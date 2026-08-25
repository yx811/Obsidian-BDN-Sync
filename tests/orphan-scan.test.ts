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
