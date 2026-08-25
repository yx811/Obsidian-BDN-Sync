import { describe, it, expect } from 'vitest';
import {
  parseBdnRef,
  buildBdnRef,
  shouldInlineMedia,
  preloadForKind,
} from '../src/lab/media-bridge';
import type { PreviewTarget } from '../src/ui/file-preview';

// ---- 构造测试用 PreviewTarget ----
function mkTarget(name: string, size = 0): PreviewTarget {
  return { name, fsId: '123', path: `/apps/bdnsync/vault/${name}`, size };
}

describe('parseBdnRef', () => {
  it('解析纯路径引用（无 fsId）', () => {
    const r = parseBdnRef('bdn://images/cat.png');
    expect(r).toEqual({ path: 'images/cat.png' });
  });

  it('解析 fsId|path 形式', () => {
    const r = parseBdnRef('bdn://556677|docs/note.pdf');
    expect(r).toEqual({ fsId: '556677', path: 'docs/note.pdf' });
  });

  it('不带 bdn:// 前缀也能解析', () => {
    const r = parseBdnRef('videos/clip.mp4');
    expect(r).toEqual({ path: 'videos/clip.mp4' });
  });

  it('规整前导斜杠', () => {
    const r = parseBdnRef('bdn:///images/a.png');
    expect(r?.path).toBe('images/a.png');
  });

  it('支持 % 编码路径', () => {
    const r = parseBdnRef('bdn://%E5%9B%BE%E7%89%87/猫.png');
    expect(r?.path).toBe('图片/猫.png');
  });

  it('拒绝反斜杠', () => {
    expect(parseBdnRef('bdn://images\\evil.png')).toBeNull();
  });

  it('拒绝路径穿越 ..', () => {
    expect(parseBdnRef('bdn://images/../secret.png')).toBeNull();
  });

  it('拒绝控制字符', () => {
    expect(parseBdnRef('bdn://images/a\x00.png')).toBeNull();
  });

  it('拒绝坏编码（孤立 %）', () => {
    expect(parseBdnRef('bdn://images/a%.png')).toBeNull();
  });

  it('拒绝空串', () => {
    expect(parseBdnRef('')).toBeNull();
    expect(parseBdnRef('bdn://')).toBeNull();
  });

  it('拒绝超长路径', () => {
    const long = 'a/'.repeat(2000) + 'x.png';
    expect(parseBdnRef('bdn://' + long)).toBeNull();
  });
});

describe('buildBdnRef', () => {
  it('无 fsId 时只输出路径', () => {
    expect(buildBdnRef(undefined, 'images/cat.png')).toBe('bdn://images/cat.png');
  });

  it('有 fsId 时输出 fsId|path', () => {
    expect(buildBdnRef('556677', 'docs/note.pdf')).toBe('bdn://556677|docs/note.pdf');
  });

  it('规整前导斜杠', () => {
    expect(buildBdnRef(undefined, '/images/a.png')).toBe('bdn://images/a.png');
  });

  it('与 parseBdnRef 互逆（round-trip）', () => {
    const ref = buildBdnRef('9', 'a/b/c.png');
    expect(parseBdnRef(ref)).toEqual({ fsId: '9', path: 'a/b/c.png' });
  });
});

describe('shouldInlineMedia', () => {
  const settings = { cloudMediaMaxInlineMB: 50 };

  it('小体积图片应内联', () => {
    expect(shouldInlineMedia(mkTarget('cat.png', 2 * 1024 * 1024), settings)).toBe(true);
  });

  it('pdf 不退化为内联', () => {
    expect(shouldInlineMedia(mkTarget('doc.pdf', 1024), settings)).toBe(false);
  });

  it('office 文件不退化为内联', () => {
    expect(shouldInlineMedia(mkTarget('sheet.xlsx', 1024), settings)).toBe(false);
  });

  it('超体积图片退化为文件卡片', () => {
    expect(shouldInlineMedia(mkTarget('big.png', 80 * 1024 * 1024), settings)).toBe(false);
  });

  it('体积恰好等于阈值仍可内联（严格大于才拦截）', () => {
    expect(shouldInlineMedia(mkTarget('edge.png', 50 * 1024 * 1024), settings)).toBe(true);
  });

  it('阈值=0 表示不限制，超大也可内联', () => {
    expect(
      shouldInlineMedia(mkTarget('huge.mp4', 1024 * 1024 * 1024), { cloudMediaMaxInlineMB: 0 }),
    ).toBe(true);
  });

  it('视频在阈值内可内联', () => {
    expect(shouldInlineMedia(mkTarget('clip.mp4', 10 * 1024 * 1024), settings)).toBe(true);
  });

  it('音频在阈值内可内联', () => {
    expect(shouldInlineMedia(mkTarget('song.mp3', 5 * 1024 * 1024), settings)).toBe(true);
  });
});

describe('preloadForKind', () => {
  it('视频 + 懒加载 → none', () => {
    expect(preloadForKind('video', true)).toBe('none');
  });

  it('视频 + 非懒加载 → metadata', () => {
    expect(preloadForKind('video', false)).toBe('metadata');
  });

  it('图片不设置 preload（返回 none 占位）', () => {
    expect(preloadForKind('image', true)).toBe('none');
    expect(preloadForKind('image', false)).toBe('none');
  });

  it('音频不设置 preload（返回 none 占位）', () => {
    expect(preloadForKind('audio', true)).toBe('none');
  });
});
