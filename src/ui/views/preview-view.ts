// 网盘文件预览视图（ItemView）。
//
// 设计要点：
//   - 所有文件类型的预览（图片/文本/PDF/视频/音频/Office）一律在 **主内容区 leaf**
//     中打开，而不是 Modal 弹窗；用户可与笔记并列、可拖拽、可关闭 tab。
//   - 容器使用 flex 100% 布局：视频/图像/PDF 内容会自然跟随窗口/列宽变化，
//     无须手动 fitToStage。
//   - 每个 PreviewView 持有一个目标文件，多个文件可同时开多个 tab。
//   - 视频/音频：使用 media-player.ts 中的 mountMediaPlayer。
//   - 文本/PDF/图片：直接在本 view 渲染，复用 file-preview 的 stream/fetch 工具。
//
// 入口：
//   - openFilePreviewInLeaf(plugin, target) → 在新叶子打开预览
//   - openFilePreviewInLeaf(plugin, target, {reuse: true}) → 复用已有 preview leaf
//
// 视图状态序列化：把 PreviewTarget 存入 viewState state，refresh 时还原。

import { ItemView, WorkspaceLeaf, Notice } from 'obsidian';
import type BDNSyncPlugin from '../../main';
import { formatBytes, mimeForExt } from '../../util/misc';
import {
  streamUrlFor,
  fetchBytes,
  downloadToVault,
  classifyFile,
  getExt,
  type PreviewTarget,
} from '../file-preview';
import { mountMediaPlayer, type RepeatMode } from '../media-player';
import { setIcon } from '../components';
import { renderBacklinks } from '../../lab/backlinks';

export const VIEW_TYPE_BDNSYNC_PREVIEW = 'bdnsync-preview-view';

interface PreviewState {
  target: PreviewTarget;
  playlist?: PreviewTarget[];
  index?: number;
  repeatMode?: RepeatMode;
  // 兼容 Obsidian 基类的 Record<string, unknown> 要求
  [key: string]: unknown;
}

export class PreviewView extends ItemView {
  private target: PreviewTarget;
  private plugin: BDNSyncPlugin;
  /** 当前是否替换式复用同一个 leaf（true）或新开 leaf（false） */
  private replaceMode = false;
  private blobUrl: string | null = null;
  private mediaHandle: { destroy(): void } | null = null;
  private domDisposers: Array<() => void> = [];
  /** 播放列表（同目录媒体文件）与当前下标、循环模式 */
  private playlist: PreviewTarget[] = [];
  private playlistIndex = 0;
  private repeatMode: RepeatMode = 'off';

  constructor(leaf: WorkspaceLeaf, plugin: BDNSyncPlugin, target: PreviewTarget) {
    super(leaf);
    this.plugin = plugin;
    this.target = target;
  }

  getViewType(): string {
    return VIEW_TYPE_BDNSYNC_PREVIEW;
  }

  getDisplayText(): string {
    return this.target.name;
  }

  getIcon(): string {
    return 'eye';
  }

  async onOpen(): Promise<void> {
    // 仅当 target 非空才渲染（Obsidian 从 setViewState 恢复时构造的临时 view 可能 target 为空）
    if (this.target.name) this.render();
  }

  async onClose(): Promise<void> {
    this.cleanupDom();
    this.mediaHandle?.destroy();
    if (this.blobUrl) {
      URL.revokeObjectURL(this.blobUrl);
      this.blobUrl = null;
    }
  }

  /** 重新载入另一个文件（替换式复用同一个 leaf 时调用） */
  setTarget(
    target: PreviewTarget,
    options?: {
      replaceMode?: boolean;
      playlist?: PreviewTarget[];
      index?: number;
      repeatMode?: RepeatMode;
    },
  ): void {
    this.cleanupDom();
    this.mediaHandle?.destroy();
    this.mediaHandle = null;
    if (this.blobUrl) {
      URL.revokeObjectURL(this.blobUrl);
      this.blobUrl = null;
    }
    this.target = target;
    if (options?.playlist && options.playlist.length) {
      this.playlist = options.playlist;
      this.playlistIndex = options.index ?? 0;
    } else {
      this.playlist = [target];
      this.playlistIndex = 0;
    }
    if (options?.repeatMode) this.repeatMode = options.repeatMode;
    this.replaceMode = options?.replaceMode ?? this.replaceMode;
    this.render();
    // 同步 viewState 以便 Obsidian 正确恢复
    void this.leaf.setViewState({
      type: VIEW_TYPE_BDNSYNC_PREVIEW,
      state: {
        target,
        playlist: this.playlist,
        index: this.playlistIndex,
        repeatMode: this.repeatMode,
      },
      active: true,
    });
  }

  /** Obsidian 序列化 viewState 时会用上 */
  getState(): PreviewState {
    return {
      target: this.target,
      playlist: this.playlist,
      index: this.playlistIndex,
      repeatMode: this.repeatMode,
    };
  }

  /** Obsidian 从 viewState 恢复时调用：registerView 的第二个参数返回实例后引擎会调用 setState */
  async setState(state: PreviewState): Promise<void> {
    if (state?.target) {
      this.target = state.target;
      if (state.playlist && state.playlist.length) {
        this.playlist = state.playlist;
        this.playlistIndex = state.index ?? 0;
      } else {
        this.playlist = [state.target];
        this.playlistIndex = 0;
      }
      if (state.repeatMode) this.repeatMode = state.repeatMode;
      this.render();
    }
  }

  /** 播放列表续播：根据循环模式计算下一首/上一首并替换当前 leaf 内容 */
  private advance(dir: 1 | -1, mode: RepeatMode): void {
    this.repeatMode = mode;
    if (this.playlist.length <= 1) return;
    const last = this.playlist.length - 1;
    // off / one 模式手动切到首尾则停（不回绕）；list 回绕；shuffle 随机
    if (mode === 'off' || mode === 'one') {
      if (dir === 1 && this.playlistIndex >= last) return;
      if (dir === -1 && this.playlistIndex <= 0) return;
    }
    let idx = this.playlistIndex + dir;
    if (mode === 'list') {
      if (idx < 0) idx = last;
      if (idx > last) idx = 0;
    } else if (mode === 'shuffle') {
      if (this.playlist.length === 1) return;
      let r = this.playlistIndex;
      while (r === this.playlistIndex) r = Math.floor(Math.random() * this.playlist.length);
      idx = r;
    }
    this.playlistIndex = idx;
    this.setTarget(this.playlist[idx], {
      replaceMode: true,
      playlist: this.playlist,
      index: idx,
      repeatMode: this.repeatMode,
    });
  }

  private cleanupDom(): void {
    for (const d of this.domDisposers) {
      try {
        d();
      } catch {
        /* ignore */
      }
    }
    this.domDisposers = [];
  }

  private render(): void {
    // containerEl.children[1] 是 Obsidian 的 .view-content 区域，flex 100% 父布局
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass('bdnsync-preview-view-content');
    root.removeClass(
      'bdnsync-preview-kind-text',
      'bdnsync-preview-kind-image',
      'bdnsync-preview-kind-pdf',
      'bdnsync-preview-kind-video',
      'bdnsync-preview-kind-audio',
      'bdnsync-preview-kind-office',
    );

    const kind = classifyFile(this.target.name);
    root.addClass(`bdnsync-preview-kind-${kind}`);

    // 顶部 bar：图标 + 标题 + 元数据 + 操作（下载、新标签打开、关闭）
    const bar = root.createDiv({ cls: 'bdnsync-preview-view-bar' });
    const info = bar.createDiv({ cls: 'bdnsync-preview-view-info' });
    const kindIcon = getKindIcon(kind);
    setIcon(info.createSpan({ cls: 'bdnsync-preview-view-icon' }), kindIcon, 16);
    info.createSpan({ cls: 'bdnsync-preview-view-name', text: this.target.name });
    info.createSpan({
      cls: 'bdnsync-preview-view-sub',
      text: `${formatBytes(this.target.size)}${this.target.mtime ? ' · ' + new Date(this.target.mtime).toLocaleString() : ''} · ${getExt(this.target.name).toUpperCase() || '文件'}`,
    });
    const actions = bar.createDiv({ cls: 'bdnsync-preview-view-actions' });

    const dlBtn = actions.createEl('button', {
      cls: 'bdnsync-btn bdnsync-btn-sm bdnsync-btn-primary',
      attr: { title: '下载到仓库' },
    });
    setIcon(dlBtn, 'arrow-down', 14);

    if (kind === 'pdf' || kind === 'text' || kind === 'office') {
      const openNew = actions.createEl('button', {
        cls: 'bdnsync-btn bdnsync-btn-sm',
        attr: { title: '在新标签页打开流式直链' },
      });
      setIcon(openNew, 'external-link', 14);
      dlBtn.addEventListener('click', () => void downloadToVault(this.plugin, this.target));
      openNew.addEventListener('click', () => {
        const u = streamUrlFor(this.plugin, this.target);
        if (u) window.open(u, '_blank', 'noopener');
        else new Notice('流式代理未运行，无法在新标签打开');
      });
    } else {
      dlBtn.addEventListener('click', () => void downloadToVault(this.plugin, this.target));
    }

    // body：按类型分派
    const body = root.createDiv({ cls: 'bdnsync-preview-view-body' });
    switch (kind) {
      case 'video':
      case 'audio':
        this.renderMedia(body, kind);
        break;
      case 'image':
        this.renderImage(body);
        break;
      case 'pdf':
        this.renderPdf(body);
        break;
      case 'text':
        this.renderText(body);
        break;
      case 'office':
        this.renderOffice(body);
        break;
      default:
        body.createDiv({
          cls: 'bdnsync-empty bdnsync-danger-text',
          text: '此文件类型暂不支持预览，请使用「下载到仓库」。',
        });
    }

    // 实验室：网盘文件反向引用（Backlinks）
    if (this.plugin.settings.labEnabled && this.plugin.settings.labBacklinksEnabled) {
      void renderBacklinks(this.plugin, root, this.target).catch(() => {});
    }
  }

  // -------------------------------------------------------------------
  // 各类型渲染
  // -------------------------------------------------------------------

  private renderMedia(body: HTMLElement, kind: 'video' | 'audio'): void {
    // mountMediaPlayer 完全接管 host 子节点
    this.mediaHandle?.destroy();
    const hasPlaylist = this.playlist.length > 1;
    this.mediaHandle = mountMediaPlayer(body, this.plugin, this.target, kind, {
      onAdvance: hasPlaylist ? (dir, mode) => this.advance(dir, mode) : undefined,
      repeatMode: this.repeatMode,
      playlistLabel: hasPlaylist
        ? `第 ${this.playlistIndex + 1} / ${this.playlist.length} 集`
        : undefined,
      hasPrev:
        hasPlaylist &&
        (this.repeatMode === 'list' || this.repeatMode === 'shuffle' || this.playlistIndex > 0),
      hasNext:
        hasPlaylist &&
        (this.repeatMode === 'list' ||
          this.repeatMode === 'shuffle' ||
          this.playlistIndex < this.playlist.length - 1),
    });
  }

  private renderImage(body: HTMLElement): void {
    const stage = body.createDiv({ cls: 'bdnsync-preview-stage bdnsync-image-stage' });
    const loading = stage.createDiv({ cls: 'bdnsync-loading', text: '正在加载图片…' });
    const ext = getExt(this.target.name);
    void (async () => {
      try {
        const streamUrl = streamUrlFor(this.plugin, this.target);
        const url = streamUrl;
        if (url) {
          loading.remove();
          const img = stage.createEl('img', {
            cls: 'bdnsync-preview-image',
            attr: { src: url, alt: this.target.name },
          });
          this.blobUrl = url;
          img.addEventListener('error', async () => {
            // 流式失败回退 blob
            try {
              const bytes = await fetchBytes(this.plugin, this.target);
              const blob = new Blob([bytes as unknown as ArrayBufferView], { type: mimeFor(ext) });
              const u = URL.createObjectURL(blob);
              this.blobUrl = u;
              img.src = u;
            } catch {
              /* error already shown below */
            }
          });
        } else {
          const bytes = await fetchBytes(this.plugin, this.target);
          const blob = new Blob([bytes as unknown as ArrayBufferView], { type: mimeFor(ext) });
          this.blobUrl = URL.createObjectURL(blob);
          loading.remove();
          stage.createEl('img', {
            cls: 'bdnsync-preview-image',
            attr: { src: this.blobUrl, alt: this.target.name },
          });
        }
      } catch (e) {
        loading.remove();
        stage.createDiv({
          cls: 'bdnsync-empty bdnsync-danger-text',
          text: `图片加载失败：${e instanceof Error ? e.message : String(e)}`,
        });
      }
    })();
  }

  private renderPdf(body: HTMLElement): void {
    const stage = body.createDiv({ cls: 'bdnsync-preview-stage bdnsync-pdf-stage' });
    const loading = stage.createDiv({ cls: 'bdnsync-loading', text: '正在加载 PDF…' });
    void (async () => {
      try {
        const streamUrl = streamUrlFor(this.plugin, this.target);
        let url: string;
        if (streamUrl) {
          this.blobUrl = streamUrl;
          url = streamUrl;
        } else {
          const bytes = await fetchBytes(this.plugin, this.target);
          const blob = new Blob([bytes as unknown as ArrayBufferView], { type: 'application/pdf' });
          this.blobUrl = URL.createObjectURL(blob);
          url = this.blobUrl;
        }
        loading.remove();
        const iframe = stage.createEl('iframe', { cls: 'bdnsync-preview-iframe' });
        iframe.setAttribute('title', this.target.name);
        iframe.src = url + '#toolbar=1&navpanes=1&view=FitH';
      } catch (e) {
        loading.remove();
        stage.createDiv({
          cls: 'bdnsync-empty bdnsync-danger-text',
          text: `PDF 加载失败：${e instanceof Error ? e.message : String(e)}`,
        });
      }
    })();
  }

  private renderText(body: HTMLElement): void {
    const stage = body.createDiv({ cls: 'bdnsync-preview-stage bdnsync-text-stage' });
    const loading = stage.createDiv({ cls: 'bdnsync-loading', text: '正在加载…' });
    const host = stage.createDiv({ cls: 'bdnsync-text-host' });
    void (async () => {
      try {
        let text: string;
        let byteLen = 0;
        const streamUrl = streamUrlFor(this.plugin, this.target);
        if (streamUrl) {
          try {
            const resp = await fetch(streamUrl);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            text = await resp.text();
            byteLen = new TextEncoder().encode(text).byteLength;
          } catch {
            const bytes = await fetchBytes(this.plugin, this.target);
            text = new TextDecoder('utf-8').decode(bytes);
            byteLen = bytes.byteLength;
          }
        } else {
          const bytes = await fetchBytes(this.plugin, this.target);
          text = new TextDecoder('utf-8').decode(bytes);
          byteLen = bytes.byteLength;
        }
        loading.remove();
        const ext = getExt(this.target.name);
        const isMarkdown = ext === 'md' || ext === 'markdown';
        const TEXT_PREVIEW_LIMIT = 200_000;
        if (isMarkdown && byteLen <= TEXT_PREVIEW_LIMIT) {
          const rendered = host.createDiv({ cls: 'bdnsync-markdown-preview markdown-rendered' });
          const { MarkdownRenderer } = await import('obsidian');
          try {
            await MarkdownRenderer.render(
              this.app,
              text,
              rendered,
              this.target.path,
              this as unknown as import('obsidian').Component,
            );
          } catch {
            rendered.empty();
            rendered.createEl('pre', { cls: 'bdnsync-text-pre', text });
          }
        } else if (byteLen > TEXT_PREVIEW_LIMIT) {
          host.createEl('pre', {
            cls: 'bdnsync-text-pre',
            text: text.slice(0, TEXT_PREVIEW_LIMIT),
          });
          host.createDiv({
            cls: 'bdnsync-text-trunc-note',
            text: `内容超过 ${formatBytes(TEXT_PREVIEW_LIMIT)}，已截断显示。完整内容请「下载到仓库」后查看。`,
          });
        } else {
          host.createEl('pre', { cls: 'bdnsync-text-pre', text });
        }
      } catch (e) {
        loading.remove();
        host.createDiv({
          cls: 'bdnsync-empty bdnsync-danger-text',
          text: `预览失败：${e instanceof Error ? e.message : String(e)}`,
        });
      }
    })();
  }

  private renderOffice(body: HTMLElement): void {
    const stage = body.createDiv({ cls: 'bdnsync-preview-stage bdnsync-office-stage' });
    stage.createDiv({ cls: 'bdnsync-loading', text: '正在准备 Office 预览…' });
    // Office 没有原生的免费浏览器渲染（Edge Web Viewer 需要域名/IP 白名单），
    // 这里给出"网页预览/百度文档"两条出口 + 下载到库兜底。
    stage.empty();
    stage.addClass('bdnsync-office-empty');
    const msg = stage.createDiv({ cls: 'bdnsync-office-msg' });
    msg.createEl('div', {
      cls: 'bdnsync-office-title',
      text: 'Office 文档在浏览器内直接渲染支持有限',
    });
    msg.createEl('div', {
      cls: 'bdnsync-office-sub',
      text: `${this.target.name}（${formatBytes(this.target.size)}）`,
    });
    const acts = stage.createDiv({ cls: 'bdnsync-office-actions' });
    const dlBtn = acts.createEl('button', {
      cls: 'bdnsync-btn bdnsync-btn-primary',
      text: '下载到仓库后用 Obsidian 打开',
    });
    setIcon(dlBtn, 'arrow-down', 14);
    dlBtn.addEventListener('click', () => void downloadToVault(this.plugin, this.target));
    const openNew = acts.createEl('button', { cls: 'bdnsync-btn', text: '复制直链到剪贴板' });
    setIcon(openNew, 'external-link', 14);
    openNew.addEventListener('click', async () => {
      const u = streamUrlFor(this.plugin, this.target);
      if (!u) return new Notice('流式代理未运行');
      try {
        await navigator.clipboard.writeText(u);
        new Notice('已复制流式直链到剪贴板（在外部浏览器打开）');
      } catch {
        new Notice(`直链：${u}`);
      }
    });
  }
}

function mimeFor(ext: string): string {
  return mimeForExt(ext);
}

function getKindIcon(kind: import('../file-preview').FileKind): import('../components').IconName {
  switch (kind) {
    case 'image':
      return 'image';
    case 'text':
      return 'file-text';
    case 'video':
      return 'film';
    case 'audio':
      return 'music';
    case 'pdf':
      return 'file-text';
    case 'office':
      return 'file-spreadsheet';
    default:
      return 'file-question';
  }
}

// -------------------------------------------------------------------
// 入口：在 workspace leaf 中打开预览
// -------------------------------------------------------------------

/**
 * 在主内容区（root split）打开一个网盘文件预览 leaf。
 * 默认每个文件开一个新 tab；可传 `{ reuse: true }` 复用第一个现有 preview leaf。
 */
export async function openFilePreviewInLeaf(
  plugin: BDNSyncPlugin,
  target: PreviewTarget,
  opts: {
    reuse?: boolean;
    reveal?: boolean;
    playlist?: PreviewTarget[];
    index?: number;
    repeatMode?: RepeatMode;
  } = {},
): Promise<PreviewView> {
  const { workspace } = plugin.app;
  const reuse = opts.reuse === true;
  const stateExtra =
    opts.playlist && opts.playlist.length
      ? { playlist: opts.playlist, index: opts.index ?? 0, repeatMode: opts.repeatMode }
      : {};

  // 1) 先查现有 preview leaf
  let leaf: WorkspaceLeaf | null = null;
  let view: PreviewView | null = null;
  if (reuse) {
    const existing = workspace.getLeavesOfType(VIEW_TYPE_BDNSYNC_PREVIEW);
    if (existing.length > 0) {
      leaf = existing[0];
      view = leaf.view as unknown as PreviewView;
    }
  }

  // 2) 没找到则新开
  if (!leaf) {
    leaf = workspace.getLeaf('split');
    await leaf.setViewState({
      type: VIEW_TYPE_BDNSYNC_PREVIEW,
      state: { target, ...stateExtra },
      active: true,
    });
    view = leaf.view as unknown as PreviewView;
    if (view && !view.getState().target) view.setTarget(target, stateExtra);
  } else if (view) {
    view.setTarget(target, stateExtra);
  }

  if (opts.reveal !== false) workspace.revealLeaf(leaf);
  return view as PreviewView;
}
