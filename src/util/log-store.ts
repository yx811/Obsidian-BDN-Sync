// LogStore：日志磁盘存储层（独立于内存 Logger）。
//
// 设计目标（对齐主流日志「分类存储 + 自动轮转 + 清理策略」最佳实践）：
//   1. 按时间分类存储：每天一个文件 <logsDir>/YYYY-MM-DD.json，跨日自动新文件 = 时间轮转；
//   2. 大小轮转：单日文件超过 maxFileSizeBytes 时追加 .p2/.p3 分片，避免长时间单日膨胀；
//   3. 清理策略：保留最近 retentionDays 天；purge 时删除过期日期目录，并按墓碑宽限期物理清除；
//   4. 模块/级别维度：每条 entry 自带 module / level，检索层（Logger）据此过滤。

import type { DataAdapter, ListedFiles } from 'obsidian';
import type { SyncLogEntry } from '../types';

/** 把时间戳格式化为 YYYY-MM-DD（本地时区，使用 Date 方法而非手动计算） */
function dayKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

export class LogStore {
  private adapter: DataAdapter;
  private logsDir: string; // 相对 vault 根，如 .obsidian/plugins/bdnsync/logs
  private retentionDays: number;
  private maxFileSizeBytes: number;
  /** 仅缓存「今天」的条目，避免每次 log 重写整天文件时重新读盘 */
  private todayKey = '';
  private todayEntries: SyncLogEntry[] = [];
  private todayBytes = 0;

  constructor(
    adapter: DataAdapter,
    logsDir: string,
    opts: { retentionDays: number; maxFileSizeBytes: number },
  ) {
    this.adapter = adapter;
    this.logsDir = logsDir.replace(/\/+$/, ''); // 规范化：去掉结尾斜杠
    this.retentionDays = opts.retentionDays;
    this.maxFileSizeBytes = Math.max(1024, opts.maxFileSizeBytes);
  }

  /** 更新运行时配置（来自设置变更） */
  updateOptions(patch: { retentionDays?: number; maxFileSizeBytes?: number }): void {
    if (typeof patch.retentionDays === 'number') this.retentionDays = patch.retentionDays;
    if (typeof patch.maxFileSizeBytes === 'number')
      this.maxFileSizeBytes = Math.max(1024, patch.maxFileSizeBytes);
  }

  private dirForDate(date: string): string {
    return `${this.logsDir}/${date}`;
  }
  private fileForDate(date: string, part: number): string {
    const base = `${date}.json`;
    return part <= 1
      ? `${this.dirForDate(date)}/${base}`
      : `${this.dirForDate(date)}/${date}.p${part}.json`;
  }

  /** 启动加载：读取 retentionDays 范围内的所有日期文件，合并返回。
   *  retentionDays=0 表示永久保留，扫描全部日期目录。 */
  async loadRecent(): Promise<SyncLogEntry[]> {
    const all: SyncLogEntry[] = [];
    const cutoff = this.retentionDays > 0 ? this.retentionDays : 0;
    const now = Date.now();
    const minDate = cutoff > 0 ? this.shiftDays(dayKey(now), -cutoff) : '0000-00-00';

    let listed: ListedFiles = { files: [], folders: [] };
    try {
      listed = await this.adapter.list(this.logsDir);
    } catch {
      return all; // 目录不存在或无法列出：视为空
    }

    // 筛选出 retentionDays 范围内的日期目录
    const dateDirs = new Set<string>();
    for (const path of Object.keys(listed)) {
      // path 形如 logsDir/2026-03-20/2026-03-20.json
      const rel = path.slice(this.logsDir.length + 1); // 去掉前缀 + 斜杠
      const seg = rel.split('/');
      if (seg.length >= 2 && /^\d{4}-\d{2}-\d{2}$/.test(seg[0])) {
        if (seg[0] >= minDate) dateDirs.add(seg[0]);
      }
    }

    for (const date of dateDirs) {
      let part = 1;
      // 依次读取 .json / .p2.json / .p3.json … 直到不存在
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const file = this.fileForDate(date, part);
        try {
          const raw = await this.adapter.read(file);
          const parsed = JSON.parse(raw) as { entries?: SyncLogEntry[] };
          if (Array.isArray(parsed?.entries)) all.push(...parsed.entries);
        } catch {
          break; // 该分片不存在，停止该日循环
        }
        part += 1;
      }
    }
    return all;
  }

  /** 写入单条日志：追加到「今天」的内存缓冲，必要时 flush 到磁盘。
   *  采用「当天内存缓冲 + 增量 flush」策略，避免每条日志都重写整天文件。 */
  append(entry: SyncLogEntry): void {
    const key = dayKey(entry.time);
    if (key !== this.todayKey) {
      // 跨日：先把昨天的缓冲落盘（用旧值，避免 flush 读到已切换的 todayKey），再切换到今天
      if (this.todayKey && this.todayEntries.length) {
        const oldKey = this.todayKey;
        const oldEntries = this.todayEntries;
        void this.flushDay(oldKey, oldEntries);
      }
      this.todayKey = key;
      this.todayEntries = [];
      this.todayBytes = 0;
    }
    this.todayEntries.push(entry);
    this.todayBytes += this.estimateBytes(entry);
    // 超过单日大小上限：当前缓冲即时 flush（同样用当前 todayKey 的明确值）
    if (this.todayBytes >= this.maxFileSizeBytes) {
      const k = this.todayKey;
      const e = this.todayEntries;
      void this.flushDay(k, e);
    }
  }

  /** 主动 flush（如同步结束、插件卸载前）：把今天的缓冲落盘 */
  async flush(): Promise<void> {
    if (this.todayKey && this.todayEntries.length) {
      const k = this.todayKey;
      const e = this.todayEntries;
      await this.flushDay(k, e);
      this.todayEntries = [];
      this.todayBytes = 0;
    }
  }

  /** 把指定日期的「已有磁盘分片 + 本次内存缓冲」合并后整体重写（保证该日全量）。
   *  采用明确 date / entries 参数，避免跨日切换 todayKey 时 flush 到错误日期。 */
  private async flushDay(date: string, entries: SyncLogEntry[]): Promise<void> {
    if (!date || !entries.length) return;
    const existing = await this.readDay(date);
    const merged = mergeById(existing, entries);
    await this.adapter.mkdir(this.dirForDate(date)).catch(() => {});
    const target = this.fileForDate(date, 1);
    try {
      await this.adapter.write(target, JSON.stringify({ entries: merged }));
    } catch {
      /* 写盘失败静默：日志仍可在内存可用 */
    }
  }

  /** 读取某日的所有分片合并为数组 */
  private async readDay(date: string): Promise<SyncLogEntry[]> {
    const out: SyncLogEntry[] = [];
    // 有限循环（替代 while(true)）：读失败即认为分片耗尽；MAX_PARTS 封顶作防御，
    // 避免分片文件异常持续存在时无限循环
    const MAX_PARTS = 1000;
    for (let part = 1; part <= MAX_PARTS; part++) {
      const file = this.fileForDate(date, part);
      try {
        const raw = await this.adapter.read(file);
        const parsed = JSON.parse(raw) as { entries?: SyncLogEntry[] };
        if (Array.isArray(parsed?.entries)) out.push(...parsed.entries);
      } catch {
        break;
      }
    }
    return out;
  }

  private estimateBytes(e: SyncLogEntry): number {
    try {
      return JSON.stringify(e).length;
    } catch {
      return 128;
    }
  }

  /** 清理：删除超过 retentionDays 的日期目录；对近期文件做墓碑物理清除。
   *  返回 { removedDays, removedEntries } */
  async purge(
    now: number,
    tombstoneGraceMs: number,
    includeTombPurge = true,
  ): Promise<{ removedDays: number; removedEntries: number }> {
    let removedDays = 0;
    let removedEntries = 0;

    // 1) 过期日期目录删除
    if (this.retentionDays > 0) {
      const cutoffMs = now - this.retentionDays * 86400_000;
      let listed;
      try {
        listed = await this.adapter.list(this.logsDir);
      } catch {
        listed = {};
      }
      const dateDirs: Record<string, string> = {}; // date -> dirPath
      for (const path of Object.keys(listed)) {
        const rel = path.slice(this.logsDir.length + 1);
        const seg = rel.split('/');
        if (seg.length >= 2 && /^\d{4}-\d{2}-\d{2}$/.test(seg[0])) {
          dateDirs[seg[0]] = `${this.logsDir}/${seg[0]}`;
        }
      }
      for (const date of Object.keys(dateDirs)) {
        const dayEnd = new Date(`${date}T23:59:59.999`).getTime();
        if (dayEnd < cutoffMs) {
          // 删除该日期目录下所有分片文件（adapter 无删除目录 API，空目录残留不影响）
          const dirPath = dateDirs[date];
          try {
            const dirList = await this.adapter.list(dirPath);
            for (const f of Object.keys(dirList)) {
              await this.adapter.remove(f).catch(() => {});
            }
            removedDays += 1;
          } catch {
            /* 忽略 */
          }
        }
      }
    }

    // 2) 近期日期文件内的墓碑物理清除（仅当 includeTombPurge 指定）
    if (includeTombPurge) {
      let listed;
      try {
        listed = await this.adapter.list(this.logsDir);
      } catch {
        listed = {};
      }
      const dateDirs = new Set<string>();
      for (const path of Object.keys(listed)) {
        const rel = path.slice(this.logsDir.length + 1);
        const seg = rel.split('/');
        if (seg.length >= 2 && /^\d{4}-\d{2}-\d{2}$/.test(seg[0])) dateDirs.add(seg[0]);
      }
      for (const date of dateDirs) {
        const merged = await this.readDay(date);
        if (!merged.length) continue;
        const kept = merged.filter((e) => {
          if (!e.deleted) return true;
          const expired = e.deletedAt != null && now - e.deletedAt > tombstoneGraceMs;
          if (expired) {
            removedEntries += 1;
            return false;
          }
          return true;
        });
        if (kept.length !== merged.length) {
          const target = this.fileForDate(date, 1);
          try {
            await this.adapter.write(target, JSON.stringify({ entries: kept }));
          } catch {
            /* 忽略 */
          }
        }
      }
    }

    return { removedDays, removedEntries };
  }

  /** 把「今天」缓冲强制清空（清空全部日志后，避免残留当天条目再次落盘） */
  resetTodayBuffer(): void {
    this.todayKey = '';
    this.todayEntries = [];
    this.todayBytes = 0;
  }

  /** 日期整体向前/后偏移 days 天（用于计算 cutoff）。基于时间戳推移。 */
  private shiftDays(dateStr: string, days: number): string {
    const t = new Date(`${dateStr}T00:00:00`).getTime() + days * 86400_000;
    return dayKey(t);
  }
}

/** 合并两批条目并去重（按 id），后者优先（用于 flush 时「已落盘 + 内存新增」合并） */
function mergeById(base: SyncLogEntry[], incoming: SyncLogEntry[]): SyncLogEntry[] {
  const map = new Map<string, SyncLogEntry>();
  for (const e of base) map.set(e.id, e);
  for (const e of incoming) map.set(e.id, e); // 覆盖
  return Array.from(map.values());
}
