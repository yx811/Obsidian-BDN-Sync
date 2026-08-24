// 状态栏：统一状态按钮 + 快速操作浮层 + 冲突角标

import type { App } from 'obsidian';
import { createProgressBar, createBadge, setIcon, showPopover, type IconName } from './components';
import { formatBytes } from '../util/misc';

export type StatusState =
  'idle' | 'syncing' | 'uploading' | 'downloading' | 'done' | 'error' | 'offline';

interface QuickAction {
  id: string;
  icon: IconName;
  label: string;
  badge?: number;
  onClick: () => void;
}

export class StatusBar {
  private el: HTMLElement | null = null;
  private iconEl: HTMLElement | null = null;
  private textEl: HTMLElement | null = null;
  private dotEl: HTMLElement | null = null;
  private conflictBadge: HTMLElement | null = null;
  private revertTimer: number | null = null;
  private conflictCount = 0;
  private state: StatusState = 'idle';
  private tooltip = 'BDNSync：点击打开快速操作';

  constructor(
    private app: App,
    private onSyncClick: () => void,
    private onConflictClick: () => void,
    private onStatsClick: () => void,
    private onBrowseClick: () => void,
    private onSettingsClick: () => void,
    private onVersionClick: () => void,
    private onUsageClick: () => void,
    private onSnapshotClick: () => void,
    private getStatusSummary: () => {
      lastSyncAt: number;
      lastSummary: string;
      quotaUsed: number;
      quotaTotal: number;
    },
  ) {}

  mount(container: HTMLElement): void {
    this.el = container.createEl('button', { cls: 'bdnsync-status' });
    this.el.setAttribute('aria-label', this.tooltip);
    this.iconEl = this.el.createSpan({ cls: 'bdnsync-status-icon' });
    this.textEl = this.el.createSpan({ cls: 'bdnsync-status-text' });
    this.dotEl = this.el.createSpan({ cls: 'bdnsync-status-dot' });
    this.conflictBadge = this.el.createSpan({ cls: 'bdnsync-status-conflict-badge' });
    this.conflictBadge.style.display = 'none';

    this.el.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.openQuickActions();
    });

    this.setIdle();
  }

  unmount(): void {
    this.el?.remove();
    this.el = null;
  }

  private setAria(tip: string): void {
    this.tooltip = tip;
    this.el?.setAttribute('aria-label', tip);
  }

  private setIconAndState(name: IconName, state: StatusState): void {
    this.state = state;
    if (this.iconEl) setIcon(this.iconEl, name, 16);
    if (this.el) this.el.className = `bdnsync-status bdnsync-status-${state}`;
  }

  private scheduleRevert(ms: number): void {
    if (this.revertTimer) window.clearTimeout(this.revertTimer);
    this.revertTimer = window.setTimeout(() => this.setIdle(), ms);
  }

  setIdle(): void {
    if (this.state === 'syncing' || this.state === 'uploading' || this.state === 'downloading')
      return;
    this.setIconAndState('cloud-check', 'idle');
    if (this.textEl) this.textEl.setText('');
    if (this.dotEl) this.dotEl.className = 'bdnsync-status-dot';
    this.setAria('BDNSync：已同步，点击打开快速操作');
  }

  setSyncing(msg = '同步中…'): void {
    this.setIconAndState('refresh-cw', 'syncing');
    if (this.textEl) this.textEl.setText(msg);
    this.setAria(`BDNSync：${msg}`);
  }

  setUploading(upBytes: number, totalBytes?: number): void {
    this.setIconAndState('arrow-up', 'uploading');
    const progress =
      totalBytes && totalBytes > 0 ? ` ${Math.round((upBytes / totalBytes) * 100)}%` : '';
    if (this.textEl) this.textEl.setText(`上传 ${formatBytes(upBytes)}${progress}`);
    this.setAria(`BDNSync：正在上传 ${formatBytes(upBytes)}`);
  }

  setDownloading(downBytes: number, totalBytes?: number): void {
    this.setIconAndState('arrow-down', 'downloading');
    const progress =
      totalBytes && totalBytes > 0 ? ` ${Math.round((downBytes / totalBytes) * 100)}%` : '';
    if (this.textEl) this.textEl.setText(`下载 ${formatBytes(downBytes)}${progress}`);
    this.setAria(`BDNSync：正在下载 ${formatBytes(downBytes)}`);
  }

  setProgress(down: number, up: number): void {
    if (up > 0 && down === 0) {
      this.setUploading(up);
    } else if (down > 0 && up === 0) {
      this.setDownloading(down);
    } else if (up > 0 && down > 0) {
      this.setIconAndState('refresh-cw', 'syncing');
      if (this.textEl) this.textEl.setText(`↑${formatBytes(up)} ↓${formatBytes(down)}`);
      this.setAria(`BDNSync：上传 ${formatBytes(up)} / 下载 ${formatBytes(down)}`);
    }
  }

  setDone(summary: string): void {
    this.setIconAndState('cloud-check', 'done');
    if (this.textEl) this.textEl.setText('已同步');
    this.setAria(`BDNSync：同步完成（${summary}）`);
    this.scheduleRevert(5000);
  }

  setError(msg: string): void {
    this.setIconAndState('cloud-alert', 'error');
    if (this.textEl) this.textEl.setText('同步失败');
    this.setAria(`BDNSync：${msg}，点击重试`);
  }

  setOffline(): void {
    this.setIconAndState('cloud-off', 'offline');
    if (this.textEl) this.textEl.setText('离线');
    this.setAria('BDNSync：当前离线，恢复网络后自动同步');
  }

  setConflicts(n: number): void {
    this.conflictCount = n;
    if (!this.conflictBadge) return;
    if (n > 0) {
      this.conflictBadge.style.display = '';
      this.conflictBadge.setText(String(n));
      this.setAria(`BDNSync：${n} 个冲突待处理，点击打开快速操作`);
    } else {
      this.conflictBadge.style.display = 'none';
    }
  }

  /** 方案1：展示失败重试队列中待重试的任务数（角标） */
  setRetryCount(n: number): void {
    if (!this.conflictBadge) return;
    if (n > 0) {
      this.conflictBadge.style.display = '';
      this.conflictBadge.setText(String(n));
      this.conflictBadge.setAttribute('title', `${n} 个任务待重试`);
      this.setAria(`BDNSync：${n} 个同步任务待重试`);
    } else if (this.conflictCount === 0) {
      this.conflictBadge.style.display = 'none';
    }
  }

  private openQuickActions(): void {
    if (!this.el) return;
    const summary = this.getStatusSummary();
    const groups: { title: string; actions: QuickAction[] }[] = [
      {
        title: '同步',
        actions: [
          { id: 'sync', icon: 'refresh-cw', label: '立即同步', onClick: () => this.onSyncClick() },
          {
            id: 'conflict',
            icon: 'alert-triangle',
            label: '处理冲突',
            badge: this.conflictCount,
            onClick: () => this.onConflictClick(),
          },
        ],
      },
      {
        title: '浏览与存储',
        actions: [
          { id: 'browse', icon: 'folder', label: '浏览网盘', onClick: () => this.onBrowseClick() },
          { id: 'usage', icon: 'pie-chart', label: '远程占用', onClick: () => this.onUsageClick() },
          {
            id: 'snapshot',
            icon: 'layers',
            label: '整库快照',
            onClick: () => this.onSnapshotClick(),
          },
        ],
      },
      {
        title: '分析与设置',
        actions: [
          {
            id: 'stats',
            icon: 'bar-chart-2',
            label: '同步统计',
            onClick: () => this.onStatsClick(),
          },
          {
            id: 'version',
            icon: 'history',
            label: '版本历史',
            onClick: () => this.onVersionClick(),
          },
          {
            id: 'settings',
            icon: 'settings',
            label: '打开设置',
            onClick: () => this.onSettingsClick(),
          },
        ],
      },
    ];

    showPopover(
      this.app,
      this.el,
      (panel, close) => {
        // 头部：插件名 + 状态摘要
        const head = panel.createDiv({ cls: 'bdnsync-quick-head' });
        const headIcon = head.createSpan({ cls: 'bdnsync-quick-head-icon' });
        setIcon(headIcon, 'cloud', 16);
        head.createSpan({ text: 'BDNSync', cls: 'bdnsync-quick-head-title' });

        // 容量摘要卡
        const quotaCard = panel.createDiv({ cls: 'bdnsync-quick-quota' });
        const quotaText = quotaCard.createDiv({ cls: 'bdnsync-quick-quota-text' });
        const ratio = summary.quotaTotal > 0 ? summary.quotaUsed / summary.quotaTotal : 0;
        quotaText.setText(
          `网盘容量 ${formatBytes(summary.quotaUsed)} / ${formatBytes(summary.quotaTotal)}`,
        );
        createProgressBar(quotaCard).setRatio(ratio);

        // 上次同步
        const last = panel.createDiv({ cls: 'bdnsync-quick-meta' });
        last.setText(
          summary.lastSyncAt
            ? `上次同步：${new Date(summary.lastSyncAt).toLocaleString()}`
            : '尚未同步',
        );

        // 分组操作
        for (const g of groups) {
          const sectionLabel = panel.createDiv({ cls: 'bdnsync-quick-group-label' });
          sectionLabel.setText(g.title);
          const grid = panel.createDiv({ cls: 'bdnsync-popover-grid' });
          for (const a of g.actions) {
            const btn = grid.createEl('button', { cls: 'bdnsync-popover-action' });
            const iconWrap = btn.createSpan({ cls: 'bdnsync-popover-action-icon' });
            setIcon(iconWrap, a.icon, 18);
            if (a.badge && a.badge > 0) {
              createBadge(btn, String(a.badge), 'error').addClass('bdnsync-popover-badge');
            }
            btn.createSpan({ text: a.label, cls: 'bdnsync-popover-action-label' });
            btn.addEventListener('click', () => {
              close();
              a.onClick();
            });
          }
        }
      },
      { width: 248, className: 'bdnsync-quick-actions' },
    );
  }
}
