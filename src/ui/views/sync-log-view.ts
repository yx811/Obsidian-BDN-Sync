// 同步日志：Obsidian 标签页（ItemView），在主区域作为新标签打开。
// 重构后特性：按日期分组 + 级别色彩 + 搜索（正则/高亮）+ 排序切换 + 实时订阅刷新
// + 级别/模块筛选 + 单条复制/导出 + 按筛选导出 txt/json。

import { ItemView, WorkspaceLeaf, Notice } from 'obsidian';
import type { LogLevel, LogFilter, LogModule, SyncLogEntry } from '../../types';
import { LEVEL_LABEL, MODULE_LABEL, Logger, parseLogMessage, type DiagnosticContext } from '../../util/logger';
import { createIconButton, createModalHeader, showConfirmModal, setIcon, type IconName } from '../components';

export const VIEW_TYPE_BDNSYNC_LOG = 'bdnsync-log';

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
  private from = '';
  private to = '';
  private sort: 'desc' | 'asc' = 'desc';
  private includeTomb = false;

  private body!: HTMLElement;
  private listContainer!: HTMLElement;
  private statBar!: HTMLElement;
  private searchInput!: HTMLInputElement;
  private unsub: (() => void) | null = null;
  private onDocClick: ((e: MouseEvent) => void) | null = null;
  private pendingRender = false;
  /** 🟡#16：跨实时重渲染保留的「已展开」行集合（按 entry id）。
   *  新日志到达触发整体重建时，已展开的行不会因 DOM 重建而折叠。 */
  private expandedIds = new Set<string>();
  // ── 增量渲染跟踪状态 ──
  /** 上次完整渲染时使用的 filter hash，用于判断是否需要全量重建 */
  private lastFilterKey = '';
  /** 当前 DOM 中已渲染的 entry id 集合（用于快速判断新增条目） */
  private renderedIds = new Set<string>();
  /** 当前 DOM 中日期分组 → list 容器的映射（用于增量追加） */
  private groupElements = new Map<string, { header: HTMLElement; list: HTMLElement; count: HTMLElement }>();
  /** DOM 中实际渲染的条目数（用于判断是否超限） */
  private renderedCount = 0;
  /** 增量渲染最大 DOM 条目数上限，超出后退化为全量重建并截断 */
  private static readonly MAX_DOM_ROWS = 200;

  constructor(
    leaf: WorkspaceLeaf,
    private logger: Logger,
    private diagCtx: () => DiagnosticContext,
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

    // ── 工具栏：搜索 + 排序 + 刷新 ──
    const toolbar = head.head.createDiv({ cls: 'bdnsync-log-toolbar' });
    const searchWrap = toolbar.createDiv({ cls: 'bdnsync-log-search' });
    const searchIcon = searchWrap.createSpan({ cls: 'bdnsync-log-search-icon' });
    setIcon(searchIcon, 'filter', 16);
    const searchInput = searchWrap.createEl('input', {
      cls: 'bdnsync-input bdnsync-log-search-input',
      attr: { type: 'text', placeholder: '搜索消息、路径或模块…' },
    }) as HTMLInputElement;
    this.searchInput = searchInput;
    searchInput.value = this.keyword;
    searchInput.addEventListener('input', () => {
      this.keyword = searchInput.value;
      this.updateSearchClear();
      this.scheduleRender();
    });
    const clearBtn = searchWrap.createEl('button', {
      cls: 'bdnsync-log-search-clear',
      attr: { 'aria-label': '清除搜索', title: '清除搜索' },
    });
    setIcon(clearBtn, 'x', 14);
    clearBtn.addEventListener('click', () => {
      searchInput.value = '';
      this.keyword = '';
      this.updateSearchClear();
      this.scheduleRender();
    });
    this.updateSearchClear();

    // 操作按钮组
    const actions = toolbar.createDiv({ cls: 'bdnsync-log-actions' });
    createIconButton(actions, {
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

    // ── 筛选栏：时间范围 + 最低级别 + 墓碑开关 ──
    const filterBar = body.createDiv({ cls: 'bdnsync-log-filterbar' });
    const filterLeft = filterBar.createDiv({ cls: 'bdnsync-log-filter-left' });
    const filterRight = filterBar.createDiv({ cls: 'bdnsync-log-filter-right' });

    // 时间范围
    const dateGroup = filterLeft.createDiv({ cls: 'bdnsync-log-date-group' });
    const fromWrap = dateGroup.createDiv({ cls: 'bdnsync-log-field' });
    fromWrap.createEl('label', { text: '起始', cls: 'bdnsync-log-label' });
    const fromInput = fromWrap.createEl('input', {
      cls: 'bdnsync-input',
      attr: { type: 'date' },
    }) as HTMLInputElement;
    fromInput.value = this.from;
    fromInput.addEventListener('change', () => {
      this.from = fromInput.value;
      this.scheduleRender();
    });
    dateGroup.createSpan({ text: '–', cls: 'bdnsync-log-date-sep' });
    const toWrap = dateGroup.createDiv({ cls: 'bdnsync-log-field' });
    toWrap.createEl('label', { text: '结束', cls: 'bdnsync-log-label' });
    const toInput = toWrap.createEl('input', {
      cls: 'bdnsync-input',
      attr: { type: 'date' },
    }) as HTMLInputElement;
    toInput.value = this.to;
    toInput.addEventListener('change', () => {
      this.to = toInput.value;
      this.scheduleRender();
    });

    // 最低级别
    const lvlWrap = filterLeft.createDiv({ cls: 'bdnsync-log-field' });
    lvlWrap.createEl('label', { text: '级别', cls: 'bdnsync-log-label' });
    const lvlSelect = lvlWrap.createEl('select', { cls: 'bdnsync-input' }) as HTMLSelectElement;
    for (const [v, label] of [
      ['debug', '全部'],
      ['info', '信息+'],
      ['warn', '警告+'],
      ['error', '仅错误'],
    ] as const) {
      const opt = lvlSelect.createEl('option', { text: label, value: v });
      if (v === this.minLevel) opt.selected = true;
    }
    lvlSelect.addEventListener('change', () => {
      this.minLevel = lvlSelect.value as LogLevel;
      this.scheduleRender();
    });

    // 统计摘要占位
    this.statBar = filterRight.createDiv({ cls: 'bdnsync-log-statbar' });

    // ── 级别 chips ──
    const levelChips = body.createDiv({ cls: 'bdnsync-log-filters bdnsync-log-chips' });
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

    // ── 模块 chips ──
    const modChips = body.createDiv({ cls: 'bdnsync-log-filters bdnsync-log-chips' });
    modChips.createSpan({ text: '模块', cls: 'bdnsync-log-chips-label' });
    for (const m of MODULES) {
      const chip = modChips.createSpan({
        cls: `bdnsync-log-chip bdnsync-log-chip-module`,
      });
      chip.setText(MODULE_LABEL[m]);
      chip.addEventListener('click', () => {
        if (this.moduleFilter.has(m)) this.moduleFilter.delete(m);
        else this.moduleFilter.add(m);
        chip.classList.toggle('active', this.moduleFilter.has(m));
        this.scheduleRender();
      });
    }

    // ── 列表容器 ──
    const listContainer = body.createDiv({ cls: 'bdnsync-log-list-container' });
    this.listContainer = listContainer;

    // ── 底部操作 ──
    const footer = shell.createDiv({ cls: 'bdnsync-modal-foot bdnsync-log-footer' });
    const footerLeft = footer.createDiv({ cls: 'bdnsync-log-footer-left' });
    const footerRight = footer.createDiv({ cls: 'bdnsync-log-footer-right' });

    createIconButton(footerLeft, {
      icon: 'trash-2',
      label: '清空',
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
    createIconButton(footerLeft, {
      icon: 'copy',
      label: '复制全部日志',
      title: '将当前筛选条件下的全部日志以文本格式复制到剪贴板',
      onClick: async () => {
        const text = this.logger.exportText(this.buildFilter());
        await navigator.clipboard.writeText(text);
        new Notice('BDNSync：已复制筛选日志到剪贴板');
      },
    });
    createIconButton(footerLeft, {
      icon: 'info',
      label: '复制诊断信息',
      title: '一键复制脱敏诊断快照（插件版本 / 平台 / 设置摘要 / 最近错误 / 日志样本），便于向开发者反馈问题',
      onClick: async () => {
        await navigator.clipboard.writeText(this.logger.exportDiagnostic(this.diagCtx()));
        new Notice('BDNSync：诊断信息已复制到剪贴板（可直接粘贴给开发者）');
      },
    });

    // 导出按钮组
    const exportBtn = footerRight.createDiv({ cls: 'bdnsync-log-export-group' });
    const exportToggle = exportBtn.createEl('button', {
      cls: 'bdnsync-btn bdnsync-log-export-toggle',
    });
    setIcon(exportToggle.createSpan(), 'download', 14);
    exportToggle.createSpan({ text: '导出' });
    const exportMenu = exportBtn.createDiv({ cls: 'bdnsync-log-export-menu' });
    exportMenu.style.display = 'none';

    const exportItems: { icon: IconName; label: string; format: () => string; name: string; mime: string }[] = [
      { icon: 'file-json', label: 'JSON', format: () => this.logger.exportJSON(this.buildFilter()), name: 'bdnsync-logs.json', mime: 'application/json' },
      { icon: 'file-text', label: '文本', format: () => this.logger.exportText(this.buildFilter()), name: 'bdnsync-logs.txt', mime: 'text/plain' },
      { icon: 'file-spreadsheet', label: 'CSV', format: () => this.logger.exportCsv(this.buildFilter()), name: 'bdnsync-logs.csv', mime: 'text/csv;charset=utf-8' },
      { icon: 'file-text', label: 'Markdown', format: () => this.logger.exportMarkdown(this.buildFilter()), name: 'bdnsync-logs.md', mime: 'text/markdown' },
    ];
    for (const item of exportItems) {
      const row = exportMenu.createDiv({ cls: 'bdnsync-log-export-item' });
      const iconEl = row.createSpan({ cls: 'bdnsync-log-export-icon' });
      setIcon(iconEl, item.icon, 14);
      row.createSpan({ text: item.label, cls: 'bdnsync-log-export-label' });
      row.addEventListener('click', async () => {
        await this.downloadFile(item.name, item.format(), item.mime);
        exportMenu.style.display = 'none';
      });
    }

    exportToggle.addEventListener('click', () => {
      const visible = exportMenu.style.display !== 'none';
      exportMenu.style.display = visible ? 'none' : 'block';
    });
    this.onDocClick = (e: MouseEvent) => {
      if (!exportBtn.contains(e.target as Node)) {
        exportMenu.style.display = 'none';
      }
    };
    document.addEventListener('click', this.onDocClick);

    // 实时订阅：新日志到达时刷新（防抖，避免高频写入时 UI 抖动）
    this.unsub = this.logger.onEntry(() => this.scheduleRender());

    this.renderList();
  }

  private updateSearchClear(): void {
    const clearBtn = this.searchInput?.parentElement?.querySelector('.bdnsync-log-search-clear') as HTMLElement | null;
    if (clearBtn) {
      clearBtn.style.display = this.keyword ? 'flex' : 'none';
    }
  }

  async onClose(): Promise<void> {
    if (this.onDocClick) {
      document.removeEventListener('click', this.onDocClick);
      this.onDocClick = null;
    }
    if (this.unsub) {
      this.unsub();
      this.unsub = null;
    }
    // 清理增量渲染状态
    this.groupElements.clear();
    this.renderedIds.clear();
    this.renderedCount = 0;
    this.lastFilterKey = '';
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

    const filter = this.buildFilter();
    const exactLevels = this.levelFilter.size ? this.levelFilter : null;
    const filtered = this.logger.query(filter).filter((e) => !exactLevels || exactLevels.has(e.level));
    // 过滤被条目应用：后续分组 & 渲染只用 filtered
    const filterKey = this.computeFilterKey(filter, exactLevels);

    this.renderStatBar(filtered);

    if (filtered.length === 0) {
      this.listContainer.empty();
      this.groupElements.clear();
      this.renderedIds.clear();
      this.renderedCount = 0;
      this.lastFilterKey = '';
      const empty = this.listContainer.createDiv({ cls: 'bdnsync-empty-state' });
      const iconWrap = empty.createSpan({ cls: 'bdnsync-empty-state-icon' });
      setIcon(iconWrap, 'filter', 28);
      empty.createSpan({ text: '当前筛选无匹配日志', cls: 'bdnsync-empty-state-text' });
      return;
    }

    // ── 判断是否需要全量重建 ──
    const needFullRebuild = filterKey !== this.lastFilterKey
      || this.renderedCount > SyncLogView.MAX_DOM_ROWS
      || !this.listContainer.isConnected;

    if (needFullRebuild) {
      this.fullRebuild(filtered, filterKey);
      return;
    }

    // ── 增量模式：仅追加新增条目 ──
    const newEntries = filtered.filter((e) => !this.renderedIds.has(e.id));
    if (newEntries.length === 0) return;

    // 🔴 排序方向修正：desc（最新优先）时新日志必须插入组内顶部、新日期组置于列表顶部，
    // 此前统一 appendChild 会把新日志排到旧日志之下（新来的反而在底部），顺序错乱。
    // 通过「逆序遍历 + prepend」保证：先放较旧的新条目、再放最新的，最终最新在最上。
    const seq = this.sort === 'desc' ? [...newEntries].reverse() : newEntries;
    for (const log of seq) {
      const dayKey = this.dateKey(log.time);
      let group = this.groupElements.get(dayKey);
      if (!group) {
        group = this.createDayGroup(dayKey, this.sort === 'desc');
      }
      const row = this.renderRow(log);
      if (this.sort === 'desc') group.list.prepend(row);
      else group.list.appendChild(row);
      this.renderedIds.add(log.id);
      this.renderedCount++;
      // 超限 → 退化为全量重建（截断）
      if (this.renderedCount > SyncLogView.MAX_DOM_ROWS) {
        this.fullRebuild(filtered, filterKey);
        return;
      }
    }
    // 更新分组计数
    this.updateGroupCounts();
  }

  /** 全量重建：清空容器 + 重建所有分组 & 行 */
  private fullRebuild(filtered: SyncLogEntry[], filterKey: string): void {
    this.listContainer.empty();
    this.groupElements.clear();
    this.renderedIds.clear();
    this.renderedCount = 0;
    this.lastFilterKey = filterKey;

    // 按日期分组
    const groups = new Map<string, SyncLogEntry[]>();
    for (const e of filtered) {
      const key = this.dateKey(e.time);
      const bucket = groups.get(key) ?? [];
      bucket.push(e);
      groups.set(key, bucket);
    }
    // 日期组排序（与整体排序方向一致）
    const groupKeys = Array.from(groups.keys()).sort((a, b) =>
      this.sort === 'desc' ? b.localeCompare(a) : a.localeCompare(b),
    );

    for (const dayKeyStr of groupKeys) {
      const entries = groups.get(dayKeyStr) ?? [];
      const group = this.createDayGroup(dayKeyStr);
      for (const log of entries) {
        group.list.appendChild(this.renderRow(log));
        this.renderedIds.add(log.id);
        this.renderedCount++;
      }
      group.count.textContent = `${entries.length} 条`;
    }
  }

  /** 创建日期分组 DOM（header + list），并注册到 groupElements。
   *  prepend=true（desc 增量模式）：新日期组应置于列表顶部，而非末尾。 */
  private createDayGroup(
    dayKey: string,
    prepend = false,
  ): { header: HTMLElement; list: HTMLElement; count: HTMLElement } {
    const groupEl = this.listContainer.createDiv({ cls: 'bdnsync-log-group' });
    if (prepend) this.listContainer.prepend(groupEl);
    const header = groupEl.createDiv({ cls: 'bdnsync-log-group-header' });
    header.createSpan({ text: dayKey, cls: 'bdnsync-log-group-date' });
    const count = header.createSpan({ text: '0 条', cls: 'bdnsync-log-group-count' });
    const list = groupEl.createDiv({ cls: 'bdnsync-log-list' });
    const group = { header, list, count };
    this.groupElements.set(dayKey, group);
    return group;
  }

  /** 更新各分组计数标签（增量追加后调用） */
  private updateGroupCounts(): void {
    for (const group of this.groupElements.values()) {
      group.count.textContent = `${group.list.childElementCount} 条`;
    }
  }

  /** 生成日期分组 key（YYYY-MM-DD） */
  private dateKey(ts: number): string {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  /** 计算 filter 状态 hash，用于判断是否需要全量重建 */
  private computeFilterKey(filter: LogFilter, exactLevels: Set<LogLevel> | null): string {
    return JSON.stringify({ filter, exactLevels: exactLevels ? [...exactLevels].sort() : null });
  }

  private renderRow(log: SyncLogEntry): HTMLElement {
    const row = document.createElement('div');
    row.className = `bdnsync-log-row bdnsync-log-level-${log.level}${log.deleted ? ' bdnsync-log-row-tomb' : ''}`;
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    // 🟡#16：恢复该行的持久化展开状态，避免实时重渲染后已展开的行被折叠
    const isOpen = this.expandedIds.has(log.id);
    row.setAttribute('aria-expanded', String(isOpen));
    if (isOpen) row.classList.add('is-expanded');
    row.setAttribute('aria-label', '展开日志详情');

    // 级别色条（grid 第一列 4px）
    row.createDiv({ cls: `bdnsync-log-levelbar bdnsync-log-levelbar-${log.level}` });

    const content = row.createDiv({ cls: 'bdnsync-log-row-content' });

    const head = content.createDiv({ cls: 'bdnsync-log-row-head' });
    // 展开/折叠指示器
    const caret = head.createSpan({ cls: 'bdnsync-log-row-caret' });
    setIcon(caret, 'chevron-right', 12);
    // 级别徽章（始终显示，与类型标签并用）
    head.createSpan({
      cls: `bdnsync-log-badge bdnsync-log-badge-${log.level}`,
      text: LEVEL_LABEL[log.level],
    });
    // 类型标签（小色点 + 文案胶囊，按业务类型着色）
    const typeTag = head.createSpan({
      cls: `bdnsync-log-type-tag bdnsync-log-type-${log.type}`,
    });
    // 前置小色点（替代抽象的大图标，更精致不抢眼）
    const _dot = typeTag.createSpan({ cls: 'bdnsync-log-type-dot' });
    typeTag.createSpan({ text: this.typeLabel(log.type), cls: 'bdnsync-log-type-text' });
    // 模块标签
    head.createSpan({
      cls: `bdnsync-log-module bdnsync-log-module-${log.module}`,
      text: MODULE_LABEL[log.module],
    });
    // 时间
    head.createSpan({
      cls: 'bdnsync-log-time',
      text: this.formatShortTime(log.time),
    });

    // 消息内容
    const firstLine = log.message.split('\n')[0] ?? '';
    const msg = content.createDiv({ cls: 'bdnsync-log-msg' });
    this.highlightInto(msg, firstLine);
    if (log.message.includes('\n')) {
      msg.createSpan({ cls: 'bdnsync-log-msg-more', text: '…' });
    }
    // 路径
    if (log.path) {
      const pathEl = content.createDiv({ cls: 'bdnsync-log-path' });
      this.highlightInto(pathEl, log.path);
    }

    // 单条操作（hover 显示）
    const actions = content.createDiv({ cls: 'bdnsync-log-row-actions' });
    this.addRowAction(actions, 'copy', '复制', () =>
      this.copy(this.logger.exportTextOne(log)),
    );
    this.addRowAction(actions, 'download', '导出', () =>
      this.downloadFile(`log-${log.id}.json`, this.logger.exportJSONOne(log), 'application/json'),
    );

    // 详情面板（默认折叠）
    const details = row.createDiv({ cls: 'bdnsync-log-details' });
    details.style.display = isOpen ? 'block' : 'none';
    this.renderDetails(details, log);

    const toggle = () => {
      const expanded = row.classList.toggle('is-expanded');
      row.setAttribute('aria-expanded', String(expanded));
      details.style.display = expanded ? 'block' : 'none';
      if (expanded) this.expandedIds.add(log.id);
      else this.expandedIds.delete(log.id);
    };
    row.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.bdnsync-log-row-action')) return;
      toggle();
    });
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
      }
    });

    return row;
  }

  /** 短时间格式：今天只显示时分，其他显示日期+时分 */
  private formatShortTime(ts: number): string {
    const d = new Date(ts);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    if (isToday) return time;
    return `${d.getMonth() + 1}/${d.getDate()} ${time}`;
  }

  /** 展开态详情：结构化字段 + 内容提炼（结论 / 上下文 / 折叠技术堆栈 / 原始消息） */
  private renderDetails(container: HTMLElement, log: SyncLogEntry): void {
    const grid = container.createDiv({ cls: 'bdnsync-log-detail-grid' });
    // ── 紧凑分组：短字段两两一行（2 列），长字段跨满整行 ──
    this.addDetailField(grid, '发生时间', this.formatFullTime(log.time));
    this.addDetailField(grid, '相对时间', this.formatRelative(log.time));
    this.addDetailField(grid, '严重程度', LEVEL_LABEL[log.level]);
    this.addDetailField(grid, '业务类型', this.typeLabel(log.type));
    this.addDetailField(grid, '来源模块', MODULE_LABEL[log.module]);
    this.addDetailField(grid, '日志编号', log.id);
    if (log.path) {
      const pathField = this.addDetailField(grid, '相关路径', log.path, true, true, true);
      // 路径点击 → 在 Obsidian 主区域打开对应文件/笔记
      pathField.classList.add('bdnsync-log-path-clickable');
      pathField.addEventListener('click', () => {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const p = log.path!;
        const af = this.app.vault.getAbstractFileByPath(p);
        if (af) void this.app.workspace.openLinkText(p, '/', false);
        else new Notice(`BDNSync：路径不存在或已被删除：${p}`);
      });
    }
    // errno 解析（如果 message 里出现 "errno=N" 形式，识别并显示人话说明）
    const errnoHit = this.extractErrno(log.message);
    if (errnoHit !== null) {
      this.addDetailField(grid, '错误码', `errno=${errnoHit}（${this.errnoHint(errnoHit)}）`, false, false, true);
    }
    if (log.deleted) {
      const st = log.deletedAt
        ? `已标记删除（${this.formatRelative(log.deletedAt)}标记）`
        : '已标记删除';
      this.addDetailField(grid, '处理状态', st, false, false, true);
    }

    const section = container.createDiv({ cls: 'bdnsync-log-detail-section' });
    section.createDiv({ cls: 'bdnsync-log-detail-h', text: '内容提炼' });

    const parsed = parseLogMessage(log.message);
    const concl = section.createDiv({ cls: 'bdnsync-log-detail-concl' });
    concl.textContent = parsed.summary || '（无内容）';

    if (parsed.context.length) {
      const ctx = section.createDiv({ cls: 'bdnsync-log-detail-ctx' });
      for (const line of parsed.context) {
        ctx.createDiv({ cls: 'bdnsync-log-detail-ctx-line' }).textContent = line;
      }
    }

    // 技术堆栈默认折叠，避免普通用户被冗长原始堆栈干扰（开发者排查用）
    if (parsed.stack.length) {
      const d = section.createEl('details', { cls: 'bdnsync-log-stack' });
      d.createEl('summary', {
        text: `技术堆栈（开发者排查用，共 ${parsed.stack.length} 帧）`,
      });
      // 🔴 阻止 details 点击冒泡到行 toggle，避免展开堆栈时整行被折叠
      d.addEventListener('click', (e) => e.stopPropagation());
      const pre = d.createEl('pre', { cls: 'bdnsync-log-stack-pre' });
      pre.textContent = parsed.stack.join('\n');
    }

    // 原始消息全文：默认折叠，用户主动展开时查看（区别于"内容提炼"）
    const raw = section.createEl('details', { cls: 'bdnsync-log-raw' });
    raw.createEl('summary', { text: '原始消息（全文）' });
    // 🔴 阻止 details 点击冒泡到行 toggle，避免展开原始消息时整行被折叠
    raw.addEventListener('click', (e) => e.stopPropagation());
    const pre = raw.createEl('pre', { cls: 'bdnsync-log-raw-pre' });

    // ── 丰富原始消息内容：结构化展示所有可用字段 ──
    const richLines: string[] = [];
    richLines.push(`【消息正文】`);
    richLines.push(log.message);
    richLines.push('');
    // 操作元数据
    const metaParts: string[] = [];
    if (log.durationMs != null) metaParts.push(`耗时 ${log.durationMs}ms`);
    if (log.bytesUp != null) metaParts.push(`上传 ${(log.bytesUp / 1024).toFixed(1)} KB`);
    if (log.bytesDown != null) metaParts.push(`下载 ${(log.bytesDown / 1024).toFixed(1)} KB`);
    if (metaParts.length) {
      richLines.push(`【操作统计】${metaParts.join(' · ')}`);
      richLines.push('');
    }
    // 变更前后对比（审计）
    if (log.beforeHash || log.beforeSize != null || log.beforeMtime != null) {
      const beforeParts: string[] = [];
      if (log.beforeSize != null) beforeParts.push(`大小 ${log.beforeSize} B`);
      if (log.beforeMtime != null) beforeParts.push(`mtime ${new Date(log.beforeMtime).toISOString()}`);
      if (log.beforeHash) beforeParts.push(`hash ${log.beforeHash.slice(0, 12)}…`);
      richLines.push(`【变更前】${beforeParts.join(' | ')}`);
      richLines.push('');
    }
    // 触发方式（从 message 中提取）
    const triggerMatch = log.message.match(/\((manual|auto|realtime|startup|online)\)/);
    if (triggerMatch) {
      const triggerMap: Record<string, string> = { manual: '手动触发', auto: '定时自动', realtime: '实时监听', startup: '启动同步', online: '上线恢复' };
      richLines.push(`【触发方式】${triggerMatch[1] ?? triggerMatch[1]}（${triggerMap[triggerMatch[1]] ?? '未知'}）`);
      richLines.push('');
    }
    // 结构化解析结果
    if (parsed.summary) richLines.push(`【提炼结论】${parsed.summary}`);
    if (parsed.context.length) {
      richLines.push(`【上下文（${parsed.context.length} 行）】`);
      for (const line of parsed.context) richLines.push(`  ${line}`);
    }
    pre.textContent = richLines.join('\n');
  }

  /** 从日志文本中提取 errno=N（百度/Node 错误常见形式） */
  private extractErrno(msg: string): number | null {
    const m = /errno[=:]?\s*(-?\d+)/i.exec(msg);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    return isNaN(n) ? null : n;
  }

  /** 百度网盘 OpenAPI 常见 errno 速查（与 README 「errno 速查」一致） */
  private errnoHint(n: number): string {
    const map: Record<number, string> = {
      [-9]: '文件不存在',
      [-7]: '文件或目录名不合法',
      [2]: '参数错误',
      [10]: '创建文件失败',
      [12]: '部分失败（批量中单条）',
      [31034]: '接口调用频率超限（百度 QPS 限制）',
      [31039]: '操作频繁（被风控）',
      [31355]: '上传/同步限流',
      [102]: '沙箱根被越过（调用方 bug）',
      [404]: '网盘路径不存在',
    };
    return map[n] ?? '未知错误码（百度网盘 OpenAPI 文档）';
  }

  private addDetailField(
    grid: HTMLElement,
    label: string,
    value: string,
    mono = false,
    clickable = false,
    full = false,
  ): HTMLElement {
    const item = grid.createDiv({ cls: `bdnsync-log-detail-field${full ? ' bdnsync-log-detail-field--full' : ''}` });
    item.createSpan({ cls: 'bdnsync-log-detail-label', text: label });
    const v = item.createSpan({
      cls: `bdnsync-log-detail-value${mono ? ' is-mono' : ''}${clickable ? ' is-clickable' : ''}`,
    });
    v.textContent = value;
    return v;
  }

  private typeLabel(t: SyncLogEntry['type']): string {
    const map: Record<SyncLogEntry['type'], string> = {
      upload: '上传',
      download: '下载',
      delete: '删除',
      conflict: '冲突',
      error: '错误',
      info: '信息',
    };
    return map[t] ?? t;
  }

  private pad(n: number): string {
    return String(n).padStart(2, '0');
  }

  private formatFullTime(ts: number): string {
    const d = new Date(ts);
    return (
      `${d.getFullYear()}-${this.pad(d.getMonth() + 1)}-${this.pad(d.getDate())} ` +
      `${this.pad(d.getHours())}:${this.pad(d.getMinutes())}:${this.pad(d.getSeconds())}.` +
      `${String(d.getMilliseconds()).padStart(3, '0')}`
    );
  }

  private formatRelative(ts: number): string {
    const diff = Date.now() - ts;
    const s = Math.floor(diff / 1000);
    if (s < 60) return `${s} 秒前`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} 分钟前`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} 小时前`;
    const d = Math.floor(h / 24);
    if (d < 30) return `${d} 天前`;
    const mo = Math.floor(d / 30);
    if (mo < 12) return `${mo} 个月前`;
    return `${Math.floor(mo / 12)} 年前`;
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

  private highlightInto(el: HTMLElement, text: string): void {
    el.textContent = '';
    if (!this.keyword.trim()) {
      el.textContent = text;
      return;
    }
    try {
      const kw = this.escapeRegex(this.keyword.trim());
      const re = new RegExp(`(${kw})`, 'gi');
      const parts = text.split(re);
      const lcKw = this.keyword.trim().toLowerCase();
      for (const part of parts) {
        if (part.toLowerCase() === lcKw) {
          const mark = el.createEl('mark', { cls: 'bdnsync-log-hl', text: part });
          mark.textContent = part;
        } else {
          el.appendChild(document.createTextNode(part));
        }
      }
    } catch {
      el.textContent = text;
    }
  }

  private escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private renderStatBar(filtered: SyncLogEntry[]): void {
    this.statBar.empty();
    // 🔴 用「已过滤后的列表」直接统计，而非再查一次 levelCounts(buildFilter())——
    // 后者不含级别 chip 过滤，级别 chip 激活时统计数字与列表内容不一致。
    const counts: Record<LogLevel, number> = { debug: 0, info: 0, warn: 0, error: 0 };
    for (const e of filtered) counts[e.level]++;

    const summary = this.statBar.createDiv({ cls: 'bdnsync-log-stat-summary' });
    summary.createSpan({ text: `${filtered.length}`, cls: 'bdnsync-log-stat-num' });
    summary.createSpan({ text: ' 条匹配', cls: 'bdnsync-log-stat-text' });

    const chips = this.statBar.createDiv({ cls: 'bdnsync-log-stat-levels' });
    for (const l of LEVELS) {
      if (counts[l] === 0) continue;
      const c = chips.createSpan({
        cls: `bdnsync-log-stat-chip bdnsync-log-stat-chip-${l}`,
      });
      c.setText(`${counts[l]}`);
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
