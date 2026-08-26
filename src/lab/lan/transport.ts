/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * 局域网传输层（#5.10）：基于 Node net 的 TCP 链路
 *
 * - 分帧：4 字节大端长度前缀 + UTF-8 负载（负载为加密后的 JSON 字符串，或明文 JSON）。
 * - 请求/响应：每条请求带唯一 id；响应回带相同 id。链路既可作为客户端（发起请求），
 *   也可作为服务端（注册 requestHandler 处理对端请求并回响应）。
 * - 信道加密由 LanCipher 在分帧前完成（AES-256-GCM）。
 * - 零依赖：net 懒加载，移动端不会执行（上层 Platform.isDesktop 守卫）。
 */

import { LanCipher } from './cipher';
import { decodeMsg, encodeMsg, type LanMsg, type LanReq } from './protocol';

function lazyNet(): any {
  const net = (globalThis as any).require?.('net');
  if (!net) throw new Error('net 模块不可用（非桌面端？）');
  return net;
}

export type LanRequestHandler = (msg: LanMsg) => Promise<LanMsg> | LanMsg;

/** 对联合类型逐成员剔除 id（Omit 对联合体会退化为空集，必须分布操作） */
type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;
export type LanReqIn = DistributiveOmit<LanReq, 'id'>;

export class LanServer {
  constructor(
    public server: any,
    public port: number,
  ) {}
  close(): void {
    try {
      this.server.close();
    } catch {
      /* ignore */
    }
  }
}

export class TcpLink {
  private buf = Buffer.alloc(0);
  private pending = new Map<number, { resolve: (m: LanMsg) => void; reject: (e: any) => void }>();
  private nextId = 1;
  private closed = false;
  private requestHandler: LanRequestHandler | null = null;

  private constructor(
    private socket: any,
    private cipher: LanCipher,
  ) {
    socket.on('data', (d: Buffer) => this.onData(d));
    socket.on('close', () => this.onClose());
    socket.on('error', (e: Error) => this.onError(e));
  }

  /** 链路是否已关闭（用于持久连接的复用判断） */
  isClosed(): boolean {
    return this.closed;
  }

  /** 作为客户端连接到对端 TCP 服务 */
  static connect(host: string, port: number, cipher: LanCipher): Promise<TcpLink> {
    return new Promise((resolve, reject) => {
      const net = lazyNet();
      const socket = net.createConnection({ host, port }, () => resolve(new TcpLink(socket, cipher)));
      socket.once('error', reject);
    });
  }

  /**
   * 作为服务端监听；对每个入站连接注册 requestHandler。
   * @param bindHost 监听地址。跨设备 LAN 同步须监听外部接口，故默认传入 undefined，
   *                 由 Node 绑定全部接口（含 IPv4/IPv6）；仅本机回环放行时再显式传 '127.0.0.1'。
   */
  static listen(
    port: number,
    cipher: LanCipher,
    handler: LanRequestHandler,
    bindHost?: string,
  ): Promise<LanServer> {
    const net = lazyNet();
    const server = net.createServer((socket: any) => {
      const link = new TcpLink(socket, cipher);
      link.requestHandler = handler;
    });
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      const onListening = () => {
        const addr = server.address();
        const actualPort = typeof addr === 'object' && addr && typeof addr.port === 'number' ? addr.port : port;
        resolve(new LanServer(server, actualPort));
      };
      if (typeof bindHost === 'string' && bindHost.length > 0) {
        server.listen(port, bindHost, onListening);
      } else {
        server.listen(port, onListening);
      }
    });
  }

  setRequestHandler(h: LanRequestHandler): void {
    this.requestHandler = h;
  }

  /**
   * 发起一次请求并等待响应（按 id 匹配）。入参无需带 id，本方法自动分配并回填。
   * 带整体超时：对端无响应 / 信道口令不一致导致解密失败丢帧时，不会无限挂起，
   * 而是以清晰错误拒绝（默认 30s，可由调用方按场景收紧，如局域网内 4~15s）。
   */
  request(msg: LanReqIn, timeoutMs = 30_000): Promise<LanMsg> {
    const id = this.nextId++;
    const full = { ...msg, id } as LanMsg;
    return new Promise<LanMsg>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `局域网请求超时（${timeoutMs}ms 内未收到对端响应，可能对方已断开或信道口令不一致）`,
          ),
        );
      }, timeoutMs);
      const onResolve = (m: LanMsg) => {
        clearTimeout(timer);
        resolve(m);
      };
      const onReject = (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      };
      this.pending.set(id, { resolve: onResolve, reject: onReject });
      this.rawSend(full).catch((e) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      });
    });
  }

  private async rawSend(msg: LanMsg): Promise<void> {
    const json = encodeMsg(msg);
    const payload = this.cipher.enabled ? this.cipher.encrypt(json) : json;
    const body = Buffer.from(payload, 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length, 0);
    await this.writeAll(Buffer.concat([header, body]));
  }

  private writeAll(buf: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.write(buf, (err?: Error) => (err ? reject(err) : resolve()));
    });
  }

  private onData(d: Buffer): void {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (this.buf.length < 4 + len) break;
      const body = this.buf.subarray(4, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      const payload = body.toString('utf8');
      let json: string;
      try {
        json = this.cipher.enabled ? this.cipher.decrypt(payload) : payload;
      } catch {
        continue; // 解密失败（口令不符/损坏帧）→ 丢弃
      }
      let msg: LanMsg;
      try {
        msg = decodeMsg(json);
      } catch {
        continue;
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: LanMsg): void {
    const pending = this.pending.get(msg.id);
    if (pending) {
      this.pending.delete(msg.id);
      pending.resolve(msg);
      return;
    }
    if (this.requestHandler) {
      Promise.resolve(this.requestHandler(msg))
        .then((resp) => this.rawSend(resp))
        .catch((e) =>
          this.rawSend({ id: msg.id, t: 'error', message: String((e as any)?.message ?? e) }),
        );
    }
    // 既非响应也非服务端 → 忽略
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      try {
        this.socket.destroy();
      } catch {
        /* ignore */
      }
    }
  }

  private onClose(): void {
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new Error('LAN 链路已关闭'));
    this.pending.clear();
  }

  private onError(e: Error): void {
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
  }
}
