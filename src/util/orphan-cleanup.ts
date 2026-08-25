// Orphan backup cleanup：扫描并清理网盘「vault 名 + 时间戳段」型孤儿目录。
//
// 目的：用户 vault 真名若叫 "Obsidian Vault"，当网盘上出现
//   Obsidian Vault_20260824_231304_20260824_231304_20260824_231304
// 这种带下划线+重复时间戳段的目录时——既非 BDNSync 当前代码产物（不会产生
// 该模式），也非用户主同步数据——会被识别为"疑似孤儿备份"，由用户在 UI 中
// 二次确认后批量删除。
//
// 设计原则：
//   1. 严格 1 层扫描：只扫描 remoteRoot 的「父目录」直接子项，不递归。
//   2. 严格规则匹配：仅识别 `${vaultName}(_<ts>{1,N})` 形态，零信任其它目录。
//   3. 0 自动删：util 只做"识别 + 测量"，删除调用方传入并走 UI 确认。
//   4. 风险分级：高（≥2 段时间戳段叠加）/ 中（1 段）/ 低（同名无时间戳）。

// 注：本文件为纯函数，0 副作用，0 设置/IO 依赖，便于跨场景复用与单测。

/** 匹配 "YYYYMMDD_HHMMSS" 的一个时间戳段 */
const TS_SEG = /^\d{8}_\d{6}$/;

/**
 * 分析一个目录名是否像"孤儿备份"。
 * @returns segments：剥离后的尾段时间戳段数。>=1 即认定为疑似孤儿。
 */
export function parseOrphanSegments(
  dirName: string,
  vaultName: string,
): { matched: boolean; segments: number; risk: 0 | 1 | 2 } {
  if (!vaultName) return { matched: false, segments: 0, risk: 0 };
  if (!dirName.startsWith(vaultName)) return { matched: false, segments: 0, risk: 0 };

  const tail = dirName.slice(vaultName.length);
  // 完全同名（无任何后缀）—— 仅当 vaultName 自身就是孤儿候选时算"低风险"
  // 但通常用户主同步目录就叫这个名字，调用方必须把它从候选中剔除。
  if (tail === '') {
    return { matched: true, segments: 0, risk: 0 };
  }
  // 期望 tail 严格为 '_YYYYMMDD_HHMMSS' 重复 1..N 次，没有多余字符
  if (!tail.startsWith('_')) return { matched: false, segments: 0, risk: 0 };
  const parts = tail.slice(1).split('_'); // "20260824_231304_20260824_231304" → ["20260824","231304","20260824","231304"]
  // 必须由完整 _YYYYMMDD_HHMMSS 段构成，且整段没有多余（数组长度必为偶数且可整 2）
  if (parts.length < 2 || parts.length % 2 !== 0) {
    return { matched: false, segments: 0, risk: 0 };
  }
  // 重新按 2 段配对
  let n = 0;
  for (let i = 0; i < parts.length; i += 2) {
    const date = parts[i];
    const time = parts[i + 1];
    if (!TS_SEG.test(date + '_' + time)) return { matched: false, segments: 0, risk: 0 };
    n++;
  }
  // 风险分级：≥2 段叠加（典型"反复累积"）= 高；1 段 = 中
  const risk: 0 | 1 | 2 = n >= 2 ? 2 : 1;
  return { matched: true, segments: n, risk };
}

/** 扫描出的孤儿目录条目 */
export interface OrphanEntry {
  /** 远程完整路径（含 remoteRoot 前缀或仅父目录一层），例如 /apps/bdnsync/Obsidian Vault_20260824_231304 */
  fullPath: string;
  /** 仅名称段（不含父目录） */
  name: string;
  /** 命中规则匹配的"时间戳段"数 */
  segments: number;
  /** 风险等级 0=低（同名无 ts）/ 1=中（1 段）/ 2=高（≥2 段） */
  risk: 0 | 1 | 2;
  /** 远程最后修改时间（毫秒，若平台缺则为 0） */
  mtime: number;
  /** 子文件数（不含目录） */
  fileCount: number;
  /** 累计子文件字节数 */
  totalBytes: number;
  /**
   * 测量（单层列出子项）是否失败。失败时 fileCount/totalBytes 会被置 0 占位，
   * 但用户无法分辨「真为空」vs「测量失败」。本字段用于 UI 显式标注「测量失败」，
   * 避免把"列出失败"误当成"空孤儿"而误导删除决策（修复 #80 缺陷 2）。
   */
  measureError?: boolean;
}

/** 远端目录条目最小契约（避免 util 反向依赖具体 BaiduApi 类型） */
export interface RemoteDirRow {
  path: string; // 网盘绝对路径或本次 list 入口路径
  name: string;
  isDir: boolean;
  mtime?: number;
  size?: number;
}

/** 远端递归列出接口（由 BaiduApi 实现）。单层列出，仅用于"估算孤儿是否有数据"——不必深递归。 */
export interface RemoteLister {
  listDir(remoteDir: string): Promise<RemoteDirRow[]>;
}

/** 远端删除接口 */
export interface RemoteDeleter {
  deleteFiles(fullPaths: string[]): Promise<void>;
}

/**
 * 给定远端 listDir 单层结果，过滤出"疑似孤儿"目录条目。
 * 注意：调用方负责只传「remoteRoot 父目录的 1 层」结果，且排除主同步目录名本身（vaultName 精确等于 dirName）。
 *
 * 硬排除（v2 深化）：所有 `.bdnsync` / `.bdnsync-*` 前缀目录一律不视为孤儿候选——
 * 它们是插件自身的基础设施（索引 `.bdnsync`、祖先快照 `.bdnsync-base`、合并草稿
 * `.bdnsync-merge-draft` 等），即使 vaultName 恰好以 `.bdnsync` 开头也不会被误判。
 */
export function pickOrphans(
  entries: RemoteDirRow[],
  vaultName: string,
): OrphanEntry[] {
  const out: OrphanEntry[] = [];
  for (const e of entries) {
    if (!e.isDir) continue;
    // 硬排除插件基础设施目录
    if (e.name === '.bdnsync' || e.name.startsWith('.bdnsync-')) continue;
    const parsed = parseOrphanSegments(e.name, vaultName);
    if (!parsed.matched) continue;
    // 严格剔除主同步根目录本身（同名无时间戳）
    if (e.name === vaultName) continue;
    out.push({
      fullPath: e.path,
      name: e.name,
      segments: parsed.segments,
      risk: parsed.risk,
      mtime: e.mtime ?? 0,
      fileCount: 0,
      totalBytes: 0,
    });
  }
  // 风险等级高的在前，时间最久的在前
  out.sort((a, b) => {
    if (b.risk !== a.risk) return b.risk - a.risk;
    return a.mtime - b.mtime;
  });
  return out;
}

/**
 * 对每个孤儿候选单层扫描子项，统计 fileCount / totalBytes（粗估）。
 * 设计取舍：orphan 内部通常是与 vault 平级的根次复制，单层已能判定"是否有数据"。
 * 失败容错：单目录扫不到时记 0，不抛出。
 * 审计 #10：仅含嵌套目录（直接子项全为目录）时 fileCount 可能为 0，这里把
 * 「有任意子项」也视为有数据（fileCount 至少 1），避免按字节过滤时把非空孤儿判空。
 */
export async function measureOrphans(
  lister: RemoteLister,
  items: OrphanEntry[],
): Promise<OrphanEntry[]> {
  const out: OrphanEntry[] = [];
  for (const it of items) {
    try {
      const rows = await lister.listDir(it.fullPath);
      let files = 0;
      let bytes = 0;
      for (const r of rows) {
        if (!r.isDir) {
          files += 1;
          bytes += r.size ?? 0;
        }
      }
      if (rows.length > 0 && files === 0) files = 1; // 有子项（哪怕全为目录）即视为有数据
      out.push({ ...it, fileCount: files, totalBytes: bytes });
    } catch {
      // 列出失败也要返回，让用户在 UI 看到（用 0 占位）；
      // 同时置 measureError=true，UI 据此显式标「测量失败」而非误导性的「0 文件 · 0 B」
      out.push({ ...it, fileCount: 0, totalBytes: 0, measureError: true });
    }
  }
  return out;
}

/**
 * 删除一组孤儿目录（整目录递归删）。失败容错：单条失败不影响其它，结果返回分桶。
 * 审计 #9：confirmedByUser 是硬门禁——未确认时整体拒绝删除（返回全失败桶），
 * 防止被程序化调用/脚本误用。UI 层（OrphanCleanupModal 输入 DELETE）负责置 true。
 * 审计 #11：错误信息自动包含 errno（若来自 BaiduApiError）—— modal 可据此给出诊断。
 */
export async function deleteOrphans(
  deleter: RemoteDeleter,
  items: OrphanEntry[],
  opts: {
    /** 调用方是否已做了二次确认（UI 弹窗输入 DELETE）—— 硬门禁，未确认拒绝删除 */
    confirmedByUser: boolean;
    /** 单条最大重试次数（默认 2） */
    retries?: number;
    /** 删除间退避毫秒（默认 300） */
    delayMs?: number;
  },
): Promise<{ ok: string[]; failed: { path: string; error: string; errno?: number }[] }> {
  if (!opts.confirmedByUser) {
    return {
      ok: [],
      failed: items.map((it) => ({ path: it.fullPath, error: '未经过用户二次确认，已拒绝删除' })),
    };
  }
  const ok: string[] = [];
  const failed: { path: string; error: string; errno?: number }[] = [];
  const retries = Math.max(0, opts.retries ?? 2);
  const delayMs = Math.max(0, opts.delayMs ?? 300);
  for (const it of items) {
    let lastErr = '';
    let lastErrno: number | undefined;
    let done = false;
    for (let r = 0; r <= retries; r++) {
      try {
        await deleter.deleteFiles([it.fullPath]);
        done = true;
        break;
      } catch (e) {
        // 把 errno 单独拎出来，error 字符串里也加前缀（modal 可直接读 .errno 做诊断）
        const errno =
          e && typeof e === 'object' && 'errno' in e && typeof (e as { errno: unknown }).errno === 'number'
            ? (e as { errno: number }).errno
            : undefined;
        const msg = e instanceof Error ? e.message : String(e);
        lastErr = errno !== undefined ? `errno=${errno} ${msg}` : msg;
        lastErrno = errno;
        if (r < retries) await new Promise((res) => setTimeout(res, delayMs));
      }
    }
    if (done) ok.push(it.fullPath);
    else failed.push({ path: it.fullPath, error: lastErr, ...(lastErrno !== undefined ? { errno: lastErrno } : {}) });
  }
  return { ok, failed };
}

/**
 * 巡检 hook 默认 24h 限频。
 * @returns true = 应触发扫描；false = 距上次扫描未到 limitMs。
 */
export function shouldScanOrphans(lastScanAt: number, now: number, limitMs = 24 * 3600 * 1000): boolean {
  if (!lastScanAt) return true;
  return now - lastScanAt >= limitMs;
}

/** 巡检命中时的"高风险/大体积"过滤——只把高风险或大体积推到用户面前。 */
export function isCandidateToAlert(item: OrphanEntry, opts: { minRisk: 1 | 2; minBytes?: number }): boolean {
  if (item.risk < opts.minRisk) return false;
  if (opts.minBytes !== undefined && item.totalBytes < opts.minBytes) return false;
  return true;
}
