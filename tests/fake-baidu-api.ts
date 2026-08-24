// 内存版 BaiduApi：模拟百度网盘远端存储，使真实 BaiduAdapter（上传分片/秒传/
// 下载校验/续传/删除/移动）可在 Node 测试环境完整运行，无需真实网络。
//
// 设计目标：让 adapter 层的真实逻辑（encrypt→分片→superfileUpload→createFile、
// download 解密 + hash 校验、move 保留 fsId）被真实执行，从而让引擎集成测试覆盖
// "adapter.upload/download/deleteRemote/renameRemote" 这些此前零测试的核心路径。
import { BaiduApiError, type BaiduAuth, type RemoteRawEntry } from '../src/baidu/api';
import { md5Hex } from '../src/util/md5';

/** 内存中的云端条目：path(绝对网盘路径) → 内容(已是"落盘"形态，明文或密文) + 元数据 */
interface CloudNode {
  content: Uint8Array;
  size: number; // 落盘字节数
  mtime: number; // 秒级 server_mtime
  fsId: string;
  isDir: boolean;
}

export class FakeBaiduApi {
  private nodes = new Map<string, CloudNode>();
  private fsIdSeq = 1;
  /** 分片暂存：uploadid → 按顺序累积的分片内容（模拟 superfile 上传后合并） */
  private pendingChunks = new Map<string, Uint8Array[]>();
  private auth: BaiduAuth;
  private quota = { total: 5 * 1024 * 1024 * 1024, used: 0 };
  /** 测试开关：置位后 download/getDlink 抛 31326（网盘容量不足），用于验证 short-circuit */
  forceQuotaExhausted = false;

  constructor(auth?: Partial<BaiduAuth>) {
    this.auth = {
      mode: 'openapi',
      bduss: '',
      stoken: '',
      cookieString: '',
      appKey: '',
      secretKey: '',
      accessToken: 'fake-token',
      refreshToken: '',
      tokenExpiresAt: '',
      ...auth,
    };
  }

  snapshotAuth(): BaiduAuth {
    return this.auth;
  }
  updateAuth(a: BaiduAuth): void {
    this.auth = a;
  }
  updateInterval(): void {}

  // ---- 目录 ----
  async mkdir(dir: string): Promise<void> {
    const d = normRemote(dir);
    this.nodes.set(d, {
      content: new Uint8Array(),
      size: 0,
      mtime: Math.floor(Date.now() / 1000),
      fsId: `fs-dir-${this.fsIdSeq++}`,
      isDir: true,
    });
  }

  async listDir(dir: string): Promise<RemoteRawEntry[]> {
    const d = normRemote(dir);
    const prefix = d === '/' ? '' : `${d}/`;
    const out: RemoteRawEntry[] = [];
    const seenDirs = new Set<string>();
    for (const [path, node] of this.nodes) {
      if (prefix && !path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      if (!rest) continue;
      const slash = rest.indexOf('/');
      if (slash >= 0) {
        const childDir = `${prefix}${rest.slice(0, slash)}`;
        if (!seenDirs.has(childDir)) {
          seenDirs.add(childDir);
          out.push({
            path: childDir,
            name: childDir.split('/').pop() || childDir,
            isDir: true,
            size: 0,
            mtime: 0,
            fsId: `fs-dir-${this.fsIdSeq++}`,
          });
        }
      } else {
        out.push({
          path,
          name: rest,
          isDir: node.isDir,
          size: node.size,
          mtime: node.mtime,
          fsId: node.fsId,
        });
      }
    }
    return out;
  }

  // ---- 下载 ----
  async getDlink(fsId: string, _path: string): Promise<string> {
    if (this.forceQuotaExhausted) {
      throw new BaiduApiError(31326, '网盘容量不足（测试注入）', { code: 'QUOTA' });
    }
    return `fake-dlink://${fsId}`;
  }

  async downloadByDlink(dlink: string, _path: string): Promise<Uint8Array> {
    // 真实百度：dlink 本身携带下载凭据，path 仅用于日志；fake 从 dlink 解析 fsId 定位内容。
    const m = /^fake-dlink:\/\/(.+)$/.exec(dlink);
    const fsId = m ? m[1] : dlink;
    for (const node of this.nodes.values()) {
      if (node.fsId === fsId) return node.content;
    }
    throw new BaiduApiError(-9, `文件不存在 ${_path}`, { code: 'NOT_FOUND' });
  }

  // ---- 上传（三步：precreate → superfileUpload → createFile）----
  async precreate(
    remotePath: string,
    total: number,
    md5s: string[],
    _rtype: number,
  ): Promise<{
    returnType: number;
    fsId?: string;
    uploadid?: string;
    md5?: string;
  }> {
    const p = normRemote(remotePath);
    const node = this.nodes.get(p);
    // 秒传：内容已存在且分片指纹一致 → 直接返回 fsId，不进入分片上传
    if (node && node.size === total) {
      const existingMd5 = md5HexOf(node.content);
      // 单分片（整文件）秒传：仅当 md5s 长度为 1 且匹配
      if (md5s.length === 1 && md5s[0] === existingMd5) {
        return { returnType: 2, fsId: node.fsId };
      }
    }
    return { returnType: 1, uploadid: `up-${this.fsIdSeq++}`, md5: md5s.join(',') };
  }

  async superfileUpload(
    remotePath: string,
    uploadid: string,
    _partIndex: number,
    chunk: Uint8Array,
  ): Promise<{ md5: string }> {
    // 真实分片上传的"网络"层：累积分片并校验 MD5（adapter 内部会比对）
    const key = uploadid;
    if (!this.pendingChunks.has(key)) this.pendingChunks.set(key, []);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    this.pendingChunks.get(key)!.push(chunk);
    return { md5: md5HexOf(chunk) };
  }

  async createFile(
    remotePath: string,
    total: number,
    uploadid: string,
    _md5s: string[],
    _rtype: number,
    _mtime: number,
  ): Promise<{ fsId: string }> {
    const p = normRemote(remotePath);
    // 合并此前 superfileUpload 累积的分片，模拟"分片上传完成后落盘"
    const chunks = this.pendingChunks.get(uploadid) ?? [];
    const merged = mergeChunks(chunks);
    this.pendingChunks.delete(uploadid);

    const node = this.nodes.get(p);
    if (node) {
      node.content = merged;
      node.size = total;
      node.mtime = Math.floor(Date.now() / 1000);
      return { fsId: node.fsId };
    }
    const fsId = `fs-${this.fsIdSeq++}`;
    this.nodes.set(p, {
      content: merged,
      size: total,
      mtime: Math.floor(Date.now() / 1000),
      fsId,
      isDir: false,
    });
    this.quota.used += total;
    return { fsId };
  }

  async deleteFiles(remotePaths: string[]): Promise<void> {
    for (const p of remotePaths) {
      const np = normRemote(p);
      const node = this.nodes.get(np);
      if (node) {
        this.quota.used = Math.max(0, this.quota.used - node.size);
        this.nodes.delete(np);
      }
    }
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    const f = normRemote(fromPath);
    const t = normRemote(toPath);
    const node = this.nodes.get(f);
    if (!node) throw new BaiduApiError(-9, `源文件不存在 ${f}`, { code: 'NOT_FOUND' });
    this.nodes.delete(f);
    this.nodes.set(t, { ...node });
  }

  // ---- 配额/用户（引擎未直接用到，供测试可调）----
  async getQuota(): Promise<{ total: number; used: number; free: number }> {
    return { ...this.quota, free: this.quota.total - this.quota.used };
  }

  async getUserInfo(): Promise<string | null> {
    return 'fake-user';
  }
}

function normRemote(p: string): string {
  if (!p.startsWith('/')) p = `/${p}`;
  return p.replace(/\/+/g, '/');
}

function md5HexOf(bytes: Uint8Array): string {
  return md5Hex(bytes);
}

function mergeChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}
