// BDNSync 插件入口：生命周期、命令、事件、调度器、新 UI 集成

import { FileSystemAdapter, Modal, Notice, Platform, Plugin, TAbstractFile, TFile, TFolder } from 'obsidian';
import {
  BaiduApi,
  parseCookieField,
  redactSecrets,
  type QuotaInfo,
  type DeviceAuthInfo,
  type UserInfo,
} from './baidu/api';
import { BaiduAdapter } from './baidu/adapter';
import { Encryptor } from './crypto/encryption';
import { SyncEngine, type SyncResult } from './sync/engine';
import { LocalStore } from './storage/local-store';
import { FileWatcher } from './watcher/file-watcher';
import { StatusBar } from './ui/status-bar';
import {
  ConflictModal,
  FirstSyncModal,
  ForceSyncConfirmModal,
  MassDeleteGuardModal,
  OrphanCleanupModal,
  StatsModal,
  VersionHistoryModal,
  SyncPreviewModal,
  SnapshotRestoreModal,
  ConflictReportModal,
} from './ui/modals';
import { MergePanelModal } from './ui/merge-panel';
import { RemoteUsageModal } from './ui/remote-usage';
import { CrossDeviceDashboardView, VIEW_TYPE_BDNSYNC_DASHBOARD } from './ui/views/cross-device-dashboard-view';
import { ReEncryptModal } from './ui/re-encrypt-modal';
import { NetdiskBrowserView, VIEW_TYPE_BDNSYNC_BROWSER } from './ui/views/netdisk-browser-view';
import { SyncLogView, VIEW_TYPE_BDNSYNC_LOG } from './ui/views/sync-log-view';
import { PreviewView, VIEW_TYPE_BDNSYNC_PREVIEW } from './ui/views/preview-view';
import { BDNSyncSettingTab } from './settings';
import {
  DEFAULT_SETTINGS,
  type BDNSyncSettings,
  type LogLevel,
  type LogModule,
  type SyncLogEntry,
  type DeepScanOptions,
  type DeepScanResult,
  type OrphanFinding,
  type SyncPlanPreview,
  type ScanProgress,
} from './types';
import {
  PathFilter,
  genDeviceId,
  formatBytes,
  u8ToArrayBuffer,
  shouldShowNotice,
  remoteParent,
  remoteJoin,
  applyMobileDefaults,
} from './util/misc';
import { diagnoseByMessage } from './util/error-dict';
import { type DiagnosticContext, Logger } from './util/logger';
import { probeHealth, probeDegradationAdvice } from './lab/api-probe';
import { md5Hex } from './util/md5';
import { LogStore } from './util/log-store';
import {
  shouldScanOrphans,
  PLUGIN_INFRA_HARD_EXCLUDE,
  type RemoteLister,
  type RemoteDeleter,
  type RemoteDirRow,
} from './util/orphan-cleanup';
import {
  walkRemoteTree,
  classifyOrphans,
  runDeepScan,
  type ClassifyOptions,
} from './util/orphan-scan';
import { sealSecretsInPlace, unsealSecretsInPlace } from './security/secrets';
import { keyFileTemplate, DEFAULT_KEY_FILE } from './util/keyfile';
import { RetryQueue } from './sync/retry-queue';
import { DirtySet } from './sync/dirty-set';
import { StreamServer } from './stream-server';
import { rewriteBdnRefs, recoverBdnRefs, buildBdnRef } from './lab/media-bridge';
import { rebuildBacklinkIndex } from './lab/backlinks';
import { evaluateSyncHealth } from './lab/health-score';
import { GitChangeSource, isGitRepo } from './lab/git-change-source';
import { LanBackend, LanPeer } from './lab/lan/lan-backend';
import { LanDiscovery } from './lab/lan/discovery';
// 引入插件样式：esbuild 会将其打包并通过 onload 注入，缺失会导致全部 UI 弹窗无样式
import '../styles.css';

const PLUGIN_DIR = '.obsidian/plugins/bdnsync';
/** 局域网 P2P 同步专用本地索引目录（与云端索引隔离，避免 index namespace 冲突） */
const LAN_PLUGIN_DIR = '.obsidian/plugins/bdnsync-lan';
/** 本机作为「被同步对端」时，远端镜像落盘目录（置于 .obsidian 下，天然被云端同步排除） */
const LAN_PEER_DIR = '.obsidian/plugins/bdnsync/lan-peer';

export default class BDNSyncPlugin extends Plugin {
  settings!: BDNSyncSettings;
  statusBar!: StatusBar;
  engine: SyncEngine | null = null;
  watcher!: FileWatcher;

  lastQuota: QuotaInfo | null = null;
  lastQuotaError: string | null = null;
  lastTestedUser = '';
  /** 会员等级 / 账号信息（与 BaiduApi 自带 10min 缓存并行，仅给设置页/状态栏展示用） */
  lastVipInfo: UserInfo | null = null;
  lastVipInfoAt = 0;
  lastVipInfoError: string | null = null;
  /** 上一次主动刷新 VIP 引起的设置页重绘 token，避免并发 refresh 重复 dispatch */
  private vipRerenderToken = 0;

  private api!: BaiduApi;
  private cloudAdapter!: BaiduAdapter;
  /** 局域网 P2P：本机作为「被同步对端」时的服务实例（另一台设备连它拉/推） */
  private lanPeer: LanPeer | null = null;
  /** 局域网 P2P：UDP 信标广播（让同网段其他设备发现本机） */
  private lanDiscovery: LanDiscovery | null = null;
  /** 局域网 P2P：防止并发发起多次 LAN 同步（与云端同步互斥） */
  private lanSyncing = false;
  /** 本地持久化存储（LocalStore）：实验功能读写索引/报告等使用 */
  store!: LocalStore;
  private nextAutoSyncAt = 0;
  private autoFailCount = 0;
  /** #4.5 上次自动快照时间（ms），用于定时快照间隔判定 */
  private lastSnapshotAt = 0;
  /** 订阅式日志器：持久化 + 墓碑清理 + 整合筛选/导出 */
  logger!: Logger;
  /** 日志磁盘存储层（按日期分文件 + 大小轮转 + retentionDays 清理） */
  logStore!: LogStore;
  /** 增量同步因引擎忙被推迟时，置位后由当前同步结束兜底一次完整对账，避免并发编辑丢失上传 */
  private pendingQuickSync = false;
  /** 插件卸载标志：置位后不再发起新的同步（进行中的同步由 flush 等待完成后才 dispose） */
  private disposing = false;
  /** 反向引用索引 debounce 重建定时器（vault 变更后轻量触发） */
  private backlinkRebuildTimer: number | null = null;
  /** 失败重试队列（方案1）：把失败任务入队，指数退避自动重试，断网持久化 */
  retryQueue!: RetryQueue;
  /** 脏集合（方案3）：跨批次累积待同步路径，避免增量退化成全量 */
  private dirtySet!: DirtySet;
  /** 本地流式代理：供预览 Modal 免落盘在线打开/播放网盘文件（还原澜库 /stream 能力） */
  private streamServer: StreamServer | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    // #2.2 移动端：按平台下调并发/分片/风暴阈值（桌面端原样返回；已自定义值不覆盖）
    applyMobileDefaults(this.settings);

    // 日志器：按日期分文件持久化 + 大小轮转 + retentionDays 自动清理 + 墓碑宽限期
    const LOGS_DIR = `${PLUGIN_DIR}/logs`;
    const maxLogFileBytes = 4 * 1024 * 1024; // 单日文件上限 4MB，超出追加分片
    const store = new LogStore(this.app.vault.adapter, LOGS_DIR, {
      retentionDays: this.settings.logRetentionDays,
      maxFileSizeBytes: maxLogFileBytes,
    });
    this.logStore = store;
    this.logger = new Logger({
      level: this.settings.logLevel,
      maxEntries: this.settings.logMaxEntries,
      retentionDays: this.settings.logRetentionDays,
      tombstoneGraceHours: this.settings.logTombstoneGraceHours,
      maxFileSizeBytes: maxLogFileBytes,
      store,
    });
    await this.logger.ensureLoaded();
    // 启动墓碑自动清理（每 6 小时一次；onload 时先跑一次）
    void this.logger.purge();
    this.registerInterval(window.setInterval(() => void this.logger.purge(), 6 * 3600_000));

    // 注册工作区视图（文件浏览器 / 同步日志）—— 作为 Obsidian 标签页打开，避免 Modal 截断
    this.registerView(VIEW_TYPE_BDNSYNC_BROWSER, (leaf) => new NetdiskBrowserView(leaf, this));
    this.registerView(VIEW_TYPE_BDNSYNC_LOG, (leaf) => new SyncLogView(leaf, this.logger, () => this.buildDiagnosticContext()));
    this.registerView(VIEW_TYPE_BDNSYNC_DASHBOARD, (leaf) => new CrossDeviceDashboardView(leaf, this));
    this.registerView(
      VIEW_TYPE_BDNSYNC_PREVIEW,
      // view 实例在 setState 时再创建（拿到 target）
      (leaf) => new PreviewView(leaf, this, { name: '', fsId: '', path: '', size: 0 }),
    );

    // 状态栏
    const sbEl = this.addStatusBarItem();
    this.statusBar = new StatusBar(
      this.app,
      () => void this.syncNow('manual'),
      () => this.openConflictPanel(),
      () => void this.openStats(),
      () => this.openNetdiskBrowser(),
      () => this.openSettingsTab(),
      () => void this.openVersionHistory(),
      () => void this.openRemoteUsage(),
      () => void this.openSnapshots(),
      () => this.buildStatusSummary(),
    );
    this.statusBar.mount(sbEl);

    // 后端
    this.rebuildBackend();

    // 脏集合（方案3）：跨批次累积待同步路径
    this.dirtySet = new DirtySet(() => this.settings);

    // 失败重试队列（方案1）：失败任务持久化到 transfer-state.json，指数退避重试
    this.retryQueue = new RetryQueue(
      async () => this.persistRetryState(),
      async (paths) => {
        await this.runQuickSync(paths);
      },
      () => this.statusBar.setRetryCount(this.retryQueue.size),
    );
    // 恢复磁盘上残留的待重试条目
    void this.loadTransferStateForRetry();

    // 布局就绪：恢复断点会话 + 启动同步
    this.app.workspace.onLayoutReady(() => {
      void this.onLayoutReady();
    });

    // 文件监听
    this.watcher = new FileWatcher({
      onFlush: (paths) => this.runQuickSync(paths),
      onStorm: (paths) => void this.runStormSync(paths),
      getFileSize: (path) => {
        const f = this.app.vault.getAbstractFileByPath(path);
        return f instanceof TFile ? f.stat.size : 0;
      },
    });
    // 本地文件变更：统一路由到「保存同步」与「实验功能反向引用重建」两个关注点。
    // 合并到单一处理器，避免对同一事件重复注册（此前 create/modify/delete 各注册两次，
    // 虽因 watcher 防抖与 backlink 防抖未产生功能性 bug，但结构冗余、可读性差）。
    const onFileChanged = (path: string): void => {
      this.onLocalChange(path);
      this.scheduleBacklinkRebuild();
    };
    this.registerEvent(
      this.app.vault.on('create', (f: TAbstractFile) => {
        if (f instanceof TFile) onFileChanged(f.path);
      }),
    );
    this.registerEvent(
      this.app.vault.on('modify', (f: TAbstractFile) => {
        if (f instanceof TFile) onFileChanged(f.path);
      }),
    );
    this.registerEvent(
      this.app.vault.on('delete', (f: TAbstractFile) => {
        if (f instanceof TFile) {
          // 记录删除事件到脏集合的「近期删除窗口」，供跨批次 rename 配对使用
          // （engine.quickSync 内的 hash 配对负责同批次 rename；此处兜底窗口内配对）。
          this.dirtySet.markDelete(f.path);
          onFileChanged(f.path);
        }
      }),
    );
    this.registerEvent(
      this.app.vault.on('rename', (f: TAbstractFile, oldPath: string) => {
        // rename = oldPath 删除 + newPath 创建：两路都交给 onLocalChange（watcher 内部会做重命名配对）
        onFileChanged(oldPath);
        if (f instanceof TFile) onFileChanged(f.path);
        // 目录重命名：新路径的目录需在云端补建（空目录同步修复点）
        if (f instanceof TFolder) this.ensureRemoteFolder(f.path);
      }),
    );
    // 目录创建：Obsidian 仅对 TFolder 发 create 事件（新建笔记时可能自动建空子目录）。
    // 此前同步链路只监听 TFile，本地空文件夹永远不会同步到云端。这里补建云端目录，
    // 放松同步限制（原不同步空目录 → 现在允许空目录同步）。
    this.registerEvent(
      this.app.vault.on('create', (f: TAbstractFile) => {
        if (f instanceof TFolder) this.ensureRemoteFolder(f.path);
      }),
    );

    // Ribbon + 命令
    this.addRibbonIcon('cloud', 'BDNSync：立即同步', () => void this.syncNow('manual'));

    this.addCommand({
      id: 'bdnsync-sync-now',
      name: '立即同步',
      callback: () => void this.syncNow('manual'),
    });
    this.addCommand({
      id: 'bdnsync-force-upload',
      name: '强制全量上传（本地覆盖云端）',
      callback: () => void this.forceSync('force-upload'),
    });
    this.addCommand({
      id: 'bdnsync-force-download',
      name: '强制全量下载（云端覆盖本地）',
      callback: () => void this.forceSync('force-download'),
    });
    this.addCommand({
      id: 'bdnsync-show-conflicts',
      name: '打开冲突处理面板',
      callback: () => this.openConflictPanel(),
    });
    this.addCommand({
      id: 'bdnsync-show-stats',
      name: '查看同步统计',
      callback: () => void this.openStats(),
    });
    this.addCommand({
      id: 'bdnsync-browse-netdisk',
      name: '浏览百度网盘文件',
      callback: () => this.openNetdiskBrowser(),
    });
    this.addCommand({
      id: 'bdnsync-show-logs',
      name: '查看同步日志',
      callback: () => this.openLogPanel(),
    });
    this.addCommand({
      id: 'bdnsync-remote-usage',
      name: '远程目录占用明细',
      callback: () => this.openRemoteUsage(),
    });
    this.addCommand({
      id: 'bdnsync-snapshots',
      name: '整库快照与回滚',
      callback: () => this.openSnapshots(),
    });
    this.addCommand({
      id: 'bdnsync-conflict-report',
      name: '查看冲突处理报告',
      callback: () => this.openConflictReport(),
    });
    this.addCommand({
      id: 'bdnsync-orphan-cleanup',
      name: '扫描并清理网盘备份目录',
      callback: () => void this.openOrphanCleanupModal({ autoMode: false }),
    });
    // P0-1.4 冲突合并面板（仅当 mergeDraftEnabled 时展示）
    if (this.settings.mergeDraftEnabled) {
      this.addCommand({
        id: 'bdnsync-open-merge-panel',
        name: '打开冲突合并面板（逐段裁决）',
        callback: () => void this.openMergePanelFirst(),
      });
      // P2-4.2 撤销最近合并
      this.addCommand({
        id: 'bdnsync-undo-merge',
        name: '撤销最近一次冲突合并',
        callback: () => void this.undoLastMerge(),
      });
    }
    // P2-4.6 跨设备同步看板（轮询式）
    this.addCommand({
      id: 'bdnsync-cross-device-dashboard',
      name: '跨设备同步状态看板',
      callback: () => void this.openCrossDeviceDashboard(),
    });
    // 实验室 #5.9：基于 Git 差异的增量同步（仅桌面，且需开启对应开关）
    if (this.settings.labEnabled && this.settings.labGitEnabled && Platform.isDesktop) {
      this.addCommand({
        id: 'bdnsync-git-sync',
        name: 'Git 增量同步（实验室）',
        callback: () => void this.syncViaGit(),
      });
    }
    // 实验室 #5.10：局域网 P2P 同步（仅桌面，且需开启对应开关）
    if (this.settings.labEnabled && this.settings.labLanEnabled && Platform.isDesktop) {
      this.addCommand({
        id: 'bdnsync-lan-peer-start',
        name: '启动局域网对端（实验室）',
        callback: () => void this.startLanPeer(),
      });
      this.addCommand({
        id: 'bdnsync-lan-peer-stop',
        name: '停止局域网对端（实验室）',
        callback: () => this.stopLanPeer(),
      });
      this.addCommand({
        id: 'bdnsync-lan-sync',
        name: '局域网同步（实验室）',
        callback: () => void this.runLanSync(),
      });
    }

    // 实验功能：插入 bdn:// 网盘媒体引用（相对 remoteRoot，需开启网盘媒体直嵌）
    if (this.settings.labEnabled && this.settings.cloudMediaEnabled) {
      this.addCommand({
        id: 'bdnsync-insert-bdn-ref',
        name: '插入网盘媒体引用（bdn://）',
        editorCallback: (editor, ctx) => {
          const file = ctx.file;
          if (!file) {
            new Notice('请先打开一个笔记再插入引用');
            return;
          }
          const ref = buildBdnRef(undefined, file.path);
          editor.replaceSelection(`[${file.name}](${ref})`);
        },
      });
    }

    // 实验功能：网盘媒体直嵌 Markdown PostProcessor
    this.registerMarkdownPostProcessor((el) => rewriteBdnRefs(this, el));

    // 设置页
    this.addSettingTab(new BDNSyncSettingTab(this.app, this));

    // 网络恢复自动同步
    const onlineHandler = () => {
      if (this.settings.syncMode !== 'manual') {
        this.log('info', '网络已恢复');
        // 方案1：网络恢复后先 flush 失败重试队列，再触发常规同步
        void this.retryQueue.flush();
        void this.syncNow('online');
      }
      // 实验功能：离线占位符在网络恢复后自动重新加载
      recoverBdnRefs(this);
    };
    window.addEventListener('online', onlineHandler);
    this.register(() => window.removeEventListener('online', onlineHandler));

    // 离线监听
    const offlineHandler = () => {
      this.statusBar.setOffline();
      this.log('info', '网络已断开');
    };
    window.addEventListener('offline', offlineHandler);
    this.register(() => window.removeEventListener('offline', offlineHandler));

    // 自动同步调度
    this.restartScheduler();
    this.registerInterval(window.setInterval(() => this.tickScheduler(), 30_000));

    // #2.1 API 稳定性与容灾：轻量探查（list/upload/quota）调度，按设置周期运行；
    // 探测到 OpenAPI 不可用且 Cookie 可用时给出降级引导（best-effort，失败不影响主流程）。
    if (this.settings.apiProbeEnabled) {
      this.registerInterval(
        window.setInterval(
          () => void this.runApiProbe().catch(() => {}),
          Math.max(1, this.settings.apiProbeIntervalHours) * 3600_000,
        ),
      );
      // 启动后稍延迟跑一次（避免在 onload 高峰期抢占网络）。
      // 用 registerInterval 托管该一次性定时器：onunload 时会自动 clearInterval，
      // 避免在插件已卸载（实例正在释放）后回调仍调用 this.runApiProbe 触碰已释放资源。
      this.registerInterval(
        window.setTimeout(() => void this.runApiProbe().catch(() => {}), 15_000),
      );
    }

  }

  onunload(): void {
    // 停止后台重试轮询定时器（schedulePoll 用的是裸 window.setInterval，不会随插件卸载自动清除，
    // 否则卸载后每 15s 仍会在已释放的插件实例上触发 flush → 泄漏），须在 onunload 显式停止。
    this.retryQueue?.stopPoll();
    // 卸载前尽量把「保存后尚未同步」的待提交变更 flush 出去，避免移动端/关闭时丢改。
    // 注意：disposing 守卫会阻止 runQuickSync 执行，因此这里先不置 disposing，
    // 待 flush 真正发起（fire-and-forget）后再标记卸载，确保 flush 有机会实际同步。
    // 即便卸载窗口未能等网络完成，下次启动的 startup 全量扫描也会重新覆盖 vault 内全部文件。
    if (
      this.watcher &&
      this.engine &&
      this.settings.syncOnSave &&
      this.hasAuth() &&
      navigator.onLine
    ) {
      void this.watcher
        .flush()
        .catch(() => {
          /* ignore */
        })
        .finally(() => this.watcher?.dispose());
    } else {
      this.watcher?.dispose();
    }
    // 标记卸载：之后不再接受新的同步触发（周期调度 / 保存增量 / pending 兜底），
    // 避免 dispose 清空 watcher 定时器后仍有上传在 api 层裸跑丢失最后几个文件。
    this.disposing = true;
    void this.store?.saveTransferState(this.cloudAdapter?.exportSessions() ?? []).catch(() => {
      /* ignore */
    });
    document.body?.classList.remove('bdnsync-theme-hc');
    // 关闭所有已打开的工作区视图（文件浏览器 / 同步日志 / 跨设备看板 / 文件预览）
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_BDNSYNC_BROWSER);
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_BDNSYNC_LOG);
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_BDNSYNC_DASHBOARD);
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_BDNSYNC_PREVIEW);
    // 停止本地流式代理，释放端口
    this.streamServer?.stop();
    this.streamServer = null;
    // 停止局域网对端服务与信标广播，释放端口
    this.stopLanPeer();
    // 清理反向引用重建防抖定时器，避免在已卸载实例上执行
    if (this.backlinkRebuildTimer !== null) {
      window.clearTimeout(this.backlinkRebuildTimer);
      this.backlinkRebuildTimer = null;
    }
    // 清理状态栏（含内部 revert 定时器）
    this.statusBar?.unmount();
    //  ㅤ卸载前把「今天」日志缓冲落盘，避免当天日志丢失
    void this.logStore?.flush().catch(() => {
      /* ignore */
    });
  }

  /** 仅用于内部测试/重置：清空推迟标志 */
  clearPendingQuickSync(): void {
    this.pendingQuickSync = false;
  }

  // ---------------- 设置 ----------------

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as Partial<BDNSyncSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data || {});
    // 解密磁盘上的加密凭据（若环境不支持则保持原值，由连接校验提示重新登录）
    await unsealSecretsInPlace(this.settings);
    let dirty = false;
    if (!this.settings.deviceId) {
      this.settings.deviceId = genDeviceId();
      dirty = true;
    }
    if (!this.settings.deviceName) {
      this.settings.deviceName = '我的设备';
      dirty = true;
    }
    if (!this.settings.remoteRoot) {
      this.settings.remoteRoot = `/apps/bdnsync/${this.app.vault.getName()}`;
      dirty = true;
    }
    if (dirty) await this.writeSettings();
    this.applyTheme();
    this.applyRuntimeConfig();
  }

  /**
   * 落盘设置：先对敏感字段做信封加密，再交给 Obsidian 持久化。
   * 与 saveSettings 的区别：不触发 refreshBackend / applyTheme（避免加密回调中误换后端）。
   */
  private async writeSettings(): Promise<void> {
    const copy = JSON.parse(JSON.stringify(this.settings)) as BDNSyncSettings;
    await sealSecretsInPlace(copy);
    await this.saveData(copy);
  }

  async saveSettings(): Promise<void> {
    await this.writeSettings();
    this.refreshBackend();
    this.applyTheme();
    this.applyRuntimeConfig();
  }

  /** 将运行时字段（风暴阈值、脏集合窗口、日志配置）与最新 settings 联动 */
  private applyRuntimeConfig(): void {
    if (this.watcher) this.watcher.stormThreshold = this.settings.stormThreshold;
    if (this.dirtySet) this.dirtySet.setWindow(this.settings.renameGraceMs);
    // 日志：实时同步级别阈值、容量上限、保留天数到 Logger / LogStore
    if (this.logger) {
      this.logger.updateOptions({
        level: this.settings.logLevel,
        maxEntries: this.settings.logMaxEntries,
        retentionDays: this.settings.logRetentionDays,
        tombstoneGraceHours: this.settings.logTombstoneGraceHours,
      });
    }
  }

  /** 应用界面主题：高对比度模式给 document.body 加 class，使所有 BDNSync 弹窗/浮层继承 */
  private applyTheme(): void {
    const root = document.body;
    if (!root) return;
    root.classList.toggle('bdnsync-theme-hc', this.settings.themeMode === 'high-contrast');
  }

  // ---------------- 后端组装 ----------------

  private buildAuth() {
    const s = this.settings;
    let bduss = s.bduss;
    let stoken = s.stoken;
    if (s.cookies) {
      const p1 = parseCookieField(s.cookies, 'BDUSS');
      const p2 = parseCookieField(s.cookies, 'STOKEN');
      if (p1 && !bduss) bduss = p1;
      if (p2 && !stoken) stoken = p2;
    }
    return {
      mode: s.authMode,
      bduss: bduss || '',
      stoken: stoken || '',
      cookieString: s.cookies || '',
      appKey: s.appKey || '',
      secretKey: s.secretKey || '',
      accessToken: s.accessToken || '',
      refreshToken: s.refreshToken || '',
      tokenExpiresAt: s.tokenExpiresAt || '',
    };
  }

  private makeApi(): BaiduApi {
    return new BaiduApi(this.buildAuth(), this.settings.requestIntervalMs);
  }

  /** 暴露给 UI 浏览器等只读场景创建独立 API 实例，避免污染主限流状态 */
  createApi(): BaiduApi {
    return this.makeApi();
  }

  /** 暴露给网盘浏览器等场景，用于解密手动下载的密文文件 */
  createEncryptor(): Encryptor | null {
    return this.makeEncryptor();
  }

  /** 获取 live API 实例（设备码授权等需要跨调用保持状态的场景使用） */
  getApi(): BaiduApi {
    return this.api;
  }

  /** 获取本地流式代理实例（预览 Modal 用它构建免落盘直链） */
  getStreamServer(): StreamServer | null {
    return this.streamServer;
  }

  /**
   * 流式代理归属校验：仅允许读取「属于当前 vault 远程索引」的 fsId。
   * 作为流式代理的安全纵深防御——即使一次性 token 经 URL 泄露，外部也无法借此
   * 读取用户网盘任意文件。engine 未初始化时拒绝（预览回退下载模式）。
   */
  async verifyStreamFsId(fsId: string, path: string): Promise<boolean> {
    if (!this.engine) return false;
    return this.engine.verifyFsIdOwnership(fsId, path);
  }

  /** 确保本地流式代理已启动（授权完成等场景下按需拉起） */
  async ensureStreamServer(): Promise<void> {
    if (this.streamServer && this.streamServer.isRunning) return;
    if (!this.hasAuth()) return;
    try {
      this.streamServer = new StreamServer(this);
      await this.streamServer.start();
    } catch (e) {
      console.warn(
        `[BDNSync] 本地流式代理启动失败（预览将回退为下载模式）：${(e as Error)?.message || String(e)}`,
      );
      this.streamServer = null;
    }
  }

  /** 启动设备码授权（委托 live api，设备码状态保留在实例内） */
  async startDeviceAuth(): Promise<DeviceAuthInfo> {
    return this.api.startDeviceAuth();
  }

  /** 轮询设备码授权状态；成功时回写 token 到设置并热更新后端 */
  async pollDeviceAuth(): Promise<boolean> {
    const ok = await this.api.pollDeviceAuth();
    if (ok) {
      // 从 live api 回读最新 token 并持久化
      const snap = this.api.snapshotAuth();
      this.settings.accessToken = snap.accessToken;
      this.settings.refreshToken = snap.refreshToken;
      this.settings.tokenExpiresAt = snap.tokenExpiresAt;
      await this.writeSettings();
      this.refreshBackend();
    }
    return ok;
  }

  private makeEncryptor(): Encryptor | null {
    if (!this.settings.encryptionEnabled || !this.settings.encryptionPassword) return null;
    return new Encryptor(
      this.settings.encryptionPassword,
      this.settings.encryptionSalt || undefined,
      // 首次加密时生成的库级 salt 需要持久化，否则下次启动会换 salt，
      // 导致密钥缓存失效、每个文件重新跑 PBKDF2。
      (b64) => {
        this.settings.encryptionSalt = b64;
        // 只落盘，不走 saveSettings()——后者会 refreshBackend() 把加密器换掉，
        // 而这个回调可能正发生在一次上传的加密过程中。
        void this.writeSettings();
      },
    );
  }

  private rebuildBackend(): void {
    this.api = this.makeApi();
    this.cloudAdapter = new BaiduAdapter(this.api, () => this.settings, this.makeEncryptor());
    this.store = new LocalStore(this.app.vault.adapter, PLUGIN_DIR, {
      onCorruptIndex: () =>
        new Notice('BDNSync：本地索引校验失败，已自动重建（下次同步将全量对账）', 6000),
    });
    this.engine = new SyncEngine(
      this.app,
      () => this.settings,
      this.cloudAdapter,
      this.store,
      this.statusBar,
      async (localCount, remoteCount) => {
        const m = this.openExclusive('first-sync', () => new FirstSyncModal(this.app, localCount, remoteCount));
        if (!m) return 'cancel'; // 已有引导弹窗打开（并发触发），本次按取消处理
        return await m.open();
      },
      (n) => this.statusBar.setConflicts(n),
      async (info) => {
        this.log('info', `删除保护触发：${info.reason}`);
        const m = this.openExclusive('mass-delete-guard', () => new MassDeleteGuardModal(this.app, info));
        if (!m) return 'cancel'; // 已有删除保护弹窗打开，本次按取消（不执行删除）
        return await m.open();
      },
    );
    // 注入"同步成功后"异步钩子：触发 orphan 巡检 + 配置快照（A+B+C 三档共用入口）
    this.engine.setAfterCommitHook(() => {
      void this.runAutoOrphanScanIfDue({ from: 'sync' }).catch((e) => {
        this.logger.log(
          'cleanup',
          'info',
          'warn',
          `orphan 巡检钩子抛出：${e instanceof Error ? e.message : String(e)}`,
        );
      });
      // P1-3.4 配置快照：syncConfigDir 开启且保留数 > 0 时，同步后打 .obsidian 配置快照
      void this.snapshotConfigIfEnabled().catch(() => {
        /* 快照失败静默 */
      });
    });
  }

  /** 设置变更后热更新（认证/加密/限流间隔） */
  private refreshBackend(): void {
    this.api?.updateAuth(this.buildAuth());
    this.api?.updateInterval(this.settings.requestIntervalMs);
    this.cloudAdapter?.setEncryptor(this.makeEncryptor());
  }

  /** 供设置页调用的连接测试 */
  async testConnection(): Promise<{
    ok: boolean;
    message: string;
    quota?: QuotaInfo;
    user?: string;
  }> {
    try {
      const api = this.makeApi();
      const quota = await api.getQuota();
      const info = await api.getUserInfo();
      this.lastQuota = quota;
      this.lastTestedUser = info.name || '';
      return { ok: true, message: '连接成功', quota, user: info.name || undefined };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }

  // ---------------- 同步触发 ----------------

  private async withSuspendedWatcher<T>(fn: () => Promise<T>): Promise<T> {
    this.watcher?.suspend();
    try {
      return await fn();
    } finally {
      this.watcher?.resume();
    }
  }

  async syncNow(
    trigger: 'manual' | 'startup' | 'auto' | 'online' | 'conflict-resolve' = 'manual',
    direction: 'bidirectional' | 'force-upload' | 'force-download' = 'bidirectional',
  ): Promise<SyncResult> {
    // 同步弹窗（预览/冲突/首次引导 Modal 与错误 Notice）统一在全局容器弹出。
    // 若用户停留在设置页（Obsidian 设置为 Modal 形式），先关闭它，避免同步弹窗
    // 叠加/渲染在设置容器区域上方造成「弹窗嵌在设置页里」的观感与 z-index 混乱。
    this.closeSettingsIfOpen();
    // 防重入短路：引擎已在同步时，直接返回「占用中」结果，不再走到预览弹窗/配额
    // 查询等后续步骤（否则连续点击「立即同步」会重复 buildPreviewPlan + 重复弹窗，
    // 且每次都会重复「已有同步正在进行」Notice）。
    // 例外：force 方向（强制上传/下载）需等待进行中的同步结束后再继续，否则会被
    // busy 守卫静默吞掉，导致用户点击「强制同步」却无任何动作（🔴协调）。
    if (this.engine?.isBusy()) {
      if (direction !== 'bidirectional') {
        const released = await this.waitForIdle(20000);
        if (!released || this.engine?.isBusy()) {
          this.logM('general', 'info', 'warn', `强制同步：等待进行中的同步${released ? '后仍忙碌' : '超时'}，已放弃`);
          return {
            ok: false,
            cancelled: true,
            uploaded: 0,
            downloaded: 0,
            deletedLocal: 0,
            deletedRemote: 0,
            conflicts: 0,
            skipped: 0,
            errors: 0,
            bytesUp: 0,
            bytesDown: 0,
            errorMessages: [],
          };
        }
      } else {
        this.statusBar.setSyncing('同步进行中…');
        this.log('info', '同步被跳过：已有同步进行中');
        // 用户主动点击同步时给出明确反馈（限频：3 秒内同文案不重复弹，避免连点刷屏）
        if (trigger === 'manual') this.notifyBusy('BDNSync：已有同步正在进行，请稍候。完成后再试即可。', 4000);
        return {
          ok: false,
          cancelled: true,
          uploaded: 0,
          downloaded: 0,
          deletedLocal: 0,
          deletedRemote: 0,
          conflicts: 0,
          skipped: 0,
          errors: 0,
          bytesUp: 0,
          bytesDown: 0,
          errorMessages: [],
        };
      }
    }
    if (!this.engine || !navigator.onLine) {
      if (!navigator.onLine) this.statusBar.setOffline();
      return {
        ok: false,
        uploaded: 0,
        downloaded: 0,
        deletedLocal: 0,
        deletedRemote: 0,
        conflicts: 0,
        skipped: 0,
        errors: 1,
        bytesUp: 0,
        bytesDown: 0,
        errorMessages: [!navigator.onLine ? '当前离线' : '引擎未初始化'],
      };
    }
    // 🟡#5：未配置连接时 fullSync 会返回 null（与「busy」同源），下方「!result → 已有同步进行中」
    // 会把「未配置」误标为「占用中」，误导用户。这里提前给出明确提示并短路，避免混淆。
    if (!this.hasAuth()) {
      this.statusBar.setError('未配置连接');
      new Notice('BDNSync：请先在设置中配置百度网盘连接');
      this.logM('general', 'info', 'warn', '同步被跳过：未配置百度网盘连接');
      return {
        ok: false,
        uploaded: 0,
        downloaded: 0,
        deletedLocal: 0,
        deletedRemote: 0,
        conflicts: 0,
        skipped: 0,
        errors: 1,
        bytesUp: 0,
        bytesDown: 0,
        errorMessages: ['未配置百度网盘连接'],
      };
    }
    // 配额告警：手动/启动时预检云端空间，避免同步中途因配额耗尽失败
    if (trigger === 'manual' || trigger === 'startup') {
      try {
        const q = await this.makeApi()
          .getQuota()
          .catch(() => null);
        if (q && q.total > 0 && q.used / q.total > 0.95) {
          new Notice(
            `BDNSync：百度网盘空间已用 ${Math.round((q.used / q.total) * 100)}%（${formatBytes(q.used)} / ${formatBytes(q.total)}），同步可能失败，建议清理空间。`,
            8000,
          );
        }
      } catch {
        /* 配额查询失败不阻断同步 */
      }
    }
    // 同步预览（dry-run）：手动双向同步且开启预览时，先展示计划让用户确认
    if (trigger === 'manual' && this.settings.syncPreviewEnabled && direction === 'bidirectional') {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const plan = await this.engine!.buildPreviewPlan(direction);
      const modal = this.openExclusive('sync-preview', () => new SyncPreviewModal(this.app, plan));
      if (!modal) {
        // 预览弹窗已打开（连点）：不重复弹，本次按取消处理
        return {
          ok: false,
          cancelled: true,
          uploaded: 0,
          downloaded: 0,
          deletedLocal: 0,
          deletedRemote: 0,
          conflicts: 0,
          skipped: 0,
          errors: 0,
          bytesUp: 0,
          bytesDown: 0,
          errorMessages: [],
        };
      }
      const ok = await modal.open();
      if (!ok) {
        this.statusBar.setIdle();
        this.log('info', '已取消同步（预览确认未通过）');
        return {
          ok: false,
          cancelled: true,
          uploaded: 0,
          downloaded: 0,
          deletedLocal: 0,
          deletedRemote: 0,
          conflicts: 0,
          skipped: 0,
          errors: 0,
          bytesUp: 0,
          bytesDown: 0,
          errorMessages: [],
        };
      }
    }
    this.statusBar.setSyncing();
    this.logM(
      'engine',
      'info',
      'info',
      `开始同步（${trigger}${direction !== 'bidirectional' ? `, ${direction}` : ''}）`,
    );
    return await this.withSuspendedWatcher(async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const result = await this.engine!.fullSync(trigger, direction);
        if (!result || result.cancelled) {
          this.statusBar.setIdle();
          if (!result) this.log('info', '同步被跳过：已有同步进行中');
          return (
            result ?? {
              ok: false,
              cancelled: true,
              uploaded: 0,
              downloaded: 0,
              deletedLocal: 0,
              deletedRemote: 0,
              conflicts: 0,
              skipped: 0,
              errors: 0,
              bytesUp: 0,
              bytesDown: 0,
              errorMessages: [],
            }
          );
        } else if (result.ok) {
          this.statusBar.setDone(this.summaryText(result));
          this.logM('engine', 'info', 'info', `同步完成：${this.summaryText(result)}`);
          // 🔴 仅当本次同步产生了「需要用户手动裁决」的草稿（pending-merge）才自动打开
          // 冲突面板，避免每次同步结束都被骚扰：
          //   - pending-merge：smart-merge 内嵌用户冲突标记，需手动合并 → 必然需要操作
          //   - 其它未 resolved（如 ask-me 策略产生）：用户已选择询问，本就在被弹
          //   - 全自动合并成功：仅发 Notice 提示，不弹窗
          // 同步失败 / 取消 / 网络异常一律不弹，避免误导用户。
          void this.maybeOpenConflictPanelAfterSync();
        } else {
          this.statusBar.setError(result.errorMessages[0] || '未知错误');
          this.logM(
            'engine',
            'error',
            'error',
            `同步失败：${result.errorMessages.join('；') || '未知错误'}`,
          );
          this.maybeSurfaceAuthFailure(result.errorMessages.join('；') || '未知错误');
        }
        // 实验室：同步健康分（失败/取消不影响主流程）
        if (this.settings.labEnabled && this.settings.labHealthEnabled && result) {
          void evaluateSyncHealth(this, result).catch(() => {});
        }
        return result;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.statusBar.setError(msg);
        this.logM('engine', 'error', 'error', `同步异常：${msg}`);
        this.maybeSurfaceAuthFailure(msg);
        return {
          ok: false,
          uploaded: 0,
          downloaded: 0,
          deletedLocal: 0,
          deletedRemote: 0,
          conflicts: 0,
          skipped: 0,
          errors: 1,
          bytesUp: 0,
          bytesDown: 0,
          errorMessages: [msg],
        };
      } finally {
        // 增量同步期间被占用而推迟的请求，在本次完整同步结束后补一次全量对账，
        // 确保并发编辑不会因「静默丢弃」而漏传。
        // 注意：必须解耦到下一个宏任务执行，不能在 finally 中同步递归调用 syncNow，
        // 否则每次同步结束都可能再触发、再递归，导致调用栈持续加深（潜在栈溢出）。
        if (this.pendingQuickSync) {
          this.pendingQuickSync = false;
          this.log('info', '执行被推迟的增量同步兜底对账');
          window.setTimeout(() => void this.syncNow('manual'), 0);
        }
      }
    });
  }

  /** 强制全量同步（本地覆盖云端 / 云端覆盖本地）：破坏性修复操作，先确认再执行。
   * 改造：先 dry-run 计算 SyncPlanPreview，让确认弹窗把"将上传/下载/删除/已校验一致"摆出来，
   * 避免"点了 force 提示'无变更'"带来的困惑——其实是没有需要传输/删除的文件，全程都跳过而已。*/
  /** 轮询等待引擎空闲（最多 timeoutMs）。用于「强制同步」等需要抢占锁的场景，
   *  避免被 busy 守卫静默吞掉。返回 true=已空闲，false=超时仍在忙。 */
  private async waitForIdle(timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (this.engine?.isBusy()) {
      if (Date.now() - start > timeoutMs) return false;
      await new Promise((r) => setTimeout(r, 200));
    }
    return true;
  }

  async forceSync(direction: 'force-upload' | 'force-download'): Promise<void> {
    if (!this.hasAuth()) {
      new Notice('BDNSync：请先在设置中配置百度网盘连接');
      return;
    }
    // 等待进行中的同步结束，避免「强制同步」被 busy 守卫静默吞掉
    // （用户日志中 force-upload 被「已有同步进行中」拦截的根因）。
    if (this.engine?.isBusy()) {
      const released = await this.waitForIdle(20000);
      if (!released) {
        new Notice('BDNSync：同步等待超时，请稍后重试');
        this.logM('general', 'info', 'warn', '强制同步：等待进行中的同步超时，已放弃');
        return;
      }
    }
    // 先 dry-run 一份计划（不发起任何写入），让弹窗展示"这次 force 实际会做什么"。
    // 若引擎未就绪或网络不通，回退成无计划的纯净确认弹窗（维持旧行为兜底）。
    let plan: SyncPlanPreview | null = null;
    if (this.engine) {
      try {
        plan = await this.engine.buildPreviewPlan(direction);
      } catch (e) {
        // dry-run 失败不阻断 force 流程（罕见的网络/解析异常都能让用户继续确认）
        this.log('info', `[dry-run 跳过] 强制同步预览失败，将不展示计划：${e instanceof Error ? e.message : String(e)}`);
        plan = null;
      }
    }
    const modal = this.openExclusive('force-sync-confirm', () => new ForceSyncConfirmModal(this.app, direction, plan));
    if (!modal) return; // 已有确认弹窗打开，忽略本次连点
    const confirm = await modal.open();
    if (confirm !== 'confirm') {
      this.log('info', `已取消强制同步（${direction}）`);
      return;
    }
    this.log('info', `开始强制同步（${direction}）`);
    await this.syncNow('manual', direction);
  }

  /** 取 Vault 在磁盘上的绝对路径（仅桌面端有效；移动端 / 非文件系统 adapter 返回 null） */
  private getVaultDiskPath(): string | null {
    if (!Platform.isDesktop) return null;
    // 官方要求：访问 adapter 文件系统属性前先 instanceof 校验，避免移动端 CapacitorAdapter 上取 basePath 崩溃
    const adapter = this.app.vault.adapter;
    return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null;
  }

  /**
   * 实验室 #5.9：基于 Git 差异的增量同步。
   * 采集 git 变更路径 → 喂给引擎 syncSubset（与 watcher 增量同一通道）。
   * 同步成功后把基线 ref 更新为最新 HEAD，下次自动收敛到「上次同步后」区间。
   * 非桌面 / 未开启 / 非 Git 仓库按设置回退常规同步或直接提示。
   */
  async syncViaGit(): Promise<SyncResult | null> {
    if (!Platform.isDesktop) {
      new Notice('Git 增量同步仅支持桌面端（依赖 git 二进制）');
      return null;
    }
    if (!this.settings.labEnabled || !this.settings.labGitEnabled) {
      new Notice('请先在「设置 → 实验室」中启用「Git 差异增量同步」');
      return null;
    }
    if (!this.engine) {
      new Notice('同步引擎尚未就绪');
      return null;
    }
    const disk = this.getVaultDiskPath();
    if (!disk) {
      new Notice('无法获取 Vault 磁盘路径');
      return null;
    }

    // 快速预检：非 Git 仓库直接走回退路径，避免盲目起 4 次 git 子进程后才发现
    if (!(await isGitRepo(disk))) {
      if (this.settings.labGitFallbackToScan) {
        new Notice('当前 Vault 不是 Git 仓库，已回退常规同步');
        return await this.syncNow('manual');
      }
      new Notice('当前 Vault 不是 Git 仓库，且未开启回退（设置 → 实验室）');
      return null;
    }

    const src = new GitChangeSource(disk, this.settings.lastGitSyncRef || undefined);
    let cs;
    try {
      cs = await src.collect();
    } catch (e) {
      new Notice(`Git 采集失败：${e instanceof Error ? e.message : String(e)}`);
      return null;
    }

    if (!cs) {
      if (this.settings.labGitFallbackToScan) {
        new Notice('当前 Vault 不是 Git 仓库，已回退常规同步');
        return await this.syncNow('manual');
      }
      new Notice('当前 Vault 不是 Git 仓库，且未开启回退（设置 → 实验室）');
      return null;
    }
    // 空值窄化后快照：闭包内引用 const，无需非空断言，也避免后续对 cs 的误用
    const changeSet = cs;

    // 同步成功或跳过时，都把基线 ref 推进到最新 HEAD，收敛区间
    const advanceRef = async () => {
      if (changeSet.head && changeSet.head !== this.settings.lastGitSyncRef) {
        this.settings.lastGitSyncRef = changeSet.head;
        await this.saveSettings();
      }
    };

    if (changeSet.paths.length === 0) {
      new Notice('Git 未检测到变更（working tree 干净）');
      await advanceRef();
      return null;
    }

    new Notice(`Git 检测到 ${changeSet.paths.length} 个变更文件，开始增量同步…`);
    const result = await this.engine.syncSubset(changeSet.paths);
    await advanceRef();
    new Notice(
      `Git 增量同步完成：${changeSet.paths.length} 个文件，成功 ${result.successPaths?.length ?? 0}`,
    );
    return result;
  }

  /** 局域网 P2P：本机作为「被同步对端」时的镜像落盘目录（置于 .obsidian 下，天然被云端同步排除） */
  private lanPeerDir(): string | null {
    const base = this.getVaultDiskPath();
    if (!base) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const path = (globalThis as any).require?.('path');
    if (!path) return null;
    return path.join(base, LAN_PEER_DIR);
  }

  /**
   * 实验室 #5.10：启动局域网对端服务。
   * 本机开始监听 TCP，等同「成为可被另一台设备同步的远端」；同时广播 UDP 信标便于被发现。
   */
  async startLanPeer(): Promise<void> {
    if (!Platform.isDesktop) {
      new Notice('局域网对端仅支持桌面端');
      return;
    }
    if (!this.settings.labEnabled || !this.settings.labLanEnabled) {
      new Notice('请先在「设置 → 实验室」中启用「局域网 P2P 同步」');
      return;
    }
    if (this.lanPeer) {
      new Notice(`局域网对端已在运行（端口 ${this.lanPeer.port}）`);
      return;
    }
    const dir = this.lanPeerDir();
    if (!dir) {
      new Notice('无法获取 Vault 磁盘路径');
      return;
    }
    const peer = new LanPeer({
      peerDataDir: dir,
      port: this.settings.lanListenPort,
      passphrase: this.settings.lanPassphrase,
    });
    // 无口令时监听外部接口等同局域网内明文可读写，明确警告，指导用户设配对码
    if (!this.settings.lanPassphrase) {
      new Notice('重要：未设置信道配对口令，局域网内任意设备均可连接本机对端，建议配置「设置→实验室→信道配对口令」');
    }
    try {
      await peer.listen();
    } catch (e) {
      new Notice(`启动局域网对端失败：${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    this.lanPeer = peer;
    new Notice(`局域网对端已启动，监听端口 ${peer.port}`);
    try {
      this.lanDiscovery = new LanDiscovery(
        this.settings.deviceId || 'bdnsync',
        this.settings.deviceName || 'BDNSync 设备',
      );
      this.lanDiscovery.startAdvertise(peer.port);
    } catch {
      /* 发现广播失败不影响同步，仅影响自动发现 */
    }
  }

  /** 停止局域网对端服务并停止信标广播 */
  stopLanPeer(): void {
    this.lanDiscovery?.stop();
    this.lanDiscovery = null;
    this.lanPeer?.close();
    this.lanPeer = null;
    new Notice('已停止局域网对端');
  }

  /**
   * 实验室 #5.10：与对端执行一次双向 fullSync。
   * 复用同一 Vault 与本地磁盘，但使用独立的 LocalStore 命名空间（bdnsync-lan）+ LanBackend，
   * 因此与云端同步的索引互不干扰。目标 host/port 优先取设置，缺省回退到本机监听端口。
   */
  async runLanSync(): Promise<void> {
    if (!Platform.isDesktop) {
      new Notice('局域网同步仅支持桌面端');
      return;
    }
    if (!this.settings.labEnabled || !this.settings.labLanEnabled) {
      new Notice('请先在「设置 → 实验室」中启用「局域网 P2P 同步」');
      return;
    }
    if (this.engine?.isBusy() || this.lanSyncing) {
      new Notice('已有同步进行中，请稍候');
      return;
    }
    const host = this.settings.lanTargetHost?.trim() || '127.0.0.1';
    const port = this.settings.lanTargetPort || this.settings.lanListenPort;
    if (!this.settings.lanTargetHost?.trim()) {
      // 未指定对端主机：回退到本机回环，仅用于同机多实例联调验证；
      // 跨设备直连必须在「设置→实验室→手动指定对端主机」填写另一台设备的 IP。
      new Notice('未指定对端主机，将尝试本机回环直连（联调用）；跨设备请填写对端 IP');
    }
    this.lanSyncing = true;
    new Notice(`局域网同步开始，连接 ${host}:${port} …`);
    const backend = new LanBackend({
      host,
      port,
      passphrase: this.settings.lanPassphrase,
      encryptor: this.makeEncryptor(),
    });
    const store = new LocalStore(this.app.vault.adapter, LAN_PLUGIN_DIR, {
      onCorruptIndex: () =>
        new Notice('局域网同步：本地索引校验失败，已自动重建（下次同步将全量对账）', 6000),
    });
    const engine = new SyncEngine(
      this.app,
      () => this.settings,
      backend,
      store,
      this.statusBar,
      async () => 'merge',
      (n: number) => this.statusBar.setConflicts(n),
      async () => 'proceed',
    );
    try {
      const res = await engine.fullSync('manual');
      if (res) {
        new Notice(
          `局域网同步完成：上传 ${res.uploaded}、下载 ${res.downloaded}、删除远端 ${res.deletedRemote}`,
        );
      } else {
        new Notice('局域网同步未执行（无变更或未完成）');
      }
    } catch (e) {
      new Notice(`局域网同步失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      backend.close(); // 释放持久 TCP 连接，避免半开 socket 残留
      this.lanSyncing = false;
    }
  }

  private async runQuickSync(paths: string[]): Promise<void> {
    if (this.disposing) return; // 卸载中：不发起新同步
    if (!this.engine || !this.settings.syncOnSave || this.settings.syncMode === 'manual') return;
    // 同步通知统一在全局容器弹出，避免叠加在设置容器区域
    this.closeSettingsIfOpen();
    if (!navigator.onLine) {
      this.statusBar.setOffline();
      // 离线：把路径计入脏集合，恢复后补齐
      for (const p of paths) this.dirtySet.mark(p);
      return;
    }
    // 引擎正忙（完整同步 / 上一次增量尚未结束）：把路径并入脏集合，等结束后补齐
    if (this.engine.isBusy()) {
      for (const p of paths) this.dirtySet.mark(p);
      this.pendingQuickSync = true;
      this.log('info', `增量同步被占用，推迟（${paths.length} 个文件将在下次同步补齐）`);
      return;
    }
    // 方案3：并入脏集合，以「全局脏集合」而非「本次 flush 单次路径」作为输入，减少退化全量
    for (const p of paths) this.dirtySet.mark(p);
    const allPaths = this.dirtySet.drain();
    this.statusBar.setSyncing(`同步中（${allPaths.length}）…`);
    await this.withSuspendedWatcher(async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const result = await this.engine!.quickSync(allPaths);
        // 细粒度重试：仅对「本次未成功落盘」的文件登记重试，已成功的文件立即 clearPaths，
        // 避免成功文件在当前/后续 flush 中被无意义重传到上限、浪费配额（M3）。
        const successSet = new Set(result.successPaths || []);
        const failed = allPaths.filter((p) => !successSet.has(p));
        if (!result.ok) {
          if (failed.length === 0) {
            // 无失败集但 ok=false（极少数边界）：整组 clear 以防卡死
            this.dirtySet.clearPaths(allPaths);
            this.statusBar.setError(result.errorMessages[0] || '同步失败');
            this.log('error', `保存同步失败：${(result.errorMessages || []).join('；')}`);
            return;
          }
          const firstMsg = (result.errorMessages && result.errorMessages[0]) || '同步失败';
          // 审计：此前无条件传 transient=true，非瞬态失败（鉴权/文件名非法/参数错误）
          // 也会入队空转重试 8 次浪费配额。按错误文案判定瞬态（限流/网络/超时）。
          const transient =
            /errno=31039|errno=31034|errno=42112|ECONN|ETIMEDOUT|ESOCKET|超时|网络|限流|503|502|429/i.test(
              firstMsg,
            );
          for (const p of failed) {
            // 瞬态判定基于该批次的首条错误信息（quickSync 顶层 catch 通常是整批级错误；
            // 单文件失败的路径会随脏集合保留，下次 flush 补齐）。
            this.retryQueue.registerFailure(p, firstMsg, transient, 0);
          }
          this.dirtySet.clearPaths(successSet.size ? Array.from(successSet) : []);
          this.dirtySet.keep(failed);
          this.statusBar.setError(firstMsg);
          this.log('error', `保存同步失败：${(result.errorMessages || []).join('；')}`);
          return;
        }
        // ok=true：本次增量同步无内部错误。只清除 quickSync「已确认处理」的文件
        // （upload/download/delete 或判定为已一致）；其余（因 busy / 无凭据 / 用户取消等
        // 被 bail 的文件）保留在脏集合中，待下次 flush 补齐——避免「被跳过却误清空脏集合」
        // 导致改动永久丢失（🔴#3）。
        this.dirtySet.clearPaths(Array.from(successSet));
        if (successSet.size === allPaths.length) {
          this.statusBar.setDone(`同步完成（${allPaths.length}）`);
          this.log('info', `保存同步完成：${allPaths.length} 个文件`);
        } else if (successSet.size > 0) {
          this.statusBar.setDone(`同步完成（${successSet.size}/${allPaths.length}）`);
          this.log('info', `保存同步完成：${successSet.size} 个文件，其余将在下次补齐`);
        } else {
          // 增量判定无需变更或暂挂：保留路径，等下次 flush 重新评估
          this.logM('general', 'info', 'debug', `保存同步暂未变更 ${allPaths.length} 个文件，保持待同步`);
        }
      } catch (e) {
        // quickSync 内部已吞掉异常并转为 SyncResult，此处仅捕获「quickSync 之外的异常」
        // （如 dirtySet/statusBar 调用异常）。无法获知部分成功集，保守整组 keep+重试。
        const msg = e instanceof Error ? e.message : String(e);
        // 方案1：瞬态失败（限流/网络）入队重试；非瞬态则仅报错。
        const transient =
          /errno=31039|errno=31034|ECONN|ETIMEDOUT|超时|网络|网络超时|503|502|429/i.test(msg);
        for (const p of allPaths) {
          this.retryQueue.registerFailure(p, msg, transient, 0);
        }
        this.dirtySet.keep(allPaths);
        this.statusBar.setError(msg);
        this.log('error', `保存同步异常：${msg}`);
      }
    });
  }

  /**
   * 方案2 风暴处理：单次批次变更过多（>stormThreshold），降级为一次完整同步；
   * 完整同步自然覆盖所有变更，避免逐文件增量误删/误增。
   */
  private async runStormSync(paths: string[]): Promise<void> {
    this.log('info', `检测到批量变更（${paths.length} 个文件），转为完整同步以保证一致性`);
    await this.syncNow('auto');
  }

  // ---------------- 失败重试队列持久化（方案1） ----------------

  private async loadTransferStateForRetry(): Promise<void> {
    try {
      const st = await this.store.loadRetryState();
      this.retryQueue.hydrate(st);
    } catch {
      /* ignore */
    }
    this.retryQueue.schedulePoll(15_000); // 后台每 15s 尝试 flush 到期条目
  }

  private async persistRetryState(): Promise<void> {
    try {
      await this.store.saveRetryState(this.retryQueue.toState().items);
    } catch {
      /* ignore */
    }
  }

  private onLocalChange(path: string): void {
    if (!this.settings.syncOnSave || this.settings.syncMode === 'manual') return;
    if (new PathFilter(this.settings).isExcluded(path)) return;
    this.watcher.onChange(path);
  }

  /**
   * 本地目录创建/移动后的云端目录补建（空文件夹同步修复点）。
   * 复用 engine.ensureRemoteDirs（幂等、受沙箱根护栏保护）。
   * 仅在已登录、未处于手动模式、路径未被排除时执行；运行中同步会由下一次全量扫描覆盖，故并发跳过。
   */
  private ensureRemoteFolder(relPath: string): void {
    if (!this.hasAuth() || !this.engine) return;
    if (this.settings.syncMode === 'manual') return;
    if (new PathFilter(this.settings).isExcluded(relPath)) return;
    if (this.engine.isBusy()) return; // 正在同步中：本次由全量扫描统一补建，避免重复 mkdir
    void this.engine
      .ensureRemoteDirs([relPath])
      .then((r) => {
        if (r.errors.length) {
          new Notice(`BDNSync：空目录同步失败 ${relPath}（详见控制台）`, 4000);
        }
      })
      .catch(() => {
        /* 静默 */
      });
  }

  /** 反向引用索引：vault 变更后防抖重建（仅实验室 Backlinks 开启时） */
  private scheduleBacklinkRebuild(): void {
    if (!this.settings.labEnabled || !this.settings.labBacklinksEnabled) return;
    if (this.backlinkRebuildTimer !== null) window.clearTimeout(this.backlinkRebuildTimer);
    this.backlinkRebuildTimer = window.setTimeout(() => {
      this.backlinkRebuildTimer = null;
      void rebuildBacklinkIndex(this).catch(() => {});
    }, 1500);
  }

  private async onLayoutReady(): Promise<void> {
    try {
      const ts = await this.store.loadTransferState();
      this.cloudAdapter.restoreSessions(ts.uploads);
      const idx = await this.store.loadLocalIndex();
      this.statusBar.setConflicts(idx.conflicts.filter((c) => !c.resolved).length);
    } catch {
      /* ignore */
    }
    if (this.settings.syncOnStartup && this.hasAuth()) {
      await this.syncNow('startup');
    }
    // 启动后静默拉取网盘配额（存储使用情况），避免连接卡片一直显示「尚未测试连接」/ 0B。
    // 仅在已有凭据且尚未获取过配额时触发，失败静默忽略，不阻断其它流程。
    if (this.hasAuth() && !this.lastQuota && navigator.onLine) {
      void this.refreshQuota();
    }
    // 后台拉取账号/会员等级，用于设置页会员中心卡片 + 状态栏徽标
    if (this.hasAuth() && navigator.onLine) {
      void this.refreshVipInfo();
    }
    // 拉起本地流式代理，使预览 Modal 可免落盘在线打开/播放网盘文件
    if (this.hasAuth() && navigator.onLine) {
      void this.ensureStreamServer();
    }
    // P0-orphan-prevention 启动时巡检：即使今天没做过任何同步，也能发现「外部力量」
    // （其它同步工具 / 手动网盘操作 / 多设备并发）造成的孤儿。
    // 24h 限频由 runAutoOrphanScanIfDue 自身保证，与同步结束钩子共用同一时间窗。
    if (this.hasAuth() && navigator.onLine) {
      void this.runAutoOrphanScanIfDue({ from: 'startup' }).catch(() => {
        /* 静默 */
      });
    }
  }

  /** 后台刷新账号/会员等级，写回 lastVipInfo 与最近错误，通知设置页刷新 */
  async refreshVipInfo(): Promise<UserInfo | null> {
    // 10 分钟内复用上次结果，避免每次点开播放器都打 uinfo
    if (this.lastVipInfo && Date.now() - this.lastVipInfoAt < 10 * 60 * 1000)
      return this.lastVipInfo;
    const token = ++this.vipRerenderToken;
    try {
      const info = await this.makeApi().getUserInfo();
      if (token !== this.vipRerenderToken) return info; // 已被更新的并发调用覆盖
      this.lastVipInfo = info;
      this.lastVipInfoAt = Date.now();
      this.lastVipInfoError = null;
      // 与 lastTestedUser 联动：VIP 检测拿到名字时同步过去，避免设置页 user 与 vip 错位
      if (info.name) this.lastTestedUser = info.name;
      window.dispatchEvent(new CustomEvent('bdnsync:vip-updated'));
      return info;
    } catch (e) {
      if (token !== this.vipRerenderToken) return null;
      this.lastVipInfoError =
        e instanceof Error ? redactSecrets(e.message) : redactSecrets(String(e));
      window.dispatchEvent(new CustomEvent('bdnsync:vip-updated'));
      return null;
    }
  }

  /** 后台刷新网盘配额（存储使用情况），写回 lastQuota 与最近错误，通知设置页刷新 */
  async refreshQuota(): Promise<QuotaInfo | null> {
    try {
      const q = await this.makeApi().getQuota();
      this.lastQuota = q;
      this.lastQuotaError = null;
      window.dispatchEvent(new CustomEvent('bdnsync:quota-updated'));
      return q;
    } catch (e) {
      // 保存最近一次失败原因，让设置页连接卡片能告诉用户为什么没拿到容量。
      // 失败原因可能包含敏感字段（access_token 等），先经 redactSecrets 脱敏再存储。
      this.lastQuotaError =
        e instanceof Error ? redactSecrets(e.message) : redactSecrets(String(e));
      window.dispatchEvent(new CustomEvent('bdnsync:quota-updated'));
      return null;
    }
  }

  hasAuth(): boolean {
    const s = this.settings;
    return !!(s.bduss || s.cookies || s.accessToken);
  }

  /**
   * 鉴权失败（AUTH_FAILED / -6 / 111 / 50305）的无感恢复入口：
   * 检测到同步因鉴权失效失败后，弹出「重新授权」动作，引导用户在设置中重连，
   * 而不是仅留一句难以定位的报错。避免鉴权过期后用户一直看到失败却不知如何处理。
   */
  private authNoticeShownAt = 0;
  private maybeSurfaceAuthFailure(msg: string): void {
    if (!/AUTH_FAILED|access_token|errno=-6|errno=111|errno=50305|授权|令牌|token|errno=6|errno=111/i.test(msg))
      return;
    const now = Date.now();
    // 限频：同一鉴权问题 10 分钟内只提示一次，避免反复刷屏（沉浸无感）
    if (now - this.authNoticeShownAt < 10 * 60_000) return;
    this.authNoticeShownAt = now;
    // #3.7 错误诊断：复用中文知识库给出可读提示
    const diag = diagnoseByMessage(msg);
    const detail = diag ? `（${diag.zh}${diag.hint ? '；' + diag.hint : ''}）` : '';
    const notice = new Notice(
      `BDNSync：网盘授权已失效或过期，点击「重新授权」恢复同步。${detail}`,
      12000,
    );
    notice.noticeEl.addEventListener('click', () => {
      this.openSettingsTab();
    });
  }

  // ---------------- 状态摘要 ----------------

  private buildStatusSummary(): {
    lastSyncAt: number;
    lastSummary: string;
    quotaUsed: number;
    quotaTotal: number;
  } {
    const idx = this.store?.lastLoadedIndex;
    const quotaUsed = this.lastQuota?.used ?? 0;
    const quotaTotal = this.lastQuota?.total ?? 0;
    return {
      lastSyncAt: idx?.lastSyncAt ?? 0,
      lastSummary: idx?.stats.lastSyncSummary ?? '',
      quotaUsed,
      quotaTotal,
    };
  }

  private summaryText(r: SyncResult): string {
    const parts: string[] = [];
    if (r.uploaded) parts.push(`上传 ${r.uploaded}`);
    if (r.downloaded) parts.push(`下载 ${r.downloaded}`);
    if (r.deletedLocal + r.deletedRemote) parts.push(`删除 ${r.deletedLocal + r.deletedRemote}`);
    if (r.conflicts) parts.push(`冲突 ${r.conflicts}`);
    return parts.length ? parts.join('，') : '无变更';
  }

  // ---------------- 日志 ----------------
  // 业务类型 → 默认级别（与旧 logger 的 inferLevel 一致：error→error，conflict→warn，其余→info）
  private inferLevel(type: SyncLogEntry['type']): LogLevel {
    return type === 'error' ? 'error' : type === 'conflict' ? 'warn' : 'info';
  }

  /** 旧契约：this.log(type, message, path) —— 默认归到 general 模块 */
  log(type: SyncLogEntry['type'], message: string, path?: string): void {
    this.logger.log('general', type, this.inferLevel(type), message, path);
  }

  /** 模块化日志：显式指定来源模块、业务类型、级别（核心子系统使用） */
  logM(
    module: LogModule,
    type: SyncLogEntry['type'],
    level: LogLevel,
    message: string,
    path?: string,
  ): void {
    this.logger.log(module, type, level, message, path);
  }

  // ---------------- 自动同步调度 ----------------

  restartScheduler(): void {
    this.nextAutoSyncAt = Date.now() + Math.max(1, this.settings.autoSyncInterval) * 60_000;
    this.autoFailCount = 0;
  }

  /** 由 registerInterval 每 30 秒调用 */
  tickScheduler(): void {
    if (this.disposing) return; // 卸载中：不发起新同步
    // 周期性后台同步只适用于 auto 模式。
    // realtime 模式仅靠「保存文件 → 3 秒防抖 → quickSync」响应，不做定时轮询；
    // manual 模式完全由用户手动触发。
    if (this.settings.syncMode !== 'auto') return;
    if (!this.hasAuth()) return;
    if (Date.now() < this.nextAutoSyncAt) return;
    if (this.engine?.isBusy()) return;

    const intervalMs = Math.max(1, this.settings.autoSyncInterval) * 60_000;
    const backoffMs =
      this.autoFailCount <= 0
        ? intervalMs
        : this.autoFailCount === 1
          ? 60_000
          : this.autoFailCount === 2
            ? 5 * 60_000
            : 15 * 60_000;
    this.nextAutoSyncAt = Date.now() + backoffMs;

    void this.syncNow('auto').then((r) => {
      // #4.5 定时自动快照：同步成功后，若达到间隔则顺带生成一个快照点（备注含触发来源）
      if (
        r &&
        r.ok &&
        this.settings.autoSnapshot &&
        this.settings.snapshotIntervalMinutes > 0 &&
        Date.now() - this.lastSnapshotAt >= this.settings.snapshotIntervalMinutes * 60_000
      ) {
        this.lastSnapshotAt = Date.now();
        void this.engine
          ?.takeSnapshot(`定时自动快照（${new Date().toLocaleString()}）`)
          .then((n) =>
            this.logM('engine', 'info', 'info', `定时快照完成：${n} 个文件`),
          )
          .catch(() => {});
      }
      if (r && !r.ok && !r.cancelled) {
        this.autoFailCount++;
        // 服务端故障/限流：进入长退避时给出低频友好提示（沉浸无感——
        // 后台安静重试，仅在退避明显拉长时提醒一次，避免刷屏）。
        if (this.autoFailCount >= 3 && this.autoFailCount % 3 === 0) {
          new Notice(
            `BDNSync：自动同步暂未成功（已连续失败 ${this.autoFailCount} 次），将在后台自动重试。若持续失败，请检查网络或网盘授权。`,
            6000,
          );
        }
      } else {
        this.autoFailCount = 0;
      }
    });
  }

  /**
   * #2.1 API 稳定性与容灾：轻量探查 list/upload/quota，落日志并评估是否需要降级。
   * best-effort：任何异常都被吞掉，绝不阻断主同步。
   */
  private async runApiProbe(): Promise<void> {
    if (this.disposing || !this.hasAuth()) return;
    const api = this.makeApi();
    const root = this.settings.remoteRoot;
    const result = await probeHealth(api, root);
    const summary = `API 探查：${result.ok ? '正常' : '异常'}（list=${result.listOk ? '✓' : '✗'}${result.quota ? ' quota=✓' : ' quota=✗'}${result.diagnose ? ` ${result.diagnose.zh}` : ''}）`;
    this.logM('engine', 'info', result.ok ? 'info' : 'warn', summary);
    if (!result.ok) {
      const currentMode: 'cookies' | 'openapi' = this.settings.cookies || this.settings.bduss
        ? 'cookies'
        : 'openapi';
      const { degrade, advice } = probeDegradationAdvice(result, currentMode);
      if (advice) this.logM('engine', 'info', 'warn', `容灾建议：${advice}`);
      // 仅在 OpenAPI 故障且存在 Cookie 凭证时，主动提示可切换（不自动切，避免误伤上传能力）
      if (degrade && currentMode === 'openapi' && (this.settings.cookies || this.settings.bduss)) {
        new Notice(
          `BDNSync：OpenAPI 探测异常，建议临时切换至 Cookie 模式继续同步。详情见设置 → 连接。`,
          8000,
        );
      }
    }
  }

  // ---------------- 面板 ----------------

  /**
   * 若 Obsidian 设置页（Modal 形式）当前打开，则关闭它。
   * 目的：同步触发的弹窗（预览/冲突/首次引导 Modal、错误 Notice）统一在全局
   * document.body 容器弹出，避免叠加在设置容器区域，造成「弹窗嵌在设置页里」。
   * 内部 API（app.setting）运行时稳定存在；不存在时静默跳过。
   */
  private closeSettingsIfOpen(): void {
    try {
      const setting = (this.app as unknown as { setting?: { close(): void } }).setting;
      if (setting && typeof setting.close === 'function') setting.close();
    } catch {
      /* 关闭设置页失败不影响同步 */
    }
  }

  /** 已打开的弹窗实例表（单实例守卫用）：key → 实例引用 */
  private openModals = new Map<string, Modal>();
  /** 当前打开的孤儿清理弹窗引用（用于「已打开时重新聚焦」而非静默忽略） */
  private orphanModal: OrphanCleanupModal | null = null;

  /** 忙碌提示：与 engine 通知共用同一套共享限频（同文案 3 秒内只弹一次） */
  private notifyBusy(msg: string, timeout?: number): void {
    if (!shouldShowNotice(msg)) return;
    new Notice(msg, timeout);
  }

  /**
   * 单实例弹窗守卫：同一 key 的弹窗已打开时**不重复创建**，返回 null（调用方直接
   * 短路返回），避免用户快速双击/连点触发时叠加多个相同弹窗（Obsidian 每个 Modal
   * 都是独立 DOM 遮罩，叠加后既遮视线又难关闭；且 Promise 型 Modal 二次 open 会
   * 覆盖 resolveP 造成 Promise 悬挂）。
   * 弹窗关闭时自动从表里移除（覆写 close 钩子，不破坏原行为）。
   */
  private openExclusive<T extends Modal>(key: string, create: () => T): T | null {
    const existing = this.openModals.get(key);
    if (existing) {
      // 🔴 守卫自修复：若已登记的弹窗其实已关闭（close 因 open 渲染异常 / 特殊关闭路径
      // 未触发 guard 清理），其 containerEl 已被 Obsidian detach（脱离 DOM）。此时仍把它
      // 当成「打开中」会永久卡死该 key——表现为「孤儿目录扫描一直被限制打开」。
      // 检测到失效引用即清除，允许本次重新打开（自愈），杜绝一次异常后的死锁。
      const stillOpen = !!(existing.containerEl && existing.containerEl.parentElement);
      if (!stillOpen) {
        this.openModals.delete(key);
      } else {
        return null;
      }
    }
    const modal = create();
    this.openModals.set(key, modal);
    const origClose = modal.close.bind(modal);
    modal.close = () => {
      origClose();
      // 关闭后释放引用（同一 key 下次可重新打开）
      if (this.openModals.get(key) === modal) this.openModals.delete(key);
    };
    return modal;
  }

  private openSettingsTab(): void {
    // Obsidian 内部 API：app.setting 未在公开类型中暴露，但运行时稳定存在
    const setting = (this.app as unknown as {
      setting?: { open(): void; openTabById(id: string): void };
    }).setting;
    if (!setting) return;
    setting.open();
    if (typeof setting.openTabById === 'function') {
      setting.openTabById(this.manifest.id);
    }
  }

  openConflictPanel(): void {
    void (async () => {
      const idx = await this.store.loadLocalIndex();
      const conflicts = idx.conflicts.filter((c) => !c.resolved);
      const refresh = async () => {
        const fresh = await this.store.loadLocalIndex();
        // 强制同步 conflict + retry 两个独立徽章（避免 retry 抢占 conflict 元素）
        this.statusBar.forceSyncBadges(
          fresh.conflicts.filter((c) => !c.resolved).length,
          this.retryQueue.size,
        );
      };
      const modal = this.openExclusive('conflict-panel', () =>
        new ConflictModal(
          this.app,
          conflicts,
          async (path, strategy) => {
            const ok = await this.withSuspendedWatcher(() =>
              // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
              this.engine!.resolvePending(path, strategy),
            );
            await refresh();
            return ok;
          },
          () => void refresh(),
        ),
      );
      if (!modal) return;
      // 🔴 关键修复：ConflictModal 关闭（用户点 X / 全部解决完 / 按 ESC）时强制同步徽章。
      // 旧实现仅在 resolve 回调里 refresh——若用户点 X 关闭、resolvePending 抛错、或 modal
      // 被 onClose hook 路径不触发 refresh，徽章就会卡在"已处理还显示 N"的旧状态。
      const origClose = modal.close.bind(modal);
      modal.close = () => {
        origClose();
        void refresh();
      };
      modal.open();
    })();
  }

  /**
   * 同步完成后自动开冲突面板的判定函数。仅当存在 status==='pending-merge' 的草稿时
   * 自动打开 ConflictModal（这些草稿需要用户手动合并，无法自动收尾）；其它情形
   * （无冲突 / 仅 ask-me 策略未决议 / 已自动合并完成）一律不主动弹窗。
   *
   * 异常路径（同步被取消 / 鉴权失败 / 网络错误）不弹，避免误导用户。
   */
  private async maybeOpenConflictPanelAfterSync(): Promise<void> {
    try {
      const idx = await this.store.loadLocalIndex();
      const pending = idx.conflicts.filter(
        (c) => !c.resolved && c.status === 'pending-merge' && !!c.draftPath,
      );
      if (pending.length === 0) {
        // 已全部自动合并完成或无冲突：发一条 Notice 告知，避免用户疑惑（视图中
        // statusBar 徽章会清零，但有些用户会盯着「同步完成」提示）。
        // 这里判静默 OR Notice 二选：仅当之前有未解决冲突才提示，避免噪声。
        const anyUnresolved = idx.conflicts.some((c) => !c.resolved);
        if (anyUnresolved) {
          this.notifyBusy(
            `BDNSync：${idx.conflicts.filter((c) => !c.resolved).length} 个冲突未解决（含 ask-me/强制分支等），点击状态栏徽章打开面板`,
            6000,
          );
        }
        return;
      }
      this.logger.log(
        'cleanup',
        'info',
        'info',
        `检测到 ${pending.length} 个待手动合并的草稿，自动打开冲突面板`,
      );
      this.openConflictPanel();
    } catch (e) {
      // 读索引失败不阻断主流程，仅记录
      this.log('info', `检查冲突面板失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** P0-1.4 打开第一个待处理草稿的合并面板（命令入口） */
  async openMergePanelFirst(): Promise<void> {
    const idx = await this.store.loadLocalIndex();
    const pending = idx.conflicts.find((c) => c.status === 'pending-merge' && c.draftPath);
    if (!pending) {
      new Notice('BDNSync：当前没有待处理的合并草稿');
      return;
    }
    await this.openMergePanel(pending.path);
  }

  /** P0-1.4 打开指定路径的合并面板：三栏对比 + 逐段裁决 + 保存写回 */
  async openMergePanel(path: string): Promise<void> {
    try {
      const idx = await this.store.loadLocalIndex();
      const conflict = idx.conflicts.find(
        (c) => c.path === path && c.status === 'pending-merge' && c.draftPath,
      );
      if (!conflict || !conflict.draftPath) {
        new Notice('BDNSync：未找到该文件的合并草稿');
        return;
      }
      const vault = this.app.vault;
      const draftText = await vault.adapter.read(conflict.draftPath).catch(() => '');
      const localText = await vault.adapter.read(path).catch(() => '');
      // 远端内容：优先 base 缓存，其次从网盘下载
      const remoteBytes =
        conflict.remoteHash != null
          ? await this.store.getBase(conflict.remoteHash).catch(() => null)
          : null;
      const remoteText =
        remoteBytes != null
          ? new TextDecoder('utf-8', { fatal: false }).decode(remoteBytes)
          : '(远端内容不可用，仅展示草稿)';
      // 标签必须与生成标记时完全一致（审计 #8）：marker 由 conflict-resolver 用
      // deviceName / remoteDevice 生成，解析时若截断（如 deviceB.slice(0,8)）会导致
      // extractConflictSections 精确匹配失败 → 冲突段全部解析不到 → 误判无冲突。
      const localLabel = this.settings.deviceName || '本机';
      const remoteLabel = conflict.deviceB || 'REMOTE';
      const engine = this.engine;
      if (!engine) {
        new Notice('BDNSync：引擎未初始化');
        return;
      }
      this.openExclusive('merge-panel', () =>
        new MergePanelModal(this.app, {
          path,
          draftText,
          localText,
          remoteText,
          localLabel,
          remoteLabel,
          onSave: async (mergedText) => {
            const ok = await this.withSuspendedWatcher(() => engine.confirmMergeDraft(path, mergedText));
            await this.statusBar.setConflicts(
              (await this.store.loadLocalIndex()).conflicts.filter((c) => !c.resolved).length,
            );
            return ok;
          },
        }),
      )?.open();
    } catch (e) {
      new Notice(`BDNSync：打开合并面板失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** P2-4.2 撤销最近一次冲突合并（恢复冲突前内容 + 清理草稿） */
  async undoLastMerge(): Promise<void> {
    try {
      const engine = this.engine;
      if (!engine) {
        new Notice('BDNSync：引擎未初始化');
        return;
      }
      const idx = await this.store.loadLocalIndex();
      const target = [...idx.conflicts]
        .reverse()
        .find((c) => c.status === 'pending-merge' || (c.resolved && c.resolvedBy === 'manual'));
      if (!target) {
        new Notice('BDNSync：没有可撤销的合并记录');
        return;
      }
      const ok = await this.withSuspendedWatcher(() => engine.undoMerge(target.path));
      if (ok) {
        new Notice(`BDNSync：已撤销「${target.path}」的合并`);
        await this.statusBar.setConflicts(
          (await this.store.loadLocalIndex()).conflicts.filter((c) => !c.resolved).length,
        );
      } else {
        new Notice('BDNSync：撤销失败（冲突前版本不可用）');
      }
    } catch (e) {
      new Notice(`BDNSync：撤销失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * P1-3.4 配置快照：syncConfigDir 开启且 configSnapshotRetention > 0 时，
   * 同步后对 .obsidian 配置目录打轻量快照（文件 → hash/mtime/size），
   * 供「一键回滚最近稳定配置」使用。内容由 base 池按 hash 引用。
   */
  private async snapshotConfigIfEnabled(): Promise<void> {
    if (!this.settings.syncConfigDir) return;
    const retention = this.settings.configSnapshotRetention;
    if (retention <= 0) return;
    const idx0 = await this.store.loadLocalIndex();
    // 审计 #12：时间门控（10 分钟）——配置快照成本随 .obsidian 体积线性增长，
    // 每次同步全量遍历会带来无谓开销；高频同步（如实时模式）下 10 分钟内只拍一次。
    const last = idx0.configSnapshots?.[0]?.createdAt ?? 0;
    if (last && Date.now() - last < 10 * 60 * 1000) return;
    const adapter = this.app.vault.adapter;
    const files: Record<string, { hash: string; mtime: number; size: number }> = {};
    let totalBytes = 0;
    const walk = async (dir: string): Promise<void> => {
      const list = await adapter.list(dir).catch(() => ({ files: [], folders: [] }));
      for (const f of list.files) {
        if (/\.obsidian\/plugins\/bdnsync\//.test(f)) continue; // 不拍插件自身数据
        const bytes = new Uint8Array(await adapter.readBinary(f).catch(() => new ArrayBuffer(0)));
        if (bytes.length === 0) continue;
        const hash = md5Hex(bytes);
        files[f] = { hash, mtime: Date.now(), size: bytes.length };
        totalBytes += bytes.length;
        await this.store.putBase(hash, bytes);
      }
      for (const d of list.folders) await walk(d);
    };
    await walk('.obsidian');
    const idx = await this.store.loadLocalIndex();
    this.store.pushConfigSnapshot(
      idx,
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        createdAt: Date.now(),
        deviceId: this.settings.deviceId,
        deviceName: this.settings.deviceName,
        reason: '同步后配置自动快照',
        files,
        totalFiles: Object.keys(files).length,
        totalBytes,
      },
      retention,
    );
    await this.store.saveLocalIndex(idx);
  }

  /** P1-3.4 一键回滚 .obsidian 配置到最近稳定版本 */
  async restoreConfigSnapshot(): Promise<boolean> {
    try {
      const idx = await this.store.loadLocalIndex();
      const snaps = this.store.getConfigSnapshots(idx);
      if (snaps.length === 0) {
        new Notice('BDNSync：没有可用的配置快照（需开启「同步 .obsidian 配置目录」并同步一次）');
        return false;
      }
      const snap = snaps[0]; // 最近一份
      const adapter = this.app.vault.adapter;
      let restored = 0;
      for (const [path, meta] of Object.entries(snap.files)) {
        const bytes = await this.store.getBase(meta.hash);
        if (!bytes) continue;
        const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
        if (dir) await adapter.mkdir(dir).catch(() => {});
        await adapter.writeBinary(path, u8ToArrayBuffer(bytes));
        restored++;
      }
      new Notice(
        `BDNSync：已回滚 ${restored} 个配置项（快照时间 ${new Date(snap.createdAt).toLocaleString()}）`,
      );
      return true;
    } catch (e) {
      new Notice(`BDNSync：配置回滚失败：${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  async openStats(): Promise<void> {
    const idx = await this.store.loadLocalIndex();
    let quota: QuotaInfo | null = null;
    if (this.hasAuth()) {
      quota = await this.makeApi()
        .getQuota()
        .catch(() => null);
    }
    this.openExclusive('stats', () =>
      new StatsModal(
        this.app,
        idx.stats,
        idx.lastSyncAt,
        idx.lastRemoteSyncVersion,
        this.settings.deviceName,
        this.settings.deviceId,
        quota,
        this.settings.deleteStrategy,
        this.logger,
      ),
    )?.open();
  }

  openLogPanel(): void {
    this.activateView(VIEW_TYPE_BDNSYNC_LOG);
  }

  openNetdiskBrowser(): void {
    this.activateView(VIEW_TYPE_BDNSYNC_BROWSER);
  }

  /**
   * 打开（若已开则复用）一个 ItemView 标签页。在主内容区（root split）新开，
   * 与参考代码 `getLeaf(true).setViewState({type})` 一致，用户可与其它笔记并列/拖拽。
   */
  private async activateView(type: string): Promise<void> {
    const { workspace } = this.app;
    // 1) 已有同类型 leaf 则直接 reveal
    const existing = workspace.getLeavesOfType(type);
    if (existing.length > 0) {
      workspace.revealLeaf(existing[0]);
      return;
    }
    // 2) 否则在主内容区新开一个 leaf
    const leaf = workspace.getLeaf(true);
    await leaf.setViewState({ type, active: true });
    workspace.revealLeaf(leaf);
  }

  async openRemoteUsage(): Promise<void> {
    if (!this.hasAuth()) {
      new Notice('BDNSync：请先配置百度网盘连接');
      return;
    }
    this.openExclusive('remote-usage', () =>
      new RemoteUsageModal(
        this.app,
        this.makeApi(),
        this.settings.remoteRoot || '/apps/bdnsync/MyVault',
      ),
    )?.open();
  }

  async openSnapshots(): Promise<void> {
    this.openExclusive('snapshots', () =>
      new SnapshotRestoreModal(this.app, this.store, async (snap) => {
        await this.engine?.restoreSnapshot(snap, (t, m) => {
          // 回调参数 t 是级别（info/warn/error），映射到 general 模块 + 'info' 业务类型
          this.logger.log('general', 'info', t, m);
        });
      }),
    )?.open();
  }

  /** 构造脱敏诊断上下文（#3.7 一键复制诊断），供同步日志视图调用 */
  buildDiagnosticContext(): DiagnosticContext {
    return {
      version: this.manifest.version,
      platform: Platform.isMobile ? 'mobile' : 'desktop',
      settings: this.settings,
    };
  }

  async openCrossDeviceDashboard(): Promise<void> {
    if (!this.settings.crossDeviceDashboardEnabled) {
      new Notice('BDNSync：跨设备看板已在设置中关闭');
      return;
    }
    if (!this.hasAuth()) {
      new Notice('BDNSync：请先配置百度网盘连接');
      return;
    }
    this.activateView(VIEW_TYPE_BDNSYNC_DASHBOARD);
  }

  /** P1-3.5 生成密钥文件模板（首行留空待填写密码），并设为密钥文件路径 */
  async createKeyFileTemplate(): Promise<void> {
    const path = this.settings.keyFilePath?.trim() || DEFAULT_KEY_FILE;
    const content = keyFileTemplate('');
    if (await this.app.vault.adapter.exists(path)) {
      new Notice(`BDNSync：密钥文件已存在（${path}），未覆盖`);
      return;
    }
    await this.app.vault.adapter.write(path, content);
    this.settings.keyFilePath = path;
    await this.saveSettings();
    new Notice(`BDNSync：已生成密钥文件模板 ${path}，请编辑首行填入密码`);
  }

  /** P2-3.5 更改加密密码（重新加密）：弹出双密码输入，确认后委托引擎重加密 */
  async openReEncrypt(): Promise<void> {
    if (!this.settings.encryptionEnabled) {
      new Notice('BDNSync：请先启用端到端加密');
      return;
    }
    if (!this.settings.encryptionSalt) {
      new Notice('BDNSync：加密盐尚未初始化，请先完成一次加密同步');
      return;
    }
    new ReEncryptModal(this.app, async (newPassword) => {
      const engine = this.engine;
      if (!engine) {
        new Notice('BDNSync：同步引擎尚未初始化');
        return;
      }
      try {
        const { reuploadCount } = await engine.reEncryptWith(newPassword);
        this.settings.encryptionPassword = newPassword;
        await this.saveSettings();
        new Notice(
          `BDNSync：密钥已更换，${reuploadCount} 个文件将在下次同步以新密码重新上传`,
          8000,
        );
      } catch (e) {
        new Notice(`BDNSync：改密失败：${(e as Error).message}`);
      }
    }).open();
  }

  async openConflictReport(): Promise<void> {
    const idx = await this.store.loadLocalIndex();
    const entries = (idx.lastConflictReport || []).slice().reverse();
    this.openExclusive('conflict-report', () => new ConflictReportModal(this.app, entries))?.open();
  }

  /**
   * 网盘孤儿备份目录清理入口（手动 + 自动巡检共用）。
   * 不论哪种入口都走 OrphanCleanupModal，行为差异通过 opts.autoMode 区分。
   */
  async openOrphanCleanupModal(opts: { autoMode?: boolean; preScanned?: DeepScanResult } = {}): Promise<void> {
    if (!this.cloudAdapter) {
      new Notice('BDNSync：尚未配置，无法扫描');
      return;
    }
    if (!this.hasAuth()) {
      new Notice('BDNSync：请先完成百度网盘认证');
      return;
    }
    const vaultName = this.app.vault.getName();
    const remoteRoot = this.settings.remoteRoot || `/apps/bdnsync/${vaultName}`;
    const parentDir = remoteParent(remoteRoot);
    // 严格扫描边界：父目录必须是 ≥2 段的绝对路径（不能就是根）
    if (!parentDir || parentDir === '/' || parentDir === remoteRoot) {
      new Notice(
        'BDNSync：同步根目录位于网盘根，无法扫描。请先在设置「同步目录」中指定 /apps/bdnsync/<vault 名>。',
      );
      return;
    }

    // 1) 构造弹窗并立即打开：先展示「正在扫描…」，扫描在后台执行（U1 修复：
    //    不再在打开弹窗前 await 扫描，避免大库扫描期间 UI 长时间无响应/卡死）
    const lister = this.makeOrphanLister();
    const deleter = this.makeOrphanDeleter();
    // 🟡#10：自动巡检（同步结束钩子）与手动打开可能并发触发，用 openExclusive 互斥，
    // 避免同一时刻出现两个孤儿清理弹窗（双弹窗会各自扫描、竞态覆盖结果）。
    const modal = this.openExclusive('orphan-cleanup', () =>
      new OrphanCleanupModal(this.app, vaultName, parentDir, lister, deleter, {
      autoMode: !!opts.autoMode,
      retentionDays: this.settings.orphanRetentionDays,
      bulkConfirmThreshold: this.settings.bulkDeleteConfirm,
      useRecycleBin: this.settings.orphanUseRecycleBin !== false,
      scanMode: this.settings.orphanScanMode,
      // v2 主入口：open() 后由 startDeepScan 驱动扫描，禁止 onOpen 再跑 legacy 自扫
      // （否则并发双扫描竞态：结果/阶段/勾选集合不确定，且 legacy 只扫父目录层）。
      legacyScanOnOpen: false,
      onComplete: (r) => {
        // 弹窗真正关闭：释放引用（🟡#10 重新聚焦守卫依赖此字段判定「已有弹窗」）
        this.orphanModal = null;
        // 扫描结果从 modal 取（startDeepScan 完成时回填 lastScan；取消/失败时可能为空）。
        // modal 由 openExclusive 返回（可能为 null），但本回调只在弹窗真正关闭时触发，
        // 此时 modal 必为非 null。闭包捕获的联合类型无法被下方 null 守卫收窄，故用非空断言
        // （与 engine.ts 既有用法一致）。
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const scanResult = modal!.lastScan;
        const findings = scanResult?.findings ?? [];
        const stats = scanResult?.stats;
        // 任何结果（取消/完成/失败）都更新 lastOrphanScanAt，作为下次 24h 限频基准
        this.settings.lastOrphanScanAt = Date.now();
        void this.saveSettings();
        const level: 'info' | 'warn' = r.failedCount > 0 ? 'warn' : 'info';
        const text = r.cancelled
          ? `orphan 巡检取消（已选 ${r.selectedCount}）`
          : `orphan 清理完成：成功 ${r.okCount}、失败 ${r.failedCount}（已选 ${r.selectedCount}）`;
        this.logger.log('cleanup', 'info', level, text);
        // P0-5 审计闭环：持久化 lastOrphanReport（v2 含扫描摘要）
        void this.store
          .loadLocalIndex()
          .then(async (idx) => {
            const counts = this.countFindingsByKind(findings);
            idx.lastOrphanReport = [
              {
                at: Date.now(),
                scannedParent: parentDir,
                total: findings.length,
                selected: r.selectedCount,
                ok: r.okPaths ?? [],
                failed: r.failedPaths ?? [],
                mode: opts.autoMode ? 'auto' : 'manual',
                summary: {
                  scanMode: this.settings.orphanScanMode,
                  nodesScanned: stats?.scannedNodes ?? 0,
                  bytesScanned: stats?.scannedBytes ?? 0,
                  backupDirCount: counts.backupDir,
                  orphanFileCount: counts.orphanFile,
                  orphanDirCount: counts.orphanDir,
                  truncated: stats?.truncated ?? false,
                  useRecycleBin: this.settings.orphanUseRecycleBin !== false,
                },
              },
            ];
            await this.store.saveLocalIndex(idx);
          })
          .catch(() => {
            /* 审计写入失败不影响主流程 */
          });
        // 详细结果（每条失败）落 info 级别日志，便于审计
        if (!r.cancelled && r.failedCount > 0) {
          this.logger.log(
            'cleanup',
            'info',
            'warn',
            `扫描模式 ${this.settings.orphanScanMode}，发现 ${findings.length} 个候选，清理完成（含 ${r.failedCount} 条失败，详见面板失败列表）`,
          );
        }
      },
    }),
    );
    if (!modal) {
      // 已有孤儿清理弹窗在打开中（自动巡检 + 手动并发）。不再静默记「忽略」日志，
      // 而是给出明确提示，避免用户反复点击命令却只看到忽略日志、误以为弹窗坏了（🟡#10）。
      // 注：不重复调用 modal.open()（会再次触发 onOpen 重复渲染），弹窗本就可见，提示即可。
      new Notice('BDNSync：孤儿清理弹窗已在打开中');
      return;
    }
    this.orphanModal = modal;
    try {
      modal.open();
    } catch (e) {
      // 🔴 自修复：open() 渲染期异常（如 DOM 构建失败）会导致弹窗未真正显示但仍占着
      // openModals 的 'orphan-cleanup' key。立即清理守卫并提示，避免「一次异常后永远
      // 打不开」的死锁（与 openExclusive 的自修复互为兜底）。
      this.openModals.delete('orphan-cleanup');
      this.orphanModal = null;
      new Notice(`BDNSync：孤儿清理弹窗打开失败：${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    // 2) 后台执行深度扫描：弹窗先显示「正在扫描…」，完成后回填列表（U1 修复）。
    //    若调用方已预扫（自动巡检钩子路径），直接回填预扫结果，避免二次扫描。
    if (opts.preScanned) {
      void modal.applyPreScanned(opts.preScanned);
    } else {
      void modal.startDeepScan(() =>
        this.runOrphanScan({
          vaultName,
          parentDir,
          remoteRoot,
          onProgress: (info) => modal.updateScanProgress(info),
        }),
      );
    }
  }

  /**
   * 统一孤儿扫描入口。根据 settings.orphanScanMode 选择 parent-only（legacy）/ scoped / full-vault。
   * 三个模式都返回统一的 DeepScanResult（含 findings + 扫描统计 + 错误），下游 modal 不需关心模式。
   *
   * 注：sync-index 交叉校验通过 LocalIndex.files —— 仅当文件在 idx.files 中且未被删除时算 active。
   */
  private async runOrphanScan(opts: {
    vaultName: string;
    parentDir: string;
    remoteRoot: string;
    /** 实时进度回调（由 modal 接收并展示当前扫描路径/节点数） */
    onProgress?: (info: ScanProgress) => void;
  }): Promise<DeepScanResult> {
    const s = this.settings;
    const mode = s.orphanScanMode;
    // 收集忽略规则：excludePatterns（既有过滤）+ orphanExtraIgnoreGlobs（新加的）
    const ignoreGlobs = [
      ...(s.excludePatterns || []),
      ...(s.orphanExtraIgnoreGlobs || []),
      // 永远排除插件自身基础设施目录（即使用户改坏设置也不会误删索引）。
      // 关键：必须用「裸 glob」（如 `.bdnsync`）而非 `.bdnsync/**` ——
      // globToRegExp 对裸项生成 `^\.bdnsync(/.*)?$`，同时覆盖「目录条目本身」与「整棵子树」；
      // 若只写 `X/**`，目录条目 X 本身不命中忽略，会被误判为 orphan-dir 甚至被删除（F1 回归）。
      // 此处直接复用 orphan-cleanup.ts 的 PLUGIN_INFRA_HARD_EXCLUDE 单一事实源，
      // 与 pickOrphans 的精确名称白名单保持一致，避免两处不同步。
      ...PLUGIN_INFRA_HARD_EXCLUDE,
      // `.obsidian` 是 Obsidian 系统配置目录，与 .bdnsync 一样由同步引擎在任意方向完全隔离
      // （engine.ts 系统目录隔离），绝不参与用户内容同步，因此也不能作为 orphan 候选
      // （否则 syncConfigDir 关闭时可能被误判为 orphan-dir 而遭删除）。注意：其时间戳备份型
      // 兄弟目录 `.obsidian_20260825_140911` 不会被本 glob 命中（裸 glob `^\.obsidian(/.*)?$`
      // 只匹配 `.obsidian` 本身与子树，不匹配 `.obsidian_<ts>`），仍可正常识别为孤儿。
      '.obsidian',
    ];

    // 准备 LocalIndex 交叉校验：路径 → 是否 active
    let activeFiles: Set<string> | null = null;
    try {
      const idx = await this.store.loadLocalIndex();
      const set = new Set<string>();
      for (const [p, st] of Object.entries(idx.files || {})) {
        if (!st.deleted) set.add(p.replace(/\\/g, '/'));
      }
      activeFiles = set;
    } catch {
      activeFiles = null; // 读不到不阻断
    }
    // 🔴#4：索引为空 / 读取失败 → 不可信。此时「索引依赖型」孤儿判定会把整库误标为可删除，
    // 因此降级为仅保留命名型备份目录判定（trustIndex=false）。删除是破坏性操作，漏判远优于误删。
    const indexUsable = activeFiles !== null && activeFiles.size > 0;
    if (!indexUsable) {
      this.logM(
        'general',
        'info',
        'warn',
        '孤儿清理：本地同步索引为空/不可用，已跳过「索引依赖型」孤儿判定（仅保留命名型备份目录），避免误标整个 vault',
      );
    }

    const isActive: ClassifyOptions['isActive'] = (relPath) => {
      if (!activeFiles) return false;
      return activeFiles.has(relPath);
    };

    if (mode === 'parent-only') {
      // 旧管线：单层扫父目录，命中 backup-dir（不进入 vault 根内部）
      const walked = await walkRemoteTree(this.makeOrphanLister(), {
        parentDir: opts.parentDir,
        remoteRoot: opts.remoteRoot,
        vaultName: opts.vaultName,
        mode: 'parent-only',
        maxDepth: 0,
        maxNodes: s.orphanScanMaxNodes || 20000,
        maxBytes: s.orphanScanMaxBytes || 0,
        concurrency: s.orphanScanConcurrency || 3,
        ignoreGlobs,
        onProgress: opts.onProgress,
      });
      const findings = await classifyOrphans(walked.nodes, {
        vaultName: opts.vaultName,
        isActive,
        ignoreGlobs,
        trustIndex: indexUsable,
      });
      // 诊断警告落地到日志，便于审计"为何父目录层走了搜索兜底"
      for (const w of walked.warnings) this.logM('cleanup', 'info', 'warn', w);
      return {
        findings,
        scannedNodes: walked.scannedNodes,
        scannedBytes: walked.scannedBytes,
        truncated: walked.truncated,
        durationMs: 0,
        errors: walked.errors,
        warnings: walked.warnings,
      };
    }

    // scoped / full-vault：走完整 walkRemoteTree + classify
    const scanOpts: DeepScanOptions = {
      parentDir: opts.parentDir,
      remoteRoot: opts.remoteRoot,
      vaultName: opts.vaultName,
      mode,
      maxDepth: s.orphanScanMaxDepth || 0,
      maxNodes: s.orphanScanMaxNodes || 20000,
      maxBytes: s.orphanScanMaxBytes || 0,
      concurrency: s.orphanScanConcurrency || 3,
      ignoreGlobs,
      onProgress: opts.onProgress,
    };
    const res = await runDeepScan(this.makeOrphanLister(), scanOpts, {
      vaultName: opts.vaultName,
      isActive,
      ignoreGlobs,
      trustIndex: indexUsable,
    });
    // 诊断警告落地到日志
    for (const w of res.warnings) this.logM('cleanup', 'info', 'warn', w);
    return {
      findings: res.findings,
      scannedNodes: res.scannedNodes,
      scannedBytes: res.scannedBytes,
      truncated: res.truncated,
      durationMs: res.durationMs,
      errors: res.errors,
      warnings: res.warnings,
    };
  }

  /** 按 kind 统计 OrphanFinding 数量（用于审计摘要） */
  private countFindingsByKind(findings: OrphanFinding[]): {
    backupDir: number;
    orphanFile: number;
    orphanDir: number;
  } {
    let backupDir = 0;
    let orphanFile = 0;
    let orphanDir = 0;
    for (const f of findings) {
      if (f.kind === 'backup-dir') backupDir++;
      else if (f.kind === 'orphan-file') orphanFile++;
      else if (f.kind === 'orphan-dir') orphanDir++;
    }
    return { backupDir, orphanFile, orphanDir };
  }

  /**
   * orphan-cleanup 用 Lister：调用 adapter.listRemoteDir（绝对路径）后，
   * 把返回的「相对父目录的 basename」重新拼接为「完整绝对路径」——
   * adapter 默认行为是把 parent 前缀剥掉以供同步决策用，但 orphan-cleanup
   * 需要把绝对路径直接交给 deleter；不拼接会触发 Baidu API errno=-7
   * 「文件或目录名不合法」（API 在用户家目录找 basename 找不到）。
   */
  private makeOrphanLister(): RemoteLister {
    if (!this.cloudAdapter) throw new Error('BDNSync：adapter 未初始化');
    const api = this.getApi();
    return {
      async listDir(absPath: string): Promise<RemoteDirRow[]> {
        // strict：listDir 在百度沙箱根（如 /apps/bdnsync）常因 errno=-9 被 api.listDir
        // **静默返回空**（同步链路把「不存在」当「空」是有意为之）。孤儿扫描必须区分
        // 「真空 vs 读取失败」——strict 模式抛错后 walkRemoteTree 才能正确走 search 兜底
        // 并产出诊断 warning（否则「网盘里明明有孤儿却扫描为 0」，且无任何提示）。
        const rows = await api.listDir(absPath, { strict: true });
        return rows.map((r) => ({
          // api.listDir 返回的是绝对路径（与 adapter 的"剥前缀"不同），直接透传
          path: r.path || remoteJoin(absPath, r.name),
          name: r.name,
          isDir: r.isDir,
          mtime: r.mtime,
          size: r.size,
        }));
      },
      // 🔴 孤儿扫描兜底：父目录层（沙箱根）listDir 常因 errno=-9 返回空，导致扫描 0 结果。
      // 这里暴露百度 search 接口，由 walkRemoteTree 在 listDir 失败时反向枚举孤儿目录。
      async search(keyword: string, dir: string): Promise<RemoteDirRow[]> {
        const hits = await api.search(keyword, dir);
        return hits.map((h) => ({
          path: h.path,
          name: h.name,
          isDir: h.isDir,
          mtime: h.mtime,
          size: h.size,
        }));
      },
    };
  }

  /** orphan-cleanup 用 Deleter：直接用 live api.deleteFiles（不走 adapter；orphan 路径已是绝对路径）
   *  注：百度网盘 xpan OpenAPI 的「deleteFiles」本身就是移到回收站（可逆）。
   *  真正「永久删除」需要额外调回收站清理接口（不同账户/版本差异大），
   *  本实现选择把 useRecycleBin=false 也复用 deleteFiles —— 由 modal 显式提示
   *  「永久删除仍需到百度网盘 Web 端清空回收站」。这样保证永远不会「假装永久」
   *  造成用户预期之外的不可逆损失。 */
  private makeOrphanDeleter(): RemoteDeleter {
    // 显式捕获 api 引用，避免对象字面量内部 this 引用歧义
    const api = this.getApi();
    return {
      async deleteFiles(fullPaths: string[]): Promise<void> {
        await api.deleteFiles(fullPaths);
      },
      // 占位：保持接口兼容；目前未实现独立「跳过回收站」路径
      async deleteFilesPermanent(fullPaths: string[]): Promise<void> {
        // 兜底走回收站（最安全选择）；modal 会在 UI 上显式标注「需手动清空回收站」
        await api.deleteFiles(fullPaths);
      },
    };
  }

  /**
   * 同步结束后 / 启动时由 engine hook / onLayoutReady 调用的"是否应触发 orphan 巡检"判定 + 触发入口。
   *
   * P0-orphan-prevention 三档策略：
   *  1. detectOrphanBackupDirs=false → 直接 return（用户完全关停）
   *  2. detectOrphanBackupDirs=true && autoPrune=false → 仅检测，扫到就写日志 + 爆发提示
   *  3. autoPrune=true → 弹模态框让用户确认（仍受 24h 限频）
   *
   * 爆发检测（防误判）：把"本次扫描识别到的孤儿 path 集合"与「上次清理报告」中 ok 列表对比，
   * 新增数 ≥ BURST_THRESHOLD 时弹一条高优 Notice（哪怕 detect=true & autoPrune=false），
   * 提示用户网盘父目录短期内被外部力量"反复打备份"，可能是其它工具/手动操作造成。
   */
  private async runAutoOrphanScanIfDue(opts: { from?: 'sync' | 'startup' } = {}): Promise<void> {
    if (!this.settings.detectOrphanBackupDirs) return;
    if (this.settings.autoPruneOrphanBackupDirs !== true) {
      // 仅检测不主动弹窗：仍跑一次扫描（24h 限频），写一条诊断日志，但**不弹窗**
      const now = Date.now();
      if (!shouldScanOrphans(this.settings.lastOrphanScanAt, now)) return;
      this.settings.lastOrphanScanAt = now;
      void this.saveSettings();
      try {
        // 检测必须与弹窗主链路同一引擎（runOrphanScan），覆盖父目录层 + vault 自身层
        // 两类孤儿（旧 collectOrphanCandidates 只扫父目录层，vault 内 .obsidian_*/ .bdnsync_*
        // 时间戳备份会漏报——升级目标「消除扫描盲区」要求检测路径同样覆盖两层）。
        const vaultName = this.app.vault.getName();
        const remoteRoot = this.settings.remoteRoot || `/apps/bdnsync/${vaultName}`;
        const parentDir = remoteParent(remoteRoot);
        if (parentDir && parentDir !== '/' && parentDir !== remoteRoot) {
          const scan = await this.runOrphanScan({ vaultName, parentDir, remoteRoot });
          const { findings } = scan;
          if (findings.length > 0) {
            const high = findings.filter((f) => f.risk === 2).length;
            const mid = findings.filter((f) => f.risk === 1).length;
            const kinds = this.countFindingsByKind(findings);
            this.logger.log(
              'cleanup',
              'info',
              'warn',
              `${opts.from === 'startup' ? '启动' : '同步后'}检测到 ${findings.length} 个疑似孤儿（高风险 ${high}、中等 ${mid}；备份目录 ${kinds.backupDir}、孤儿文件 ${kinds.orphanFile}、孤儿目录 ${kinds.orphanDir}）。请运行「BDNSync：扫描并清理网盘备份目录」处理。`,
            );
            // 爆发检测（基于两层命中路径对比上次清理报告）
            void this.maybeBurstNotice(findings);
          }
        }
      } catch (e) {
        this.logger.log(
          'cleanup',
          'info',
          'warn',
          `orphan 巡检失败：${e instanceof Error ? e.message : String(e)}`,
        );
      }
      return;
    }
    // autoPrune 开启：先扫描，仅当确有候选时才弹模态框（仍需手动确认删除）。
    // 关键修复：不再「无论有无孤儿都弹空弹窗」——空弹窗既无清理价值，又会在同步刚结束/启动时
    // 弹窗遮挡，让用户误以为「同步未完成」（即用户反馈的「同步一直不显示完成」根因）。
    const now2 = Date.now();
    if (!shouldScanOrphans(this.settings.lastOrphanScanAt, now2)) return;
    this.settings.lastOrphanScanAt = now2;
    void this.saveSettings();
    try {
      const vaultName = this.app.vault.getName();
      const remoteRoot = this.settings.remoteRoot || `/apps/bdnsync/${vaultName}`;
      const parentDir = remoteParent(remoteRoot);
      if (!parentDir || parentDir === '/' || parentDir === remoteRoot) {
        this.logger.log('cleanup', 'info', 'info', `${opts.from === 'startup' ? '启动' : '同步后'}孤儿巡检：同步根位于网盘根，跳过`);
        return;
      }
      const scan = await this.runOrphanScan({ vaultName, parentDir, remoteRoot });
      // 与 modal 内一致：autoMode 按保留天数过滤（保留期内的近期备份属正常活动，不弹出）
      let findings = scan.findings;
      if ((this.settings.orphanRetentionDays ?? 0) > 0) {
        const cutoff = Date.now() - (this.settings.orphanRetentionDays ?? 0) * 24 * 3600 * 1000;
        findings = findings.filter((f) => f.mtime === 0 || f.mtime < cutoff);
      }
      if (findings.length === 0) {
        this.logger.log(
          'cleanup',
          'info',
          'info',
          `${opts.from === 'startup' ? '启动' : '同步后'}孤儿巡检：未发现需清理的孤儿备份，不弹窗`,
        );
        return;
      }
      // 直接把预扫结果交给弹窗回填，避免二次扫描
      await this.openOrphanCleanupModal({ autoMode: true, preScanned: scan });
    } catch (e) {
      this.logger.log(
        'cleanup',
        'info',
        'warn',
        `orphan 巡检失败：${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /**
   * 爆发检测：与上次清理报告对比，**新增** ≥ 3 个孤儿 → 弹 Notice 提示。
   * 即使 autoPrune=false（用户不愿弹模态框）也会触发，因为「短期内多出备份」属于异常状态，
   * 需要让用户知道可能存在「外部工具写入同路径」或「手动重命名」等根因。
   * 实现：读 idx.lastOrphanReport（最近一次清理结果），取出当时成功的 ok 集合和失败的 failed 集合，
   * 用差集求新增项。
   */
  private static readonly BURST_THRESHOLD = 3;

  private async maybeBurstNotice(currentItems: Array<{ fullPath: string }>): Promise<void> {
    if (currentItems.length === 0) return;
    const currentPaths = new Set(currentItems.map((it) => it.fullPath));
    let prevHandled: Set<string> | null = null;
    try {
      const idx = await this.store.loadLocalIndex();
      const last = idx.lastOrphanReport?.[0];
      if (last) {
        prevHandled = new Set([...last.ok, ...last.failed.map((f) => f.path)]);
      }
    } catch {
      /* 读不到就不做对比，直接当首次 */
    }
    // 首次巡检（prevHandled=null）时：仅在孤儿数 ≥ 阈值时也提示一次（让用户知道有这个机制）
    const prevSet = prevHandled;
    const newOnes = prevSet ? [...currentPaths].filter((p) => !prevSet.has(p)) : [];
    const burstCount = prevSet ? newOnes.length : currentItems.length;
    if (burstCount < BDNSyncPlugin.BURST_THRESHOLD) return;

    const sample = (prevHandled ? newOnes : [...currentPaths])
      .slice(0, 3)
      .map((p) => `  · ${p}`)
      .join('\n');
    const more = burstCount > 3 ? `\n  …还有 ${burstCount - 3} 个` : '';
    new Notice(
      `⚠️ BDNSync：网盘父目录短期内新增 ${burstCount} 个疑似孤儿备份\n${sample}${more}\n\n常见原因：\n  · 其它同步工具 / 百度网盘客户端在写入同路径\n  · 你在网盘 Web 端手动重命名了 vault 根\n  · 多设备 BDNSync 并发同步竞争\n\n建议：运行命令「BDNSync：扫描并清理网盘备份目录」处理。`,
      0, // 持续显示，需用户手动关闭
    );
  }

  /** 版本历史：从文件右键/命令打开（取当前活动文件） */
  async openVersionHistory(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice('BDNSync：请先打开一个文件');
      return;
    }
    this.openExclusive('version-history', () =>
      new VersionHistoryModal(this.app, this.store, file.path, async (path, content) => {
        const buf = u8ToArrayBuffer(content);
        await this.app.vault.adapter.writeBinary(path, buf);
        new Notice(`BDNSync：已恢复 ${path}（本地已更新，下次同步将上传）`);
      }),
    )?.open();
  }

  /** 恢复文件到指定版本（供版本面板调用，写入本地 + 触发上传） */
  async restoreVersion(path: string, content: Uint8Array): Promise<void> {
    await this.app.vault.adapter.writeBinary(path, u8ToArrayBuffer(content));
    await this.runQuickSync([path]);
  }
}
