// 行级三方合并（diff3）与两方联合合并实现
// - threeWayMerge: 有 base（上次同步内容）时的标准 diff3 行级合并
// - unionMerge: 无 base 时的联合合并（双方新增均保留，同一位置的差异加冲突标记）

export interface MergeResult {
  merged: string;
  hasConflict: boolean; // 是否包含冲突标记（需用户手动处理）
}

const MAX_LCS_CELLS = 500_000; // DP 上限（约 2MB Int32Array），防止超大文件内存爆炸/性能劣化。
// 超过此上限时 lcsMatches 返回 null，上层走整体冲突标记降级路径。

function toLines(text: string): string[] {
  return text.split('\n');
}

/**
 * 用共享字典将多组行数组映射为整数，加速比较。
 * 关键：三数组必须用同一字典编码，否则同一行文本在不同数组里会被赋予不同 ID，
 * 导致跨数组的 LCS 比较失效（表现为「追加块被静默丢弃」「同长度修改被判未改」）。
 */
function encodeLinesShared(...lineSets: string[][]): Int32Array[] {
  const dict = new Map<string, number>();
  return lineSets.map((lines) => {
    const arr = new Int32Array(lines.length);
    for (let i = 0; i < lines.length; i++) {
      let id = dict.get(lines[i]);
      if (id === undefined) {
        id = dict.size;
        dict.set(lines[i], id);
      }
      arr[i] = id;
    }
    return arr;
  });
}

interface LcsMatch {
  aIdx: number;
  bIdx: number;
}

/** LCS 匹配（返回按序的公共元素索引对）。超限返回 null。 */
function lcsMatches(a: Int32Array, b: Int32Array): LcsMatch[] | null {
  const n = a.length,
    m = b.length;
  if ((n + 1) * (m + 1) > MAX_LCS_CELLS) return null;
  const w = m + 1;
  const dp = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    const rowBase = i * w,
      nextBase = (i + 1) * w;
    for (let j = m - 1; j >= 0; j--) {
      dp[rowBase + j] =
        a[i] === b[j] ? dp[nextBase + j + 1] + 1 : Math.max(dp[nextBase + j], dp[rowBase + j + 1]);
    }
  }
  const out: LcsMatch[] = [];
  let i = 0,
    j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ aIdx: i, bIdx: j });
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++;
    else j++;
  }
  return out;
}

/** 标准 diff3：base 为锚点，三方对比，两侧同区不同修改 → 冲突标记 */
export function threeWayMerge(
  baseText: string,
  localText: string,
  remoteText: string,
  localLabel = 'LOCAL',
  remoteLabel = 'REMOTE',
): MergeResult {
  const base = toLines(baseText);
  const local = toLines(localText);
  const remote = toLines(remoteText);

  const [baseArr, localArr, remoteArr] = encodeLinesShared(base, local, remote);

  const lm = lcsMatches(baseArr, localArr);
  const rm = lcsMatches(baseArr, remoteArr);
  if (!lm || !rm) return fallbackMerge(localText, remoteText, localLabel, remoteLabel);

  // base→local / base→remote 的行映射（-1 表示未匹配）
  const mapLocal = new Int32Array(base.length).fill(-1);
  for (const p of lm) mapLocal[p.aIdx] = p.bIdx;
  const mapRemote = new Int32Array(base.length).fill(-1);
  for (const p of rm) mapRemote[p.aIdx] = p.bIdx;

  const out: string[] = [];
  let hasConflict = false;

  // 比较「base 区间」与「local/remote 区间」的内容是否一致（判断相对 base 是否改动）。
  // 注意：早期版本误把 base 区间与 local 区间在同一数组内比较，导致「同长度的内容修改」
  // 被误判为未改、尾部追加块被静默丢弃——这是 smart-merge 静默丢失修改的根因，现已修正。
  const localEqBase = (bS: number, bE: number, lS: number, lE: number): boolean => {
    if (bE - bS !== lE - lS) return false;
    for (let i = 0; i < lE - lS; i++) if (base[bS + i] !== local[lS + i]) return false;
    return true;
  };
  const remoteEqBase = (bS: number, bE: number, rS: number, rE: number): boolean => {
    if (bE - bS !== rE - rS) return false;
    for (let i = 0; i < rE - rS; i++) if (base[bS + i] !== remote[rS + i]) return false;
    return true;
  };

  // 找到下一个"双方都匹配的 base 行"作为锚
  // 预先构建锚列表
  const anchors: { b: number; l: number; r: number }[] = [];
  for (let b = 0; b < base.length; b++) {
    const l = mapLocal[b],
      r = mapRemote[b];
    if (l >= 0 && r >= 0) anchors.push({ b, l, r });
  }

  let anchorPtr = 0;
  let curB = 0,
    curL = 0,
    curR = 0;

  while (anchorPtr <= anchors.length) {
    const next = anchorPtr < anchors.length ? anchors[anchorPtr] : null;
    const endB = next ? next.b : base.length;
    const endL = next ? next.l : local.length;
    const endR = next ? next.r : remote.length;

    // 区间 [cur, end) 为不稳定块
    const baseChunk = base.slice(curB, endB);
    const localChunk = local.slice(curL, endL);
    const remoteChunk = remote.slice(curR, endR);

    const localChanged =
      !localEqBase(curB, endB, curL, endL) || localChunk.length !== baseChunk.length;
    const remoteChanged =
      !remoteEqBase(curB, endB, curR, endR) || remoteChunk.length !== baseChunk.length;

    if (!localChanged && !remoteChanged) {
      out.push(...baseChunk);
    } else if (localChanged && !remoteChanged) {
      out.push(...localChunk);
    } else if (!localChanged && remoteChanged) {
      out.push(...remoteChunk);
    } else {
      // 双方都修改：比较 local 区间与 remote 区间是否改成了一致内容
      const sameLR = (() => {
        if (localChunk.length !== remoteChunk.length) return false;
        for (let i = 0; i < localChunk.length; i++)
          if (localChunk[i] !== remoteChunk[i]) return false;
        return true;
      })();
      if (sameLR) {
        out.push(...localChunk); // 改成了相同内容
      } else {
        hasConflict = true;
        out.push(`<<<<<<< LOCAL (${localLabel})`);
        out.push(...localChunk);
        out.push('=======');
        out.push(...remoteChunk);
        out.push(`>>>>>>> REMOTE (${remoteLabel})`);
      }
    }

    if (next) {
      out.push(base[next.b]); // 稳定锚行
      curB = next.b + 1;
      curL = next.l + 1;
      curR = next.r + 1;
      anchorPtr++;
    } else {
      break;
    }
  }

  return { merged: out.join('\n'), hasConflict };
}

/** 无 base 时的两方联合合并：非重叠变更合并保留，同位差异加冲突标记 */
export function unionMerge(
  localText: string,
  remoteText: string,
  localLabel = 'LOCAL',
  remoteLabel = 'REMOTE',
): MergeResult {
  return fallbackMerge(localText, remoteText, localLabel, remoteLabel);
}

function fallbackMerge(
  localText: string,
  remoteText: string,
  localLabel: string,
  remoteLabel: string,
): MergeResult {
  if (localText === remoteText) return { merged: localText, hasConflict: false };
  if (localText === '') return { merged: remoteText, hasConflict: false };
  if (remoteText === '') return { merged: localText, hasConflict: false };

  const local = toLines(localText);
  const remote = toLines(remoteText);
  const [la, ra] = encodeLinesShared(local, remote);
  const matches = lcsMatches(la, ra);

  if (!matches) {
    // 过大：直接整体标记冲突
    return {
      merged: [
        `<<<<<<< LOCAL (${localLabel})`,
        ...local,
        '=======',
        ...remote,
        `>>>>>>> REMOTE (${remoteLabel})`,
      ].join('\n'),
      hasConflict: true,
    };
  }

  const out: string[] = [];
  let hasConflict = false;
  let li = 0,
    ri = 0,
    mi = 0;
  while (mi < matches.length || li < local.length || ri < remote.length) {
    const m = mi < matches.length ? matches[mi] : null;
    if (m) {
      const localChunk = local.slice(li, m.aIdx);
      const remoteChunk = remote.slice(ri, m.bIdx);
      if (localChunk.length === 0 && remoteChunk.length === 0) {
        // 无差异
      } else if (localChunk.length === 0) {
        out.push(...remoteChunk); // 远程新增
      } else if (remoteChunk.length === 0) {
        out.push(...localChunk); // 本地新增
      } else {
        const same =
          localChunk.length === remoteChunk.length &&
          localChunk.every((l, i) => l === remoteChunk[i]);
        if (same) {
          out.push(...localChunk);
        } else {
          // 同一位置双方都有不同内容 → 冲突标记（保留双方）
          hasConflict = true;
          out.push(`<<<<<<< LOCAL (${localLabel})`);
          out.push(...localChunk);
          out.push('=======');
          out.push(...remoteChunk);
          out.push(`>>>>>>> REMOTE (${remoteLabel})`);
        }
      }
      out.push(local[m.aIdx]); // 公共行
      li = m.aIdx + 1;
      ri = m.bIdx + 1;
      mi++;
    } else {
      // 尾部块
      const localChunk = local.slice(li);
      const remoteChunk = remote.slice(ri);
      const same =
        localChunk.length === remoteChunk.length &&
        localChunk.every((l, i) => l === remoteChunk[i]);
      if (same) {
        out.push(...localChunk);
      } else if (localChunk.length === 0) {
        out.push(...remoteChunk);
      } else if (remoteChunk.length === 0) {
        out.push(...localChunk);
      } else {
        hasConflict = true;
        out.push(`<<<<<<< LOCAL (${localLabel})`);
        out.push(...localChunk);
        out.push('=======');
        out.push(...remoteChunk);
        out.push(`>>>>>>> REMOTE (${remoteLabel})`);
      }
      break;
    }
  }
  return { merged: out.join('\n'), hasConflict };
}
