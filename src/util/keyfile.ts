/**
 * 密钥文件模式（#3.5 加密密钥管理）
 *
 * 支持把加密密码存于 vault 内的约定文件（默认 `.bdnsync-key`），避免每次输入密码，
 * 也便于脚本/CI 场景。该文件已加入 `ALWAYS_EXCLUDE`（`misc.ts`），**绝不会被同步上云**，
 * 但仍建议将其加入 `.gitignore` / 不提交进版本库，以免本地泄露。
 */

import type { App } from 'obsidian';
import type { BDNSyncSettings } from '../types';
import { KEY_FILE_NAME } from './misc';

/** 默认密钥文件名 */
export const DEFAULT_KEY_FILE = KEY_FILE_NAME;

/**
 * 解析实际用于解密的密码：
 *  - 若 settings.keyFilePath 非空 → 读取该 vault 内文件内容（去除首尾空白）作为密码；
 *  - 否则回退 settings.encryptionPassword。
 * @throws 当指定了密钥文件但读取失败时抛出可读错误。
 */
export async function resolveEncryptionPassword(
  app: App,
  settings: BDNSyncSettings,
): Promise<string> {
  const kf = settings.keyFilePath?.trim();
  if (kf) {
    const p = kf.replace(/\\/g, '/');
    try {
      const buf = await app.vault.adapter.read(p);
      const pw = buf.trim();
      if (!pw) throw new Error('密钥文件为空');
      return pw;
    } catch (e) {
      throw new Error(
        `密钥文件读取失败：${p}（${(e as Error).message}）。请确认文件存在且内容为密码，或清空「密钥文件路径」回退手动密码。`,
      );
    }
  }
  return settings.encryptionPassword;
}

/** 路径是否为密钥文件（用于 UI 提示 / 防误同步二次校验） */
export function isKeyFilePath(path: string): boolean {
  const p = path.replace(/\\/g, '/');
  return p === KEY_FILE_NAME || p.endsWith('/' + KEY_FILE_NAME);
}

/**
 * 生成一份密钥文件模板内容（供「生成密钥文件」按钮写入 vault）。
 * 含警示注释，提醒用户不要提交进版本库。
 */
export function keyFileTemplate(password: string): string {
  return [
    '# BDNSync 加密密钥文件（#3.5）',
    '# 本文件内容即加密密码。已自动排除于同步之外，但请勿提交进 Git 等版本库。',
    '# 一旦丢失，已加密数据无法恢复。',
    password,
    '',
  ].join('\n');
}
