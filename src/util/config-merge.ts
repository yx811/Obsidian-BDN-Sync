// .obsidian 配置类文件的「结构化字段级合并」纯函数。
//
// 背景：配置同步若整文件覆盖，多设备不同配置会互相覆盖（如 A 改了 cssTheme、
// B 改了 lastOpenFiles → 后同步者覆盖前者的修改）。本模块按「配置文件类型」
// 提供白名单字段级合并 / 插件启用列表并集 / 整文件 LWW 三类策略。
//
// 设计约束（安全优先）：
//   - 只合并「语义安全」的白名单字段，绝不盲目递归深度合并（深度合并对
//     workspace 布局序列化这类结构会造成灾难性破坏）；
//   - 非白名单字段一律 LWW（最后写入获胜），但保留被覆盖前版本到 base 池可回滚；
//   - 合并失败（JSON 解析失败）一律拒绝合并，交由调用方走「保留双方/回滚」。

export type ConfigKind =
  | 'workspace'
  | 'app'
  | 'community-plugins'
  | 'plugin-config'
  | 'other';

/** 判断 .obsidian 下配置文件类型（非 .obsidian 路径返回 null） */
export function classifyConfigPath(path: string): ConfigKind | null {
  if (!path.startsWith('.obsidian/')) return null;
  const rest = path.slice('.obsidian/'.length);
  if (rest === 'workspace.json') return 'workspace';
  if (rest === 'app.json') return 'app';
  if (rest === 'community-plugins.json') return 'community-plugins';
  if (rest.startsWith('plugins/') && rest.endsWith('/data.json')) return 'plugin-config';
  if (rest.endsWith('.json')) return 'other';
  return null; // 非 JSON 配置（如 core-plugins 之外的 assets）不归本模块
}

/**
 * 字段级合并白名单（每类配置允许「按字段合并」的顶层 key）。
 * 白名单外的字段一律整字段 LWW。
 */
const FIELD_WHITELIST: Record<string, string[]> = {
  workspace: ['lastOpenFiles', 'lastOpenFilesBefore'],
  app: ['appearance', 'editor', 'files'],
};

/** JSON 安全解析：非对象/数组的顶层、解析失败均返回 null */
export function parseJsonSafe(text: string): unknown | null {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

export interface ConfigMergeResult {
  merged: string | null; // null = 无法合并（解析失败），调用方应走保留双方
  hasConflict: boolean;
  /** 发生字段级冲突（两端同字段不同值）的顶层 key 列表 */
  conflictFields: string[];
  /** 采用的策略：field-merge / plugin-union / lww */
  strategy: 'field-merge' | 'plugin-union' | 'lww';
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** 一层对象合并：以 newer 为基底，把 older 中「基底没有的 key」并入；同 key 双方都有且不等 → 标冲突（值取 newer） */
function mergeObjectLayer(
  older: Record<string, unknown>,
  newer: Record<string, unknown>,
  conflictFields: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...newer };
  for (const k of Object.keys(older)) {
    if (k in out) {
      const a = older[k];
      const b = out[k];
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        conflictFields.push(k);
        // LWW：保留 newer 侧值；冲突仅标记，不改变取值
      }
    } else {
      out[k] = older[k];
    }
  }
  return out;
}

/** 字符串数组并集（保持顺序：newer 在前，older 中新增的追加在后） */
function unionArrays(newer: string[], older: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const it of [...newer, ...older]) {
    if (!seen.has(it)) {
      seen.add(it);
      out.push(it);
    }
  }
  return out;
}

/** 字段级合并：白名单字段做一层合并，其余字段 LWW（取较新 mtime 侧） */
function fieldMerge(
  localObj: Record<string, unknown>,
  remoteObj: Record<string, unknown>,
  localNewer: boolean,
  whitelist: string[],
): { merged: Record<string, unknown>; conflictFields: string[] } {
  const conflictFields: string[] = [];
  const newer = localNewer ? localObj : remoteObj;
  const older = localNewer ? remoteObj : localObj;
  const out: Record<string, unknown> = {};
  // 先处理白名单字段（字段级合并）
  for (const k of whitelist) {
    const a = older[k];
    const b = newer[k];
    if (a === undefined && b === undefined) continue;
    if (a === undefined) {
      out[k] = b;
    } else if (b === undefined) {
      out[k] = a;
    } else if (isPlainObject(a) && isPlainObject(b)) {
      out[k] = mergeObjectLayer(a, b, conflictFields);
    } else if (Array.isArray(a) && Array.isArray(b)) {
      // 数组字段（如 lastOpenFiles）语义为「状态快照」→ LWW 取较新侧；并集仅用于 community-plugins（已单独处理）
      if (JSON.stringify(a) !== JSON.stringify(b)) conflictFields.push(k);
      out[k] = b;
    } else {
      if (JSON.stringify(a) !== JSON.stringify(b)) conflictFields.push(k);
      out[k] = b; // LWW
    }
  }
  // 其余字段整字段 LWW（取较新侧；若较旧侧有而较新侧没有，则并入）
  for (const k of Object.keys(newer)) {
    if (!(k in out)) out[k] = newer[k];
  }
  for (const k of Object.keys(older)) {
    if (!(k in out)) out[k] = older[k];
  }
  return { merged: out, conflictFields };
}

/**
 * 配置文本合并入口。
 * @param localText 本地（设备 A）配置内容
 * @param remoteText 远端（设备 B）配置内容
 * @param localNewer 本地 mtime 是否更新（决定 LWW 基底）
 */
export function mergeConfigTexts(
  kind: ConfigKind,
  localText: string,
  remoteText: string,
  localNewer: boolean,
): ConfigMergeResult {
  if (localText === remoteText) {
    return { merged: localText, hasConflict: false, conflictFields: [], strategy: 'lww' };
  }
  const localObj = parseJsonSafe(localText);
  const remoteObj = parseJsonSafe(remoteText);

  if (kind === 'community-plugins') {
    // 插件启用列表：并集合并（各设备启用的插件都保留）
    if (Array.isArray(localObj) && Array.isArray(remoteObj)) {
      const list = unionArrays(
        (localObj as unknown[]).filter((x): x is string => typeof x === 'string'),
        (remoteObj as unknown[]).filter((x): x is string => typeof x === 'string'),
      );
      // 同一插件「一端启用、另一端显式移除」时无法从并集感知 → 不标冲突，仅并集；
      // 语义上「启用」是幂等的，并集不会造成破坏。
      // 审计 #11：并集若与较新侧（LWW 基底）语义一致，直接返回较新侧原文，
      // 避免 JSON.stringify 重排缩进造成格式抖动（下次同步 hash 变化 → 反复合并）。
      const newerArr = localNewer ? localObj : remoteObj;
      if (JSON.stringify(list) === JSON.stringify(newerArr)) {
        return {
          merged: localNewer ? localText : remoteText,
          hasConflict: false,
          conflictFields: [],
          strategy: 'plugin-union',
        };
      }
      return {
        merged: JSON.stringify(list, null, 2),
        hasConflict: false,
        conflictFields: [],
        strategy: 'plugin-union',
      };
    }
    return { merged: null, hasConflict: true, conflictFields: ['*'], strategy: 'plugin-union' };
  }

  if (!localObj || !remoteObj) {
    // 任一端解析失败：拒绝合并（防破坏），调用方走「保留双方/回滚」
    return { merged: null, hasConflict: true, conflictFields: ['*'], strategy: 'lww' };
  }

  const whitelist = FIELD_WHITELIST[kind] ?? [];
  if (whitelist.length === 0) {
    // 无白名单（plugin-config / other）：整文件 LWW，取较新侧
    const merged = localNewer ? localText : remoteText;
    return {
      merged,
      hasConflict: false,
      conflictFields: [],
      strategy: 'lww',
    };
  }

  const { merged, conflictFields } = fieldMerge(
    localObj as Record<string, unknown>,
    remoteObj as Record<string, unknown>,
    localNewer,
    whitelist,
  );
  // 审计 #11：无字段冲突且合并结果与较新侧（LWW 基底）语义一致时，返回较新侧原文，
  // 避免重排缩进导致格式抖动（下次同步 hash 变化 → 反复合并）。
  const newerObj = localNewer ? localObj : remoteObj;
  if (conflictFields.length === 0 && JSON.stringify(merged) === JSON.stringify(newerObj)) {
    return {
      merged: localNewer ? localText : remoteText,
      hasConflict: false,
      conflictFields: [],
      strategy: 'field-merge',
    };
  }
  return {
    merged: JSON.stringify(merged, null, 2),
    hasConflict: conflictFields.length > 0,
    conflictFields,
    strategy: 'field-merge',
  };
}

// ---------------- Markdown Frontmatter 结构化合并（#4.8 插件生态集成） ----------------
//
// 仅做「顶层 key 级」合并，绝不递归深度合并嵌套对象（YAML 嵌套语义复杂，深度合并
// 极易破坏用户手写 frontmatter）。非标量/列表块统一按整块 LWW。合并失败（解析异常）
// 返回 null，交由调用方走「保留双方 / 回滚」。

export interface FrontmatterMergeResult {
  /** 合并后的完整文档（含 body）。null = 无法合并 */
  merged: string | null;
  hasConflict: boolean;
  conflictKeys: string[];
}

/** 解析 YAML frontmatter：返回 { fm: 行数组（已去缩进块归属）, body }；无 frontmatter 返回 null */
function parseFrontmatter(text: string): { lines: string[]; body: string } | null {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return null;
  const fmBlock = m[1];
  const body = text.slice(m[0].length);
  // 按顶层 key（行首非空白 `key:` 或 `key: value`）拆分块；缩进行归属上一个顶层 key
  const lines = fmBlock.split(/\r?\n/).filter((l) => l.trim().length > 0);
  return { lines, body };
}

/** 把 frontmatter 行数组解析成 顶层key → 整块文本（含其下缩进子行） 的映射，保留顺序 */
function fmToBlocks(lines: string[]): { order: string[]; blocks: Map<string, string> } {
  const order: string[] = [];
  const blocks = new Map<string, string>();
  let curKey: string | null = null;
  let curLines: string[] = [];
  const flush = () => {
    if (curKey !== null) {
      if (!blocks.has(curKey)) order.push(curKey);
      blocks.set(curKey, curLines.join('\n'));
    }
  };
  for (const line of lines) {
    const topMatch = line.match(/^([A-Za-z0-9_][\w-]*):(?:\s+(.*))?$/);
    if (topMatch && !/^\s/.test(line)) {
      flush();
      curKey = topMatch[1];
      curLines = [line];
    } else if (curKey !== null) {
      curLines.push(line);
    }
  }
  flush();
  return { order, blocks };
}

/**
 * 合并两版 Markdown 的 frontmatter（字段级）。
 * @param localText 本地版完整文档
 * @param remoteText 远程版完整文档
 * @param localNewer 是否以本地为「较新」基底（用于 LWW 取值）
 */
export function mergeFrontmatter(
  localText: string,
  remoteText: string,
  localNewer: boolean,
): FrontmatterMergeResult {
  const lp = parseFrontmatter(localText);
  const rp = parseFrontmatter(remoteText);
  // 仅一端（或两端都）无 frontmatter：无法做字段级合并，返回 null 交由 conflict-resolver
  // 回落整文件 diff3/联合合并（与「仅一端有 frontmatter 或解析失败时回落到下方 diff3」一致）。
  if (!lp || !rp) {
    return { merged: null, hasConflict: false, conflictKeys: [] };
  }
  const local = fmToBlocks(lp.lines);
  const remote = fmToBlocks(rp.lines);
  const conflictKeys: string[] = [];
  const outOrder: string[] = [];
  const outBlocks = new Map<string, string>();
  const allKeys = Array.from(new Set([...local.order, ...remote.order]));
  for (const key of allKeys) {
    const l = local.blocks.get(key);
    const r = remote.blocks.get(key);
    if (l && !r) {
      outOrder.push(key);
      outBlocks.set(key, l);
    } else if (!l && r) {
      outOrder.push(key);
      outBlocks.set(key, r);
    } else if (l && r) {
      if (l === r) {
        outOrder.push(key);
        outBlocks.set(key, l);
      } else {
        // 同 key 不同值：标冲突，LWW 取值（localNewer 取本地，否则取远程）
        conflictKeys.push(key);
        outOrder.push(key);
        outBlocks.set(key, localNewer ? l : r);
      }
    }
  }
  const fmText = outOrder.map((k) => outBlocks.get(k)).join('\n');
  const body = (localNewer ? lp : rp).body;
  const merged = `---\n${fmText}\n---\n${body}`;
  return { merged, hasConflict: conflictKeys.length > 0, conflictKeys };
}

// ---------------- Canvas / Excalidraw 节点级三方合并（#4.8） ----------------
//
// .canvas 是 { nodes:[{id,...}], edges:[{id,...}] } 的 JSON；.excalidraw 是
// { type, version, elements:[{id,...}], files:{}, appState:{} }。两者语义都是
// 「带 id 的元素集合」，适合做按 id 的结构化三方合并（而非整文件文本 diff3）。
// 合并策略：
//   - 每个参与合并的数组字段（canvas: nodes/edges；excalidraw: elements）按 id 对齐；
//   - 某 id 仅一端改 → 取该端；两端都改且相同 → 取任一；两端都改不同 → 按 LWW 取较新端并标冲突；
//   - 某端删除、另一端保留 → 保留；两端都删 → 丢弃；
//   - 顶层非数组字段（version/appState/files 等）整字段 LWW（取较新端），不标冲突。
// 任一端非合法 JSON → merged:null，交由 conflict-resolver 走分叉兜底。

export type CanvasKind = 'canvas' | 'excalidraw';

/** 判断路径是否为可节点级合并的画布文件 */
export function classifyCanvasPath(path: string): CanvasKind | null {
  const lower = path.toLowerCase();
  if (lower.endsWith('.canvas')) return 'canvas';
  if (lower.endsWith('.excalidraw')) return 'excalidraw';
  return null;
}

/** 数组字段（按 id 参与三方合并） */
const CANVAS_ARRAY_FIELDS: Record<CanvasKind, string[]> = {
  canvas: ['nodes', 'edges'],
  excalidraw: ['elements'],
};

/** 递归排序对象键，产生稳定字符串用于「内容是否相同」比较（规避 JSON key 顺序差异） */
function stableStringify(v: unknown): string {
  if (v === undefined) return 'undefined';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

export interface CanvasMergeResult {
  /** null = 无法合并（解析失败），调用方应走保留双方/回滚 */
  merged: string | null;
  hasConflict: boolean;
  /** 发生冲突（两端同 id 不同）的元素 id 列表 */
  conflictIds: string[];
}

/**
 * 画布三方合并。
 * @param localText 本地版（设备 A）
 * @param remoteText 远程版（设备 B）
 * @param baseText 上次同步快照（base 缺失时为 null → 调用方应走分叉兜底）
 * @param localNewer 本地是否为「较新」基底（LWW 取值）
 */
export function mergeCanvasTexts(
  kind: CanvasKind,
  localText: string,
  remoteText: string,
  baseText: string | null,
  localNewer: boolean,
): CanvasMergeResult {
  const local = parseJsonSafe(localText);
  const remote = parseJsonSafe(remoteText);
  const base = baseText ? parseJsonSafe(baseText) : null;
  if (!isPlainObject(local) || !isPlainObject(remote) || !isPlainObject(base)) {
    return { merged: null, hasConflict: false, conflictIds: [] };
  }
  const conflictIds: string[] = [];
  const newer = (localNewer ? local : remote) as Record<string, unknown>;
  const older = (localNewer ? remote : local) as Record<string, unknown>;
  const baseRec = base as Record<string, unknown>;

  // 顶层非数组字段：整字段 LWW（取较新端；若较新端没有而较旧端有则并入）
  const out: Record<string, unknown> = {};
  const allTopKeys = Array.from(new Set([...Object.keys(newer), ...Object.keys(older)]));
  for (const k of allTopKeys) {
    if (CANVAS_ARRAY_FIELDS[kind].includes(k)) continue; // 数组字段单独处理
    if (k in newer) out[k] = newer[k];
    else if (k in older) out[k] = older[k];
  }

  // 数组字段逐 id 三方合并
  for (const field of CANVAS_ARRAY_FIELDS[kind]) {
    const baseArr = Array.isArray(baseRec[field]) ? (baseRec[field] as unknown[]) : [];
    const localArr = Array.isArray(local[field as keyof typeof local])
      ? (local[field as keyof typeof local] as unknown[])
      : [];
    const remoteArr = Array.isArray(remote[field as keyof typeof remote])
      ? (remote[field as keyof typeof remote] as unknown[])
      : [];
    const toMap = (arr: unknown[]) => {
      const m = new Map<string, Record<string, unknown>>();
      for (const it of arr) {
        const rec = it as Record<string, unknown>;
        const id = rec?.id;
        if (typeof id === 'string' || typeof id === 'number') m.set(String(id), rec);
      }
      return m;
    };
    const baseMap = toMap(baseArr);
    const localMap = toMap(localArr);
    const remoteMap = toMap(remoteArr);
    // 保持顺序：base → local 新增 → remote 新增
    const ordered = Array.from(
      new Set([
        ...baseMap.keys(),
        ...[...localMap.keys()].filter((id) => !baseMap.has(id)),
        ...[...remoteMap.keys()].filter((id) => !baseMap.has(id) && !localMap.has(id)),
      ]),
    );
    const result: Record<string, unknown>[] = [];
    for (const id of ordered) {
      const b = baseMap.get(id);
      const l = localMap.get(id);
      const r = remoteMap.get(id);
      const eq = (a: unknown, c: unknown) => stableStringify(a) === stableStringify(c);
      if (b && l && r) {
        if (eq(l, r)) result.push(l);
        else if (eq(l, b)) result.push(r); // 仅远端改
        else if (eq(r, b)) result.push(l); // 仅本地改
        else {
          result.push(localNewer ? l : r);
          conflictIds.push(id);
        }
      } else if (!b && l && r) {
        if (eq(l, r)) result.push(l);
        else {
          result.push(localNewer ? l : r);
          conflictIds.push(id);
        }
      } else if (b && l && !r) result.push(l); // 远端删、本地留
      else if (b && !l && r) result.push(r); // 本地删、远端留
      else if (!b && l && !r) result.push(l); // 仅本地建
      else if (!b && !l && r) result.push(r); // 仅远端建
      // 两端都删 → 丢弃
    }
    out[field] = result;
  }

  return { merged: JSON.stringify(out, null, 2), hasConflict: conflictIds.length > 0, conflictIds };
}

