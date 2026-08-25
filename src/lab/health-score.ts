/**
 * 实验室功能 4：同步健康分 / 风险雷达
 *
 * 把每次同步的 SyncResult 聚合成一个 0-100 的「健康分」，并对异常维度（冲突数、删除数、
 * 错误数、超大传输）给出可读的风险原因。主程序在 syncNow 完成后调用 evaluateSyncHealth，
 * 分数低于阈值时通过 Notice 主动预警，把「被动翻日志」升级为「主动感知」。
 *
 * 设计约束：
 * - computeHealthScore 为纯函数，便于单测，不依赖 plugin / Obsidian；
 * - 任何评估异常均降级为「未知」而非抛错；
 * - 不修改任何同步行为，仅观测与提示。
 */
import { Notice } from 'obsidian';
import type BDNSyncPlugin from '../main';
import type { SyncResult } from '../sync/engine';

export type HealthLevel = 'good' | 'warn' | 'risk' | 'unknown';

export interface HealthReport {
  score: number; // 0-100
  level: HealthLevel;
  reasons: string[];
  ts: number;
}

/** 各风险维度权重（扣分上限） */
const W = {
  conflict: 18, // 每个冲突最多扣 18，几个就触底
  deletedLocal: 10, // 本地被删（可能误删）
  deletedRemote: 6,
  error: 25, // 错误最严重
  oversize: 8, // 超大传输（>50MB 单文件）
};

const OVERSIZE_BYTES = 50 * 1024 * 1024;

/**
 * 纯函数：根据同步结果与当前失败重试队列长度计算健康分。
 * @param result  syncNow 返回的 SyncResult
 * @param retryPending 当前 RetryQueue 中待重试/失败项数量
 */
export function computeHealthScore(result: SyncResult, retryPending = 0): HealthReport {
  const reasons: string[] = [];
  let penalty = 0;

  // 冲突
  if (result.conflicts > 0) {
    const p = Math.min(W.conflict * result.conflicts, 60);
    penalty += p;
    reasons.push(`出现 ${result.conflicts} 个冲突，需人工核对`);
  }
  // 本地删除（风险较高：可能误删）
  if (result.deletedLocal > 0) {
    const p = Math.min(W.deletedLocal * result.deletedLocal, 30);
    penalty += p;
    reasons.push(`本地删除了 ${result.deletedLocal} 个文件`);
  }
  // 远程删除
  if (result.deletedRemote > 0) {
    const p = Math.min(W.deletedRemote * result.deletedRemote, 20);
    penalty += p;
    reasons.push(`云端删除了 ${result.deletedRemote} 个文件`);
  }
  // 错误
  if (result.errors > 0) {
    const p = Math.min(W.error * result.errors, 70);
    penalty += p;
    reasons.push(`同步失败 ${result.errors} 项`);
  }
  // 超大传输
  const big = Math.max(result.bytesUp, result.bytesDown);
  if (big > OVERSIZE_BYTES) {
    penalty += W.oversize;
    reasons.push(`存在超大文件传输（${(big / 1024 / 1024).toFixed(0)}MB）`);
  }
  // 重试队列堆积
  if (retryPending > 0) {
    penalty += Math.min(retryPending * 3, 20);
    reasons.push(`${retryPending} 个文件处于重试队列`);
  }

  if (result.cancelled) {
    return { score: 100, level: 'good', reasons: ['同步已取消，未产生变更'], ts: Date.now() };
  }

  const score = Math.max(0, Math.min(100, 100 - penalty));
  let level: HealthLevel = 'good';
  if (score < 50) level = 'risk';
  else if (score < 80) level = 'warn';
  if (reasons.length === 0) reasons.push('同步健康，无异常');

  return { score, level, reasons, ts: Date.now() };
}

/**
 * 在同步完成后调用：计算分数，低于阈值时发 Notice 预警。
 * 同时把最近一次报告写入 LocalStore 供设置页/状态栏读取。
 */
export async function evaluateSyncHealth(
  plugin: BDNSyncPlugin,
  result: SyncResult,
): Promise<HealthReport> {
  let report: HealthReport;
  try {
    const pending = plugin.retryQueue?.size ?? 0;
    report = computeHealthScore(result, pending);
  } catch {
    return { score: 0, level: 'unknown', reasons: ['健康分计算失败'], ts: Date.now() };
  }

  // 持久化最近报告
  try {
    await plugin.store.writeJson('lab-health-last.json', report);
  } catch {
    /* ignore */
  }

  const threshold = plugin.settings.labHealthWarnThreshold ?? 80;
  if (report.level !== 'good' && report.score < threshold) {
    const head = report.level === 'risk' ? '⚠️ 同步风险' : '⚠️ 同步提醒';
    const detail = report.reasons.slice(0, 3).join('；');
    new Notice(`${head}（健康分 ${report.score}）：${detail}`, 8000);
  }
  return report;
}

/** 读取最近一次健康报告（供状态栏/设置页展示） */
export async function getLastHealthReport(plugin: BDNSyncPlugin): Promise<HealthReport | null> {
  try {
    return await plugin.store.readJson<HealthReport>('lab-health-last.json');
  } catch {
    return null;
  }
}

/** 等级 -> 中文标签 */
export function levelLabel(level: HealthLevel): string {
  switch (level) {
    case 'good':
      return '健康';
    case 'warn':
      return '注意';
    case 'risk':
      return '风险';
    default:
      return '未知';
  }
}
