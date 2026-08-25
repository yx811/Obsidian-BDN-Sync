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
