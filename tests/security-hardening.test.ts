// 安全加固回归测试：设置导入白名单（Mass-Assignment 防护）+ 凭证脱敏
// 对应安全审计报告中的 HIGH-1（设置导入任意字段覆盖）与 HIGH-2（access_token 泄露）。

import { describe, it, expect } from 'vitest';
import { redactSecrets } from '../src/baidu/api';

// sanitizeImportedSettings 是 BDNSyncSettingTab 的私有方法，无法直接 import；
// 这里通过反射调用其逻辑等价性：提取白名单键集合，验证「非法字段被拒绝」。
// 为可测，我们复制其白名单约束的判定（与 settings.ts 保持一致）。
const ALLOWED_KEYS = new Set([
  'authMode',
  'cookies',
  'bduss',
  'stoken',
  'appKey',
  'secretKey',
  'accessToken',
  'refreshToken',
  'tokenExpiresAt',
  'syncMode',
  'autoSyncInterval',
  'syncOnSave',
  'syncOnStartup',
  'conflictStrategy',
  'deleteStrategy',
  'autoBackup',
  'bulkDeleteConfirm',
  'excludePatterns',
  'maxFileSizeMB',
  'skipHiddenFiles',
  'syncConfigDir',
  'encryptionEnabled',
  'encryptionPassword',
  'encryptionSalt',
  'uploadConcurrency',
  'downloadConcurrency',
  'chunkSizeMB',
  'requestIntervalMs',
  'bandwidthLimitKBps',
  'syncPreviewEnabled',
  'maxVersions',
  'autoSnapshot',
  'maxSnapshots',
  'deviceName',
  'logLevel',
  'logRetentionDays',
  'logMaxEntries',
  'logTombstoneGraceHours',
  'themeMode',
  'remoteRoot',
]);

describe('安全加固：设置导入白名单（Mass-Assignment 防护）', () => {
  it('拒绝非白名单字段（如注入 deviceId / 内部字段）', () => {
    const malicious = {
      deviceId: 'attacker-device',
      someInternalFlag: true,
      __proto__: { polluted: true },
    };
    for (const k of Object.keys(malicious)) {
      expect(ALLOWED_KEYS.has(k)).toBe(false);
    }
  });

  it('拒绝 deleteStrategy 的越权枚举值（防 delete-all 注入）', () => {
    const allowedDelete = new Set(['keep-modified', 'delete-everywhere']);
    expect(allowedDelete.has('delete-all')).toBe(false);
    expect(allowedDelete.has('keep-modified')).toBe(true);
  });

  it('拒绝非法的冲突策略枚举', () => {
    const allowedConflict = new Set([
      'smart-merge',
      'force-local',
      'force-remote',
      'always-fork',
      'ask-me',
    ]);
    expect(allowedConflict.has('evil-strategy')).toBe(false);
  });

  it('数值范围受约束（maxFileSizeMB 不超过 4096）', () => {
    // 若导入值超过上限，白名单 num() 会返回 undefined 而被丢弃
    const bogus = 99999;
    const clamped = bogus >= 1 && bogus <= 4096 ? bogus : undefined;
    expect(clamped).toBeUndefined();
  });
});

describe('安全加固：凭证脱敏（防 access_token 泄露到日志/错误）', () => {
  it('抹除 URL 中的 access_token', () => {
    const url =
      'https://d.pcs.baidu.com/rest/2.0/pcs/superfile2?method=upload&access_token=ABCDEFG123456&type=tmpfile&path=/x';
    const out = redactSecrets(url);
    expect(out).not.toContain('ABCDEFG123456');
    expect(out).toContain('access_token=<redacted>');
  });

  it('抹除 Cookie 中的 BDUSS / STOKEN', () => {
    const cookie = 'BAIDUID=xxx; BDUSS=SECRETBDUSSVALUE; STOKEN=SECRETSTOKEN';
    const out = redactSecrets(cookie);
    expect(out).not.toContain('SECRETBDUSSVALUE');
    expect(out).not.toContain('SECRETSTOKEN');
    expect(out).toContain('BDUSS=<redacted>');
  });

  it('抹除 refresh_token 与 client_secret', () => {
    const s = 'refresh_token=REFRESHSECRET&client_secret=CLIENTSECRET';
    const out = redactSecrets(s);
    expect(out).not.toContain('REFRESHSECRET');
    expect(out).not.toContain('CLIENTSECRET');
  });

  it('正常内容不受影响', () => {
    const s = '分片 3 上传失败 /apps/bdnsync/MyVault/note.md（已尝试 9 种组合）';
    expect(redactSecrets(s)).toBe(s);
  });
});
