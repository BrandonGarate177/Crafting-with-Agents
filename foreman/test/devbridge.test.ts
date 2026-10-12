// The DevBridge client against a local WebSocket server that speaks the mod's frames: a dev.hello on
// connect, then one reply per request, matched by id.
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { DEFAULT_DEV_PORT, DevBridge, DevBridgeStamper, devBridgePort } from '../src/devbridge.js';

type Frame = { id: string; type: string; cmd?: string };
/** The reply fields for a request, or undefined to answer later (or never) through `reply`. */
type Answer = (req: Frame, reply: (fields: Record<string, unknown>) => void) => Record<string, unknown> | undefined;

const servers: WebSocketServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    for (const c of s.clients) c.terminate();
    await new Promise((r) => s.close(r));
  }
});

/** A fake DevBridge that answers each request through `answer`. */
async function fakeBridge(answer: Answer, opts: { hello?: boolean } = {}): Promise<{ port: number; frames: Frame[] }> {
  const frames: Frame[] = [];
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  servers.push(wss);
  await new Promise((r) => wss.once('listening', r));
  wss.on('connection', (ws) => {
    if (opts.hello !== false) ws.send(JSON.stringify({ type: 'dev.hello', protocol: 1, minecraft: '26.3', inWorld: true }));
    ws.on('message', (data) => {
      const req = JSON.parse(String(data)) as Frame;
      frames.push(req);
      const reply = (fields: Record<string, unknown>) => ws.send(JSON.stringify({ id: req.id, type: req.type, ...fields }));
      const res = answer(req, reply);
      if (res) reply(res);
    });
  });
  return { port: (wss.address() as net.AddressInfo).port, frames };
}

const ran = (req: Frame) => ({ ok: true, cmd: req.cmd, messages: ['Successfully filled 64 block(s)'], success: true, result: 64 });

describe('DevBridge client', () => {
  it('sends each command as a dev.command request, in order, over one connection', async () => {
    const { port, frames } = await fakeBridge(ran);
    const stamper = new DevBridgeStamper({ port });
    await stamper.send('/fill 30 64 10 38 64 18 minecraft:cobblestone');
    await stamper.send('/fill 31 65 11 37 68 17 minecraft:air');
    stamper.close();
    expect(frames).toEqual([
      { id: '1', type: 'dev.command', cmd: '/fill 30 64 10 38 64 18 minecraft:cobblestone' },
      { id: '2', type: 'dev.command', cmd: '/fill 31 65 11 37 68 17 minecraft:air' },
    ]);
  });

  it('connects again after close', async () => {
    const { port, frames } = await fakeBridge(ran);
    const stamper = new DevBridgeStamper({ port });
    await stamper.send('/fill 0 64 0 0 64 0 minecraft:glass');
    stamper.close();
    await stamper.send('/fill 1 64 1 1 64 1 minecraft:glass');
    stamper.close();
    // a fresh connection numbers its requests from 1 again
    expect(frames.map((f) => f.id)).toEqual(['1', '1']);
  });

  it('treats a fill over matching blocks ("No blocks were filled") as done', async () => {
    const { port } = await fakeBridge((req) => ({ ok: true, cmd: req.cmd, messages: ['No blocks were filled'], success: false, result: 0 }));
    const bridge = await DevBridge.connect({ port });
    await expect(bridge.command('/fill 0 64 0 3 64 3 minecraft:cobblestone')).resolves.toBeUndefined();
    bridge.close();
  });

  it('rejects a command that did not run, and an ok:false reply', async () => {
    const { port } = await fakeBridge((req) =>
      req.cmd!.includes('bad') ? { ok: false, error: "field 'cmd' must be a non-empty string" } : { ok: true, cmd: req.cmd, messages: ['That position is not loaded'], success: false, result: null },
    );
    const bridge = await DevBridge.connect({ port });
    await expect(bridge.command('/fill 0 64 0 3 64 3 minecraft:glass')).rejects.toThrow('/fill 0 64 0 3 64 3 minecraft:glass did not run: That position is not loaded');
    await expect(bridge.command('/bad')).rejects.toThrow("/bad failed: field 'cmd' must be a non-empty string");
    bridge.close();
  });

  it('matches replies by id when they come back out of order', async () => {
    const held: Array<() => void> = [];
    const { port } = await fakeBridge((req, reply) => {
      held.push(() => reply({ ok: true, which: req.cmd }));
      if (held.length === 2) held.reverse().forEach((send) => send());
      return undefined;
    });
    const bridge = await DevBridge.connect({ port });
    const [a, b] = await Promise.all([bridge.request('dev.command', { cmd: 'a' }), bridge.request('dev.command', { cmd: 'b' })]);
    expect(a.which).toBe('a');
    expect(b.which).toBe('b');
    bridge.close();
  });

  it('fails fast when nothing listens on the port', async () => {
    const port = await freePort();
    const stamper = new DevBridgeStamper({ port, connectTimeoutMs: 2000 });
    const t0 = Date.now();
    await expect(stamper.send('/fill 0 64 0 0 64 0 minecraft:glass')).rejects.toThrow(`DevBridge not reachable on ws://127.0.0.1:${port}`);
    expect(Date.now() - t0).toBeLessThan(2500);
  });

  it('gives up when the server never says dev.hello', async () => {
    const { port } = await fakeBridge(ran, { hello: false });
    const t0 = Date.now();
    await expect(DevBridge.connect({ port, connectTimeoutMs: 300 })).rejects.toThrow(/no dev\.hello within 300 ms/);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('reads the port from AGENTCRAFT_DEV_PORT', () => {
    expect(devBridgePort({})).toBe(DEFAULT_DEV_PORT);
    expect(devBridgePort({ AGENTCRAFT_DEV_PORT: '7999' })).toBe(7999);
    expect(devBridgePort({ AGENTCRAFT_DEV_PORT: 'seven' })).toBe(DEFAULT_DEV_PORT);
    expect(devBridgePort({ AGENTCRAFT_DEV_PORT: '' })).toBe(DEFAULT_DEV_PORT);
  });
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}
