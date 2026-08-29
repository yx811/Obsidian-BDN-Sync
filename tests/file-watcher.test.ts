// FileWatcher 同步触发可靠性单测（锁定 RC-A~RC-D 修复行为）
//
// 覆盖：
// 1) 🔴RC-B：同步期间（watcher suspended）产生的变更，resume 后必须重新投递，绝不丢失；
//    且批次计时器在 suspended 期间触发时不得清空 pendingPaths 后丢弃。
// 2) 🔴RC-C：超大文件（>100MB）不再静默丢弃，而是降级为一次完整同步（onStorm）。
// 3) 🟡RC-D：最小同步间隔护栏使用真实时间戳重排，变更不丢、最终仍能 flush。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FileWatcher } from '../src/watcher/file-watcher';

// 让 FileWatcher 使用的 window.setTimeout / window.clearTimeout 指向 vitest 假定时器
beforeEach(() => {
  (globalThis as { window?: unknown }).window = globalThis;
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { window?: unknown }).window;
});

function makeWatcher(getFileSize: (p: string) => number) {
  const flushed: string[][] = [];
  const stormed: string[][] = [];
  const w = new FileWatcher({
    onFlush: (paths) => {
      flushed.push(paths);
    },
    onStorm: (paths) => {
      stormed.push(paths);
    },
    getFileSize,
  });
  return { w, flushed, stormed };
}

describe('FileWatcher 同步触发可靠性', () => {
  it('RC-B：suspend 期间累积的变更在 resume 后被重新投递，不丢失', () => {
    const { w, flushed } = makeWatcher(() => 0);
    w.onChange('a.md');
    // 走完单文件防抖(3s) + 批次窗口(5s)，批次计时器已排期
    vi.advanceTimersByTime(3000);
    w.suspend();
    // 同步期间又产生 b.md 变更（应被记录而非丢弃）
    w.onChange('b.md');
    // 批次计时器触发：处于 suspended，仅返回，pendingPaths 保留不丢
    vi.advanceTimersByTime(5000);
    expect(flushed.length).toBe(0);
    // 恢复：discarded(b.md) 重新投递 + 既有 a.md 一并调度
    w.resume();
    vi.advanceTimersByTime(3000 + 5000);
    expect(flushed.length).toBe(1);
    expect([...flushed[0]].sort()).toEqual(['a.md', 'b.md']);
  });

  it('RC-B：批次计时器在 suspended 期间触发不得清空 pendingPaths', () => {
    const { w, flushed } = makeWatcher(() => 0);
    w.onChange('a.md');
    vi.advanceTimersByTime(3000); // 单文件防抖 → 进入批次窗口
    w.suspend();
    vi.advanceTimersByTime(5000); // 批次计时器触发但 suspended → 不丢
    w.resume();
    vi.advanceTimersByTime(3000 + 5000);
    expect(flushed.length).toBe(1);
    expect(flushed[0]).toContain('a.md');
  });

  it('RC-C：超大文件(>100MB)降级为完整同步(onStorm)而非静默丢弃', () => {
    const { w, flushed, stormed } = makeWatcher((p) => (p === 'big.bin' ? 200 * 1024 * 1024 : 0));
    w.onChange('big.bin');
    // 超大文件使用大文件防抖(10s) + 批次窗口(5s)
    vi.advanceTimersByTime(10000 + 5000);
    expect(stormed.length).toBe(1);
    expect(stormed[0]).toContain('big.bin');
    expect(flushed.length).toBe(0); // 不应走增量 onFlush
  });

  it('RC-C：普通文件仍走增量 onFlush', () => {
    const { w, flushed, stormed } = makeWatcher(() => 0);
    w.onChange('note.md');
    vi.advanceTimersByTime(3000 + 5000);
    expect(flushed.length).toBe(1);
    expect(stormed.length).toBe(0);
  });

  it('RC-D：最小间隔护栏不丢变更，重试后最终 flush', () => {
    const { w, flushed } = makeWatcher(() => 0);
    w.onChange('a.md');
    vi.advanceTimersByTime(3000 + 5000); // 第一次 flush
    expect(flushed.length).toBe(1);
    w.onChange('b.md');
    vi.advanceTimersByTime(3000 + 5000); // 受 minInterval(2s) 护栏，先重排再 flush
    expect(flushed.length).toBe(2);
    expect([...flushed[1]].sort()).toEqual(['b.md']);
  });

  // —— 实时模式更跟手档位（用户反馈痛点 #2：实时同步不够"实时"）——
  it('实时档位：传入 debounceMs/batchWindowMs 后防抖更短，≈2.3s 即 flush', () => {
    const { w, flushed } = makeWatcher(() => 0);
    w.setTiming(800, 3000, 1500);
    w.onChange('note.md');
    vi.advanceTimersByTime(800 + 1500); // 800ms 单文件防抖 + 1500ms 批次窗口
    expect(flushed.length).toBe(1);
    expect(flushed[0]).toContain('note.md');
  });

  it('实时档位：构造函数传参即生效（realtime 实例化路径）', () => {
    const flushed: string[][] = [];
    const w = new FileWatcher({
      onFlush: (paths) => flushed.push(paths),
      onStorm: () => {},
      getFileSize: () => 0,
      debounceMs: 800,
      largeDebounceMs: 3000,
      batchWindowMs: 1500,
    });
    w.onChange('note.md');
    vi.advanceTimersByTime(800 + 1500);
    expect(flushed.length).toBe(1);
  });

  it('档位切换：默认档位→实时档位后，新变更按更短防抖生效', () => {
    const { w, flushed } = makeWatcher(() => 0);
    // 默认档位：3s 防抖；先验证默认行为
    w.onChange('a.md');
    vi.advanceTimersByTime(3000 + 5000);
    expect(flushed.length).toBe(1);
    // 运行时切换到实时档位
    w.setTiming(800, 3000, 1500);
    w.onChange('b.md');
    vi.advanceTimersByTime(800 + 1500);
    expect(flushed.length).toBe(2);
    expect(flushed[1]).toContain('b.md');
  });
});
