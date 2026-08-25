// 冲突解决面板：三栏对比 + 逐段采纳/舍弃/手动编辑。
//
// 数据来源（由 main 层组装）：
//   - localText：本地（设备 A）当前内容
//   - remoteText：远端（设备 B）当前内容
//   - draftText：引擎生成的合并草稿（含 `<<<<<<< / ======= / >>>>>>>` 标记）
//   - conflictSections：由 extractConflictSections 解析出的冲突块（精确行区间）
//
// 面板能力：
//   - 逐段导航（只跳到有冲突的段，跳过已自动合部分）
//   - 每段三选一：采纳本地 / 采纳远端 / 保留双方（并排）
//   - 草稿区可手动编辑（textarea）
//   - 保存前校验「是否仍有未解决的标记」
//   - 保存后回调（main → engine.confirmMergeDraft 写回 + 上传 + 清理）

import { App, Modal, setIcon } from 'obsidian';
import { extractConflictSections, type ConflictSection } from '../util/diff3';

export interface MergePanelOptions {
  path: string;
  draftText: string;
  localText: string;
  remoteText: string;
  localLabel: string; // 设备 A 展示名
  remoteLabel: string; // 设备 B 展示名
  /** 保存合并结果（写回原路径 + 上传 + 清理草稿）。返回是否成功。 */
  onSave: (mergedText: string) => Promise<boolean>;
}

const MAX_PREVIEW_LINES = 2000; // 大文件只预览前段，避免 DOM 卡死

function truncateLines(text: string, max: number): string {
  const lines = text.split('\n');
  if (lines.length <= max) return text;
  return lines.slice(0, max).join('\n') + `\n…（仅显示前 ${max} 行）`;
}

export class MergePanelModal extends Modal {
  private mergedLines: string[] = [];
  private sections: ConflictSection[] = [];
  private draftArea!: HTMLTextAreaElement;
  private sectionListEl!: HTMLElement;
  private statusEl!: HTMLElement;

  constructor(
    app: App,
    private opts: MergePanelOptions,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('bdnsync-merge-panel');
    this.mergedLines = this.opts.draftText.split('\n');
    this.sections = extractConflictSections(this.opts.draftText, this.opts.localLabel, this.opts.remoteLabel);

    // 头部
    const header = contentEl.createDiv({ cls: 'bdnsync-merge-header' });
    header.createEl('h3', {
      text: '冲突解决面板',
    });
    header.createEl('div', {
      cls: 'bdnsync-merge-path',
      text: this.opts.path,
    });

    // 统计条
    const stat = contentEl.createDiv({ cls: 'bdnsync-merge-stat' });
    stat.createSpan({
      text: `共 ${this.sections.length} 处冲突段 · 本地（${this.opts.localLabel}）↔ 远端（${this.opts.remoteLabel}）`,
    });
    this.statusEl = stat.createSpan({ cls: 'bdnsync-merge-status' });

    // 三栏
    const cols = contentEl.createDiv({ cls: 'bdnsync-merge-cols' });
    this.renderSide(cols, `本地 · ${this.opts.localLabel}`, this.opts.localText);
    this.renderDraft(cols);
    this.renderSide(cols, `远端 · ${this.opts.remoteLabel}`, this.opts.remoteText);

    // 冲突段操作区
    const ops = contentEl.createDiv({ cls: 'bdnsync-merge-sections' });
    ops.createEl('div', { cls: 'bdnsync-merge-sections-title', text: '逐段裁决' });
    this.sectionListEl = ops.createDiv({ cls: 'bdnsync-merge-section-list' });
    this.renderSections();

    // 底部按钮
    const footer = contentEl.createDiv({ cls: 'bdnsync-merge-footer' });
    const saveBtn = footer.createEl('button', {
      cls: 'mod-cta',
      text: '保存并标记为已解决',
    });
    saveBtn.addEventListener('click', () => void this.save());
    const cancelBtn = footer.createEl('button', { text: '关闭（保留草稿）' });
    cancelBtn.addEventListener('click', () => this.close());
  }

  private renderSide(parent: HTMLElement, title: string, text: string): void {
    const box = parent.createDiv({ cls: 'bdnsync-merge-col' });
    box.createEl('div', { cls: 'bdnsync-merge-col-title', text: title });
    const pre = box.createEl('pre', { cls: 'bdnsync-merge-col-body' });
    pre.setText(truncateLines(text, MAX_PREVIEW_LINES));
  }

  private renderDraft(parent: HTMLElement): void {
    const box = parent.createDiv({ cls: 'bdnsync-merge-col bdnsync-merge-col-draft' });
    box.createEl('div', { cls: 'bdnsync-merge-col-title', text: '合并草稿（可编辑）' });
    this.draftArea = box.createEl('textarea', {
      cls: 'bdnsync-merge-draft-area',
      attr: { spellcheck: 'false' },
    });
    this.draftArea.value = this.mergedLines.join('\n');
    this.draftArea.addEventListener('input', () => {
      this.mergedLines = this.draftArea.value.split('\n');
      this.sections = extractConflictSections(
        this.draftArea.value,
        this.opts.localLabel,
        this.opts.remoteLabel,
      );
      this.renderSections();
      this.updateStatus();
    });
  }

  private renderSections(): void {
    this.sectionListEl.empty();
    if (this.sections.length === 0) {
      this.sectionListEl.createSpan({
        cls: 'bdnsync-merge-none',
        text: '✅ 无未解决的冲突段（或已全部采纳/舍弃）',
      });
      return;
    }
    this.sections.forEach((sec, idx) => {
      const row = this.sectionListEl.createDiv({ cls: 'bdnsync-merge-section-row' });
      row.createSpan({
        cls: 'bdnsync-merge-section-idx',
        text: `#${idx + 1}`,
      });
      const meta = row.createDiv({ cls: 'bdnsync-merge-section-meta' });
      meta.createDiv({
        cls: 'bdnsync-merge-section-local',
        text: `本地：${sec.local.slice(0, 3).join(' / ') || '（空）'}`,
      });
      meta.createDiv({
        cls: 'bdnsync-merge-section-remote',
        text: `远端：${sec.remote.slice(0, 3).join(' / ') || '（空）'}`,
      });
      const btns = row.createDiv({ cls: 'bdnsync-merge-section-btns' });
      btns.createEl('button', { text: '采纳本地' }).addEventListener('click', () =>
        this.applyChoice(sec, 'local'),
      );
      btns.createEl('button', { text: '采纳远端' }).addEventListener('click', () =>
        this.applyChoice(sec, 'remote'),
      );
      btns.createEl('button', { text: '保留双方' }).addEventListener('click', () =>
        this.applyChoice(sec, 'both'),
      );
      const jump = btns.createEl('button', { text: '定位', cls: 'bdnsync-merge-jump' });
      const iconWrap = jump.createSpan();
      setIcon(iconWrap, 'locate');
      jump.addEventListener('click', () => this.jumpTo(sec));
    });
  }

  private applyChoice(sec: ConflictSection, choice: 'local' | 'remote' | 'both'): void {
    const lines = this.mergedLines;
    const replacement: string[] =
      choice === 'local' ? [...sec.local] : choice === 'remote' ? [...sec.remote] : [...sec.local, '', ...sec.remote];
    const next = [...lines.slice(0, sec.blockStart), ...replacement, ...lines.slice(sec.blockEnd)];
    this.mergedLines = next;
    this.draftArea.value = this.mergedLines.join('\n');
    // 行号已变化，重新解析冲突段
    this.sections = extractConflictSections(
      this.draftArea.value,
      this.opts.localLabel,
      this.opts.remoteLabel,
    );
    this.renderSections();
    this.updateStatus();
  }

  private jumpTo(sec: ConflictSection): void {
    // 只做光标定位 + 滚动，绝不改写 textarea 内容（审计 #2：旧实现把 "▶ " 前缀
    // 写回 value，用户随后点「保存」会把污染内容写进原文件）。
    const lines = this.draftArea.value.split('\n');
    this.draftArea.focus();
    // 用行号换算光标位置（粗定位到冲突块起始）
    const offset = lines.slice(0, sec.blockStart).reduce((acc, l) => acc + l.length + 1, 0);
    this.draftArea.setSelectionRange(offset, offset);
    this.draftArea.scrollTop = Math.max(0, offset - 200);
  }

  private updateStatus(): void {
    this.statusEl.empty();
    if (this.sections.length > 0) {
      this.statusEl.setText(`⚠ 仍有 ${this.sections.length} 处冲突未处理`);
      this.statusEl.addClass('bdnsync-merge-status-warn');
    } else {
      this.statusEl.setText('✅ 已无冲突段，可保存');
      this.statusEl.removeClass('bdnsync-merge-status-warn');
    }
  }

  private async save(): Promise<void> {
    const text = this.draftArea.value;
    // 兜底校验（审计 #8）：不依赖标签解析结果，直接检测文本中是否残留冲突标记行。
    // 防止标签不一致导致 sections 解析为空、却把 `<<<<<<< / ======= / >>>>>>>` 写进文件。
    if (/^<<<<<<< |^>>>>>>> /m.test(text)) {
      this.statusEl.setText('⚠ 文本中仍残留冲突标记（<<<<<<< / >>>>>>>），请先清理后再保存');
      this.statusEl.addClass('bdnsync-merge-status-warn');
      return;
    }
    // 保存前校验：若仍含未解决的冲突段则阻止
    if (this.sections.length > 0) {
      this.statusEl.setText('⚠ 仍有冲突段未处理，请先逐段采纳或手动删除标记');
      this.statusEl.addClass('bdnsync-merge-status-warn');
      return;
    }
    this.statusEl.setText('保存中…');
    const ok = await this.opts.onSave(text);
    if (ok) {
      this.statusEl.setText('✅ 已保存并写回原文件');
      setTimeout(() => this.close(), 800);
    } else {
      this.statusEl.setText('❌ 保存失败，请查看日志');
      this.statusEl.addClass('bdnsync-merge-status-warn');
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
