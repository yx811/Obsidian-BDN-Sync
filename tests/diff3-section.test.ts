// diff3 分段合并（sectionMerge）与冲突块提取（extractConflictSections）单测
import { describe, expect, it } from 'vitest';
import { extractConflictSections, sectionMerge, threeWayMerge } from '../src/util/diff3';

describe('extractConflictSections 冲突块解析', () => {
  it('解析带标记文本的冲突块（精确行区间 + 两端内容）', () => {
    const text = [
      '# 标题',
      '',
      '<<<<<<< LOCAL (设备A)',
      '本地内容行',
      '=======',
      '远端内容行',
      '>>>>>>> REMOTE (设备B)',
      '',
      '公共尾部',
    ].join('\n');
    const sections = extractConflictSections(text, '设备A', '设备B');
    expect(sections.length).toBe(1);
    const sec = sections[0];
    expect(sec.local).toEqual(['本地内容行']);
    expect(sec.remote).toEqual(['远端内容行']);
    // blockStart 指向 <<<<<<< 行，blockEnd 指向 >>>>>>> 之后
    expect(sec.blockStart).toBe(2);
    expect(sec.blockEnd).toBe(7);
    // 上下文扩展：向上遇到空行边界即停（不含空行本身），向下遇到空行即停
    expect(sec.contextStart).toBe(2);
    expect(sec.contextEnd).toBe(7);
  });

  it('多段冲突 → 返回多个 section', () => {
    const mk = (i: number) =>
      [
        `<<<<<<< LOCAL (A)`,
        `L${i}`,
        '=======',
        `R${i}`,
        `>>>>>>> REMOTE (B)`,
      ].join('\n');
    const sections = extractConflictSections(`${mk(1)}\n\n${mk(2)}`, 'A', 'B');
    expect(sections.length).toBe(2);
  });

  it('无标记 → 空数组', () => {
    expect(extractConflictSections('hello\nworld', 'A', 'B')).toEqual([]);
  });

  it('CRLF 文本也能正确解析（审计 #5）', () => {
    const text = [
      '<<<<<<< LOCAL (设备A)\r',
      '本地行\r',
      '=======\r',
      '远端行\r',
      '>>>>>>> REMOTE (设备B)\r',
    ].join('\n');
    const sections = extractConflictSections(text, '设备A', '设备B');
    expect(sections.length).toBe(1);
    expect(sections[0].local).toEqual(['本地行\r']);
    expect(sections[0].remote).toEqual(['远端行\r']);
  });

  it('正文含 `<<<<<<< 设备A` 不误触发（审计 #8 精确匹配）', () => {
    const text = ['正文第一行', '<<<<<<< 设备A', '正文第二行'].join('\n');
    expect(extractConflictSections(text, '设备A', '设备B')).toEqual([]);
  });
});

describe('sectionMerge 分段合并', () => {
  const base = ['# 标题', '', '第一段第一行', '第一段第二行', '', '第二段', '内容'].join('\n');

  it('无冲突（仅一方修改）→ hasConflict=false 且无 sections', () => {
    const local = base.replace('第一段第二行', '本地改了这一行');
    const r = sectionMerge(base, local, base, '设备A', '设备B');
    expect(r.hasConflict).toBe(false);
    expect(r.conflictSections).toEqual([]);
    expect(r.merged).toContain('本地改了这一行');
  });

  it('同文件不同段并发修改 → 自动合并，无冲突', () => {
    const local = base.replace('第一段第二行', 'A 改第一段');
    const remote = base.replace('第二段\n内容', '第二段\nB 改第二段');
    const r = sectionMerge(base, local, remote, '设备A', '设备B');
    expect(r.hasConflict).toBe(false);
    expect(r.merged).toContain('A 改第一段');
    expect(r.merged).toContain('B 改第二段');
  });

  it('同一段同位置修改 → 冲突标记 + 可提取 sections', () => {
    const local = base.replace('第一段第一行', 'A 的内容');
    const remote = base.replace('第一段第一行', 'B 的内容');
    const r = sectionMerge(base, local, remote, '设备A', '设备B');
    expect(r.hasConflict).toBe(true);
    expect(r.merged).toContain('<<<<<<<');
    expect(r.conflictSections.length).toBeGreaterThanOrEqual(1);
    expect(r.conflictSections[0].local.some((l) => l.includes('A 的内容'))).toBe(true);
  });

  it('无 base → 走 unionMerge 仍能返回结构化 sections', () => {
    const a = ['行1', 'A 独有'].join('\n');
    const b = ['行1', 'B 独有'].join('\n');
    const r = sectionMerge(null, a, b, 'A', 'B');
    expect(r.hasConflict).toBe(true);
    expect(r.conflictSections.length).toBeGreaterThanOrEqual(1);
  });

  it('与 threeWayMerge 结果一致（兼容性）', () => {
    const local = base.replace('第一段第二行', 'A 改');
    const remote = base.replace('第一段第二行', 'B 改');
    const t = threeWayMerge(base, local, remote, 'A', 'B');
    const s = sectionMerge(base, local, remote, 'A', 'B');
    expect(s.merged).toBe(t.merged);
    expect(s.hasConflict).toBe(t.hasConflict);
  });
});
