// 本地流式代理（还原澜库 MCP Server 的 /stream 端点核心能力）。
//
// 为什么需要它：
//   Obsidian 的 requestUrl 会把整个响应读进内存，导致「预览大视频」必须等整文件
//   下载完才能播放。澜库的方案是启动一个本地 HTTP 服务器，浏览器 <video> 直接请求
//   http://127.0.0.1:<port>/stream?...，服务器把百度网盘的直链响应流 pipe 给浏览器，
//   实现真正的「边下边播 / 免落盘」。
//
// 本模块在插件加载时启动一个 http.Server 监听 127.0.0.1 随机端口，提供：
//   GET /stream?path=<网盘路径>&fsId=<fsId>&token=<token>
//     - 解析浏览器带来的 Range 头
//     - 优先用 BaiduApi.getStreamRequestInfo() 拿百度直链，Node https 请求并把响应
//       流直接 pipe 给本地响应（零落盘，边下边播）
//     - 直链失败时回退：downloadByDlink 整文件下载 → 按 Range 切片返回 206
//   GET /health  健康检查
//
// 鉴权：所有 /stream 请求必须带正确的 token（防止本机其他程序读取用户网盘内容）。

import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
  request as httpRequest,
} from 'http';
import { request as httpsRequest } from 'https';
import { URL } from 'url';
import type BDNSyncPlugin from './main';
import { redactSecrets } from './baidu/api';
import { mimeForExt } from './util/misc';

const MAX_FALLBACK_BYTES = 256 * 1024 * 1024; // 直链失败时回退下载的最大文件（256MB）

export class StreamServer {
  private server: Server | null = null;
  private port = 0;
  private token = '';
  private plugin: BDNSyncPlugin;

  constructor(plugin: BDNSyncPlugin) {
    this.plugin = plugin;
  }

  get baseUrl(): string {
    return this.port ? `http://127.0.0.1:${this.port}` : '';
  }

  get isRunning(): boolean {
    return this.server !== null;
  }

  /** 启动本地流式代理。失败（端口占用等）时自动换端口重试，最多 10 次。 */
  async start(): Promise<void> {
    if (this.server) return;
    // 生成一个一次性 token
    this.token = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const tryListen = (p: number, attempt: number): Promise<void> => {
      return new Promise((resolve, reject) => {
        const srv = createServer((req, res) => this.handle(req, res));
        const onError = (err: NodeJS.ErrnoException) => {
          srv.removeAllListeners('error');
          if (err.code === 'EADDRINUSE' && attempt > 0) {
            // 端口被占用，换端口重试（还原澜库逻辑）
            tryListen(p + 1, attempt - 1).then(resolve, reject);
          } else {
            reject(err);
          }
        };
        srv.once('error', onError);
        srv.listen(p, '127.0.0.1', () => {
          srv.removeAllListeners('error');
          this.server = srv;
          this.port = (srv.address() as { port: number }).port;
          resolve();
        });
      });
    };
    // 从 8731 起，避开常见端口
    const startPort = 8731 + Math.floor(Math.random() * 200);
    await tryListen(startPort, 10);
  }

  stop(): void {
    if (this.server) {
      try {
        this.server.close();
      } catch {
        /* ignore */
      }
      this.server = null;
      this.port = 0;
    }
  }

  /**
   * 为某个网盘文件构建本地流式地址（供预览 Modal 直接使用）
   *
   * @param quality 可选：'auto'（默认，按 VIP 自动选最高清晰度），
   *                或具体等级例如 '1080p' / '720p' / '4k' / 'original'
   *                播放器没有切换等级时调 auto 即可。
   */
  buildStreamUrl(target: { path: string; fsId: string }, quality = 'auto'): string {
    if (!this.baseUrl) return '';
    const u = new URL(`${this.baseUrl}/stream`);
    u.searchParams.set('path', target.path);
    u.searchParams.set('fsId', target.fsId);
    u.searchParams.set('token', this.token);
    if (quality && quality !== 'auto') u.searchParams.set('quality', quality);
    return u.toString();
  }

  // ---- 请求处理 ----

  /** 是否为本机回环地址（仅本机程序可访问流式代理） */
  private isLoopback(addr: string | undefined): boolean {
    if (!addr) return false;
    const a = addr.replace(/^::ffff:/, '').replace(/^::1$/, '127.0.0.1');
    return a === '127.0.0.1' || a === '::1' || a === 'localhost';
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    let parsed: URL;
    try {
      parsed = new URL(req.url || '/', 'http://127.0.0.1');
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad url' }));
      return;
    }
    // 远程地址防护：流式代理仅绑定 127.0.0.1，但仍需显式拒绝任何非本机来源，
    // 防止端口被转发到公网后远程请求也能读取用户网盘内容（即便持有所谓 token）。
    const remote = req.socket.remoteAddress;
    if (!this.isLoopback(remote)) {
      console.warn(`[BDNSync] 拒绝来自非本机地址的流式请求：${remote ?? 'unknown'}`);
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden: remote access denied' }));
      return;
    }
    // Host 头校验：只允许本机 host，拒绝被恶意 DNS/代理指向的外部 host。
    const host = req.headers.host || '';
    if (host && !/^(127\.0\.0\.1|localhost|\[::1\])(:|$)/.test(host)) {
      console.warn(`[BDNSync] 拒绝非法 Host 头的流式请求：${host}`);
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden: invalid host' }));
      return;
    }
    try {
      if (req.method === 'GET' && parsed.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', server: 'bdnsync-stream' }));
        return;
      }
      if (req.method === 'GET' && parsed.pathname === '/stream') {
        void this.handleStream(req, res, parsed);
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    } catch (e) {
      try {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: (e as Error)?.message || 'internal error' }));
      } catch {
        /* ignore */
      }
    }
  }

  private corsHeaders(): Record<string, string> {
    return {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Range, Content-Type',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
    };
  }

  private async handleStream(
    req: IncomingMessage,
    res: ServerResponse,
    parsed: URL,
  ): Promise<void> {
    const cors = this.corsHeaders();
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    // 鉴权
    const token = parsed.searchParams.get('token') || '';
    if (token !== this.token) {
      res.writeHead(401, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    const path = parsed.searchParams.get('path') || '';
    const fsId = parsed.searchParams.get('fsId') || '';
    if (!path || !fsId) {
      res.writeHead(400, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ error: 'missing path or fsId' }));
      return;
    }
    const range = req.headers.range;
    const qualityParam = parsed.searchParams.get('quality') || '';
    const wantQuality = qualityParam || 'auto';

    try {
      const api = this.plugin.createApi();
      // 优先：使用清晰度感知的播放源接口（Cookie 模式下尝试 HLS playurlinfo / dlink，
      //       开放平台模式显式带 clienttype=web 拿原画）。失败时回退到旧 dlink 路径。
      let initialUrl: string;
      let baseHeaders: Record<string, string>;
      try {
        const opts = await api.getMediaPlayOptions(fsId, path);
        // wantQuality = 'auto' → 用 defaultUrl（接口已按 VIP 选最高档）
        // 否则按清晰度标签匹配 alternatives
        let chosen = opts.defaultUrl;
        let chosenHeaders = opts.defaultHeaders;
        if (wantQuality !== 'auto' && opts.alternatives.length > 1) {
          const targetH = qualityToHeight(wantQuality);
          const found = opts.alternatives
            .map((a) => ({ a, h: parseInt(String(a.label).match(/\d+/)?.[0] || '0', 10) }))
            .filter((x) => x.h === targetH)[0]?.a;
          if (found) {
            chosen = found.url;
            chosenHeaders = found.headers;
          }
        }
        initialUrl = chosen;
        baseHeaders = chosenHeaders;
      } catch {
        // getMediaPlayOptions 失败时回退到老路径（保证现有功能不受影响）
        const fallback = await api.getStreamRequestInfo(fsId, path);
        initialUrl = fallback.url;
        baseHeaders = fallback.headers;
      }
      // 强制 identity 编码（百度直链返回 gzip 会让 video/audio 解码失败）。
      // 默认 UA 给一个主流浏览器，baseHeaders 中的 UA（pan.baidu.com）会覆盖。
      const initialHeaders: Record<string, string> = {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept-Encoding': 'identity',
        ...baseHeaders,
      };
      if (range) initialHeaders.Range = range;

      // 跟随 3xx 重定向最多 5 次（百度直链通常会 302 → 实际 CDN 节点）。
      // 这是澜库 `Is` 函数的核心：浏览器拿到的 URL 是稳定的本地代理，但实际
      // 跨过了多次重定向拿到真实下载源。
      const result = await streamFetchWithRedirect(initialUrl, initialHeaders, 5);
      const status = result.status;
      const outHeaders: Record<string, string> = { ...cors, 'Cache-Control': 'no-store' };
      for (const key of [
        'content-type',
        'content-length',
        'content-range',
        'accept-ranges',
        'last-modified',
        'etag',
      ]) {
        const v = result.headers[key];
        if (v !== undefined) outHeaders[key] = Array.isArray(v) ? v.join(',') : String(v);
      }
      if (!outHeaders['accept-ranges']) outHeaders['accept-ranges'] = 'bytes';
      res.writeHead(status, outHeaders);
      result.stream.pipe(res);
      result.stream.on('error', () => {
        try {
          res.end();
        } catch {
          /* ignore */
        }
      });
      res.on('close', () => {
        try {
          result.stream.destroy();
        } catch {
          /* ignore */
        }
      });
    } catch (e) {
      console.warn(
        `[BDNSync] 直链流式失败，回退整文件下载: ${redactSecrets((e as Error)?.message || String(e))}`,
      );
      await this.fallbackDownload(this.plugin.createApi(), fsId, path, range, res, cors);
    }
  }

  /** 直链失败时：整文件下载到内存，按 Range 切片返回（还原澜库 fallback 分支） */
  private async fallbackDownload(
    api: ReturnType<BDNSyncPlugin['createApi']>,
    fsId: string,
    path: string,
    range: string | undefined,
    res: ServerResponse,
    cors: Record<string, string>,
  ): Promise<void> {
    let bytes: Uint8Array;
    try {
      const dlink = await api.getDlink(fsId, path);
      bytes = await api.downloadByDlink(dlink, path);
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ error: redactSecrets((e as Error)?.message || 'download failed') }));
      return;
    }
    const total = bytes.byteLength;
    if (total > MAX_FALLBACK_BYTES) {
      res.writeHead(413, { 'Content-Type': 'application/json', ...cors });
      res.end(
        JSON.stringify({
          error: `文件过大（${(total / 1048576).toFixed(0)}MB），直链流式不可用，请下载后查看`,
        }),
      );
      return;
    }
    const mime = guessMime(path);
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : total - 1;
      if (Number.isNaN(start) || start < 0) start = 0;
      if (Number.isNaN(end) || end >= total) end = total - 1;
      const slice = bytes.slice(start, end + 1);
      res.writeHead(206, {
        ...cors,
        'Content-Type': mime,
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
        'Content-Length': String(slice.byteLength),
      });
      res.end(Buffer.from(slice));
    } else {
      res.writeHead(200, {
        ...cors,
        'Content-Type': mime,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
        'Content-Length': String(total),
      });
      res.end(Buffer.from(bytes));
    }
  }
}

function guessMime(path: string): string {
  const ext = (path.split('.').pop() || '').toLowerCase();
  return mimeForExt(ext);
}

/**
 * 跟随 3xx 重定向的流式 HTTP(S) 请求（还原澜库 `Is` 函数核心）。
 * 百度直链几乎都会 302 到实际 CDN 节点（bj.bcebos.com / d.pcs.baidu.com 等），
 * Node 的 https.request 不自动跟随重定向，所以必须手动循环。
 *
 * 返回值是最终响应的 IncomingMessage，可直接 `.pipe(res)` 给本地响应——
 * 浏览器拿到的是稳定可读的字节流（不是 302 + JSON 错误体）。
 */
async function streamFetchWithRedirect(
  initialUrl: string,
  headers: Record<string, string>,
  maxRedirects: number,
): Promise<{
  status: number;
  headers: import('http').IncomingHttpHeaders;
  stream: IncomingMessage;
}> {
  const tryOnce = (
    url: string,
    depth: number,
  ): Promise<{
    status: number;
    headers: import('http').IncomingHttpHeaders;
    stream: IncomingMessage;
  }> => {
    return new Promise((resolve, reject) => {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch (e) {
        reject(new Error(`invalid url: ${url}`));
        return;
      }
      const isHttps = parsed.protocol === 'https:';
      const lib = isHttps ? httpsRequest : httpRequest;
      const req = lib(
        {
          protocol: parsed.protocol,
          hostname: parsed.hostname,
          port: parsed.port || (isHttps ? 443 : 80),
          path: (parsed.pathname || '/') + (parsed.search || ''),
          method: 'GET',
          headers,
        },
        (resp) => {
          const status = resp.statusCode || 0;
          // 跟随 3xx 重定向（302/303/307 都按 GET 处理，保留 headers）
          if (status >= 300 && status < 400 && resp.headers.location) {
            // 必须消费掉当前响应体，否则会泄漏 socket
            resp.resume();
            if (depth >= maxRedirects) {
              reject(new Error(`重定向次数过多（>${maxRedirects}）: ${url}`));
              resp.resume();
              return;
            }
            const next = new URL(resp.headers.location, url).toString();
            tryOnce(next, depth + 1).then(resolve, reject);
            return;
          }
          // 最终响应（200/206/4xx/5xx 等）—— 返回给上层 pipe
          resolve({ status, headers: resp.headers, stream: resp });
        },
      );
      req.on('error', (err) => reject(new Error(`流式请求失败 ${url}: ${err.message}`)));
      req.end();
    });
  };
  return tryOnce(initialUrl, 0);
}

/** 用户传入的 quality 字符串 → 像素高度（用于在 alternatives 里挑匹配的清晰度档） */
function qualityToHeight(q: string): number {
  const k = String(q || '').toLowerCase();
  if (k === 'original' || k === '原画' || k === '4k' || k === '2k') return 9999;
  const m = k.match(/(\d{3,4})p?/);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  if (k === '4k') return 2160;
  if (k === '2k') return 1440;
  return n;
}
