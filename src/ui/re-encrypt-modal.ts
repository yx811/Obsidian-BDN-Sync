// 更改加密密码（重新加密）模态框（#3.5 改密重加密）。
//
// 收集「新密码 + 二次确认」，校验一致后回调 onConfirm(newPassword)。
// 真正的重加密逻辑在 SyncEngine.reEncryptWith 中（本地明文为真相源，标记重上传）。

import { App, Modal } from 'obsidian';
import { createModalHeader, createPasswordField, setIcon } from './components';
import { passwordStrength } from '../crypto/encryption';

export class ReEncryptModal extends Modal {
  private pw1 = '';
  private pw2 = '';
  private errEl!: HTMLElement;
  private meterEl!: HTMLElement;

  constructor(
    app: App,
    private onConfirm: (newPassword: string) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass('bdnsync-view', 'bdnsync-reencrypt');
    const shell = root.createDiv({ cls: 'bdnsync-modal-shell' });
    createModalHeader(shell, {
      title: '更改加密密码',
      icon: 'lock',
      subtitle: '新密码将用于重新加密所有已同步文件；请牢记，丢失无法恢复。',
    });

    const body = shell.createDiv({ cls: 'bdnsync-modal-body' });

    const row1 = body.createDiv({ cls: 'bdnsync-input-row' });
    row1.createEl('label', { text: '新密码' });
    createPasswordField(row1, {
      value: '',
      placeholder: '输入新密码',
      onChange: (v) => {
        this.pw1 = v;
        this.updateMeter();
      },
    });

    const row2 = body.createDiv({ cls: 'bdnsync-input-row' });
    row2.createEl('label', { text: '确认新密码' });
    createPasswordField(row2, {
      value: '',
      placeholder: '再次输入新密码',
      onChange: (v) => {
        this.pw2 = v;
      },
    });

    this.meterEl = body.createDiv({ cls: 'bdnsync-pw-meter' });
    this.errEl = body.createDiv({ cls: 'bdnsync-error-text' });

    const foot = shell.createDiv({ cls: 'bdnsync-modal-foot' });
    const cancel = foot.createEl('button', { text: '取消' });
    cancel.addEventListener('click', () => this.close());
    const ok = foot.createEl('button', { cls: 'mod-cta', text: '开始重新加密' });
    setIcon(ok, 'refresh-cw');
    ok.addEventListener('click', () => {
      if (this.pw1.length < 8) {
        this.errEl.setText('密码至少 8 位');
        return;
      }
      if (this.pw1 !== this.pw2) {
        this.errEl.setText('两次输入的密码不一致');
        return;
      }
      this.close();
      this.onConfirm(this.pw1);
    });
  }

  private updateMeter(): void {
    const st = passwordStrength(this.pw1);
    this.meterEl.setText(`强度：${st.label} · ${st.hint}`);
    this.meterEl.className = `bdnsync-pw-meter bdnsync-pw-meter-${st.score}`;
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
