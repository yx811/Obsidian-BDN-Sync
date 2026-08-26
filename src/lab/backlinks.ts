/**
 * 实验室功能 2：网盘文件反向引用（Backlinks）
 *
 * MediaBridge 让「笔记 → 网盘文件」单向可达（bdn:// 引用）。本模块补齐反向链路：
 * 扫描 vault 内所有 Markdown，抽取其中的 bdn:// 引用，建立「网盘文件 → 引用它的笔记」索引，
 * 在文件预览 / 网盘浏览器中展示「哪些笔记引用了此文件」，点击即可跳回对应笔记。
 *
 * 设计约束（与 MediaBridge 一致）：
 * - 纯本地扫描，绝不触网；
 * - 任何异常均吞掉，不抛给调用方；
 * - 索引带 TTL 缓存，避免每次打开都全量扫描；
 * - vault 变更（create/modify/delete/rename）经 debounce 后增量重建。
 */
import { normalizePath } from 'obsidian';
import type BDNSyncPlugin from '../main';
import type { PreviewTarget } from '../ui/file-preview';
import { parseBdnRef } from './media-bridge';

/** 单条反向引用记录 */
export interface BacklinkRef {
  /** 引用该文件的笔记路径（vault 相对） */
  notePath: string;
  /** 命中行号（1-based），用于跳转后定位 */
  line: number;
  /** 原始 bdn:// 引用文本 */
  raw: string;
}

/** 索引结构：key = fsId 或 remotePath；value = 引用列表 */
interface BacklinkIndex {
  ts: number;
  /** fsId -> refs */
  byFsId: Record<string, BacklinkRef[]>;
  /** 规整后的 remotePath -> refs */
  byPath: Record<string, BacklinkRef[]>;
}

const INDEX_FILE = 'lab-backlinks.json';
const INDEX_TTL = 1000 * 60 * 30; // 30 分钟

// 模块级复用：匹配 bdn:// 引用（行内或链接目标）。带 g 标志须在每次使用前重置 lastIndex。
// 用 RegExp 构造避开单/双引号嵌套的歧义，字符类内只对 \ / ] 做必要转义。
const BDNSYNC_REF_RE = /bdn:\/\/[^\s)\]>"']+/g;

function indexKeyFsId(fsId: string): string {
  return `fs:${fsId}`;
}
function indexKeyPath(p: string): string {
  return `path:${normalizePath(p).replace(/^\/+/, '')}`;
}

/**
 * 扫描整个 vault，构建反向引用索引。耗时操作，调用方应自行考虑节流。
 * 返回索引对象；失败返回空索引（不抛）。
 */
export async function buildBacklinkIndex(plugin: BDNSyncPlugin): Promise<BacklinkIndex> {
  const index: BacklinkIndex = { ts: Date.now(), byFsId: {}, byPath: {} };
  try {
    const files = plugin.app.vault.getMarkdownFiles();
    for (const file of files) {
      let content: string;
      try {
        content = await plugin.app.vault.cachedRead(file);
      } catch {
        continue;
      }
      const lines = content.split('\n');
      lines.forEach((lineText, i) => {
        BDNSYNC_REF_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = BDNSYNC_REF_RE.exec(lineText)) !== null) {
          const ref = parseBdnRef(m[0]);
          if (!ref) continue;
          const rec: BacklinkRef = {
            notePath: file.path,
            line: i + 1,
            raw: m[0],
          };
          if (ref.fsId) {
            const k = indexKeyFsId(ref.fsId);
            (index.byFsId[k] ||= []).push(rec);
          }
          if (ref.path) {
            const k = indexKeyPath(ref.path);
            (index.byPath[k] ||= []).push(rec);
          }
        }
      });
    }
  } catch {
    /* 忽略整个扫描的异常 */
  }
  return index;
}

/** 取（或惰性重建）反向引用索引，带 TTL 缓存 */
export async function getBacklinkIndex(plugin: BDNSyncPlugin): Promise<BacklinkIndex> {
  try {
    const cached = await plugin.store.readJson<BacklinkIndex>(INDEX_FILE);
    if (cached && cached.ts && Date.now() - cached.ts < INDEX_TTL) {
      return cached;
    }
  } catch {
    /* 缓存读取失败，重新构建 */
  }
  const fresh = await buildBacklinkIndex(plugin);
  try {
    await plugin.store.writeJson(INDEX_FILE, fresh);
  } catch {
    /* 持久化失败不致命 */
  }
  return fresh;
}

/** 强制重建并持久化索引（vault 变更后调用） */
export async function rebuildBacklinkIndex(plugin: BDNSyncPlugin): Promise<BacklinkIndex> {
  const fresh = await buildBacklinkIndex(plugin);
  try {
    await plugin.store.writeJson(INDEX_FILE, fresh);
  } catch {
    /* ignore */
  }
  return fresh;
}

/**
 * 查某个网盘文件被哪些笔记引用。
 * 优先按 fsId 匹配，其次按 path 匹配（fsId 缺失的引用）。
 */
export async function findBacklinks(
  plugin: BDNSyncPlugin,
  target: PreviewTarget,
): Promise<BacklinkRef[]> {
  const idx = await getBacklinkIndex(plugin);
  const out: BacklinkRef[] = [];
  const seen = new Set<string>();
  const pushUnique = (arr?: BacklinkRef[]) => {
    if (!arr) return;
    for (const r of arr) {
      const key = `${r.notePath}#${r.line}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(r);
      }
    }
  };
  if (target.fsId) pushUnique(idx.byFsId[indexKeyFsId(target.fsId)]);
  if (target.path) pushUnique(idx.byPath[indexKeyPath(target.path)]);
  return out;
}

/**
 * 在给定容器里渲染「引用此文件的笔记」区块。
 * 无引用时渲染空态；点击条目跳回对应笔记并定位行。
 * 调用方保证 container 已 empty 或本函数自行创建子节点。
 */
export async function renderBacklinks(
  plugin: BDNSyncPlugin,
  container: HTMLElement,
  target: PreviewTarget,
): Promise<void> {
  const section = container.createDiv({ cls: 'bdnsync-bd-backlinks' });
  const title = section.createDiv({ cls: 'bdnsync-bd-backlinks-title' });
  title.textContent = '引用此文件的笔记';

  let refs: BacklinkRef[] = [];
  try {
    refs = await findBacklinks(plugin, target);
  } catch {
    refs = [];
  }

  if (refs.length === 0) {
    const empty = section.createDiv({ cls: 'bdnsync-bd-backlinks-empty' });
    empty.textContent = '暂无笔记引用此文件';
    return;
  }

  const list = section.createDiv({ cls: 'bdnsync-bd-backlinks-list' });
  for (const ref of refs) {
    const item = list.createDiv({ cls: 'bdnsync-bd-backlinks-item' });
    const name = ref.notePath.split('/').pop() || ref.notePath;
    const link = item.createEl('a', {
      cls: 'bdnsync-bd-backlinks-link',
      text: name,
      attr: { title: `${ref.notePath} (行 ${ref.line})` },
    });
    const sub = item.createSpan({ cls: 'bdnsync-bd-backlinks-sub' });
    sub.textContent = `行 ${ref.line}`;
    link.addEventListener('click', (e) => {
      e.preventDefault();
      void plugin.app.workspace.openLinkText(ref.notePath, '', false);
    });
  }
}

/** 仅同步判定：目标是否被引用（供其它模块快速判断，不渲染） */
export async function hasBacklinks(plugin: BDNSyncPlugin, target: PreviewTarget): Promise<boolean> {
  const refs = await findBacklinks(plugin, target);
  return refs.length > 0;
}
