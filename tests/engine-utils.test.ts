import { describe, it, expect } from 'vitest';
import { baseName, makeTombstone, summarize, type SyncStats } from '../src/sync/engine';
import { redactSecrets } from '../src/baidu/api';

describe('makeTombstone (B4 墓碑工厂)', () => {
  it('构造的墓碑字段形态一致：mtime/size 归零、deleted 标记齐全', () => {
    const t = makeTombstone('a/b.md', 'dev-1', 'hash-x', 123456);
    expect(t).toEqual({
      path: 'a/b.md',
      mtime: 0,
      size: 0,
      hash: 'hash-x',
      deleted: true,
      deletedAt: 123456,
      deletedBy: 'dev-1',
    });
  });

  it('默认 hash 为空串、deletedAt 为 Date.now()（可注入便于断言）', () => {
    const before = Date.now();
    const t = makeTombstone('c.md', 'dev-2');
    expect(t.hash).toBe('');
    expect(t.deletedAt).toBeGreaterThanOrEqual(before);
    expect(t.deletedBy).toBe('dev-2');
    expect(t.deleted).toBe(true);
  });

  it('两处调用产生的结构等价，避免此前 8 处字面量复制的漂移风险', () => {
    const a = makeTombstone('p', 'd', 'h');
    const b = makeTombstone('p', 'd', 'h');
    expect(a).toEqual(b);
  });
});

describe('baseName (路径末段提取)', () => {
  it('提取末段文件名', () => {
    expect(baseName('a/b/c.md')).toBe('c.md');
  });
  it('无斜杠时返回原串', () => {
    expect(baseName('notes.md')).toBe('notes.md');
  });
  it('保留隐藏文件点前缀判定语义（.obsidian）', () => {
    expect(baseName('.obsidian/config')).toBe('config');
  });
});

describe('redactSecrets (凭证脱敏，安全加固保留)', () => {
  it('脱敏 access_token / BDUSS / STOKEN / refresh_token / client_secret / secretKey', () => {
    const input = JSON.stringify({
      access_token: 'AT-123',
      BDUSS: 'BD-456',
      STOKEN: 'ST-789',
      refresh_token: 'RT-000',
      client_secret: 'CS-abc',
      secretKey: 'SK-def',
      safe: 'keep-me',
    });
    const out = redactSecrets(input);
    expect(out).not.toContain('AT-123');
    expect(out).not.toContain('BD-456');
    expect(out).not.toContain('ST-789');
    expect(out).not.toContain('RT-000');
    expect(out).not.toContain('CS-abc');
    expect(out).not.toContain('SK-def');
    expect(out).toContain('keep-me');
  });

  it('非 JSON 字符串（key=value 形式）也做脱敏，不抛错', () => {
    const out = redactSecrets('access_token=AT-secret&user=alice');
    expect(out).not.toContain('AT-secret');
    expect(out).toContain('access_token=<redacted>');
  });
});

describe('summarize (同步摘要格式化)', () => {
  it('输出包含上传/下载/冲突计数', () => {
    const stats: SyncStats = {
      uploaded: 3,
      downloaded: 2,
      deletedLocal: 1,
      deletedRemote: 0,
      conflicts: 1,
      skipped: 0,
      errors: 0,
      bytesUp: 300,
      bytesDown: 200,
      durationMs: 1500,
    };
    const s = summarize(stats);
    expect(s).toContain('3');
    expect(s).toContain('2');
    expect(s).toContain('1');
  });
});
