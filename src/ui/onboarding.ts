// BDNSync 首次启用引导
//
// 设计取舍：连接凭证的采集统一由 BaiduConnectionModal 负责（它已正确实现
// Cookie 与 OpenAPI 设备码授权两条路径）。本文件只做「欢迎 + 能力说明 + 入口」，
// 不再重复实现一套表单，避免两处实现漂移——历史上这里曾停留在「手填
// access_token」的旧流程，与设备码授权重构后的实际流程矛盾，用户走到底是死路。

import { Notice } from 'obsidian';
import { createCard, createIconButton, setIcon, type IconName } from './components';
import type BDNSyncPlugin from '../main';
import { BaiduConnectionModal } from './connection-modal';

interface OnboardingCallbacks {
  testConnection: () => Promise<{
    ok: boolean;
    message: string;
    quotaUsed?: number;
    quotaTotal?: number;
    user?: string;
  }>;
  saveSettings: () => Promise<void>;
  /** 连接完成后请求宿主重绘设置页 */
  refresh?: () => void;
}

interface CapabilityRow {
  icon: IconName;
  title: string;
  desc: string;
}

const CAPABILITIES: CapabilityRow[] = [
  {
    icon: 'refresh-cw',
    title: '双向增量同步',
    desc: '本地 / 云端 / 上次同步三方对比，只传变化的文件',
  },
  { icon: 'git-merge', title: '智能冲突合并', desc: 'Markdown 三方合并，二进制自动分叉保留双方' },
  { icon: 'shield', title: '端到端加密', desc: 'AES-256-GCM 本地加密后再上传，密码不出本机' },
  { icon: 'zap', title: '秒传与断点续传', desc: '命中云端已有文件秒完成，大文件中断可续' },
];

export function renderOnboarding(
  container: HTMLElement,
  plugin: BDNSyncPlugin,
  callbacks: OnboardingCallbacks,
): void {
  const card = createCard(container, 'bdnsync-onboarding-card');

  // ---- 头部 ----
  const header = card.createDiv({ cls: 'bdnsync-onboarding-header' });
  const iconWrap = header.createSpan({ cls: 'bdnsync-onboarding-icon' });
  setIcon(iconWrap, 'cloud', 32);
  const headText = header.createDiv();
  headText.createEl('h3', { text: '把这个库同步到百度网盘' });
  headText.createEl('p', {
    cls: 'bdnsync-onboarding-desc',
    text: '连接账号后即可跨设备访问，凭证与加密密码仅保存在本机。',
  });

  // ---- 能力速览 ----
  const grid = card.createDiv({ cls: 'bdnsync-cap-grid' });
  for (const cap of CAPABILITIES) {
    const item = grid.createDiv({ cls: 'bdnsync-cap-item' });
    const ci = item.createSpan({ cls: 'bdnsync-cap-icon' });
    setIcon(ci, cap.icon, 18);
    const txt = item.createDiv({ cls: 'bdnsync-cap-text' });
    txt.createDiv({ text: cap.title, cls: 'bdnsync-cap-title' });
    txt.createDiv({ text: cap.desc, cls: 'bdnsync-cap-desc' });
  }

  // ---- 连接方式说明 ----
  // 必须讲清楚 Cookie 模式不能上传：百度 precreate 接口要求开放平台 access_token，
  // Cookie 只能下载/列表/删除。把它当「推荐」会让用户配好之后同步必然失败。
  const note = card.createDiv({ cls: 'bdnsync-callout bdnsync-callout-info' });
  note.createEl('strong', { text: '关于连接方式：' });
  const ul = note.createEl('ul', { cls: 'bdnsync-callout-list' });
  ul.createEl('li', {
    text: 'OpenAPI 设备码授权（推荐）：填入 AppKey / SecretKey 后扫码授权，支持完整的双向同步、上传与秒传。',
  });
  ul.createEl('li', {
    text: 'Cookies 直连：配置最快，但百度上传接口要求开放平台 Token，因此该模式只能下载 / 浏览 / 删除，无法上传，不能完成双向同步。',
  });

  // ---- 主行动区 ----
  const actions = card.createDiv({ cls: 'bdnsync-onboarding-actions' });
  createIconButton(actions, {
    icon: 'cloud',
    label: '连接百度网盘',
    primary: true,
    onClick: () => {
      new BaiduConnectionModal(plugin.app, plugin, () => {
        // 连接弹窗保存成功后回来重绘设置页，让用户直接看到完整设置项
        callbacks.refresh?.();
      }).open();
    },
  });

  const resultEl = actions.createDiv({ cls: 'bdnsync-onboarding-result' });
  resultEl.setText('尚未连接');

  createIconButton(actions, {
    icon: 'refresh-cw',
    label: '测试当前凭证',
    onClick: async () => {
      if (!plugin.hasAuth()) {
        new Notice('BDNSync：请先完成连接');
        return;
      }
      resultEl.removeClass('success', 'error');
      resultEl.setText('测试中…');
      const r = await callbacks.testConnection();
      if (r.ok) {
        resultEl.addClass('success');
        resultEl.setText(`连接成功${r.user ? `（${r.user}）` : ''}`);
      } else {
        resultEl.addClass('error');
        resultEl.setText(`连接失败：${r.message}`);
      }
    },
  });

  // ---- 帮助链接 ----
  const help = card.createDiv({ cls: 'bdnsync-onboarding-help' });
  help.createSpan({ text: '需要 AppKey？前往 ' });
  const link = help.createEl('a', { text: '百度网盘开放平台', href: '#' });
  link.addEventListener('click', (ev) => {
    ev.preventDefault();
    window.open('https://pan.baidu.com/union/main/app', '_blank', 'noopener,noreferrer');
  });
  help.createSpan({ text: ' 创建应用，开通「网盘基础服务」权限后即可获取。' });
}
