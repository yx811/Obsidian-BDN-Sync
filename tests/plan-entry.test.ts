import { describe, it, expect } from 'vitest';
import { planEntry } from '../src/sync/engine';
import type { FileState } from '../src/types';

function fs(path: string, hash: string, over: Partial<FileState> = {}): FileState {
  return { path, mtime: 1, size: 10, hash, byDevice: 'dev', ...over };
}

const base = {
  direction: 'bidirectional' as const,
  deleteStrategy: 'keep-local' as const,
  remoteSize: 10,
};

function first(path: string, ctx: Parameters<typeof planEntry>[1]) {
  return planEntry(path, ctx)[0];
}

// 注意：base 提供默认 direction/deleteStrategy/remoteSize，调用方如需覆盖
// 必须在展开 base 之后再写字段，否则会被 base 的默认值覆盖。

describe('planEntry — bidirectional', () => {
  it('uploads new local file with no remote and no anchor', () => {
    const a = first('a.md', { L: fs('a.md', 'h1'), R: null, S: null, ...base });
    expect(a.type).toBe('upload');
  });

  it('downloads new remote file with no local and no anchor', () => {
    const a = first('b.md', { L: null, R: fs('b.md', 'h2'), S: null, ...base });
    expect(a.type).toBe('download');
  });

  it('deletes local when local-only file matches lastSync (removed remotely)', () => {
    const a = first('c.md', { L: fs('c.md', 'h3'), R: null, S: fs('c.md', 'h3'), ...base });
    expect(a.type).toBe('delete-local');
  });

  it('keeps local modification when remote removed but local changed (keep-local)', () => {
    const a = first('d.md', { L: fs('d.md', 'hNew'), R: null, S: fs('d.md', 'h3'), ...base });
    expect(a.type).toBe('upload');
  });

  it('deletes local modification when remote removed and delete-everywhere', () => {
    const a = first('d.md', {
      ...base,
      L: fs('d.md', 'hNew'),
      R: null,
      S: fs('d.md', 'h3'),
      deleteStrategy: 'delete-everywhere',
    });
    expect(a.type).toBe('delete-local');
  });

  it('restores remote when local removed but remote unchanged', () => {
    const a = first('e.md', { L: null, R: fs('e.md', 'h5'), S: fs('e.md', 'h5'), ...base });
    expect(a.type).toBe('delete-remote');
  });

  it('flags create-create conflict when both new with different hashes', () => {
    const a = first('f.md', { L: fs('f.md', 'hL'), R: fs('f.md', 'hR'), S: null, ...base });
    expect(a.type).toBe('conflict');
    expect(a.kind).toBe('create-create');
  });

  it('skips when local and remote identical and anchored', () => {
    const a = first('g.md', {
      L: fs('g.md', 'h9'),
      R: fs('g.md', 'h9'),
      S: fs('g.md', 'h9'),
      ...base,
    });
    expect(a.type).toBe('skip');
  });

  it('uploads when only local changed', () => {
    const a = first('h.md', {
      L: fs('h.md', 'hNew'),
      R: fs('h.md', 'h9'),
      S: fs('h.md', 'h9'),
      ...base,
    });
    expect(a.type).toBe('upload');
  });

  it('downloads when only remote changed', () => {
    const a = first('i.md', {
      L: fs('i.md', 'h9'),
      R: fs('i.md', 'hNew'),
      S: fs('i.md', 'h9'),
      ...base,
    });
    expect(a.type).toBe('download');
  });

  it('flags edit-edit conflict when both changed differently', () => {
    const a = first('j.md', {
      L: fs('j.md', 'hL'),
      R: fs('j.md', 'hR'),
      S: fs('j.md', 'hS'),
      ...base,
    });
    expect(a.type).toBe('conflict');
    expect(a.kind).toBe('edit-edit');
  });

  it('produces no action when both ends deleted (only anchored)', () => {
    const acts = planEntry('k.md', { L: null, R: null, S: fs('k.md', 'hx'), ...base });
    expect(acts).toHaveLength(0);
  });

  it('downloads when remote hash is empty (stale index) and local unchanged', () => {
    // 远端 hash 不可信（空）但本地与锚点一致 → 视为「远端可能改动，恢复云端」，download
    const a = first('l.md', {
      ...base,
      L: fs('l.md', 'h9'),
      R: fs('l.md', ''),
      S: fs('l.md', 'h9'),
    });
    expect(a.type).toBe('download');
  });
});

describe('planEntry — force-upload (local is truth)', () => {
  it('skips identical files', () => {
    const a = first('a.md', {
      ...base,
      L: fs('a.md', 'h1'),
      R: fs('a.md', 'h1'),
      S: null,
      direction: 'force-upload',
    });
    expect(a.type).toBe('skip');
  });
  it('uploads any local file not identical to remote', () => {
    const a = first('a.md', {
      ...base,
      L: fs('a.md', 'hL'),
      R: fs('a.md', 'hR'),
      S: null,
      direction: 'force-upload',
    });
    expect(a.type).toBe('upload');
  });
  it('deletes remote-only files', () => {
    const a = first('a.md', {
      ...base,
      L: null,
      R: fs('a.md', 'hR'),
      S: null,
      direction: 'force-upload',
    });
    expect(a.type).toBe('delete-remote');
  });
});

describe('planEntry — force-download (remote is truth)', () => {
  it('downloads any remote file not identical to local', () => {
    const a = first('a.md', {
      ...base,
      L: fs('a.md', 'hL'),
      R: fs('a.md', 'hR'),
      S: null,
      direction: 'force-download',
    });
    expect(a.type).toBe('download');
  });
  it('deletes local-only files', () => {
    const a = first('a.md', {
      ...base,
      L: fs('a.md', 'hL'),
      R: null,
      S: null,
      direction: 'force-download',
    });
    expect(a.type).toBe('delete-local');
  });
});
