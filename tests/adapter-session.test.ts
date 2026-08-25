import { describe, it, expect } from 'vitest';
import { BaiduAdapter } from '../src/baidu/adapter';
import type { UploadSession } from '../src/types';

// 最小 api 桩（restoreSessions / shardBucket 不触发任何 api 调用）
const fakeApi = {
  snapshotAuth: () => ({ mode: 'openapi' as const }),
} as any;

function makeSession(over: Partial<UploadSession>): UploadSession {
  const md5s = over.md5s ?? ['a', 'b', 'c'];
  return {
    path: 'doc.md',
    remotePath: '/apps/bdnsync/doc.md',
    uploadid: 'uid-1',
    totalSize: 300,
    partSize: 100,
    md5s,
    doneParts: over.doneParts ?? [],
    doneBytes: over.doneBytes ?? 0,
    blockMd5: over.blockMd5 ?? [],
    startedAt: Date.now(),
    ...over,
  };
}

function newAdapter(): BaiduAdapter {
  return new BaiduAdapter(fakeApi, () => ({ deviceId: 'd' }) as any, null);
}

describe('BaiduAdapter.restoreSessions — F1 断点续传有效性校验', () => {
  it('restores a fresh, fully-consistent session', () => {
    const a = newAdapter();
    const s = makeSession({
      md5s: ['m1', 'm2'],
      doneParts: [0],
      blockMd5: ['m1', 'm2'],
      doneBytes: 100,
    });
    a.restoreSessions([s]);
    expect(a.exportSessions().length).toBe(1);
  });

  it('drops sessions older than 12h window', () => {
    const a = newAdapter();
    const old = makeSession({
      startedAt: Date.now() - 13 * 60 * 60 * 1000,
      blockMd5: ['m1', 'm2'],
    });
    a.restoreSessions([old]);
    expect(a.exportSessions().length).toBe(0);
  });

  it('drops session when blockMd5 mismatches md5s at a done part (dirty resume guard)', () => {
    const a = newAdapter();
    // doneParts=[0]，但 blockMd5[0] 与 md5s[0] 不符 → 视为脏断点，丢弃
    const dirty = makeSession({ md5s: ['m1', 'm2'], doneParts: [0], blockMd5: ['WRONG', 'm2'] });
    a.restoreSessions([dirty]);
    expect(a.exportSessions().length).toBe(0);
  });

  it('drops session when doneParts index out of range', () => {
    const a = newAdapter();
    const oob = makeSession({ md5s: ['m1', 'm2'], doneParts: [5], blockMd5: [] });
    a.restoreSessions([oob]);
    expect(a.exportSessions().length).toBe(0);
  });

  it('legacy session without blockMd5 is still restored if doneParts in range', () => {
    const a = newAdapter();
    const legacy = makeSession({ md5s: ['m1', 'm2', 'm3'], doneParts: [0, 1], blockMd5: [] });
    a.restoreSessions([legacy]);
    expect(a.exportSessions().length).toBe(1);
  });

  it('fills default doneBytes/blockMd5 when missing', () => {
    const a = newAdapter();
    const s = makeSession({ doneBytes: undefined as any, blockMd5: undefined as any });
    a.restoreSessions([s]);
    const out = a.exportSessions()[0];
    expect(out.doneBytes).toBe(0);
    expect(out.blockMd5).toEqual([]);
  });
});

describe('BaiduAdapter.shardBucket — A3 确定性分桶', () => {
  it('same path always maps to same shard', () => {
    const a = newAdapter();
    const p = 'Notes/sub/deep/file.md';
    const b1 = (a as any).shardBucket(p, 8);
    const b2 = (a as any).shardBucket(p, 8);
    expect(b1).toBe(b2);
    expect(b1).toBeGreaterThanOrEqual(0);
    expect(b1).toBeLessThan(8);
  });

  it('distribution is stable and bounded across many paths', () => {
    const a = newAdapter();
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i++) {
      const b = (a as any).shardBucket(`path/num-${i}.md`, 16);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(16);
      seen.add(b);
    }
    // 1000 个不同路径在 16 个分片中应当至少用到多个桶（非全挤一个）
    expect(seen.size).toBeGreaterThan(4);
  });
});
