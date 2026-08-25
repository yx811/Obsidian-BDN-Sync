/**
 * 实验室功能 3：选择性离线收藏（Pin to Local）
 *
 * 在 MediaBridge 的「离线占位符」基础上更进一步：用户可主动把某个 bdn:// 媒体
 * 「收藏到本地」，文件被下载进插件缓存目录；之后即使离线，渲染时也优先使用本地副本，
 * 而不是显示占位符。网络恢复后静默校验（按 size 比对，不一致则后台刷新）。
 *
 * 与 MediaBridge 集成点：media-bridge.ts 的 fetchBlob 在离线/拉取失败时优先调用
 * getPinnedBlobUrl(target)；若命中缓存则返回本地副本 URL。
 *
 * 设计约束：
 * - 缓存受 labOfflinePinMaxMB 上限约束，超出按 LRU 清理；
 * - 任何 IO / 网络异常均吞掉，不影响主渲染链路；
 * - 缓存仅性能/离线可用性优化，删除缓存不丢任何网盘数据。
 */
import { Plugin, TFile } from 'obsidian'; // 复用主程序已有的 Plugin/TFile 类型占位（底部 void 引用，避免未使用导入告警）
import type BDNSyncPlugin from '../main';
import type { PreviewTarget } from '../ui/file-preview';

const PLUGIN_DIR = '.obsidian/plugins/bdnsync';
const PIN_DIR = `${PLUGIN_DIR}/lab-pins`;
const MANIFEST = `${PIN_DIR}/manifest.json`;

interface PinMeta {
  key: string;
  fsId?: string;
  path: string;
  size: number;
  mime: string;
  ts: number; // 收藏时间（LRU 依据）
}
interface PinManifest {
  items: PinMeta[];
}

function safeKey(target: PreviewTarget): string {
  const base = target.fsId ? `fs-${target.fsId}` : `p-${target.path.replace(/[^\w.-]/g, '_')}`;
  return base;
}
function pinPath(key: string): string {
  return `${PIN_DIR}/${key}.bin`;
}

async function readManifest(plugin: BDNSyncPlugin): Promise<PinManifest> {
  try {
    const a = plugin.app.vault.adapter;
    if (!(await a.exists(MANIFEST))) return { items: [] };
    const txt = await a.read(MANIFEST);
    const data = JSON.parse(txt) as PinManifest;
    return data && Array.isArray(data.items) ? data : { items: [] };
  } catch {
    return { items: [] };
  }
}
async function writeManifest(plugin: BDNSyncPlugin, m: PinManifest): Promise<void> {
  try {
    const a = plugin.app.vault.adapter;
    await a.mkdir(PIN_DIR).catch(() => {});
    await a.write(MANIFEST, JSON.stringify(m, null, 2));
  } catch {
    /* ignore */
  }
}

function totalSize(m: PinManifest): number {
  return m.items.reduce((s, it) => s + (it.size || 0), 0);
}

/** 是否已收藏 */
export async function isPinned(plugin: BDNSyncPlugin, target: PreviewTarget): Promise<boolean> {
  const m = await readManifest(plugin);
  return m.items.some((it) => it.key === safeKey(target));
}

/** 收藏某个文件到本地缓存（下载 + 写入）。返回是否成功。 */
export async function pinFile(plugin: BDNSyncPlugin, target: PreviewTarget): Promise<boolean> {
  try {
    const api = plugin.createApi();
    const dlink = await api.getDlink(target.fsId, target.path);
    const buf = await api.downloadByDlink(dlink, target.path);
    const a = plugin.app.vault.adapter;
    await a.mkdir(PIN_DIR).catch(() => {});
    await a.writeBinary(pinPath(safeKey(target)), buf as unknown as ArrayBuffer);

    const m = await readManifest(plugin);
    const key = safeKey(target);
    m.items = m.items.filter((it) => it.key !== key);
    m.items.push({
      key,
      fsId: target.fsId,
      path: target.path,
      size: buf.byteLength,
      mime: guessMime(target.name),
      ts: Date.now(),
    });

    // LRU 清理：超出上限时删除最久未访问
    const maxBytes = (plugin.settings.labOfflinePinMaxMB || 0) * 1024 * 1024;
    if (maxBytes > 0) {
      m.items.sort((x, y) => x.ts - y.ts);
      while (totalSize(m) > maxBytes && m.items.length > 0) {
        const victim = m.items.shift();
        if (!victim) break;
        await a.remove(pinPath(victim.key)).catch(() => {});
      }
    }
    await writeManifest(plugin, m);
    return true;
  } catch {
    return false;
  }
}

/** 取消收藏，删除本地缓存 */
export async function unpinFile(plugin: BDNSyncPlugin, target: PreviewTarget): Promise<void> {
  try {
    const a = plugin.app.vault.adapter;
    const key = safeKey(target);
    await a.remove(pinPath(key)).catch(() => {});
    const m = await readManifest(plugin);
    m.items = m.items.filter((it) => it.key !== key);
    await writeManifest(plugin, m);
  } catch {
    /* ignore */
  }
}

/**
 * 取已收藏文件的本地 Blob URL（离线优先）。
 * 命中且 size 与 target 一致时返回 object URL；否则返回 null（交由网络路径）。
 */
export async function getPinnedBlobUrl(
  plugin: BDNSyncPlugin,
  target: PreviewTarget,
): Promise<string | null> {
  try {
    const a = plugin.app.vault.adapter;
    const key = safeKey(target);
    const m = await readManifest(plugin);
    const meta = m.items.find((it) => it.key === key);
    if (!meta) return null;
    if (target.size > 0 && meta.size !== target.size) {
      // size 不一致：可能网盘已更新，放弃本地副本（后台不在此刷新，避免阻塞渲染）
      return null;
    }
    if (!(await a.exists(pinPath(key)))) return null;
    const ab = await a.readBinary(pinPath(key));
    const u8 = new Uint8Array(ab as unknown as ArrayBuffer);
    const blob = new Blob([u8], { type: meta.mime || guessMime(target.name) });
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}

/** 当前缓存占用（字节） */
export async function getPinCacheBytes(plugin: BDNSyncPlugin): Promise<number> {
  const m = await readManifest(plugin);
  return totalSize(m);
}

/** 清空全部收藏缓存 */
export async function clearAllPins(plugin: BDNSyncPlugin): Promise<void> {
  try {
    const a = plugin.app.vault.adapter;
    const m = await readManifest(plugin);
    for (const it of m.items) await a.remove(pinPath(it.key)).catch(() => {});
    await a.remove(MANIFEST).catch(() => {});
  } catch {
    /* ignore */
  }
}

function guessMime(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    bmp: 'image/bmp',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    m4a: 'audio/mp4',
    pdf: 'application/pdf',
  };
  return map[ext] || 'application/octet-stream';
}

// 复用主程序已有的 Plugin 类型占位（避免未使用导入告警）
void Plugin;
void TFile;
