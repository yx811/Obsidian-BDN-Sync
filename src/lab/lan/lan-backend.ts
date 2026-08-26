/**
 * 局域网 P2P 同步后端（#5.10）——客户端 LanBackend + 对端文件仓储 LanPeer
 *
 * 设计要点（与云端 BaiduAdapter 保持同一心智模型，便于引擎零改动复用）：
 *   - 引擎只认 SyncBackend 接口；LanBackend 在「本机 → 对端设备」之间充当远端存储。
 *   - 对端运行 LanPeer（一个与内容无关的纯文件仓储），接收 file_get/file_put/delete/rename/list_tree。
 *   - 端到端加密（加密器）由客户端在上传前施加、下载后解除，对端落盘的是密文；
 *     信道再用基于配对口令的 AES-256-GCM（LanCipher）加密，防御同网段嗅探/误连。
 *   - 远程索引复用 file 通道（特殊路径 `.bdnsync/index.json`），因此服务端无需理解索引结构。
 *
 * 依赖 Node 内置模块（net/fs/path/buffer），全部懒加载，移动端不会执行（上层 Platform.isDesktop 守卫）。
 */

import type { Encryptor } from '../../crypto/encryption';
import { md5Hex } from '../../util/md5';
import type { RemoteEntry, RemoteIndex, UploadSession } from '../../types';
import type { ResolvedRemoteIndex, UploadResult } from '../../baidu/adapter';
import type { SyncBackend, SyncBackendUploadOpts } from '../../sync/backend';
import { TcpLink, type LanServer, type LanReqIn } from './transport';
import { LanCipher } from './cipher';
import type { LanMsg, LanTreeEntry } from './protocol';

/** 远程索引在「对端仓储」中的特殊路径（复用 file 通道，服务端不感知语义） */
export const LAN_INDEX_PATH = '.bdnsync/index.json';
/** 对端仓储内命名空间：把所有同步文件收敛到单一子目录，避免与本机其他文件混淆 */
const DEFAULT_NAMESPACE = 'vault';

/* ----------------------------- 懒加载 Node 内建 ----------------------------- */

// 懒加载 Node 模块：其精确类型依赖运行时注入，返回 any 属预期写法。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function req(name: string): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (globalThis as any).require?.(name);
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getBuffer(): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (globalThis as any).Buffer ?? req('buffer')?.Buffer;
}

/* ------------------------------- 客户端后端 ------------------------------- */

export interface LanBackendOpts {
  host: string;
  port: number;
  passphrase?: string;
  encryptor?: Encryptor | null;
  namespace?: string;
  /** 单条请求整体超时（毫秒），防止对端无响应时永久挂起 */
  timeoutMs?: number;
}

export class LanBackend implements SyncBackend {
  private cipher: LanCipher;
  private encryptor: Encryptor | null;
  private namespace: string;
  private host: string;
  private port: number;
  private timeoutMs: number;
  /** 持久连接：整个同步周期复用同一条 TCP 链路，避免「每操作一连接」的握手开销与端口耗尽（#R2） */
  private link: TcpLink | null = null;

  constructor(opts: LanBackendOpts) {
    this.host = opts.host;
    this.port = opts.port;
    this.cipher = new LanCipher(opts.passphrase ?? '');
    this.encryptor = opts.encryptor ?? null;
    this.namespace = opts.namespace ?? DEFAULT_NAMESPACE;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  setEncryptor(e: Encryptor | null): void {
    this.encryptor = e;
  }

  /** 局域网 P2P 不依赖百度云鉴权，离线可用 */
  get requiresCloudAuth(): boolean {
    return false;
  }

  /** 名义根路径（引擎仅用于拼接 ensureDir 参数，真实磁盘映射由对端 LanPeer 内部完成） */
  get root(): string {
    return `/${this.namespace}`;
  }

  /**
   * 获取（或惰性重建）持久连接。若链路已关闭（对端断开 / 上次请求失败）则重新连接，
   * 因此网络抖动后能自动恢复。
   */
  private async acquireLink(): Promise<TcpLink> {
    if (this.link && !this.link.isClosed()) return this.link;
    this.link = await TcpLink.connect(this.host, this.port, this.cipher);
    return this.link;
  }

  /** 在持久连接上发一次请求（带超时）。任一次请求失败都把链路置空，下次重建。 */
  private async req(msg: LanReqIn): Promise<LanMsg> {
    const link = await this.acquireLink();
    try {
      return await link.request(msg, this.timeoutMs);
    } catch (e) {
      this.link = null;
      throw e;
    }
  }

  /** 显式关闭底层连接（同步结束后应调用，释放半开 socket） */
  close(): void {
    this.link?.close();
    this.link = null;
  }

  private b64(bytes: Uint8Array): string {
    return getBuffer().from(bytes).toString('base64');
  }
  private unb64(s: string): Uint8Array {
    return new Uint8Array(getBuffer().from(s, 'base64'));
  }

  private async putBytes(relPath: string, bytes: Uint8Array): Promise<void> {
    const resp = await this.req({
      t: 'file_put',
      path: relPath,
      contentB64: this.b64(bytes),
      hash: md5Hex(bytes),
    });
    if (resp.t === 'error') throw new Error(resp.message);
    if (resp.t !== 'ok') throw new Error(`局域网写入失败：意外响应 ${resp.t}`);
  }

  private async getBytes(relPath: string): Promise<Uint8Array | null> {
    const resp = await this.req({ t: 'file_get', path: relPath });
    if (resp.t === 'file_data') return this.unb64(resp.contentB64);
    if (resp.t === 'file_missing') return null;
    if (resp.t === 'error') throw new Error(resp.message);
    throw new Error(`局域网读取失败：意外响应 ${resp.t}`);
  }

  private async encryptIfNeeded(plain: Uint8Array): Promise<Uint8Array> {
    if (this.encryptor && this.encryptor.isEnabled()) return this.encryptor.encrypt(plain);
    return plain;
  }
  private async decryptIfNeeded(bytes: Uint8Array): Promise<Uint8Array> {
    if (this.encryptor && this.encryptor.isEnabled()) return this.encryptor.decrypt(bytes);
    return bytes;
  }

  async readRemoteIndex(): Promise<ResolvedRemoteIndex | null> {
    const raw = await this.getBytes(LAN_INDEX_PATH);
    if (!raw) return null;
    try {
      const text = new TextDecoder('utf-8').decode(await this.decryptIfNeeded(raw));
      const idx = JSON.parse(text) as RemoteIndex;
      if (!idx || typeof idx !== 'object') return null;
      if (!idx.files) idx.files = {} as Record<string, never>;
      return idx as ResolvedRemoteIndex;
    } catch {
      // 索引损坏 → 交给引擎走全量对账兜底
      return null;
    }
  }

  async listTree(onProgress?: (count: number) => void): Promise<Map<string, RemoteEntry>> {
    const resp = await this.req({ t: 'list_tree' });
    const out = new Map<string, RemoteEntry>();
    if (resp.t !== 'tree') throw new Error(`局域网列举失败：${resp.t}`);
    let n = 0;
    for (const e of resp.entries) {
      if (e.path === '.bdnsync' || e.path.startsWith('.bdnsync/')) continue; // 排除索引目录
      out.set(e.path, {
        path: e.path,
        name: e.path.split('/').pop() || e.path,
        isDir: false,
        size: e.size,
        mtime: e.mtime,
        fsId: e.fsId,
      });
      n++;
      onProgress?.(n);
    }
    return out;
  }

  async download(entry: RemoteEntry, expectHash?: string): Promise<Uint8Array> {
    const raw = await this.getBytes(entry.path);
    if (!raw) throw new Error(`局域网下载失败：对端不存在 ${entry.path}`);
    const bytes = await this.decryptIfNeeded(raw);
    if (expectHash && md5Hex(bytes) !== expectHash) {
      throw new Error(`局域网下载校验失败：${entry.path}（hash 不一致）`);
    }
    return bytes;
  }

  async downloadByPath(relPath: string, expectHash?: string): Promise<Uint8Array | null> {
    const raw = await this.getBytes(relPath);
    if (!raw) return null;
    const bytes = await this.decryptIfNeeded(raw);
    if (expectHash && md5Hex(bytes) !== expectHash) return null;
    return bytes;
  }

  async upload(
    path: string,
    content: Uint8Array,
    opts?: SyncBackendUploadOpts,
  ): Promise<UploadResult> {
    // 0KB 文件（Obsidian 未命名草稿等）按「已同步」处理：不落盘物理上传。
    if (content.length === 0) {
      opts?.onSkipEmpty?.(path);
      return { fsId: undefined, rapid: true, bytesUp: 0, remoteSize: 0 };
    }
    const payload = await this.encryptIfNeeded(content);
    await this.putBytes(path, payload);
    return { fsId: undefined, rapid: false, bytesUp: content.length, remoteSize: payload.length };
  }

  async deleteRemote(relPaths: string[]): Promise<void> {
    const resp = await this.req({ t: 'delete', paths: relPaths });
    if (resp.t === 'error') throw new Error(resp.message);
  }

  async ensureDir(_remoteDir: string): Promise<void> {
    // 文件在 put 时按路径自动建目录，无需显式 mkdir
  }

  async renameRemote(oldRel: string, newRel: string): Promise<void> {
    const resp = await this.req({ t: 'rename', oldRel, newRel });
    if (resp.t === 'error') throw new Error(resp.message);
  }

  async writeRemoteIndex(idx: RemoteIndex): Promise<void> {
    idx.updatedAt = Date.now();
    const text = JSON.stringify(idx);
    const bytes = await this.encryptIfNeeded(new TextEncoder().encode(text));
    await this.putBytes(LAN_INDEX_PATH, bytes);
  }

  exportSessions(): UploadSession[] {
    return [];
  }
  restoreSessions(_sessions: UploadSession[]): void {
    /* 局域网后端暂不支持断点续传会话 */
  }
}

/* ------------------------------- 对端文件仓储 ------------------------------- */

export interface LanPeerOpts {
  /** 对端本地数据存储目录（与「本机 vault」完全独立，避免互相覆盖） */
  peerDataDir: string;
  /** 监听端口；传 0 由系统分配（测试场景推荐），随后读 .port 取实际端口 */
  port: number;
  passphrase?: string;
  namespace?: string;
}

export class LanPeer {
  private cipher: LanCipher;
  private namespace: string;
  private dataDir: string;
  private srv: LanServer | null = null;
  private listeningPort = 0;
  private startedPort: number;

  constructor(opts: LanPeerOpts) {
    this.cipher = new LanCipher(opts.passphrase ?? '');
    this.namespace = opts.namespace ?? DEFAULT_NAMESPACE;
    this.dataDir = opts.peerDataDir;
    this.startedPort = opts.port;
  }

  /** 实际监听端口（port 传 0 时由系统分配） */
  get port(): number {
    return this.listeningPort || this.startedPort;
  }

  isListening(): boolean {
    return this.srv !== null;
  }

  /** 启动 TCP 服务，作为「被同步的对端」 */
  async listen(): Promise<void> {
    const fs = req('fs');
    fs.mkdirSync(this.nsRoot(), { recursive: true });
    this.srv = await TcpLink.listen(this.startedPort, this.cipher, (msg) => this.handle(msg));
    this.listeningPort = this.srv.port;
  }

  close(): void {
    if (this.srv) {
      this.srv.close();
      this.srv = null;
    }
    this.listeningPort = 0;
  }

  private nsRoot(): string {
    const path = req('path');
    return path.join(this.dataDir, this.namespace);
  }
  /**
   * 把相对路径映射到对端数据目录内的绝对路径。
   * 安全加固（fail-closed）：剥离前导斜杠后，若任何路径段为 `.` / `..` 直接拒绝；
   * 并二次校验最终结果未逃出 `dataDir/namespace`，防止恶意或异常客户端以 `../../` 越界写入（#R6）。
   */
  private diskPath(relPath: string): string {
    const path = req('path');
    const segments = relPath
      .replace(/^[/\\]+/, '')
      .split(/[/\\]+/)
      .filter((s) => s.length > 0);
    for (const s of segments) {
      if (s === '.' || s === '..') {
        throw new Error(`拒绝越界路径访问：${relPath}`);
      }
    }
    const safe = segments.join('/');
    const root = path.join(this.dataDir, this.namespace);
    const full = path.join(root, safe);
    const rel = path.relative(root, full);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`拒绝越界路径访问：${relPath}`);
    }
    return full;
  }
  private static parentOf(p: string): string {
    return req('path').dirname(p);
  }

  private async handle(msg: LanMsg): Promise<LanMsg> {
    try {
      switch (msg.t) {
        case 'hello':
          return { id: msg.id, t: 'ok' };
        case 'list_tree':
          return { id: msg.id, t: 'tree', entries: this.walk() };
        case 'file_get': {
          const fs = req('fs');
          const p = this.diskPath(msg.path);
          if (!fs.existsSync(p) || !fs.statSync(p).isFile()) {
            return { id: msg.id, t: 'file_missing' };
          }
          const bytes = fs.readFileSync(p);
          return {
            id: msg.id,
            t: 'file_data',
            contentB64: getBuffer().from(bytes).toString('base64'),
            hash: md5Hex(new Uint8Array(bytes)),
          };
        }
        case 'file_put': {
          const fs = req('fs');
          const p = this.diskPath(msg.path);
          fs.mkdirSync(LanPeer.parentOf(p), { recursive: true });
          fs.writeFileSync(p, getBuffer().from(msg.contentB64, 'base64'));
          return { id: msg.id, t: 'ok' };
        }
        case 'delete': {
          const fs = req('fs');
          for (const rp of msg.paths) {
            const p = this.diskPath(rp);
            if (fs.existsSync(p)) fs.rmSync(p, { force: true });
          }
          return { id: msg.id, t: 'ok' };
        }
        case 'rename': {
          const fs = req('fs');
          const oldP = this.diskPath(msg.oldRel);
          const newP = this.diskPath(msg.newRel);
          if (fs.existsSync(oldP)) {
            fs.mkdirSync(LanPeer.parentOf(newP), { recursive: true });
            fs.renameSync(oldP, newP);
          }
          return { id: msg.id, t: 'ok' };
        }
        default:
          return { id: (msg as { id: number }).id ?? 0, t: 'error', message: `不支持的消息类型` };
      }
    } catch (e: unknown) {
      const m = e instanceof Error ? e.message : String(e);
      return { id: (msg as { id: number }).id ?? 0, t: 'error', message: m };
    }
  }

  /** 递归遍历命名空间下的全部文件，排除索引目录 */
  private walk(): LanTreeEntry[] {
    const fs = req('fs');
    const path = req('path');
    const base = this.nsRoot();
    const entries: LanTreeEntry[] = [];
    const stack: string[] = [base];
    while (stack.length) {
      const dir = stack.pop() as string;
      let list: unknown[];
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        list = fs.readdirSync(dir, { withFileTypes: true }) as any[];
      } catch {
        continue;
      }
      for (const ent of list) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const e = ent as any;
        const full = path.join(dir, e.name);
        const rel = full.slice(base.length + 1).split(path.sep).join('/');
        if (e.isDirectory()) {
          stack.push(full);
        } else if (e.isFile()) {
          if (rel === '.bdnsync' || rel.startsWith('.bdnsync/')) continue;
          const st = fs.statSync(full);
          entries.push({
            path: rel,
            size: st.size,
            mtime: st.mtimeMs,
            fsId: md5Hex(new TextEncoder().encode(rel)).slice(0, 16),
          });
        }
      }
    }
    return entries;
  }
}
