// 版本向量（version vector）纯函数单测：多设备离线编辑的有序归并语义
import { describe, expect, it } from 'vitest';
import {
  bumpVV,
  compareVV,
  emptyVV,
  isDiverged,
  mergeIntoRemote,
  mergeVV,
  type VersionVector,
} from '../src/util/version-vector';

describe('version-vector 基本操作', () => {
  it('emptyVV / bumpVV：首次编辑计数为 1，连续编辑递增', () => {
    const v1 = bumpVV(emptyVV(), 'devA');
    expect(v1).toEqual({ devA: 1 });
    const v2 = bumpVV(v1, 'devA');
    expect(v2).toEqual({ devA: 2 });
    // 不修改原对象
    expect(v1).toEqual({ devA: 1 });
  });

  it('bumpVV 保留其它设备计数', () => {
    const base: VersionVector = { devA: 3, devB: 2 };
    const v = bumpVV(base, 'devC');
    expect(v).toEqual({ devA: 3, devB: 2, devC: 1 });
  });

  it('mergeVV：逐设备取 max，空设备不产生键', () => {
    expect(mergeVV({ devA: 2 }, { devA: 3, devB: 1 })).toEqual({ devA: 3, devB: 1 });
    expect(mergeVV(undefined, { devA: 1 })).toEqual({ devA: 1 });
    expect(mergeVV(undefined, undefined)).toEqual({});
  });
});

describe('compareVV / isDiverged 因果判定', () => {
  it('相等向量 → equal', () => {
    expect(compareVV({ devA: 1 }, { devA: 1 })).toBe('equal');
    expect(isDiverged({ devA: 1 }, { devA: 1 })).toBe(false);
  });

  it('一方是另一方祖先（无并发）→ 不 diverged', () => {
    // B 包含 A 的所有变更（A 更旧）
    expect(compareVV({ devA: 1 }, { devA: 1, devB: 2 })).toBe('a-before-b');
    expect(isDiverged({ devA: 1 }, { devA: 1, devB: 2 })).toBe(false);
    // A 包含 B（B 更旧）
    expect(compareVV({ devA: 2, devB: 1 }, { devA: 2 })).toBe('b-before-a');
    expect(isDiverged({ devA: 2, devB: 1 }, { devA: 2 })).toBe(false);
  });

  it('双方并发 → diverged', () => {
    // A 在 devA 前进、B 在 devB 前进：互不包含
    expect(compareVV({ devA: 2, devB: 1 }, { devA: 1, devB: 2 })).toBe('concurrent');
    expect(isDiverged({ devA: 2, devB: 1 }, { devA: 1, devB: 2 })).toBe(true);
  });

  it('缺省（单设备旧索引）按不并发处理', () => {
    expect(compareVV(undefined, undefined)).toBe('equal');
    expect(isDiverged(undefined, undefined)).toBe(false);
  });
});

describe('mergeIntoRemote 合并提交语义', () => {
  it('远端已有的设备计数不被本地覆盖', () => {
    const localVV = bumpVV({ devA: 3, devB: 1 }, 'devA'); // 本地 devA 编辑 +1 → 4
    const remoteVV = { devA: 3, devB: 2, devC: 5 }; // 远端他看到 devB=2, devC=5
    const merged = mergeIntoRemote(localVV, remoteVV);
    expect(merged).toEqual({ devA: 4, devB: 2, devC: 5 });
  });

  it('本地为唯一设备时正常累积', () => {
    const merged = mergeIntoRemote(bumpVV(emptyVV(), 'devA'), undefined);
    expect(merged).toEqual({ devA: 1 });
  });
});
