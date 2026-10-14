// The city skeleton's layout (src/city.ts) and the stamp:city script, which sends it over a local
// WebSocket server that speaks the DevBridge's frames, like test/devbridge.test.ts.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { stampCity } from '../scripts/stamp-city.js';
import { type Box, cityCommands, cityLayout, CityError, MAX_CITY_COMMANDS, MAX_FILL_VOLUME, MIN_Y, STUDIO_BOX, undoCityCommands } from '../src/city.js';
import { DEFAULT_SITE, type Site } from '../src/site.js';
import { rmrf, tempDir } from './helpers.js';

const dirs: string[] = [];
const servers: WebSocketServer[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) rmrf(d);
  for (const s of servers.splice(0)) {
    for (const c of s.clients) c.terminate();
    await new Promise((r) => s.close(r));
  }
});

function temp(): string {
  const d = tempDir();
  dirs.push(d);
  return d;
}

/** The box a `/fill x1 y1 z1 x2 y2 z2 block` command covers, and its block. */
function parseFill(cmd: string): Box & { block: string } {
  const m = /^\/fill (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (\S+)$/.exec(cmd);
  if (!m) throw new Error(`not a fill: ${cmd}`);
  const [x1, y1, z1, x2, y2, z2] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  return { x1, y1, z1, x2, y2, z2, block: m[7]! };
}

const volume = (b: Box) => (b.x2 - b.x1 + 1) * (b.y2 - b.y1 + 1) * (b.z2 - b.z1 + 1);
const overlaps = (a: Box, b: Box) => a.x1 <= b.x2 && b.x1 <= a.x2 && a.y1 <= b.y2 && b.y1 <= a.y2 && a.z1 <= b.z2 && b.z1 <= a.z2;
const within = (a: Box, b: Box) => a.x1 >= b.x1 && a.x2 <= b.x2 && a.y1 >= b.y1 && a.y2 <= b.y2 && a.z1 >= b.z1 && a.z2 <= b.z2;

const shifted = (site: Site, dx: number, dz: number): Site => ({ ...site, origin: { ...site.origin, x: site.origin.x + dx, z: site.origin.z + dz } });

describe('city layout', () => {
  const layout = cityLayout(DEFAULT_SITE);
  const build = cityCommands(DEFAULT_SITE);
  const undo = undoCityCommands(DEFAULT_SITE);

  it('is all /fill commands, inside the city bounds, outside the studio box, never below y 60', () => {
    expect(layout.bounds.y1).toBeGreaterThanOrEqual(MIN_Y);
    expect(overlaps(layout.bounds, STUDIO_BOX)).toBe(false);
    for (const cmd of [...build, ...undo]) {
      const f = parseFill(cmd.replace(/\[.*$/, '')); // a sign's state and text are not coordinates
      expect(f.x1 <= f.x2 && f.y1 <= f.y2 && f.z1 <= f.z2, cmd).toBe(true);
      expect(f.y1, cmd).toBeGreaterThanOrEqual(MIN_Y);
      expect(within(f, layout.bounds), cmd).toBe(true);
      expect(overlaps(f, STUDIO_BOX), cmd).toBe(false);
      expect(volume(f), cmd).toBeLessThanOrEqual(MAX_FILL_VOLUME);
    }
  });

  it('keeps the whole city east of the studio and about 130 blocks on a side', () => {
    expect(layout.bounds.x1).toBeGreaterThan(STUDIO_BOX.x2);
    expect(layout.bounds.x2 - layout.bounds.x1 + 1).toBeGreaterThanOrEqual(110);
    expect(layout.bounds.x2 - layout.bounds.x1 + 1).toBeLessThanOrEqual(150);
    expect(layout.bounds.z2 - layout.bounds.z1 + 1).toBeGreaterThanOrEqual(110);
    expect(layout.bounds.z2 - layout.bounds.z1 + 1).toBeLessThanOrEqual(150);
    expect(layout.ground).toBe(64);
  });

  it('has a plot per spec district, and the market plot holds every slot', () => {
    expect(layout.plots.map((p) => p.district).sort()).toEqual(
      ['Docks', 'Farms outside the Wall', 'Fishing Quarter', 'Gate Road', 'Lighthouse Point', 'Market', 'Old Town', 'Shipyard', 'Town Hall Square', 'Warehouses'],
    );
    const m = layout.market;
    expect(layout.plots).toContain(m);
    expect(layout.slots.map((s) => s.letter).sort()).toEqual(['A', 'B', 'C', 'D']);
    for (const s of layout.slots) {
      // inside the outline, not on it
      expect(s.x1 > m.x1 && s.x2 < m.x2 && s.z1 > m.z1 && s.z2 < m.z2, s.letter).toBe(true);
    }
  });

  it('keeps roads clear of plots, and plots clear of each other and of the harbor', () => {
    const flat = (r: { x1: number; z1: number; x2: number; z2: number }): Box => ({ ...r, y1: 0, y2: 0 });
    const { plots, roads, basin, dockEdge } = layout;
    for (const [i, p] of plots.entries()) {
      for (const r of roads) expect(overlaps(flat(p), flat(r)), `${p.district} and a road`).toBe(false);
      for (const q of plots.slice(i + 1)) expect(overlaps(flat(p), flat(q)), `${p.district} and ${q.district}`).toBe(false);
      expect(overlaps(flat(p), flat(basin)) || overlaps(flat(p), flat(dockEdge)), p.district).toBe(false);
    }
  });

  it('stakes a two-high stone-brick post on every slot corner', () => {
    const g = layout.ground;
    const posts = build
      .filter((c) => !c.includes('['))
      .map(parseFill)
      .filter((f) => f.block === 'minecraft:stone_bricks' && f.x1 === f.x2 && f.z1 === f.z2 && f.y1 === g + 1 && f.y2 === g + 2)
      .map((f) => `${f.x1} ${f.z1}`);
    const corners = layout.slots.flatMap((s) => [`${s.x1} ${s.z1}`, `${s.x2} ${s.z1}`, `${s.x1} ${s.z2}`, `${s.x2} ${s.z2}`]);
    expect(posts.sort()).toEqual([...new Set(corners)].sort());
  });

  it('lays each slot footprint in coarse dirt and builds nothing above it but the corner posts', () => {
    const g = layout.ground;
    for (const s of layout.slots) {
      expect(build).toContain(`/fill ${s.x1} ${g} ${s.z1} ${s.x2} ${g} ${s.z2} minecraft:coarse_dirt`);
    }
    const slotAir: Box[] = layout.slots.map((s) => ({ ...s, y1: g + 1, y2: 400 }));
    const corner = (f: Box) => layout.slots.some((s) => (f.x1 === s.x1 || f.x1 === s.x2) && (f.z1 === s.z1 || f.z1 === s.z2) && f.x1 === f.x2 && f.z1 === f.z2);
    for (const cmd of build) {
      const f = parseFill(cmd.replace(/\[.*$/, ''));
      if (slotAir.some((b) => overlaps(f, b))) expect(corner(f), cmd).toBe(true);
    }
  });

  it('signs every district on its road side and every slot with its letter and name', () => {
    const signs = build.filter((c) => c.includes('oak_sign'));
    for (const p of layout.plots) expect(signs.some((s) => s.includes(`"${p.district.split(' ')[0]}`)), p.district).toBe(true);
    expect(signs.some((s) => s.includes('"Zone B","West building"'))).toBe(true);
    expect(signs).toHaveLength(layout.plots.length + layout.slots.length);
    for (const s of signs) {
      expect(s).toMatch(/ minecraft:oak_sign\[rotation=(0|4|8|12)\]\{front_text:\{messages:\["[^"]*","[^"]*","[^"]*","[^"]*"\]\},is_waxed:1b\}$/);
    }
  });

  it('digs the basin to y 62, fills water to 63 and edges it with spruce planks at 64', () => {
    const { basin, dockEdge } = layout;
    expect(build).toContain(`/fill ${basin.x1} 64 ${basin.z1} ${basin.x2} 64 ${basin.z2} minecraft:air`);
    expect(build).toContain(`/fill ${basin.x1} 62 ${basin.z1} ${basin.x2} 63 ${basin.z2} minecraft:water`);
    expect(build).toContain(`/fill ${dockEdge.x1} 64 ${dockEdge.z1} ${dockEdge.x2} 64 ${dockEdge.z2} minecraft:spruce_planks`);
    expect(dockEdge.z2 + 1).toBe(basin.z1);
  });

  it('stays under the command cap', () => {
    expect(build.length + 2).toBeLessThan(MAX_CITY_COMMANDS);
    expect(undo.length + 2).toBeLessThan(MAX_CITY_COMMANDS);
  });

  it('undoes to grass at the ground and air above over the whole city, the basin back to dirt', () => {
    const b = layout.bounds;
    expect(undo[0]).toBe(`/fill ${layout.basin.x1} 62 ${layout.basin.z1} ${layout.basin.x2} 63 ${layout.basin.z2} minecraft:dirt`);
    expect(undo[1]).toBe(`/fill ${b.x1} 64 ${b.z1} ${b.x2} 64 ${b.z2} minecraft:grass_block`);
    const air = undo.slice(2).map(parseFill);
    expect(air.every((f) => f.block === 'minecraft:air' && f.x1 === b.x1 && f.x2 === b.x2 && f.z1 === b.z1 && f.z2 === b.z2)).toBe(true);
    // contiguous from just above the ground to the top, the tallest slot included
    expect(air[0]!.y1).toBe(65);
    for (let i = 1; i < air.length; i++) expect(air[i]!.y1).toBe(air[i - 1]!.y2 + 1);
    expect(air.at(-1)!.y2).toBe(b.y2);
    expect(b.y2).toBe(64 + 16 - 1);
  });

  it('moves with the slots', () => {
    const moved = cityCommands(shifted(DEFAULT_SITE, 10, -7));
    const expected = build.map((c) =>
      c.replace(/^\/fill (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+)/, (_m, x1, y1, z1, x2, y2, z2) => `/fill ${+x1 + 10} ${y1} ${+z1 - 7} ${+x2 + 10} ${y2} ${+z2 - 7}`),
    );
    expect(moved).toEqual(expected);
  });

  it('refuses a site that reaches into the studio, digs below y 60, or has no slots', () => {
    expect(() => cityLayout({ ...DEFAULT_SITE, origin: { x: 30, y: 64, z: 10 } })).toThrow(CityError);
    expect(() => cityLayout({ ...DEFAULT_SITE, origin: { x: 30, y: 64, z: 10 } })).toThrow(/studio/);
    expect(() => cityLayout({ ...DEFAULT_SITE, origin: { x: 55, y: 61, z: 10 } })).toThrow(/below y 60/);
    expect(() => cityLayout({ origin: { x: 55, y: 64, z: 10 }, zones: {} })).toThrow(/no zone slots/);
  });

  it('escapes quotes in slot names and wraps long ones', () => {
    const site: Site = { ...DEFAULT_SITE, zones: { ...DEFAULT_SITE.zones, B: { ...DEFAULT_SITE.zones.B!, name: 'The "Big" back\\room shop with many words' } } };
    const signB = cityCommands(site).find((c) => c.includes('"Zone B"'))!;
    expect(signB).toContain('messages:["Zone B","The \\"Big\\"","back\\\\room shop","with many words"]');
  });
});

// ---------------------------------------------------------------------------------------- script

type Frame = { id: string; type: string; cmd?: string };

/** A fake DevBridge: dev.hello on connect, then one reply per request from `answer`. */
async function fakeBridge(answer: (req: Frame, n: number) => Record<string, unknown>): Promise<{ port: number; frames: Frame[] }> {
  const frames: Frame[] = [];
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  servers.push(wss);
  await new Promise((r) => wss.once('listening', r));
  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'dev.hello', protocol: 1, minecraft: '26.3', inWorld: true }));
    ws.on('message', (data) => {
      const req = JSON.parse(String(data)) as Frame;
      frames.push(req);
      ws.send(JSON.stringify({ id: req.id, type: req.type, ...answer(req, frames.length) }));
    });
  });
  return { port: (wss.address() as net.AddressInfo).port, frames };
}

const ran = (req: Frame) => ({ ok: true, cmd: req.cmd, messages: ['Successfully filled 1 block(s)'], success: true, result: 1 });

async function run(argv: string[], env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await stampCity(argv, { out: (l) => out.push(l), err: (l) => err.push(l), env, sleep: async () => {}, loadTries: 3 });
  return { code, out, err };
}

function siteFile(site: Site = DEFAULT_SITE): string {
  const f = path.join(temp(), 'site.json');
  fs.writeFileSync(f, JSON.stringify(site));
  return f;
}

describe('stamp:city', () => {
  const build = cityCommands(DEFAULT_SITE);
  const bounds = cityLayout(DEFAULT_SITE).bounds;
  const add = `/forceload add ${bounds.x1} ${bounds.z1} ${bounds.x2} ${bounds.z2}`;
  const remove = `/forceload remove ${bounds.x1} ${bounds.z1} ${bounds.x2} ${bounds.z2}`;

  it('dry-runs by default: the same output every time for the default site, nothing written, nothing sent', async () => {
    const { port, frames } = await fakeBridge(ran);
    const home = temp();
    const a = await run(['--home', home], { AGENTCRAFT_DEV_PORT: String(port) });
    const b = await run(['--home', home, '--dry-run'], { AGENTCRAFT_DEV_PORT: String(port) });
    expect(a.code).toBe(0);
    expect(a.err).toEqual([]);
    expect(b).toEqual(a);
    const cmds = a.out.filter((l) => l.startsWith('/'));
    expect(cmds).toEqual([add, ...build, remove]);
    expect(a.out.at(-1)).toBe(`${build.length + 2} commands, nothing sent (dry run). Add --go to send them to the game.`);
    expect(a.out[0]).toContain('the default site');
    expect(fs.existsSync(path.join(home, 'claude', 'site.json'))).toBe(false);
    expect(frames).toEqual([]);
  });

  it("reads the Foreman's site.json under --home and --profile", async () => {
    const home = temp();
    fs.mkdirSync(path.join(home, 'sim'));
    fs.writeFileSync(path.join(home, 'sim', 'site.json'), JSON.stringify(shifted(DEFAULT_SITE, 20, 0)));
    const { code, out } = await run(['--home', home, '--profile', 'sim']);
    expect(code).toBe(0);
    expect(out[0]).toBe(`# city skeleton for ${path.join(home, 'sim', 'site.json')}`);
    expect(out.filter((l) => l.startsWith('/')).slice(1, -1)).toEqual(cityCommands(shifted(DEFAULT_SITE, 20, 0)));
  });

  it('sends every command in order over the DevBridge with --go, with progress every 25', async () => {
    const { port, frames } = await fakeBridge(ran);
    const { code, out, err } = await run(['--go', '--site', siteFile()], { AGENTCRAFT_DEV_PORT: String(port) });
    expect(err).toEqual([]);
    expect(code).toBe(0);
    expect(frames.map((f) => f.type)).toEqual(Array(build.length + 2).fill('dev.command'));
    expect(frames.map((f) => f.cmd)).toEqual([add, ...build, remove]);
    expect(out.filter((l) => l.startsWith('sent '))).toEqual(['sent 25/91', 'sent 50/91', 'sent 75/91']);
    expect(out.at(-1)).toBe('done: 91 commands sent');
  });

  it('stops at the first failing command, says which, and still releases the chunks', async () => {
    const bad = build[9]!;
    const { port, frames } = await fakeBridge((req) => (req.cmd === bad ? { ok: true, cmd: req.cmd, messages: ['Unknown block type'], success: false, result: null } : ran(req)));
    const { code, err } = await run(['--go', '--site', siteFile()], { AGENTCRAFT_DEV_PORT: String(port) });
    expect(code).toBe(1);
    expect(err[0]).toBe(`failed at command 11 of ${build.length + 2}: ${bad}`);
    expect(err[1]).toContain('Unknown block type');
    expect(frames.map((f) => f.cmd)).toEqual([add, ...build.slice(0, 10), remove]);
  });

  it('retries a fill while its chunks load, and gives up after the last try', async () => {
    let unloaded = 2;
    const { port, frames } = await fakeBridge((req) =>
      req.cmd === build[0] && unloaded-- > 0 ? { ok: true, cmd: req.cmd, messages: ['That position is not loaded'], success: false, result: null } : ran(req),
    );
    const ok = await run(['--go', '--site', siteFile()], { AGENTCRAFT_DEV_PORT: String(port) });
    expect(ok.code).toBe(0);
    expect(frames.filter((f) => f.cmd === build[0])).toHaveLength(3);

    const never = await fakeBridge((req) => (req.cmd === build[0] ? { ok: true, cmd: req.cmd, messages: ['That position is not loaded'], success: false, result: null } : ran(req)));
    const failed = await run(['--go', '--site', siteFile()], { AGENTCRAFT_DEV_PORT: String(never.port) });
    expect(failed.code).toBe(1);
    expect(failed.err[1]).toMatch(/not loaded/);
    expect(never.frames.filter((f) => f.cmd === build[0])).toHaveLength(3);
  });

  it('carries on when the chunks are already force-loaded', async () => {
    const { port, frames } = await fakeBridge((req) => (req.cmd === add ? { ok: true, cmd: req.cmd, messages: ['No chunks were marked for force loading'], success: false, result: 0 } : ran(req)));
    const { code, err } = await run(['--go', '--site', siteFile()], { AGENTCRAFT_DEV_PORT: String(port) });
    expect(code).toBe(0);
    expect(err[0]).toMatch(/^warning: .*No chunks were marked/);
    expect(frames).toHaveLength(build.length + 2);
  });

  it('sends the undo with --undo --go', async () => {
    const { port, frames } = await fakeBridge(ran);
    const { code } = await run(['--undo', '--go', '--site', siteFile()], { AGENTCRAFT_DEV_PORT: String(port) });
    expect(code).toBe(0);
    expect(frames.map((f) => f.cmd)).toEqual([add, ...undoCityCommands(DEFAULT_SITE), remove]);
  });

  it('fails fast when the game is not running', async () => {
    const port = await freePort();
    const { code, err } = await run(['--go', '--site', siteFile()], { AGENTCRAFT_DEV_PORT: String(port) });
    expect(code).toBe(1);
    expect(err).toEqual([expect.stringContaining(`DevBridge not reachable on ws://127.0.0.1:${port}`)]);
  });

  it('refuses bad arguments and a site that reaches into the studio, sending nothing', async () => {
    const { port, frames } = await fakeBridge(ran);
    const env = { AGENTCRAFT_DEV_PORT: String(port) };
    expect((await run(['--go', '--dry-run'], env)).code).toBe(2);
    expect((await run(['--fast'], env)).code).toBe(2);
    expect((await run(['--site'], env)).code).toBe(2);
    const studio = await run(['--go', '--site', siteFile({ ...DEFAULT_SITE, origin: { x: 30, y: 64, z: 10 } })], env);
    expect(studio.code).toBe(1);
    expect(studio.err[0]).toMatch(/^city: .*studio/);
    const missing = await run(['--site', path.join(temp(), 'nope.json')], env);
    expect(missing.code).toBe(1);
    expect(frames).toEqual([]);
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
