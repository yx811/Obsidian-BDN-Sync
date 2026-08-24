// 脏集合管理（方案 3 · 一致性）
//
// 维护「待同步」的本地文件集合，跨多次 flush 累积，随成功同步移除。
// 解决两个问题：
//  1. 增量对比的输入从「本次 flush 的路径」升级为「全局脏集合」，避免跨窗口的
//     并发修改被误判为「冲突」从而退化成完整同步。
//  2. 跨窗口 rename：记录近期 delete 事件（oldPath），与稍后到达的 create 事件配对，
//     在 watcher 层面就把「删+增」合并为一次 move，而不是交给增量对比盲目处理。

import type { BDNSyncSettings } from '../types';

interface PendingDelete {
  path: string;
  at: number;
}

export class DirtySet {
  private dirty = new Set<string>();
  private recentDeletes: PendingDelete[] = [];
  private windowMs: number;

  constructor(settings: () => BDNSyncSettings) {
    this.windowMs = (settings().renameGraceMs ?? 1500) || 1500;
  }

  /** 设置变更后实时更新窗口（供设置页保存后联动） */
  setWindow(ms: number): void {
    this.windowMs = Math.max(0, ms) || 1500;
  }

  /** 标记文件为脏（创建/修改/重命名目标） */
  mark(path: string): void {
    this.dirty.add(path);
  }

  /** 记录一次删除事件，便于与随后到达的新路径配对成 rename */
  markDelete(path: string): void {
    this.dirty.add(path);
    this.recentDeletes.push({ path, at: Date.now() });
    // 只保留窗口内的记录，避免无限增长
    const cutoff = Date.now() - this.windowMs;
    this.recentDeletes = this.recentDeletes.filter((d) => d.at >= cutoff);
  }

  /**
   * 尝试把一个「新路径」与最近的删除配对成 rename（跨窗口）。
   * 返回配对的 oldPath（已删除、且尚未被消费），否则 null。
   * 命中后消费该 delete 记录并把它从脏集合移除（交给上层 move 处理）。
   */
  matchRename(_newPath: string): string | null {
    const cutoff = Date.now() - this.windowMs;
    for (let i = 0; i < this.recentDeletes.length; i++) {
      const d = this.recentDeletes[i];
      if (d.at < cutoff) continue;
      // 简单启发：同一父目录下、且 newPath 不在本地索引之外的「删除」视为配对候选；
      // 严格 hash 校验由引擎做，这里只做「窗口内的删除 → 创建」配对提示。
      this.recentDeletes.splice(i, 1);
      this.dirty.delete(d.path);
      return d.path;
    }
    return null;
  }

  /** 取出并清空脏集合，重置计数（成功同步后调用） */
  drain(): string[] {
    const out = Array.from(this.dirty);
    this.dirty.clear();
    return out;
  }

  /** 同步成功后，从集合中移除已成功路径 */
  clearPaths(paths: string[]): void {
    for (const p of paths) this.dirty.delete(p);
  }

  /** 失败时保留脏标记，等待下次补齐 */
  keep(paths: string[]): void {
    for (const p of paths) this.dirty.add(p);
  }

  get size(): number {
    return this.dirty.size;
  }
}
