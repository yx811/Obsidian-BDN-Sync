// BDNSync 可复用 UI 组件：图标、卡片、按钮、进度条、浮层、分步向导

import { App, Modal, Notice } from 'obsidian';
import { md5Hex } from '../util/md5';

// ---------------- SVG 图标（Lucide 风格，与 Obsidian 原生一致）----------------

export type IconName =
  | 'cloud'
  | 'cloud-check'
  | 'cloud-alert'
  | 'cloud-off'
  | 'cloud-upload'
  | 'cloud-download'
  | 'refresh-cw'
  | 'arrow-up'
  | 'arrow-down'
  | 'trash-2'
  | 'alert-triangle'
  | 'check'
  | 'x'
  | 'settings'
  | 'bar-chart-2'
  | 'activity'
  | 'shield'
  | 'zap'
  | 'hard-drive'
  | 'smartphone'
  | 'monitor'
  | 'laptop'
  | 'file-text'
  | 'folder'
  | 'git-merge'
  | 'copy'
  | 'eye'
  | 'eye-off'
  | 'chevron-down'
  | 'chevron-right'
  | 'info'
  | 'rotate-ccw'
  | 'download'
  | 'folder-plus'
  | 'pencil'
  | 'folder-input'
  | 'history'
  | 'git-branch'
  | 'timeline'
  | 'pie-chart'
  | 'sliders'
  | 'share-2'
  | 'image'
  | 'layers'
  | 'gauge'
  | 'clock'
  | 'filter'
  | 'maximize-2'
  | 'minimize-2'
  | 'external-link'
  | 'film'
  | 'music'
  | 'file-spreadsheet'
  | 'file-question'
  | 'play'
  | 'pause'
  | 'rotate-cw'
  | 'volume-2'
  | 'volume-x'
  | 'sliders-horizontal'
  | 'picture-in-picture-2'
  // 实验室 / 实验相关
  | 'beaker'
  | 'flask-conical'
  | 'test-tube'
  | 'atom'
  | 'wrench'
  | 'sparkles'
  | 'skip-back'
  | 'skip-forward'
  | 'repeat'
  | 'repeat-1'
  | 'shuffle'
  | 'subtitles'
  | 'rewind'
  | 'fast-forward'
  | 'volume-1'
  | 'volume-off'
  | 'aspect-ratio'
  | 'circle-play'
  | 'circle-pause'
  | 'user-round'
  | 'crown'
  | 'badge-check'
  | 'badge-info'
  | 'flame'
  | 'star'
  | 'wallet'
  | 'package-2'
  | 'gem'
  | 'lock'
  | 'unlock'
  | 'regex'
  | 'arrow-down-wide-narrow'
  | 'file-json';

const ICON_PATHS: Record<IconName, string> = {
  cloud:
    '<path d="M17.5 19c0-3.037-2.463-5.5-5.5-5.5S6.5 15.963 6.5 19M17.5 19H19c1.933 0 3.5-1.567 3.5-3.5S20.933 12 19 12h-.5c-.267-3.64-3.36-6.5-7-6.5S4.267 8.36 4 12h-.5C1.567 12 0 13.567 0 15.5S1.567 19 3.5 19h14z"/>',
  'cloud-check':
    '<path d="M11 19h6.5c1.933 0 3.5-1.567 3.5-3.5S20.933 12 19 12h-.5c-.267-3.64-3.36-6.5-7-6.5S4.267 8.36 4 12h-.5C1.567 12 0 13.567 0 15.5S1.567 19 3.5 19H11z"/><path d="M9 18l2 2 4-4"/>',
  'cloud-alert':
    '<path d="M17.5 19c0-3.037-2.463-5.5-5.5-5.5S6.5 15.963 6.5 19M17.5 19H19c1.933 0 3.5-1.567 3.5-3.5S20.933 12 19 12h-.5c-.267-3.64-3.36-6.5-7-6.5S4.267 8.36 4 12h-.5C1.567 12 0 13.567 0 15.5S1.567 19 3.5 19h14z"/><path d="M12 9v3"/><path d="M12 15h.01"/>',
  'cloud-off':
    '<path d="M2 2l20 20M8.5 19H3.5C1.567 19 0 17.433 0 15.5S1.567 12 3.5 12H4c.267-3.64 3.36-6.5 7-6.5 1.896 0 3.61.767 4.864 2.013M17.5 12H19c1.933 0 3.5 1.567 3.5 3.5S20.933 19 19 19h-2"/>',
  'cloud-upload':
    '<path d="M17.5 19c0-3.037-2.463-5.5-5.5-5.5S6.5 15.963 6.5 19M17.5 19H19c1.933 0 3.5-1.567 3.5-3.5S20.933 12 19 12h-.5c-.267-3.64-3.36-6.5-7-6.5S4.267 8.36 4 12h-.5C1.567 12 0 13.567 0 15.5S1.567 19 3.5 19h14z"/><path d="M12 13v8M8 17l4-4 4 4"/>',
  'cloud-download':
    '<path d="M17.5 19c0-3.037-2.463-5.5-5.5-5.5S6.5 15.963 6.5 19M17.5 19H19c1.933 0 3.5-1.567 3.5-3.5S20.933 12 19 12h-.5c-.267-3.64-3.36-6.5-7-6.5S4.267 8.36 4 12h-.5C1.567 12 0 13.567 0 15.5S1.567 19 3.5 19h14z"/><path d="M12 15v-8M8 11l4 4 4-4"/>',
  'refresh-cw': '<path d="M21 12a9 9 0 1 1-2.636-6.364M21 3v9h-9"/>',
  'arrow-up': '<path d="M12 19V5M5 12l7-7 7 7"/>',
  'arrow-down': '<path d="M12 5v14M5 12l7 7 7-7"/>',
  'trash-2':
    '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6M14 11v6"/>',
  'alert-triangle':
    '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  'bar-chart-2': '<path d="M18 20V10M12 20V4M6 20v-6"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  zap: '<path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>',
  'hard-drive':
    '<path d="M2 12h20M2 12a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h20a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2M2 12v4a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-4"/><path d="M6 16h.01M10 16h.01"/>',
  smartphone: '<rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><path d="M12 18h.01"/>',
  monitor:
    '<rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>',
  laptop: '<path d="M4 4h16c1.1 0 2 .9 2 2v10c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><path d="M2 18h20"/>',
  'file-text':
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M16 13H8M16 17H8M10 9H8"/>',
  folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
  'git-merge':
    '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
  'eye-off':
    '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><path d="M1 1l22 22"/>',
  'chevron-down': '<path d="M6 9l6 6 6-6"/>',
  'chevron-right': '<path d="M9 18l6-6-6-6"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  'rotate-ccw': '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  'folder-plus':
    '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><path d="M12 11v6M9 14h6"/>',
  pencil: '<path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  'folder-input':
    '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><path d="M12 11v6M9.5 13.5L12 11l2.5 2.5"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>',
  'git-branch':
    '<line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  timeline:
    '<line x1="12" y1="2" x2="12" y2="22"/><circle cx="12" cy="6" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="18" r="2"/><path d="M14 6h6M14 12h4M14 18h7"/>',
  'pie-chart': '<path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/>',
  sliders:
    '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
  'share-2':
    '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>',
  image:
    '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
  layers:
    '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
  gauge: '<path d="M12 14l4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  filter: '<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>',
  'maximize-2':
    '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>',
  'minimize-2':
    '<polyline points="4 14 10 14 10 20"/><polyline points="14 10 14 4 20 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/>',
  'external-link':
    '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
  film: '<rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="7" x2="7" y2="7"/><line x1="2" y1="17" x2="7" y2="17"/><line x1="17" y1="17" x2="22" y2="17"/><line x1="17" y1="7" x2="22" y2="7"/>',
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  'file-spreadsheet':
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M8 13h8M8 17h8M12 13v4"/>',
  'file-question':
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M9.5 14.5a2.5 2.5 0 1 1 3.5 2.3c-.8.4-1.5.5-2 .9M12 17h.01"/>',
  play: '<polygon points="5 3 19 12 5 21 5 3"/>',
  pause: '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>',
  'rotate-cw': '<path d="M21 12a9 9 0 1 1-2.83-6.36M21 3v9h-9"/>',
  'volume-2':
    '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/>',
  'volume-x':
    '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/>',
  'sliders-horizontal':
    '<line x1="3" y1="8" x2="21" y2="8"/><line x1="3" y1="16" x2="21" y2="16"/><circle cx="9" cy="8" r="2"/><circle cx="15" cy="16" r="2"/>',
  'picture-in-picture-2':
    '<path d="M9 7V3M9 3h4M9 3l3 3"/><rect x="3" y="7" width="18" height="14" rx="2" ry="2"/><path d="M21 11v6a2 2 0 0 1-2 2h-6"/><rect x="11" y="13" width="6" height="4" rx="1"/>',
  'skip-back': '<polygon points="19 20 9 12 19 4 19 20"/><line x1="5" y1="19" x2="5" y2="5"/>',
  'skip-forward': '<polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19"/>',
  repeat:
    '<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>',
  'repeat-1':
    '<polyline points="17 2 21 6 17 10"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><polyline points="7 22 3 18 7 14"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/><path d="M11 14h1v4"/>',
  shuffle:
    '<polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/>',
  subtitles:
    '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M6 12h4"/><path d="M14 12h4"/><path d="M6 16h2"/><path d="M12 16h6"/>',
  rewind: '<polygon points="11 19 2 12 11 5 11 19"/><polygon points="22 19 13 12 22 5 22 19"/>',
  'fast-forward':
    '<polygon points="13 19 22 12 13 5 13 19"/><polygon points="2 19 11 12 2 5 2 19"/>',
  'volume-1':
    '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>',
  'volume-off': '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>',
  'aspect-ratio':
    '<rect x="2" y="9" width="20" height="6" rx="2"/><path d="M6 9V5a2 2 0 0 1 2-2h4"/><path d="M18 9V5a2 2 0 0 0-2-2h-4"/><path d="M6 15v4a2 2 0 0 0 2 2h4"/><path d="M18 15v4a2 2 0 0 1-2 2h-4"/>',
  'circle-play': '<circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/>',
  'circle-pause':
    '<circle cx="12" cy="12" r="10"/><rect x="9" y="8" width="2.5" height="8"/><rect x="12.5" y="8" width="2.5" height="8"/>',
  'user-round': '<circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 1 0-16 0"/>',
  crown:
    '<path d="M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.734H5.81a1 1 0 0 1-.957-.734L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z"/><path d="M5 21h14"/>',
  'badge-check':
    '<path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"/><path d="m9 12 2 2 4-4"/>',
  'badge-info': '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  flame:
    '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
  star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  wallet:
    '<path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4Z"/>',
  'package-2':
    '<path d="M3 9h18v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9zM3 9V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4"/><path d="M9 12h6"/><path d="M9 16h6"/>',
  gem: '<path d="M6 3h12l4 6-10 13L2 9Z"/><path d="M11 3 8 9l4 13 4-13-3-6"/><path d="M2 9h20"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  unlock:
    '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>',
  regex:
    '<path d="M17 3v10"/><path d="m12.67 5.5 8.66 5"/><path d="m12.67 10.5 8.66-5"/><path d="M9 17a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v2a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2v-2z"/>',
  'arrow-down-wide-narrow':
    '<path d="m3 16 4 4 4-4"/><path d="M7 20V4"/><path d="M11 4h10"/><path d="M11 8h7"/><path d="M11 12h4"/>',
  'file-json':
    '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="M10 12a1 1 0 0 0-1 1v1a1 1 0 0 1-1 1 1 1 0 0 1 1 1v1a1 1 0 0 0 1 1"/><path d="M14 18a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1 1 1 0 0 1-1-1v-1a1 1 0 0 0-1-1"/>',
  beaker:
    '<path d="M4.5 3h15M6 3v7.5L3 18a2 2 0 0 0 1.8 3h14.4A2 2 0 0 0 21 18l-3-7.5V3"/><path d="M6 11h12"/>',
  'flask-conical':
    '<path d="M10 2v6.3L4.4 18a2 2 0 0 0 1.8 3h11.6a2 2 0 0 0 1.8-3L14 8.3V2"/><path d="M8 2h8M7 14h10"/>',
  'test-tube':
    '<path d="M14 2v6.3L19.6 18a2 2 0 0 1-1.8 3H6.2A2 2 0 0 1 4.4 18L10 8.3V2"/><path d="M9 2h6"/>',
  atom: '<circle cx="12" cy="12" r="1.6"/><path d="M20 12a8 8 0 0 1-16 0M4 12a8 8 0 0 1 16 0M12 4a8 8 0 0 1 0 16M12 4a8 8 0 0 0 0 16"/>',
  wrench:
    '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2-2 2.6-2.6z"/>',
  sparkles:
    '<path d="M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8z"/><path d="M19 14l.9 2.1L22 17l-2.1.9L19 20l-.9-2.1L16 17l2.1-.9z"/>',
};

export function setIcon(el: HTMLElement, name: IconName, size = 16): void {
  el.empty();
  const svg = el.createSvg('svg', {
    attr: {
      viewBox: '0 0 24 24',
      width: size,
      height: size,
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '2',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    },
  });
  svg.innerHTML = ICON_PATHS[name] ?? '';
}

export function createIconButton(
  container: HTMLElement,
  opts: {
    icon: IconName;
    label: string;
    title?: string;
    onClick: (btn: HTMLButtonElement) => void;
    primary?: boolean;
    danger?: boolean;
    disabled?: boolean;
  },
): HTMLButtonElement {
  const btn = container.createEl('button', {
    cls: [
      'bdnsync-btn',
      opts.primary ? 'bdnsync-btn-primary' : '',
      opts.danger ? 'bdnsync-btn-danger' : '',
    ]
      .filter(Boolean)
      .join(' '),
    attr: { 'aria-label': opts.label, title: opts.title ?? opts.label },
  });
  if (opts.disabled) btn.disabled = true;
  const iconWrap = btn.createSpan({ cls: 'bdnsync-btn-icon' });
  setIcon(iconWrap, opts.icon, 16);
  btn.createSpan({ text: opts.label });
  btn.addEventListener('click', () => opts.onClick(btn));
  return btn;
}

/**
 * 紧凑图标按钮：仅图标 + tooltip，用于表格/列表行内密集操作区。
 * 视觉上更轻量，hover 才显现背景，避免一行塞多个文字按钮导致的拥挤。
 */
export function createCompactButton(
  container: HTMLElement,
  opts: {
    icon: IconName;
    label: string;
    onClick: (btn: HTMLButtonElement) => void;
    danger?: boolean;
    active?: boolean;
    disabled?: boolean;
  },
): HTMLButtonElement {
  const btn = container.createEl('button', {
    cls: [
      'bdnsync-icon-btn',
      'bdnsync-compact-btn',
      opts.danger ? 'bdnsync-compact-btn-danger' : '',
      opts.active ? 'bdnsync-compact-btn-active' : '',
    ]
      .filter(Boolean)
      .join(' '),
    attr: { 'aria-label': opts.label, title: opts.label },
  });
  if (opts.disabled) btn.disabled = true;
  const iconWrap = btn.createSpan();
  setIcon(iconWrap, opts.icon, 15);
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    opts.onClick(btn);
  });
  return btn;
}

/**
 * 弹窗标题徽标：在标题左侧渲染一个圆角图标 chip，统一所有弹窗的视觉入口。
 */
export function createModalHeader(
  container: HTMLElement,
  opts: { title: string; subtitle?: string; icon: IconName; danger?: boolean },
): { head: HTMLElement; titleEl: HTMLElement; subtitleEl?: HTMLElement } {
  const head = container.createDiv({ cls: 'bdnsync-modal-head' });
  const chip = head.createDiv({
    cls: `bdnsync-modal-chip${opts.danger ? ' bdnsync-modal-chip-danger' : ''}`,
  });
  setIcon(chip, opts.icon, 18);
  const textWrap = head.createDiv({ cls: 'bdnsync-modal-headtext' });
  const titleEl = textWrap.createEl('h3', { text: opts.title, cls: 'bdnsync-modal-title' });
  let subtitleEl: HTMLElement | undefined;
  if (opts.subtitle) {
    subtitleEl = textWrap.createEl('p', { text: opts.subtitle, cls: 'bdnsync-modal-subtitle' });
  }
  return { head, titleEl, subtitleEl };
}

// ---------------- 卡片与布局 ----------------

export interface SectionOpts {
  title: string;
  icon?: IconName;
  collapsible?: boolean;
  defaultOpen?: boolean;
}

export function createSection(
  container: HTMLElement,
  opts: SectionOpts,
): {
  header: HTMLElement;
  body: HTMLElement;
  toggle: (open?: boolean) => boolean;
} {
  const wrap = container.createDiv({ cls: 'bdnsync-section' });
  const header = wrap.createDiv({ cls: 'bdnsync-section-header' });
  if (opts.icon) {
    const iconEl = header.createSpan({ cls: 'bdnsync-section-icon' });
    setIcon(iconEl, opts.icon, 18);
  }
  header.createSpan({ text: opts.title, cls: 'bdnsync-section-title' });

  const body = wrap.createDiv({ cls: 'bdnsync-section-body' });
  let open = opts.defaultOpen !== false;

  if (opts.collapsible) {
    wrap.addClass('bdnsync-section-collapsible');
    const chevron = header.createSpan({ cls: 'bdnsync-section-chevron' });
    setIcon(chevron, 'chevron-down', 16);
    header.addEventListener('click', () => toggle());
    const toggle = (force?: boolean): boolean => {
      open = force ?? !open;
      body.style.display = open ? '' : 'none';
      chevron.style.transform = open ? 'rotate(0deg)' : 'rotate(-90deg)';
      return open;
    };
    toggle(open);
    return { header, body, toggle };
  }

  return { header, body, toggle: () => true };
}

export function createCard(container: HTMLElement, cls = ''): HTMLElement {
  return container.createDiv({ cls: `bdnsync-card ${cls}`.trim() });
}

export function createBadge(
  container: HTMLElement,
  text: string,
  type: 'neutral' | 'success' | 'warning' | 'error' | 'info' = 'neutral',
): HTMLElement {
  return container.createSpan({ text, cls: `bdnsync-badge bdnsync-badge-${type}` });
}

// ---------------- 进度条 ----------------

export interface ProgressBar {
  el: HTMLElement;
  fill: HTMLElement;
  text: HTMLElement;
  setRatio: (ratio: number, label?: string) => void;
}

export function createProgressBar(container: HTMLElement, label?: string): ProgressBar {
  const wrap = container.createDiv({ cls: 'bdnsync-progress-wrap' });
  const track = wrap.createDiv({ cls: 'bdnsync-progress-track' });
  const fill = track.createDiv({ cls: 'bdnsync-progress-fill', attr: { style: 'width:0%' } });
  const text = wrap.createDiv({ cls: 'bdnsync-progress-text', text: label ?? '' });
  return {
    el: wrap,
    fill,
    text,
    setRatio: (ratio, newLabel) => {
      const r = Math.max(0, Math.min(1, ratio));
      fill.style.width = `${Math.round(r * 100)}%`;
      if (newLabel !== undefined) text.setText(newLabel);
    },
  };
}

// ---------------- 空状态 / 加载态（跨弹窗与视图统一） ----------------

export interface EmptyStateOpts {
  icon?: IconName;
  title: string;
  desc?: string;
  /** 追加到根节点的额外 class（如保留各视图自身样式） */
  cls?: string;
}

/** 统一空状态：图标 + 标题 + 可选描述，跨网盘浏览器 / 看板 / 日志 / 弹窗复用，视觉一致 */
export function createEmptyState(container: HTMLElement, opts: EmptyStateOpts): HTMLElement {
  const wrap = container.createDiv({
    cls: `bdnsync-emptystate ${opts.cls ?? ''}`.trim(),
  });
  if (opts.icon) {
    const iconEl = wrap.createDiv({ cls: 'bdnsync-emptystate-icon' });
    setIcon(iconEl, opts.icon, 28);
  }
  wrap.createDiv({ cls: 'bdnsync-emptystate-title', text: opts.title });
  if (opts.desc) wrap.createDiv({ cls: 'bdnsync-emptystate-desc', text: opts.desc });
  return wrap;
}

/** 骨架屏占位：加载中显示若干 shimmer 行，避免「空白闪烁」 */
export function createSkeleton(container: HTMLElement, lines = 3): HTMLElement {
  const wrap = container.createDiv({ cls: 'bdnsync-skeleton' });
  for (let i = 0; i < lines; i++) {
    wrap.createDiv({ cls: 'bdnsync-skeleton-line' });
  }
  return wrap;
}

// ---------------- 小型浮层 Popover ----------------

export interface PopoverHandle {
  close: () => void;
}

export function showPopover(
  app: App,
  anchor: HTMLElement,
  render: (el: HTMLElement, close: () => void) => void,
  opts?: { width?: number; className?: string },
): PopoverHandle {
  const doc = window.document;
  const backdrop = doc.createDiv({ cls: 'bdnsync-popover-backdrop' });
  const panel = backdrop.createDiv({ cls: `bdnsync-popover ${opts?.className ?? ''}`.trim() });
  if (opts?.width) panel.style.width = `${opts.width}px`;

  const close = () => {
    panel.addClass('bdnsync-popover-out');
    window.setTimeout(() => backdrop.remove(), 120);
    doc.removeEventListener('keydown', onKey);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };
  doc.addEventListener('keydown', onKey);

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });

  render(panel, close);
  doc.body.appendChild(backdrop);

  // 定位到 anchor 上方或下方
  requestAnimationFrame(() => {
    const rect = anchor.getBoundingClientRect();
    const popRect = panel.getBoundingClientRect();
    let top = rect.bottom + 6;
    if (top + popRect.height > window.innerHeight - 12) {
      top = Math.max(12, rect.top - popRect.height - 6);
    }
    let left = rect.left;
    if (left + popRect.width > window.innerWidth - 12) {
      left = Math.max(12, window.innerWidth - popRect.width - 12);
    }
    panel.style.top = `${top}px`;
    panel.style.left = `${left}px`;
    panel.addClass('bdnsync-popover-in');
  });

  return { close };
}

// ---------------- 分步向导 ----------------

export interface WizardStep {
  id: string;
  title: string;
  description?: string;
  render: (container: HTMLElement) => void;
  canNext?: () => boolean;
}

export interface WizardResult {
  el: HTMLElement;
  next: () => boolean;
  prev: () => boolean;
  goto: (idx: number) => void;
}

export function createWizard(
  container: HTMLElement,
  steps: WizardStep[],
  onFinish: () => void,
  onCancel?: () => void,
): WizardResult {
  const wrap = container.createDiv({ cls: 'bdnsync-wizard' });
  const header = wrap.createDiv({ cls: 'bdnsync-wizard-header' });
  const body = wrap.createDiv({ cls: 'bdnsync-wizard-body' });
  const footer = wrap.createDiv({ cls: 'bdnsync-wizard-footer' });

  let current = 0;

  const renderStep = (idx: number) => {
    body.empty();
    const step = steps[idx];
    body.createEl('h4', { text: step.title, cls: 'bdnsync-wizard-step-title' });
    if (step.description) {
      body.createEl('p', { text: step.description, cls: 'bdnsync-wizard-step-desc' });
    }
    step.render(body);
    updateHeader();
    updateFooter();
  };

  const updateHeader = () => {
    header.empty();
    steps.forEach((step, idx) => {
      const dot = header.createDiv({ cls: 'bdnsync-wizard-dot' });
      if (idx < current) dot.addClass('done');
      if (idx === current) dot.addClass('active');
      dot.createSpan({ text: String(idx + 1) });
      if (idx < steps.length - 1) {
        const line = header.createDiv({ cls: 'bdnsync-wizard-line' });
        if (idx < current) line.addClass('done');
      }
    });
  };

  const updateFooter = () => {
    footer.empty();
    if (onCancel) {
      const cancel = footer.createEl('button', { text: '取消', cls: 'bdnsync-btn' });
      cancel.addEventListener('click', onCancel);
    }
    if (current > 0) {
      const prev = footer.createEl('button', { text: '上一步', cls: 'bdnsync-btn' });
      prev.addEventListener('click', () => prevStep());
    }
    const isLast = current === steps.length - 1;
    const next = footer.createEl('button', {
      text: isLast ? '完成' : '下一步',
      cls: 'bdnsync-btn bdnsync-btn-primary',
    });
    next.addEventListener('click', () => {
      const step = steps[current];
      if (step.canNext && !step.canNext()) return;
      if (isLast) onFinish();
      else nextStep();
    });
  };

  const nextStep = (): boolean => {
    if (current < steps.length - 1) {
      current++;
      renderStep(current);
      return true;
    }
    return false;
  };

  const prevStep = (): boolean => {
    if (current > 0) {
      current--;
      renderStep(current);
      return true;
    }
    return false;
  };

  renderStep(0);

  return {
    el: wrap,
    next: nextStep,
    prev: prevStep,
    goto: (idx) => {
      current = Math.max(0, Math.min(steps.length - 1, idx));
      renderStep(current);
    },
  };
}

// ---------------- 小工具 ----------------

/** 创建密码输入框并附带显示/隐藏切换 */
export function createPasswordField(
  container: HTMLElement,
  opts: { value: string; placeholder?: string; onChange: (v: string) => void },
): { input: HTMLInputElement; row: HTMLElement } {
  const row = container.createDiv({ cls: 'bdnsync-password-row' });
  const input = row.createEl('input', {
    type: 'password',
    value: opts.value,
    placeholder: opts.placeholder ?? '',
    cls: 'bdnsync-input',
  });
  input.addEventListener('input', () => opts.onChange(input.value));

  const toggle = row.createEl('button', {
    cls: 'bdnsync-icon-btn',
    attr: { 'aria-label': '显示密码' },
  });
  const iconWrap = toggle.createSpan();
  setIcon(iconWrap, 'eye-off', 16);
  toggle.addEventListener('click', () => {
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    setIcon(iconWrap, showing ? 'eye-off' : 'eye', 16);
  });

  return { input, row };
}

/** 安全的 DOM 创建封装 */
export function createEl<K extends keyof HTMLElementTagNameMap>(
  container: HTMLElement,
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const el = container.createEl(tag, cls ? { cls } : undefined);
  if (text) el.setText(text);
  return el;
}

// ---------------- 内联表单校验（微交互：即时反馈，不依赖弹窗） ----------------

export interface ValidatedTextHandle {
  input: HTMLInputElement;
  /** 手动设置校验结果（error 非空即非法，显示红框 + 提示） */
  setResult: (error: string | null, okHint?: string) => void;
}

/**
 * 带内联校验提示的文本输入：失焦/输入时调用 validator，
 * 非法时输入框加 `.bdnsync-input-invalid` 红框并下方显示错误提示，合法时显示可选的 OK 提示。
 * 校验为纯前端即时反馈，不改变既有 onChange 的数据写入逻辑。
 *
 * @param validator 返回错误文案（非空=非法）；返回空字符串表示合法。
 *                  可用返回值区分「错误」与「提示」：返回 {error, hint} 时用对象形式。
 */
export function createValidatedText(
  container: HTMLElement,
  opts: {
    value?: string;
    placeholder?: string;
    type?: string;
    validator?: (v: string) => string | null;
    onChange?: (v: string, handle: ValidatedTextHandle) => void;
  },
): ValidatedTextHandle {
  const wrap = container.createDiv({ cls: 'bdnsync-field' });
  const input = wrap.createEl('input', {
    type: opts.type ?? 'text',
    value: opts.value ?? '',
    placeholder: opts.placeholder ?? '',
    cls: 'bdnsync-input',
  });
  const hint = wrap.createDiv({ cls: 'bdnsync-field-hint', attr: { style: 'display:none' } });

  const setResult = (error: string | null, okHint?: string) => {
    if (error) {
      input.classList.add('bdnsync-input-invalid');
      hint.classList.remove('bdnsync-field-hint-ok');
      hint.classList.add('bdnsync-field-hint-error');
      hint.textContent = error;
      hint.style.display = '';
    } else if (okHint) {
      input.classList.remove('bdnsync-input-invalid');
      hint.classList.remove('bdnsync-field-hint-error');
      hint.classList.add('bdnsync-field-hint-ok');
      hint.textContent = okHint;
      hint.style.display = '';
    } else {
      input.classList.remove('bdnsync-input-invalid');
      hint.classList.remove('bdnsync-field-hint-error', 'bdnsync-field-hint-ok');
      hint.textContent = '';
      hint.style.display = 'none';
    }
  };

  const handle: ValidatedTextHandle = { input, setResult };

  input.addEventListener('input', () => {
    if (opts.validator) setResult(opts.validator(input.value));
    opts.onChange?.(input.value, handle);
  });
  input.addEventListener('blur', () => {
    if (opts.validator) setResult(opts.validator(input.value));
  });

  if (opts.validator && opts.value) setResult(opts.validator(opts.value));
  return handle;
}

// ---------------- 轻量小弹窗（确认 / 提示 / 输入） ----------------

/** 轻量确认弹窗：统一使用 .bdnsync-modal-shell 骨架，与大型弹窗视觉一致 */
export function showConfirmModal(
  app: App,
  opts: {
    title: string;
    message: string;
    confirmText?: string;
    cancelText?: string;
    danger?: boolean;
    icon?: IconName;
  },
): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = new MiniModal(app);
    modal.renderConfirm(opts, (ok) => {
      modal.close();
      resolve(ok);
    });
    modal.open();
  });
}

/** 轻量文本输入弹窗 */
export function showPromptModal(
  app: App,
  opts: { title: string; placeholder?: string; defaultValue?: string; confirmText?: string },
): Promise<string | null> {
  return new Promise((resolve) => {
    const modal = new MiniModal(app);
    modal.renderPrompt(opts, (val) => {
      modal.close();
      resolve(val);
    });
    modal.open();
  });
}

/** 统一的小弹窗实现（确认 / 输入 / 图片 / 文本展示） */
export class MiniModal extends Modal {
  private content: ((shell: HTMLElement, done: () => void) => void) | null = null;
  /** 图片预览用的 object URL，关闭时释放避免内存泄漏 */
  private previewUrl: string | null = null;

  renderConfirm(
    opts: {
      title: string;
      message: string;
      confirmText?: string;
      cancelText?: string;
      danger?: boolean;
      icon?: IconName;
    },
    resolve: (ok: boolean) => void,
  ): void {
    this.content = (shell) => {
      createModalHeader(shell, {
        title: opts.title,
        icon: opts.icon ?? 'info',
        danger: opts.danger,
      });
      const body = shell.createDiv({ cls: 'bdnsync-modal-body' });
      body.createEl('p', { text: opts.message, cls: 'bdnsync-modal-subtitle' });
      const foot = shell.createDiv({ cls: 'bdnsync-modal-foot' });
      createIconButton(foot, {
        icon: 'x',
        label: opts.cancelText ?? '取消',
        onClick: () => resolve(false),
      });
      createIconButton(foot, {
        icon: opts.danger ? 'alert-triangle' : 'check',
        label: opts.confirmText ?? '确定',
        primary: !opts.danger,
        danger: opts.danger,
        onClick: () => resolve(true),
      });
    };
  }

  renderPrompt(
    opts: { title: string; placeholder?: string; defaultValue?: string; confirmText?: string },
    resolve: (val: string | null) => void,
  ): void {
    this.content = (shell) => {
      createModalHeader(shell, { title: opts.title, icon: 'pencil' });
      const body = shell.createDiv({ cls: 'bdnsync-modal-body' });
      const input = body.createEl('input', {
        cls: 'bdnsync-input',
        attr: { type: 'text', placeholder: opts.placeholder ?? '' },
      });
      input.value = opts.defaultValue ?? '';
      const foot = shell.createDiv({ cls: 'bdnsync-modal-foot' });
      createIconButton(foot, { icon: 'x', label: '取消', onClick: () => resolve(null) });
      createIconButton(foot, {
        icon: 'check',
        label: opts.confirmText ?? '确定',
        primary: true,
        onClick: () => resolve(input.value.trim() || null),
      });
      window.setTimeout(() => input.focus(), 30);
    };
  }

  /** 图片预览小弹窗（url 可为 object URL 或 dataURL） */
  renderImage(name: string, url: string, size: number): void {
    // 防御：若复用了同一 MiniModal 实例再次渲染，先释放旧 blob，避免泄漏
    if (this.previewUrl) {
      try {
        URL.revokeObjectURL(this.previewUrl);
      } catch {
        /* ignore */
      }
      this.previewUrl = null;
    }
    this.previewUrl = url.startsWith('blob:') ? url : null;
    this.content = (shell) => {
      createModalHeader(shell, { title: name, icon: 'image', subtitle: formatBytesSafe(size) });
      const body = shell.createDiv({ cls: 'bdnsync-modal-body bdnsync-img-body' });
      const img = body.createEl('img', {
        cls: 'bdnsync-img-preview-img',
        attr: { src: url, alt: name },
      });
      img.style.maxWidth = '100%';
      img.style.height = 'auto';
      const foot = shell.createDiv({ cls: 'bdnsync-modal-foot' });
      createIconButton(foot, { icon: 'x', label: '关闭', onClick: () => this.close() });
    };
  }

  /** 分享链接展示小弹窗 */
  renderShare(name: string, link: string): void {
    this.content = (shell) => {
      createModalHeader(shell, { title: '分享链接', icon: 'share-2', subtitle: name });
      const body = shell.createDiv({ cls: 'bdnsync-modal-body' });
      const ta = body.createEl('textarea', {
        cls: 'bdnsync-input bdnsync-share-link',
        attr: { readonly: 'true', rows: '3' },
      }) as HTMLTextAreaElement;
      ta.value = link;
      ta.addEventListener('focus', () => ta.select());
      const foot = shell.createDiv({ cls: 'bdnsync-modal-foot' });
      createIconButton(foot, {
        icon: 'copy',
        label: '复制',
        primary: true,
        onClick: () => {
          ta.select();
          void navigator.clipboard.writeText(link).then(() => new Notice('BDNSync：已复制'));
        },
      });
      createIconButton(foot, { icon: 'x', label: '关闭', onClick: () => this.close() });
    };
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    const shell = contentEl.createDiv({ cls: 'bdnsync-modal-shell' });
    this.content?.(shell, () => this.close());
  }

  onClose(): void {
    if (this.previewUrl) {
      try {
        URL.revokeObjectURL(this.previewUrl);
      } catch {
        /* ignore */
      }
      this.previewUrl = null;
    }
    this.contentEl.empty();
  }
}

function formatBytesSafe(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024,
    i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

// ---------------- 可拖拽调整大小的弹窗 ----------------

/**
 * 为弹窗注入「右下角拖拽调整尺寸」能力，并持久化到 localStorage。
 * 原生 `resize: both` 在部分 Obsidian 主题下会被覆盖，这里用自绘 grip 兜底，
 * 保证「查看日志」「浏览网盘」等弹窗既能按视口自适应，又能由用户手动拖拽放大/缩小。
 *
 * 关键：Obsidian Modal 的真实尺寸容器是 `.modal-content`（modalEl 的直接子元素），
 * 固定尺寸 CSS 也写在它上面；contentEl 只是其中的内容层，给它设宽高会被外层裁剪。
 * 因此本函数优先定位 `.modal-content` 作为 resize 目标，只有找不到时才回退到 contentEl。
 *
 * @param modalEl  Obsidian Modal 的 this.modalEl
 * @param contentEl 弹窗内容容器（Obsidian 的 contentEl；resize 目标回退用）
 * @param key      持久化键（不同弹窗用不同 key 互不影响）
 * @param scope    可选的隔离域（如 vault 名），用于多 vault 共用配置目录时尺寸互不串扰
 */
export function makeResizable(
  modalEl: HTMLElement,
  contentEl: HTMLElement,
  key: string,
  scope?: string,
): void {
  // 多 vault 隔离：同一 Obsidian 配置目录下多个 vault 共用 localStorage，
  // 不隔离会让 A vault 拖拽的尺寸覆盖到 B vault。用 scope 哈希区分。
  const scopeTag = scope ? `-${md5Hex(new TextEncoder().encode(scope)).slice(0, 8)}` : '';
  const LS_KEY = `bdnsync-resize-${key}${scopeTag}`;
  // resize 目标：优先 .modal-content（真实尺寸容器），回退 contentEl
  const target = (modalEl.querySelector('.modal-content') as HTMLElement) || contentEl;
  const content = target;

  // 让目标可定位（grip 用 absolute 定位到其右下角）
  if (getComputedStyle(content).position === 'static') content.style.position = 'relative';

  // 恢复上次尺寸（首次打开使用 CSS 默认尺寸，之后用用户上次拖拽的结果）
  try {
    const saved = localStorage.getItem(LS_KEY);
    if (saved) {
      const { w, h } = JSON.parse(saved) as { w: number; h: number };
      if (w > 0) content.style.width = `${w}px`;
      if (h > 0) content.style.height = `${h}px`;
    }
  } catch {
    /* ignore */
  }

  const grip = document.createElement('div');
  grip.className = 'bdnsync-resize-grip';
  grip.setAttribute('aria-label', '拖拽调整窗口大小');
  grip.innerHTML =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v6h-6M21 21h-6M21 9V3h-6M21 3l-6 6"/></svg>';
  content.appendChild(grip);

  let startX = 0,
    startY = 0,
    startW = 0,
    startH = 0,
    dragging = false;

  const onMove = (e: PointerEvent) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const maxW = window.innerWidth * 0.98;
    const maxH = window.innerHeight * 0.98;
    const minW = 360,
      minH = 320;
    const newW = Math.max(minW, Math.min(maxW, startW + dx));
    const newH = Math.max(minH, Math.min(maxH, startH + dy));
    content.style.width = `${newW}px`;
    content.style.height = `${newH}px`;
  };

  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    grip.classList.remove('bdnsync-resize-grip-active');
    document.body.style.userSelect = '';
    try {
      localStorage.setItem(
        LS_KEY,
        JSON.stringify({
          w: content.offsetWidth,
          h: content.offsetHeight,
        }),
      );
    } catch {
      /* ignore */
    }
  };

  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    const rect = content.getBoundingClientRect();
    startW = rect.width;
    startH = rect.height;
    grip.classList.add('bdnsync-resize-grip-active');
    document.body.style.userSelect = 'none';
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  });
}
