// DevBridge client: the mod's dev control WebSocket on ws://127.0.0.1:7879 (AGENTCRAFT_DEV_PORT).
// The stamper uses it to send a merged zone's `/fill` commands as `dev.command` requests.
//
// Frames match tools/lib/devclient.mjs and mod/DEV.md "DevBridge": the server greets with
// `{type: "dev.hello"}` right after the handshake, a request is `{id, type, ...fields}`, and the reply
// echoes the id as `{id, type, ok: true, ...result}` or `{id, type, ok: false, error}`.
// Unlike devclient.mjs there is one connect attempt with a short timeout and no retry loop: when the
// game is closed, a merge must not wait for it.
import WebSocket from 'ws';

export const DEFAULT_DEV_PORT = 7879;

/** The DevBridge port from AGENTCRAFT_DEV_PORT, or 7879 when it is unset or not a port number. */
export function devBridgePort(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.AGENTCRAFT_DEV_PORT);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_DEV_PORT;
}

export class DevBridgeError extends Error {
  override name = 'DevBridgeError';
}

export interface DevReply {
  id: string;
  type: string;
  ok: boolean;
  error?: string;
  [field: string]: unknown;
}

export interface DevBridgeOptions {
  port?: number;
  host?: string;
  /** handshake plus dev.hello; default 3 s */
  connectTimeoutMs?: number;
}

interface Pending {
  resolve: (r: DevReply) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class DevBridge {
  private nextId = 1;
  private readonly pending = new Map<string, Pending>();
  private closed = false;

  private constructor(private readonly ws: WebSocket) {
    ws.on('message', (data) => this.onMessage(data));
    ws.on('close', () => {
      this.closed = true;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new DevBridgeError('DevBridge connection closed'));
      }
      this.pending.clear();
    });
    ws.on('error', () => {});
  }

  /** Connect once; rejects when nothing answers with dev.hello within the timeout. */
  static connect(opts: DevBridgeOptions = {}): Promise<DevBridge> {
    const url = `ws://${opts.host ?? '127.0.0.1'}:${opts.port ?? devBridgePort()}`;
    const timeoutMs = opts.connectTimeoutMs ?? 3000;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { handshakeTimeout: timeoutMs });
      let settled = false;
      const fail = (why: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          ws.terminate();
        } catch {
          /* already gone */
        }
        reject(new DevBridgeError(`DevBridge not reachable on ${url} (${why})`));
      };
      const timer = setTimeout(() => fail(`no dev.hello within ${timeoutMs} ms`), timeoutMs);
      ws.once('error', (e) => fail(e.message || String(e)));
      ws.once('unexpected-response', (_req, res) => fail(`HTTP ${res.statusCode}`));
      ws.once('message', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ws.removeAllListeners('error');
        resolve(new DevBridge(ws));
      });
    });
  }

  private onMessage(data: WebSocket.RawData): void {
    let msg: { id?: unknown };
    try {
      msg = JSON.parse(String(data)) as { id?: unknown };
    } catch {
      return;
    }
    if (msg.id == null) return; // events such as dev.hello
    const p = this.pending.get(String(msg.id));
    if (!p) return;
    this.pending.delete(String(msg.id));
    clearTimeout(p.timer);
    p.resolve(msg as DevReply);
  }

  /** Send one request and resolve with the raw reply, `ok: false` included. */
  request(type: string, fields: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<DevReply> {
    if (this.closed) return Promise.reject(new DevBridgeError('DevBridge connection closed'));
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new DevBridgeError(`${type} got no reply within ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ ...fields, id, type }));
    });
  }

  /**
   * Run a server command in the game. Rejects unless it ran: an `ok: false` reply, or a command
   * that reports `success: false`. A `/fill` over blocks that already match reports
   * "No blocks were filled", which counts as done (mod/DEV.md).
   */
  async command(cmd: string): Promise<void> {
    const res = await this.request('dev.command', { cmd });
    if (!res.ok) throw new DevBridgeError(`${cmd} failed: ${res.error ?? 'no error given'}`);
    if (res.success !== false) return;
    const messages = Array.isArray(res.messages) ? res.messages.map(String) : [];
    if (messages.some((m) => /no blocks were filled/i.test(m))) return;
    throw new DevBridgeError(`${cmd} did not run${messages.length ? `: ${messages.join(' ')}` : ''}`);
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* already gone */
    }
  }
}

/** Where the Foreman sends a merged zone's fills. Tests pass a fake. */
export interface Stamper {
  /** Run one server command in the game; rejects when it could not be sent or did not run. */
  send(cmd: string): Promise<void>;
  /** Called after each zone's fills. The next send connects again. */
  close?(): void;
}

/** The real stamper: connects to the DevBridge on the first send and holds the socket until close(). */
export class DevBridgeStamper implements Stamper {
  private bridge: Promise<DevBridge> | undefined;

  constructor(private readonly opts: DevBridgeOptions = {}) {}

  async send(cmd: string): Promise<void> {
    this.bridge ??= DevBridge.connect(this.opts);
    let bridge: DevBridge;
    try {
      bridge = await this.bridge;
    } catch (e) {
      this.bridge = undefined;
      throw e;
    }
    await bridge.command(cmd);
  }

  close(): void {
    const b = this.bridge;
    this.bridge = undefined;
    void b?.then(
      (bridge) => bridge.close(),
      () => {},
    );
  }
}
