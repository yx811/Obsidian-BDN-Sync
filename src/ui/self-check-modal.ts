// 实验室 · 功能自检结果面板：逐项展示体检结论，按级别着色（与日志浏览器配色一致）

import { App, Modal } from 'obsidian';
import { createModalHeader, setIcon } from './components';
import type { SelfCheckReport, SelfCheckItem } from '../lab/self-check';

export class SelfCheckModal extends Modal {
  private report: SelfCheckReport;

  constructor(app: App, report: SelfCheckReport) {
    super(app);
    this.report = report;
    this.modalEl.addClass('bdnsync-modal');
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    const shell = contentEl.createDiv({ cls: 'bdnsync-modal-shell' });
    createModalHeader(shell, {
      title: '功能自检',
      icon: this.report.healthy ? 'check' : 'alert-triangle',
      subtitle: this.report.healthy
        ? '插件基础能力体检通过'
        : '体检发现问题，请关注下方红 / 黄项',
    });

    const body = shell.createDiv({ cls: 'bdnsync-modal-body' });

    // 概览条
    const overview = body.createDiv({
      cls: `bdnsync-selfcheck-overview ${this.report.healthy ? 'is-ok' : 'is-bad'}`,
    });
    const ovIcon = overview.createSpan({ cls: 'bdnsync-selfcheck-overview-icon' });
    setIcon(ovIcon, this.report.healthy ? 'check' : 'alert-triangle', 20);
    overview.createSpan({ cls: 'bdnsync-selfcheck-overview-text', text: this.report.summary });
    const ovMeta = overview.createSpan({ cls: 'bdnsync-selfcheck-overview-meta' });
    ovMeta.setText(
      `通过 ${this.report.passed} · 警告 ${this.report.warnings} · 错误 ${this.report.failed}`,
    );

    // 明细列表
    const list = body.createDiv({ cls: 'bdnsync-selfcheck-list' });
    for (const it of this.report.items) {
      list.appendChild(this.renderItem(it));
    }

    // 底部
    const footer = shell.createDiv({ cls: 'bdnsync-modal-foot' });
    const closeBtn = footer.createEl('button', {
      cls: 'bdnsync-btn bdnsync-btn-primary',
      text: '知道了',
    });
    closeBtn.addEventListener('click', () => this.close());
  }

  private renderItem(it: SelfCheckItem): HTMLElement {
    const row = document.createElement('div');
    row.className = `bdnsync-selfcheck-item bdnsync-selfcheck-item-${it.ok ? 'ok' : it.level}`;

    const icon = row.createSpan({ cls: 'bdnsync-selfcheck-item-icon' });
    setIcon(
      icon,
      it.ok ? 'check' : it.level === 'error' ? 'x' : 'alert-triangle',
      16,
    );

    const main = row.createDiv({ cls: 'bdnsync-selfcheck-item-main' });
    main.createSpan({ cls: 'bdnsync-selfcheck-item-name', text: it.name });
    main.createSpan({ cls: 'bdnsync-selfcheck-item-detail', text: it.detail });

    row.createSpan({
      cls: `bdnsync-selfcheck-item-tag bdnsync-selfcheck-tag-${it.ok ? 'ok' : it.level}`,
      text: it.ok ? '正常' : it.level === 'error' ? '错误' : '警告',
    });

    return row;
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
