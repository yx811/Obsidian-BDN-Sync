// BDNSync 插件入口：生命周期、命令、事件、调度器、新 UI 集成

import { Modal, Notice, Plugin, TAbstractFile, TFile } from 'obsidian';
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
} from './types';
import {
  PathFilter,
  genDeviceId,
  formatBytes,
  u8ToArrayBuffer,
  shouldShowNotice,
  remoteParent,
  remoteJoin,
} from './util/misc';
import { Logger } from './util/logger';
import { md5Hex } from './util/md5';
import { LogStore } from './util/log-store';
import {
  pickOrphans as pickOrphansUtil,
  measureOrphans as measureOrphansUtil,
  shouldScanOrphans,
  type RemoteLister,
  type RemoteDeleter,
  type RemoteDirRow,
  type OrphanEntry,
} from './util/orphan-cleanup';
import { sealSecretsInPlace, unsealSecretsInPlace } from './security/secrets';
import { RetryQueue } from './sync/retry-queue';
import { DirtySet } from './sync/dirty-set';
import { StreamServer } from './stream-server';
import { rewriteBdnRefs, recoverBdnRefs, buildBdnRef } from './lab/media-bridge';
import { rebuildBacklinkIndex } from './lab/backlinks';
import { evaluateSyncHealth } from './lab/health-score';
// 引入插件样式：esbuild 会将其打包并通过 onload 注入，缺失会导致全部 UI 弹窗无样式
import '../styles.css';

const PLUGIN_DIR = '.obsidian/plugins/bdnsync';

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
  private adapter!: BaiduAdapter;
  /** 本地持久化存储（LocalStore）：实验功能读写索引/报告等使用 */
  store!: LocalStore;
  private nextAutoSyncAt = 0;
  private autoFailCount = 0;
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
    this.registerView(VIEW_TYPE_BDNSYNC_LOG, (leaf) => new SyncLogView(leaf, this.logger));
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
    // P0-1.4 冲突合并面板（仅当存在 pending-merge 草稿时展示）
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

    // 实验功能：插入 bdn:// 网盘媒体引用（相对 remoteRoot）
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

    // 本地流式代理：布局就绪后启动（已授权才需要），供预览 Modal 免落盘在线打开/播放
    this.app.workspace.onLayoutReady(() => {
      if (this.hasAuth()) {
        this.streamServer = new StreamServer(this);
        this.streamServer.start().catch((e) => {
          console.warn(
            `[BDNSync] 本地流式代理启动失败（预览将回退为下载模式）：${(e as Error)?.message || String(e)}`,
          );
          this.streamServer = null;
        });
      }
    });
  }

  onunload(): void {
    // 标记卸载：之后不再接受新的同步触发（周期调度 / 保存增量 / pending 兜底），
    // 避免 dispose 清空 watcher 定时器后仍有上传在 api 层裸跑丢失最后几个文件。
    this.disposing = true;
    // 卸载前尽量把「保存后尚未同步」的待提交变更 flush 出去，避免移动端/关闭时丢改。
    // flush() 现在会 await 实际的 runQuickSync 完成；由于 onunload 是同步上下文、Obsidian
    // 不保证等待其异步结束，这里以「尽力同步 + startup 全量兜底」双保险：先 fire-and-forget
    // 发起 flush，待其完成（或失败）后再 dispose，确保 flush 触发的同步不被 dispose 打断。
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
    void this.store?.saveTransferState(this.adapter?.exportSessions() ?? []).catch(() => {
      /* ignore */
    });
    document.body?.classList.remove('bdnsync-theme-hc');
    // 关闭所有已打开的工作区视图（文件浏览器 / 同步日志 / 文件预览）
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_BDNSYNC_BROWSER);
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_BDNSYNC_LOG);
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_BDNSYNC_PREVIEW);
    // 停止本地流式代理，释放端口
    this.streamServer?.stop();
    this.streamServer = null;
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
    this.adapter = new BaiduAdapter(this.api, () => this.settings, this.makeEncryptor());
    this.store = new LocalStore(this.app.vault.adapter, PLUGIN_DIR, {
      onCorruptIndex: () =>
        new Notice('BDNSync：本地索引校验失败，已自动重建（下次同步将全量对账）', 6000),
    });
    this.engine = new SyncEngine(
      this.app,
      () => this.settings,
      this.adapter,
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
    this.adapter?.setEncryptor(this.makeEncryptor());
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
    if (this.engine?.isBusy()) {
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
          if (!result) this.log('info', '同步被跳过（已有同步进行中）');
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

  /** 强制全量同步（本地覆盖云端 / 云端覆盖本地）：破坏性修复操作，先确认再执行 */
  async forceSync(direction: 'force-upload' | 'force-download'): Promise<void> {
    if (this.engine && this.engine.isBusy()) {
      new Notice('BDNSync：已有同步正在进行，请稍候');
      return;
    }
    if (!this.hasAuth()) {
      new Notice('BDNSync：请先在设置中配置百度网盘连接');
      return;
    }
    const modal = this.openExclusive('force-sync-confirm', () => new ForceSyncConfirmModal(this.app, direction));
    if (!modal) return; // 已有确认弹窗打开，忽略本次连点
    const confirm = await modal.open();
    if (confirm !== 'confirm') {
      this.log('info', `已取消强制同步（${direction}）`);
      return;
    }
    this.log('info', `开始强制同步（${direction}）`);
    await this.syncNow('manual', direction);
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
        // ok=true：全量成功（errors===0）
        this.dirtySet.clearPaths(allPaths);
        this.statusBar.setDone(`同步完成（${allPaths.length}）`);
        this.log('info', `保存同步完成：${allPaths.length} 个文件`);
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
      this.adapter.restoreSessions(ts.uploads);
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
    if (!/AUTH_FAILED|access_token|errno=-6|errno=111|errno=50305|授权|令牌|token/i.test(msg))
      return;
    const now = Date.now();
    // 限频：同一鉴权问题 10 分钟内只提示一次，避免反复刷屏（沉浸无感）
    if (now - this.authNoticeShownAt < 10 * 60_000) return;
    this.authNoticeShownAt = now;
    const notice = new Notice('BDNSync：网盘授权已失效或过期，点击「重新授权」恢复同步。', 12000);
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

  // ---------------- 面板 ----------------

  /**
   * 若 Obsidian 设置页（Modal 形式）当前打开，则关闭它。
   * 目的：同步触发的弹窗（预览/冲突/首次引导 Modal、错误 Notice）统一在全局
   * document.body 容器弹出，避免叠加在设置容器区域，造成「弹窗嵌在设置页里」。
   * 内部 API（app.setting）运行时稳定存在；不存在时静默跳过。
   */
  private closeSettingsIfOpen(): void {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const setting = (this.app as any).setting;
      if (setting && typeof setting.close === 'function') setting.close();
    } catch {
      /* 关闭设置页失败不影响同步 */
    }
  }

  /** 已打开的弹窗实例表（单实例守卫用）：key → 实例引用 */
  private openModals = new Map<string, Modal>();

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
    if (this.openModals.has(key)) return null;
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const setting = (this.app as any).setting;
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
        this.statusBar.setConflicts(fresh.conflicts.filter((c) => !c.resolved).length);
      };
      this.openExclusive('conflict-panel', () =>
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
      )?.open();
    })();
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

  async openConflictReport(): Promise<void> {
    const idx = await this.store.loadLocalIndex();
    const entries = (idx.lastConflictReport || []).slice().reverse();
    this.openExclusive('conflict-report', () => new ConflictReportModal(this.app, entries))?.open();
  }

  /**
   * 网盘孤儿备份目录清理入口（手动 + 自动巡检共用）。
   * 不论哪种入口都走 OrphanCleanupModal，行为差异通过 opts.autoMode 区分。
   */
  async openOrphanCleanupModal(opts: { autoMode?: boolean } = {}): Promise<void> {
    if (!this.adapter) {
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
    // 严格 1 层扫描边界：父目录必须是 ≥2 段的绝对路径（不能就是根）
    if (!parentDir || parentDir === '/' || parentDir === remoteRoot) {
      new Notice(
        'BDNSync：同步根目录位于网盘根，无法严格 1 层扫描。请先在设置「同步目录」中指定 /apps/bdnsync/<vault 名>。',
      );
      return;
    }
    const lister = this.makeOrphanLister();
    const deleter = this.makeOrphanDeleter();
    const modal = new OrphanCleanupModal(this.app, vaultName, parentDir, lister, deleter, {
      autoMode: !!opts.autoMode,
      retentionDays: this.settings.orphanRetentionDays,
      bulkConfirmThreshold: this.settings.bulkDeleteConfirm,
      onComplete: (r) => {
        // 任何结果（取消/完成/失败）都更新 lastOrphanScanAt，作为下次 24h 限频基准
        this.settings.lastOrphanScanAt = Date.now();
        void this.saveSettings();
        const level: 'info' | 'warn' = r.failedCount > 0 ? 'warn' : 'info';
        const text = r.cancelled
          ? `orphan 巡检取消（已选 ${r.selectedCount}）`
          : `orphan 清理完成：成功 ${r.okCount}、失败 ${r.failedCount}（已选 ${r.selectedCount}）`;
        this.logger.log('cleanup', 'info', level, text);
        // P0-5 审计闭环：持久化 lastOrphanReport（可溯源：时间/范围/数量/成败明细）
        void this.store
          .loadLocalIndex()
          .then(async (idx) => {
            idx.lastOrphanReport = [
              {
                at: Date.now(),
                scannedParent: parentDir,
                total: r.selectedCount + r.failedCount,
                selected: r.selectedCount,
                ok: r.okPaths ?? [],
                failed: r.failedPaths ?? [],
                mode: opts.autoMode ? 'auto' : 'manual',
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
            `扫描父目录 ${parentDir}，发现 ${r.selectedCount} 个候选，清理完成（含 ${r.failedCount} 条失败，详见面板失败列表）`,
          );
        }
      },
    });
    modal.open();
  }

  /**
   * orphan-cleanup 用 Lister：调用 adapter.listRemoteDir（绝对路径）后，
   * 把返回的「相对父目录的 basename」重新拼接为「完整绝对路径」——
   * adapter 默认行为是把 parent 前缀剥掉以供同步决策用，但 orphan-cleanup
   * 需要把绝对路径直接交给 deleter；不拼接会触发 Baidu API errno=-7
   * 「文件或目录名不合法」（API 在用户家目录找 basename 找不到）。
   */
  private makeOrphanLister(): RemoteLister {
    const adapter = this.adapter;
    if (!adapter) throw new Error('BDNSync：adapter 未初始化');
    return {
      async listDir(absPath: string): Promise<RemoteDirRow[]> {
        const rows = await adapter.listRemoteDir(absPath);
        return rows.map((r) => ({
          // 关键：把相对 basename 与已知 absPath 拼回绝对路径，供 deleter 使用
          path: r.path ? remoteJoin(absPath, r.path) : remoteJoin(absPath, r.name),
          name: r.name,
          isDir: r.isDir,
          mtime: r.mtime,
          size: r.size,
        }));
      },
    };
  }

  /** orphan-cleanup 用 Deleter：直接用 live api.deleteFiles（不走 adapter；orphan 路径已是绝对路径） */
  private makeOrphanDeleter(): RemoteDeleter {
    // 显式捕获 api 引用，避免对象字面量内部 this 引用歧义
    const api = this.getApi();
    return {
      async deleteFiles(fullPaths: string[]): Promise<void> {
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
        const items = await this.collectOrphanCandidates();
        if (items.length > 0) {
          const high = items.filter((it) => it.risk === 2).length;
          const mid = items.filter((it) => it.risk === 1).length;
          this.logger.log(
            'cleanup',
            'info',
            'warn',
            `${opts.from === 'startup' ? '启动' : '同步后'}检测到 ${items.length} 个疑似孤儿目录（高风险 ${high}、中等 ${mid}）。请运行「BDNSync：扫描并清理网盘备份目录」处理。`,
          );
          // 爆发检测
          void this.maybeBurstNotice(items);
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
    // autoPrune 开启：弹模态框（仍需手动确认删除）。
    // 审计 #4：与「仅检测」分支同样受 24h 限频，避免每次成功同步都弹框打扰。
    const now2 = Date.now();
    if (!shouldScanOrphans(this.settings.lastOrphanScanAt, now2)) return;
    this.settings.lastOrphanScanAt = now2;
    void this.saveSettings();
    await this.openOrphanCleanupModal({ autoMode: true });
  }

  /**
   * 爆发检测：与上次清理报告对比，**新增** ≥ 3 个孤儿 → 弹 Notice 提示。
   * 即使 autoPrune=false（用户不愿弹模态框）也会触发，因为「短期内多出备份」属于异常状态，
   * 需要让用户知道可能存在「外部工具写入同路径」或「手动重命名」等根因。
   * 实现：读 idx.lastOrphanReport（最近一次清理结果），取出当时成功的 ok 集合和失败的 failed 集合，
   * 用差集求新增项。
   */
  private static readonly BURST_THRESHOLD = 3;

  private async maybeBurstNotice(currentItems: OrphanEntry[]): Promise<void> {
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

  /** 共用的"候选识别"流水线（仅检测不入弹窗时复用） */
  private async collectOrphanCandidates(): Promise<OrphanEntry[]> {
    if (!this.adapter) return [];
    if (!this.hasAuth()) return [];
    const vaultName = this.app.vault.getName();
    const remoteRoot = this.settings.remoteRoot || `/apps/bdnsync/${vaultName}`;
    const parentDir = remoteParent(remoteRoot);
    if (!parentDir || parentDir === '/' || parentDir === remoteRoot) return [];
    // 与 makeOrphanLister 同样的「相对 basename → 绝对路径」修复：
    // 若不拼接，pickOrphans 输出的 fullPath 仅为 basename，measureOrphans 进一步
    // 用「相对路径」去 listDir 会再次落入用户家目录，触发 errno=-7/-9 噪声。
    const rows = await this.adapter.listRemoteDir(parentDir);
    const entries: RemoteDirRow[] = rows.map((r) => ({
      path: r.path ? remoteJoin(parentDir, r.path) : remoteJoin(parentDir, r.name),
      name: r.name,
      isDir: r.isDir,
      mtime: r.mtime,
      size: r.size,
    }));
    const candidates = pickOrphansUtil(entries, vaultName);
    if (candidates.length === 0) return [];
    const adapter = this.adapter; // 闭包捕获：函数开头已 guard 非空
    const lister: RemoteLister = {
      listDir: async (p: string) => {
        const rs = await adapter.listRemoteDir(p);
        return rs.map((r) => ({
          // measureOrphans 传入的 p 已经是 orphan 的绝对路径，此处继续拼绝对
          path: r.path ? remoteJoin(p, r.path) : remoteJoin(p, r.name),
          name: r.name,
          isDir: r.isDir,
          mtime: r.mtime,
          size: r.size,
        }));
      },
    };
    return await measureOrphansUtil(lister, candidates);
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
