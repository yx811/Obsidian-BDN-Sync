/**
 * 实验室功能（#5.9）：基于 Git 差异的增量同步变更源
 *
 * 对开启了 Git 的 Vault，用 `git status --porcelain -uall`（working tree 相对 HEAD 的改动，
 * 含未跟踪文件）作为变更清单，**跳过全量文件系统扫描**，对大 vault 显著提升速度。
 *
 * 设计约束（来自 docs/功能可行性分析.md §5.9）：
 * - **仅桌面可用**：移动端无 git 二进制 / child_process，须 Platform.isDesktop 门控，
 *   移动端回退到 watcher/扫描。
 * - **只读 Git**：BDNSync 只读取 Git 状态，**绝不自动 commit**；若同时开启 Git 协同需约定
 *   提交职责，避免「上传 ↔ 提交」循环。
 * - **覆盖完整性**：`git status --porcelain -uall` 同时覆盖「已跟踪改动」与「新增未 add 文件」，
 *   避免漏同步；若设置了 lastGitSyncRef，再并入 `git diff --name-only <ref> HEAD` 的已提交区间。
 * - **可测试**：变更采集通过可注入的 GitRunner 抽象，便于单测（不依赖真实 git 环境）。
 *
 * 接入方式：采集到的路径集合直接喂给引擎 `syncSubset(paths)`（#3.6 增量入口同一通道），
 * 与 watcher 增量 / 扫描增量三者统一为「变更源」抽象。
 */

import { Platform } from 'obsidian';

/** 一次 git 调用的结果 */
export interface GitRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** 可注入的 git 执行器（便于单测 mock，同步） */
export interface GitRunner {
  run(args: string[], cwd: string): GitRunResult;
}

/** 异步 git 执行器（生产默认，避免阻塞 UI 线程） */
export interface AsyncGitRunner {
  run(args: string[], cwd: string): Promise<GitRunResult>;
}

/** 默认执行器：桌面端通过 child_process.spawnSync 调 git（懒加载，避免移动端加载崩溃） */
function defaultRunner(): GitRunner {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cp = (globalThis as any).require?.('child_process');
  if (!cp || typeof cp.spawnSync !== 'function') {
    return {
      run: () => ({ ok: false, stdout: '', stderr: 'child_process unavailable' }),
    };
  }
  return {
    run(args: string[], cwd: string): GitRunResult {
      try {
        const r = cp.spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 20000 });
        if (r.error) return { ok: false, stdout: '', stderr: String(r.error) };
        return {
          ok: r.status === 0,
          stdout: typeof r.stdout === 'string' ? r.stdout : '',
          stderr: typeof r.stderr === 'string' ? r.stderr : '',
        };
      } catch (e) {
        return { ok: false, stdout: '', stderr: String(e) };
      }
    },
  };
}

/**
 * 异步默认执行器：桌面端通过 child_process.spawn 调 git（懒加载）。
 * 与同步 defaultRunner 的语义一致，但用事件驱动 + Promise 包裹，
 * 不再阻塞 Obsidian 主线程（大库 git status 可能耗时数秒）。
 */
function defaultAsyncRunner(): AsyncGitRunner {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cp = (globalThis as any).require?.('child_process');
  if (!cp || typeof cp.spawn !== 'function') {
    return {
      run: async () => ({ ok: false, stdout: '', stderr: 'child_process unavailable' }),
    };
  }
  return {
    run(args: string[], cwd: string): Promise<GitRunResult> {
      return new Promise<GitRunResult>((resolve) => {
        let stdout = '';
        let stderr = '';
        let settled = false;
        const finish = (ok: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ ok, stdout, stderr });
        };
        const child = cp.spawn('git', args, { cwd });
        const timer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* ignore */
          }
          stderr += '\n[git 调用超时（20s）]';
          finish(false);
        }, 20000);
        child.stdout?.on('data', (d: Buffer) => {
          stdout += d.toString('utf8');
        });
        child.stderr?.on('data', (d: Buffer) => {
          stderr += d.toString('utf8');
        });
        child.on('error', (e: Error) => {
          stderr += String(e);
          finish(false);
        });
        child.on('close', (code: number) => {
          finish(code === 0);
        });
      });
    },
  };
}

/** 采集结果 */
export interface GitChangeSet {
  /** vault 相对路径集合（已去重、已过滤系统目录） */
  paths: string[];
  /** 当前 HEAD sha（同步成功后可记为 lastGitSyncRef） */
  head: string | null;
  /** git 仓库根（绝对路径） */
  repoRoot: string;
  /** 是否因缺少 lastGitSyncRef 而仅取 working tree 范围（true = 未用「上次同步后」区间） */
  usedFallback: boolean;
}

/**
 * 解析 `git status --porcelain -uall` 输出，返回受影响的（相对仓库根）路径列表。
 * 覆盖：修改/新增/删除/重命名/类型变更等各类状态码，以及未跟踪文件（??）。
 */
export function parsePorcelain(out: string): string[] {
  const paths: string[] = [];
  for (const rawLine of out.split('\n')) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    // 状态码占前两列（XY），之后可能有一个空格，再是路径
    const code = line.slice(0, 2);
    const body = line.slice(2).replace(/^ /, '');
    if (!body) continue;
    const unquote = (s: string): string =>
      s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;
    // 重命名（R）/ 复制（C）才按 ` -> ` 拆分；普通文件若名字本身含 ` -> `（git 会加引号输出），
    // 必须走引号分支，否则会被误拆成两个路径。
    const isRenameLike = code.includes('R') || code.includes('C');
    if (isRenameLike && body.includes(' -> ')) {
      const [oldP, newP] = body.split(' -> ');
      if (oldP) paths.push(unquote(oldP.trim()));
      if (newP) paths.push(unquote(newP.trim()));
    } else if (body.startsWith('"') && body.endsWith('"')) {
      // 带引号（含空格/特殊字符）的路径
      paths.push(body.slice(1, -1));
    } else {
      paths.push(body);
    }
  }
  return paths;
}

/**
 * 把「相对 git 仓库根」的路径集合，转换为「相对 vault 根」的路径集合。
 * 若 vault 是仓库的子目录，则剥离 vault 子目录前缀；仓库外的路径被丢弃。
 */
export function relativeToVault(
  repoRoot: string,
  vaultPath: string,
  gitPaths: string[],
): string[] {
  const norm = (p: string): string => {
    const s = p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '');
    return s;
  };
  const repo = norm(repoRoot);
  const vault = norm(vaultPath);
  let prefix = '';
  if (vault !== repo) {
    if (vault.startsWith(repo + '/')) {
      prefix = vault.slice(repo.length + 1) + '/';
    } else {
      // vault 与仓库不在同一棵子树（罕见）：无法安全对齐，原样返回（调用方按 vault 根对齐）
      prefix = '';
    }
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (let p of gitPaths) {
    // git 对目录的表示常以 '/' 结尾（如 rename 的目录或 untracked 目录），目录本身不参与同步
    if (p.endsWith('/') || p.endsWith('\\')) continue;
    p = norm(p);
    let rel: string;
    if (prefix && p.startsWith(prefix)) rel = p.slice(prefix.length);
    else if (prefix && p === prefix.replace(/\/$/, '')) continue; // vault 根目录本身
    else if (!prefix) rel = p;
    else continue; // 仓库内但 vault 外
    if (!rel || rel.endsWith('/')) continue; // 空或纯目录
    if (rel.startsWith('.git/') || rel === '.git') continue;
    if (!seen.has(rel)) {
      seen.add(rel);
      out.push(rel);
    }
  }
  return out;
}

/** 是否处于桌面端且具备 git（懒探测：跑一次 rev-parse） */
export async function isGitRepo(vaultPath: string): Promise<boolean> {
  if (!Platform.isDesktop) return false;
  const runner = defaultRunner();
  const r = runner.run(['rev-parse', '--is-inside-work-tree'], vaultPath);
  return r.ok;
}

/**
 * Git 变更源：采集「自上次同步以来」的变更路径集合。
 * - 若 lastRef 有效：并集 = (git diff --name-only <lastRef> HEAD) ∪ (git status --porcelain -uall)
 * - 否则：仅用 git status --porcelain -uall（working tree 范围），usedFallback=true
 * 非 git 仓库 / 非桌面端返回 null（调用方应回退常规同步）。
 */
export class GitChangeSource {
  constructor(
    private vaultPath: string,
    private lastRef?: string,
    private runner?: GitRunner,
    private asyncRunner?: AsyncGitRunner,
  ) {}

  private getRunner(): GitRunner {
    return this.runner ?? defaultRunner();
  }

  private getAsyncRunner(): AsyncGitRunner {
    return this.asyncRunner ?? defaultAsyncRunner();
  }

  /** 统一执行入口：测试注入的同步 runner 优先（保持单测兼容），否则走异步 spawn（不阻塞 UI 线程） */
  private async runGit(args: string[]): Promise<GitRunResult> {
    if (this.runner) return this.runner.run(args, this.vaultPath);
    return this.getAsyncRunner().run(args, this.vaultPath);
  }

  async collect(): Promise<GitChangeSet | null> {
    if (!Platform.isDesktop) return null;

    const top = await this.runGit(['rev-parse', '--show-toplevel']);
    if (!top.ok) return null;
    const repoRoot = top.stdout.trim().replace(/\\/g, '/').replace(/\/+$/, '');
    if (!repoRoot) return null;

    const headRes = await this.runGit(['rev-parse', 'HEAD']);
    const head = headRes.ok ? headRes.stdout.trim() : null;

    const paths = new Set<string>();

    // 1) 已提交区间（上次同步 ref → 当前 HEAD）
    const usedFallback = !this.lastRef;
    if (this.lastRef) {
      const diff = await this.runGit(['diff', '--name-only', this.lastRef, 'HEAD']);
      if (diff.ok) {
        for (const p of diff.stdout.split('\n')) {
          const t = p.trim();
          if (t) paths.add(t);
        }
      }
    }

    // 2) working tree 相对 HEAD 的改动（含未跟踪、重命名）
    const status = await this.runGit(['status', '--porcelain', '-uall']);
    if (!status.ok) {
      // status 失败且没有任何区间结果 → 无法界定变更
      if (paths.size === 0) return null;
    } else {
      for (const p of parsePorcelain(status.stdout)) paths.add(p);
    }

    const vaultPaths = relativeToVault(repoRoot, this.vaultPath, Array.from(paths));
    return {
      paths: vaultPaths,
      head,
      repoRoot,
      usedFallback,
    };
  }
}
