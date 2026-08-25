// 同步日志：Obsidian 标签页（ItemView），在主区域作为新标签打开。
// 重构后特性：按日期分组 + 级别色彩 + 搜索（正则/高亮）+ 排序切换 + 实时订阅刷新
// + 级别/模块筛选 + 单条复制/导出 + 按筛选导出 txt/json。

import { ItemView, WorkspaceLeaf, Notice } from 'obsidian';
import type { LogLevel, LogFilter, LogModule, SyncLogEntry } from '../../types';
import { LEVEL_LABEL, MODULE_LABEL, Logger } from '../../util/logger';
import { createIconButton, createModalHeader, showConfirmModal, setIcon, type IconName } from '../components';

export const VIEW_TYPE_BDNSYNC_LOG = 'bdnsync-log';

const TYPE_LABEL: Record<SyncLogEntry['type'], string> = {
  upload: '上传',
  download: '下载',
  delete: '删除',
  conflict: '冲突',
  error: '错误',
  info: '信息',
};

const LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];
const MODULES: LogModule[] = [
  'general',
  'engine',
  'auth',
  'watcher',
  'browser',
  'ui',
  'netdisk',
  'crypto',
  'lab',
];

export class SyncLogView extends ItemView {
  private minLevel: LogLevel = 'debug';
  private levelFilter: Set<LogLevel> = new Set(); // 精确级别多选；空 = 不过滤
  private moduleFilter: Set<LogModule> = new Set(); // 模块多选；空 = 不过滤
  private keyword = '';
  private useRegex = false;
  private from = '';
  private to = '';
  private sort: 'desc' | 'asc' = 'desc';
  private includeTomb = false;

  private body!: HTMLElement;
  private listContainer!: HTMLElement;
  private statBar!: HTMLElement;
  private unsub: (() => void) | null = null;
  private pendingRender = false;

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
      subtitle: '按日期分组 · 级别色彩区分 · 支持搜索/过滤/排序/导出',
    });

    // ── 工具栏：搜索 + 正则 + 排序 + 刷新 ──
    const toolbar = head.head.createDiv({ cls: 'bdnsync-log-toolbar' });
    const searchWrap = toolbar.createDiv({ cls: 'bdnsync-log-search' });
    const searchInput = searchWrap.createEl('input', {
      cls: 'bdnsync-input bdnsync-log-search-input',
      attr: { type: 'text', placeholder: '搜索消息/路径/模块（支持正则）…' },
    }) as HTMLInputElement;
    searchInput.value = this.keyword;
    searchInput.addEventListener('input', () => {
      this.keyword = searchInput.value;
      this.scheduleRender();
    });
    createIconButton(toolbar, {
      icon: 'regex',
      label: '正则',
      title: '将搜索内容作为正则表达式解析（否则纯文本子串）',
      primary: this.useRegex,
      onClick: () => {
        this.useRegex = !this.useRegex;
        toolbar.querySelectorAll('.bdnsync-log-regex-btn').forEach((b) => {
          b.classList.toggle('bdnsync-btn-primary', this.useRegex);
        });
        this.scheduleRender();
      },
    }).addClass('bdnsync-log-regex-btn');
    createIconButton(toolbar, {
      icon: 'arrow-down-wide-narrow',
      label: '排序',
      title: '切换排序方向（最新优先 ⇄ 最早优先）',
      primary: true,
      onClick: () => {
        this.sort = this.sort === 'desc' ? 'asc' : 'desc';
        this.renderList();
      },
    }).addClass('bdnsync-log-sort-btn');

    const body = shell.createDiv({ cls: 'bdnsync-modal-body' });
    this.body = body;

    // ── 筛选栏：时间范围 + 最低级别 + 精确级别 chips + 模块 chips + 墓碑开关 ──
    const filterBar = body.createDiv({ cls: 'bdnsync-log-filterbar' });
    const mkField = (label: string): HTMLElement => {
      const f = filterBar.createDiv({ cls: 'bdnsync-log-field' });
      f.createEl('label', { text: label, cls: 'bdnsync-log-label' });
      return f;
    };
    const fromWrap = mkField('起始');
    const fromInput = fromWrap.createEl('input', {
      cls: 'bdnsync-input',
      attr: { type: 'date' },
    }) as HTMLInputElement;
    fromInput.value = this.from;
    fromInput.addEventListener('change', () => {
      this.from = fromInput.value;
      this.scheduleRender();
    });
    const toWrap = mkField('结束');
    const toInput = toWrap.createEl('input', {
      cls: 'bdnsync-input',
      attr: { type: 'date' },
    }) as HTMLInputElement;
    toInput.value = this.to;
    toInput.addEventListener('change', () => {
      this.to = toInput.value;
      this.scheduleRender();
    });
    const lvlWrap = mkField('最低级别');
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
      this.scheduleRender();
    });

    // 精确级别 chips（彩色）
    const levelChips = body.createDiv({ cls: 'bdnsync-log-filters bdnsync-log-chips-levels' });
    levelChips.createSpan({ text: '级别', cls: 'bdnsync-log-chips-label' });
    for (const l of LEVELS) {
      const chip = levelChips.createSpan({
        cls: `bdnsync-log-chip bdnsync-log-chip-level-${l}`,
      });
      chip.setText(LEVEL_LABEL[l]);
      chip.addEventListener('click', () => {
        if (this.levelFilter.has(l)) this.levelFilter.delete(l);
        else this.levelFilter.add(l);
        chip.classList.toggle('active', this.levelFilter.has(l));
        this.scheduleRender();
      });
    }

    // 模块 chips
    const modChips = body.createDiv({ cls: 'bdnsync-log-filters bdnsync-log-chips-modules' });
    modChips.createSpan({ text: '模块', cls: 'bdnsync-log-chips-label' });
    for (const m of MODULES) {
      const chip = modChips.createSpan({
        cls: `bdnsync-log-chip bdnsync-log-chip-module-${m}`,
      });
      chip.setText(MODULE_LABEL[m]);
      chip.addEventListener('click', () => {
        if (this.moduleFilter.has(m)) this.moduleFilter.delete(m);
        else this.moduleFilter.add(m);
        chip.classList.toggle('active', this.moduleFilter.has(m));
        this.scheduleRender();
      });
    }

    // ── 列表容器 + 统计条 ──
    this.statBar = body.createDiv({ cls: 'bdnsync-log-statbar' });
    const listContainer = body.createDiv({ cls: 'bdnsync-log-list-container' });
    this.listContainer = listContainer;

    // ── 底部操作：清空 / 复制 / 导出 ──
    const footer = shell.createDiv({ cls: 'bdnsync-modal-foot' });
    createIconButton(footer, {
      icon: 'trash-2',
      label: '清空全部',
      danger: true,
      onClick: async () => {
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
      },
    });
    createIconButton(footer, {
      icon: 'copy',
      label: '复制结果',
      onClick: async () => {
        await navigator.clipboard.writeText(this.logger.exportText(this.buildFilter()));
        new Notice('BDNSync：已复制筛选结果到剪贴板');
      },
    });
    createIconButton(footer, {
      icon: 'file-json',
      label: '导出 JSON',
      onClick: async () => {
        const json = this.logger.exportJSON(this.buildFilter());
        await this.downloadFile('bdnsync-logs.json', json, 'application/json');
        new Notice('BDNSync：已导出 JSON 日志');
      },
    });
    createIconButton(footer, {
      icon: 'file-text',
      label: '导出文本',
      onClick: async () => {
        const txt = this.logger.exportText(this.buildFilter());
        await this.downloadFile('bdnsync-logs.txt', txt, 'text/plain');
        new Notice('BDNSync：已导出文本日志');
      },
    });

    // 实时订阅：新日志到达时刷新（防抖，避免高频写入时 UI 抖动）
    this.unsub = this.logger.onEntry(() => this.scheduleRender());

    this.renderList();
  }

  async onClose(): Promise<void> {
    if (this.unsub) {
      this.unsub();
      this.unsub = null;
    }
  }

  /** 防抖渲染 */
  private scheduleRender(): void {
    if (this.pendingRender) return;
    this.pendingRender = true;
    window.setTimeout(() => {
      this.pendingRender = false;
      if (this.listContainer && this.listContainer.isConnected) this.renderList();
    }, 120);
  }

  private buildFilter(): LogFilter {
    const f: LogFilter = {
      minLevel: this.minLevel,
      sort: this.sort,
      regex: this.useRegex,
      includeTombstoned: this.includeTomb,
    };
    if (this.moduleFilter.size) f.modules = [...this.moduleFilter];
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

    // 将精确级别多选并入 minLevel 语义：若选了精确级别，则「仅这些级别」（取最高权重作为最小 + 额外包含）
    const filter = this.buildFilter();
    // 处理精确级别：Logger.query 用 minLevel 阈值；精确多选需在 query 后二次过滤
    const exactLevels = this.levelFilter.size ? this.levelFilter : null;
    const filtered = this.logger.query(filter).filter((e) => !exactLevels || exactLevels.has(e.level));

    this.renderStatBar(filtered);

    if (filtered.length === 0) {
      const empty = this.listContainer.createDiv({ cls: 'bdnsync-empty-state' });
      const iconWrap = empty.createSpan({ cls: 'bdnsync-empty-state-icon' });
      setIcon(iconWrap, 'filter', 28);
      empty.createSpan({ text: '当前筛选无匹配日志', cls: 'bdnsync-empty-state-text' });
      return;
    }

    // 按日期分组
    const groups = new Map<string, SyncLogEntry[]>();
    for (const e of filtered) {
      const d = new Date(e.time);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(e);
    }
    // 日期组排序（与整体排序方向一致）
    const groupKeys = Array.from(groups.keys()).sort((a, b) =>
      this.sort === 'desc' ? b.localeCompare(a) : a.localeCompare(b),
    );

    for (const dayKeyStr of groupKeys) {
      const entries = groups.get(dayKeyStr)!;
      const groupEl = this.listContainer.createDiv({ cls: 'bdnsync-log-group' });
      const header = groupEl.createDiv({ cls: 'bdnsync-log-group-header' });
      header.createSpan({ text: dayKeyStr, cls: 'bdnsync-log-group-date' });
      header.createSpan({
        text: `${entries.length} 条`,
        cls: 'bdnsync-log-group-count',
      });
      const list = groupEl.createDiv({ cls: 'bdnsync-log-list' });
      for (const log of entries) {
        list.appendChild(this.renderRow(log));
      }
    }
  }

  private renderRow(log: SyncLogEntry): HTMLElement {
    const row = document.createElement('div');
    row.className = `bdnsync-log-row bdnsync-log-level-${log.level}${log.deleted ? ' bdnsync-log-row-tomb' : ''}`;
    // 左侧级别色条
    const bar = row.createSpan({ cls: `bdnsync-log-levelbar bdnsync-log-levelbar-${log.level}` });

    const content = row.createDiv({ cls: 'bdnsync-log-row-content' });

    const head = content.createDiv({ cls: 'bdnsync-log-row-head' });
    const levelBadge = head.createSpan({
      cls: `bdnsync-log-badge bdnsync-log-badge-${log.level}`,
      text: LEVEL_LABEL[log.level],
    });
    const modBadge = head.createSpan({
      cls: 'bdnsync-log-module',
      text: MODULE_LABEL[log.module],
    });
    const time = head.createSpan({
      cls: 'bdnsync-log-time',
      text: new Date(log.time).toLocaleString(),
    });
    const typeIcon = head.createSpan({ cls: 'bdnsync-log-icon' });
    // 类型图标
    this.setRowIcon(typeIcon, log.type);

    const msg = content.createDiv({ cls:  'bdnsync-log-msg' });
    msg.innerHTML = this.highlight(log.message);
    if (log.path) {
      const pathEl = content.createDiv({ cls: 'bdnsync-log-path' });
      pathEl.innerHTML = this.highlight(log.path);
    }

    // 单条操作（hover 显示）
    const actions = content.createDiv({ cls: 'bdnsync-log-row-actions' });
    this.addRowAction(actions, 'copy', '复制文本', () =>
      this.copy(this.logger.exportTextOne(log)),
    );
    this.addRowAction(actions, 'download', '导出 JSON', () =>
      this.downloadFile(`log-${log.id}.json`, this.logger.exportJSONOne(log), 'application/json'),
    );
    this.addRowAction(actions, 'file-text', '导出文本', () =>
      this.downloadFile(`log-${log.id}.txt`, this.logger.exportTextOne(log), 'text/plain'),
    );

    return row;
  }

  private addRowAction(
    container: HTMLElement,
    icon: IconName,
    label: string,
    onClick: () => void,
  ): void {
    const btn = container.createEl('button', {
      cls: 'bdnsync-icon-btn bdnsync-log-row-action',
      attr: { 'aria-label': label, title: label },
    });
    const iconWrap = btn.createSpan({ cls: 'bdnsync-log-row-action-icon' });
    setIcon(iconWrap, icon, 14);
    btn.createSpan({ text: label, cls: 'bdnsync-log-row-action-label' });
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
    });
  }

  private setRowIcon(el: HTMLElement, type: SyncLogEntry['type']): void {
    const map: Record<SyncLogEntry['type'], IconName> = {
      upload: 'arrow-up',
      download: 'arrow-down',
      delete: 'trash-2',
      conflict: 'alert-triangle',
      error: 'x',
      info: 'info',
    };
    el.addClass('bdnsync-log-type-icon');
    setIcon(el, map[type] ?? 'info', 13);
  }

  private highlight(text: string): string {
    // 转义 HTML，避免 XSS / 破坏结构
    const esc = text.replace(/[&<>"]/g, (c) => {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;';
    });
    if (!this.keyword.trim()) return esc;
    try {
      const kw = this.useRegex ? this.keyword.trim() : this.escapeRegex(this.keyword.trim());
      const re = new RegExp(`(${kw})`, 'gi');
      return esc.replace(re, '<mark class="bdnsync-log-hl">$1</mark>');
    } catch {
      return esc;
    }
  }

  private escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private renderStatBar(filtered: SyncLogEntry[]): void {
    this.statBar.empty();
    const stats = this.logger.tombstoneStats();
    const counts = this.logger.levelCounts(this.buildFilter());
    const summary = this.statBar.createSpan({ cls: 'bdnsync-log-stat-summary' });
    summary.setText(`匹配 ${filtered.length} 条 · 总计 ${stats.total} 条（墓碑 ${stats.tombstoned}）`);

    const chips = this.statBar.createSpan({ cls: 'bdnsync-log-stat-levels' });
    for (const l of LEVELS) {
      const c = chips.createSpan({
        cls: `bdnsync-log-stat-chip bdnsync-log-stat-chip-${l}`,
      });
      c.setText(`${LEVEL_LABEL[l]} ${counts[l]}`);
    }
  }

  private async copy(text: string): Promise<void> {
    await navigator.clipboard.writeText(text);
    new Notice('BDNSync：已复制到剪贴板');
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
}
