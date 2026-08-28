// 失败重试队列（方案 1 · 可靠性）
//
// 把增量/完整同步中失败的文件放入队列，按指数退避自动重试，并尊重服务端返回的
// cooldownMs（限流/操作频繁）。队列持久化到 retry-state.json，崩溃/离线重启后仍在，
// 网络恢复（online 事件）或下一次同步时自动 flush。非瞬态错误（鉴权/非法）不入队。

import { BaiduApiError } from '../baidu/api';

export interface RetryItem {
  path: string;
  attempts: number;
  nextAt: number; // 下次可重试的 Unix 毫秒
  lastError: string;
  lastErrno?: number;
}

export interface RetryState {
  items: RetryItem[];
}

const MAX_ATTEMPTS = 8;
const BASE_DELAY = 1000; // 1s
const MAX_DELAY = 60_000; // 60s 上限

function computeDelay(attempts: number, cooldownMs: number): number {
  const exp = Math.min(BASE_DELAY * 2 ** (attempts - 1), MAX_DELAY);
  return Math.max(exp, cooldownMs);
}

export class RetryQueue {
  private items: RetryItem[] = [];
  private timer: number | null = null;
  private persist: () => Promise<void>;
  private flushFn: (paths: string[]) => Promise<void>;
  private onUpdate?: () => void;
  /**
   * 跨 flush 周期的 attempts 记忆（path → 已尝试次数）。
   *
   * 背景（验收发现的真实缺陷）：flush() 会在调用 flushFn **之前**把到期条目移出 items
   * （避免与自身重试竞争），而 flushFn（即 runQuickSync）内部会 catch 掉全部异常、
   * 再调用 registerFailure 登记失败。此时条目已不在 items 中，registerFailure 走
   * 「新建」分支、恒以 attempts=1 重建 —— 结果是退避永远停留在最小值（1s）、
   * MAX_ATTEMPTS 永远触不到，永久失败的文件每 15s 被无限重试，空耗 API 配额。
   * 这里用一张记忆表把 attempts 跨周期保留下来，让指数退避与次数上限真正生效。
   */
  private attemptsMemo = new Map<string, number>();

  constructor(
    persist: () => Promise<void>,
    flushFn: (paths: string[]) => Promise<void>,
    onUpdate?: () => void,
  ) {
    this.persist = persist;
    this.flushFn = flushFn;
    this.onUpdate = onUpdate;
  }

  /** 从磁盘恢复（仅恢复未过期条目） */
  hydrate(state: { items?: RetryItem[] } | undefined): void {
    if (!state || !Array.isArray(state.items)) return;
    const now = Date.now();
    this.items = state.items.filter(
      (it) => it.attempts < MAX_ATTEMPTS && it.nextAt <= now + 7 * 86400_000,
    );
    this.notify();
  }

  toState(): RetryState {
    return { items: this.items };
  }

  get size(): number {
    return this.items.length;
  }

  list(): ReadonlyArray<RetryItem> {
    return this.items;
  }

  /**
   * 登记一次失败。瞬态错误（限流/网络）才入队；冷却时间尊重服务端 cooldownMs。
   * 同一 path 已存在则更新 attempts / nextAt，避免重复堆积。
   */
  registerFailure(path: string, err: unknown, transient: boolean, cooldownMs = 0): void {
    if (!transient) return; // 非瞬态：直接报错，不入队列，避免无意义重试
    const existing = this.items.find((it) => it.path === path);
    // 条目已被 flush 提前摘出时，用记忆表中的次数继续累加（详见 attemptsMemo 注释）
    const prevAttempts = existing ? existing.attempts : (this.attemptsMemo.get(path) ?? 0);
    const attempts = prevAttempts + 1;
    const msg = err instanceof Error ? err.message : String(err);
    const errno = err instanceof BaiduApiError ? err.errno : undefined;
    const nextAt = Date.now() + computeDelay(attempts, cooldownMs);
    // 达到上限：放弃该路径并清除记忆，避免永久失败项无限占用轮询与 API 配额
    if (attempts > MAX_ATTEMPTS) {
      this.items = this.items.filter((it) => it.path !== path);
      this.attemptsMemo.delete(path);
      console.warn(
        `[BDNSync] 重试已达上限（${MAX_ATTEMPTS} 次），放弃自动重试：${path}（最后错误：${msg}）`,
      );
      void this.persist().catch(() => {});
      this.notify();
      return;
    }
    if (existing) {
      existing.attempts = attempts;
      existing.nextAt = nextAt;
      existing.lastError = msg;
      existing.lastErrno = errno;
    } else {
      this.items.push({ path, attempts, nextAt, lastError: msg, lastErrno: errno });
    }
    this.attemptsMemo.set(path, attempts);
    void this.persist().catch(() => {});
    this.notify();
  }

  /** 同步成功后移除对应 path */
  markSuccess(path: string): void {
    const before = this.items.length;
    this.items = this.items.filter((it) => it.path !== path);
    if (this.items.length !== before) {
      void this.persist().catch(() => {});
      this.notify();
    }
  }

  /** 立即尝试 flush 所有到期条目；调用 flushFn(paths) 重新同步。 */
  async flush(): Promise<void> {
    const now = Date.now();
    const due = this.items.filter((it) => it.nextAt <= now);
    if (due.length === 0) return;
    const paths = due.map((it) => it.path);
    // 临时移除以免 flush 与自身重试竞争；若仍失败由 flushFn 再次 registerFailure。
    // 注意：移除后无法再通过 .find 拿到原 attempts，必须先用快照保留原状态。
    const snapshot = new Set(paths);
    this.items = this.items.filter((it) => !snapshot.has(it.path));
    this.notify();
    try {
      await this.flushFn(paths);
      // 仍失败的路径由 flushFn 内部调用 registerFailure 重新入队（attempts 经
      // attemptsMemo 累加）；成功的路径不再回到队列，等同于成功出队。
    } catch (e) {
      // flushFn 整体抛出（正常情况下它会自行 catch 并 registerFailure）：
      // 仅对「尚未被重新登记」的路径补一次失败登记，避免重复计数。
      const msg = e instanceof Error ? e.message : String(e);
      for (const p of paths) {
        if (!this.items.some((it) => it.path === p)) {
          this.registerFailure(p, new Error(msg), true, 0);
        }
      }
    }
    // 本轮未被重新登记 ⇒ 该路径已成功（或不再需要重试）：清除其 attempts 记忆，
    // 使后续偶发的新失败从 1 重新开始，不被很久以前的历史累计次数误伤。
    for (const p of paths) {
      if (!this.items.some((it) => it.path === p)) this.attemptsMemo.delete(p);
    }
    void this.persist().catch(() => {});
    this.notify();
  }

  /** 调度一次带超时的 flush（供后台定时器调用） */
  schedulePoll(intervalMs: number): void {
    if (this.timer !== null) return;
    this.timer = window.setInterval(() => {
      // catch：轮询每 15s 触发一次，未处理的 rejection 会持续污染宿主（界面不稳定）
      if (navigator.onLine) void this.flush().catch(() => {});
    }, intervalMs);
  }

  stopPoll(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  private notify(): void {
    this.onUpdate?.();
  }
}
