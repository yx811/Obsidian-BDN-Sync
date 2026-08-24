import { describe, it, expect } from 'vitest';
import {
  ConflictResolver,
  type ConflictInput,
  type ResolveOutcome,
} from '../src/sync/conflict-resolver';
import type { ConflictKind } from '../src/types';

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8');

const resolver = new ConflictResolver();

/** 构造冲突输入 */
function input(over: Partial<ConflictInput> & { path: string; kind: ConflictKind }): ConflictInput {
  return {
    localBytes: null,
    remoteBytes: null,
    baseBytes: null,
    deviceName: '本机',
    ...over,
  };
}

function ok(o: ResolveOutcome): void {
  // 基本结构断言（所有分支都应返回合法的 ResolveOutcome）
  expect(o).toHaveProperty('action');
  expect(typeof o.uploadOriginal).toBe('boolean');
  expect(Array.isArray(o.conflictCopies)).toBe(true);
  expect(typeof o.hasMarkers).toBe('boolean');
  expect(typeof o.note).toBe('string');
}

describe('ConflictResolver — smart-merge', () => {
  it('text edit-edit with base → clean merge when only one side changed', () => {
    // 远端未改（remote == base），仅本地改了 line2 → 干净合并、无冲突标记
    const base = enc.encode('line1\nline2\nline3\n');
    const local = enc.encode('line1\nline2 LOCAL\nline3\n');
    const remote = base;
    const out = resolver.resolve(
      input({
        path: 'a.md',
        kind: 'edit-edit',
        localBytes: local,
        remoteBytes: remote,
        baseBytes: base,
      }),
      'smart-merge',
    );
    ok(out);
    expect(out.action).toBe('write-and-upload');
    expect(out.uploadOriginal).toBe(true);
    expect(out.hasMarkers).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const text = dec.decode(out.localBytes!);
    expect(text).toContain('LOCAL');
    expect(text).toContain('line1');
    expect(text).toContain('line3');
  });

  it('text edit-edit with base → three-way merge (with conflict markers)', () => {
    const base = enc.encode('shared\n');
    const local = enc.encode('shared\nLOCAL ONLY\n');
    const remote = enc.encode('shared\nREMOTE ONLY\n');
    const out = resolver.resolve(
      input({
        path: 'a.md',
        kind: 'edit-edit',
        localBytes: local,
        remoteBytes: remote,
        baseBytes: base,
      }),
      'smart-merge',
    );
    ok(out);
    expect(out.action).toBe('write-and-upload');
    // 两边改了同一段 → 产生冲突标记
    expect(out.hasMarkers).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const text = dec.decode(out.localBytes!);
    expect(text).toContain('<<<<<<<');
    expect(text).toContain('=======');
    expect(text).toContain('>>>>>>>');
  });

  it('text edit-edit without base → union merge', () => {
    const local = enc.encode('L\n');
    const remote = enc.encode('R\n');
    const out = resolver.resolve(
      input({
        path: 'a.md',
        kind: 'edit-edit',
        localBytes: local,
        remoteBytes: remote,
        baseBytes: null,
      }),
      'smart-merge',
    );
    ok(out);
    expect(out.action).toBe('write-and-upload');
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const text = dec.decode(out.localBytes!);
    expect(text).toContain('L');
    expect(text).toContain('R');
  });

  it('non-UTF8 content (fake .md) → fork, never lossy merge', () => {
    // 后缀像文本但内容是非法 UTF-8：解码失败必须分叉，绝不做有损合并
    const local = new Uint8Array([0xff, 0xfe, 0x00, 0x10]);
    const remote = new Uint8Array([0xaa, 0xbb, 0xcc]);
    const out = resolver.resolve(
      input({ path: 'fake.md', kind: 'edit-edit', localBytes: local, remoteBytes: remote }),
      'smart-merge',
    );
    ok(out);
    expect(out.action).toBe('upload-local');
    expect(out.uploadOriginal).toBe(true);
    expect(out.conflictCopies.length).toBe(1);
    // 云端版本另存为冲突副本（REMOTE 标记）
    expect(out.conflictCopies[0].path).toContain('REMOTE');
    expect(out.conflictCopies[0].bytes).toEqual(remote);
    // 本地版本仍保留在原路径（由引擎原样上传）
  });

  it('oversized text (>512KB) → fork instead of merging on main thread', () => {
    const big = 'x'.repeat(600 * 1024); // 600KB，超过 MERGE_MAX_BYTES(512KB)
    const local = enc.encode(big + 'LOCAL');
    const remote = enc.encode(big + 'REMOTE');
    const out = resolver.resolve(
      input({ path: 'big.md', kind: 'edit-edit', localBytes: local, remoteBytes: remote }),
      'smart-merge',
    );
    ok(out);
    expect(out.action).toBe('upload-local');
    expect(out.conflictCopies.length).toBe(1);
    expect(out.conflictCopies[0].path).toContain('REMOTE');
  });

  it('binary file (.png) conflict → fork', () => {
    const local = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG magic
    const remote = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x01]);
    const out = resolver.resolve(
      input({ path: 'img.png', kind: 'binary', localBytes: local, remoteBytes: remote }),
      'smart-merge',
    );
    ok(out);
    expect(out.action).toBe('upload-local');
    expect(out.conflictCopies.length).toBe(1);
    expect(out.conflictCopies[0].bytes).toEqual(remote);
  });

  it('delete-modify-local: local deleted, remote modified → restore remote (write-local)', () => {
    const remote = enc.encode('remote content');
    const out = resolver.resolve(
      input({ path: 'd.md', kind: 'delete-modify-local', localBytes: null, remoteBytes: remote }),
      'smart-merge',
    );
    ok(out);
    expect(out.action).toBe('write-local');
    expect(out.uploadOriginal).toBe(false);
    expect(out.localBytes).toEqual(remote);
  });

  it('delete-modify-remote: remote deleted, local modified → keep local (upload-local)', () => {
    const local = enc.encode('local content');
    const out = resolver.resolve(
      input({ path: 'd.md', kind: 'delete-modify-remote', localBytes: local, remoteBytes: null }),
      'smart-merge',
    );
    ok(out);
    expect(out.action).toBe('upload-local');
    expect(out.uploadOriginal).toBe(true);
    expect(out.conflictCopies.length).toBe(0);
  });

  it('both deleted → deferred (nothing to do)', () => {
    const out = resolver.resolve(
      input({ path: 'gone.md', kind: 'unknown', localBytes: null, remoteBytes: null }),
      'smart-merge',
    );
    ok(out);
    expect(out.action).toBe('deferred');
    expect(out.uploadOriginal).toBe(false);
  });
});

describe('ConflictResolver — force-local', () => {
  it('local present → overwrite remote (upload-local)', () => {
    const local = enc.encode('local wins');
    const out = resolver.resolve(
      input({
        path: 'f.md',
        kind: 'edit-edit',
        localBytes: local,
        remoteBytes: enc.encode('remote'),
      }),
      'force-local',
    );
    ok(out);
    expect(out.action).toBe('upload-local');
    expect(out.uploadOriginal).toBe(true);
    expect(out.conflictCopies.length).toBe(0);
  });

  it('local deleted → delete remote', () => {
    const out = resolver.resolve(
      input({
        path: 'f.md',
        kind: 'delete-modify-remote',
        localBytes: null,
        remoteBytes: enc.encode('remote'),
      }),
      'force-local',
    );
    ok(out);
    expect(out.action).toBe('delete-remote');
    expect(out.uploadOriginal).toBe(false);
  });
});

describe('ConflictResolver — force-remote', () => {
  it('remote present → overwrite local (write-local carrying remote bytes)', () => {
    const remote = enc.encode('remote wins');
    const out = resolver.resolve(
      input({
        path: 'f.md',
        kind: 'edit-edit',
        localBytes: enc.encode('local'),
        remoteBytes: remote,
      }),
      'force-remote',
    );
    ok(out);
    // 关键：action=write-local 且 localBytes 携带云端内容，引擎才会真正写回本地
    expect(out.action).toBe('write-local');
    expect(out.uploadOriginal).toBe(false);
    expect(out.localBytes).toEqual(remote);
  });

  it('remote deleted → delete local', () => {
    const local = enc.encode('local');
    const out = resolver.resolve(
      input({ path: 'f.md', kind: 'delete-modify-local', localBytes: local, remoteBytes: null }),
      'force-remote',
    );
    ok(out);
    expect(out.action).toBe('delete-local');
  });
});

describe('ConflictResolver — always-fork', () => {
  it('both present → keep remote at original path, fork local as copy', () => {
    const local = enc.encode('local version');
    const remote = enc.encode('remote version');
    const out = resolver.resolve(
      input({ path: 'f.md', kind: 'edit-edit', localBytes: local, remoteBytes: remote }),
      'always-fork',
    );
    ok(out);
    expect(out.action).toBe('write-local');
    expect(out.localBytes).toEqual(remote); // 原路径保留云端
    expect(out.uploadOriginal).toBe(false);
    expect(out.conflictCopies.length).toBe(1);
    expect(out.conflictCopies[0].path).toContain('LOCAL');
    expect(out.conflictCopies[0].bytes).toEqual(local);
  });

  it('only local → re-upload', () => {
    const local = enc.encode('local only');
    const out = resolver.resolve(
      input({ path: 'f.md', kind: 'create-create', localBytes: local, remoteBytes: null }),
      'always-fork',
    );
    ok(out);
    expect(out.action).toBe('upload-local');
    expect(out.uploadOriginal).toBe(true);
  });

  it('only remote → download/restore', () => {
    const remote = enc.encode('remote only');
    const out = resolver.resolve(
      input({ path: 'f.md', kind: 'create-create', localBytes: null, remoteBytes: remote }),
      'always-fork',
    );
    ok(out);
    expect(out.action).toBe('write-local');
    expect(out.localBytes).toEqual(remote);
  });

  it('both deleted → deferred', () => {
    const out = resolver.resolve(
      input({ path: 'f.md', kind: 'unknown', localBytes: null, remoteBytes: null }),
      'always-fork',
    );
    ok(out);
    expect(out.action).toBe('deferred');
  });
});

describe('ConflictResolver — ask-me', () => {
  it('always defers to conflict panel', () => {
    const out = resolver.resolve(
      input({
        path: 'f.md',
        kind: 'edit-edit',
        localBytes: enc.encode('l'),
        remoteBytes: enc.encode('r'),
      }),
      'ask-me',
    );
    ok(out);
    expect(out.action).toBe('deferred');
    expect(out.uploadOriginal).toBe(false);
    expect(out.conflictCopies.length).toBe(0);
  });

  it('unknown strategy defaults to deferred', () => {
    const out = resolver.resolve(
      input({
        path: 'f.md',
        kind: 'edit-edit',
        localBytes: enc.encode('l'),
        remoteBytes: enc.encode('r'),
      }),
      'not-a-strategy' as any,
    );
    ok(out);
    expect(out.action).toBe('deferred');
  });
});
