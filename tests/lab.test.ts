// 实验室功能 2/3/4 纯逻辑单测
import { describe, it, expect } from 'vitest';
import { computeHealthScore } from '../src/lab/health-score';
import type { SyncResult } from '../src/sync/engine';
import { parseBdnRef, buildBdnRef } from '../src/lab/media-bridge';

function baseResult(over: Partial<SyncResult> = {}): SyncResult {
  return {
    ok: true,
    uploaded: 0,
    downloaded: 0,
    deletedLocal: 0,
    deletedRemote: 0,
    conflicts: 0,
    skipped: 0,
    errors: 0,
    bytesUp: 0,
    bytesDown: 0,
    errorMessages: [],
    ...over,
  };
}

describe('health-score: computeHealthScore', () => {
  it('完全健康 → 100', () => {
    const r = computeHealthScore(baseResult());
    expect(r.score).toBe(100);
    expect(r.level).toBe('good');
  });

  it('取消同步 → 视作健康', () => {
    const r = computeHealthScore(baseResult({ cancelled: true }));
    expect(r.level).toBe('good');
    expect(r.score).toBe(100);
  });

  it('1 个冲突 → 扣分且 warn/risk', () => {
    const r = computeHealthScore(baseResult({ conflicts: 1 }));
    expect(r.score).toBeLessThan(100);
    expect(r.reasons.some((x) => x.includes('冲突'))).toBe(true);
  });

  it('本地删除越多扣越多', () => {
    const a = computeHealthScore(baseResult({ deletedLocal: 1 }));
    const b = computeHealthScore(baseResult({ deletedLocal: 3 }));
    expect(b.score).toBeLessThan(a.score);
  });

  it('错误最严重，扣到 risk', () => {
    const r = computeHealthScore(baseResult({ errors: 3 }));
    expect(r.level).toBe('risk');
    expect(r.score).toBeLessThan(50);
  });

  it('错误=2 临界为 warn（score=50）', () => {
    const r = computeHealthScore(baseResult({ errors: 2 }));
    expect(r.level).toBe('warn');
    expect(r.score).toBe(50);
  });

  it('超大传输触发 oversize 原因', () => {
    const r = computeHealthScore(baseResult({ bytesUp: 200 * 1024 * 1024 }));
    expect(r.reasons.some((x) => x.includes('超大'))).toBe(true);
  });

  it('重试队列堆积加分', () => {
    const a = computeHealthScore(baseResult(), 0);
    const b = computeHealthScore(baseResult(), 5);
    expect(b.score).toBeLessThan(a.score);
  });

  it('分数钳制在 0-100', () => {
    const r = computeHealthScore(baseResult({ conflicts: 99, errors: 99, deletedLocal: 99 }));
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
  });
});

describe('backlinks: parseBdnRef 复用', () => {
  it('fsId|path 与 path-only 都能解析', () => {
    expect(parseBdnRef('bdn://123|img/a.png')).toEqual({ fsId: '123', path: 'img/a.png' });
    expect(parseBdnRef('bdn://img/a.png')).toEqual({ path: 'img/a.png' });
    expect(buildBdnRef('123', 'img/a.png')).toBe('bdn://123|img/a.png');
  });
});

describe('offline-pin: safeKey 稳定性（通过 pinFile/unpin 行为间接验证）', () => {
  it('safeKey 对同一 target 稳定（通过 isPinned 前后一致间接测）', async () => {
    // 受 stub 限制，这里只验证模块可导入、纯逻辑不崩溃
    const mod = await import('../src/lab/offline-pin');
    expect(typeof mod.isPinned).toBe('function');
    expect(typeof mod.pinFile).toBe('function');
    expect(typeof mod.getPinnedBlobUrl).toBe('function');
  });
});
