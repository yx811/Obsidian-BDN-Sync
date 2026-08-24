// Obsidian API 在 Node 测试环境的轻量 stub。
// 仅提供 planEntry / PathFilter 等纯函数测试所间接 import 到的符号，不影响逻辑。
export class Notice {
  constructor(_msg: string, _timeout?: number) {}
  setMessage(_msg: string): this {
    return this;
  }
  hide(): void {}
}

export class Modal {
  constructor(_app?: unknown) {}
  open(): void {}
  close(): void {}
  onOpen(): void {}
  onClose(): void {}
}

export class Component {
  load(): void {}
  unload(): void {}
  registerEvent(): void {}
}

export class Plugin {
  constructor(_app?: unknown, _manifest?: unknown) {}
  addCommand(): void {}
  addRibbonIcon(): void {}
  registerView(): void {}
  addSettingTab(): void {}
}

// 视图相关最小 stub，供依赖 ItemView 的模块（如 preview-view）在 Node 下被导入
export class WorkspaceLeaf {
  setViewState(_state: unknown): Promise<void> {
    return Promise.resolve();
  }
}
export class ItemView {
  constructor(_leaf?: unknown) {}
  getViewType(): string {
    return '';
  }
  getDisplayText(): string {
    return '';
  }
  getIcon(): string {
    return '';
  }
  onOpen(): Promise<void> {
    return Promise.resolve();
  }
  onClose(): Promise<void> {
    return Promise.resolve();
  }
}
export class MarkdownView extends ItemView {}
export class View {
  constructor(_leaf?: unknown) {}
}

export const Platform = { isDesktop: true, isMobile: false };
