// The harbor city skeleton: a cobble road grid, one outlined and signed plot per district, the
// harbor basin with its dock edge, and the market block with its zone slots staked out. Pure: it
// turns a Site into /fill commands in world space and sends nothing (scripts/stamp-city.ts does).
//
// Map, x grows east and z grows south; the studio is west of the city:
//
//   north road
//   | gate road | farms outside the wall ------------------------------------- |
//   road
//   | old town  | town hall square | fishing quarter | warehouses       |
//   road
//   | market    | docks            | shipyard        | lighthouse point |
//   waterfront road
//   dock edge (spruce planks), two piers in front of the docks
//   basin (water)
//
// The market plot is the zone slots' bounding box plus a two-block margin (the outline, then a ring
// for the slot signs). Column 0 and the waterfront row take its size; every other plot is PLOT
// blocks square. The whole city hangs off the market plot, so moving the slots in site.json moves
// the city with them.
//
// Everything is a /fill, single blocks included: a fill over blocks that already match reports
// "No blocks were filled", which the DevBridge client counts as done, so a second run is harmless
// (a /setblock over an identical block fails instead).
import type { Site } from './site.js';

/** An inclusive box in world space. */
export interface Box {
  x1: number;
  y1: number;
  z1: number;
  x2: number;
  y2: number;
  z2: number;
}

/** An inclusive x/z rectangle on the ground. */
export interface Rect {
  x1: number;
  z1: number;
  x2: number;
  z2: number;
}

export interface Plot extends Rect {
  district: string;
}

export interface Slot extends Rect {
  letter: string;
  name: string;
}

export interface CityLayout {
  /** the grass top the city sits on (the site origin's y) */
  ground: number;
  /** every block any command touches, the undo's air included */
  bounds: Box;
  roads: Rect[];
  plots: Plot[];
  /** the plot holding the zone slots (also in `plots`) */
  market: Plot;
  slots: Slot[];
  /** dug out at ground level, water in the two blocks below */
  basin: Rect;
  dockEdge: Rect;
  piers: Rect[];
}

/** StudioHqBuilder.SITE: a republish of the studio rewrites every cell in this box. */
export const STUDIO_BOX: Box = { x1: -46, y1: 60, z1: -36, x2: 46, y2: 100, z2: 54 };
/** No command goes below this y. */
export const MIN_Y = 60;
/** Vanilla's default /fill limit; the HQ world raises it, but every fill stays under it anyway. */
export const MAX_FILL_VOLUME = 32_768;
export const MAX_CITY_COMMANDS = 300;

const ROAD = 5;
const PLOT = 24;
/** market plot margin around the slots: outline, then the slot-sign ring */
const PAD = 2;
const DOCK = 2;
const BASIN = 12;
const PIER_WIDTH = 3;
const PIER_LENGTH = 8;
/** characters per sign line that still fit on an oak sign */
const SIGN_LINE = 15;

const COBBLE = 'minecraft:cobblestone';
const BRICKS = 'minecraft:stone_bricks';
const PLANKS = 'minecraft:spruce_planks';
const GRASS = 'minecraft:grass_block';
const DIRT = 'minecraft:dirt';
const SLOT_GROUND = 'minecraft:coarse_dirt';
const WATER = 'minecraft:water';
const AIR = 'minecraft:air';

/** Standing sign rotations: the side the text faces. */
const FACING = { south: 0, west: 4, north: 8, east: 12 } as const;

export class CityError extends Error {
  override name = 'CityError';
}

/** Where everything goes. Throws a CityError when the site has no slots, sits too low, or would reach into the studio. */
export function cityLayout(site: Site): CityLayout {
  const { x: ox, y: ground, z: oz } = site.origin;
  const slots: Slot[] = [];
  let maxHeight = 0;
  for (const [letter, s] of Object.entries(site.zones)) {
    if (!s) continue;
    const x1 = ox + s.x;
    const z1 = oz + s.z;
    slots.push({ letter, name: s.name, x1, z1, x2: x1 + s.w - 1, z2: z1 + s.d - 1 });
    maxHeight = Math.max(maxHeight, s.h);
  }
  if (!slots.length) throw new CityError('the site has no zone slots, so there is no market block to plan the city around');

  const market: Plot = {
    district: 'Market',
    x1: Math.min(...slots.map((s) => s.x1)) - PAD,
    z1: Math.min(...slots.map((s) => s.z1)) - PAD,
    x2: Math.max(...slots.map((s) => s.x2)) + PAD,
    z2: Math.max(...slots.map((s) => s.z2)) + PAD,
  };

  // columns west to east, rows north to south; the market is column 0 of the waterfront row
  const col0 = { x1: market.x1, x2: market.x2 };
  const col1 = after(col0.x2, PLOT);
  const col2 = after(col1.x2, PLOT);
  const col3 = after(col2.x2, PLOT);
  const xMin = col0.x1 - ROAD;
  const xMax = col3.x2 + ROAD;
  const rowW = { z1: market.z1, z2: market.z2 };
  const row2 = { z1: rowW.z1 - ROAD - PLOT, z2: rowW.z1 - ROAD - 1 };
  const row3 = { z1: row2.z1 - ROAD - PLOT, z2: row2.z1 - ROAD - 1 };
  const zMin = row3.z1 - ROAD;
  const waterfront = { z1: rowW.z2 + 1, z2: rowW.z2 + ROAD };
  const dock = { z1: waterfront.z2 + 1, z2: waterfront.z2 + DOCK };
  const basinZ = { z1: dock.z2 + 1, z2: dock.z2 + BASIN };

  const across = (z1: number): Rect => ({ x1: xMin, z1, x2: xMax, z2: z1 + ROAD - 1 });
  const down = (x1: number, z1: number): Rect => ({ x1, z1, x2: x1 + ROAD - 1, z2: waterfront.z2 });
  const roads: Rect[] = [
    across(zMin),
    across(row3.z2 + 1),
    across(row2.z2 + 1),
    across(waterfront.z1),
    down(xMin, zMin),
    down(col0.x2 + 1, zMin),
    // the farms plot spans columns 1 to 3, so these two start below it
    down(col1.x2 + 1, row3.z2 + 1),
    down(col2.x2 + 1, row3.z2 + 1),
    down(col3.x2 + 1, zMin),
  ];

  const plot = (district: string, x: { x1: number; x2: number }, z: { z1: number; z2: number }): Plot => ({ district, x1: x.x1, z1: z.z1, x2: x.x2, z2: z.z2 });
  const plots: Plot[] = [
    plot('Gate Road', col0, row3),
    plot('Farms outside the Wall', { x1: col1.x1, x2: col3.x2 }, row3),
    plot('Old Town', col0, row2),
    plot('Town Hall Square', col1, row2),
    plot('Fishing Quarter', col2, row2),
    plot('Warehouses', col3, row2),
    market,
    plot('Docks', col1, rowW),
    plot('Shipyard', col2, rowW),
    plot('Lighthouse Point', col3, rowW),
  ];

  const basin: Rect = { x1: xMin, z1: basinZ.z1, x2: xMax, z2: basinZ.z2 };
  const dockEdge: Rect = { x1: xMin, z1: dock.z1, x2: xMax, z2: dock.z2 };
  const pier = (x1: number): Rect => ({ x1, z1: basin.z1, x2: x1 + PIER_WIDTH - 1, z2: basin.z1 + PIER_LENGTH - 1 });
  const piers = [pier(col1.x1 + 5), pier(col1.x2 - 5 - PIER_WIDTH + 1)];

  // the undo clears up to the tallest slot, so it also takes away zones built since
  const top = Math.max(ground + 2, ground + maxHeight - 1);
  const bounds: Box = { x1: xMin, y1: ground - 2, z1: zMin, x2: xMax, y2: top, z2: basin.z2 };
  if (bounds.y1 < MIN_Y) throw new CityError(`the basin would dig to y ${bounds.y1}, below y ${MIN_Y}; raise the site origin's y`);
  if (overlaps(bounds, STUDIO_BOX)) {
    throw new CityError(
      `the city (x ${bounds.x1}..${bounds.x2}, z ${bounds.z1}..${bounds.z2}) reaches into the studio's box ` +
        `(x ${STUDIO_BOX.x1}..${STUDIO_BOX.x2}, z ${STUDIO_BOX.z1}..${STUDIO_BOX.z2}); move the site origin in site.json`,
    );
  }
  return { ground, bounds, roads, plots, market, slots, basin, dockEdge, piers };
}

/** The commands that stamp the skeleton, in order. */
export function cityCommands(site: Site): string[] {
  const c = cityLayout(site);
  const g = c.ground;
  const cmds: string[] = [];

  // harbor: dig out the ground row, water in the two below it, then the dock edge and piers
  cmds.push(fill(c.basin, g, g, AIR), fill(c.basin, g - 2, g - 1, WATER), fill(c.dockEdge, g, g, PLANKS));
  for (const p of c.piers) cmds.push(fill(p, g, g, PLANKS));
  for (const r of c.roads) cmds.push(fill(r, g, g, COBBLE));

  // the market: grass inside its outline, the slots' footprints in coarse dirt
  cmds.push(fill(inset(c.market, 1), g, g, GRASS));
  for (const s of c.slots) cmds.push(fill(s, g, g, SLOT_GROUND));

  for (const p of c.plots) {
    cmds.push(...outline(p, g + 1, BRICKS));
    cmds.push(sign(Math.floor((p.x1 + p.x2) / 2), g + 2, p.z2, FACING.south, wrap(p.district)));
  }

  const posts = new Set<string>();
  for (const s of c.slots) {
    for (const [x, z] of corners(s)) {
      const key = `${x} ${z}`;
      if (posts.has(key)) continue;
      posts.add(key);
      cmds.push(`/fill ${x} ${g + 1} ${z} ${x} ${g + 2} ${z} ${BRICKS}`);
    }
  }
  for (const s of c.slots) {
    const spot = slotSignSpot(s, c);
    if (spot) cmds.push(sign(spot.x, g + 1, spot.z, spot.facing, [`Zone ${s.letter}`, ...wrap(s.name)]));
  }
  return cmds;
}

/** The commands that put the flat meadow back over the city's bounds: dirt in the basin, grass on top, air above. */
export function undoCityCommands(site: Site): string[] {
  const c = cityLayout(site);
  const b = c.bounds;
  const g = c.ground;
  const area: Rect = { x1: b.x1, z1: b.z1, x2: b.x2, z2: b.z2 };
  const cmds = [fill(c.basin, g - 2, g - 1, DIRT), fill(area, g, g, GRASS)];
  const perFill = Math.max(1, Math.floor(MAX_FILL_VOLUME / ((b.x2 - b.x1 + 1) * (b.z2 - b.z1 + 1))));
  for (let y = g + 1; y <= b.y2; y += perFill) cmds.push(fill(area, y, Math.min(y + perFill - 1, b.y2), AIR));
  return cmds;
}

/** Keep the city's chunks loaded while it is stamped from anywhere in the world, then let them go. */
export function forceloadCommands(bounds: Box): { add: string; remove: string } {
  const span = `${bounds.x1} ${bounds.z1} ${bounds.x2} ${bounds.z2}`;
  return { add: `/forceload add ${span}`, remove: `/forceload remove ${span}` };
}

function after(x2: number, width: number): { x1: number; x2: number } {
  return { x1: x2 + ROAD + 1, x2: x2 + ROAD + width };
}

function inset(r: Rect, n: number): Rect {
  return { x1: r.x1 + n, z1: r.z1 + n, x2: r.x2 - n, z2: r.z2 - n };
}

function overlaps(a: Box, b: Box): boolean {
  return a.x1 <= b.x2 && b.x1 <= a.x2 && a.y1 <= b.y2 && b.y1 <= a.y2 && a.z1 <= b.z2 && b.z1 <= a.z2;
}

function contains(r: Rect, x: number, z: number): boolean {
  return x >= r.x1 && x <= r.x2 && z >= r.z1 && z <= r.z2;
}

function fill(r: Rect, y1: number, y2: number, block: string): string {
  return `/fill ${r.x1} ${y1} ${r.z1} ${r.x2} ${y2} ${r.z2} ${block}`;
}

function outline(r: Rect, y: number, block: string): string[] {
  return [
    fill({ ...r, z2: r.z1 }, y, y, block),
    fill({ ...r, z1: r.z2 }, y, y, block),
    fill({ x1: r.x1, z1: r.z1 + 1, x2: r.x1, z2: r.z2 - 1 }, y, y, block),
    fill({ x1: r.x2, z1: r.z1 + 1, x2: r.x2, z2: r.z2 - 1 }, y, y, block),
  ];
}

function corners(r: Rect): Array<[number, number]> {
  return [
    [r.x1, r.z1],
    [r.x2, r.z1],
    [r.x1, r.z2],
    [r.x2, r.z2],
  ];
}

/** The first free cell beside a slot (west, east, north, south of its middle) inside the market's outline. */
function slotSignSpot(s: Slot, c: CityLayout): { x: number; z: number; facing: number } | undefined {
  const mx = Math.floor((s.x1 + s.x2) / 2);
  const mz = Math.floor((s.z1 + s.z2) / 2);
  const inside = inset(c.market, 1);
  const candidates = [
    { x: s.x1 - 1, z: mz, facing: FACING.west },
    { x: s.x2 + 1, z: mz, facing: FACING.east },
    { x: mx, z: s.z1 - 1, facing: FACING.north },
    { x: mx, z: s.z2 + 1, facing: FACING.south },
  ];
  return candidates.find((p) => contains(inside, p.x, p.z) && !c.slots.some((o) => contains(o, p.x, p.z)));
}

/** Words into at most four sign lines of SIGN_LINE characters. */
function wrap(text: string): string[] {
  const lines: string[] = [];
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const last = lines.length - 1;
    if (last >= 0 && lines[last]!.length + 1 + word.length <= SIGN_LINE) lines[last] += ` ${word}`;
    else lines.push(word.slice(0, SIGN_LINE));
  }
  return lines;
}

/**
 * A waxed oak sign with up to four lines, short text centred vertically. Sign lines are plain
 * strings: 26.3's ComponentSerialization codec reads a bare string as a text component.
 */
function sign(x: number, y: number, z: number, facing: number, text: string[]): string {
  const lines = text.slice(0, 4);
  const padded = lines.length >= 3 ? lines : ['', ...lines];
  while (padded.length < 4) padded.push('');
  const messages = padded.map((l) => `"${l.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',');
  return `/fill ${x} ${y} ${z} ${x} ${y} ${z} minecraft:oak_sign[rotation=${facing}]{front_text:{messages:[${messages}]},is_waxed:1b}`;
}
