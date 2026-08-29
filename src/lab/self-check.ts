/**
 * 实验室 · 功能自检（Self-Check）
 *
 * 对插件自身的基础能力做一次性体检：配置合法性、授权、网络/API 可达性、
 * 同步引擎、日志系统、失败重试队列、文件监听、本地存储、端到端加密。
 *
 * 设计为「纯逻辑 + 无副作用」：只读取宿主暴露的能力并产出结构化报告，
 * 便于在设置页「立即运行自检」、命令面板与单元测试中复用。
 * 实际触发 / 落日志 / 弹面板由 main.ts 负责。
 */

import type { BDNSyncSettings } from '../types';
import type { BaiduApi } from '../baidu/api';
import type { Logger } from '../util/logger';
import type { SyncEngine } from '../sync/engine';
import type { FileWatcher } from '../watcher/file-watcher';
import type { RetryQueue } from '../sync/retry-queue';
import type { LocalStore } from '../storage/local-store';
import type { BaiduAdapter } from '../baidu/adapter';
import { probeHealth } from './api-probe';

export type CheckLevel = 'info' | 'warn' | 'error';

export interface SelfCheckItem {
  id: string;
  name: string;
  ok: boolean;
  /** 不通过时的严重程度：error=致命，warn=可降级，info=正常 */
  level: CheckLevel;
  detail: string;
}

export interface SelfCheckReport {
  at: number;
  items: SelfCheckItem[];
  passed: number;
  failed: number;
  warnings: number;
  /** 无 error 级失败即为健康（warn 不阻断） */
  healthy: boolean;
  summary: string;
}

/** 自检宿主：由 main.ts 在调用时组装，避免本模块反向依赖插件类（杜绝循环引用） */
export interface SelfCheckHost {
  settings: BDNSyncSettings;
  hasAuth: () => boolean;
  makeApi: () => BaiduApi;
  logger: Logger;
  isEngineBusy: () => boolean;
  engine: SyncEngine | null;
  watcher: FileWatcher | null;
  retryQueue: RetryQueue | null;
  store: LocalStore | null;
  cloudAdapter: BaiduAdapter | null;
}

const VALID_MODES = new Set(['manual', 'auto', 'realtime']);

/**
 * 运行一次完整自检。
 * 任何单项检查抛错都不影响其余项（逐项 try 隔离），整体始终返回结构化报告。
 */
export async function runSelfCheck(host: SelfCheckHost): Promise<SelfCheckReport> {
  const items: SelfCheckItem[] = [];
  const add = (
    id: string,
    name: string,
    ok: boolean,
    level: CheckLevel,
    detail: string,
  ): void => {
    items.push({ id, name, ok, level, detail });
  };

  const s = host.settings;

  // 1) 基础配置合法性
  const cfgProblems: string[] = [];
  if (!s.deviceName) cfgProblems.push('设备名未设置');
  if (!s.remoteRoot) cfgProblems.push('远程同步目录未设置');
  else if (!s.remoteRoot.startsWith('/') || s.remoteRoot.split('/').includes('..'))
    cfgProblems.push('远程同步目录非法（须以 / 开头且不含 ..）');
  if (!VALID_MODES.has(s.syncMode)) cfgProblems.push('同步模式非法');
  if (!(s.autoSyncInterval >= 1 && s.autoSyncInterval <= 720))
    cfgProblems.push('自动同步间隔越界（应为 1–720 分钟）');
  add(
    'config',
    '基础配置',
    cfgProblems.length === 0,
    cfgProblems.length ? 'error' : 'info',
    cfgProblems.length ? cfgProblems.join('；') : '设备名 / 远程目录 / 同步模式 / 间隔均有效',
  );

  // 2) 授权 / 凭据
  const authed = host.hasAuth();
  if (!authed) {
    add('auth', '百度网盘授权', false, 'error', '未配置连接（Cookie / OpenAPI 凭证缺失）');
  } else {
    const mode = s.cookies || s.bduss ? 'Cookie' : 'OpenAPI';
    add('auth', '百度网盘授权', true, 'info', `已配置（${mode} 模式）`);
  }

  // 3) 网络 / API 可达性（复用 API 容灾探测）
  if (!authed) {
    add('network', '网络 / API 可达', false, 'warn', '未授权，跳过 API 探测');
  } else {
    try {
      const api = host.makeApi();
      const root = s.remoteRoot || '/';
      const r = await probeHealth(api, root);
      if (r.ok) add('network', '网络 / API 可达', true, 'info', r.message);
      else
        add(
          'network',
          '网络 / API 可达',
          false,
          r.diagnose?.category === 'auth' ? 'error' : 'warn',
          r.message,
        );
    } catch (e) {
      add(
        'network',
        '网络 / API 可达',
        false,
        'warn',
        `探测异常：${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // 4) 同步引擎
  if (!host.engine) add('engine', '同步引擎', false, 'error', '引擎未初始化');
  else
    add(
      'engine',
      '同步引擎',
      true,
      'info',
      host.isEngineBusy() ? '已初始化（当前正忙）' : '已初始化（空闲）',
    );

  // 5) 日志系统
  try {
    const c = host.logger.levelCounts();
    const total = c.debug + c.info + c.warn + c.error;
    add('logger', '日志系统', true, 'info', `记录正常（当前样本 ${total} 条）`);
  } catch (e) {
    add('logger', '日志系统', false, 'error', `日志器异常：${e instanceof Error ? e.message : String(e)}`);
  }

  // 6) 失败重试队列
  if (!host.retryQueue) {
    add('retry', '失败重试队列', false, 'warn', '重试队列未初始化');
  } else {
    try {
      const n = host.retryQueue.toState().items.length;
      add('retry', '失败重试队列', true, 'info', `就绪（待重试 ${n} 项）`);
    } catch (e) {
      add('retry', '失败重试队列', false, 'warn', `状态读取异常：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 7) 文件监听
  if (!host.watcher) add('watcher', '文件监听', false, 'warn', '文件监听器未初始化');
  else add('watcher', '文件监听', true, 'info', `就绪（风暴阈值 ${host.watcher.stormThreshold}）`);

  // 8) 本地存储
  if (!host.store) add('store', '本地存储', false, 'warn', '本地存储未初始化');
  else add('store', '本地存储', true, 'info', '就绪');

  // 9) 云端后端适配器
  if (!host.cloudAdapter) add('backend', '云端后端', false, 'warn', '云端适配器未初始化');
  else add('backend', '云端后端', true, 'info', '就绪');

  // 10) 端到端加密
  if (s.encryptionEnabled) {
    if (s.encryptionPassword || s.keyFilePath)
      add('crypto', '端到端加密', true, 'info', '已启用且已配置密码 / 密钥文件');
    else add('crypto', '端到端加密', false, 'error', '已开启加密但未配置密码 / 密钥文件');
  } else {
    add('crypto', '端到端加密', true, 'info', '未启用（明文同步）');
  }

  const failed = items.filter((i) => !i.ok && i.level === 'error').length;
  const warnings = items.filter((i) => !i.ok && i.level === 'warn').length;
  const passed = items.filter((i) => i.ok).length;
  const healthy = failed === 0;
  const summary = healthy
    ? `自检通过：${passed} 项正常${warnings ? `，${warnings} 项警告` : ''}`
    : `自检发现问题：${failed} 项错误，${warnings} 项警告`;
  return { at: Date.now(), items, passed, failed, warnings, healthy, summary };
}
