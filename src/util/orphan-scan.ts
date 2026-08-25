// 网盘孤儿备份「深度扫描」引擎（v2 增强）
//
// 目的：在旧的「严格 1 层扫描父目录」基础上扩展为可配置的深度遍历，
//       精确识别三类孤儿（备份子目录 / 孤儿文件 / 孤儿空目录）。
//
// 设计原则：
//   1. 纯函数 + 抽象接口（RemoteLister），便于注入 fake 测试与复用。
//   2. 三种扫描模式：
//      a) parent-only —— 旧行为：仅扫父目录直接子项（不递归），找的是 "${vault}_TS" 型备份目录。
//      b) scoped      —— 父目录 + 同步根顶层 + 各顶层子目录单层；不深入递归。
//      c) full-vault  —— 父目录 + 同步根整棵子树（深度可控）；找 vault 根下的孤儿文件、
//                       以及嵌套在 .obsidian 等目录里的时间戳孤儿子目录。
//   3. 双重防护：
//      - orphanScanMaxNodes / orphanScanMaxBytes 双预算：任一触达即停（maxBytes 在遍历中
//        实时检查，不再是遍历结束后才标记）。
//      - 并发 listDir 受 orphanScanConcurrency 限制，避免触百度 QPS 限频（errno=31034/31039）。
//   4. 零信任：所有「备份子目录」之外的内容必须经 ignore-globs / sync-index 双重校验
//      才被排除；未被排除的就算「候选孤儿」，UI 上由用户逐项勾选确认。
//      注意：插件自身基础设施目录（.bdnsync / .bdnsync-base / .bdnsync-merge-draft /
//      .bdnsync-backup）由 main.ts 以「裸 glob + 子项 glob」双重硬排除，目录条目本身
//      与内容都不进入候选（裸 glob 如 `.bdnsync` 匹配条目自身与整棵子树）。
//   5. 显式 risk 分级：orphan-file / orphan-dir 默认为 risk=0（最低），UI 上仅在
//      「选中数 ≥ 用户阈值」时批量走二次确认；backup-dir 保留旧分级（同名=0/1段=1/≥2段=2）。
//
// 边界：
//   - 「${vault}_TS」识别复用 orphan-cleanup.ts 的 parseOrphanSegments（避免规则漂移）。
//   - 「sync index 交叉校验」由调用方在 classifyOrphans 之前注入 `isActive(path)` 函数；
//     这样 util 不依赖 LocalIndex 类型，便于纯函数测试。
//   - orphan-dir 判定为「传递性」：目录子树内**任一**文件 active 即视为受保护；
//     且只有实际展开过子项（childrenListed=true）的目录才可判「空目录」，防止
//     parent-only / 深度边界等未遍历目录被误报。

import {
  parseOrphanSegments,
  type RemoteDirRow,
  type RemoteLister,
} from './orphan-cleanup';
import { normalizeRemote, remoteJoin, remoteParent, globToRegExp } from './misc';
import type { DeepScanOptions, DeepScanResult, OrphanFinding } from '../types';

// ---------- 内部辅助 ----------

/**
 * 把绝对路径转为相对 remoteRoot 的路径（正斜杠），且以 '/' 分隔。
 * 若路径不在 remoteRoot 之内（其它分支），返回空字符串。
 * 注意：relative 不以 '/' 开头；root 直接子项的 relative 是 basename。
 */
function relFromRoot(remoteRoot: string, absPath: string): string {
  const root = normalizeRemote(remoteRoot);
  const abs = normalizeRemote(absPath);
  if (abs === root) return '';
  if (!abs.startsWith(root + '/')) return '';
  return abs.slice(root.length + 1);
}

/**
 * 计算相对 remoteRoot 的深度（root 直接子项 = 1；root 自身 = 0）。
 */
function depthFromRoot(relPath: string): number {
  if (!relPath) return 0;
  return relPath.split('/').filter(Boolean).length;
}

/**
 * 把 glob 数组编译成正则列表（行为与 misc.PathFilter.isExcluded 对齐）。
 * 传入空数组时返回 null（= 不应用忽略规则），方便快速短路。
 */
function compileIgnoreGlobs(globs: string[] | undefined): RegExp[] | null {
  if (!globs || globs.length === 0) return null;
  const out: RegExp[] = [];
  for (const g of globs) {
    const t = g.trim();
    if (!t) continue;
    try {
      out.push(globToRegExp(t));
    } catch {
      /* 无效 glob 跳过，避免一个写错的 glob 把整库跳过 */
    }
  }
  return out.length > 0 ? out : null;
}

/** 匹配该相对路径是否被忽略规则命中（任一命中即整棵子树跳过） */
function isIgnored(relPath: string, regs: RegExp[] | null): boolean {
  if (!regs) return false;
  for (const re of regs) if (re.test(relPath)) return true;
  return false;
}

// ---------- 主入口：walkRemoteTree ----------
//
// 广度优先遍历远端树，从 parentDir 起步。先把 parentDir 直接子项入队作为「第 0 层」；
// 之后才进入 remoteRoot 子树（深度 ≥ 1）。两类节点共享同一并发池 + 预算。
// 返回扁平节点列表（每个节点 = 一个远端条目，含全路径 + relPath + depth）。
//
// visited：避免循环（罕见但需防）。同时若被多个父节点引用（不可能在百度网盘上），
//          第二次见到时跳过，避免重复扫描。

export interface ScannedNode {
  /** 绝对网盘路径 */
  absPath: string;
  /** basename */
  name: string;
  /** 是否为目录 */
  isDir: boolean;
  /** 字节数（文件才有意义；目录为 0） */
  bytes: number;
  /** mtime ms */
  mtime: number;
  /** 相对 remoteRoot 的路径（root 自身的直接子项 = basename；不在 remoteRoot 内 = ''） */
  relPath: string;
  /** 相对 remoteRoot 的深度（root 直接子项 = 1） */
  depth: number;
  /**
   * 目录的子项是否真的被 listDir 拉取过（即遍历引擎进入过该目录）。
   * 目录被加入 out 但未入队展开（如 parent-only / scoped 非展开目录 / full-vault 深度边界目录）
   * 时为 false —— 此时「byParent 查不到子项」不代表目录为空，绝不能据此判 orphan-dir。
   */
  childrenListed: boolean;
  /**
   * 命中来源层（v2.2 新增）：'parent' = 来自同步根的父目录直接子项；
   * 'vault' = 来自 vault 自身目录（同步根顶层 + 整棵子树）。仅用于 UI 溯源与审计，
   * 不影响孤儿判定逻辑。由 walkRemoteTree 在创建节点时设置；纯函数测试中可省略（缺省 undefined）。
   */
  origin?: 'parent' | 'vault';
}

export async function walkRemoteTree(
  lister: RemoteLister,
  opts: DeepScanOptions,
): Promise<{ nodes: ScannedNode[]; scannedNodes: number; scannedBytes: number; truncated: boolean; errors: { path: string; message: string }[] }> {
  const parentDir = normalizeRemote(opts.parentDir);
  const remoteRoot = normalizeRemote(opts.remoteRoot);
  const ignoreRegs = compileIgnoreGlobs(opts.ignoreGlobs);
  const maxDepth = opts.maxDepth > 0 ? opts.maxDepth : Infinity;
  const maxNodes = opts.maxNodes > 0 ? opts.maxNodes : Infinity;
  const maxBytes = opts.maxBytes > 0 ? opts.maxBytes : Infinity;
  const concurrency = Math.max(1, Math.min(opts.concurrency || 3, 8));

  const out: ScannedNode[] = [];
  const errors: { path: string; message: string }[] = [];
  const visited = new Set<string>(); // 去重（防止同一目录被多次入队）
  let scannedBytes = 0;
  let truncated = false;

  // 队列元素：{ absPath, relPath, depth, node }，depth=1 表示 root 直接子项（root 自身 = 0 但不入队）
  // node 引用指向已加入 out 的节点，pumpOne 实际 listDir 成功后回填 childrenListed=true。
  type QItem = { absPath: string; relPath: string; depth: number; node?: ScannedNode };
  const queue: QItem[] = [];

  // —— 起步：parentDir 直接子项先入队（depth 记 0，让「vault 在父目录里」与「vault 内部」分流显示）——
  if (parentDir && parentDir !== '/' && parentDir !== remoteRoot) {
    try {
      const top = await lister.listDir(parentDir);
      for (const e of top) {
        const abs = remoteJoin(parentDir, e.name);
        if (visited.has(abs)) continue;
        visited.add(abs);
        const rel = relFromRoot(remoteRoot, abs); // 父目录通常不是 remoteRoot 的子，返回 ''
        const d = rel ? depthFromRoot(rel) : 0;
        out.push({
          absPath: abs,
          name: e.name,
          isDir: e.isDir,
          bytes: e.size ?? 0,
          mtime: e.mtime ?? 0,
          relPath: rel,
          depth: d,
          childrenListed: false, // parentDir 顶层不展开子项（parent-only 语义）
          origin: 'parent', // 来自同步根父目录直接子项
        });
      }
    } catch (e) {
      errors.push({ path: parentDir, message: e instanceof Error ? e.message : String(e) });
    }
  }

  // —— 入队 remoteRoot 直接子项（parent-only 模式到此为止）——
  if (remoteRoot && remoteRoot !== '/' && opts.mode !== 'parent-only') {
    if (out.length < maxNodes && !truncated) {
      try {
        const top = await lister.listDir(remoteRoot);
        for (const e of top) {
          if (out.length >= maxNodes) {
            truncated = true;
            break;
          }
          const abs = remoteJoin(remoteRoot, e.name);
          if (visited.has(abs)) continue;
          visited.add(abs);
          const rel = relFromRoot(remoteRoot, abs);
          const d = depthFromRoot(rel);
          // 命中忽略规则 → 整棵子树跳过（不入队、不计入 scannedNodes）
          if (isIgnored(rel, ignoreRegs)) continue;
          const node: ScannedNode = {
            absPath: abs,
            name: e.name,
            isDir: e.isDir,
            bytes: e.size ?? 0,
            mtime: e.mtime ?? 0,
            relPath: rel,
            depth: d,
            childrenListed: false, // 是否真正展开子项由 pumpOne 回填
            origin: 'vault', // 来自 vault 自身目录（同步根顶层）
          };
          // scoped/full-vault 时把目录入队（决定是否递归展开）；file 直接产出
          if (e.isDir) {
            // scoped: 仅单层展开（不入队）；full-vault: 受 maxDepth 控制
            const shouldEnqueue =
              opts.mode === 'full-vault' && (d < maxDepth || !isFinite(maxDepth));
            if (shouldEnqueue) queue.push({ absPath: abs, relPath: rel, depth: d, node });
          }
          out.push(node);
          if (!e.isDir) {
            scannedBytes += e.size ?? 0;
            // F3 修复：字节预算在遍历中即生效（不再等遍历结束后才标记）
            if (scannedBytes > maxBytes) {
              truncated = true;
              break;
            }
          }
        }
      } catch (e) {
        errors.push({ path: remoteRoot, message: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  // —— 进度回调（首次）——
  opts.onProgress?.({
    scannedNodes: out.length,
    scannedBytes,
    truncated,
  });

  // —— 并发展开队列（仅目录；full-vault 才入队，scoped 不入队）——
  const inFlight = new Set<Promise<void>>();

  const pumpOne = async (): Promise<void> => {
    const item = queue.shift();
    if (!item) return;
    if (out.length >= maxNodes || truncated) {
      truncated = true;
      return;
    }
    let rows: RemoteDirRow[] = [];
    try {
      rows = await lister.listDir(item.absPath);
    } catch (e) {
      errors.push({ path: item.absPath, message: e instanceof Error ? e.message : String(e) });
      return;
    }
    // 该目录的子项确实被拉取过 → childrenListed=true（byParent 无子项时才能判「空目录」）
    if (item.node) item.node.childrenListed = true;
    for (const r of rows) {
      if (out.length >= maxNodes) {
        truncated = true;
        break;
      }
      const abs = remoteJoin(item.absPath, r.name);
      if (visited.has(abs)) continue;
      visited.add(abs);
      const rel = relFromRoot(remoteRoot, abs);
      const d = depthFromRoot(rel);
      if (isIgnored(rel, ignoreRegs)) continue;
      const node: ScannedNode = {
        absPath: abs,
        name: r.name,
        isDir: r.isDir,
        bytes: r.size ?? 0,
        mtime: r.mtime ?? 0,
        relPath: rel,
        depth: d,
        childrenListed: false,
        origin: 'vault', // 来自 vault 子树（full-vault 递归展开）
      };
      out.push(node);
      if (!r.isDir) {
        scannedBytes += r.size ?? 0;
        // F3 修复：字节预算在遍历中即生效
        if (scannedBytes > maxBytes) {
          truncated = true;
          break;
        }
      }
      // 子目录决定是否继续入队（继续受 maxDepth + 全局预算控制）
      if (r.isDir) {
        const shouldEnqueue =
          opts.mode === 'full-vault' && (d < maxDepth || !isFinite(maxDepth));
        if (shouldEnqueue) queue.push({ absPath: abs, relPath: rel, depth: d, node });
      }
    }
  };

  // 简易协程：固定大小 worker 池 + 中央队列
  const worker = async () => {
    while (!truncated && (queue.length > 0 || inFlight.size > 0)) {
      if (queue.length === 0) {
        await Promise.race(inFlight);
        continue;
      }
      const task = pumpOne();
      inFlight.add(task);
      task.finally(() => inFlight.delete(task));
      // 控制并发：等到池子有空间再派下一个
      if (inFlight.size >= concurrency) await Promise.race(inFlight);
    }
  };

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);
  // 等待 inFlight 清空（防御性）
  await Promise.allSettled(Array.from(inFlight));

  // 最后裁剪：bytes 预算也可能在收尾时超——超出部分截掉（先按 mtime 旧 → 新保留，
  // 即优先保留最新数据，因新数据往往是用户最近活动产生的，删错代价更大）。
  if (scannedBytes > maxBytes) {
    truncated = true;
  }

  opts.onProgress?.({
    scannedNodes: out.length,
    scannedBytes,
    truncated,
  });
  return { nodes: out, scannedNodes: out.length, scannedBytes, truncated, errors };
}

// ---------- 主入口：classifyOrphans ----------
//
// 把 walkRemoteTree 结果 + sync-index 交叉校验 + 用户 ignore-globs 翻译为 OrphanFinding 列表。
//
// isActive(relPath)：由调用方注入；返回 true 表示「这条文件在 sync index 里有，
//                    视为受保护文件，绝不能作为 orphan-file 候选」。
// 目录的「活」性判断：当目录内**任意**一个文件是 active 时，目录本身不能被视作 orphan-dir。
// 目录命名规则（parseOrphanSegments）：与旧逻辑完全一致——按 vaultName + N 段 YYYYMMDD_HHMMSS 匹配。

export interface ClassifyOptions {
  vaultName: string;
  /** 调用方注入：相对路径 → 是否在 sync index 中（受保护）。允许是异步查询 */
  isActive?: (relPath: string) => boolean | Promise<boolean>;
  /** 忽略 glob（与 walkRemoteTree 共用；可省略，但若两者都传需一致） */
  ignoreGlobs?: string[];
}

export async function classifyOrphans(
  scanned: ScannedNode[],
  opts: ClassifyOptions,
): Promise<OrphanFinding[]> {
  const ignoreRegs = compileIgnoreGlobs(opts.ignoreGlobs);
  const findings: OrphanFinding[] = [];
  // 按 absPath 索引，便于「目录下是否有 active 文件」判断
  const byParent = new Map<string, ScannedNode[]>();
  for (const n of scanned) {
    const parent = remoteParent(n.absPath);
    const bucket = byParent.get(parent) ?? [];
    bucket.push(n);
    byParent.set(parent, bucket);
  }

  // 二次扫描：收集「子树内（传递性）含有至少一个 active 文件」的所有目录。
  // protectedDirs 存目录 absPath；目录在此集合中 = 其内存在同步中的文件 → 绝不能判孤儿。
  // 注意：必须沿祖先链一路标记到根（而不只是直接父目录），否则 F2 场景
  // 「Notes/Archive/active.md」会把 Notes 误判为 orphan-dir。
  const protectedDirs = new Set<string>();
  if (opts.isActive) {
    for (const n of scanned) {
      if (n.isDir) continue;
      if (!n.relPath) continue;
      if (isIgnored(n.relPath, ignoreRegs)) continue;
      let active = false;
      try {
        active = await opts.isActive(n.relPath);
      } catch {
        active = false; // 查询失败当 inactive 处理，宁可多判孤儿不可漏判
      }
      if (!active) continue;
      let p = remoteParent(n.absPath);
      while (p && p !== '/') {
        protectedDirs.add(p);
        p = remoteParent(p);
      }
    }
  }

  for (const n of scanned) {
    // 1. ignore-globs 命中 → 跳过（直接忽略）
    if (isIgnored(n.relPath, ignoreRegs)) continue;
    // 2. 备份目录：名字匹配 vaultName + N 段时间戳 → 即便深度更深也算
    if (n.isDir) {
      // 主同步根（无时间戳）一定不是 orphan
      // 「vaultName」直接命中时 segments=0 / risk=0；调用方必须自己剔除
      const parsed = parseOrphanSegments(n.name, opts.vaultName);
      if (parsed.matched && parsed.segments >= 1) {
        findings.push({
          kind: 'backup-dir',
          fullPath: n.absPath,
          name: n.name,
          parentPath: remoteParent(n.absPath),
          relPath: n.relPath,
          depth: n.depth,
          bytes: 0, // 由 measureOrphans 后置填充（如果调用方做了）
          mtime: n.mtime,
          risk: parsed.risk,
          reason:
            parsed.risk === 2
              ? `高风险：${parsed.segments} 段重复时间戳叠加（典型「反复累积」现象）`
              : `中等风险：单段时间戳（${parsed.segments} 段）`,
          segments: parsed.segments,
          origin: n.origin,
        });
        continue;
      }
      // 非备份目录：判断是否 orphan-dir（空 / 整棵子树无 active 文件）
      const kids = byParent.get(n.absPath) ?? [];
      // 🔴 安全护栏（vault 根误删）：relPath==='' 的目录位于 remoteRoot 之外，
      // 其中唯一会被展开出子项的节点就是「vault 根自身」（父目录层列出、子项来自
      // remoteRoot 列表）。本地索引为空（换账号 / 索引重置 / 读取失败）时整库文件都判
      // inactive，vault 根会落入「目录内 N 项均不在 sync index 中」→ 一旦被勾选删除
      // = 清空整个网盘 vault（与 quickSync 的 B1 空索引护栏同源的风险）。
      // 父目录层其它目录从未展开（childrenListed=false）本就无法判定，跳过无损失；
      // 而父目录层的备份目录（backup-dir）不受影响（走上面的命名分支）。
      if (!n.relPath) continue;
      // 子树内存在同步中的文件（传递性）→ 不能删
      if (protectedDirs.has(n.absPath)) continue;
      if (kids.length === 0) {
        // 只有「实际列出过子项且确认为空」才判空目录孤儿；
        // 未展开的目录（childrenListed=false，如 parent-only 顶层 / scoped 非展开目录 /
        // full-vault 深度边界目录）无法断言为空 → 不判，避免把真实目录误报为孤儿。
        if (!n.childrenListed) continue;
        findings.push({
          kind: 'orphan-dir',
          fullPath: n.absPath,
          name: n.name,
          parentPath: remoteParent(n.absPath),
          relPath: n.relPath,
          depth: n.depth,
          bytes: 0,
          mtime: n.mtime,
          risk: 0,
          reason: '空目录',
          segments: 0,
          origin: n.origin,
        });
      } else {
        // 非空且整棵子树无 active 文件（protectedDirs 不含本目录）→ 全部子项均为孤儿
        const bytes = kids.reduce((s, k) => s + (k.isDir ? 0 : k.bytes), 0);
        findings.push({
          kind: 'orphan-dir',
          fullPath: n.absPath,
          name: n.name,
          parentPath: remoteParent(n.absPath),
          relPath: n.relPath,
          depth: n.depth,
          bytes,
          mtime: n.mtime,
          risk: 0,
          reason: `目录内 ${kids.length} 项均不在 sync index 中`,
          segments: 0,
          origin: n.origin,
        });
      }
      continue;
    }
    // 3. 文件：relPath 为空说明不在 vault 内（属于父目录或外部），跳过
    if (!n.relPath) continue;
    if (isIgnored(n.relPath, ignoreRegs)) continue;
    // active? → 跳过
    if (opts.isActive) {
      let active = false;
      try {
        active = await opts.isActive(n.relPath);
      } catch {
        active = false;
      }
      if (active) continue;
    }
    // 命中 ignore glob → 已在前置过滤
    findings.push({
      kind: 'orphan-file',
      fullPath: n.absPath,
      name: n.name,
      parentPath: remoteParent(n.absPath),
      relPath: n.relPath,
      depth: n.depth,
      bytes: n.bytes,
      mtime: n.mtime,
      risk: 0,
      reason: '文件不在 sync index 中',
      segments: 0,
      origin: n.origin,
    });
  }

  // 排序：高风险优先；同风险按 depth 升序（浅在前），再按 mtime 升序
  findings.sort((a, b) => {
    if (b.risk !== a.risk) return b.risk - a.risk;
    if (a.depth !== b.depth) return a.depth - b.depth;
    return a.mtime - b.mtime;
  });

  return findings;
}

// ---------- 主入口：mergeFindings ----------
//
// 把旧管线「parent-only 命中」的 OrphanEntry 与新管线「scoped/full-vault 命中」的
// OrphanFinding 合并去重（按 fullPath）。重复路径保留更详细的（深度 / kind 信息更多）。
//
// 用途：让 openOrphanCleanupModal 一次返回「所有命中」—— 用户无论切到哪个模式，
//      都至少能看到与旧行为一致的结果；同时不会重复显示同一项。

export interface LegacyEntryLike {
  fullPath: string;
  name: string;
  segments: number;
  risk: 0 | 1 | 2;
  mtime: number;
  fileCount: number;
  totalBytes: number;
}

export function mergeFindings(
  legacyEntries: LegacyEntryLike[],
  deepFindings: OrphanFinding[],
): OrphanFinding[] {
  const out: OrphanFinding[] = [...deepFindings];
  const idxByPath = new Map<string, number>();
  for (let i = 0; i < out.length; i++) idxByPath.set(out[i].fullPath, i);

  for (const e of legacyEntries) {
    const parent = remoteParent(e.fullPath);
    if (idxByPath.has(e.fullPath)) {
      // 已存在：用 legacy 的字节数补字段（findings 里 bytes 可能是 0）
      const i = idxByPath.get(e.fullPath);
      if (i === undefined) continue;
      out[i] = {
        ...out[i],
        bytes: e.totalBytes,
        segments: e.segments,
        risk: e.risk,
        mtime: e.mtime || out[i].mtime,
      };
      continue;
    }
    out.push({
      kind: 'backup-dir',
      fullPath: e.fullPath,
      name: e.name,
      parentPath: parent,
      relPath: '', // legacy 不区分 remoteRoot 内外
      depth: 0, // parent-only 视角：父目录直接子项
      bytes: e.totalBytes,
      mtime: e.mtime,
      risk: e.risk,
      reason:
        e.risk === 2
          ? `高风险：${e.segments} 段时间戳段叠加（parent-only 命中）`
          : `中等风险：${e.segments} 段时间戳段（parent-only 命中）`,
      segments: e.segments,
      origin: 'parent',
    });
  }
  return out.sort((a, b) => {
    if (b.risk !== a.risk) return b.risk - a.risk;
    if (a.depth !== b.depth) return a.depth - b.depth;
    return a.mtime - b.mtime;
  });
}

// ---------- 主入口：runDeepScan（顶层便捷入口）----------

export async function runDeepScan(
  lister: RemoteLister,
  opts: DeepScanOptions,
  classifyOpts: Omit<ClassifyOptions, 'ignoreGlobs'> & { ignoreGlobs?: string[] },
): Promise<DeepScanResult> {
  const t0 = Date.now();
  const ignoreGlobs = classifyOpts.ignoreGlobs;
  const walked = await walkRemoteTree(lister, { ...opts, ignoreGlobs });
  const findings = await classifyOrphans(walked.nodes, {
    vaultName: classifyOpts.vaultName,
    isActive: classifyOpts.isActive,
    ignoreGlobs,
  });
  return {
    findings,
    scannedNodes: walked.scannedNodes,
    scannedBytes: walked.scannedBytes,
    truncated: walked.truncated,
    durationMs: Date.now() - t0,
    errors: walked.errors,
  };
}
