// 本地存储：本地索引、传输状态、base 内容缓存（用于三方合并）、覆盖前备份

import type { DataAdapter } from 'obsidian';
import { md5Hex } from '../util/md5';
import { u8ToArrayBuffer } from '../util/misc';
import type {
  BackupEntry,
  CumulativeStats,
  FileVersion,
  LocalIndex,
  UploadSession,
  VaultSnapshot,
  ConflictReportEntry,
} from '../types';
import type { RetryItem } from '../sync/retry-queue';

const BASE_CACHE_MAX_BYTES = 512 * 1024 * 1024; // base 缓存目录上限
const BASE_FILE_MAX_BYTES = 1024 * 1024; // 单文件进 base 缓存上限 1MB
const BASE_CACHE_TTL_DAYS = 90; // base 缓存内容最长保留时间（未被引用也清理）
const BACKUP_KEEP = 100; // 覆盖前备份元数据保留数量
const BACKUP_MAX_AGE_DAYS = 30; // 覆盖前备份元数据保留天数
const SNAPSHOT_MAX_AGE_DAYS = 90; // 整库快照点最长保留时间

export interface LocalStoreEvents {
  onCorruptIndex?: () => void;
}

export class LocalStore {
  /** 最近一次加载的本地索引（用于状态栏摘要，不持久化） */
  lastLoadedIndex: LocalIndex | null = null;

  constructor(
    private adapter: DataAdapter,
    private baseDir: string, // 如 .obsidian/plugins/bdnsync
    private events: LocalStoreEvents = {},
  ) {}

  private p(file: string): string {
    return `${this.baseDir}/${file}`;
  }

  private async ensurePluginDir(): Promise<void> {
    await this.adapter.mkdir(this.baseDir).catch(() => {
      /* 已存在 */
    });
  }

  // ---------- JSON 读写 ----------

  async readJson<T = unknown>(file: string): Promise<T | null> {
    try {
      if (!(await this.adapter.exists(this.p(file)))) return null;
      const text = await this.adapter.read(this.p(file));
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  async writeJson(file: string, data: unknown): Promise<void> {
    await this.ensurePluginDir();
    await this.adapter.write(this.p(file), JSON.stringify(data, null, 2));
  }

  async removeFile(file: string): Promise<void> {
    try {
      if (await this.adapter.exists(this.p(file))) await this.adapter.remove(this.p(file));
    } catch {
      /* ignore */
    }
  }

  // ---------- 本地索引 ----------

  emptyLocalIndex(): LocalIndex {
    return {
      schema: 1,
      lastSyncAt: 0,
      lastRemoteSyncVersion: 0,
      files: {},
      conflicts: [],
      stats: {
        totalUploads: 0,
        totalDownloads: 0,
        totalDeletes: 0,
        totalConflicts: 0,
        bytesUp: 0,
        bytesDown: 0,
        syncCount: 0,
      },
      checksum: '',
    };
  }

  private computeChecksum(idx: LocalIndex): string {
    // 覆盖全部持久化字段：文件锚点、冲突、快照版本历史、整库快照、最后同步锚点。
    // 早期版本仅覆盖 files/conflicts/lastSyncAt/lastRemoteSyncVersion，导致 versions/snapshots
    // 半截损坏时不会被检出，可能加载到损坏的版本清单。现一并纳入。
    const payload = JSON.stringify({
      f: idx.files,
      c: idx.conflicts,
      vs: idx.versions,
      sn: idx.snapshots,
      l: idx.lastSyncAt,
      v: idx.lastRemoteSyncVersion,
    });
    return md5Hex(new TextEncoder().encode(payload));
  }

  async loadLocalIndex(): Promise<LocalIndex> {
    const data = await this.readJson<Partial<LocalIndex>>('local-index.json');
    if (!data || typeof data !== 'object' || !data.files) {
      this.lastLoadedIndex = this.emptyLocalIndex();
      return this.lastLoadedIndex;
    }
    const idx = data as LocalIndex;
    if (idx.checksum && idx.checksum !== this.computeChecksum(idx)) {
      // 索引损坏 → 重建（全量对比兜底），保留统计
      this.events.onCorruptIndex?.();
      const fresh = this.emptyLocalIndex();
      fresh.stats = idx.stats || fresh.stats;
      this.lastLoadedIndex = fresh;
      return fresh;
    }
    if (!idx.stats) idx.stats = this.emptyLocalIndex().stats;
    if (!Array.isArray(idx.conflicts)) idx.conflicts = [];
    this.lastLoadedIndex = idx;
    return idx;
  }

  async saveLocalIndex(idx: LocalIndex): Promise<void> {
    idx.checksum = this.computeChecksum(idx);
    await this.writeJson('local-index.json', idx);
  }

  // ---------- 传输状态（断点续传持久化） ----------

  async loadTransferState(): Promise<{ uploads: UploadSession[] }> {
    const data = await this.readJson<{ uploads?: UploadSession[] }>('transfer-state.json');
    return { uploads: Array.isArray(data?.uploads) ? data.uploads : [] };
  }

  async saveTransferState(uploads: UploadSession[]): Promise<void> {
    if (uploads.length === 0) await this.removeFile('transfer-state.json');
    else await this.writeJson('transfer-state.json', { uploads });
  }

  /** 失败重试队列持久化（独立于断点续传，避免相互干扰） */
  async loadRetryState(): Promise<{ items?: RetryItem[] }> {
    const data = await this.readJson<{ items?: RetryItem[] }>('retry-state.json');
    return { items: Array.isArray(data?.items) ? data.items : [] };
  }

  async saveRetryState(items: RetryItem[]): Promise<void> {
    if (items.length === 0) await this.removeFile('retry-state.json');
    else await this.writeJson('retry-state.json', { items });
  }

  // ---------- base 内容缓存（三方合并的 lastSync 快照） ----------

  private baseDirPath(): string {
    return `${this.baseDir}/base`;
  }

  async putBase(hash: string, content: Uint8Array): Promise<void> {
    if (content.length > BASE_FILE_MAX_BYTES) return;
    try {
      const dir = this.baseDirPath();
      await this.adapter.mkdir(dir).catch(() => {
        /* 已存在 */
      });
      const path = `${dir}/${hash}`;
      if (!(await this.adapter.exists(path))) {
        await this.adapter.writeBinary(path, u8ToArrayBuffer(content));
        // 增量更新 manifest（避免后续 enforceBaseCacheLimit 全量 stat）
        await this.touchBaseManifest(hash, content.length, Date.now());
      }
    } catch (e) {
      console.warn('[BDNSync] base 缓存写入失败', e);
    }
  }

  /**
   * base 缓存元数据清单（hash → {size, mtime}）。
   * 目的：enforceBaseCacheLimit / baseCacheSize 不再对每个 base 文件逐个 stat（O(n) IO），
   * 而是直接读这份清单，把同步开销从「与文件数成正比」降为一次 JSON 读取。
   * 它只是性能缓存：真实内容以磁盘为准（getBase/exists 直查磁盘），
   * 清单缺失/损坏时由 reconcileBaseManifest 在启动时一次性重建。
   */
  private baseManifestPath(): string {
    return `${this.baseDir}/base-manifest.json`;
  }

  private async loadBaseManifest(): Promise<Record<string, { size: number; mtime: number }>> {
    const data = await this.readJson('base-manifest.json');
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      return data as Record<string, { size: number; mtime: number }>;
    }
    return {};
  }

  private async saveBaseManifest(
    m: Record<string, { size: number; mtime: number }>,
  ): Promise<void> {
    await this.writeJson('base-manifest.json', m);
  }

  /** putBase 写入新文件后增量登记，避免整份清单回写 */
  private async touchBaseManifest(hash: string, size: number, mtime: number): Promise<void> {
    try {
      const m = await this.loadBaseManifest();
      m[hash] = { size, mtime };
      await this.saveBaseManifest(m);
    } catch {
      /* manifest 异常不影响写入本身 */
    }
  }

  /**
   * 校准 manifest 与磁盘的一致性：
   *  - 清单有、磁盘无 → 移除（文件被外部/异常删除）
   *  - 磁盘有、清单无 → 补 stat 登记（仅针对缺失项，非全量）
   * 返回校准后的清单（已持久化）。仅在启动时调用一次，不进入热路径。
   */
  private async reconcileBaseManifest(): Promise<Record<string, { size: number; mtime: number }>> {
    try {
      const dir = this.baseDirPath();
      if (!(await this.adapter.exists(dir))) return {};
      const list = await this.adapter.list(dir);
      const onDisk = new Set<string>();
      for (const f of list.files) {
        const name = f.split('/').pop() || '';
        onDisk.add(name);
      }
      const m = await this.loadBaseManifest();
      let changed = false;
      // 移除清单中已不存在的文件
      for (const key of Object.keys(m)) {
        if (!onDisk.has(key)) {
          delete m[key];
          changed = true;
        }
      }
      // 补登记磁盘有但清单缺的（仅对缺失项 stat）
      for (const name of onDisk) {
        if (!m[name]) {
          const path = `${dir}/${name}`;
          const st = await this.adapter.stat(path).catch(() => null);
          if (st) {
            m[name] = { size: st.size, mtime: st.mtime };
            changed = true;
          }
        }
      }
      if (changed) await this.saveBaseManifest(m);
      return m;
    } catch {
      return {};
    }
  }

  async getBase(hash: string): Promise<Uint8Array | null> {
    try {
      const path = `${this.baseDirPath()}/${hash}`;
      if (!(await this.adapter.exists(path))) return null;
      const buf = await this.adapter.readBinary(path);
      return new Uint8Array(buf);
    } catch {
      return null;
    }
  }

  /**
   * 收集所有仍被引用的 base 缓存 hash。
   * 必须覆盖：当前 lastSync 文件、文件级版本历史、整库快照点。
   * 之前只收集 files 的 hash，导致旧版本内容被 pruneBase 误删（恢复上一版本失效）。
   */
  collectBaseReferences(idx: LocalIndex): Set<string> {
    const refs = new Set<string>();
    for (const f of Object.values(idx.files)) {
      if (f.hash && !f.deleted) refs.add(f.hash);
    }
    if (idx.versions) {
      for (const list of Object.values(idx.versions)) {
        for (const v of list) if (v.hash) refs.add(v.hash);
      }
    }
    if (idx.snapshots) {
      for (const snap of idx.snapshots) {
        for (const info of Object.values(snap.files)) if (info.hash) refs.add(info.hash);
      }
    }
    return refs;
  }

  /** 清理不再被引用的 base 缓存 */
  async pruneBase(referenced: Set<string>): Promise<void> {
    try {
      const dir = this.baseDirPath();
      if (!(await this.adapter.exists(dir))) return;
      const list = await this.adapter.list(dir);
      // 注意：DataAdapter.list() 返回的是相对 vault 根的完整路径，直接用于 remove/stat，
      // 不要再拼 `${dir}/${f}`（会得到重复前缀而静默失败）。
      const manifest = await this.loadBaseManifest();
      let manifestChanged = false;
      for (const f of list.files) {
        const name = f.split('/').pop() || '';
        if (!referenced.has(name)) {
          await this.adapter.remove(f).catch(() => {
            /* ignore */
          });
          if (manifest[name]) {
            delete manifest[name];
            manifestChanged = true;
          }
        }
      }
      if (manifestChanged) await this.saveBaseManifest(manifest);
    } catch {
      /* ignore */
    }
  }

  async baseCacheSize(): Promise<number> {
    try {
      const dir = this.baseDirPath();
      if (!(await this.adapter.exists(dir))) return 0;
      const manifest = await this.loadBaseManifest();
      const names = Object.keys(manifest);
      // manifest 基本可信时直接累加，避免逐个 stat
      if (names.length > 0) {
        let total = 0;
        for (const v of Object.values(manifest)) total += v.size;
        return total;
      }
      // manifest 为空（缺失/损坏）→ 回退一次性 stat
      const list = await this.adapter.list(dir);
      let total = 0;
      for (const f of list.files) {
        const st = await this.adapter.stat(f).catch(() => null);
        if (st) total += st.size;
      }
      return total;
    } catch {
      return 0;
    }
  }

  /**
   * 强制把 base 缓存压到上限以内：按 mtime 从旧到新淘汰。
   * 之前 BASE_CACHE_MAX_BYTES 只被定义、从未执行，缓存目录会无界增长。
   *
   * 改进后同时考虑引用与 TTL：
   *   - 引用中的文件（files/versions/snapshots/backups）不因容量压力删除，保数据安全。
   *   - 未被引用且超过 BASE_CACHE_TTL_DAYS 的文件优先删除（生命周期到期）。
   *   - 容量仍超限时，只删除未被引用的文件（按最旧优先），绝不删除引用中的文件。
   *
   * 性能优化（A2）：优先用 base-manifest.json 的 size/mtime 元数据，避免对每个文件
   * 逐个 stat（O(n) IO）；仅当 manifest 缺失/为空时才回退一次性 stat。
   */
  async enforceBaseCacheLimit(referenced: Set<string>): Promise<void> {
    try {
      const dir = this.baseDirPath();
      if (!(await this.adapter.exists(dir))) return;
      const list = await this.adapter.list(dir);
      const now = Date.now();
      const ttlCutoff = now - BASE_CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;

      // 启动时校准一次 manifest（list+stat 仅此一次），之后本方法内直接用其元数据，
      // 避免对每个 base 文件逐个 stat（O(n) IO → O(1) 读取）。
      const manifest = await this.reconcileBaseManifest();
      const stats: {
        path: string;
        name: string;
        size: number;
        mtime: number;
        referenced: boolean;
      }[] = [];
      let total = 0;
      for (const f of list.files) {
        const name = f.split('/').pop() || '';
        const isRef = referenced.has(name);
        const mv = manifest[name];
        // manifest 条目缺失（reconcile 时 stat 失败的极少数情况）才补一次 stat
        if (!mv) {
          const st = await this.adapter.stat(f).catch(() => null);
          if (!st) continue;
          stats.push({ path: f, name, size: st.size, mtime: st.mtime, referenced: isRef });
          total += st.size;
          continue;
        }
        stats.push({ path: f, name, size: mv.size, mtime: mv.mtime, referenced: isRef });
        total += mv.size;
      }

      const manifestNext: Record<string, { size: number; mtime: number }> = {};
      let manifestChanged = false;
      const flushManifest = async () => {
        if (manifestChanged) await this.saveBaseManifest(manifestNext);
      };

      if (total <= BASE_CACHE_MAX_BYTES) {
        // 即使容量合规，也清理过期未引用文件（统一生命周期）
        for (const it of stats) {
          if (!it.referenced && it.mtime < ttlCutoff) {
            await this.adapter.remove(it.path).catch(() => {
              /* ignore */
            });
            manifestChanged = true;
          } else {
            manifestNext[it.name] = { size: it.size, mtime: it.mtime };
          }
        }
        await flushManifest();
        return;
      }
      // 容量超限：先删过期未引用，再删最旧未引用；引用中的文件不删
      stats.sort((a, b) => a.mtime - b.mtime); // 最旧的先删
      for (const it of stats) {
        if (total <= BASE_CACHE_MAX_BYTES) {
          manifestNext[it.name] = { size: it.size, mtime: it.mtime };
          continue;
        }
        if (it.referenced) {
          manifestNext[it.name] = { size: it.size, mtime: it.mtime };
          continue;
        }
        await this.adapter.remove(it.path).catch(() => {
          /* ignore */
        });
        total -= it.size;
        manifestChanged = true;
      }
      await flushManifest();
      if (total > BASE_CACHE_MAX_BYTES) {
        console.warn(
          '[BDNSync] base 缓存容量已超上限，但所有剩余文件均被引用，无法安全清理。建议增大「base 缓存上限」或减少版本/快照保留量。',
        );
      }
    } catch {
      /* ignore */
    }
  }

  // ---------- 覆盖前备份（去重：物理内容走 base 池） ----------

  private backupsJsonPath(): string {
    return `${this.baseDir}/backups.json`;
  }

  async listBackups(): Promise<BackupEntry[]> {
    const data = await this.readJson('backups.json');
    return Array.isArray(data) ? data : [];
  }

  /**
   * 覆盖前备份：内容写入 base 池（hash 去重），元数据写入 backups.json。
   * 这样同一内容不会在 base 与 backups 里双份冗余，生命周期也由 base 池统一管理。
   */
  async backupFile(relPath: string, content: Uint8Array): Promise<void> {
    try {
      const hash = md5Hex(content);
      await this.putBase(hash, content);
      const entry: BackupEntry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        time: Date.now(),
        relPath,
        hash,
        size: content.length,
      };
      const list = await this.listBackups();
      list.unshift(entry);
      // 数量 + 时间 TTL 双控
      const cutoff = Date.now() - BACKUP_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
      const filtered = list.filter((b) => b.time >= cutoff);
      while (filtered.length > BACKUP_KEEP) filtered.pop();
      await this.writeJson('backups.json', filtered);
    } catch (e) {
      console.warn('[BDNSync] 备份失败', e);
    }
  }

  /** 按备份元数据恢复内容（实际从 base 池读取） */
  async getBackupContent(hash: string): Promise<Uint8Array | null> {
    return this.getBase(hash);
  }

  /**
   * 批量提交覆盖前备份元数据：一次完整同步可能覆盖大量文件，若每个文件都
   * 全量读写 backups.json（读→改→写），会产生 O(N) 次整文件 IO。改为在内存中
   * 累积本次同步产生的所有备份条目，结束后一次性读→合并→写，把 IO 降到 O(1)。
   * 物理内容仍由 putBase（hash 去重、幂等）负责，这里只管元数据。
   */
  async commitBackups(entries: BackupEntry[]): Promise<void> {
    if (entries.length === 0) return;
    try {
      const list = await this.listBackups();
      for (const e of entries) list.unshift(e);
      const cutoff = Date.now() - BACKUP_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
      const filtered = list.filter((b) => b.time >= cutoff);
      while (filtered.length > BACKUP_KEEP) filtered.pop();
      await this.writeJson('backups.json', filtered);
    } catch (e) {
      console.warn('[BDNSync] 批量备份提交失败', e);
    }
  }

  /** 清理超期的覆盖前备份元数据（物理内容由 base 池引用/容量回收） */
  async pruneBackups(): Promise<void> {
    try {
      const list = await this.listBackups();
      const cutoff = Date.now() - BACKUP_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
      const filtered = list.filter((b) => b.time >= cutoff);
      if (filtered.length > BACKUP_KEEP) filtered.splice(BACKUP_KEEP);
      if (filtered.length !== list.length) await this.writeJson('backups.json', filtered);
    } catch {
      /* ignore */
    }
  }

  // ---------- 文件级版本历史 ----------

  /**
   * 记录一个文件版本。版本内容依赖 base 缓存（putBase 已在调用处写入），
   * 这里只维护「版本清单」：path → 按时间倒序的版本数组。
   * 超过 maxVersions 时淘汰最旧版本（其 base 内容由 pruneBase 引用计数回收）。
   */
  async recordVersion(
    idx: LocalIndex,
    relPath: string,
    version: FileVersion,
    maxVersions: number,
  ): Promise<void> {
    if (maxVersions <= 0) return;
    if (!idx.versions) idx.versions = {};
    const list = idx.versions[relPath] || [];
    // 若最新版本的 hash 相同，则视为同一版本，仅更新时间
    if (list.length > 0 && list[0].hash === version.hash) {
      list[0] = {
        ...list[0],
        mtime: version.mtime,
        byDevice: version.byDevice,
        deviceName: version.deviceName,
        note: version.note,
      };
    } else {
      list.unshift(version);
    }
    // 淘汰最旧（保留 maxVersions 个）
    while (list.length > maxVersions) list.pop();
    idx.versions[relPath] = list;
  }

  /** 列出某文件的版本清单（按时间倒序） */
  listVersions(idx: LocalIndex, relPath: string): FileVersion[] {
    return (idx.versions && idx.versions[relPath]) || [];
  }

  /** 取某版本的明文内容（基于 base 缓存） */
  async getVersionContent(hash: string): Promise<Uint8Array | null> {
    return this.getBase(hash);
  }

  // ---------- 整库快照点 ----------

  /** 写入一个整库快照点（按时间倒序，最多 maxSnapshots 个，且不超过 SNAPSHOT_MAX_AGE_DAYS 天） */
  pushSnapshot(idx: LocalIndex, snap: VaultSnapshot, maxSnapshots: number): void {
    if (!idx.snapshots) idx.snapshots = [];
    idx.snapshots.unshift(snap);
    const cutoff = Date.now() - SNAPSHOT_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    idx.snapshots = idx.snapshots.filter((s) => s.createdAt >= cutoff);
    while (idx.snapshots.length > maxSnapshots) idx.snapshots.pop();
  }

  /** P1-3.4 配置类文件快照：.obsidian 配置整目录状态（用于一键回滚最近稳定版本） */
  pushConfigSnapshot(idx: LocalIndex, snap: VaultSnapshot, maxSnapshots: number): void {
    if (maxSnapshots <= 0) return;
    if (!idx.configSnapshots) idx.configSnapshots = [];
    idx.configSnapshots.unshift(snap);
    while (idx.configSnapshots.length > maxSnapshots) idx.configSnapshots.pop();
  }

  getConfigSnapshots(idx: LocalIndex): VaultSnapshot[] {
    return idx.configSnapshots || [];
  }

  // ---------- 冲突处理报告 ----------

  /** 记录最近一次同步的冲突处理明细（审计） */
  setConflictReport(idx: LocalIndex, entries: ConflictReportEntry[]): void {
    idx.lastConflictReport = entries;
  }

  getConflictReport(idx: LocalIndex): ConflictReportEntry[] {
    return idx.lastConflictReport || [];
  }
}

export function emptyStats(): CumulativeStats {
  return {
    totalUploads: 0,
    totalDownloads: 0,
    totalDeletes: 0,
    totalConflicts: 0,
    bytesUp: 0,
    bytesDown: 0,
    syncCount: 0,
  };
}
