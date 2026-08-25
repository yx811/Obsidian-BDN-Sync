// 弹窗：首次同步引导 / 冲突面板 / 统计面板 / 同步日志 / 确认框

import { App, Modal, Notice } from 'obsidian';
import type {
  ConflictRecord,
  CumulativeStats,
  DeleteStrategy,
  VaultSnapshot,
  SyncPlanPreview,
  ConflictReportEntry,
  OrphanFinding,
  DeepScanResult,
} from '../types';
import { conflictKindText } from '../sync/conflict-resolver';
import type { LocalStore } from '../storage/local-store';
import { formatBytes, formatTime, runWithConcurrency } from '../util/misc';
import {
  deleteOrphans,
  measureOrphans,
  pickOrphans,
  type OrphanEntry,
  type RemoteDirRow,
  type RemoteLister,
  type RemoteDeleter,
} from '../util/orphan-cleanup';
import type { QuotaInfo } from '../baidu/api';
import {
  createBadge,
  createCard,
  createIconButton,
  createModalHeader,
  createProgressBar,
  createSection,
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

/**
 * 网盘孤儿备份目录清理面板。
 *
 * 设计目标：
 *   1. 严格 0 自动删：所有动作必须用户手动确认（每条独立勾选 / 数量大时输入 DELETE）。
 *   2. 两种入口共用同一弹窗：
 *      - manual：命令面板 / 设置按钮触发的"扫描并清理"。
 *      - auto：同步结束钩子触发，候选保留天数过滤后弹出。
 *   3. 失败容错：单条删除失败不影响其它；结果分桶返回并写 SyncLog。
 *   4. 失败 UX：失败项展示完整绝对路径 + errno；提供「重试失败项」与「复制全部失败」操作；
 *      给出基于 errno 的诊断提示（路径不存在/部分失败/限流等），减少用户「为什么失败」的盲区。
 */
export class OrphanCleanupModal extends Modal {
  private items: OrphanEntry[] = []; // legacy 1-level 命中（保留向后兼容：若 opts.findings 不提供则自己扫）
  private findings: OrphanFinding[] = []; // v2 三类合并命中（由 main.ts 预扫后传入）
  private scanStats: { scannedNodes: number; scannedBytes: number; truncated: boolean; durationMs: number; errors: { path: string; message: string }[] } | null = null;
  private selected = new Set<string>(); // fullPath 集合
  private phase: 'scanning' | 'ready' | 'deleting' | 'done' = 'scanning';
  private summary = { total: 0, totalBytes: 0, selectedCount: 0, selectedBytes: 0 };
  private deleteResult: { ok: string[]; failed: { path: string; error: string; errno?: number }[] } | null = null;
  private bodyEl!: HTMLElement;
  private footerEl!: HTMLElement;
  /** 缓存「删除选中」按钮引用，使其能在勾选变化时原地更新文案/禁用态（修复 #80 缺陷 1）。 */
  private deleteBtn?: HTMLButtonElement;
  /** v2 设置：删除是否先送回收站（默认 true；false 时 modal 会提示「仍需到网盘回收站手动清空」） */
  private useRecycleBin = true;
  /** v2.1：最后一次成功扫描的结果快照（main.ts 的 onComplete 审计从此处读取 findings/stats）。 */
  lastScan: { findings: OrphanFinding[]; stats: NonNullable<OrphanCleanupModal['scanStats']> } | null = null;

  constructor(
    app: App,
    private vaultName: string,
    private parentDir: string,
    private lister: RemoteLister,
    private deleter: RemoteDeleter,
    private opts: {
      /** 同步结束钩子触发：候选过滤已生效，且 UI 文案偏向"是否清理"。 */
      autoMode?: boolean;
      /** 自动清理候选保留天数（autoMode 下展示用）；manual 模式传 0 不显示。 */
      retentionDays?: number;
      /** 当选中数量 ≥ 该值时要求输入"DELETE" 二次确认（默认 50）。 */
      bulkConfirmThreshold?: number;
      /** 完成时回调（删除完成 / 用户取消均触发）；manual 模式可省略。 */
      onComplete?: (r: {
        cancelled: boolean;
        okCount: number;
        failedCount: number;
        selectedCount: number;
        okPaths?: string[];
        failedPaths?: { path: string; error: string; errno?: number }[];
      }) => void;
      /** v2：使用回收站（默认 true；可逆）；false = 永久删除（仍会进回收站，需用户手动清空） */
      useRecycleBin?: boolean;
      /** v2：本次扫描模式（仅展示用） */
      scanMode?: 'parent-only' | 'scoped' | 'full-vault';
      /** v2：主入口预扫的结果（提供则跳过 modal 自带的 1 层 scan，直接进入 ready） */
      findings?: OrphanFinding[];
      /** v2：扫描统计（与 findings 配对） */
      scanStats?: {
        scannedNodes: number;
        scannedBytes: number;
        truncated: boolean;
        durationMs: number;
        errors: { path: string; message: string }[];
      };
    } = {},
  ) {
    super(app);
    this.modalEl.addClass('bdnsync-modal', 'bdnsync-orphan-modal');
    this.useRecycleBin = opts.useRecycleBin !== false;
  }

  onOpen(): void {
    this.renderShell();
    // v2 短路：若主入口已预扫，直接进入 ready；否则走 legacy 自扫
    if (this.opts.findings && this.opts.scanStats) {
      this.findings = [...this.opts.findings];
      this.scanStats = this.opts.scanStats;
      this.phase = 'ready';
      // 按 risk ≥ 1（高 + 中）默认勾选；orphan-file/orphan-dir 默认 risk=0 → 默认不勾（保守）
      for (const f of this.findings) {
        if (f.risk >= 1) this.selected.add(f.fullPath);
      }
      this.recomputeSummary();
      this.renderBody();
      this.renderFooter();
      // F4 修复：目录类候选（backup-dir / orphan-dir）缺省 bytes=0，后台补齐大小后重渲
      // 注意：闭包内 this.scanStats 的收窄会丢失，这里先用局部常量捕获。
      const statsAtOpen = this.scanStats;
      void this.measureDirFindings(this.findings).then((measured) => {
        this.findings = measured;
        if (statsAtOpen) this.lastScan = { findings: this.findings, stats: statsAtOpen };
        this.recomputeSummary();
        this.renderBody();
        this.renderFooter();
      });
      return;
    }
    void this.scan();
  }

  onClose(): void {
    this.opts.onComplete?.({
      cancelled: this.phase !== 'done',
      okCount: this.deleteResult?.ok.length ?? 0,
      failedCount: this.deleteResult?.failed.length ?? 0,
      selectedCount: this.selected.size,
      okPaths: this.deleteResult?.ok ?? [],
      failedPaths: this.deleteResult?.failed ?? [],
    });
    this.contentEl.empty();
  }

  private renderShell(): void {
    const { contentEl } = this;
    contentEl.empty();
    const shell = contentEl.createDiv({ cls: 'bdnsync-modal-shell' });
    const subtitle = this.opts.autoMode
      ? `同步结束巡检：候选保留天数 ${this.opts.retentionDays ?? 0}（超过该天数才进入）`
      : `扫描范围：父目录 ${this.parentDir} + vault 自身目录（含子树，消除扫描盲区）`;
    createModalHeader(shell, {
      title: this.opts.autoMode ? '发现疑似孤儿备份' : '扫描并清理网盘备份',
      icon: 'trash-2',
      subtitle,
      danger: true,
    });
    this.bodyEl = shell.createDiv({ cls: 'bdnsync-modal-body' });
    this.footerEl = shell.createDiv({ cls: 'bdnsync-modal-foot' });
  }

  /** v2.1：主入口调用的「后台深度扫描」入口。先展示「正在扫描…」，扫描完成后回填列表。
   *  U1 修复：扫描不再阻塞弹窗打开（main.ts 先 open 再调本方法），用户能实时看到进度状态。 */
  async startDeepScan(scanFn: () => Promise<DeepScanResult>): Promise<void> {
    this.phase = 'scanning';
    this.renderBody();
    this.renderFooter();
    try {
      const result = await scanFn();
      // F4 修复：目录类候选缺省 bytes=0，测量补齐后再展示
      const measured = await this.measureDirFindings(result.findings);
      this.findings = measured;
      this.scanStats = {
        scannedNodes: result.scannedNodes,
        scannedBytes: result.scannedBytes,
        truncated: result.truncated,
        durationMs: result.durationMs,
        errors: result.errors,
      };
      this.lastScan = { findings: this.findings, stats: this.scanStats };
      this.phase = 'ready';
      // 按 risk ≥ 1 默认勾选；orphan-file/orphan-dir（risk=0）默认不勾（保守）
      for (const f of this.findings) {
        if (f.risk >= 1) this.selected.add(f.fullPath);
      }
      this.recomputeSummary();
      this.renderBody();
      this.renderFooter();
    } catch (e) {
      this.phase = 'done';
      this.bodyEl.empty();
      this.bodyEl.createEl('p', {
        cls: 'bdnsync-modal-subtitle',
        text: `扫描失败：${e instanceof Error ? e.message : String(e)}`,
      });
      this.footerEl.empty();
      this.footerEl
        .createEl('button', { text: '关闭', cls: 'bdnsync-btn' })
        .addEventListener('click', () => this.close());
    }
  }

  /** F4 修复：目录类候选（backup-dir / orphan-dir）缺省 bytes=0，用单层测量（measureOrphans）补齐。 */
  private async measureDirFindings(findings: OrphanFinding[]): Promise<OrphanFinding[]> {
    const dirs = findings.filter((f) => f.kind !== 'orphan-file' && f.bytes === 0);
    if (dirs.length === 0) return findings;
    const measured = await measureOrphans(
      this.lister,
      dirs.map<OrphanEntry>((f) => ({
        fullPath: f.fullPath,
        name: f.name,
        segments: f.segments,
        risk: f.risk,
        mtime: f.mtime,
        fileCount: 0,
        totalBytes: 0,
      })),
    );
    const byPath = new Map(measured.map((m) => [m.fullPath, m]));
    return findings.map((f) => {
      if (f.kind === 'orphan-file' || f.bytes > 0) return f;
      const m = byPath.get(f.fullPath);
      if (!m || m.measureError) return f;
      return { ...f, bytes: m.totalBytes };
    });
  }

  /**
   * @deprecated v2.1 起真实流程由 main.ts 预扫 + startDeepScan 驱动；本方法仅保留
   * 向后兼容（无 findings 传入时兜底走 legacy 1 层扫描 + 测量）。后续版本可删除。
   */
  private async scan(): Promise<void> {
    try {
      const rows: RemoteDirRow[] = await this.lister.listDir(this.parentDir);
      const candidates = pickOrphans(rows, this.vaultName);
      // autoMode 下按 mtime 距今 ≥ retentionDays 过滤
      let filtered = candidates;
      if (this.opts.autoMode && (this.opts.retentionDays ?? 0) > 0) {
        const cutoff = Date.now() - (this.opts.retentionDays ?? 0) * 24 * 3600 * 1000;
        filtered = candidates.filter((c) => c.mtime === 0 || c.mtime < cutoff);
      }
      const measured = await measureOrphans(this.lister, filtered);
      this.items = measured;
      // 默认勾选：autoMode 勾选高+中；manual 仅勾高（保守）
      for (const it of this.items) {
        if (this.opts.autoMode ? it.risk >= 1 : it.risk >= 2) {
          this.selected.add(it.fullPath);
        }
      }
      this.phase = 'ready';
      this.recomputeSummary();
      this.renderBody();
      this.renderFooter();
    } catch (e) {
      this.phase = 'done';
      this.bodyEl.empty();
      this.bodyEl.createEl('p', {
        cls: 'bdnsync-modal-subtitle',
        text: `扫描失败：${e instanceof Error ? e.message : String(e)}`,
      });
      this.footerEl.empty();
      this.footerEl
        .createEl('button', { text: '关闭', cls: 'bdnsync-btn' })
        .addEventListener('click', () => this.close());
    }
  }

  private recomputeSummary(): void {
    let totalBytes = 0;
    let totalCount = 0;
    let selectedBytes = 0;
    for (const it of this.iterActive()) {
      totalBytes += it.bytes;
      totalCount++;
      if (this.selected.has(it.fullPath)) selectedBytes += it.bytes;
    }
    this.summary = {
      total: totalCount,
      totalBytes,
      selectedCount: this.selected.size,
      selectedBytes,
    };
  }

  /** 统一迭代当前阶段的「活跃条目」：v2 走 findings；v1 走 items。 */
  private *iterActive(): Generator<{ fullPath: string; name: string; bytes: number; kind: string; risk: 0 | 1 | 2; relPath: string; reason: string; segments: number }> {
    if (this.findings.length > 0) {
      for (const f of this.findings) {
        yield {
          fullPath: f.fullPath,
          name: f.name,
          bytes: f.bytes,
          kind: f.kind,
          risk: f.risk,
          relPath: f.relPath,
          reason: f.reason,
          segments: f.segments,
        };
      }
      return;
    }
    for (const it of this.items) {
      yield {
        fullPath: it.fullPath,
        name: it.name,
        bytes: it.totalBytes,
        kind: 'backup-dir',
        risk: it.risk,
        relPath: '',
        reason: it.risk === 2 ? `高风险：${it.segments} 段时间戳段叠加` : `中等风险：${it.segments} 段时间戳段`,
        segments: it.segments,
      };
    }
  }

  /** 按 kind 分组（仅 v2 有意义） */
  private groupFindings(): { backupDir: OrphanFinding[]; orphanFile: OrphanFinding[]; orphanDir: OrphanFinding[] } {
    const out = { backupDir: [] as OrphanFinding[], orphanFile: [] as OrphanFinding[], orphanDir: [] as OrphanFinding[] };
    for (const f of this.findings) {
      if (f.kind === 'backup-dir') out.backupDir.push(f);
      else if (f.kind === 'orphan-file') out.orphanFile.push(f);
      else if (f.kind === 'orphan-dir') out.orphanDir.push(f);
    }
    return out;
  }

  private renderBody(): void {
    this.bodyEl.empty();
    if (this.phase === 'scanning' || this.phase === 'deleting') {
      this.bodyEl.createEl('p', {
        cls: 'bdnsync-modal-subtitle',
        text:
          this.phase === 'scanning'
            ? '正在扫描…'
            : `正在删除（剩 ${this.summary.total - this.summary.selectedCount} 条未选中）…`,
      });
      return;
    }
    if (this.phase === 'done' && this.deleteResult) {
      const { ok, failed } = this.deleteResult;
      const sum = createCard(this.bodyEl, 'bdnsync-orphan-summary');
      sum.createEl('p', {
        cls: 'bdnsync-callout-text',
        text: `✓ 成功删除 ${ok.length} 个目录`,
      });
      if (failed.length > 0) {
        sum.createEl('p', {
          cls: 'bdnsync-callout-text',
          text: `✗ 失败 ${failed.length} 个（详见下方）`,
        });
        // P0-orphan-UX 失败明细增强：每条都显示完整绝对路径 + 错误，便于定位。
        // 之前只显示 basename 时（即 fix 之前的 bug）用户看不出「路径不全」是元凶。
        const list = sum.createDiv({ cls: 'bdnsync-orphan-failed-list' });
        for (const f of failed.slice(0, 20)) {
          const row = list.createDiv({
            cls: 'bdnsync-orphan-failed-row',
            attr: { title: `${f.path}\n\n${f.error}` },
          });
          const nameSpan = row.createEl('div', { cls: 'bdnsync-orphan-failed-name' });
          // 路径渲染：把父目录前缀灰一些，让 basename 突出
          const full = f.path || '';
          const lastSlash = full.lastIndexOf('/');
          if (lastSlash > 0) {
            nameSpan.createEl('span', {
              cls: 'bdnsync-orphan-failed-parent',
              text: full.slice(0, lastSlash + 1),
            });
            nameSpan.createEl('span', {
              cls: 'bdnsync-orphan-failed-base',
              text: full.slice(lastSlash + 1),
            });
          } else {
            nameSpan.setText(full);
          }
          row.createEl('div', {
            cls: 'bdnsync-orphan-failed-err',
            text: f.error,
          });
        }
        if (failed.length > 20) {
          list.createEl('div', {
            text: `…还有 ${failed.length - 20} 条，已写入 SyncLog（模块 cleanup）`,
            cls: 'bdnsync-orphan-failed-row bdnsync-orphan-failed-more',
          });
        }
        // 失败诊断 + 重试 / 复制 操作行
        const actions = sum.createDiv({ cls: 'bdnsync-orphan-failed-actions' });
        createIconButton(actions, {
          icon: 'rotate-cw',
          label: `重试 ${failed.length} 个失败项`,
          onClick: () => void this.retryFailed(),
        });
        createIconButton(actions, {
          icon: 'copy',
          label: '复制全部失败',
          title: '把失败清单复制到剪贴板（便于粘贴到 Bug 报告）',
          onClick: () => void this.copyFailedToClipboard(),
        });
        // 诊断提示
        const hint = sum.createDiv({ cls: 'bdnsync-orphan-failed-hint' });
        hint.createEl('div', { text: '💡 常见原因：', cls: 'bdnsync-orphan-failed-hint-title' });
        const hints = [
          '路径不合法（errno=-7）：通常是「父目录已不存在」或「特殊字符」；hover 行查看完整路径。',
          '文件不存在（errno=-9）：目录可能已被其它工具/手动操作删除，可直接重试。',
          '部分失败（errno=12）：批量删除时单条失败，不影响其它项；重试即可。',
          '操作频繁（errno=31039/31034）：等 1–2 分钟再重试。',
        ];
        for (const h of hints) {
          hint.createEl('div', { text: h, cls: 'bdnsync-orphan-failed-hint-row' });
        }
      }
      return;
    }

    // ready
    let activeCount = 0;
    for (const _ of this.iterActive()) {
      activeCount++;
      break;
    }
    if (activeCount === 0) {
      this.bodyEl.createEl('p', {
        cls: 'bdnsync-modal-subtitle',
        text: '没有发现疑似孤儿备份目录。扫描范围：' + this.parentDir,
      });
      return;
    }

    const head = this.bodyEl.createDiv({ cls: 'bdnsync-orphan-head' });
    head.createEl('div', {
      cls: 'bdnsync-orphan-count',
      text: `候选 ${this.summary.total} 个（合计 ${formatBytes(this.summary.totalBytes)}）`,
    });
    head.createEl('div', {
      cls: 'bdnsync-orphan-count',
      text: `已选 ${this.summary.selectedCount} 个（${formatBytes(this.summary.selectedBytes)}）`,
    });

    // v2 扫描统计摘要（仅当主入口传入了 scanStats 时显示）
    if (this.scanStats) {
      const statsLine = head.createDiv({ cls: 'bdnsync-orphan-count bdnsync-orphan-stats' });
      statsLine.style.opacity = '0.85';
      statsLine.style.fontSize = '12px';
      const modeLabel =
        this.opts.scanMode === 'parent-only'
          ? '父目录单层'
          : this.opts.scanMode === 'scoped'
          ? '父目录 + vault 顶层'
          : '深度遍历（full-vault）';
      const parts = [
        `扫描模式：${modeLabel}`,
        `访问节点 ${this.scanStats.scannedNodes} 个`,
        `累计字节 ${formatBytes(this.scanStats.scannedBytes)}`,
      ];
      if (this.scanStats.durationMs > 0) parts.push(`耗时 ${this.scanStats.durationMs} ms`);
      if (this.scanStats.truncated) parts.push('⚠️ 已达节点/字节预算上限，结果可能不完整');
      statsLine.textContent = parts.join('  ·  ');
      if (this.scanStats.errors.length > 0) {
        const errLine = head.createDiv({ cls: 'bdnsync-orphan-stats-err' });
        errLine.style.color = '#c97';
        errLine.style.fontSize = '12px';
        errLine.textContent = `扫描期遇到 ${this.scanStats.errors.length} 个错误（前 3 条）：${this.scanStats.errors
          .slice(0, 3)
          .map((e) => `${e.path} (${e.message})`)
          .join('；')}`;
      }
    }

    // 全选 / 清除选择 工具栏：便于对 4+ 个候选做批量勾选（修复 #80 缺陷 3）
    const toolbar = this.bodyEl.createDiv({ cls: 'bdnsync-orphan-toolbar' });
    toolbar.style.display = 'flex';
    toolbar.style.gap = '8px';
    toolbar.style.margin = '8px 0';
    toolbar.style.flexWrap = 'wrap';
    toolbar.style.alignItems = 'center';
    const selectAllBtn = toolbar.createEl('button', { text: '全选', cls: 'bdnsync-btn' });
    selectAllBtn.style.minWidth = '64px';
    selectAllBtn.addEventListener('click', () => this.toggleSelectAll(true));
    const clearSelBtn = toolbar.createEl('button', { text: '清除选择', cls: 'bdnsync-btn' });
    clearSelBtn.style.minWidth = '80px';
    clearSelBtn.addEventListener('click', () => this.toggleSelectAll(false));

    // v2：按 kind 分组批量勾选（备份目录 / 孤儿文件 / 孤儿目录）
    if (this.findings.length > 0) {
      const groups = this.groupFindings();
      const labels: Array<{ key: 'backupDir' | 'orphanFile' | 'orphanDir'; text: string }> = [
        { key: 'backupDir', text: `勾选备份目录 (${groups.backupDir.length})` },
        { key: 'orphanFile', text: `勾选孤儿文件 (${groups.orphanFile.length})` },
        { key: 'orphanDir', text: `勾选孤儿目录 (${groups.orphanDir.length})` },
      ];
      for (const g of labels) {
        const list = groups[g.key];
        if (list.length === 0) continue;
        const btn = toolbar.createEl('button', {
          text: g.text,
          cls: 'bdnsync-btn',
        });
        btn.style.fontSize = '12px';
        btn.addEventListener('click', () => {
          // X1 修复：孤儿文件/孤儿目录为 risk=0 低风险候选（基于 sync index 判定，
          // 可能存在误报），一键全组勾选前先弹确认，防止误删。
          const isLowRiskGroup = g.key !== 'backupDir';
          void (async () => {
            if (isLowRiskGroup) {
              const ok = await this.confirmLowRiskSelect(g.text, list.length);
              if (!ok) return;
            }
            for (const f of list) this.selected.add(f.fullPath);
            this.recomputeSummary();
            this.renderBody();
            this.renderFooter();
          })();
        });
      }
    }

    // 候选行也展示完整绝对路径（hover 可见），避免「选中后才发现只勾到 basename」的歧义
    const list = this.bodyEl.createDiv({ cls: 'bdnsync-orphan-list' });
    if (this.findings.length > 0) {
      // v2：按 kind 分组渲染，每组带标题
      const groups = this.groupFindings();
      this.renderFindingGroup(list, '备份目录（vault 名 + 时间戳段）', groups.backupDir, 'backup-dir');
      this.renderFindingGroup(list, '孤儿文件（不在 sync index 中）', groups.orphanFile, 'orphan-file');
      this.renderFindingGroup(list, '孤儿目录（空 / 全是孤儿子项）', groups.orphanDir, 'orphan-dir');
    } else {
      // v1 legacy：单列表
      for (const it of this.items) {
        this.renderLegacyRow(list, it);
      }
    }

    // 来源诊断块：在候选下方显示一条简短说明，帮助用户理解为什么会产生孤儿
    const source = this.bodyEl.createDiv({ cls: 'bdnsync-orphan-source-hint' });
    source.createEl('div', { text: '为什么会有这些孤儿备份？', cls: 'bdnsync-orphan-source-hint-title' });
    const sourceItems = [
      '这些目录并非当前 BDNSync 写入；可能是旧版本残留 / 手动网盘操作 / 其它同步插件并发冲突累积。',
      '预防建议：避免在网盘 Web 端直接重命名 vault 根；同一时间不要让两个同步工具写入同一父目录。',
      // F5 提示：孤儿文件/孤儿目录基于本地同步索引（LocalIndex）判定，索引未全量时可能误列
      '孤儿文件 / 孤儿目录依据本地同步索引判定：若索引刚重置或尚未全量同步，可能误列，删除前请核对预览清单。',
    ];
    for (const s of sourceItems) {
      source.createEl('div', { text: s, cls: 'bdnsync-orphan-source-hint-row' });
    }
  }

  /** v2：按组渲染一组 findings；kindLabel 用于分组标题 */
  private renderFindingGroup(
    container: HTMLElement,
    title: string,
    findings: OrphanFinding[],
    kindLabel: 'backup-dir' | 'orphan-file' | 'orphan-dir',
  ): void {
    if (findings.length === 0) return;
    const groupEl = container.createDiv({ cls: 'bdnsync-orphan-group' });
    groupEl.createEl('div', {
      text: `${title}（${findings.length}）`,
      cls: 'bdnsync-orphan-group-title',
    });
    for (const f of findings) {
      const row = groupEl.createDiv({ cls: 'bdnsync-orphan-row' });
      // X3：为复选框提供 aria-label，便于读屏器（路径 + 类别 + 风险）
      const kindText = kindLabel === 'backup-dir' ? '备份目录' : kindLabel === 'orphan-file' ? '孤儿文件' : '孤儿目录';
      const cb = row.createEl('input', {
        type: 'checkbox',
        attr: { 'aria-label': `勾选 ${kindText}：${f.name}（风险 ${f.risk}）` },
      });
      cb.checked = this.selected.has(f.fullPath);
      cb.addEventListener('change', () => {
        if (cb.checked) this.selected.add(f.fullPath);
        else this.selected.delete(f.fullPath);
        this.recomputeSummary();
        const counts = this.bodyEl.querySelectorAll('.bdnsync-orphan-count');
        if (counts[1]) {
          counts[1].textContent = `已选 ${this.summary.selectedCount} 个（${formatBytes(this.summary.selectedBytes)}）`;
        }
        this.updateFooterDeleteState();
      });
      const main = row.createDiv({ cls: 'bdnsync-orphan-main' });
      const pathDisplay = f.relPath ? f.relPath : f.name;
      main.createEl('div', {
        cls: 'bdnsync-orphan-name',
        text: f.name,
        attr: {
          title: `完整路径：${f.fullPath}\n\n相对 vault：${pathDisplay}\n深度：${f.depth}\n类别：${kindLabel}\n原因：${f.reason}`,
        },
      });
      const meta = main.createDiv({ cls: 'bdnsync-orphan-meta' });
      const kindBadge = kindLabel === 'backup-dir' ? '备份目录' : kindLabel === 'orphan-file' ? '孤儿文件' : '孤儿目录';
      const kindStyle: 'error' | 'warning' | 'info' =
        kindLabel === 'backup-dir' && f.risk === 2
          ? 'error'
          : kindLabel === 'backup-dir' && f.risk === 1
          ? 'warning'
          : 'info';
      createBadge(meta, kindBadge, kindStyle);
      // v2.2：来源层徽标（父目录层 / vault 自身层），让用户一眼看清孤儿项来自哪一层
      if (f.origin) {
        const originText = f.origin === 'parent' ? '父目录层' : 'vault 自身层';
        createBadge(meta, originText, 'info');
      }
      if (kindLabel === 'backup-dir' && f.segments > 0) {
        const riskLabel = f.risk === 2 ? '高风险' : f.risk === 1 ? '中等' : '低';
        createBadge(meta, `风险 ${riskLabel}`, f.risk === 2 ? 'error' : f.risk === 1 ? 'warning' : 'info');
        createBadge(meta, `${f.segments} 段时间戳`, 'info');
      }
      if (f.bytes > 0) createBadge(meta, formatBytes(f.bytes), 'info');
      else if (kindLabel === 'orphan-dir' || kindLabel === 'backup-dir') {
        createBadge(meta, '空 / 仅目录', 'info');
      }
      if (f.mtime) createBadge(meta, formatTime(f.mtime), 'info');
      if (f.depth > 1) createBadge(meta, `深度 ${f.depth}`, 'info');
    }
  }

  /** v1 legacy 单行渲染（保留向后兼容） */
  private renderLegacyRow(container: HTMLElement, it: OrphanEntry): void {
    const row = container.createDiv({ cls: 'bdnsync-orphan-row' });
    // X3：为复选框提供 aria-label，便于读屏器
    const cb = row.createEl('input', {
      type: 'checkbox',
      attr: { 'aria-label': `勾选备份目录：${it.name}（风险 ${it.risk}）` },
    });
    cb.checked = this.selected.has(it.fullPath);
    cb.addEventListener('change', () => {
      if (cb.checked) this.selected.add(it.fullPath);
      else this.selected.delete(it.fullPath);
      this.recomputeSummary();
      const counts = this.bodyEl.querySelectorAll('.bdnsync-orphan-count');
      if (counts[1]) {
        counts[1].textContent = `已选 ${this.summary.selectedCount} 个（${formatBytes(this.summary.selectedBytes)}）`;
      }
      // 修复 #80 缺陷 1：勾选变化必须同步刷新底部「删除选中 (N)」按钮的文案与禁用态，
      // 否则按钮数字永远停在初始值、且取消到 0 后仍可被点击。
      this.updateFooterDeleteState();
    });
    const main = row.createDiv({ cls: 'bdnsync-orphan-main' });
    main.createEl('div', {
      cls: 'bdnsync-orphan-name',
      text: it.name,
      attr: {
        title: `完整路径：${it.fullPath}\n\n时间戳段：${it.segments}\n风险：${
          it.risk === 2 ? '高' : it.risk === 1 ? '中' : '低'
        }`,
      },
    });
    const meta = main.createDiv({ cls: 'bdnsync-orphan-meta' });
    const riskLabel = it.risk === 2 ? '高风险' : it.risk === 1 ? '中等' : '低';
    createBadge(meta, `风险 ${riskLabel}`, it.risk === 2 ? 'error' : it.risk === 1 ? 'warning' : 'info');
    createBadge(meta, `${it.segments} 段时间戳`, 'info');
    if (it.measureError) {
      // 修复 #80 缺陷 2：列出子项失败 ≠ 空目录，显式标「测量失败」避免误导
      createBadge(meta, '测量失败', 'warning');
    } else {
      createBadge(meta, `${it.fileCount} 文件 · ${formatBytes(it.totalBytes)}`, 'info');
    }
    if (it.mtime) {
      createBadge(meta, formatTime(it.mtime), 'info');
    }
  }

  private renderFooter(): void {
    this.footerEl.empty();
    if (this.phase === 'scanning') return;
    if (this.phase === 'deleting') {
      this.footerEl.createEl('p', {
        cls: 'bdnsync-modal-subtitle',
        text: '正在删除…',
      });
      return;
    }
    if (this.phase === 'done') {
      this.footerEl
        .createEl('button', { text: '关闭', cls: 'bdnsync-btn bdnsync-btn-primary' })
        .addEventListener('click', () => this.close());
      return;
    }
    // ready
    let activeCount = 0;
    for (const _ of this.iterActive()) {
      activeCount++;
      break;
    }
    if (activeCount === 0) {
      this.footerEl
        .createEl('button', { text: '关闭', cls: 'bdnsync-btn' })
        .addEventListener('click', () => this.close());
      return;
    }
    // v2：底部显示「送回收站 / 永久删除」提示
    const recycleHint = this.footerEl.createDiv({ cls: 'bdnsync-orphan-recycle-hint' });
    recycleHint.style.fontSize = '12px';
    recycleHint.style.opacity = '0.7';
    recycleHint.style.margin = '0 0 4px 0';
    if (this.useRecycleBin) {
      recycleHint.textContent = '✓ 删除模式：先送回收站（可逆）—— 永久删除请到网盘 Web 端回收站手动清空。';
    } else {
      // X2 修复：明确「百度 API 无跳过回收站接口」，避免用户误以为关闭该选项即真正永久删除
      recycleHint.textContent = '⚠ 删除模式：永久删除（百度网盘限制：仍会进回收站，需到网盘 Web 端回收站手动清空）';
      recycleHint.style.color = '#c97';
    }
    const deleteBtn = this.footerEl.createEl('button', {
      text: `删除选中（${this.summary.selectedCount}）`,
      cls: 'bdnsync-btn bdnsync-btn-danger',
    });
    deleteBtn.disabled = this.selected.size === 0;
    deleteBtn.addEventListener('click', () => void this.confirmAndDelete());
    this.deleteBtn = deleteBtn;
    // v2：v2 时附一个「导出预览清单」按钮，方便用户先留档再删
    if (this.findings.length > 0) {
      const exportBtn = this.footerEl.createEl('button', {
        text: '复制预览清单',
        cls: 'bdnsync-btn',
      });
      exportBtn.style.marginLeft = '8px';
      exportBtn.addEventListener('click', () => void this.copyPreviewToClipboard());
    }
    this.footerEl
      .createEl('button', {
        text: this.opts.autoMode ? '暂不处理（仅记日志）' : '取消',
        cls: 'bdnsync-btn',
      })
      .addEventListener('click', () => this.close());
  }

  /** 复制预览清单（kind / 完整路径 / 风险 / 字节 / mtime）到剪贴板 */
  private async copyPreviewToClipboard(): Promise<void> {
    const lines: string[] = [];
    lines.push(`BDNSync orphan 预览清单（${new Date().toLocaleString()}）`);
    lines.push(`扫描模式：${this.opts.scanMode ?? 'parent-only'}`);
    lines.push(`扫描范围：父目录 ${this.parentDir} / 同步根 ${this.opts.findings?.length ?? 0} 项`);
    if (this.scanStats) {
      lines.push(
        `访问节点 ${this.scanStats.scannedNodes} / 累计字节 ${this.scanStats.scannedBytes} / 耗时 ${this.scanStats.durationMs}ms` +
          (this.scanStats.truncated ? '（已截断）' : ''),
      );
    }
    lines.push('');
    const groups = this.groupFindings();
    const pushGroup = (title: string, list: OrphanFinding[]) => {
      if (list.length === 0) return;
      lines.push(`── ${title}（${list.length}） ──`);
      for (const f of list) {
        lines.push(
          `[${f.kind}] ${f.fullPath}` +
            ` | 风险=${f.risk}` +
            ` | 段=${f.segments}` +
            ` | 字节=${f.bytes}` +
            ` | mtime=${f.mtime ? formatTime(f.mtime) : '0'}` +
            ` | 来源=${f.origin ?? 'parent'}` +
            (f.relPath ? ` | rel=${f.relPath}` : ''),
        );
      }
      lines.push('');
    };
    pushGroup('备份目录', groups.backupDir);
    pushGroup('孤儿文件', groups.orphanFile);
    pushGroup('孤儿目录', groups.orphanDir);
    const text = lines.join('\n');
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      new Notice(`BDNSync：已复制 ${this.findings.length} 条预览到剪贴板`);
    } catch {
      new Notice('BDNSync：复制失败，请手动选中');
    }
  }

  /**
   * 修复 #80 缺陷 1：勾选变化时原地刷新底部「删除选中 (N)」按钮，
   * 避免按钮文案停留在初始值、且选中数归零后仍可点击。
   * renderFooter 每次重建按钮后会同步刷新 this.deleteBtn 引用。
   */
  private updateFooterDeleteState(): void {
    if (!this.deleteBtn) return;
    this.deleteBtn.textContent = `删除选中（${this.selected.size}）`;
    this.deleteBtn.disabled = this.selected.size === 0;
  }

  /**
   * 修复 #80 缺陷 3：全选 / 清除选择。直接改写 selected 集合后重渲 body+footer，
   * 保证复选框勾选态、头部计数、底部按钮三者一致。
   * X1 修复：若候选里包含 risk=0 项（孤儿文件/孤儿目录），「全选」前先弹确认——
   * 防止一键绕过「仅预选 backup-dir」的保守默认造成误删。
   */
  private toggleSelectAll(select: boolean): void {
    this.selected.clear();
    if (select) {
      const hasLowRisk = [...this.iterActive()].some((it) => it.risk === 0);
      if (hasLowRisk) {
        void this.confirmLowRiskSelect('全部候选', this.summary.total).then((ok) => {
          if (!ok) return;
          for (const it of this.iterActive()) this.selected.add(it.fullPath);
          this.recomputeSummary();
          this.renderBody();
          this.renderFooter();
        });
        return;
      }
      for (const it of this.iterActive()) this.selected.add(it.fullPath);
    }
    this.recomputeSummary();
    this.renderBody();
    this.renderFooter();
  }

  /** X1 修复：低风险批量勾选前的二次确认（孤儿文件/孤儿目录基于 sync index 判定，可能有误报）。 */
  private confirmLowRiskSelect(label: string, count: number): Promise<boolean> {
    if (count <= 0) return Promise.resolve(true);
    return showConfirmModal(this.app, {
      title: `批量勾选「${label}」`,
      message:
        `将选中 ${count} 个低风险候选。孤儿文件 / 孤儿目录依据本地同步索引判定，` +
        '索引未全量或刚重置时可能存在误报。请先核对预览清单（可「复制预览清单」留档）后再继续。',
      confirmText: '仍要勾选',
      cancelText: '取消',
      danger: false,
    });
  }

  /** 把「当前选中的活跃条目」投影成 OrphanEntry（仅用于传给 deleteOrphans） */
  private collectSelectedAsOrphanEntries(): OrphanEntry[] {
    if (this.findings.length > 0) {
      return this.findings
        .filter((f) => this.selected.has(f.fullPath))
        .map<OrphanEntry>((f) => ({
          fullPath: f.fullPath,
          name: f.name,
          segments: f.segments,
          risk: f.risk,
          mtime: f.mtime,
          fileCount: 0,
          totalBytes: f.bytes,
        }));
    }
    return this.items.filter((it) => this.selected.has(it.fullPath));
  }

  private async confirmAndDelete(): Promise<void> {
    const selectedItems = this.collectSelectedAsOrphanEntries();
    if (selectedItems.length === 0) return;
    const threshold = this.opts.bulkConfirmThreshold ?? 50;
    if (selectedItems.length >= threshold) {
      const ok = await this.askBulkConfirm(selectedItems.length);
      if (!ok) return;
    }

    this.phase = 'deleting';
    this.renderBody();
    this.renderFooter();
    this.deleteResult = await deleteOrphans(this.deleter, selectedItems, {
      confirmedByUser: true,
      retries: 2,
      delayMs: 300,
      useRecycleBin: this.useRecycleBin,
    });
    this.phase = 'done';
    this.recomputeSummary();
    this.renderBody();
    this.renderFooter();
    const ok = this.deleteResult.ok.length;
    const fail = this.deleteResult.failed.length;
    const recycleLabel = this.useRecycleBin ? '回收站' : '永久';
    new Notice(
      `BDNSync orphan 清理（${recycleLabel}）：成功 ${ok}` + (fail ? `、失败 ${fail}（见日志模块 cleanup）` : ''),
    );
  }

  /**
   * P0-orphan-UX：失败项一键重试。仅对上次失败的子集再次删除，避免用户重新走整轮
   * 选 + 确认流程。重试结果会**合并**到 deleteResult（成功的从 failed 移到 ok，失败仍留 failed）。
   * 阈值仍走 bulkConfirmThreshold：若重试数仍 ≥ 阈值会要求再次输入 DELETE。
   */
  private async retryFailed(): Promise<void> {
    const prev = this.deleteResult;
    if (!prev || prev.failed.length === 0) return;
    const failedFullPaths = new Set(prev.failed.map((f) => f.path));
    const failedItems: OrphanEntry[] = this.collectSelectedAsOrphanEntries().filter((it) =>
      failedFullPaths.has(it.fullPath),
    );
    // 兼容旧路径：collectSelectedAsOrphanEntries 只返回当前 selected；这里需要从 findings/items
    // 直接映射失败集合（防止用户在重试前取消了勾选）
    let actualFailed: OrphanEntry[] = failedItems;
    if (actualFailed.length === 0) {
      const lookup = new Map<string, OrphanEntry>();
      if (this.findings.length > 0) {
        for (const f of this.findings) {
          lookup.set(f.fullPath, {
            fullPath: f.fullPath,
            name: f.name,
            segments: f.segments,
            risk: f.risk,
            mtime: f.mtime,
            fileCount: 0,
            totalBytes: f.bytes,
          });
        }
      } else {
        for (const it of this.items) lookup.set(it.fullPath, it);
      }
      actualFailed = prev.failed
        .map((f) => lookup.get(f.path))
        .filter((x): x is OrphanEntry => !!x);
    }
    if (actualFailed.length === 0) return;

    const threshold = this.opts.bulkConfirmThreshold ?? 50;
    if (actualFailed.length >= threshold) {
      const ok = await this.askBulkConfirm(actualFailed.length);
      if (!ok) return;
    }

    this.phase = 'deleting';
    this.renderBody();
    this.renderFooter();
    const r = await deleteOrphans(this.deleter, actualFailed, {
      confirmedByUser: true,
      retries: 3, // 重试时给更多次数，常见瞬态错误（31034/31039）第二次就能过
      delayMs: 500,
      useRecycleBin: this.useRecycleBin,
    });
    // 合并结果：之前 ok 的保留 + 本次 ok；之前 failed 中重试 ok 的转 ok，仍 fail 的留 failed
    const okSet = new Set(r.ok);
    const stillFailed = prev.failed
      .filter((f) => !okSet.has(f.path))
      .map((f) => {
        const updated = r.failed.find((x) => x.path === f.path);
        return updated ?? f;
      });
    this.deleteResult = {
      ok: [...prev.ok, ...r.ok],
      failed: stillFailed,
    };
    this.phase = 'done';
    this.recomputeSummary();
    this.renderBody();
    this.renderFooter();
    const okN = r.ok.length;
    const failN = r.failed.length;
    new Notice(
      `BDNSync orphan 重试：成功 ${okN}` + (failN ? `、仍失败 ${failN}（可稍后再试）` : ' ✅'),
    );
  }

  /**
   * 把失败清单复制到剪贴板（含绝对路径 + 错误），便于粘贴到 SyncLog 或 Bug 报告。
   * Obsidian 浏览器环境 navigator.clipboard 在非安全上下文可能不可用，兜底用临时 textarea。
   */
  private async copyFailedToClipboard(): Promise<void> {
    const prev = this.deleteResult;
    if (!prev || prev.failed.length === 0) return;
    const text =
      `BDNSync orphan 清理失败清单（${new Date().toLocaleString()}）\n` +
      `扫描父目录：${this.parentDir}\n` +
      `vault：${this.vaultName}\n\n` +
      prev.failed.map((f, i) => `${i + 1}. ${f.path}\n   ${f.error}`).join('\n\n') +
      '\n';
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      new Notice(`BDNSync：已复制 ${prev.failed.length} 条失败到剪贴板`);
    } catch {
      new Notice('BDNSync：复制失败，请手动选中');
    }
  }

  /**
   * 数量 ≥ 阈值时强制要求输入 "DELETE" 二次确认（避免误点）。
   * 这里用 ConfirmModal 作为框架，但额外注入一个输入框 + 锁定确认按钮。
   * 返回 Promise<boolean>：true 表示确认通过；false 表示取消或输入错误。
   */
  private askBulkConfirm(count: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const modal = new ConfirmModal(
        this.app,
        '确认批量删除',
        `即将删除 ${count} 个网盘目录，累计 ${formatBytes(this.summary.selectedBytes)}。该操作不可恢复。\n\n如确要继续，请输入 DELETE：`,
        '确认删除',
        true,
      );
      const wireGate = () => {
        const shell = modal.modalEl.querySelector('.bdnsync-modal-shell');
        if (!shell || shell.querySelector('.bdnsync-confirm-input-wrap')) return;
        const wrap = document.createElement('div');
        wrap.className = 'bdnsync-confirm-input-wrap';
        const label = document.createElement('label');
        label.className = 'bdnsync-confirm-input-label';
        label.textContent = '请输入 DELETE 以确认：';
        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = 'DELETE';
        input.className = 'bdnsync-input';
        input.autocomplete = 'off';
        const lockConfirm = () => {
          const btns = modal.modalEl.querySelectorAll('button');
          for (const b of Array.from(btns)) {
            if (b.textContent === '确认删除') {
              (b as HTMLButtonElement).disabled = input.value !== 'DELETE';
            }
          }
        };
        input.addEventListener('input', lockConfirm);
        // 阻止回车直接关闭（避免未输入就跳过）
        input.addEventListener('keydown', (ev) => {
          if ((ev as KeyboardEvent).key === 'Enter') {
            ev.stopPropagation();
            if (input.value === 'DELETE') {
              const btns = modal.modalEl.querySelectorAll('button');
              for (const b of Array.from(btns)) {
                if (b.textContent === '确认删除') (b as HTMLButtonElement).click();
              }
            }
          }
        });
        label.appendChild(input);
        wrap.appendChild(label);
        shell.appendChild(wrap);
        lockConfirm();
        // 输入框获得焦点
        setTimeout(() => input.focus(), 30);
      };
      // ConfirmModal 在 super.open 时立刻走 onOpen 渲染，下一帧再注入
      setTimeout(wireGate, 0);
      void modal.open().then((v) => resolve(!!v));
    });
  }
}
