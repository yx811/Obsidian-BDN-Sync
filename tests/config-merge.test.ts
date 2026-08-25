// 配置字段级合并（.obsidian）纯函数单测
import { describe, expect, it } from 'vitest';
import { classifyConfigPath, mergeConfigTexts } from '../src/util/config-merge';

describe('classifyConfigPath 配置类型识别', () => {
  it('识别各类配置文件', () => {
    expect(classifyConfigPath('.obsidian/workspace.json')).toBe('workspace');
    expect(classifyConfigPath('.obsidian/app.json')).toBe('app');
    expect(classifyConfigPath('.obsidian/community-plugins.json')).toBe('community-plugins');
    expect(classifyConfigPath('.obsidian/plugins/dataview/data.json')).toBe('plugin-config');
    expect(classifyConfigPath('.obsidian/appearance.json')).toBe('other');
    expect(classifyConfigPath('notes/foo.md')).toBeNull();
    expect(classifyConfigPath('.obsidian/plugins/bdnsync/data.json')).toBe('plugin-config');
  });
});

describe('mergeConfigTexts community-plugins 并集合并', () => {
  it('两端启用的插件取并集', () => {
    const local = JSON.stringify(['dataview', 'obsidian-git']);
    const remote = JSON.stringify(['dataview', 'calendar']);
    const r = mergeConfigTexts('community-plugins', local, remote, true);
    expect(r.strategy).toBe('plugin-union');
    expect(r.hasConflict).toBe(false);
    const list = JSON.parse(r.merged as string);
    expect(new Set(list)).toEqual(new Set(['dataview', 'obsidian-git', 'calendar']));
  });

  it('同一份内容 → 直接返回', () => {
    const text = JSON.stringify(['a']);
    const r = mergeConfigTexts('community-plugins', text, text, true);
    expect(r.merged).toBe(text);
  });

  it('任一端非数组 → 拒绝合并（merged=null）', () => {
    const r = mergeConfigTexts('community-plugins', '{"a":1}', JSON.stringify(['x']), true);
    expect(r.merged).toBeNull();
    expect(r.hasConflict).toBe(true);
  });
});

describe('mergeConfigTexts workspace 字段级合并', () => {
  const local = JSON.stringify({ lastOpenFiles: ['a.md'], cssTheme: 'dark', main: { x: 1 } });
  const remote = JSON.stringify({ lastOpenFiles: ['b.md'], cssTheme: 'dark', active: 'b.md' });

  it('白名单字段不同 → 标冲突但保留双方 key（LWW 取较新侧）', () => {
    const r = mergeConfigTexts('workspace', local, remote, false); // remote 较新
    expect(r.strategy).toBe('field-merge');
    const obj = JSON.parse(r.merged as string);
    // LWW：取较新（remote）的 lastOpenFiles
    expect(obj.lastOpenFiles).toEqual(['b.md']);
    // 非白名单字段 main 整字段 LWW（remote 无 main → 并入 local 的 main）
    expect(obj.main).toEqual({ x: 1 });
    // active 仅 remote 有 → 保留
    expect(obj.active).toBe('b.md');
    // lastOpenFiles 两端不同 → 冲突标记
    expect(r.conflictFields).toContain('lastOpenFiles');
  });

  it('不同字段各自修改 → 自动合并且无冲突', () => {
    const a = JSON.stringify({ lastOpenFiles: ['x.md'] });
    const b = JSON.stringify({ cssTheme: 'light' });
    const r = mergeConfigTexts('workspace', a, b, true);
    const obj = JSON.parse(r.merged as string);
    expect(obj.lastOpenFiles).toEqual(['x.md']);
    expect(obj.cssTheme).toBe('light');
    expect(r.hasConflict).toBe(false);
  });

  it('JSON 解析失败 → 拒绝合并（merged=null）', () => {
    const r = mergeConfigTexts('workspace', '{broken', '{"a":1}', true);
    expect(r.merged).toBeNull();
    expect(r.hasConflict).toBe(true);
  });
});

describe('mergeConfigTexts plugin-config 整文件 LWW', () => {
  it('无白名单 → 直接取较新 mtime 侧', () => {
    const a = '{"showAll":true}';
    const b = '{"showAll":false,"extra":1}';
    const r = mergeConfigTexts('plugin-config', a, b, false); // remote 较新
    expect(r.strategy).toBe('lww');
    expect(JSON.parse(r.merged as string)).toEqual({ showAll: false, extra: 1 });
  });
});

describe('mergeConfigTexts app 字段级合并', () => {
  it('appearance 子树一层合并', () => {
    const a = JSON.stringify({ appearance: { theme: 'obsidian', accent: 'red' }, editor: { spellcheck: true } });
    const b = JSON.stringify({ appearance: { theme: 'obsidian', baseFontSize: 16 } });
    const r = mergeConfigTexts('app', a, b, true);
    const obj = JSON.parse(r.merged as string);
    expect(obj.appearance.theme).toBe('obsidian');
    // 双方同 key 不同值（accent vs 无）→ LWW 保留较新侧 + baseFontSize 并入
    expect(obj.appearance.baseFontSize).toBe(16);
    expect(obj.editor).toEqual({ spellcheck: true });
  });
});
