import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BLOCK_PALETTE, MAX_BOXES, parseBlueprint, readBlueprint, type ZoneSlot } from '../src/blueprint.js';

const FIXTURES = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), 'fixtures', 'blueprints');
const fixture = (name: string): string => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

// zone B as the build plan lays out the first city block: origin (30, 64, 10), 16 x 16 x 14
const B: ZoneSlot = { letter: 'B', box: { x: 30, y: 64, z: 10, w: 16, h: 16, d: 14 } };
// a small slot with a negative z origin, so the offset is easy to check by hand
const C: ZoneSlot = { letter: 'C', box: { x: 100, y: 64, z: -20, w: 4, h: 3, d: 5 } };

describe('blueprint parser', () => {
  it('turns the spec example into world-space fills in file order', () => {
    const r = readBlueprint(path.join(FIXTURES, 'worktree'), B);
    expect(r).toEqual({
      ok: true,
      zone: 'B',
      fills: [
        '/fill 30 64 10 38 64 18 minecraft:stone_bricks',
        '/fill 30 65 10 38 70 18 minecraft:spruce_planks',
        '/fill 31 65 11 37 67 17 minecraft:air',
        '/fill 31 69 11 37 70 17 minecraft:air',
        '/fill 34 65 10 34 66 10 minecraft:air',
      ],
      notes: [],
    });
  });

  it('orders each corner pair low to high', () => {
    const r = parseBlueprint('{"zone":"C","boxes":[{"from":[3,2,4],"to":[0,0,1],"block":"minecraft:water"}]}', C);
    expect(r).toEqual({ ok: true, zone: 'C', fills: ['/fill 100 64 -19 103 66 -16 minecraft:water'], notes: [] });
  });

  it('clamps out-of-bounds coordinates into the zone and says so', () => {
    const r = parseBlueprint(fixture('out-of-bounds.json'), C);
    expect(r).toEqual({
      ok: true,
      zone: 'C',
      fills: ['/fill 100 64 -20 103 64 -16 minecraft:cobblestone', '/fill 100 65 -20 103 66 -17 minecraft:glass'],
      notes: ['boxes[1] went outside the zone (4 x 3 x 5), clamped [-2, 1, 3]..[6, 9, -1] to [0, 1, 3]..[3, 2, 0].'],
    });
  });

  it('replaces blocks outside the palette with stone bricks and names the original', () => {
    const r = parseBlueprint(fixture('unknown-block.json'), C);
    expect(r).toEqual({
      ok: true,
      zone: 'C',
      fills: [
        '/fill 100 64 -20 103 64 -16 minecraft:stone_bricks',
        '/fill 101 65 -19 101 65 -19 minecraft:lantern',
        '/fill 102 65 -18 102 66 -18 minecraft:stone_bricks',
      ],
      notes: [
        'boxes[0]: "minecraft:diamond_block" is not in the palette, used minecraft:stone_bricks.',
        'boxes[2]: "oak_door" is not in the palette, used minecraft:stone_bricks.',
      ],
    });
    expect(BLOCK_PALETTE).toHaveLength(9);
  });

  it('keeps the first 60 boxes and notes how many it dropped', () => {
    const boxes = Array.from({ length: 75 }, () => ({ from: [0, 0, 0], to: [0, 0, 0], block: 'minecraft:glass' }));
    const r = parseBlueprint(JSON.stringify({ zone: 'C', boxes }), C);
    expect(r.ok && r.fills).toHaveLength(MAX_BOXES);
    expect(r.ok && r.notes).toEqual(['75 boxes, the limit is 60: dropped boxes[60] to boxes[74].']);
  });

  it('reports invalid JSON without throwing', () => {
    const r = parseBlueprint(fixture('invalid-json.json'), C, 'zones/C.json');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/^zones\/C\.json: not valid JSON: /);
  });

  it('names the box and field when the shape is wrong', () => {
    expect(parseBlueprint(fixture('missing-to.json'), C, 'zones/C.json')).toEqual({
      ok: false,
      error: 'zones/C.json: boxes[1].to: missing, expected [x, y, z], three whole numbers',
    });
    const bad = parseBlueprint('{"zone":"C","boxes":[{"from":[0,1.5,0],"to":[1,1],"block":7}]}', C);
    expect(!bad.ok && bad.error.split('; ')).toEqual([
      'blueprint: boxes[0].from[1]: expected a whole number',
      'boxes[0].to: expected [x, y, z], three whole numbers',
      'boxes[0].block: expected a block id like "minecraft:stone_bricks"',
    ]);
    expect(parseBlueprint('[]', C)).toEqual({ ok: false, error: 'blueprint: top level: expected an object like {"zone": "B", "boxes": [...]}' });
  });

  it('refuses a blueprint written for another zone', () => {
    expect(parseBlueprint(fixture('out-of-bounds.json'), B, 'zones/B.json')).toEqual({
      ok: false,
      error: 'zones/B.json: "zone" is "C" but this task is zone B; set "zone": "B"',
    });
  });

  it('reports a missing zone file', () => {
    expect(readBlueprint(path.join(FIXTURES, 'worktree'), C)).toEqual({
      ok: false,
      error: 'zones/C.json: file not found; write your blueprint there',
    });
  });
});
