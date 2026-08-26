/**
 * API 容灾 / 轻量探查（#2.1 API 稳定性与容灾机制）
 *
 * 提供「无副作用」的健康探测：调用 listDir + getQuota 两个轻量端点，判断当前认证模式
 * 是否仍可用，并在失败时给出中文诊断 + 降级建议（如「切到 Cookie 模式」）。
 *
 * 调度（每日一次、移动端 best-effort）由 main.ts 负责；本模块只做「探测 + 诊断」纯逻辑，
 * 便于单元测试与按需手动触发。
 */

import { BaiduApi } from '../baidu/api';
import { diagnoseError, type Diagnosis } from '../util/error-dict';

export interface ProbeResult {
  ok: boolean;
  at: number;
  /** 配额信息（探测成功时存在） */
  quota?: { total: number; used: number; free: number };
  /** 列表端点是否可达（目录树权限正常） */
  listOk: boolean;
  /** 失败时的中文诊断 */
  diagnose?: Diagnosis;
  /** 人类可读结论 */
  message: string;
}

/**
 * 执行一次健康探测。
 * @param api 已认证的 BaiduApi
 * @param root 远程根目录（用于 listDir 探测目录树权限）
 */
export async function probeHealth(api: BaiduApi, root: string): Promise<ProbeResult> {
  const at = Date.now();
  const res: ProbeResult = { ok: false, at, listOk: false, message: '' };

  try {
    const q = await api.getQuota();
    res.quota = { total: q.total, used: q.used, free: Math.max(0, q.total - q.used) };
  } catch (e) {
    const d = diagnoseError(e);
    res.diagnose = d;
    res.message = `配额探测失败：${d.zh}；${d.hint}`;
  }

  try {
    await api.listDir(root || '/');
    res.listOk = true;
  } catch (e) {
    const d = diagnoseError(e);
    res.diagnose = res.diagnose ?? d;
    res.message =
      (res.message ? res.message + '；' : '') +
      `列表探测失败：${d.zh}（${d.hint}）`;
  }

  res.ok = !!res.quota && res.listOk;
  if (!res.message) {
    res.message = res.ok ? 'API 健康：配额与列表探测均正常' : 'API 探测异常';
  }
  return res;
}

/**
 * 由探测结果给出「是否应降级」及建议文案。
 * 当 OpenAPI 模式且鉴权类失败时，建议切换 Cookie 模式。
 */
export function probeDegradationAdvice(
  res: ProbeResult,
  currentMode: 'cookies' | 'openapi',
): { degrade: boolean; advice: string } {
  if (res.ok) return { degrade: false, advice: '' };
  const authFailed = res.diagnose?.category === 'auth';
  if (authFailed && currentMode === 'openapi') {
    return {
      degrade: true,
      advice: 'OpenAPI 鉴权失败，建议切到 Cookie 模式（设置页「认证模式」）后重试上传。',
    };
  }
  if (authFailed && currentMode === 'cookies') {
    return {
      degrade: true,
      advice: 'Cookie 模式鉴权失败，请检查 BDUSS/STOKEN 是否过期；OpenAPI 模式可重新设备码授权。',
    };
  }
  return { degrade: false, advice: res.message };
}
