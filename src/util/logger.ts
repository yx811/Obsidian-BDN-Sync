import { LogFilter, LogLevel, SyncLogEntry } from '../types';

/** 级别严重程度权重（越大越重要） */
const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const LEVEL_LABEL: Record<LogLevel, string> = {
  debug: '调试',
  info: '信息',
  warn: '警告',
  error: '错误',
};

let idSeq = 0;
function genId(): string {
  idSeq += 1;
  return `log_${Date.now().toString(36)}_${idSeq.toString(36)}`;
}

/** 业务类型 → 默认严重程度映射。
 *  现有 main.ts 调用 log(type, ...) 时 type 既描述业务也隐含级别，
 *  这里把 'error' 业务类型归为 error 级，其余归为 info 级。 */
function inferLevel(type: SyncLogEntry['type']): LogLevel {
  return type === 'error' ? 'error' : type === 'conflict' ? 'warn' : 'info';
}

export interface LoggerPersist {
  load: () => Promise<SyncLogEntry[]>;
  persist: (entries: SyncLogEntry[]) => Promise<void>;
}

export interface LoggerOptions {
  level: LogLevel;
  maxEntries: number;
  retentionDays: number;
  tombstoneGraceHours: number;
  persist?: LoggerPersist;
}

/**
 * 订阅式日志器（参考 LyncVault 的 LogLevel 设计，并扩展）：
 *  - level 阈值：低于设定级别的条目直接丢弃
 *  - maxEntries：环形缓冲，超出按时间最旧淘汰
 *  - listeners：实时订阅推送（UI 可监听刷新）
 *  - 持久化：可选落盘，便于重启后排查 bug
 *  - 墓碑机制（tombstone）：删除分两阶段——先标记 deleted+deletedAt，
 *    过宽限期后才物理清除；宽限期内可恢复
 *  - 整合筛选：时间范围 / 级别 / 业务类型 / 关键字 / 含墓碑
 *  - 导出：筛选结果 → 纯文本 或 JSON
 */
export class Logger {
  /** 用 Map 索引（id → entry）作主存储，插入顺序即时间顺序，所有按 id 的查找为 O(1) */
  private index = new Map<string, SyncLogEntry>();
  private listeners: Array<(e: SyncLogEntry) => void> = [];
  private opts: LoggerOptions;
  private loaded = false;

  constructor(opts: LoggerOptions) {
    this.opts = { ...opts };
  }

  /** 同步更新运行时配置（来自设置变更） */
  updateOptions(patch: Partial<LoggerOptions>): void {
    this.opts = { ...this.opts, ...patch };
    // 容量上限立即生效
    this.enforceCapacity();
  }

  /** 从持久化层加载（只加载一次） */
  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (this.opts.persist) {
      try {
        const loaded = await this.opts.persist.load();
        if (Array.isArray(loaded)) {
          for (const e of loaded) {
            if (isValidEntry(e)) this.index.set(e.id, e);
          }
        }
      } catch {
        /* 忽略加载失败，使用空日志 */
      }
    }
    this.loaded = true;
  }

  private levelOk(level: LogLevel): boolean {
    return LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[this.opts.level];
  }

  /** 记录一条日志（业务类型驱动）。message 可为 Error，自动提取可读信息 */
  log(type: SyncLogEntry['type'], message: string | Error, path?: string, level?: LogLevel): void {
    const msg = message instanceof Error ? `${message.message}` : message;
    const lvl = level ?? inferLevel(type);
    if (!this.levelOk(lvl)) return;

    const entry: SyncLogEntry = {
      id: genId(),
      time: Date.now(),
      type,
      level: lvl,
      message: msg,
      path,
    };
    this.index.set(entry.id, entry);
    // 物理越界立即淘汰最旧（墓碑清理是独立调度，不阻塞写入）
    this.enforceCapacity();

    for (const fn of this.listeners) {
      try {
        fn(entry);
      } catch {
        /* 忽略 listener 异常 */
      }
    }
    // 镜像到浏览器控制台，便于开发者直接排查
    const tag = `[BDNSync][${entry.type}]`;
    if (lvl === 'error') console.error(tag, msg, path ?? '');
    else if (lvl === 'warn') console.warn(tag, msg, path ?? '');
    else console.log(tag, msg, path ?? '');
  }

  debug(type: SyncLogEntry['type'], message: string, path?: string): void {
    this.log(type, message, path, 'debug');
  }
  info(type: SyncLogEntry['type'], message: string, path?: string): void {
    this.log(type, message, path, 'info');
  }
  warn(type: SyncLogEntry['type'], message: string, path?: string): void {
    this.log(type, message, path, 'warn');
  }
  error(type: SyncLogEntry['type'], message: string, path?: string): void {
    this.log(type, message, path, 'error');
  }

  onEntry(fn: (e: SyncLogEntry) => void): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((f) => f !== fn);
    };
  }

  private enforceCapacity(): void {
    const max = Math.max(1, this.opts.maxEntries);
    // Map 按插入顺序迭代：第一个 deleted 即最旧墓碑，第一个 entry 即最旧有效条目
    while (this.index.size > max) {
      let tombstonedKey: string | null = null;
      let firstKey: string | null = null;
      for (const [k, e] of this.index) {
        if (firstKey === null) firstKey = k;
        if (tombstonedKey === null && e.deleted) tombstonedKey = k;
      }
      const dropKey = tombstonedKey ?? firstKey;
      if (dropKey === null) break;
      this.index.delete(dropKey);
    }
  }

  /** 墓碑清理：标记过期的墓碑为物理删除，并按保留天数清理超期有效条目。
   *  返回本次物理清除的条目数（用于提示）。 */
  async purge(): Promise<number> {
    await this.ensureLoaded();
    const now = Date.now();
    const graceMs = this.opts.tombstoneGraceHours * 3600_000;
    const retentionMs =
      this.opts.retentionDays > 0 ? this.opts.retentionDays * 86400_000 : Infinity;
    let removed = 0;

    for (const [k, e] of this.index) {
      if (e.deleted) {
        // 墓碑宽限期内保留，过期物理清除
        const expired = e.deletedAt != null && now - e.deletedAt > graceMs;
        if (expired) {
          this.index.delete(k);
          removed++;
        }
      } else if (now - e.time > retentionMs) {
        // 有效条目：超过保留天数则标记墓碑（进入宽限期，下次 purge 物理清除）
        this.index.set(k, { ...e, deleted: true, deletedAt: now });
      }
    }
    this.enforceCapacity();
    if (this.opts.persist) await this.opts.persist.persist(this.snapshot());
    return removed;
  }

  /** 逻辑删除（墓碑标记）。ids 为空表示清空全部有效条目。
   *  返回被标记的条目数。宽限期内可 recover()。 */
  markDeleted(ids?: string[]): number {
    if (!ids) {
      // 清空全部有效条目：直接遍历标记，O(n) 但无需查找
      let n = 0;
      for (const [k, e] of this.index) {
        if (!e.deleted) {
          this.index.set(k, { ...e, deleted: true, deletedAt: Date.now() });
          n++;
        }
      }
      return n;
    }
    // 指定 ids：用 Set 做 O(1) 命中判定
    const idSet = new Set(ids);
    let n = 0;
    for (const [k, e] of this.index) {
      if (!e.deleted && idSet.has(e.id)) {
        this.index.set(k, { ...e, deleted: true, deletedAt: Date.now() });
        n++;
      }
    }
    return n;
  }

  /** 恢复墓碑条目（宽限期内） */
  recover(ids: string[]): number {
    const idSet = new Set(ids);
    let n = 0;
    for (const [k, e] of this.index) {
      if (e.deleted && idSet.has(e.id)) {
        this.index.set(k, { ...e, deleted: false, deletedAt: undefined });
        n++;
      }
    }
    return n;
  }

  /** 物理清空所有条目（不可恢复） */
  clearAll(): void {
    this.index.clear();
  }

  /** 整合筛选：时间范围 / 级别 / 业务类型 / 关键字 / 含墓碑 */
  query(filter: LogFilter = {}): SyncLogEntry[] {
    const kw = filter.keyword?.trim().toLowerCase();
    const from = filter.from ?? -Infinity;
    const to = filter.to ?? Infinity;
    const minW = filter.minLevel ? LEVEL_WEIGHT[filter.minLevel] : 0;
    const types = filter.types && filter.types.length ? new Set(filter.types) : null;

    const out: SyncLogEntry[] = [];
    for (const e of this.index.values()) {
      if (e.deleted && !filter.includeTombstoned) continue;
      if (e.time < from || e.time > to) continue;
      if (types && !types.has(e.type)) continue;
      if (LEVEL_WEIGHT[e.level] < minW) continue;
      if (kw) {
        const hay = `${e.message} ${e.path ?? ''}`.toLowerCase();
        if (!hay.includes(kw)) continue;
      }
      out.push(e);
    }
    return out.sort((a, b) => b.time - a.time); // 最新在前
  }

  /** 墓碑统计（用于设置页展示） */
  tombstoneStats(): { total: number; tombstoned: number; oldestActive?: number } {
    let tombstoned = 0;
    let oldest = Infinity;
    for (const e of this.index.values()) {
      if (e.deleted) tombstoned++;
      else if (e.time < oldest) oldest = e.time;
    }
    return {
      total: this.index.size,
      tombstoned,
      oldestActive: oldest === Infinity ? undefined : oldest,
    };
  }

  /** 导出为纯文本（排查友好，含级别与时间戳） */
  exportText(filter?: LogFilter): string {
    const lines = this.query(filter ?? {}).map((e) => {
      const t = new Date(e.time).toLocaleString();
      const lvl = LEVEL_LABEL[e.level];
      const p = e.path ? ` (${e.path})` : '';
      return `[${t}] [${lvl}] ${e.type}: ${e.message}${p}`;
    });
    return lines.join('\n') || '（无匹配日志）';
  }

  /** 导出为 JSON（结构化，便于程序分析） */
  exportJSON(filter?: LogFilter): string {
    return JSON.stringify(this.query(filter ?? {}), null, 2);
  }

  /** 当前全部条目（供持久化） */
  snapshot(): SyncLogEntry[] {
    return Array.from(this.index.values());
  }
}

function isValidEntry(e: unknown): e is SyncLogEntry {
  if (!e || typeof e !== 'object') return false;
  const o = e as Record<string, unknown>;
  return typeof o.time === 'number' && typeof o.type === 'string' && typeof o.message === 'string';
}
