// 集中提示字典：统一 BDNSync 所有 Notice 的前缀与口吻，作为未来多语言/文案治理的单一入口。
// 设计原则：渲染出的文案与历史版本逐字一致（仅把前缀与构造收敛到一处），不引入行为变更。

import { Notice } from 'obsidian';
import { formatBytes } from '../util/misc';

const PREFIX = 'BDNSync：';

export type NoticeLevel = 'ok' | 'err' | 'info';

function emit(level: NoticeLevel, msg: string, timeout?: number): Notice {
  const t =
    timeout ?? (level === 'err' ? 8000 : level === 'info' ? 0 : 5000);
  return new Notice(PREFIX + msg, t);
}

export const noticeOk = (msg: string, timeout?: number): Notice => emit('ok', msg, timeout);
export const noticeErr = (msg: string, timeout?: number): Notice => emit('err', msg, timeout);
export const noticeInfo = (msg: string, timeout?: number): Notice => emit('info', msg, timeout);

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 语义化提示集合。新增提示请在此登记，调用方统一走此处，避免散落硬编码。
 * 文案与历史保持一致，便于后续统一治理。
 */
export const Notices = {
  // —— 目录设置 ——
  syncDirSet: (dir: string) => noticeOk(`同步目录已设为 ${dir}`),

  // —— 下载 ——
  downloadStart: (name: string) => noticeInfo(`正在下载 ${name}…`),
  downloadDone: (path: string, size: number) =>
    noticeOk(`已下载到 ${path}（${formatBytes(size)}）`),
  downloadFail: (e: unknown) => noticeErr(`下载失败 — ${errMsg(e)}`),
  dirDownloadStart: (name: string) => noticeInfo(`正在下载目录 ${name}…`),
  dirDownloadDone: (count: number, name: string) =>
    noticeOk(`目录下载完成，共 ${count} 个文件 → _netdisk_downloads/${name}`),
  dirDownloadFail: (e: unknown) => noticeErr(`目录下载失败 — ${errMsg(e)}`),
  bulkDownloadEmpty: () => noticeErr('请先勾选要下载的文件/目录'),
  bulkDownloadDone: (ok: number) => noticeOk(`批量下载完成（${ok} 个文件）`),

  // —— 删除 ——
  deleteDone: (name: string) => noticeOk(`已删除 ${name}`),
  deleteFail: (e: unknown) => noticeErr(`删除失败 — ${errMsg(e)}`),
  bulkDeleteEmpty: () => noticeErr('请先勾选要删除的文件'),
  bulkDeleteDone: (n: number) => noticeOk(`已删除 ${n} 项`),
  bulkDeleteFail: (e: unknown) => noticeErr(`批量删除失败 — ${errMsg(e)}`),

  // —— 新建 / 重命名 / 移动 ——
  created: (dir: string) => noticeOk(`已创建 ${dir}`),
  createFail: (e: unknown) => noticeErr(`创建失败 — ${errMsg(e)}`),
  renamed: (name: string) => noticeOk(`已重命名为 ${name}`),
  renameFail: (e: unknown) => noticeErr(`重命名失败 — ${errMsg(e)}`),
  moved: (dest: string) => noticeOk(`已移动到同步目录 ${dest}`),
  moveFail: (e: unknown) => noticeErr(`移动失败 — ${errMsg(e)}`),

  // —— 加密 ——
  encryptedNeedPass: (name: string) =>
    noticeErr(`${name} 是加密文件，请先开启端到端加密并填写密码`, 8000),
  decryptFail: (name: string, e: unknown) =>
    noticeErr(`${name} 解密失败（${errMsg(e)}）`, 8000),

  // —— 预览 / 缩略图 / 分享 ——
  previewUnsupported: (name: string) =>
    noticeInfo(`暂不支持预览 ${name}，可下载到仓库后用本地应用打开`),
  thumbStart: (name: string) => noticeInfo(`加载缩略图 ${name}…`),
  thumbFail: (e: unknown) => noticeErr(`缩略图加载失败 — ${errMsg(e)}`),
  shareStart: (name: string) => noticeInfo(`正在生成分享链接 ${name}…`),
  shareDone: (link: string, copied: boolean) =>
    noticeInfo(`分享链接已生成${copied ? '并复制到剪贴板' : ''}：\n${link}`, 10000),
  shareFail: (e: unknown) => noticeErr(`生成分享链接失败 — ${errMsg(e)}`),
};
