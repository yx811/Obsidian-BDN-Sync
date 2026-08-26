import { describe, it, expect } from 'vitest';
import {
  parsePorcelain,
  relativeToVault,
  GitChangeSource,
  type GitRunner,
} from '../src/lab/git-change-source';
import { Platform } from 'obsidian';

/** 基于命令字符串命中 mock 的极简 git 执行器 */
function fakeRunner(
  map: Record<string, { ok: boolean; stdout: string }>,
): GitRunner {
  return {
    run(args: string[]) {
      const key = args.join(' ');
      const hit = map[key] ?? map[args[0]];
      if (!hit) return { ok: false, stdout: '', stderr: `no mock for ${key}` };
      return { ok: hit.ok, stdout: hit.stdout, stderr: '' };
    },
  };
}

describe('parsePorcelain', () => {
  it('解析 修改/新增/删除/未跟踪/重命名 各类状态码', () => {
    const out = [
      ' M note.md',
      'A  added.md',
      ' D deleted.md',
      '?? untracked.md',
      'R  old.md -> new.md',
    ].join('\n');
    expect(parsePorcelain(out).sort()).toEqual(
      ['added.md', 'deleted.md', 'new.md', 'note.md', 'old.md', 'untracked.md'].sort(),
    );
  });

  it('忽略空行', () => {
    expect(parsePorcelain('\n  \n M a.md\n')).toEqual(['a.md']);
  });

  it('文件名本身含 ` -> ` 时不被误拆（git 会加引号输出）', () => {
    expect(parsePorcelain('?? "a -> b.md"\n')).toEqual(['a -> b.md']);
  });

  it('带引号的重命名两侧都正确去引号', () => {
    expect(parsePorcelain('R  "old file.md" -> "new file.md"\n')).toEqual([
      'old file.md',
      'new file.md',
    ]);
  });

  it('带引号的普通修改路径正确还原', () => {
    expect(parsePorcelain(' M "my note.md"\n')).toEqual(['my note.md']);
  });
});

describe('relativeToVault', () => {
  it('vault 即仓库根时原样返回并过滤 .git', () => {
    expect(relativeToVault('/repo', '/repo', ['.git/config', 'a.md'])).toEqual(['a.md']);
  });

  it('vault 是仓库子目录时剥离前缀，仓库外的路径被丢弃', () => {
    const r = relativeToVault('/repo', '/repo/vault', [
      'vault/x.md',
      'other/y.md',
      'vault/',
    ]);
    expect(r).toEqual(['x.md']);
  });

  it('纯目录路径被跳过', () => {
    expect(relativeToVault('/repo', '/repo', ['adir/'])).toEqual([]);
  });
});

describe('GitChangeSource.collect', () => {
  it('非 git 仓库返回 null', async () => {
    const runner = fakeRunner({ 'rev-parse --show-toplevel': { ok: false, stdout: '' } });
    const cs = await new GitChangeSource('/vault', undefined, runner).collect();
    expect(cs).toBeNull();
  });

  it('采集 working tree 变更并返回 HEAD', async () => {
    const runner = fakeRunner({
      'rev-parse --show-toplevel': { ok: true, stdout: '/repo\n' },
      'rev-parse HEAD': { ok: true, stdout: 'abc123\n' },
      'status --porcelain -uall': { ok: true, stdout: ' M a.md\n?? b.md\n' },
    });
    const cs = await new GitChangeSource('/repo', undefined, runner).collect();
    expect(cs).not.toBeNull();
    expect(cs!.paths.sort()).toEqual(['a.md', 'b.md']);
    expect(cs!.head).toBe('abc123');
    expect(cs!.usedFallback).toBe(true);
  });

  it('设置了 lastRef 时合并 diff 区间与 status，usedFallback=false', async () => {
    const runner = fakeRunner({
      'rev-parse --show-toplevel': { ok: true, stdout: '/repo\n' },
      'rev-parse HEAD': { ok: true, stdout: 'head2\n' },
      'diff --name-only prev HEAD': { ok: true, stdout: 'c.md\n' },
      'status --porcelain -uall': { ok: true, stdout: ' M a.md\n' },
    });
    const cs = await new GitChangeSource('/repo', 'prev', runner).collect();
    expect(cs!.paths.sort()).toEqual(['a.md', 'c.md']);
    expect(cs!.usedFallback).toBe(false);
  });

  it('移动端（非桌面）直接返回 null', async () => {
    const prev = Platform.isDesktop;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Platform as any).isDesktop = false;
    try {
      const runner = fakeRunner({ 'rev-parse --show-toplevel': { ok: true, stdout: '/repo' } });
      const cs = await new GitChangeSource('/repo', undefined, runner).collect();
      expect(cs).toBeNull();
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (Platform as any).isDesktop = prev;
    }
  });
});
