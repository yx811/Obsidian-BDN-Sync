// 文件监听：防抖 + 批量合并（5 秒窗口），大文件延长防抖，同步期间挂起防自触发

export interface FileWatcherOptions {
  onFlush: (paths: string[]) => void | Promise<void>;
  onStorm: (paths: string[]) => void | Promise<void>; // 超阈值时触发完整对账
  getFileSize: (path: string) => number;
}

export class FileWatcher {
  private pendingPaths = new Set<string>();
  private timers = new Map<string, number>();
  private batchTimer: number | null = null;
  private suspended = false;
  private discardedDuringSync = new Set<string>();
  private LARGE = 10 * 1024 * 1024; // >10MB 防抖 10s
  private HUGE = 100 * 1024 * 1024; // >100MB 不做实时同步
  private DEBOUNCE_MS = 3000;
  private LARGE_DEBOUNCE_MS = 10000;
  private BATCH_WINDOW_MS = 5000;
  /** 单次 flush 超过此数量的变更即视为「风暴」，降级为完整同步（0 表示不启用） */
  stormThreshold = 200;
  /** 上一次 flush 时间戳，用于最小同步间隔护栏 */
  private lastFlushAt = 0;
  minIntervalMs = 2000;

  constructor(private opts: FileWatcherOptions) {}

  suspend(): void {
    this.suspended = true;
  }

  resume(): void {
    this.suspended = false;
    // 丢弃同步期间由引擎自身写入触发的变更
    for (const p of this.discardedDuringSync) this.clearTimer(p);
    this.discardedDuringSync.clear();
  }

  private clearTimer(path: string): void {
    const t = this.timers.get(path);
    if (t !== undefined) {
      window.clearTimeout(t);
      this.timers.delete(path);
    }
    this.pendingPaths.delete(path);
    if (this.pendingPaths.size === 0 && this.batchTimer !== null) {
      window.clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
  }

  /** 文件创建/修改/删除/重命名（旧路径也需传入） */
  onChange(path: string): void {
    if (!path) return;
    if (this.suspended) {
      this.discardedDuringSync.add(path);
      return;
    }
    const size = this.opts.getFileSize(path);
    if (size > this.HUGE) return; // 超大文件交由手动/自动同步

    const delay = size > this.LARGE ? this.LARGE_DEBOUNCE_MS : this.DEBOUNCE_MS;

    // 重置该文件的防抖计时器
    const existing = this.timers.get(path);
    if (existing !== undefined) window.clearTimeout(existing);

    this.pendingPaths.add(path);
    this.timers.set(
      path,
      window.setTimeout(() => {
        this.timers.delete(path);
        this.scheduleBatch();
      }, delay),
    );
  }

  private scheduleBatch(): void {
    if (this.batchTimer !== null) return;
    this.batchTimer = window.setTimeout(() => {
      this.batchTimer = null;
      const paths = Array.from(this.pendingPaths);
      this.pendingPaths.clear();
      for (const p of paths) this.timers.delete(p);
      if (paths.length === 0) return;
      if (this.suspended) return;

      // 最小同步间隔护栏：两次 flush 不能挨得太近，避免互相抢占
      const now = Date.now();
      if (now - this.lastFlushAt < this.minIntervalMs) {
        // 还不够，稍后重试并把本次累积的变更继续保留。
        // 注意：必须用「合并」而非整体覆盖——重试等待期内可能又有新的 onChange
        // 往 pendingPaths 添加了路径，若直接 `pendingPaths = new Set(paths)` 会把
        // 这些新变更冲掉（极小窗口竞态丢同步触发；虽由 startup 全量兜底，但应消除）。
        for (const p of paths) this.pendingPaths.add(p);
        this.batchTimer = window.setTimeout(
          () => this.scheduleBatch(),
          this.minIntervalMs - (now - this.lastFlushAt),
        );
        return;
      }

      // 风暴限流：大量变更转为一次完整同步，避免逐文件增量误删/误增
      if (this.stormThreshold > 0 && paths.length >= this.stormThreshold) {
        this.lastFlushAt = now;
        void this.opts.onStorm(paths);
        return;
      }

      this.lastFlushAt = now;
      void this.opts.onFlush(paths);
    }, this.BATCH_WINDOW_MS);
  }

  /** 插件卸载/立即触发 */
  async flush(): Promise<void> {
    if (this.batchTimer !== null) {
      window.clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    for (const t of this.timers.values()) window.clearTimeout(t);
    this.timers.clear();
    const paths = Array.from(this.pendingPaths);
    this.pendingPaths.clear();
    if (paths.length > 0 && !this.suspended) {
      await this.opts.onFlush(paths);
    }
  }

  dispose(): void {
    for (const t of this.timers.values()) window.clearTimeout(t);
    this.timers.clear();
    this.pendingPaths.clear();
    if (this.batchTimer !== null) window.clearTimeout(this.batchTimer);
    this.batchTimer = null;
  }
}
