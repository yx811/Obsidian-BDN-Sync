// Logger：订阅式日志器（参考 LyncVault 的 LogLevel 设计，并扩展）：
//  - level 阈值：低于设定级别的条目直接丢弃
//  - maxEntries：环形缓冲，超出按时间最旧淘汰（内存索引上限）
//  - listeners：实时订阅推送（UI 可监听刷新）
//  - 持久化：通过 LogStore 按「日期分文件 + 大小轮转」落盘，retentionDays 自动清理
//  - 墓碑机制（tombstone）：删除分两阶段——先标记 deleted+deletedAt，过宽限期后才物理清除
//  - 整合筛选：时间范围 / 级别 / 模块 / 业务类型 / 关键字（支持正则）/ 含墓碑 / 排序
//  - 导出：筛选结果 → 纯文本 或 JSON；支持单条导出与复制

import type { BDNSyncSettings, LogFilter, LogLevel, LogModule, SyncLogEntry } from '../types';
import { LogStore } from './log-store';
import { redactSecrets } from '../baidu/api';
import { diagnoseError } from './error-dict';

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
    // 🔴#5 脱敏：凭证明文（access_token / BDUSS / STOKEN …）可能随错误对象或字符串进入日志，
    // 落盘 / 控制台镜像前必须脱敏，避免敏感信息写入磁盘日志文件或泄露到开发者工具。
    msg = redactSecrets(msg);

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
      const idx = this.listeners.indexOf(fn);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  private enforceCapacity(): void {
    const max = Math.max(1, this.opts.maxEntries);
    if (this.index.size <= max) return;
    const toDrop = this.index.size - max;
    let dropped = 0;
    // 第一轮：优先淘汰墓碑条目（O(n) 单次扫描，不再每条淘汰都全表遍历，🟢 性能）
    if (toDrop > 0) {
      for (const [k, e] of this.index) {
        if (dropped >= toDrop) break;
        if (e.deleted) {
          this.index.delete(k);
          dropped += 1;
        }
      }
    }
    // 第二轮：从最旧（Map 插入序 = 时间序）起淘汰剩余超出部分
    if (dropped < toDrop) {
      for (const k of this.index.keys()) {
        if (dropped >= toDrop) break;
        this.index.delete(k);
        dropped += 1;
      }
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

  /** 物理清空所有条目（不可恢复）：内存清空 + 今天缓冲清空（磁盘历史由 retention/自然淘汰） */
  clearAll(): void {
    this.index.clear();
    this.store?.resetTodayBuffer();
  }

  /** 单条软删除（两阶段删除的第一步，🟡#14 补齐墓碑机制入口）：
   *  置 deleted=true + deletedAt，并在所在日期分片落盘。之后由 purge 按宽限期物理清除。 */
  deleteEntry(id: string): void {
    const e = this.index.get(id);
    if (!e || e.deleted) return;
    const tomb: SyncLogEntry = { ...e, deleted: true, deletedAt: Date.now() };
    this.index.set(id, tomb);
    this.store?.tombstoneEntry(tomb);
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

  /** 导出为 CSV（#4.3 审计日志导出）：含表头，字段按 RFC 4180 转义 */
  exportCsv(filter?: LogFilter): string {
    const rows = this.query(filter ?? {});
    const header = [
      'time',
      'level',
      'module',
      'type',
      'path',
      'message',
      'bytesUp',
      'bytesDown',
      'durationMs',
    ];
    const lines = [header.join(',')];
    for (const e of rows) {
      lines.push(
        [
          new Date(e.time).toISOString(),
          e.level,
          e.module,
          e.type,
          e.path ?? '',
          e.message,
          e.bytesUp ?? '',
          e.bytesDown ?? '',
          e.durationMs ?? '',
        ]
          .map(csvCell)
          .join(','),
      );
    }
    return lines.join('\n') || 'time,level,module,type,path,message,bytesUp,bytesDown,durationMs';
  }

  /** 导出为 Markdown 表格（#4.3 审计日志导出），适合直接贴入笔记/Issue */
  exportMarkdown(filter?: LogFilter): string {
    const rows = this.query(filter ?? {});
    if (!rows.length) return '_（无匹配日志）_';
    const lines: string[] = [];
    lines.push('# BDNSync 同步审计日志');
    lines.push('');
    lines.push(`> 导出时间：${new Date().toLocaleString()} 共 ${rows.length} 条`);
    lines.push('');
    lines.push('| 时间 | 级别 | 模块 | 类型 | 路径 | 说明 |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const e of rows) {
      const t = new Date(e.time).toLocaleString();
      lines.push(
        `| ${t} | ${LEVEL_LABEL[e.level]} | ${MODULE_LABEL[e.module]} | ${e.type} | ${mdCell(e.path ?? '')} | ${mdCell(e.message)} |`,
      );
    }
    return lines.join('\n');
  }

  /**
   * 生成「一键复制诊断信息」（#3.7 错误诊断与用户引导）。
   * 收集：版本/平台/设置子集（敏感字段已脱敏）+ 最近错误分布 + 最近 N 条日志 + 可选样本错误诊断。
   * 返回纯文本，可直接写入剪贴板。
   */
  exportDiagnostic(ctx: DiagnosticContext): string {
    const lines: string[] = [];
    lines.push('=== BDNSync 诊断信息 ===');
    lines.push(`版本: ${ctx.version}`);
    lines.push(`平台: ${ctx.platform}`);
    lines.push(`时间: ${new Date().toLocaleString()}`);
    lines.push('');
    lines.push('--- 设置（已脱敏）---');
    const s = ctx.settings;
    lines.push(`authMode: ${s.authMode}`);
    lines.push(`remoteRoot: ${s.remoteRoot || '(未设置)'}`);
    lines.push(`syncMode: ${s.syncMode}`);
    lines.push(`conflictStrategy: ${s.conflictStrategy}`);
    lines.push(`encryptionEnabled: ${s.encryptionEnabled}`);
    lines.push(`uploadConcurrency: ${s.uploadConcurrency} (adaptive=${s.adaptiveConcurrency})`);
    lines.push(`deviceId: ${s.deviceId || '(未设置)'}`);
    lines.push(`apiProbeEnabled: ${s.apiProbeEnabled}`);
    lines.push('');
    lines.push('--- 最近错误分布 ---');
    const errs = this.query({ types: ['error'], minLevel: 'error' }).slice(0, 20);
    if (!errs.length) lines.push('（无 error 级日志）');
    else for (const e of errs) lines.push(`[${new Date(e.time).toLocaleString()}] ${e.message}${e.path ? ` (${e.path})` : ''}`);
    if (ctx.sampleError != null) {
      lines.push('');
      lines.push('--- 样本错误诊断 ---');
      const d = diagnoseError(ctx.sampleError as unknown);
      lines.push(`分类: ${d.code} (${d.category})`);
      lines.push(`说明: ${d.zh}`);
      lines.push(`建议: ${d.hint}`);
      lines.push(`可恢复: ${d.recoverable ? '是' : '否'}`);
    }
    lines.push('');
    lines.push('--- 最近 30 条日志 ---');
    const recent = this.query({ sort: 'desc' }).slice(0, 30).reverse();
    for (const e of recent) lines.push(`[${new Date(e.time).toLocaleString()}] [${e.level}] ${e.type}: ${e.message}${e.path ? ` (${e.path})` : ''}`);
    return lines.join('\n');
  }

  /** 当前全部条目（供持久化 / 快照） */
  snapshot(): SyncLogEntry[] {
    return Array.from(this.index.values());
  }
}

/** 一键复制诊断所需的上下文（由调用方（main/settings）注入脱敏后的设置与版本信息） */
export interface DiagnosticContext {
  version: string;
  platform: string;
  settings: BDNSyncSettings;
  sampleError?: unknown;
}

function csvCell(v: string | number): string {
  const s = String(v ?? '');
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function mdCell(v: string): string {
  return v.replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 300);
}

/** 解析日志 message 文本，拆分为「一句话结论 / 关键上下文 / 技术堆栈」三段。
 *  以 Error 记录时，Logger.log 会把 message 存为 `人类可读信息\nError: x\n    at ...`，
 *  这里把首行作为结论，中间非堆栈行作为上下文，以 `at ` 开头的行归为技术堆栈（供开发者折叠排查）。
 *  用于日志浏览器「展开详情」时提炼展示，避免直接堆砌冗长原始堆栈。 */
export interface ParsedLogMessage {
  summary: string;
  context: string[];
  stack: string[];
}

export function parseLogMessage(raw: string): ParsedLogMessage {
  const lines = raw.split(/\r?\n/);
  const summary = (lines[0] ?? '').trim();
  const context: string[] = [];
  const stack: string[] = [];
  const STACK_CAP = 30; // 技术堆栈最多保留 30 帧，避免超长 dump
  const CONTEXT_CAP = 60; // 🟢 上下文行数上限，避免极长 message 撑爆展开视图
  for (let i = 1; i < lines.length; i++) {
    const ln = lines[i].replace(/\s+$/, '');
    const trimmed = ln.trim();
    if (!trimmed) continue;
    if (/^\s*at\s/.test(ln)) {
      if (stack.length < STACK_CAP) stack.push(trimmed);
      continue;
    }
    // 跳过与结论重复的 "Error: xxx" 标题行（堆栈首行常与结论重复）
    const deErr = trimmed.replace(/^Error:\s*/i, '');
    if (deErr && deErr === summary) continue;
    if (context.length < CONTEXT_CAP) context.push(trimmed); // 超出部分直接丢弃
  }
  return { summary, context, stack };
}

function isValidEntry(e: unknown): e is SyncLogEntry {
  if (!e || typeof e !== 'object') return false;
  const o = e as Record<string, unknown>;
  if (typeof o.time !== 'number') return false;
  if (typeof o.type !== 'string') return false;
  if (typeof o.message !== 'string') return false;
  // 🟡#11：level / module 必须在枚举内，否则导出会写出 undefined 标签（MODULE_LABEL[level] 越界）。
  // 损坏或旧版日志里出现非法枚举时直接丢弃该条，避免污染内存索引与导出结果。
  if (typeof o.level !== 'string' || !(o.level in LEVEL_WEIGHT)) return false;
  if (typeof o.module !== 'string' || !(o.module in MODULE_LABEL)) return false;
  return true;
}
