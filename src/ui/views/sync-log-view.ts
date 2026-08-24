// 同步日志：改为 Obsidian 标签页（ItemView），在主区域作为新标签打开
// 替代旧的 SyncLogModal，避免弹窗宽度受限 / 字符竖排等问题

import { ItemView, WorkspaceLeaf, Notice } from 'obsidian';
import type { LogLevel, LogFilter, SyncLogEntry } from '../../types';
import type { Logger } from '../../util/logger';
import { createIconButton, createModalHeader, setIcon, showConfirmModal } from '../components';

export const VIEW_TYPE_BDNSYNC_LOG = 'bdnsync-log';

export class SyncLogView extends ItemView {
  private viewMode: 'list' | 'timeline' = 'list';
  private typeFilter: Set<SyncLogEntry['type']> = new Set();
  private minLevel: LogLevel = 'debug';
  private keyword = '';
  private from = '';
  private to = '';
  private listContainer!: HTMLElement;

  constructor(
    leaf: WorkspaceLeaf,
    private logger: Logger,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_BDNSYNC_LOG;
  }
  getDisplayText(): string {
    return 'BDNSync 同步日志';
  }
  getIcon(): string {
    return 'activity';
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass('bdnsync-view', 'bdnsync-log-view');

    const shell = root.createDiv({ cls: 'bdnsync-modal-shell bdnsync-view-shell' });
    const head = createModalHeader(shell, {
      title: '同步日志',
      icon: 'activity',
      subtitle: '支持按时间范围、级别、类型与关键字整合筛选，并可导出排查',
    });

    const toolbar = head.head.createDiv({ cls: 'bdnsync-log-toolbar' });
    createIconButton(toolbar, {
      icon: 'filter',
      label: '列表',
      primary: this.viewMode === 'list',
      onClick: () => {
        this.viewMode = 'list';
        this.renderList();
      },
    });
    createIconButton(toolbar, {
      icon: 'timeline',
      label: '时间线',
      primary: this.viewMode === 'timeline',
      onClick: () => {
        this.viewMode = 'timeline';
        this.renderList();
      },
    });

    const body = shell.createDiv({ cls: 'bdnsync-modal-body' });

    const filterBar = body.createDiv({ cls: 'bdnsync-log-filterbar' });
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

    const listContainer = body.createDiv({ cls: 'bdnsync-log-list-container' });
    this.listContainer = listContainer;
    this.renderList();

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
  }

  async onClose(): Promise<void> {
    // no-op
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

  private renderList(): void {
    if (!this.listContainer) return;
    this.listContainer.empty();
    const filtered = this.logger.query(this.buildFilter());
    const stats = this.logger.tombstoneStats();

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
}
