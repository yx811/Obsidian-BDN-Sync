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
   * 文件级版本向量：deviceId → 该设备对该文件的编辑计数。
   * 用于多设备离线编辑的有序归并：一方是另一方祖先（无并发）→ 直接采用较新；
   * 双方并发 → 进入冲突队列而非覆盖。可选字段，旧索引缺省时按单设备处理。
   */
  vv?: Record<string, number>;
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

/** 冲突处理状态：pending-merge 待合并（有草稿）/ pending-decision 待决策 / resolved 已解决 */
export type ConflictStatus = 'pending-merge' | 'pending-decision' | 'resolved';

export interface ConflictRecord {
  path: string;
  detectedAt: number;
  reason: string; // 人类可读原因
  kind: ConflictKind;
  resolved: boolean;
  /** 冲突处理状态（默认 pending-decision；草稿落盘时为 pending-merge） */
  status?: ConflictStatus;
  /** 合并草稿路径（相对 vault 根，仅 pending-merge 时有值） */
  draftPath?: string;
  /** 三向内容 hash（审计/溯源：共同祖先 + 两端） */
  baseHash?: string;
  localHash?: string;
  remoteHash?: string;
  /** 冲突两端设备标识（审计/溯源） */
  deviceA?: string;
  deviceB?: string;
  /** 解决方式：auto 自动合并 / manual 人工面板 / lww 最后写入获胜 */
  resolvedBy?: 'auto' | 'manual' | 'lww';
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
  /** 配置类文件快照（.obsidian 下，按时间倒序，用于一键回滚） */
  configSnapshots?: VaultSnapshot[];
  /** 最近一次网盘孤儿目录清理审计 */
  lastOrphanReport?: OrphanReportEntry[];
  stats: CumulativeStats;
  checksum: string; // 内容校验和，防索引损坏
}

/** 网盘孤儿目录清理审计条目 */
export interface OrphanReportEntry {
  at: number;
  scannedParent: string; // 扫描的父目录（remoteRoot 父层）
  total: number; // 本次识别出的候选总数
  selected: number; // 用户确认删除数
  ok: string[]; // 成功删除路径
  failed: { path: string; error: string; errno?: number }[]; // 失败路径（含 errno 用于审计追溯）
  mode: 'manual' | 'auto'; // 手动命令 / 同步后自动巡检
  /** v2 字段：本次扫描的详情摘要（用于审计追溯），可选以便向后兼容旧索引 */
  summary?: {
    scanMode: 'parent-only' | 'scoped' | 'full-vault';
    nodesScanned: number;
    bytesScanned: number;
    backupDirCount: number;
    orphanFileCount: number;
    orphanDirCount: number;
    truncated: boolean; // 是否触达 budget 上限被截断
    useRecycleBin: boolean;
  };
}

/**
 * 孤儿发现项（v2 三类合并表示）。注意与历史 OrphanEntry（仅一类「backup-dir」）
 * 并存：本类型用于深度扫描统一表达，新管线（orphan-scan.ts）统一返回。
 *
 * 分类语义：
 *   - 'backup-dir'  : 名称匹配「${vaultName}_YYYYMMDD_HHMMSS[...]」模式的目录（任意深度）
 *   - 'orphan-file' : 不在 sync index 中的文件，且不被任何忽略规则排除（任意深度）
 *   - 'orphan-dir'   : 不在 sync index 中的「空目录」或「全部子项也是孤儿的目录」，
 *                     仅在 scoped/full-vault 模式下识别（parent-only 不深入递归）
 */
export type OrphanFindingKind = 'backup-dir' | 'orphan-file' | 'orphan-dir';

export interface OrphanFinding {
  kind: OrphanFindingKind;
  /** 远端绝对路径（如 /apps/bdnsync/Obsidian Vault/未命名.canvas） */
  fullPath: string;
  /** 仅 basename */
  name: string;
  /** 父目录绝对路径（用于展示） */
  parentPath: string;
  /** 相对 remoteRoot 的路径（仅当路径在 remoteRoot 内时非空；用于过滤/分组） */
  relPath: string;
  /** 相对 remoteRoot 的深度（root 直接子项 = 1，root 的子项的子项 = 2，……） */
  depth: number;
  /** 字节数（orphan-file / orphan-dir 时 = 直接子文件字节和；backup-dir 时 = 单层测量值） */
  bytes: number;
  /** 最后修改时间 ms（若平台无则 0） */
  mtime: number;
  /** 风险等级 0=低 / 1=中 / 2=高 */
  risk: 0 | 1 | 2;
  /** 一句话原因（人类可读，UI 上 hover 显示） */
  reason: string;
  /**
   * 仅当 kind === 'backup-dir'：命中规则匹配的「时间戳段」数（1 = 中风险；≥2 = 高风险）。
   * 仅当 kind === 'orphan-file' 或 'orphan-dir'：未使用（置 0）。
   */
  segments: number;
  /** 单层测量失败标记（仅 backup-dir / orphan-dir 模式单层列子项时使用） */
  measureError?: boolean;
}

/** 深度扫描选项（orphan-scan.ts 主入口） */
export interface DeepScanOptions {
  /** 扫描根（默认 = settings.remoteRoot 父目录 + settings.remoteRoot 整棵树） */
  parentDir: string;
  /** 同步根（vault 在网盘上的真实目录），用于 cross-check sync index */
  remoteRoot: string;
  /** 当前 vault 名（用于 backup-dir 命名匹配） */
  vaultName: string;
  /** 'parent-only' | 'scoped' | 'full-vault' —— 已通过 settings 传入 */
  mode: 'parent-only' | 'scoped' | 'full-vault';
  /** 最大递归深度（0 = 不限；parent-only 时忽略） */
  maxDepth: number;
  /** 最大节点预算 */
  maxNodes: number;
  /** 最大字节预算 */
  maxBytes: number;
  /** 并发 listDir 数 */
  concurrency: number;
  /** 进度回调（每访问一个节点调一次） */
  onProgress?: (info: { scannedNodes: number; scannedBytes: number; truncated: boolean }) => void;
  /** 忽略规则（glob 数组）—— 相对路径匹配；返回 true 时整棵子树跳过 */
  ignoreGlobs?: string[];
}

/** 深度扫描结果 */
export interface DeepScanResult {
  findings: OrphanFinding[];
  scannedNodes: number;
  scannedBytes: number;
  truncated: boolean;
  durationMs: number;
  errors: { path: string; message: string }[];
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
  /** 冲突合并含标记时写草稿（不直接覆盖原文件），由面板确认后写回；false = 维持原「写回+分叉」行为 */
  mergeDraftEnabled: boolean;
  /** .obsidian 配置类文件快照保留数量（一键回滚用，0 = 关闭配置快照） */
  configSnapshotRetention: number;

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

  // —— 网盘孤儿备份目录清理 ——
  /** 检测网盘远程根父目录下的「vault 名 + 时间戳段」型疑似孤儿目录；
   *  命中时写 SyncLog（不删、不弹窗），由用户决定是否手动清理 */
  detectOrphanBackupDirs: boolean;
  /** 同步结束时自动触发 orphan 巡检；命中候选时**仍走二次确认弹窗**，不静默删 */
  autoPruneOrphanBackupDirs: boolean;
  /** 自动清理候选保留天数（mtime 距今超过此值才进入候选；默认 90） */
  orphanRetentionDays: number;
  /** 上一次 orphan 扫描时间戳（毫秒），用于 24h 限频 */
  lastOrphanScanAt: number;

  // —— 网盘孤儿深度扫描（v2 增强）——
  /**
   * 扫描模式：
   *   - 'parent-only' ：仅扫描同步根的「父目录」直接子项（旧行为，最保守）
   *   - 'scoped'      ：扫描「父目录 + 同步根顶层 + 顶层已知子目录」但不深入递归
   *   - 'full-vault'  ：深度遍历「父目录 + 同步根」整棵子树（推荐；能识别 vault 根下的
   *                     残留孤儿文件如「未命名.canvas」、以及嵌套在 .obsidian 等目录里的
   *                     时间戳孤儿子目录如 .obsidian_20260825_011814）
   * 注意：full-vault 受 orphanScanMaxNodes / orphanScanMaxBytes 节流保护；
   *       命中预算上限会终止扫描并把已发现项返回，不会因为大库而无限占用资源。
   */
  orphanScanMode: 'parent-only' | 'scoped' | 'full-vault';
  /** 最大递归深度（仅 full-vault 生效）。0 = 不限，但 orphanScanMaxNodes 仍是硬上限 */
  orphanScanMaxDepth: number;
  /** 单次扫描最多处理的远端条目数（节点预算）。默认 20000 — 万级库安全余量 */
  orphanScanMaxNodes: number;
  /** 单次扫描累计访问文件字节数上限（字节预算）。默认 2 GB */
  orphanScanMaxBytes: number;
  /** 扫描期 listDir 并发数（限速保护，避免触百度 QPS 限频） */
  orphanScanConcurrency: number;
  /** 删除时是否先送回收站（推荐开启，删除可逆）；关闭 = 永久删除（不可逆） */
  orphanUseRecycleBin: boolean;
  /** 额外的「孤儿识别忽略 glob」列表（相对路径，支持 *、**、?），叠加在已有 excludePatterns 之上
   *  —— 用于声明「即使模型判断为孤儿，也请跳过」的安全白名单（例：attachments/**、*.important） */
  orphanExtraIgnoreGlobs: string[];
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
  mergeDraftEnabled: true,
  configSnapshotRetention: 5,

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

  // 孤儿目录清理（默认保守：只检测、不自动删；保留天数 90；上次扫描 0 = 从未扫过）
  detectOrphanBackupDirs: true,
  autoPruneOrphanBackupDirs: false,
  orphanRetentionDays: 90,
  lastOrphanScanAt: 0,

  // 深度扫描 v2：默认走「full-vault」—— 完整遍历 vault 整棵树，识别 vault 根下的
  // 孤儿文件（"未命名.canvas" 这类无主残留）与嵌套在子目录里的时间戳孤儿子目录。
  // 预算足够大（2w 节点 / 2GB），不会因为单次大库扫满；用户可在设置里调小或切回 parent-only。
  orphanScanMode: 'full-vault',
  orphanScanMaxDepth: 0, // 0 = 不限
  orphanScanMaxNodes: 20000,
  orphanScanMaxBytes: 2 * 1024 * 1024 * 1024, // 2 GB
  orphanScanConcurrency: 3,
  orphanUseRecycleBin: true, // 默认回收站模式（可逆）；切 false 才走永久删除
  orphanExtraIgnoreGlobs: [],
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

/** 日志来源模块（用于「按模块」分类检索与存储） */
export type LogModule =
  | 'general'
  | 'engine'
  | 'auth'
  | 'watcher'
  | 'browser'
  | 'ui'
  | 'netdisk'
  | 'crypto'
  | 'lab'
  | 'cleanup';

/** 同步日志条目。
 *  - module：来源模块（如 engine / auth / watcher），用于按模块分类存储与检索
 *  - type：业务分类（如 upload / download / conflict），用于彩色筛选 chip
 *  - level：严重程度（debug/info/warn/error，用于级别筛选与丢弃阈值）
 *  - deleted / deletedAt：墓碑机制字段。标记删除后进入宽限期，到期才物理清除 */
export type SyncLogEntry = {
  id: string;
  time: number;
  module: LogModule;
  type: 'upload' | 'download' | 'delete' | 'conflict' | 'error' | 'info';
  level: LogLevel;
  message: string;
  path?: string;
  /** 墓碑标记：true 表示已被逻辑删除（宽限期内可恢复），物理清除后置为移除 */
  deleted?: boolean;
  /** 墓碑标记时间戳（ms）。用于宽限期判断 */
  deletedAt?: number;
};

/** 日志排序方向 */
export type LogSort = 'desc' | 'asc';

/** 日志筛选条件（查看与导出共用） */
export type LogFilter = {
  /** 起始时间（ms，含）。不传表示从最早 */
  from?: number;
  /** 结束时间（ms，含）。不传表示到最新 */
  to?: number;
  /** 业务类型筛选（多选）；空数组表示不过滤 */
  types?: SyncLogEntry['type'][];
  /** 来源模块筛选（多选）；空数组表示不过滤 */
  modules?: LogModule[];
  /** 最低级别阈值；低于该级别的日志被排除 */
  minLevel?: LogLevel;
  /** 关键字（匹配 message / path / module / type，大小写不敏感，支持正则） */
  keyword?: string;
  /** 是否把 keyword 作为正则解析（否则纯文本子串） */
  regex?: boolean;
  /** 是否包含处于墓碑宽限期内的条目（默认 false，排查时可见） */
  includeTombstoned?: boolean;
  /** 排序方向（默认 desc，最新在前） */
  sort?: LogSort;
};
