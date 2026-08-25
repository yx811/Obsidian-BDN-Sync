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

  it('孤儿目录：vault 内空目录 → orphan-dir', async () => {
    const nodes: ScannedNode[] = [
      {
        absPath: `${REMOTE_ROOT}/empty-folder`,
        name: 'empty-folder',
        isDir: true,
        bytes: 0,
        mtime: 0,
        relPath: 'empty-folder',
        depth: 1,
      },
    ];
    const out = await classifyOrphans(nodes, {
      vaultName: VAULT,
      isActive: () => false,
    });
    expect(out.length).toBe(1);
    expect(out[0].kind).toBe('orphan-dir');
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
