// 百度网盘文件浏览器：改为 Obsidian 标签页（ItemView），在主区域作为新标签打开
// 替代旧的 NetdiskBrowserModal，避免弹窗裁切/滚动问题，并支持与其它笔记标签并列

import { ItemView, WorkspaceLeaf } from 'obsidian';
import type BDNSyncPlugin from '../../main';
import { formatBytes, formatTime, u8ToArrayBuffer } from '../../util/misc';
import { looksEncrypted } from '../../crypto/encryption';
import type { RemoteRawEntry } from '../../baidu/api';
import {
  setIcon,
  showConfirmModal,
  showPromptModal,
  createEmptyState,
  MiniModal,
  type IconName,
} from '../components';
import { Notices } from '../notices';
import { canPreview, classifyFile } from '../file-preview';
import { openFilePreviewInLeaf } from './preview-view';

export const VIEW_TYPE_BDNSYNC_BROWSER = 'bdnsync-browser';

/** 供设置页"浏览选择"使用：用户点"选为同步目录"后回调，参数为选中的目录路径 */
export let onSelectDirCallback: ((dir: string) => void) | null = null;
export function setOnSelectDirCallback(cb: ((dir: string) => void) | null): void {
  onSelectDirCallback = cb;
}

type BrowserEntry = RemoteRawEntry & { fullPath: string };
type SortKey = 'name' | 'size' | 'mtime';
type Mode = 'browse' | 'search';

const DOWNLOAD_DIR = '_netdisk_downloads';
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|ico|tiff?|avif)$/i;
const isImageFile = (name: string): boolean => IMAGE_EXT.test(name);

function sanitizeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'download';
}

function bytesToPreviewUrl(bytes: Uint8Array, name: string): string {
  const ext = (name.split('.').pop() || 'png').toLowerCase();
  const mimeMap: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    bmp: 'image/bmp',
    ico: 'image/x-icon',
    tif: 'image/tiff',
    tiff: 'image/tiff',
    avif: 'image/avif',
  };
  const mime = mimeMap[ext] || 'application/octet-stream';
  try {
    const blob = new Blob([bytes as unknown as ArrayBufferView], { type: mime });
    return URL.createObjectURL(blob);
  } catch {
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(
        null,
        Array.from(bytes.subarray(i, i + chunk)) as unknown as number[],
      );
    }
    return `data:${mime};base64,${btoa(bin)}`;
  }
}

export class NetdiskBrowserView extends ItemView {
  private currentDir = '/';
  private stack: string[] = [];
  private entries: BrowserEntry[] = [];
  private loading = false;
  private mode: Mode = 'browse';
  private keyword = '';
  private sortKey: SortKey = 'name';
  private sortAsc = true;
  private selected = new Set<string>();
  /** 上次单击的行索引（用于 Shift 范围选择） */
  private lastClickedIndex: number | null = null;

  private footEl!: HTMLElement;
  private listEl!: HTMLElement;
  private breadcrumbEl!: HTMLElement;
  private searchInput!: HTMLInputElement;
  private statusEl!: HTMLElement;
  private bulkEl!: HTMLElement;
  private fileInput!: HTMLInputElement;
  private clearBtn!: HTMLButtonElement;
  private statusPathEl!: HTMLElement;
  private statusInfoEl!: HTMLElement;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: BDNSyncPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_BDNSYNC_BROWSER;
  }
  getDisplayText(): string {
    return '百度网盘文件';
  }
  getIcon(): string {
    return 'folder';
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass('bdnsync-view', 'bdnsync-browser-view');

    // ===== 单行工具栏（参考 svp-explorer：flex-wrap，所有元素同一行）=====
    const toolbar = root.createDiv({ cls: 'bdnsync-explorer-toolbar' });

    // 面包屑（flex:1 1 auto，溢出横向滚动）
    this.breadcrumbEl = toolbar.createDiv({ cls: 'bdnsync-explorer-crumbrow' });

    // 搜索框（参考 svp-search：focus 时变宽）
    this.searchInput = toolbar.createEl('input', {
      cls: 'bdnsync-explorer-search',
      attr: {
        type: 'text',
        placeholder: '搜索（Enter）',
        spellcheck: 'false',
        'aria-label': '搜索文件名',
      },
    });
    this.searchInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        this.keyword = this.searchInput.value.trim();
        if (this.keyword) void this.doSearch();
        else {
          this.mode = 'browse';
          void this.refresh();
        }
      } else if (ev.key === 'Escape') {
        this.searchInput.value = '';
        if (this.keyword) {
          this.mode = 'browse';
          void this.refresh();
        }
        this.keyword = '';
      }
    });

    // 操作按钮（参考：上一级/刷新/新建/设为同步根；选中后才显示「清除选择」）
    this.addBtn(
      toolbar,
      '上一级',
      'arrow-up',
      () => void this.goUp(),
      '返回上一级目录（Backspace）',
    );
    this.addBtn(toolbar, '刷新', 'refresh-cw', () => void this.refresh(), '刷新当前目录');
    this.addBtn(
      toolbar,
      '新建',
      'folder-plus',
      () => void this.promptNewFolder(),
      '在当前目录新建文件夹',
    );
    this.addBtn(
      toolbar,
      '设为同步根',
      'check',
      () => this.setSyncDir(this.currentDir),
      '将当前目录设为同步根目录',
      true,
    );
    this.clearBtn = this.addBtn(
      toolbar,
      '清除选择',
      'x',
      () => {
        this.selected.clear();
        this.lastClickedIndex = null;
        this.render();
      },
      '清除全部选择',
    );
    this.clearBtn.style.display = 'none';

    // 隐藏的文件 input（占位）
    this.fileInput = root.createEl('input', {
      cls: 'bdnsync-explorer-fileinput',
      attr: { type: 'file', multiple: 'multiple', 'aria-hidden': 'true' },
    });
    this.fileInput.style.display = 'none';

    // ===== 列表（参考：4 列 grid，行内 flex）=====
    const listWrap = root.createDiv({ cls: 'bdnsync-explorer-listwrap', attr: { tabindex: '0' } });
    listWrap.addEventListener('keydown', (e) => this.onListKeyDown(e));
    this.listEl = listWrap.createDiv({ cls: 'bdnsync-explorer-filelist' });
    this.listEl.createDiv({ cls: 'bdnsync-explorer-loading', text: '加载中…' });

    // ===== 状态栏（细线分隔，左右分布）=====
    this.footEl = root.createDiv({ cls: 'bdnsync-explorer-statusbar' });
    this.statusPathEl = this.footEl.createSpan({
      cls: 'bdnsync-explorer-statuspath',
      text: '当前目录：/',
    });
    const right = this.footEl.createDiv({ cls: 'bdnsync-explorer-statusinfo' });
    this.statusInfoEl = right.createSpan({ cls: 'bdnsync-explorer-statuscount' });
    this.bulkEl = right.createDiv({ cls: 'bdnsync-explorer-bulk' });
    this.addBtn(
      this.bulkEl,
      '批量下载',
      'arrow-down',
      () => void this.bulkDownload(),
      '批量下载选中项',
    );
    this.addBtn(
      this.bulkEl,
      '批量删除',
      'trash-2',
      () => void this.bulkDelete(),
      '批量删除选中项',
      false,
      true,
    );

    void this.refresh();
  }

  /** 添加一个紧凑的图标+文字按钮 */
  private addBtn(
    parent: HTMLElement,
    text: string,
    iconName: IconName,
    onClick: () => void,
    title?: string,
    primary = false,
    danger = false,
  ): HTMLButtonElement {
    const b = parent.createEl('button', {
      cls: `bdnsync-explorer-btn${primary ? ' is-primary' : ''}${danger ? ' is-danger' : ''}`,
    });
    if (title) b.setAttr('title', title);
    setIcon(b.createSpan({ cls: 'bdnsync-explorer-btn-icon' }), iconName, 14);
    b.createSpan({ text });
    b.addEventListener('click', (ev) => {
      ev.preventDefault();
      onClick();
    });
    return b;
  }

  async onClose(): Promise<void> {
    // no-op
  }

  // ---- 数据 ----

  private pluginApi() {
    return this.plugin.createApi();
  }

  private async refresh(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.setStatus('加载中…');
    try {
      const api = this.pluginApi();
      const raw = await api.listDir(this.currentDir);
      this.entries = raw.map((it) => ({ ...it, fullPath: it.path || it.name }));
      this.sortEntries();
      this.mode = 'browse';
      this.render();
    } catch (e) {
      this.listEl.empty();
      createEmptyState(this.listEl, {
        icon: 'cloud-alert',
        title: '加载失败',
        desc: e instanceof Error ? e.message : String(e),
      });
      this.setStatus('加载失败');
    } finally {
      this.loading = false;
    }
  }

  private async doSearch(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.setStatus(`搜索「${this.keyword}」中…`);
    try {
      const api = this.pluginApi();
      const raw = await api.search(this.keyword, this.currentDir);
      this.entries = raw.map((it) => ({ ...it, fullPath: it.path || it.name }));
      this.sortEntries();
      this.mode = 'search';
      this.render();
    } catch (e) {
      this.listEl.empty();
      createEmptyState(this.listEl, {
        icon: 'cloud-alert',
        title: '搜索失败',
        desc: e instanceof Error ? e.message : String(e),
      });
    } finally {
      this.loading = false;
    }
  }

  private sortEntries(): void {
    const dir = this.sortAsc ? 1 : -1;
    this.entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      const k = this.sortKey;
      if (k === 'name') return a.name.localeCompare(b.name, 'zh-CN') * dir;
      if (k === 'size') return (a.size - b.size) * dir;
      return (a.mtime - b.mtime) * dir;
    });
  }

  private toggleSort(key: SortKey): void {
    if (this.sortKey === key) this.sortAsc = !this.sortAsc;
    else {
      this.sortKey = key;
      this.sortAsc = true;
    }
    this.sortEntries();
    this.render();
  }

  // ---- 渲染 ----

  private render(): void {
    this.renderBreadcrumb();
    this.renderList();
    this.updateStatus();
  }

  private renderBreadcrumb(): void {
    this.breadcrumbEl.empty();
    const root = this.breadcrumbEl.createEl('span', {
      text: '网盘',
      cls: 'bdnsync-explorer-crumb',
    });
    root.addEventListener('click', () => void this.enter('/'));
    if (this.mode === 'search') {
      this.breadcrumbEl.createEl('span', { text: '·', cls: 'bdnsync-explorer-crumb-sep' });
      this.breadcrumbEl.createEl('span', {
        text: `搜索「${this.keyword}」`,
        cls: 'bdnsync-explorer-crumb-current',
      });
      return;
    }
    const parts = this.currentDir.split('/').filter(Boolean);
    let acc = '';
    for (const p of parts) {
      this.breadcrumbEl.createEl('span', { text: '/', cls: 'bdnsync-explorer-crumb-sep' });
      acc = acc ? `${acc}/${p}` : `/${p}`;
      const crumb = this.breadcrumbEl.createEl('span', { text: p, cls: 'bdnsync-explorer-crumb' });
      const target = acc;
      crumb.addEventListener('click', () => void this.enter(target));
    }
  }

  private renderList(): void {
    this.listEl.empty();
    // 表头（参考：与行同 grid，无 checkbox 列）
    const header = this.listEl.createDiv({ cls: 'bdnsync-explorer-filelist-header' });
    const hName = header.createSpan({ text: '名称', cls: 'bdnsync-explorer-col-name is-sortable' });
    hName.addEventListener('click', () => this.toggleSort('name'));
    const hSize = header.createSpan({ text: '大小', cls: 'bdnsync-explorer-col-size is-sortable' });
    hSize.addEventListener('click', () => this.toggleSort('size'));
    const hTime = header.createSpan({
      text: '修改时间',
      cls: 'bdnsync-explorer-col-time is-sortable',
    });
    hTime.addEventListener('click', () => this.toggleSort('mtime'));
    header.createSpan({ cls: 'bdnsync-explorer-col-act' });

    if (this.entries.length === 0) {
      createEmptyState(this.listEl, {
        icon: 'folder',
        title: this.mode === 'search' ? '无匹配结果' : '此目录为空',
      });
      return;
    }

    for (const e of this.entries) {
      const checked = this.selected.has(e.fullPath);
      const row = this.listEl.createDiv({
        cls: `bdnsync-explorer-filerow${checked ? ' is-selected' : ''}`,
      });
      row.dataset.path = e.fullPath;

      // 名称（图标 + 文件名，单行省略）
      const name = row.createDiv({ cls: 'bdnsync-explorer-col-name bdnsync-explorer-file-name' });
      const iconWrap = name.createSpan({ cls: 'bdnsync-explorer-fileicon' });
      setIcon(iconWrap, e.isDir ? 'folder' : isImageFile(e.name) ? 'image' : 'file-text', 16);
      name.createSpan({ cls: 'bdnsync-explorer-file-label', text: e.name });

      // 大小
      row.createSpan({
        text: e.isDir ? '—' : formatBytes(e.size),
        cls: 'bdnsync-explorer-col-size',
      });

      // 时间
      row.createSpan({ text: formatTime(e.mtime), cls: 'bdnsync-explorer-col-time' });

      // 操作（hover/选中时显现）
      const actions = row.createDiv({
        cls: 'bdnsync-explorer-col-act bdnsync-explorer-fileactions',
      });
      if (e.isDir) {
        this.addAct(actions, '进入', 'chevron-right', () => void this.enter(e.fullPath));
      } else {
        this.addAct(actions, '下载', 'arrow-down', () => void this.downloadFile(e));
        if (canPreview(e.name)) {
          this.addAct(actions, '预览', 'eye', () => this.previewFile(e), true);
        }
      }
      this.addAct(actions, '重命名', 'pencil', () => void this.promptRename(e), false, false, true);
      this.addAct(
        actions,
        '移至同步根',
        'folder-input',
        () => void this.moveToSyncDir(e),
        false,
        false,
        true,
      );
      this.addAct(actions, '删除', 'trash-2', () => void this.deleteEntry(e), false, true, true);

      // 行点击 = 进入目录 / 选中；Shift 多选；Ctrl/Cmd 多选
      row.addEventListener('click', (ev) => {
        const t = ev.target as HTMLElement;
        if (t.closest('button,input,a,select')) return;
        const idx = this.entries.findIndex((x) => x.fullPath === e.fullPath);
        if (ev.shiftKey && this.lastClickedIndex !== null && idx >= 0) {
          const [a, b] = [this.lastClickedIndex, idx].sort((x, y) => x - y);
          for (let i = a; i <= b; i++) this.selected.add(this.entries[i].fullPath);
        } else if (ev.ctrlKey || ev.metaKey) {
          if (this.selected.has(e.fullPath)) this.selected.delete(e.fullPath);
          else this.selected.add(e.fullPath);
          this.lastClickedIndex = idx;
        } else {
          if (e.isDir) void this.enter(e.fullPath);
          else {
            if (this.selected.has(e.fullPath)) this.selected.delete(e.fullPath);
            else this.selected.add(e.fullPath);
            this.lastClickedIndex = idx;
          }
        }
        this.render();
      });

      // 双击 = 进入目录 / 预览文件
      row.addEventListener('dblclick', () => {
        if (e.isDir) void this.enter(e.fullPath);
        else this.previewFile(e);
      });
    }
  }

  /** 在行操作列内加一个图标-only 紧凑按钮（节省横向空间避免覆盖 size/time 列）。
   *  secondary=true 时默认隐藏，仅在 hover/选中行时显现；核心操作（下载/预览）常驻。 */
  private addAct(
    parent: HTMLElement,
    text: string,
    iconName: IconName,
    onClick: () => void,
    primary = false,
    danger = false,
    secondary = false,
  ): HTMLButtonElement {
    const b = parent.createEl('button', {
      cls: `bdnsync-explorer-act${primary ? ' is-primary' : ''}${danger ? ' is-danger' : ''}${secondary ? ' is-secondary' : ''}`,
    });
    b.setAttr('title', text);
    b.setAttr('aria-label', text);
    setIcon(b.createSpan({ cls: 'bdnsync-explorer-act-icon' }), iconName, 14);
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      onClick();
    });
    return b;
  }

  private setSyncDir(dir: string): void {
    this.plugin.settings.remoteRoot = dir;
    void this.plugin.saveSettings();
    Notices.syncDirSet(dir);
    if (onSelectDirCallback) {
      const cb = onSelectDirCallback;
      cb(dir);
    }
  }

  private updateStatus(): void {
    const dirCount = this.entries.filter((e) => e.isDir).length;
    const fileCount = this.entries.length - dirCount;
    const countStr =
      this.mode === 'search'
        ? `命中 ${this.entries.length} 项`
        : `共 ${this.entries.length} 项（目录 ${dirCount} / 文件 ${fileCount}）`;
    if (this.statusInfoEl) {
      const sel = this.selected.size;
      this.statusInfoEl.setText(sel > 0 ? `已选 ${sel} 项 · ${countStr}` : countStr);
    }
    if (this.bulkEl) this.bulkEl.style.display = this.selected.size > 0 ? 'flex' : 'none';
    if (this.clearBtn) this.clearBtn.style.display = this.selected.size > 0 ? '' : 'none';
    if (this.statusPathEl) {
      this.statusPathEl.setText(`当前目录：${this.currentDir === '/' ? '/' : this.currentDir}`);
    }
  }

  private setStatus(text: string): void {
    if (this.statusInfoEl) this.statusInfoEl.setText(text);
    if (this.bulkEl) this.bulkEl.style.display = 'none';
    if (this.clearBtn) this.clearBtn.style.display = 'none';
  }

  private onListKeyDown(ev: KeyboardEvent): void {
    // 占位：保留后续上/下导航/选择
    if (ev.key === 'Backspace' && this.currentDir !== '/') {
      ev.preventDefault();
      void this.goUp();
    }
  }

  // ---- 导航 ----

  private async enter(dir: string): Promise<void> {
    if (this.mode === 'search') {
      this.mode = 'browse';
      this.searchInput.value = '';
      this.keyword = '';
    }
    this.stack.push(this.currentDir);
    this.currentDir = dir;
    this.selected.clear();
    this.lastClickedIndex = null;
    await this.refresh();
  }

  private async goUp(): Promise<void> {
    if (this.currentDir === '/') return;
    const parent = this.currentDir.slice(0, this.currentDir.lastIndexOf('/')) || '/';
    this.currentDir = parent;
    this.selected.clear();
    this.lastClickedIndex = null;
    await this.refresh();
  }

  // ---- 下载 / 文件管理（与 Modal 行为一致）----

  private async downloadFile(e: BrowserEntry, destBase = DOWNLOAD_DIR): Promise<boolean> {
    const notice = Notices.downloadStart(e.name);
    try {
      const api = this.pluginApi();
      const dlink = await api.getDlink(e.fsId, e.fullPath);
      let bytes = await api.downloadByDlink(dlink, e.name);
      if (looksEncrypted(bytes)) {
        const enc = this.plugin.createEncryptor();
        if (!enc) {
          notice.hide();
          Notices.encryptedNeedPass(e.name);
          return false;
        }
        try {
          bytes = await enc.decrypt(bytes);
        } catch (decErr) {
          notice.hide();
          Notices.decryptFail(e.name, decErr);
          return false;
        }
      }
      const adapter = this.app.vault.adapter;
      await adapter.mkdir(destBase).catch(() => {
        /* 已存在 */
      });
      const relPath = await this.uniquePath(`${destBase}/${sanitizeName(e.name)}`);
      await adapter.writeBinary(relPath, u8ToArrayBuffer(bytes));
      notice.hide();
      Notices.downloadDone(relPath, bytes.length);
      return true;
    } catch (err) {
      notice.hide();
      Notices.downloadFail(err);
      return false;
    }
  }

  private async downloadDir(e: BrowserEntry): Promise<void> {
    const notice = Notices.dirDownloadStart(e.name);
    try {
      let count = 0;
      const walk = async (dir: string, destBase: string) => {
        const api = this.pluginApi();
        const list = await api.listDir(dir);
        await this.app.vault.adapter.mkdir(destBase).catch(() => {
          /* ignore */
        });
        for (const it of list) {
          const fp = it.path || `${dir}/${it.name}`;
          const sub = `${destBase}/${sanitizeName(it.name)}`;
          if (it.isDir) {
            await walk(fp, sub);
          } else {
            const ok = await this.downloadFile({ ...it, fullPath: fp } as BrowserEntry, destBase);
            if (ok) count++;
          }
        }
      };
      await walk(e.fullPath, `${DOWNLOAD_DIR}/${sanitizeName(e.name)}`);
      notice.hide();
      Notices.dirDownloadDone(count, e.name);
    } catch (err) {
      notice.hide();
      Notices.dirDownloadFail(err);
    }
  }

  private async bulkDownload(): Promise<void> {
    const paths = [...this.selected];
    if (paths.length === 0) {
      Notices.bulkDownloadEmpty();
      return;
    }
    let ok = 0;
    for (const p of paths) {
      const entry = this.entries.find((e) => e.fullPath === p);
      if (!entry) continue;
      if (entry.isDir) await this.downloadDir(entry);
      else if (await this.downloadFile(entry)) ok++;
    }
    Notices.bulkDownloadDone(ok);
    this.selected.clear();
    this.lastClickedIndex = null;
    this.render();
  }

  private async deleteEntry(e: BrowserEntry): Promise<void> {
    if (
      !(await showConfirmModal(this.app, {
        title: `删除「${e.name}」`,
        message: '此操作将永久删除云端文件，且不影响本地仓库。确定？',
        danger: true,
        icon: 'trash-2',
        confirmText: '删除',
      }))
    )
      return;
    try {
      await this.pluginApi().deleteFiles([e.fullPath]);
      Notices.deleteDone(e.name);
      this.selected.delete(e.fullPath);
      await this.refresh();
    } catch (err) {
      Notices.deleteFail(err);
    }
  }

  private async bulkDelete(): Promise<void> {
    const paths = [...this.selected];
    if (paths.length === 0) {
      Notices.bulkDeleteEmpty();
      return;
    }
    if (
      !(await showConfirmModal(this.app, {
        title: `批量删除 ${paths.length} 项`,
        message: '将永久删除云端这些文件，不影响本地仓库。确定？',
        danger: true,
        icon: 'trash-2',
        confirmText: '删除',
      }))
    )
      return;
    try {
      await this.pluginApi().deleteFiles(paths);
      Notices.bulkDeleteDone(paths.length);
      this.selected.clear();
      this.lastClickedIndex = null;
      await this.refresh();
    } catch (err) {
      Notices.bulkDeleteFail(err);
    }
  }

  private async promptNewFolder(): Promise<void> {
    const name = await showPromptModal(this.app, {
      title: '新建文件夹',
      placeholder: '文件夹名称',
      defaultValue: '新文件夹',
    });
    if (!name) return;
    try {
      const dir = this.currentDir === '/' ? `/${name}` : `${this.currentDir}/${name}`;
      await this.pluginApi().mkdir(dir);
      Notices.created(dir);
      await this.refresh();
    } catch (err) {
      Notices.createFail(err);
    }
  }

  private async promptRename(e: BrowserEntry): Promise<void> {
    const name = await showPromptModal(this.app, {
      title: '重命名',
      placeholder: '新名称',
      defaultValue: e.name,
    });
    if (!name || name === e.name) return;
    try {
      await this.pluginApi().rename(e.fullPath, name);
      Notices.renamed(name);
      await this.refresh();
    } catch (err) {
      Notices.renameFail(err);
    }
  }

  private async moveToSyncDir(e: BrowserEntry): Promise<void> {
    const root = this.plugin.settings.remoteRoot || '/apps/bdnsync/MyVault';
    const dest = root === '/' ? `/${e.name}` : `${root}/${e.name}`;
    if (
      !(await showConfirmModal(this.app, {
        title: '移动到同步目录',
        message: `将「${e.name}」移动到 ${dest}，之后会被纳入本地同步。确定？`,
        icon: 'folder-input',
        confirmText: '移动',
      }))
    )
      return;
    try {
      await this.pluginApi().move(e.fullPath, root);
      Notices.moved(dest);
      await this.refresh();
    } catch (err) {
      Notices.moveFail(err);
    }
  }

  private async previewThumb(e: BrowserEntry): Promise<void> {
    const notice = Notices.thumbStart(e.name);
    try {
      const api = this.pluginApi();
      const dlink = await api.getDlink(e.fsId, e.fullPath);
      const bytes = await api.downloadByDlink(dlink, e.name);
      notice.hide();
      const url = bytesToPreviewUrl(bytes, e.name);
      const m = new MiniModal(this.app);
      m.renderImage(e.name, url, e.size);
      m.open();
    } catch (err) {
      notice.hide();
      Notices.thumbFail(err);
    }
  }

  /** 预览文件：在主内容区（workspace leaf）打开，支持图片/文本/PDF/Office/音视频 */
  private previewFile(e: BrowserEntry): void {
    if (!canPreview(e.name)) {
      Notices.previewUnsupported(e.name);
      return;
    }
    const target = {
      name: e.name,
      fsId: e.fsId,
      path: e.fullPath,
      size: e.size,
      mtime: e.mtime,
    };
    // 构造同目录媒体播放列表（视频/音频），支持剧集连续播放
    const mediaEntries = this.entries.filter(
      (en) => !en.isDir && (classifyFile(en.name) === 'video' || classifyFile(en.name) === 'audio'),
    );
    const index = mediaEntries.findIndex((en) => en.fullPath === e.fullPath);
    const playlist = mediaEntries.map((en) => ({
      name: en.name,
      fsId: en.fsId,
      path: en.fullPath,
      size: en.size,
      mtime: en.mtime,
    }));
    void openFilePreviewInLeaf(this.plugin, target, {
      playlist: playlist.length > 1 ? playlist : undefined,
      index: index >= 0 ? index : 0,
    });
  }

  private async createShare(e: BrowserEntry): Promise<void> {
    const notice = Notices.shareStart(e.name);
    try {
      const link = await this.pluginApi().createShareLink(e.fullPath);
      notice.hide();
      try {
        await navigator.clipboard.writeText(link);
        Notices.shareDone(link, true);
      } catch {
        Notices.shareDone(link, false);
      }
      const m = new MiniModal(this.app);
      m.renderShare(e.name, link);
      m.open();
    } catch (err) {
      notice.hide();
      Notices.shareFail(err);
    }
  }

  private async uniquePath(base: string): Promise<string> {
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(base))) return base;
    const dot = base.lastIndexOf('.');
    const stem = dot > base.lastIndexOf('/') ? base.slice(0, dot) : base;
    const ext = dot > base.lastIndexOf('/') ? base.slice(dot) : '';
    for (let i = 1; i < 1000; i++) {
      const cand = `${stem}-${i}${ext}`;
      if (!(await adapter.exists(cand))) return cand;
    }
    return `${stem}-${Date.now()}${ext}`;
  }
}
