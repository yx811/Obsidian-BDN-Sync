// orphan-scan 单元测试：覆盖深度遍历 / 三类分类 / 同步索引交叉校验 / 预算保护 / 忽略 glob。
//
// 注：orphan-scan 是纯函数 + 抽象接口（RemoteLister），便于注入 fake 测试。

import { describe, expect, it } from 'vitest';
import {
  walkRemoteTree,
  classifyOrphans,
  type ScannedNode,
} from '../src/util/orphan-scan';
import type { RemoteDirRow, RemoteLister } from '../src/util/orphan-cleanup';

const VAULT = 'Obsidian Vault';
const PARENT = '/apps/bdnsync';
const REMOTE_ROOT = `${PARENT}/${VAULT}`;

// ---------------- fake lister ----------------
//
// map：`{ "<abs path>": RemoteDirRow[] }`。未列到 = 视为空目录（避免无限递归）。

function makeLister(map: Record<string, RemoteDirRow[]>): RemoteLister {
  return {
    async listDir(p: string): Promise<RemoteDirRow[]> {
      if (!(p in map)) throw new Error(`not found: ${p}`);
      return map[p];
    },
  };
}

const f = (name: string, isDir: boolean, size = 0, mtime = 0): RemoteDirRow => ({
  path: name, // adapter 会拼绝对；测试里直接用 name 也行
  name,
  isDir,
  size,
  mtime,
});

// ---------------- walkRemoteTree ----------------

describe('walkRemoteTree：parent-only 模式', () => {
  it('parent-only 仅列父目录直接子项；不进入 vault 根', async () => {
    const map: Record<string, RemoteDirRow[]> = {
      [PARENT]: [f('Obsidian Vault', true), f('Obsidian Vault_20240101_000000', true)],
      [REMOTE_ROOT]: [f('Notes', true), f('orphan.canvas', false, 100)],
      [`${REMOTE_ROOT}/Notes`]: [f('a.md', false, 50)],
    };
    const r = await walkRemoteTree(makeLister(map), {
      parentDir: PARENT,
      remoteRoot: REMOTE_ROOT,
      vaultName: VAULT,
      mode: 'parent-only',
      maxDepth: 0,
      maxNodes: 100,
      maxBytes: 0,
      concurrency: 1,
    });
    // parent-only 只产父目录的 2 项；不应进入 vault 根
    expect(r.nodes.map((n) => n.name)).toEqual(['Obsidian Vault', 'Obsidian Vault_20240101_000000']);
    expect(r.scannedNodes).toBe(2);
  });
});

describe('walkRemoteTree：full-vault 模式 + 深度限制', () => {
  it('full-vault 进入 vault 根，按 maxDepth 控制深度', async () => {
    const map: Record<string, RemoteDirRow[]> = {
      [PARENT]: [],
      [REMOTE_ROOT]: [f('Notes', true), f('orphan.canvas', false, 100), f('a.md', false, 50)],
      [`${REMOTE_ROOT}/Notes`]: [f('sub', true), f('b.md', false, 10)],
      [`${REMOTE_ROOT}/Notes/sub`]: [f('c.md', false, 5)],
    };
    // maxDepth=2：root(0) → Notes(1) 允许；Notes/sub(2) 允许作为条目但不深入（其子项 c.md@3 不进）
    const r = await walkRemoteTree(makeLister(map), {
      parentDir: PARENT,
      remoteRoot: REMOTE_ROOT,
      vaultName: VAULT,
      mode: 'full-vault',
      maxDepth: 2,
      maxNodes: 100,
      maxBytes: 0,
      concurrency: 2,
    });
    const names = r.nodes.map((n) => n.name);
    // depth ≤ 2 应全部可见
    expect(names).toContain('Notes');
    expect(names).toContain('sub');
    expect(names).toContain('b.md');
    expect(names).toContain('orphan.canvas');
    expect(names).toContain('a.md');
    // depth=3（sub 的子项 c.md）不应进入
    expect(names).not.toContain('c.md');
    expect(r.scannedNodes).toBe(5);
  });

  it('maxDepth=3：允许 sub 的子项 c.md 进入（depth=3）', async () => {
    const map: Record<string, RemoteDirRow[]> = {
      [PARENT]: [],
      [REMOTE_ROOT]: [f('Notes', true)],
      [`${REMOTE_ROOT}/Notes`]: [f('sub', true)],
      [`${REMOTE_ROOT}/Notes/sub`]: [f('c.md', false, 5)],
    };
    const r = await walkRemoteTree(makeLister(map), {
      parentDir: PARENT,
      remoteRoot: REMOTE_ROOT,
      vaultName: VAULT,
      mode: 'full-vault',
      maxDepth: 3,
      maxNodes: 100,
      maxBytes: 0,
      concurrency: 1,
    });
    const names = r.nodes.map((n) => n.name);
    expect(names).toContain('c.md');
  });

  it('maxDepth=1：root 直接子项允许；不进入 Notes/sub 等二级', async () => {
    const map: Record<string, RemoteDirRow[]> = {
      [PARENT]: [],
      [REMOTE_ROOT]: [f('Notes', true), f('a.md', false, 50)],
      [`${REMOTE_ROOT}/Notes`]: [f('b.md', false, 10)],
    };
    const r = await walkRemoteTree(makeLister(map), {
      parentDir: PARENT,
      remoteRoot: REMOTE_ROOT,
      vaultName: VAULT,
      mode: 'full-vault',
      maxDepth: 1,
      maxNodes: 100,
      maxBytes: 0,
      concurrency: 1,
    });
    const names = r.nodes.map((n) => n.name).sort();
    expect(names).toEqual(['Notes', 'a.md'].sort()); // 只 root 直接子项
    expect(names).not.toContain('b.md');
  });
});

describe('walkRemoteTree：预算保护', () => {
  it('maxNodes=3 时第 4 个节点不进入列表，truncated=true', async () => {
    const map: Record<string, RemoteDirRow[]> = {
      [PARENT]: [],
      [REMOTE_ROOT]: [
        f('a.md', false, 10),
        f('b.md', false, 20),
        f('c.md', false, 30),
        f('d.md', false, 40),
      ],
    };
    const r = await walkRemoteTree(makeLister(map), {
      parentDir: PARENT,
      remoteRoot: REMOTE_ROOT,
      vaultName: VAULT,
      mode: 'full-vault',
      maxDepth: 0,
      maxNodes: 3,
      maxBytes: 0,
      concurrency: 1,
    });
    expect(r.nodes.length).toBeLessThanOrEqual(3);
    expect(r.truncated).toBe(true);
  });

  it('F3 回归：maxBytes 在遍历中实时截断（不再等遍历结束后才标记）', async () => {
    const map: Record<string, RemoteDirRow[]> = {
      [PARENT]: [],
      [REMOTE_ROOT]: [
        f('big1.bin', false, 100),
        f('big2.bin', false, 100),
        f('big3.bin', false, 100),
        f('big4.bin', false, 100),
      ],
    };
    const r = await walkRemoteTree(makeLister(map), {
      parentDir: PARENT,
      remoteRoot: REMOTE_ROOT,
      vaultName: VAULT,
      mode: 'full-vault',
      maxDepth: 0,
      maxNodes: 100,
      maxBytes: 250, // big1(100)+big2(200) 未超；big3 后累计 300 > 250 → 立即截断
      concurrency: 1,
    });
    expect(r.nodes.length).toBe(3); // big1/big2/big3 已加入，big3 触达预算即停；big4 未进入
    expect(r.truncated).toBe(true);
    expect(r.scannedBytes).toBe(300);
  });

  it('并发 2 时 pumpOne worker 池至少处理 2 个并发任务', async () => {
    let maxInflight = 0;
    let inflight = 0;
    const slow = (delay: number) =>
      async (p: string) => {
        inflight++;
        maxInflight = Math.max(maxInflight, inflight);
        await new Promise((r) => setTimeout(r, delay));
        inflight--;
        if (p === PARENT) return [];
        return [f('x.md', false, 1), f('y.md', false, 1)];
      };
    const lister = { listDir: slow(20) };
    await walkRemoteTree(lister as unknown as RemoteLister, {
      parentDir: PARENT,
      remoteRoot: REMOTE_ROOT,
      vaultName: VAULT,
      mode: 'full-vault',
      maxDepth: 0,
      maxNodes: 100,
      maxBytes: 0,
      concurrency: 2,
    });
    expect(maxInflight).toBeLessThanOrEqual(2); // 不超过并发
  });
});

describe('walkRemoteTree：ignore-globs', () => {
  it('命中 ignore 的子目录整棵子树跳过', async () => {
    const map: Record<string, RemoteDirRow[]> = {
      [PARENT]: [],
      [REMOTE_ROOT]: [f('attachments', true), f('a.md', false, 50)],
      [`${REMOTE_ROOT}/attachments`]: [f('big.png', false, 1024)],
    };
    const r = await walkRemoteTree(makeLister(map), {
      parentDir: PARENT,
      remoteRoot: REMOTE_ROOT,
      vaultName: VAULT,
      mode: 'full-vault',
      maxDepth: 0,
      maxNodes: 100,
      maxBytes: 0,
      concurrency: 1,
      ignoreGlobs: ['attachments/**'],
    });
    const names = r.nodes.map((n) => n.name);
    expect(names).toContain('attachments'); // 目录本身可被记录（不入递归）
    expect(names).not.toContain('big.png'); // 但子项被跳过
  });
});

// ---------------- classifyOrphans ----------------

describe('classifyOrphans：三类分类', () => {
  it('备份目录：识别 ${vaultName}_YYYYMMDD_HHMMSS 为 backup-dir', async () => {
    const nodes: ScannedNode[] = [
      {
        absPath: `${PARENT}/Obsidian Vault_20240101_000000`,
        name: 'Obsidian Vault_20240101_000000',
        isDir: true,
        bytes: 0,
        mtime: 0,
        relPath: '',
        depth: 0,
      },
    ];
    const out = await classifyOrphans(nodes, { vaultName: VAULT });
    expect(out.length).toBe(1);
    expect(out[0].kind).toBe('backup-dir');
    expect(out[0].risk).toBe(1);
    expect(out[0].segments).toBe(1);
  });

  it('备份目录：≥2 段时间戳段 → risk=2', async () => {
    const nodes: ScannedNode[] = [
      {
        absPath: `${PARENT}/Obsidian Vault_20240101_000000_20240201_000000`,
        name: 'Obsidian Vault_20240101_000000_20240201_000000',
        isDir: true,
        bytes: 0,
        mtime: 0,
        relPath: '',
        depth: 0,
      },
    ];
    const out = await classifyOrphans(nodes, { vaultName: VAULT });
    expect(out[0].kind).toBe('backup-dir');
    expect(out[0].risk).toBe(2);
  });

  it('孤儿文件：vault 内不在 sync index 的文件 → orphan-file', async () => {
    const nodes: ScannedNode[] = [
      {
        absPath: `${REMOTE_ROOT}/未命名.canvas`,
        name: '未命名.canvas',
        isDir: false,
        bytes: 54,
        mtime: 1_700_000_000_000,
        relPath: '未命名.canvas',
        depth: 1,
      },
    ];
    const out = await classifyOrphans(nodes, {
      vaultName: VAULT,
      isActive: () => false, // 都不在 sync index
    });
    expect(out.length).toBe(1);
    expect(out[0].kind).toBe('orphan-file');
    expect(out[0].relPath).toBe('未命名.canvas');
  });

  it('孤儿文件：在 sync index 中 → 不算孤儿', async () => {
    const nodes: ScannedNode[] = [
      {
        absPath: `${REMOTE_ROOT}/notes/a.md`,
        name: 'a.md',
        isDir: false,
        bytes: 100,
        mtime: 0,
        relPath: 'notes/a.md',
        depth: 2,
      },
    ];
    const out = await classifyOrphans(nodes, {
      vaultName: VAULT,
      isActive: (p) => p === 'notes/a.md',
    });
    expect(out.length).toBe(0); // active 文件被排除
  });

  it('孤儿目录：vault 内空目录（已实际展开子项）→ orphan-dir', async () => {
    const nodes: ScannedNode[] = [
      {
        absPath: `${REMOTE_ROOT}/empty-folder`,
        name: 'empty-folder',
        isDir: true,
        bytes: 0,
        mtime: 0,
        relPath: 'empty-folder',
        depth: 1,
        childrenListed: true, // walk 引擎确实 listDir 过该目录且为空
      },
    ];
    const out = await classifyOrphans(nodes, {
      vaultName: VAULT,
      isActive: () => false,
    });
    expect(out.length).toBe(1);
    expect(out[0].kind).toBe('orphan-dir');
  });

  it('F6 回归：未实际展开子项的目录（childrenListed=false）不判 orphan-dir（防止 parent-only 把真实 vault 目录误报为空）', async () => {
    const nodes: ScannedNode[] = [
      {
        absPath: `${REMOTE_ROOT}`,
        name: VAULT,
        isDir: true,
        bytes: 0,
        mtime: 0,
        relPath: '',
        depth: 0,
        childrenListed: false, // parent-only 下只列了父目录一层，没进 vault 内部
      },
    ];
    const out = await classifyOrphans(nodes, {
      vaultName: VAULT,
      isActive: () => false,
    });
    expect(out.length).toBe(0); // 未知内容 ≠ 空目录，不得误报
  });

  it('F2 回归：含嵌套活动文件的目录（Notes/Archive/active.md）不判 orphan-dir', async () => {
    const map: Record<string, RemoteDirRow[]> = {
      [PARENT]: [],
      [REMOTE_ROOT]: [f('Notes', true), f('a.md', false, 10)],
      [`${REMOTE_ROOT}/Notes`]: [f('Archive', true)],
      [`${REMOTE_ROOT}/Notes/Archive`]: [f('active.md', false, 20)],
    };
    const walked = await walkRemoteTree(makeLister(map), {
      parentDir: PARENT,
      remoteRoot: REMOTE_ROOT,
      vaultName: VAULT,
      mode: 'full-vault',
      maxDepth: 0,
      maxNodes: 100,
      maxBytes: 0,
      concurrency: 2,
    });
    const out = await classifyOrphans(walked.nodes, {
      vaultName: VAULT,
      isActive: (p) => p === 'Notes/Archive/active.md',
    });
    // Notes / Archive 的子树内存在 active 文件 → 不得判孤儿目录
    expect(out.some((x) => x.name === 'Notes' && x.kind === 'orphan-dir')).toBe(false);
    expect(out.some((x) => x.name === 'Archive' && x.kind === 'orphan-dir')).toBe(false);
    // 真正的孤儿文件仍被识别
    expect(out.some((x) => x.name === 'a.md' && x.kind === 'orphan-file')).toBe(true);
  });

  it('F1 回归：基础设施目录（.bdnsync 等）用裸 glob 硬排除，目录条目本身不入候选', async () => {
    const map: Record<string, RemoteDirRow[]> = {
      [PARENT]: [],
      [REMOTE_ROOT]: [
        f('.bdnsync', true),
        f('.bdnsync-base', true),
        f('.bdnsync-merge-draft', true),
        f('Notes', true),
        f('a.md', false, 50),
      ],
      [`${REMOTE_ROOT}/.bdnsync`]: [f('index.json', false, 10)],
      [`${REMOTE_ROOT}/Notes`]: [f('b.md', false, 10)],
    };
    const walked = await walkRemoteTree(makeLister(map), {
      parentDir: PARENT,
      remoteRoot: REMOTE_ROOT,
      vaultName: VAULT,
      mode: 'full-vault',
      maxDepth: 0,
      maxNodes: 100,
      maxBytes: 0,
      concurrency: 2,
      // 与 main.ts 硬排除一致：必须是裸 glob（`X/**` 只覆盖子项，覆盖不了目录条目本身）
      ignoreGlobs: ['.bdnsync', '.bdnsync-base', '.bdnsync-merge-draft', '.bdnsync-backup'],
    });
    const out = await classifyOrphans(walked.nodes, {
      vaultName: VAULT,
      isActive: () => false,
    });
    // 基础设施目录不入节点、不入候选（不进入 .bdnsync 内部遍历）
    expect(walked.nodes.map((n) => n.name)).not.toContain('.bdnsync');
    expect(walked.nodes.map((n) => n.name)).not.toContain('.bdnsync-base');
    expect(out.some((x) => x.name.startsWith('.bdnsync'))).toBe(false);
    // 真正的孤儿文件仍被识别
    expect(out.some((x) => x.name === 'a.md' && x.kind === 'orphan-file')).toBe(true);
  });

  it('忽略 glob：命中即整棵子树跳过', async () => {
    const nodes: ScannedNode[] = [
      {
        absPath: `${REMOTE_ROOT}/attachments/big.png`,
        name: 'big.png',
        isDir: false,
        bytes: 1024,
        mtime: 0,
        relPath: 'attachments/big.png',
        depth: 2,
      },
    ];
    const out = await classifyOrphans(nodes, {
      vaultName: VAULT,
      isActive: () => false,
      ignoreGlobs: ['attachments/**'],
    });
    expect(out.length).toBe(0);
  });
});

describe('classifyOrphans：vault 自身目录命名基（.obsidian / .bdnsync）+ 来源标记', () => {
  it('.obsidian_<ts> 在 vault 根下被识别为 backup-dir，且 origin=vault', async () => {
    const nodes: ScannedNode[] = [
      {
        absPath: `${REMOTE_ROOT}/.obsidian_20260825_140911`,
        name: '.obsidian_20260825_140911',
        isDir: true,
        bytes: 0,
        mtime: 0,
        relPath: '.obsidian_20260825_140911',
        depth: 1,
        origin: 'vault',
      },
    ];
    const out = await classifyOrphans(nodes, { vaultName: VAULT });
    expect(out.length).toBe(1);
    expect(out[0].kind).toBe('backup-dir');
    expect(out[0].segments).toBe(1);
    expect(out[0].origin).toBe('vault');
  });

  it('.bdnsync_<ts> 在 vault 根下被识别为 backup-dir，且 origin=vault', async () => {
    const nodes: ScannedNode[] = [
      {
        absPath: `${REMOTE_ROOT}/.bdnsync_20260825_011832`,
        name: '.bdnsync_20260825_011832',
        isDir: true,
        bytes: 0,
        mtime: 0,
        relPath: '.bdnsync_20260825_011832',
        depth: 1,
        origin: 'vault',
      },
    ];
    const out = await classifyOrphans(nodes, { vaultName: VAULT });
    expect(out.length).toBe(1);
    expect(out[0].kind).toBe('backup-dir');
    expect(out[0].origin).toBe('vault');
  });

  it('父目录层孤儿（parent-only 命中）origin=parent 透传到 finding', async () => {
    const nodes: ScannedNode[] = [
      {
        absPath: `${PARENT}/Obsidian Vault_20240101_000000`,
        name: 'Obsidian Vault_20240101_000000',
        isDir: true,
        bytes: 0,
        mtime: 0,
        relPath: '',
        depth: 0,
        origin: 'parent',
      },
    ];
    const out = await classifyOrphans(nodes, { vaultName: VAULT });
    expect(out.length).toBe(1);
    expect(out[0].kind).toBe('backup-dir');
    expect(out[0].origin).toBe('parent');
  });

  it('真实 .obsidian 配置目录（无时间戳）不被当作 backup-dir（bare base segments=0）', async () => {
    const nodes: ScannedNode[] = [
      {
        absPath: `${REMOTE_ROOT}/.obsidian`,
        name: '.obsidian',
        isDir: true,
        bytes: 0,
        mtime: 0,
        relPath: '.obsidian',
        depth: 1,
        childrenListed: true,
        origin: 'vault',
      },
    ];
    const out = await classifyOrphans(nodes, { vaultName: VAULT, isActive: () => false });
    // bare base（segments=0）绝不可能是 backup-dir；即便它因未进 sync index 被归为 orphan-dir，
    // 也不应被归为「时间戳备份目录」而误导用户。
    expect(out.some((x) => x.kind === 'backup-dir')).toBe(false);
  });
});

describe('classifyOrphans：vault 根目录安全护栏（空索引不误删整库）', () => {
  it('full-vault + 空索引（isActive 全 false）：vault 根自身绝不出现在候选中', async () => {
    const map: Record<string, RemoteDirRow[]> = {
      [PARENT]: [f('Obsidian Vault', true)],
      [REMOTE_ROOT]: [f('Notes', true), f('a.md', false, 100)],
      [`${REMOTE_ROOT}/Notes`]: [f('b.md', false, 50)],
    };
    const walked = await walkRemoteTree(makeLister(map), {
      parentDir: PARENT,
      remoteRoot: REMOTE_ROOT,
      vaultName: VAULT,
      mode: 'full-vault',
      maxDepth: 0,
      maxNodes: 100,
      maxBytes: 0,
      concurrency: 2,
    });
    const out = await classifyOrphans(walked.nodes, {
      vaultName: VAULT,
      isActive: () => false, // 换账号 / 索引重置 / LocalIndex 读取失败
      ignoreGlobs: ['.bdnsync', '.bdnsync-base', '.bdnsync-merge-draft', '.bdnsync-backup', '.obsidian'],
    });
    // vault 根（/apps/bdnsync/Obsidian Vault）绝不能是候选
    expect(out.some((x) => x.fullPath === REMOTE_ROOT)).toBe(false);
    // vault 内部真正的孤儿（文件/子目录）仍应被识别
    expect(out.some((x) => x.fullPath === `${REMOTE_ROOT}/a.md`)).toBe(true);
    expect(out.some((x) => x.fullPath === `${REMOTE_ROOT}/Notes`)).toBe(true);
  });

  it('scoped + 空索引：vault 根同样不出现在候选中', async () => {
    const map: Record<string, RemoteDirRow[]> = {
      [PARENT]: [f('Obsidian Vault', true)],
      [REMOTE_ROOT]: [f('Notes', true), f('a.md', false, 100)],
      [`${REMOTE_ROOT}/Notes`]: [f('b.md', false, 50)],
    };
    const walked = await walkRemoteTree(makeLister(map), {
      parentDir: PARENT,
      remoteRoot: REMOTE_ROOT,
      vaultName: VAULT,
      mode: 'scoped',
      maxDepth: 0,
      maxNodes: 100,
      maxBytes: 0,
      concurrency: 2,
    });
    const out = await classifyOrphans(walked.nodes, {
      vaultName: VAULT,
      isActive: () => false,
    });
    expect(out.some((x) => x.fullPath === REMOTE_ROOT)).toBe(false);
  });

  it('护栏不误伤父目录层备份目录（relPath="" 的 backup-dir 仍被识别）', async () => {
    const nodes: ScannedNode[] = [
      {
        absPath: `${PARENT}/.obsidian_20260825_140911`,
        name: '.obsidian_20260825_140911',
        isDir: true,
        bytes: 0,
        mtime: 0,
        relPath: '',
        depth: 0,
        origin: 'parent',
      },
    ];
    const out = await classifyOrphans(nodes, { vaultName: VAULT, isActive: () => false });
    expect(out.some((x) => x.kind === 'backup-dir' && x.name === '.obsidian_20260825_140911')).toBe(true);
  });
});

describe('classifyOrphans：🔴#4 trustIndex=false 降级护栏（空索引不整库误标）', () => {
  it('索引不可信时：仅保留命名型备份目录判定，vault 内部孤儿文件/目录不再被误标', async () => {
    const map: Record<string, RemoteDirRow[]> = {
      [PARENT]: [f('Obsidian Vault_20240101_000000', true)], // 命名型备份目录（应保留判定）
      [REMOTE_ROOT]: [f('Notes', true), f('a.md', false, 100)],
      [`${REMOTE_ROOT}/Notes`]: [f('b.md', false, 50)],
    };
    const walked = await walkRemoteTree(makeLister(map), {
      parentDir: PARENT,
      remoteRoot: REMOTE_ROOT,
      vaultName: VAULT,
      mode: 'full-vault',
      maxDepth: 0,
      maxNodes: 100,
      maxBytes: 0,
      concurrency: 2,
    });
    const out = await classifyOrphans(walked.nodes, {
      vaultName: VAULT,
      isActive: () => false, // 换账号 / 索引重置 / LocalIndex 读取失败 → 空索引
      trustIndex: false, // 🔴#4 降级：索引不可信，索引依赖型孤儿判定关闭
      ignoreGlobs: ['.bdnsync', '.bdnsync-base', '.bdnsync-merge-draft', '.bdnsync-backup', '.obsidian'],
    });
    // vault 内部「索引依赖型」孤儿：不再误标（否则会整库删除）
    expect(out.some((x) => x.fullPath === `${REMOTE_ROOT}/a.md`)).toBe(false);
    expect(out.some((x) => x.fullPath === `${REMOTE_ROOT}/Notes`)).toBe(false);
    expect(out.some((x) => x.fullPath === REMOTE_ROOT)).toBe(false);
    // 但「命名型」备份目录（不依赖索引）仍应被识别
    expect(
      out.some(
        (x) => x.kind === 'backup-dir' && x.fullPath === `${PARENT}/Obsidian Vault_20240101_000000`,
      ),
    ).toBe(true);
  });

  it('trustIndex 缺省（true）时仍走原行为：空索引下内部孤儿会被判（由调用方决定是否安全）', async () => {
    const map: Record<string, RemoteDirRow[]> = {
      [PARENT]: [],
      [REMOTE_ROOT]: [f('a.md', false, 100)],
    };
    const walked = await walkRemoteTree(makeLister(map), {
      parentDir: PARENT,
      remoteRoot: REMOTE_ROOT,
      vaultName: VAULT,
      mode: 'full-vault',
      maxDepth: 0,
      maxNodes: 100,
      maxBytes: 0,
      concurrency: 2,
    });
    const out = await classifyOrphans(walked.nodes, {
      vaultName: VAULT,
      isActive: () => false, // 缺省 trustIndex（true）：保留原行为
    });
    // 缺省行为下，空索引仍会把 vault 内文件判为 orphan-file（由 main.ts 传入 trustIndex=false 来关闭）
    expect(out.some((x) => x.kind === 'orphan-file' && x.fullPath === `${REMOTE_ROOT}/a.md`)).toBe(true);
  });
});

// ---------------- mergeFindings ----------------

describe('mergeFindings：旧管线 + 新管线合并去重', () => {
  it('fullPath 重复时：用 new 的 kind + 用 old 的字节数补字段', async () => {
    const { mergeFindings } = await import('../src/util/orphan-scan');
    const legacy = [
      {
        fullPath: `${PARENT}/Obsidian Vault_20240101_000000`,
        name: 'Obsidian Vault_20240101_000000',
        segments: 1,
        risk: 1 as const,
        mtime: 0,
        fileCount: 3,
        totalBytes: 1024,
      },
    ];
    const newFindings = [
      {
        kind: 'backup-dir' as const,
        fullPath: `${PARENT}/Obsidian Vault_20240101_000000`,
        name: 'Obsidian Vault_20240101_000000',
        parentPath: PARENT,
        relPath: '',
        depth: 0,
        bytes: 0, // 新管线不直接计算（依赖 measureOrphans）
        mtime: 0,
        risk: 1 as const,
        reason: '...',
        segments: 1,
      },
    ];
    const merged = mergeFindings(legacy, newFindings);
    expect(merged.length).toBe(1);
    expect(merged[0].bytes).toBe(1024); // 字节数被补
    expect(merged[0].kind).toBe('backup-dir');
  });

  it('fullPath 不重复时：保留两边', async () => {
    const { mergeFindings } = await import('../src/util/orphan-scan');
    const legacy = [
      {
        fullPath: `${PARENT}/X`,
        name: 'X',
        segments: 1,
        risk: 1 as const,
        mtime: 0,
        fileCount: 0,
        totalBytes: 0,
      },
    ];
    const newFindings = [
      {
        kind: 'orphan-file' as const,
        fullPath: `${REMOTE_ROOT}/y.md`,
        name: 'y.md',
        parentPath: REMOTE_ROOT,
        relPath: 'y.md',
        depth: 1,
        bytes: 10,
        mtime: 0,
        risk: 0 as const,
        reason: '不在 sync index',
        segments: 0,
      },
    ];
    const merged = mergeFindings(legacy, newFindings);
    expect(merged.length).toBe(2);
  });
});

// ---------------- 本轮回归：🟡#7 深度截断护栏 / 🟡#8 仅含被忽略子项 / 🟢 基础设施目录硬排除 ----------------

describe('🟡#7 深度截断护栏：命中 maxDepth 的目录不误判 orphan-dir', () => {
  it('full-vault 命中 maxDepth 的目录 depthTruncated=true，且自身及祖先均不被判 orphan-dir', async () => {
    // maxDepth=2：Notes/sub 位于 depth=2（=maxDepth）→ 子树不再展开，被标记 depthTruncated。
    // Notes（祖先）因此进入 unsafeDirs，整棵不被判 orphan-dir，避免把含深层未知内容的目录误标。
    const map: Record<string, RemoteDirRow[]> = {
      [PARENT]: [],
      [REMOTE_ROOT]: [f('root.md', false, 100), f('Notes', true)],
      [`${REMOTE_ROOT}/Notes`]: [f('note.md', false, 10), f('sub', true)],
      [`${REMOTE_ROOT}/Notes/sub`]: [f('c.md', false, 5)], // 不会进入（被深度限制）
    };
    const walked = await walkRemoteTree(makeLister(map), {
      parentDir: PARENT,
      remoteRoot: REMOTE_ROOT,
      vaultName: VAULT,
      mode: 'full-vault',
      maxDepth: 2,
      maxNodes: 100,
      maxBytes: 0,
      concurrency: 1,
    });
    // walk 输出：sub 应带 depthTruncated=true（命中深度上限）
    const sub = walked.nodes.find((n) => n.name === 'sub');
    expect(sub).toBeDefined();
    expect(sub?.depthTruncated).toBe(true);
    // c.md 不应进入（被深度限制）
    expect(walked.nodes.map((n) => n.name)).not.toContain('c.md');

    const out = await classifyOrphans(walked.nodes, {
      vaultName: VAULT,
      isActive: () => false, // 索引全空，但截断目录不应因此被误标
    });
    // 截断目录自身 + 其祖先均不被判 orphan-dir
    expect(out.some((x) => x.kind === 'orphan-dir' && x.name === 'sub')).toBe(false);
    expect(out.some((x) => x.kind === 'orphan-dir' && x.name === 'Notes')).toBe(false);
    // 同层真正无活跃文件的文件仍被识别
    expect(out.some((x) => x.kind === 'orphan-file' && x.name === 'root.md')).toBe(true);
    expect(out.some((x) => x.kind === 'orphan-file' && x.name === 'note.md')).toBe(true);
  });

  it('未截断的深度目录（整棵已展开、子项均 inactive）仍被正确判为 orphan-dir（修复不误伤）', async () => {
    const map: Record<string, RemoteDirRow[]> = {
      [PARENT]: [],
      [REMOTE_ROOT]: [f('Trash', true)],
      [`${REMOTE_ROOT}/Trash`]: [f('old.md', false, 20)],
    };
    const walked = await walkRemoteTree(makeLister(map), {
      parentDir: PARENT,
      remoteRoot: REMOTE_ROOT,
      vaultName: VAULT,
      mode: 'full-vault',
      maxDepth: 3, // 充足深度，Trash 完整展开
      maxNodes: 100,
      maxBytes: 0,
      concurrency: 1,
    });
    const trash = walked.nodes.find((n) => n.name === 'Trash');
    expect(trash?.depthTruncated).toBeFalsy(); // 未被截断
    const out = await classifyOrphans(walked.nodes, {
      vaultName: VAULT,
      isActive: () => false,
    });
    // 已完整展开且无活跃文件 → 正确判 orphan-dir（修复不误伤合法判定）
    expect(out.some((x) => x.kind === 'orphan-dir' && x.name === 'Trash')).toBe(true);
  });
});

describe('🟡#8 仅含被忽略子项的目录不误判 orphan-dir（realKids 过滤）', () => {
  it('目录仅含被忽略子项（.DS_Store）→ 不判为空/孤儿目录', async () => {
    // 注意：ignoreGlobs 只传给 classifyOrphans，不传给 walker ——
    // 这样被忽略的 .DS_Store 仍以节点形式进入 kids，真正考验 realKids 过滤（而非 walker 预过滤）。
    const map: Record<string, RemoteDirRow[]> = {
      [PARENT]: [],
      [REMOTE_ROOT]: [f('Secret', true), f('a.md', false, 100)],
      [`${REMOTE_ROOT}/Secret`]: [f('.DS_Store', false, 0)],
    };
    const walked = await walkRemoteTree(makeLister(map), {
      parentDir: PARENT,
      remoteRoot: REMOTE_ROOT,
      vaultName: VAULT,
      mode: 'full-vault',
      maxDepth: 2, // 让 Secret 展开，.DS_Store 作为真实节点进入 kids
      maxNodes: 100,
      maxBytes: 0,
      concurrency: 1,
    });
    const out = await classifyOrphans(walked.nodes, {
      vaultName: VAULT,
      isActive: () => false,
      ignoreGlobs: ['.DS_Store'],
    });
    // 仅含忽略子项的目录：不得判 orphan-dir（修复前会被误判为「1 项孤儿目录」）
    expect(out.some((x) => x.kind === 'orphan-dir' && x.name === 'Secret')).toBe(false);
    // 真正的孤儿文件仍被识别
    expect(out.some((x) => x.kind === 'orphan-file' && x.name === 'a.md')).toBe(true);
  });

  it('目录含「忽略子项 + 真实 inactive 子项」→ 判 orphan-dir，但字节/项数仅计真实子项', async () => {
    const map: Record<string, RemoteDirRow[]> = {
      [PARENT]: [],
      [REMOTE_ROOT]: [f('Docs', true)],
      [`${REMOTE_ROOT}/Docs`]: [f('.DS_Store', false, 0), f('note.md', false, 200)],
    };
    const walked = await walkRemoteTree(makeLister(map), {
      parentDir: PARENT,
      remoteRoot: REMOTE_ROOT,
      vaultName: VAULT,
      mode: 'full-vault',
      maxDepth: 2,
      maxNodes: 100,
      maxBytes: 0,
      concurrency: 1,
    });
    const out = await classifyOrphans(walked.nodes, {
      vaultName: VAULT,
      isActive: () => false,
      ignoreGlobs: ['.DS_Store'],
    });
    const docs = out.find((x) => x.kind === 'orphan-dir' && x.name === 'Docs');
    expect(docs).toBeDefined();
    // 字节仅计真实子项 note.md（200），不含被忽略的 .DS_Store；项数=1
    expect(docs?.bytes).toBe(200);
    expect(docs?.reason).toContain('1 项');
  });
});

describe('🟢 PLUGIN_INFRA_HARD_EXCLUDE：分类器直接跳过基础设施目录（不依赖 ignore-globs）', () => {
  it('未传 ignoreGlobs 时，.bdnsync 目录节点仍被分类器硬排除（不判 orphan-dir）', async () => {
    const map: Record<string, RemoteDirRow[]> = {
      [PARENT]: [],
      [REMOTE_ROOT]: [f('.bdnsync', true), f('a.md', false, 100)],
      // 故意不传 ignoreGlobs：证明分类器层 PLUGIN_INFRA_HARD_EXCLUDE 兜底生效（纵深防御）
    };
    const walked = await walkRemoteTree(makeLister(map), {
      parentDir: PARENT,
      remoteRoot: REMOTE_ROOT,
      vaultName: VAULT,
      mode: 'full-vault',
      maxDepth: 0, // .bdnsync 不被递归，但仍作为节点进入 walk 输出
      maxNodes: 100,
      maxBytes: 0,
      concurrency: 1,
    });
    // 证明 .bdnsync 节点确实进了 walk 输出（否则就测不到分类器兜底）
    expect(walked.nodes.map((n) => n.name)).toContain('.bdnsync');
    const out = await classifyOrphans(walked.nodes, {
      vaultName: VAULT,
      isActive: () => false,
    });
    // 基础设施目录自身绝不被判 orphan-dir / 任何 kind
    expect(out.some((x) => x.name === '.bdnsync')).toBe(false);
    // 真正的孤儿文件仍被识别
    expect(out.some((x) => x.kind === 'orphan-file' && x.name === 'a.md')).toBe(true);
  });
});

// ---------------- 本轮修复：🔴 父目录层 listDir 空 → search 兜底 / 进度回调 ----------------

describe('walkRemoteTree：🔴 父目录层 listDir 空 → search 兜底找回孤儿（0 结果根因修复）', () => {
  it('listDir(parentDir) 返回空且 lister.search 命中孤儿目录时，父目录层仍能找回 backup-dir 候选', async () => {
    // 父目录 listDir 空（模拟百度 errno=-9：沙箱根常返回空），真实场景因此 0 结果
    const map: Record<string, RemoteDirRow[]> = {
      [PARENT]: [], // 关键：父目录不可列
      [REMOTE_ROOT]: [f('Notes', true), f('a.md', false, 100)],
    };
    // search 接口兜底找回孤儿（百度 search 返回完整条目）
    const searchHits: RemoteDirRow[] = [
      {
        path: `${PARENT}/Obsidian Vault_20240101_000000`,
        name: 'Obsidian Vault_20240101_000000',
        isDir: true,
        mtime: 0,
        size: 0,
      },
    ];
    const lister: RemoteLister = {
      async listDir(p: string): Promise<RemoteDirRow[]> {
        if (!(p in map)) throw new Error(`not found: ${p}`);
        return map[p];
      },
      async search(): Promise<RemoteDirRow[]> {
        return searchHits;
      },
    };
    const r = await walkRemoteTree(lister, {
      parentDir: PARENT,
      remoteRoot: REMOTE_ROOT,
      vaultName: VAULT,
      mode: 'full-vault',
      maxDepth: 0,
      maxNodes: 100,
      maxBytes: 0,
      concurrency: 1,
    });
    // 父目录层仍应包含 search 兜底的孤儿目录
    const names = r.nodes.map((n) => n.name);
    expect(names).toContain('Obsidian Vault_20240101_000000');
    // 应产生一条 warning 说明走了搜索兜底
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.warnings[0]).toContain('搜索');
    // 分类器应把它识别为 backup-dir
    const out = await classifyOrphans(r.nodes, { vaultName: VAULT });
    expect(
      out.some((x) => x.kind === 'backup-dir' && x.name === 'Obsidian Vault_20240101_000000'),
    ).toBe(true);
  });

  it('listDir 正常返回时不应触发 search（无 warning、search 不被调用）', async () => {
    const map: Record<string, RemoteDirRow[]> = {
      [PARENT]: [f('Obsidian Vault', true), f('Obsidian Vault_20240101_000000', true)],
    };
    let searchCalled = false;
    const lister: RemoteLister = {
      async listDir(p: string): Promise<RemoteDirRow[]> {
        if (!(p in map)) throw new Error(`not found: ${p}`);
        return map[p];
      },
      async search(): Promise<RemoteDirRow[]> {
        searchCalled = true;
        return [];
      },
    };
    const r = await walkRemoteTree(lister, {
      parentDir: PARENT,
      remoteRoot: REMOTE_ROOT,
      vaultName: VAULT,
      mode: 'parent-only',
      maxDepth: 0,
      maxNodes: 100,
      maxBytes: 0,
      concurrency: 1,
    });
    expect(searchCalled).toBe(false);
    expect(r.warnings.length).toBe(0);
  });

  it('listDir 抛错时同样走 search 兜底（而非静默 0 结果）', async () => {
    const map: Record<string, RemoteDirRow[]> = {
      [REMOTE_ROOT]: [f('a.md', false, 100)],
    };
    const searchHits: RemoteDirRow[] = [
      {
        path: `${PARENT}/Obsidian Vault_20240101_000000`,
        name: 'Obsidian Vault_20240101_000000',
        isDir: true,
        mtime: 0,
        size: 0,
      },
    ];
    const lister: RemoteLister = {
      async listDir(p: string): Promise<RemoteDirRow[]> {
        if (p === PARENT) throw new Error('errno=-9 父目录不可列');
        if (!(p in map)) throw new Error(`not found: ${p}`);
        return map[p];
      },
      async search(): Promise<RemoteDirRow[]> {
        return searchHits;
      },
    };
    const r = await walkRemoteTree(lister, {
      parentDir: PARENT,
      remoteRoot: REMOTE_ROOT,
      vaultName: VAULT,
      mode: 'parent-only',
      maxDepth: 0,
      maxNodes: 100,
      maxBytes: 0,
      concurrency: 1,
    });
    expect(r.nodes.map((n) => n.name)).toContain('Obsidian Vault_20240101_000000');
    expect(r.warnings.some((w) => w.includes('搜索'))).toBe(true);
  });

  it('search 兜底只收「≥1 段时间戳」的孤儿：vault 根（无时间戳）不被找回', async () => {
    // 全盘搜索可能把 vault 根自身（Obsidian Vault，segments=0）也模糊命中；
    // 过滤必须与分类器一致（segments>=1），否则 vault 根会被误收为候选。
    const map: Record<string, RemoteDirRow[]> = { [PARENT]: [] };
    const lister: RemoteLister = {
      async listDir(p: string): Promise<RemoteDirRow[]> {
        if (!(p in map)) throw new Error(`not found: ${p}`);
        return map[p];
      },
      async search(): Promise<RemoteDirRow[]> {
        return [
          { path: `${PARENT}/Obsidian Vault`, name: 'Obsidian Vault', isDir: true, mtime: 0, size: 0 },
          {
            path: `${PARENT}/Obsidian Vault_20240101_000000`,
            name: 'Obsidian Vault_20240101_000000',
            isDir: true,
            mtime: 0,
            size: 0,
          },
        ];
      },
    };
    const r = await walkRemoteTree(lister, {
      parentDir: PARENT,
      remoteRoot: REMOTE_ROOT,
      vaultName: VAULT,
      mode: 'full-vault',
      maxDepth: 0,
      maxNodes: 100,
      maxBytes: 0,
      concurrency: 1,
    });
    const names = r.nodes.map((n) => n.name);
    expect(names).not.toContain('Obsidian Vault'); // vault 根被过滤
    expect(names).toContain('Obsidian Vault_20240101_000000'); // 真孤儿被找回
    const out = await classifyOrphans(r.nodes, { vaultName: VAULT });
    expect(
      out.some((x) => x.kind === 'backup-dir' && x.name === 'Obsidian Vault_20240101_000000'),
    ).toBe(true);
  });

  it('search 全盘命中父目录之外的孤儿时，absPath 使用真实路径而非硬拼 parentDir', async () => {
    // 孤儿若在网盘其它位置（如根目录 /Obsidian Vault_20240101_000000），
    // 兜底结果必须保留其真实绝对路径，否则会被错误拼到 parentDir 之下。
    const map: Record<string, RemoteDirRow[]> = { [PARENT]: [] };
    const lister: RemoteLister = {
      async listDir(p: string): Promise<RemoteDirRow[]> {
        if (!(p in map)) throw new Error(`not found: ${p}`);
        return map[p];
      },
      async search(): Promise<RemoteDirRow[]> {
        return [
          {
            path: '/Obsidian Vault_20240101_000000', // 网盘根目录，不在 PARENT 下
            name: 'Obsidian Vault_20240101_000000',
            isDir: true,
            mtime: 0,
            size: 0,
          },
        ];
      },
    };
    const r = await walkRemoteTree(lister, {
      parentDir: PARENT,
      remoteRoot: REMOTE_ROOT,
      vaultName: VAULT,
      mode: 'full-vault',
      maxDepth: 0,
      maxNodes: 100,
      maxBytes: 0,
      concurrency: 1,
    });
    const hit = r.nodes.find((n) => n.name === 'Obsidian Vault_20240101_000000');
    expect(hit).toBeDefined();
    // 关键断言：真实路径被保留，而不是拼成 /apps/bdnsync/Obsidian Vault_20240101_000000
    expect(hit?.absPath).toBe('/Obsidian Vault_20240101_000000');
  });
});

describe('walkRemoteTree：onProgress 实时上报 currentPath（扫描进度反馈）', () => {
  it('遍历中至少上报父目录层、vault 根与子树目录路径', async () => {
    const map: Record<string, RemoteDirRow[]> = {
      [PARENT]: [],
      [REMOTE_ROOT]: [f('Notes', true), f('a.md', false, 100)],
      [`${REMOTE_ROOT}/Notes`]: [f('b.md', false, 10)],
    };
    const paths: string[] = [];
    await walkRemoteTree(makeLister(map), {
      parentDir: PARENT,
      remoteRoot: REMOTE_ROOT,
      vaultName: VAULT,
      mode: 'full-vault',
      maxDepth: 0,
      maxNodes: 100,
      maxBytes: 0,
      concurrency: 1,
      onProgress: (info) => {
        if (info.currentPath) paths.push(info.currentPath);
      },
    });
    expect(paths).toContain(PARENT); // 父目录层
    expect(paths).toContain(REMOTE_ROOT); // vault 根
    expect(paths).toContain(`${REMOTE_ROOT}/Notes`); // 子树目录
  });
});
