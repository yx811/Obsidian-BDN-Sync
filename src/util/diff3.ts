// 行级三方合并（diff3）与两方联合合并实现
// - threeWayMerge: 有 base（上次同步内容）时的标准 diff3 行级合并
// - unionMerge: 无 base 时的联合合并（双方新增均保留，同一位置的差异加冲突标记）

export interface MergeResult {
  merged: string;
  hasConflict: boolean; // 是否包含冲突标记（需用户手动处理）
}

/** 冲突块：合并结果中一处 `<<<<<<< ======= >>>>>>>` 区间的精确定位与两端内容 */
export interface ConflictSection {
  /** 冲突块在合并后文本中的行区间 [blockStart, blockEnd)（含标记行，替换/采纳时用） */
  blockStart: number;
  blockEnd: number;
  /** 扩展到段边界（空行/标题/分隔线）的展示区间 [contextStart, contextEnd)，仅供展示上下文 */
  contextStart: number;
  contextEnd: number;
  /** 本地端（设备 A）冲突行 */
  local: string[];
  /** 远端（设备 B）冲突行 */
  remote: string[];
}

export interface SectionMergeResult extends MergeResult {
  /** 冲突段列表（供面板逐段导航与采纳） */
  conflictSections: ConflictSection[];
}

const MAX_LCS_CELLS = 500_000; // DP 上限（约 2MB Int32Array），防止超大文件内存爆炸/性能劣化。
// 超过此上限时 lcsMatches 返回 null，上层走整体冲突标记降级路径。

function toLines(text: string): string[] {
  // 归一化行尾（CRLF/CR → LF）后再切分：合并始终在 LF 语义上进行，避免把
  // "abc\r" 与 "abc" 判为不同行导致假冲突；最终写回时由 conflict-resolver
  // 按本地原文的行尾还原（审计 #5）。
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
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

// ---------------- 分段合并（section-aware） ----------------

/**
 * Markdown 语义段边界：空行、标题（# 开头）、水平分隔线（--- / *** / ___）。
 * 用于把冲突块扩展到「整段」上下文，便于面板展示与逐段裁决。
 */
function isSectionBoundary(line: string): boolean {
  const t = line.trim();
  if (t === '') return true;
  if (/^#{1,6}\s/.test(line)) return true;
  if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) return true;
  return false;
}

function escapeRegExpChar(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 从合并结果文本中提取所有冲突块。
 * 兼容 threeWayMerge / unionMerge 的标记格式：`<<<<<<< <label> / ======= / >>>>>>> <label>`。
 * 每个块记录精确行区间（替换用）+ 扩展到段边界的展示区间（上下文用）。
 */
export function extractConflictSections(
  mergedText: string,
  localLabel: string,
  remoteLabel: string,
): ConflictSection[] {
  const lines = mergedText.split('\n');
  // CRLF 容忍（审计 #5）：合并结果可能被恢复为 CRLF，比较时统一去掉行尾 \r
  const clean = (s: string): string => (s.endsWith('\r') ? s.slice(0, -1) : s);
  // 精确匹配（审计 #8）：open/close 必须是「标记前缀 + 标签」的整行格式，
  // 不再用宽松的 `.*标签` 通配，避免正文中的 `<<<<<<<`/`>>>>>>>` 行被误认。
  const openRe = new RegExp(`^<<<<<<< LOCAL \\(${escapeRegExpChar(localLabel)}\\)\r?$`);
  const closeRe = new RegExp(`^>>>>>>> REMOTE \\(${escapeRegExpChar(remoteLabel)}\\)\r?$`);
  const sections: ConflictSection[] = [];
  let i = 0;
  while (i < lines.length) {
    if (openRe.test(clean(lines[i]))) {
      const blockStart = i;
      const local: string[] = [];
      let j = i + 1;
      while (j < lines.length && clean(lines[j]) !== '=======') {
        local.push(lines[j]);
        j++;
      }
      const sepIdx = j;
      if (sepIdx >= lines.length) break; // 畸形标记：跳过防死循环
      j++;
      const remote: string[] = [];
      while (j < lines.length && !closeRe.test(clean(lines[j]))) {
        remote.push(lines[j]);
        j++;
      }
      if (j >= lines.length) break;
      const blockEnd = j + 1; // 含 >>>>>>> 行
      // 向前/向后扩展到段边界（留一行上下文避免贴死边界）
      let contextStart = blockStart;
      while (contextStart > 0 && !isSectionBoundary(lines[contextStart - 1])) contextStart--;
      let contextEnd = blockEnd;
      while (contextEnd < lines.length && !isSectionBoundary(lines[contextEnd])) contextEnd++;
      sections.push({ blockStart, blockEnd, contextStart, contextEnd, local, remote });
      i = blockEnd;
    } else {
      i++;
    }
  }
  return sections;
}

/**
 * 分段合并：先在整文件上做行级三方合并（有 base）或联合合并（无 base），
 * 再把冲突块映射为「段」信息供面板逐段裁决。
 * 与直接 threeWayMerge 的差异：
 *   - 返回 conflictSections（块精确定位 + 段上下文），支撑逐段采纳 UI；
 *   - 冲突块内 local/remote 内容结构化，无需用户自行解析标记文本。
 */
export function sectionMerge(
  baseText: string | null,
  localText: string,
  remoteText: string,
  localLabel = 'LOCAL',
  remoteLabel = 'REMOTE',
): SectionMergeResult {
  const base: MergeResult =
    baseText !== null
      ? threeWayMerge(baseText, localText, remoteText, localLabel, remoteLabel)
      : unionMerge(localText, remoteText, localLabel, remoteLabel);
  if (!base.hasConflict) {
    return { merged: base.merged, hasConflict: false, conflictSections: [] };
  }
  const conflictSections = extractConflictSections(base.merged, localLabel, remoteLabel);
  return { ...base, conflictSections };
}
