// BDNSync 插件入口：生命周期、命令、事件、调度器、新 UI 集成

import { Notice, Plugin, TAbstractFile, TFile } from 'obsidian';
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
  StatsModal,
  VersionHistoryModal,
  SyncPreviewModal,
  SnapshotRestoreModal,
  ConflictReportModal,
} from './ui/modals';
import { RemoteUsageModal } from './ui/remote-usage';
import { NetdiskBrowserView, VIEW_TYPE_BDNSYNC_BROWSER } from './ui/views/netdisk-browser-view';
import { SyncLogView, VIEW_TYPE_BDNSYNC_LOG } from './ui/views/sync-log-view';
import { PreviewView, VIEW_TYPE_BDNSYNC_PREVIEW } from './ui/views/preview-view';
import { BDNSyncSettingTab } from './settings';
import { DEFAULT_SETTINGS, type BDNSyncSettings, type SyncLogEntry } from './types';
import { PathFilter, genDeviceId, formatBytes, u8ToArrayBuffer } from './util/misc';
import { Logger } from './util/logger';
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

    // 日志器：持久化 + 墓碑清理 + 整合筛选/导出
    this.logger = new Logger({
      level: this.settings.logLevel,
      maxEntries: this.settings.logMaxEntries,
      retentionDays: this.settings.logRetentionDays,
      tombstoneGraceHours: this.settings.logTombstoneGraceHours,
      persist: {
        load: async () => this.loadLogEntries(),
        persist: async (entries) => this.saveLogEntries(entries),
      },
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
        if (f instanceof TFile) onFileChanged(f.path);
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

  /** 将运行时字段（风暴阈值、脏集合窗口）与最新 settings 联动 */
  private applyRuntimeConfig(): void {
    if (this.watcher) this.watcher.stormThreshold = this.settings.stormThreshold;
    if (this.dirtySet) this.dirtySet.setWindow(this.settings.renameGraceMs);
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
        return await new FirstSyncModal(this.app, localCount, remoteCount).open();
      },
      (n) => this.statusBar.setConflicts(n),
      async (info) => {
        this.log('info', `删除保护触发：${info.reason}`);
        return await new MassDeleteGuardModal(this.app, info).open();
      },
    );
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
      const ok = await new SyncPreviewModal(this.app, plan).open();
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
    this.log(
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
          this.log('info', `同步完成：${this.summaryText(result)}`);
        } else {
          this.statusBar.setError(result.errorMessages[0] || '未知错误');
          this.log('error', `同步失败：${result.errorMessages.join('；') || '未知错误'}`);
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
        this.log('error', `同步异常：${msg}`);
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
    const confirm = await new ForceSyncConfirmModal(this.app, direction).open();
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
        // 方案4：把失败路径登记到重试队列（瞬态失败才入队）
        if (!result.ok && result.errorMessages.length > 0) {
          for (const msg of result.errorMessages) {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            this.retryQueue.registerFailure(allPaths.join('|'), msg, true, 0);
          }
          this.dirtySet.keep(allPaths);
          this.statusBar.setError(result.errorMessages[0]);
          this.log('error', `保存同步失败：${result.errorMessages.join('；')}`);
          return;
        }
        this.dirtySet.clearPaths(allPaths);
        this.statusBar.setDone(`同步完成（${allPaths.length}）`);
        this.log('info', `保存同步完成：${allPaths.length} 个文件`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.dirtySet.keep(allPaths);
        // 方案1：瞬态失败（限流/网络）入队重试；非瞬态则仅报错
        const transient =
          /errno=31039|errno=31034|ECONN|ETIMEDOUT|超时|网络|网络超时|503|502|429/i.test(msg);
        this.retryQueue.registerFailure(allPaths.join('|'), msg, transient, 0);
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

  log(type: SyncLogEntry['type'], message: string, path?: string): void {
    this.logger.log(type, message, path);
  }

  // ---------------- 日志持久化（独立文件，不与 settings 耦合） ----------------

  private logFilePath(): string {
    return `${PLUGIN_DIR}/sync-logs.json`;
  }

  private async loadLogEntries(): Promise<SyncLogEntry[]> {
    try {
      const raw = await this.app.vault.adapter.read(this.logFilePath());
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed?.entries) ? parsed.entries : [];
    } catch {
      return [];
    }
  }

  private async saveLogEntries(entries: SyncLogEntry[]): Promise<void> {
    try {
      await this.app.vault.adapter.write(this.logFilePath(), JSON.stringify({ entries }));
    } catch {
      /* 持久化失败时静默，日志仍在内存可用 */
    }
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
      ).open();
    })();
  }

  async openStats(): Promise<void> {
    const idx = await this.store.loadLocalIndex();
    let quota: QuotaInfo | null = null;
    if (this.hasAuth()) {
      quota = await this.makeApi()
        .getQuota()
        .catch(() => null);
    }
    new StatsModal(
      this.app,
      idx.stats,
      idx.lastSyncAt,
      idx.lastRemoteSyncVersion,
      this.settings.deviceName,
      this.settings.deviceId,
      quota,
      this.settings.deleteStrategy,
    ).open();
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
    new RemoteUsageModal(
      this.app,
      this.makeApi(),
      this.settings.remoteRoot || '/apps/bdnsync/MyVault',
    ).open();
  }

  async openSnapshots(): Promise<void> {
    new SnapshotRestoreModal(this.app, this.store, async (snap) => {
      await this.engine?.restoreSnapshot(snap, (t, m) => {
        this.logger.log(t === 'warn' ? 'info' : t, m);
      });
    }).open();
  }

  async openConflictReport(): Promise<void> {
    const idx = await this.store.loadLocalIndex();
    const entries = (idx.lastConflictReport || []).slice().reverse();
    new ConflictReportModal(this.app, entries).open();
  }

  /** 版本历史：从文件右键/命令打开（取当前活动文件） */
  async openVersionHistory(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice('BDNSync：请先打开一个文件');
      return;
    }
    new VersionHistoryModal(this.app, this.store, file.path, async (path, content) => {
      const buf = u8ToArrayBuffer(content);
      await this.app.vault.adapter.writeBinary(path, buf);
      new Notice(`BDNSync：已恢复 ${path}（本地已更新，下次同步将上传）`);
    }).open();
  }

  /** 恢复文件到指定版本（供版本面板调用，写入本地 + 触发上传） */
  async restoreVersion(path: string, content: Uint8Array): Promise<void> {
    await this.app.vault.adapter.writeBinary(path, u8ToArrayBuffer(content));
    await this.runQuickSync([path]);
  }
}
