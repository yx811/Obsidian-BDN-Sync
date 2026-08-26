// 冲突解决器：smart-merge（文本三方/联合合并、二进制分叉）/ force-local / force-remote / always-fork / ask-me

import type { ConflictKind, ConflictStrategy } from '../types';
import { conflictName, isTextPath } from '../util/misc';
import { threeWayMerge, unionMerge } from '../util/diff3';
import { classifyConfigPath, mergeConfigTexts, classifyCanvasPath, mergeCanvasTexts, mergeFrontmatter } from '../util/config-merge';

export interface ConflictInput {
  path: string;
  kind: ConflictKind;
  localBytes: Uint8Array | null; // 本地当前内容（本地已删除则为 null）
  remoteBytes: Uint8Array | null; // 云端当前内容（云端已删除则为 null）
  baseBytes: Uint8Array | null; // 上次同步内容快照（base 缓存未命中则为 null）
  deviceName: string;
  remoteDevice?: string;
  /** 两端 mtime（毫秒），用于配置类文件「最后写入获胜」的基底判断 */
  localMtime?: number;
  remoteMtime?: number;
}

export interface ResolveOutcome {
  action:
    | 'write-and-upload'
    | 'write-local'
    | 'upload-local'
    | 'delete-remote'
    | 'delete-local'
    | 'deferred';
  localBytes?: Uint8Array; // 要写入原路径的内容
  uploadOriginal: boolean; // 是否需要上传原路径
  conflictCopies: { path: string; bytes: Uint8Array }[]; // 冲突副本（写入并上传）
  hasMarkers: boolean; // 合并结果含冲突标记
  note: string;
}

const KIND_TEXT: Record<string, string> = {
  'edit-edit': '两端都修改了同一文件',
  'create-create': '两端独立创建了同名文件',
  'delete-modify-local': '本地已删除，云端已修改',
  'delete-modify-remote': '云端已删除，本地已修改',
  binary: '二进制文件冲突',
  race: '同步期间被其他设备覆盖（竞态）',
  unknown: '未知冲突',
};

export function conflictKindText(kind: ConflictKind): string {
  return KIND_TEXT[kind] || KIND_TEXT.unknown;
}

/**
 * 三方合并的体量上限（本地 + 云端 + base 的总字节）。
 * 合并是纯 JS 的行级 diff，在主线程执行；超大文本会直接卡住 Obsidian 界面。
 * 超限时退化为分叉保留双方版本（参考实现同样取了 300KB 量级的阈值）。
 */
const MERGE_MAX_BYTES = 512 * 1024;

/**
 * 严格 UTF-8 解码。扩展名只是「大概率是文本」的启发式判断：
 * 一个后缀为 .md 但实际是二进制/非 UTF-8 编码的文件，用宽松解码会被替换字符（U+FFFD）
 * 污染，合并后写回就是**不可逆的内容损坏**。因此解码失败时必须退回分叉路径。
 */
function decodeStrict(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * 合并输出按本地原文行尾还原（审计 #5）：diff3/config-merge 全程在 LF 语义上工作，
 * 若本地原文是 CRLF（Windows/Obsidian 常见），写回前要把 \n 还原为 \r\n，
 * 否则整文件行尾被改写、下次同步 hash 变化产生假冲突/重复合并。
 */
function restoreLineEndings(text: string, original: string): string {
  if (!original.includes('\r\n')) return text;
  return text.replace(/\n/g, '\r\n');
}

export class ConflictResolver {
  resolve(input: ConflictInput, strategy: ConflictStrategy): ResolveOutcome {
    const { path, localBytes, remoteBytes, baseBytes } = input;
    const forkRemoteCopy = (remote: Uint8Array, note: string): ResolveOutcome => ({
      action: 'upload-local',
      uploadOriginal: true,
      conflictCopies: [{ path: conflictName(path, 'REMOTE'), bytes: remote }],
      hasMarkers: false,
      note,
    });

    switch (strategy) {
      case 'smart-merge': {
        if (localBytes && remoteBytes) {
          // —— P1-3.3 配置类文件：结构化字段级合并（而非纯文本 diff3）——
          // .obsidian 下的 JSON 配置文件（workspace/app/community-plugins/插件 config）
          // 语义是「字段级状态」，整文件文本 diff 会因 JSON 格式化差异产生大量假冲突，
          // 且字段互相独立（不同设备改不同字段应自动合并）。白名单字段做一层合并、
          // 插件启用列表做并集，其余 LWW。
          const cfgKind = classifyConfigPath(path);
          if (cfgKind) {
            const localText = decodeStrict(localBytes);
            const remoteText = decodeStrict(remoteBytes);
            if (localText !== null && remoteText !== null) {
              const localNewer = (input.localMtime ?? 0) >= (input.remoteMtime ?? 0);
              const cfg = mergeConfigTexts(cfgKind, localText, remoteText, localNewer);
              if (cfg.merged !== null) {
                return {
                  action: 'write-and-upload',
                  localBytes: new TextEncoder().encode(restoreLineEndings(cfg.merged, localText)),
                  uploadOriginal: true,
                  conflictCopies: [],
                  hasMarkers: cfg.hasConflict,
                  note: cfg.hasConflict
                    ? `配置字段级合并：字段 ${cfg.conflictFields.join('、')} 两端不同，已按最后写入取用（可在配置快照中回滚）`
                    : `已按${
                        cfg.strategy === 'plugin-union'
                          ? '插件启用并集'
                          : cfg.strategy === 'field-merge'
                            ? '字段级合并'
                            : '最后写入获胜'
                      }合并配置`,
                };
              }
              // 解析失败：拒绝合并，降级分叉保留双方（防破坏）
              return forkRemoteCopy(
                remoteBytes,
                '配置文件解析失败，已按二进制分叉：本地版本保留在原路径，云端版本另存为冲突副本',
              );
            }
          }
          // —— #4.8 Canvas / Excalidraw 节点级三方合并（结构化，非整文件 diff3）——
          const canvasKind = classifyCanvasPath(path);
          if (canvasKind) {
            const totalBytesCv = localBytes.length + remoteBytes.length + (baseBytes?.length ?? 0);
            if (totalBytesCv > MERGE_MAX_BYTES) {
              return forkRemoteCopy(
                remoteBytes,
                `Canvas 体量超过 ${Math.round(MERGE_MAX_BYTES / 1024)} KB 未做自动合并：分叉保留双方`,
              );
            }
            const localText = decodeStrict(localBytes);
            const remoteText = decodeStrict(remoteBytes);
            const baseText = baseBytes ? decodeStrict(baseBytes) : null;
            const localNewer = (input.localMtime ?? 0) >= (input.remoteMtime ?? 0);
            if (localText !== null && remoteText !== null && baseText !== null) {
              const cv = mergeCanvasTexts(canvasKind, localText, remoteText, baseText, localNewer);
              if (cv.merged !== null) {
                return {
                  action: 'write-and-upload',
                  localBytes: new TextEncoder().encode(restoreLineEndings(cv.merged, localText)),
                  uploadOriginal: true,
                  conflictCopies: [],
                  hasMarkers: cv.hasConflict,
                  note: cv.hasConflict
                    ? `Canvas 节点级合并：元素 ${cv.conflictIds.join('、')} 两端不同，已按最后写入取用（可在冲突副本回滚）`
                    : '已按节点级三方合并 Canvas',
                };
              }
            }
            return forkRemoteCopy(remoteBytes, 'Canvas 解析失败或缺少 base，已按分叉保留双方版本');
          }
          // —— #4.8 Markdown frontmatter 字段级合并 ——
          // 两端都有 YAML frontmatter 时，用字段级合并（而非整文件 diff3），避免「字段互相独立
          // 却被当成整体冲突」；正文保持不变。仅一端有 frontmatter 或解析失败时回落到下方 diff3。
          // 体量超过上限时直接跳过本分支（下方会按超大文本分叉），避免主线程卡顿。
          const totalBytes = localBytes.length + remoteBytes.length + (baseBytes?.length ?? 0);
          const lowerPath = path.toLowerCase();
          if (lowerPath.endsWith('.md') && totalBytes <= MERGE_MAX_BYTES) {
            const lt = decodeStrict(localBytes);
            const rt = decodeStrict(remoteBytes);
            if (lt !== null && rt !== null) {
              const localNewer = (input.localMtime ?? 0) >= (input.remoteMtime ?? 0);
              const fm = mergeFrontmatter(lt, rt, localNewer);
              if (fm.merged !== null) {
                return {
                  action: 'write-and-upload',
                  localBytes: new TextEncoder().encode(restoreLineEndings(fm.merged, lt)),
                  uploadOriginal: true,
                  conflictCopies: [],
                  hasMarkers: fm.hasConflict,
                  note: fm.hasConflict
                    ? `frontmatter 字段 ${fm.conflictKeys.join('、')} 两端不同，已按最后写入取用`
                    : '已按字段级合并 Markdown frontmatter（正文保持不变）',
                };
              }
            }
          }
          if (isTextPath(path) && totalBytes <= MERGE_MAX_BYTES) {
            const localText = decodeStrict(localBytes);
            const remoteText = decodeStrict(remoteBytes);
            if (localText === null || remoteText === null) {
              // 后缀像文本但内容不是合法 UTF-8：按二进制分叉，绝不做有损合并
              return forkRemoteCopy(
                remoteBytes,
                '内容不是合法 UTF-8，已按二进制分叉：本地版本保留在原路径，云端版本另存为冲突副本',
              );
            }
            const baseText = baseBytes ? decodeStrict(baseBytes) : null;
            const result =
              baseText !== null
                ? threeWayMerge(
                    baseText,
                    localText,
                    remoteText,
                    input.deviceName,
                    input.remoteDevice || 'REMOTE',
                  )
                : unionMerge(
                    localText,
                    remoteText,
                    input.deviceName,
                    input.remoteDevice || 'REMOTE',
                  );
            return {
              action: 'write-and-upload',
              localBytes: new TextEncoder().encode(restoreLineEndings(result.merged, localText)),
              uploadOriginal: true,
              conflictCopies: [],
              hasMarkers: result.hasConflict,
              note: result.hasConflict
                ? '已自动合并，但存在无法自动解决的行冲突（已插入冲突标记，请手动编辑后保存）'
                : '已自动三方合并',
            };
          }
          if (isTextPath(path)) {
            return forkRemoteCopy(
              remoteBytes,
              `文本体量超过 ${Math.round(MERGE_MAX_BYTES / 1024)} KB 未做自动合并：本地版本保留在原路径，云端版本另存为冲突副本`,
            );
          }
          return forkRemoteCopy(
            remoteBytes,
            '二进制冲突：本地版本保留在原路径，云端版本已另存为冲突副本',
          );
        }
        if (remoteBytes && !localBytes) {
          return {
            action: 'write-local',
            localBytes: remoteBytes,
            uploadOriginal: false,
            conflictCopies: [],
            hasMarkers: false,
            note: '本地已删除、云端有修改：按“保留修改”恢复云端版本',
          };
        }
        if (localBytes && !remoteBytes) {
          return {
            action: 'upload-local',
            uploadOriginal: true,
            conflictCopies: [],
            hasMarkers: false,
            note: '云端已删除、本地有修改：按“保留修改”重新上传本地版本',
          };
        }
        return {
          action: 'deferred',
          uploadOriginal: false,
          conflictCopies: [],
          hasMarkers: false,
          note: '两端均已删除，无需处理',
        };
      }
      case 'force-local': {
        if (localBytes) {
          return {
            action: 'upload-local',
            uploadOriginal: true,
            conflictCopies: [],
            hasMarkers: false,
            note: '按策略强制以本地版本覆盖云端',
          };
        }
        return {
          action: 'delete-remote',
          uploadOriginal: false,
          conflictCopies: [],
          hasMarkers: false,
          note: '本地已删除：按策略删除云端文件',
        };
      }
      case 'force-remote': {
        if (remoteBytes) {
          // localBytes 必须携带云端内容，否则引擎侧「写入原路径」分支不会触发，
          // 表现为选了「保留云端」却什么都没发生、冲突却被标记为已解决。
          return {
            action: 'write-local',
            localBytes: remoteBytes,
            uploadOriginal: false,
            conflictCopies: [],
            hasMarkers: false,
            note: '按策略强制以云端版本覆盖本地',
          };
        }
        return {
          action: 'delete-local',
          uploadOriginal: false,
          conflictCopies: [],
          hasMarkers: false,
          note: '云端已删除：按策略删除本地文件',
        };
      }
      case 'always-fork': {
        if (localBytes && remoteBytes) {
          return {
            action: 'write-local',
            localBytes: remoteBytes,
            uploadOriginal: false,
            conflictCopies: [{ path: conflictName(path, 'LOCAL'), bytes: localBytes }],
            hasMarkers: false,
            note: '已分叉：原路径保留云端版本，本地版本另存为冲突副本',
          };
        }
        if (localBytes) {
          return {
            action: 'upload-local',
            uploadOriginal: true,
            conflictCopies: [],
            hasMarkers: false,
            note: '仅本地存在：重新上传',
          };
        }
        if (remoteBytes) {
          return {
            action: 'write-local',
            localBytes: remoteBytes,
            uploadOriginal: false,
            conflictCopies: [],
            hasMarkers: false,
            note: '仅云端存在：下载恢复',
          };
        }
        return {
          action: 'deferred',
          uploadOriginal: false,
          conflictCopies: [],
          hasMarkers: false,
          note: '两端均已删除',
        };
      }
      case 'ask-me':
      default:
        return {
          action: 'deferred',
          uploadOriginal: false,
          conflictCopies: [],
          hasMarkers: false,
          note: '等待用户在冲突面板中选择处理策略',
        };
    }
  }
}
