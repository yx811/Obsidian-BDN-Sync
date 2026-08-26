// 媒体播放器（完整复刻参考代码 svp 的 Ki 类，并支持挂载到任意容器）。
//
// 参考代码 Ki 是一个功能完整的自定义播放器，而非浏览器原生 controls：
//   - 自定义进度条（seek 缓冲条 / 已播放条 / 可拖动 range / hover 时间气泡）
//   - 播放/暂停、快退 10s、快进 10s、静音、音量条
//   - 倍速菜单（0.5x ~ 2x）、画质（显示）菜单、画中画、循环、锁定比例、尺寸适配
//   - 全屏、键盘快捷键（空格/方向键/f/m/p/,. 等）
//   - 加载转圈、缓冲 wait、错误兜底提示
//
// 挂载逻辑完全对齐参考的 on() 函数：
//   若本地 StreamServer 已运行 → 直接用 streamUrl（免下载、边下边播）；
//   否则整文件下载到内存 → Blob URL。
//
// 容器自适应：在 ItemView（leaf 内）挂载时，整个 stage 占满 host 可用空间，
// 视频/音频使用 width:100% height:100% object-fit:contain，随窗口变化自动跟随。

import { Notice } from 'obsidian';
import type BDNSyncPlugin from '../main';
import { formatBytes } from '../util/misc';
import { setIcon, type IconName } from './components';
import {
  streamUrlFor,
  downloadToVault,
  getExt,
  type PreviewTarget,
  fetchBytes,
} from './file-preview';

// ---- 播放列表 / 循环模式 / 字幕 相关类型 ----
export type RepeatMode = 'off' | 'list' | 'one' | 'shuffle';
export interface MediaPlayerOptions {
  /** 上一首/下一首：dir=1 下一首，-1 上一首；mode 为当前循环模式（供续播决策） */
  onAdvance?: (dir: 1 | -1, mode: RepeatMode) => void;
  /** 当前循环模式（用于初始显示） */
  repeatMode?: RepeatMode;
  /** 集数标签，如「第 3 / 12 集」 */
  playlistLabel?: string;
  /** 是否有上一首/下一首（决定按钮禁用态） */
  hasPrev?: boolean;
  hasNext?: boolean;
  /** 字幕文件列表（同名 srt/vtt），由预览层预查后传入；为空则不显示字幕按钮 */
  subtitles?: { name: string; fsId: string; path: string }[];
}

// ---- 对齐参考的 dn() 时间格式化 ----
function fmtTime(c: number): string {
  if (!isFinite(c) || c < 0) c = 0;
  const i = Math.floor(c % 60);
  const t = Math.floor(c / 60) % 60;
  const e = Math.floor(c / 3600);
  const s = (n: number) => String(n).padStart(2, '0');
  return e > 0 ? `${e}:${s(t)}:${s(i)}` : `${t}:${s(i)}`;
}

// ---- 对齐参考的 mo() mime ----
function mimeFor(ext: string): string {
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
    avif: 'image/avif',
    ico: 'image/x-icon',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    mkv: 'video/x-matroska',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    flac: 'audio/flac',
    aac: 'audio/aac',
    ogg: 'audio/ogg',
    m4a: 'audio/mp4',
  };
  return map[ext] || 'application/octet-stream';
}

/** 播放器控制句柄（用于主动销毁；如 unmount） */
export interface MediaPlayerHandle {
  destroy(): void;
}

/**
 * 把完整的媒体播放器挂载到任意 host 元素。容器使用 flex 100% 布局，
 * 视频/音频自然跟随容器大小变化（不需要 Modal 那种手动 fitToStage）。
 */
export function mountMediaPlayer(
  host: HTMLElement,
  plugin: BDNSyncPlugin,
  t: PreviewTarget,
  mode: 'video' | 'audio',
  opts: MediaPlayerOptions = {},
): MediaPlayerHandle {
  const urls: string[] = [];
  const icon: IconName = mode === 'video' ? 'film' : 'music';

  // 播放进度记忆：按 fsId+path 存 localStorage，重开同一文件恢复
  const progressKey = `bdnsync:progress:${t.fsId}:${t.path}`;
  const loadSavedTime = (): number => {
    try {
      const raw = localStorage.getItem(progressKey);
      if (!raw) return 0;
      const v = Number(raw);
      return isFinite(v) && v > 0 ? v : 0;
    } catch {
      return 0;
    }
  };
  const saveTime = (sec: number) => {
    try {
      if (sec > 1) localStorage.setItem(progressKey, String(Math.floor(sec)));
    } catch {
      /* ignore */
    }
  };

  host.empty();
  host.addClass('bdnsync-media-player-host');

  // 顶部 bar：文件名 + 操作
  const bar = host.createDiv({ cls: 'bdnsync-media-bar' });
  const info = bar.createDiv({ cls: 'bdnsync-media-bar-info' });
  info.createSpan({ cls: 'bdnsync-media-bar-name', text: t.name });
  info.createSpan({
    cls: 'bdnsync-media-bar-sub',
    text: `${formatBytes(t.size)}${t.mtime ? ' · ' + new Date(t.mtime).toLocaleString() : ''}`,
  });
  // 会员等级标签（异步获取，根据百度 vip_type 着色：SVIP 金 / VIP 蓝 / 普通 灰）
  const vipTag = bar.createDiv({ cls: 'bdnsync-media-vip-tag', text: '账号' });
  void (async () => {
    try {
      const ui = await plugin.createApi().getUserInfo();
      vipTag.textContent = ui.vipLabel;
      vipTag.classList.add(
        ui.vipType === 2 ? 'is-svip' : ui.vipType === 1 ? 'is-vip' : 'is-normal',
      );
    } catch {
      vipTag.textContent = '账号';
    }
  })();
  const act = bar.createDiv({ cls: 'bdnsync-media-bar-actions' });
  const dlBtn = act.createEl('button', {
    cls: 'bdnsync-btn bdnsync-btn-sm bdnsync-btn-primary',
    attr: { title: '下载到仓库' },
  });
  setIcon(dlBtn, 'arrow-down', 14);
  const fsBtn = act.createEl('button', {
    cls: 'bdnsync-btn bdnsync-btn-sm',
    attr: { title: '全屏' },
  });
  setIcon(fsBtn, 'maximize-2', 14);

  // stage：占满 host 剩余空间（flex:1 min-height:0），视频/音频 stage 内宽高 100%
  const stage = host.createDiv({ cls: `bdnsync-media-stage bdnsync-media-stage-${mode}` });
  stage.tabIndex = 0;

  const spinner = stage.createDiv({ cls: 'bdnsync-media-spinner' });

  if (mode === 'audio') {
    const art = stage.createDiv({ cls: 'bdnsync-media-audio-art' });
    setIcon(art, 'music', 64);
    stage.createDiv({ cls: 'bdnsync-media-audio-name', text: t.name });
  }

  // 控制条（按功能分组：左 = 上一首/播放/下一首；中 = 快退/快进 + 时间 + 进度条；右 = 音量/倍速/菜单/字幕/循环/PiP/比例）
  const ctrl = host.createDiv({ cls: 'bdnsync-media-controls' });

  // —— 左：上一首 / 圆形主播放按钮 / 下一首 ——
  const prevBtn = ctrl.createEl('button', {
    cls: 'bdnsync-media-ctrl-btn bdnsync-media-prev',
    attr: { title: '上一首 (Ctrl+←)' },
  });
  setIcon(prevBtn, 'skip-back', 18);
  const playBtn = ctrl.createEl('button', {
    cls: 'bdnsync-media-ctrl-btn bdnsync-media-play',
    attr: { title: '播放/暂停 (空格)' },
  });
  setIcon(playBtn, 'circle-play', 20);
  const nextBtn = ctrl.createEl('button', {
    cls: 'bdnsync-media-ctrl-btn bdnsync-media-next',
    attr: { title: '下一首 (Ctrl+→)' },
  });
  setIcon(nextBtn, 'skip-forward', 18);

  // 分组分隔（细线）
  ctrl.createDiv({ cls: 'bdnsync-media-sep' });

  // —— 中左：快退 10s / 快进 10s（双三角箭头，比 rotate-ccw/cw 更不易误解为「撤销/重做」）/ 集数标签 ——
  const backBtn = ctrl.createEl('button', {
    cls: 'bdnsync-media-ctrl-btn',
    attr: { title: '快退 10 秒 (←)' },
  });
  setIcon(backBtn, 'rewind', 18);
  const fwdBtn = ctrl.createEl('button', {
    cls: 'bdnsync-media-ctrl-btn',
    attr: { title: '快进 10 秒 (→)' },
  });
  setIcon(fwdBtn, 'fast-forward', 18);
  // 集数标签（如「第 3 / 12 集」）：直接挂到 ctrl 上，不需要持有引用
  if (opts.playlistLabel) {
    ctrl.createDiv({ cls: 'bdnsync-media-playlist-label', text: opts.playlistLabel });
  }

  // —— 中间：当前时间 / 自定义进度条（轨道 + 缓冲条 + 已播条 + 拖拽圆点 + 悬停/拖拽气泡）/ 总时长 ——
  const curTimeEl = ctrl.createDiv({ cls: 'bdnsync-media-time', text: '0:00' });
  const seek = ctrl.createDiv({ cls: 'bdnsync-media-seek' });
  const seekTrack = seek.createDiv({ cls: 'bdnsync-media-seek-track' });
  const seekBuf = seekTrack.createDiv({ cls: 'bdnsync-media-seek-buf' });
  const seekPlay = seekTrack.createDiv({ cls: 'bdnsync-media-seek-play' });
  const seekThumb = seekTrack.createDiv({ cls: 'bdnsync-media-seek-thumb' });
  // 悬停小气泡（仅在鼠标悬停于进度条上时显示，修复：移出后立即隐藏）
  const seekHoverTip = seek.createDiv({ cls: 'bdnsync-media-seek-hover-tip' });
  // 拖拽大气泡（仅在拖拽时显示，松手立即隐藏）
  const seekDragTip = seek.createDiv({ cls: 'bdnsync-media-seek-drag-tip' });
  const durTimeEl = ctrl.createDiv({ cls: 'bdnsync-media-time', text: '0:00' });

  ctrl.createDiv({ cls: 'bdnsync-media-sep' });

  // —— 右：音量 / 倍速 / 倍速+画质菜单 / 字幕 / 循环 / PiP / 比例 ——
  const vol = ctrl.createDiv({ cls: 'bdnsync-media-vol' });
  const volBtn = vol.createEl('button', {
    cls: 'bdnsync-media-ctrl-btn bdnsync-media-vol-btn',
    attr: { title: '静音 (m)' },
  });
  setIcon(volBtn, 'volume-2', 18);
  const volRange = vol.createEl('input', {
    cls: 'bdnsync-media-vol-range',
    type: 'range',
    attr: { min: '0', max: '100', step: '1', value: '100' },
  });
  const speedBtn = ctrl.createEl('button', {
    cls: 'bdnsync-media-speed',
    attr: { title: '播放速度' },
    text: '1x',
  });
  const menuBtn = ctrl.createEl('button', {
    cls: 'bdnsync-media-ctrl-btn bdnsync-media-menu',
    attr: { title: '画质与倍速' },
  });
  setIcon(menuBtn, 'sliders-horizontal', 18);
  // 字幕按钮：视频模式常驻（自动找到同名词幕后启用）
  const subtitleBtn =
    mode === 'video'
      ? ctrl.createEl('button', {
          cls: 'bdnsync-media-ctrl-btn bdnsync-media-subtitle',
          attr: { title: '字幕' },
        })
      : null;
  if (subtitleBtn) {
    setIcon(subtitleBtn, 'subtitles', 18);
    const hasSubs = !!(opts.subtitles && opts.subtitles.length);
    subtitleBtn.toggleAttribute('disabled', !hasSubs);
    if (!hasSubs) subtitleBtn.style.display = 'none';
  }
  // 循环模式（off/list/one/shuffle）
  const repeatBtn = ctrl.createEl('button', {
    cls: 'bdnsync-media-ctrl-btn bdnsync-media-repeat',
    attr: { title: '循环：关' },
  });
  setIcon(repeatBtn, 'repeat', 18);
  // 画中画
  const pipBtn = ctrl.createEl('button', {
    cls: 'bdnsync-media-ctrl-btn bdnsync-media-pip',
    attr: { title: '画中画 (p)' },
  });
  setIcon(pipBtn, 'picture-in-picture-2', 18);
  // 画面比例（用 aspect-ratio 图标替代「⊡」字符）
  const ratioBtn = ctrl.createEl('button', {
    cls: 'bdnsync-media-ctrl-btn bdnsync-media-ratio',
    attr: { title: '锁定/解除画面比例' },
  });
  setIcon(ratioBtn, 'aspect-ratio', 18);

  // 媒体元素
  const el: HTMLVideoElement | HTMLAudioElement =
    mode === 'video' ? document.createElement('video') : document.createElement('audio');
  if (mode === 'video') {
    el.className = 'bdnsync-media-embed';
    el.setAttribute('playsinline', '');
    stage.insertBefore(el, spinner);
  }
  el.preload = 'metadata';

  // 倍速 / 音量 记忆（跨文件通用）
  const SPEED_KEY = 'bdnsync:media:speed';
  const VOL_KEY = 'bdnsync:media:volume';
  const MUTE_KEY = 'bdnsync:media:muted';
  const memGetNum = (k: string, d: number): number => {
    try {
      const v = localStorage.getItem(k);
      return v == null ? d : Number(v);
    } catch {
      return d;
    }
  };
  const memSetNum = (k: string, v: number): void => {
    try {
      localStorage.setItem(k, String(v));
    } catch {
      /* ignore */
    }
  };
  const memGetBool = (k: string, d: boolean): boolean => {
    try {
      const v = localStorage.getItem(k);
      return v == null ? d : v === '1';
    } catch {
      return d;
    }
  };
  const memSetBool = (k: string, v: boolean): void => {
    try {
      localStorage.setItem(k, v ? '1' : '0');
    } catch {
      /* ignore */
    }
  };

  const speeds = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  let speedIdx = 2;
  // 循环模式（playlist）：off/list/one/shuffle，由本播放器维护 UI 状态
  let repeatMode: RepeatMode = opts.repeatMode ?? 'off';
  const repeatCycle: RepeatMode[] = ['off', 'list', 'one', 'shuffle'];
  const repeatIcon: Record<RepeatMode, IconName> = {
    off: 'repeat',
    list: 'repeat',
    one: 'repeat-1',
    shuffle: 'shuffle',
  };
  const repeatTitle: Record<RepeatMode, string> = {
    off: '循环：关',
    list: '列表循环',
    one: '单曲循环',
    shuffle: '随机播放',
  };
  function updateRepeatBtn(): void {
    setIcon(repeatBtn, repeatIcon[repeatMode], 18);
    repeatBtn.setAttr('title', repeatTitle[repeatMode]);
    repeatBtn.classList.toggle('bdnsync-media-active', repeatMode !== 'off');
  }
  updateRepeatBtn();
  // 字幕轨道（加载后挂到 video）
  const subtitleTracks: { label: string; track: TextTrack }[] = [];
  let activeSubtitle = -1; // -1 = 关闭
  // 清晰度上限：根据百度网盘会员等级（vip_type）决定可解锁的最高清晰度。
  // 直链下载本身是原画，但普通用户/会员在百度在线播放有转码限速/降分辨率，
  // 这里据此给出默认上限建议：SVIP 不限制（原画/4K），会员 1080P，普通用户 720P。
  // 用户仍可手动选更高档（直链物理支持），仅作为首选项与标签提示。
  let vipMaxHeight: number | null = null; // null = 不限制
  let qualityCap: number | null = null;
  const qualityOptions: { label: string; h: number | null; locked?: boolean }[] = [
    { label: '原画', h: null },
  ];
  let popEl: HTMLElement | null = null;
  const scaleFactor = 1;
  let fitAspect = true;

  const onFsChange = () => {
    const fs = !!document.fullscreenElement;
    setIcon(fsBtn, fs ? 'minimize-2' : 'maximize-2', 14);
    fsBtn.setAttr('title', fs ? '退出全屏 (Esc)' : '全屏');
    if (fs) scheduleHideUi();
    else showUi();
  };

  const hideSpinner = () => {
    spinner.style.display = 'none';
  };

  // 应用记忆的倍速 / 音量（跨文件持久）
  const savedSpeed = memGetNum(SPEED_KEY, 1);
  if (savedSpeed > 0) {
    el.playbackRate = savedSpeed;
    speedIdx = Math.max(0, speeds.indexOf(savedSpeed));
    if (speedIdx < 0) speedIdx = 2;
    speedBtn.textContent = `${speeds[speedIdx]}x`;
  }
  const savedVol = memGetNum(VOL_KEY, 100);
  el.volume = Math.min(1, Math.max(0, savedVol / 100));
  el.muted = memGetBool(MUTE_KEY, false);
  el.addEventListener('loadedmetadata', () => {
    hideSpinner();
    durTimeEl.textContent = fmtTime(el.duration);
    // 恢复上次播放进度（若接近结尾则从头开始，避免「看完却停在最后」）
    const saved = loadSavedTime();
    if (saved > 0 && saved < (el.duration || Infinity) - 2) {
      el.currentTime = saved;
      updateProgress();
    }
    // 解析会员等级 → 设定清晰度默认上限（SVIP 不限 / 会员 1080P / 普通 720P）
    void (async () => {
      try {
        const ui = await plugin.createApi().getUserInfo();
        vipMaxHeight = ui.vipType === 2 ? null : ui.vipType === 1 ? 1080 : 720;
      } catch {
        vipMaxHeight = 720;
      }
      refreshQualityOptions();
      // 切档重载后 loadedmetadata 才会再次触发，此时再探一次
      probeActualQuality();
    })();
    // 自动查找并加载同名词幕
    void findSubtitles();
    fitToStage();
  });
  el.addEventListener('waiting', () => {
    spinner.style.display = '';
  });
  el.addEventListener('playing', hideSpinner);
  el.addEventListener('canplay', hideSpinner);
  el.addEventListener('play', () => setIcon(playBtn, 'circle-pause', 20));
  el.addEventListener('pause', () => setIcon(playBtn, 'circle-play', 20));
  el.addEventListener('timeupdate', () => {
    updateProgress();
    saveTime(el.currentTime);
  });
  el.addEventListener('ended', () => {
    saveTime(0);
    try {
      localStorage.removeItem(progressKey);
    } catch {
      /* ignore */
    }
    if (repeatMode === 'one') {
      el.currentTime = 0;
      void el.play().catch(() => {
        /* ignore */
      });
      return;
    }
    opts.onAdvance?.(1, repeatMode);
  });
  el.addEventListener('progress', () => updateBuffered());
  el.addEventListener('volumechange', () => {
    volRange.value = String(Math.round(el.volume * 100));
    // 三档音量图标：muted/volume-0 → volume-x；1~49 → volume-1；≥50 → volume-2
    let volIcon: IconName;
    if (el.muted || el.volume === 0) volIcon = 'volume-x';
    else if (el.volume < 0.5) volIcon = 'volume-1';
    else volIcon = 'volume-2';
    setIcon(volBtn, volIcon, 18);
    memSetNum(VOL_KEY, Math.round(el.volume * 100));
    memSetBool(MUTE_KEY, el.muted);
  });
  el.addEventListener('error', () => {
    hideSpinner();
    stage.createDiv({
      cls: 'bdnsync-empty bdnsync-danger-text',
      text: '媒体加载失败，请改用「下载到仓库」后本地播放。',
    });
  });

  const loadSrc = (url: string) => {
    el.src = url;
    el.load();
  };

  /**
   * 按指定清晰度档重新加载视频流。
   *
   * 把当前播放进度、播放状态保留；切档完成后若原本是暂停则保持暂停。
   *
   * 关键：调用 streamUrlFor(plugin, t, quality)，让 StreamServer 用
   * getMediaPlayOptions 按 VIP 等级枚举的多档 URL 选具体一档，
   * 而不再固定返回 dlink（dlink 在某些开放平台账号下会被转码成 720P）。
   */
  let pendingQuality = 'auto';
  function applyQuality(quality: string): void {
    pendingQuality = quality || 'auto';
    const wasT = el.currentTime;
    const wasP = !el.paused;
    const srv = plugin.getStreamServer();
    if (!srv || !srv.isRunning) {
      // StreamServer 未启动：回退到 fetchBytes 整文件下到内存
      void (async () => {
        try {
          // 释放旧 blob
          for (const u of urls)
            try {
              URL.revokeObjectURL(u);
            } catch {
              /* ignore */
            }
          urls.length = 0;
          const bytes = await fetchBytes(plugin, t);
          const blob = new Blob([bytes as unknown as ArrayBufferView], {
            type: mimeFor(getExt(t.name)),
          });
          const u = URL.createObjectURL(blob);
          urls.push(u);
          loadSrc(u);
        } catch (e) {
          new Notice(`BDNSync：加载失败 — ${e instanceof Error ? e.message : String(e)}`);
        }
      })();
      return;
    }
    // 已有流式 URL，直接在播放器层切 src 即可
    const next = srv.buildStreamUrl(t, pendingQuality);
    if (!next) {
      new Notice('BDNSync：流式代理未就绪');
      return;
    }
    loadSrc(next);
    // loadedmetadata 后恢复进度
    const onReady = () => {
      el.removeEventListener('loadedmetadata', onReady);
      if (wasT > 0 && wasT < (el.duration || Infinity)) el.currentTime = wasT;
      if (!wasP) el.pause();
      updateProgress();
    };
    el.addEventListener('loadedmetadata', onReady);
  }

  // ---- 字幕解析与加载（srt/vtt 自动识别，ass/ssa 暂不支持） ----
  function parseTs(s: string): number {
    s = s.trim().replace(',', '.');
    const p = s.split(':').map(Number);
    if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
    if (p.length === 2) return p[0] * 60 + p[1];
    return Number(s);
  }
  function parseSubtitles(text: string): { start: number; end: number; text: string }[] {
    const blocks = text.replace(/\r/g, '').split(/\n\s*\n/);
    const timeRe = /\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}\s*-->\s*\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}/;
    const cues: { start: number; end: number; text: string }[] = [];
    for (const b of blocks) {
      const lines = b.split('\n').filter((l) => l.trim() !== '');
      if (lines.length < 2) continue;
      let i = 0;
      if (/^\d+$/.test(lines[0].trim())) i = 1;
      const m = lines[i]?.match(timeRe);
      if (!m) continue;
      const parts = lines[i].split('-->');
      const start = parseTs(parts[0]);
      const end = parseTs(parts[1]);
      const txt = lines.slice(i + 1).join('\n');
      if (isFinite(start) && isFinite(end)) cues.push({ start, end, text: txt });
    }
    return cues;
  }
  async function findSubtitles(): Promise<void> {
    // 若外层已预填字幕（来自播放列表）直接加载；否则自动查找同目录同名 srt/vtt/ass/ssa
    if (!opts.subtitles || !opts.subtitles.length) {
      try {
        const api = plugin.createApi();
        const parent = t.path.includes('/') ? t.path.slice(0, t.path.lastIndexOf('/')) || '/' : '/';
        const entries = await api.listDir(parent);
        const stem = t.name.replace(/\.[^.]+$/, '').toLowerCase();
        const subs = entries.filter(
          (e) =>
            !e.isDir &&
            /\.(srt|vtt|ass|ssa)$/i.test(e.name) &&
            e.name.replace(/\.[^.]+$/, '').toLowerCase() === stem,
        );
        if (subs.length)
          opts.subtitles = subs.map((s) => ({ name: s.name, fsId: s.fsId, path: s.path }));
      } catch {
        /* 找不到字幕不影响播放 */
      }
    }
    if (opts.subtitles && opts.subtitles.length && subtitleBtn) {
      subtitleBtn.disabled = false;
      subtitleBtn.style.display = '';
    }
    await loadSubtitles();
  }
  async function loadSubtitles(): Promise<void> {
    if (mode !== 'video' || !opts.subtitles || !opts.subtitles.length) return;
    const v = el as HTMLVideoElement;
    for (const sub of opts.subtitles) {
      try {
        const bytes = await fetchBytes(plugin, {
          name: sub.name,
          fsId: sub.fsId,
          path: sub.path,
          size: 0,
        });
        const text = new TextDecoder('utf-8').decode(bytes);
        const cues = parseSubtitles(text);
        if (!cues.length) continue;
        const track = v.addTextTrack('subtitles', sub.name.replace(/\.[^.]+$/, ''), 'zh-CN');
        track.mode = 'hidden';
        for (const c of cues) track.addCue(new VTTCue(c.start, c.end, c.text));
        subtitleTracks.push({ label: sub.name, track });
      } catch {
        /* 字幕加载失败不影响播放 */
      }
    }
    if (subtitleTracks.length) {
      activeSubtitle = 0;
      subtitleTracks[0].track.mode = 'showing';
      if (subtitleBtn) {
        subtitleBtn.disabled = false;
        subtitleBtn.style.display = '';
        subtitleBtn.classList.add('bdnsync-media-active');
      }
    }
  }
  function cycleSubtitle(): void {
    if (!subtitleTracks.length) return;
    const order = [...subtitleTracks.map((_, i) => i), -1];
    const cur = activeSubtitle;
    const next = order[(order.indexOf(cur) + 1) % order.length];
    if (cur >= 0) subtitleTracks[cur].track.mode = 'hidden';
    activeSubtitle = next;
    if (next >= 0) {
      subtitleTracks[next].track.mode = 'showing';
      subtitleBtn?.classList.add('bdnsync-media-active');
    } else {
      subtitleBtn?.classList.remove('bdnsync-media-active');
    }
  }

  void (async () => {
    try {
      const streamUrl = streamUrlFor(plugin, t, pendingQuality);
      if (streamUrl) {
        // 对齐参考 on()：mcpServer 运行 → 直接 streamUrl（免下载、边下边播）。
        // 清晰度选择由 pendingQuality 传给 StreamServer：'auto' 时服务端按 VIP 选最高档，
        // 否则按用户在画质菜单点选的等级匹配 alternatives。
        loadSrc(streamUrl);
      } else {
        // 回退：整文件下载到内存 → blob
        const bytes = await fetchBytes(plugin, t);
        const blob = new Blob([bytes as unknown as ArrayBufferView], {
          type: mimeFor(getExt(t.name)),
        });
        const u = URL.createObjectURL(blob);
        urls.push(u);
        loadSrc(u);
      }
    } catch (e) {
      hideSpinner();
      stage.createDiv({
        cls: 'bdnsync-empty bdnsync-danger-text',
        text: `加载失败：${e instanceof Error ? e.message : String(e)}`,
      });
    }
  })();

  // ---- 控件事件 ----
  function togglePlay(): void {
    if (el.paused)
      el.play().catch(() => {
        /* ignore */
      });
    else el.pause();
  }
  function skip(delta: number): void {
    if (!el.duration) {
      el.currentTime = Math.max(0, el.currentTime + delta);
      return;
    }
    el.currentTime = Math.max(0, Math.min(el.duration, el.currentTime + delta));
    updateProgress();
  }
  function toggleFullscreen(): void {
    const target: HTMLElement = mode === 'video' ? (el as HTMLVideoElement) : stage;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {
        /* ignore */
      });
    } else {
      const fs =
        target.requestFullscreen ||
        (target as unknown as { webkitRequestFullscreen?: () => Promise<void> })
          .webkitRequestFullscreen;
      if (fs) fs.call(target).catch(() => new Notice('当前环境不支持全屏 API'));
      else new Notice('当前环境不支持全屏 API');
    }
  }
  function updateProgress(): void {
    const e = el.duration ? el.currentTime / el.duration : 0;
    seekPlay.style.width = `${e * 100}%`;
    seekThumb.style.left = `${e * 100}%`;
    curTimeEl.textContent = fmtTime(el.currentTime);
  }
  function updateBuffered(): void {
    if (!el.buffered.length || !el.duration) return;
    const end = el.buffered.end(el.buffered.length - 1);
    seekBuf.style.width = `${Math.min(100, (end / el.duration) * 100)}%`;
  }
  function fitToStage(): void {
    if (mode !== 'video') return;
    const v = el as HTMLVideoElement;
    if (!v.videoWidth) return;
    // 容器自适应：stage 已是 flex:1 100% 父区域；只调整 video 元素的最大宽高
    // 让浏览器原生 object-fit:contain 处理比例即可，无需手动 fit
    (el as HTMLVideoElement).style.objectFit = fitAspect ? 'contain' : 'fill';
    (el as HTMLVideoElement).style.width = `${scaleFactor * 100}%`;
    (el as HTMLVideoElement).style.height = `${scaleFactor * 100}%`;
  }
  function refreshQualityOptions(): void {
    if (mode !== 'video') return;
    const v = el as HTMLVideoElement;
    const vh = v.videoHeight || 0;
    // 根据源文件分辨率 + 会员上限生成档位
    const s: { label: string; h: number | null; locked?: boolean }[] = [{ label: '原画', h: null }];
    const tiers: [number, string][] = [
      [2160, '4K'],
      [1440, '2K'],
      [1080, '1080P'],
      [720, '720P'],
      [480, '480P'],
      [360, '360P'],
    ];
    for (const [h, label] of tiers) {
      if (vh >= h) {
        // 超出会员上限的档位仍可选（直链物理支持），但用 locked 标记提示
        const locked = vipMaxHeight !== null && h > vipMaxHeight;
        s.push({ label, h, locked });
      }
    }
    if (vh) s[0].label = `原画 ${vh}p`;
    qualityOptions.length = 0;
    qualityOptions.push(...s);
    // 默认清晰度上限：受会员等级约束（SVIP 不限 → 原画；会员/普通 → 对应上限）
    if (qualityCap === null && vipMaxHeight !== null) {
      const cap = vipMaxHeight;
      const allowed = s.filter((q) => q.h === null || q.h <= cap);
      qualityCap = allowed.length ? allowed[allowed.length - 1].h : null;
    }
    if (popEl) {
      closePlayerMenu();
      openPlayerMenu();
    }
  }

  /**
   * 实际播放分辨率探测：播放器 loadedmetadata 后调用，与"原文件分辨率 + VIP 上限"
   * 对比。若明显小于源文件，说明百度接口返回的是被转码的版本，提示用户切 Cookie 模式
   * 或升级 VIP 以解锁更高画质。
   */
  function probeActualQuality(): void {
    if (mode !== 'video') return;
    const v = el as HTMLVideoElement;
    if (!v.videoHeight || !v.videoWidth) return;
    const sourceH = qualityOptions[0]?.h ?? 0; // 原画档的源文件高度
    if (!sourceH) return;
    const actualH = v.videoHeight;
    if (actualH < sourceH * 0.95) {
      // 实际播放清晰度比源文件低 → 通常是被转码了
      const ratio = ((actualH / sourceH) * 100).toFixed(0);
      new Notice(
        `BDNSync：当前播放 ${actualH}p（约源文件 ${sourceH}p 的 ${ratio}%），可能受 VIP 等级限制。` +
          `如需原画质请检查账号会员等级或 Cookie 中的 STOKEN`,
        8000,
      );
      vipTag.classList.add('is-downgraded');
      vipTag.setAttr('title', `实际播放 ${actualH}p · 源 ${sourceH}p（被百度接口按权限转码）`);
    } else {
      vipTag.classList.remove('is-downgraded');
      vipTag.setAttr('title', '');
    }
  }
  function closePlayerMenu(): void {
    if (popEl) {
      popEl.remove();
      popEl = null;
    }
  }
  function openPlayerMenu(): void {
    const pop = stage.createDiv({ cls: 'bdnsync-media-pop' });
    popEl = pop;
    const sec1 = pop.createDiv({ cls: 'bdnsync-media-pop-sec' });
    sec1.createDiv({ cls: 'bdnsync-media-pop-title', text: '倍速' });
    const row1 = sec1.createDiv({ cls: 'bdnsync-media-pop-row' });
    const cur = speeds[speedIdx];
    for (const sp of speeds) {
      row1
        .createEl('button', {
          cls: `bdnsync-media-pop-item${sp === cur ? ' active' : ''}`,
          text: `${sp}x`,
        })
        .addEventListener('click', () => {
          el.playbackRate = sp;
          speedIdx = speeds.indexOf(sp);
          speedBtn.textContent = `${sp}x`;
          memSetNum(SPEED_KEY, sp);
          closePlayerMenu();
        });
    }
    const sec2 = pop.createDiv({ cls: 'bdnsync-media-pop-sec' });
    const vipNote =
      vipMaxHeight === null
        ? '画质（原画直链 · 会员不限）'
        : `画质（账号上限 ${String(vipMaxHeight)}P）`;
    sec2.createDiv({ cls: 'bdnsync-media-pop-title', text: vipNote });
    const row2 = sec2.createDiv({ cls: 'bdnsync-media-pop-row' });
    for (const q of qualityOptions) {
      const cls = `bdnsync-media-pop-item${q.h === qualityCap ? ' active' : ''}${q.locked ? ' is-locked' : ''}`;
      const item = row2.createEl('button', { cls, text: q.label });
      if (q.locked)
        item.setAttr(
          'title',
          '超出当前账号会员等级，仍可播放（直链为原画），但清晰度受百度接口返回限制',
        );
      item.addEventListener('click', () => {
        qualityCap = q.h;
        // 真正按用户选的清晰度重新构建流式 URL（auto 时 defaultUrl 已经是按 VIP 选最高）
        const label = qualityCap == null ? 'auto' : `${qualityCap}p`;
        applyQuality(label);
        closePlayerMenu();
      });
    }
    const onDoc = (ev: MouseEvent) => {
      if (!popEl) return;
      const u = ev.target as HTMLElement;
      if (popEl.contains(u) || menuBtn.contains(u)) return;
      closePlayerMenu();
      document.removeEventListener('click', onDoc, true);
    };
    setTimeout(() => document.addEventListener('click', onDoc, true), 0);
  }

  playBtn.addEventListener('click', togglePlay);
  backBtn.addEventListener('click', () => skip(-10));
  fwdBtn.addEventListener('click', () => skip(10));
  // 播放列表：上一首 / 下一首
  prevBtn.addEventListener('click', () => opts.onAdvance?.(-1, repeatMode));
  nextBtn.addEventListener('click', () => opts.onAdvance?.(1, repeatMode));
  if (opts.onAdvance) {
    prevBtn.toggleAttribute('disabled', !opts.hasPrev);
    nextBtn.toggleAttribute('disabled', !opts.hasNext);
  } else {
    prevBtn.toggleAttribute('disabled', true);
    nextBtn.toggleAttribute('disabled', true);
  }
  // ---- 自定义进度条交互（对标 B站/YouTube）：悬停小气泡 + 拖拽大气泡 + 圆点放大 ----
  /** 把客户端 X 坐标换算成进度比例 [0,1]（相对进度条轨道宽度） */
  function ratioFromClientX(clientX: number): number {
    const r = seek.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  }
  let dragging = false;
  let wasPlaying = false; // 拖拽前是否播放中（拖拽时暂停，松手恢复）
  let lastLiveSeek = 0; // 节流：拖拽时实时 seek 的时间戳
  let clickTimer: number | null = null; // 单击播放延迟（避免与双击全屏冲突）
  // ---- 控制条自动隐藏（仅全屏时）：鼠标静止 2.5s 隐藏 UI + 光标 ----
  let hideUiTimer: number | null = null;
  function showUi(): void {
    host.removeClass('bdnsync-media-hide-ui');
    if (hideUiTimer) {
      clearTimeout(hideUiTimer);
      hideUiTimer = null;
    }
  }
  function scheduleHideUi(): void {
    if (!document.fullscreenElement) return;
    showUi();
    hideUiTimer = window.setTimeout(() => {
      if (document.fullscreenElement && !dragging) host.addClass('bdnsync-media-hide-ui');
    }, 2500);
  }
  stage.addEventListener('mousemove', scheduleHideUi);
  /** 判断某比例位置是否已在缓冲区内（用于拖拽 tip 提示） */
  function isBuffered(ratio: number): boolean {
    if (!el.buffered.length || !el.duration) return false;
    const timeSec = ratio * el.duration;
    for (let i = 0; i < el.buffered.length; i++) {
      if (timeSec >= el.buffered.start(i) - 0.5 && timeSec <= el.buffered.end(i) + 0.5) return true;
    }
    return false;
  }
  function showHoverTip(clientX: number): void {
    if (!el.duration || dragging) return;
    const b = ratioFromClientX(clientX);
    seekHoverTip.textContent = fmtTime(b * el.duration);
    seekHoverTip.style.left = `${b * 100}%`;
    seekHoverTip.style.opacity = '1';
  }
  function hideHoverTip(): void {
    if (!dragging) seekHoverTip.style.opacity = '0';
  }
  function startDrag(clientX: number): void {
    if (!el.duration) return;
    dragging = true;
    wasPlaying = !el.paused;
    // 拖拽期间暂停播放，让画面稳定停在拖动点（精确跳转体验）
    if (wasPlaying) el.pause();
    seek.classList.add('bdnsync-media-seek-dragging');
    // 拖拽时禁用 width 过渡，让已播条/圆点跟手零延迟
    seekPlay.style.transition = 'none';
    seekThumb.style.transition = 'none';
    document.body.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';
    moveDrag(clientX);
  }
  function moveDrag(clientX: number): void {
    if (!el.duration) return;
    const b = ratioFromClientX(clientX);
    // 拖拽时立即更新已播条 + 圆点（视觉跟随）
    seekPlay.style.width = `${b * 100}%`;
    seekThumb.style.left = `${b * 100}%`;
    // drag-tip 实时显示目标时间；若超出缓冲区则变灰提示「缓冲外」
    const buffered = isBuffered(b);
    seekDragTip.textContent = buffered
      ? fmtTime(b * el.duration)
      : `${fmtTime(b * el.duration)} · 缓冲外`;
    seekDragTip.style.left = `${b * 100}%`;
    seekDragTip.style.opacity = '1';
    seekDragTip.classList.toggle('is-out', !buffered);
    seekHoverTip.style.opacity = '0';
    // 节流实时 seek：让画面真正跳到目标位置（精确跳转），最多每 80ms 一次
    const now = performance.now();
    if (now - lastLiveSeek > 80) {
      lastLiveSeek = now;
      el.currentTime = b * el.duration;
    }
  }
  function endDrag(clientX: number): void {
    if (!el.duration) {
      dragging = false;
      return;
    }
    const b = ratioFromClientX(clientX);
    el.currentTime = b * el.duration; // 松手最终精确跳转
    updateProgress();
    dragging = false;
    if (wasPlaying)
      el.play().catch(() => {
        /* ignore */
      }); // 拖前在播则恢复
    seek.classList.remove('bdnsync-media-seek-dragging');
    // 恢复过渡
    seekPlay.style.transition = '';
    seekThumb.style.transition = '';
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    seekDragTip.style.opacity = '0';
    seekDragTip.classList.remove('is-out');
  }
  // 鼠标：点击跳、拖拽、悬停气泡
  // 关键：window 级 mousemove 仅在拖拽时追踪光标；悬停气泡只能在 seek 元素自身上
  // 触发（通过下面的 seek.mousemove / mouseleave），否则鼠标移出进度条后气泡仍
  // 会跟随显示并卡在 ratio=0 处显示「0:00」——这是用户截图里的主要 bug。
  seek.addEventListener('mousedown', (ev) => {
    ev.preventDefault();
    startDrag(ev.clientX);
  });
  // 命名引用：destroy 时需显式移除 window 级监听，否则每次打开/关闭播放器都会累积全局监听（泄漏）
  const onWinMove = (ev: MouseEvent) => {
    if (dragging) moveDrag(ev.clientX);
  };
  const onWinUp = (ev: MouseEvent) => {
    if (dragging) endDrag(ev.clientX);
  };
  window.addEventListener('mousemove', onWinMove);
  window.addEventListener('mouseup', onWinUp);
  seek.addEventListener('mousemove', (ev) => showHoverTip(ev.clientX));
  seek.addEventListener('mouseleave', () => {
    hideHoverTip();
    // drag tip 由 startDrag/endDrag 完全托管；拖拽中即使鼠标移到进度条外，
    // window.mousemove→moveDrag 也会持续把 drag tip 定位在最新位置，无需额外处理。
  });
  // 触摸：拖拽进度（移动端）
  seek.addEventListener(
    'touchstart',
    (ev) => {
      startDrag(ev.touches[0].clientX);
    },
    { passive: true },
  );
  seek.addEventListener(
    'touchmove',
    (ev) => {
      moveDrag(ev.touches[0].clientX);
    },
    { passive: true },
  );
  seek.addEventListener('touchend', (ev) => {
    const touch = ev.changedTouches[0];
    if (touch) endDrag(touch.clientX);
  });
  // 滚轮在进度条上 → 微调进度（±5s）；双击进度条 → 全屏
  seek.addEventListener(
    'wheel',
    (ev) => {
      ev.preventDefault();
      if (!el.duration) return;
      const d = ev.deltaY > 0 ? -5 : 5;
      el.currentTime = Math.max(0, Math.min(el.duration, el.currentTime + d));
      updateProgress();
    },
    { passive: false },
  );
  seek.addEventListener('dblclick', (ev) => {
    ev.preventDefault();
    toggleFullscreen();
  });
  volBtn.addEventListener('click', () => {
    el.muted = !el.muted;
    if (!el.muted && el.volume === 0) el.volume = 0.5;
  });
  volRange.addEventListener('input', () => {
    const a = Number(volRange.value) / 100;
    el.volume = a;
    el.muted = a === 0;
  });
  // 滚轮在音量区 → 微调音量
  vol.addEventListener(
    'wheel',
    (ev) => {
      ev.preventDefault();
      const a = Math.max(0, Math.min(1, el.volume + (ev.deltaY > 0 ? -0.05 : 0.05)));
      el.volume = a;
      el.muted = a === 0;
      volRange.value = String(Math.round(a * 100));
    },
    { passive: false },
  );
  speedBtn.addEventListener('click', () => {
    speedIdx = (speedIdx + 1) % speeds.length;
    const sp = speeds[speedIdx];
    el.playbackRate = sp;
    speedBtn.textContent = `${sp}x`;
    memSetNum(SPEED_KEY, sp);
  });
  // 循环模式：off → list → one → shuffle → off（内层维护 UI 状态；切集时由 onAdvance 同步给外层）
  repeatBtn.addEventListener('click', () => {
    const i = repeatCycle.indexOf(repeatMode);
    repeatMode = repeatCycle[(i + 1) % repeatCycle.length];
    updateRepeatBtn();
  });
  if (subtitleBtn) subtitleBtn.addEventListener('click', cycleSubtitle);
  pipBtn.addEventListener('click', () => {
    if (mode !== 'video') return;
    const v = el as HTMLVideoElement;
    if (!v.requestPictureInPicture) return;
    if (document.pictureInPictureElement)
      document.exitPictureInPicture().catch(() => {
        /* ignore */
      });
    else v.requestPictureInPicture().catch(() => new Notice('当前环境不支持画中画'));
  });
  ratioBtn.addEventListener('click', () => {
    fitAspect = !fitAspect;
    ratioBtn.classList.toggle('bdnsync-media-active', !fitAspect);
    if (mode === 'video') (el as HTMLVideoElement).style.objectFit = fitAspect ? 'contain' : 'fill';
    fitToStage();
  });
  fsBtn.addEventListener('click', toggleFullscreen);
  dlBtn.addEventListener('click', () => void downloadToVault(plugin, t));
  menuBtn.addEventListener('click', () => {
    if (popEl) closePlayerMenu();
    else openPlayerMenu();
  });

  // 键盘快捷键
  stage.addEventListener('keydown', (ev) => {
    switch (ev.key) {
      case ' ':
        ev.preventDefault();
        togglePlay();
        break;
      case 'ArrowLeft':
        if (ev.ctrlKey || ev.metaKey) {
          if (opts.onAdvance) {
            ev.preventDefault();
            opts.onAdvance(-1, repeatMode);
          }
        } else skip(ev.shiftKey ? -30 : -5);
        break;
      case 'ArrowRight':
        if (ev.ctrlKey || ev.metaKey) {
          if (opts.onAdvance) {
            ev.preventDefault();
            opts.onAdvance(1, repeatMode);
          }
        } else skip(ev.shiftKey ? 30 : 5);
        break;
      case 'PageUp':
        skip(30);
        break;
      case 'PageDown':
        skip(-30);
        break;
      case 'Home':
        if (el.duration) {
          el.currentTime = 0;
          updateProgress();
        }
        break;
      case 'End':
        if (el.duration) {
          el.currentTime = el.duration;
          updateProgress();
        }
        break;
      case ',':
      case 'j':
      case 'J':
        skip(-10);
        break;
      case '.':
      case 'l':
      case 'L':
        skip(10);
        break;
      case 'ArrowUp':
        ev.preventDefault();
        el.volume = Math.min(1, el.volume + 0.1);
        break;
      case 'ArrowDown':
        ev.preventDefault();
        el.volume = Math.max(0, el.volume - 0.1);
        break;
      case 'f':
      case 'F':
        toggleFullscreen();
        break;
      case 'm':
      case 'M':
        el.muted = !el.muted;
        break;
      case 'p':
      case 'P':
        if (mode === 'video') pipBtn.click();
        break;
    }
    updateProgress();
  });
  stage.addEventListener('click', (ev) => {
    const tgt = ev.target as HTMLElement;
    if (tgt === stage || tgt.classList.contains('bdnsync-media-embed')) {
      // 延迟执行，避免与双击全屏冲突（双击时取消单击切换）
      if (clickTimer) {
        clearTimeout(clickTimer);
        clickTimer = null;
      }
      clickTimer = window.setTimeout(() => {
        togglePlay();
        clickTimer = null;
      }, 250);
    }
  });
  // 双击画面 → 全屏
  stage.addEventListener('dblclick', (ev) => {
    const tgt = ev.target as HTMLElement;
    if (tgt === stage || tgt.classList.contains('bdnsync-media-embed')) {
      ev.preventDefault();
      if (clickTimer) {
        clearTimeout(clickTimer);
        clickTimer = null;
      }
      toggleFullscreen();
    }
  });

  document.addEventListener('fullscreenchange', onFsChange);

  return {
    destroy(): void {
      document.removeEventListener('fullscreenchange', onFsChange);
      window.removeEventListener('mousemove', onWinMove);
      window.removeEventListener('mouseup', onWinUp);
      if (hideUiTimer) clearTimeout(hideUiTimer);
      if (clickTimer) clearTimeout(clickTimer);
      saveTime(el.currentTime);
      closePlayerMenu();
      if (el) {
        el.pause();
        el.removeAttribute('src');
        el.load();
      }
      for (const u of urls) URL.revokeObjectURL(u);
      host.empty();
    },
  };

  // 暴露 icon 给无用的内部（保持类型一致）
  void icon;
}
