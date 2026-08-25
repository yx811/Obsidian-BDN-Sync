// AES-256-GCM 端到端加密（Web Crypto）
// 文件格式：magic(8B "BDNSYNC1") | salt(16B) | iv(12B) | ciphertext(+16B GCM tag)
// 密钥：PBKDF2-SHA256，100,000 轮，每次加密随机 salt（抗彩虹表）

const MAGIC = new Uint8Array([0x42, 0x44, 0x4e, 0x53, 0x59, 0x4e, 0x43, 0x31]); // "BDNSYNC1"
const SALT_LEN = 16;
const IV_LEN = 12;
const PBKDF2_ITERS = 100000;

export class EncryptionError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'EncryptionError';
  }
}

/**
 * 加密密码强度评估（与 rclone crypt / 主流 E2EE 一致：强度取决于长度与字符集多样性）。
 * 返回 0-4 强度等级与可读提示，供设置页实时反馈。
 */
export function passwordStrength(pwd: string): {
  score: 0 | 1 | 2 | 3 | 4;
  label: string;
  hint: string;
} {
  if (!pwd) return { score: 0, label: '未设置', hint: '开启加密后必须设置密码' };
  let variety = 0;
  if (/[a-z]/.test(pwd)) variety++;
  if (/[A-Z]/.test(pwd)) variety++;
  if (/[0-9]/.test(pwd)) variety++;
  if (/[^a-zA-Z0-9]/.test(pwd)) variety++;
  const len = pwd.length;
  if (len < 8) return { score: 1, label: '弱', hint: '密码过短（至少 8 位）' };
  if (len < 12 || variety < 3)
    return { score: 2, label: '中', hint: '建议 12 位以上且混合大小写/数字/符号' };
  if (len < 16 || variety < 4) return { score: 3, label: '强', hint: '还不错，越长越安全' };
  return { score: 4, label: '极强', hint: '高强度密码，难以暴力破解' };
}

/** salt / 密钥缓存上限，避免长期运行后无界增长 */
const KEY_CACHE_MAX = 32;

export function saltToB64(salt: Uint8Array): string {
  let s = '';
  for (let i = 0; i < salt.length; i++) s += String.fromCharCode(salt[i]);
  return btoa(s);
}

export function b64ToSalt(b64: string): Uint8Array | null {
  try {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out.length === SALT_LEN ? out : null;
  } catch {
    return null;
  }
}

export class Encryptor {
  private keyCache = new Map<string, CryptoKey>();
  /**
   * 加密用的固定 salt（每个库一份，持久化到设置）。
   *
   * 为什么不用「每文件随机 salt」：keyCache 是按 salt 缓存的，每文件随机 salt
   * 会让缓存永远命中不了，于是每个文件的加密/解密都要跑一遍 PBKDF2-SHA256 10 万轮。
   * 一个 1000 文件的库就是 1000 次 10 万轮派生，同步会直接卡死。
   *
   * 固定 salt + 每文件随机 IV 在 AES-GCM 下依然满足语义安全（IV 才是防重放的关键），
   * 而 PBKDF2 只需派生一次。解密时仍从文件头读取 salt，因此旧的
   * 「每文件随机 salt」密文完全可以正常解开，向后兼容。
   */
  private encSalt: Uint8Array | null = null;

  constructor(
    private password: string,
    saltB64?: string,
    private onSaltCreated?: (b64: string) => void,
  ) {
    if (saltB64) this.encSalt = b64ToSalt(saltB64);
  }

  isEnabled(): boolean {
    return !!this.password;
  }

  /** 取（必要时生成并回调持久化）本库的加密 salt */
  private currentSalt(): Uint8Array {
    if (this.encSalt && this.encSalt.length === SALT_LEN) return this.encSalt;
    const s = crypto.getRandomValues(new Uint8Array(SALT_LEN));
    this.encSalt = s;
    this.onSaltCreated?.(saltToB64(s));
    return s;
  }

  private async deriveKey(salt: Uint8Array): Promise<CryptoKey> {
    const saltKey = Array.from(salt).join(',');
    const cached = this.keyCache.get(saltKey);
    if (cached) return cached;
    if (!this.password) throw new EncryptionError('未设置加密密码');
    const subtle = crypto.subtle;
    if (!subtle) throw new EncryptionError('当前环境不支持 Web Crypto');
    const enc = new TextEncoder();
    const baseKey = await subtle.importKey('raw', enc.encode(this.password), 'PBKDF2', false, [
      'deriveKey',
    ]);
    const key = await subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: salt as unknown as BufferSource,
        iterations: PBKDF2_ITERS,
        hash: 'SHA-256',
      },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
    if (this.keyCache.size >= KEY_CACHE_MAX) {
      const oldest = this.keyCache.keys().next().value;
      if (oldest !== undefined) this.keyCache.delete(oldest);
    }
    this.keyCache.set(saltKey, key);
    return key;
  }

  async encrypt(plain: Uint8Array): Promise<Uint8Array> {
    const salt = this.currentSalt();
    const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
    const key = await this.deriveKey(salt);
    const ct = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: iv as unknown as BufferSource },
        key,
        plain as unknown as BufferSource,
      ),
    );
    const out = new Uint8Array(MAGIC.length + SALT_LEN + IV_LEN + ct.length);
    out.set(MAGIC, 0);
    out.set(salt, MAGIC.length);
    out.set(iv, MAGIC.length + SALT_LEN);
    out.set(ct, MAGIC.length + SALT_LEN + IV_LEN);
    return out;
  }

  async decrypt(data: Uint8Array): Promise<Uint8Array> {
    if (data.length < MAGIC.length + SALT_LEN + IV_LEN + 16) {
      throw new EncryptionError('密文长度不合法（文件可能未加密或已损坏）');
    }
    for (let i = 0; i < MAGIC.length; i++) {
      if (data[i] !== MAGIC[i]) {
        throw new EncryptionError('文件头不是 BDNSync 加密格式（请检查两端加密设置是否一致）');
      }
    }
    const salt = data.slice(MAGIC.length, MAGIC.length + SALT_LEN);
    const iv = data.slice(MAGIC.length + SALT_LEN, MAGIC.length + SALT_LEN + IV_LEN);
    const ct = data.slice(MAGIC.length + SALT_LEN + IV_LEN);
    const key = await this.deriveKey(salt);
    try {
      const pt = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv as unknown as BufferSource },
        key,
        ct as unknown as BufferSource,
      );
      return new Uint8Array(pt);
    } catch (_e) {
      throw new EncryptionError('解密失败：密码错误或数据损坏');
    }
  }
}

export function looksEncrypted(data: Uint8Array): boolean {
  if (data.length < MAGIC.length) return false;
  for (let i = 0; i < MAGIC.length; i++) if (data[i] !== MAGIC[i]) return false;
  return true;
}
