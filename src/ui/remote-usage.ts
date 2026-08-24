// 远程目录占用明细面板：基于 listTree 统计同步根目录按类型/按顶层目录的空间占用。

import { App, Modal } from 'obsidian';
import { formatBytes } from '../util/misc';
import { createCard, createModalHeader, createSection, setIcon } from './components';
import { BaiduApi } from '../baidu/api';
import type { RemoteEntry } from '../types';

const TYPE_GROUPS: { label: string; match: (ext: string) => boolean; color: string }[] = [
  {
    label: '文档',
    match: (e) =>
      [
        'md',
        'markdown',
        'txt',
        'json',
        'csv',
        'yaml',
        'yml',
        'org',
        'tex',
        'bib',
        'canvas',
      ].includes(e),
    color: '#4f8cff',
  },
  {
    label: '图片',
    match: (e) => ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(e),
    color: '#37c997',
  },
  {
    label: '音频',
    match: (e) => ['mp3', 'wav', 'ogg', 'flac', 'm4a'].includes(e),
    color: '#f5a623',
  },
  {
    label: '视频',
    match: (e) => ['mp4', 'mov', 'webm', 'mkv', 'avi'].includes(e),
    color: '#e05c5c',
  },
  {
    label: '压缩包',
    match: (e) => ['zip', 'rar', '7z', 'tar', 'gz'].includes(e),
    color: '#9b6dff',
  },
  { label: '其他', match: () => true, color: '#8a94a6' },
];

function extOf(path: string): string {
  const i = path.lastIndexOf('.');
  return i >= 0 ? path.slice(i + 1).toLowerCase() : '';
}

export class RemoteUsageModal extends Modal {
  private loading = false;

  constructor(
    app: App,
    private api: BaiduApi,
    private remoteRoot: string,
  ) {
    super(app);
    this.modalEl.addClass('bdnsync-modal', 'bdnsync-usage-modal');
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    const shell = contentEl.createDiv({ cls: 'bdnsync-modal-shell' });
    createModalHeader(shell, {
      title: '远程目录占用明细',
      icon: 'pie-chart',
      subtitle: `同步根目录：${this.remoteRoot}`,
    });
    const body = shell.createDiv({ cls: 'bdnsync-modal-body' });
    body.createDiv({ cls: 'bdnsync-usage-loading', text: '正在统计远程目录占用…' });

    const foot = shell.createDiv({ cls: 'bdnsync-modal-foot' });
    foot
      .createEl('button', { text: '关闭', cls: 'bdnsync-btn bdnsync-btn-primary' })
      .addEventListener('click', () => this.close());

    void this.load(body);
  }

  private async load(body: HTMLElement): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    try {
      // 复用适配器同款递归树：直接走 api.listDir 逐层累加
      const all = await this.walk(this.remoteRoot);
      body.empty();
      if (all.length === 0) {
        createCard(body).createEl('p', { text: '远程同步目录为空', cls: 'bdnsync-empty-state' });
        return;
      }

      // 按类型聚合
      const byType = new Map<string, number>();
      let total = 0;
      for (const e of all) {
        total += e.size;
        const ext = extOf(e.path);
        const grp = TYPE_GROUPS.find((g) => g.match(ext)) || TYPE_GROUPS[TYPE_GROUPS.length - 1];
        byType.set(grp.label, (byType.get(grp.label) || 0) + e.size);
      }

      // 概览卡
      const overview = body.createDiv({ cls: 'bdnsync-usage-overview' });
      const ov = createCard(overview, 'bdnsync-usage-total');
      ov.createEl('div', { text: formatBytes(total), cls: 'bdnsync-usage-total-value' });
      ov.createEl('div', { text: `共 ${all.length} 个文件`, cls: 'bdnsync-usage-total-label' });

      // 类型分布条形（纯 CSS，无外部依赖）
      const typeSection = createSection(body, { title: '按文件类型', icon: 'pie-chart' });
      const typeBar = typeSection.body.createDiv({ cls: 'bdnsync-usage-typebar' });
      for (const g of TYPE_GROUPS) {
        const v = byType.get(g.label) || 0;
        if (v === 0) continue;
        const seg = typeBar.createDiv({ cls: 'bdnsync-usage-seg' });
        seg.style.width = `${(v / total) * 100}%`;
        seg.style.background = g.color;
        seg.setAttribute('title', `${g.label} ${formatBytes(v)}`);
      }
      const typeLegend = typeSection.body.createDiv({ cls: 'bdnsync-usage-legend' });
      for (const g of TYPE_GROUPS) {
        const v = byType.get(g.label) || 0;
        if (v === 0) continue;
        const item = typeLegend.createDiv({ cls: 'bdnsync-usage-legend-item' });
        const dot = item.createSpan({ cls: 'bdnsync-usage-legend-dot' });
        dot.style.background = g.color;
        item.createSpan({ text: `${g.label}`, cls: 'bdnsync-usage-legend-label' });
        item.createSpan({
          text: `${formatBytes(v)} · ${Math.round((v / total) * 100)}%`,
          cls: 'bdnsync-usage-legend-val',
        });
      }

      // 按顶层目录聚合
      const byDir = new Map<string, { count: number; size: number }>();
      for (const e of all) {
        const top = e.path.includes('/') ? e.path.slice(0, e.path.indexOf('/')) : '(根目录)';
        const cur = byDir.get(top) || { count: 0, size: 0 };
        cur.count++;
        cur.size += e.size;
        byDir.set(top, cur);
      }
      const dirSection = createSection(body, { title: '按顶层目录', icon: 'folder' });
      const dirList = dirSection.body.createDiv({ cls: 'bdnsync-usage-dirlist' });
      const sorted = Array.from(byDir.entries()).sort((a, b) => b[1].size - a[1].size);
      for (const [dir, info] of sorted) {
        const row = dirList.createDiv({ cls: 'bdnsync-usage-dirrow' });
        const nameEl = row.createDiv({ cls: 'bdnsync-usage-dirname' });
        const iconWrap = nameEl.createSpan({ cls: 'bdnsync-usage-diricon' });
        setIcon(iconWrap, 'folder', 14);
        nameEl.createSpan({ text: dir });
        const barWrap = row.createDiv({ cls: 'bdnsync-usage-dirbar-wrap' });
        const bar = barWrap.createDiv({ cls: 'bdnsync-usage-dirbar' });
        bar.style.width = `${(info.size / total) * 100}%`;
        row.createSpan({
          text: `${formatBytes(info.size)} · ${info.count} 文件`,
          cls: 'bdnsync-usage-dirval',
        });
      }
    } catch (e) {
      body.empty();
      body.createEl('div', {
        text: `统计失败：${e instanceof Error ? e.message : String(e)}`,
        cls: 'bdnsync-empty-state',
      });
    } finally {
      this.loading = false;
    }
  }

  /** 递归列出同步根目录下所有文件（与适配器 listTree 一致） */
  private async walk(dir: string): Promise<RemoteEntry[]> {
    const out: RemoteEntry[] = [];
    const raw = await this.api.listDir(dir);
    for (const e of raw) {
      const full = e.path || `${dir}/${e.name}`;
      if (e.isDir) {
        // 精确排除插件内部目录，而非按字符串包含判定，避免误伤名称中恰好含
        // ".bdnsync" 片段的正常业务文件夹（如 "project.bdnsync-data"）。
        if (full === '/apps/bdnsync' || this.isBdnsyncInternalDir(full)) continue;
        out.push(...(await this.walk(full)));
      } else {
        out.push({ ...e, path: full.replace(/^\//, '') });
      }
    }
    return out;
  }

  /**
   * 精确判定某远程目录是否为本插件内部目录，避免字符串 includes('.bdnsync') 误伤。
   * 规则：
   *   - 沙箱根 /apps/bdnsync 本身；
   *   - 任意路径段精确等于 ".bdnsync"（即 remoteRoot 或 index/分片存放目录）；
   *   - 用户配置的 remoteRoot 自身（含其下的同步锚点等内部文件）。
   */
  private isBdnsyncInternalDir(full: string): boolean {
    const normalized = full.replace(/^\//, '');
    if (normalized === 'apps/bdnsync') return true;
    const seg = normalized.split('/');
    if (seg.includes('.bdnsync')) return true;
    // remoteRoot 自身（通常是 /apps/bdnsync/MyVault 之类）不入统计
    const root = (this.remoteRoot || '').replace(/^\//, '').replace(/\/$/, '');
    if (root && normalized === root) return true;
    return false;
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
