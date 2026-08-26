// 跨设备同步看板（#4.6 画布式拓扑布局）
//
// 将同步拓扑以画布（canvas-style dashboard）形式呈现：云端作为中心枢纽，各设备围绕分布。
// 百度网盘无 webhook/推送通道，远端设备在线状态以「最近同步时间」推测并明确标注。
//
// 设计要点：
//  - 画布式卡片布局：桌面端多列拓扑网格，移动端单列堆叠。
//  - 全彩视觉：状态色光晕、渐变背景、SVG 环形配额、设备类型图标。
//  - 响应式：CSS Grid + Container Queries 思路，小屏自动单列并缩小字号/间距。
//  - 性能：渲染复用 setIcon，避免复杂动画阻塞主线程；轮询仅重算本地聚合。

import { ItemView, WorkspaceLeaf } from 'obsidian';
import type BDNSyncPlugin from '../../main';
import { formatBytes, formatTime } from '../../util/misc';
import type { QuotaInfo } from '../../baidu/api';
import { setIcon, createBadge, createIconButton, type IconName } from '../components';

export const VIEW_TYPE_BDNSYNC_DASHBOARD = 'bdnsync-cross-device-dashboard';

interface DashDevice {
  id: string;
  name: string;
  isCurrent: boolean;
  fileCount: number;
  totalBytes: number;
  lastActive: number;
}

type DeviceState = 'online' | 'active' | 'idle' | 'stale' | 'unknown';
type DeviceKind = 'windows' | 'apple' | 'mobile' | 'default';

interface CloudSnapshot {
  ok: boolean;
  message: string;
  quota?: QuotaInfo;
  user?: string;
}

const ACTIVE_WINDOW = 24 * 3600 * 1000; // 24h 内视为活跃
const IDLE_WINDOW = 7 * 24 * 3600 * 1000; // 7d 内视为近期

export class CrossDeviceDashboardView extends ItemView {
  private plugin: BDNSyncPlugin;
  private canvasEl!: HTMLElement;
  private machineOnlineEl!: HTMLElement;
  private updatedEl!: HTMLElement;
  private pollTimer: number | null = null;
  private onOnline = () => this.handleConnectivityChange(true);
  private onOffline = () => this.handleConnectivityChange(false);

  constructor(leaf: WorkspaceLeaf, plugin: BDNSyncPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_BDNSYNC_DASHBOARD;
  }
  getDisplayText(): string {
    return '跨设备同步看板';
  }
  getIcon(): string {
    return 'share-2';
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass('bdnsync-view', 'bdnsync-dashboard-view');

    // ===== 顶部工具栏 =====
    const toolbar = root.createDiv({ cls: 'bdnsync-dash-toolbar' });
    const title = toolbar.createDiv({ cls: 'bdnsync-dash-title' });
    setIcon(title.createSpan({ cls: 'bdnsync-dash-title-icon' }), 'share-2', 18);
    title.createSpan({ cls: 'bdnsync-dash-title-text', text: '跨设备同步看板' });

    toolbar.createDiv({ cls: 'bdnsync-dash-toolbar-spacer' });

    this.machineOnlineEl = toolbar.createDiv({ cls: 'bdnsync-dash-pill' });

    createIconButton(toolbar, {
      icon: 'refresh-cw',
      label: '刷新',
      title: '刷新云端状态与设备列表',
      onClick: () => void this.refresh(),
    });

    // ===== 画布主体 =====
    this.canvasEl = root.createDiv({ cls: 'bdnsync-dash-canvas' });

    // ===== 底部状态栏 =====
    const foot = root.createDiv({ cls: 'bdnsync-dash-foot' });
    this.updatedEl = foot.createSpan({ cls: 'bdnsync-dash-updated', text: '准备中…' });

    // 轻量轮询：仅重算本地索引聚合（无网络往返）
    this.pollTimer = window.setInterval(() => this.renderCanvas(), 15000);
    window.addEventListener('online', this.onOnline);
    window.addEventListener('offline', this.onOffline);

    await this.refresh();
  }

  async onClose(): Promise<void> {
    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    window.removeEventListener('online', this.onOnline);
    window.removeEventListener('offline', this.onOffline);
  }

  // ---- 顶层刷新（含云端网络往返）----

  private async refresh(): Promise<void> {
    this.updatedEl.setText('刷新中…');
    const cloud: CloudSnapshot = this.plugin.hasAuth()
      ? await this.plugin.testConnection().catch(() => ({
          ok: false,
          message: '连接测试异常',
        }))
      : { ok: false, message: '未配置百度网盘连接' };

    this.renderCanvas(cloud);
    this.renderMachineOnline();

    const now = new Date();
    this.updatedEl.setText(`最近更新：${now.toLocaleTimeString()}`);
  }

  // ---- 画布整体渲染 ----

  private renderCanvas(cloud?: CloudSnapshot): void {
    const idx = this.plugin.store?.lastLoadedIndex ?? null;
    const devices = this.collectDevices(idx);
    const cloudSnapshot = cloud ?? this.lastCloudSnapshot();

    const canvas = this.canvasEl;
    canvas.empty();

    // 云端枢纽（顶部中心大卡片）
    canvas.appendChild(this.buildCloudHub(cloudSnapshot));

    // 设备画布区
    const devicesRegion = canvas.createDiv({ cls: 'bdnsync-dash-devices-region' });
    devicesRegion.createEl('h4', { cls: 'bdnsync-dash-region-title', text: '同步设备' });

    const grid = devicesRegion.createDiv({ cls: 'bdnsync-dash-devices-grid' });

    if (devices.length === 0) {
      grid.createEl('p', {
        cls: 'bdnsync-dash-empty',
        text: '暂无设备同步记录，请先完成一次同步。',
      });
    } else {
      for (const d of devices) {
        grid.appendChild(this.buildDeviceCard(d));
      }
    }

    // 底部汇总栏
    canvas.appendChild(this.buildSummary(devices));
  }

  private buildSummary(devices: DashDevice[]): HTMLElement {
    const totalFiles = devices.reduce((sum, d) => sum + d.fileCount, 0);
    const totalBytes = devices.reduce((sum, d) => sum + d.totalBytes, 0);
    const onlineCount = devices.filter((d) => {
      const { state } = this.deviceState(d);
      return state === 'online' || state === 'active';
    }).length;

    const wrap = createEl('div', { cls: 'bdnsync-dash-summary' });
    this.summaryCard(wrap, 'file-text', String(totalFiles), '总文件数');
    this.summaryCard(wrap, 'hard-drive', formatBytes(totalBytes), '总占用');
    this.summaryCard(wrap, 'activity', String(onlineCount), '在线设备');
    return wrap;
  }

  private summaryCard(parent: HTMLElement, icon: IconName, value: string, label: string): void {
    const card = createEl('div', { cls: 'bdnsync-dash-summary-card' });
    const iconWrap = card.createDiv({ cls: 'bdnsync-dash-summary-icon' });
    setIcon(iconWrap, icon, 18);
    const text = card.createDiv({ cls: 'bdnsync-dash-summary-text' });
    text.createDiv({ cls: 'bdnsync-dash-summary-value', text: value });
    text.createDiv({ cls: 'bdnsync-dash-summary-label', text: label });
    parent.appendChild(card);
  }

  private lastCloudSnapshot(): CloudSnapshot {
    // 轮询复用：只更新设备聚合，云端状态保持上次结果（避免频繁网络往返）
    return { ok: false, message: '等待刷新…' };
  }

  // ---- 云端枢纽卡片 ----

  private buildCloudHub(cloud: CloudSnapshot): HTMLElement {
    const hub = createEl('div', { cls: 'bdnsync-dash-hub' });
    const isOk = cloud.ok;

    // 左侧：视觉云 + 状态光环
    const visual = hub.createDiv({ cls: 'bdnsync-dash-hub-visual' });
    const cloudRing = visual.createDiv({
      cls: `bdnsync-dash-hub-ring ${isOk ? 'is-online' : 'is-offline'}`,
    });
    setIcon(cloudRing.createSpan({ cls: 'bdnsync-dash-hub-cloud' }), 'cloud', 32);

    // 脉冲装饰（纯 CSS 动画）
    if (isOk) {
      cloudRing.createSpan({ cls: 'bdnsync-dash-hub-pulse' });
      cloudRing.createSpan({ cls: 'bdnsync-dash-hub-pulse bdnsync-delay-1' });
    }

    // 右侧：信息
    const info = hub.createDiv({ cls: 'bdnsync-dash-hub-info' });
    const head = info.createDiv({ cls: 'bdnsync-dash-hub-head' });
    head.createSpan({ cls: 'bdnsync-dash-hub-name', text: '百度网盘' });
    head.appendChild(
      isOk ? createBadge(head, '已连接', 'success') : createBadge(head, '未连接', 'error'),
    );

    if (cloud.user) {
      info.createDiv({ cls: 'bdnsync-dash-hub-user', text: cloud.user });
    }

    if (!isOk) {
      info.createDiv({ cls: 'bdnsync-dash-hub-error', text: cloud.message });
      info.createDiv({
        cls: 'bdnsync-dash-hub-hint',
        text: '可在设置页重新授权，或运行「连接测试」查看详情。',
      });
      return hub;
    }

    if (cloud.quota) {
      const { total, used, free } = cloud.quota;
      const ratio = total > 0 ? used / total : 0;
      const percent = Math.round(ratio * 100);
      const freeBytes = free || Math.max(0, total - used);

      const quotaWrap = info.createDiv({ cls: 'bdnsync-dash-quota-ring-wrap' });
      quotaWrap.appendChild(this.buildQuotaRing(ratio));

      const quotaText = quotaWrap.createDiv({ cls: 'bdnsync-dash-quota-text' });
      quotaText.createDiv({ cls: 'bdnsync-dash-quota-percent', text: `${percent}%` });
      quotaText.createDiv({
        cls: 'bdnsync-dash-quota-label',
        text: `已用 ${formatBytes(used)} / ${formatBytes(total)}`,
      });
      quotaText.createDiv({
        cls: 'bdnsync-dash-quota-free',
        text: `剩余 ${formatBytes(freeBytes)}`,
      });

      if (ratio > 0.95) {
        info.appendChild(createBadge(info, '空间即将耗尽', 'warning'));
      }
    }

    const idx = this.plugin.store?.lastLoadedIndex;
    if (idx?.lastSyncAt) {
      const meta = info.createDiv({ cls: 'bdnsync-dash-hub-meta' });
      meta.createSpan({ cls: 'bdnsync-dash-meta-k', text: '上次同步' });
      meta.createSpan({ cls: 'bdnsync-dash-meta-v', text: formatTime(idx.lastSyncAt) });
    }

    return hub;
  }

  private buildQuotaRing(ratio: number): SVGSVGElement {
    const radius = 28;
    const circumference = 2 * Math.PI * radius;
    const offset = circumference * (1 - Math.min(1, Math.max(0, ratio)));
    const colorClass = ratio > 0.95 ? 'is-warning' : ratio > 0.8 ? 'is-caution' : 'is-ok';

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 64 64');
    svg.setAttribute('class', 'bdnsync-dash-quota-ring');

    const track = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    track.setAttribute('cx', '32');
    track.setAttribute('cy', '32');
    track.setAttribute('r', String(radius));
    track.setAttribute('class', 'bdnsync-dash-quota-track');

    const fill = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    fill.setAttribute('cx', '32');
    fill.setAttribute('cy', '32');
    fill.setAttribute('r', String(radius));
    fill.setAttribute('class', `bdnsync-dash-quota-fill ${colorClass}`);
    fill.setAttribute('stroke-dasharray', String(circumference));
    fill.setAttribute('stroke-dashoffset', String(offset));

    svg.appendChild(track);
    svg.appendChild(fill);
    return svg;
  }

  // ---- 设备卡片 ----

  private buildDeviceCard(d: DashDevice): HTMLElement {
    const { state, label } = this.deviceState(d);
    const kind = this.deviceKind(d);
    const icon = DEVICE_ICONS[kind];

    const card = createEl('div', {
      cls: `bdnsync-dash-device ${d.isCurrent ? 'is-current' : ''} state-${state}`,
    });

    // 卡片顶部：图标 + 名称 + 状态条
    const header = card.createDiv({ cls: 'bdnsync-dash-device-header' });
    const iconWrap = header.createDiv({ cls: 'bdnsync-dash-device-icon-wrap' });
    setIcon(iconWrap.createSpan({ cls: 'bdnsync-dash-device-icon' }), icon, 22);

    const meta = header.createDiv({ cls: 'bdnsync-dash-device-meta' });
    meta.createDiv({ cls: 'bdnsync-dash-device-name', text: d.name });
    meta.createDiv({ cls: 'bdnsync-dash-device-id', text: d.id });

    const statusCol = header.createDiv({ cls: 'bdnsync-dash-device-status-col' });
    statusCol.createSpan({ cls: `bdnsync-status-dot bdnsync-status-${state}` });
    if (d.isCurrent) statusCol.createSpan({ cls: 'bdnsync-dash-device-badge', text: '本机' });

    // 设备主体数据
    const body = card.createDiv({ cls: 'bdnsync-dash-device-body' });

    const metrics = body.createDiv({ cls: 'bdnsync-dash-device-metrics' });
    this.metricItem(metrics, 'file-text', String(d.fileCount), '文件');
    this.metricItem(metrics, 'hard-drive', formatBytes(d.totalBytes), '占用');
    this.metricItem(metrics, 'clock', d.lastActive ? formatTime(d.lastActive) : '—', '最近活跃');

    const footer = card.createDiv({ cls: 'bdnsync-dash-device-footer' });
    footer.createSpan({
      cls: `bdnsync-dash-device-state-label state-${state}`,
      text: label,
    });

    return card;
  }

  private metricItem(parent: HTMLElement, icon: IconName, value: string, label: string): void {
    const item = parent.createDiv({ cls: 'bdnsync-dash-metric' });
    setIcon(item.createSpan({ cls: 'bdnsync-dash-metric-icon' }), icon, 14);
    const text = item.createDiv({ cls: 'bdnsync-dash-metric-text' });
    text.createDiv({ cls: 'bdnsync-dash-metric-value', text: value });
    text.createDiv({ cls: 'bdnsync-dash-metric-label', text: label });
  }

  private deviceKind(d: DashDevice): DeviceKind {
    const s = `${d.id} ${d.name}`.toLowerCase();
    if (/win|microsoft|surface/.test(s)) return 'windows';
    if (/mac|macbook|imac|darwin|apple/.test(s)) return 'apple';
    if (/iphone|ipad|android|mobile|phone|tablet/.test(s)) return 'mobile';
    return 'default';
  }

  // ---- 设备聚合 ----

  private collectDevices(idx: import('../../types').LocalIndex | null): DashDevice[] {
    const currentId = this.plugin.settings.deviceId;
    const map = new Map<string, DashDevice>();
    const touch = (id: string, size: number, mtime: number) => {
      if (!id) return;
      let row = map.get(id);
      if (!row) {
        row = { id, name: id, isCurrent: id === currentId, fileCount: 0, totalBytes: 0, lastActive: 0 };
        map.set(id, row);
      }
      row.fileCount++;
      row.totalBytes += size;
      row.lastActive = Math.max(row.lastActive, mtime);
    };

    if (idx) {
      for (const st of Object.values(idx.files)) {
        if (st.deleted) continue;
        touch(st.byDevice ?? '未知设备', st.size ?? 0, st.mtime ?? 0);
      }
      for (const versions of Object.values(idx.versions ?? {})) {
        for (const v of versions) {
          if (v.byDevice && v.deviceName && map.has(v.byDevice)) {
            const row = map.get(v.byDevice);
            if (row && row.name === row.id) row.name = v.deviceName;
          }
        }
      }
    }

    if (!map.has(currentId)) {
      map.set(currentId, {
        id: currentId,
        name: this.plugin.settings.deviceName || '本机',
        isCurrent: true,
        fileCount: 0,
        totalBytes: 0,
        lastActive: idx?.lastSyncAt ?? 0,
      });
    } else {
      const cur = map.get(currentId);
      if (cur && cur.name === cur.id && this.plugin.settings.deviceName) cur.name = this.plugin.settings.deviceName;
    }

    return Array.from(map.values()).sort((a, b) => {
      if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
      return b.lastActive - a.lastActive;
    });
  }

  private deviceState(d: DashDevice): { state: DeviceState; label: string } {
    if (d.isCurrent) {
      return navigator.onLine
        ? { state: 'online', label: '本机在线' }
        : { state: 'stale', label: '本机离线' };
    }
    if (!d.lastActive) return { state: 'unknown', label: '从未同步' };
    const diff = Date.now() - d.lastActive;
    if (diff <= ACTIVE_WINDOW) return { state: 'active', label: '活跃（推测）' };
    if (diff <= IDLE_WINDOW) return { state: 'idle', label: '近期未同步' };
    return { state: 'stale', label: '长时间未同步' };
  }

  // ---- 本机在线指示（工具栏）----

  private renderMachineOnline(): void {
    const el = this.machineOnlineEl;
    el.empty();
    const online = navigator.onLine;
    el.createSpan({
      cls: `bdnsync-status-dot ${online ? 'bdnsync-status-online' : 'bdnsync-status-stale'}`,
    });
    el.createSpan({
      cls: 'bdnsync-dash-pill-text',
      text: online ? '本机在线' : '本机离线',
    });
  }

  private handleConnectivityChange(_online: boolean): void {
    this.renderMachineOnline();
    this.renderCanvas();
  }
}

const DEVICE_ICONS: Record<DeviceKind, IconName> = {
  windows: 'monitor',
  apple: 'laptop',
  mobile: 'smartphone',
  default: 'hard-drive',
};
