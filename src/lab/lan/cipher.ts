/**
 * 局域网信道加密（#5.10）：基于配对口令的 AES-256-GCM
 *
 * 数据不出局域网已是隐私增益；再叠加信道加密（防御同网段嗅探 / 误连陌生设备）。
 * 密钥由「配对口令（passphrase）+ 固定 salt」经 PBKDF2 派生，两端口令一致即能互通。
 * 口令为空时退化为明文（仅用于本地联调，不推荐生产）。
 *
 * 依赖 Node crypto，全部懒加载，移动端不会执行（由上层 Platform.isDesktop 守卫）。
 */

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;
// 固定 salt：口令本身是共享秘密（配对码），固定 salt 不影响安全性（PBKDF2 仍拉伸）
const SALT = Buffer.from('bdnsync-lan-v1-salt', 'utf8');
const ITER = 100_000;

export class LanCipher {
  private key: Buffer | null = null;
  // 构造时一次性解析 crypto 模块并缓存，避免每次加解密重复 require；
  // 也为了在「口令已设但模块缺失」时抛出清晰错误，而非模糊的 undefined.xxx。
  // 懒加载的 Node 模块类型不完整，用 any 属预期写法。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private cryptoMod: any = null;

  constructor(passphrase: string) {
    if (passphrase && passphrase.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const crypto = (globalThis as any).require?.('crypto');
      if (!crypto || typeof crypto.pbkdf2Sync !== 'function') {
        throw new Error('无法加载 Node crypto 模块，局域网信道加密不可用（需桌面端运行时）');
      }
      this.cryptoMod = crypto;
      this.key = crypto.pbkdf2Sync(passphrase, SALT, ITER, 32, 'sha256');
    }
  }

  get enabled(): boolean {
    return this.key !== null;
  }

  /** 明文 → base64(iv|tag|ciphertext) */
  encrypt(plain: string): string {
    if (!this.key) return plain;
    if (!this.cryptoMod) throw new Error('LanCipher 未初始化 crypto 模块');
    const iv = this.cryptoMod.randomBytes(IV_LEN);
    const cipher = this.cryptoMod.createCipheriv(ALGO, this.key, iv);
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, ct]).toString('base64');
  }

  /** base64(iv|tag|ciphertext) → 明文 */
  decrypt(b64: string): string {
    if (!this.key) return b64;
    if (!this.cryptoMod) throw new Error('LanCipher 未初始化 crypto 模块');
    const buf = Buffer.from(b64, 'base64');
    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const ct = buf.subarray(IV_LEN + TAG_LEN);
    const decipher = this.cryptoMod.createDecipheriv(ALGO, this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  }
}
