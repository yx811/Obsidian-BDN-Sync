import { describe, it, expect } from 'vitest';
import { PathFilter } from '../src/util/misc';
import { makeSettings } from './helpers';

describe('PathFilter.isExcluded', () => {
  it('always excludes system dirs regardless of settings', () => {
    const f = new PathFilter(makeSettings({ syncConfigDir: false }));
    expect(f.isExcluded('.trash/foo.md')).toBe(true);
    expect(f.isExcluded('.bdnsync/meta.json')).toBe(true);
  });

  it('excludes .obsidian by default but includes when syncConfigDir is on', () => {
    const off = new PathFilter(makeSettings({ syncConfigDir: false }));
    expect(off.isExcluded('.obsidian/plugins/x/plugin.json')).toBe(true);
    const on = new PathFilter(makeSettings({ syncConfigDir: true }));
    expect(on.isExcluded('.obsidian/plugins/x/plugin.json')).toBe(false);
  });

  it('excludes .obsidian/workspace when syncing config dir', () => {
    const on = new PathFilter(makeSettings({ syncConfigDir: true }));
    expect(on.isExcluded('.obsidian/workspace')).toBe(true);
    expect(on.isExcluded('.obsidian/workspace.json')).toBe(true);
  });

  it('excludes hidden files when skipHiddenFiles is on', () => {
    const f = new PathFilter(makeSettings({ skipHiddenFiles: true }));
    expect(f.isExcluded('notes/.secret')).toBe(true);
    expect(f.isExcluded('.gitignore')).toBe(true);
    expect(f.isExcluded('normal/note.md')).toBe(false);
  });

  it('honours user glob patterns', () => {
    const f = new PathFilter(makeSettings({ excludePatterns: ['*.tmp', 'drafts/**'] }));
    expect(f.isExcluded('a.tmp')).toBe(true);
    expect(f.isExcluded('drafts/idea.md')).toBe(true);
    expect(f.isExcluded('notes/keep.md')).toBe(false);
  });

  it('treats backslashes as path separators', () => {
    const f = new PathFilter(makeSettings({ syncConfigDir: false }));
    expect(f.isExcluded('.obsidian\\plugins\\x')).toBe(true);
  });
});

describe('PathFilter.isOversized', () => {
  it('flags files larger than maxFileSizeMB', () => {
    const f = new PathFilter(makeSettings({ maxFileSizeMB: 10 }));
    expect(f.isOversized(9 * 1024 * 1024)).toBe(false);
    expect(f.isOversized(11 * 1024 * 1024)).toBe(true);
  });
});
