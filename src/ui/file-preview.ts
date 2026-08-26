// 网盘文件预览体系（参照参考代码 svp 的 openPreview/fillPreview + 各类预览器，
// 适配本项目的 createModalHeader + shell 架构，并做了进一步优化）。
//
// 支持的文件类型与分发：
//   图片  png/jpg/jpeg/gif/webp/svg/bmp/ico/avif/tiff/tif  → ImagePreviewModal（缩放/全屏）
//   文本  md/txt/csv/json/xml/log/yml/yaml/ini/toml/conf/sh → TextPreviewModal（高亮/截断/可选渲染）
//   音视频 mp4/webm/mov/avi/mp3/flac/...                    → MediaPreviewModal（进度/音量/倍速）
//   PDF   pdf                                          → PdfPreviewModal（iframe + 工具栏 + 全屏）
//   Office doc/docx/ppt/pptx/xls/xlsx                  → OfficePreviewModal（百度在线预览 / 降级下载）
//   其他  → 提示不支持并引导下载
//
// 所有预览器共用：下载到仓库（_netdisk_downloads）、下载进度提示、blob/objectURL 释放。

import { App, Modal, Notice } from 'obsidian';
import type BDNSyncPlugin from '../main';
import { formatBytes } from '../util/misc';
import { looksEncrypted } from '../crypto/encryption';
import { createModalHeader, setIcon } from './components';
// 视频/音频已全部改用 media-player 的 mountMediaPlayer 在 ItemView 中挂载，
// 不再需要 Modal 类版本。

/**
 * 解析预览用的「流式直链」。优先用本地 StreamServer 的 /stream 地址（浏览器直接请求，
 * 服务器把百度直链响应流 pipe 过来，零落盘、边下边播）；StreamServer 未启动或地址为空时
 * 返回 null，调用方回退到 fetchBytes（内存 blob）方案。
 */
export function streamUrlFor(
  plugin: BDNSyncPlugin,
  t: PreviewTarget,
  quality = 'auto',
): string | null {
  const srv = plugin.getStreamServer();
  if (!srv || !srv.isRunning) return null;
  const url = srv.buildStreamUrl(t, quality);
  return url || null;
}

// ---- 文件类型判定（搬运并扩展参考的 Mt/De/Ie/Le/yo） ----

export function getExt(name: string): string {
  const i = (name.split('/').pop() || '').lastIndexOf('.');
  return i < 0 ? '' : (name.split('/').pop() || '').slice(i + 1).toLowerCase();
}

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif', 'tif', 'tiff'];
const TEXT_EXT = [
  'md',
  'markdown',
  'txt',
  'text',
  'csv',
  'tsv',
  'json',
  'xml',
  'log',
  'yml',
  'yaml',
  'ini',
  'toml',
  'conf',
  'cfg',
  'sh',
  'bat',
  'ps1',
  'sql',
  'html',
  'htm',
];
const VIDEO_EXT = [
  'mp4',
  'mkv',
  'webm',
  'mov',
  'avi',
  'flv',
  'm4v',
  'ts',
  'rmvb',
  'wmv',
  'mpg',
  'mpeg',
];
const AUDIO_EXT = ['mp3', 'flac', 'aac', 'ogg', 'wav', 'm4a', 'opus', 'wma', 'ape'];
const OFFICE_EXT = [
  'doc',
  'docx',
  'ppt',
  'pptx',
  'xls',
  'xlsx',
  'dot',
  'dotx',
  'pot',
  'potx',
  'xlt',
  'xltx',
  'rtf',
];

export type FileKind = 'image' | 'text' | 'video' | 'audio' | 'pdf' | 'office' | 'other';

export function classifyFile(name: string): FileKind {
  const ext = getExt(name);
  if (ext === 'pdf') return 'pdf';
  if (IMAGE_EXT.includes(ext)) return 'image';
  if (TEXT_EXT.includes(ext)) return 'text';
  if (VIDEO_EXT.includes(ext)) return 'video';
  if (AUDIO_EXT.includes(ext)) return 'audio';
  if (OFFICE_EXT.includes(ext)) return 'office';
  return 'other';
}

/** 该类型是否支持内置预览（false 时引导下载） */
export function canPreview(name: string): boolean {
  return classifyFile(name) !== 'other';
}

const MIME_MAP: Record<string, string> = {
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
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
  flv: 'video/x-flv',
  m4v: 'video/mp4',
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  opus: 'audio/ogg',
  wma: 'audio/x-ms-wma',
  json: 'application/json',
  xml: 'application/xml',
  csv: 'text/csv',
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  log: 'text/plain',
  html: 'text/html',
  htm: 'text/html',
};

function mimeFor(ext: string): string {
  return MIME_MAP[ext] || 'application/octet-stream';
}

const TEXT_PREVIEW_LIMIT = 200_000; // 200KB 以内直接内联；超出截断并提示下载

// ---- 共享辅助 ----

export interface PreviewTarget {
  name: string;
  fsId: string;
  path: string;
  size: number;
  mtime?: number;
}

function sanitizeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'download';
}

/** 通过插件 API 下载并解密（如需）一个网盘文件，返回原始字节 */
export async function fetchBytes(plugin: BDNSyncPlugin, t: PreviewTarget): Promise<Uint8Array> {
  const api = plugin.createApi();
  const dlink = await api.getDlink(t.fsId, t.path);
  let bytes = await api.downloadByDlink(dlink, t.path);
  if (looksEncrypted(bytes)) {
    const enc = plugin.createEncryptor();
    if (!enc) throw new Error(`${t.name} 是加密文件，请先在设置中开启端到端加密并填写密码`);
    try {
      bytes = await enc.decrypt(bytes);
    } catch (e) {
      throw new Error(`${t.name} 解密失败（${e instanceof Error ? e.message : String(e)}）`);
    }
  }
  return bytes;
}

/** 下载到仓库（_netdisk_downloads），供各预览器复用 */
export async function downloadToVault(
  plugin: BDNSyncPlugin,
  t: PreviewTarget,
): Promise<string | null> {
  const notice = new Notice(`BDNSync：正在下载 ${t.name}…`, 0);
  try {
    const bytes = await fetchBytes(plugin, t);
    const adapter = plugin.app.vault.adapter;
    const base = '_netdisk_downloads';
    await adapter.mkdir(base).catch(() => {
      /* 已存在 */
    });
    let rel = `${base}/${sanitizeName(t.name)}`;
    if (await adapter.exists(rel)) {
      const dot = rel.lastIndexOf('.');
      const stem = dot > rel.lastIndexOf('/') ? rel.slice(0, dot) : rel;
      const ext = dot > rel.lastIndexOf('/') ? rel.slice(dot) : '';
      rel = `${stem}-${Date.now()}${ext}`;
    }
    await adapter.writeBinary(
      rel,
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    );
    notice.hide();
    new Notice(`BDNSync：已下载到 ${rel}`);
    return rel;
  } catch (e) {
    notice.hide();
    new Notice(`BDNSync：下载失败 — ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

// ---- 通用下载动作行 ----

function buildActionBar(host: HTMLElement, plugin: BDNSyncPlugin, t: PreviewTarget): void {
  const bar = host.createDiv({ cls: 'bdnsync-preview-actions' });
  const dl = bar.createEl('button', {
    cls: 'bdnsync-btn bdnsync-btn-primary bdnsync-btn-sm',
    attr: { title: '下载到仓库' },
  });
  setIcon(dl, 'arrow-down', 14);
  dl.createSpan({ text: ' 下载到仓库' });
  dl.addEventListener('click', () => void downloadToVault(plugin, t));
}

// ======================================================================
// 文本预览（参考 svp fillPreview 的 yo 分支，做了大幅扩展与优化）
// ======================================================================

export class TextPreviewModal extends Modal {
  private t: PreviewTarget;
  private plugin: BDNSyncPlugin;
  private blobUrls: string[] = [];
  private truncated = false;

  constructor(app: App, plugin: BDNSyncPlugin, t: PreviewTarget) {
    super(app);
    this.plugin = plugin;
    this.t = t;
    this.modalEl.addClass('bdnsync-modal', 'bdnsync-text-preview-modal');
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    const shell = contentEl.createDiv({ cls: 'bdnsync-modal-shell' });
    const sub = `${formatBytes(this.t.size)}${this.t.mtime ? ' · ' + new Date(this.t.mtime).toLocaleString() : ''} · ${getExt(this.t.name).toUpperCase() || '文本'}`;
    createModalHeader(shell, { title: this.t.name, subtitle: sub, icon: 'file-text' });
    const body = shell.createDiv({ cls: 'bdnsync-modal-body bdnsync-text-preview-body' });

    const loading = body.createDiv({ cls: 'bdnsync-loading', text: '正在加载…' });
    const host = body.createDiv({ cls: 'bdnsync-text-host' });

    void (async () => {
      try {
        let text: string;
        let byteLen = 0;
        const streamUrl = streamUrlFor(this.plugin, this.t);
        if (streamUrl) {
          // 流式直链：浏览器直接请求本地代理（零落盘），按 Range/整文件取文本
          try {
            const resp = await fetch(streamUrl);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            text = await resp.text();
            byteLen = new TextEncoder().encode(text).byteLength;
          } catch (e) {
            // 回退：内存下载
            const bytes = await fetchBytes(this.plugin, this.t);
            text = new TextDecoder('utf-8').decode(bytes);
            byteLen = bytes.byteLength;
          }
        } else {
          const bytes = await fetchBytes(this.plugin, this.t);
          text = new TextDecoder('utf-8').decode(bytes);
          byteLen = bytes.byteLength;
        }
        loading.remove();
        if (this.truncated) return;
        const ext = getExt(this.t.name);
        const isMarkdown = ext === 'md' || ext === 'markdown';
        if (isMarkdown && byteLen <= TEXT_PREVIEW_LIMIT) {
          // 优化：Markdown 用 Obsidian 原生渲染器，体验更好
          const rendered = host.createDiv({ cls: 'bdnsync-markdown-preview markdown-rendered' });
          const { MarkdownRenderer } = await import('obsidian');
          try {
            await MarkdownRenderer.render(
              this.app,
              text,
              rendered,
              this.t.path,
              this as unknown as import('obsidian').Component,
            );
          } catch {
            rendered.empty();
            rendered.createEl('pre', { cls: 'bdnsync-text-pre', text });
          }
        } else {
          if (byteLen > TEXT_PREVIEW_LIMIT) {
            this.truncated = true;
            const pre = host.createDiv({ cls: 'bdnsync-text-pre' });
            pre.setText(text.slice(0, TEXT_PREVIEW_LIMIT));
            host.createDiv({
              cls: 'bdnsync-text-trunc-note',
              text: `内容超过 ${formatBytes(TEXT_PREVIEW_LIMIT)}，已截断显示。完整内容请「下载到仓库」后查看。`,
            });
          } else {
            const pre = host.createDiv({ cls: 'bdnsync-text-pre' });
            pre.setText(text);
          }
        }
        buildActionBar(body, this.plugin, this.t);
      } catch (e) {
        loading.remove();
        host.createDiv({
          cls: 'bdnsync-empty bdnsync-danger-text',
          text: `预览失败：${e instanceof Error ? e.message : String(e)}`,
        });
        buildActionBar(body, this.plugin, this.t);
      }
    })();
  }

  onClose(): void {
    for (const u of this.blobUrls) URL.revokeObjectURL(u);
    this.blobUrls = [];
    this.contentEl.empty();
  }
}

// ======================================================================
// 图片预览（参考 svp fillPreview 的 De 分支）
// ======================================================================

export class ImagePreviewModal extends Modal {
  private t: PreviewTarget;
  private plugin: BDNSyncPlugin;
  private blobUrl: string | null = null;

  constructor(app: App, plugin: BDNSyncPlugin, t: PreviewTarget) {
    super(app);
    this.plugin = plugin;
    this.t = t;
    this.modalEl.addClass('bdnsync-modal', 'bdnsync-image-preview-modal');
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    const shell = contentEl.createDiv({ cls: 'bdnsync-modal-shell' });
    createModalHeader(shell, {
      title: this.t.name,
      subtitle: formatBytes(this.t.size),
      icon: 'image',
    });
    const body = shell.createDiv({ cls: 'bdnsync-modal-body bdnsync-image-preview-body' });

    const loading = body.createDiv({ cls: 'bdnsync-loading', text: '正在加载图片…' });
    const stage = body.createDiv({ cls: 'bdnsync-image-stage' });
    const ext = getExt(this.t.name);

    void (async () => {
      try {
        const streamUrl = streamUrlFor(this.plugin, this.t);
        if (streamUrl) {
          // 流式直链：img 直接请求本地代理（零落盘）
          loading.remove();
          this.blobUrl = streamUrl;
          const img = stage.createEl('img', {
            cls: 'bdnsync-image-preview-img',
            attr: { src: streamUrl, alt: this.t.name },
          });
          img.addEventListener('error', async () => {
            // 流式失败回退 blob
            try {
              const bytes = await fetchBytes(this.plugin, this.t);
              const blob = new Blob([bytes as unknown as ArrayBufferView], { type: mimeFor(ext) });
              const u = URL.createObjectURL(blob);
              img.src = u;
            } catch {
              /* 错误已由下方处理 */
            }
          });
          img.addEventListener('load', () => {
            img.style.maxWidth = '100%';
            img.style.maxHeight = '100%';
            img.style.objectFit = 'contain';
          });
          buildActionBar(body, this.plugin, this.t);
          return;
        }
        const bytes = await fetchBytes(this.plugin, this.t);
        loading.remove();
        const blob = new Blob([bytes as unknown as ArrayBufferView], { type: mimeFor(ext) });
        this.blobUrl = URL.createObjectURL(blob);
        const img = stage.createEl('img', {
          cls: 'bdnsync-image-preview-img',
          attr: { src: this.blobUrl, alt: this.t.name },
        });
        img.addEventListener('load', () => {
          img.style.maxWidth = '100%';
          img.style.maxHeight = '100%';
          img.style.objectFit = 'contain';
        });
        buildActionBar(body, this.plugin, this.t);
      } catch (e) {
        loading.remove();
        stage.createDiv({
          cls: 'bdnsync-empty bdnsync-danger-text',
          text: `图片加载失败：${e instanceof Error ? e.message : String(e)}`,
        });
        buildActionBar(body, this.plugin, this.t);
      }
    })();
  }

  onClose(): void {
    if (this.blobUrl) URL.revokeObjectURL(this.blobUrl);
    this.blobUrl = null;
    this.contentEl.empty();
  }
}

// ======================================================================
// PDF 预览（参考 svp un 类：iframe + 工具栏参数 + 全屏 + 新标签）
// ======================================================================

function withPdfToolbar(url: string): string {
  const params = '#toolbar=1&navpanes=1&pagemode=bookmarks&view=FitH';
  return url.includes('#') ? `${url}&${params.slice(1)}` : `${url}${params}`;
}

export class PdfPreviewModal extends Modal {
  private t: PreviewTarget;
  private plugin: BDNSyncPlugin;
  private iframe: HTMLIFrameElement | null = null;
  private blobUrl: string | null = null;
  private fsBtn: HTMLButtonElement | null = null;
  private onFsChange = () => {
    if (!this.fsBtn) return;
    const fs = !!document.fullscreenElement;
    setIcon(this.fsBtn, fs ? 'minimize-2' : 'maximize-2', 14);
    this.fsBtn.setAttr('title', fs ? '退出全屏 (Esc)' : '全屏');
  };

  constructor(app: App, plugin: BDNSyncPlugin, t: PreviewTarget) {
    super(app);
    this.plugin = plugin;
    this.t = t;
    this.modalEl.addClass('bdnsync-modal', 'bdnsync-pdf-preview-modal');
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    const shell = contentEl.createDiv({ cls: 'bdnsync-modal-shell' });
    createModalHeader(shell, {
      title: this.t.name,
      subtitle: formatBytes(this.t.size),
      icon: 'file-text',
    });
    const body = shell.createDiv({ cls: 'bdnsync-modal-body bdnsync-pdf-preview-body' });

    // 顶部工具条
    const bar = body.createDiv({ cls: 'bdnsync-pdf-bar' });
    const info = bar.createDiv({ cls: 'bdnsync-pdf-bar-info' });
    info.createSpan({ cls: 'bdnsync-pdf-bar-name', text: this.t.name });
    info.createSpan({ cls: 'bdnsync-pdf-bar-sub', text: formatBytes(this.t.size) });
    const actions = bar.createDiv({ cls: 'bdnsync-pdf-bar-actions' });

    const openNew = actions.createEl('button', {
      cls: 'bdnsync-btn bdnsync-btn-sm',
      attr: { title: '在新标签页打开' },
    });
    setIcon(openNew, 'external-link', 14);
    const dl = actions.createEl('button', {
      cls: 'bdnsync-btn bdnsync-btn-sm bdnsync-btn-primary',
      attr: { title: '下载到仓库' },
    });
    setIcon(dl, 'arrow-down', 14);
    this.fsBtn = actions.createEl('button', {
      cls: 'bdnsync-btn bdnsync-btn-sm',
      attr: { title: '全屏' },
    });
    setIcon(this.fsBtn, 'maximize-2', 14);

    const stage = body.createDiv({ cls: 'bdnsync-pdf-stage' });
    const loading = stage.createDiv({ cls: 'bdnsync-loading', text: '正在加载 PDF…' });

    const showIframe = (url: string) => {
      loading.remove();
      const iframe = stage.createEl('iframe', { cls: 'bdnsync-preview-iframe' });
      iframe.setAttribute('title', this.t.name);
      iframe.onerror = () => {
        stage.empty();
        stage.createDiv({
          cls: 'bdnsync-empty bdnsync-danger-text',
          text: 'PDF 渲染失败，请改用「下载到仓库」后本地打开。',
        });
      };
      iframe.src = withPdfToolbar(url);
      this.iframe = iframe;
    };

    void (async () => {
      try {
        const streamUrl = streamUrlFor(this.plugin, this.t);
        if (streamUrl) {
          // 流式直链：iframe 直接请求本地代理（零落盘）
          loading.remove();
          this.blobUrl = streamUrl;
          showIframe(streamUrl);
          return;
        }
        const bytes = await fetchBytes(this.plugin, this.t);
        const blob = new Blob([bytes as unknown as ArrayBufferView], { type: 'application/pdf' });
        this.blobUrl = URL.createObjectURL(blob);
        showIframe(this.blobUrl);
      } catch (e) {
        loading.remove();
        stage.createDiv({
          cls: 'bdnsync-empty bdnsync-danger-text',
          text: `PDF 加载失败：${e instanceof Error ? e.message : String(e)}`,
        });
      }
    })();

    openNew.addEventListener('click', () => {
      if (this.iframe?.src) window.open(this.iframe.src, '_blank', 'noopener');
    });
    dl.addEventListener('click', () => void downloadToVault(this.plugin, this.t));
    this.fsBtn.addEventListener('click', () => {
      const el = this.contentEl;
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {
          /* ignore */
        });
      } else {
        const fs =
          el.requestFullscreen ||
          (el as unknown as { webkitRequestFullscreen?: () => Promise<void> })
            .webkitRequestFullscreen;
        if (fs) fs.call(el).catch(() => new Notice('当前环境不支持全屏 API'));
        else new Notice('当前环境不支持全屏 API');
      }
    });
    document.addEventListener('fullscreenchange', this.onFsChange);
    body.createDiv({
      cls: 'bdnsync-pdf-hint',
      text: '阅读器右侧/左侧栏可查看书签与大纲 · 顶部「全屏」可沉浸阅读',
    });
  }

  onClose(): void {
    document.removeEventListener('fullscreenchange', this.onFsChange);
    if (this.blobUrl) URL.revokeObjectURL(this.blobUrl);
    this.blobUrl = null;
    this.iframe = null;
    this.fsBtn = null;
    this.contentEl.empty();
  }
}

// ======================================================================
// 媒体预览（音视频）已不再使用 Modal 版本，统一改用 media-player.ts 的
// mountMediaPlayer 函数在 ItemView (preview-view.ts) 中挂载，容器自适应。
// ======================================================================

// ======================================================================
// Office 预览（doc/docx/ppt/pptx/xls/xlsx）
// 优化：cookie 模式用百度网盘在线预览页 iframe；openapi 模式降级为下载提示。
// ======================================================================

export class OfficePreviewModal extends Modal {
  private t: PreviewTarget;
  private plugin: BDNSyncPlugin;

  constructor(app: App, plugin: BDNSyncPlugin, t: PreviewTarget) {
    super(app);
    this.plugin = plugin;
    this.t = t;
    this.modalEl.addClass('bdnsync-modal', 'bdnsync-office-preview-modal');
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    const shell = contentEl.createDiv({ cls: 'bdnsync-modal-shell' });
    createModalHeader(shell, {
      title: this.t.name,
      subtitle: formatBytes(this.t.size),
      icon: 'file-spreadsheet',
    });
    const body = shell.createDiv({ cls: 'bdnsync-modal-body bdnsync-office-preview-body' });

    const api = this.plugin.createApi();
    const mode = api.getAuthMode();

    if (mode === 'cookies') {
      // cookie 模式：百度网盘在线预览页（需登录 Cookie，iframe 自动携带）
      const previewUrl = `https://pan.baidu.com/rest/2.0/xpan/file?method=preview&fsid=${encodeURIComponent(this.t.fsId)}&path=${encodeURIComponent(this.t.path)}&web=1&channel=dubox&clienttype=0`;
      const loading = body.createDiv({ cls: 'bdnsync-loading', text: '正在加载在线预览…' });
      const stage = body.createDiv({ cls: 'bdnsync-office-stage' });
      const iframe = stage.createEl('iframe', { cls: 'bdnsync-preview-iframe' });
      iframe.setAttribute('title', this.t.name);
      iframe.onload = () => loading.remove();
      iframe.onerror = () => {
        loading.remove();
        stage.empty();
        this.renderFallback(stage);
      };
      iframe.src = previewUrl;
      buildActionBar(body, this.plugin, this.t);
    } else {
      // openapi 模式：无完整网盘登录态，在线预览不可用，引导下载
      const note = body.createDiv({ cls: 'bdnsync-office-fallback' });
      this.renderFallback(note);
      buildActionBar(body, this.plugin, this.t);
    }
  }

  private renderFallback(host: HTMLElement): void {
    host.empty();
    host.createDiv({ cls: 'bdnsync-empty', text: '当前授权模式不支持在线预览 Office 文档。' });
    host.createDiv({
      cls: 'bdnsync-office-tip',
      text: '建议：「下载到仓库」后用本地 Office / WPS 打开；或切换到「Cookies 直连」模式以启用百度在线预览。',
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

// ======================================================================
// 不支持的文件类型：引导下载
// ======================================================================

export class UnsupportedModal extends Modal {
  private t: PreviewTarget;
  private plugin: BDNSyncPlugin;

  constructor(app: App, plugin: BDNSyncPlugin, t: PreviewTarget) {
    super(app);
    this.plugin = plugin;
    this.t = t;
    this.modalEl.addClass('bdnsync-modal', 'bdnsync-unsupported-modal');
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    const shell = contentEl.createDiv({ cls: 'bdnsync-modal-shell' });
    createModalHeader(shell, {
      title: this.t.name,
      subtitle: formatBytes(this.t.size),
      icon: 'file-question',
    });
    const body = shell.createDiv({ cls: 'bdnsync-modal-body' });
    body.createDiv({
      cls: 'bdnsync-empty',
      text: '暂不支持内置预览此文件类型，可下载到仓库后用本地应用打开。',
    });
    buildActionBar(body, this.plugin, this.t);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
