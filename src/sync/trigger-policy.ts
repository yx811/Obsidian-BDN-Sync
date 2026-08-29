// 同步触发边界条件 —— 单一事实来源（single source of truth）
//
// 此前「是否自动触发同步」的判断散落在 onLayoutReady / tickScheduler / onlineHandler /
// runQuickSync / onLocalChange 等多处，且各自复读 `syncMode === 'manual'`、重复表达
// `auto || realtime`，极易在不同入口产生语义漂移（例如曾经 auto 与 realtime 都触发了
// 「保存即同步」，二者边界名存实亡）。
// 这里把三种同步模式在四个触发点上的边界条件收敛成一个纯函数，所有入口统一查表，
// 既便于审计，也便于单测锁定矩阵。
//
// ┌──────────────┬───────────┬──────────┬───────────┐
// │  触发点       │  manual   │  auto    │ realtime  │
// ├──────────────┼───────────┼──────────┼───────────┤
// │ startup      │ 仅当      │   是     │   是      │
// │ (启动/重载/   │ syncOn    │          │           │
// │  插件启用)    │ Startup   │          │           │
// │ periodic     │   否      │   是     │   是      │
// │ (autoSync    │           │          │           │
// │  Interval)   │           │          │           │
// │ saveImmediate│   否      │   否     │ syncOnSave│
// │ (保存即同步) │           │          │           │
// │ online       │   否      │   是     │   是      │
// │ (网络恢复)   │           │          │           │
// └──────────────┴───────────┴──────────┴───────────┘
//
// 说明：
// - manual：完全由用户手动触发；若用户额外开启 syncOnStartup，则只在启动时跑一次完整同步，
//   之后不会再自动同步（符合「手动」语义）。
// - auto：仅按 autoSyncInterval 周期对账 + 启动/网络恢复兜底；保存文件时**不**立即同步，
//   变更由下一个周期的全量扫描覆盖（避免每次保存都打一次网盘）。
// - realtime：在 auto 全部能力之上，额外对「保存」立即触发增量同步（保存即同步）。
//   若用户把 realtime 的 syncOnSave 关掉，则退化为与 auto 相同的纯周期行为。

import type { SyncMode } from '../types';

export interface SyncTriggerPolicy {
  /** 启动 / 重载 / 插件启用时是否自动跑一次完整同步 */
  startup: boolean;
  /** 周期调度（autoSyncInterval）是否启用：auto / realtime 模式 */
  periodic: boolean;
  /** 保存文件时是否立即触发增量同步：仅 realtime 且 syncOnSave 开启 */
  saveImmediate: boolean;
  /** 网络恢复时是否自动补同步：auto / realtime 模式 */
  online: boolean;
}

export interface SyncTriggerInput {
  syncMode: SyncMode;
  syncOnSave: boolean;
  syncOnStartup: boolean;
  hasAuth: boolean;
}

/**
 * 由当前设置 + 鉴权状态解析同步触发边界条件。
 * 纯函数、无副作用，便于单测锁定上面那张矩阵。
 */
export function resolveSyncTriggers(input: SyncTriggerInput): SyncTriggerPolicy {
  const autoClass = input.syncMode === 'auto' || input.syncMode === 'realtime';
  return {
    startup: input.hasAuth && (input.syncMode !== 'manual' || input.syncOnStartup),
    periodic: autoClass,
    saveImmediate: input.syncMode === 'realtime' && input.syncOnSave,
    online: autoClass,
  };
}
