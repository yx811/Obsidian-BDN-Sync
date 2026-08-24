// 百度网盘文件浏览器：查看云端目录/文件、搜索、新建/重命名/移动/删除、
// 选择同步目录、下载（单文件 / 递归目录）到本地。
// 使用统一 .bdnsync-modal-shell 骨架（head/body/foot），body 内部滚动，
// 避免 Obsidian 外层 modal 整体下滑。

import { App, Modal, Notice } from 'obsidian';
import { BaiduApi, type RemoteRawEntry } from '../baidu/api';
import type BDNSyncPlugin from '../main';
import { formatBytes, formatTime, u8ToArrayBuffer, mimeForExt } from '../util/misc';
import { looksEncrypted } from '../crypto/encryption';
import {
  createCard,
  createCompactButton,
  createIconButton,
  showConfirmModal,
  showPromptModal,
  MiniModal,
  setIcon,
  makeResizable,
} from './components';

type BrowserEntry = RemoteRawEntry & { fullPath: string };

const DOWNLOAD_DIR = '_netdisk_downloads';

/** 图片类文件后缀（用于缩略图预览） */
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|ico|tiff?|avif)$/i;

function isImageFile(name: string): boolean {
  return IMAGE_EXT.test(name);
}

function sanitizeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'download';
}

/** 把二进制转为可预览的 URL。
 * 优先用 Blob + URL.createObjectURL（避免 base64 全程驻留内存，且规避
 * String.fromCharCode.apply 在大图下触发调用栈限制的风险）；
 * 环境不支持时回退到 base64 dataURL。返回的 URL 应在不再需要时 revoke。 */
function bytesToPreviewUrl(bytes: Uint8Array, name: string): string {
  const ext = (name.split('.').pop() || 'png').toLowerCase();
  const mime = mimeForExt(ext);
  try {
    const blob = new Blob([bytes as unknown as ArrayBufferView], { type: mime });
    return URL.createObjectURL(blob);
  } catch {
    // 回退 base64（小图安全路径）
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

type SortKey = 'name' | 'size' | 'mtime';
type Mode = 'browse' | 'search';

export class NetdiskBrowserModal extends Modal {
  private currentDir = '/';
  private stack: string[] = [];
  private entries: BrowserEntry[] = [];
  private loading = false;
  private mode: Mode = 'browse';
  private keyword = '';
  private sortKey: SortKey = 'name';
  private sortAsc = true;
  private selected = new Set<string>();

  private shellEl!: HTMLElement;
  private headEl!: HTMLElement;
  private bodyEl!: HTMLElement;
  private footEl!: HTMLElement;
  private listEl!: HTMLElement;
  private breadcrumbEl!: HTMLElement;
  private searchInput!: HTMLInputElement;
  private statusEl!: HTMLElement;

  constructor(
    app: App,
    private plugin: BDNSyncPlugin,
    private onSelectDir?: (dir: string) => void,
  ) {
    super(app);
    this.modalEl.addClass('bdnsync-modal', 'bdnsync-browser-modal');
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    const shell = contentEl.createDiv({ cls: 'bdnsync-modal-shell' });
    this.shellEl = shell;

    // head：标题 + 工具栏
    const head = shell.createDiv({ cls: 'bdnsync-modal-head' });
    head.createEl('h3', { text: '百度网盘文件浏览器', cls: 'bdnsync-modal-title' });

    const toolbar = head.createDiv({ cls: 'bdnsync-browser-toolbar' });
    createIconButton(toolbar, {
      icon: 'rotate-ccw',
      label: '刷新',
      onClick: () => void this.refresh(),
    });
    createIconButton(toolbar, { icon: 'arrow-up', label: '上级', onClick: () => void this.goUp() });
    this.searchInput = toolbar.createEl('input', {
      cls: 'bdnsync-browser-search',
      attr: { type: 'text', placeholder: '搜索文件名…', 'aria-label': '搜索文件名' },
    });
    this.searchInput.addEventListener('input', () => {
      this.keyword = this.searchInput.value.trim();
      if (this.keyword) void this.doSearch();
      else {
        this.mode = 'browse';
        void this.refresh();
      }
    });
    if (this.onSelectDir) {
      createIconButton(toolbar, {
        icon: 'check',
        label: '选为同步目录',
        primary: true,
        onClick: () => {
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          this.onSelectDir!(this.currentDir);
          new Notice(`BDNSync：同步目录已设为 ${this.currentDir}`);
          this.close();
        },
      });
    }

    this.breadcrumbEl = head.createDiv({ cls: 'bdnsync-browser-breadcrumb' });

    // body：列表（内部滚动）
    const body = shell.createDiv({ cls: 'bdnsync-modal-body bdnsync-browser-body' });
    this.bodyEl = body;
    // 表头
    const header = body.createDiv({ cls: 'bdnsync-browser-row bdnsync-browser-header' });
    header.createEl('span', { text: '', cls: 'bdnsync-browser-check' });
    const cName = header.createEl('span', { text: '名称', cls: 'bdnsync-browser-sortable' });
    cName.addEventListener('click', () => this.toggleSort('name'));
    const cSize = header.createEl('span', { text: '大小', cls: 'bdnsync-browser-sortable' });
    cSize.addEventListener('click', () => this.toggleSort('size'));
    const cTime = header.createEl('span', { text: '修改时间', cls: 'bdnsync-browser-sortable' });
    cTime.addEventListener('click', () => this.toggleSort('mtime'));
    header.createEl('span', { text: '操作', cls: 'bdnsync-browser-opcol' });

    this.listEl = body.createDiv({ cls: 'bdnsync-browser-list' });
    this.listEl.createDiv({ cls: 'bdnsync-browser-loading', text: '加载中…' });

    // foot：状态信息 + 批量操作
    const foot = shell.createDiv({ cls: 'bdnsync-modal-foot bdnsync-browser-foot' });
    this.footEl = foot;
    this.statusEl = foot.createDiv({ cls: 'bdnsync-browser-status', text: '准备中…' });
    const actions = foot.createDiv({ cls: 'bdnsync-browser-bulk' });
    createIconButton(actions, {
      icon: 'download',
      label: '批量下载',
      onClick: () => void this.bulkDownload(),
    });
    createIconButton(actions, {
      icon: 'trash-2',
      label: '批量删除',
      danger: true,
      onClick: () => void this.bulkDelete(),
    });
    createIconButton(actions, {
      icon: 'folder-plus',
      label: '新建文件夹',
      onClick: () => void this.promptNewFolder(),
    });
    createIconButton(actions, {
      icon: 'x',
      label: '取消选择',
      onClick: () => {
        this.selected.clear();
        this.render();
      },
    });

    void this.refresh();

    // 支持用户拖拽调整弹窗尺寸（自适应 + 手动）；scope 隔离多 vault 尺寸
    makeResizable(this.modalEl, contentEl, 'browser', this.app.vault.getName());
  }

  // ---------------- 数据 ----------------

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
      this.listEl.createEl('div', {
        cls: 'bdnsync-empty-state',
        text: `加载失败：${e instanceof Error ? e.message : String(e)}`,
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
      this.listEl.createEl('div', {
        cls: 'bdnsync-empty-state',
        text: `搜索失败：${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      this.loading = false;
    }
  }

  private sortEntries(): void {
    const dir = this.sortAsc ? 1 : -1;
    this.entries.sort((a, b) => {
      // 目录永远在前
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

  // ---------------- 渲染 ----------------

  private render(): void {
    this.renderBreadcrumb();
    this.renderList();
    this.updateStatus();
  }

  private renderBreadcrumb(): void {
    this.breadcrumbEl.empty();
    if (this.mode === 'search') {
      const back = this.breadcrumbEl.createEl('span', {
        text: '← 返回浏览',
        cls: 'bdnsync-browser-crumb',
      });
      back.addEventListener('click', () => {
        this.mode = 'browse';
        this.searchInput.value = '';
        this.keyword = '';
        void this.refresh();
      });
      this.breadcrumbEl.createEl('span', {
        text: ` · 搜索「${this.keyword}」`,
        cls: 'bdnsync-browser-crumb-sep',
      });
      return;
    }
    const parts = this.currentDir.split('/').filter(Boolean);
    const rootCrumb = this.breadcrumbEl.createEl('span', {
      text: '网盘',
      cls: 'bdnsync-browser-crumb',
    });
    rootCrumb.addEventListener('click', () => void this.enter('/'));
    let acc = '';
    for (const p of parts) {
      this.breadcrumbEl.createEl('span', { text: '/', cls: 'bdnsync-browser-crumb-sep' });
      acc = acc ? `${acc}/${p}` : `/${p}`;
      const crumb = this.breadcrumbEl.createEl('span', { text: p, cls: 'bdnsync-browser-crumb' });
      const target = acc;
      crumb.addEventListener('click', () => void this.enter(target));
    }
  }

  private renderList(): void {
    this.listEl.empty();
    if (this.entries.length === 0) {
      createCard(this.listEl).createEl('div', {
        cls: 'bdnsync-empty-state',
        text: this.mode === 'search' ? '无匹配结果' : '此目录为空',
      });
      return;
    }
    for (const e of this.entries) {
      const checked = this.selected.has(e.fullPath);
      const row = this.listEl.createDiv({
        cls: `bdnsync-browser-row${checked ? ' bdnsync-browser-row-selected' : ''}`,
      });
      if (e.isDir) row.addClass('bdnsync-browser-dir');

      // 选择框
      const chk = row.createEl('input', {
        cls: 'bdnsync-browser-check',
        attr: { type: 'checkbox' },
      }) as HTMLInputElement;
      chk.checked = checked;
      chk.setAttribute('aria-label', `选择 ${e.name}`);
      chk.addEventListener('change', () => {
        if (chk.checked) this.selected.add(e.fullPath);
        else this.selected.delete(e.fullPath);
        row.toggleClass('bdnsync-browser-row-selected', chk.checked);
        this.updateStatus();
      });

      // 名称
      const nameCell = row.createEl('div', { cls: 'bdnsync-browser-name' });
      const iconWrap = nameCell.createSpan({ cls: 'bdnsync-browser-icon' });
      setIcon(iconWrap, e.isDir ? 'folder' : isImageFile(e.name) ? 'image' : 'file-text', 16);
      nameCell.createEl('span', { text: e.name, cls: 'bdnsync-browser-label' });

      row.createEl('span', {
        text: e.isDir ? '—' : formatBytes(e.size),
        cls: 'bdnsync-browser-meta',
      });
      row.createEl('span', { text: formatTime(e.mtime), cls: 'bdnsync-browser-meta' });

      // 操作（紧凑图标按钮：仅图标 + hover tooltip，hover 行时显示）
      const actions = row.createDiv({ cls: 'bdnsync-browser-actions' });
      if (e.isDir) {
        createCompactButton(actions, {
          icon: 'chevron-right',
          label: '进入',
          onClick: () => void this.enter(e.fullPath),
        });
        createCompactButton(actions, {
          icon: 'download',
          label: '下载目录',
          onClick: () => void this.downloadDir(e),
        });
      } else {
        createCompactButton(actions, {
          icon: 'arrow-down',
          label: '下载',
          onClick: () => void this.downloadFile(e),
        });
        // 图片类文件：缩略图预览
        if (isImageFile(e.name)) {
          createCompactButton(actions, {
            icon: 'eye',
            label: '预览缩略图',
            onClick: () => void this.previewThumb(e),
          });
        }
        // 生成分享链接
        createCompactButton(actions, {
          icon: 'share-2',
          label: '生成分享链接',
          onClick: () => void this.createShare(e),
        });
      }
      createCompactButton(actions, {
        icon: 'pencil',
        label: '重命名',
        onClick: () => void this.promptRename(e),
      });
      createCompactButton(actions, {
        icon: 'folder-input',
        label: '移动到同步目录',
        onClick: () => void this.moveToSyncDir(e),
      });
      createCompactButton(actions, {
        icon: 'trash-2',
        label: '删除',
        danger: true,
        onClick: () => void this.deleteEntry(e),
      });
      if (this.onSelectDir && e.isDir) {
        createCompactButton(actions, {
          icon: 'check',
          label: '选此目录',
          active: true,
          onClick: () => {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            this.onSelectDir!(e.fullPath);
            new Notice(`BDNSync：同步目录已设为 ${e.fullPath}`);
            this.close();
          },
        });
      }
    }
  }

  private updateStatus(): void {
    const dirCount = this.entries.filter((e) => e.isDir).length;
    const fileCount = this.entries.length - dirCount;
    const base =
      this.mode === 'search'
        ? `搜索「${this.keyword}」 · 共 ${this.entries.length} 项`
        : `当前目录：${this.currentDir} · 共 ${this.entries.length} 项（目录 ${dirCount} / 文件 ${fileCount}）`;
    this.setStatus(this.selected.size > 0 ? `${base} · 已选 ${this.selected.size} 项` : base);
  }

  private setStatus(text: string): void {
    if (this.statusEl) this.statusEl.setText(text);
  }

  // ---------------- 导航 ----------------

  private async enter(dir: string): Promise<void> {
    if (this.mode === 'search') {
      this.mode = 'browse';
      this.searchInput.value = '';
      this.keyword = '';
    }
    this.stack.push(this.currentDir);
    this.currentDir = dir;
    this.selected.clear();
    await this.refresh();
  }

  private async goUp(): Promise<void> {
    if (this.currentDir === '/') return;
    const parent = this.currentDir.slice(0, this.currentDir.lastIndexOf('/')) || '/';
    this.currentDir = parent;
    this.selected.clear();
    await this.refresh();
  }

  // ---------------- 下载 ----------------

  private async downloadFile(e: BrowserEntry, destBase = DOWNLOAD_DIR): Promise<boolean> {
    const notice = new Notice(`BDNSync：正在下载 ${e.name}…`, 0);
    try {
      const api = this.pluginApi();
      const dlink = await api.getDlink(e.fsId, e.fullPath);
      let bytes = await api.downloadByDlink(dlink, e.name);
      if (looksEncrypted(bytes)) {
        const enc = this.plugin.createEncryptor();
        if (!enc) {
          notice.hide();
          new Notice(`BDNSync：${e.name} 是加密文件，请先开启端到端加密并填写密码`, 8000);
          return false;
        }
        try {
          bytes = await enc.decrypt(bytes);
        } catch (decErr) {
          notice.hide();
          new Notice(
            `BDNSync：${e.name} 解密失败（${decErr instanceof Error ? decErr.message : String(decErr)}）`,
            8000,
          );
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
      new Notice(`BDNSync：已下载到 ${relPath}（${formatBytes(bytes.length)}）`);
      return true;
    } catch (err) {
      notice.hide();
      new Notice(`BDNSync：下载失败 — ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /** 递归下载整个目录（含子目录） */
  private async downloadDir(e: BrowserEntry): Promise<void> {
    const notice = new Notice(`BDNSync：正在下载目录 ${e.name}…`, 0);
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
      new Notice(`BDNSync：目录下载完成，共 ${count} 个文件 → ${DOWNLOAD_DIR}/${e.name}`);
    } catch (err) {
      notice.hide();
      new Notice(`BDNSync：目录下载失败 — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async bulkDownload(): Promise<void> {
    const paths = [...this.selected];
    if (paths.length === 0) {
      new Notice('请先勾选要下载的文件/目录');
      return;
    }
    let ok = 0;
    for (const p of paths) {
      const entry = this.entries.find((e) => e.fullPath === p);
      if (!entry) continue;
      if (entry.isDir) await this.downloadDir(entry);
      else if (await this.downloadFile(entry)) ok++;
    }
    new Notice(`BDNSync：批量下载完成（${ok} 个文件）`);
    this.selected.clear();
    this.render();
  }

  // ---------------- 文件管理 ----------------

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
      new Notice(`BDNSync：已删除 ${e.name}`);
      this.selected.delete(e.fullPath);
      await this.refresh();
    } catch (err) {
      new Notice(`BDNSync：删除失败 — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async bulkDelete(): Promise<void> {
    const paths = [...this.selected];
    if (paths.length === 0) {
      new Notice('请先勾选要删除的文件');
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
      new Notice(`BDNSync：已删除 ${paths.length} 项`);
      this.selected.clear();
      await this.refresh();
    } catch (err) {
      new Notice(`BDNSync：批量删除失败 — ${err instanceof Error ? err.message : String(err)}`);
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
      new Notice(`BDNSync：已创建 ${dir}`);
      await this.refresh();
    } catch (err) {
      new Notice(`BDNSync：创建失败 — ${err instanceof Error ? err.message : String(err)}`);
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
      new Notice(`BDNSync：已重命名为 ${name}`);
      await this.refresh();
    } catch (err) {
      new Notice(`BDNSync：重命名失败 — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 把云端文件移动到本插件同步根目录（便于纳入同步） */
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
      new Notice(`BDNSync：已移动到同步目录 ${dest}`);
      await this.refresh();
    } catch (err) {
      new Notice(`BDNSync：移动失败 — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---------------- 辅助 ----------------

  private pluginApi(): BaiduApi {
    return this.plugin.createApi();
  }

  /** 图片文件：下载后弹窗预览缩略图（dataURL 渲染） */
  private async previewThumb(e: BrowserEntry): Promise<void> {
    const notice = new Notice(`BDNSync：加载缩略图 ${e.name}…`, 0);
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
      new Notice(`BDNSync：缩略图加载失败 — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 生成并复制分享链接 */
  private async createShare(e: BrowserEntry): Promise<void> {
    const notice = new Notice(`BDNSync：正在生成分享链接 ${e.name}…`, 0);
    try {
      const link = await this.pluginApi().createShareLink(e.fullPath);
      notice.hide();
      // 复制到剪贴板
      try {
        await navigator.clipboard.writeText(link);
        new Notice(`BDNSync：分享链接已生成并复制到剪贴板：\n${link}`, 10000);
      } catch {
        new Notice(`BDNSync：分享链接已生成：\n${link}`, 10000);
      }
      // 同时弹窗展示，便于手动复制
      const m = new MiniModal(this.app);
      m.renderShare(e.name, link);
      m.open();
    } catch (err) {
      notice.hide();
      new Notice(`BDNSync：生成分享链接失败 — ${err instanceof Error ? err.message : String(err)}`);
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

  onClose(): void {
    this.contentEl.empty();
  }
}
