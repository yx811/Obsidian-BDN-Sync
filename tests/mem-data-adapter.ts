// 内存版 Obsidian DataAdapter：支撑 FakeVaultAdapter 与 LocalStore 在 Node 测试环境运行。
// 仅实现 SyncEngine / LocalStore 实际调用到的子集，不追求完整模拟 DataAdapter 全部方法。
import type { DataAdapter, ListedFiles, Stat } from 'obsidian';

export class MemDataAdapter implements DataAdapter {
  /** 绝对路径（带前导 /） → 内容（文本或二进制） */
  private files = new Map<string, Uint8Array>();

  /** 构造时可选预置一批文件（path → 文本） */
  constructor(seed?: Record<string, string>) {
    if (seed) {
      for (const [p, t] of Object.entries(seed)) {
        this.files.set(norm(p), new TextEncoder().encode(t));
      }
    }
  }

  private existsSync(path: string): boolean {
    const p = norm(path);
    if (this.files.has(p)) return true;
    // 目录存在性：是否有任意文件以该前缀开头
    const dirPrefix = p.endsWith('/') ? p : `${p}/`;
    for (const k of this.files.keys()) if (k.startsWith(dirPrefix)) return true;
    return false;
  }

  async exists(path: string): Promise<boolean> {
    return this.existsSync(path);
  }

  async stat(path: string): Promise<Stat> {
    const p = norm(path);
    const content = this.files.get(p);
    if (content !== undefined) {
      return { type: 'file', size: content.length, ctime: 0, mtime: Date.now() };
    }
    if (this.existsSync(p)) {
      return { type: 'folder', size: 0, ctime: 0, mtime: Date.now() };
    }
    throw new Error(`No such file or directory, ${path}`);
  }

  async list(path: string): Promise<ListedFiles> {
    const dir = norm(path);
    const prefix = dir === '/' ? '' : dir.endsWith('/') ? dir : `${dir}/`;
    const files: string[] = [];
    const folders = new Set<string>();
    for (const k of this.files.keys()) {
      if (prefix && !k.startsWith(prefix)) continue;
      // 去掉 prefix 后，rest 可能仍带前导 "/"（根目录 prefix 为空时），统一剥离
      let rest = k.slice(prefix.length);
      if (rest.startsWith('/')) rest = rest.slice(1);
      if (!rest) continue;
      const slash = rest.indexOf('/');
      if (slash >= 0) {
        folders.add(rest.slice(0, slash));
      } else {
        files.push(k);
      }
    }
    return {
      files: [...files].sort(),
      folders: [...folders].sort(),
    };
  }

  async read(path: string): Promise<string> {
    const content = this.files.get(norm(path));
    if (content === undefined) throw new Error(`No such file or directory, ${path}`);
    return new TextDecoder('utf-8').decode(content);
  }

  async write(path: string, data: string): Promise<void> {
    this.files.set(norm(path), new TextEncoder().encode(data));
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const content = this.files.get(norm(path));
    if (content === undefined) throw new Error(`No such file or directory, ${path}`);
    return content.buffer.slice(
      content.byteOffset,
      content.byteOffset + content.byteLength,
    ) as ArrayBuffer;
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.files.set(norm(path), new Uint8Array(data));
  }

  async append(path: string, data: string): Promise<void> {
    const existing = this.files.get(norm(path)) ?? new Uint8Array();
    const merged = new Uint8Array(existing.length + new TextEncoder().encode(data).length);
    merged.set(existing, 0);
    merged.set(new TextEncoder().encode(data), existing.length);
    this.files.set(norm(path), merged);
  }

  async mkdir(_path: string): Promise<void> {
    // 目录是隐式的（由文件前缀决定），无需实际创建
  }

  async rm(path: string): Promise<void> {
    this.files.delete(norm(path));
  }

  async remove(path: string): Promise<void> {
    await this.rm(path);
  }

  /** 测试辅助：直接注入/读取二进制内容（path → Uint8Array） */
  putBinary(path: string, bytes: Uint8Array): void {
    this.files.set(norm(path), bytes);
  }

  getBinary(path: string): Uint8Array | undefined {
    return this.files.get(norm(path));
  }

  /** 测试辅助：列出所有未删除的文件（绝对路径） */
  allPaths(): string[] {
    return [...this.files.keys()].sort();
  }
}

function norm(p: string): string {
  if (!p.startsWith('/')) p = `/${p}`;
  return p.replace(/\/+/g, '/');
}
