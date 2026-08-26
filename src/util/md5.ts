// MD5 实现：桌面端优先使用 Node crypto，否则回退纯 JS 实现（RFC 1321）

// 仅在运行时通过 CJS require 获取 Node crypto（避免模块顶层硬依赖 obsidian/node）。
// 以下具体接口用于收紧此前 `as any` 的类型逃逸，并规避可选方法导致的类型塌缩为 unknown。
interface NodeHash {
  update(chunk: Buffer): NodeHash;
  digest(encoding: string): string;
}
interface NodeCryptoModule {
  createHash(algorithm: string): NodeHash;
}
type CjsRequire = (id: string) => NodeCryptoModule | undefined;

/** 在运行时按环境取 CJS require（桌面端 globalThis/window 上的 Obsidian 注入），无则 undefined。 */
function getCjsRequire(): CjsRequire | undefined {
  const g = globalThis as { require?: CjsRequire };
  if (typeof g.require === 'function') return g.require;
  if (typeof window !== 'undefined') {
    const w = window as unknown as { require?: CjsRequire };
    if (typeof w.require === 'function') return w.require;
  }
  return undefined;
}

function md5ViaNodeCrypto(data: Uint8Array): string | null {
  try {
    const req = getCjsRequire();
    if (typeof req !== 'function') return null;
    const nodeCrypto: NodeCryptoModule | undefined = req('crypto');
    if (!nodeCrypto || typeof nodeCrypto.createHash !== 'function') return null;
    const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    return nodeCrypto.createHash('md5').update(buf).digest('hex');
  } catch (_e) {
    // ignore → 纯 JS 回退
  }
  return null;
}

const S = new Uint8Array([
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14,
  20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6,
  10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
]);

const K = new Int32Array(64);
for (let i = 0; i < 64; i++) {
  K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
}

const HEX = '0123456789abcdef';

function md5Pure(data: Uint8Array): string {
  const len = data.length;
  const bitLenHi = Math.floor(len / 0x20000000) | 0;
  const bitLenLo = (len << 3) >>> 0;
  const paddedLen = ((((len + 8) >>> 6) + 1) << 6) >>> 0;
  const msg = new Uint8Array(paddedLen);
  msg.set(data);
  msg[len] = 0x80;
  const dv = new DataView(msg.buffer);
  dv.setUint32(paddedLen - 8, bitLenLo, true);
  dv.setUint32(paddedLen - 4, bitLenHi, true);

  let a0 = 0x67452301 | 0,
    b0 = 0xefcdab89 | 0,
    c0 = 0x98badcfe | 0,
    d0 = 0x10325476 | 0;
  const M = new Int32Array(16);

  for (let off = 0; off < paddedLen; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = dv.getInt32(off + i * 4, true);
    let A = a0,
      B = b0,
      C = c0,
      D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number, g: number;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      F = (F + A + K[i] + M[g]) | 0;
      A = D;
      D = C;
      C = B;
      const s = S[i];
      B = (B + ((F << s) | (F >>> (32 - s)))) | 0;
    }
    a0 = (a0 + A) | 0;
    b0 = (b0 + B) | 0;
    c0 = (c0 + C) | 0;
    d0 = (d0 + D) | 0;
  }

  const out = new Uint8Array(16);
  const odv = new DataView(out.buffer);
  odv.setInt32(0, a0, true);
  odv.setInt32(4, b0, true);
  odv.setInt32(8, c0, true);
  odv.setInt32(12, d0, true);
  let hex = '';
  for (let i = 0; i < 16; i++) hex += HEX[out[i] >> 4] + HEX[out[i] & 0xf];
  return hex;
}

export function md5Hex(data: Uint8Array): string {
  return md5ViaNodeCrypto(data) ?? md5Pure(data);
}

export function md5HexOf(chunks: Uint8Array[]): string {
  const fast = md5ViaNodeCryptoOfChunks(chunks);
  if (fast) return fast;
  let total = 0;
  for (const c of chunks) total += c.length;
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.length;
  }
  return md5Pure(merged);
}

function md5ViaNodeCryptoOfChunks(chunks: Uint8Array[]): string | null {
  try {
    const req = getCjsRequire();
    if (typeof req !== 'function') return null;
    const nodeCrypto: NodeCryptoModule | undefined = req('crypto');
    if (!nodeCrypto || typeof nodeCrypto.createHash !== 'function') return null;
    const h = nodeCrypto.createHash('md5');
    for (const c of chunks) h.update(Buffer.from(c.buffer, c.byteOffset, c.byteLength));
    return h.digest('hex');
  } catch (_e) {
    /* ignore */
  }
  return null;
}

/**
 * 异步 MD5：利用浏览器原生 Web Crypto（`crypto.subtle.digest`）在底层线程计算，
 * 避免大文件在主线程用纯 JS 计算时阻塞 Obsidian UI。
 * - 桌面端（有 Node crypto）仍优先用同步 `md5Hex`（C++ 实现极快，无需异步开销）。
 * - 仅在 subtle 可用且调用方传入大缓冲区时，异步路径才有意义；否则回退同步。
 *
 * 注意：本函数返回 Promise，供 `scanLocal` 在 await 上下文中批量计算大文件哈希。
 */
export async function md5HexAsync(data: Uint8Array): Promise<string> {
  // 优先同步快路径（桌面端 Node crypto / 小数据）
  const fast = md5ViaNodeCrypto(data);
  if (fast) return fast;
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle as
    | SubtleCrypto
    | undefined;
  if (subtle?.digest) {
    try {
      const buf = await subtle.digest('MD5', data);
      const bytes = new Uint8Array(buf);
      let hex = '';
      for (let i = 0; i < bytes.length; i++) hex += HEX[bytes[i] >> 4] + HEX[bytes[i] & 0xf];
      return hex;
    } catch (_e) {
      /* MD5 可能在部分环境被禁用 → 回退纯 JS */
    }
  }
  return md5Pure(data);
}

/** 大文件阈值：超过则用异步路径（避免主线程长时间占用） */
export const MD5_ASYNC_THRESHOLD = 512 * 1024;
