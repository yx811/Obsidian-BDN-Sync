// 百度网盘连接配置弹窗（参考澜库连接向导，单账号卡片式）

import { App, Modal, Notice, Setting } from 'obsidian';
import type BDNSyncPlugin from '../main';
import type { BDNSyncSettings } from '../types';
import { parseCookieField } from '../baidu/api';
import { formatBytes } from '../util/misc';
import { createCard, createIconButton, setIcon } from './components';
import { DeviceAuthModal } from './device-auth-modal';

export class BaiduConnectionModal extends Modal {
  private s!: BDNSyncSettings;
  private testResultEl: HTMLElement | null = null;
  private shellEl: HTMLElement | null = null;
  private choiceCards: HTMLElement[] = [];

  constructor(
    app: App,
    private plugin: BDNSyncPlugin,
    private onSaved?: () => void,
  ) {
    super(app);
    this.s = plugin.settings;
    this.modalEl.addClass('bdnsync-modal', 'bdnsync-connection-modal');
  }

  onOpen(): void {
    const { contentEl } = this;
    const shell = contentEl.createDiv({ cls: 'bdnsync-modal-shell' });
    const head = shell.createDiv({ cls: 'bdnsync-modal-head' });
    head.createEl('h3', { text: '连接百度网盘', cls: 'bdnsync-modal-title' });
    head.createEl('p', {
      cls: 'bdnsync-modal-subtitle',
      text: '选择连接方式并填写凭证。凭证仅保存在本地设备，不会上传到服务器。',
    });
    const body = shell.createDiv({ cls: 'bdnsync-modal-body' });
    this.shellEl = shell;

    // 方式选择
    const modeGrid = body.createDiv({ cls: 'bdnsync-choice-grid' });
    const modes: {
      key: 'cookies' | 'openapi';
      title: string;
      desc: string;
      icon: Parameters<typeof setIcon>[1];
    }[] = [
      {
        key: 'cookies',
        title: 'Cookies 直连',
        desc: '无需申请应用，从浏览器复制 BDUSS 即可。仅支持下载/列表/删除，不支持上传',
        icon: 'smartphone',
      },
      {
        key: 'openapi',
        title: 'OpenAPI 设备码授权',
        desc: '填 AppKey/SecretKey 扫码授权，长期更稳定，支持完整上传与秒传',
        icon: 'shield',
      },
    ];
    for (const m of modes) {
      const card = createCard(
        modeGrid,
        `bdnsync-choice-card ${this.s.authMode === m.key ? 'bdnsync-choice-card-active' : ''}`,
      );
      card.setAttribute('role', 'button');
      card.setAttribute('tabindex', '0');
      card.setAttribute('data-mode', m.key);
      const iconWrap = card.createDiv({ cls: 'bdnsync-choice-icon' });
      setIcon(iconWrap, m.icon, 24);
      card.createEl('div', { text: m.title, cls: 'bdnsync-choice-title' });
      card.createEl('div', { text: m.desc, cls: 'bdnsync-choice-desc' });
      this.choiceCards.push(card);
      const select = () => {
        this.s.authMode = m.key;
        this.refreshChoiceActive();
        this.renderBody();
      };
      card.addEventListener('click', select);
      card.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          select();
        }
      });
    }

    this.renderBody();
  }

  private refreshChoiceActive(): void {
    for (const c of this.choiceCards) {
      const key = c.getAttribute('data-mode');
      c.classList.toggle('bdnsync-choice-card-active', key === this.s.authMode);
    }
  }

  private renderBody(): void {
    const body = this.shellEl?.querySelector('.bdnsync-modal-body') as HTMLElement | null;
    const container = body ?? this.contentEl;
    const existing = container.querySelector('.bdnsync-connection-body');
    if (existing) existing.remove();
    const form = container.createDiv({ cls: 'bdnsync-connection-body' });

    if (this.s.authMode === 'cookies') {
      this.renderCookieForm(form);
    } else {
      this.renderOpenApiForm(form);
    }

    // 底部测试与保存（独立 foot，不随表单滚动）
    const foot = this.shellEl?.querySelector('.bdnsync-connection-foot') as HTMLElement | null;
    if (foot) foot.remove();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const footer = this.shellEl!.createDiv({ cls: 'bdnsync-modal-foot bdnsync-connection-foot' });
    this.testResultEl = footer.createDiv({ cls: 'bdnsync-onboarding-result' });
    this.testResultEl.setText('填写后点击「测试连接」验证');

    createIconButton(footer, {
      icon: 'refresh-cw',
      label: '测试连接',
      primary: true,
      onClick: () => void this.doTest(),
    });
    createIconButton(footer, {
      icon: 'check',
      label: '保存并完成',
      primary: true,
      onClick: () => void this.doSave(),
    });
  }

  private renderCookieForm(container: HTMLElement): void {
    container.createEl('div', {
      cls: 'bdnsync-callout',
      text: '获取方式：登录 pan.baidu.com → F12 打开开发者工具 → Application/Cookies → 复制 BDUSS（必须）和 STOKEN（推荐）。',
    });

    new Setting(container)
      .setName('BDUSS')
      .setDesc('浏览器 Cookie 中的 BDUSS 值')
      .addText((t) => {
        t.setValue(this.s.bduss);
        t.inputEl.type = 'password';
        t.onChange((v) => {
          this.s.bduss = v.trim();
        });
      });

    new Setting(container)
      .setName('STOKEN')
      .setDesc('同一位置的 STOKEN，部分接口需要')
      .addText((t) => {
        t.setValue(this.s.stoken);
        t.inputEl.type = 'password';
        t.onChange((v) => {
          this.s.stoken = v.trim();
        });
      });

    const cookieWrap = container.createDiv({ cls: 'bdnsync-input-row' });
    cookieWrap.createEl('label', { text: '或粘贴完整 Cookie（自动提取）' });
    const cookieInput = cookieWrap.createEl('textarea', {
      value: this.s.cookies,
      placeholder: 'BAIDUID=...; BDUSS=...; STOKEN=...;',
      cls: 'bdnsync-input bdnsync-textarea',
    });
    cookieInput.rows = 3;
    cookieInput.addEventListener('input', () => {
      this.s.cookies = cookieInput.value.trim();
    });

    const extractRow = container.createDiv({ cls: 'bdnsync-connection-actions-left' });
    createIconButton(extractRow, {
      icon: 'copy',
      label: '从 Cookie 自动提取',
      onClick: () => {
        const bduss = parseCookieField(this.s.cookies, 'BDUSS');
        const stoken = parseCookieField(this.s.cookies, 'STOKEN');
        if (!bduss) {
          new Notice('BDNSync：未在 Cookie 中找到 BDUSS');
          return;
        }
        this.s.bduss = bduss;
        if (stoken) this.s.stoken = stoken;
        new Notice('BDNSync：已提取 BDUSS/STOKEN');
        this.renderBody();
      },
    });
  }

  private renderOpenApiForm(container: HTMLElement): void {
    container.createEl('div', {
      cls: 'bdnsync-callout',
      text: '获取方式：前往 pan.open.baidu.com 创建应用，开通「网盘基础服务」与「网盘登录」权限，在「安全设置」中添加 OAuth 回调页 http://localhost/callback，应用上线后填入 AppKey/SecretKey。',
    });

    new Setting(container)
      .setName('AppKey')
      .setDesc('百度开放平台应用的 AppKey（注意不是 AppID）')
      .addText((t) => {
        t.setValue(this.s.appKey);
        t.onChange((v) => {
          this.s.appKey = v.trim();
        });
      });

    new Setting(container)
      .setName('SecretKey')
      .setDesc('百度开放平台应用的 SecretKey')
      .addText((t) => {
        t.setValue(this.s.secretKey);
        t.inputEl.type = 'password';
        t.onChange((v) => {
          this.s.secretKey = v.trim();
        });
      });

    // 授权状态与设备码授权按钮
    const authRow = container.createDiv({ cls: 'bdnsync-connection-actions-left' });
    const status = authRow.createDiv({ cls: 'bdnsync-auth-state' });
    const authorized = !!this.s.accessToken;
    status.createSpan({
      text: authorized ? '已授权（Token 已保存）' : '未授权',
      cls: authorized
        ? 'bdnsync-badge bdnsync-badge-success'
        : 'bdnsync-badge bdnsync-badge-warning',
    });
    if (this.s.tokenExpiresAt) {
      const exp = Number(this.s.tokenExpiresAt);
      if (exp > Date.now()) {
        status.createSpan({
          text: ` · ${new Date(exp).toLocaleString()} 到期`,
          cls: 'bdnsync-auth-state-extra',
        });
      } else {
        status.createSpan({
          text: ' · 已过期，需重新授权',
          cls: 'bdnsync-auth-state-extra bdnsync-badge-error',
        });
      }
    }

    createIconButton(authRow, {
      icon: 'shield',
      label: '设备码授权',
      primary: true,
      onClick: () => {
        if (!this.s.appKey || !this.s.secretKey) {
          new Notice('请先填写 AppKey 与 SecretKey');
          return;
        }
        // 先保存当前 AppKey/SecretKey，使 live api 持有最新凭证
        void this.plugin.saveSettings().then(() => {
          new DeviceAuthModal(this.app, this.plugin).open();
        });
      },
    });

    const tip = container.createDiv({ cls: 'bdnsync-tip-block' });
    tip.createEl('strong', { text: '说明：' });
    tip.createEl('span', {
      text: 'OpenAPI 模式通过设备码扫码授权获取 access_token，自动刷新续期，无需手动粘贴 Token。首次配置需在开放平台等待 5–10 分钟生效。',
    });
  }

  private async doTest(): Promise<void> {
    if (!this.testResultEl) return;
    this.testResultEl.removeClass('success', 'error');
    this.testResultEl.setText('连接中…');
    const r = await this.plugin.testConnection();
    if (r.ok) {
      this.testResultEl.addClass('success');
      this.testResultEl.setText(
        `连接成功${r.user ? `（${r.user}）` : ''} · 容量 ${formatBytes(r.quota?.used ?? 0)} / ${formatBytes(r.quota?.total ?? 0)}`,
      );
    } else {
      this.testResultEl.addClass('error');
      this.testResultEl.setText(`连接失败：${r.message}`);
    }
  }

  private async doSave(): Promise<void> {
    // 先校验凭证是否真的填了，避免保存一个空配置后自动同步、然后报一堆鉴权错
    if (this.s.authMode === 'cookies') {
      if (!this.s.bduss && !this.s.cookies) {
        new Notice('BDNSync：请先填写 BDUSS 或完整 Cookie');
        return;
      }
    } else if (!this.s.accessToken) {
      new Notice('BDNSync：请先完成「设备码授权」获取 Token');
      return;
    }

    await this.plugin.saveSettings();
    this.plugin.restartScheduler();
    this.onSaved?.();
    this.close();

    if (this.s.authMode === 'cookies') {
      // Cookie 模式无法上传，直接自动同步只会刷一屏 NOT_SUPPORTED，
      // 明确告知而不是让用户自己去猜为什么同步一直失败。
      new Notice(
        'BDNSync：已保存。当前为 Cookies 模式，仅支持下载 / 浏览 / 删除，无法上传。' +
          '若需双向同步，请改用「OpenAPI 设备码授权」。',
        10000,
      );
      return;
    }

    new Notice('BDNSync：连接配置已保存，开始同步');
    void this.plugin.syncNow('manual');
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
