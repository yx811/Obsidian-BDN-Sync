// 通用工具：路径、glob 过滤、格式化、重试退避等

import { Platform } from 'obsidian';
import type { BDNSyncSettings } from '../types';

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Uint8Array → 独立 ArrayBuffer（避免共享缓冲区偏移问题） */
export function u8ToArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

export function randomId(len = 8): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

export function genDeviceId(): string {
  const platform =
    (navigator.platform || 'desktop')
      .toString()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 8) || 'device';
  // 用密码学随机Uuid 作为随机部分，避免多设备碰撞（此前用 Date.now + Math.random 非密码学）。
  // crypto.randomUUID 在 Electron / 现代浏览器安全上下文可用；不可用则回退到 randomId。
  let rand: string;
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      rand = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    } else {
      rand = randomId(16);
    }
  } catch {
    rand = randomId(16);
  }
  return `${platform}-${rand}`;
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatTime(ms: number): string {
  if (!ms) return '从未';
  const d = new Date(ms);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 冲突副本命名：{base}.conflict-{YYYYMMDD-HHMMSS}-{origin}{.ext} */
export function conflictName(path: string, origin: 'LOCAL' | 'REMOTE'): string {
  const d = new Date();
  const p = (x: number) => String(x).padStart(2, '0');
  const ts = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const idx = path.lastIndexOf('.');
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
  const base =
    idx > dir.length
      ? path.slice(dir.length, idx)
      : path.slice(dir.length);
  const ext = idx > dir.length ? path.slice(idx) : '';
  return `${dir}${base}.conflict-${ts}-${origin}${ext}`;
}

// ---------- 远程路径工具（网盘路径统一以 / 开头，正斜杠） ----------

export function normalizeRemote(p: string): string {
  let r = (p || '/').replace(/\\/g, '/');
  if (!r.startsWith('/')) r = '/' + r;
  r = r.replace(/\/+/g, '/');
  if (r.length > 1 && r.endsWith('/')) r = r.slice(0, -1);
  return r || '/';
}

export function remoteJoin(...parts: string[]): string {
  return normalizeRemote(parts.filter(Boolean).join('/'));
}

export function remoteParent(p: string): string {
  const n = normalizeRemote(p);
  if (n === '/') return '/';
  const idx = n.lastIndexOf('/');
  return idx <= 0 ? '/' : n.slice(0, idx);
}

export function remoteBaseName(p: string): string {
  const n = normalizeRemote(p);
  return n === '/' ? '/' : n.slice(n.lastIndexOf('/') + 1);
}

// ---------- glob 过滤 ----------

/** glob → RegExp。支持 **、*（不含 /）、?（不含 /）；无通配符时按前缀目录匹配 */
export function globToRegExp(pattern: string): RegExp {
  const p = pattern.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!p) return /$^/;
  const hasWildcard = /[*?]/.test(p);
  if (!hasWildcard) {
    // 纯路径：匹配自身或其子路径
    const esc = escapeRe(p.replace(/\/+$/, ''));
    return new RegExp(`^${esc}(/.*)?$`);
  }
  let re = '';
  let i = 0;
  while (i < p.length) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        // /** 或 **/
        if (p[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 3;
        } else {
          re += '.*';
          i += 2;
        }
      } else {
        re += '[^/]*';
        i += 1;
      }
    } else if (c === '?') {
      re += '[^/]';
      i += 1;
    } else {
      re += escapeRe(c);
      i += 1;
    }
  }
  return new RegExp(`^${re}$`);
}

function escapeRe(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

const ALWAYS_EXCLUDE = [
  /^\.obsidian\/plugins\/bdnsync\/.*/,
  /^\.bdnsync-backup\/.*/,
  /^\.bdnsync\/.*/,
  // P0-1.2/1.3 基础设施目录：祖先快照（.bdnsync-base/）与合并草稿（.bdnsync-merge-draft/）
  // 是插件内部数据，绝不参与同步比对、删除传播或 orphan 识别。
  /^\.bdnsync-base\/.*/,
  /^\.bdnsync-merge-draft\/.*/,
  // 空目录占位符（#3.8）：仅存在于远端索引/偶发落盘，绝不参与正常比对，避免删除传播循环。
  /^\.bdnsync-empty-.*/,
  // 密钥文件（#3.5）：含密码源，严禁被同步上云泄露。
  /^\.bdnsync-key(\.|$)/,
];

/** 空目录占位符文件名前缀（#3.8）：位于某目录下时，表示该目录在远端应保留为空目录 */
export const EMPTY_DIR_MARKER_PREFIX = '.bdnsync-empty-';
/** 密钥文件名（#3.5）：vault 内约定文件作为密码源 */
export const KEY_FILE_NAME = '.bdnsync-key';

export class PathFilter {
  private regexes: RegExp[] = [];
  private includeRegexes: RegExp[] = [];

  constructor(private settings: BDNSyncSettings) {
    for (const p of settings.excludePatterns || []) {
      if (p.trim()) this.regexes.push(globToRegExp(p));
    }
    for (const p of settings.includePatterns || []) {
      if (p.trim()) this.includeRegexes.push(globToRegExp(p));
    }
  }

  /** 是否应排除（不同步）该相对路径 */
  isExcluded(path: string): boolean {
    const p = path.replace(/\\/g, '/');
    if (ALWAYS_EXCLUDE.some((re) => re.test(p))) return true;
    // 选择性同步白名单（#4.2）：include 非空时仅放行命中项
    if (this.includeRegexes.length > 0) {
      return !this.includeRegexes.some((re) => re.test(p));
    }
    if (!this.settings.syncConfigDir && (p === '.obsidian' || p.startsWith('.obsidian/')))
      return true;
    if (this.settings.syncConfigDir) {
      // 同步配置目录时排除工作区状态与本插件自身数据
      if (/^\.obsidian\/workspace/.test(p)) return true;
    }
    if (this.settings.skipHiddenFiles) {
      const segs = p.split('/');
      if (segs.some((s) => s.startsWith('.') && s !== '.obsidian')) return true;
    }
    return this.regexes.some((re) => re.test(p));
  }

  /** 选择性同步：该路径是否被白名单命中（用于 UI 提示） */
  isIncluded(path: string): boolean {
    const p = path.replace(/\\/g, '/');
    if (this.includeRegexes.length === 0) return true;
    return this.includeRegexes.some((re) => re.test(p));
  }

  isOversized(sizeBytes: number): boolean {
    const max = this.settings.maxFileSizeMB * 1024 * 1024;
    return sizeBytes > max;
  }

  /** 是否超过「大文件独立通道」阈值（#4.7）。0 = 不启用 */
  isLargeFile(sizeBytes: number): boolean {
    if (!this.settings.largeFileThresholdMB) return false;
    return sizeBytes > this.settings.largeFileThresholdMB * 1024 * 1024;
  }
}

/**
 * 移动端平台默认参数（#2.2 移动端适配与性能）。
 * 移动端内存/算力受限，按平台下调并发与分片，避免卡顿与 OOM。
 * 桌面端原样返回。调用方应在 loadData 合并 DEFAULT_SETTINGS 之后调用，
 * 直接改写传入对象（不改动 DEFAULT_SETTINGS 常量）。
 */
export function applyMobileDefaults(s: BDNSyncSettings): BDNSyncSettings {
  if (Platform.isMobile) {
    s.uploadConcurrency = Math.min(s.uploadConcurrency || 3, 2);
    s.downloadConcurrency = Math.min(s.downloadConcurrency || 3, 2);
    s.chunkSizeMB = Math.min(s.chunkSizeMB || 8, 4);
    s.stormThreshold = Math.min(s.stormThreshold || 200, 100);
    // 移动端后台会被系统挂起，探查/快照调度 best-effort：保留开关但缩短间隔意义不大，维持默认
  }
  return s;
}

/** 是否处于移动端（供 UI 展示「移动端支持矩阵」状态） */
export function isMobilePlatform(): boolean {
  return Platform.isMobile;
}

/** 简单文本文件扩展名集合（用于智能合并判定） */
const TEXT_EXTS = new Set([
  'md',
  'markdown',
  'mdx',
  'txt',
  'text',
  'json',
  'csv',
  'tsv',
  'log',
  'yml',
  'yaml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'tex',
  'bib',
  'org',
  'canvas',
  'css',
  'js',
  'ts',
  'html',
  'xml',
  'svg',
]);

export function isTextPath(path: string): boolean {
  const idx = path.lastIndexOf('.');
  const ext = idx >= 0 ? path.slice(idx + 1).toLowerCase() : '';
  return TEXT_EXTS.has(ext);
}

/** 并发执行任务（限制最大并发数） */
export async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  limit: number,
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, async () => {
    while (next < tasks.length) {
      const i = next++;
      try {
        results[i] = { status: 'fulfilled', value: await tasks[i]() };
      } catch (e) {
        results[i] = { status: 'rejected', reason: e };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/** 统一的扩展名 → MIME 类型映射（图片/媒体/文档），供预览、流式代理、媒体桥等共用。
 *  未知扩展名回退 application/octet-stream。维护点唯一：改这里即可全局生效。 */
const MIME_BY_EXT: Record<string, string> = {
  // 图片
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
  // 视频
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
  flv: 'video/x-flv',
  m4v: 'video/mp4',
  // 音频
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  opus: 'audio/ogg',
  wma: 'audio/x-ms-wma',
  // 文档 / 其他
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  xml: 'application/xml',
  csv: 'text/csv',
  html: 'text/html',
  htm: 'text/html',
};

export function mimeForExt(ext: string): string {
  const e = (ext || '').toLowerCase().replace(/^\./, '');
  return MIME_BY_EXT[e] || 'application/octet-stream';
}

/** 指数退避重试 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: {
    retries?: number;
    baseMs?: number;
    onRetry?: (err: unknown, attempt: number, waitMs: number) => void;
  } = {},
): Promise<T> {
  const retries = opts.retries ?? 3;
  const base = opts.baseMs ?? 1000;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt === retries) break;
      const wait = base * Math.pow(2, attempt) + Math.floor(Math.random() * 300);
      if (opts.onRetry) opts.onRetry(e, attempt, wait);
      await sleep(wait);
    }
  }
  throw lastErr;
}

// ---------- 通知限频（共享） ----------
//
// 全局唯一的「消息 → 最近弹出时间」状态。engine 的同步通知与 main 的忙碌提示
// 共用同一套限频，避免两处各自维护独立状态导致：未来统一弹窗渠道时，
// 同一条消息在两个入口间交替触发（各自都未超限）而重复弹出；
// 或某入口升级后另一个入口的限频状态被绕过。模块级 Map 天然跨实例共享。

const noticeRateState = new Map<string, number>(); // msg → 最近时间戳(ms)

/** 判定该消息当前是否应弹出：同消息 windowMs 内已弹过 → false（限频）；否则记录并 true */
export function shouldShowNotice(msg: string, windowMs = 3000): boolean {
  const now = Date.now();
  const last = noticeRateState.get(msg);
  if (last !== undefined && now - last < windowMs) return false;
  noticeRateState.set(msg, now);
  // 防 Map 无界增长：仅清理远久条目（500 条以上时惰性清理最旧一半）
  if (noticeRateState.size > 500) {
    const cutoff = now - 60_000;
    for (const [k, t] of noticeRateState) {
      if (t < cutoff) noticeRateState.delete(k);
    }
    if (noticeRateState.size > 500) {
      // 极端情况仍超限：清空旧条目兜底（限频是尽力而为，不阻塞功能）
      const entries = [...noticeRateState.entries()].sort((a, b) => a[1] - b[1]);
      for (const [k] of entries.slice(0, entries.length - 250)) noticeRateState.delete(k);
    }
  }
  return true;
}
