// 百度网盘原始 HTTP API 封装
// - 基于 Obsidian requestUrl（桌面/移动端均可绕过 CORS）
// - 双模式：cookie（BDUSS/STOKEN，Web 端点，仅下载/列表/删除）/ openapi（设备码 OAuth 授权，xpan 端点，全功能含上传）
// - 设备码授权流程：startDeviceAuth → pollDeviceAuth（轮询）→ 自动 refreshAccessToken
// - openRequest：自动追加 access_token，遇 401/errno 111/-6/50305 自动刷新重试一次
// - 内置 QPS 节流、瞬态错误指数退避、errno 映射

import { requestUrl } from 'obsidian';
import { sleep } from '../util/misc';
import type { AuthMode } from '../types';

export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
// 开放平台 PCS 接口专用 UA（与网盘官方客户端一致）
export const PCS_UA = 'pan.baidu.com';
// 开放平台 OAuth 接口专用 UA
export const OAUTH_UA = 'pan.baidu.com';

export class BaiduApiError extends Error {
  errno: number;
  raw: unknown;
  /** 是否瞬态可重试（限流/网络） */
  transient: boolean;
  /** 是否要求暂停较长时间（31039 操作频繁） */
  cooldownMs: number;
  /** 错误分类（对齐参考实现） */
  code: string;
  constructor(
    errno: number,
    message: string,
    opts: { transient?: boolean; cooldownMs?: number; raw?: unknown; code?: string } = {},
  ) {
    super(message);
    this.name = 'BaiduApiError';
    this.errno = errno;
    this.raw = opts.raw;
    this.transient = !!opts.transient;
    // 限流/操作频繁类错误：自动携带冷却时长，使重试退避尊重服务端限流节奏，
    // 避免后台高频重试浪费配额（沉浸无感的关键）。
    this.cooldownMs = opts.cooldownMs ?? (errno === 31039 ? 60_000 : errno === 31034 ? 10_000 : 0);
    this.code = opts.code ?? errnoToCode(errno);
  }
}

export interface BaiduAuth {
  mode: AuthMode;
  bduss: string;
  stoken: string;
  cookieString: string; // 完整 Cookie（可选）
  // openapi 设备码授权相关
  appKey: string;
  secretKey: string;
  accessToken: string;
  refreshToken: string;
  tokenExpiresAt: string; // 毫秒时间戳（字符串存储）
}

interface RawResp {
  status: number;
  headers: Record<string, string>;
  arrayBuffer: ArrayBuffer;
  text: () => string;
  json: () => unknown;
}

export interface QuotaInfo {
  total: number;
  free: number;
  used: number;
}

/**
 * 开放平台接口的统一返回形状（外部契约边界）。
 * 百度网盘接口的成功/错误都包在同一层：errno===0 表示成功，其余字段视接口而定。
 * 用此接口替代 `any` 作为 openRequest 的返回类型，可在调用点做受控窄化，
 * 避免 `any` 沿调用链扩散（此前 openRequest 返回 any 导致 20+ 处 any）。
 * 其余业务字段用索引签名兜底，由各调用点按需读取并做类型转换。
 */
export interface BaiduApiResponse {
  errno?: number;
  error_msg?: string;
  error_code?: number;
  request_id?: string;
  [key: string]: unknown;
}

/** 会员等级 / 用户名信息（uinfo 接口，vip_version=v2 时 vip_type 语义：0 普通 / 1 会员 / 2 超级会员） */
export interface UserInfo {
  /** 百度账号 / 网盘账号显示名 */
  name: string;
  /** 会员类型：0 普通用户 / 1 会员VIP / 2 超级会员SVIP */
  vipType: number;
  /** 中文标签，用于 UI 展示 */
  vipLabel: string;
  /**
   * 头像 URL（最佳努力获取）：
   *  1. uinfo 返回的 avatar_url / avatar / face_url 等字段；
   *  2. 否则用 `uk` 拼接百度默认头像服务
   *     `https://himg.bdimg.com/sys/portrait/item/{uk}` 作为兜底（未设置过头像的用户也会得到一个默认图）。
   * 浏览器渲染 <img> 时若 404 则自动隐藏（无需前端特殊处理）。
   */
  avatarUrl: string | null;
  /** 用户 uk（用于 fallback 头像与服务调用） */
  uk: string | null;
}

/**
 * 百度网盘列表/元数据接口返回的原始条目形状（外部契约，字段可选且类型宽松）。
 * 这是「外部 any → 内部已知类型」的转换边界：所有从 `any` 进入内部类型系统的入口
 * 都应先窄化为本接口，再由 `mapEntry` 映射为内部 `RemoteRawEntry`，避免 `any` 扩散。
 */
export interface BaiduRawEntry {
  path?: string;
  server_filename?: string;
  isdir?: number | boolean;
  size?: number | string;
  server_mtime?: number | string;
  local_mtime?: number | string;
  fs_id?: number | string;
  [key: string]: unknown;
}

/** 列表类接口的通用信封（仅声明实际用到的字段，其余由索引签名兜底） */
export interface BaiduListResp {
  errno?: number;
  list?: BaiduRawEntry[];
  info?: BaiduRawEntry[];
  [key: string]: unknown;
}

export interface RemoteRawEntry {
  path: string;
  name: string;
  isDir: boolean;
  size: number;
  mtime: number; // 毫秒
  fsId: string;
  isFile: boolean;
}

export interface DeviceAuthInfo {
  qrcodeUrl: string;
  verificationUrl: string;
  userCode: string;
  expiresInSec: number;
  pollIntervalSec: number;
}

const ERRNO_MESSAGES: Record<string, string> = {
  '-6': '身份验证失败（errno=-6）：access_token 无效或已过期，请重新完成设备码授权',
  '-7': '文件或目录名不合法',
  '-9': '文件或目录不存在（errno=-9），或应用无权访问该路径',
  '-8': '文件或目录已存在',
  '-4': '请求过于频繁或被拦截，稍后重试',
  '2': '参数错误',
  '12': '部分文件操作失败',
  '111': 'access_token 无效或已过期（errno=111）',
  '31034': '命中接口限流（errno=31034），稍后将自动退避重试',
  '31039': '操作过于频繁（errno=31039），稍后自动恢复',
  '31045': '目录不存在，稍后自动创建后重试',
  '31061': '文件已存在',
  '31062': '文件名不合法',
  '31200': '秒传失败（文件不存在），将降级为普通分片上传',
  '31326': '网盘容量不足（errno=31326），请清理网盘空间',
  '31363': '命中安全策略，本设备或账号暂时被限制',
  '42111': '上传分片 MD5 不一致',
  '42112': '分片上传被中断，稍后续传',
  '50305': 'access_token 无效或已过期（errno=50305）',
};

/** 限流类 errno（指数退避重试），对齐参考实现 */
const RATE_LIMIT_ERRNOS = [31034, 31001, 31021, 31022, 31025, 31031, 31101, 403, -4];
/** 鉴权类 errno（触发自动刷新 access_token 重试） */
const AUTH_ERRNOS = [111, -6, 50305];

export function errnoMessage(errno: number, fallback: string): string {
  return ERRNO_MESSAGES[String(errno)] ?? `${fallback}（errno=${errno}）`;
}

/** errno → 错误分类码（对齐参考 baiduError） */
export function errnoToCode(errno: number): string {
  if (errno === 12 || errno === -6 || errno === 111 || errno === 50305) return 'AUTH_FAILED';
  if (errno === -8) return 'CONFLICT';
  if (errno === -7) return 'NOT_FOUND';
  if (errno === -10 || errno === -11) return 'QUOTA';
  if (RATE_LIMIT_ERRNOS.includes(errno)) return 'RATE_LIMIT';
  if (errno === -9) return 'AUTH_FAILED';
  return 'UNKNOWN';
}

export function parseCookieField(cookieStr: string, field: string): string {
  const m = new RegExp(`(?:^|;\\s*)${field}=([^;]*)`).exec(cookieStr || '');
  return m ? decodeURIComponent(m[1]).trim() : '';
}

/**
 * 从百度接口的宽松响应对象中按点号路径取第一个有效数字。
 * 兼容顶层字段（`total`）和嵌套字段（`data.total`），便于不同端点响应形状差异。
 * 返回 0 表示所有候选都缺失或非数字。
 */
function pickNum(obj: unknown, paths: string[]): number {
  if (!obj || typeof obj !== 'object') return 0;
  const get = (o: unknown, p: string): unknown =>
    p.includes('.')
      ? p
          .split('.')
          .reduce<unknown>(
            (acc, k) =>
              acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined,
            o,
          )
      : (o as Record<string, unknown>)[p];
  for (const p of paths) {
    const v = get(obj, p);
    const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

/**
 * 从百度接口的宽松响应对象中按点号路径取第一个非空字符串。
 * 用于头像 URL、用户 uk 等"字段名多变"的取值场景。
 */
function pickString(obj: unknown, paths: string[]): string | null {
  if (!obj || typeof obj !== 'object') return null;
  const get = (o: unknown, p: string): unknown =>
    p.includes('.')
      ? p
          .split('.')
          .reduce<unknown>(
            (acc, k) =>
              acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined,
            o,
          )
      : (o as Record<string, unknown>)[p];
  for (const p of paths) {
    const v = get(obj, p);
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return null;
}

/**
 * 判断一个错误是否为「瞬态、可安全重试」的错误。
 *
 * 仅对以下类别自动重试，其他一律快速失败，避免掩盖真正的逻辑/权限问题：
 *  - 网络层异常（无 HTTP 状态，即 requestUrl 抛出的连接中断 / 超时 / DNS 失败）
 *  - 限流类 errno（RATE_LIMIT_ERRNOS，含 31034/31039 等）
 *  - 服务端暂时不可用（HTTP 5xx、连接被重置）
 *
 * 鉴权类（111/-6/50305）、参数类（2）、文件不存在（-9）、文件名非法（-7）
 * 等**终止性**错误不重试——它们不会因重试而自愈，重试只会浪费配额与延迟。
 */
export function isTransientError(e: unknown): boolean {
  if (e instanceof BaiduApiError) {
    if (e.transient) return true;
    if (RATE_LIMIT_ERRNOS.includes(e.errno)) return true;
    // 服务端内部错误 / 网关类：偶发，重试有机会恢复
    if (e.errno === 42111 || e.errno === 42112) return true;
    return false;
  }
  if (e instanceof Error) {
    // 未带 HTTP 状态的网络异常（连接断开、超时、DNS）
    const msg = e.message || '';
    if (
      /网络请求失败|ECONNRESET|ETIMEDOUT|ESOCKETTIMEDOUT|socket hang up|timeout|network|fetch failed|aborted/i.test(
        msg,
      )
    )
      return true;
  }
  return false;
}

/**
 * 统一的瞬态重试包装：仅对 {@link isTransientError} 命中者按指数退避重试，
 * 重试上限受 maxRetries 约束；尊重错误自带的 cooldownMs（限流冷却）。
 *
 * 与 misc.withRetry 的区别：本函数只在「瞬态」时重试，并且对冷却型错误
 * 使用更长的退避，避免反复打接口浪费配额（沉浸无感的关键——后台安静重试）。
 *
 * @param fn          实际请求闭包
 * @param opts.label  日志标签（便于排查）
 * @param opts.maxRetries 最大重试次数（默认 4）
 */
export async function transientRetry<T>(
  fn: () => Promise<T>,
  opts: { label?: string; maxRetries?: number } = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 4;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!isTransientError(e)) throw e;
      if (attempt === maxRetries) {
        // 重试耗尽：保留原生瞬态标记，交由上层决定提示
        throw e;
      }
      // 退避：基础指数 + 限流冷却优先
      let wait = 1000 * Math.pow(2, attempt) + Math.floor(Math.random() * 400);
      if (e instanceof BaiduApiError && e.cooldownMs > 0) wait = Math.max(wait, e.cooldownMs);
      if (opts.label)
        console.warn(
          `[BDNSync] ${opts.label} 瞬时失败，第 ${attempt + 1} 次重试（${wait}ms）：${errMsgShort(e)}`,
        );
      await sleep(wait);
    }
  }
  throw lastErr;
}

function errMsgShort(e: unknown): string {
  if (e instanceof BaiduApiError) return `errno=${e.errno} ${e.message}`;
  if (e instanceof Error) return e.message.slice(0, 120);
  return String(e).slice(0, 120);
}

/**
 * 脱敏：从任意字符串中抹除 access_token / BDUSS / refresh_token / secretKey，
 * 避免凭证经错误消息、日志或异常堆栈泄露到磁盘/控制台。
 * URL 中的 access_token=xxx、Cookie 中的 BDUSS=xxx 都会被替换为 <redacted>。
 */
export function redactSecrets(input: string): string {
  // 覆盖两类形态：
  //  1) URL / Cookie 串中的 key=value（原始实现，向后兼容）
  //  2) JSON 序列化对象中的 "key":"value"（日志中常对 auth 等对象做 JSON.stringify，
  //     原实现无法脱敏，会导致凭证明文进入日志 —— 本次修复补齐）
  const keys = ['access_token', 'BDUSS', 'STOKEN', 'refresh_token', 'client_secret', 'secretKey'];
  let out = input;
  for (const k of keys) {
    // key=value （值截至分隔符/空白/引号/尖括号）
    out = out.replace(new RegExp(`${k}=[^&;\\s"'<>]+`, 'gi'), `${k}=<redacted>`);
    // "key":"value" （JSON，值截至下一个未转义双引号）
    out = out.replace(new RegExp(`("${k}"\\s*:\\s*")([^"]*)(")`, 'gi'), '$1<redacted>$3');
  }
  return out;
}

export class BaiduApi {
  private lastRequestAt = 0;
  // 设备码授权运行时状态（仅存于内存，不持久化）
  private deviceCode = '';
  private deviceCodeExpireAt = 0;
  private devicePollIntervalSec = 3;
  private devicePollFails = 0;
  /** 会员等级 / 用户名缓存（10min 内复用，避免播放器每次打开都打接口） */
  private userInfoCache: { ts: number; info: UserInfo } | null = null;

  constructor(
    private auth: BaiduAuth,
    private minIntervalMs = 550,
  ) {}

  updateAuth(auth: BaiduAuth) {
    this.auth = auth;
  }
  updateInterval(ms: number) {
    this.minIntervalMs = ms;
  }

  /** 当前授权模式（'openapi' | 'cookies'），供预览器判断能否使用在线预览 */
  getAuthMode(): 'openapi' | 'cookies' {
    return this.auth.mode;
  }

  /** 返回当前凭证快照（供持久化 access_token/refresh_token 等） */
  snapshotAuth(): BaiduAuth {
    return { ...this.auth };
  }

  private cookieHeader(): string {
    const a = this.auth;
    if (a.cookieString && a.cookieString.trim()) {
      let c = a.cookieString.trim();
      if (!/BDUSS=/.test(c) && a.bduss) c += `; BDUSS=${a.bduss.trim()}`;
      if (!/STOKEN=/.test(c) && a.stoken) c += `; STOKEN=${a.stoken.trim()}`;
      return c;
    }
    const parts: string[] = [];
    if (a.bduss) parts.push(`BDUSS=${a.bduss.trim()}`);
    if (a.stoken) parts.push(`STOKEN=${a.stoken.trim()}`);
    return parts.join('; ');
  }

  /** Web 端请求头（Cookie 模式） */
  webHeaders(extra?: Record<string, string>): Record<string, string> {
    return {
      'User-Agent': BROWSER_UA,
      Referer: 'https://pan.baidu.com/disk/main',
      Cookie: this.cookieHeader(),
      ...extra,
    };
  }

  private ensureAuth() {
    const a = this.auth;
    if (a.mode === 'cookies') {
      if (!a.bduss && !a.cookieString)
        throw new BaiduApiError(-6, '未配置 BDUSS/Cookie，请先在设置中完成连接配置', {
          code: 'AUTH_FAILED',
        });
    } else {
      if (!a.accessToken && !a.refreshToken) {
        throw new BaiduApiError(
          -6,
          '尚未完成开放平台授权。请在设置中填写 AppKey/SecretKey 后点击「设备码授权」',
          { code: 'AUTH_FAILED' },
        );
      }
    }
  }

  private async throttle() {
    const wait = this.minIntervalMs - (Date.now() - this.lastRequestAt);
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = Date.now();
  }

  /**
   * OAuth 端点专用请求：跳过 ensureAuth（设备码/令牌端点本就是"获取凭证"的入口，
   * 调用时往往尚无 access_token）。仍走限流。
   */
  /**
   * 统一 HTTP 请求封装：限流 + 网络错误脱敏 + 非 JSON 响应体归一化。
   *
   * 原 `oauthRequest` 与 `rawRequest` 仅差一处 `ensureAuth()` 调用，已合并于此。
   * 通过 `opts.skipAuth` 区分：OAuth 设备码/令牌交换等尚无常量凭证的调用传 true，
   * 其余需要有效 access_token 的调用默认走 `ensureAuth()`。
   */
  private async request(
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: ArrayBuffer | string } = {},
    opts: { skipAuth?: boolean } = {},
  ): Promise<RawResp> {
    if (!opts.skipAuth) this.ensureAuth();
    await this.throttle();
    try {
      const resp = await requestUrl({
        url,
        method: init.method || 'GET',
        headers: init.headers || {},
        body: init.body as never,
        throw: false,
      });
      const headers = (resp.headers || {}) as Record<string, string>;
      const buf = resp.arrayBuffer || new ArrayBuffer(0);
      let textCache: string | null = null;
      const text = () => {
        if (textCache === null) textCache = new TextDecoder('utf-8').decode(buf);
        return textCache;
      };
      return {
        status: resp.status,
        headers,
        arrayBuffer: buf,
        text,
        json: () => {
          try {
            return JSON.parse(text());
          } catch {
            throw new BaiduApiError(0, `响应体非 JSON：${url.slice(0, 120)}`);
          }
        },
      };
    } catch (e) {
      const err = e as { status?: number; headers?: Record<string, string>; message?: string };
      if (typeof err.status === 'number') {
        return {
          status: err.status,
          headers: err.headers || {},
          arrayBuffer: new ArrayBuffer(0),
          text: () => String(err.message || ''),
          json: () => {
            throw new BaiduApiError(0, '无响应体');
          },
        };
      }
      throw new BaiduApiError(0, `网络请求失败：${redactSecrets(err.message || String(e))}`, {
        transient: true,
      });
    }
  }

  private formBody(params: Record<string, string>): string {
    return Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
  }

  // ============ 设备码 OAuth 授权流程（对齐参考实现）============

  /**
   * 启动设备码授权：向百度开放平台申请 device_code 与用户码。
   * POST 失败时回退 GET（部分环境/回调配置下 POST 会被拦）。
   */
  async startDeviceAuth(): Promise<DeviceAuthInfo> {
    const a = this.auth;
    if (!a.appKey || !a.secretKey) {
      throw new BaiduApiError(
        -6,
        '请先填写开放平台 AppKey / SecretKey（pan.open.baidu.com 创建应用获取）',
        { code: 'AUTH_FAILED' },
      );
    }
    const url = 'https://openapi.baidu.com/oauth/2.0/device/code';
    const params: Record<string, string> = {
      client_id: a.appKey,
      response_type: 'device_code',
      scope: 'basic,netdisk',
    };
    const headers = { 'User-Agent': OAUTH_UA };
    let status = 0;
    let data: Record<string, unknown> | null = null;
    try {
      const resp = await this.request(
        url,
        { method: 'POST', headers, body: this.formBody(params) },
        { skipAuth: true },
      );
      status = resp.status;
      data = safeJson(resp);
      if (status >= 400) throw new Error('POST 失败，回退 GET');
    } catch {
      // 回退 GET
      const qs = new URLSearchParams(params).toString();
      const resp = await this.request(
        `${url}?${qs}`,
        { method: 'GET', headers },
        { skipAuth: true },
      );
      status = resp.status;
      data = safeJson(resp);
    }
    if (!data?.device_code || status >= 400) {
      const d = data?.error_description || data?.error || data?.errmsg || `HTTP ${status}`;
      throw new BaiduApiError(
        -6,
        `获取设备码失败（${d}）。请按顺序确认：1) pan.open.baidu.com →「应用详情」→「安全设置」中添加了 OAuth 授权回调页地址（如 http://localhost/callback）；2)「接口权限」已勾选「网盘基础服务」/「网盘登录」；3) 使用的是「AppKey」而不是 AppID；4) 应用已上线（未上线通常报 20017）`,
        { code: 'AUTH_FAILED', raw: data },
      );
    }
    this.deviceCode = String(data.device_code);
    this.deviceCodeExpireAt = Date.now() + Number(data.expires_in ?? 300) * 1000;
    this.devicePollIntervalSec = Math.max(1, Number(data.interval ?? 3));
    const verificationUrl = String(
      data.verification_url || data.verify_url || 'https://openapi.baidu.com/device',
    );
    const qrcodeUrl = String(data.qrcode_url || '');
    return {
      qrcodeUrl,
      verificationUrl,
      userCode: String(data.user_code || ''),
      expiresInSec: Number(data.expires_in ?? 300),
      pollIntervalSec: this.devicePollIntervalSec,
    };
  }

  /**
   * 轮询设备码授权状态。
   * @returns true 表示授权成功（token 已写入 auth）；false 表示仍在等待用户操作（继续轮询）。
   * @throws 用户拒绝 / 设备码过期等终止性错误。
   */
  async pollDeviceAuth(): Promise<boolean> {
    const a = this.auth;
    if (!this.deviceCode)
      throw new BaiduApiError(-6, '请先调用 startDeviceAuth 获取设备码', { code: 'AUTH_FAILED' });
    if (!a.appKey || !a.secretKey)
      throw new BaiduApiError(-6, '缺少 AppKey / SecretKey，无法完成设备码授权', {
        code: 'AUTH_FAILED',
      });
    if (this.deviceCodeExpireAt && Date.now() > this.deviceCodeExpireAt) {
      this.deviceCode = '';
      this.devicePollFails = 0;
      throw new BaiduApiError(-6, '设备码已过期。请重新点击「设备码授权」获取新的用户码与二维码', {
        code: 'AUTH_FAILED',
      });
    }
    const url = 'https://openapi.baidu.com/oauth/2.0/token';
    const params: Record<string, string> = {
      grant_type: 'device_token',
      code: this.deviceCode,
      client_id: a.appKey,
      client_secret: a.secretKey,
    };
    const headers = { 'User-Agent': OAUTH_UA };
    const resp = await this.request(
      url,
      { method: 'POST', headers, body: this.formBody(params) },
      { skipAuth: true },
    );
    let status = resp.status;
    let data: Record<string, unknown> | null = safeJson(resp);
    const errStr = String(data?.error || '');
    // POST 返回 4xx 且非"等待授权"类错误时回退 GET
    if (
      status >= 400 &&
      !/authorization_pending|authorization_declined|slow_down|expired|invalid_grant/i.test(errStr)
    ) {
      const qs = new URLSearchParams(params).toString();
      const gr = await this.request(`${url}?${qs}`, { method: 'GET', headers }, { skipAuth: true });
      const gd: BaiduApiResponse = safeJson<BaiduApiResponse>(gr) ?? ({} as BaiduApiResponse);
      if (
        gr.status < 400 ||
        (gd &&
          (gd.access_token || /authorization_pending|slow_down/i.test(String(gd?.error || ''))))
      ) {
        status = gr.status;
        data = gd;
      }
    }
    if (data?.access_token) {
      this.auth.accessToken = String(data.access_token);
      if (data.refresh_token) this.auth.refreshToken = String(data.refresh_token);
      if (data.expires_in)
        this.auth.tokenExpiresAt = String(Date.now() + Number(data.expires_in) * 1000);
      this.deviceCode = '';
      this.deviceCodeExpireAt = 0;
      this.devicePollFails = 0;
      return true;
    }
    const err = String(data?.error || '');
    const desc = String(data?.error_description || '');
    if (err === 'authorization_pending' || err === 'slow_down') {
      this.devicePollFails = 0;
      return false;
    }
    if (err === 'access_denied') {
      this.deviceCode = '';
      this.devicePollFails = 0;
      throw new BaiduApiError(-6, `用户拒绝授权（${desc || err}）`, {
        code: 'AUTH_FAILED',
        raw: data,
      });
    }
    if (/expired_token|invalid_grant|token_expired/i.test(err) || /expired/i.test(desc)) {
      this.deviceCode = '';
      this.devicePollFails = 0;
      throw new BaiduApiError(
        -6,
        `设备码已过期（${desc || err}）。请重新点击「设备码授权」获取新的用户码`,
        { code: 'AUTH_FAILED', raw: data },
      );
    }
    if (status >= 400) {
      this.devicePollFails++;
      if (this.devicePollFails >= 5) {
        this.deviceCode = '';
        this.devicePollFails = 0;
        const hint = /20017|app/.test(String(data?.error || '') + desc)
          ? '（开放平台接口权限未勾选网盘，或应用未上线）'
          : '';
        throw new BaiduApiError(
          -6,
          `设备码授权多次失败${hint}（${desc || err || `HTTP ${status}`}）。请检查 pan.open.baidu.com：1)「安全设置」已添加回调 http://localhost/callback；2)「接口权限」已勾选网盘；3) 使用 AppKey 而非 AppID。配置保存后需等待 5-10 分钟再重新授权`,
          { code: 'AUTH_FAILED', raw: data },
        );
      }
      return false;
    }
    return false;
  }

  /** 刷新 access_token（用 refresh_token）。成功返回 true。 */
  async refreshAccessToken(): Promise<boolean> {
    const a = this.auth;
    if (!a.appKey || !a.secretKey || !a.refreshToken) return false;
    const url = 'https://openapi.baidu.com/oauth/2.0/token';
    const params: Record<string, string> = {
      grant_type: 'refresh_token',
      refresh_token: a.refreshToken,
      client_id: a.appKey,
      client_secret: a.secretKey,
    };
    const resp = await this.request(
      url,
      { method: 'POST', headers: { 'User-Agent': OAUTH_UA }, body: this.formBody(params) },
      { skipAuth: true },
    );
    const data: BaiduApiResponse = safeJson<BaiduApiResponse>(resp) ?? ({} as BaiduApiResponse);
    if (data?.access_token) {
      this.auth.accessToken = String(data.access_token);
      if (data.refresh_token) this.auth.refreshToken = String(data.refresh_token);
      if (data.expires_in)
        this.auth.tokenExpiresAt = String(Date.now() + Number(data.expires_in) * 1000);
      return true;
    }
    return false;
  }

  /** 获取可用 access_token（无则抛错） */
  async accessToken(): Promise<string> {
    const a = this.auth;
    if (!a.accessToken) {
      throw new BaiduApiError(
        -6,
        '尚未完成开放平台授权。请在设置中点击「设备码授权」（startDeviceAuth + pollDeviceAuth），或改用 Cookie 模式',
        { code: 'AUTH_FAILED' },
      );
    }
    return a.accessToken;
  }

  /**
   * 开放平台统一请求：自动追加 access_token，遇鉴权类错误自动刷新重试一次。
   * @param url 不含 access_token 的接口 URL
   * @param opts method/params(POST 表单)
   */
  private async openRequest(
    url: string,
    opts: { method?: string; params?: Record<string, string>; retried?: boolean } = {},
  ): Promise<BaiduApiResponse> {
    const token = await this.accessToken();
    const sep = url.includes('?') ? '&' : '?';
    const fullUrl = `${url}${sep}access_token=${encodeURIComponent(token)}`;
    const headers = { 'User-Agent': PCS_UA };
    const resp =
      opts.method === 'POST'
        ? await this.request(fullUrl, {
            method: 'POST',
            headers,
            body: this.formBody(opts.params || {}),
          })
        : await this.request(fullUrl, { method: 'GET', headers });
    const data = safeJson(resp) as BaiduApiResponse;
    const errno = Number(data?.errno);
    if ((resp.status === 401 || AUTH_ERRNOS.includes(errno)) && !opts.retried) {
      if (await this.refreshAccessToken()) {
        return this.openRequest(url, { ...opts, retried: true });
      }
      throw new BaiduApiError(
        errno || -6,
        `AccessToken 无效或已过期（errno=${errno || resp.status}），自动刷新失败，请重新完成设备码授权`,
        { code: 'AUTH_FAILED', raw: data },
      );
    }
    return data;
  }

  // ---------- 账号 ----------

  /**
   * 获取网盘容量与用户名（openapi/cookie 各自多级回退）
   *
   * OpenAPI（设备码授权）路径：
   *   1) `rest/2.0/xpan/nas?method=uinfo` 拿用户名
   *   2) `rest/2.0/xpan/nas?method=quota` 拿容量（部分账号 errno=0 但 quota 字段缺失，需要继续走 3）
   *   3) `api/quota?checkfree=1&checkexpire=1` 最后兜底
   * Cookie（BDUSS+STOKEN）路径：
   *   1) `rest/2.0/xpan/nas?method=uinfo&web=1&channel=dubox&clienttype=0`
   *   2) `api/quota?checkfree=1&checkexpire=1&web=1&channel=dubox&clienttype=0`（官方端点）
   *
   * 任一路径拿到非零 total 立即返回；全部失败抛 BaiduApiError，让 UI 明确显示失败原因。
   * 老实现里第 2 步直接 return `{total:0}` 会让连接卡片显示 0B/0B 但不告知原因，已修复。
   */
  async getQuota(): Promise<QuotaInfo> {
    this.ensureAuth();
    const mode = this.auth.mode;
    let firstReason = '';
    let lastRaw: unknown = null;

    const tryParse = (
      label: string,
      data: BaiduApiResponse | null,
    ): { total: number; used: number } => {
      const t = pickNum(data, ['total', 'quota', 'quota_all', 'data.total', 'data.quota']);
      const u = pickNum(data, [
        'used',
        'quota_used',
        'quota_used_by_user',
        'data.used',
        'data.quota_used',
      ]);
      if (
        process.env.NODE_ENV !== 'production' ||
        (typeof window !== 'undefined' && (window as { __bdnsyncDebug?: boolean }).__bdnsyncDebug)
      ) {
        console.debug(`[BDNSync] quota ${label}: errno=${data?.errno ?? '?'} total=${t} used=${u}`);
      }
      return { total: t, used: u };
    };

    if (mode === 'openapi') {
      // ── 路径 1：uinfo（顺便拿用户名） ─────────────────────
      try {
        const j: BaiduApiResponse = await this.openRequest(
          'https://pan.baidu.com/rest/2.0/xpan/nas?method=uinfo',
          { method: 'GET' },
        );
        lastRaw = j;
        if (Number(j?.errno ?? 0) === 0) {
          const { total, used } = tryParse('uinfo', j);
          if (total > 0) return { total, free: Math.max(0, total - used), used };
        } else if (!firstReason) {
          firstReason = `uinfo errno=${j?.errno} ${j?.error_msg || j?.error_code || ''}`.trim();
        }
      } catch (e) {
        if (!firstReason)
          firstReason = e instanceof Error ? `uinfo 异常：${e.message}` : 'uinfo 异常';
      }
      // ── 路径 2：xpan/nas?method=quota ─────────────────────
      try {
        const q: BaiduApiResponse = await this.openRequest(
          'https://pan.baidu.com/rest/2.0/xpan/nas?method=quota',
          { method: 'GET' },
        );
        lastRaw = q;
        if (Number(q?.errno ?? 0) === 0) {
          const { total, used } = tryParse('quota', q);
          if (total > 0) return { total, free: Math.max(0, total - used), used };
        } else if (!firstReason) {
          firstReason = `quota errno=${q?.errno} ${q?.error_msg || q?.error_code || ''}`.trim();
        }
      } catch (e) {
        if (!firstReason)
          firstReason = e instanceof Error ? `quota 异常：${e.message}` : 'quota 异常';
      }
      // ── 路径 3：api/quota 兜底 ────────────────────────────
      try {
        const q: BaiduApiResponse = await this.openRequest(
          'https://pan.baidu.com/api/quota?checkfree=1&checkexpire=1',
          { method: 'GET' },
        );
        lastRaw = q;
        const { total, used } = tryParse('api/quota', q);
        if (total > 0) return { total, free: Math.max(0, total - used), used };
      } catch (e) {
        if (!firstReason)
          firstReason = e instanceof Error ? `api/quota 异常：${e.message}` : 'api/quota 异常';
      }
      // 三条路径都拿到 0：抛错让上层显示"未获取"并提示切换授权
      throw new BaiduApiError(
        0,
        `openapi 模式下三次配额查询均未拿到 total（${firstReason || '接口返回正常但字段缺失'}）。开放平台应用的"接口权限"可能未勾选"网盘基础服务/quota 相关"，请到 pan.open.baidu.com 检查后重新授权或切换到 Cookie 模式`,
        { code: 'QUOTA', raw: lastRaw },
      );
    }

    // ── Cookie 模式 ────────────────────────────────────────
    let firstCookieReason = '';
    // 1) uinfo + web=1
    try {
      const url =
        'https://pan.baidu.com/rest/2.0/xpan/nas?method=uinfo&web=1&channel=dubox&clienttype=0';
      const resp = await this.request(url, { method: 'GET', headers: this.webHeaders() });
      const data: BaiduApiResponse = safeJson<BaiduApiResponse>(resp) ?? ({} as BaiduApiResponse);
      lastRaw = data;
      if (Number(data?.errno ?? 1) === 0) {
        const { total, used } = tryParse('uinfo&web=1', data);
        if (total > 0) return { total, free: Math.max(0, total - used), used };
      } else if (!firstCookieReason) {
        firstCookieReason = `errno=${data?.errno}`;
      }
    } catch (e) {
      if (!firstCookieReason)
        firstCookieReason = e instanceof Error ? e.message.slice(0, 80) : 'uinfo 异常';
    }
    // 2) api/quota（官方 web 端点）
    try {
      const url =
        'https://pan.baidu.com/api/quota?checkfree=1&checkexpire=1&web=1&channel=dubox&clienttype=0';
      const resp = await this.request(url, { method: 'GET', headers: this.webHeaders() });
      const data: BaiduApiResponse = safeJson<BaiduApiResponse>(resp) ?? ({} as BaiduApiResponse);
      lastRaw = data;
      if (resp.status < 400 && Number(data?.errno ?? 1) === 0) {
        const { total, used } = tryParse('api/quota', data);
        if (total > 0) return { total, free: Math.max(0, total - used), used };
        if (!firstCookieReason)
          firstCookieReason = 'api/quota 返回正常但 quota 字段缺失（Cookie 中可能缺少 STOKEN）';
      } else {
        const en = Number(data?.errno ?? 1);
        const msg = errnoMessage(en, '获取网盘容量失败');
        if (!firstCookieReason) firstCookieReason = `${msg}（errno=${en}, HTTP ${resp.status}）`;
        throw new BaiduApiError(en, msg, { code: errnoToCode(en), raw: data });
      }
    } catch (e) {
      if (e instanceof BaiduApiError) throw e;
      if (!firstCookieReason)
        firstCookieReason = e instanceof Error ? e.message.slice(0, 80) : 'api/quota 异常';
    }
    throw new BaiduApiError(
      0,
      `cookie 模式下两次配额查询均未拿到 total（${firstCookieReason || '未知原因'}）。请在浏览器登录 https://pan.baidu.com 重新抓取包含 STOKEN 的完整 Cookie（不只是 BDUSS）`,
      { code: 'QUOTA', raw: lastRaw },
    );
  }

  /** 会员等级信息（vip_type：0 普通用户 / 1 会员VIP / 2 超级会员SVIP） */
  async getUserInfo(): Promise<UserInfo> {
    const cache = this.userInfoCache;
    if (cache && Date.now() - cache.ts < 10 * 60 * 1000) return cache.info;
    try {
      let data: BaiduApiResponse;
      if (this.auth.mode === 'openapi') {
        data = await this.openRequest(
          'https://pan.baidu.com/rest/2.0/xpan/nas?method=uinfo&vip_version=v2',
          { method: 'GET' },
        );
      } else {
        const url =
          'https://pan.baidu.com/rest/2.0/xpan/nas?method=uinfo&vip_version=v2&web=1&channel=dubox&clienttype=0';
        const resp = await this.request(url, { method: 'GET', headers: this.webHeaders() });
        data = safeJson<BaiduApiResponse>(resp) ?? ({} as BaiduApiResponse);
      }
      const vipType = Number(data?.vip_type ?? 0);
      const name = String(data?.baidu_name || data?.netdisk_name || data?.nick_name || '');
      // ---- 头像 URL 解析（多版本兼容 + uk 兜底拼接） ----
      // 经验：uinfo v2 在不同账号类型（OAuth / Cookie）下字段名略有差异：
      //   - OAuth / 部分账号返回 `avatar_url`
      //   - 某些自定义版本返回 `avatar` / `face_url` / `portrait`
      //   - 字段缺失时用 uk 拼默认服务
      const candidateAvatar = pickString(data, [
        'avatar_url',
        'avatarUrl',
        'avatar',
        'face_url',
        'faceUrl',
        'portrait',
        'user_image',
        'userImage',
      ]);
      const ukCandidate = pickString(data, ['uk', 'baidu_uid', 'user_id', 'userId']);
      const avatarUrl =
        candidateAvatar ||
        (ukCandidate
          ? `https://himg.bdimg.com/sys/portrait/item/${encodeURIComponent(ukCandidate)}`
          : null);
      const info: UserInfo = {
        name,
        vipType,
        vipLabel: vipType === 2 ? '超级会员 SVIP' : vipType === 1 ? '会员 VIP' : '普通用户',
        avatarUrl,
        uk: ukCandidate || null,
      };
      this.userInfoCache = { ts: Date.now(), info };
      return info;
    } catch {
      return { name: '', vipType: 0, vipLabel: '普通用户', avatarUrl: null, uk: null };
    }
  }

  // ---------- 目录列表 ----------

  /** 列出目录（单层）。errno -9/-7（不存在）返回空数组。网络抖动/限流自动重试 */
  async listDir(dir: string): Promise<RemoteRawEntry[]> {
    this.ensureAuth();
    const out: RemoteRawEntry[] = [];
    if (this.auth.mode === 'openapi') {
      let start = 0;
      for (;;) {
        const data = await transientRetry<BaiduListResp>(
          () =>
            this.openRequest(
              `https://pan.baidu.com/rest/2.0/xpan/file?method=list&dir=${encodeURIComponent(dir)}&order=name&desc=0&limit=100&start=${start}&web=1`,
              { method: 'GET' },
            ),
          { label: `listDir ${dir}` },
        );
        const errno = Number(data?.errno ?? 0);
        if (errno === -9 || errno === -7) return out;
        if (errno !== 0)
          throw new BaiduApiError(errno, errnoMessage(errno, `列出目录 ${dir} 失败`), {
            code: errnoToCode(errno),
            raw: data,
          });
        const list: BaiduRawEntry[] = Array.isArray(data?.list) ? data.list : [];
        for (const it of list) out.push(mapEntry(it));
        if (list.length < 100 || start > 100000) break;
        start += 100;
      }
      return out;
    }
    let start = 0;
    for (;;) {
      const url = `https://pan.baidu.com/api/list?dir=${encodeURIComponent(dir)}&num=1000&showempty=0&web=1&channel=dubox&clienttype=0&start=${start}`;
      const resp = await transientRetry(
        () => this.request(url, { method: 'GET', headers: this.webHeaders() }),
        { label: `listDir ${dir}` },
      );
      const data = safeJson<BaiduListResp>(resp);
      const errno = Number(data?.errno ?? 1);
      if (errno === -9 || errno === -7) return out;
      if (errno !== 0)
        throw new BaiduApiError(errno, errnoMessage(errno, `列出目录 ${dir} 失败`), {
          code: errnoToCode(errno),
          raw: data,
        });
      const list: BaiduRawEntry[] = Array.isArray(data?.list) ? data.list : [];
      for (const it of list) out.push(mapEntry(it));
      if (list.length < 1000 || start > 100000) break;
      start += 1000;
    }
    return out;
  }

  // ---------- 下载 ----------

  /** 获取下载直链（openapi：filemetas 取 dlink，无则回退 pcs download；cookie：api/filemetas） */
  async getDlink(fsId: string, path: string): Promise<string> {
    this.ensureAuth();
    if (this.auth.mode === 'openapi') {
      const data = await transientRetry<BaiduListResp>(
        () =>
          this.openRequest(
            `https://pan.baidu.com/rest/2.0/xpan/multimedia?method=filemetas&dlink=1&fsids=${encodeURIComponent(JSON.stringify([Number(fsId)]))}`,
            { method: 'GET' },
          ),
        { label: `getDlink ${path}` },
      );
      const errno = Number(data?.errno ?? 0);
      if (errno !== 0)
        throw new BaiduApiError(errno, errnoMessage(errno, `获取下载链接失败 ${path}`), {
          code: errnoToCode(errno),
          raw: data,
        });
      const dlink = (data?.list as Array<{ dlink?: unknown }> | undefined)?.[0]?.dlink;
      if (dlink) return String(dlink);
      // 回退：pcs download 直链
      return `https://d.pcs.baidu.com/rest/2.0/xpan/file?method=download&path=${encodeURIComponent(path)}`;
    }
    const url = `https://pan.baidu.com/api/filemetas?target=ukey&dlink=1&web=1&channel=dubox&clienttype=0&fsids=${encodeURIComponent(JSON.stringify([fsId]))}`;
    const resp = await transientRetry(
      () => this.request(url, { method: 'GET', headers: this.webHeaders() }),
      { label: `getDlink ${path}` },
    );
    const data: BaiduApiResponse = safeJson<BaiduApiResponse>(resp) ?? ({} as BaiduApiResponse);
    const errno = Number(data?.errno ?? 1);
    if (errno !== 0)
      throw new BaiduApiError(errno, errnoMessage(errno, `获取下载链接失败 ${path}`), {
        code: errnoToCode(errno),
        raw: data,
      });
    const dlink = (data?.list as Array<{ dlink?: unknown }> | undefined)?.[0]?.dlink;
    if (!dlink)
      throw new BaiduApiError(
        0,
        `获取下载链接失败 ${path}（Cookie 可能缺少权限，或该文件不支持直链下载）`,
      );
    return String(dlink);
  }

  /**
   * 为本地流式代理（StreamServer）准备「直链 + 请求头」。
   * StreamServer 会用 Node 的 https 模块直接请求该直链并把响应流 pipe 给浏览器，
   * 实现「边下边播 / 免落盘」的在线预览（还原澜库 handleStream 的核心能力）。
   * 与 downloadByDlink 不同，本方法不做整文件缓冲，只返回请求所需的信息。
   */
  async getStreamRequestInfo(
    fsId: string,
    path: string,
  ): Promise<{ url: string; headers: Record<string, string> }> {
    this.ensureAuth();
    const dlink = await this.getDlink(fsId, path);
    if (this.auth.mode === 'openapi') {
      const token = await this.accessToken();
      const sep = dlink.includes('?') ? '&' : '?';
      return {
        url: `${dlink}${sep}access_token=${encodeURIComponent(token)}`,
        headers: { 'User-Agent': PCS_UA },
      };
    }
    // cookie 模式：直链需带登录 Cookie 与 Referer
    return { url: dlink, headers: this.webHeaders({ 'User-Agent': PCS_UA }) };
  }

  /**
   * 取网盘文件的「可播放列表」（多清晰度 / VIP 解锁）。
   *
   * 背景：
   * 大量用户反馈"视频最高只能播到 720P"。百度网盘的视频清晰度由
   *   1. 当前登录态的 VIP 等级
   *   2. 请求接口（开放平台 vs 网页客户端）
   * 二者共同决定。开放平台 token 在不携带额外参数时往往只返回被转码成 720P 的源，
   * 网页客户端（Cookie 模式）则会根据 VIP 等级返回 1080P/原画。
   *
   * 本方法优先按"网页客户端（Cookie）→  开放平台"两条路径去枚举：
   *   - Cookie 模式：调用 `/api/playurlinfo` 与 `/api/filemetas?dlink=1`，
   *     拿到 m3u8（HLS）或 dlink（直链）作为可播放源；保留 vipType 上下文，
   *     让上层 UI 提示"正在播放 <720P/1080P/原画>"。
   *   - 开放平台：仍然走现有 dlink，并在 URL 强制带上 `clienttype=0&web=1`
   *     以请求原始分辨率（否则百度会按"非 SVIP"返回 720P 转码版）。
   *
   * 返回结构包含 `defaultUrl`（优先项）+ `alternatives`（备选），
   * 每条都有 `headers` 用作 StreamServer 转发。
   */
  async getMediaPlayOptions(
    fsId: string,
    path: string,
  ): Promise<{
    defaultUrl: string;
    defaultHeaders: Record<string, string>;
    alternatives: { label: string; url: string; headers: Record<string, string> }[];
    source: 'web-hls' | 'web-direct' | 'openapi-direct' | 'pcs-direct';
    vipType: number;
    /** 推理出的百度端可能提供的最高质量（用来在 UI 上提示"已自动选择 / 您可解锁更清画质"） */
    estimatedMaxHeight: number;
  }> {
    this.ensureAuth();
    // 先缓存或拉一次 vip（不影响命中策略，仅用于 UI 标签）
    const userInfo = await this.getUserInfo().catch(() => ({
      name: '',
      vipType: 0,
      vipLabel: '普通用户',
      avatarUrl: null,
      uk: null,
    }));
    const vipType = userInfo.vipType;

    if (this.auth.mode === 'cookies') {
      // 1) 尝试拿 HLS（playurlinfo）：网页端会根据会员等级返回多码率 m3u8
      try {
        const r = await this.request(
          `https://pan.baidu.com/api/playurlinfo?fsid=${encodeURIComponent(fsId)}&type=2&clienttype=0&web=1&channel=dubox`,
          { method: 'GET', headers: this.webHeaders() },
        );
        const d = safeJson<BaiduApiResponse>(r);
        // 兼容两种形态：playurlinfo 返回 dlink（m3u8 url）或 playurls 数组
        const list: Array<{
          url?: string;
          dlink?: string;
          quality?: string;
          height?: number;
          bitrate?: number;
        }> = (Array.isArray(d?.playurls) ? d?.playurls : []) as never[];
        if (list.length && (r.status ?? 0) < 400) {
          const urls = list
            .map(
              (it, i): { label: string; url: string; headers: Record<string, string> } | null => {
                const u = it.dlink || it.url;
                if (!u) return null;
                const h = typeof it.height === 'number' ? it.height : 0;
                const q = it.quality || (h ? `${h}p` : `清晰度${i + 1}`);
                return { label: q, url: u, headers: this.webHeaders({ 'User-Agent': PCS_UA }) };
              },
            )
            .filter(
              (x): x is { label: string; url: string; headers: Record<string, string> } => !!x,
            );
          if (urls.length) {
            // 默认选最清画质（vipType>=1 可拿 1080P+/原画，0 最高 720P）
            urls.sort((a, b) => parseInt(b.label, 10) - parseInt(a.label, 10));
            const def = urls[0];
            return {
              defaultUrl: def.url,
              defaultHeaders: def.headers,
              alternatives: urls,
              source: 'web-hls',
              vipType,
              estimatedMaxHeight:
                parseInt(def.label, 10) || (vipType === 2 ? 2160 : vipType === 1 ? 1080 : 720),
            };
          }
        }
      } catch {
        // playurlinfo 不一定所有文件都可用（m3u8 仅对 mp4/hls 编码有效，mkv 等容器返回 404），
        // 失败时自然回退到下一种拿法
      }
      // 2) 回退拿 dlink（cookie 模式一般会返回原画质，因为带会话 Cookie）
      const dlink = await this.getDlink(fsId, path);
      return {
        defaultUrl: dlink,
        defaultHeaders: this.webHeaders({ 'User-Agent': PCS_UA }),
        alternatives: [
          { label: '原画（直链）', url: dlink, headers: this.webHeaders({ 'User-Agent': PCS_UA }) },
        ],
        source: 'web-direct',
        vipType,
        estimatedMaxHeight: vipType === 2 ? 2160 : vipType === 1 ? 1080 : 720,
      };
    }

    // 开放平台：dlink 默认是被百度按权限转码过的版本（普通 token 最高 720P）。
    // 关键：必须在 URL 里显式带上 `clienttype=0&web=1` 并要求百度"按网页端对待"，
    // 这是百度文档化的"原画质请求"参数（vip_type>=1 可解锁 1080P，>=2 可解锁 2K/4K）。
    try {
      const token = await this.accessToken();
      const listData = await transientRetry<BaiduListResp>(
        () =>
          this.openRequest(
            `https://pan.baidu.com/rest/2.0/xpan/multimedia?method=filemetas&dlink=1&thumb=0&extra=1&fsids=${encodeURIComponent(JSON.stringify([Number(fsId)]))}&clienttype=0&web=1`,
            { method: 'GET' },
          ),
        { label: `playOptions ${path}` },
      );
      const item = (listData?.list as Array<{ dlink?: unknown }> | undefined)?.[0];
      const dlink = item?.dlink ? String(item.dlink) : '';
      if (!dlink)
        throw new BaiduApiError(0, '开放平台未返回 dlink（可能该文件无原画版本或权限受限）');
      const sep = dlink.includes('?') ? '&' : '?';
      const url = `${dlink}${sep}access_token=${encodeURIComponent(token)}`;
      return {
        defaultUrl: url,
        defaultHeaders: { 'User-Agent': PCS_UA },
        alternatives: [{ label: '原画（开放平台直链）', url, headers: { 'User-Agent': PCS_UA } }],
        source: 'openapi-direct',
        vipType,
        estimatedMaxHeight: vipType === 2 ? 2160 : vipType === 1 ? 1080 : 720,
      };
    } catch (e) {
      // 最后兜底：pcs 下载直链（无清晰度控制，但至少有东西能播）
      const url = `https://d.pcs.baidu.com/rest/2.0/xpan/file?method=download&path=${encodeURIComponent(path)}`;
      const token = await this.accessToken();
      const sep = url.includes('?') ? '&' : '?';
      const u = `${url}${sep}access_token=${encodeURIComponent(token)}`;
      return {
        defaultUrl: u,
        defaultHeaders: { 'User-Agent': PCS_UA },
        alternatives: [{ label: 'pcs 直链（兜底）', url: u, headers: { 'User-Agent': PCS_UA } }],
        source: 'pcs-direct',
        vipType,
        estimatedMaxHeight: 720, // pcs 直链普通账号最高 720P
      };
    }
  }

  /** 通过直链下载完整文件（cookie 模式 UA 失败时切 PCS UA 重试；网络抖动/限流自动重试） */
  async downloadByDlink(dlink: string, path: string): Promise<Uint8Array> {
    this.ensureAuth();
    let headers: Record<string, string>;
    if (this.auth.mode === 'openapi') {
      // openapi 直链需追加 access_token
      const token = await this.accessToken();
      const sep = dlink.includes('?') ? '&' : '?';
      headers = { 'User-Agent': PCS_UA };
      const resp = await transientRetry(
        () =>
          this.request(`${dlink}${sep}access_token=${encodeURIComponent(token)}`, {
            method: 'GET',
            headers,
          }),
        { label: `download ${path}` },
      );
      // 直链失败时百度可能返回 JSON 错误体（如 errno=31326 容量不足、errno=-20 文件不存在），
      // 而非二进制流。此时不应把它当"空响应"无谓重试 4 次，应直接解析 errno 抛明确错误。
      if (resp.arrayBuffer.byteLength > 0) {
        const probe = new TextDecoder('utf-8').decode(resp.arrayBuffer.slice(0, 64));
        if (probe.trim().startsWith('{')) {
          try {
            const errJson = JSON.parse(new TextDecoder('utf-8').decode(resp.arrayBuffer));
            const errno = Number(errJson?.errno ?? 0);
            if (errno !== 0) {
              throw new BaiduApiError(errno, errnoMessage(errno, `下载失败 ${path}`), {
                code: errnoToCode(errno),
                raw: errJson,
              });
            }
          } catch (e) {
            if (e instanceof BaiduApiError) throw e;
            // 非 JSON：当作正常二进制流，往下走
          }
        }
      }
      if (resp.status >= 400 || resp.arrayBuffer.byteLength === 0) {
        throw new BaiduApiError(0, `下载失败 ${path}（HTTP ${resp.status}）`, { transient: true });
      }
      return new Uint8Array(resp.arrayBuffer);
    }
    headers = this.webHeaders();
    let resp = await transientRetry(() => this.request(dlink, { method: 'GET', headers }), {
      label: `download ${path}`,
    });
    if (resp.status >= 400 || resp.arrayBuffer.byteLength === 0) {
      // Web UA 失败时切换 PCS UA 重试
      resp = await this.request(dlink, {
        method: 'GET',
        headers: this.webHeaders({ 'User-Agent': PCS_UA }),
      });
    }
    if (resp.status >= 400 || resp.arrayBuffer.byteLength === 0) {
      throw new BaiduApiError(0, `下载失败 ${path}（HTTP ${resp.status}）`, { transient: true });
    }
    return new Uint8Array(resp.arrayBuffer);
  }

  // ---------- 上传（三步：precreate → superfile2 → create），仅 openapi ----------

  /** 预创建。return_type=2 表示秒传成功 */
  async precreate(
    remotePath: string,
    size: number,
    blockListMd5: string[],
    rtype: number,
  ): Promise<{ uploadid: string; returnType: number; fsId?: string }> {
    this.ensureAuth();
    const blockList = JSON.stringify(blockListMd5);
    let attempt = 0;
    for (;;) {
      const data: BaiduApiResponse = await this.openRequest(
        'https://pan.baidu.com/rest/2.0/xpan/file?method=precreate',
        {
          method: 'POST',
          params: {
            path: remotePath,
            size: String(size),
            isdir: '0',
            autoinit: '1',
            block_list: blockList,
            rtype: String(rtype),
          },
        },
      );
      const errno = Number(data?.errno ?? 1);
      if (errno === 0) {
        const infoArr = data?.info as Array<{ fs_id?: unknown }> | undefined;
        return {
          uploadid: String(data.uploadid || ''),
          returnType: Number(data.return_type || 1),
          fsId:
            infoArr?.[0]?.fs_id != null
              ? String(infoArr[0].fs_id)
              : data.fs_id != null
                ? String(data.fs_id)
                : undefined,
        };
      }
      // -7：父目录可能失效，清缓存由上层重建（此处仅重试限流类）
      if (RATE_LIMIT_ERRNOS.includes(errno) && attempt < 4) {
        await sleep(1000 * Math.pow(2, attempt) + Math.floor(Math.random() * 300));
        attempt++;
        continue;
      }
      throw new BaiduApiError(errno, errnoMessage(errno, `上传预检失败 ${remotePath}`), {
        code: errnoToCode(errno),
        raw: data,
      });
    }
  }

  /**
   * 上传单个分片。多主机 × 多方法 × 多轮重试（对齐参考实现，提升成功率）：
   * 主机 [d.pcs.baidu.com, c.pcs.baidu.com, pan.baidu.com]，
   * 方法 [multipart POST, multipart PUT, octet-stream POST]。
   */
  async superfileUpload(
    remotePath: string,
    uploadid: string,
    partseq: number,
    chunk: Uint8Array,
  ): Promise<{ md5?: string }> {
    this.ensureAuth();
    const token = await this.accessToken();
    const hosts = ['https://d.pcs.baidu.com', 'https://c.pcs.baidu.com', 'https://pan.baidu.com'];
    const qs = `?method=upload&access_token=${encodeURIComponent(token)}&type=tmpfile&path=${encodeURIComponent(remotePath)}&uploadid=${encodeURIComponent(uploadid)}&partseq=${partseq}`;

    // multipart 边界
    const boundary = `----BDNSyncBoundary${Math.random().toString(36).slice(2)}`;
    const pre = new TextEncoder().encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="block${partseq}.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    );
    const post = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
    const body = new Uint8Array(pre.length + chunk.length + post.length);
    body.set(pre, 0);
    body.set(chunk, pre.length);
    body.set(post, pre.length + chunk.length);
    const bodyBuf = body.buffer.slice(
      body.byteOffset,
      body.byteOffset + body.byteLength,
    ) as ArrayBuffer;

    const attempts: { host: string; method: string; status: number; msg: string }[] = [];
    let successHostIdx = -1;

    for (let round = 0; round < 3; round++) {
      const order =
        successHostIdx >= 0
          ? [successHostIdx, ...hosts.map((_, i) => i).filter((i) => i !== successHostIdx)]
          : hosts.map((_, i) => i);
      for (const hostIdx of order) {
        const url = `${hosts[hostIdx]}/rest/2.0/pcs/superfile2${qs}`;
        const variants: {
          method: string;
          init: { method: string; headers: Record<string, string>; body: ArrayBuffer };
        }[] = [
          {
            method: 'multipart-POST',
            init: {
              method: 'POST',
              headers: {
                'User-Agent': PCS_UA,
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
              },
              body: bodyBuf,
            },
          },
          {
            method: 'multipart-PUT',
            init: {
              method: 'PUT',
              headers: {
                'User-Agent': PCS_UA,
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
              },
              body: bodyBuf,
            },
          },
          {
            method: 'octet-POST',
            init: {
              method: 'POST',
              headers: { 'User-Agent': PCS_UA, 'Content-Type': 'application/octet-stream' },
              body: chunk.buffer.slice(
                chunk.byteOffset,
                chunk.byteOffset + chunk.byteLength,
              ) as ArrayBuffer,
            },
          },
        ];
        for (const v of variants) {
          try {
            const resp = await this.request(url, v.init);
            const data: BaiduApiResponse =
              safeJson<BaiduApiResponse>(resp) ?? ({} as BaiduApiResponse);
            const errno = Number(data?.error_code ?? data?.errno ?? 0);
            if (resp.status < 400 && errno === 0) {
              successHostIdx = hostIdx;
              return { md5: data?.md5 ? String(data.md5) : undefined };
            }
            attempts.push({
              host: hosts[hostIdx],
              method: v.method,
              status: resp.status,
              msg: `err ${errno}`,
            });
          } catch (e) {
            attempts.push({
              host: hosts[hostIdx],
              method: v.method,
              status: 0,
              msg: e instanceof Error ? e.message.slice(0, 80) : String(e),
            });
          }
        }
      }
      if (round < 2) {
        await sleep(800 * Math.pow(2, round) + Math.floor(Math.random() * 400));
      }
    }
    const detail = attempts
      .slice(0, 3)
      .map((a) => `${a.host} ${a.method} ${a.status}${a.msg ? `(${a.msg})` : ''}`)
      .join('；');
    // 错误详情不暴露 access_token（已在 qs 中），脱敏后抛出
    const safeRemote = redactSecrets(remotePath);
    throw new BaiduApiError(
      0,
      `分片 ${partseq} 上传失败 ${safeRemote}（已尝试 ${attempts.length} 种组合：multipart POST/PUT、octet-stream × d/c/pan 主机 × 3 轮）：${redactSecrets(detail).slice(0, 240)}`,
      { transient: true },
    );
  }

  /** 创建（合并分片） */
  async createFile(
    remotePath: string,
    size: number,
    uploadid: string,
    blockListMd5: string[],
    rtype: number,
    localMtime?: number,
  ): Promise<{ fsId?: string }> {
    this.ensureAuth();
    const params: Record<string, string> = {
      path: remotePath,
      size: String(size),
      isdir: '0',
      uploadid,
      block_list: JSON.stringify(blockListMd5),
      rtype: String(rtype),
    };
    if (localMtime) params.local_mtime = String(Math.floor(localMtime / 1000));
    let attempt = 0;
    for (;;) {
      const data: BaiduApiResponse = await this.openRequest(
        'https://pan.baidu.com/rest/2.0/xpan/file?method=create',
        { method: 'POST', params },
      );
      const errno = Number(data?.errno ?? 1);
      if (errno === 0) {
        const infoArr = data?.info as Array<{ fs_id?: unknown }> | undefined;
        return {
          fsId:
            infoArr?.[0]?.fs_id != null
              ? String(infoArr[0].fs_id)
              : data.fs_id != null
                ? String(data.fs_id)
                : undefined,
        };
      }
      if (errno === -7) {
        // 父目录失效，由上层重建后重试
        if (attempt < 1) {
          attempt++;
          continue;
        }
      }
      if (RATE_LIMIT_ERRNOS.includes(errno) && attempt < 2) {
        await sleep(1000 * Math.pow(2, attempt) + Math.floor(Math.random() * 300));
        attempt++;
        continue;
      }
      throw new BaiduApiError(errno, errnoMessage(errno, `上传合并失败 ${remotePath}`), {
        code: errnoToCode(errno),
        raw: data,
      });
    }
  }

  // ---------- 文件管理 ----------

  /** 创建目录（已存在则视为成功） */
  async mkdir(remoteDir: string): Promise<void> {
    this.ensureAuth();
    // 通用兜底：/apps 是网盘为第三方应用预留的顶层保留目录，绝不可创建（errno=102）。
    // 应用自身专属子目录（/apps/<appName>）同样由授权时创建，调用方不应尝试重建。
    const d = (remoteDir || '/').replace(/\\/g, '/').replace(/\/+$/, '') || '/';
    if (d === '/' || d === '/apps') return;
    if (this.auth.mode === 'openapi') {
      const data: BaiduApiResponse = await this.openRequest(
        'https://pan.baidu.com/rest/2.0/xpan/file?method=create',
        {
          method: 'POST',
          params: { path: remoteDir, isdir: '1', size: '1', block_list: '[]', rtype: '2' },
        },
      );
      const errno = Number(data?.errno ?? 0);
      if (errno !== 0 && errno !== -8 && errno !== -7) {
        throw new BaiduApiError(errno, errnoMessage(errno, `创建目录 ${remoteDir} 失败`), {
          code: errnoToCode(errno),
          raw: data,
        });
      }
      return;
    }
    const parent = remoteDir.slice(0, remoteDir.lastIndexOf('/')) || '/';
    const url = `https://pan.baidu.com/api/create?a=1&parent_path=${encodeURIComponent(parent)}&web=1&channel=dubox&clienttype=0`;
    const params = { path: remoteDir, isdir: '1', size: '1', block_list: '[]', rtype: '2' };
    const resp = await this.request(url, {
      method: 'POST',
      headers: { ...this.webHeaders(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: this.formBody(params),
    });
    const data = safeJson<BaiduListResp>(resp);
    const errno = Number(data?.errno ?? 0);
    if (errno !== 0 && errno !== -8 && errno !== -7) {
      throw new BaiduApiError(errno, errnoMessage(errno, `创建目录 ${remoteDir} 失败`), {
        code: errnoToCode(errno),
        raw: data,
      });
    }
  }

  /** 批量删除云端文件 */
  async deleteFiles(remotePaths: string[]): Promise<void> {
    this.ensureAuth();
    if (remotePaths.length === 0) return;
    for (let i = 0; i < remotePaths.length; i += 100) {
      const batch = remotePaths.slice(i, i + 100);
      const filelist = JSON.stringify(batch.map((p) => ({ path: p })));
      let errno = 0;
      let data: BaiduApiResponse | null = null;
      if (this.auth.mode === 'openapi') {
        data = await transientRetry(
          () =>
            this.openRequest(
              'https://pan.baidu.com/rest/2.0/xpan/file?method=filemanager&opera=delete',
              {
                method: 'POST',
                params: { async: '0', filelist },
              },
            ),
          { label: 'deleteFiles' },
        );
        errno = Number(data?.errno ?? 0);
      } else {
        const url = 'https://pan.baidu.com/api/filemanager?web=1&channel=dubox&clienttype=0';
        const resp = await transientRetry(
          () =>
            this.request(url, {
              method: 'POST',
              headers: {
                ...this.webHeaders(),
                'Content-Type': 'application/x-www-form-urlencoded',
              },
              body: this.formBody({ method: 'delete', opera: 'delete', filelist, async: '2' }),
            }),
          { label: 'deleteFiles' },
        );
        data = safeJson(resp);
        errno = Number(data?.errno ?? 0);
        if (resp.status >= 400) {
          throw new BaiduApiError(resp.status, `删除云端文件失败：HTTP ${resp.status}`, {
            raw: data,
          });
        }
      }
      if (errno !== 0 && errno !== 12) {
        throw new BaiduApiError(
          errno,
          errnoMessage(errno, `删除云端文件失败（${batch.length} 个）`),
          { code: errnoToCode(errno), raw: data },
        );
      }
      // 逐项检查
      const infos: BaiduRawEntry[] = Array.isArray(data?.info) ? data.info : [];
      for (const info of infos) {
        const en = Number(info?.errno ?? 0);
        if (en !== 0 && en !== 12 && en !== -9) {
          throw new BaiduApiError(en, errnoMessage(en, `删除云端文件失败 ${info?.path ?? ''}`), {
            code: errnoToCode(en),
            raw: data,
          });
        }
      }
    }
  }

  /** 移动/重命名单个云端条目（filemanager opera=move/rename），自动创建目标父目录 */
  private async fileManager(
    opera: 'move' | 'rename',
    path: string,
    target: string,
    newname?: string,
  ): Promise<void> {
    this.ensureAuth();
    const payload: Record<string, string> = { path, isdir: '0' };
    if (opera === 'move') payload.dest = target;
    else payload.newname = newname ?? '';
    const filelist = JSON.stringify([payload]);
    if (this.auth.mode === 'openapi') {
      // openapi 移动需先确保目标父目录存在；但绝不可越过应用沙箱根创建 /apps 等保留目录
      if (opera === 'move' && target && target !== '/') {
        const parent = target.slice(0, target.lastIndexOf('/')) || '/';
        // 由源路径推算沙箱根（/apps/<appName>），该层及 /apps 由网盘授权时创建，禁止 mkdir
        const segs = path.replace(/^\/+/, '').split('/').filter(Boolean);
        const sandbox =
          segs.length >= 2 && segs[0] === 'apps'
            ? `/apps/${segs[1]}`
            : segs.length >= 1
              ? `/${segs[0]}`
              : '/';
        if (parent !== '/' && parent !== '/apps' && parent !== sandbox) {
          await this.mkdir(parent).catch(() => {
            /* 已存在则忽略 */
          });
        }
      }
      const data: BaiduApiResponse = await this.openRequest(
        'https://pan.baidu.com/rest/2.0/xpan/file?method=filemanager&opera=' + opera,
        {
          method: 'POST',
          params: { async: '0', filelist, ondup: 'overwrite' },
        },
      );
      const errno = Number(data?.errno ?? 0);
      if (errno !== 0 && errno !== 12) {
        throw new BaiduApiError(
          errno,
          errnoMessage(errno, `${opera === 'move' ? '移动' : '重命名'}失败 ${path}`),
          { code: errnoToCode(errno), raw: data },
        );
      }
      return;
    }
    const url = 'https://pan.baidu.com/api/filemanager?web=1&channel=dubox&clienttype=0';
    const resp = await this.request(url, {
      method: 'POST',
      headers: { ...this.webHeaders(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: this.formBody({ method: opera, opera, filelist, async: '2' }),
    });
    const data: BaiduApiResponse = safeJson<BaiduApiResponse>(resp) ?? ({} as BaiduApiResponse);
    const errno = Number(data?.errno ?? 0);
    if (resp.status >= 400) {
      throw new BaiduApiError(
        resp.status,
        `${opera === 'move' ? '移动' : '重命名'}失败：HTTP ${resp.status}`,
        { raw: data },
      );
    }
    if (errno !== 0 && errno !== 12) {
      throw new BaiduApiError(
        errno,
        errnoMessage(errno, `${opera === 'move' ? '移动' : '重命名'}失败 ${path}`),
        { code: errnoToCode(errno), raw: data },
      );
    }
  }

  /** 移动云端文件/目录到目标目录 */
  async move(fromPath: string, toDir: string): Promise<void> {
    await this.fileManager('move', fromPath, toDir);
  }

  /**
   * 生成分享链接（filemanager opera=share）。
   * openapi：/rest/2.0/xpan/file?method=filemanager&opera=share
   * cookie：/api/share/link?channel=dubox（POST，method=share，shorturl=1）
   * @param path 云端文件/目录路径
   * @returns 分享短链
   */
  async createShareLink(path: string): Promise<string> {
    this.ensureAuth();
    const filelist = JSON.stringify([{ path }]);
    if (this.auth.mode === 'openapi') {
      const data: BaiduApiResponse = await this.openRequest(
        'https://pan.baidu.com/rest/2.0/xpan/file?method=filemanager&opera=share',
        {
          method: 'POST',
          params: { async: '0', filelist },
        },
      );
      const errno = Number(data?.errno ?? 0);
      if (errno !== 0 && errno !== 12) {
        throw new BaiduApiError(errno, errnoMessage(errno, `生成分享链接失败 ${path}`), {
          code: errnoToCode(errno),
          raw: data,
        });
      }
      const link = data?.shorturl || data?.linkurl || data?.shareurl;
      if (link) return String(link);
      // 返回体结构可能为 { errno:0, data: { shorturl } }
      const nestedData = data?.data as Record<string, unknown> | undefined;
      const nested = nestedData?.shorturl || nestedData?.linkurl || nestedData?.shareurl;
      if (nested) return String(nested);
      throw new BaiduApiError(0, `生成分享链接失败 ${path}：接口未返回链接`, { raw: data });
    }
    const url = 'https://pan.baidu.com/api/share/link?web=1&channel=dubox&clienttype=0';
    const resp = await this.request(url, {
      method: 'POST',
      headers: { ...this.webHeaders(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: this.formBody({ method: 'share', shorturl: '1', filelist }),
    });
    const data: BaiduApiResponse = safeJson<BaiduApiResponse>(resp) ?? ({} as BaiduApiResponse);
    const errno = Number(data?.errno ?? 0);
    if (resp.status >= 400) {
      throw new BaiduApiError(resp.status, `生成分享链接失败：HTTP ${resp.status}`, { raw: data });
    }
    if (errno !== 0 && errno !== 12) {
      throw new BaiduApiError(errno, errnoMessage(errno, `生成分享链接失败 ${path}`), {
        code: errnoToCode(errno),
        raw: data,
      });
    }
    const urlsArr = data?.urls as Array<{ url?: unknown }> | undefined;
    const link = data?.shorturl || data?.link || urlsArr?.[0]?.url;
    if (!link)
      throw new BaiduApiError(0, `生成分享链接失败 ${path}：接口未返回链接`, { raw: data });
    return String(link);
  }

  /** 重命名云端文件/目录 */
  async rename(path: string, newName: string): Promise<void> {
    await this.fileManager('rename', path, '', newName);
  }

  /** 云端搜索（返回匹配条目，按名称模糊匹配） */
  async search(keyword: string, dir = '/'): Promise<RemoteRawEntry[]> {
    this.ensureAuth();
    const out: RemoteRawEntry[] = [];
    if (this.auth.mode === 'openapi') {
      const data: BaiduApiResponse = await this.openRequest(
        `https://pan.baidu.com/rest/2.0/xpan/file?method=search&dir=${encodeURIComponent(dir)}&key=${encodeURIComponent(keyword)}&limit=50&web=1`,
        { method: 'GET' },
      );
      const errno = Number(data?.errno ?? 0);
      if (errno !== 0 && errno !== -9) return out;
      const list: BaiduRawEntry[] = Array.isArray(data?.list) ? data.list : [];
      for (const it of list) out.push(mapEntry(it));
      return out;
    }
    const url = `https://pan.baidu.com/api/search?dir=${encodeURIComponent(dir)}&key=${encodeURIComponent(keyword)}&num=50&web=1&channel=dubox&clienttype=0`;
    const resp = await this.request(url, { method: 'GET', headers: this.webHeaders() });
    const data = safeJson<BaiduListResp>(resp);
    const errno = Number(data?.errno ?? 0);
    if (errno !== 0 && errno !== -9) return out;
    const list: BaiduRawEntry[] = Array.isArray(data?.list) ? data.list : [];
    for (const it of list) out.push(mapEntry(it));
    return out;
  }
}

function safeJson<T = unknown>(resp: RawResp): T | null {
  try {
    return resp.json() as T;
  } catch {
    return null;
  }
}

function mapEntry(it: BaiduRawEntry): RemoteRawEntry {
  const isDir = Number(it.isdir) === 1 || it.isdir === true;
  const path = String(it.path || '');
  const name = String(it.server_filename || path.slice(path.lastIndexOf('/') + 1) || '');
  const mtime = (Number(it.server_mtime) || Number(it.local_mtime) || 0) * 1000;
  return {
    path,
    name,
    isDir,
    isFile: !isDir,
    size: Number(it.size) || 0,
    mtime,
    fsId: String(it.fs_id ?? path),
  };
}
