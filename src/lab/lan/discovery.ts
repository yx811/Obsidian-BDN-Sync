/**
 * 局域网设备发现（#5.10 辅助）：基于 UDP 广播的信标（beacon）
 *
 * 设备作为「被同步对端」时，周期性广播自己的 TCP 端口；另一台设备发起 scan
 * 即可在局域网内发现对端，免手动填 IP。数据不出局域网，且信标本身不含文件内容。
 *
 * 依赖 Node dgram，全部懒加载；移动端不执行（上层 Platform.isDesktop 守卫）。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
function req(name: string): any {
  return (globalThis as any).require?.(name);
}
function getBuffer(): any {
  return (globalThis as any).Buffer ?? req('buffer')?.Buffer;
}

/** 局域网默认发现端口（与 TCP 同步端口区分） */
export const DISCOVERY_PORT = 51821;
/** 广播地址（子网下所有主机均可收到） */
const BROADCAST_ADDR = '255.255.255.255';

export interface LanPeerInfo {
  deviceId: string;
  name: string;
  /** 对端监听的 TCP 同步端口 */
  tcpPort: number;
  ts: number;
}

export function encodeBeacon(info: LanPeerInfo): string {
  return JSON.stringify({ v: 1, ...info });
}

export function decodeBeacon(text: string): LanPeerInfo | null {
  try {
    const o = JSON.parse(text);
    if (typeof o?.deviceId === 'string' && typeof o?.tcpPort === 'number') {
      return {
        deviceId: o.deviceId,
        name: typeof o.name === 'string' ? o.name : '',
        tcpPort: o.tcpPort,
        ts: typeof o.ts === 'number' ? o.ts : 0,
      };
    }
  } catch {
    /* 非法信标忽略 */
  }
  return null;
}

export class LanDiscovery {
  private socket: any = null;
  private scanSocket: any = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private seen = new Map<string, { info: LanPeerInfo; at: number }>();

  constructor(
    private deviceId: string,
    private name: string,
  ) {}

  private makeSocket(): any {
    const dgram = req('dgram');
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    // 向 255.255.255.255 发送广播前必须显式开启，否则多数平台 send 会报错（EACCES/ENETUNREACH）
    try {
      socket.setBroadcast(true);
    } catch {
      /* 个别环境不支持广播，忽略 */
    }
    return socket;
  }

  /** 持续广播本机存在（每 intervalMs 一次）。返回停止函数。 */
  startAdvertise(tcpPort: number, intervalMs = 3000): () => void {
    const socket = this.makeSocket();
    this.socket = socket;
    const buf = getBuffer().from(
      encodeBeacon({ deviceId: this.deviceId, name: this.name, tcpPort, ts: Date.now() }),
      'utf8',
    );
    const send = () =>
      socket.send(buf, 0, buf.length, DISCOVERY_PORT, BROADCAST_ADDR, () => {
        /* 忽略发送错误（部分网络禁广播） */
      });
    send();
    this.timer = setInterval(send, intervalMs);
    return () => this.stop();
  }

  /**
   * 扫描一个窗口（windowMs），收集此期间收到的对端信标。
   * @param onPeer 每发现一个新设备回调一次（去重：60s 内同一 deviceId 只回调一次）
   * @returns 窗口内发现的所有对端（去重后）
   */
  async scan(onPeer: (info: LanPeerInfo) => void, windowMs = 2500): Promise<LanPeerInfo[]> {
    const socket = this.makeSocket();
    this.scanSocket = socket;
    const startedAt = Date.now();
    // bind 失败（端口被占用等）时：error 事件若无监听会抛成未捕获异常导致崩溃；
    // 这里把它当作「本次扫描无结果」优雅降级，并阻止 promise 永不 resolve 造成的挂起。
    socket.on('error', () => {
      /* bind 失败 → 本次扫描为空 */
    });
    socket.on('message', (msg: any) => {
      const info = decodeBeacon(msg.toString('utf8'));
      if (!info || info.deviceId === this.deviceId) return;
      const prev = this.seen.get(info.deviceId);
      if (prev && Date.now() - prev.at < 60_000) return;
      this.seen.set(info.deviceId, { info, at: Date.now() });
      onPeer(info);
    });
    await new Promise<void>((resolve) => {
      try {
        socket.bind(DISCOVERY_PORT, () => resolve());
      } catch {
        resolve(); // 同步抛错（如已绑定）也优雅结束
      }
    });
    await new Promise((r) => setTimeout(r, windowMs));
    try {
      socket.close();
    } catch {
      /* ignore */
    }
    // 只返回「本次窗口内」新发现的设备，避免把历史扫描的陈旧信标混入结果
    return [...this.seen.values()]
      .filter((x) => x.at >= startedAt)
      .map((x) => x.info);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const s of [this.socket, this.scanSocket]) {
      if (s) {
        try {
          s.close();
        } catch {
          /* ignore */
        }
      }
    }
    this.socket = null;
    this.scanSocket = null;
  }
}
