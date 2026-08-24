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
    const attempts = existing ? existing.attempts + 1 : 1;
    const msg = err instanceof Error ? err.message : String(err);
    const errno = err instanceof BaiduApiError ? err.errno : undefined;
    const nextAt = Date.now() + computeDelay(existing ? existing.attempts + 1 : 1, cooldownMs);
    if (existing) {
      existing.attempts = attempts;
      existing.nextAt = nextAt;
      existing.lastError = msg;
      existing.lastErrno = errno;
    } else {
      this.items.push({ path, attempts: 1, nextAt, lastError: msg, lastErrno: errno });
    }
    void this.persist();
    this.notify();
  }

  /** 同步成功后移除对应 path */
  markSuccess(path: string): void {
    const before = this.items.length;
    this.items = this.items.filter((it) => it.path !== path);
    if (this.items.length !== before) {
      void this.persist();
      this.notify();
    }
  }

  /** 立即尝试 flush 所有到期条目；调用 flushFn(paths) 重新同步。 */
  async flush(): Promise<void> {
    const now = Date.now();
    const due = this.items.filter((it) => it.nextAt <= now);
    if (due.length === 0) return;
    const paths = due.map((it) => it.path);
    // 临时移除以免 flush 与自身重试竞争；若仍失败由 flushFn 再次 registerFailure
    const handled = new Set(paths);
    this.items = this.items.filter((it) => !handled.has(it.path));
    this.notify();
    try {
      await this.flushFn(paths);
      // 成功路径会在各自同步流程里 markSuccess；这里不再重复移除
    } catch {
      // flush 整体失败：把条目重新放回队列并推开 nextAt
      for (const p of paths) {
        const existing = this.items.find((it) => it.path === p);
        if (existing) {
          existing.nextAt = Date.now() + computeDelay(existing.attempts + 1, 0);
          existing.attempts += 1;
        } else {
          this.items.push({
            path: p,
            attempts: 1,
            nextAt: Date.now() + BASE_DELAY,
            lastError: '重试失败',
          });
        }
      }
      void this.persist();
      this.notify();
    }
  }

  /** 调度一次带超时的 flush（供后台定时器调用） */
  schedulePoll(intervalMs: number): void {
    if (this.timer !== null) return;
    this.timer = window.setInterval(() => {
      if (navigator.onLine) void this.flush();
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
