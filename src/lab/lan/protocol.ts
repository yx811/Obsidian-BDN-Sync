/**
 * 局域网 P2P 同步协议消息定义（#5.10）
 *
 * 所有消息均为「请求 → 响应」一对一模型：客户端（发起同步的设备）发出带 id 的请求，
 * 服务端（被同步的对端设备）回带相同 id 的响应。引擎对 SyncBackend 的每次调用对应一次
 * 请求/响应往返。消息体为 JSON，传输层（transport.ts）负责长度分帧与（可选的）AES-GCM 加密。
 */

export interface LanTreeEntry {
  path: string;
  size: number;
  mtime: number;
  fsId: string;
}

/**
 * 请求类消息（由客户端发起，带唯一 id）。
 * 注：远程索引不单独设计消息，而是复用 file_get / file_put 走「特殊路径 `.bdnsync/index.json`」，
 * 这样服务端是一个与内容无关的纯文件仓储，加密完全由客户端把控（与云端 BaiduAdapter 模型一致）。
 */
export type LanReq =
  | { id: number; t: 'hello'; deviceId: string; name: string; tcpPort: number }
  | { id: number; t: 'list_tree' }
  | { id: number; t: 'file_get'; path: string; hash?: string }
  | { id: number; t: 'file_put'; path: string; contentB64: string; hash: string }
  | { id: number; t: 'delete'; paths: string[] }
  | { id: number; t: 'rename'; oldRel: string; newRel: string };

/** 响应类消息（服务端回带相同 id） */
export type LanResp =
  | { id: number; t: 'tree'; entries: LanTreeEntry[] }
  | { id: number; t: 'file_data'; contentB64: string; hash: string }
  | { id: number; t: 'file_missing' }
  | { id: number; t: 'ok' }
  | { id: number; t: 'error'; message: string };

export type LanMsg = LanReq | LanResp;

/** 序列化（明文 JSON）。加密由 transport 在分帧前完成。 */
export function encodeMsg(msg: LanMsg): string {
  return JSON.stringify(msg);
}

export function decodeMsg(text: string): LanMsg {
  return JSON.parse(text) as LanMsg;
}
