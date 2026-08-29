// 文件监听：防抖 + 批量合并（5 秒窗口），大文件延长防抖，同步期间挂起防自触发

export interface FileWatcherOptions {
  onFlush: (paths: string[]) => void | Promise<void>;
  onStorm: (paths: string[]) => void | Promise<void>; // 超阈值时触发完整对账
  getFileSize: (path: string) => number;
  /** 普通文件防抖（毫秒）。实时模式可传更短值以更跟手。默认 3000。 */
  debounceMs?: number;
  /** 大文件（>10MB）防抖（毫秒）。默认 10000。 */
  largeDebounceMs?: number;
  /** 批次合并窗口（毫秒）。默认 5000。 */
  batchWindowMs?: number;
}

export class FileWatcher {
  private pendingPaths = new Set<string>();
  private timers = new Map<string, number>();
  private batchTimer: number | null = null;
  private suspended = false;
  private discardedDuringSync = new Set<string>();
  private LARGE = 10 * 1024 * 1024; // >10MB 防抖 10s
  private HUGE = 100 * 1024 * 1024; // >100MB：不实时增量，改走完整同步兜底
  /** 本批次中标记为「超大文件」的路径：触发时降级为一次完整同步，确保不丢 */
  private hugePaths = new Set<string>();
  private DEBOUNCE_MS: number;
  private LARGE_DEBOUNCE_MS: number;
  private BATCH_WINDOW_MS: number;
  /** 单次 flush 超过此数量的变更即视为「风暴」，降级为完整同步（0 表示不启用） */
  stormThreshold = 200;
  /** 上一次 flush 时间戳，用于最小同步间隔护栏 */
  private lastFlushAt = 0;
  minIntervalMs = 2000;

  constructor(private opts: FileWatcherOptions) {
    this.DEBOUNCE_MS = opts.debounceMs ?? 3000;
    this.LARGE_DEBOUNCE_MS = opts.largeDebounceMs ?? 10000;
    this.BATCH_WINDOW_MS = opts.batchWindowMs ?? 5000;
  }

  /**
   * 运行时切换防抖/批次参数（如由 realtime 模式切换为更跟手的档位）。
   * 不中断正在累积的批次，仅影响后续新文件的防抖时长。
   */
  setTiming(debounceMs: number, largeDebounceMs: number, batchWindowMs: number): void {
    this.DEBOUNCE_MS = debounceMs;
    this.LARGE_DEBOUNCE_MS = largeDebounceMs;
    this.BATCH_WINDOW_MS = batchWindowMs;
  }

  suspend(): void {
    this.suspended = true;
  }

  resume(): void {
    this.suspended = false;
    // 🔴RC-B 修复：同步期间累积的变更不能丢弃——重新投递到批次队列，
    // 确保实时同步窗口内的改动最终落盘（此前 clearTimer 等于直接丢弃）。
    for (const p of this.discardedDuringSync) this.pendingPaths.add(p);
    this.discardedDuringSync.clear();
    if (this.pendingPaths.size > 0) this.scheduleBatch();
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
      // 🔴RC-B 修复：同步期间产生的变更先记录，resume() 会重新投递，绝不丢弃
      this.discardedDuringSync.add(path);
      return;
    }
    const size = this.opts.getFileSize(path);
    // 🔴RC-C 修复：超大文件不再静默丢弃——标记后并入批次，批次触发时降级为一次完整同步，
    // 确保即便实时增量不擅长处理大文件，也不会永久漏同步。
    if (size > this.HUGE) this.hugePaths.add(path);

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
      if (paths.length === 0) return;
      // 🔴RC-B 修复：同步进行中（watcher 被挂起）时，保留累积变更不丢——直接返回即可，
      // pendingPaths 仍保留原样，待 resume() 重新投递并调度；此前是「先 clear 再 suspended return」导致永久丢失。
      if (this.suspended) return;
      this.pendingPaths.clear();
      for (const p of paths) this.timers.delete(p);

      // 最小同步间隔护栏：两次 flush 不能挨得太近，避免互相抢占
      // 🟡RC-D 修复：用「当前真实时间戳」计算重试间隔（此前复用函数入口处的旧 now，可能过短导致反复重排）。
      const now = Date.now();
      if (now - this.lastFlushAt < this.minIntervalMs) {
        // 还不够，稍后重试并把本次累积的变更继续保留。
        // 注意：必须用「合并」而非整体覆盖——重试等待期内可能又有新的 onChange
        // 往 pendingPaths 添加了路径，若直接 `pendingPaths = new Set(paths)` 会把
        // 这些新变更冲掉（极小窗口竞态丢同步触发；虽由 startup 全量兜底，但应消除）。
        for (const p of paths) this.pendingPaths.add(p);
        this.batchTimer = window.setTimeout(
          () => this.scheduleBatch(),
          Math.max(200, this.minIntervalMs - (now - this.lastFlushAt)),
        );
        return;
      }

      // 超大文件存在：降级为一次完整同步，确保不丢（RC-C）
      if (this.hugePaths.size > 0 && paths.some((p) => this.hugePaths.has(p))) {
        for (const p of paths) this.hugePaths.delete(p);
        this.lastFlushAt = now;
        void this.opts.onStorm(paths);
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
