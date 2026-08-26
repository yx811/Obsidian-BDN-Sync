/**
 * 错误诊断知识库（#3.7 错误诊断与用户引导）
 *
 * 将百度网盘 errno / 错误分类码映射为中文说明、用户可执行建议与可恢复性标记。
 * 纯数据 + 纯函数，无副作用、无外部依赖，便于在设置页、健康检查面板、日志中复用。
 *
 * errno 取值对齐 `src/baidu/api.ts` 的 `ERRNO_MESSAGES` 与 `errnoToCode`。
 */

export type ErrorCategory =
  | 'auth' // 鉴权失败
  | 'quota' // 容量/配额
  | 'ratelimit' // 限流/操作频繁
  | 'notfound' // 文件/目录不存在
  | 'conflict' // 已存在/冲突
  | 'param' // 参数错误
  | 'security' // 安全策略
  | 'network' // 网络层
  | 'unknown';

export interface ErrorInfo {
  /** 中文简述 */
  zh: string;
  /** 给用户的可执行建议 */
  hint: string;
  /** 是否可恢复（瞬态限流/网络类通常可自动重试恢复） */
  recoverable: boolean;
  category: ErrorCategory;
}

/** errno → 知识库条目（覆盖 api.ts 中出现的全部 errno） */
export const ERROR_DICT: Record<number, ErrorInfo> = {
  '-6': { zh: '身份验证失败', hint: 'access_token 无效或已过期，请重新完成设备码授权（设置页「重新授权」）。', recoverable: true, category: 'auth' },
  '-7': { zh: '文件或目录名不合法', hint: '检查路径是否含非法字符（如 \\ / : * ? " < > |）；百度网盘对部分字符敏感。', recoverable: false, category: 'notfound' },
  '-8': { zh: '文件或目录已存在', hint: '目标已存在，通常可在三向合并中自动处理；若持续报错请检查冲突策略。', recoverable: true, category: 'conflict' },
  '-9': { zh: '文件或目录不存在 / 无权限', hint: '远端路径不存在或应用无权访问；插件会自动重建目录后重试。', recoverable: true, category: 'notfound' },
  '-4': { zh: '请求被拦截 / 过于频繁', hint: '稍后自动退避重试；若频繁出现请降低并发或提高 requestIntervalMs。', recoverable: true, category: 'ratelimit' },
  '2': { zh: '参数错误', hint: '多为内部调用参数异常，请附诊断信息反馈开发者。', recoverable: false, category: 'param' },
  '12': { zh: '部分文件操作失败', hint: '批量操作中个别文件失败，可重试；若持续请查看具体文件路径日志。', recoverable: true, category: 'unknown' },
  '111': { zh: 'access_token 无效或已过期', hint: '请重新完成设备码授权；Cookie 模式用户请检查 BDUSS/STOKEN 是否失效。', recoverable: true, category: 'auth' },
  '31034': { zh: '命中接口限流', hint: '将自动退避重试；可调高 requestIntervalMs 或降低并发。', recoverable: true, category: 'ratelimit' },
  '31039': { zh: '操作过于频繁', hint: '稍后自动恢复（冷却约 60s）；避免短时间内大量触发同步。', recoverable: true, category: 'ratelimit' },
  '31045': { zh: '目录不存在', hint: '插件会自动创建目录后重试，无需干预。', recoverable: true, category: 'notfound' },
  '31061': { zh: '文件已存在', hint: '通常可安全跳过；如非预期请检查是否重复同步。', recoverable: true, category: 'conflict' },
  '31062': { zh: '文件名不合法', hint: '修改本地文件名避开非法字符后重试。', recoverable: false, category: 'param' },
  '31200': { zh: '秒传失败', hint: '将自动降级为普通分片上传，无需干预。', recoverable: true, category: 'unknown' },
  '31326': { zh: '网盘容量不足', hint: '清理网盘空间或升级会员后重试。', recoverable: false, category: 'quota' },
  '31363': { zh: '命中安全策略，账号被限制', hint: '账号/设备暂时受限，请稍后重试或联系百度网盘客服。', recoverable: false, category: 'security' },
  '42111': { zh: '上传分片 MD5 不一致', hint: '分片校验失败，将自动重传该分片。', recoverable: true, category: 'unknown' },
  '42112': { zh: '分片上传被中断', hint: '已记录断点，将自动续传。', recoverable: true, category: 'network' },
  '50305': { zh: 'access_token 无效或已过期', hint: '请重新完成设备码授权（OpenAPI 模式）。', recoverable: true, category: 'auth' },
};

/** 错误分类码 → 兜底说明（用于 errno 不在字典中的情况，对齐 errnoToCode） */
export const CODE_FALLBACK: Record<string, ErrorInfo> = {
  AUTH_FAILED: { zh: '鉴权失败', hint: '重新授权或检查 Cookie；OpenAPI 模式请刷新 access_token。', recoverable: true, category: 'auth' },
  QUOTA: { zh: '容量/配额不足', hint: '清理网盘空间或升级会员。', recoverable: false, category: 'quota' },
  RATE_LIMIT: { zh: '接口限流', hint: '自动退避重试；降低并发或提高请求间隔。', recoverable: true, category: 'ratelimit' },
  CONFLICT: { zh: '资源已存在/冲突', hint: '通常由合并策略自动处理。', recoverable: true, category: 'conflict' },
  NOT_FOUND: { zh: '资源不存在/无权限', hint: '插件会自动重建后重试。', recoverable: true, category: 'notfound' },
  UNKNOWN: { zh: '未知错误', hint: '请收集诊断信息反馈开发者。', recoverable: false, category: 'unknown' },
  NETWORK: { zh: '网络异常', hint: '检查网络后重试，插件会自动退避。', recoverable: true, category: 'network' },
};

export interface Diagnosis {
  errno?: number;
  code: string;
  category: ErrorCategory;
  zh: string;
  hint: string;
  recoverable: boolean;
}

/** 由 errno 给出诊断；未知 errno 用分类码兜底 */
export function diagnoseErrno(errno: number, code = 'UNKNOWN'): Diagnosis {
  const info = ERROR_DICT[errno] ?? CODE_FALLBACK[code] ?? CODE_FALLBACK.UNKNOWN;
  return { errno, code, ...info };
}

/** 由分类码给出诊断（无 errno 时，如网络异常） */
export function diagnoseCode(code: string): Diagnosis {
  const info = CODE_FALLBACK[code] ?? CODE_FALLBACK.UNKNOWN;
  return { code, category: info.category, zh: info.zh, hint: info.hint, recoverable: info.recoverable };
}

/** 由任意 Error 推断诊断：识别 BaiduApiError 的 errno/code，其余按网络/未知处理 */
export function diagnoseError(err: unknown): Diagnosis {
  const e = err as { errno?: number; code?: string; name?: string; message?: string } | null;
  if (e && typeof e === 'object') {
    if (typeof e.errno === 'number') return diagnoseErrno(e.errno, e.code ?? 'UNKNOWN');
    if (typeof e.code === 'string') return diagnoseCode(e.code);
    if (e.name === 'BaiduApiError') return diagnoseCode('UNKNOWN');
  }
  // 网络层异常（requestUrl 抛出的连接/超时/DNS 失败无 errno）
  if (e?.message && /network|timeout|fetch|ECONN|ENOTFOUND|aborted/i.test(e.message)) {
    return diagnoseCode('NETWORK');
  }
  return diagnoseCode('UNKNOWN');
}

/** 由一段错误信息文本（如日志/异常 message）提取 errno/code 并给出诊断。
 *  用于在只拿到字符串（而非 Error 对象）的上下文（如同步结果汇总）中复用中文知识库。 */
export function diagnoseByMessage(msg: string): Diagnosis | null {
  if (!msg) return null;
  const errnoM = msg.match(/errno=(-?\d+)/i);
  if (errnoM) {
    const codeM = msg.match(/code=(\w+)/i);
    return diagnoseErrno(Number(errnoM[1]), codeM?.[1] ?? 'UNKNOWN');
  }
  const codeM = msg.match(/\b(NOT_SUPPORTED|AUTH_FAILED|RATE_LIMIT|NETWORK|TIMEOUT|QUOTA|SERVER)\b/);
  if (codeM) return diagnoseCode(codeM[1]);
  return null;
}

