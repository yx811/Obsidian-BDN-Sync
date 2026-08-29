import { describe, it, expect } from 'vitest';
import { resolveSyncTriggers } from '../src/sync/trigger-policy';
import type { SyncMode } from '../src/types';

type Flags = { syncOnSave: boolean; syncOnStartup: boolean; hasAuth: boolean };

const base: Flags = { syncOnSave: true, syncOnStartup: true, hasAuth: true };

function policy(mode: SyncMode, flags: Partial<Flags> = {}) {
  return resolveSyncTriggers({ syncMode: mode, ...base, ...flags });
}

describe('同步触发边界条件矩阵', () => {
  it('manual 模式：仅当 syncOnStartup 开启时在启动触发，其余全部否', () => {
    const on = policy('manual', { syncOnStartup: true });
    expect(on.startup).toBe(true);
    expect(on.periodic).toBe(false);
    expect(on.saveImmediate).toBe(false);
    expect(on.online).toBe(false);

    const off = policy('manual', { syncOnStartup: false });
    expect(off.startup).toBe(false);
    expect(off.periodic).toBe(false);
    expect(off.saveImmediate).toBe(false);
    expect(off.online).toBe(false);
  });

  it('manual 模式：未授权时即便 syncOnStartup 也不启动同步', () => {
    const noAuth = policy('manual', { syncOnStartup: true, hasAuth: false });
    expect(noAuth.startup).toBe(false);
  });

  it('auto 模式：周期 + 启动 + 网络恢复触发，但保存不立即同步', () => {
    const p = policy('auto');
    expect(p.startup).toBe(true);
    expect(p.periodic).toBe(true);
    expect(p.saveImmediate).toBe(false); // 关键边界：auto 不做「保存即同步」
    expect(p.online).toBe(true);
  });

  it('realtime 模式：全量触发（含保存即同步）', () => {
    const p = policy('realtime');
    expect(p.startup).toBe(true);
    expect(p.periodic).toBe(true);
    expect(p.saveImmediate).toBe(true);
    expect(p.online).toBe(true);
  });

  it('realtime 模式：syncOnSave 关闭后退化为纯周期行为（与 auto 同）', () => {
    const p = policy('realtime', { syncOnSave: false });
    expect(p.saveImmediate).toBe(false);
    expect(p.periodic).toBe(true);
    expect(p.startup).toBe(true);
    expect(p.online).toBe(true);
  });

  it('auto/realtime 未授权时启动同步被抑制', () => {
    expect(policy('auto', { hasAuth: false }).startup).toBe(false);
    expect(policy('realtime', { hasAuth: false }).startup).toBe(false);
  });

  it('边界矩阵与文档一致（纯函数幂等）', () => {
    const a = resolveSyncTriggers({ syncMode: 'auto', ...base });
    const b = resolveSyncTriggers({ syncMode: 'auto', ...base });
    expect(a).toEqual(b);
  });
});
