// 局域网 P2P 同步（#5.10）loopback 集成测试
//
// 验证口径（与规划确认一致）：在单机内启动一个真实 LanPeer 服务 + 两个真实 SyncEngine
// （各自独立 LocalStore 命名空间），通过 127.0.0.1 TCP 来回同步，覆盖：
//   1) 设备A 把 Vault 推送到对端 → 文件真实落盘到对端数据目录；
//   2) 设备B（空 Vault）从同一对端拉回 → 内容逐字节一致（loopback 双向）；
//   3) 开启信道加密 + 端到端加密后，对端落盘不是明文；
//   4) UDP 发现信标的 encode/decode 往返一致。
//
// 不依赖真实网络/百度云；依赖 Node 内建模块，通过 createRequire 注入 globalThis.require 供 ESM 测试环境使用。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createRequire } from 'module';
import { SyncEngine, type SyncResult } from '../src/sync/engine';
import { LocalStore } from '../src/storage/local-store';
import { MemDataAdapter } from './mem-data-adapter';
import { DEFAULT_SETTINGS, type BDNSyncSettings } from '../src/types';
import { LanBackend, LanPeer } from '../src/lab/lan/lan-backend';
import { encodeBeacon, decodeBeacon, type LanPeerInfo } from '../src/lab/lan/discovery';
import { Encryptor } from '../src/crypto/encryption';

// 让依赖 Node 内建的 LAN 模块在 vitest (ESM) 下可用
const req = createRequire(import.meta.url);
if (!(globalThis as { require?: unknown }).require) {
  (globalThis as { require?: unknown }).require = req;
}

function makeSettings(overrides: Partial<BDNSyncSettings> = {}): BDNSyncSettings {
  return { ...DEFAULT_SETTINGS, deviceId: 'dev-lan', deviceName: 'LanTest', ...overrides };
}
function dec(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}

function makeStatusBar(): any {
  return {
    setSyncing: vi.fn(),
    setDone: vi.fn(),
    setError: vi.fn(),
    setIdle: vi.fn(),
    setProgress: vi.fn(),
    setConflicts: vi.fn(),
  };
}

/**
 * 组装一个「以 LanBackend 为远端」的引擎（复用真实 SyncEngine + 真实 LocalStore）。
 * 每个引擎使用独立的 LocalStore 命名空间，避免与云端索引互相干扰。
 */
function lanEngine(
  vault: MemDataAdapter,
  settings: BDNSyncSettings,
  backend: LanBackend,
  storeDir: string,
): SyncEngine {
  const store = new LocalStore(vault as any, storeDir);
  return new SyncEngine(
    { vault: { adapter: vault as any, getName: () => 'Vault' } } as any,
    () => settings,
    backend,
    store,
    makeStatusBar(),
    async () => 'merge',
    () => {},
    async () => 'proceed',
  );
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'bdn-lan-'));
});
afterEach(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('局域网 P2P 同步（loopback 集成）', () => {
  it(
    '设备A 推送到对端 → 设备B 从对端拉回，内容逐字节一致',
    async () => {
      const peerDir = join(tmp, 'peer');
      const peer = new LanPeer({ peerDataDir: peerDir, port: 0, passphrase: '' });
      await peer.listen();
      const port = peer.port;

      // —— 设备 A：含子目录的 Vault，推送到对端 ——
      const vaultA = new MemDataAdapter({
        'note-a.md': '# A\nhello from A',
        'sub/note-b.md': 'second file',
      });
      const backendA = new LanBackend({ host: '127.0.0.1', port, passphrase: '', encryptor: null });
      const engineA = lanEngine(vaultA, makeSettings(), backendA, '.obsidian/plugins/bdnsync-lan-a');

      const resA = (await engineA.fullSync('manual')) as SyncResult;
      expect(resA.uploaded).toBe(2);

      // 对端落盘校验（未加密信道 → 明文）
      expect(existsSync(join(peerDir, 'vault', 'note-a.md'))).toBe(true);
      expect(dec(new Uint8Array(readFileSync(join(peerDir, 'vault', 'note-a.md'))))).toBe(
        '# A\nhello from A',
      );
      expect(existsSync(join(peerDir, 'vault', 'sub', 'note-b.md'))).toBe(true);

      // —— 设备 B：空 Vault，从同一对端拉回 ——
      const vaultB = new MemDataAdapter({});
      const backendB = new LanBackend({ host: '127.0.0.1', port, passphrase: '', encryptor: null });
      const engineB = lanEngine(vaultB, makeSettings(), backendB, '.obsidian/plugins/bdnsync-lan-b');

      const resB = (await engineB.fullSync('manual')) as SyncResult;
      expect(resB.downloaded).toBe(2);
      expect(vaultB.getBinary('/note-a.md') ? dec(vaultB.getBinary('/note-a.md')!) : '').toBe(
        '# A\nhello from A',
      );
      expect(dec(vaultB.getBinary('/sub/note-b.md')!)).toBe('second file');

      peer.close();
    },
    30000,
  );

  it(
    '开启信道 + 端到端加密后，对端落盘为非明文',
    async () => {
      const peerDir = join(tmp, 'peer2');
      const peer = new LanPeer({ peerDataDir: peerDir, port: 0, passphrase: 'channel-secret' });
      await peer.listen();
      const port = peer.port;

      const vaultA = new MemDataAdapter({ 'secret.md': 'top secret content' });
      const encryptor = new Encryptor('file-pw'); // 端到端加密
      const backendA = new LanBackend({
        host: '127.0.0.1',
        port,
        passphrase: 'channel-secret',
        encryptor,
      });
      const engineA = lanEngine(vaultA, makeSettings(), backendA, '.obsidian/plugins/bdnsync-lan-c');

      const res = (await engineA.fullSync('manual')) as SyncResult;
      expect(res.uploaded).toBe(1);

      // 信道(AES-GCM) + 端到端(AES-GCM) 双重加密，落盘绝不含明文
      const raw = readFileSync(join(peerDir, 'vault', 'secret.md'));
      expect(raw.toString('utf8')).not.toContain('top secret content');

      peer.close();
    },
    30000,
  );

  it(
    '删除同步：设备A 删除文件后，对端对应文件被删除',
    async () => {
      const peerDir = join(tmp, 'peer3');
      const peer = new LanPeer({ peerDataDir: peerDir, port: 0, passphrase: '' });
      await peer.listen();
      const port = peer.port;

      const vaultA = new MemDataAdapter({ 'keep.md': 'keep', 'drop.md': 'drop me' });
      const backendA = new LanBackend({ host: '127.0.0.1', port, passphrase: '', encryptor: null });
      const engineA = lanEngine(vaultA, makeSettings(), backendA, '.obsidian/plugins/bdnsync-lan-d');
      await engineA.fullSync('manual');

      // 删除 drop.md 并再次同步
      vaultA.remove('drop.md');
      const res2 = (await engineA.fullSync('manual')) as SyncResult;
      expect(res2.deletedRemote).toBe(1);
      expect(existsSync(join(peerDir, 'vault', 'drop.md'))).toBe(false);
      expect(existsSync(join(peerDir, 'vault', 'keep.md'))).toBe(true);

      peer.close();
    },
    30000,
  );

  it(
    '拒绝越界路径（防护 ../ 穿越对端数据目录）',
    async () => {
      const peerDir = join(tmp, 'peer-sec');
      const peer = new LanPeer({ peerDataDir: peerDir, port: 0, passphrase: '' });
      await peer.listen();
      const port = peer.port;
      const backend = new LanBackend({
        host: '127.0.0.1',
        port,
        passphrase: '',
        encryptor: null,
        timeoutMs: 5000,
      });
      // 尝试以 ../ 逃出对端命名空间
      let threw = false;
      try {
        await backend.upload('../escape.md', new TextEncoder().encode('payload'), {});
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
      // 确认没有写到 peer 目录之外
      expect(existsSync(join(peerDir, '..', 'escape.md'))).toBe(false);
      backend.close();
      peer.close();
    },
    15000,
  );

  it(
    '信道口令不一致应在超时前快速失败而非无限挂起',
    async () => {
      const peerDir = join(tmp, 'peer-pw');
      const peer = new LanPeer({ peerDataDir: peerDir, port: 0, passphrase: 'right-pw' });
      await peer.listen();
      const port = peer.port;
      // 客户端用错误口令 → 每帧解密失败 → 旧实现会无限挂起；修复后应超时拒绝
      const backend = new LanBackend({
        host: '127.0.0.1',
        port,
        passphrase: 'wrong-pw',
        encryptor: null,
        timeoutMs: 4000,
      });
      const start = Date.now();
      let err = '';
      try {
        await backend.listTree();
      } catch (e) {
        err = e instanceof Error ? e.message : String(e);
      }
      const elapsed = Date.now() - start;
      expect(err).toContain('超时');
      expect(elapsed).toBeLessThan(12000); // 远小于"无限"，且给足超时本身的余量
      backend.close();
      peer.close();
    },
    15000,
  );
});

describe('局域网发现信标', () => {
  it('encode/decode 往返一致', () => {
    const info: LanPeerInfo = { deviceId: 'd1', name: 'N', tcpPort: 51820, ts: 123 };
    const back = decodeBeacon(encodeBeacon(info));
    expect(back).toEqual(info);
  });
  it('非法信标返回 null', () => {
    expect(decodeBeacon('not json')).toBeNull();
    expect(decodeBeacon('{}')).toBeNull();
  });
});
