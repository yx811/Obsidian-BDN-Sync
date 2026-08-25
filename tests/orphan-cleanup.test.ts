// orphan-cleanup 单元测试：覆盖识别规则 / 排序 / 限频 / 测量容错。
//
// 注：orphan-cleanup 是纯函数 + 抽象接口（RemoteLister/Deleter），方便在测试里注入 fake 实现。

import { describe, expect, it } from 'vitest';
import {
  pickOrphans,
  parseOrphanSegments,
  measureOrphans,
  deleteOrphans,
  shouldScanOrphans,
  isCandidateToAlert,
  type RemoteDirRow,
  type OrphanEntry,
} from '../src/util/orphan-cleanup';

const VAULT = 'Obsidian Vault';

function row(name: string, isDir: boolean, mtime = 0, size = 0): RemoteDirRow {
  return { path: `/apps/bdnsync/${name}`, name, isDir, mtime, size };
}

describe('parseOrphanSegments：识别 vaultName + 时间戳段', () => {
  it('1 段时间戳段识别为中风险', () => {
    const r = parseOrphanSegments('Obsidian Vault_20260824_231304', VAULT);
    expect(r.matched).toBe(true);
    expect(r.segments).toBe(1);
    expect(r.risk).toBe(1);
  });

  it('3 段时间戳段叠加识别为高风险', () => {
    const r = parseOrphanSegments(
      'Obsidian Vault_20260824_231304_20260824_231304_20260824_231304',
      VAULT,
    );
    expect(r.matched).toBe(true);
    expect(r.segments).toBe(3);
    expect(r.risk).toBe(2);
  });

  it('仅同名（无时间戳）—— risk 0（低，需调用方剔除主同步目录）', () => {
    const r = parseOrphanSegments('Obsidian Vault', VAULT);
    expect(r.matched).toBe(true);
    expect(r.segments).toBe(0);
    expect(r.risk).toBe(0);
  });

  it('不匹配 vaultName 前缀 —— 拒绝', () => {
    const r = parseOrphanSegments('AnotherVault_20260824_231304', VAULT);
    expect(r.matched).toBe(false);
    expect(r.segments).toBe(0);
  });

  it('多余下划线 / 中间有非数字段 —— 拒绝', () => {
    expect(parseOrphanSegments('Obsidian Vault_2026_0824_231304', VAULT).matched).toBe(false);
    expect(parseOrphanSegments('Obsidian Vault_20260824_231304_extra', VAULT).matched).toBe(false);
    expect(parseOrphanSegments('Obsidian Vault_2026082_231304', VAULT).matched).toBe(false); // 7 位日期
  });

  it('中文 / 空格 / 下划线 vault 名 OK', () => {
    const r = parseOrphanSegments('我的笔记_20260824_231304', '我的笔记');
    expect(r.matched).toBe(true);
    expect(r.segments).toBe(1);
  });

  it('空 vaultName —— 全部不匹配', () => {
    expect(parseOrphanSegments('random_20260824_231304', '').matched).toBe(false);
  });
});

describe('pickOrphans：过滤 + 排序 + 剔除主同步目录', () => {
  it('剔除主同步目录、把目录条目按风险/时间排序', () => {
    const entries: RemoteDirRow[] = [
      row('Obsidian Vault', true, 0), // 主同步目录 → 剔除
      row('Obsidian Vault_20240101_000000', true, 1_704_067_200_000), // 1 段
      row('Obsidian Vault_20250101_000000_20250101_000000', true, 1_735_689_600_000), // 2 段（高）
      row('Obsidian Vault_20250102_000000_20250102_000000_20250102_000000', true, 1_735_776_000_000), // 3 段（高，mtime 更新）
      row('OtherTool', true, 0), // 与 vault 名无关 → 不匹配
      row('doc.md', false, 0), // 文件 → 不参与
    ];
    const out = pickOrphans(entries, VAULT);
    expect(out.length).toBe(3);
    // 高风险优先；同风险按 mtime 升序（旧在前）
    expect(out.map((o) => o.segments)).toEqual([2, 3, 1]); // 2 段 mtime 较早；3 段 mtime 较晚但风险更高
    expect(out[0].risk).toBe(2);
    // 确认主同步目录被剔除
    expect(out.find((o) => o.name === 'Obsidian Vault')).toBeUndefined();
  });
});

describe('measureOrphans：mock lister 单层列出统计字节/数', () => {
  it('正常返回单层文件数 + 字节', async () => {
    const items: OrphanEntry[] = [
      {
        fullPath: '/apps/bdnsync/A_20240101_000000',
        name: 'A_20240101_000000',
        segments: 1,
        risk: 1,
        mtime: 0,
        fileCount: 0,
        totalBytes: 0,
      },
    ];
    const lister = {
      async listDir(p: string): Promise<RemoteDirRow[]> {
        expect(p).toBe('/apps/bdnsync/A_20240101_000000');
        return [
          row('a.md', false, 0, 100),
          row('b.png', false, 0, 200),
        ];
      },
    };
    const out = await measureOrphans(lister, items);
    expect(out[0].fileCount).toBe(2);
    expect(out[0].totalBytes).toBe(300);
  });

  it('lister 抛错时记 0 不抛', async () => {
    const items: OrphanEntry[] = [
      {
        fullPath: '/x',
        name: 'X_20240101_000000',
        segments: 1,
        risk: 1,
        mtime: 0,
        fileCount: 0,
        totalBytes: 0,
      },
    ];
    const lister = { async listDir() { throw new Error('boom'); } };
    const out = await measureOrphans(lister, items);
    expect(out[0].fileCount).toBe(0);
    expect(out[0].totalBytes).toBe(0);
    // #80 缺陷 2 回归：列出失败必须显式标记 measureError，UI 才能区分「真为空」vs「测失败」
    expect(out[0].measureError).toBe(true);
  });

  it('正常 lister 成功路径不置 measureError', async () => {
    const items: OrphanEntry[] = [
      {
        fullPath: '/apps/bdnsync/A_20240101_000000',
        name: 'A_20240101_000000',
        segments: 1,
        risk: 1,
        mtime: 0,
        fileCount: 0,
        totalBytes: 0,
      },
    ];
    const lister = {
      async listDir(): Promise<RemoteDirRow[]> {
        return [row('a.md', false, 0, 100)];
      },
    };
    const out = await measureOrphans(lister, items);
    expect(out[0].fileCount).toBe(1);
    expect(out[0].measureError).toBeFalsy();
  });
});

describe('deleteOrphans：批量 + 重试 + 失败分桶', () => {
  it('全部成功', async () => {
    const items: OrphanEntry[] = [
      mkOrphan('A'),
      mkOrphan('B'),
    ];
    const deleter = {
      async deleteFiles(paths: string[]): Promise<void> {
        expect(paths.length).toBe(1);
      },
    };
    const r = await deleteOrphans(deleter, items, { confirmedByUser: true });
    expect(r.ok.length).toBe(2);
    expect(r.failed.length).toBe(0);
  });

  it('单条持续失败 → 进入 failed 桶', async () => {
    const items = [mkOrphan('A'), mkOrphan('B-fail')];
    let callCount = 0;
    const deleter = {
      async deleteFiles(paths: string[]): Promise<void> {
        callCount++;
        if (paths[0].includes('B-fail')) throw new Error('perm denied');
      },
    };
    const r = await deleteOrphans(deleter, items, { confirmedByUser: true, retries: 1, delayMs: 0 });
    expect(r.ok.length).toBe(1);
    expect(r.failed.length).toBe(1);
    expect(r.failed[0].error).toContain('perm denied');
    expect(callCount).toBeGreaterThanOrEqual(2); // B 至少重试 1 次
  });

  it('BaiduApiError 风格异常 → error 字符串自动包含 errno 前缀，failed[].errno 也被记录', async () => {
    // 模拟「errno=-7 文件或目录名不合法」—— P0-orphan bug 的典型表现
    const items = [mkOrphan('BadPath')];
    const deleter = {
      async deleteFiles(): Promise<void> {
        const e = new Error('文件或目录名不合法') as Error & { errno: number };
        e.errno = -7;
        throw e;
      },
    };
    const r = await deleteOrphans(deleter, items, {
      confirmedByUser: true,
      retries: 0,
      delayMs: 0,
    });
    expect(r.failed.length).toBe(1);
    expect(r.failed[0].errno).toBe(-7);
    expect(r.failed[0].error).toMatch(/errno=-7/);
    expect(r.failed[0].error).toContain('文件或目录名不合法');
  });

  it('confirmedByUser=false → 硬门禁拒绝删除（审计 #9）', async () => {
    const items = [mkOrphan('A')];
    let called = false;
    const r = await deleteOrphans(
      {
        async deleteFiles() {
          called = true;
        },
      },
      items,
      { confirmedByUser: false }, // 未确认：整体拒绝，防止程序化误删
    );
    expect(called).toBe(false);
    expect(r.ok.length).toBe(0);
    expect(r.failed.length).toBe(1);
    expect(r.failed[0].error).toContain('拒绝删除');
  });

  it('confirmedByUser=true → 正常执行删除', async () => {
    const items = [mkOrphan('A')];
    let called = false;
    const r = await deleteOrphans(
      {
        async deleteFiles() {
          called = true;
        },
      },
      items,
      { confirmedByUser: true },
    );
    expect(called).toBe(true);
    expect(r.ok.length).toBe(1);
  });
});

/**
 * P0-orphan-path 回归测试：模拟「main.ts makeOrphanLister」在拿到 listRemoteDir
 * 返回的相对路径时，必须重新拼接成绝对路径再交给 deleter。
 * 若不拼接，deleter 收到的就是「Obsidian Vault_20260825_011813」这种 basename，
 * 百度 API 会在用户家目录找 → errno=-7。
 */
describe('orphan lister 路径拼回（绝对路径修复回归）', () => {
  it('lister 收到的相对 path 必须被拼回为绝对路径，deleter 收到完整路径', async () => {
    // 模拟 adapter.listRemoteDir('/apps/bdnsync') 的真实返回：path 是相对 basename
    const mockListRemoteDir = async (absDir: string) => {
      expect(absDir).toBe('/apps/bdnsync');
      return [
        {
          path: 'Obsidian Vault_20260825_011813', // 相对（adapter 行为）
          name: 'Obsidian Vault_20260825_011813',
          isDir: true,
          mtime: 1_700_000_000_000,
          size: 0,
          fsId: 'fs-1',
        } as RemoteDirRow,
      ];
    };

    // 复刻 makeOrphanLister 的修复后逻辑
    const fixedLister: { listDir: (p: string) => Promise<RemoteDirRow[]> } = {
      listDir: async (absPath: string) => {
        const rows = await mockListRemoteDir(absPath);
        return rows.map((r) => ({
          path: r.path ? `${absPath}/${r.path}`.replace(/\/+/g, '/') : `${absPath}/${r.name}`,
          name: r.name,
          isDir: r.isDir,
          mtime: r.mtime,
          size: r.size,
        }));
      },
    };

    // 走完整流水线：scan → pickOrphans → 模拟 deleter（断言收到的是绝对路径）
    const rows = await fixedLister.listDir('/apps/bdnsync');
    const entries: RemoteDirRow[] = rows.map((r) => ({
      path: r.path,
      name: r.name,
      isDir: r.isDir,
      mtime: r.mtime,
      size: r.size,
    }));
    const items = pickOrphans(entries, 'Obsidian Vault');
    expect(items.length).toBe(1);
    expect(items[0].fullPath).toBe('/apps/bdnsync/Obsidian Vault_20260825_011813');

    // 关键：deleter 收到的 path 必须是绝对路径（修复前会是 'Obsidian Vault_20260825_011813'）
    const receivedPaths: string[] = [];
    await deleteOrphans(
      {
        async deleteFiles(paths: string[]) {
          receivedPaths.push(...paths);
        },
      },
      items,
      { confirmedByUser: true },
    );
    expect(receivedPaths).toEqual(['/apps/bdnsync/Obsidian Vault_20260825_011813']);
  });

  it('lister 修复前（返回相对路径）→ deleter 收到 basename，模拟 errno=-7', async () => {
    // 对照组：模拟修复前的 buggy lister——直接把 listRemoteDir 的相对 path 传出去
    const buggyLister: { listDir: () => Promise<RemoteDirRow[]> } = {
      listDir: async () => [
        {
          path: 'Obsidian Vault_20260825_011813', // bug：相对 basename
          name: 'Obsidian Vault_20260825_011813',
          isDir: true,
          mtime: 0,
          size: 0,
        } as RemoteDirRow,
      ],
    };

    const rows = await buggyLister.listDir();
    const entries: RemoteDirRow[] = rows.map((r) => ({
      path: r.path,
      name: r.name,
      isDir: r.isDir,
      mtime: r.mtime,
      size: r.size,
    }));
    const items = pickOrphans(entries, 'Obsidian Vault');
    // 即使 lister 错，pickOrphans 仍然把 e.path 当作 fullPath 转发
    expect(items[0].fullPath).toBe('Obsidian Vault_20260825_011813'); // ❌ 相对路径

    // 模拟百度 API errno=-7：用户家目录找不到 basename
    const deleter = {
      async deleteFiles(): Promise<void> {
        const e = new Error('文件或目录名不合法') as Error & { errno: number };
        e.errno = -7;
        throw e;
      },
    };
    const r = await deleteOrphans(deleter, items, { confirmedByUser: true, retries: 0, delayMs: 0 });
    expect(r.failed.length).toBe(1);
    expect(r.failed[0].errno).toBe(-7); // 与用户截图完全一致
  });
});

describe('shouldScanOrphans：24h 限频', () => {
  it('lastScanAt=0 → 应扫描', () => {
    expect(shouldScanOrphans(0, 1_000_000)).toBe(true);
  });

  it('距上次扫描 < 24h → 跳过', () => {
    expect(shouldScanOrphans(1_000_000, 1_000_000 + 23 * 3600 * 1000)).toBe(false);
  });

  it('距上次扫描 = 24h → 触发', () => {
    expect(shouldScanOrphans(1_000_000, 1_000_000 + 24 * 3600 * 1000)).toBe(true);
  });
});

describe('isCandidateToAlert：高风险/大体积过滤', () => {
  const base = (overrides: Partial<OrphanEntry> = {}): OrphanEntry => ({
    fullPath: '/x',
    name: 'X',
    segments: 2,
    risk: 2,
    mtime: 0,
    fileCount: 0,
    totalBytes: 0,
    ...overrides,
  });

  it('风险低于 minRisk 不过', () => {
    expect(isCandidateToAlert(base({ risk: 1 }), { minRisk: 2 })).toBe(false);
    expect(isCandidateToAlert(base({ risk: 2 }), { minRisk: 2 })).toBe(true);
  });

  it('加上 minBytes：低于门槛不过', () => {
    expect(isCandidateToAlert(base({ totalBytes: 100 }), { minRisk: 1, minBytes: 1024 })).toBe(false);
    expect(isCandidateToAlert(base({ totalBytes: 2048 }), { minRisk: 1, minBytes: 1024 })).toBe(true);
  });
});

function mkOrphan(name: string): OrphanEntry {
  return {
    fullPath: `/apps/bdnsync/${name}`,
    name,
    segments: 1,
    risk: 1,
    mtime: 0,
    fileCount: 0,
    totalBytes: 0,
  };
}
