// The build site: four fixed zone slots (A-D) the lead hands out to zone tasks.
//
//   <dataDir>/site.json   { "origin": {x, y, z}, "zones": { "A": {name, x, z, w, d, h}, ... } }
//
// Slot x/z are offsets from `origin`; y is the ground block, so a slot's box starts at origin.y.
// A fresh profile gets the default city block (east of the studio, x 30..61, z 10..41, ground 64).
// A file that does not parse leaves the Foreman with no slots: zone tasks are refused, everything
// else runs as before.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Logger } from './context.js';
import { formatZodError, ZoneLetter, type BuildSite, type Zone } from './protocol.js';
import { writeJsonAtomic } from './util/fsx.js';

const Int = z.number().int();
const Size = z.number().int().positive();

export const SiteSlot = z.object({ name: z.string(), x: Int, z: Int, w: Size, d: Size, h: Size });
export type SiteSlot = z.infer<typeof SiteSlot>;

export const Site = z.object({
  origin: z.object({ x: Int, y: Int, z: Int }),
  zones: z.partialRecord(ZoneLetter, SiteSlot),
});
export type Site = z.infer<typeof Site>;

export const DEFAULT_SITE: Site = {
  origin: { x: 30, y: 64, z: 10 },
  zones: {
    A: { name: 'Main street segment', x: 0, z: 14, w: 32, d: 4, h: 8 },
    B: { name: 'West building', x: 0, z: 0, w: 16, d: 14, h: 16 },
    C: { name: 'East building', x: 16, z: 0, w: 16, d: 14, h: 16 },
    D: { name: 'Plaza', x: 0, z: 18, w: 32, d: 14, h: 10 },
  },
};

/** Read `<dir>/site.json`, writing the default first when there is none. Undefined if it is invalid. */
export function loadSite(dir: string, log: Logger): Site | undefined {
  const file = path.join(dir, 'site.json');
  if (!fs.existsSync(file)) {
    try {
      writeJsonAtomic(file, DEFAULT_SITE);
    } catch (e) {
      log.warn(`site: could not write the default ${file}: ${(e as Error).message}`);
    }
    return structuredClone(DEFAULT_SITE);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    log.warn(`site: ${file} is not valid JSON (${(e as Error).message}); running with no zone slots`);
    return undefined;
  }
  const r = Site.safeParse(raw);
  if (!r.success) {
    log.warn(`site: ${file} is invalid (${formatZodError(r.error)}); running with no zone slots`);
    return undefined;
  }
  return r.data;
}

/** The world-space box of a slot, or undefined when the site has no such slot. */
export function resolveZone(site: Site | undefined, letter: ZoneLetter): Zone | undefined {
  const slot = site?.zones[letter];
  if (!site || !slot) return undefined;
  const { origin } = site;
  return { letter, box: { x: origin.x + slot.x, y: origin.y, z: origin.z + slot.z, w: slot.w, h: slot.h, d: slot.d } };
}

/** The whole site in world space, A to D, for the mod's snapshot. Undefined when there are no slots. */
export function siteInWorld(site: Site | undefined): BuildSite | undefined {
  if (!site) return undefined;
  const zones = ZoneLetter.options.flatMap((letter) => resolveZone(site, letter) ?? []);
  return { origin: { ...site.origin }, zones };
}
