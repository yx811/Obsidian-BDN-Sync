import { describe, it, expect } from 'vitest';
import { traverseRemoteTree } from '../src/baidu/adapter';
import { BaiduApiError } from '../src/baidu/api';
import type { RemoteEntry } from '../src/types';

// 可控虚拟目录树：
// /root        -> f1, d1, d2
// /root/d1     -> fd1, d1sub
// /root/d2     -> fd2
// /root/d1/d1sub -> fds
function makeFs() {
  const fs: Record<string, RemoteEntry[]> = {
    '/root': [
      { path: 'f1', name: 'f1', isDir: false, size: 1, mtime: 1, fsId: 1 },
      { path: 'd1', name: 'd1', isDir: true, size: 0, mtime: 1, fsId: 2 },
      { path: 'd2', name: 'd2', isDir: true, size: 0, mtime: 1, fsId: 3 },
    ],
    '/root/d1': [
      { path: 'fd1', name: 'fd1', isDir: false, size: 1, mtime: 1, fsId: 4 },
      { path: 'd1sub', name: 'd1sub', isDir: true, size: 0, mtime: 1, fsId: 5 },
    ],
    '/root/d2': [{ path: 'fd2', name: 'fd2', isDir: false, size: 1, mtime: 1, fsId: 6 }],
    '/root/d1/d1sub': [{ path: 'fds', name: 'fds', isDir: false, size: 1, mtime: 1, fsId: 7 }],
  };
  return fs;
}

describe('traverseRemoteTree 并发遍历', () => {
  it('结果语义与串行一致（按 rel 收集所有文件）', async () => {
    const fs = makeFs();
    const result = await traverseRemoteTree('/root', (dir) => Promise.resolve(fs[dir] ?? []), {
      concurrency: 3,
      indexDir: '.bdnsync',
    });
    expect([...result.keys()].sort()).toEqual(['d1/d1sub/fds', 'd1/fd1', 'd2/fd2', 'f1']);
  });

  it('并发度 > 1 时目录列举确实并发执行（maxInFlight >= 2）', async () => {
    const fs = makeFs();
    let inFlight = 0;
    let maxInFlight = 0;
    const listDir = (dir: string) =>
      new Promise<RemoteEntry[]>((res) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        setTimeout(() => {
          inFlight--;
          res(fs[dir] ?? []);
        }, 20);
      });
    await traverseRemoteTree('/root', listDir, { concurrency: 4, indexDir: '.bdnsync' });
    expect(maxInFlight).toBeGreaterThanOrEqual(2);
  });

  it('目录不存在（errno=-9/-7）被安全跳过，不抛错、不漏其它分支', async () => {
    const fs = makeFs();
    const listDir = (dir: string) => {
      if (dir === '/root/d1') return Promise.reject(new BaiduApiError(-9, 'dir not found'));
      return Promise.resolve(fs[dir] ?? []);
    };
    const result = await traverseRemoteTree('/root', listDir, { concurrency: 2, indexDir: '.bdnsync' });
    // d1 子树应被跳过，仅保留 root 与 d2 下的文件
    expect([...result.keys()].sort()).toEqual(['d2/fd2', 'f1']);
  });

  it('concurrency=1 时严格串行（maxInFlight === 1，且访问 4 个目录）', async () => {
    const fs = makeFs();
    let calls = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const listDir = (dir: string) =>
      new Promise<RemoteEntry[]>((res) => {
        calls++;
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        setTimeout(() => {
          inFlight--;
          res(fs[dir] ?? []);
        }, 10);
      });
    await traverseRemoteTree('/root', listDir, { concurrency: 1, indexDir: '.bdnsync' });
    expect(maxInFlight).toBe(1); // 串行
    expect(calls).toBe(4); // root + d1 + d2 + d1sub
  });

  it('concurrency 非法值（0）回退默认 3，仍正确遍历且并发生效', async () => {
    const fs = makeFs();
    let inFlight = 0;
    let maxInFlight = 0;
    const listDir = (dir: string) =>
      new Promise<RemoteEntry[]>((res) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        setTimeout(() => {
          inFlight--;
          res(fs[dir] ?? []);
        }, 15);
      });
    const result = await traverseRemoteTree('/root', listDir, { concurrency: 0, indexDir: '.bdnsync' });
    expect([...result.keys()].sort()).toEqual(['d1/d1sub/fds', 'd1/fd1', 'd2/fd2', 'f1']);
    expect(maxInFlight).toBeGreaterThanOrEqual(2); // 0 回退到默认 3，确实并发
  });

  it('indexDir 子树被跳过', async () => {
    const fs = makeFs();
    fs['/root'].push({ path: '.bdnsync', name: '.bdnsync', isDir: true, size: 0, mtime: 1, fsId: 99 });
    const result = await traverseRemoteTree('/root', (dir) => Promise.resolve(fs[dir] ?? []), {
      concurrency: 3,
      indexDir: '.bdnsync',
    });
    expect([...result.keys()]).not.toContain('.bdnsync/index.json');
    expect(result.has('.bdnsync')).toBe(false);
  });
});
