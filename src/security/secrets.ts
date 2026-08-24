// 凭据信封加密（P0 修复）
//
// 问题：原实现将 bduss / stoken / accessToken / refreshToken / secretKey / encryptionPassword
// 以明文写入 data.json。该文件会被 Obsidian 设置同步、第三方备份、手动拷贝带走，存在凭据泄露风险。
//
// 方案：把这些字段在落盘前用 AES-256-GCM 加密，密文以 `enc::` 前缀写回 data.json；解密密钥
// （32 字节）存放在 localStorage（不随 vault 同步，不进入 data.json）。这样即便 data.json 被同步/
// 备份到他处，敏感字段也不可读。Web Crypto 在 Obsidian（Electron / 移动端）安全上下文中均可使用。
//
// 若运行环境连 localStorage 都没有（极少见），则回退为明文并告警，绝不静默。

import type { BDNSyncSettings } from '../types';

const ENC_PREFIX = 'enc::';
const MASTER_KEY_LS = 'bdnsync_master_key_v1';
const SECRET_KEYS: Array<keyof BDNSyncSettings> = [
  'bduss',
  'stoken',
  'accessToken',
  'refreshToken',
  'secretKey',
  'encryptionPassword',
];

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function hasWebCrypto(): boolean {
  return (
    typeof crypto !== 'undefined' && !!crypto.subtle && typeof crypto.getRandomValues === 'function'
  );
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + chunk)) as unknown as number[],
    );
  }
  return btoa(bin);
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 加载主密钥：优先从 localStorage 读取；不存在则生成并持久化。 */
function loadMasterKey(): Uint8Array {
  if (!hasWebCrypto()) {
    // 没有 Web Crypto（理论上不会发生于 Electron / 现代浏览器），无法加密，明文回退。
    console.warn('[BDNSync] 环境缺少 Web Crypto，凭据将以明文保存，请检查运行环境');
    return new Uint8Array(32); // 无效密钥，仅占位，实际走明文分支
  }
  const existing = localStorage.getItem(MASTER_KEY_LS);
  if (existing) return b64ToBytes(existing);
  const key = crypto.getRandomValues(new Uint8Array(32));
  try {
    localStorage.setItem(MASTER_KEY_LS, bytesToB64(key));
  } catch {
    console.warn('[BDNSync] 无法持久化主密钥，凭据将以明文保存');
  }
  return key;
}

async function aesGcmEncrypt(plain: string, key: Uint8Array): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ck = await crypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['encrypt']);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, ck, encoder.encode(plain));
  const out = new Uint8Array(iv.length + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), iv.length);
  return ENC_PREFIX + bytesToB64(out);
}

async function aesGcmDecrypt(blob: string, key: Uint8Array): Promise<string> {
  const raw = b64ToBytes(blob.slice(ENC_PREFIX.length));
  const iv = raw.subarray(0, 12);
  const ct = raw.subarray(12);
  const ck = await crypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['decrypt']);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, ck, ct);
  return decoder.decode(pt);
}

/**
 * 把内存中的明文凭据就地加密，准备落盘。
 * 已加密（以 enc:: 开头）或空串跳过，避免重复加密。
 */
export async function sealSecretsInPlace(s: BDNSyncSettings): Promise<void> {
  if (!hasWebCrypto()) return; // 明文回退（已在 loadMasterKey 告警）
  const key = loadMasterKey();
  const rec = s as unknown as Record<string, unknown>;
  for (const k of SECRET_KEYS) {
    const v = rec[k];
    if (typeof v === 'string' && v.length > 0 && !v.startsWith(ENC_PREFIX)) {
      rec[k] = await aesGcmEncrypt(v, key);
    }
  }
}

/**
 * 从磁盘读取后就地解密凭据。解密失败（如换设备 / 清除 localStorage）时保留原值，
 * 由上层（连接校验）提示用户重新登录，而不是崩溃。
 */
export async function unsealSecretsInPlace(s: BDNSyncSettings): Promise<void> {
  if (!hasWebCrypto()) return;
  const key = loadMasterKey();
  const rec = s as unknown as Record<string, unknown>;
  for (const k of SECRET_KEYS) {
    const v = rec[k];
    if (typeof v === 'string' && v.startsWith(ENC_PREFIX)) {
      try {
        rec[k] = await aesGcmDecrypt(v, key);
      } catch {
        // 密钥不匹配（换机 / 清缓存），保持原密文，连接校验会失败并提示重新授权
        rec[k] = '';
      }
    }
  }
}

/** 判断某个字段当前是否已是加密形态（供 UI 展示掩码时参考） */
export function isEncryptedSecret(value: string | undefined): boolean {
  return typeof value === 'string' && value.startsWith(ENC_PREFIX);
}
