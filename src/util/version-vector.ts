// 文件级版本向量（version vector）纯函数工具。
// 用于多设备离线同时编辑的有序归并：区分「一方是另一方祖先」（可直接采用较新）
// 与「双方并发」（必须进入冲突处理），避免多设备互相覆盖丢写。
//
// 语义（标准向量时钟）：
//   vv: Record<deviceId, counter> —— 该设备对某文件的编辑累计次数。
//   A 是 B 的祖先 ⇔ ∀d: A.vv[d] <= B.vv[d]（且至少一个严格小于）。
//   A、B 并发 ⇔ ∃d1: A.vv[d1] > B.vv[d1] 且 ∃d2: A.vv[d2] < B.vv[d2]。

export type VersionVector = Record<string, number>;

/** 空向量 */
export function emptyVV(): VersionVector {
  return {};
}

/** 本设备编辑计数 +1（返回新对象，不改原值） */
export function bumpVV(vv: VersionVector | undefined, deviceId: string): VersionVector {
  const out: VersionVector = { ...(vv ?? {}) };
  out[deviceId] = (out[deviceId] ?? 0) + 1;
  return out;
}

/** 逐设备取 max 合并两个向量（返回新对象）——远端索引「合并提交」语义的核心 */
export function mergeVV(
  a: VersionVector | undefined,
  b: VersionVector | undefined,
): VersionVector {
  const out: VersionVector = {};
  const allKeys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  for (const k of allKeys) {
    const va = a?.[k] ?? 0;
    const vb = b?.[k] ?? 0;
    if (va !== 0 || vb !== 0) out[k] = Math.max(va, vb);
  }
  return out;
}

/** 向量关系判定：'a-before-b' = a 是 b 的祖先（a 旧 b 新）；'b-before-a' = b 是 a 的祖先 */
export type VVRelation = 'equal' | 'a-before-b' | 'b-before-a' | 'concurrent';

export function compareVV(a: VersionVector | undefined, b: VersionVector | undefined): VVRelation {
  const allKeys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  let aGt = false; // 存在 a > b 的设备（a 有 b 没有的变更）
  let bGt = false; // 存在 b > a 的设备（b 有 a 没有的变更）
  for (const k of allKeys) {
    const va = a?.[k] ?? 0;
    const vb = b?.[k] ?? 0;
    if (va > vb) aGt = true;
    else if (vb > va) bGt = true;
  }
  if (aGt && bGt) return 'concurrent';
  if (bGt) return 'a-before-b'; // b 有 a 没有的变更 → a 是 b 的祖先（a 旧 b 新）
  if (aGt) return 'b-before-a'; // a 有 b 没有的变更 → b 是 a 的祖先（b 旧 a 新）
  return 'equal';
}

/** 是否并发（需要冲突处理）；false 表示一方是另一方祖先，可直接采用较新 */
export function isDiverged(a: VersionVector | undefined, b: VersionVector | undefined): boolean {
  return compareVV(a, b) === 'concurrent';
}

/**
 * 合并提交辅助：把本地（已 +1）的向量与远端索引中的向量做 max 合并后返回。
 * 用于 commitRemoteIndex 中「多设备并发提交时向量不互相覆盖」。
 */
export function mergeIntoRemote(
  localVV: VersionVector | undefined,
  remoteVV: VersionVector | undefined,
): VersionVector {
  // localVV 应已包含本设备本次 +1；与远端逐设备 max 后即为并集因果
  return mergeVV(localVV, remoteVV);
}
