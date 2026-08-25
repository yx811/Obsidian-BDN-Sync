// log-message-parse 单元测试：覆盖 Logger.log 以 Error 记录时的三段提炼
// （一句话结论 / 关键上下文 / 技术堆栈），以及冗长堆栈截断、重复 Error 标题去重。

import { describe, expect, it } from 'vitest';
import { parseLogMessage } from '../src/util/logger';

describe('parseLogMessage：日志内容三段提炼', () => {
  it('纯文本消息：整行作为结论，无上下文/堆栈', () => {
    const r = parseLogMessage('上传成功：notes/todo.md');
    expect(r.summary).toBe('上传成功：notes/todo.md');
    expect(r.context).toEqual([]);
    expect(r.stack).toEqual([]);
  });

  it('含换行但无 at 堆栈：首行为结论，其余为上下文', () => {
    const raw = '清理完成\n共删除 3 个孤儿目录\n跳过 1 个受保护目录';
    const r = parseLogMessage(raw);
    expect(r.summary).toBe('清理完成');
    expect(r.context).toEqual(['共删除 3 个孤儿目录', '跳过 1 个受保护目录']);
    expect(r.stack).toEqual([]);
  });

  it('Error 风格堆栈：首行结论 + 去重 Error 标题 + at 行归为堆栈', () => {
    const raw =
      '文件读取失败' +
      '\nError: 文件读取失败' +
      '\n    at Object.read (/app/io.js:12:3)' +
      '\n    at async sync (/app/engine.js:40:5)';
    const r = parseLogMessage(raw);
    expect(r.summary).toBe('文件读取失败');
    // 与结论重复的 "Error: 文件读取失败" 应被剔除
    expect(r.context).toEqual([]);
    expect(r.stack).toEqual([
      'at Object.read (/app/io.js:12:3)',
      'at async sync (/app/engine.js:40:5)',
    ]);
  });

  it('上下文行与堆栈行混合：正确分流', () => {
    const raw =
      '同步中断' +
      '\nerrno=-7 文件或目录名不合法' +
      '\n    at upload (/app/net.js:8:1)' +
      '\n    at main (/app/main.js:2:1)';
    const r = parseLogMessage(raw);
    expect(r.summary).toBe('同步中断');
    expect(r.context).toEqual(['errno=-7 文件或目录名不合法']);
    expect(r.stack.length).toBe(2);
  });

  it('超长堆栈：仅保留前 30 帧，避免冗长 dump', () => {
    const lines = ['触发异常'];
    for (let i = 0; i < 80; i++) lines.push(`    at frame${i} (/app/f.js:${i}:1)`);
    const raw = lines.join('\n');
    const r = parseLogMessage(raw);
    expect(r.summary).toBe('触发异常');
    expect(r.stack.length).toBe(30);
    expect(r.stack[0]).toBe('at frame0 (/app/f.js:0:1)');
  });

  it('空字符串：结论为空，无副作用', () => {
    const r = parseLogMessage('');
    expect(r.summary).toBe('');
    expect(r.context).toEqual([]);
    expect(r.stack).toEqual([]);
  });

  it('保留与结论不重复的 Error 行作为上下文', () => {
    const raw = '操作失败\nError: 网络超时' + '\n    at x (/a.js:1:1)';
    const r = parseLogMessage(raw);
    expect(r.summary).toBe('操作失败');
    // "Error: 网络超时" 与结论不同 → 作为上下文保留
    expect(r.context).toEqual(['Error: 网络超时']);
    expect(r.stack).toEqual(['at x (/a.js:1:1)']);
  });
});
