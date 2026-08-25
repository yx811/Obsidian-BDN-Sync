// 设备码授权弹窗：二维码 + 授权码 + 倒计时 + 轮询（对齐参考实现 startBaiduDeviceAuth）
// 用户填 AppKey/SecretKey 后点击「设备码授权」打开本弹窗，扫码或手动输入码完成授权，
// 授权成功后 access_token/refresh_token 自动写入设置。

import { App, Modal, Notice } from 'obsidian';
import type BDNSyncPlugin from '../main';
import type { DeviceAuthInfo } from '../baidu/api';
import { setIcon } from './components';

export class DeviceAuthModal extends Modal {
  private closed = false;
  private countdownTimer?: number;
  private pollTimer?: number;
  private info!: DeviceAuthInfo;
  private expireAt = 0;

  constructor(
    app: App,
    private plugin: BDNSyncPlugin,
  ) {
    super(app);
    this.modalEl.addClass('bdnsync-modal', 'bdnsync-device-auth-modal');
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    const shell = contentEl.createDiv({ cls: 'bdnsync-modal-shell' });
    const head = shell.createDiv({ cls: 'bdnsync-modal-head' });
    head.createEl('h3', { text: '百度网盘 · 设备码授权', cls: 'bdnsync-modal-title' });
    const body = shell.createDiv({ cls: 'bdnsync-modal-body' });
    this.shellEl = shell;
    this.bodyEl = body;

    // 启动设备码
    let info: DeviceAuthInfo;
    try {
      info = await this.plugin.startDeviceAuth();
    } catch (e) {
      body.createEl('p', {
        text: `启动设备码授权失败：${e instanceof Error ? e.message : String(e)}`,
        cls: 'bdnsync-auth-error',
      });
      return;
    }
    if (this.closed) return;
    this.info = info;
    this.expireAt = Date.now() + (info.expiresInSec || 300) * 1000;
    this.renderBody();
    this.startCountdown();
    this.startPolling();
  }

  private shellEl!: HTMLElement;
  private bodyEl!: HTMLElement;

  private renderBody(): void {
    const { bodyEl } = this;
    bodyEl.empty();

    // tab 切换
    const tabs = this.bodyEl.createDiv({ cls: 'bdnsync-auth-tabs' });
    const tabQr = tabs.createDiv({
      cls: 'bdnsync-auth-tab bdnsync-auth-tab-active',
      text: '扫码授权',
    });
    const tabCode = tabs.createDiv({ cls: 'bdnsync-auth-tab', text: '手动输入码' });
    const panels = this.bodyEl.createDiv({ cls: 'bdnsync-auth-panels' });
    const qrPanel = panels.createDiv({ cls: 'bdnsync-auth-panel bdnsync-auth-panel-qr' });
    const codePanel = panels.createDiv({ cls: 'bdnsync-auth-panel bdnsync-auth-panel-code' });
    codePanel.style.display = 'none';

    const switchTab = (which: 'qr' | 'code') => {
      const isQr = which === 'qr';
      tabQr.classList.toggle('bdnsync-auth-tab-active', isQr);
      tabCode.classList.toggle('bdnsync-auth-tab-active', !isQr);
      qrPanel.style.display = isQr ? '' : 'none';
      codePanel.style.display = isQr ? 'none' : '';
    };
    tabQr.addEventListener('click', () => switchTab('qr'));
    tabCode.addEventListener('click', () => switchTab('code'));

    // ---- 扫码面板 ----
    qrPanel.createDiv({
      cls: 'bdnsync-auth-intro',
      text: '方式一：打开手机百度网盘 App，扫描下方二维码完成授权（无需输入）',
    });
    const qrBox = qrPanel.createDiv({ cls: 'bdnsync-qr-box' });
    const qrImg = qrBox.createEl('img', {
      cls: 'bdnsync-qr-img',
      attr: { alt: '授权二维码', draggable: 'false' },
    });
    let qrFallbackTried = false;
    const fallbackQrUrl = () => {
      const v = this.info.verificationUrl;
      const u = v.includes('?')
        ? `${v}&code=${encodeURIComponent(this.info.userCode)}`
        : `${v}?code=${encodeURIComponent(this.info.userCode)}`;
      return `https://api.qrserver.com/v1/create-qr-code/?size=240x240&margin=8&data=${encodeURIComponent(u)}`;
    };
    const setQr = () => {
      if (this.info.qrcodeUrl) qrImg.src = this.info.qrcodeUrl;
      else qrImg.src = fallbackQrUrl();
    };
    qrImg.addEventListener('error', () => {
      if (!qrFallbackTried) {
        qrFallbackTried = true;
        qrImg.src = fallbackQrUrl();
      } else {
        qrBox.empty();
        const fail = qrBox.createDiv({ cls: 'bdnsync-qr-fail' });
        fail.createDiv({ cls: 'bdnsync-qr-fail-icon', text: '⚠' });
        fail.createDiv({ cls: 'bdnsync-qr-fail-text', text: '二维码图片暂时无法加载' });
        fail
          .createEl('button', {
            cls: 'bdnsync-btn bdnsync-btn-primary bdnsync-btn-sm',
            text: '改用「手动输入授权码」',
          })
          .addEventListener('click', () => switchTab('code'));
      }
    });
    setQr();

    const countdownRow = qrPanel.createDiv({ cls: 'bdnsync-countdown-row' });
    countdownRow.createSpan({ cls: 'bdnsync-countdown-label', text: '二维码有效期：' });
    const qrCountdown = countdownRow.createSpan({ cls: 'bdnsync-countdown-value', text: '' });
    this._qrCountdownEl = qrCountdown;

    qrPanel.createDiv({ cls: 'bdnsync-auth-divider', text: '或' });
    qrPanel.createDiv({
      cls: 'bdnsync-auth-intro',
      text: '扫码不方便？可使用手机浏览器打开下方链接，输入授权码完成确认：',
    });
    this.buildLinkRow(qrPanel, this.info.verificationUrl, this.info.userCode);

    // ---- 手动码面板 ----
    codePanel.createDiv({
      cls: 'bdnsync-auth-intro',
      text: '方式二：在浏览器中打开下方授权页面，输入授权码并点击「连接」即可授权。',
    });
    this.buildLinkRow(codePanel, this.info.verificationUrl, this.info.userCode);
    const codeWrap = codePanel.createDiv({ cls: 'bdnsync-user-code-wrap' });
    codeWrap.createDiv({ cls: 'bdnsync-user-code-label', text: '授权码（点击复制）' });
    const codeBlock = codeWrap.createDiv({
      cls: 'bdnsync-code-block bdnsync-user-code',
      text: this.info.userCode || '(空)',
      attr: { title: '点击复制' },
    });
    codeBlock.style.cursor = 'pointer';
    codeBlock.addEventListener('click', async () => {
      if (!this.info.userCode) return;
      try {
        await navigator.clipboard.writeText(this.info.userCode);
        const prev = codeBlock.textContent;
        codeBlock.textContent = '已复制';
        window.setTimeout(() => {
          codeBlock.textContent = prev;
        }, 1500);
      } catch {
        const range = document.createRange();
        range.selectNodeContents(codeBlock);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
        new Notice('已选中授权码，请按 Ctrl+C 复制');
      }
    });
    const codeCountdownRow = codePanel.createDiv({ cls: 'bdnsync-countdown-row' });
    codeCountdownRow.createSpan({ cls: 'bdnsync-countdown-label', text: '授权码有效期：' });
    const codeCountdown = codeCountdownRow.createSpan({ cls: 'bdnsync-countdown-value', text: '' });
    this._codeCountdownEl = codeCountdown;

    // ---- 配置引导 ----
    const tip = this.bodyEl.createDiv({ cls: 'bdnsync-tip-block' });
    tip.createEl('strong', { text: '首次使用前请在百度开放平台确认以下配置：' });
    const list = tip.createEl('ol');
    for (const item of [
      '「应用详情」→「接口权限」：已勾选「网盘基础服务」/「网盘登录」',
      '「安全设置」→「OAuth 授权回调页」：已添加 http://localhost/callback（https 也可），保存后等待 5–10 分钟生效',
      '使用的是「AppKey」（不是 AppID），且应用状态为「已上线」而非「开发中」',
    ]) {
      list.createEl('li', { text: item });
    }

    // ---- 状态行 ----
    this._statusEl = this.bodyEl.createDiv({
      cls: 'bdnsync-device-status',
      text: '等待您完成授权确认…',
    });
  }

  private _qrCountdownEl?: HTMLElement;
  private _codeCountdownEl?: HTMLElement;
  private _statusEl?: HTMLElement;

  private buildLinkRow(container: HTMLElement, verificationUrl: string, userCode: string): void {
    const row = container.createDiv({ cls: 'bdnsync-auth-link-row' });
    row
      .createDiv({ cls: 'bdnsync-auth-link-box' })
      .createEl('a', {
        cls: 'bdnsync-auth-link',
        text: verificationUrl,
        href: '#',
        attr: { title: '点击在新窗口打开授权页' },
      })
      .addEventListener('click', (ev) => {
        ev.preventDefault();
        const u = verificationUrl.includes('?')
          ? `${verificationUrl}&code=${encodeURIComponent(userCode)}`
          : `${verificationUrl}?code=${encodeURIComponent(userCode)}`;
        window.open(u, '_blank', 'noopener,noreferrer');
      });
    const actions = row.createDiv({ cls: 'bdnsync-auth-link-actions' });
    const copyBtn = actions.createEl('button', {
      cls: 'bdnsync-btn bdnsync-btn-sm',
      text: '复制链接',
    });
    copyBtn.addEventListener('click', async () => {
      const u = verificationUrl.includes('?')
        ? `${verificationUrl}&code=${encodeURIComponent(userCode)}`
        : `${verificationUrl}?code=${encodeURIComponent(userCode)}`;
      try {
        await navigator.clipboard.writeText(u);
        const prev = copyBtn.textContent;
        copyBtn.textContent = '已复制';
        window.setTimeout(() => {
          copyBtn.textContent = prev;
        }, 1500);
      } catch {
        new Notice('复制失败，请手动选中并复制链接');
      }
    });
    const openBtn = actions.createEl('button', {
      cls: 'bdnsync-btn bdnsync-btn-sm bdnsync-btn-primary',
    });
    setIcon(openBtn, 'chevron-right', 14);
    openBtn.createSpan({ text: ' 打开授权页' });
    openBtn.addEventListener('click', () => {
      const u = verificationUrl.includes('?')
        ? `${verificationUrl}&code=${encodeURIComponent(userCode)}`
        : `${verificationUrl}?code=${encodeURIComponent(userCode)}`;
      window.open(u, '_blank', 'noopener,noreferrer');
    });
  }

  private fmt(ms: number): string {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 60)}分${String(s % 60).padStart(2, '0')}秒`;
  }

  private startCountdown(): void {
    const tick = () => {
      if (this.closed) return;
      const left = this.expireAt - Date.now();
      const txt = left > 0 ? this.fmt(left) : '已过期';
      if (this._qrCountdownEl) this._qrCountdownEl.textContent = txt;
      if (this._codeCountdownEl) this._codeCountdownEl.textContent = txt;
      if (left <= 0) {
        window.clearInterval(this.countdownTimer);
        if (this._statusEl)
          this._statusEl.setText(
            '授权码已过期，请关闭弹窗后重新点击「设备码授权」获取新的二维码 / 授权码。',
          );
      }
    };
    tick();
    this.countdownTimer = window.setInterval(tick, 1000);
  }

  private startPolling(): void {
    // 固定每 5 秒获取一次授权状态（用户要求）；每次轮询都实时刷新状态显示。
    const interval = 5000;
    const poll = async () => {
      if (this.closed) return;
      if (Date.now() > this.expireAt) {
        window.clearInterval(this.pollTimer);
        window.clearInterval(this.countdownTimer);
        if (this._statusEl)
          this._statusEl.setText(
            '授权码已过期，请关闭弹窗后重新点击「设备码授权」获取新的二维码 / 授权码。',
          );
        return;
      }
      // 实时刷新：每次轮询开始时即显示「正在检测」，让授权状态可见地随轮询更新
      if (this._statusEl) this._statusEl.setText('正在检测授权状态…');
      try {
        const ok = await this.plugin.pollDeviceAuth();
        if (this.closed) return;
        if (ok) {
          window.clearInterval(this.pollTimer);
          window.clearInterval(this.countdownTimer);
          if (this._statusEl)
            this._statusEl.setText('授权成功！Access Token 已自动保存到配置。即将关闭…');
          new Notice('百度网盘授权成功');
          await this.plugin.saveSettings();
          // 授权成功后拉起本地流式代理，使预览 Modal 可免落盘在线打开/播放。
          // 流式代理启动失败不阻断授权流程，但需捕获并明确上报，避免静默 swallow。
          try {
            await this.plugin.ensureStreamServer();
          } catch (se) {
            const msg = se instanceof Error ? se.message : String(se);
            console.warn(`[BDNSync] 授权成功但本地流式代理启动失败：${msg}`);
            new Notice(
              '百度网盘授权成功，但本地流式预览代理启动失败（预览将回退为下载模式）',
              6000,
            );
          }
          window.setTimeout(() => this.close(), 1200);
        } else if (this._statusEl) {
          const left = this.expireAt - Date.now();
          this._statusEl.setText(
            left > 0
              ? `等待您在手机/浏览器上确认授权…（剩余 ${this.fmt(left)} · 每 5 秒检测）`
              : '已过期，请重新获取授权码',
          );
        }
      } catch (e) {
        window.clearInterval(this.pollTimer);
        window.clearInterval(this.countdownTimer);
        const msg = e instanceof Error ? e.message : String(e);
        if (this._statusEl) this._statusEl.setText(`授权失败：${msg}`);
        new Notice(`百度网盘授权失败：${msg}`, 8000);
      }
    };
    window.setTimeout(() => {
      void poll();
    }, 1500);
    this.pollTimer = window.setInterval(() => {
      if (!this.closed && Date.now() <= this.expireAt) void poll();
    }, interval);
  }

  onClose(): void {
    this.closed = true;
    window.clearInterval(this.countdownTimer);
    window.clearInterval(this.pollTimer);
    this.contentEl.empty();
  }
}
