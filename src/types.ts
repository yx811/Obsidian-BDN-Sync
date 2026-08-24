// BDNSync 核心类型定义

export type AuthMode = 'cookies' | 'openapi';
export type SyncMode = 'manual' | 'auto' | 'realtime';
export type ConflictStrategy =
  'smart-merge' | 'force-local' | 'force-remote' | 'always-fork' | 'ask-me';
export type DeleteStrategy = 'keep-modified' | 'delete-everywhere';

/** 单个文件在某一端的状态 */
export interface FileState {
  path: string; // 相对 vault 根目录的路径（正斜杠）
  mtime: number; // 毫秒时间戳
  size: number; // 明文字节数
  hash: string; // 内容 MD5（始终为明文内容哈希；加密时哈希也不变）
  deleted?: boolean; // 墓碑标记
  deletedAt?: number;
  deletedBy?: string;
  fsId?: string; // 百度网盘 fs_id（云端条目）
  byDevice?: string; // 最后写入该状态的设备
  /**
   * 该文件实际落在网盘上的字节数（开启加密时 = 密文长度，未加密时 = 明文长度）。
   * 用于判断「远程索引条目是否与网盘现状一致」：网盘列表返回的 size 是密文长度、
   * mtime 是秒级 server_mtime，直接与明文 size / 本地毫秒 mtime 比较永远不相等，
   * 会让索引里的 hash 被判为过期 → 每次同步重复下载、每次本地编辑都变成假冲突。
   */
  remoteSize?: number;
}

/**
 * 远程索引（存于云端 .bdnsync/ 目录）。
 *
 * 分片方案（A3，万级文件扩展性）：
 *  - 当文件数超过阈值时，`files` 为 null，实际文件状态分散在 `shards` 列出的分片 JSON 中；
 *  - 每个分片文件存于 `.bdnsync/shards/shard-<n>.json`，内容为 `{ files: Record<string, FileState> }`；
 *  - `manifest` 指向 `.bdnsync/index.json` 这一份轻量清单（仅含元信息 + 分片列表），
 *    清单体积与文件总数无关，避免单 JSON 体积随库规模膨胀到不可维护。
 *  - 文件数较少时仍保持「单文件」紧凑形态（`files` 直接内联、shards 为空），向后兼容旧客户端。
 *
 * 乐观锁（syncVersion）始终在「清单」上 +1，分片不参与版本号，CAS 语义不变。
 */
export interface RemoteIndex {
  version: string;
  vaultName: string;
  createdAt: number;
  updatedAt: number;
  deviceId: string;
  syncVersion: number; // 乐观锁版本号，每次写入 +1（始终在清单上）
  /** 内联文件表（文件数较少时）；分片模式下为 null，改用 shards 聚合 */
  files: Record<string, FileState> | null;
  /** 分片文件名列表（不含目录前缀），如 ['shard-0.json','shard-1.json']；空数组表示未分片 */
  shards?: string[];
}

export interface ConflictRecord {
  path: string;
  detectedAt: number;
  reason: string; // 人类可读原因
  kind: ConflictKind;
  resolved: boolean;
}

export type ConflictKind =
  | 'edit-edit'
  | 'create-create'
  | 'delete-modify-local'
  | 'delete-modify-remote'
  | 'binary'
  | 'race'
  | 'unknown';

export interface LocalIndex {
  schema: 1;
  lastSyncAt: number;
  lastRemoteSyncVersion: number;
  files: Record<string, FileState>; // 上次同步成功时的状态（lastSync 锚点）
  conflicts: ConflictRecord[];
  /** 文件级版本历史：path → 最近 N 个版本（按时间倒序） */
  versions?: Record<string, FileVersion[]>;
  /** 整库快照点列表（按时间倒序，最多 maxSnapshots 个） */
  snapshots?: VaultSnapshot[];
  /** 最近一次同步的冲突处理明细（审计） */
  lastConflictReport?: ConflictReportEntry[];
  stats: CumulativeStats;
  checksum: string; // 内容校验和，防索引损坏
}

export interface CumulativeStats {
  totalUploads: number;
  totalDownloads: number;
  totalDeletes: number;
  totalConflicts: number;
  bytesUp: number;
  bytesDown: number;
  syncCount: number;
  lastSyncSummary?: string;
}

export interface SyncStats {
  uploaded: number;
  downloaded: number;
  deletedLocal: number;
  deletedRemote: number;
  conflicts: number;
  skipped: number;
  errors: number;
  bytesUp: number;
  bytesDown: number;
  errorMessages: string[];
}

/**
 * 上传会话（断点续传）。
 *
 * F1 真断点续传：除 `doneParts`（已成功上传的分块序号）外，额外持久化
 * `doneBytes`（已上行字节总数）与 `blockMd5`（各分块 MD5），使 `transfer-state.json`
 * 在崩溃/重启后不仅能恢复 uploadid，还能校验「磁盘上残留的分块是否与记录一致」，
 * 从而避免「脏续传」（复用了一个已被网盘 GC 或内容已变的 uploadid）。
 */
export interface UploadSession {
  path: string;
  remotePath: string;
  uploadid: string;
  totalSize: number;
  partSize: number;
  md5s: string[];
  doneParts: number[];
  /** 已成功上行的字节总数（doneParts 各块之和），用于进度展示与续传起点判断 */
  doneBytes: number;
  /** 各分块内容 MD5（与 md5s 同序），崩溃恢复时校验断点有效性 */
  blockMd5: string[];
  startedAt: number;
}

/** 文件级版本历史中的单个版本 */
export interface FileVersion {
  hash: string; // 内容 MD5（base 缓存键）
  mtime: number; // 该版本写入时间（毫秒）
  size: number; // 明文字节数
  byDevice: string; // 写入该版本的设备
  deviceName?: string; // 设备展示名（便于审计）
  note?: string; // 来源说明（如「同步上传」「本地编辑」「恢复版本」）
}

/** 整库快照点（force 方向前轻量索引，用于误删后整库回滚） */
export interface VaultSnapshot {
  id: string;
  createdAt: number;
  deviceId: string;
  deviceName?: string;
  reason: string; // 触发原因（如「强制全量上传前自动备份」）
  files: Record<string, { hash: string; mtime: number; size: number }>;
  totalFiles: number;
  totalBytes: number;
}

/** 同步计划预览（dry-run）：手动同步前展示将要执行的操作 */
export interface SyncPlanPreview {
  direction: 'bidirectional' | 'force-upload' | 'force-download';
  upload: number;
  download: number;
  deleteLocal: number;
  deleteRemote: number;
  conflicts: number;
  skip: number;
  samples: {
    path: string;
    op: 'upload' | 'download' | 'delete-local' | 'delete-remote' | 'conflict' | 'skip';
  }[];
  generatedAt: number;
}

/** 单次同步的冲突处理明细（审计用） */
export interface ConflictReportEntry {
  path: string;
  kind: ConflictKind;
  strategy: string;
  outcome: string;
  at: number;
}

/** 覆盖前备份的元数据（物理内容存于 base 池，按 hash 去重） */
export interface BackupEntry {
  id: string;
  time: number;
  relPath: string;
  hash: string;
  size: number;
}

export interface BDNSyncSettings {
  // 认证（参照澜库 credentials 结构）
  authMode: AuthMode;
  // openapi 模式（设备码授权）
  appKey: string; // 百度开放平台 AppKey
  secretKey: string; // 百度开放平台 SecretKey
  accessToken: string; // 设备码授权获取
  refreshToken: string; // 用于刷新 accessToken
  tokenExpiresAt: string; // 毫秒时间戳（字符串存储）
  // cookie 模式
  cookies: string; // 完整 Cookie 字符串（可选，优先使用）
  bduss: string;
  stoken: string;
  remoteRoot: string; // 远程根目录，如 /apps/bdnsync/MyVault

  // 同步模式
  syncMode: SyncMode;
  autoSyncInterval: number; // 分钟
  syncOnSave: boolean;
  syncOnStartup: boolean;

  // 冲突解决
  conflictStrategy: ConflictStrategy;
  deleteStrategy: DeleteStrategy;
  autoBackup: boolean; // 覆盖本地前自动备份
  /** 单次同步删除数达到该值时弹窗确认（0 = 关闭该确认；比例式异常检测始终生效） */
  bulkDeleteConfirm: number;

  // 过滤
  excludePatterns: string[];
  maxFileSizeMB: number;
  skipHiddenFiles: boolean;
  syncConfigDir: boolean;

  // 加密
  encryptionEnabled: boolean;
  encryptionPassword: string;
  /** 本库固定的 PBKDF2 salt（base64）。首次加密时自动生成并持久化，
   *  用于避免每个文件都重跑一次 10 万轮 PBKDF2。 */
  encryptionSalt: string;

  // 性能
  uploadConcurrency: number;
  downloadConcurrency: number;
  chunkSizeMB: number;
  requestIntervalMs: number; // 内置 QPS 节流
  /** 上传带宽上限（KB/s）。0 = 不限速。避免大库同步占满带宽 */
  bandwidthLimitKBps: number;
  /** 上传前是否展示同步预览（dry-run）让用户确认 */
  syncPreviewEnabled: boolean;
  /** 跨窗口 rename 配对的时间窗口（毫秒）；大于 0 时把「删除+创建」合并为 move */
  renameGraceMs: number;
  /** 实时同步风暴阈值：单次批量变更超过该数量降级为完整同步；0 = 关闭 */
  stormThreshold: number;

  // 版本历史
  /** 每个文件保留的最近版本数（0 = 关闭版本历史） */
  maxVersions: number;

  // 整库快照
  /** 自动快照：force 方向前生成整库快照点（0 = 关闭） */
  autoSnapshot: boolean;
  /** 保留的快照点数量上限 */
  maxSnapshots: number;

  // 设备
  deviceId: string;
  deviceName: string;

  // 日志与诊断
  /** 日志最低记录级别：低于该级别的日志将被丢弃（debug 最详细，error 最精简） */
  logLevel: LogLevel;
  /** 日志保留天数：超过该天数的日志将被墓碑清理（0 = 永久保留） */
  logRetentionDays: number;
  /** 日志条目容量上限（环形缓冲，超出按时间最旧淘汰） */
  logMaxEntries: number;
  /** 墓碑宽限期（小时）：标记为删除后保留该时长再物理清除，留出误删恢复窗口 */
  logTombstoneGraceHours: number;

  // 界面
  /** 主题模式：auto=跟随 Obsidian；normal=常规高可读；high-contrast=高对比度 */
  themeMode: 'auto' | 'normal' | 'high-contrast';

  // —— 实验室（Lab）功能区域 ——
  /** 实验室总开关：一键开启/关闭整个实验性功能区域（关闭时各实验功能零副作用） */
  labEnabled: boolean;
  /** 实验功能 1：网盘媒体直嵌（MediaBridge）。仅当 labEnabled 时生效 */
  cloudMediaEnabled: boolean;
  /** 懒加载：图片原生 lazy、视频进入视口才拉流 */
  cloudMediaLazyLoad: boolean;
  /** 超过该体积（MB）的文件改为"点击加载"占位，避免一打开笔记就全量拉流 */
  cloudMediaMaxInlineMB: number;
  /** 离线时显示占位（而非静默失败） */
  cloudMediaOfflinePlaceholder: boolean;

  // —— 实验功能 2：网盘文件反向引用（Backlinks） ——
  /** 仅当 labEnabled 时生效；在文件预览/网盘浏览器展示「哪些笔记引用了此文件」 */
  labBacklinksEnabled: boolean;

  // —— 实验功能 3：选择性离线收藏（Pin to Local） ——
  /** 仅当 labEnabled 时生效；允许把 bdn:// 媒体收藏到本地缓存，离线可用 */
  labOfflinePinEnabled: boolean;
  /** 离线收藏缓存上限（MB），0 = 不限制 */
  labOfflinePinMaxMB: number;

  // —— 实验功能 4：同步健康分 / 风险雷达 ——
  /** 仅当 labEnabled 时生效；同步完成后打分并低于阈值时预警 */
  labHealthEnabled: boolean;
  /** 健康分低于该值（0-100）时发 Notice 预警 */
  labHealthWarnThreshold: number;
}

export const DEFAULT_SETTINGS: BDNSyncSettings = {
  authMode: 'cookies',
  cookies: '',
  bduss: '',
  stoken: '',
  appKey: '',
  secretKey: '',
  accessToken: '',
  refreshToken: '',
  tokenExpiresAt: '',
  remoteRoot: '',

  syncMode: 'manual',
  autoSyncInterval: 5,
  syncOnSave: true,
  syncOnStartup: true,

  conflictStrategy: 'smart-merge',
  deleteStrategy: 'keep-modified',
  autoBackup: true,
  bulkDeleteConfirm: 50,

  excludePatterns: ['.trash/**', '*.tmp', '~$*', '*.lock'],
  maxFileSizeMB: 100,
  skipHiddenFiles: true,
  syncConfigDir: false,

  encryptionEnabled: false,
  encryptionPassword: '',
  encryptionSalt: '',

  uploadConcurrency: 3,
  downloadConcurrency: 3,
  chunkSizeMB: 4,
  requestIntervalMs: 550,
  bandwidthLimitKBps: 0,
  syncPreviewEnabled: true,
  renameGraceMs: 1500,
  stormThreshold: 200,

  maxVersions: 5,

  autoSnapshot: true,
  maxSnapshots: 3,

  deviceId: '',
  deviceName: '',

  logLevel: 'info',
  logRetentionDays: 30,
  logMaxEntries: 1000,
  logTombstoneGraceHours: 24,

  themeMode: 'auto',

  // 实验室
  labEnabled: false,
  cloudMediaEnabled: true,
  cloudMediaLazyLoad: true,
  cloudMediaMaxInlineMB: 50,
  cloudMediaOfflinePlaceholder: true,

  labBacklinksEnabled: true,
  labOfflinePinEnabled: true,
  labOfflinePinMaxMB: 200,
  labHealthEnabled: true,
  labHealthWarnThreshold: 80,
};

/** 远程目录条目 */
export interface RemoteEntry {
  path: string; // 相对 remoteRoot 的路径
  name: string;
  isDir: boolean;
  size: number;
  mtime: number; // 毫秒
  fsId: string;
}

/** 日志严重程度级别（严重程度递增） */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** 同步日志条目。
 *  - type：业务分类（用于彩色筛选 chip）
 *  - level：严重程度（debug/info/warn/error，用于级别筛选与丢弃阈值）
 *  - deleted / deletedAt：墓碑机制字段。标记删除后进入宽限期，到期才物理清除 */
export type SyncLogEntry = {
  id: string;
  time: number;
  type: 'upload' | 'download' | 'delete' | 'conflict' | 'error' | 'info';
  level: LogLevel;
  message: string;
  path?: string;
  /** 墓碑标记：true 表示已被逻辑删除（宽限期内可恢复），物理清除后置为移除 */
  deleted?: boolean;
  /** 墓碑标记时间戳（ms）。用于宽限期判断 */
  deletedAt?: number;
};

/** 日志筛选条件（查看与导出共用） */
export type LogFilter = {
  /** 起始时间（ms，含）。不传表示从最早 */
  from?: number;
  /** 结束时间（ms，含）。不传表示到最新 */
  to?: number;
  /** 业务类型筛选（多选）；空数组表示不过滤 */
  types?: SyncLogEntry['type'][];
  /** 最低级别阈值；低于该级别的日志被排除 */
  minLevel?: LogLevel;
  /** 关键字（匹配 message / path，大小写不敏感） */
  keyword?: string;
  /** 是否包含处于墓碑宽限期内的条目（默认 false，排查时可见） */
  includeTombstoned?: boolean;
};
