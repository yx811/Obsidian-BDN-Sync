// Logger：订阅式日志器（参考 LyncVault 的 LogLevel 设计，并扩展）：
//  - level 阈值：低于设定级别的条目直接丢弃
//  - maxEntries：环形缓冲，超出按时间最旧淘汰（内存索引上限）
//  - listeners：实时订阅推送（UI 可监听刷新）
//  - 持久化：通过 LogStore 按「日期分文件 + 大小轮转」落盘，retentionDays 自动清理
//  - 墓碑机制（tombstone）：删除分两阶段——先标记 deleted+deletedAt，过宽限期后才物理清除
//  - 整合筛选：时间范围 / 级别 / 模块 / 业务类型 / 关键字（支持正则）/ 含墓碑 / 排序
//  - 导出：筛选结果 → 纯文本 或 JSON；支持单条导出与复制

import type { LogFilter, LogLevel, LogModule, SyncLogEntry } from '../types';
import { LogStore } from './log-store';

/** 级别严重程度权重（越大越重要） */
const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export const LEVEL_LABEL: Record<LogLevel, string> = {
  debug: '调试',
  info: '信息',
  warn: '警告',
  error: '错误',
};

export const MODULE_LABEL: Record<LogModule, string> = {
  general: '通用',
  engine: '同步引擎',
  auth: '认证',
  watcher: '文件监听',
  browser: '浏览器',
  ui: '界面',
  netdisk: '网盘',
  crypto: '加密',
  lab: '实验',
  cleanup: '清理',
};

let idSeq = 0;
function genId(): string {
  idSeq += 1;
  return `log_${Date.now().toString(36)}_${idSeq.toString(36)}`;
}

export interface LoggerOptions {
  level: LogLevel;
  maxEntries: number;
  retentionDays: number;
  tombstoneGraceHours: number;
  /** 单日文件大小阈值（字节）；超过则追加分片。默认 4MB */
  maxFileSizeBytes?: number;
  store?: LogStore;
}

export class Logger {
  private index = new Map<string, SyncLogEntry>(); // id → entry，插入顺序即时间顺序
  private listeners: Array<(e: SyncLogEntry) => void> = [];
  private opts: LoggerOptions;
  private store?: LogStore;
  private loaded = false;

  constructor(opts: LoggerOptions) {
    this.opts = { ...opts };
    this.store = opts.store;
  }

  /** 同步更新运行时配置（来自设置变更） */
  updateOptions(patch: Partial<LoggerOptions>): void {
    this.opts = { ...this.opts, ...patch };
    this.store?.updateOptions({
      retentionDays: this.opts.retentionDays,
      maxFileSizeBytes: this.opts.maxFileSizeBytes,
    });
    this.enforceCapacity();
  }

  /** 从持久化层加载（只加载一次） */
  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (this.store) {
      try {
        const loaded = await this.store.loadRecent();
        for (const e of loaded) {
          if (isValidEntry(e)) this.index.set(e.id, e);
        }
      } catch {
        /* 忽略加载失败，使用空日志 */
      }
    }
    this.loaded = true;
    this.enforceCapacity();
  }

  private levelOk(level: LogLevel): boolean {
    return LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[this.opts.level];
  }

  /**
   * 记录一条日志。module 标识来源模块，level 标识严重程度。
   * message 可为 Error，自动提取可读信息并保留 stack（存于 message 末尾）。
   */
  log(
    module: LogModule,
    type: SyncLogEntry['type'],
    level: LogLevel,
    message: string | Error,
    path?: string,
  ): void {
    if (!this.levelOk(level)) return;

    let msg: string;
    if (message instanceof Error) {
      msg = message.stack ? `${message.message}\n${message.stack}` : message.message;
    } else {
      msg = message;
    }

    const entry: SyncLogEntry = {
      id: genId(),
      time: Date.now(),
      module,
      type,
      level,
      message: msg,
      path,
    };
    this.index.set(entry.id, entry);
    this.enforceCapacity();

    this.store?.append(entry);

    for (const fn of this.listeners) {
      try {
        fn(entry);
      } catch {
        /* 忽略 listener 异常 */
      }
    }
    // 镜像到浏览器控制台，便于开发者直接排查
    const tag = `[BDNSync][${MODULE_LABEL[entry.module]}][${entry.type}]`;
    if (level === 'error') console.error(tag, msg, path ?? '');
    else if (level === 'warn') console.warn(tag, msg, path ?? '');
    else console.log(tag, msg, path ?? '');
  }

  debug(module: LogModule, type: SyncLogEntry['type'], message: string, path?: string): void {
    this.log(module, type, 'debug', message, path);
  }
  info(module: LogModule, type: SyncLogEntry['type'], message: string, path?: string): void {
    this.log(module, type, 'info', message, path);
  }
  warn(module: LogModule, type: SyncLogEntry['type'], message: string, path?: string): void {
    this.log(module, type, 'warn', message, path);
  }
  error(module: LogModule, type: SyncLogEntry['type'], message: string, path?: string): void {
    this.log(module, type, 'error', message, path);
  }

  onEntry(fn: (e: SyncLogEntry) => void): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((f) => f !== fn);
    };
  }

  private enforceCapacity(): void {
    const max = Math.max(1, this.opts.maxEntries);
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

  /** 墓碑清理（委托 LogStore 清理磁盘）：删除过期日期 + 物理清除过期墓碑。
   *  清理后强制重新加载近期日志以保持内存与磁盘一致。 */
  async purge(): Promise<{ removedDays: number; removedEntries: number }> {
    if (this.store) {
      const graceMs = this.opts.tombstoneGraceHours * 3600_000;
      const res = await this.store.purge(Date.now(), graceMs);
      // 强制重新加载：清除内存缓存后重新从磁盘聚合
      this.index.clear();
      this.loaded = false;
      await this.ensureLoaded();
      return res;
    }
    return { removedDays: 0, removedEntries: 0 };
  }

  /** 物理清空所有条目（不可恢复）：内存清空 + 今天缓冲清空（磁盘历史由 retention 自然淘汰） */
  clearAll(): void {
    this.index.clear();
    this.store?.resetTodayBuffer();
  }

  /** 整合筛选：时间范围 / 级别 / 模块 / 业务类型 / 关键字（正则）/ 含墓碑 / 排序 */
  query(filter: LogFilter = {}): SyncLogEntry[] {
    const kw = filter.keyword?.trim();
    const from = filter.from ?? -Infinity;
    const to = filter.to ?? Infinity;
    const minW = filter.minLevel ? LEVEL_WEIGHT[filter.minLevel] : 0;
    const types = filter.types && filter.types.length ? new Set(filter.types) : null;
    const modules = filter.modules && filter.modules.length ? new Set(filter.modules) : null;

    let matcher: (text: string) => boolean;
    if (kw) {
      if (filter.regex) {
        try {
          const re = new RegExp(kw, 'i');
          matcher = (text) => re.test(text);
        } catch {
          // 正则非法时退化为子串匹配
          const lc = kw.toLowerCase();
          matcher = (text) => text.toLowerCase().includes(lc);
        }
      } else {
        const lc = kw.toLowerCase();
        matcher = (text) => text.toLowerCase().includes(lc);
      }
    } else {
      matcher = () => true;
    }

    const out: SyncLogEntry[] = [];
    for (const e of this.index.values()) {
      if (e.deleted && !filter.includeTombstoned) continue;
      if (e.time < from || e.time > to) continue;
      if (types && !types.has(e.type)) continue;
      if (modules && !modules.has(e.module)) continue;
      if (LEVEL_WEIGHT[e.level] < minW) continue;
      if (kw) {
        const hay = `${e.message} ${e.path ?? ''} ${e.module} ${e.type}`.toLowerCase();
        if (!matcher(hay)) continue;
      }
      out.push(e);
    }
    const dir = filter.sort === 'asc' ? 1 : -1;
    return out.sort((a, b) => (a.time - b.time) * dir);
  }

  /** 墓碑统计（用于界面展示） */
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

  /** 各级别计数（用于统计条展示） */
  levelCounts(filter?: LogFilter): Record<LogLevel, number> {
    const counts: Record<LogLevel, number> = { debug: 0, info: 0, warn: 0, error: 0 };
    for (const e of this.query(filter ?? {})) counts[e.level] += 1;
    return counts;
  }

  /** 导出为纯文本（排查友好，含级别 + 模块 + 时间戳） */
  exportText(filter?: LogFilter): string {
    const lines = this.query(filter ?? {}).map((e) => {
      const t = new Date(e.time).toLocaleString();
      const lvl = LEVEL_LABEL[e.level];
      const mod = MODULE_LABEL[e.module];
      const p = e.path ? ` (${e.path})` : '';
      return `[${t}] [${lvl}] [${mod}] ${e.type}: ${e.message}${p}`;
    });
    return lines.join('\n') || '（无匹配日志）';
  }

  /** 导出单条为纯文本 */
  exportTextOne(e: SyncLogEntry): string {
    const t = new Date(e.time).toLocaleString();
    const p = e.path ? ` (${e.path})` : '';
    return `[${t}] [${LEVEL_LABEL[e.level]}] [${MODULE_LABEL[e.module]}] ${e.type}: ${e.message}${p}`;
  }

  /** 导出为 JSON（结构化，便于程序分析） */
  exportJSON(filter?: LogFilter): string {
    return JSON.stringify(this.query(filter ?? {}), null, 2);
  }

  /** 导出单条为 JSON */
  exportJSONOne(e: SyncLogEntry): string {
    return JSON.stringify(e, null, 2);
  }

  /** 当前全部条目（供持久化 / 快照） */
  snapshot(): SyncLogEntry[] {
    return Array.from(this.index.values());
  }
}

function isValidEntry(e: unknown): e is SyncLogEntry {
  if (!e || typeof e !== 'object') return false;
  const o = e as Record<string, unknown>;
  return (
    typeof o.time === 'number' &&
    typeof o.type === 'string' &&
    typeof o.message === 'string' &&
    typeof o.level === 'string' &&
    typeof o.module === 'string'
  );
}
