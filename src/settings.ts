// 设置面板：卡片化、连接状态卡片、首次引导、折叠高级参数

import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
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
  private rerenderToken = 0;
  private quotaListener = (): void => {
    // 配额后台刷新完成后自动重绘连接卡片，避免一直显示「未检测」
    if (!this.containerEl.isConnected) return;
    this.display();
  };
  private vipListener = (): void => {
    // VIP 信息后台刷新完成后自动重绘个人卡片
    if (!this.containerEl.isConnected) return;
    this.display();
  };

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
    containerEl.empty();
    containerEl.addClass('bdnsync-setting-tab', 'bdnsync-root');

    // 顶部标题
    const header = containerEl.createDiv({ cls: 'bdnsync-setting-header' });
    const headerIcon = header.createDiv({ cls: 'bdnsync-setting-header-icon' });
    setIcon(headerIcon, 'cloud', 24);
    const headerText = header.createDiv({ cls: 'bdnsync-setting-header-title' });
    headerText.createEl('h2', { text: 'BDNSync' });
    headerText.createEl('p', { text: '百度网盘同步设置' });

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

    // 实验室（实验功能，默认折叠；启用后展开子项）
    const labSection = createSection(containerEl, {
      title: '实验室',
      icon: 'beaker',
      collapsible: true,
      defaultOpen: false,
    });
    this.renderLab(labSection.body);

    // 冲突与删除
    const conflictSection = createSection(containerEl, {
      title: '冲突与删除',
      icon: 'alert-triangle',
    });
    this.renderConflict(conflictSection.body);

    // 同步范围
    const filterSection = createSection(containerEl, { title: '同步范围', icon: 'folder' });
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

    // 高级性能（默认折叠）
    const perfSection = createSection(containerEl, {
      title: '高级性能参数',
      icon: 'activity',
      collapsible: true,
      defaultOpen: false,
    });
    this.renderPerformance(perfSection.body);

    // 设备
    const deviceSection = createSection(containerEl, { title: '本设备', icon: 'smartphone' });
    this.renderDevice(deviceSection.body);
    this.renderSnapshot(deviceSection.body);

    // 日志与诊断
    const logSection = createSection(containerEl, { title: '日志与诊断', icon: 'file-text' });
    this.renderLogConfig(logSection.body);

    // 维护（危险区）
    const maintSection = createSection(containerEl, { title: '维护', icon: 'rotate-ccw' });
    const maintCard = createCard(maintSection.body, 'bdnsync-danger-zone');
    this.renderMaintenance(maintCard);
    this.renderForceSync(maintSection.body);
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
            await this.plugin.saveSettings();
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
            await this.plugin.saveSettings();
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
            await this.plugin.saveSettings();
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
            await this.plugin.saveSettings();
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
    avatar.classList.add(`bdnsync-vip-avatar-${vipTier}`);

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
    const vipBadge = headRow.createSpan({ cls: `bdnsync-vip-badge bdnsync-vip-badge-${vipTier}` });
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
    const tierEl = subRow.createSpan({ cls: `bdnsync-vip-tier bdnsync-vip-tier-${vipTier}` });
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

    // 配额进度条
    const progressHost = info.createDiv({ cls: 'bdnsync-vip-progress' });
    const progressBar = createProgressBar(progressHost);
    const meta = info.createDiv({ cls: 'bdnsync-vip-meta' });
    const metaSize = meta.createSpan({ cls: 'bdnsync-vip-meta-size' });
    const metaPct = meta.createSpan({ cls: 'bdnsync-vip-meta-pct' });

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
        metaSize.setText('存储用量获取失败');
        metaPct.setText('点击下方「刷新用量」重试');
        progressBar.setRatio(0);
        resultEl.setText('未获取配额');
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
          await this.plugin.saveSettings();
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
        await this.plugin.saveSettings();
        this.plugin.restartScheduler();
        this.display();
      });
    }

    if (s.syncMode === 'auto') {
      new Setting(container)
        .setName('自动同步间隔（分钟）')
        .setDesc('无变更时仅拉取索引，几乎不消耗流量；实时同步模式不启用定时轮询')
        .addSlider((sl) => {
          sl.setLimits(1, 60, 1)
            .setValue(s.autoSyncInterval)
            .setDynamicTooltip()
            .onChange(async (v) => {
              s.autoSyncInterval = v;
              await this.plugin.saveSettings();
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
          await this.plugin.saveSettings();
        }),
      );

    new Setting(container)
      .setName('保存时同步')
      .setDesc('文件修改 3 秒后自动上传；大于 10MB 延长至 10 秒')
      .addToggle((t) =>
        t.setValue(s.syncOnSave).onChange(async (v) => {
          s.syncOnSave = v;
          await this.plugin.saveSettings();
        }),
      );
  }

  private renderConflict(container: HTMLElement): void {
    const s = this.plugin.settings;
    new Setting(container)
      .setName('冲突解决策略')
      .setDesc('智能合并会自动合并文本；每次询问则打开冲突面板')
      .addDropdown((d) => {
        d.addOption('smart-merge', '智能合并（推荐）');
        d.addOption('force-local', '强制本地优先');
        d.addOption('force-remote', '强制云端优先');
        d.addOption('always-fork', '始终保留双版本');
        d.addOption('ask-me', '每次询问（冲突面板）');
        d.setValue(s.conflictStrategy);
        d.onChange(async (v) => {
          s.conflictStrategy = v as BDNSyncSettings['conflictStrategy'];
          await this.plugin.saveSettings();
        });
      });

    new Setting(container)
      .setName('删除同步策略')
      .setDesc(
        '一端删除、另一端也删除时，删除会正常同步到云端（已删除的文件不会复活）。仅在「一端删除、另一端同时修改」时才需要裁决：保留修改 = 以对方的新版本为准（不丢对方改动）；到处删除 = 直接删除云端。',
      )
      .addDropdown((d) => {
        d.addOption('keep-modified', '保留修改（更安全，推荐）');
        d.addOption('delete-everywhere', '到处删除');
        d.setValue(s.deleteStrategy);
        d.onChange(async (v) => {
          s.deleteStrategy = v as BDNSyncSettings['deleteStrategy'];
          await this.plugin.saveSettings();
        });
      });

    new Setting(container)
      .setName('覆盖前自动备份')
      .setDesc('同步覆盖本地文件前，先备份到插件目录（最近 100 份）')
      .addToggle((t) =>
        t.setValue(s.autoBackup).onChange(async (v) => {
          s.autoBackup = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(container)
      .setName('批量删除确认阈值')
      .setDesc(
        '单次同步的删除数量达到该值时弹窗确认。0 = 关闭此确认（异常删除检测始终生效：例如云端整棵目录树为空却要删本地文件时，一定会拦下来）',
      )
      .addText((t) => {
        t.inputEl.type = 'number';
        t.setValue(String(s.bulkDeleteConfirm ?? 50));
        t.onChange(async (v) => {
          const n = Number(v);
          s.bulkDeleteConfirm = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 50;
          await this.plugin.saveSettings();
        });
      });
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

    new Setting(container)
      .setName('单文件大小上限（MB）')
      .setDesc('超过此大小的文件不同步')
      .addText((t) => {
        t.setValue(String(s.maxFileSizeMB));
        t.onChange(async (v) => {
          const n = parseInt(v, 10);
          if (!Number.isNaN(n) && n > 0 && n <= 4096) {
            s.maxFileSizeMB = n;
            await this.plugin.saveSettings();
          }
        });
      });

    new Setting(container)
      .setName('跳过隐藏文件')
      .setDesc('跳过以 . 开头的文件与目录')
      .addToggle((t) =>
        t.setValue(s.skipHiddenFiles).onChange(async (v) => {
          s.skipHiddenFiles = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(container)
      .setName('同步 .obsidian 配置目录')
      .setDesc('开启后主题、快捷键、插件配置可跨设备一致')
      .addToggle((t) =>
        t.setValue(s.syncConfigDir).onChange(async (v) => {
          s.syncConfigDir = v;
          await this.plugin.saveSettings();
        }),
      );
  }

  private renderEncryption(container: HTMLElement): void {
    const s = this.plugin.settings;
    new Setting(container)
      .setName('启用端到端加密')
      .setDesc('AES-256-GCM：文件在上传前于本机加密，云端仅存密文。所有设备必须使用同一密码。')
      .addToggle((t) =>
        t.setValue(s.encryptionEnabled).onChange(async (v) => {
          s.encryptionEnabled = v;
          await this.plugin.saveSettings();
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
          await this.plugin.saveSettings();
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
        text: '警告：忘记密码将无法解密云端文件，请妥善保管。密码只保存在本地。算法 AES-256-GCM + PBKDF2-SHA256（100,000 轮），与 rclone crypt / 主流 E2EE 同级。',
      });
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
            await this.plugin.saveSettings();
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
      text: '实验室：实验功能集中入口，每个功能都独立开关。开启主开关后，按需启用下方的子功能。',
    });
    const usageList = usage.createEl('ul', { cls: 'bdnsync-callout-list' });
    usageList.createEl('li', {
      cls: 'bdnsync-callout-text',
      text: 'bdn:// 语法：bdn://<fsId>|<相对路径> 或 bdn://<相对路径>（相对「云端同步目录」）。',
    });
    usageList.createEl('li', {
      cls: 'bdnsync-callout-text',
      text: '快速插入：命令面板运行「BDNSync：插入网盘媒体引用（bdn://）」，按当前笔记路径自动生成引用。',
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
          await this.plugin.saveSettings();
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
      s.cloudMediaMaxInlineMB = 50;
      s.labBacklinksEnabled = false;
      s.labOfflinePinEnabled = false;
      s.labOfflinePinMaxMB = 200;
      s.labHealthEnabled = false;
      s.labHealthWarnThreshold = 80;
      await this.plugin.saveSettings();
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
      text: '在笔记中用 bdn:// 引用百度网盘文件并直接内联渲染，支持图片/视频/音频；PDF/Office 等显示为文件卡片。',
    });

    new Setting(sec.body)
      .setName('启用 MediaBridge')
      .setDesc('关闭后 bdn:// 引用不会自动渲染（仅显示为链接）。')
      .addToggle((t) =>
        t.setValue(on).onChange(async (v) => {
          s.cloudMediaEnabled = v;
          await this.plugin.saveSettings();
          this.refreshLabStatusBadge(sec.header, v);
        }),
      );

    new Setting(sec.body)
      .setName('视频懒加载')
      .setDesc('开启后视频仅在交互时加载（preload=none），降低首屏带宽；关闭则预取元数据。')
      .addToggle((t) =>
        t.setValue(s.cloudMediaLazyLoad).onChange(async (v) => {
          s.cloudMediaLazyLoad = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(sec.body)
      .setName('离线占位符')
      .setDesc('设备离线时显示占位符，网络恢复后自动重新加载；关闭则直接报错占位。')
      .addToggle((t) =>
        t.setValue(s.cloudMediaOfflinePlaceholder).onChange(async (v) => {
          s.cloudMediaOfflinePlaceholder = v;
          await this.plugin.saveSettings();
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
            await this.plugin.saveSettings();
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
      text: '在文件预览 / 网盘浏览器中展示「哪些笔记引用了此网盘文件」，点击可跳回对应笔记并定位行号。索引按 vault 增量重建，存储于插件缓存目录。',
    });

    new Setting(sec.body)
      .setName('启用反向引用')
      .setDesc('开启后在 PreviewView 末尾展示引用当前网盘文件的笔记列表。')
      .addToggle((t) =>
        t.setValue(on).onChange(async (v) => {
          s.labBacklinksEnabled = v;
          await this.plugin.saveSettings();
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
      text: '把 bdn:// 媒体「收藏到本地」：已收藏的文件在离线时可直接渲染（不等网络恢复）；超出容量上限按访问时间清理。',
    });

    new Setting(sec.body)
      .setName('启用离线收藏')
      .setDesc(
        '开启后 bdn:// 媒体加载失败时回退到本地缓存（同时支持手动 pinFile/unpinFile 命令）。',
      )
      .addToggle((t) =>
        t.setValue(on).onChange(async (v) => {
          s.labOfflinePinEnabled = v;
          await this.plugin.saveSettings();
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
            await this.plugin.saveSettings();
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
      text: '每次同步完成后计算一个 0-100 的健康分：综合冲突数 / 大规模删除 / 失败 / 超大传输权重计算。低于阈值时弹提醒，避免半夜同步后问题被忽略。',
    });

    new Setting(sec.body)
      .setName('启用同步健康分')
      .setDesc('关闭则不计算、不提醒。')
      .addToggle((t) =>
        t.setValue(on).onChange(async (v) => {
          s.labHealthEnabled = v;
          await this.plugin.saveSettings();
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
            await this.plugin.saveSettings();
          }),
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
      .setDesc('大文件分片上传的单片大小')
      .addDropdown((d) => {
        d.addOption('4', '4 MB');
        d.addOption('16', '16 MB');
        d.addOption('32', '32 MB');
        d.setValue(String(s.chunkSizeMB));
        d.onChange(async (v) => {
          s.chunkSizeMB = parseInt(v, 10);
          await this.plugin.saveSettings();
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
            await this.plugin.saveSettings();
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
            await this.plugin.saveSettings();
          }),
      );

    new Setting(container)
      .setName('请求间隔（毫秒）')
      .setDesc('内置 QPS 节流，避免触发网盘限流。默认 550')
      .addText((t) => {
        t.setValue(String(s.requestIntervalMs));
        t.onChange(async (v) => {
          const n = parseInt(v, 10);
          if (!Number.isNaN(n) && n >= 200 && n <= 5000) {
            s.requestIntervalMs = n;
            await this.plugin.saveSettings();
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
            await this.plugin.saveSettings();
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
          await this.plugin.saveSettings();
        }),
      );

    new Setting(container)
      .setName('风暴阈值（实时同步）')
      .setDesc(
        '单次批量变更超过该数量时，实时同步降级为一次完整同步以保证一致性。0 = 关闭（大库/批量操作建议设为 200）',
      )
      .addText((t) => {
        t.inputEl.type = 'number';
        t.setValue(String(s.stormThreshold));
        t.onChange(async (v) => {
          const n = parseInt(v, 10);
          if (Number.isInteger(n) && n >= 0) {
            s.stormThreshold = n;
            await this.plugin.saveSettings();
          }
        });
      });

    new Setting(container)
      .setName('脏集合窗口（毫秒）')
      .setDesc(
        '跨窗口 rename 配对的时间窗口：在时间窗口内的「删除+创建」会被合并为一次 move。范围 0–10000，默认 1500',
      )
      .addText((t) => {
        t.inputEl.type = 'number';
        t.setValue(String(s.renameGraceMs));
        t.onChange(async (v) => {
          const n = parseInt(v, 10);
          if (Number.isInteger(n) && n >= 0 && n <= 10000) {
            s.renameGraceMs = n;
            await this.plugin.saveSettings();
          }
        });
      });
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
            await this.plugin.saveSettings();
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
            await this.plugin.saveSettings();
            this.display();
          }),
      );

    new Setting(container)
      .setName('界面主题')
      .setDesc('高对比度模式使用纯黑/纯白与加粗描边，提升弱光或视觉敏感场景的可读性')
      .addDropdown((d) =>
        d
          .addOption('auto', '跟随 Obsidian')
          .addOption('normal', '常规（高可读）')
          .addOption('high-contrast', '高对比度')
          .setValue(s.themeMode)
          .onChange(async (v) => {
            s.themeMode = v as 'auto' | 'normal' | 'high-contrast';
            await this.plugin.saveSettings();
          }),
      );
  }

  /** 整库快照设置（force 方向前自动备份，误删可整库回滚） */
  private renderSnapshot(container: HTMLElement): void {
    const section = createSection(container, { title: '整库快照', icon: 'layers' });
    new Setting(section.body)
      .setName('自动快照')
      .setDesc('强制全量同步（本地/云端覆盖）执行前自动生成整库快照点，误删后可整库回滚')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.autoSnapshot).onChange(async (v) => {
          this.plugin.settings.autoSnapshot = v;
          await this.plugin.saveSettings();
        }),
      );
    new Setting(section.body)
      .setName('保留快照数')
      .setDesc('最多保留的快照点数量，超出后最旧的自动淘汰')
      .addText((t) => {
        t.inputEl.type = 'number';
        t.setValue(String(this.plugin.settings.maxSnapshots));
        t.onChange(async (v) => {
          const n = parseInt(v, 10);
          if (Number.isFinite(n) && n >= 1 && n <= 20) {
            this.plugin.settings.maxSnapshots = n;
            await this.plugin.saveSettings();
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
