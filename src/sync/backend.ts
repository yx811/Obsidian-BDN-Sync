/**
 * 同步后端抽象（#5.10 局域网 P2P 的结构性基础）
 *
 * 把「同步引擎」与「远端存储实现」解耦：引擎只认 SyncBackend 接口，不再耦合具体的
 * BaiduAdapter。这样同一套三向合并 / 墓碑 / 版本向量 / 冲突决策逻辑可以无缝切换到
 * 不同的后端：
 *   - BaiduAdapter：百度网盘（云端），默认后端；
 *   - LanBackend（实验室 #5.10）：同局域网设备直连，数据不出局域网。
 *
 * 接口方法面严格对齐引擎当前对 adapter 的全部调用（见 src/sync/engine.ts 的 this.adapter.*），
 * 因此抽接口是「机械重命名」级别的低风险改造：引擎逻辑零改动，仅字段类型从 BaiduAdapter
 * 变为 SyncBackend。所有方法均为异步（除少数同步配置项），便于后端做网络 IO。
 */

import type { Encryptor } from '../crypto/encryption';
import type { RemoteEntry, RemoteIndex, UploadSession } from '../types';
import type { ResolvedRemoteIndex, UploadResult } from '../baidu/adapter';

/** upload 的可选回调（断点续传 / 进度 / 0KB 跳过通知） */
export interface SyncBackendUploadOpts {
  onProgress?: (done: number, total: number) => void;
  onPartDone?: (session: UploadSession) => void;
  overwrite?: boolean;
  /** #3.8 边缘情况：0KB 文件跳过物理上传时回调，便于引擎记日志/统计 */
  onSkipEmpty?: (relPath: string) => void;
}

export interface SyncBackend {
  /** 设置变更后热更新加密器（E2E 加密由后端在读写时应用） */
  setEncryptor(e: Encryptor | null): void;

  /** 后端是否需要百度云鉴权才能工作（云端=true；局域网 P2P=false，离线可用） */
  readonly requiresCloudAuth: boolean;

  /** 远端根目录（用于拼接远端路径、确保目录存在） */
  readonly root: string;

  /**
   * 读取已聚合的远程索引（分片已合并）；失败/不存在返回 null。
   * 返回 ResolvedRemoteIndex（files 必为非空 Record），与引擎既有契约一致——
   * 引擎多处依赖 files 非 null，故接口沿用 BaiduAdapter 的返回类型，避免改造引擎逻辑。
   */
  readRemoteIndex(): Promise<ResolvedRemoteIndex | null>;

  /** 列出远端目录树：path → { size, mtime, fsId }。
   *  可选 signal：用户取消预览时中止遍历（仅停止后续目录列举，已发出的网络请求不可撤销）。 */
  listTree(
    onProgress?: (count: number) => void,
    signal?: AbortSignal,
  ): Promise<Map<string, RemoteEntry>>;

  /** 按远程条目下载内容（可选校验 hash） */
  download(entry: RemoteEntry, expectHash?: string): Promise<Uint8Array>;

  /** 按相对路径直接下载（用于预览等场景），不存在返回 null */
  downloadByPath(relPath: string, expectHash?: string): Promise<Uint8Array | null>;

  /** 上传一个文件（加密、分片、断点续传由后端实现） */
  upload(
    path: string,
    content: Uint8Array,
    opts?: SyncBackendUploadOpts,
  ): Promise<UploadResult>;

  /** 批量删除远端文件 */
  deleteRemote(relPaths: string[]): Promise<void>;

  /** 确保远端目录存在（越界/沙箱根由后端自行保护） */
  ensureDir(remoteDir: string): Promise<void>;

  /** 远端重命名（保留 fsId，避免删除+重传） */
  renameRemote(oldRel: string, newRel: string): Promise<void>;

  /** 写回远程索引 */
  writeRemoteIndex(idx: RemoteIndex): Promise<void>;

  /** 导出未完成的断点续传会话（供本地持久化，下次恢复） */
  exportSessions(): UploadSession[];

  /** 恢复断点续传会话 */
  restoreSessions(sessions: UploadSession[]): void;
}
