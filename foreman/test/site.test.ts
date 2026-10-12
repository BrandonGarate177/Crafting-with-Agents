import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Logger } from '../src/context.js';
import { DEFAULT_SITE, loadSite, resolveZone } from '../src/site.js';
import { makeForeman, rmrf, tempDir, testConfig, type Harness } from './helpers.js';

const dirs: string[] = [];
let h: Harness | undefined;

afterEach(async () => {
  await h?.fm.close();
  h = undefined;
  for (const d of dirs.splice(0)) rmrf(d);
});

function temp(): string {
  const d = tempDir();
  dirs.push(d);
  return d;
}

function recorder(): Logger & { warnings: string[] } {
  const warnings: string[] = [];
  return { warnings, info() {}, warn: (m) => warnings.push(m), error() {}, debug() {} };
}

/** A Foreman whose profile directory already holds `siteJson` (raw text) before it starts. */
function foremanWithSite(siteJson?: string): Harness {
  const home = temp();
  const dataDir = testConfig(home, ['--backend', 'sim']).dataDir;
  if (siteJson !== undefined) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'site.json'), siteJson);
  }
  h = makeForeman(home, ['--backend', 'sim']);
  return h;
}

describe('site.json', () => {
  it('writes the default four-slot layout when there is none', () => {
    const dir = temp();
    const log = recorder();
    expect(loadSite(dir, log)).toEqual(DEFAULT_SITE);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'site.json'), 'utf8'))).toEqual(DEFAULT_SITE);
    expect(Object.keys(DEFAULT_SITE.zones).sort()).toEqual(['A', 'B', 'C', 'D']);
    expect(log.warnings).toEqual([]);
  });

  it('parses a present file and resolves letters to world boxes', () => {
    const dir = temp();
    const site = { origin: { x: 100, y: 70, z: -20 }, zones: { A: { name: 'Pier', x: 2, z: 3, w: 8, d: 5, h: 4 } } };
    fs.writeFileSync(path.join(dir, 'site.json'), JSON.stringify(site));
    const loaded = loadSite(dir, recorder());
    expect(loaded).toEqual(site);
    expect(resolveZone(loaded, 'A')).toEqual({ letter: 'A', box: { x: 102, y: 70, z: -17, w: 8, h: 4, d: 5 } });
    expect(resolveZone(loaded, 'B')).toBeUndefined();
    // the file is left as written
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'site.json'), 'utf8'))).toEqual(site);
  });

  it('resolves the default slots to the city block east of the studio', () => {
    expect(resolveZone(DEFAULT_SITE, 'A')).toEqual({ letter: 'A', box: { x: 30, y: 64, z: 24, w: 32, h: 8, d: 4 } });
    expect(resolveZone(DEFAULT_SITE, 'B')).toEqual({ letter: 'B', box: { x: 30, y: 64, z: 10, w: 16, h: 16, d: 14 } });
    expect(resolveZone(DEFAULT_SITE, 'C')).toEqual({ letter: 'C', box: { x: 46, y: 64, z: 10, w: 16, h: 16, d: 14 } });
    expect(resolveZone(DEFAULT_SITE, 'D')).toEqual({ letter: 'D', box: { x: 30, y: 64, z: 28, w: 32, h: 10, d: 14 } });
    expect(resolveZone(undefined, 'A')).toBeUndefined();
  });

  it.each([
    ['not JSON', '{"origin": {'],
    ['no origin', JSON.stringify({ zones: DEFAULT_SITE.zones })],
    ['a slot with no size', JSON.stringify({ ...DEFAULT_SITE, zones: { A: { name: 'Road', x: 0, z: 0 } } })],
    ['a fractional offset', JSON.stringify({ ...DEFAULT_SITE, zones: { B: { ...DEFAULT_SITE.zones.B, x: 0.5 } } })],
  ])('survives a malformed file (%s): a warning and no slots', (_label, raw) => {
    const dir = temp();
    fs.writeFileSync(path.join(dir, 'site.json'), raw);
    const log = recorder();
    expect(loadSite(dir, log)).toBeUndefined();
    expect(log.warnings).toHaveLength(1);
    expect(log.warnings[0]).toMatch(/no zone slots/);
    expect(fs.readFileSync(path.join(dir, 'site.json'), 'utf8')).toBe(raw); // not overwritten
  });

  it('loads at Foreman startup', () => {
    const { fm, cfg } = foremanWithSite();
    expect(fm.site).toEqual(DEFAULT_SITE);
    expect(fs.existsSync(path.join(cfg.dataDir, 'site.json'))).toBe(true);
    expect(fm.zone('C')).toEqual({ letter: 'C', box: { x: 46, y: 64, z: 10, w: 16, h: 16, d: 14 } });
  });

  it('starts with no slots when the file is malformed', () => {
    const { fm } = foremanWithSite('not json');
    expect(fm.site).toBeUndefined();
    expect(fm.zone('A')).toBeUndefined();
    expect(fm.tasks.create({ title: 'still works', createdBy: 'marlow' }).id).toBe('t1');
  });
});

