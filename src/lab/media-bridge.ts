// BDNSync 实验功能：网盘媒体直嵌（MediaBridge）
//
// 通过 `bdn://` 引用语法，把百度网盘中的图片 / 视频 / 音频直接内嵌进 Obsidian 笔记渲染，
// 而无需把文件先下载到本地 vault。
//
// 设计不变量（来自规格）：
//   1. 永远不要因为单个媒体失败而打断整篇笔记的渲染，也不要把异常抛给渲染层。
//   2. 桌面端走既有 StreamServer 本地流式代理（零落盘、支持 Range）；移动端（无 Node http）
//      回退到 fetchBytes → 内存 Blob。
//   3. 解析阶段对引用字符串做严格校验：拒绝控制字符、反斜杠、`..` 穿越、超长、坏编码，
//      直接给中性占位符，绝不抛错。
//   4. 失败分级：离线（online 事件自动恢复）/ 限流（静默退避重试）/ 加密（致命，引导下载）/
//      鉴权过期（致命，引导重连）/ 文件消失（致命）/ 其他（手动重试）。
//   5. data-bdn 属性保留原始引用，供恢复 / 重试；data-bdn-ok 标记已成功，离线恢复时跳过。

import { Platform } from 'obsidian';
import type BDNSyncPlugin from '../main';
import {
  classifyFile,
  getExt,
  fetchBytes,
  streamUrlFor,
  type PreviewTarget,
} from '../ui/file-preview';
import { remoteJoin, remoteParent, remoteBaseName, mimeForExt } from '../util/misc';
import { BaiduApiError } from '../baidu/api';
import { getPinnedBlobUrl } from './offline-pin';
import { VIEW_TYPE_BDNSYNC_PREVIEW } from '../ui/views/preview-view';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface BdnRef {
  /** 网盘文件 fsId（优先）；可缺省，此时由 path 反查 */
  fsId?: string;
  /** 相对 remoteRoot 的路径，如 images/cat.png */
  path: string;
}

type FailKind = 'offline' | 'rate-limit' | 'encrypted' | 'auth' | 'gone' | 'generic';

interface BdnError {
  kind: FailKind;
  message: string;
  /** 是否可静默自动重试（离线 / 限流） */
  silent: boolean;
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const BDN_MAX_PATH = 1024;
const BDN_MAX_FSID = 64;
const SEMAPHORE = 6; // 同时最多 6 个内存 Blob 拉取
const FSID_CACHE_TTL = 5 * 60 * 1000; // 5 分钟

// fsId 反查缓存：parentDir -> { ts, map: filename -> { fsId, size, mtime } }
interface FsIdCacheEntry {
  fsId: string;
  size: number;
  mtime?: number;
}
const fsIdCache = new Map<string, { ts: number; map: Map<string, FsIdCacheEntry> }>();

// 并发信号量
let activeBlobs = 0;
const blobWaiters: Array<() => void> = [];

function acquireBlobSlot(): Promise<void> {
  if (activeBlobs < SEMAPHORE) {
    activeBlobs++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => blobWaiters.push(resolve));
}

function releaseBlobSlot(): void {
  activeBlobs = Math.max(0, activeBlobs - 1);
  const next = blobWaiters.shift();
  if (next) {
    activeBlobs++;
    next();
  }
}

// ---------------------------------------------------------------------------
// 引用解析
// ---------------------------------------------------------------------------

/**
 * 解析 `bdn://<fsId>|<path>` 或 `bdn://<path>`。
 * 校验失败或格式非法时返回 null（调用方给中性占位符），绝不抛异常。
 */
export function parseBdnRef(raw: string): BdnRef | null {
  try {
    if (!raw || typeof raw !== 'string') return null;
    const body = raw.startsWith('bdn://') ? raw.slice('bdn://'.length) : raw;
    if (body.length === 0 || body.length > BDN_MAX_PATH + BDN_MAX_FSID + 8) return null;

    // 解码（容错：坏编码直接拒绝，不 fallback）
    let decoded: string;
    try {
      decoded = decodeURIComponent(body);
    } catch {
      return null;
    }
    if (decoded !== body && body.includes('%') && !/%(?:[0-9A-Fa-f]{2})/.test(body)) {
      // 包含 % 但非合法转义，视为坏编码
      return null;
    }

    // 拒绝控制字符与空白字符（用 Unicode 类别 Cc 替代 \x00-\x1f，避免 no-control-regex 警告）
    if (/\p{Cc}/u.test(decoded)) return null;
    // 拒绝反斜杠（只接受正斜杠）
    if (decoded.includes('\\')) return null;
    // 拒绝路径穿越：仅当某个路径段严格等于 '..' 时才拒绝（避免误伤合法文件名，如 v2.0..final.png）
    if (decoded.split('/').some((seg) => seg === '..')) return null;

    // 拆分 fsId 与 path
    let fsId: string | undefined;
    let path: string;
    const bar = decoded.indexOf('|');
    if (bar >= 0) {
      const left = decoded.slice(0, bar).trim();
      const right = decoded.slice(bar + 1).trim();
      if (right.length === 0) return null;
      path = right;
      // 左段若像 fsId（纯数字/字母且非路径）则作为 fsId
      if (left.length > 0 && !left.includes('/') && left.length <= BDN_MAX_FSID) {
        fsId = left;
      }
    } else {
      path = decoded.trim();
    }

    if (path.length === 0 || path.length > BDN_MAX_PATH) return null;
    // 路径不能以 / 开头（相对 remoteRoot），但允许中间 / 分隔
    path = path.replace(/^\/+/, '');
    if (path.length === 0) return null;

    return { fsId, path };
  } catch {
    return null;
  }
}

/** 构造一个 bdn:// 引用（供插入命令使用） */
export function buildBdnRef(fsId: string | undefined, relPath: string): string {
  const p = relPath.replace(/^\/+/, '');
  return fsId ? `bdn://${fsId}|${p}` : `bdn://${p}`;
}

// ---------------------------------------------------------------------------
// 目标解析
// ---------------------------------------------------------------------------

/** 通过 parent 目录列表反查 fsId + 元信息（带 TTL 缓存） */
async function resolveFsIdByPath(
  plugin: BDNSyncPlugin,
  relPath: string,
): Promise<{ fsId: string; size: number; mtime?: number } | null> {
  try {
    const parent = remoteParent(relPath);
    const fileName = remoteBaseName(relPath);
    const remoteParentDir = remoteJoin(plugin.settings.remoteRoot || '', parent);

    const now = Date.now();
    const cached = fsIdCache.get(remoteParentDir);
    if (cached && now - cached.ts < FSID_CACHE_TTL) {
      const hit = cached.map.get(fileName);
      if (hit) return hit;
    }

    const api = plugin.createApi();
    const list = await api.listDir(remoteParentDir);
    const map = new Map<string, { fsId: string; size: number; mtime?: number }>();
    let found: { fsId: string; size: number; mtime?: number } | null = null;
    for (const item of list) {
      const name = remoteBaseName(item.path);
      const entry = { fsId: item.fsId, size: item.size, mtime: item.mtime };
      map.set(name, entry);
      if (name === fileName) found = entry;
    }
    fsIdCache.set(remoteParentDir, { ts: now, map });
    return found;
  } catch {
    return null;
  }
}

/**
 * 把 BdnRef 解析成 PreviewTarget（含 fsId + 完整 path + size）。
 * 解析失败返回 null，由调用方转占位符，不抛。
 */
async function resolveTarget(plugin: BDNSyncPlugin, ref: BdnRef): Promise<PreviewTarget | null> {
  try {
    let fsId = ref.fsId;
    let size = 0;
    let mtime: number | undefined;
    if (!fsId) {
      const looked = await resolveFsIdByPath(plugin, ref.path);
      if (!looked) return null;
      fsId = looked.fsId;
      size = looked.size;
      mtime = looked.mtime;
    }
    const fullPath = remoteJoin(plugin.settings.remoteRoot || '', ref.path);
    return { name: remoteBaseName(ref.path), fsId, path: fullPath, size, mtime };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 地址 / Blob 获取
// ---------------------------------------------------------------------------

/** 桌面端流式代理地址；不可用（非桌面 / 服务未起）返回 null */
function desktopStreamUrl(plugin: BDNSyncPlugin, target: PreviewTarget): string | null {
  try {
    if (!Platform.isDesktop) return null;
    return streamUrlFor(plugin, target) ?? null;
  } catch {
    return null;
  }
}

/** 移动端 / 桌面不可用时：拉取字节 → 内存 Blob URL */
async function fetchBlob(plugin: BDNSyncPlugin, target: PreviewTarget): Promise<string | null> {
  // 实验室：离线收藏优先——开启且已收藏时，离线/拉取失败均回退本地副本
  const pinEnabled = plugin.settings.labEnabled && plugin.settings.labOfflinePinEnabled;
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  if (pinEnabled) {
    try {
      const pinned = await getPinnedBlobUrl(plugin, target);
      // 离线时本地副本是唯一可用来源，直接返回；在线时优先走网络最新版，
      // 本地副本作为下方 fetch 失败时的兜底（见 catch 分支）。
      if (pinned && offline) return pinned;
    } catch {
      /* 忽略收藏读取异常 */
    }
  }

  await acquireBlobSlot();
  try {
    const bytes = await fetchBytes(plugin, target);
    const mime = mimeForExt(getExt(target.name));
    const blob = new Blob([bytes as BlobPart], { type: mime });
    return URL.createObjectURL(blob);
  } catch (e) {
    // 拉取失败：若已收藏，回退本地副本（离线可用）
    if (pinEnabled) {
      try {
        const pinned = await getPinnedBlobUrl(plugin, target);
        if (pinned) return pinned;
      } catch {
        /* ignore */
      }
    }
    throw e;
  } finally {
    releaseBlobSlot();
  }
}

// ---------------------------------------------------------------------------
// 错误分级
// ---------------------------------------------------------------------------

function classifyError(e: unknown): BdnError {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { kind: 'offline', message: '当前离线，恢复网络后自动重试', silent: true };
  }
  if (e instanceof BaiduApiError) {
    if (e.code === 'RATE_LIMIT') {
      return { kind: 'rate-limit', message: '命中接口限流，稍后自动重试', silent: true };
    }
    if (e.code === 'AUTH_FAILED') {
      return { kind: 'auth', message: '网盘授权已过期，请在设置中重新连接', silent: false };
    }
    if (e.code === 'NOT_FOUND') {
      return { kind: 'gone', message: '网盘文件已不存在（可能被移动或删除）', silent: false };
    }
    return { kind: 'generic', message: e.message || `网盘错误（errno=${e.errno}）`, silent: false };
  }
  if (e instanceof Error) {
    if (/加密/.test(e.message)) {
      return {
        kind: 'encrypted',
        message: '该文件已加密，请在设置中开启端到端加密后重试',
        silent: false,
      };
    }
    if (/解密失败/.test(e.message)) {
      return { kind: 'encrypted', message: `解密失败：${e.message}`, silent: false };
    }
    return { kind: 'generic', message: e.message || '加载失败', silent: false };
  }
  return { kind: 'generic', message: '加载失败', silent: false };
}

// ---------------------------------------------------------------------------
// 占位符 / 文件卡片
// ---------------------------------------------------------------------------

/** 通过 PreviewView 打开一个网盘文件（文件卡片 / 下载入口） */
function openBdnPreview(plugin: BDNSyncPlugin, target: PreviewTarget): void {
  try {
    const leaf = plugin.app.workspace.getLeaf(true);
    void leaf.setViewState({
      type: VIEW_TYPE_BDNSYNC_PREVIEW,
      state: { target },
      active: true,
    });
  } catch {
    /* 静默失败 */
  }
}

function makePlaceholder(
  plugin: BDNSyncPlugin,
  ref: BdnRef,
  label: string,
  opts: { kind: FailKind; retry?: boolean } = { kind: 'generic', retry: false },
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'bdnsync-bdn-ph';
  wrap.setAttribute('role', 'status');
  wrap.dataset.bdn = buildBdnRef(ref.fsId, ref.path);

  const icon = document.createElement('span');
  icon.className = 'bdnsync-bdn-ph-icon';
  icon.textContent = opts.kind === 'offline' ? '📡' : opts.kind === 'gone' ? '🗑' : '🖼';
  wrap.appendChild(icon);

  const text = document.createElement('span');
  text.className = 'bdnsync-bdn-ph-text';
  text.textContent = label;
  wrap.appendChild(text);

  if (opts.retry) {
    const btn = document.createElement('button');
    btn.className = 'bdnsync-bdn-ph-retry';
    btn.textContent = '重试';
    btn.addEventListener('click', () => {
      const host = document.createElement('span');
      host.className = 'bdnsync-bdn-host';
      wrap.replaceWith(host);
      void processOne(plugin, ref, host);
    });
  }
  return wrap;
}

function showFileCard(
  plugin: BDNSyncPlugin,
  ref: BdnRef,
  target: PreviewTarget | null,
): HTMLElement {
  const card = document.createElement('div');
  card.className = 'bdnsync-bdn-filecard';
  card.dataset.bdn = buildBdnRef(ref.fsId, ref.path);

  const name = document.createElement('div');
  name.className = 'bdnsync-bdn-filecard-name';
  name.textContent = ref.path;
  card.appendChild(name);

  if (target?.size) {
    const meta = document.createElement('div');
    meta.className = 'bdnsync-bdn-filecard-meta';
    meta.textContent = `${(target.size / 1024).toFixed(1)} KB · ${getExt(target.name).toUpperCase() || '文件'}`;
    card.appendChild(meta);
  }

  const btn = document.createElement('button');
  btn.className = 'bdnsync-bdn-filecard-open';
  btn.textContent = '打开 / 下载';
  btn.addEventListener('click', () => {
    if (target) openBdnPreview(plugin, target);
  });
  card.appendChild(btn);
  return card;
}

// ---------------------------------------------------------------------------
// 核心处理
// ---------------------------------------------------------------------------

/**
 * 处理一个 bdn 目标：根据类型渲染图片 / 视频 / 音频 / 文件卡片，或失败时给占位符。
 * el 必须是可被替换的容器（img 或占位 div）。解析得到的 ref 由调用方传入。
 */
async function processOne(plugin: BDNSyncPlugin, ref: BdnRef, host: HTMLElement): Promise<void> {
  try {
    const target = await resolveTarget(plugin, ref);
    if (!target) {
      const ph = makePlaceholder(plugin, ref, '无法解析网盘文件（路径或文件不存在）', {
        kind: 'gone',
      });
      host.replaceWith(ph);
      return;
    }

    const kind = classifyFile(target.name);

    // 非媒体 / 超体积：文件卡片（shouldInlineMedia 已封装两类判定）
    if (!shouldInlineMedia(target, plugin.settings)) {
      const card = showFileCard(plugin, ref, target);
      host.replaceWith(card);
      card.dataset.bdnOk = '1';
      return;
    }

    // 桌面端优先流式代理
    const streamUrl = desktopStreamUrl(plugin, target);
    if (streamUrl) {
      const media = renderMedia(kind, streamUrl, target, plugin.settings.cloudMediaLazyLoad);
      media.dataset.bdn = buildBdnRef(ref.fsId, ref.path);
      media.dataset.bdnOk = '1';
      host.replaceWith(media);
      return;
    }

    // 离线且无离线占位策略 → 占位
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      if (plugin.settings.cloudMediaOfflinePlaceholder) {
        const ph = makePlaceholder(plugin, ref, '离线中，恢复网络后自动加载', { kind: 'offline' });
        host.replaceWith(ph);
        return;
      }
    }

    // 移动端 / 桌面不可用时：拉 Blob
    let blobUrl: string | null = null;
    try {
      blobUrl = await fetchBlob(plugin, target);
    } catch (e) {
      const err = classifyError(e);
      const retry = err.kind === 'generic' || err.kind === 'encrypted' || err.kind === 'auth';
      const ph = makePlaceholder(plugin, ref, err.message, { kind: err.kind, retry });
      host.replaceWith(ph);
      return;
    }
    if (!blobUrl) {
      const ph = makePlaceholder(plugin, ref, '媒体加载失败', { kind: 'generic', retry: true });
      host.replaceWith(ph);
      return;
    }
    const media = renderMedia(kind, blobUrl, target, plugin.settings.cloudMediaLazyLoad);
    media.dataset.bdn = buildBdnRef(ref.fsId, ref.path);
    media.dataset.bdnOk = '1';
    host.replaceWith(media);
  } catch (e) {
    // 兜底：任何未预期异常都不外溢
    const err = classifyError(e);
    const ph = makePlaceholder(plugin, ref, err.message, { kind: err.kind, retry: true });
    host.replaceWith(ph);
  }
}

/** 是否应内联渲染（图片/视频/音频）还是退化为文件卡片。
 *  非媒体类型、或体积超过 cloudMediaMaxInlineMB（>0 时）则 false。 */
export function shouldInlineMedia(
  target: PreviewTarget,
  settings: { cloudMediaMaxInlineMB: number },
): boolean {
  const kind = classifyFile(target.name);
  if (kind === 'other' || kind === 'office' || kind === 'pdf') return false;
  const maxMB = settings.cloudMediaMaxInlineMB;
  if (maxMB > 0 && target.size > maxMB * 1024 * 1024) return false;
  return true;
}

/** 视频的 preload 取值：懒加载=none（交互才加载），否则=metadata（预取元数据）。 */
export function preloadForKind(kind: string, lazyLoad: boolean): 'none' | 'metadata' {
  if (kind !== 'video') return 'none';
  return lazyLoad ? 'none' : 'metadata';
}

function renderMedia(
  kind: string,
  url: string,
  target: PreviewTarget,
  lazyLoad: boolean,
): HTMLElement {
  const media = document.createElement(
    kind === 'video' ? 'video' : kind === 'audio' ? 'audio' : 'img',
  );
  media.className = 'bdnsync-bdn-media';
  media.setAttribute('src', url);
  media.setAttribute('alt', target.name);
  if (kind === 'video') {
    media.setAttribute('controls', '');
    // 视频懒加载：开启时 preload=none（交互才加载）；关闭时 preload=metadata 提前取元数据
    media.setAttribute('preload', preloadForKind(kind, lazyLoad));
  }
  if (kind === 'audio') media.setAttribute('controls', '');
  return media;
}

// ---------------------------------------------------------------------------
// 对外入口
// ---------------------------------------------------------------------------

/**
 * Markdown PostProcessor 入口：扫描 bdn:// 引用并渲染。
 * 由 main.ts 在 labEnabled && cloudMediaEnabled 时注册。
 */
export function rewriteBdnRefs(plugin: BDNSyncPlugin, el: HTMLElement): void {
  try {
    if (!plugin.settings.labEnabled || !plugin.settings.cloudMediaEnabled) return;

    // 收集 bdn:// 链接
    const links = Array.from(el.querySelectorAll('a[href^="bdn://"]')) as HTMLAnchorElement[];
    for (const a of links) {
      const ref = parseBdnRef(a.getAttribute('href') || '');
      if (!ref) continue;
      const host = document.createElement('span');
      host.className = 'bdnsync-bdn-host';
      a.replaceWith(host);
      void processOne(plugin, ref, host);
    }

    // 已存在占位符节点上的重试事件（由 CustomEvent 触发统一处理）
    // 这里不重复扫描 data-bdn-ok 节点，避免离线恢复时重复渲染
  } catch {
    /* 渲染层绝不抛 */
  }
}

/**
 * 网络恢复后，重新处理所有未成功的 bdn 占位符。
 * 由 main.ts 在 window 'online' 事件中调用。
 */
export function recoverBdnRefs(plugin: BDNSyncPlugin): void {
  try {
    if (!plugin.settings.labEnabled || !plugin.settings.cloudMediaEnabled) return;
    const phs = Array.from(document.querySelectorAll('.bdnsync-bdn-ph[data-bdn]')) as HTMLElement[];
    for (const ph of phs) {
      const ref = parseBdnRef(ph.dataset.bdn || '');
      if (!ref) continue;
      const host = document.createElement('span');
      host.className = 'bdnsync-bdn-host';
      ph.replaceWith(host);
      void processOne(plugin, ref, host);
    }
  } catch {
    /* 静默 */
  }
}
