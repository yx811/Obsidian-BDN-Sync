// 弹窗：首次同步引导 / 冲突面板 / 统计面板 / 同步日志 / 确认框

import { App, Modal, Notice } from 'obsidian';
import type {
  ConflictRecord,
  CumulativeStats,
  DeleteStrategy,
  VaultSnapshot,
  SyncPlanPreview,
  ConflictReportEntry,
  SyncLogEntry,
  LogLevel,
  LogFilter,
} from '../types';
import { conflictKindText } from '../sync/conflict-resolver';
import type { LocalStore } from '../storage/local-store';
import { formatBytes, formatTime, runWithConcurrency } from '../util/misc';
import type { QuotaInfo } from '../baidu/api';
import {
  createBadge,
  createCard,
  createIconButton,
  createModalHeader,
  createProgressBar,
  createSection,
  makeResizable,
  setIcon,
  showConfirmModal,
} from './components';

/** 首次同步保护：本地与云端均有文件时让用户选择合并方向 */
export class FirstSyncModal extends Modal {
  private resolveP: ((choice: 'merge' | 'cloud' | 'local' | 'cancel') => void) | null = null;

  constructor(
    app: App,
    private localCount: number,
    private remoteCount: number,
  ) {
    super(app);
    this.modalEl.addClass('bdnsync-modal');
  }

  open(): Promise<'merge' | 'cloud' | 'local' | 'cancel'> {
    super.open();
    return new Promise((resolve) => {
      this.resolveP = resolve;
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    const shell = contentEl.createDiv({ cls: 'bdnsync-modal-shell' });
    createModalHeader(shell, {
      title: '首次同步',
      icon: 'cloud',
      subtitle: `检测到本地已有 ${this.localCount} 个文件，云端已有 ${this.remoteCount} 个文件。请选择同步方式：`,
    });
    const body = shell.createDiv({ cls: 'bdnsync-modal-body' });

    const done = (c: 'merge' | 'cloud' | 'local' | 'cancel') => {
      this.resolveP?.(c);
      this.resolveP = null;
      this.close();
    };

    const grid = body.createDiv({ cls: 'bdnsync-choice-grid' });

    const choices: {
      key: 'merge' | 'cloud' | 'local';
      title: string;
      desc: string;
      icon: Parameters<typeof setIcon>[1];
      primary: boolean;
    }[] = [
      {
        key: 'merge',
        title: '智能合并（推荐）',
        desc: '双向对比：本地新文件上传，云端新文件下载，文本冲突自动合并',
        icon: 'git-merge',
        primary: true,
      },
      {
        key: 'cloud',
        title: '用云端覆盖本地',
        desc: '以云端为准，本地多余文件将被删除（未同步的修改会丢失）',
        icon: 'cloud',
        primary: false,
      },
      {
        key: 'local',
        title: '用本地覆盖云端',
        desc: '以本地为准，云端多余文件将被删除',
        icon: 'hard-drive',
        primary: false,
      },
    ];

    for (const c of choices) {
      const card = createCard(grid, 'bdnsync-choice-card');
      card.setAttribute('role', 'button');
      card.setAttribute('tabindex', '0');
      const iconWrap = card.createDiv({ cls: 'bdnsync-choice-icon' });
      setIcon(iconWrap, c.icon, 24);
      card.createEl('div', { text: c.title, cls: 'bdnsync-choice-title' });
      card.createEl('div', { text: c.desc, cls: 'bdnsync-choice-desc' });
      card.addEventListener('click', () => done(c.key));
      card.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          done(c.key);
        }
      });
      if (c.primary) card.addClass('bdnsync-choice-card-primary');
    }

    const foot = shell.createDiv({ cls: 'bdnsync-modal-foot' });
    foot
      .createEl('button', {
        text: '取消本次同步',
        cls: 'bdnsync-btn',
      })
      .addEventListener('click', () => done('cancel'));
  }

  onClose(): void {
    this.resolveP?.('cancel');
    this.resolveP = null;
    this.contentEl.empty();
  }
}

/**
 * 大规模删除保护：在执行「疑似整边清空」的删除前强制确认。
 * 触发场景：远程根目录被移动/改名、凭据换成了别的账号、库文件尚未落盘等。
 */
export class MassDeleteGuardModal extends Modal {
  private resolveP: ((choice: 'proceed' | 'skip-deletes' | 'cancel') => void) | null = null;

  constructor(
    app: App,
    private info: {
      deleteLocal: number;
      deleteRemote: number;
      localTotal: number;
      remoteTotal: number;
      samples: string[];
      reason: string;
    },
  ) {
    super(app);
    this.modalEl.addClass('bdnsync-modal', 'bdnsync-guard-modal');
  }

  open(): Promise<'proceed' | 'skip-deletes' | 'cancel'> {
    super.open();
    return new Promise((resolve) => {
      this.resolveP = resolve;
    });
  }

  onOpen(): void {
    const { contentEl, info } = this;
    const shell = contentEl.createDiv({ cls: 'bdnsync-modal-shell' });
    createModalHeader(shell, {
      title: '检测到大量删除操作',
      icon: 'alert-triangle',
      danger: true,
    });
    const body = shell.createDiv({ cls: 'bdnsync-modal-body' });
    body.createEl('p', { text: info.reason, cls: 'bdnsync-guard-reason' });

    const card = createCard(body, 'bdnsync-guard-card');
    const row = (k: string, v: string) => {
      const r = card.createDiv({ cls: 'bdnsync-stats-info-row' });
      r.createEl('span', { text: k, cls: 'bdnsync-stats-info-key' });
      r.createEl('span', { text: v, cls: 'bdnsync-stats-info-value' });
    };
    row('计划删除本地', `${info.deleteLocal} 个（本地共 ${info.localTotal} 个）`);
    row('计划删除云端', `${info.deleteRemote} 个（云端共 ${info.remoteTotal} 个）`);

    if (info.samples.length) {
      const list = body.createDiv({ cls: 'bdnsync-guard-samples' });
      list.createEl('div', { text: '受影响文件（部分）：', cls: 'bdnsync-guard-samples-title' });
      for (const p of info.samples) list.createEl('div', { text: p, cls: 'bdnsync-guard-sample' });
    }

    body.createEl('p', {
      cls: 'bdnsync-modal-subtitle',
      text: '若你并未在其他设备上批量删除文件，请选择「跳过删除」，先检查远程根目录与账号设置。',
    });

    const done = (c: 'proceed' | 'skip-deletes' | 'cancel') => {
      this.resolveP?.(c);
      this.resolveP = null;
      this.close();
    };

    const footer = shell.createDiv({ cls: 'bdnsync-modal-foot' });
    footer
      .createEl('button', { text: '取消同步', cls: 'bdnsync-btn' })
      .addEventListener('click', () => done('cancel'));
    footer
      .createEl('button', { text: '跳过删除（推荐）', cls: 'bdnsync-btn bdnsync-btn-primary' })
      .addEventListener('click', () => done('skip-deletes'));
    footer
      .createEl('button', { text: '确认删除', cls: 'bdnsync-btn bdnsync-btn-danger' })
      .addEventListener('click', () => done('proceed'));
  }

  onClose(): void {
    this.resolveP?.('cancel');
    this.resolveP = null;
    this.contentEl.empty();
  }
}

/**
 * 强制全量同步确认：force-upload / force-download 会删除对侧多余文件，
 * 属于破坏性修复操作，执行前必须让用户明确确认意图与后果。
 */
export class ForceSyncConfirmModal extends Modal {
  private resolveP: ((choice: 'confirm' | 'cancel') => void) | null = null;

  constructor(
    app: App,
    private direction: 'force-upload' | 'force-download',
  ) {
    super(app);
    this.modalEl.addClass('bdnsync-modal', 'bdnsync-guard-modal');
  }

  open(): Promise<'confirm' | 'cancel'> {
    super.open();
    return new Promise((resolve) => {
      this.resolveP = resolve;
    });
  }

  onOpen(): void {
    const { contentEl, direction } = this;
    const isUpload = direction === 'force-upload';
    const shell = contentEl.createDiv({ cls: 'bdnsync-modal-shell' });
    createModalHeader(shell, {
      title: isUpload ? '强制全量上传（本地覆盖云端）' : '强制全量下载（云端覆盖本地）',
      icon: 'alert-triangle',
      danger: true,
    });
    const body = shell.createDiv({ cls: 'bdnsync-modal-body' });
    body.createEl('p', {
      text: isUpload
        ? '本操作将以「本地文件」为唯一真相：本地所有文件上传到云端，云端存在但本地不存在的文件将被删除。'
        : '本操作将以「云端文件」为唯一真相：云端所有文件下载到本地，本地存在但云端不存在的文件将被删除。',
      cls: 'bdnsync-guard-reason',
    });

    const list = body.createDiv({ cls: 'bdnsync-guard-samples' });
    list.createEl('div', { text: '适用场景：', cls: 'bdnsync-guard-samples-title' });
    const items = isUpload
      ? [
          '本地做了大量修改，想彻底用本地覆盖远端',
          '远端索引损坏、冲突缠死，需要重新对齐',
          '换机后本地库为重装，需要把当前库推上去',
        ]
      : [
          '云端是主库，需要把本地完全恢复成云端状态',
          '本地误删文件，想从云端全量拉回',
          '本地索引错乱，需要以云端为准重新对齐',
        ];
    for (const it of items) list.createEl('div', { text: `· ${it}`, cls: 'bdnsync-guard-sample' });

    body.createEl('p', {
      cls: 'bdnsync-modal-subtitle',
      text: '重要：被「真相侧」判定为多余的对方文件将被删除，且删除遵循 30 天墓碑回收机制（可在网盘浏览器或回收站找回）。请确认这是你想要的。',
    });

    const done = (c: 'confirm' | 'cancel') => {
      this.resolveP?.(c);
      this.resolveP = null;
      this.close();
    };

    const footer = shell.createDiv({ cls: 'bdnsync-modal-foot' });
    footer
      .createEl('button', { text: '取消', cls: 'bdnsync-btn' })
      .addEventListener('click', () => done('cancel'));
    footer
      .createEl('button', {
        text: isUpload ? '确认：本地覆盖云端' : '确认：云端覆盖本地',
        cls: 'bdnsync-btn bdnsync-btn-danger',
      })
      .addEventListener('click', () => done('confirm'));
  }

  onClose(): void {
    this.resolveP?.('cancel');
    this.resolveP = null;
    this.contentEl.empty();
  }
}

type ResolveStrategy = 'smart-merge' | 'force-local' | 'force-remote' | 'always-fork';

const STRATEGY_LABEL: Record<ResolveStrategy, string> = {
  'smart-merge': '智能合并',
  'force-local': '保留本地',
  'force-remote': '保留云端',
  'always-fork': '双版本保留',
};

const STRATEGY_DESC: Record<ResolveStrategy, string> = {
  'smart-merge': '文本文件自动三方合并；二进制保留双版本',
  'force-local': '用本地版本覆盖云端',
  'force-remote': '用云端版本覆盖本地',
  'always-fork': '本地与云端各保留一份',
};

const STRATEGY_ICON: Record<ResolveStrategy, Parameters<typeof setIcon>[1]> = {
  'smart-merge': 'git-merge',
  'force-local': 'hard-drive',
  'force-remote': 'cloud',
  'always-fork': 'copy',
};

/** 冲突面板：逐文件或批量选择策略 */
export class ConflictModal extends Modal {
  private choices = new Map<string, ResolveStrategy>();
  private selectedPath: string | null = null;

  constructor(
    app: App,
    private conflicts: ConflictRecord[],
    private onResolve: (path: string, strategy: ResolveStrategy) => Promise<boolean>,
    private onRefresh: () => void,
  ) {
    super(app);
    this.modalEl.addClass('bdnsync-modal', 'bdnsync-conflict-modal');
  }

  onOpen(): void {
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();

    const shell = contentEl.createDiv({ cls: 'bdnsync-modal-shell bdnsync-modal-split' });
    createModalHeader(shell, {
      title: '冲突处理',
      icon: 'git-merge',
      subtitle: '以下文件在多个设备上同时被修改。为每个文件选择处理方式，或批量应用同一策略。',
    });
    const body = shell.createDiv({ cls: 'bdnsync-modal-body' });

    if (this.conflicts.length === 0) {
      createCard(body).createEl('p', {
        text: '当前没有待处理的冲突 🎉',
        cls: 'bdnsync-empty-state',
      });
      const foot = shell.createDiv({ cls: 'bdnsync-modal-foot' });
      foot
        .createEl('button', { text: '关闭', cls: 'bdnsync-btn bdnsync-btn-primary' })
        .addEventListener('click', () => this.close());
      return;
    }

    const split = body.createDiv({ cls: 'bdnsync-conflict-split' });
    const listEl = split.createDiv({
      cls: 'bdnsync-conflict-list',
      attr: { role: 'listbox', 'aria-label': '冲突文件列表' },
    });
    const detailEl = split.createDiv({ cls: 'bdnsync-conflict-detail' });

    this.conflicts.forEach((c, idx) => {
      const row = listEl.createDiv({
        cls: 'bdnsync-conflict-row',
        attr: {
          role: 'option',
          tabindex: '0',
          'aria-selected': String(this.selectedPath === c.path),
        },
      });
      if (this.selectedPath === c.path) row.addClass('active');
      const top = row.createDiv({ cls: 'bdnsync-conflict-row-top' });
      top.createEl('span', { text: c.path, cls: 'bdnsync-conflict-path' });
      createBadge(top, conflictKindText(c.kind), 'warning');
      row.createEl('div', {
        text: `${formatTime(c.detectedAt)} · ${c.reason}`,
        cls: 'bdnsync-conflict-row-meta',
      });
      row.addEventListener('click', () => {
        this.selectedPath = c.path;
        this.render();
      });
      row.addEventListener('keydown', (ev) => {
        if (ev.key === 'ArrowDown') {
          ev.preventDefault();
          this.focusRow(Math.min(this.conflicts.length - 1, idx + 1));
        } else if (ev.key === 'ArrowUp') {
          ev.preventDefault();
          this.focusRow(Math.max(0, idx - 1));
        } else if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          this.selectedPath = c.path;
          this.render();
        }
      });
    });

    const active = this.conflicts.find((c) => c.path === this.selectedPath) ?? this.conflicts[0];
    this.selectedPath = active.path;

    detailEl.createEl('h4', { text: active.path, cls: 'bdnsync-conflict-detail-title' });
    detailEl.createEl('p', { text: active.reason, cls: 'bdnsync-conflict-detail-reason' });

    createSection(detailEl, { title: '选择处理方式', icon: 'git-merge' });
    const strategyGrid = detailEl.createDiv({ cls: 'bdnsync-strategy-grid' });
    const selected = this.choices.get(active.path) || 'smart-merge';
    for (const [key, label] of Object.entries(STRATEGY_LABEL)) {
      const strategy = key as ResolveStrategy;
      const card = createCard(strategyGrid, 'bdnsync-strategy-card');
      card.setAttribute('role', 'radio');
      card.setAttribute('tabindex', '0');
      card.setAttribute('aria-checked', String(strategy === selected));
      const iconWrap = card.createSpan({ cls: 'bdnsync-strategy-icon' });
      setIcon(iconWrap, STRATEGY_ICON[strategy], 18);
      card.createEl('div', { text: label, cls: 'bdnsync-strategy-title' });
      card.createEl('div', { text: STRATEGY_DESC[strategy], cls: 'bdnsync-strategy-desc' });
      if (strategy === selected) card.addClass('bdnsync-strategy-card-active');
      card.addEventListener('click', () => {
        this.choices.set(active.path, strategy);
        this.render();
      });
      card.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          this.choices.set(active.path, strategy);
          this.render();
        }
      });
    }

    const actions = detailEl.createDiv({ cls: 'bdnsync-conflict-actions' });
    createIconButton(actions, {
      icon: 'check',
      label: `应用「${STRATEGY_LABEL[selected]}」`,
      primary: true,
      onClick: async () => {
        const strategy = this.choices.get(active.path) || 'smart-merge';
        const ok = await this.onResolve(active.path, strategy);
        if (!ok) new Notice(`BDNSync：处理失败 ${active.path}`);
        this.onRefresh();
        this.conflicts = this.conflicts.filter((c) => c.path !== active.path);
        this.selectedPath = this.conflicts[0]?.path ?? null;
        this.render();
      },
    });

    // 批量处理（统一设计令牌：自定义 select + 统一按钮样式，避免 Obsidian 原生
    // Dropdown/Button 在暗色或第三方主题下与 .bdnsync-btn 视觉不一致）
    const bulk = shell.createDiv({ cls: 'bdnsync-modal-foot bdnsync-conflict-bulk-foot' });
    bulk.createEl('span', { text: '全部应用：', cls: 'bdnsync-conflict-bulk-label' });
    let bulkStrategy: ResolveStrategy = 'smart-merge';
    const sel = bulk.createEl('select', {
      cls: 'bdnsync-select',
      attr: { 'aria-label': '批量冲突解决策略' },
    });
    for (const [key, label] of Object.entries(STRATEGY_LABEL)) {
      const opt = sel.createEl('option', { text: label });
      opt.value = key;
    }
    sel.value = bulkStrategy;
    sel.addEventListener('change', () => {
      bulkStrategy = sel.value as ResolveStrategy;
    });
    createIconButton(bulk, {
      icon: 'zap',
      label: '批量处理',
      primary: true,
      onClick: async (btn) => {
        btn.disabled = true;
        const todo = [...this.conflicts];
        let ok = 0,
          done = 0;
        const total = todo.length;
        const progress = new Notice(`BDNSync：批量处理中 0/${total}`, 0);
        // 并发批量处理（限制并发，避免大量冲突时瞬间打满网盘 API）
        await runWithConcurrency(
          todo.map((c) => async () => {
            if (await this.onResolve(c.path, bulkStrategy)) ok++;
            done++;
            if (done % 5 === 0 || done === total) {
              progress.setMessage(`BDNSync：批量处理中 ${done}/${total}`);
            }
          }),
          3,
        );
        progress.hide();
        new Notice(`BDNSync：已处理 ${ok}/${total} 个冲突`);
        this.onRefresh();
        this.conflicts = [];
        this.render();
      },
    });
  }

  private focusRow(idx: number): void {
    const rows = this.contentEl.querySelectorAll('.bdnsync-conflict-row');
    const target = rows[idx] as HTMLElement | undefined;
    if (target) {
      this.selectedPath = this.conflicts[idx].path;
      this.render();
      (this.contentEl.querySelectorAll('.bdnsync-conflict-row')[idx] as HTMLElement)?.focus();
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** 统计面板 */
export class StatsModal extends Modal {
  constructor(
    app: App,
    private stats: CumulativeStats,
    private lastSyncAt: number,
    private syncVersion: number,
    private deviceName: string,
    private deviceId: string,
    private quota: QuotaInfo | null,
    private deleteStrategy: DeleteStrategy,
  ) {
    super(app);
    this.modalEl.addClass('bdnsync-modal', 'bdnsync-stats-modal');
  }

  onOpen(): void {
    const { contentEl } = this;
    const shell = contentEl.createDiv({ cls: 'bdnsync-modal-shell' });
    createModalHeader(shell, { title: '同步统计', icon: 'bar-chart-2' });
    const body = shell.createDiv({ cls: 'bdnsync-modal-body' });

    const metrics = body.createDiv({ cls: 'bdnsync-stats-grid' });
    const cards: { label: string; value: string; accent: 'blue' | 'green' | 'amber' | 'rose' }[] = [
      { label: '同步次数', value: String(this.stats.syncCount), accent: 'blue' },
      { label: '累计上传', value: `${this.stats.totalUploads} 个`, accent: 'green' },
      { label: '累计下载', value: `${this.stats.totalDownloads} 个`, accent: 'green' },
      { label: '累计冲突', value: String(this.stats.totalConflicts), accent: 'rose' },
    ];
    for (const c of cards) {
      const card = createCard(metrics, `bdnsync-stats-card bdnsync-stats-card-${c.accent}`);
      card.createEl('div', { text: c.value, cls: 'bdnsync-stats-card-value' });
      card.createEl('div', { text: c.label, cls: 'bdnsync-stats-card-label' });
    }

    const info = body.createDiv({ cls: 'bdnsync-stats-info' });
    const addInfo = (k: string, v: string) => {
      const row = info.createDiv({ cls: 'bdnsync-stats-info-row' });
      row.createEl('span', { text: k, cls: 'bdnsync-stats-info-key' });
      row.createEl('span', { text: v, cls: 'bdnsync-stats-info-value' });
    };
    addInfo('最近同步', this.lastSyncAt ? new Date(this.lastSyncAt).toLocaleString() : '—');
    addInfo('上次结果', this.stats.lastSyncSummary || '—');
    addInfo('累计上传流量', formatBytes(this.stats.bytesUp));
    addInfo('累计下载流量', formatBytes(this.stats.bytesDown));
    addInfo('累计删除', String(this.stats.totalDeletes));
    addInfo('远程索引版本', `v${this.syncVersion}`);
    addInfo('本设备', `${this.deviceName || '未命名'}（${this.deviceId}）`);
    addInfo(
      '删除策略',
      this.deleteStrategy === 'keep-modified' ? '保留修改（更安全）' : '到处删除',
    );

    if (this.quota) {
      const quotaSection = createSection(body, { title: '网盘容量', icon: 'hard-drive' });
      const ratio = this.quota.total > 0 ? this.quota.used / this.quota.total : 0;
      createProgressBar(quotaSection.body).setRatio(
        ratio,
        `${formatBytes(this.quota.used)} / ${formatBytes(this.quota.total)}（剩余 ${formatBytes(this.quota.free)}）`,
      );
    }

    const foot = shell.createDiv({ cls: 'bdnsync-modal-foot' });
    foot
      .createEl('button', {
        text: '关闭',
        cls: 'bdnsync-btn bdnsync-btn-primary',
      })
      .addEventListener('click', () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** 同步日志面板（支持时间线视图 + 类型筛选 + 整合筛选/导出） */
import { Logger } from '../util/logger';

export class SyncLogModal extends Modal {
  private viewMode: 'list' | 'timeline' = 'list';
  private typeFilter: Set<SyncLogEntry['type']> = new Set();
  private minLevel: LogLevel = 'debug';
  private keyword = '';
  private from = '';
  private to = '';

  constructor(
    app: App,
    private logger: Logger,
  ) {
    super(app);
    this.modalEl.addClass('bdnsync-modal', 'bdnsync-log-modal');
  }

  private buildFilter(): LogFilter {
    const f: LogFilter = { minLevel: this.minLevel };
    if (this.typeFilter.size) f.types = [...this.typeFilter];
    if (this.keyword.trim()) f.keyword = this.keyword.trim();
    if (this.from) {
      const t = new Date(this.from + 'T00:00:00').getTime();
      if (!isNaN(t)) f.from = t;
    }
    if (this.to) {
      const t = new Date(this.to + 'T23:59:59').getTime();
      if (!isNaN(t)) f.to = t;
    }
    return f;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    const shell = contentEl.createDiv({ cls: 'bdnsync-modal-shell' });
    const head = createModalHeader(shell, {
      title: '同步日志',
      icon: 'activity',
      subtitle: '支持按时间范围、级别、类型与关键字整合筛选，并可导出排查',
    });

    // 工具栏：视图切换
    const toolbar = head.head.createDiv({ cls: 'bdnsync-log-toolbar' });
    createIconButton(toolbar, {
      icon: 'filter',
      label: '列表',
      primary: this.viewMode === 'list',
      onClick: () => {
        this.viewMode = 'list';
        this.render();
      },
    });
    createIconButton(toolbar, {
      icon: 'timeline',
      label: '时间线',
      primary: this.viewMode === 'timeline',
      onClick: () => {
        this.viewMode = 'timeline';
        this.render();
      },
    });

    const body = shell.createDiv({ cls: 'bdnsync-modal-body' });

    // 整合筛选栏
    const filterBar = body.createDiv({ cls: 'bdnsync-log-filterbar' });
    // 关键字
    const kwWrap = filterBar.createDiv({ cls: 'bdnsync-log-field' });
    kwWrap.createEl('label', { text: '关键字', cls: 'bdnsync-log-label' });
    const kwInput = kwWrap.createEl('input', {
      cls: 'bdnsync-input',
      attr: { type: 'text', placeholder: '搜索消息/路径…' },
    }) as HTMLInputElement;
    kwInput.value = this.keyword;
    kwInput.addEventListener('input', () => {
      this.keyword = kwInput.value;
      this.renderList();
    });
    // 起止日期
    const fromWrap = filterBar.createDiv({ cls: 'bdnsync-log-field' });
    fromWrap.createEl('label', { text: '起始', cls: 'bdnsync-log-label' });
    const fromInput = fromWrap.createEl('input', {
      cls: 'bdnsync-input',
      attr: { type: 'date' },
    }) as HTMLInputElement;
    fromInput.value = this.from;
    fromInput.addEventListener('change', () => {
      this.from = fromInput.value;
      this.renderList();
    });
    const toWrap = filterBar.createDiv({ cls: 'bdnsync-log-field' });
    toWrap.createEl('label', { text: '结束', cls: 'bdnsync-log-label' });
    const toInput = toWrap.createEl('input', {
      cls: 'bdnsync-input',
      attr: { type: 'date' },
    }) as HTMLInputElement;
    toInput.value = this.to;
    toInput.addEventListener('change', () => {
      this.to = toInput.value;
      this.renderList();
    });
    // 级别下拉
    const lvlWrap = filterBar.createDiv({ cls: 'bdnsync-log-field' });
    lvlWrap.createEl('label', { text: '最低级别', cls: 'bdnsync-log-label' });
    const lvlSelect = lvlWrap.createEl('select', { cls: 'bdnsync-input' }) as HTMLSelectElement;
    for (const [v, label] of [
      ['debug', '调试'],
      ['info', '信息'],
      ['warn', '警告'],
      ['error', '错误'],
    ] as const) {
      const opt = lvlSelect.createEl('option', { text: label, value: v });
      if (v === this.minLevel) opt.selected = true;
    }
    lvlSelect.addEventListener('change', () => {
      this.minLevel = lvlSelect.value as LogLevel;
      this.renderList();
    });

    // 类型 chip 筛选
    const chips = body.createDiv({ cls: 'bdnsync-log-filters' });
    const types: SyncLogEntry['type'][] = [
      'upload',
      'download',
      'delete',
      'conflict',
      'error',
      'info',
    ];
    for (const t of types) {
      const chip = chips.createSpan({
        cls: `bdnsync-log-chip bdnsync-log-chip-${t}${this.typeFilter.has(t) ? ' active' : ''}`,
      });
      chip.setText(this.logTypeLabel(t));
      chip.addEventListener('click', () => {
        if (this.typeFilter.has(t)) this.typeFilter.delete(t);
        else this.typeFilter.add(t);
        chip.classList.toggle('active', this.typeFilter.has(t));
        this.renderList();
      });
    }

    // 列表/时间线容器
    const listContainer = body.createDiv({ cls: 'bdnsync-log-list-container' });
    this.listContainer = listContainer;
    this.renderList();

    // 底部操作
    const footer = shell.createDiv({ cls: 'bdnsync-modal-foot' });
    footer
      .createEl('button', { text: '清空全部', cls: 'bdnsync-btn bdnsync-btn-danger' })
      .addEventListener('click', async () => {
        const ok = await showConfirmModal(this.app, {
          title: '清空全部日志',
          message: '将物理清除所有日志条目（不可恢复）。确定？',
          danger: true,
          icon: 'trash-2',
        });
        if (!ok) return;
        this.logger.clearAll();
        await this.logger.purge();
        this.renderList();
        new Notice('BDNSync：日志已清空');
      });
    footer
      .createEl('button', { text: '复制结果', cls: 'bdnsync-btn' })
      .addEventListener('click', async () => {
        await navigator.clipboard.writeText(this.logger.exportText(this.buildFilter()));
        new Notice('BDNSync：已复制筛选结果到剪贴板');
      });
    footer
      .createEl('button', { text: '导出 JSON', cls: 'bdnsync-btn' })
      .addEventListener('click', async () => {
        const json = this.logger.exportJSON(this.buildFilter());
        await this.downloadFile('bdnsync-logs.json', json, 'application/json');
        new Notice('BDNSync：已导出 JSON 日志');
      });
    footer
      .createEl('button', { text: '导出文本', cls: 'bdnsync-btn' })
      .addEventListener('click', async () => {
        const txt = this.logger.exportText(this.buildFilter());
        await this.downloadFile('bdnsync-logs.txt', txt, 'text/plain');
        new Notice('BDNSync：已导出文本日志');
      });
    footer
      .createEl('button', { text: '关闭', cls: 'bdnsync-btn bdnsync-btn-primary' })
      .addEventListener('click', () => this.close());

    // 支持用户拖拽调整弹窗尺寸（自适应 + 手动）；scope 隔离多 vault 尺寸
    makeResizable(this.modalEl, contentEl, 'log', this.app.vault.getName());
  }

  private listContainer!: HTMLElement;

  /** 仅重渲染列表/时间线区域（筛选交互时避免整窗重建） */
  private renderList(): void {
    if (!this.listContainer) return;
    this.listContainer.empty();
    const filtered = this.logger.query(this.buildFilter());
    const stats = this.logger.tombstoneStats();

    // 结果统计行
    const statBar = this.listContainer.createDiv({ cls: 'bdnsync-log-statbar' });
    statBar.setText(
      `匹配 ${filtered.length} 条 · 总计 ${stats.total} 条（墓碑 ${stats.tombstoned}）`,
    );
    if (stats.tombstoned > 0) {
      const recBtn = statBar.createEl('button', { text: '恢复墓碑', cls: 'bdnsync-link-btn' });
      recBtn.addEventListener('click', async () => {
        const ok = await showConfirmModal(this.app, {
          title: '恢复墓碑日志',
          message: `将恢复 ${stats.tombstoned} 条处于宽限期的日志。确定？`,
          icon: 'rotate-ccw',
        });
        if (!ok) return;
        const ids = this.logger
          .snapshot()
          .filter((e) => e.deleted)
          .map((e) => e.id);
        this.logger.recover(ids);
        await this.logger.purge();
        this.renderList();
        new Notice('BDNSync：已恢复墓碑日志');
      });
    }

    if (filtered.length === 0) {
      this.listContainer.createEl('p', { text: '当前筛选无匹配日志', cls: 'bdnsync-empty-state' });
      return;
    }
    if (this.viewMode === 'timeline') {
      this.renderTimeline(this.listContainer, filtered);
    } else {
      const list = this.listContainer.createDiv({ cls: 'bdnsync-log-list' });
      for (const log of filtered) {
        const row = list.createDiv({
          cls: `bdnsync-log-row${log.deleted ? ' bdnsync-log-row-tomb' : ''}`,
        });
        const iconWrap = row.createSpan({ cls: 'bdnsync-log-icon' });
        setIcon(iconWrap, this.logIcon(log.type), 14);
        row.createSpan({ text: new Date(log.time).toLocaleString(), cls: 'bdnsync-log-time' });
        row.createSpan({ text: this.logTypeLabel(log.type), cls: 'bdnsync-log-type' });
        row.createSpan({ text: log.message, cls: 'bdnsync-log-msg' });
        if (log.path) row.createEl('div', { text: log.path, cls: 'bdnsync-log-path' });
        if (log.deleted) row.createSpan({ text: '（墓碑·宽限期内）', cls: 'bdnsync-log-tomb-tag' });
      }
    }
  }

  private async downloadFile(name: string, content: string, mime: string): Promise<void> {
    try {
      const blob = new Blob([content], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      await navigator.clipboard.writeText(content);
      new Notice('BDNSync：下载不可用，已复制到剪贴板');
    }
  }

  private renderTimeline(container: HTMLElement, logs: SyncLogEntry[]): void {
    const wrap = container.createDiv({ cls: 'bdnsync-timeline' });
    for (const log of logs) {
      const item = wrap.createDiv({
        cls: `bdnsync-timeline-item bdnsync-timeline-${log.type}${log.deleted ? ' bdnsync-timeline-tomb' : ''}`,
      });
      const dot = item.createSpan({ cls: 'bdnsync-timeline-dot' });
      setIcon(dot, this.logIcon(log.type), 12);
      const content = item.createDiv({ cls: 'bdnsync-timeline-content' });
      content.createEl('div', {
        text: new Date(log.time).toLocaleString(),
        cls: 'bdnsync-timeline-time',
      });
      content.createEl('div', {
        text: `${this.logTypeLabel(log.type)} · ${log.message}`,
        cls: 'bdnsync-timeline-msg',
      });
      if (log.path) content.createEl('div', { text: log.path, cls: 'bdnsync-timeline-path' });
      if (log.deleted)
        content.createEl('div', { text: '（墓碑·宽限期内）', cls: 'bdnsync-timeline-tomb-tag' });
    }
  }

  private logTypeLabel(t: SyncLogEntry['type']): string {
    return {
      upload: '上传',
      download: '下载',
      delete: '删除',
      conflict: '冲突',
      error: '错误',
      info: '信息',
    }[t];
  }

  private logIcon(type: SyncLogEntry['type']): Parameters<typeof setIcon>[1] {
    switch (type) {
      case 'upload':
        return 'arrow-up';
      case 'download':
        return 'arrow-down';
      case 'delete':
        return 'trash-2';
      case 'conflict':
        return 'alert-triangle';
      case 'error':
        return 'cloud-alert';
      default:
        return 'info';
    }
  }

  private render(): void {
    this.contentEl.empty();
    this.onOpen();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** 确认弹窗 */
export class ConfirmModal extends Modal {
  private resolveP: ((ok: boolean) => void) | null = null;

  constructor(
    app: App,
    private title: string,
    private message: string,
    private confirmText = '确认',
    private danger = false,
  ) {
    super(app);
    this.modalEl.addClass('bdnsync-modal');
  }

  open(): Promise<boolean> {
    super.open();
    return new Promise((resolve) => {
      this.resolveP = resolve;
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    const shell = contentEl.createDiv({ cls: 'bdnsync-modal-shell' });
    createModalHeader(shell, {
      title: this.title,
      icon: this.danger ? 'alert-triangle' : 'info',
      danger: this.danger,
    });
    const body = shell.createDiv({ cls: 'bdnsync-modal-body' });
    body.createEl('p', { text: this.message, cls: 'bdnsync-modal-subtitle' });
    const footer = shell.createDiv({ cls: 'bdnsync-modal-foot' });
    footer
      .createEl('button', { text: '取消', cls: 'bdnsync-btn' })
      .addEventListener('click', () => this.done(false));
    footer
      .createEl('button', {
        text: this.confirmText,
        cls: `bdnsync-btn ${this.danger ? 'bdnsync-btn-danger' : 'bdnsync-btn-primary'}`,
      })
      .addEventListener('click', () => this.done(true));
  }

  private done(ok: boolean): void {
    this.resolveP?.(ok);
    this.resolveP = null;
    this.close();
  }

  onClose(): void {
    this.resolveP?.(false);
    this.resolveP = null;
    this.contentEl.empty();
  }
}

/**
 * 文件级版本历史面板：列出某文件的版本，可将指定版本（或上一版本）恢复回 vault + 上传。
 */
export class VersionHistoryModal extends Modal {
  constructor(
    app: App,
    private store: LocalStore,
    private filePath: string,
    private onRestore: (path: string, content: Uint8Array) => Promise<void>,
  ) {
    super(app);
    this.modalEl.addClass('bdnsync-modal', 'bdnsync-version-modal');
  }

  onOpen(): void {
    void this.render();
  }

  private async render(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    const shell = contentEl.createDiv({ cls: 'bdnsync-modal-shell' });
    createModalHeader(shell, {
      title: '版本历史',
      icon: 'history',
      subtitle: this.filePath,
    });
    const body = shell.createDiv({ cls: 'bdnsync-modal-body' });

    const idx = await this.store.loadLocalIndex();
    const versions = this.store.listVersions(idx, this.filePath);
    if (versions.length === 0) {
      createCard(body).createEl('p', {
        text: '该文件暂无版本记录（版本历史在同步写入/本地编辑时自动记录）',
        cls: 'bdnsync-empty-state',
      });
      const foot = shell.createDiv({ cls: 'bdnsync-modal-foot' });
      foot
        .createEl('button', { text: '关闭', cls: 'bdnsync-btn bdnsync-btn-primary' })
        .addEventListener('click', () => this.close());
      return;
    }

    body.createEl('p', {
      text: `共 ${versions.length} 个历史版本（最新在前）`,
      cls: 'bdnsync-help-text',
    });
    const list = body.createDiv({ cls: 'bdnsync-version-list' });
    versions.forEach((v, i) => {
      const row = list.createDiv({ cls: 'bdnsync-version-row' });
      const meta = row.createDiv({ cls: 'bdnsync-version-meta' });
      meta.createEl('div', {
        text: `${formatTime(v.mtime)} · ${formatBytes(v.size)}`,
        cls: 'bdnsync-version-time',
      });
      meta.createEl('div', {
        text: `${v.deviceName || v.byDevice}${v.note ? ` · ${v.note}` : ''}`,
        cls: 'bdnsync-version-src',
      });
      const actions = row.createDiv({ cls: 'bdnsync-version-actions' });
      createIconButton(actions, {
        icon: 'rotate-ccw',
        label: i === 0 ? '恢复此版本' : '恢复',
        primary: i === 0,
        onClick: async () => {
          const bytes = await this.store.getVersionContent(v.hash);
          if (!bytes) {
            new Notice('BDNSync：该版本内容已过期（base 缓存被回收），无法恢复');
            return;
          }
          await this.onRestore(this.filePath, bytes);
          new Notice(`BDNSync：已恢复 ${this.filePath} 的版本（${formatTime(v.mtime)}）`);
          this.close();
        },
      });
    });

    const foot = shell.createDiv({ cls: 'bdnsync-modal-foot' });
    foot
      .createEl('button', { text: '关闭', cls: 'bdnsync-btn bdnsync-btn-primary' })
      .addEventListener('click', () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** 同步预览（dry-run）确认弹窗：手动同步前展示计划，用户确认后再执行 */
export class SyncPreviewModal extends Modal {
  private resolveP: ((confirm: boolean) => void) | null = null;

  constructor(
    app: App,
    private plan: SyncPlanPreview,
  ) {
    super(app);
    this.modalEl.addClass('bdnsync-modal', 'bdnsync-preview-modal');
  }

  open(): Promise<boolean> {
    super.open();
    return new Promise((resolve) => {
      this.resolveP = resolve;
    });
  }

  onOpen(): void {
    const { contentEl, plan } = this;
    const shell = contentEl.createDiv({ cls: 'bdnsync-modal-shell' });
    const dirText =
      plan.direction === 'force-upload'
        ? '强制上传（本地覆盖云端）'
        : plan.direction === 'force-download'
          ? '强制下载（云端覆盖本地）'
          : '双向同步';
    createModalHeader(shell, {
      title: '同步预览',
      icon: 'timeline',
      subtitle: `即将执行：${dirText}`,
    });

    const body = shell.createDiv({ cls: 'bdnsync-modal-body' });

    const metrics = body.createDiv({ cls: 'bdnsync-preview-grid' });
    const cards: { label: string; value: number; accent: 'blue' | 'green' | 'amber' | 'rose' }[] = [
      { label: '将上传', value: plan.upload, accent: 'green' },
      { label: '将下载', value: plan.download, accent: 'blue' },
      { label: '删除本地', value: plan.deleteLocal, accent: 'rose' },
      { label: '删除云端', value: plan.deleteRemote, accent: 'rose' },
      { label: '冲突', value: plan.conflicts, accent: 'amber' },
      { label: '跳过', value: plan.skip, accent: 'amber' },
    ];
    for (const c of cards) {
      const card = createCard(
        metrics,
        `bdnsync-preview-card bdnsync-preview-card-${c.accent}${c.value > 0 ? ' bdnsync-preview-card-active' : ''}`,
      );
      card.createEl('div', { text: String(c.value), cls: 'bdnsync-preview-card-value' });
      card.createEl('div', { text: c.label, cls: 'bdnsync-preview-card-label' });
    }

    if (plan.samples.length) {
      const sampleWrap = body.createDiv({ cls: 'bdnsync-preview-samples' });
      sampleWrap.createEl('div', { text: '操作样例：', cls: 'bdnsync-preview-samples-title' });
      const opLabel: Record<string, string> = {
        upload: '↑上传',
        download: '↓下载',
        'delete-local': '🗑删本地',
        'delete-remote': '🗑删云端',
        conflict: '⚠冲突',
        skip: '跳过',
      };
      for (const s of plan.samples) {
        const row = sampleWrap.createDiv({ cls: 'bdnsync-preview-sample' });
        const badge = createBadge(
          row,
          opLabel[s.op] || s.op,
          s.op.startsWith('delete') ? 'error' : s.op === 'conflict' ? 'warning' : 'info',
        );
        badge.addClass('bdnsync-preview-sample-badge');
        row.createSpan({ text: s.path, cls: 'bdnsync-preview-sample-path' });
      }
    } else {
      createCard(body).createEl('p', { text: '没有需要同步的变更 ✅', cls: 'bdnsync-empty-state' });
    }

    const done = (confirm: boolean) => {
      this.resolveP?.(confirm);
      this.resolveP = null;
      this.close();
    };
    const footer = shell.createDiv({ cls: 'bdnsync-modal-foot' });
    footer
      .createEl('button', { text: '取消', cls: 'bdnsync-btn' })
      .addEventListener('click', () => done(false));
    footer
      .createEl('button', { text: '确认同步', cls: 'bdnsync-btn bdnsync-btn-primary' })
      .addEventListener('click', () => done(true));
  }

  onClose(): void {
    this.resolveP?.(false);
    this.resolveP = null;
    this.contentEl.empty();
  }
}

/** 整库快照恢复弹窗：列出快照点，选择后将库回滚到该快照（重新下载/上传快照中记录的文件） */
export class SnapshotRestoreModal extends Modal {
  constructor(
    app: App,
    private store: LocalStore,
    private onRestore: (snap: VaultSnapshot) => Promise<void>,
  ) {
    super(app);
    this.modalEl.addClass('bdnsync-modal', 'bdnsync-snapshot-modal');
  }

  onOpen(): void {
    void this.render();
  }

  private async render(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    const shell = contentEl.createDiv({ cls: 'bdnsync-modal-shell' });
    createModalHeader(shell, {
      title: '整库快照',
      icon: 'layers',
      subtitle: 'force 方向同步前自动生成的轻量索引，可整库回滚到该时间点',
    });
    const body = shell.createDiv({ cls: 'bdnsync-modal-body' });

    const idx = await this.store.loadLocalIndex();
    const snaps = idx.snapshots || [];
    if (snaps.length === 0) {
      createCard(body).createEl('p', {
        text: '暂无快照点（在设置中开启「自动快照」后，强制同步前会自动生成）',
        cls: 'bdnsync-empty-state',
      });
      const foot = shell.createDiv({ cls: 'bdnsync-modal-foot' });
      foot
        .createEl('button', { text: '关闭', cls: 'bdnsync-btn bdnsync-btn-primary' })
        .addEventListener('click', () => this.close());
      return;
    }

    const list = body.createDiv({ cls: 'bdnsync-snapshot-list' });
    snaps.forEach((snap) => {
      const row = list.createDiv({ cls: 'bdnsync-snapshot-row' });
      const meta = row.createDiv({ cls: 'bdnsync-snapshot-meta' });
      meta.createEl('div', {
        text: `${formatTime(snap.createdAt)} · ${snap.reason}`,
        cls: 'bdnsync-snapshot-time',
      });
      meta.createEl('div', {
        text: `${snap.totalFiles} 个文件 · ${formatBytes(snap.totalBytes)} · ${snap.deviceName || snap.deviceId}`,
        cls: 'bdnsync-snapshot-src',
      });
      const actions = row.createDiv({ cls: 'bdnsync-snapshot-actions' });
      createIconButton(actions, {
        icon: 'rotate-ccw',
        label: '回滚到此',
        danger: true,
        onClick: async () => {
          if (
            !(await new ConfirmModal(
              this.app,
              '确认整库回滚',
              `将把库恢复到 ${formatTime(snap.createdAt)} 的快照状态（${snap.totalFiles} 个文件）。当前与快照不一致的文件将被覆盖/删除。此操作不可逆，建议先备份。`,
              '回滚',
              true,
            ).open())
          )
            return;
          await this.onRestore(snap);
          new Notice('BDNSync：已开始整库回滚，请在同步日志查看进度');
          this.close();
        },
      });
    });

    const foot = shell.createDiv({ cls: 'bdnsync-modal-foot' });
    foot
      .createEl('button', { text: '关闭', cls: 'bdnsync-btn bdnsync-btn-primary' })
      .addEventListener('click', () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** 冲突处理明细报告弹窗（审计）：展示最近一次同步的冲突处理情况 */
export class ConflictReportModal extends Modal {
  constructor(
    app: App,
    private entries: ConflictReportEntry[],
  ) {
    super(app);
    this.modalEl.addClass('bdnsync-modal', 'bdnsync-report-modal');
  }

  onOpen(): void {
    const { contentEl } = this;
    const shell = contentEl.createDiv({ cls: 'bdnsync-modal-shell' });
    createModalHeader(shell, { title: '冲突处理报告', icon: 'git-merge' });
    const body = shell.createDiv({ cls: 'bdnsync-modal-body' });
    if (this.entries.length === 0) {
      createCard(body).createEl('p', {
        text: '最近一次同步没有冲突 ✅',
        cls: 'bdnsync-empty-state',
      });
    } else {
      const list = body.createDiv({ cls: 'bdnsync-report-list' });
      for (const e of this.entries) {
        const row = list.createDiv({ cls: 'bdnsync-report-row' });
        createBadge(row, conflictKindText(e.kind), 'warning');
        row.createEl('span', { text: e.path, cls: 'bdnsync-report-path' });
        row.createEl('div', {
          text: `策略：${e.strategy} · ${e.outcome}`,
          cls: 'bdnsync-report-outcome',
        });
      }
    }
    const foot = shell.createDiv({ cls: 'bdnsync-modal-foot' });
    foot
      .createEl('button', { text: '关闭', cls: 'bdnsync-btn bdnsync-btn-primary' })
      .addEventListener('click', () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** 导入设置弹窗（粘贴 JSON） */
export class ImportSettingsModal extends Modal {
  constructor(
    app: App,
    private onImport: (json: string) => boolean,
  ) {
    super(app);
    this.modalEl.addClass('bdnsync-modal');
  }

  onOpen(): void {
    const { contentEl } = this;
    const shell = contentEl.createDiv({ cls: 'bdnsync-modal-shell' });
    createModalHeader(shell, {
      title: '导入设置',
      icon: 'file-text',
      subtitle: '粘贴之前导出的设置 JSON，或选择本地设置文件（含认证信息，请注意安全）：',
    });
    const body = shell.createDiv({ cls: 'bdnsync-modal-body' });

    // 文件选择导入：避免剪贴板长 JSON 被截断导致配置缺失
    const fileRow = body.createDiv({ cls: 'bdnsync-setting-row' });
    const fileInput = fileRow.createEl('input', {
      type: 'file',
      attr: { accept: 'application/json,.json' },
    });
    fileInput.style.display = 'none';

    const selectBtn = createIconButton(fileRow, {
      icon: 'folder-input',
      label: '选择设置文件',
      onClick: () => fileInput.click(),
    });
    selectBtn.addClass('bdnsync-btn');

    const fileHint = fileRow.createEl('span', {
      cls: 'bdnsync-setting-hint',
      text: '未选择文件',
    });

    const ta = body.createEl('textarea', { cls: 'bdnsync-textarea' });

    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      fileHint.setText(file.name);
      const reader = new FileReader();
      reader.onload = () => {
        const text = String(reader.result ?? '');
        ta.value = text;
        // 文件读取成功后自动尝试导入；失败时保留文本供用户检查/手动修正
        if (this.onImport(text)) this.close();
        else new Notice('BDNSync：设置文件 JSON 解析或校验失败');
      };
      reader.onerror = () => {
        new Notice('BDNSync：读取设置文件失败');
      };
      reader.readAsText(file);
    });

    const footer = shell.createDiv({ cls: 'bdnsync-modal-foot' });
    footer
      .createEl('button', { text: '取消', cls: 'bdnsync-btn' })
      .addEventListener('click', () => this.close());
    footer
      .createEl('button', { text: '导入', cls: 'bdnsync-btn bdnsync-btn-primary' })
      .addEventListener('click', () => {
        if (this.onImport(ta.value)) this.close();
        else new Notice('BDNSync：设置 JSON 解析失败');
      });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
