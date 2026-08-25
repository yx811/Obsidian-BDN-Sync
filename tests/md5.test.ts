import { describe, it, expect } from 'vitest';
import { md5Hex, md5HexOf } from '../src/util/md5';

describe('md5Hex', () => {
  it('matches the canonical MD5 of an empty string', () => {
    expect(md5Hex(new Uint8Array(0))).toBe('d41d8cd98f00b204e9800998ecf8427e');
  });

  it('matches the canonical MD5 of "abc"', () => {
    expect(md5Hex(new TextEncoder().encode('abc'))).toBe('900150983cd24fb0d6963f7d28e17f72');
  });

  it('matches the canonical MD5 of a longer known string', () => {
    const s = 'The quick brown fox jumps over the lazy dog';
    expect(md5Hex(new TextEncoder().encode(s))).toBe('9e107d9d372bb6826bd81d3542a419d6');
  });

  it('handles multi-byte UTF-8 input correctly', () => {
    // 中文「你好」的 UTF-8 编码 MD5（独立用 openssl/在线校验确认为正确值）
    expect(md5Hex(new TextEncoder().encode('你好'))).toBe('7eca689f0d3389d9dea66ae112e5cfd7');
  });

  it('is length-independent of chunking for md5HexOf', () => {
    const data = new TextEncoder().encode('abcdefghijklmnopqrstuvwxyz0123456789');
    const whole = md5Hex(data);
    // 切成 3 段
    const c1 = data.slice(0, 10);
    const c2 = data.slice(10, 25);
    const c3 = data.slice(25);
    expect(md5HexOf([c1, c2, c3])).toBe(whole);
  });
});
