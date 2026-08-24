import type { BDNSyncSettings } from '../src/types';

/** 测试用最小设置（仅包含 PathFilter / planEntry 依赖到的字段） */
export function makeSettings(overrides: Partial<BDNSyncSettings> = {}): BDNSyncSettings {
  return {
    deviceId: 'test-device',
    remoteBase: '/apps/bdnsync-test',
    syncConfigDir: false,
    skipHiddenFiles: true,
    excludePatterns: [],
    maxFileSizeMB: 50,
    deleteStrategy: 'keep-local',
    autoBackup: true,
    ...overrides,
  } as BDNSyncSettings;
}
