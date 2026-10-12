// Zone blueprints: turn a worker's `zones/<letter>.json` into world-space `/fill` commands.
//
// Rules (MVP spec, "Blueprint format")
//  - the file must parse: `{ zone, boxes: [{ from: [x,y,z], to: [x,y,z], block }] }`, zone-local, y up
//  - `zone` must be the slot's letter
//  - every coordinate stays inside the zone's box: out-of-range values are clamped and noted
//  - at most MAX_BOXES boxes: the rest are dropped and noted
//  - blocks come from BLOCK_PALETTE: anything else becomes FALLBACK_BLOCK and is noted
// Fills keep file order, since later boxes overwrite earlier ones (fill a shape, then carve it with air).
// Pure and synchronous apart from `readBlueprint`'s one file read. Nothing here throws; failures come
// back as `{ ok: false, error }` written for the worker who has to fix the file.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

export const BLOCK_PALETTE = [
  'minecraft:stone_bricks',
  'minecraft:cobblestone',
  'minecraft:spruce_planks',
  'minecraft:spruce_log',
  'minecraft:glass',
  'minecraft:oak_door',
  'minecraft:lantern',
  'minecraft:water',
  'minecraft:air',
] as const;
export type PaletteBlock = (typeof BLOCK_PALETTE)[number];

export const FALLBACK_BLOCK: PaletteBlock = 'minecraft:stone_bricks';
export const MAX_BOXES = 60;

export type ZoneLetter = 'A' | 'B' | 'C' | 'D';

/** A zone's place in the world: x, y, z is the lowest corner, w, h, d the size along x, y, z. */
export interface ZoneSlot {
  letter: ZoneLetter;
  box: { x: number; y: number; z: number; w: number; h: number; d: number };
}

export type BlueprintResult =
  | { ok: true; zone: ZoneLetter; fills: string[]; notes: string[] }
  | { ok: false; error: string };

type Vec3 = [number, number, number];

// zod's default messages ("expected tuple, received undefined") are hard for a worker to act on
const want = (what: string) => ({ error: (iss: { input?: unknown }) => (iss.input === undefined ? `missing, expected ${what}` : `expected ${what}`) });
const Int = z.number().int(want('a whole number'));
const Coord = z.tuple([Int, Int, Int], want('[x, y, z], three whole numbers'));
const Blueprint = z.object(
  {
    zone: z.enum(['A', 'B', 'C', 'D'], want('"A", "B", "C" or "D"')),
    boxes: z.array(
      z.object({ from: Coord, to: Coord, block: z.string(want('a block id like "minecraft:stone_bricks"')) }, want('a box like {"from": [0, 0, 0], "to": [1, 1, 1], "block": "minecraft:stone_bricks"}')),
      want('a list of boxes'),
    ),
  },
  want('an object like {"zone": "B", "boxes": [...]}'),
);

const PALETTE: ReadonlySet<string> = new Set(BLOCK_PALETTE);

/** Parse blueprint text for `slot`. `source` names the file in error messages. */
export function parseBlueprint(text: string, slot: ZoneSlot, source = 'blueprint'): BlueprintResult {
  const fail = (msg: string): BlueprintResult => ({ ok: false, error: `${source}: ${msg}` });
  const { w, h, d } = slot.box;
  if (![w, h, d].every((n) => Number.isInteger(n) && n > 0)) return fail(`zone ${slot.letter} has no usable size (w ${w}, h ${h}, d ${d})`);

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return fail(`not valid JSON: ${(e as Error).message}`);
  }
  const parsed = Blueprint.safeParse(raw);
  if (!parsed.success) return fail(parsed.error.issues.slice(0, 5).map((i) => `${issuePath(i.path)}: ${i.message}`).join('; '));
  const bp = parsed.data;
  if (bp.zone !== slot.letter) return fail(`"zone" is "${bp.zone}" but this task is zone ${slot.letter}; set "zone": "${slot.letter}"`);

  const notes: string[] = [];
  const boxes = bp.boxes.slice(0, MAX_BOXES);
  if (bp.boxes.length > MAX_BOXES) {
    notes.push(`${bp.boxes.length} boxes, the limit is ${MAX_BOXES}: dropped boxes[${MAX_BOXES}] to boxes[${bp.boxes.length - 1}].`);
  }
  const size: Vec3 = [w, h, d];
  const origin: Vec3 = [slot.box.x, slot.box.y, slot.box.z];
  const fills = boxes.map((box, i) => {
    const from = clamp(box.from, size);
    const to = clamp(box.to, size);
    if (!same(from, box.from) || !same(to, box.to)) {
      notes.push(`boxes[${i}] went outside the zone (${w} x ${h} x ${d}), clamped ${span(box.from, box.to)} to ${span(from, to)}.`);
    }
    let block = box.block;
    if (!PALETTE.has(block)) {
      notes.push(`boxes[${i}]: "${block}" is not in the palette, used ${FALLBACK_BLOCK}.`);
      block = FALLBACK_BLOCK;
    }
    const lo = from.map((v, a) => origin[a]! + Math.min(v, to[a]!));
    const hi = from.map((v, a) => origin[a]! + Math.max(v, to[a]!));
    return `/fill ${lo.join(' ')} ${hi.join(' ')} ${block}`;
  });
  return { ok: true, zone: slot.letter, fills, notes };
}

/** Read and parse `zones/<letter>.json` from a worktree. */
export function readBlueprint(worktree: string, slot: ZoneSlot): BlueprintResult {
  const rel = `zones/${slot.letter}.json`;
  let text: string;
  try {
    text = fs.readFileSync(path.join(worktree, 'zones', `${slot.letter}.json`), 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { ok: false, error: `${rel}: file not found; write your blueprint there` };
    return { ok: false, error: `${rel}: could not read it (${(e as Error).message})` };
  }
  return parseBlueprint(text, slot, rel);
}

function clamp(v: Vec3, size: Vec3): Vec3 {
  return v.map((n, a) => Math.min(Math.max(n, 0), size[a]! - 1)) as Vec3;
}

function same(a: Vec3, b: Vec3): boolean {
  return a.every((n, i) => n === b[i]);
}

function span(from: Vec3, to: Vec3): string {
  return `[${from.join(', ')}]..[${to.join(', ')}]`;
}

function issuePath(p: PropertyKey[]): string {
  if (p.length === 0) return 'top level';
  return p.map((k, i) => (typeof k === 'number' ? `[${k}]` : i === 0 ? String(k) : `.${String(k)}`)).join('');
}
