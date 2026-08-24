// 同步引擎：三方对比（本地 / 云端 / 上次同步）、决策矩阵、墓碑、乐观锁竞态检测、断点续传

import { type App } from 'obsidian';
import { BaiduApiError } from '../baidu/api';
import {
  INDEX_VERSION,
  TOMBSTONE_TTL,
  type BaiduAdapter,
  type ResolvedRemoteIndex,
} from '../baidu/adapter';
import type { LocalStore } from '../storage/local-store';
import type {
  BackupEntry,
  DeleteStrategy,
  BDNSyncSettings,
  ConflictKind,
  ConflictRecord,
  FileState,
  LocalIndex,
  SyncStats,
  SyncPlanPreview,
  VaultSnapshot,
  ConflictReportEntry,
} from '../types';
import type { StatusBar } from '../ui/status-bar';
import { ConflictResolver } from './conflict-resolver';
import { md5Hex, md5HexAsync, MD5_ASYNC_THRESHOLD } from '../util/md5';
import {
  PathFilter,
  conflictName,
  runWithConcurrency,
  u8ToArrayBuffer,
  sleep,
  randomId,
} from '../util/misc';

type Action =
  | { type: 'upload'; path: string; local: FileState }
  | { type: 'download'; path: string; remoteState: FileState; remoteSize: number }
  | { type: 'delete-local'; path: string; last: FileState }
  | { type: 'delete-remote'; path: string; last: FileState }
  | { type: 'skip'; path: string; local: FileState }
  | {
      type: 'conflict';
      path: string;
      kind: ConflictKind;
      local: FileState | null;
      remoteState: FileState | null;
      last: FileState | null;
    };

export interface SyncResult extends SyncStats {
  ok: boolean;
  cancelled?: boolean;
}

export type FirstSyncAsker = (
  localCount: number,
  remoteCount: number,
) => Promise<'merge' | 'cloud' | 'local' | 'cancel'>;

/** 增量同步的「无操作」结果占位（被跳过时不改变统计） */
const NOTHING: SyncResult = {
  ok: true,
  uploaded: 0,
  downloaded: 0,
  deletedLocal: 0,
  deletedRemote: 0,
  conflicts: -0,
  skipped: 0,
  errors: 0,
  bytesUp: 0,
  bytesDown: 0,
  errorMessages: [],
};

/**
 * 同步方向。
 *  - bidirectional：常规三方对比（默认）
 *  - force-upload：以本地为唯一真相（本地覆盖云端，云端多余文件删除）
 *  - force-download：以云端为唯一真相（云端覆盖本地，本地多余文件删除）
 *
 * 两个 force 方向用于「索引损坏 / 冲突缠死 / 换机重装」等修复场景，
 * 语义等价于首次同步弹窗里的「用云端覆盖本地」「用本地覆盖云端」，
 * 但可以在任意时刻按需触发。
 */
export type SyncDirection = 'bidirectional' | 'force-upload' | 'force-download';

/**
 * 把 DataAdapter.list() 的返回项归一化成「相对 vault 根目录」的路径。
 *
 * Obsidian 官方 API 文档中 ListedFiles 的 files/folders 均标注为 "Array of file paths"，
 * 即返回的已经是相对 vault 根的完整路径（如 `Notes/sub/a.md`），而不是 basename。
 * 社区实现（obsidian-git 等）也一律用 `entry.substring(dir.length)` 来反推 basename。
 *
 * 这里做防御性归一化：无论适配器返回完整路径还是 basename，都能得到正确结果，
 * 避免出现 `Notes/Notes/sub/a.md` 这类重复前缀导致整棵子树被静默丢弃。
 */
function toVaultPath(dir: string, entry: string): string {
  const e = entry.replace(/^\/+/, '');
  const d = dir.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!d) return e;
  const prefix = `${d}/`;
  return e.startsWith(prefix) ? e : `${prefix}${e}`;
}

/** 取路径最后一段，用于隐藏文件 / .obsidian 判定 */
export function baseName(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}

/** 引擎内诊断日志（与 [BDNSync] 前缀风格一致；同步结果摘要仍由 main 层记录） */
function engineLog(level: 'info' | 'warn' | 'error', msg: string): void {
  if (level === 'error') console.error(`[BDNSync] ${msg}`);
  else if (level === 'warn') console.warn(`[BDNSync] ${msg}`);
  else console.info(`[BDNSync] ${msg}`);
}

/**
 * 构造一个墓碑（已删除）状态对象，统一所有删除分支的字段形态。
 *
 * 此前该字面量在引擎内被复制 8 处，易漏字段（如 deletedBy）或写错 mtime/size 默认值。
 * 工厂保证：mtime/size 归零、deleted 标记、deletedAt 时间戳、deletedBy 设备标识齐全且一致。
 *
 * @param path    相对 vault 的路径
 * @param deviceId 执行删除的设备标识（写入 deletedBy）
 * @param hash    被删文件的内容哈希（无内容时传空串，默认 ''）
 * @param now     删除时间戳（默认 Date.now()，便于测试注入固定值）
 */
export function makeTombstone(
  path: string,
  deviceId: string,
  hash = '',
  now: number = Date.now(),
): FileState {
  return {
    path,
    mtime: 0,
    size: 0,
    hash,
    deleted: true,
    deletedAt: now,
    deletedBy: deviceId,
  };
}

/**
 * 远程索引条目是否仍与网盘现状一致（决定该条目里的 hash 能否被采信）。
 *
 * 网盘列表返回的 size 是「落盘字节数」（加密时为密文长度）、mtime 是秒级 server_mtime；
 * 而索引里的 size 是明文长度、mtime 在上传时被写成本地毫秒时间。二者直接比较永远不相等，
 * 会让 hash 一律被判为过期，进而导致：每次同步把云端文件重新下载一遍、每次本地编辑都被
 * 误判成 edit-edit 冲突。因此这里用 remoteSize + fsId 作为一致性凭据。
 */
function remoteIndexInSync(
  rIdx: FileState,
  entry: { size: number; mtime: number; fsId: string },
): boolean {
  if (rIdx.remoteSize != null) {
    if (rIdx.remoteSize !== entry.size) return false;
    // fs_id 在文件被覆盖/替换时会变化，可捕获「网页端直接改了文件」的情况
    if (rIdx.fsId && entry.fsId && rIdx.fsId !== entry.fsId) return false;
    return true;
  }
  // 兼容 remoteSize 之前的旧索引：退化为宽松比较（秒级 mtime 容差）
  return rIdx.size === entry.size && Math.abs(rIdx.mtime - entry.mtime) <= 1000;
}

/** 大规模删除保护的判定结果 */
export type MassDeleteChoice = 'proceed' | 'skip-deletes' | 'cancel';
export type MassDeleteAsker = (info: {
  deleteLocal: number;
  deleteRemote: number;
  localTotal: number;
  remoteTotal: number;
  samples: string[];
  reason: string;
}) => Promise<MassDeleteChoice>;

export class SyncEngine {
  private syncing = false;
  private resolver = new ConflictResolver();
  /**
   * 文件哈希缓存（path → {mtime,size,hash}）。
   * 大库（万级文件）下若无限增长会吃内存，这里用插入序 Map 充当 LRU：
   * 超过上限时淘汰最旧条目。命中缓存可跳过整文件 readBinary+MD5，是同步性能关键。
   */
  private hashCache = new Map<string, { mtime: number; size: number; hash: string }>();
  private static readonly HASH_CACHE_MAX = 5000;
  /** 上传带宽节流：上一次限速 sleep 的余数（平滑吞吐） */
  private bandwidthCarry = 0;
  /** 下载校验（hash 不一致）连续失败计数：超过阈值说明本地索引与云端严重失配，引导重置 */
  private downloadVerifyFails = 0;
  /** 网盘容量不足标志：下载阶段命中 31326 后置位，剩余下载短路 */
  private quotaExhausted = false;
  /**
   * 覆盖前备份元数据缓冲：一次完整同步可能覆盖/删除大量文件，若每个都即时全量
   * 读写 backups.json 会产生 O(N) 次整文件 IO。这里先在内存累积，待同步结束统一
   * 提交（commitBackups），将 IO 降到 O(1)。物理内容仍由 putBase 负责（hash 去重）。
   */
  private backupBuffer: BackupEntry[] = [];

  constructor(
    private app: App,
    private getSettings: () => BDNSyncSettings,
    private adapter: BaiduAdapter,
    private store: LocalStore,
    private statusBar: StatusBar,
    private askFirstSync: FirstSyncAsker,
    private onConflictsChanged: (n: number) => void,
    private askMassDelete: MassDeleteAsker,
    /** UI 通知回调（解耦引擎与 Obsidian Notice：默认回退到 new Notice，便于测试注入） */
    private onNotice: (msg: string, timeout?: number) => void = (msg, timeout) => {
      // 延迟到运行时引用，避免模块顶层直接依赖 obsidian 的 Notice
      const NoticeCtor =
        // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any
        (globalThis as any).require?.('obsidian')?.Notice ?? (globalThis as any).Notice;
      if (NoticeCtor) new NoticeCtor(msg, timeout);
    },
  ) {}

  isBusy(): boolean {
    return this.syncing;
  }

  /** 统一的 UI 通知出口（经 onNotice 回调解耦 Obsidian Notice，便于测试 mock） */
  private notify(msg: string, timeout?: number): void {
    try {
      this.onNotice(msg, timeout);
    } catch {
      /* 通知失败不影响同步主流程 */
    }
  }

  /** 写入哈希缓存，超出容量时淘汰最旧条目（插入序 Map 即 LRU 近似） */
  private cacheHash(path: string, entry: { mtime: number; size: number; hash: string }): void {
    if (this.hashCache.size >= SyncEngine.HASH_CACHE_MAX && !this.hashCache.has(path)) {
      const oldest = this.hashCache.keys().next().value;
      if (oldest !== undefined) this.hashCache.delete(oldest);
    }
    this.hashCache.set(path, entry);
  }

  private s(): BDNSyncSettings {
    return this.getSettings();
  }
  private vadapter() {
    return this.app.vault.adapter;
  }

  /**
   * 把「覆盖/删除前的旧内容」登记为覆盖前备份：物理内容已由调用处 putBase 写入
   * base 池（hash 去重），这里只累积元数据，待本次同步结束统一 commitBackups，
   * 避免每个文件都全量读写 backups.json。
   */
  private bufferBackup(relPath: string, content: Uint8Array): void {
    this.backupBuffer.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      time: Date.now(),
      relPath,
      hash: md5Hex(content),
      size: content.length,
    });
  }

  // ---------------- 本地扫描 ----------------

  private async ensureLocalDir(relDir: string): Promise<void> {
    if (!relDir) return;
    const parts = relDir.split('/');
    let cur = '';
    for (const p of parts) {
      cur = cur ? `${cur}/${p}` : p;
      await this.vadapter()
        .mkdir(cur)
        .catch(() => {
          /* 已存在 */
        });
    }
  }

  /**
   * 判断本地 IO 错误是否为「文件被占用/锁定」类（Windows EBUSY/EPERM、macOS 锁）。
   * 这类错误是瞬时性的（其他进程/编辑器短暂持有句柄），重试有机会成功；
   * 但与内容/权限无关，绝不可因重试而掩盖真正的写入失败。
   */
  private static isFileLockError(e: unknown): boolean {
    if (!(e instanceof Error)) return false;
    const msg = e.message || '';
    return /EBUSY|EPERM|EACCES|locked|being used by another|in use|text file busy|resource temporarily unavailable/i.test(
      msg,
    );
  }

  private async writeLocalFile(relPath: string, bytes: Uint8Array, backup: boolean): Promise<void> {
    const exists = await this.vadapter().exists(relPath);
    if (exists && backup) {
      const old = new Uint8Array(await this.vadapter().readBinary(relPath));
      this.bufferBackup(relPath, old);
    }
    const dir = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '';
    await this.ensureLocalDir(dir);
    // 本地文件占用/锁定：最多重试 3 次（指数退避），数据安全不受影响——
    // 重试的是「写入动作」，内容 bytes 始终来自已校验的源（云端/本地备份）。
    let lastErr: unknown;
    for (let attempt = 0; attempt <= 3; attempt++) {
      try {
        await this.vadapter().writeBinary(relPath, u8ToArrayBuffer(bytes));
        return;
      } catch (e) {
        lastErr = e;
        if (!SyncEngine.isFileLockError(e) || attempt === 3) throw e;
        await sleep(300 * Math.pow(2, attempt) + Math.floor(Math.random() * 200));
      }
    }
    throw lastErr;
  }

  /**
   * 写入本地文件后生成 lastSync 状态：mtime/size 取磁盘真实值。
   * 若用 Date.now() 代替，下次扫描时 `last.mtime === st.mtime` 必然不成立，
   * 会把刚下载的每个文件都重新读盘做一次 MD5（大库表现为同步后卡顿）。
   */
  private async stateAfterLocalWrite(
    relPath: string,
    bytes: Uint8Array,
    hash: string,
  ): Promise<FileState> {
    const st = await this.vadapter()
      .stat(relPath)
      .catch(() => null);
    const state: FileState = {
      path: relPath,
      mtime: st?.mtime ?? Date.now(),
      size: st?.size ?? bytes.length,
      hash,
      byDevice: this.s().deviceId,
    };
    this.cacheHash(relPath, { mtime: state.mtime, size: state.size, hash });
    return state;
  }

  /**
   * 上传带宽节流。按 settings.bandwidthLimitKBps 计算本次应 sleep 的毫秒数，
   * 使实际上行速率不超过上限。0 = 不限速。用 carry 累积余数，避免小分片抖动。
   */
  private async throttleBandwidth(bytes: number): Promise<void> {
    const kbps = this.s().bandwidthLimitKBps;
    if (!kbps || kbps <= 0) return;
    const ms = (bytes / 1024 / kbps) * 1000 + this.bandwidthCarry;
    if (ms < 1) {
      this.bandwidthCarry = ms;
      return;
    }
    const whole = Math.floor(ms);
    this.bandwidthCarry = ms - whole;
    await sleep(whole);
  }

  private async readLocalFile(relPath: string): Promise<Uint8Array | null> {
    try {
      if (!(await this.vadapter().exists(relPath))) return null;
      // 读取被其他进程短暂锁定的文件：重试几次，避免把「临时读不到」误判为删除。
      for (let attempt = 0; attempt <= 3; attempt++) {
        try {
          return new Uint8Array(await this.vadapter().readBinary(relPath));
        } catch (e) {
          if (!SyncEngine.isFileLockError(e) || attempt === 3) {
            if (SyncEngine.isFileLockError(e)) return null; // 锁文件读不到：视为暂不可读，不报错
            throw e;
          }
          await sleep(300 * Math.pow(2, attempt) + Math.floor(Math.random() * 200));
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  /** 递归扫描 vault，返回相对路径 → 状态 */
  private async scanLocal(
    filter: PathFilter,
    lastSync: Record<string, FileState>,
    onProgress?: (n: number) => void,
  ): Promise<Map<string, FileState>> {
    const out = new Map<string, FileState>();
    const visited = new Set<string>();
    const walk = async (dir: string): Promise<void> => {
      // 防御符号链接成环 / 适配器返回自身导致的无限递归
      if (visited.has(dir)) return;
      visited.add(dir);

      let listing: { files: string[]; folders: string[] };
      try {
        listing = await this.vadapter().list(dir || '/');
      } catch {
        return;
      }
      for (const rawFile of listing.files || []) {
        const rel = toVaultPath(dir, rawFile);
        if (filter.isExcluded(rel)) continue;
        const st = await this.vadapter()
          .stat(rel)
          .catch(() => null);
        if (!st) continue;
        if (filter.isOversized(st.size)) continue;
        let hash = '';
        const cached = this.hashCache.get(rel);
        if (cached && cached.mtime === st.mtime && cached.size === st.size) {
          hash = cached.hash;
        } else {
          const last = lastSync[rel];
          if (last && !last.deleted && last.mtime === st.mtime && last.size === st.size) {
            hash = last.hash;
          } else {
            const bytes = await this.readLocalFile(rel);
            if (!bytes) continue;
            // 大文件走异步哈希（原生 Web Crypto / 后台），避免主线程阻塞
            hash = bytes.length > MD5_ASYNC_THRESHOLD ? await md5HexAsync(bytes) : md5Hex(bytes);
          }
          this.cacheHash(rel, { mtime: st.mtime, size: st.size, hash });
        }
        out.set(rel, {
          path: rel,
          mtime: st.mtime,
          size: st.size,
          hash,
          byDevice: this.s().deviceId,
        });
        if (onProgress && out.size % 100 === 0) onProgress(out.size);
      }
      for (const rawDir of listing.folders || []) {
        const rel = toVaultPath(dir, rawDir);
        if (rel === dir) continue; // 适配器把自身也列出来的极端情况
        if (filter.isExcluded(rel)) continue;
        // 隐藏目录与 .obsidian 的判定必须基于最后一段，而非整条路径
        const name = baseName(rel);
        if (name === '.obsidian') {
          if (this.s().syncConfigDir) await walk(rel);
          continue;
        }
        if (this.s().skipHiddenFiles && name.startsWith('.')) continue;
        await walk(rel);
      }
    };
    await walk('');
    return out;
  }

  /**
   * 孤儿文件对账：磁盘存在但本地索引没有有效锚点的文件。
   * 常见于同步中途崩溃/断线（文件已下载/上传，但 localIndex 未保存）。
   * 修复策略：
   *   - 云端 hash 与本地一致 → 补 lastSync（跳过，不重复上传）
   *   - 云端 hash 与本地不一致 → 清除旧锚点，让 buildPlan 按 create-create 冲突处理（保留双方）
   *   - 云端没有该文件 → 不处理，buildPlan 会按新增 upload
   * 返回修复的文件数（用于日志）。
   */
  private async reconcileOrphans(
    localScan: Map<string, FileState>,
    localIndex: LocalIndex,
    remoteIndex: ResolvedRemoteIndex,
    filter: PathFilter,
  ): Promise<number> {
    let fixed = 0;
    for (const [path, L] of localScan) {
      if (filter.isExcluded(path)) continue;
      const S = localIndex.files[path];
      if (S && !S.deleted) continue; // 已有有效锚点
      const R = remoteIndex.files[path];
      if (R && !R.deleted && R.hash) {
        if (R.hash === L.hash) {
          localIndex.files[path] = {
            ...L,
            remoteSize: R.remoteSize,
            fsId: R.fsId,
            byDevice: R.byDevice || this.s().deviceId,
          };
          fixed++;
        } else {
          // 两端都有但内容不同：清除旧墓碑/旧锚点，让决策矩阵走冲突保留分支
          delete localIndex.files[path];
        }
      }
      // 云端也没有：交给 buildPlan 的 L && !R && !S → upload
    }
    return fixed;
  }

  // ---------------- 决策矩阵 ----------------

  private buildPlan(
    localScan: Map<string, FileState>,
    remoteTree: Map<string, { size: number; mtime: number; fsId: string }>,
    remoteIndex: ResolvedRemoteIndex,
    localIndex: { files: Record<string, FileState> },
    filter: PathFilter,
    direction: SyncDirection = 'bidirectional',
  ): Action[] {
    const actions: Action[] = [];
    const keys = new Set<string>([
      ...localScan.keys(),
      ...remoteTree.keys(),
      ...Object.keys(localIndex.files),
      ...Object.keys(remoteIndex.files),
    ]);

    for (const path of keys) {
      if (filter.isExcluded(path)) continue;
      const L = localScan.get(path) || null;
      const entry = remoteTree.get(path) || null;
      const rIdx = remoteIndex.files[path] || null;
      // 远端实际存在性以目录树为准；hash 仅在索引条目与网盘现状一致时才可信
      let R: FileState | null = null;
      if (entry) {
        const idxFresh = !!rIdx && !rIdx.deleted && remoteIndexInSync(rIdx, entry);
        R = {
          path,
          mtime: entry.mtime,
          size: entry.size,
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          hash: idxFresh ? rIdx!.hash : '',
          fsId: entry.fsId,
        };
      }
      // 系统目录（.obsidian/.trash/.bdnsync）在任意方向都完全隔离：
      // 不扫描、不传播、不删除。默认 scanLocal 不产出 .obsidian 的 L，若用户曾在
      // 云端手动放置，force-download 不应把它下载到本地，force-upload 也不应上传本地
      // 系统目录。这里在 force 方向下直接将系统目录整体跳过（既不删也不传输）。
      const isSystemDir =
        path === '.obsidian' ||
        path.startsWith('.obsidian/') ||
        path.startsWith('.trash/') ||
        path.startsWith('.bdnsync/');
      if (isSystemDir && direction !== 'bidirectional') continue;
      const S =
        localIndex.files[path] && !localIndex.files[path].deleted ? localIndex.files[path] : null;

      // 决策矩阵下沉为纯函数 planEntry，便于单元测试覆盖（不依赖引擎实例）
      const acts = planEntry(path, {
        L,
        R,
        S,
        direction,
        deleteStrategy: this.s().deleteStrategy,
        remoteSize: entry ? entry.size : 0,
      });
      actions.push(...acts);
    }
    return actions;
  }

  /**
   * 生成同步计划预览（dry-run）：复用 buildPlan 的决策矩阵，但不执行任何 I/O，
   * 仅统计将要进行的操作类型与数量，并抽样展示样例。供手动同步前确认。
   * 注意：调用方需先完成 listRemote/scanLocal（与 fullSync 同流程），成本在于扫描本身，
   * 预览本身只是对 actions 数组的聚合，几乎零额外开销。
   */
  async buildPreviewPlan(direction: SyncDirection = 'bidirectional'): Promise<SyncPlanPreview> {
    const settings = this.s();
    const filter = new PathFilter(settings);
    const localIndex = await this.store.loadLocalIndex();
    const remoteIndex = (await this.adapter.readRemoteIndex()) || this.newRemoteIndex();
    const remoteTree = await this.adapter.listTree();
    const localScan = await this.scanLocal(filter, localIndex.files);
    const isFirst = localIndex.lastSyncAt === 0;
    const dir: SyncDirection =
      isFirst && localScan.size > 0 && remoteTree.size > 0
        ? direction !== 'bidirectional'
          ? direction
          : 'bidirectional'
        : direction;
    const actions = this.buildPlan(localScan, remoteTree, remoteIndex, localIndex, filter, dir);
    const samples: SyncPlanPreview['samples'] = [];
    let upload = 0,
      download = 0,
      deleteLocal = 0,
      deleteRemote = 0,
      conflicts = 0,
      skip = 0;
    for (const a of actions) {
      if (a.type === 'upload') {
        upload++;
        if (samples.length < 12) samples.push({ path: a.path, op: 'upload' });
      } else if (a.type === 'download') {
        download++;
        if (samples.length < 12) samples.push({ path: a.path, op: 'download' });
      } else if (a.type === 'delete-local') {
        deleteLocal++;
        if (samples.length < 12) samples.push({ path: a.path, op: 'delete-local' });
      } else if (a.type === 'delete-remote') {
        deleteRemote++;
        if (samples.length < 12) samples.push({ path: a.path, op: 'delete-remote' });
      } else if (a.type === 'conflict') {
        conflicts++;
        if (samples.length < 12) samples.push({ path: a.path, op: 'conflict' });
      } else if (a.type === 'skip') {
        skip++;
      }
    }
    return {
      direction: dir,
      upload,
      download,
      deleteLocal,
      deleteRemote,
      conflicts,
      skip,
      samples,
      generatedAt: Date.now(),
    };
  }

  // ---------------- 完整同步 ----------------

  async fullSync(
    trigger: 'manual' | 'startup' | 'auto' | 'online' | 'conflict-resolve' = 'manual',
    direction: SyncDirection = 'bidirectional',
    /** 由 quickSync 委托调用时传入：此时 syncing 由 quickSync 自身持有，语义安全，允许重入 */
    reentrant = false,
  ): Promise<SyncResult | null> {
    if (this.syncing && !reentrant) {
      this.notify('BDNSync：已有同步正在进行，请稍候');
      return null;
    }
    const settings = this.s();
    if (!settings.bduss && !settings.cookies && !settings.accessToken) {
      this.statusBar.setError('未配置连接');
      this.notify('BDNSync：请先在设置中配置百度网盘连接（BDUSS/Cookie 或 access_token）');
      return null;
    }

    this.syncing = true;
    const stats: SyncStats = {
      uploaded: 0,
      downloaded: 0,
      deletedLocal: 0,
      deletedRemote: 0,
      conflicts: 0,
      skipped: 0,
      errors: 0,
      bytesUp: 0,
      bytesDown: 0,
      errorMessages: [],
    };
    const conflictReport: ConflictReportEntry[] = [];
    const syncStartAt = Date.now();

    try {
      this.statusBar.setSyncing('正在对比…');
      const filter = new PathFilter(settings);
      const localIndex = await this.store.loadLocalIndex();
      const remoteIndex = (await this.adapter.readRemoteIndex()) || this.newRemoteIndex();
      this.statusBar.setSyncing('正在扫描远程目录…');
      const remoteTree = await this.adapter.listTree();
      this.statusBar.setSyncing('正在扫描本地文件…');
      const localScan = await this.scanLocal(filter, localIndex.files, (n) => {
        this.statusBar.setSyncing(`正在扫描本地文件…（已扫描 ${n}）`);
      });

      // 崩溃/断线安全：本地文件已落盘但索引未提交时，下次同步会把它们误判为「新文件」
      // 导致重复上传或错误冲突。启动对账：用云端 hash 校准这些「孤儿文件」的锚点。
      const orphansFixed = await this.reconcileOrphans(localScan, localIndex, remoteIndex, filter);
      if (orphansFixed > 0) {
        engineLog('info', `孤儿文件对账：已修复 ${orphansFixed} 个文件的本地索引锚点`);
      }

      const isFirst = localIndex.lastSyncAt === 0;
      let actions: Action[];
      let mode: 'merge' | 'cloud' | 'local' = 'merge';

      if (isFirst && localScan.size > 0 && remoteTree.size > 0) {
        // 首次同步保护
        const choice = await this.askFirstSync(localScan.size, remoteTree.size);
        if (choice === 'cancel') {
          this.statusBar.setIdle();
          return { ok: false, cancelled: true, ...stats };
        }
        mode = choice;
        // 「用云端覆盖本地」→ 云端为真相；「用本地覆盖云端」→ 本地为真相；
        // 二者直接复用决策矩阵的单向覆盖分支，避免两套逻辑分叉。
        const dir: SyncDirection =
          choice === 'cloud'
            ? 'force-download'
            : choice === 'local'
              ? 'force-upload'
              : 'bidirectional';
        actions = this.buildPlan(localScan, remoteTree, remoteIndex, localIndex, filter, dir);
      } else {
        actions = this.buildPlan(localScan, remoteTree, remoteIndex, localIndex, filter, direction);
      }

      // 大规模删除保护：云端根目录被移动/改名、凭据换成了另一个账号、本地库还没完全落盘
      // （云盘占位文件）等情况，都会让决策矩阵把「对面整体缺失」误读成「对面删除了文件」，
      // 从而单向清空一整边。这里在执行前拦一道。
      const guard = await this.checkDeleteGuard(
        actions,
        localScan.size,
        remoteTree.size,
        direction !== 'bidirectional' || !isFirst,
      );
      if (guard === 'cancel') {
        this.statusBar.setIdle();
        this.notify('BDNSync：已取消本次同步，未改动任何文件');
        return { ok: false, cancelled: true, ...stats };
      }
      if (guard === 'skip-deletes') {
        const before = actions.length;
        actions = actions.filter((a) => a.type !== 'delete-local' && a.type !== 'delete-remote');
        this.notify(`BDNSync：已跳过 ${before - actions.length} 个删除操作，仅同步新增与修改`);
      }

      // 整库快照点：force 方向（破坏性修复）执行前生成轻量索引，误删后可整库回滚
      if (direction !== 'bidirectional' && this.s().autoSnapshot) {
        const snap = this.buildSnapshot(localScan, remoteTree, remoteIndex, direction);
        this.store.pushSnapshot(localIndex, snap, this.s().maxSnapshots);
        this.notify(
          `BDNSync：已生成整库快照点（${snap.totalFiles} 个文件），误删可在「同步统计 → 快照」回滚`,
          6000,
        );
      }

      // 执行
      const finalStates = new Map<string, FileState>(); // path → 最终 lastSync 状态（null 表示清除）
      const remoteChanges = new Map<string, FileState>(); // 需写入远程索引的状态
      const remoteDeletes = new Set<string>(); // 需从远程索引删除的路径
      const uploadedThisRun = new Map<string, string>(); // path → 我们上传的 hash（竞态检测）
      const pendingRemoteDeletes: string[] = [];

      const doDownload = async (a: Extract<Action, { type: 'download' }>) => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          const entry = remoteTree.get(a.path)!;
          const bytes = await this.adapter.download(
            {
              path: a.path,
              name: a.path.split('/').pop() || a.path,
              isDir: false,
              size: a.remoteSize,
              mtime: a.remoteState.mtime,
              fsId: entry.fsId,
            },
            a.remoteState.hash || undefined,
          );
          await this.writeLocalFile(a.path, bytes, this.s().autoBackup);
          const hash = a.remoteState.hash || md5Hex(bytes);
          const st = await this.stateAfterLocalWrite(a.path, bytes, hash);
          finalStates.set(a.path, st);
          // 远程索引记录云端侧事实：落盘字节数 + fs_id + server_mtime
          remoteChanges.set(a.path, {
            ...st,
            mtime: a.remoteState.mtime,
            size: bytes.length,
            remoteSize: entry.size,
            fsId: entry.fsId,
          });
          await this.store.putBase(hash, bytes);
          stats.downloaded++;
          stats.bytesDown += a.remoteSize;
          this.statusBar.setProgress(stats.downloaded, stats.uploaded);
        } catch (e) {
          // 网盘容量不足（errno=31326）：这是整轮可短路的终止性错误，不必逐个文件失败。
          // 置位后由下方统一处理（给出清晰中文提示 + 配额预检建议），剩余下载跳过以免
          // 反复打接口浪费配额；已下载成功的文件仍保留（数据安全优先）。
          if (e instanceof BaiduApiError && e.errno === 31326) {
            this.quotaExhausted = true;
            stats.errors++;
            stats.errorMessages.push(`网盘容量不足，已停止下载剩余文件：${a.path}`);
            return;
          }
          // 下载校验（hash 不一致）连续失败：本地索引与云端严重失配的信号
          if (e instanceof BaiduApiError && /下载校验失败/.test(e.message)) {
            this.downloadVerifyFails++;
          }
          stats.errors++;
          stats.errorMessages.push(`下载失败 ${a.path}: ${errText(e)}`);
        }
      };

      const doUpload = async (a: Extract<Action, { type: 'upload' }>, bytes?: Uint8Array) => {
        try {
          const content = bytes ?? (await this.readLocalFile(a.path));
          if (!content) throw new BaiduApiError(0, `本地文件读取失败：${a.path}`);
          await this.throttleBandwidth(content.length);
          const hash = a.local ? a.local.hash : md5Hex(content);
          const res = await this.adapter.upload(a.path, content, {
            onProgress: () => this.statusBar.setProgress(stats.downloaded, stats.uploaded),
            // F1：每分块成功后立即持久化会话，崩溃重启后可续传而非从 precreate 重来
            onPartDone: (_session) => {
              void this.store.saveTransferState(this.adapter.exportSessions()).catch(() => {
                /* 落盘失败不阻断上传 */
              });
            },
          });
          const lst = await this.vadapter()
            .stat(a.path)
            .catch(() => null);
          const st: FileState = {
            path: a.path,
            mtime: a.local?.mtime ?? lst?.mtime ?? Date.now(),
            size: content.length,
            hash,
            byDevice: this.s().deviceId,
          };
          finalStates.set(a.path, st);
          remoteChanges.set(a.path, { ...st, remoteSize: res.remoteSize, fsId: res.fsId });
          uploadedThisRun.set(a.path, hash);
          await this.store.putBase(hash, content);
          stats.uploaded++;
          stats.bytesUp += res.bytesUp;
          this.statusBar.setProgress(stats.downloaded, stats.uploaded);
        } catch (e) {
          stats.errors++;
          stats.errorMessages.push(`上传失败 ${a.path}: ${errText(e)}`);
        }
      };

      // 1) 下载（并发）
      const downloads = actions.filter((a) => a.type === 'download') as Extract<
        Action,
        { type: 'download' }
      >[];
      if (downloads.length) this.statusBar.setSyncing(`正在下载 ${downloads.length} 个文件…`);
      await runWithConcurrency(
        downloads.map((a) => () => doDownload(a)),
        Math.max(1, this.s().downloadConcurrency),
      );

      // 1.5) 下载后短路判定（沉浸无感 + 数据安全：不浪费配额、不掩盖根因）
      if (this.quotaExhausted) {
        // 容量不足是账户级配额，上传同样会失败。为避免无意义地逐个报错刷屏，
        // 将剩余的下载与上传一并短路（已成功落盘的文件保留，数据安全优先），
        // 给出明确指引，待用户清理空间后重新同步即可完整补回。
        this.notify(
          'BDNSync：百度网盘容量不足，已暂停剩余上传/下载。请清理网盘空间后重新同步。',
          9000,
        );
        engineLog('error', '网盘容量不足（errno=31326），已短路上传/下载阶段');
        const skipTypes = new Set(['download', 'upload']);
        actions = actions.filter((x) => !skipTypes.has(x.type));
        this.quotaExhausted = false; // 仅本次同步短路，下次正常尝试
      } else if (this.downloadVerifyFails >= 5) {
        // 校验连续失败：本地索引与云端严重失配（常见于索引损坏/加密切换残留）。
        // 引导用户在无感前提下重置本地索引做全量对账，而非每文件报错。
        this.notify(
          'BDNSync：检测到多个文件下载校验失败，本地索引可能与云端失配。可在「同步统计 → 高级」中「重置本地索引」后重新同步。',
          10000,
        );
        engineLog('warn', `下载校验连续失败 ${this.downloadVerifyFails} 次，建议重置本地索引`);
      }

      // 2) 上传（并发）
      const uploads = actions.filter((a) => a.type === 'upload') as Extract<
        Action,
        { type: 'upload' }
      >[];
      if (uploads.length) this.statusBar.setSyncing(`正在上传 ${uploads.length} 个文件…`);
      await runWithConcurrency(
        uploads.map((a) => () => doUpload(a)),
        Math.max(1, this.s().uploadConcurrency),
      );

      // 3) 跳过（两端内容一致）
      // 仅当远程索引条目缺失/过期时才补写，否则「无变更同步」也会重写并上传整份索引。
      for (const a of actions as Action[]) {
        if (a.type !== 'skip') continue;
        stats.skipped++;
        finalStates.set(a.path, a.local);
        const entry = remoteTree.get(a.path);
        const rIdx = remoteIndex.files[a.path];
        const consistent =
          !!rIdx &&
          !rIdx.deleted &&
          rIdx.hash === a.local.hash &&
          (!entry || remoteIndexInSync(rIdx, entry));
        if (consistent) continue;
        remoteChanges.set(
          a.path,
          entry
            ? {
                path: a.path,
                mtime: entry.mtime,
                size: a.local.size,
                hash: a.local.hash,
                remoteSize: entry.size,
                fsId: entry.fsId,
                byDevice: rIdx?.byDevice ?? this.s().deviceId,
              }
            : { ...a.local, byDevice: this.s().deviceId },
        );
      }

      // 4) 冲突
      const conflicts = actions.filter((a) => a.type === 'conflict') as Extract<
        Action,
        { type: 'conflict' }
      >[];
      for (const c of conflicts) {
        try {
          const outcome = await this.handleConflict(c, {
            remoteTree,
            localIndex,
            finalStates,
            remoteChanges,
            remoteDeletes,
            uploadedThisRun,
            stats,
            pendingRemoteDeletes,
            conflictReport,
            doUploadRef: doUpload,
          });
          if (outcome) {
            conflictReport.push({
              path: c.path,
              kind: c.kind,
              strategy: this.s().conflictStrategy,
              outcome: outcome.note,
              at: Date.now(),
            });
          }
        } catch (e) {
          stats.errors++;
          stats.errorMessages.push(`冲突处理失败 ${c.path}: ${errText(e)}`);
          conflictReport.push({
            path: c.path,
            kind: c.kind,
            strategy: this.s().conflictStrategy,
            outcome: `处理失败：${errText(e)}`,
            at: Date.now(),
          });
        }
      }

      // 5) 本地删除
      for (const a of actions as Action[]) {
        if (a.type !== 'delete-local') continue;
        try {
          const bytes = await this.readLocalFile(a.path);
          if (bytes && this.s().autoBackup) this.bufferBackup(a.path, bytes);
          await this.vadapter()
            .remove(a.path)
            .catch(() => {
              /* 可能已被用户删除 */
            });
          this.hashCache.delete(a.path);
          const tomb = makeTombstone(a.path, this.s().deviceId, a.last.hash);
          remoteChanges.set(a.path, tomb);
          remoteDeletes.delete(a.path);
          finalStates.set(a.path, tomb);
          stats.deletedLocal++;
        } catch (e) {
          stats.errors++;
          stats.errorMessages.push(`本地删除失败 ${a.path}: ${errText(e)}`);
        }
      }

      // 6) 远程删除（批量）
      for (const a of actions as Action[]) {
        if (a.type === 'delete-remote') pendingRemoteDeletes.push(a.path);
      }
      if (pendingRemoteDeletes.length > 0) {
        try {
          await this.adapter.deleteRemote(pendingRemoteDeletes);
          const now = Date.now();
          for (const p of pendingRemoteDeletes) {
            const tomb = makeTombstone(p, this.s().deviceId, '', now);
            remoteChanges.set(p, tomb);
            finalStates.set(p, tomb);
          }
          stats.deletedRemote += pendingRemoteDeletes.length;
        } catch (e) {
          stats.errors++;
          stats.errorMessages.push(`云端删除失败: ${errText(e)}`);
        }
      }

      // 7) 提交远程索引（先合并云端最新，做竞态检测）
      this.statusBar.setSyncing('正在更新同步索引…');
      await this.commitRemoteIndex(remoteIndex, remoteChanges, remoteDeletes, uploadedThisRun, {
        finalStates,
        localIndex,
        stats,
        syncStartAt,
        remoteTree,
      });

      // 8) 保存本地索引
      for (const [p, st] of finalStates) {
        localIndex.files[p] = st;
      }

      // 版本历史：对本次本地写入的文件记录一版（供「恢复上一版本」UI）
      const maxV = this.s().maxVersions;
      if (maxV > 0) {
        for (const [p, st] of finalStates) {
          if (st.deleted || p.startsWith('.obsidian/') || p.startsWith('.trash/')) continue;
          await this.store.recordVersion(
            localIndex,
            p,
            {
              hash: st.hash,
              mtime: st.mtime,
              size: st.size,
              byDevice: st.byDevice || this.s().deviceId,
              deviceName: this.s().deviceName || '本机',
              note: '同步写入',
            },
            maxV,
          );
        }
      }

      // 冲突处理明细报告（审计）
      if (conflictReport.length > 0) {
        this.store.setConflictReport(localIndex, conflictReport);
      }

      localIndex.lastSyncAt = Date.now();
      // 统计
      localIndex.stats.totalUploads += stats.uploaded;
      localIndex.stats.totalDownloads += stats.downloaded;
      localIndex.stats.totalDeletes += stats.deletedLocal + stats.deletedRemote;
      localIndex.stats.totalConflicts += stats.conflicts;
      localIndex.stats.bytesUp += stats.bytesUp;
      localIndex.stats.bytesDown += stats.bytesDown;
      localIndex.stats.syncCount += 1;
      localIndex.stats.lastSyncSummary = summarize(stats);
      localIndex.conflicts = localIndex.conflicts.filter((c) => !c.resolved);
      await this.store.saveLocalIndex(localIndex);
      await this.store.saveTransferState(this.adapter.exportSessions());
      // 统一提交本次同步累积的覆盖前备份元数据（O(1) 批量写，避免逐文件全量 IO）
      if (this.backupBuffer.length > 0) {
        await this.store.commitBackups(this.backupBuffer);
        this.backupBuffer = [];
      }
      // 收集所有引用 base 内容的来源：lastSync 文件、版本历史、整库快照、覆盖前备份。
      // 这是 pruneBase / enforceBaseCacheLimit 不删活跃内容的共同依据。
      const referenced = this.store.collectBaseReferences(localIndex);
      const backups = await this.store.listBackups();
      for (const b of backups) if (b.hash) referenced.add(b.hash);
      await this.store.pruneBase(referenced);
      // 引用清理之后再执行容量上限：仅靠引用计数无法约束体积
      // （冲突副本、频繁改动的大量小文件都会让 base 目录持续增长）。
      await this.store.enforceBaseCacheLimit(referenced);
      await this.store.pruneBackups();

      const unresolved = localIndex.conflicts.length;
      this.onConflictsChanged(unresolved);

      if (stats.errors > 0) {
        this.statusBar.setError(`${stats.errors} 个错误`);
        this.notify(
          `BDNSync 同步完成（有错误）：${summarize(stats)}${stats.errorMessages.length ? `\n${stats.errorMessages.slice(0, 3).join('\n')}` : ''}`,
          8000,
        );
      } else {
        this.statusBar.setDone(summarize(stats));
        const dirLabel =
          direction === 'force-upload'
            ? '已用本地覆盖云端'
            : direction === 'force-download'
              ? '已用云端覆盖本地'
              : mode === 'cloud'
                ? '已用云端覆盖本地'
                : mode === 'local'
                  ? '已用本地覆盖云端'
                  : '同步完成';
        if (
          trigger !== 'auto' ||
          stats.uploaded + stats.downloaded + stats.deletedLocal + stats.deletedRemote > 0
        ) {
          this.notify(`BDNSync ${dirLabel}：${summarize(stats)}`);
        }
      }
      return { ok: stats.errors === 0, ...stats };
    } catch (e) {
      const msg = errText(e);
      this.statusBar.setError(cooldownHint(e));
      this.notify(`BDNSync 同步失败：${msg}`, 8000);
      await this.store.saveTransferState(this.adapter.exportSessions()).catch(() => {
        /* ignore */
      });
      return {
        ok: false,
        ...stats,
        errors: stats.errors + 1,
        errorMessages: [...stats.errorMessages, msg],
      };
    } finally {
      this.syncing = false;
    }
  }

  /**
   * 生成整库快照点（轻量索引）：记录当前本地扫描 + 远程树的文件状态，
   * 用于 force 方向执行前的整库回滚。不含文件内容（内容可由 base 缓存/云端恢复）。
   */
  private buildSnapshot(
    localScan: Map<string, FileState>,
    remoteTree: Map<string, { size: number; mtime: number; fsId: string }>,
    remoteIndex: ResolvedRemoteIndex,
    direction: SyncDirection,
  ): VaultSnapshot {
    const files: VaultSnapshot['files'] = {};
    // 以将要成为「真相」的一侧为基准记录
    const source = direction === 'force-upload' ? localScan : remoteTree;
    let totalBytes = 0;
    for (const [path, st] of source) {
      if (
        path.startsWith('.obsidian/') ||
        path.startsWith('.trash/') ||
        path.startsWith('.bdnsync/')
      )
        continue;
      const size = st.size ?? 0;
      const hash = (st as FileState).hash || (remoteIndex.files[path]?.hash ?? '');
      files[path] = { hash, mtime: st.mtime ?? Date.now(), size };
      totalBytes += size;
    }
    return {
      id: `snap-${Date.now()}-${randomId(4)}`,
      createdAt: Date.now(),
      deviceId: this.s().deviceId,
      deviceName: this.s().deviceName || '本机',
      reason: direction === 'force-upload' ? '强制全量上传前自动备份' : '强制全量下载前自动备份',
      files,
      totalFiles: Object.keys(files).length,
      totalBytes,
    };
  }

  /**
   * 大规模删除保护判定。仅在「明显不正常」时打断用户，日常少量删除不打扰：
   *  - 对面整棵树为空却要删本端 → 根目录/凭据问题
   *  - 单侧删除量 ≥ 5 且占该侧文件总数一半以上 → 疑似误删
   */
  private async checkDeleteGuard(
    actions: Action[],
    localTotal: number,
    remoteTotal: number,
    explicit = false,
  ): Promise<MassDeleteChoice> {
    const dl = actions.filter((a) => a.type === 'delete-local');
    const dr = actions.filter((a) => a.type === 'delete-remote');
    if (dl.length === 0 && dr.length === 0) return 'proceed';

    const threshold = this.s().bulkDeleteConfirm ?? 50;
    let reason = '';
    // 「对侧整树为空却要清空本端」是最致命的误删信号（根目录被改名 / 凭据换账号 /
    // 库未落盘），无论是否显式触发都应拦截——它代表连接本身出错而非用户意图。
    if (remoteTotal === 0 && dl.length > 0) {
      reason =
        '云端目录树为空，却计划删除本地文件。这通常说明远程根目录被移动/重命名，或凭据指向了另一个账号。';
    } else if (localTotal === 0 && dr.length > 0) {
      reason =
        '本地没有扫描到任何文件，却计划删除云端文件。这通常说明库文件尚未落盘（云盘占位文件）或索引来自另一个库。';
    } else if (!explicit) {
      // 非显式（常规自动/增量）同步：阈值与比例异常检测生效，避免静默清空。
      if (threshold > 0 && dl.length + dr.length >= threshold) {
        reason = `本次同步将删除 ${dl.length + dr.length} 个文件（≥ 批量删除确认阈值 ${threshold}）。`;
      } else if (dl.length >= 5 && dl.length >= localTotal * 0.5) {
        reason = `将删除本地 ${dl.length} 个文件，占本地文件总数（${localTotal}）的一半以上。`;
      } else if (dr.length >= 5 && dr.length >= remoteTotal * 0.5) {
        reason = `将删除云端 ${dr.length} 个文件，占云端文件总数（${remoteTotal}）的一半以上。`;
      }
    }
    if (!reason) return 'proceed';

    return this.askMassDelete({
      deleteLocal: dl.length,
      deleteRemote: dr.length,
      localTotal,
      remoteTotal,
      samples: [...dl, ...dr].slice(0, 8).map((a) => a.path),
      reason,
    });
  }

  private newRemoteIndex(): ResolvedRemoteIndex {
    return {
      version: INDEX_VERSION,
      vaultName: this.app.vault.getName(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      deviceId: this.s().deviceId,
      syncVersion: 0,
      files: {},
    };
  }

  /** 冲突处理（按全局策略或推迟） */
  private async handleConflict(
    c: Extract<Action, { type: 'conflict' }>,
    ctx: {
      remoteTree: Map<string, { size: number; mtime: number; fsId: string }>;
      localIndex: LocalIndex;
      finalStates: Map<string, FileState>;
      remoteChanges: Map<string, FileState>;
      remoteDeletes: Set<string>;
      uploadedThisRun: Map<string, string>;
      stats: SyncStats;
      pendingRemoteDeletes: string[];
      conflictReport: ConflictReportEntry[];
      doUploadRef: (a: Extract<Action, { type: 'upload' }>, bytes?: Uint8Array) => Promise<void>;
    },
  ): Promise<{ note: string } | null> {
    const { stats } = ctx;
    const strategy = this.s().conflictStrategy;
    stats.conflicts++;

    const localBytes = c.local ? await this.readLocalFile(c.path) : null;
    let remoteBytes: Uint8Array | null = null;
    if (c.remoteState) {
      const entry = ctx.remoteTree.get(c.path);
      if (entry) {
        remoteBytes = await this.adapter
          .download(
            {
              path: c.path,
              name: c.path.split('/').pop() || c.path,
              isDir: false,
              size: entry.size,
              mtime: c.remoteState.mtime,
              fsId: entry.fsId,
            },
            c.remoteState.hash || undefined,
          )
          .catch(() => null);
      }
    }
    const baseBytes = c.last ? await this.store.getBase(c.last.hash) : null;
    const remoteDevice = c.remoteState?.byDevice;

    const outcome = this.resolver.resolve(
      {
        path: c.path,
        kind: c.kind,
        localBytes,
        remoteBytes,
        baseBytes,
        deviceName: this.s().deviceName || '本机',
        remoteDevice,
      },
      strategy,
    );

    const record: ConflictRecord = {
      path: c.path,
      detectedAt: Date.now(),
      reason: `${c.kind}: ${outcome.note}`,
      kind: c.kind,
      resolved: outcome.action !== 'deferred',
    };
    ctx.localIndex.conflicts.push(record);

    if (outcome.action === 'deferred') {
      // 保留 lastSync 状态，下次同步/面板处理
      if (c.last) ctx.finalStates.set(c.path, c.last);
      // 立即持久化冲突记录：ask-me 模式下用户选择「稍后处理」的意图不能丢，
      // 若同步中途崩溃，下次启动仍能在冲突面板看到该条目。
      await this.store
        .saveLocalIndex(ctx.localIndex)
        .catch((e) => engineLog('warn', `持久化 deferred 冲突失败：${errText(e)}`));
      return null;
    }

    if (outcome.localBytes) {
      await this.writeLocalFile(c.path, outcome.localBytes, this.s().autoBackup);
      const hash = md5Hex(outcome.localBytes);
      const st = await this.stateAfterLocalWrite(c.path, outcome.localBytes, hash);
      ctx.finalStates.set(c.path, st);
      if (outcome.uploadOriginal) {
        await ctx.doUploadRef({ type: 'upload', path: c.path, local: st }, outcome.localBytes);
      } else {
        // 采用云端版本写回本地：云端内容未变，索引条目须沿用云端侧事实
        const entry = ctx.remoteTree.get(c.path);
        ctx.remoteChanges.set(
          c.path,
          entry ? { ...st, mtime: entry.mtime, remoteSize: entry.size, fsId: entry.fsId } : st,
        );
      }
      await this.store.putBase(hash, outcome.localBytes);
    } else if (outcome.action === 'upload-local') {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      await ctx.doUploadRef({ type: 'upload', path: c.path, local: c.local! });
    } else if (outcome.action === 'delete-remote') {
      ctx.pendingRemoteDeletes.push(c.path);
    } else if (outcome.action === 'delete-local') {
      const bytes = await this.readLocalFile(c.path);
      if (bytes && this.s().autoBackup) this.bufferBackup(c.path, bytes);
      await this.vadapter()
        .remove(c.path)
        .catch(() => {
          /* ignore */
        });
      const tomb = makeTombstone(c.path, this.s().deviceId);
      ctx.remoteChanges.set(c.path, tomb);
      ctx.finalStates.set(c.path, tomb);
      stats.deletedLocal++;
    }

    // 冲突副本：写入 + 上传
    for (const copy of outcome.conflictCopies) {
      await this.writeLocalFile(copy.path, copy.bytes, this.s().autoBackup);
      const hash = md5Hex(copy.bytes);
      const st = await this.stateAfterLocalWrite(copy.path, copy.bytes, hash);
      await ctx.doUploadRef({ type: 'upload', path: copy.path, local: st }, copy.bytes);
      await this.store.putBase(hash, copy.bytes);
    }
    return { note: outcome.note };
  }

  /**
   * 合并云端最新索引 + 应用本次变更 + 竞态检测 + 上传。
   *
   * 并发安全（设备 A、B 同时在线同步）：百度网盘没有「条件写」原语，
   * 两设备都读 v=N 再写 v=N+1 会互相覆盖、丢失对方更新。这里用乐观锁重试：
   * 每次写入前重新拉取最新索引，把我们的变更合并到「最新版」上（last-write-wins
   * 中含三方合并/竞态分叉），写完后回读校验版本号是否仍是我们写入的那一版；
   * 若期间被他端抢写，则基于他端的新版再合并一次，最多重试若干轮。
   * 这样无论如何交错，最终索引都收敛到「两设备变更的并集 + 冲突分叉」。
   */
  private async commitRemoteIndex(
    remoteIndex: ResolvedRemoteIndex,
    remoteChanges: Map<string, FileState>,
    remoteDeletes: Set<string>,
    uploadedThisRun: Map<string, string>,
    ctx: {
      finalStates: Map<string, FileState>;
      localIndex: LocalIndex;
      stats: SyncStats;
      syncStartAt: number;
      remoteTree: Map<string, { size: number; mtime: number; fsId: string }>;
    },
  ): Promise<void> {
    if (remoteChanges.size === 0 && remoteDeletes.size === 0) {
      // 无变更：仅清理墓碑（若有）
      const pruned = this.pruneTombstones(remoteIndex);
      if (pruned > 0) await this.adapter.writeRemoteIndex(remoteIndex);
      return;
    }

    const MAX_ATTEMPTS = 6;
    const forkedPaths = new Set<string>(); // 防止重试时重复分叉
    let raceHandled = 0;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      // 1) 拉取最新索引（每次都重新读，捕获他端并发写入）
      const fresh = await this.adapter.readRemoteIndex();
      const base = fresh || this.newRemoteIndex();

      // 2) 竞态检测：本轮上传的文件，若在他端索引中 hash 不同 → 被覆盖，自动分叉保留双方
      for (const [path, ourHash] of uploadedThisRun) {
        if (forkedPaths.has(path)) continue;
        const other = base.files[path];
        if (other && !other.deleted && other.hash && other.hash !== ourHash) {
          const localBytes = await this.readLocalFile(path);
          const entry = ctx.remoteTree.get(path);
          if (entry && localBytes) {
            try {
              const remoteBytes = await this.adapter.download(
                {
                  path,
                  name: path.split('/').pop() || path,
                  isDir: false,
                  size: entry.size,
                  mtime: other.mtime,
                  fsId: entry.fsId,
                },
                other.hash,
              );
              const copyPath = conflictName(path, 'LOCAL');
              await this.writeLocalFile(copyPath, localBytes, this.s().autoBackup);
              await this.writeLocalFile(path, remoteBytes, true);
              const copyRes = await this.adapter.upload(copyPath, localBytes);
              const copyHash = md5Hex(localBytes);
              const copyState = await this.stateAfterLocalWrite(copyPath, localBytes, copyHash);
              base.files[copyPath] = {
                ...copyState,
                remoteSize: copyRes.remoteSize,
                fsId: copyRes.fsId,
              };
              ctx.finalStates.set(copyPath, copyState);
              await this.store.putBase(copyHash, localBytes);
              ctx.finalStates.set(
                path,
                await this.stateAfterLocalWrite(path, remoteBytes, other.hash),
              );
              base.files[path] = other; // 保留他端条目
              forkedPaths.add(path);
              ctx.stats.conflicts++;
              ctx.localIndex.conflicts.push({
                path,
                detectedAt: Date.now(),
                reason: 'race: 检测到同步期间被其他设备覆盖，已保留双方版本',
                kind: 'race',
                resolved: true,
              });
              raceHandled++;
            } catch {
              // 竞态处理失败：保留本地条目，下次同步再对账
            }
          }
        }
      }

      // 3) 应用我们的变更（竞态已分叉的路径保留他端版本）
      for (const [path, st] of remoteChanges) {
        if (forkedPaths.has(path)) continue;
        base.files[path] = st;
      }
      for (const p of remoteDeletes) delete base.files[p];

      // 4) 乐观锁：版本号在最新版基础上 +1
      base.syncVersion = (fresh?.syncVersion ?? 0) + 1;
      base.deviceId = this.s().deviceId;
      base.version = INDEX_VERSION;
      this.pruneTombstones(base);
      const ourVersion = base.syncVersion;
      await this.adapter.writeRemoteIndex(base);

      // 5) 回读校验：若云端版本号仍等于我们写入的版本，说明这一轮间隙无人抢写 → 成功
      const verify = await this.adapter.readRemoteIndex();
      if (verify && verify.syncVersion === ourVersion) {
        if (raceHandled > 0)
          this.notify(
            `BDNSync：检测到 ${raceHandled} 个文件在同步期间被其他设备覆盖，已自动保留双方版本`,
          );
        ctx.localIndex.lastRemoteSyncVersion = ourVersion;
        return;
      }
      // 他端在我们写后抢先写入 → 下一轮基于他端新版再合并
      console.info(`[BDNSync] 远程索引存在并发写入，第 ${attempt + 1} 次重试合并`);
    }

    // 重试耗尽：以最后写入的版本为准（已尽力合并），提示用户
    const last = await this.adapter.readRemoteIndex();
    ctx.localIndex.lastRemoteSyncVersion =
      last?.syncVersion ?? ctx.localIndex.lastRemoteSyncVersion;
    if (raceHandled > 0)
      this.notify(`BDNSync：检测到 ${raceHandled} 个文件被其他设备覆盖，已自动保留双方版本`);
    this.notify(
      'BDNSync：检测到同步索引并发写入，已尽力合并；若个别文件仍不一致，可在冲突面板确认。',
      6000,
    );
  }

  private pruneTombstones(idx: ResolvedRemoteIndex): number {
    const now = Date.now();
    let removed = 0;
    for (const [path, st] of Object.entries(idx.files)) {
      if (st.deleted && st.deletedAt && now - st.deletedAt > TOMBSTONE_TTL) {
        delete idx.files[path];
        removed++;
      }
    }
    return removed;
  }

  // ---------------- 实时增量同步（Sync On Save） ----------------

  async quickSync(paths: string[]): Promise<SyncResult> {
    if (this.syncing) return NOTHING; // 正在完整同步时忽略（完整同步会覆盖增量）
    const settings = this.s();
    if (!settings.bduss && !settings.cookies && !settings.accessToken) return NOTHING;

    this.syncing = true;
    try {
      // 每次增量同步开始时重置「下载校验连续失败」计数，避免跨 run 累积导致
      // 旧 run 的失败数被复用到新 run，误触发「重置本地索引」引导提示。
      this.downloadVerifyFails = 0;
      const localIndex = await this.store.loadLocalIndex();
      const remoteIndex = (await this.adapter.readRemoteIndex()) || null;
      if (!remoteIndex) {
        // 从未建立索引 → 退化为完整同步（保持 busy 锁，用 reentrant 委托，避免重入被 busy 检查吞掉）
        await this.fullSync('manual', 'bidirectional', true);
        return NOTHING;
      }

      const remoteChanges = new Map<string, FileState>();
      const finalStates = new Map<string, FileState>();
      const uploadedThisRun = new Map<string, string>();
      const pendingDeletes: string[] = [];
      let uploaded = 0,
        deleted = 0,
        renamed = 0;
      let needsFullSync = false;

      // ---- 重命名感知（F2）----
      // Obsidian vault.on('rename') 会为 oldPath（删除）和 newPath（新增）各触发一次事件，
      // 若不处理会被当成「删除旧 + 上传新」，造成一次云端删除 + 一次冗余上传且丢失 fs_id。
      // 这里在同一批 paths 内识别「old 本地已删 + new 本地存在且 hash == old 的锚点 hash」的配对，
      // 改用 api.move 保留云端 fs_id。纯本地 rename 且云端从无该文件时，下方仍走普通上传。
      const localMissing: string[] = []; // 本地已不存在（可能 rename 的源）
      const localPresent = new Map<string, { hash: string; bytes: Uint8Array }>();
      for (const p of paths) {
        if (new PathFilter(settings).isExcluded(p)) continue;
        const b = await this.readLocalFile(p);
        if (b) localPresent.set(p, { hash: md5Hex(b), bytes: b });
        else if (localIndex.files[p] && !localIndex.files[p].deleted) localMissing.push(p);
      }
      const renamedSet = new Set<string>(); // 已作为 rename 目标处理的 newPath
      const renamedSources = new Set<string>(); // 已作为 rename 源处理的 oldPath
      for (const oldP of localMissing) {
        const oldS = localIndex.files[oldP];
        if (!oldS || oldS.deleted) continue;
        // 找一个 newPath：本地存在、且 hash 等于 old 锚点 hash
        for (const [newP, info] of localPresent) {
          if (renamedSet.has(newP)) continue;
          if (info.hash !== oldS.hash) continue;
          const R = remoteIndex.files[oldP];
          if (!R || R.deleted || !R.fsId) continue; // 云端旧条目必须存在才能 move
          try {
            this.statusBar.setSyncing(
              `正在重命名 ${oldP.split('/').pop()} → ${newP.split('/').pop()}…`,
            );
            await this.adapter.renameRemote(oldP, newP);
            // 更新索引：new 继承 old 的 remote 态（fsId/hash），old 置墓碑
            const lst = await this.vadapter()
              .stat(newP)
              .catch(() => null);
            const st: FileState = {
              path: newP,
              mtime: lst?.mtime ?? Date.now(),
              size: info.bytes.length,
              hash: info.hash,
              byDevice: settings.deviceId,
            };
            remoteChanges.set(newP, {
              ...st,
              remoteSize: R.remoteSize ?? info.bytes.length,
              fsId: R.fsId,
            });
            finalStates.set(newP, st);
            remoteChanges.set(oldP, makeTombstone(oldP, settings.deviceId, oldS.hash));
            finalStates.set(oldP, makeTombstone(oldP, settings.deviceId, oldS.hash));
            this.cacheHash(newP, { mtime: st.mtime, size: st.size, hash: st.hash });
            this.hashCache.delete(oldP);
            renamedSet.add(newP);
            renamedSources.add(oldP);
            renamed++;
            engineLog('info', `增量同步识别重命名：${oldP} → ${newP}`);
          } catch (e) {
            // move 失败不致命：回退为该 newPath 普通上传（下方循环会处理，因为它还在 localPresent）
            engineLog(
              'warn',
              `重命名 move 失败，回退普通上传：${oldP} → ${newP} (${(e as Error).message})`,
            );
          }
          break;
        }
      }

      for (const path of paths) {
        if (new PathFilter(settings).isExcluded(path)) continue;
        // 跳过已作为重命名识别的源/目标（已在上方处理）
        if (renamedSources.has(path) || renamedSet.has(path)) continue;
        const bytes = await this.readLocalFile(path);
        const S = localIndex.files[path];
        if (bytes) {
          const hash = md5Hex(bytes);
          if (S && !S.deleted && S.hash === hash) continue; // 未变化
          const R = remoteIndex.files[path];
          if (R && !R.deleted && S && !S.deleted && R.hash !== S.hash && hash !== S.hash) {
            // 本地与云端同时变更 → 交给完整同步合并（保持 busy 锁，reentrant 委托）
            needsFullSync = true;
            break;
          }
          this.statusBar.setSyncing(`正在上传 ${path.split('/').pop()}…`);
          const res = await this.adapter.upload(path, bytes);
          const lst = await this.vadapter()
            .stat(path)
            .catch(() => null);
          const st: FileState = {
            path,
            mtime: lst?.mtime ?? Date.now(),
            size: bytes.length,
            hash,
            byDevice: settings.deviceId,
          };
          remoteChanges.set(path, { ...st, remoteSize: res.remoteSize, fsId: res.fsId });
          finalStates.set(path, st);
          uploadedThisRun.set(path, hash);
          this.cacheHash(path, { mtime: st.mtime, size: st.size, hash });
          await this.store.putBase(hash, bytes);
          uploaded++;
        } else if (S && !S.deleted) {
          // 本地删除 → 删云端。但若云端在此期间被其他设备改过（hash 与 lastSync 不同），
          // 直接删会丢掉对方的修改，交给完整同步按删除策略裁决。
          const R = remoteIndex.files[path];
          if (R && !R.deleted && R.hash && S.hash && R.hash !== S.hash) {
            needsFullSync = true;
            break;
          }
          pendingDeletes.push(path);
          const tomb = makeTombstone(path, settings.deviceId, S.hash);
          remoteChanges.set(path, tomb);
          finalStates.set(path, tomb);
          this.hashCache.delete(path);
          deleted++;
        }
      }

      if (needsFullSync) {
        // 检测到本地/云端并发修改，交还完整同步做三方合并（保持 busy 锁，reentrant 委托）
        this.statusBar.setSyncing('检测到并发修改，转交完整同步合并…');
        await this.fullSync('manual', 'bidirectional', true);
        return NOTHING;
      }

      if (remoteChanges.size === 0) return NOTHING;

      // 增量同步的「大规模删除保护」：fullSync 有 checkDeleteGuard 兜底，但增量路径
      // 直接走 deleteRemote，若 remoteRoot 误指空目录 / 凭据换账号（旧库内容云端全缺），
      // 会把「对面整体缺失」误读成「本地删除」，静默清空整库云端文件且无快照。
      // 这里复用与 checkDeleteGuard 完全一致的判定与 askMassDelete 弹窗机制。
      if (pendingDeletes.length > 0) {
        const remoteTotal = remoteIndex ? Object.keys(remoteIndex.files).length : 0;
        const localTotal = Object.keys(localIndex.files).length;
        const threshold = this.s().bulkDeleteConfirm ?? 50;
        let reason = '';
        if (remoteTotal === 0) {
          reason =
            '云端索引为空，却要删除云端文件。这通常说明远程根目录被移动/重命名，或凭据指向了另一个账号。';
        } else if (threshold > 0 && pendingDeletes.length >= threshold) {
          reason = `本次同步将删除 ${pendingDeletes.length} 个云端文件（≥ 批量删除确认阈值 ${threshold}）。`;
        } else if (pendingDeletes.length >= 5 && pendingDeletes.length >= remoteTotal * 0.5) {
          reason = `将删除云端 ${pendingDeletes.length} 个文件，占云端文件总数（${remoteTotal}）的一半以上。`;
        }
        if (reason) {
          const choice = await this.askMassDelete({
            deleteRemote: pendingDeletes.length,
            deleteLocal: 0,
            localTotal,
            remoteTotal,
            samples: pendingDeletes.slice(0, 8),
            reason,
          });
          if (choice === 'cancel') {
            this.notify('BDNSync：已取消本次增量同步，未删除任何云端文件');
            this.statusBar.setIdle();
            return NOTHING;
          }
          if (choice === 'skip-deletes') {
            this.notify(`BDNSync：已跳过 ${pendingDeletes.length} 个删除操作，仅同步新增与修改`);
            pendingDeletes.length = 0;
          }
        }
      }

      if (pendingDeletes.length > 0) {
        await this.adapter.deleteRemote(pendingDeletes);
      }

      // 提交索引（带合并与竞态检测）
      const stats: SyncStats = {
        uploaded,
        downloaded: 0,
        deletedLocal: 0,
        deletedRemote: deleted,
        conflicts: 0,
        skipped: 0,
        errors: 0,
        bytesUp: 0,
        bytesDown: 0,
        errorMessages: [],
      };
      await this.commitRemoteIndex(remoteIndex, remoteChanges, new Set(), uploadedThisRun, {
        finalStates,
        localIndex,
        stats,
        syncStartAt: Date.now(),
        remoteTree: new Map(),
      });

      for (const [p, st] of finalStates) localIndex.files[p] = st;
      localIndex.lastSyncAt = Date.now();
      localIndex.stats.totalUploads += uploaded;
      localIndex.stats.totalDeletes += deleted;
      localIndex.stats.syncCount += 1;
      localIndex.stats.lastSyncSummary = summarize(stats);
      await this.store.saveLocalIndex(localIndex);
      await this.store.saveTransferState(this.adapter.exportSessions());
      this.statusBar.setDone(
        `↑${uploaded}${renamed ? ` ⇄${renamed}` : ''}${deleted ? ` 🗑${deleted}` : ''}`,
      );

      return {
        ok: true,
        uploaded,
        downloaded: 0,
        deletedLocal: 0,
        deletedRemote: deleted,
        conflicts: 0,
        skipped: 0,
        errors: 0,
        bytesUp: 0,
        bytesDown: 0,
        errorMessages: [],
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn('[BDNSync] 增量同步失败，等待重试/下次完整同步', e);
      this.statusBar.setError('增量同步失败');
      return {
        ok: false,
        uploaded: 0,
        downloaded: 0,
        deletedLocal: 0,
        deletedRemote: 0,
        conflicts: 0,
        skipped: 0,
        errors: 1,
        bytesUp: 0,
        bytesDown: 0,
        errorMessages: [msg],
      };
    } finally {
      this.syncing = false;
    }
  }

  // ---------------- 冲突面板：逐文件处理 ----------------

  async resolvePending(
    path: string,
    strategy: 'smart-merge' | 'force-local' | 'force-remote' | 'always-fork',
  ): Promise<boolean> {
    const localIndex = await this.store.loadLocalIndex();
    const record = localIndex.conflicts.find((c) => c.path === path && !c.resolved);
    if (!record) return false;
    const remoteIndex = (await this.adapter.readRemoteIndex()) || null;
    const S = localIndex.files[path];

    const localBytes = await this.readLocalFile(path);
    let remoteBytes: Uint8Array | null = null;
    const rEntry = remoteIndex?.files[path];
    if (rEntry && !rEntry.deleted) {
      remoteBytes = await this.adapter
        .downloadByPath(path, rEntry.hash || undefined)
        .catch(() => null);
    }
    const baseBytes = S && !S.deleted ? await this.store.getBase(S.hash) : null;

    const outcome = this.resolver.resolve(
      {
        path,
        kind: record.kind,
        localBytes,
        remoteBytes,
        baseBytes,
        deviceName: this.s().deviceName || '本机',
        remoteDevice: rEntry?.byDevice,
      },
      strategy,
    );
    if (outcome.action === 'deferred') return false;

    const finalStates = new Map<string, FileState>();
    const remoteChanges = new Map<string, FileState>();

    if (outcome.localBytes) {
      await this.writeLocalFile(path, outcome.localBytes, this.s().autoBackup);
      const hash = md5Hex(outcome.localBytes);
      const st = await this.stateAfterLocalWrite(path, outcome.localBytes, hash);
      finalStates.set(path, st);
      if (outcome.uploadOriginal) {
        const res = await this.adapter.upload(path, outcome.localBytes);
        remoteChanges.set(path, { ...st, remoteSize: res.remoteSize, fsId: res.fsId });
        await this.store.putBase(hash, outcome.localBytes);
      } else if (!rEntry || rEntry.deleted || rEntry.hash !== hash) {
        // 采用云端版本：云端内容未变，沿用其 fs_id / 落盘大小，避免索引被判过期
        remoteChanges.set(path, {
          ...st,
          mtime: rEntry?.mtime ?? st.mtime,
          remoteSize: rEntry?.remoteSize,
          fsId: rEntry?.fsId,
        });
      }
    } else if (outcome.action === 'upload-local' && localBytes) {
      const res = await this.adapter.upload(path, localBytes);
      const st: FileState = {
        path,
        mtime:
          (
            await this.vadapter()
              .stat(path)
              .catch(() => null)
          )?.mtime ?? Date.now(),
        size: localBytes.length,
        hash: md5Hex(localBytes),
        byDevice: this.s().deviceId,
      };
      finalStates.set(path, st);
      remoteChanges.set(path, { ...st, remoteSize: res.remoteSize, fsId: res.fsId });
      await this.store.putBase(st.hash, localBytes);
    } else if (outcome.action === 'delete-remote') {
      await this.adapter.deleteRemote([path]);
      remoteChanges.set(path, makeTombstone(path, this.s().deviceId));
    } else if (outcome.action === 'delete-local') {
      await this.vadapter()
        .remove(path)
        .catch(() => {
          /* ignore */
        });
      const tomb = makeTombstone(path, this.s().deviceId);
      remoteChanges.set(path, tomb);
      // 同步更新本地索引锚点，否则下次同步会误判「本地存在、云端删除」而重复上传
      finalStates.set(path, tomb);
    }

    for (const copy of outcome.conflictCopies) {
      await this.writeLocalFile(copy.path, copy.bytes, this.s().autoBackup);
      const res = await this.adapter.upload(copy.path, copy.bytes);
      const st = await this.stateAfterLocalWrite(copy.path, copy.bytes, md5Hex(copy.bytes));
      finalStates.set(copy.path, st);
      remoteChanges.set(copy.path, { ...st, remoteSize: res.remoteSize, fsId: res.fsId });
      await this.store.putBase(st.hash, copy.bytes);
    }

    if (remoteIndex && remoteChanges.size > 0) {
      const stats: SyncStats = {
        uploaded: 0,
        downloaded: 0,
        deletedLocal: 0,
        deletedRemote: 0,
        conflicts: 0,
        skipped: 0,
        errors: 0,
        bytesUp: 0,
        bytesDown: 0,
        errorMessages: [],
      };
      await this.commitRemoteIndex(remoteIndex, remoteChanges, new Set(), new Map(), {
        finalStates,
        localIndex,
        stats,
        syncStartAt: Date.now(),
        remoteTree: new Map(),
      });
    }

    for (const [p, st] of finalStates) localIndex.files[p] = st;
    record.resolved = true;
    localIndex.conflicts = localIndex.conflicts.filter((c) => !c.resolved);
    localIndex.lastSyncAt = Date.now();
    await this.store.saveLocalIndex(localIndex);
    this.onConflictsChanged(localIndex.conflicts.length);
    return true;
  }

  /** 清空本地索引（下次同步全量对账） */
  async resetLocalIndex(): Promise<void> {
    const idx = this.store.emptyLocalIndex();
    await this.store.saveLocalIndex(idx);
    this.hashCache.clear();
  }

  /**
   * 整库回滚到指定快照点：将 vault 对齐到快照记录的文件集合。
   * - 快照中有、当前没有 → 从云端下载（或 base 缓存恢复）
   * - 快照中有、当前有但 hash 不同 → 覆盖
   * - 当前有、快照中没有 → 删除本地
   * 回滚本身是一次本地修复，之后同步会把结果传播到云端。
   */
  async restoreSnapshot(
    snap: VaultSnapshot,
    log?: (type: 'info' | 'warn' | 'error', msg: string) => void,
  ): Promise<void> {
    if (this.syncing) {
      this.notify('BDNSync：已有同步在进行，请稍后再回滚');
      return;
    }
    this.syncing = true;
    const emit = (t: 'info' | 'warn' | 'error', m: string) => {
      log?.(t, m);
    };
    try {
      this.statusBar.setSyncing('正在整库回滚…');
      emit('info', `开始整库回滚到快照 ${snap.id}（${snap.totalFiles} 个文件）`);
      const localIndex = await this.store.loadLocalIndex();
      const remoteTree = await this.adapter.listTree();
      const filter = new PathFilter(this.s());
      let restored = 0,
        removed = 0;
      // 1) 恢复/覆盖快照中的文件
      for (const [path, info] of Object.entries(snap.files)) {
        if (filter.isExcluded(path)) continue;
        const exists = await this.vadapter().exists(path);
        const curHash = exists ? md5Hex((await this.readLocalFile(path)) ?? new Uint8Array()) : '';
        if (curHash === info.hash && exists) continue;
        try {
          const entry = remoteTree.get(path);
          if (entry) {
            const bytes = await this.adapter.download({ ...entry, path }, info.hash);
            await this.writeLocalFile(path, bytes, this.s().autoBackup);
          } else {
            const cached = await this.store.getBase(info.hash);
            if (!cached) {
              emit('warn', `快照文件 ${path} 云端/缓存均缺失，跳过`);
              continue;
            }
            await this.writeLocalFile(path, cached, this.s().autoBackup);
          }
          restored++;
        } catch (e) {
          emit('error', `回滚失败 ${path}: ${errText(e)}`);
        }
      }
      // 2) 删除快照外、当前多余的文件（删除前先备份，避免回滚误删无法恢复）
      const localScan = await this.scanLocal(filter, localIndex.files);
      // 回滚前强制生成一次整库快照点：即使 autoBackup 关闭，也能在回滚结果不理想时
      // 退回到回滚前状态（单文件 backup 在 autoBackup=false 时不生效，快照是更轻量的兜底）。
      const preFiles = Object.fromEntries(
        [...localScan.entries()]
          .filter(
            ([p]) =>
              !p.startsWith('.obsidian/') && !p.startsWith('.trash/') && !p.startsWith('.bdnsync/'),
          )
          .map(([p, st]) => [
            p,
            { hash: st.hash || '', mtime: st.mtime ?? Date.now(), size: st.size ?? 0 },
          ]),
      );
      let preBytes = 0;
      for (const st of Object.values(preFiles)) preBytes += st.size || 0;
      const preRollback: VaultSnapshot = {
        id: `snap-prerollback-${Date.now()}-${randomId(4)}`,
        createdAt: Date.now(),
        deviceId: this.s().deviceId,
        deviceName: this.s().deviceName || '本机',
        reason: '整库回滚前自动备份（防回滚误删不可恢复）',
        files: preFiles,
        totalFiles: Object.keys(preFiles).length,
        totalBytes: preBytes,
      };
      this.store.pushSnapshot(localIndex, preRollback, this.s().maxSnapshots);
      for (const path of localScan.keys()) {
        if (!snap.files[path] && !path.startsWith('.obsidian/')) {
          if (this.s().autoBackup) {
            const bytes = await this.readLocalFile(path);
            if (bytes) await this.store.backupFile(path, bytes);
          }
          await this.vadapter()
            .remove(path)
            .catch(() => {
              /* ignore */
            });
          removed++;
        }
      }
      emit('info', `整库回滚完成：恢复/覆盖 ${restored} 个，删除 ${removed} 个`);
      this.notify(`BDNSync：整库回滚完成（恢复 ${restored} / 删除 ${removed}）`);
      this.statusBar.setDone('回滚完成');
    } catch (e) {
      this.statusBar.setError(errText(e));
    } finally {
      this.syncing = false;
    }
  }
}

function errText(e: unknown): string {
  if (e instanceof BaiduApiError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

function cooldownHint(e: unknown): string {
  if (e instanceof BaiduApiError && e.cooldownMs > 0) return `${e.message}，将自动暂停后重试`;
  return errText(e);
}

export function summarize(s: SyncStats): string {
  const parts: string[] = [];
  if (s.uploaded) parts.push(`↑${s.uploaded}`);
  if (s.downloaded) parts.push(`↓${s.downloaded}`);
  if (s.deletedLocal) parts.push(`删本地${s.deletedLocal}`);
  if (s.deletedRemote) parts.push(`删云端${s.deletedRemote}`);
  if (s.conflicts) parts.push(`冲突${s.conflicts}`);
  if (s.errors) parts.push(`错误${s.errors}`);
  if (parts.length === 0) return '无变更';
  return parts.join(' ');
}

/**
 * 单文件同步决策矩阵（纯函数，便于单元测试）。
 * 从 `buildPlan` 抽取，不依赖引擎实例 / 设置 / IO。
 *
 * @param path   待决策的文件相对路径
 * @param L      本地扫描态（null 表示本地无此文件）
 * @param R      远端真实态（以目录树为准，hash 可信时才有值；null 表示远端无）
 * @param S      上次同步锚点（lastSync 索引条目；null 表示从未同步过）
 * @param direction 同步方向
 * @param deleteStrategy 删除策略（控制「一端删、另一端改」时的取舍）
 * @param remoteSize 远端文件字节数（download 动作携带）
 */
export function planEntry(
  path: string,
  ctx: {
    L: FileState | null;
    R: FileState | null;
    S: FileState | null;
    direction: SyncDirection;
    deleteStrategy: DeleteStrategy;
    remoteSize: number;
  },
): Action[] {
  const { L, R, S, direction, deleteStrategy, remoteSize } = ctx;
  const actions: Action[] = [];

  // ---- 单向覆盖：跳过三方裁决，直接按「哪一侧是真相」派活 ----
  if (direction === 'force-upload') {
    if (L && R && R.hash && L.hash === R.hash) actions.push({ type: 'skip', path, local: L });
    else if (L) actions.push({ type: 'upload', path, local: L });
    else if (R) {
      // 云端有、本地没有 → 本地是真相，删掉云端多余文件
      actions.push({
        type: 'delete-remote',
        path,
        last: S ?? { path, mtime: R.mtime, size: R.size, hash: R.hash },
      });
    }
    return actions;
  }
  if (direction === 'force-download') {
    if (L && R && R.hash && L.hash === R.hash) actions.push({ type: 'skip', path, local: L });
    else if (R) actions.push({ type: 'download', path, remoteState: R, remoteSize });
    else if (L) {
      // 本地有、云端没有 → 云端是真相，删掉本地多余文件
      actions.push({ type: 'delete-local', path, last: S ?? L });
    }
    return actions;
  }

  if (L && !R && !S) actions.push({ type: 'upload', path, local: L });
  else if (!L && R && !S) actions.push({ type: 'download', path, remoteState: R, remoteSize });
  else if (L && !R && S) {
    if (L.hash === S.hash) actions.push({ type: 'delete-local', path, last: S });
    else if (deleteStrategy === 'delete-everywhere')
      actions.push({ type: 'delete-local', path, last: S });
    else actions.push({ type: 'upload', path, local: L }); // 保留修改：重新上传
  } else if (!L && R && S) {
    if (R.hash && R.hash === S.hash) actions.push({ type: 'delete-remote', path, last: S });
    else if (deleteStrategy === 'delete-everywhere')
      actions.push({ type: 'delete-remote', path, last: S });
    else actions.push({ type: 'download', path, remoteState: R, remoteSize }); // 保留修改：恢复云端
  } else if (L && R && !S) {
    if (R.hash && L.hash === R.hash) actions.push({ type: 'skip', path, local: L });
    else
      actions.push({
        type: 'conflict',
        path,
        kind: 'create-create',
        local: L,
        remoteState: R,
        last: null,
      });
  } else if (L && R && S) {
    if (L.hash === R.hash) actions.push({ type: 'skip', path, local: L });
    else {
      const localChanged = L.hash !== S.hash;
      const remoteChanged = !R.hash || R.hash !== S.hash;
      if (localChanged && !remoteChanged) actions.push({ type: 'upload', path, local: L });
      else if (!localChanged && remoteChanged)
        actions.push({ type: 'download', path, remoteState: R, remoteSize });
      else
        actions.push({
          type: 'conflict',
          path,
          kind: 'edit-edit',
          local: L,
          remoteState: R,
          last: S,
        });
    }
  }
  // !L && !R && S：两端都已删除 → lastSync 清除即可（无动作）
  return actions;
}
