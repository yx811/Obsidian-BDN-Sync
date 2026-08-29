// 设置面板：卡片化、连接状态卡片、首次引导、折叠高级参数

import { App, Notice, Platform, PluginSettingTab, Setting } from 'obsidian';
import type BDNSyncPlugin from './main';
import type { BDNSyncSettings } from './types';

import { formatBytes, formatTime } from './util/misc';
import { passwordStrength } from './crypto/encryption';
import {
  createCard,
  createIconButton,
  createPasswordField,
  createProgressBar,
  createSection,
  setIcon,
  type IconName,
} from './ui/components';
import { renderOnboarding } from './ui/onboarding';
import { ImportSettingsModal, ConfirmModal } from './ui/modals';
import { BaiduConnectionModal } from './ui/connection-modal';
import { VIEW_TYPE_BDNSYNC_BROWSER, setOnSelectDirCallback } from './ui/views/netdisk-browser-view';

export class BDNSyncSettingTab extends PluginSettingTab {
  private plugin: BDNSyncPlugin;
  /** 文本输入防抖保存定时器：避免每敲一个字符就全量落盘 + 刷新后端 */
  private saveTimer: number | null = null;
  // ── 增量 DOM 更新引用（quota / vip listener 局部刷新，避免 display() 全量重建） ──
  private quotaMetaSize: HTMLElement | null = null;
  private quotaMetaPct: HTMLElement | null = null;
  private quotaProgressBar: ReturnType<typeof createProgressBar> | null = null;
  private quotaResultEl: HTMLElement | null = null;
  private vipTierEl: HTMLElement | null = null;
  private vipTimeEl: HTMLElement | null = null;
  private vipBadge: HTMLElement | null = null;
  private quotaListener = (): void => {
    // 配额后台刷新完成后自动重绘连接卡片，避免一直显示「未检测」
    if (!this.containerEl.isConnected) return;
    this.updateQuotaDisplay();
  };
  private vipListener = (): void => {
    // VIP 信息后台刷新完成后自动重绘个人卡片
    if (!this.containerEl.isConnected) return;
    this.updateVipDisplay();
  };

  /** 文本类 onChange 专用：300ms 防抖后执行 saveSettings，避免高频写盘 */
  private debouncedSave(): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.plugin.saveSettings();
    }, 300);
  }

  constructor(app: App, plugin: BDNSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
    window.addEventListener('bdnsync:quota-updated', this.quotaListener);
    window.addEventListener('bdnsync:vip-updated', this.vipListener);
    // 设置页卸载时移除监听，避免泄漏
    this.plugin.register(() =>
      window.removeEventListener('bdnsync:quota-updated', this.quotaListener),
    );
    this.plugin.register(() => window.removeEventListener('bdnsync:vip-updated', this.vipListener));
  }

  /**
   * 安全导入设置：白名单 + 类型/范围校验（Mass-Assignment 防护）。
   *
   * 直接 `Object.assign(settings, JSON.parse(userJson))` 会允许任意字段覆盖，
   * 攻击者可借此注入 `deleteStrategy: 'delete-all'`、篡改 `remoteRoot`、
   * 乃至写入非预期字段。这里只接受已知配置键，并对枚举/数值做约束，
   * 任何越界或非法字段都被静默丢弃（不抛错，避免阻断正常导入）。
   */
  private sanitizeImportedSettings(raw: unknown): Partial<BDNSyncSettings> | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const src = raw as Record<string, unknown>;
    const out: Partial<BDNSyncSettings> = {};

    const str = (k: string, max = 4096): string | undefined => {
      const v = src[k];
      return typeof v === 'string' && v.length <= max ? v : undefined;
    };
    const arr = (k: string, maxLen = 256): string[] | undefined => {
      const v = src[k];
      if (!Array.isArray(v)) return undefined;
      const items: string[] = [];
      for (const item of v) {
        if (typeof item !== 'string') continue;
        const t = item.trim();
        if (!t) continue;
        items.push(t);
        if (items.length >= maxLen) break;
      }
      return items;
    };
    const num = (k: string, min: number, max: number): number | undefined => {
      const v = src[k];
      return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : undefined;
    };
    const bool = (k: string): boolean | undefined => {
      const v = src[k];
      return typeof v === 'boolean' ? v : undefined;
    };
    const enumOf = <T extends string>(k: string, allowed: readonly T[]): T | undefined => {
      const v = src[k];
      return allowed.includes(v as T) ? (v as T) : undefined;
    };
    const arrStr = (k: string, maxItems = 200): string[] | undefined => {
      const v = src[k];
      if (!Array.isArray(v) || v.length > maxItems) return undefined;
      return v.every((x) => typeof x === 'string' && x.length <= 512) ? (v as string[]) : undefined;
    };

    // 认证（仅接受字段，值须经用户重新授权才生效；此处只搬运，不自动激活）
    const authMode = enumOf('authMode', ['cookies', 'openapi'] as const);
    if (authMode) out.authMode = authMode;
    const cookies = str('cookies', 8192);
    if (cookies !== undefined) out.cookies = cookies;
    const bduss = str('bduss', 1024);
    if (bduss !== undefined) out.bduss = bduss;
    const stoken = str('stoken', 1024);
    if (stoken !== undefined) out.stoken = stoken;
    const appKey = str('appKey', 256);
    if (appKey !== undefined) out.appKey = appKey;
    const secretKey = str('secretKey', 256);
    if (secretKey !== undefined) out.secretKey = secretKey;
    const accessToken = str('accessToken', 1024);
    if (accessToken !== undefined) out.accessToken = accessToken;
    const refreshToken = str('refreshToken', 1024);
    if (refreshToken !== undefined) out.refreshToken = refreshToken;
    const tokenExpiresAt = str('tokenExpiresAt', 32);
    if (tokenExpiresAt !== undefined) out.tokenExpiresAt = tokenExpiresAt;

    // 同步模式
    const syncMode = enumOf('syncMode', ['manual', 'auto', 'realtime'] as const);
    if (syncMode) out.syncMode = syncMode;
    const autoSyncInterval = num('autoSyncInterval', 1, 720);
    if (autoSyncInterval !== undefined) out.autoSyncInterval = autoSyncInterval;
    const syncOnSave = bool('syncOnSave');
    if (syncOnSave !== undefined) out.syncOnSave = syncOnSave;
    const syncOnStartup = bool('syncOnStartup');
    if (syncOnStartup !== undefined) out.syncOnStartup = syncOnStartup;

    // 冲突/删除策略（枚举约束，杜绝 delete-all 注入）
    const conflictStrategy = enumOf('conflictStrategy', [
      'smart-merge',
      'force-local',
      'force-remote',
      'always-fork',
      'ask-me',
    ] as const);
    if (conflictStrategy) out.conflictStrategy = conflictStrategy;
    const deleteStrategy = enumOf('deleteStrategy', [
      'keep-modified',
      'delete-everywhere',
    ] as const);
    if (deleteStrategy) out.deleteStrategy = deleteStrategy;
    const autoBackup = bool('autoBackup');
    if (autoBackup !== undefined) out.autoBackup = autoBackup;
    const bulkDeleteConfirm = num('bulkDeleteConfirm', 0, 100000);
    if (bulkDeleteConfirm !== undefined) out.bulkDeleteConfirm = bulkDeleteConfirm;
    const mergeDraftEnabled = bool('mergeDraftEnabled');
    if (mergeDraftEnabled !== undefined) out.mergeDraftEnabled = mergeDraftEnabled;
    const configSnapshotRetention = num('configSnapshotRetention', 0, 100);
    if (configSnapshotRetention !== undefined) out.configSnapshotRetention = configSnapshotRetention;

    // 过滤
    const excludePatterns = arrStr('excludePatterns');
    if (excludePatterns !== undefined) out.excludePatterns = excludePatterns;
    const maxFileSizeMB = num('maxFileSizeMB', 1, 4096);
    if (maxFileSizeMB !== undefined) out.maxFileSizeMB = maxFileSizeMB;
    const skipHiddenFiles = bool('skipHiddenFiles');
    if (skipHiddenFiles !== undefined) out.skipHiddenFiles = skipHiddenFiles;
    const syncConfigDir = bool('syncConfigDir');
    if (syncConfigDir !== undefined) out.syncConfigDir = syncConfigDir;

    // 加密开关（密码/salt 需用户显式设置；导入搬运，但启用需用户确认）
    const encryptionEnabled = bool('encryptionEnabled');
    if (encryptionEnabled !== undefined) out.encryptionEnabled = encryptionEnabled;
    const encryptionPassword = str('encryptionPassword', 256);
    if (encryptionPassword !== undefined) out.encryptionPassword = encryptionPassword;
    const encryptionSalt = str('encryptionSalt', 64);
    if (encryptionSalt !== undefined) out.encryptionSalt = encryptionSalt;

    // 性能
    const uploadConcurrency = num('uploadConcurrency', 1, 16);
    if (uploadConcurrency !== undefined) out.uploadConcurrency = uploadConcurrency;
    const downloadConcurrency = num('downloadConcurrency', 1, 16);
    if (downloadConcurrency !== undefined) out.downloadConcurrency = downloadConcurrency;
    const chunkSizeMB = num('chunkSizeMB', 1, 32);
    if (chunkSizeMB !== undefined) out.chunkSizeMB = chunkSizeMB;
    const requestIntervalMs = num('requestIntervalMs', 50, 5000);
    if (requestIntervalMs !== undefined) out.requestIntervalMs = requestIntervalMs;
    const bandwidthLimitKBps = num('bandwidthLimitKBps', 0, 100000);
    if (bandwidthLimitKBps !== undefined) out.bandwidthLimitKBps = bandwidthLimitKBps;
    const syncPreviewEnabled = bool('syncPreviewEnabled');
    if (syncPreviewEnabled !== undefined) out.syncPreviewEnabled = syncPreviewEnabled;
    const renameGraceMs = num('renameGraceMs', 0, 10000);
    if (renameGraceMs !== undefined) out.renameGraceMs = renameGraceMs;
    const stormThreshold = num('stormThreshold', 200, 100000);
    if (stormThreshold !== undefined) out.stormThreshold = stormThreshold;

    // 版本/快照
    const maxVersions = num('maxVersions', 0, 100);
    if (maxVersions !== undefined) out.maxVersions = maxVersions;
    const autoSnapshot = bool('autoSnapshot');
    if (autoSnapshot !== undefined) out.autoSnapshot = autoSnapshot;
    const maxSnapshots = num('maxSnapshots', 1, 20);
    if (maxSnapshots !== undefined) out.maxSnapshots = maxSnapshots;

    // 设备
    const deviceName = str('deviceName', 64);
    if (deviceName !== undefined) out.deviceName = deviceName;

    // 日志
    const logLevel = enumOf('logLevel', ['debug', 'info', 'warn', 'error'] as const);
    if (logLevel) out.logLevel = logLevel;
    const logRetentionDays = num('logRetentionDays', 0, 3650);
    if (logRetentionDays !== undefined) out.logRetentionDays = logRetentionDays;
    const logMaxEntries = num('logMaxEntries', 50, 50000);
    if (logMaxEntries !== undefined) out.logMaxEntries = logMaxEntries;
    const logTombstoneGraceHours = num('logTombstoneGraceHours', 0, 720);
    if (logTombstoneGraceHours !== undefined) out.logTombstoneGraceHours = logTombstoneGraceHours;

    // 界面
    const themeMode = enumOf('themeMode', ['auto', 'normal', 'high-contrast'] as const);
    if (themeMode) out.themeMode = themeMode;

    // 实验室（仅接受已知布尔/数值，越界丢弃）
    const labEnabled = bool('labEnabled');
    if (labEnabled !== undefined) out.labEnabled = labEnabled;
    const cloudMediaEnabled = bool('cloudMediaEnabled');
    if (cloudMediaEnabled !== undefined) out.cloudMediaEnabled = cloudMediaEnabled;
    const cloudMediaLazyLoad = bool('cloudMediaLazyLoad');
    if (cloudMediaLazyLoad !== undefined) out.cloudMediaLazyLoad = cloudMediaLazyLoad;
    const cloudMediaMaxInlineMB = num('cloudMediaMaxInlineMB', 0, 4096);
    if (cloudMediaMaxInlineMB !== undefined) out.cloudMediaMaxInlineMB = cloudMediaMaxInlineMB;
    const cloudMediaOfflinePlaceholder = bool('cloudMediaOfflinePlaceholder');
    if (cloudMediaOfflinePlaceholder !== undefined)
      out.cloudMediaOfflinePlaceholder = cloudMediaOfflinePlaceholder;
    const labBacklinksEnabled = bool('labBacklinksEnabled');
    if (labBacklinksEnabled !== undefined) out.labBacklinksEnabled = labBacklinksEnabled;
    const labOfflinePinEnabled = bool('labOfflinePinEnabled');
    if (labOfflinePinEnabled !== undefined) out.labOfflinePinEnabled = labOfflinePinEnabled;
    const labOfflinePinMaxMB = num('labOfflinePinMaxMB', 0, 4096);
    if (labOfflinePinMaxMB !== undefined) out.labOfflinePinMaxMB = labOfflinePinMaxMB;
    const labHealthEnabled = bool('labHealthEnabled');
    if (labHealthEnabled !== undefined) out.labHealthEnabled = labHealthEnabled;
    const labHealthWarnThreshold = num('labHealthWarnThreshold', 0, 100);
    if (labHealthWarnThreshold !== undefined) out.labHealthWarnThreshold = labHealthWarnThreshold;
    const labGitEnabled = bool('labGitEnabled');
    if (labGitEnabled !== undefined) out.labGitEnabled = labGitEnabled;
    const lastGitSyncRef = str('lastGitSyncRef');
    if (lastGitSyncRef !== undefined) out.lastGitSyncRef = lastGitSyncRef;
    const labGitFallbackToScan = bool('labGitFallbackToScan');
    if (labGitFallbackToScan !== undefined) out.labGitFallbackToScan = labGitFallbackToScan;

    // 实验功能 10：局域网 P2P 同步
    const labLanEnabled = bool('labLanEnabled');
    if (labLanEnabled !== undefined) out.labLanEnabled = labLanEnabled;
    const labSelfCheckEnabled = bool('labSelfCheckEnabled');
    if (labSelfCheckEnabled !== undefined) out.labSelfCheckEnabled = labSelfCheckEnabled;
    const lanPassphrase = str('lanPassphrase');
    if (lanPassphrase !== undefined) out.lanPassphrase = lanPassphrase;
    const lanListenPort = num('lanListenPort', 1, 65535);
    if (lanListenPort !== undefined) out.lanListenPort = lanListenPort;
    const lanTargetHost = str('lanTargetHost');
    if (lanTargetHost !== undefined) out.lanTargetHost = lanTargetHost;
    const lanTargetPort = num('lanTargetPort', 0, 65535);
    if (lanTargetPort !== undefined) out.lanTargetPort = lanTargetPort;

    // 孤儿目录清理
    const detectOrphanBackupDirs = bool('detectOrphanBackupDirs');
    if (detectOrphanBackupDirs !== undefined) out.detectOrphanBackupDirs = detectOrphanBackupDirs;
    const autoPruneOrphanBackupDirs = bool('autoPruneOrphanBackupDirs');
    if (autoPruneOrphanBackupDirs !== undefined) out.autoPruneOrphanBackupDirs = autoPruneOrphanBackupDirs;
    const orphanRetentionDays = num('orphanRetentionDays', 0, 3650);
    if (orphanRetentionDays !== undefined) out.orphanRetentionDays = orphanRetentionDays;
    // v2：深度扫描配置
    const orphanScanMode = str('orphanScanMode') as 'parent-only' | 'scoped' | 'full-vault' | undefined;
    if (orphanScanMode && ['parent-only', 'scoped', 'full-vault'].includes(orphanScanMode)) {
      out.orphanScanMode = orphanScanMode;
    }
    const orphanScanMaxDepth = num('orphanScanMaxDepth', 0, 32);
    if (orphanScanMaxDepth !== undefined) out.orphanScanMaxDepth = orphanScanMaxDepth;
    const orphanScanMaxNodes = num('orphanScanMaxNodes', 0, 1_000_000);
    if (orphanScanMaxNodes !== undefined) out.orphanScanMaxNodes = orphanScanMaxNodes;
    const orphanScanMaxBytes = num('orphanScanMaxBytes', 0, 1_099_511_627_776); // 1 TB
    if (orphanScanMaxBytes !== undefined) out.orphanScanMaxBytes = orphanScanMaxBytes;
    const orphanScanConcurrency = num('orphanScanConcurrency', 1, 8);
    if (orphanScanConcurrency !== undefined) out.orphanScanConcurrency = orphanScanConcurrency;
    const orphanUseRecycleBin = bool('orphanUseRecycleBin');
    if (orphanUseRecycleBin !== undefined) out.orphanUseRecycleBin = orphanUseRecycleBin;
    const orphanExtraIgnoreGlobs = arr('orphanExtraIgnoreGlobs');
    if (orphanExtraIgnoreGlobs) out.orphanExtraIgnoreGlobs = orphanExtraIgnoreGlobs;
    // lastOrphanScanAt 由引擎自己维护，导入时不复制（避免基于错误时间戳的 24h 限频）
    // 故此处不读取。

    // remoteRoot 显式规范化（走 normalizeRemote，防路径穿越/越界）
    const remoteRoot = str('remoteRoot', 512);
    if (remoteRoot !== undefined) {
      // 延迟到 main 层 normalizeRemote，这里仅校验非空串
      out.remoteRoot = remoteRoot;
    }

    // 保护不可导入字段：deviceId（设备标识不可跨设备迁移，避免身份混淆）
    return out;
  }

  display(): void {
    const { containerEl } = this;
    // 守卫：若容器已脱离文档（标签页切走/插件卸载），跳过渲染
    if (!containerEl.isConnected) return;
    containerEl.empty();
    containerEl.addClass('bdnsync-setting-tab', 'bdnsync-root');

    // 顶部标题
    const header = containerEl.createDiv({ cls: 'bdnsync-setting-header' });
    const headerIcon = header.createDiv({ cls: 'bdnsync-setting-header-icon' });
    setIcon(headerIcon, 'cloud', 24);
    const headerText = header.createDiv({ cls: 'bdnsync-setting-header-title' });
    headerText.createEl('h2', { text: 'BDNS Sync' });
    headerText.createEl('p', { text: '百度网盘同步设置', cls: 'bdnsync-setting-header-subtitle' });

    // 未配置认证时显示引导
    if (!this.plugin.hasAuth()) {
      renderOnboarding(containerEl, this.plugin, {
        testConnection: async () => {
          const r = await this.plugin.testConnection();
          return {
            ok: r.ok,
            message: r.message,
            quotaUsed: r.quota?.used,
            quotaTotal: r.quota?.total,
            user: r.user,
          };
        },
        saveSettings: () => this.plugin.saveSettings(),
        refresh: () => this.display(),
      });
      return;
    }

    // 连接状态卡片（含配置入口）
    this.renderConnectionCard(containerEl);

    // 同步目录
    const dirSection = createSection(containerEl, { title: '同步目录', icon: 'folder' });
    this.renderRemoteRoot(dirSection.body);

    // 同步模式
    const syncSection = createSection(containerEl, { title: '同步模式', icon: 'zap' });
    this.renderSyncMode(syncSection.body);

    // 冲突与删除
    const conflictSection = createSection(containerEl, {
      title: '冲突与删除',
      icon: 'alert-triangle',
    });
    this.renderConflict(conflictSection.body);

    // 同步范围
    const filterSection = createSection(containerEl, { title: '同步范围', icon: 'filter' });
    this.renderFilter(filterSection.body);

    // 远程占用明细入口
    const usageSection = createSection(containerEl, {
      title: '远程存储与分析',
      icon: 'hard-drive',
    });
    const usageGrid = usageSection.body.createDiv({ cls: 'bdnsync-entry-grid' });
    this.renderEntryCard(usageGrid, {
      icon: 'pie-chart',
      label: '占用明细',
      desc: '按类型与目录统计',
      onClick: () => void this.plugin.openRemoteUsage(),
    });
    this.renderEntryCard(usageGrid, {
      icon: 'layers',
      label: '整库快照',
      desc: '误删后整库回滚',
      onClick: () => void this.plugin.openSnapshots(),
    });
    this.renderEntryCard(usageGrid, {
      icon: 'history',
      label: '冲突报告',
      desc: '最近同步处理明细',
      onClick: () => void this.plugin.openConflictReport(),
    });

    // 加密
    const encSection = createSection(containerEl, { title: '端到端加密', icon: 'shield' });
    this.renderEncryption(encSection.body);

    // 设备
    const deviceSection = createSection(containerEl, { title: '本设备', icon: 'smartphone' });
    this.renderDevice(deviceSection.body);
    this.renderSnapshot(deviceSection.body);

    // 实验室（实验功能，默认折叠；启用后展开子项）
    const labSection = createSection(containerEl, {
      title: '实验室',
      icon: 'beaker',
      collapsible: true,
      defaultOpen: false,
    });
    this.renderLab(labSection.body);

    // 高级性能（默认折叠）
    const perfSection = createSection(containerEl, {
      title: '高级性能参数',
      icon: 'activity',
      collapsible: true,
      defaultOpen: false,
    });
    this.renderPerformance(perfSection.body);

    // 日志与诊断（默认折叠）
    const logSection = createSection(containerEl, {
      title: '日志与诊断',
      icon: 'file-text',
      collapsible: true,
      defaultOpen: false,
    });
    this.renderLogConfig(logSection.body);

    // 维护（危险区）
    const maintSection = createSection(containerEl, { title: '维护', icon: 'rotate-ccw' });
    const maintCard = createCard(maintSection.body, 'bdnsync-danger-zone');
    this.renderMaintenance(maintCard);
    this.renderForceSync(maintSection.body);
    this.renderOrphanCleanup(maintSection.body);
    this.renderDataSafety(maintSection.body);

    containerEl.createEl('div', {
      cls: 'bdnsync-setting-footer',
      text: `BDNSync v${this.plugin.manifest.version} · 数据本地存储，云端仅保留同步内容`,
    });
  }

  private renderLogConfig(container: HTMLElement): void {
    const s = this.plugin.settings;
    const card = createCard(container, 'bdnsync-log-config');

    // 级别
    new Setting(card)
      .setName('记录级别')
      .setDesc('低于该级别的日志将被丢弃。debug 最详细，error 最精简。')
      .addDropdown((dd) =>
        dd
          .addOption('debug', '调试')
          .addOption('info', '信息')
          .addOption('warn', '警告')
          .addOption('error', '错误')
          .setValue(s.logLevel)
          .onChange(async (v) => {
            s.logLevel = v as BDNSyncSettings['logLevel'];
            this.plugin.logger?.updateOptions({ level: s.logLevel });
            this.debouncedSave();
          }),
      );

    // 保留天数
    new Setting(card)
      .setName('保留天数')
      .setDesc('超过该天数的日志将被标记为墓碑（宽限期内可恢复），随后物理清除。0 = 永久保留。')
      .addText((t) =>
        t
          .setPlaceholder('30')
          .setValue(String(s.logRetentionDays))
          .onChange(async (v) => {
            const n = Math.max(0, Math.min(3650, parseInt(v, 10) || 0));
            s.logRetentionDays = n;
            this.plugin.logger?.updateOptions({ retentionDays: n });
            this.debouncedSave();
          }),
      );

    // 容量上限
    new Setting(card)
      .setName('容量上限（条）')
      .setDesc('日志条目环形缓冲上限，超出按时间最旧淘汰。')
      .addText((t) =>
        t
          .setPlaceholder('1000')
          .setValue(String(s.logMaxEntries))
          .onChange(async (v) => {
            const n = Math.max(50, Math.min(50000, parseInt(v, 10) || 1000));
            s.logMaxEntries = n;
            this.plugin.logger?.updateOptions({ maxEntries: n });
            this.debouncedSave();
          }),
      );

    // 墓碑宽限期
    new Setting(card)
      .setName('墓碑宽限期（小时）')
      .setDesc('标记为删除后保留该时长再物理清除，留出误删恢复窗口。')
      .addText((t) =>
        t
          .setPlaceholder('24')
          .setValue(String(s.logTombstoneGraceHours))
          .onChange(async (v) => {
            const n = Math.max(0, Math.min(720, parseInt(v, 10) || 24));
            s.logTombstoneGraceHours = n;
            this.plugin.logger?.updateOptions({ tombstoneGraceHours: n });
            this.debouncedSave();
          }),
      );

    // 立即清理按钮 + 统计
    const actionRow = card.createDiv({ cls: 'bdnsync-log-config-actions' });
    createIconButton(actionRow, {
      icon: 'trash-2',
      label: '立即清理墓碑',
      onClick: async () => {
        const removed = (await this.plugin.logger?.purge()) ?? 0;
        new Notice(`BDNSync：已清理 ${removed} 条过期墓碑`);
      },
    });
    createIconButton(actionRow, {
      icon: 'file-text',
      label: '查看日志',
      primary: true,
      onClick: () => this.plugin.openLogPanel(),
    });
  }

  private renderConnectionCard(container: HTMLElement): void {
    const card = createCard(container, 'bdnsync-connection-card bdnsync-vip-card');
    const body = card.createDiv({ cls: 'bdnsync-vip-card-body' });

    // ── 左侧：会员头像（VIP 等级影响配色与外围光环） ──
    const avatar = body.createDiv({ cls: 'bdnsync-vip-avatar' });
    const avatarInner = avatar.createDiv({ cls: 'bdnsync-vip-avatar-inner' });
    const vip = this.plugin.lastVipInfo;
    const vipTier = vip?.vipType === 2 ? 'is-svip' : vip?.vipType === 1 ? 'is-vip' : 'is-normal';
    // 注意：CSS 定义为 `.bdnsync-vip-avatar.is-svip`（**两个**类），这里必须 add 独立的
    // 状态类。历史写法拼成 `bdnsync-vip-avatar-is-svip`（连写）无任何匹配规则，
    // 导致会员金色 / 普通蓝等配色**全部不生效**（验收发现）。
    avatar.classList.add(vipTier);

    // 真实头像：uinfo 接口返回的 avatar_url（或 uk 兜底拼接的默认头像）。
    // 头像加载失败（404 / 网络问题）时回退到默认 user-round 图标，避免出现破图。
    const renderAvatarImg = (url: string) => {
      avatarInner.empty();
      const img = avatarInner.createEl('img', {
        cls: 'bdnsync-vip-avatar-img',
        attr: {
          src: url,
          alt: vip?.name || '百度网盘头像',
          loading: 'lazy',
          referrerpolicy: 'no-referrer',
        },
      });
      img.addEventListener('error', () => {
        img.remove();
        setIcon(avatarInner, 'user-round', 28);
        avatar.removeAttribute('data-has-avatar');
      });
      avatar.setAttribute('data-has-avatar', '1');
    };
    if (vip?.avatarUrl) {
      renderAvatarImg(vip.avatarUrl);
    } else {
      setIcon(avatarInner, 'user-round', 28);
    }
    avatar.setAttr(
      'title',
      vip
        ? `${vip.vipLabel}${vip.name ? ' · ' + vip.name : ''}${vip.uk ? `（uk=${vip.uk}）` : ''}`
        : '正在识别会员等级…',
    );

    // ── 中部：账号/会员/配额 主信息区 ──
    const info = body.createDiv({ cls: 'bdnsync-vip-info' });

    // 标题行：用户名 + VIP 彩色徽标 + 连接状态
    const headRow = info.createDiv({ cls: 'bdnsync-vip-headrow' });
    headRow.createEl('div', {
      text: vip?.name || this.plugin.lastTestedUser || '百度网盘',
      cls: 'bdnsync-vip-name',
    });
    // 同上：状态类必须与基础类并列（`.bdnsync-vip-badge.is-svip`），不能连写
    const vipBadge = headRow.createSpan({ cls: `bdnsync-vip-badge ${vipTier}` });
    vipBadge.setText(vip?.vipLabel ?? '账号');
    const resultEl = headRow.createSpan({ cls: 'bdnsync-vip-connresult' });
    resultEl.setText('已连接');

    // 副标题：检测时间 + 等级帮助文案（说明当前会员可解锁的最高画质）
    const subRow = info.createDiv({ cls: 'bdnsync-vip-subrow' });
    const tierText =
      vip?.vipType === 2
        ? '原画/4K 直链已解锁'
        : vip?.vipType === 1
          ? '可解锁 1080P 及以下'
          : '账号等级 ≤ 720P';
    // 同上：`.bdnsync-vip-tier.is-svip`
    const tierEl = subRow.createSpan({ cls: `bdnsync-vip-tier ${vipTier}` });
    tierEl.setText(tierText);
    const timeEl = subRow.createSpan({ cls: 'bdnsync-vip-time' });
    timeEl.setText(
      vip && this.plugin.lastVipInfoAt
        ? `上次检测 ${formatTime(this.plugin.lastVipInfoAt)}`
        : '尚未检测会员等级',
    );
    if (this.plugin.lastVipInfoError) {
      timeEl.setText(`检测失败：${this.plugin.lastVipInfoError.slice(0, 60)}`);
      timeEl.setAttr('title', this.plugin.lastVipInfoError);
      timeEl.addClass('is-error');
    }

    // 存储 VIP 引用供增量更新
    this.vipTierEl = tierEl;
    this.vipTimeEl = timeEl;
    this.vipBadge = vipBadge;

    // 配额进度条
    const progressHost = info.createDiv({ cls: 'bdnsync-vip-progress' });
    const progressBar = createProgressBar(progressHost);
    const meta = info.createDiv({ cls: 'bdnsync-vip-meta' });
    const metaSize = meta.createSpan({ cls: 'bdnsync-vip-meta-size' });
    const metaPct = meta.createSpan({ cls: 'bdnsync-vip-meta-pct' });

    // 存储引用供增量更新使用
    this.quotaMetaSize = metaSize;
    this.quotaMetaPct = metaPct;
    this.quotaProgressBar = progressBar;
    this.quotaResultEl = resultEl;

    const setQuotaDisplay = (used: number, total: number) => {
      const ratio = total > 0 ? used / total : 0;
      metaSize.setText(`已用 ${formatBytes(used)} / ${formatBytes(total)}`);
      metaPct.setText(total > 0 ? `${(ratio * 100).toFixed(1)}%` : '—');
      progressBar.setRatio(ratio);
    };

    if (this.plugin.lastQuota) {
      const q = this.plugin.lastQuota;
      if (q.total > 0) {
        setQuotaDisplay(q.used, q.total);
        resultEl.addClass('is-success');
      } else {
        // total === 0 表示接口调用成功但未返回有效容量（多为 Cookie 缺 STOKEN），
        // 与「请求失败」不是一回事，文案需区分，避免误导用户以为是网络/鉴权错误。
        metaSize.setText('网盘未返回容量信息');
        metaPct.setText('请补充含 STOKEN 的 Cookie 后点击「刷新用量」');
        progressBar.setRatio(0);
        resultEl.setText('容量未知');
        resultEl.addClass('is-warning');
      }
    } else if (this.plugin.lastQuotaError) {
      const err = this.plugin.lastQuotaError;
      metaSize.setText('存储用量获取失败');
      metaPct.setText(err.length > 60 ? `${err.slice(0, 58)}…` : err);
      metaPct.setAttr('title', err);
      progressBar.setRatio(0);
      resultEl.setText('未获取配额');
      resultEl.addClass('is-error');
    } else {
      metaSize.setText('正在获取存储信息…');
      metaPct.setText('');
      progressBar.setRatio(0);
      resultEl.setText('检测中');
      resultEl.addClass('is-muted');
      if (this.plugin.hasAuth() && navigator.onLine) {
        void this.plugin.refreshQuota();
      }
    }

    // 没有触发过 VIP 检测时主动推一下
    if (
      this.plugin.hasAuth() &&
      navigator.onLine &&
      !this.plugin.lastVipInfo &&
      !this.plugin.lastVipInfoError
    ) {
      void this.plugin.refreshVipInfo();
    }

    // ── 右侧：操作按钮（VIP 中心主要控件） ──
    const actions = body.createDiv({ cls: 'bdnsync-vip-actions' });
    createIconButton(actions, {
      icon: 'crown',
      label: '刷新会员',
      primary: true,
      title: '重新从百度 uinfo 获取账号/会员等级',
      onClick: async (btn) => {
        btn.disabled = true;
        // 清掉 10min 本地缓存强制刷新
        this.plugin.lastVipInfoAt = 0;
        const info2 = await this.plugin.refreshVipInfo();
        btn.disabled = false;
        if (info2) {
          new Notice(`BDNSync：会员等级 ${info2.vipLabel}`, 4000);
        } else if (this.plugin.lastVipInfoError) {
          new Notice(`BDNSync：会员等级获取失败 — ${this.plugin.lastVipInfoError}`, 8000);
        } else {
          new Notice('BDNSync：会员等级获取失败，请检查认证', 8000);
        }
        this.display();
      },
    });
    createIconButton(actions, {
      icon: 'refresh-cw',
      label: '测试连接',
      title: '完整测试百度网盘连接（同步刷新配额与会员）',
      onClick: async (btn) => {
        btn.disabled = true;
        resultEl.removeClass('is-success', 'is-error', 'is-warning', 'is-muted');
        resultEl.setText('测试中…');
        const r = await this.plugin.testConnection();
        // testConnection 不会刷 VIP，主动调一次
        await this.plugin.refreshVipInfo();
        btn.disabled = false;
        if (r.ok) {
          resultEl.addClass('is-success');
          resultEl.setText(`已连接${r.user ? `（${r.user}）` : ''}`);
          new Notice(`BDNSync：连接成功${r.user ? `（${r.user}）` : ''}`, 4000);
        } else {
          resultEl.addClass('is-error');
          resultEl.setText('连接失败');
          new Notice(`BDNSync：连接失败 — ${r.message}`, 8000);
        }
        this.display();
      },
    });
    createIconButton(actions, {
      icon: 'hard-drive',
      label: '刷新用量',
      title: '重新获取百度网盘存储用量',
      onClick: async (btn) => {
        btn.disabled = true;
        resultEl.removeClass('is-success', 'is-error', 'is-warning', 'is-muted');
        resultEl.setText('获取中…');
        const q = await this.plugin.refreshQuota();
        btn.disabled = false;
        if (q && q.total > 0) {
          new Notice(`BDNSync：存储空间 — 已用 ${formatBytes(q.used)} / ${formatBytes(q.total)}`);
        } else if (this.plugin.lastQuotaError) {
          new Notice(`BDNSync：获取存储信息失败 — ${this.plugin.lastQuotaError}`, 10000);
        } else {
          new Notice('BDNSync：获取存储信息失败，请检查 Cookie 中是否含 STOKEN', 8000);
        }
        this.display();
      },
    });
    createIconButton(actions, {
      icon: 'folder',
      label: '浏览网盘',
      title: '以标签页方式打开百度网盘文件浏览器',
      onClick: () => {
        this.openBrowserView();
      },
    });
    createIconButton(actions, {
      icon: 'settings',
      label: '配置连接',
      title: '修改百度网盘连接配置（BDUSS/SToken/开放平台 等）',
      onClick: () => {
        new BaiduConnectionModal(this.app, this.plugin).open();
      },
    });

    // 会员等级说明区：把当前等级能做什么清晰列出来
    const tipEl = card.createDiv({ cls: 'bdnsync-vip-tip' });
    const tier = vip?.vipType ?? -1;
    const tipTable: Record<number, string> = {
      2: '当前为超级会员（SVIP）：播放视频时可获取原画/4K 直链；音视频优先走网页版播放接口（playurlinfo），可枚举多清晰度。',
      1: '当前为会员（VIP）：1080P 及以下直链已解锁；若源文件为 4K 或更高，转码版本仍以 1080P 为上限。',
      0: '当前为普通用户：建议登录百度网盘后获取包含完整 STOKEN 的 Cookie；非会员清晰度上限 720P，部分片源画质受限。',
    };
    tipEl.setText(
      tipTable[tier] ??
        '尚未识别会员等级，请点击「刷新会员」或在浏览器中重新登录百度网盘后再次抓取 Cookie。',
    );
    card.setAttribute('tabindex', '0');
  }

  /** 入口卡片（图标 + 标题 + 描述），用于远程存储等快捷入口网格 */
  private renderEntryCard(
    container: HTMLElement,
    opts: { icon: IconName; label: string; desc: string; onClick: () => void },
  ): void {
    const card = container.createDiv({ cls: 'bdnsync-entry-card' });
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    const iconWrap = card.createSpan({ cls: 'bdnsync-entry-card-icon' });
    setIcon(iconWrap, opts.icon, 20);
    const text = card.createDiv({ cls: 'bdnsync-entry-card-text' });
    text.createEl('div', { text: opts.label, cls: 'bdnsync-entry-card-label' });
    text.createEl('div', { text: opts.desc, cls: 'bdnsync-entry-card-desc' });
    card.addEventListener('click', opts.onClick);
    card.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        opts.onClick();
      }
    });
  }

  /** 增量更新配额显示（避免全量 display() 重建整个设置页） */
  private updateQuotaDisplay(): void {
    const { quotaMetaSize: metaSize, quotaMetaPct: metaPct, quotaProgressBar: progressBar, quotaResultEl: resultEl } = this;
    if (!metaSize || !metaPct || !progressBar || !resultEl) return;

    // 清除旧状态类
    resultEl.removeClass('is-success', 'is-warning', 'is-error', 'is-muted');

    if (this.plugin.lastQuota) {
      const q = this.plugin.lastQuota;
      if (q.total > 0) {
        const ratio = q.used / q.total;
        metaSize.setText(`已用 ${formatBytes(q.used)} / ${formatBytes(q.total)}`);
        metaPct.setText(`${(ratio * 100).toFixed(1)}%`);
        progressBar.setRatio(ratio);
        resultEl.setText('已连接');
        resultEl.addClass('is-success');
      } else {
        // total === 0 表示接口调用成功但未返回有效容量（多为 Cookie 缺 STOKEN），
        // 与「请求失败」不是一回事，文案需区分，避免误导用户以为是网络/鉴权错误。
        metaSize.setText('网盘未返回容量信息');
        metaPct.setText('请补充含 STOKEN 的 Cookie 后点击「刷新用量」');
        progressBar.setRatio(0);
        resultEl.setText('容量未知');
        resultEl.addClass('is-warning');
      }
    } else if (this.plugin.lastQuotaError) {
      const err = this.plugin.lastQuotaError;
      metaSize.setText('存储用量获取失败');
      metaPct.setText(err.length > 60 ? `${err.slice(0, 58)}…` : err);
      metaPct.setAttr('title', err);
      progressBar.setRatio(0);
      resultEl.setText('未获取配额');
      resultEl.addClass('is-error');
    }
  }

  /** 增量更新 VIP 显示（避免全量 display() 重建整个设置页） */
  private updateVipDisplay(): void {
    const { vipTierEl: tierEl, vipTimeEl: timeEl, vipBadge: badge } = this;
    if (!tierEl || !timeEl || !badge) return;

    const vip = this.plugin.lastVipInfo;
    const vipTier = vip?.vipType === 2 ? 'is-svip' : vip?.vipType === 1 ? 'is-vip' : 'is-normal';

    // 更新等级文字
    const tierText =
      vip?.vipType === 2
        ? '原画/4K 直链已解锁'
        : vip?.vipType === 1
          ? '可解锁 1080P 及以下'
          : '账号等级 ≤ 720P';
    tierEl.className = `bdnsync-vip-tier ${vipTier}`;
    tierEl.setText(tierText);

    // 更新检测时间
    timeEl.removeClass('is-error');
    if (this.plugin.lastVipInfoError) {
      timeEl.setText(`检测失败：${this.plugin.lastVipInfoError.slice(0, 60)}`);
      timeEl.setAttr('title', this.plugin.lastVipInfoError);
      timeEl.addClass('is-error');
    } else {
      timeEl.setText(
        vip && this.plugin.lastVipInfoAt
          ? `上次检测 ${formatTime(this.plugin.lastVipInfoAt)}`
          : '尚未检测会员等级',
      );
      timeEl.removeAttribute('title');
    }

    // 更新 VIP 徽标
    badge.className = `bdnsync-vip-badge ${vipTier}`;
    badge.setText(vip?.vipLabel ?? '账号');
  }

  private renderRemoteRoot(container: HTMLElement): void {
    const s = this.plugin.settings;
    new Setting(container)
      .setName('云端同步目录')
      .setDesc('百度网盘中的同步根目录。留空则使用默认路径。')
      .addText((t) => {
        t.setPlaceholder(`/apps/bdnsync/${this.app.vault.getName()}`);
        t.setValue(s.remoteRoot);
        t.onChange(async (v) => {
          s.remoteRoot = v.trim();
          this.debouncedSave();
        });
      })
      .addButton((b) => {
        b.setButtonText('浏览选择');
        b.onClick(() => {
          this.openBrowserView((dir) => {
            s.remoteRoot = dir;
            void this.plugin.saveSettings();
            this.display();
          });
        });
      });
    createIconButton(container, {
      icon: 'settings',
      label: '打开连接配置弹窗',
      primary: true,
      onClick: () => new BaiduConnectionModal(this.app, this.plugin).open(),
    });
  }

  /** 以 Obsidian 标签页（非弹窗）打开百度网盘文件浏览器；onSelect 为"选为同步目录"后的回调 */
  private openBrowserView(onSelect?: (dir: string) => void): void {
    setOnSelectDirCallback(onSelect ?? null);
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_BDNSYNC_BROWSER);
    if (existing.length > 0) {
      workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = workspace.getLeaf(true);
    void leaf.setViewState({ type: VIEW_TYPE_BDNSYNC_BROWSER, active: true });
    workspace.revealLeaf(leaf);
  }

  private renderSyncMode(container: HTMLElement): void {
    const s = this.plugin.settings;
    const grid = container.createDiv({ cls: 'bdnsync-choice-grid' });
    const modes: { key: 'manual' | 'auto' | 'realtime'; title: string; desc: string }[] = [
      { key: 'manual', title: '手动同步', desc: '点击状态栏或命令触发同步' },
      { key: 'auto', title: '自动同步', desc: '按间隔在后台自动同步' },
      { key: 'realtime', title: '实时同步', desc: '保存文件后 3 秒自动上传' },
    ];
    for (const m of modes) {
      const card = createCard(
        grid,
        `bdnsync-choice-card ${s.syncMode === m.key ? 'bdnsync-choice-card-active' : ''}`,
      );
      card.createEl('div', { text: m.title, cls: 'bdnsync-choice-title' });
      card.createEl('div', { text: m.desc, cls: 'bdnsync-choice-desc' });
      card.addEventListener('click', async () => {
        s.syncMode = m.key;
        // 联动触发开关：切换模式时自动调整 startup/save 的默认值，
        // 避免"设了 manual 但 syncOnStartup 仍开着 → 启动时仍然同步"的语义错位。
        if (m.key === 'manual') {
          s.syncOnSave = false;
          s.syncOnStartup = false;
        } else {
          s.syncOnSave = true;
          s.syncOnStartup = true;
        }
        this.debouncedSave();
        this.plugin.restartScheduler();
        this.display();
      });
    }

    if (s.syncMode === 'auto') {
      new Setting(container)
        .setName('自动同步间隔（分钟）')
        .setDesc('定时拉取变更并同步；实时模式下不生效。')
        .addSlider((sl) => {
          sl.setLimits(1, 60, 1)
            .setValue(s.autoSyncInterval)
            .setDynamicTooltip()
            .onChange(async (v) => {
              s.autoSyncInterval = v;
              this.debouncedSave();
              this.plugin.restartScheduler();
            });
        });
    }

    new Setting(container)
      .setName('启动时同步')
      .setDesc('打开 Obsidian 后自动执行一次完整同步')
      .addToggle((t) =>
        t.setValue(s.syncOnStartup).onChange(async (v) => {
          s.syncOnStartup = v;
          this.debouncedSave();
        }),
      );

      new Setting(container)
        .setName('保存时同步')
        .setDesc('保存文件后自动上传，大文件延迟稍长。')
      .addToggle((t) =>
        t.setValue(s.syncOnSave).onChange(async (v) => {
          s.syncOnSave = v;
          this.debouncedSave();
        }),
      );
  }

  private renderConflict(container: HTMLElement): void {
    const s = this.plugin.settings;
    new Setting(container)
      .setName('冲突解决策略')
      .setDesc('智能合并自动处理文本冲突；需裁决时打开冲突面板。')
      .addDropdown((d) => {
        d.addOption('smart-merge', '智能合并（推荐）');
        d.addOption('force-local', '强制本地优先');
        d.addOption('force-remote', '强制云端优先');
        d.addOption('always-fork', '始终保留双版本');
        d.addOption('ask-me', '每次询问（冲突面板）');
        d.setValue(s.conflictStrategy);
        d.onChange(async (v) => {
          s.conflictStrategy = v as BDNSyncSettings['conflictStrategy'];
          this.debouncedSave();
        });
      });

    new Setting(container)
      .setName('删除同步策略')
      .setDesc(
        '一端删除时是否同步删除另一端。默认「保留修改」更安全：仅当对方也改过时才删除云端副本。',
      )
      .addDropdown((d) => {
        d.addOption('keep-modified', '保留修改（更安全，推荐）');
        d.addOption('delete-everywhere', '到处删除');
        d.setValue(s.deleteStrategy);
        d.onChange(async (v) => {
          s.deleteStrategy = v as BDNSyncSettings['deleteStrategy'];
          this.debouncedSave();
        });
      });

    new Setting(container)
      .setName('覆盖前自动备份')
      .setDesc('覆盖本地文件前先备份（最近 100 份），可随时恢复。')
      .addToggle((t) =>
        t.setValue(s.autoBackup).onChange(async (v) => {
          s.autoBackup = v;
          this.debouncedSave();
        }),
      );

    new Setting(container)
      .setName('批量删除确认阈值')
      .setDesc('单次删除数达到该值时弹窗确认；0 关闭。异常删除（如清空本地）始终拦截。')
      .addText((t) => {
        t.inputEl.type = 'number';
        t.setValue(String(s.bulkDeleteConfirm ?? 50));
        t.onChange(async (v) => {
          const n = Number(v);
          s.bulkDeleteConfirm = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 50;
          this.debouncedSave();
        });
      });

    // P0-1.3/4.2 合并草稿开关：冲突含标记时写草稿待面板确认，而非直接覆盖原文件
    new Setting(container)
      .setName('冲突合并草稿（逐段确认）')
      .setDesc('无法自动解决时写入草稿，由面板逐段确认，不直接覆盖原文件。')
      .addToggle((t) =>
        t.setValue(s.mergeDraftEnabled).onChange(async (v) => {
          s.mergeDraftEnabled = v;
          this.debouncedSave();
        }),
      );

    // P0-1.4 打开合并面板入口
    new Setting(container)
      .setName('打开冲突合并面板')
      .setDesc('三栏对比、逐段采纳本地/远端/保留双方，保存后写回原文件。')
      .addButton((b) =>
        b.setButtonText('打开合并面板').onClick(() => void this.plugin.openMergePanelFirst()),
      );

    // P2-4.2 撤销最近合并入口
    new Setting(container)
      .setName('撤销最近一次合并')
      .setDesc('恢复为合并前的本地版本并清理草稿。')
      .addButton((b) =>
        b.setButtonText('撤销合并').onClick(() => void this.plugin.undoLastMerge()),
      );
  }

  private renderFilter(container: HTMLElement): void {
    const s = this.plugin.settings;

    // 可视化规则编辑器：include / exclude 列表 + 即时匹配预览
    const editor = container.createDiv({ cls: 'bdnsync-rule-editor' });
    const editorHead = editor.createDiv({ cls: 'bdnsync-rule-editor-head' });
    editorHead.createEl('span', {
      text: '选择性同步规则（可视化）',
      cls: 'bdnsync-rule-editor-title',
    });
    const addRow = editorHead.createDiv({ cls: 'bdnsync-rule-editor-add' });
    const input = addRow.createEl('input', {
      cls: 'bdnsync-input bdnsync-rule-input',
      attr: { type: 'text', placeholder: '例如：.trash/** 或 *.tmp' },
    }) as HTMLInputElement;
    createIconButton(addRow, {
      icon: 'folder-plus',
      label: '添加排除',
      primary: true,
      onClick: () => {
        const v = input.value.trim();
        if (!v) return;
        s.excludePatterns = [...(s.excludePatterns || []), v];
        input.value = '';
        void this.plugin.saveSettings();
        renderRules();
        void updatePreview();
      },
    });

    const listEl = editor.createDiv({ cls: 'bdnsync-rule-list' });
    const renderRules = () => {
      listEl.empty();
      const patterns = s.excludePatterns || [];
      if (patterns.length === 0) {
        listEl.createEl('div', { text: '暂无排除规则（同步全部文件）', cls: 'bdnsync-rule-empty' });
      }
      patterns.forEach((p, i) => {
        const row = listEl.createDiv({ cls: 'bdnsync-rule-row' });
        const badge = row.createSpan({ cls: 'bdnsync-rule-badge bdnsync-rule-badge-exclude' });
        badge.setText('排除');
        row.createSpan({ text: p, cls: 'bdnsync-rule-pattern' });
        createIconButton(row, {
          icon: 'x',
          label: '移除',
          danger: true,
          onClick: () => {
            s.excludePatterns = (s.excludePatterns || []).filter((_, idx) => idx !== i);
            void this.plugin.saveSettings();
            renderRules();
            void updatePreview();
          },
        });
      });
    };
    // 初始渲染规则列表
    renderRules();

    // 即时匹配预览
    const preview = editor.createDiv({ cls: 'bdnsync-rule-preview' });
    preview.createEl('div', {
      text: '匹配预览（本地文件，按当前规则）：',
      cls: 'bdnsync-rule-preview-title',
    });
    const previewBody = preview.createDiv({ cls: 'bdnsync-rule-preview-body' });
    const updatePreview = async () => {
      previewBody.empty();
      try {
        const filter = new (await import('./util/misc')).PathFilter(s);
        const files = this.app.vault.getFiles();
        let included = 0,
          excluded = 0;
        const samples: string[] = [];
        for (const f of files) {
          if (filter.isExcluded(f.path)) {
            excluded++;
          } else {
            included++;
            if (samples.length < 20) samples.push(f.path);
          }
        }
        const sum = previewBody.createDiv({ cls: 'bdnsync-rule-preview-sum' });
        sum.createEl('span', { text: `同步 ${included} 个`, cls: 'bdnsync-rule-preview-inc' });
        sum.createEl('span', { text: ` · 排除 ${excluded} 个`, cls: 'bdnsync-rule-preview-exc' });
        for (const p of samples)
          previewBody.createEl('div', { text: p, cls: 'bdnsync-rule-preview-item' });
        if (files.length > samples.length)
          previewBody.createEl('div', {
            text: `…共 ${files.length} 个文件`,
            cls: 'bdnsync-rule-preview-more',
          });
      } catch {
        previewBody.createEl('div', { text: '预览失败', cls: 'bdnsync-rule-preview-item' });
      }
    };
    void updatePreview();
    // 规则变更后刷新预览
    input.addEventListener('blur', () => void updatePreview());

    // P1-4.2 include 白名单：设置了 include 后，仅匹配其一的文件参与同步；
    // 空 include 表示「全部（再按 exclude 过滤）」。include 优先级高于 exclude。
    const includeBlock = container.createDiv({ cls: 'bdnsync-rule-editor' });
    const incHead = includeBlock.createDiv({ cls: 'bdnsync-rule-editor-head' });
    incHead.createEl('span', {
      text: '包含规则（白名单，可选）',
      cls: 'bdnsync-rule-editor-title',
    });
    const incAdd = incHead.createDiv({ cls: 'bdnsync-rule-editor-add' });
    const incInput = incAdd.createEl('input', {
      cls: 'bdnsync-input bdnsync-rule-input',
      attr: { type: 'text', placeholder: '例如：笔记/** 或 项目/*.md' },
    }) as HTMLInputElement;
    createIconButton(incAdd, {
      icon: 'folder-plus',
      label: '添加包含',
      primary: true,
      onClick: () => {
        const v = incInput.value.trim();
        if (!v) return;
        s.includePatterns = [...(s.includePatterns || []), v];
        incInput.value = '';
        void this.plugin.saveSettings();
        renderInc();
      },
    });
    const incList = includeBlock.createDiv({ cls: 'bdnsync-rule-list' });
    const renderInc = () => {
      incList.empty();
      const patterns = s.includePatterns || [];
      if (patterns.length === 0) {
        incList.createEl('div', {
          text: '未设置包含规则（同步全部文件，再按排除规则过滤）',
          cls: 'bdnsync-rule-empty',
        });
      }
      patterns.forEach((p, i) => {
        const row = incList.createDiv({ cls: 'bdnsync-rule-row' });
        const badge = row.createSpan({ cls: 'bdnsync-rule-badge bdnsync-rule-badge-include' });
        badge.setText('包含');
        row.createSpan({ text: p, cls: 'bdnsync-rule-pattern' });
        createIconButton(row, {
          icon: 'x',
          label: '移除',
          danger: true,
          onClick: () => {
            s.includePatterns = (s.includePatterns || []).filter((_, idx) => idx !== i);
            void this.plugin.saveSettings();
            renderInc();
          },
        });
      });
    };
    renderInc();
    container.createEl('p', {
      cls: 'bdnsync-help-text',
      text: '通配符：* 单层、** 递归、? 单字符。未设 include 时同步全部，再按 exclude 排除。',
    });

    new Setting(container)
      .setName('单文件大小上限（MB）')
      .setDesc('超过此大小的文件不同步')
      .addText((t) => {
        t.setValue(String(s.maxFileSizeMB));
        t.onChange(async (v) => {
          const n = parseInt(v, 10);
          if (!Number.isNaN(n) && n > 0 && n <= 4096) {
            s.maxFileSizeMB = n;
            this.debouncedSave();
          }
        });
      });

    new Setting(container)
      .setName('跳过隐藏文件')
      .setDesc('跳过以 . 开头的文件与目录')
      .addToggle((t) =>
        t.setValue(s.skipHiddenFiles).onChange(async (v) => {
          s.skipHiddenFiles = v;
          this.debouncedSave();
        }),
      );

    new Setting(container)
      .setName('同步 .obsidian 配置目录')
      .setDesc('开启后主题、快捷键、插件配置可跨设备一致（workspace.json 仍排除；插件状态按「启用并集」合并）')
      .addToggle((t) =>
        t.setValue(s.syncConfigDir).onChange(async (v) => {
          s.syncConfigDir = v;
          this.debouncedSave();
        }),
      );

    // P1-3.4 配置快照保留数 + 一键回滚
    new Setting(container)
      .setName('配置快照保留数')
      .setDesc('每次同步后自动保存 .obsidian 配置快照（0 = 关闭），配置异常时可一键回滚最近稳定版本。')
      .addText((t) => {
        t.inputEl.type = 'number';
        t.setValue(String(s.configSnapshotRetention ?? 5));
        t.onChange(async (v) => {
          const n = Number(v);
          s.configSnapshotRetention = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 5;
          this.debouncedSave();
        });
      });

    new Setting(container)
      .setName('恢复 .obsidian 配置')
      .setDesc('把 .obsidian 配置回滚到最近一份稳定快照（主题/快捷键/插件配置）。')
      .addButton((b) =>
        b.setButtonText('一键回滚').onClick(() => void this.plugin.restoreConfigSnapshot()),
      );
  }

  private renderEncryption(container: HTMLElement): void {
    const s = this.plugin.settings;
    new Setting(container)
      .setName('启用端到端加密')
      .setDesc('上传前在本机加密，云端只存密文；所有设备须用同一密码。')
      .addToggle((t) =>
        t.setValue(s.encryptionEnabled).onChange(async (v) => {
          s.encryptionEnabled = v;
          this.debouncedSave();
          this.display();
        }),
      );

    if (s.encryptionEnabled) {
      const pwRow = container.createDiv({ cls: 'bdnsync-input-row' });
      pwRow.createEl('label', { text: '加密密码' });
      const meter = container.createDiv({ cls: 'bdnsync-pw-meter' });
      createPasswordField(pwRow, {
        value: s.encryptionPassword,
        placeholder: '所有设备使用同一密码',
        onChange: async (v) => {
          s.encryptionPassword = v;
          this.debouncedSave();
          const st = passwordStrength(v);
          meter.setText(`强度：${st.label} · ${st.hint}`);
          meter.className = `bdnsync-pw-meter bdnsync-pw-meter-${st.score}`;
        },
      });
      const st0 = passwordStrength(s.encryptionPassword);
      meter.setText(`强度：${st0.label} · ${st0.hint}`);
      meter.className = `bdnsync-pw-meter bdnsync-pw-meter-${st0.score}`;
      container.createEl('p', {
        cls: 'bdnsync-help-text',
        text: '⚠ 忘记密码将无法解密，请妥善保管；密码仅存本地。算法 AES-256-GCM + PBKDF2。',
      });

      // P1-3.5 密码提示语（明文，仅作回忆线索，不替代密码）
      const hintRow = container.createDiv({ cls: 'bdnsync-input-row' });
      hintRow.createEl('label', { text: '密码提示语（可选）' });
      const hintInput = hintRow.createEl('input', {
        cls: 'bdnsync-input',
        attr: { type: 'text', placeholder: '例如：我家门牌号 + 宠物名' },
      }) as HTMLInputElement;
      hintInput.value = s.passwordHint;
      hintInput.addEventListener('change', async () => {
        s.passwordHint = hintInput.value;
        this.debouncedSave();
      });

      // P1-3.5 密钥文件模式：从 vault 内 .bdnsync-key 读取密码，避免每次输入
      const keyRow = container.createDiv({ cls: 'bdnsync-input-row' });
      keyRow.createEl('label', { text: '密钥文件路径（可选）' });
      const keyInput = keyRow.createEl('input', {
        cls: 'bdnsync-input',
        attr: { type: 'text', placeholder: '.bdnsync-key （相对 vault 根）' },
      }) as HTMLInputElement;
      keyInput.value = s.keyFilePath;
      keyInput.addEventListener('change', async () => {
        s.keyFilePath = keyInput.value.trim();
        this.debouncedSave();
      });
      container.createEl('p', {
        cls: 'bdnsync-help-text',
        text: '在 vault 根放置 .bdnsync-key（首行即密码），启用后免输入；该文件自动排除同步。',
      });
      new Setting(container)
        .setName('生成密钥文件模板')
        .setDesc('在 vault 根创建 .bdnsync-key（第一行留空待你填写密码），并自动设为密钥文件路径。')
        .addButton((b) =>
          b.setButtonText('生成模板').onClick(() => void this.plugin.createKeyFileTemplate()),
        );

      // P2-3.5 改密重加密
      new Setting(container)
        .setName('更改加密密码（重新加密）')
        .setDesc(
          '用新密码对所有已加密的云端文件重新加密（本地明文始终为真相源，先全量解密确认再重加密，过程不丢数据）。',
        )
        .addButton((b) =>
          b
            .setButtonText('更改密码')
            .setWarning()
            .onClick(() => void this.plugin.openReEncrypt()),
        );
    }

    // 版本历史设置（无论是否加密都可开启）
    const verSection = container.createEl('div', { cls: 'bdnsync-subsetting' });
    new Setting(verSection)
      .setName('文件级版本历史')
      .setDesc('每个文件保留最近 N 个版本，可在「版本历史」面板恢复上一版本。0 = 关闭')
      .addText((t) => {
        t.inputEl.type = 'number';
        t.setValue(String(s.maxVersions));
        t.onChange(async (v) => {
          const n = parseInt(v, 10);
          if (Number.isFinite(n) && n >= 0 && n <= 50) {
            s.maxVersions = n;
            this.debouncedSave();
          }
        });
      });
  }

  /**
   * 实验室总入口：把每个实验功能作为独立子 section（独立折叠 + 状态徽标），
   * 这样用户可以单独启用/禁用某个实验功能，无需滚动到一个长列表里找开关。
   *
   * 整体布局：
   *   - 顶部 callout：用一段通俗的「bdn://」使用说明 + 链接到总开关；
   *   - 总开关：labEnabled（关闭后下面所有子 section 隐藏/灰化）；
   *   - 4 个独立子 section：
   *       ① 网盘媒体直嵌（MediaBridge）  — 4 个开关（启/懒加载/离线占位/最大体积）
   *       ② 反向引用（Backlinks）        — 1 个开关
   *       ③ 离线收藏（Offline Pin）       — 2 个开关（启用 + 上限 MB）
   *       ④ 同步健康分（Health Score）    — 2 个开关（启用 + 预警阈值）
   *   - 每个子 section 标题右侧有状态徽标（绿=启用/灰=停用），便于一眼掌握。
   */
  private renderLab(container: HTMLElement): void {
    const s = this.plugin.settings;
    const enabled = s.labEnabled;

    // ---- 顶部说明（始终可见）：降低用户上手成本 ----
    const usage = container.createEl('div', { cls: 'bdnsync-callout bdnsync-callout-info' });
    usage.createEl('p', {
      cls: 'bdnsync-callout-text',
      text: '实验室为实验功能，每项独立开关。开启总开关后，按需启用下方子功能。',
    });
    const usageList = usage.createEl('ul', { cls: 'bdnsync-callout-list' });
    usageList.createEl('li', {
      cls: 'bdnsync-callout-text',
      text: 'bdn:// 引用：bdn://<相对路径>（相对云端同步目录）。',
    });
    usageList.createEl('li', {
      cls: 'bdnsync-callout-text',
      text: '插入引用：命令面板运行「BDNSync：插入网盘媒体引用」。',
    });

    // ---- 总开关 ----
    new Setting(container)
      .setName('启用实验室功能')
      .setDesc(
        '实验功能可能不稳定，仅建议在测试库开启。关闭后下方所有实验功能均不生效（并隐藏子项）。',
      )
      .addToggle((t) =>
        t.setValue(enabled).onChange(async (v) => {
          s.labEnabled = v;
          this.debouncedSave();
          this.display();
        }),
      );

    if (!enabled) {
      const off = container.createEl('div', { cls: 'bdnsync-callout bdnsync-callout-muted' });
      off.createEl('p', {
        cls: 'bdnsync-callout-text',
        text: '实验室已关闭。开启上方总开关后，下方每个子功能可独立启用。',
      });
      return;
    }

    // ---- 4 个子 section：每个独立折叠、独立状态徽标 ----
    this.renderLabMediaBridge(container);
    this.renderLabBacklinks(container);
    this.renderLabOfflinePin(container);
    this.renderLabHealthScore(container);
    this.renderLabGit(container);
    this.renderLabLan(container);
    this.renderLabSelfCheck(container);

    // ---- 一键复位：把全部实验功能子开关恢复默认（不影响主开关） ----
    const footer = container.createDiv({ cls: 'bdnsync-lab-footer' });
    const resetBtn = footer.createEl('button', {
      cls: 'bdnsync-btn bdnsync-btn-sm',
      text: '重置实验功能为默认（关闭）',
    });
    resetBtn.addEventListener('click', async () => {
      s.cloudMediaEnabled = false;
      s.cloudMediaLazyLoad = true;
      s.cloudMediaOfflinePlaceholder = true;
      s.labSelfCheckEnabled = false;
      s.cloudMediaMaxInlineMB = 50;
      s.labBacklinksEnabled = false;
      s.labOfflinePinEnabled = false;
      s.labOfflinePinMaxMB = 200;
      s.labHealthEnabled = false;
      s.labHealthWarnThreshold = 80;
      s.labGitEnabled = false;
      s.lastGitSyncRef = '';
      s.labGitFallbackToScan = true;
      s.labLanEnabled = false;
      s.lanPassphrase = '';
      s.lanListenPort = 51820;
      s.lanTargetHost = '';
      s.lanTargetPort = 0;
      this.debouncedSave();
      this.display();
    });
  }

  /** 实验室子功能 ①：网盘媒体直嵌（MediaBridge） */
  private renderLabMediaBridge(container: HTMLElement): void {
    const s = this.plugin.settings;
    const on = !!s.cloudMediaEnabled;
    const sec = createSection(container, {
      title: '① 网盘媒体直嵌（MediaBridge）',
      icon: 'image',
      collapsible: true,
      defaultOpen: on,
    });
    // 状态徽标
    this.renderLabStatusBadge(sec.header, on);

    // 用法说明（始终显示在本子区）
    const tip = sec.body.createEl('div', { cls: 'bdnsync-callout bdnsync-callout-muted' });
    tip.createEl('p', {
      cls: 'bdnsync-callout-text',
      text: '在笔记中用 bdn:// 引用网盘文件并内联渲染，支持图片/视频/音频；PDF/Office 显示文件卡片。',
    });

    new Setting(sec.body)
      .setName('启用 MediaBridge')
      .setDesc('关闭后 bdn:// 引用不会自动渲染（仅显示为链接）。')
      .addToggle((t) =>
        t.setValue(on).onChange(async (v) => {
          s.cloudMediaEnabled = v;
          this.debouncedSave();
          this.refreshLabStatusBadge(sec.header, v);
        }),
      );

    new Setting(sec.body)
      .setName('视频懒加载')
      .setDesc('开启后视频仅在交互时加载（preload=none），降低首屏带宽；关闭则预取元数据。')
      .addToggle((t) =>
        t.setValue(s.cloudMediaLazyLoad).onChange(async (v) => {
          s.cloudMediaLazyLoad = v;
          this.debouncedSave();
        }),
      );

    new Setting(sec.body)
      .setName('离线占位符')
      .setDesc('设备离线时显示占位符，网络恢复后自动重新加载；关闭则直接报错占位。')
      .addToggle((t) =>
        t.setValue(s.cloudMediaOfflinePlaceholder).onChange(async (v) => {
          s.cloudMediaOfflinePlaceholder = v;
          this.debouncedSave();
        }),
      );

    new Setting(sec.body)
      .setName('最大内联体积（MB）')
      .setDesc('超过该体积的媒体改为文件卡片（打开/下载），避免一次拉取过大。0 = 不限制')
      .addSlider((sl) =>
        sl
          .setLimits(0, 200, 5)
          .setValue(s.cloudMediaMaxInlineMB)
          .setDynamicTooltip()
          .onChange(async (v) => {
            s.cloudMediaMaxInlineMB = v;
            this.debouncedSave();
          }),
      );
  }

  /** 实验室子功能 ②：反向引用（Backlinks） */
  private renderLabBacklinks(container: HTMLElement): void {
    const s = this.plugin.settings;
    const on = !!s.labBacklinksEnabled;
    const sec = createSection(container, {
      title: '② 反向引用（Backlinks）',
      icon: 'git-branch',
      collapsible: true,
      defaultOpen: on,
    });
    this.renderLabStatusBadge(sec.header, on);

    const tip = sec.body.createEl('div', { cls: 'bdnsync-callout bdnsync-callout-muted' });
    tip.createEl('p', {
      cls: 'bdnsync-callout-text',
      text: '在预览/网盘浏览器中展示「哪些笔记引用了此文件」，点击可跳回对应笔记并定位行号。',
    });

    new Setting(sec.body)
      .setName('启用反向引用')
      .setDesc('开启后在 PreviewView 末尾展示引用当前网盘文件的笔记列表。')
      .addToggle((t) =>
        t.setValue(on).onChange(async (v) => {
          s.labBacklinksEnabled = v;
          this.debouncedSave();
          this.refreshLabStatusBadge(sec.header, v);
        }),
      );
  }

  /** 实验室子功能 ③：选择性离线收藏（Pin to Local） */
  private renderLabOfflinePin(container: HTMLElement): void {
    const s = this.plugin.settings;
    const on = !!s.labOfflinePinEnabled;
    const sec = createSection(container, {
      title: '③ 离线收藏（Offline Pin）',
      icon: 'download',
      collapsible: true,
      defaultOpen: on,
    });
    this.renderLabStatusBadge(sec.header, on);

    const tip = sec.body.createEl('div', { cls: 'bdnsync-callout bdnsync-callout-muted' });
    tip.createEl('p', {
      cls: 'bdnsync-callout-text',
      text: '把 bdn:// 媒体收藏到本地，离线时可直接渲染；超出上限按访问时间清理。',
    });

    new Setting(sec.body)
      .setName('启用离线收藏')
      .setDesc(
        '开启后 bdn:// 媒体加载失败时回退到本地缓存（同时支持手动 pinFile/unpinFile 命令）。',
      )
      .addToggle((t) =>
        t.setValue(on).onChange(async (v) => {
          s.labOfflinePinEnabled = v;
          this.debouncedSave();
          this.refreshLabStatusBadge(sec.header, v);
        }),
      );

    new Setting(sec.body)
      .setName('离线收藏上限（MB）')
      .setDesc('本地收藏缓存的最大体积，超出按访问时间清理。0 = 不限制')
      .addSlider((sl) =>
        sl
          .setLimits(0, 2000, 50)
          .setValue(s.labOfflinePinMaxMB)
          .setDynamicTooltip()
          .onChange(async (v) => {
            s.labOfflinePinMaxMB = v;
            this.debouncedSave();
          }),
      );
  }

  /** 实验室子功能 ④：同步健康分（Health Score） */
  private renderLabHealthScore(container: HTMLElement): void {
    const s = this.plugin.settings;
    const on = !!s.labHealthEnabled;
    const sec = createSection(container, {
      title: '④ 同步健康分（Health Score）',
      icon: 'activity',
      collapsible: true,
      defaultOpen: on,
    });
    this.renderLabStatusBadge(sec.header, on);

    const tip = sec.body.createEl('div', { cls: 'bdnsync-callout bdnsync-callout-muted' });
    tip.createEl('p', {
      cls: 'bdnsync-callout-text',
      text: '每次同步后给出 0–100 健康分，分数过低时弹提醒，避免问题被忽略。',
    });

    new Setting(sec.body)
      .setName('启用同步健康分')
      .setDesc('关闭则不计算、不提醒。')
      .addToggle((t) =>
        t.setValue(on).onChange(async (v) => {
          s.labHealthEnabled = v;
          this.debouncedSave();
          this.refreshLabStatusBadge(sec.header, v);
        }),
      );

    new Setting(sec.body)
      .setName('健康分预警阈值')
      .setDesc('同步健康分低于该值（0-100）时弹出提醒。分数越低风险越高。')
      .addSlider((sl) =>
        sl
          .setLimits(0, 100, 5)
          .setValue(s.labHealthWarnThreshold)
          .setDynamicTooltip()
          .onChange(async (v) => {
            s.labHealthWarnThreshold = v;
            this.debouncedSave();
          }),
      );
  }

  /** 实验室子功能 ⑤：基于 Git 差异的增量同步（#5.9，仅桌面） */
  private renderLabGit(container: HTMLElement): void {
    const s = this.plugin.settings;
    const on = !!s.labGitEnabled;
    const desktop = Platform.isDesktop;
    const sec = createSection(container, {
      title: '⑤ Git 差异增量同步（仅桌面）',
      icon: 'git-branch',
      collapsible: true,
      defaultOpen: on,
    });
    this.renderLabStatusBadge(sec.header, on);

    const tip = sec.body.createEl('div', { cls: 'bdnsync-callout bdnsync-callout-muted' });
    tip.createEl('p', {
      cls: 'bdnsync-callout-text',
      text: '对启用 Git 的库，用 git 差异作为变更源，跳过全量扫描，大库提速明显。仅桌面端可用，且不自动 commit。',
    });

    new Setting(sec.body)
      .setName('启用 Git 差异增量')
      .setDesc(
        desktop
          ? '开启后可用「Git 增量同步」命令，基于 git 差异跳过全量扫描。'
          : '当前为移动端，Git 增量不可用，将自动回退常规同步。',
      )
      .addToggle((t) =>
        t
          .setValue(on)
          .setDisabled(!desktop)
          .onChange(async (v) => {
            s.labGitEnabled = v;
            this.debouncedSave();
            this.refreshLabStatusBadge(sec.header, v);
          }),
      );

    new Setting(sec.body)
      .setName('Git 不可用时回退常规同步')
      .setDesc('关闭则非 Git 仓库时报错；开启则回退常规扫描。')
      .addToggle((t) =>
        t.setValue(!!s.labGitFallbackToScan).onChange(async (v) => {
          s.labGitFallbackToScan = v;
          this.debouncedSave();
        }),
      );

    const refLine = sec.body.createEl('div', { cls: 'bdnsync-callout bdnsync-callout-muted' });
    refLine.createEl('p', {
      cls: 'bdnsync-callout-text',
      text: s.lastGitSyncRef
        ? `当前基线 ref：${s.lastGitSyncRef.slice(0, 12)}…（每次成功同步后自动更新为最新 HEAD）`
        : '尚未记录基线 ref：首次同步将基于 working tree 范围，之后自动收敛到「上次同步后」区间。',
    });
  }

  /** 实验室子功能 ⑩：局域网 P2P 同步（#5.10，仅桌面） */
  private renderLabLan(container: HTMLElement): void {
    const s = this.plugin.settings;
    const on = !!s.labLanEnabled;
    const desktop = Platform.isDesktop;
    const sec = createSection(container, {
      title: '⑩ 局域网 P2P 同步（仅桌面）',
      icon: 'hard-drive',
      collapsible: true,
      defaultOpen: on,
    });
    this.renderLabStatusBadge(sec.header, on);

    const tip = sec.body.createEl('div', { cls: 'bdnsync-callout bdnsync-callout-muted' });
    tip.createEl('p', {
      cls: 'bdnsync-callout-text',
      text: '不依赖网盘，在同局域网两台设备间直接同步。数据不出局域网，信道用配对口令加密。仅桌面端可用。',
    });

    new Setting(sec.body)
      .setName('启用局域网 P2P 同步')
      .setDesc(
        desktop
          ? '开启后可在命令面板使用「启动局域网对端」「局域网同步」命令。'
          : '当前为移动端，局域网 P2P 不可用。',
      )
      .addToggle((t) =>
        t
          .setValue(on)
          .setDisabled(!desktop)
          .onChange(async (v) => {
            s.labLanEnabled = v;
            this.debouncedSave();
            this.refreshLabStatusBadge(sec.header, v);
          }),
      );

    new Setting(sec.body)
      .setName('信道配对口令')
      .setDesc('两端须一致才能互通；留空为明文信道（仅本机联调建议）。文件内容端到端加密由「加密」设置另行控制。')
      .addText((t) =>
        t
          .setValue(s.lanPassphrase)
          .setPlaceholder('两端一致的配对码')
          .onChange(async (v) => {
            s.lanPassphrase = v;
            this.debouncedSave();
          }),
      );

    new Setting(sec.body)
      .setName('本机监听端口')
      .setDesc('本机作为「被同步对端」时监听的端口（1–65535）。')
      .addText((t) => {
        t.setValue(String(s.lanListenPort));
        const input = t.inputEl;
        const hintEl = input.parentElement?.createDiv({ cls: 'bdnsync-field-hint' });
        const hint = hintEl ?? undefined;
        const validate = () => {
          const v = input.value.trim();
          const n = Number(v);
          if (!v) {
            hint?.setText('请填写监听端口');
            if (hint) hint.className = 'bdnsync-field-hint bdnsync-field-hint-error';
            input.classList.add('bdnsync-input-invalid');
            return false;
          }
          if (!Number.isInteger(n) || n < 1 || n > 65535) {
            hint?.setText('端口需为 1–65535 之间的整数');
            if (hint) hint.className = 'bdnsync-field-hint bdnsync-field-hint-error';
            input.classList.add('bdnsync-input-invalid');
            return false;
          }
          hint?.setText('端口有效');
          if (hint) hint.className = 'bdnsync-field-hint bdnsync-field-hint-ok';
          input.classList.remove('bdnsync-input-invalid');
          return true;
        };
        input.addEventListener('input', validate);
        input.addEventListener('blur', validate);
        validate();
        t.onChange(async (v) => {
          const n = Number(v);
          if (Number.isFinite(n) && n > 0 && n <= 65535) {
            s.lanListenPort = Math.floor(n);
            this.debouncedSave();
          }
        });
      });

    new Setting(sec.body)
      .setName('手动指定对端主机')
      .setDesc('手动填写另一台设备的 IP（自动发现仍在规划中）。')
      .addText((t) =>
        t
          .setValue(s.lanTargetHost)
          .setPlaceholder('如 192.168.1.20')
          .onChange(async (v) => {
            s.lanTargetHost = v.trim();
            this.debouncedSave();
          }),
      );

    new Setting(sec.body)
      .setName('手动指定对端端口')
      .setDesc('留空则随发现结果或回退到默认监听端口（1–65535，0 表示未指定）。')
      .addText((t) => {
        t.setValue(s.lanTargetPort ? String(s.lanTargetPort) : '');
        t.setPlaceholder('默认 51820');
        const input = t.inputEl;
        const hintEl = input.parentElement?.createDiv({ cls: 'bdnsync-field-hint' });
        const hint = hintEl ?? undefined;
        const validate = () => {
          const v = input.value.trim();
          if (!v) {
            hint?.setText('留空将回退默认端口');
            if (hint) hint.className = 'bdnsync-field-hint';
            input.classList.remove('bdnsync-input-invalid');
            return;
          }
          const n = Number(v);
          if (!Number.isInteger(n) || n < 1 || n > 65535) {
            hint?.setText('端口需为 1–65535 之间的整数，或留空');
            if (hint) hint.className = 'bdnsync-field-hint bdnsync-field-hint-error';
            input.classList.add('bdnsync-input-invalid');
            return;
          }
          hint?.setText('端口有效');
          if (hint) hint.className = 'bdnsync-field-hint bdnsync-field-hint-ok';
          input.classList.remove('bdnsync-input-invalid');
        };
        input.addEventListener('input', validate);
        input.addEventListener('blur', validate);
        validate();
        t.onChange(async (v) => {
          const n = Number(v);
          s.lanTargetPort = Number.isFinite(n) ? Math.floor(n) : 0;
          this.debouncedSave();
        });
      });
  }

  /** 实验室子功能 ⑥：功能自检（Self-Check） */
  private renderLabSelfCheck(container: HTMLElement): void {
    const s = this.plugin.settings;
    const on = !!s.labSelfCheckEnabled;
    const sec = createSection(container, {
      title: '⑥ 功能自检（Self-Check）',
      icon: 'check',
      collapsible: true,
      defaultOpen: on,
    });
    this.renderLabStatusBadge(sec.header, on);

    const tip = sec.body.createEl('div', { cls: 'bdnsync-callout bdnsync-callout-muted' });
    tip.createEl('p', {
      cls: 'bdnsync-callout-text',
      text: '对插件自身的基础能力（配置 / 授权 / 网络 / 引擎 / 日志 / 重试队列 / 文件监听 / 本地存储 / 加密）做一次性体检，快速定位异常项。',
    });

    new Setting(sec.body)
      .setName('启用功能自检')
      .setDesc('关闭则不在命令面板暴露「运行自检」命令。')
      .addToggle((t) =>
        t.setValue(on).onChange(async (v) => {
          s.labSelfCheckEnabled = v;
          this.debouncedSave();
          this.refreshLabStatusBadge(sec.header, v);
        }),
      );

    new Setting(sec.body)
      .setName('立即运行自检')
      .setDesc('对当前运行状态做一次体检并弹出结果面板。')
      .addButton((b) =>
        b.setButtonText('运行自检').setCta().onClick(() => void this.plugin.runSelfCheckCommand()),
      );
  }

  /** 在子区头右侧渲染一个状态徽标（绿/灰） */
  private renderLabStatusBadge(header: HTMLElement, on: boolean): HTMLElement {
    const badge = header.createSpan({
      cls: `bdnsync-lab-status-badge ${on ? 'is-on' : 'is-off'}`,
      attr: { 'aria-label': on ? '已启用' : '已停用' },
    });
    badge.createSpan({ cls: 'bdnsync-lab-status-dot' });
    badge.createSpan({ text: on ? '已启用' : '已停用' });
    return badge;
  }

  /**
   * 子区启用状态变化时，仅刷新该子区的徽标而不重渲染整个设置页。
   * 复用 header 已存在的徽标节点（带 bdnsync-lab-status-badge 类）。
   */
  private refreshLabStatusBadge(header: HTMLElement, on: boolean): void {
    const old = header.querySelector('.bdnsync-lab-status-badge');
    if (!old) return;
    old.classList.remove('is-on', 'is-off');
    old.classList.add(on ? 'is-on' : 'is-off');
    const dot = old.querySelector('.bdnsync-lab-status-dot');
    const label = old.querySelectorAll('span')[1];
    // 重建文本：清掉旧的 label 文本节点
    old.childNodes.forEach((n, idx) => {
      // idx 0: dot span (createSpan), 1: label span, 2+: text
      if (idx >= 2) old.removeChild(n);
    });
    void dot;
    if (label) label.textContent = on ? '已启用' : '已停用';
    old.setAttr('aria-label', on ? '已启用' : '已停用');
  }

  private renderPerformance(container: HTMLElement): void {
    const s = this.plugin.settings;
    new Setting(container)
      .setName('分片大小')
      .setDesc('大文件分片上传的单片大小。分片越大分片请求越少，上传越快（8-32 MB 推荐）')
      .addDropdown((d) => {
        d.addOption('4', '4 MB');
        d.addOption('8', '8 MB');
        d.addOption('16', '16 MB');
        d.addOption('32', '32 MB');
        d.setValue(String(s.chunkSizeMB));
        d.onChange(async (v) => {
          s.chunkSizeMB = parseInt(v, 10);
          this.debouncedSave();
        });
      });

    new Setting(container)
      .setName('上传并发')
      .setDesc('同时上传的文件数（1-5）')
      .addSlider((sl) =>
        sl
          .setLimits(1, 5, 1)
          .setValue(s.uploadConcurrency)
          .setDynamicTooltip()
          .onChange(async (v) => {
            s.uploadConcurrency = v;
            this.debouncedSave();
          }),
      );

    new Setting(container)
      .setName('下载并发')
      .setDesc('同时下载的文件数（1-5）')
      .addSlider((sl) =>
        sl
          .setLimits(1, 5, 1)
          .setValue(s.downloadConcurrency)
          .setDynamicTooltip()
          .onChange(async (v) => {
            s.downloadConcurrency = v;
            this.debouncedSave();
          }),
      );

    new Setting(container)
      .setName('请求间隔（毫秒）')
      .setDesc(
        '元数据接口节流，避免触发网盘限流；上传/下载不节流。推荐 200–300。',
      )
      .addText((t) => {
        t.setValue(String(s.requestIntervalMs));
        t.onChange(async (v) => {
          const n = parseInt(v, 10);
          if (!Number.isNaN(n) && n >= 50 && n <= 5000) {
            s.requestIntervalMs = n;
            this.debouncedSave();
          }
        });
      });

    new Setting(container)
      .setName('上传带宽限制（KB/s）')
      .setDesc('限制上传速度，避免大库同步占满带宽。0 = 不限速')
      .addText((t) => {
        t.inputEl.type = 'number';
        t.setValue(String(s.bandwidthLimitKBps));
        t.onChange(async (v) => {
          const n = Number(v);
          if (Number.isFinite(n) && n >= 0) {
            s.bandwidthLimitKBps = Math.floor(n);
            this.debouncedSave();
          }
        });
      });

    new Setting(container)
      .setName('同步前预览（dry-run）')
      .setDesc(
        '手动双向同步前展示将要上传/下载/删除/冲突的操作计划，确认后再执行（降低误操作焦虑）',
      )
      .addToggle((t) =>
        t.setValue(s.syncPreviewEnabled).onChange(async (v) => {
          s.syncPreviewEnabled = v;
          this.debouncedSave();
        }),
      );

    new Setting(container)
      .setName('风暴阈值（实时同步）')
      .setDesc(
        '单次批量变更超此数量时，实时同步降级为一次完整同步。大库建议 200，0 关闭。',
      )
      .addText((t) => {
        t.inputEl.type = 'number';
        t.setValue(String(s.stormThreshold));
        t.onChange(async (v) => {
          const n = parseInt(v, 10);
          if (Number.isInteger(n) && n >= 0) {
            s.stormThreshold = n;
            this.debouncedSave();
          }
        });
      });

    new Setting(container)
      .setName('脏集合窗口（毫秒）')
      .setDesc(
        '把短时间内的「删除+新建」合并为一次重命名。默认 1500 毫秒。',
      )
      .addText((t) => {
        t.inputEl.type = 'number';
        t.setValue(String(s.renameGraceMs));
        t.onChange(async (v) => {
          const n = parseInt(v, 10);
          if (Number.isInteger(n) && n >= 0 && n <= 10000) {
            s.renameGraceMs = n;
            this.debouncedSave();
          }
        });
      });

    // P1-3.6 动态并发（自适应反馈）
    new Setting(container)
      .setName('自适应并发（实验）')
      .setDesc(
        '按限流情况自动微调并发（1–5），减少手动调参。',
      )
      .addToggle((t) =>
        t.setValue(s.adaptiveConcurrency).onChange(async (v) => {
          s.adaptiveConcurrency = v;
          this.debouncedSave();
        }),
      );

    // P1-4.7 大文件独立通道阈值
    new Setting(container)
      .setName('大文件独立通道阈值（MB）')
      .setDesc(
        '超过此大小的文件走专用通道，避免阻塞小文件。0 不启用。',
      )
      .addText((t) => {
        t.inputEl.type = 'number';
        t.setValue(String(s.largeFileThresholdMB));
        t.onChange(async (v) => {
          const n = Number(v);
          if (Number.isFinite(n) && n >= 0 && n <= 4096) {
            s.largeFileThresholdMB = Math.floor(n);
            this.debouncedSave();
          }
        });
      });

    // P1-2.1 API 容灾：每日轻量探查 + 降级提示
    new Setting(container)
      .setName('API 健康探查')
      .setDesc('每日轻量探测接口健康，异常时提示降级方案（如切 Cookie 模式）。')
      .addToggle((t) =>
        t.setValue(s.apiProbeEnabled).onChange(async (v) => {
          s.apiProbeEnabled = v;
          this.debouncedSave();
        }),
      );

    new Setting(container)
      .setName('API 探查间隔（小时）')
      .setDesc('两次探查之间的最小间隔（避免频繁打扰）。默认 24 小时。')
      .addText((t) => {
        t.inputEl.type = 'number';
        t.setValue(String(s.apiProbeIntervalHours));
        t.onChange(async (v) => {
          const n = Number(v);
          if (Number.isFinite(n) && n >= 1 && n <= 168) {
            s.apiProbeIntervalHours = Math.floor(n);
            this.debouncedSave();
          }
        });
      });

    // P2-4.6 跨设备看板开关
    new Setting(container)
      .setName('跨设备同步看板')
      .setDesc('在命令面板提供「跨设备同步状态看板」，基于本地索引聚合各设备同步状态（轮询式，非实时推送）。')
      .addToggle((t) =>
        t.setValue(s.crossDeviceDashboardEnabled).onChange(async (v) => {
          s.crossDeviceDashboardEnabled = v;
          this.debouncedSave();
        }),
      );
  }

  private renderDevice(container: HTMLElement): void {
    const s = this.plugin.settings;
    new Setting(container)
      .setName('设备名称')
      .setDesc('显示在冲突标记与索引中，便于区分修改来源')
      .addText((t) =>
        t
          .setValue(s.deviceName)
          .setPlaceholder('例如：办公室台式机')
          .onChange(async (v) => {
            s.deviceName = v.trim();
            this.debouncedSave();
          }),
      );

    new Setting(container)
      .setName('设备 ID')
      .setDesc(s.deviceId)
      .addButton((b) =>
        b
          .setButtonText('重新生成')
          .setWarning()
          .onClick(async () => {
            const ok = await new ConfirmModal(
              this.app,
              '重新生成设备 ID',
              '这会导致当前设备被识别为新设备，可能引发一次全量对账。是否继续？',
              '重新生成',
              true,
            ).open();
            if (!ok) return;
            s.deviceId = `device-${Math.random().toString(36).slice(2, 10)}`;
            this.debouncedSave();
            this.display();
          }),
      );

    new Setting(container)
      .setName('界面主题')
      .setDesc('高对比度模式提升弱光或视觉敏感场景的可读性。')
      .addDropdown((d) =>
        d
          .addOption('auto', '跟随 Obsidian')
          .addOption('normal', '常规（高可读）')
          .addOption('high-contrast', '高对比度')
          .setValue(s.themeMode)
          .onChange(async (v) => {
            s.themeMode = v as 'auto' | 'normal' | 'high-contrast';
            this.debouncedSave();
          }),
      );
  }

  /** 整库快照设置（force 方向前自动备份，误删可整库回滚） */
  private renderSnapshot(container: HTMLElement): void {
    const section = createSection(container, { title: '整库快照', icon: 'layers' });
    new Setting(section.body)
      .setName('自动快照')
      .setDesc('强制覆盖前自动生成整库快照，误删后可整库回滚。')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.autoSnapshot).onChange(async (v) => {
          this.plugin.settings.autoSnapshot = v;
          this.debouncedSave();
        }),
      );
    new Setting(section.body)
      .setName('保留快照数')
      .setDesc('最多保留的快照点数量，超出自动淘汰最旧的。')
      .addText((t) => {
        t.inputEl.type = 'number';
        t.setValue(String(this.plugin.settings.maxSnapshots));
        t.onChange(async (v) => {
          const n = parseInt(v, 10);
          if (Number.isFinite(n) && n >= 1 && n <= 20) {
            this.plugin.settings.maxSnapshots = n;
            this.debouncedSave();
          }
        });
      });

    // P1-4.5 定时自动快照（常驻调度，按间隔生成带备注的整库快照）
    new Setting(section.body)
      .setName('定时快照间隔（分钟）')
      .setDesc(
        '后台按固定间隔自动生成整库快照（0 = 关闭定时快照，仍可手动生成）。仅桌面端常驻生效；移动端在每次同步后补拍。',
      )
      .addText((t) => {
        t.inputEl.type = 'number';
        t.setValue(String(this.plugin.settings.snapshotIntervalMinutes));
        t.onChange(async (v) => {
          const n = parseInt(v, 10);
          if (Number.isFinite(n) && n >= 0 && n <= 1440) {
            this.plugin.settings.snapshotIntervalMinutes = n;
            this.debouncedSave();
          }
        });
      });
  }

  private renderMaintenance(container: HTMLElement): void {
    const s = this.plugin.settings;
    const row = container.createDiv({ cls: 'bdnsync-connection-actions' });

    /** 构造可导出的设置副本：凭证字段脱敏，其余配置完整保留。 */
    const buildExportableSettings = (): Record<string, unknown> => {
      const clone = { ...s } as Record<string, unknown>;
      const SENSITIVE = [
        'cookies',
        'bduss',
        'stoken',
        'appKey',
        'secretKey',
        'accessToken',
        'refreshToken',
        'tokenExpiresAt',
        'encryptionPassword',
        'encryptionSalt',
      ];
      for (const k of SENSITIVE) {
        if (clone[k])
          clone[k] =
            typeof clone[k] === 'string' && String(clone[k]).length > 0 ? '<redacted>' : clone[k];
      }
      return clone;
    };

    createIconButton(row, {
      icon: 'copy',
      label: '导出设置到剪贴板',
      onClick: async () => {
        await navigator.clipboard.writeText(JSON.stringify(buildExportableSettings(), null, 2));
        new Notice('BDNSync：设置已复制到剪贴板（凭证已脱敏）');
      },
    });
    createIconButton(row, {
      icon: 'download',
      label: '导出设置到文件',
      onClick: () => {
        const blob = new Blob([JSON.stringify(buildExportableSettings(), null, 2)], {
          type: 'application/json',
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const date = new Date().toISOString().slice(0, 10);
        a.href = url;
        a.download = `bdnsync-settings-${date}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        new Notice('BDNSync：设置已导出为文件（凭证已脱敏）');
      },
    });
    createIconButton(row, {
      icon: 'file-text',
      label: '导入设置',
      onClick: () => {
        new ImportSettingsModal(this.app, (json) => {
          try {
            const raw = JSON.parse(json);
            const sanitized = this.sanitizeImportedSettings(raw);
            if (!sanitized) return false;
            // 白名单合并：仅接受已校验字段；deviceId 永不从导入覆盖（防设备身份混淆）
            const keepDeviceId = this.plugin.settings.deviceId;
            Object.assign(this.plugin.settings, sanitized);
            this.plugin.settings.deviceId = keepDeviceId || s.deviceId;
            void this.plugin.saveSettings();
            this.plugin.restartScheduler();
            this.display();
            return true;
          } catch {
            return false;
          }
        }).open();
      },
    });
    createIconButton(row, {
      icon: 'rotate-ccw',
      label: '重置本地索引',
      danger: true,
      onClick: async () => {
        const ok = await new ConfirmModal(
          this.app,
          '重置本地同步状态',
          '清空本地索引，下次同步将全量对账。云端文件不受影响。是否继续？',
          '重置',
          true,
        ).open();
        if (!ok) return;
        await this.plugin.engine?.resetLocalIndex();
        new Notice('BDNSync：本地索引已重置，下次同步将全量对账');
      },
    });
  }

  /** 强制同步：以某一侧为唯一真相，用于修复索引损坏 / 冲突缠死 / 换机重装 */
  private renderForceSync(container: HTMLElement): void {
    const section = createSection(container, {
      title: '强制同步（修复用）',
      icon: 'alert-triangle',
    });
    section.body.createEl('p', {
      cls: 'bdnsync-setting-hint',
      text: '当索引错乱、冲突反复无法解决，或需要换机重装时，可强制以某一侧为唯一真相重新对齐。该操作会删除对侧多余文件，执行前会二次确认。',
    });
    const row = section.body.createDiv({ cls: 'bdnsync-connection-actions' });
    createIconButton(row, {
      icon: 'cloud-upload',
      label: '强制上传（本地覆盖云端）',
      danger: true,
      onClick: () => void this.plugin.forceSync('force-upload'),
    });
    createIconButton(row, {
      icon: 'cloud-download',
      label: '强制下载（云端覆盖本地）',
      danger: true,
      onClick: () => void this.plugin.forceSync('force-download'),
    });
  }

  /** 网盘孤儿备份目录清理（与「维护」同区，默认保守：仅检测、不自动删） */
  private renderOrphanCleanup(container: HTMLElement): void {
    const s = this.plugin.settings;
    const section = createSection(container, {
      title: '网盘孤儿备份目录',
      icon: 'trash-2',
    });
    const note = section.body.createEl('div', {
      cls: 'bdnsync-callout bdnsync-callout-info',
    });
    note.createEl('p', {
      cls: 'bdnsync-callout-text',
      text:
        '识别网盘上「vault 名_时间戳」型的疑似残留目录与无主文件。仅检测、不静默删除：清理前一律弹窗确认。',
    });

    // 详细说明（可折叠，供需要深入了解的用户阅读）
    const detail = createSection(section.body, {
      title: '详细说明',
      icon: 'info',
      collapsible: true,
      defaultOpen: false,
    });
    const detailBody = detail.body;
    const addDetail = (t: string): void => {
      detailBody.createEl('p', { cls: 'bdnsync-callout-text', text: t });
    };
    addDetail('用途：识别同步目录父目录下形如「vault 名_YYYYMMDD_HHMMSS」的疑似备份；这些目录并非当前 BDNSync 写入。');
    addDetail('行为：检测开启后仅写日志；自动清理开启后同步结束会扫描，但删除仍由弹窗勾选确认，绝不静默删除。');
    addDetail('范围：parent-only 仅看父目录；scoped 含 vault 顶层；full-vault 深度遍历整棵树（可识别「未命名.canvas」等无主残留）。');
    addDetail('资源控制：full-vault 受节点/字节双重预算保护（默认 2 万节点 / 2GB），触达即停止，不会耗尽资源。');
    addDetail('忽略规则：可叠加 orphanExtraIgnoreGlobs 作为白名单；插件自身 .bdnsync*/ 目录永远硬排除。');
    addDetail('删除模式：默认先送回收站（可逆）；百度网盘接口不提供「跳过回收站」，关闭回收站后仍需到 Web 端清空。');
    addDetail('常见来源：旧版本残留、Web 端改 vault 名、其它同步插件改名前缀、多设备并发竞争等。');
    addDetail('预防：勿在 Web 端直接重命名 vault 根；避免两个同步工具写同一父目录；其它插件远端根指向子目录。');
    addDetail('启动巡检：插件启动（24h 限频）也会扫描；短期新增 ≥3 个会弹 Notice 提示并发写入风险。');

    // 检测开关
    new Setting(section.body)
      .setName('检测疑似孤儿目录')
      .setDesc('同步结束时若发现疑似孤儿目录，写入 SyncLog（模块 cleanup）供后续清理。')
      .addToggle((t) =>
        t.setValue(s.detectOrphanBackupDirs).onChange(async (v) => {
          s.detectOrphanBackupDirs = v;
          this.debouncedSave();
        }),
      );

    // 自动清理开关
    new Setting(section.body)
      .setName('同步后自动巡检清理')
      .setDesc(
        '开启后同步结束会自动扫描；**找到候选不会自动删，仍走弹窗确认**。如果你只想手动跑命令，关闭此项。',
      )
      .addToggle((t) =>
        t.setValue(s.autoPruneOrphanBackupDirs).onChange(async (v) => {
          s.autoPruneOrphanBackupDirs = v;
          this.debouncedSave();
        }),
      );

    // 保留天数
    new Setting(section.body)
      .setName('候选保留天数（仅巡检命中时过滤）')
      .setDesc(
        '仅当孤儿目录「最后修改时间」距今超过该天数才进入巡检候选。设 0 = 不论新旧都进入候选。默认 90。',
      )
      .addText((t) => {
        t.inputEl.type = 'number';
        t.setValue(String(s.orphanRetentionDays));
        t.onChange(async (v) => {
          const n = parseInt(v, 10);
          s.orphanRetentionDays = Number.isFinite(n) && n >= 0 ? Math.min(3650, Math.floor(n)) : 90;
          this.debouncedSave();
        });
      });

    // v2：扫描模式（parent-only / scoped / full-vault）
    const modeLabels: Record<string, string> = {
      'parent-only': '父目录单层（保守，旧行为）',
      scoped: '父目录 + vault 顶层（scoped）',
      'full-vault': '深度遍历 vault 整棵树（full-vault）',
    };
    new Setting(section.body)
      .setName('扫描模式')
      .setDesc(
        '选择深度遍历范围。full-vault 能识别 vault 根下的孤儿文件与嵌套孤儿子目录。',
      )
      .addDropdown((d) => {
        for (const k of ['parent-only', 'scoped', 'full-vault']) d.addOption(k, modeLabels[k]);
        d.setValue(s.orphanScanMode).onChange(async (v) => {
          if (v === 'parent-only' || v === 'scoped' || v === 'full-vault') {
            s.orphanScanMode = v;
            this.debouncedSave();
          }
        });
      });

    // v2：最大递归深度（仅 full-vault 生效；0 = 不限）
    new Setting(section.body)
      .setName('最大递归深度（仅 full-vault）')
      .setDesc(
        '限制扫描层级。0 = 不限（仍受预算保护）。',
      )
      .addText((t) => {
        t.inputEl.type = 'number';
        t.setValue(String(s.orphanScanMaxDepth));
        t.onChange(async (v) => {
          const n = parseInt(v, 10);
          s.orphanScanMaxDepth = Number.isFinite(n) && n >= 0 ? Math.min(32, Math.floor(n)) : 0;
          this.debouncedSave();
        });
      });

    // v2：节点预算
    new Setting(section.body)
      .setName('节点预算（单次扫描最多访问的远端条目数）')
      .setDesc(
        '触达即停并标记「已截断」。默认 20000。万级库安全；超大库可调高，但避免一次扫描占用过多 API 配额。',
      )
      .addText((t) => {
        t.inputEl.type = 'number';
        t.setValue(String(s.orphanScanMaxNodes));
        t.onChange(async (v) => {
          const n = parseInt(v, 10);
          s.orphanScanMaxNodes = Number.isFinite(n) && n >= 0 ? Math.min(1_000_000, Math.floor(n)) : 20000;
          this.debouncedSave();
        });
      });

    // v2：字节预算
    new Setting(section.body)
      .setName('字节预算（单次扫描累计字节数上限）')
      .setDesc('触达即停。默认 2 GB（约 2147483648 字节）。一般无需调整；超大库可调高。')
      .addText((t) => {
        t.inputEl.type = 'number';
        t.setValue(String(s.orphanScanMaxBytes));
        t.onChange(async (v) => {
          const n = parseInt(v, 10);
          s.orphanScanMaxBytes =
            Number.isFinite(n) && n >= 0 ? Math.min(1_099_511_627_776, Math.floor(n)) : 2 * 1024 * 1024 * 1024;
          this.debouncedSave();
        });
      });

    // v2：并发数
    new Setting(section.body)
      .setName('扫描并发数（listDir 并发上限）')
      .setDesc('1–8。默认 3。百度 API QPS 限制较严，超过 5 容易触发 errno=31034/31039。')
      .addText((t) => {
        t.inputEl.type = 'number';
        t.setValue(String(s.orphanScanConcurrency));
        t.onChange(async (v) => {
          const n = parseInt(v, 10);
          s.orphanScanConcurrency = Number.isFinite(n) && n >= 1 ? Math.min(8, Math.floor(n)) : 3;
          this.debouncedSave();
        });
      });

    // v2：删除模式（回收站 vs 永久）
    new Setting(section.body)
      .setName('删除先送回收站（可逆）')
      .setDesc(
        '开启 → 删除时进入回收站，可通过网盘 Web 端恢复。关闭 → 语义上「永久删除」（实际仍会进回收站，因百度网盘 API 不提供单次跳过回收站接口；modal 会显式提示）。',
      )
      .addToggle((t) =>
        t.setValue(s.orphanUseRecycleBin).onChange(async (v) => {
          s.orphanUseRecycleBin = v;
          this.debouncedSave();
        }),
      );

    // v2：额外忽略 glob
    new Setting(section.body)
      .setName('额外忽略 glob（每行一个）')
      .setDesc(
        '叠加在已有「过滤模式」之上 —— 命中即整棵子树跳过。例：attachments/**、*.important、.trash/**。',
      )
      .addTextArea((t) => {
        t.setValue((s.orphanExtraIgnoreGlobs || []).join('\n'));
        t.onChange(async (v) => {
          const arr = v
            .split('\n')
            .map((x) => x.trim())
            .filter(Boolean);
          s.orphanExtraIgnoreGlobs = arr;
          this.debouncedSave();
        });
      });

    // 上次扫描状态
    if (s.lastOrphanScanAt) {
      section.body.createEl('p', {
        cls: 'bdnsync-setting-hint',
        text: `上次扫描：${formatTime(s.lastOrphanScanAt)}（24h 内限频）`,
      });
    } else {
      section.body.createEl('p', {
        cls: 'bdnsync-setting-hint',
        text: '尚未扫描。可点击下方按钮立即跑一次（手动命令不受 24h 限频）。',
      });
    }

    // 手动扫描命令按钮
    const row = section.body.createDiv({ cls: 'bdnsync-connection-actions' });
    createIconButton(row, {
      icon: 'filter',
      label: '扫描并清理网盘备份目录',
      onClick: () => void this.plugin.openOrphanCleanupModal(),
    });
  }

  /** 数据安全说明：明确卸载/停用不会清云端、删除有墓碑回收 */
  private renderDataSafety(container: HTMLElement): void {
    const section = createSection(container, { title: '数据安全', icon: 'shield' });
    const note = section.body.createEl('div', { cls: 'bdnsync-callout bdnsync-callout-info' });
    note.createEl('p', {
      cls: 'bdnsync-callout-text',
      text: '· 卸载或停用本插件不会删除百度网盘上的任何文件，你的数据始终保留在云端。',
    });
    note.createEl('p', {
      cls: 'bdnsync-callout-text',
      text: '· 被同步删除的文件有 30 天墓碑回收期，期间可在百度网盘「回收站」找回。',
    });
    note.createEl('p', {
      cls: 'bdnsync-callout-text',
      text: '· 多设备同时在线时，索引采用乐观锁合并，并发修改会自动保留双方版本（冲突副本），不会静默丢失内容。',
    });
  }
}
