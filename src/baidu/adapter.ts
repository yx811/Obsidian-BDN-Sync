// 百度网盘高层适配器：目录树、上传（秒传/断点续传）、下载、删除、远程索引读写

import { BaiduApi, BaiduApiError } from './api';
import { looksEncrypted, type Encryptor } from '../crypto/encryption';
import { md5Hex, md5HexOf } from '../util/md5';
import { normalizeRemote, remoteJoin, remoteParent, sleep } from '../util/misc';
import type { BDNSyncSettings, FileState, RemoteEntry, RemoteIndex, UploadSession } from '../types';

/**
 * 已解析（解分片）的远程索引：files 一定是非空 Record（分片已合并），
 * 供引擎侧自由读写，无需再判 null。分片形态仅存在于云端存储层，
 * 引擎逻辑始终面对这份「已聚合」视图。
 */
export type ResolvedRemoteIndex = Omit<RemoteIndex, 'files'> & { files: Record<string, FileState> };

export const INDEX_DIR = '.bdnsync';
export const INDEX_FILE = 'index.json';
export const INDEX_VERSION = '1.0.1';
/** 分片目录（相对 INDEX_DIR）：`.bdnsync/shards/` */
export const SHARDS_DIR = 'shards';
/** 分片文件名前缀，形如 `shard-0.json` */
export const SHARD_PREFIX = 'shard-';
/** 每分片承载的最大文件条目数。超过该阈值即切换为分片索引，避免单 JSON 体积膨胀（A3） */
export const SHARD_MAX_FILES = 2000;
/** F1 断点续传有效性窗口：超过该时长（ms）的会话视为过期，不再复用 */
const SESSION_TTL = 12 * 60 * 60 * 1000; // 12 小时
/** 墓碑（已删除文件状态）在远程索引中的保留时长；超过则被 pruneTombstones 清理 */
export const TOMBSTONE_TTL = 30 * 24 * 60 * 60 * 1000; // 30 天

export interface UploadResult {
  fsId?: string;
  rapid: boolean; // 是否秒传
  bytesUp: number; // 实际上行字节（秒传为 0）
  remoteSize: number; // 落盘字节数（加密时为密文长度），用于远程索引新鲜度校验
}

export class BaiduAdapter {
  private dirCache = new Set<string>();
  private uploadSessions = new Map<string, UploadSession>();
  public lastError: BaiduApiError | null = null;

  constructor(
    public api: BaiduApi,
    private settings: () => BDNSyncSettings,
    private encryptor: Encryptor | null,
  ) {}

  /** 设置变更后热更新加密器 */
  setEncryptor(e: Encryptor | null): void {
    this.encryptor = e;
  }

  get root(): string {
    return normalizeRemote(this.settings().remoteRoot || '/apps/bdnsync/MyVault');
  }

  /**
   * 应用沙箱根：百度网盘为第三方应用预留的专用目录，形如 `/apps/<appName>`。
   * 这是「允许创建的最小祖先」——其本身（以及更上层的 `/apps`）由网盘在授权时
   * 自动创建，调用方**绝不可**尝试 mkdir，否则会收到 errno=102（父目录不存在）。
   * 所有远端目录创建逻辑都必须以它为下界，向上递归到此即停。
   */
  get sandboxRoot(): string {
    const r = this.root; // 形如 /apps/bdnsync/MyVault
    const parts = r.split('/').filter(Boolean); // ['apps','bdnsync','MyVault']
    if (parts.length >= 2 && parts[0] === 'apps') return `/apps/${parts[1]}`;
    // 非标准 /apps 布局：至少保留首段，避免向上误建根
    return parts.length >= 1 ? `/${parts[0]}` : '/';
  }

  /**
   * 受保护的目录创建：永不在「应用沙箱根」之上（含 /apps 本身）尝试创建。
   * 这是 errno=102 的根因修复点——之前 ensureDir 会把 /apps 当作普通祖先去 mkdir。
   * 返回 true 表示目录已存在或创建成功；false 表示位于沙箱根之上被安全跳过。
   */
  private async safeMkdir(dir: string): Promise<boolean> {
    const d = normalizeRemote(dir);
    const sandbox = this.sandboxRoot;
    // 不可越过沙箱根创建：/apps、/apps/<appName> 由网盘授权时创建
    if (d === '/' || d === '/apps' || d === sandbox) return false;
    try {
      await this.api.mkdir(d);
    } catch (e) {
      if (
        e instanceof BaiduApiError &&
        (e.errno === -8 ||
          e.errno === -7 ||
          e.errno === 31061 ||
          e.errno === 31064 ||
          e.errno === -9)
      ) {
        // 已存在或等价情形 → 视为成功
      } else {
        throw e;
      }
    }
    return true;
  }

  /**
   * 恢复上传会话（F1 真断点续传）。
   * 仅恢复在有效期窗口内、且分块指纹（md5s）与持久化的 blockMd5 完全一致的会话，
   * 杜绝「脏续传」——若记录中的 blockMd5 缺失/长度不符，说明 transfer-state.json
   * 与当前内容版本不匹配，宁可丢弃重新 precreate，也不复用可能失效的 uploadid。
   */
  restoreSessions(sessions: UploadSession[]) {
    const now = Date.now();
    for (const s of sessions) {
      if (now - s.startedAt >= SESSION_TTL) continue;
      if (!Array.isArray(s.md5s) || s.md5s.length === 0) continue;
      // blockMd5 缺失（旧版兼容）时，仅要求 doneParts 是 md5s 下标子集，保守复用
      if (Array.isArray(s.blockMd5) && s.blockMd5.length === s.md5s.length) {
        const valid = s.doneParts.every(
          (i) => i >= 0 && i < s.md5s.length && s.blockMd5[i] === s.md5s[i],
        );
        if (!valid) continue;
      } else {
        const maxIdx = s.md5s.length - 1;
        if (!s.doneParts.every((i) => i >= 0 && i <= maxIdx)) continue;
      }
      this.uploadSessions.set(s.path, {
        ...s,
        doneBytes: s.doneBytes ?? 0,
        blockMd5: s.blockMd5 ?? [],
      });
    }
  }

  exportSessions(): UploadSession[] {
    return Array.from(this.uploadSessions.values());
  }

  // ---------- 目录 ----------

  /** 确保远程目录存在（递归创建，带会话内缓存，且绝不超过应用沙箱根） */
  async ensureDir(remoteDir: string): Promise<void> {
    const dir = normalizeRemote(remoteDir);
    if (dir === '/' || this.dirCache.has(dir)) return;
    const sandbox = this.sandboxRoot;
    // 先确保父目录（递归到沙箱根为止，不向上越界）
    const parent = remoteParent(dir);
    if (parent !== dir && parent !== '/' && parent !== sandbox) await this.ensureDir(parent);
    await this.safeMkdir(dir);
    this.dirCache.add(dir);
  }

  /**
   * 递归列出远程树（仅文件），排除 .bdnsync 索引目录。
   * 返回 Map<相对 root 的完整路径, RemoteEntry>，且 entry.path 也被归一化为该完整路径。
   *
   * 注意：listRemoteDir 返回的 path 是「相对被列目录」的，因此这里必须逐层累加
   * 相对 root 的前缀，否则子目录里的文件会以 basename 作为键（丢掉父目录前缀），
   * 导致同步决策把本地 `Notes/sub/a.md` 误判为「云端不存在」而删除本地文件。
   */
  async listTree(onProgress?: (count: number) => void): Promise<Map<string, RemoteEntry>> {
    const result = new Map<string, RemoteEntry>();
    // 队列元素：dir = 绝对网盘路径；rel = 相对 root 的路径（'' 表示 root 自身）
    const queue: { dir: string; rel: string }[] = [{ dir: this.root, rel: '' }];
    const visited = new Set<string>([this.root]);
    let count = 0;
    while (queue.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const cur = queue.shift()!;
      let entries: RemoteEntry[] = [];
      try {
        entries = await this.listRemoteDir(cur.dir);
      } catch (e) {
        if (e instanceof BaiduApiError && (e.errno === -9 || e.errno === -7)) continue; // 目录不存在
        throw e;
      }
      for (const e of entries) {
        const name = e.path || e.name;
        if (!name) continue;
        const rel = cur.rel ? `${cur.rel}/${name}` : name;
        if (e.isDir) {
          if (rel === INDEX_DIR) continue; // 索引目录单独处理
          const abs = remoteJoin(cur.dir, name);
          if (visited.has(abs)) continue;
          visited.add(abs);
          queue.push({ dir: abs, rel });
        } else {
          result.set(rel, { ...e, path: rel });
          count++;
          if (onProgress && count % 100 === 0) onProgress(count);
        }
      }
    }
    return result;
  }

  /** 列出远程目录（单层），返回相对 root 的路径条目 */
  async listRemoteDir(remoteDir: string): Promise<RemoteEntry[]> {
    const raw = await this.api.listDir(remoteDir);
    const norm = normalizeRemote(remoteDir);
    const prefix = norm === '/' ? '' : norm + '/';
    return raw.map((it) => {
      let rel = it.path || '';
      if (prefix && rel.startsWith(prefix)) rel = rel.slice(prefix.length);
      else rel = rel.replace(/^\//, '');
      return {
        path: rel,
        name: it.name,
        isDir: it.isDir,
        size: it.size,
        mtime: it.mtime,
        fsId: it.fsId,
      } as RemoteEntry;
    });
  }

  // ---------- 读写文件内容 ----------

  /** 下载远程文件（返回解密后的明文；校验可选） */
  async download(entry: RemoteEntry, expectHash?: string): Promise<Uint8Array> {
    // 下载方向对称大小上限：云端手动放大/恶意文件不应无条件下载撑爆本地磁盘。
    // 以远程实际落盘字节数（entry.size）为准，加密时为密文长度、未加密为明文长度，
    // 均 ≥ 明文，故该上限对两种模式都安全。
    const maxBytes = this.settings().maxFileSizeMB * 1024 * 1024;
    if (entry.size > maxBytes) {
      throw new BaiduApiError(
        0,
        `下载跳过 ${entry.path}：文件体积 ${entry.size} 字节超过下载上限 ${maxBytes} 字节（可在设置调大「单文件大小上限」）`,
        { code: 'OVERSIZED' },
      );
    }
    const dlink = await this.api.getDlink(entry.fsId, remoteJoin(this.root, entry.path));
    let bytes = await this.api.downloadByDlink(dlink, entry.path);
    // 按魔数判定是否为 BDNSync 密文，而不是「只要开了加密就无条件解密」。
    // 常见场景：用户先同步了一批明文，之后才打开加密开关；此时云端同时存在
    // 明文与密文，无条件解密会让每个旧文件的下载都抛 EncryptionError。
    if (this.encryptor && this.encryptor.isEnabled() && looksEncrypted(bytes)) {
      bytes = await this.encryptor.decrypt(bytes);
    }
    if (expectHash) {
      const h = md5Hex(bytes);
      if (h !== expectHash) {
        throw new BaiduApiError(0, `下载校验失败：${entry.path}（hash 不一致）`, {
          transient: true,
        });
      }
    }
    // 防御性校验：实际字节不应超过声明 size 的 1.1 倍（加密密文略大，留余量），
    // 防止远端元数据被篡改后无界膨胀导致本地内存撑爆（类 zip 炸弹防护）。
    if (entry.size > 0 && bytes.length > entry.size * 1.1 + 16) {
      throw new BaiduApiError(
        0,
        `下载拒绝 ${entry.path}：实际 ${bytes.length} 字节远超声明的 ${entry.size}，疑似元数据被篡改`,
        { code: 'SIZE_MISMATCH' },
      );
    }
    return bytes;
  }

  /** 按路径下载（先定位 fsId；用于索引等零散文件） */
  async downloadByPath(relPath: string, expectHash?: string): Promise<Uint8Array | null> {
    const dir = remoteParent(relPath);
    const name = relPath.slice(relPath.lastIndexOf('/') + 1);
    const entries = dir
      ? await this.listRemoteDir(remoteJoin(this.root, dir))
      : await this.listRemoteDir(this.root);
    const hit = entries.find((e) => !e.isDir && e.name === name);
    if (!hit) return null;
    return this.download({ ...hit, path: relPath }, expectHash);
  }

  /**
   * 上传文件内容（自动加密 → 分片 → 秒传尝试 → 断点续传）
   * 注意：仅 OpenAPI（设备码授权）模式支持上传；Cookie 模式不支持上传（对齐参考实现）。
   * @param relPath 相对 root 路径
   * @param plain 明文字节
   */
  async upload(
    relPath: string,
    plain: Uint8Array,
    opts: {
      onProgress?: (done: number, total: number) => void;
      onPartDone?: (session: UploadSession) => void; // F1：每分块成功后回调，用于落盘断点
      overwrite?: boolean;
      /** #3.8 边缘情况：0KB 文件跳过物理上传时回调，便于引擎记日志/统计 */
      onSkipEmpty?: (relPath: string) => void;
    } = {},
  ): Promise<UploadResult> {
    if (this.api.snapshotAuth().mode !== 'openapi') {
      throw new BaiduApiError(
        0,
        'Cookie 模式不支持上传（precreate 必须开放平台 access_token）。请在设置中填写 AppKey/SecretKey 并完成「设备码授权」切换到 OpenAPI 模式后再上传',
        { code: 'NOT_SUPPORTED' },
      );
    }
    const remotePath = remoteJoin(this.root, relPath);
    await this.ensureDir(remoteParent(remotePath));

    const payload =
      this.encryptor && this.encryptor.isEnabled() ? await this.encryptor.encrypt(plain) : plain;
    const total = payload.length;
    const partSize = Math.max(1, this.settings().chunkSizeMB) * 1024 * 1024;
    const chunks: Uint8Array[] = [];
    if (total > 0) {
      for (let off = 0; off < total; off += partSize)
        chunks.push(payload.subarray(off, Math.min(off + partSize, total)));
    }
    const md5s = chunks.map((c) => md5Hex(c));
    const md5sKey = md5s.join(',');
    const rtype = opts.overwrite === false ? 0 : 3;

    // 百度网盘 openapi 物理上不允许 0 字节文件：
    // precreate(size=0, block_list=[]) → errno=2「参数错误」；createFile(size=0) → errno=10「创建文件失败」。
    // （OpenList 百度网盘驱动同样显式拒绝 size<1：`if stream.GetSize() < 1 return ErrBaiduEmptyFilesNotAllowed`）
    // 空文件（Obsidian 新建「未命名.md」等）直接按「已同步」处理：不上传、不报错、本地索引照常记录。
    // engine 侧会用空内容 hash 写入远程索引，下次三方对比 hash 一致 → skip，不再反复上传报错。
    if (total === 0) {
      const emptyHash = md5sKey || md5Hex(new Uint8Array(0)); // 空内容 md5：d41d8cd9...
      void emptyHash; // 仅供调试参考；engine 会自行计算 hash
      // #3.8 边缘情况：0KB 文件跳过物理上传（百度网盘禁止 0 字节文件），仅记索引。
      // 显式回调通知引擎，使其能标注「已跳过物理上传」并计入统计，避免日志中看似「静默成功」。
      opts.onSkipEmpty?.(relPath);
      return { fsId: undefined, rapid: true, bytesUp: 0, remoteSize: 0 };
    }

    // 断点续传：同 path + 同分片指纹 → 复用 uploadid
    let session = this.uploadSessions.get(relPath);
    if (session && (session.totalSize !== total || session.md5s.join(',') !== md5sKey)) {
      this.uploadSessions.delete(relPath);
      session = undefined;
    }

    // 自愈重试：百度 xpan create（合并分片）偶发 errno=10「文件不存在 / 分片未就绪」
    // ——precreate 拿到的 uploadid 在合并时百度侧找不到对应分片。重走「precreate→分片→合并」
    // 通常可恢复，故此处至多自愈一次，避免本次同步直接失败、只能等下次。
    for (let uploadAttempt = 0; uploadAttempt < 2; uploadAttempt++) {
    if (!session) {
      let pre;
      try {
        pre = await this.api.precreate(remotePath, total, md5s, rtype);
      } catch (e) {
        if (e instanceof BaiduApiError && e.errno === -7) {
          // 文件名/路径非法：给出可操作的明确提示，而不是笼统的"上传预检失败"。
          // 不自动改名（改名会改变文件 identity，违反数据安全原则），交由用户修正。
          const base = relPath.split('/').pop() || relPath;
          const safe = base.replace(/[\\:*?"<>|#%&{}/]/g, '_').slice(0, 200);
          throw new BaiduApiError(
            -7,
            `上传失败 ${relPath}：文件名含网盘不支持的字符（如 \\ : * ? " < > | # % & { } /）。建议重命名为「${safe}」后再同步。`,
            { code: 'NOT_FOUND', raw: e.raw },
          );
        }
        // 诊断增强：precreate 抛错（含 errno=2「参数错误」）时，把百度原始返回摘要出来，
        // 便于确认是 path / size / block_list / rtype 哪个字段非法（百度不指明字段）。
        this.attachRawDiagnostic('precreate', relPath, remotePath, total, md5s, rtype, e);
        throw e;
      }
      if (pre.returnType === 2) {
        // 秒传成功
        opts.onProgress?.(total, total);
        return { fsId: pre.fsId, rapid: true, bytesUp: 0, remoteSize: total };
      }
      if (!pre.uploadid) throw new BaiduApiError(0, `上传预检未返回 uploadid：${relPath}`);
      session = {
        path: relPath,
        remotePath,
        uploadid: pre.uploadid,
        totalSize: total,
        partSize,
        md5s,
        doneParts: [],
        doneBytes: 0,
        blockMd5: [],
        startedAt: Date.now(),
      };
      this.uploadSessions.set(relPath, session);
    }

    const done = new Set(session.doneParts);
    // TS 收窄：worker 是 async 闭包会丢失外层 session 的非空性，这里先捕获为常量
    const sess = session;
    // 🚀 分片并发上传：百度 superfile2 允许乱序分片（partseq 标识顺序，create 时合并），
    // 串行逐片上传（每片一次 HTTP 往返）在分片多时是速度瓶颈。这里按 uploadConcurrency
    // 起固定 worker 池并发上传（默认 2-3，避免同一 uploadid 过多并发触发限流）。
    const partConcurrency = Math.min(
      3,
      Math.max(1, this.settings().uploadConcurrency || 2),
    );
    let cursor = 0;
    const partWorkers = Array.from({ length: partConcurrency }, async () => {
      while (cursor < chunks.length) {
        const i = cursor++;
        if (done.has(i)) continue;
        let ok = false;
        for (let attempt = 0; attempt < 3 && !ok; attempt++) {
          try {
            const r = await this.api.superfileUpload(remotePath, sess.uploadid, i, chunks[i]);
            // 分片必须返回 md5 且与本地一致，缺 md5 视为失败（防「假成功」→ create errno=10）
            if (!r.md5) {
              throw new BaiduApiError(42111, `第 ${i + 1} 块未返回 MD5：${relPath}`);
            }
            if (r.md5 !== md5s[i]) {
              throw new BaiduApiError(42111, `第 ${i + 1} 块 MD5 校验不一致：${relPath}`);
            }
            ok = true;
          } catch (e) {
            if (e instanceof BaiduApiError && e.errno === 42112 && attempt < 2) {
              await sleep(1500);
              continue;
            }
            throw e;
          }
        }
        done.add(i);
        // F1：持久化分块级进度，使崩溃重启后能续传而非从 precreate 重来
        sess.doneParts = Array.from(done).sort((a, b) => a - b);
        sess.doneBytes = sess.doneParts.reduce(
          (sum, idx) => sum + (chunks[idx]?.length ?? 0),
          0,
        );
        sess.blockMd5[i] = md5s[i];
        opts.onPartDone?.(sess);
        opts.onProgress?.(Math.min(sess.doneBytes, total), total);
      }
    });
    await Promise.all(partWorkers);

    try {
      const created = await this.api.createFile(
        remotePath,
        total,
        session.uploadid,
        md5s,
        rtype,
        Date.now(),
      );
      this.uploadSessions.delete(relPath);
      return { fsId: created.fsId, rapid: false, bytesUp: total, remoteSize: total };
    } catch (e) {
      const isRecoverable = e instanceof BaiduApiError && (e.errno === 10 || e.errno === -9);
      if (isRecoverable && uploadAttempt < 1) {
        // 合并阶段 errno=10（分片未就绪）/ -9（目录不存在或路径校验失败）：
        // 丢弃失效会话，下一轮重新 precreate + 重传，自愈一次。
        this.uploadSessions.delete(relPath);
        session = undefined;
        console.warn(
          `[BDNSync] 上传合并返回 errno=${e instanceof BaiduApiError ? e.errno : '?'}（${relPath}），自愈重试一次（重建会话）`,
        );
        continue;
      }
      // 诊断增强：合并失败（含 errno=2「参数错误」）时，把我们传入的参数与百度原始返回一并打出，
      // 便于确认 merge 请求本身参数是否非法（path/uploadid/block_list/size 不一致）。
      this.uploadSessions.delete(relPath);
      this.attachRawDiagnostic(
        'createFile',
        relPath,
        remotePath,
        total,
        md5s,
        rtype,
        e,
        session?.uploadid,
      );
      throw e;
    }
    }
    // 不应到达此处：循环最多 2 轮，第二轮必进入非自愈分支并 throw。兜底以防万一。
    throw new BaiduApiError(0, `上传失败 ${relPath}：合并重试后仍无法完成`);
  }

  /**
   * 诊断增强：上传失败时把「我们传给百度的参数」与「百度原始返回」一并打到 console，
   * 便于定位 errno=2「参数错误」究竟是 path / size / block_list / rtype 哪个字段非法
   * （百度仅返回 errno，不指明具体字段）。
   * 不抛异常、不阻断流程——只在控制台留下案发现场，供下次复现时一锤定音。
   */
  private attachRawDiagnostic(
    step: 'precreate' | 'createFile',
    relPath: string,
    remotePath: string,
    total: number,
    md5s: string[],
    rtype: number,
    e: unknown,
    uploadid?: string,
  ): void {
    const raw = e instanceof BaiduApiError ? e.raw : undefined;
    const rawFields: string[] = [];
    if (raw && typeof raw === 'object') {
      const obj = raw as Record<string, unknown>;
      for (const k of ['errno', 'error_code', 'error_msg', 'request_id', 'path', 'uploadid']) {
        if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '')
          rawFields.push(`${k}=${String(obj[k]).slice(0, 120)}`);
      }
    }
    const reqSummary = [
      `step=${step}`,
      `relPath=${relPath}`,
      `remotePath=${remotePath}`,
      `size=${total}`,
      `rtype=${rtype}`,
      `block_list=${JSON.stringify(md5s.slice(0, 3))}${md5s.length > 3 ? `…+${md5s.length - 3}` : ''}`,
      uploadid ? `uploadid=${uploadid}` : '',
    ]
      .filter(Boolean)
      .join('; ');
    const msg = `[BDNSync] 上传失败诊断(${step})｜请求参数：${reqSummary}` +
      (rawFields.length ? `｜百度返回：${rawFields.join('; ')}` : '｜百度返回：无 raw') +
      `｜err=${e instanceof Error ? e.message : String(e)}`;
    console.warn(msg);
  }

  /** 删除远程文件（相对路径） */
  async deleteRemote(relPaths: string[]): Promise<void> {
    const full = relPaths.map((p) => remoteJoin(this.root, p));
    await this.api.deleteFiles(full);
    // 目录删除（若变空则不强制清理，保持简单）
  }

  /**
   * 云端重命名/移动（相对路径）：用 filemanager move 保留 fs_id，避免「删旧 + 上传新」的冗余。
   * 仅当本地发生 rename 且云端旧条目确实已存在时调用（否则应走普通上传）。
   */
  async renameRemote(oldRel: string, newRel: string): Promise<void> {
    await this.api.move(remoteJoin(this.root, oldRel), remoteJoin(this.root, newRel));
  }

  // ---------- 远程索引 ----------

  /**
   * 读取远程索引（A3 分片兼容）。
   *  - 先读 `.bdnsync/index.json` 清单；
   *  - 若 `files` 内联（旧形态或小规模），直接返回；
   *  - 若 `shards` 非空，逐分片下载并合并到 `files`（分片缺失/损坏的单分片不影响其余）。
   * 任何一层失败都降级到「返回 null 触发全量重建」，保证不阻塞同步。
   */
  async readRemoteIndex(): Promise<ResolvedRemoteIndex | null> {
    try {
      const manifestBytes = await this.downloadByPath(`${INDEX_DIR}/${INDEX_FILE}`);
      if (!manifestBytes) return null;
      const text = new TextDecoder('utf-8').decode(manifestBytes);
      const idx = JSON.parse(text) as RemoteIndex;
      if (!idx || typeof idx !== 'object') return null;
      if (!idx.shards || idx.shards.length === 0) {
        // 内联形态：files 必须存在
        if (!idx.files) return null;
        return idx as ResolvedRemoteIndex;
      }
      // 分片形态：聚合各分片
      const merged: Record<string, FileState> = {};
      for (const shardName of idx.shards) {
        try {
          const sb = await this.downloadByPath(`${INDEX_DIR}/${SHARDS_DIR}/${shardName}`);
          if (!sb) continue;
          const shard = JSON.parse(new TextDecoder('utf-8').decode(sb)) as {
            files?: Record<string, FileState>;
          };
          if (shard.files) Object.assign(merged, shard.files);
        } catch (e) {
          console.warn(`[BDNSync] 分片索引 ${shardName} 读取失败，跳过：`, e);
        }
      }
      return { ...idx, files: merged };
    } catch (e) {
      if (e instanceof BaiduApiError && (e.errno === -9 || e.errno === -7 || e.errno === 12))
        return null;
      // 索引损坏：返回 null 触发重建（全量对比兜底）
      console.warn('[BDNSync] 远程索引读取失败，将重建：', e);
      return null;
    }
  }

  /**
   * 写远程索引（A3 分片协议）。
   *  - 文件数 ≤ SHARD_MAX_FILES：内联写入 `index.json`（保持旧形态，单文件轻量）；
   *  - 文件数 > SHARD_MAX_FILES：按路径确定性分桶写入 `shards/shard-<n>.json`，
   *    再写仅含元信息 + 分片列表的 `index.json` 清单。
   * 写分片时逐个上传（upload 内部自带加密/秒传/续传），清单最后上传保证「先数据后指针」。
   */
  async writeRemoteIndex(idx: RemoteIndex): Promise<void> {
    idx.updatedAt = Date.now();
    const files = idx.files ?? {};
    const count = Object.keys(files).length;

    if (count <= SHARD_MAX_FILES) {
      // 内联形态：清空分片列表
      const inline: RemoteIndex = { ...idx, files, shards: [] };
      const text = JSON.stringify(inline);
      const bytes = new TextEncoder().encode(text);
      await this.upload(`${INDEX_DIR}/${INDEX_FILE}`, bytes, { overwrite: true });
      return;
    }

    // 分片形态：按路径 hash 分桶（确定性，保证同一文件始终落同一分片）
    const shardCount = Math.max(1, Math.ceil(count / SHARD_MAX_FILES));
    const buckets: Record<number, Record<string, FileState>> = {};
    for (let i = 0; i < shardCount; i++) buckets[i] = {};
    for (const [path, st] of Object.entries(files)) {
      const bucket = this.shardBucket(path, shardCount);
      buckets[bucket][path] = st;
    }

    const shardNames: string[] = [];
    for (let i = 0; i < shardCount; i++) {
      const name = `${SHARD_PREFIX}${i}.json`;
      const shardBytes = new TextEncoder().encode(JSON.stringify({ files: buckets[i] }));
      await this.upload(`${INDEX_DIR}/${SHARDS_DIR}/${name}`, shardBytes, { overwrite: true });
      shardNames.push(name);
    }

    // 写清单（不含 files 内容，仅元信息 + 分片列表）
    const manifest: RemoteIndex = {
      version: idx.version,
      vaultName: idx.vaultName,
      createdAt: idx.createdAt,
      updatedAt: idx.updatedAt,
      deviceId: idx.deviceId,
      syncVersion: idx.syncVersion,
      files: null,
      shards: shardNames,
    };
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
    await this.upload(`${INDEX_DIR}/${INDEX_FILE}`, manifestBytes, { overwrite: true });
  }

  /** 确定性分桶：同一路径始终映射到同一分片（FNV-1a 32 位 hash） */
  private shardBucket(path: string, shardCount: number): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < path.length; i++) {
      h ^= path.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    // 转无符号并取模
    return (h >>> 0) % shardCount;
  }

  /** 清理超过 30 天的墓碑 */
  static pruneTombstones(idx: {
    files: Record<string, { deleted?: boolean; deletedAt?: number }>;
  }): number {
    const now = Date.now();
    let removed = 0;
    for (const [path, st] of Object.entries(idx.files)) {
      if (st.deleted && st.deletedAt && now - st.deletedAt > TOMBSTONE_TTL) {
        delete idx.files[path];
        removed++;
      }
    }
    return removed;
  }

  /** 合并分片 MD5 计算辅助（流式） */
  static chunksMd5(chunks: Uint8Array[]): string[] {
    return chunks.map((c) => md5HexOf([c]));
  }
}
