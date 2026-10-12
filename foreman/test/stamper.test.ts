// Stamp on merge: Merge on a zone task sends the parser's fills for its blueprint to the stamper, in
// order. The merge stands whatever happens to the stamp. A FakeStamper (helpers.ts) stands in for the
// game; the last test uses the real DevBridge client against a port nothing listens on.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseBlueprint } from '../src/blueprint.js';
import { DevBridgeStamper } from '../src/devbridge.js';
import { MERGE_OPTIONS, type FeedItem, type Task, type ZoneLetter } from '../src/protocol.js';
import { demoRepo, FakeStamper, makeForeman, rmrf, tempDir, type Harness } from './helpers.js';

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmrf(dir);
});

/** A Foreman with a fresh demo repo, so every test's blueprint is a change to merge. */
async function boot(stamper?: DevBridgeStamper): Promise<Harness> {
  const home = tempDir();
  const repoPath = await demoRepo();
  dirs.push(home, path.dirname(repoPath));
  const h = makeForeman(home, ['--backend', 'sim'], stamper ? { stamper } : {});
  await h.fm.repos.add(repoPath);
  return h;
}

/** A task in review whose worktree holds `files`, merged through a Merge answer. */
async function merge(h: Harness, files: Record<string, string>, zone?: ZoneLetter): Promise<Task> {
  const fm = h.fm;
  const t = fm.tasks.create({ title: zone ? `Zone ${zone}: shop` : 'Notes', createdBy: 'marlow', repoId: 'demo-app', assignee: 'kit', ...(zone ? { zone: fm.zone(zone)! } : {}) });
  const wt = await fm.repos.createWorktree('demo-app', 'kit', t);
  fm.tasks.update(t.id, { worktree: wt.id });
  fm.tasks.setStatus(t.id, 'doing');
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(wt.path, rel)), { recursive: true });
    fs.writeFileSync(path.join(wt.path, rel), text);
  }
  fm.tasks.setStatus(t.id, 'review');
  const d = fm.createDecision({ agentId: 'marlow', kind: 'merge', question: `Merge ${t.id}?`, options: [...MERGE_OPTIONS], repoId: 'demo-app', worktree: wt.id, taskId: t.id });
  await fm.answerDecision(d.id, 'Merge');
  expect(fm.decisions.get(d.id)!.status).toBe('answered');
  return fm.tasks.require(t.id);
}

const feed = (h: Harness): FeedItem[] => h.events.flatMap((e) => (e.type === 'feed.add' ? [e.item] : []));
const notices = (h: Harness, level: string): string[] => h.events.flatMap((e) => (e.type === 'notify' && e.level === level ? [e.text] : []));

// zone B of the default site is x 30..45, y 64..79, z 10..23
const BLUEPRINT = JSON.stringify({
  zone: 'B',
  boxes: [
    { from: [0, 0, 0], to: [8, 0, 8], block: 'minecraft:cobblestone' },
    { from: [0, 1, 0], to: [8, 4, 8], block: 'minecraft:spruce_planks' },
    { from: [1, 1, 1], to: [7, 4, 7], block: 'minecraft:air' },
  ],
});

describe('stamp on merge', () => {
  it('sends the parser\'s fills for a merged zone, in order, and says so in the feed', async () => {
    const h = await boot();
    const stamper = h.stamper as FakeStamper;
    const t = await merge(h, { 'zones/B.json': BLUEPRINT }, 'B');
    expect(t.status).toBe('done');
    expect(stamper.sent).toEqual([
      '/fill 30 64 10 38 64 18 minecraft:cobblestone',
      '/fill 30 65 10 38 68 18 minecraft:spruce_planks',
      '/fill 31 65 11 37 68 17 minecraft:air',
    ]);
    const bp = parseBlueprint(BLUEPRINT, t.zone!);
    expect(bp.ok && bp.fills).toEqual(stamper.sent);
    expect(stamper.closes).toBe(1);
    const lines = feed(h).filter((f) => f.kind === 'merge').map((f) => f.text);
    expect(lines[0]).toMatch(/^Merged agentcraft\/kit\/t1/);
    expect(lines[1]).toBe('Stamped zone B: 3 fills');
    expect(feed(h).some((f) => f.kind === 'error')).toBe(false);
    await h.fm.close();
  });

  it('sends nothing for a task without a zone', async () => {
    const h = await boot();
    const stamper = h.stamper as FakeStamper;
    // even with a blueprint file in the change: no zone, no stamp
    const t = await merge(h, { 'NOTES.md': 'plain notes\n', 'zones/C.json': BLUEPRINT.replace('"B"', '"C"') });
    expect(t.status).toBe('done');
    expect(stamper.sent).toEqual([]);
    expect(stamper.closes).toBe(0);
    expect(feed(h).map((f) => f.text).filter((s) => /stamp/i.test(s))).toEqual([]);
    await h.fm.close();
  });

  it('keeps the merge when the bridge rejects, and records why the zone was not stamped', async () => {
    const h = await boot();
    const stamper = h.stamper as FakeStamper;
    stamper.failAt = 0;
    const t = await merge(h, { 'zones/B.json': BLUEPRINT }, 'B');
    expect(t.status).toBe('done');
    expect(stamper.sent).toEqual([]);
    expect(stamper.closes).toBe(1);
    const errors = feed(h).filter((f) => f.kind === 'error').map((f) => f.text);
    expect(errors).toEqual(['Zone B not stamped: DevBridge not reachable on ws://127.0.0.1:7879 (connect ECONNREFUSED 127.0.0.1:7879)']);
    expect(notices(h, 'warn')).toEqual(errors);
    expect(feed(h).some((f) => f.kind === 'merge' && f.text.startsWith('Merged '))).toBe(true);
    await h.fm.close();
  });

  it('stops at the first failed fill and says how far it got', async () => {
    const h = await boot();
    const stamper = h.stamper as FakeStamper;
    stamper.failAt = 2;
    stamper.failWith = 'DevBridge connection closed';
    const t = await merge(h, { 'zones/B.json': BLUEPRINT }, 'B');
    expect(t.status).toBe('done');
    expect(stamper.sent).toHaveLength(2);
    expect(feed(h).filter((f) => f.kind === 'error').map((f) => f.text)).toEqual(['Zone B stamped only partly (2 of 3 fills): DevBridge connection closed']);
    await h.fm.close();
  });

  it('keeps the merge when the blueprint does not parse, and sends nothing', async () => {
    const h = await boot();
    const stamper = h.stamper as FakeStamper;
    const t = await merge(h, { 'zones/B.json': '{ "zone": "B", "boxes": [' }, 'B');
    expect(t.status).toBe('done');
    expect(stamper.sent).toEqual([]);
    const errors = feed(h).filter((f) => f.kind === 'error').map((f) => f.text);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^Zone B not stamped: zones\/B\.json: not valid JSON/);
    expect(notices(h, 'warn')).toEqual(errors);
    await h.fm.close();
  });

  it('records a zone task merged without its blueprint as not stamped', async () => {
    const h = await boot();
    const stamper = h.stamper as FakeStamper;
    const t = await merge(h, { 'NOTES.md': 'forgot the blueprint\n' }, 'D');
    expect(t.status).toBe('done');
    expect(stamper.sent).toEqual([]);
    expect(feed(h).filter((f) => f.kind === 'error').map((f) => f.text)).toEqual(['Zone D not stamped: zones/D.json: not in the merged commit']);
    await h.fm.close();
  });

  it('stamps a blueprint with clamped and replaced boxes, and the merge note carries the parser\'s notes', async () => {
    const h = await boot();
    const stamper = h.stamper as FakeStamper;
    const noted = JSON.stringify({
      zone: 'B',
      boxes: [
        { from: [0, 0, 0], to: [99, 0, 2], block: 'minecraft:cobblestone' },
        { from: [0, 1, 0], to: [1, 1, 1], block: 'minecraft:gold_block' },
      ],
    });
    const t = await merge(h, { 'zones/B.json': noted }, 'B');
    expect(t.status).toBe('done');
    // the stamper sends exactly the clamped, replaced fills: nothing past x 45, no gold
    expect(stamper.sent).toEqual(['/fill 30 64 10 45 64 12 minecraft:cobblestone', '/fill 30 65 10 31 65 11 minecraft:stone_bricks']);
    const bp = parseBlueprint(noted, t.zone!, 'zones/B.json');
    expect(bp.ok).toBe(true);
    if (!bp.ok) return;
    expect(bp.notes).toHaveLength(2);
    const stamped = feed(h).find((f) => f.kind === 'merge' && f.text.startsWith('Stamped'))!;
    expect(stamped.text).toBe(`Stamped zone B: 2 fills. ${bp.notes.join(' ')}`);
    expect(stamped.text).toMatch(/clamped/);
    expect(stamped.text).toMatch(/not in the palette, used minecraft:stone_bricks/);
    await h.fm.close();
  });

  it('does not hold up a merge when the game is closed (real DevBridge client, nothing listening)', async () => {
    const port = await freePort();
    const h = await boot(new DevBridgeStamper({ port, connectTimeoutMs: 2000 }));
    const t0 = Date.now();
    const t = await merge(h, { 'zones/B.json': BLUEPRINT }, 'B');
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(t.status).toBe('done');
    const errors = feed(h).filter((f) => f.kind === 'error').map((f) => f.text);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(new RegExp(`^Zone B not stamped: DevBridge not reachable on ws://127\\.0\\.0\\.1:${port} `));
    await h.fm.close();
  });
});

/** A localhost port that was free a moment ago. */
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
