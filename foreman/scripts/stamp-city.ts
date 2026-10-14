// Stamp the harbor city skeleton (src/city.ts) into the game over the DevBridge, or take it away.
//
//   npm run stamp:city -- [--dry-run | --go] [--undo] [--site <file>] [--home <dir>] [--profile <name>] [--backend <name>]
//
// --dry-run (the default) prints the commands and a count and sends nothing. --go sends them in
// order to the DevBridge on AGENTCRAFT_DEV_PORT (7879), printing progress every 25 commands and
// stopping at the first one that fails. --undo swaps in the commands that put grass back at the
// ground and air above over the whole city, built zones included.
//
// The site is the Foreman's: <home>/<profile>/site.json with the same --home/--profile/--backend
// resolution as the Foreman (config.json and AGENTCRAFT_* included), or --site <file>. With no file
// there yet it uses the default the Foreman would write.
//
// The city's chunks are force-loaded around the stamp, so it works wherever the player stands; a fill
// that still lands on an unloaded chunk is retried while they load.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { cityCommands, cityLayout, CityError, forceloadCommands, undoCityCommands } from '../src/city.js';
import { loadConfig } from '../src/config.js';
import { DevBridgeStamper, devBridgePort } from '../src/devbridge.js';
import { formatZodError } from '../src/protocol.js';
import { DEFAULT_SITE, Site } from '../src/site.js';

const PROGRESS_EVERY = 25;
const UNLOADED = /not loaded/i;

export interface StampCityIo {
  out(line: string): void;
  err(line: string): void;
  env?: NodeJS.ProcessEnv;
  /** wait between retries of a fill on an unloaded chunk; tests pass a fast one */
  sleep?(ms: number): Promise<void>;
  /** tries per fill while its chunks load (default 40, 250 ms apart) */
  loadTries?: number;
}

const USAGE = 'usage: npm run stamp:city -- [--dry-run | --go] [--undo] [--site <file>] [--home <dir>] [--profile <name>] [--backend <name>]';

/** Run the script; resolves with the exit code. */
export async function stampCity(argv: string[], io: StampCityIo): Promise<number> {
  const env = io.env ?? process.env;
  let opts: { go: boolean; dryRun: boolean; undo: boolean; site?: string; foremanArgs: string[] };
  try {
    opts = parseArgs(argv);
  } catch (e) {
    io.err((e as Error).message);
    io.err(USAGE);
    return 2;
  }
  if (opts.go && opts.dryRun) {
    io.err('--go and --dry-run together: pick one');
    return 2;
  }

  let site: Site;
  let source: string;
  try {
    ({ site, source } = resolveSite(opts.site, opts.foremanArgs, env));
  } catch (e) {
    io.err((e as Error).message);
    return 1;
  }

  let cmds: string[];
  let layout: ReturnType<typeof cityLayout>;
  try {
    layout = cityLayout(site);
    cmds = opts.undo ? undoCityCommands(site) : cityCommands(site);
  } catch (e) {
    if (!(e instanceof CityError)) throw e;
    io.err(`city: ${e.message}`);
    return 1;
  }
  const b = layout.bounds;
  const { add, remove } = forceloadCommands(b);
  const all = [add, ...cmds, remove];
  const what = opts.undo ? 'undo of the city skeleton' : 'city skeleton';

  io.out(`# ${what} for ${source}`);
  io.out(`# origin ${site.origin.x} ${site.origin.y} ${site.origin.z}, slots ${layout.slots.map((s) => s.letter).join(' ')}, market x ${layout.market.x1}..${layout.market.x2} z ${layout.market.z1}..${layout.market.z2}`);
  io.out(`# bounds x ${b.x1}..${b.x2}, y ${b.y1}..${b.y2}, z ${b.z1}..${b.z2} (${b.x2 - b.x1 + 1} by ${b.z2 - b.z1 + 1})`);
  if (!opts.go) {
    for (const c of all) io.out(c);
    io.out(`${all.length} commands, nothing sent (dry run). Add --go to send them to the game.`);
    return 0;
  }

  const port = devBridgePort(env);
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const tries = io.loadTries ?? 40;
  const stamper = new DevBridgeStamper({ port });
  io.out(`sending ${all.length} commands to the DevBridge on port ${port}`);
  try {
    await stamper.send(add);
  } catch (e) {
    const msg = (e as Error).message;
    if (/not reachable/i.test(msg)) {
      io.err(msg);
      return 1;
    }
    // best effort: forceload reports a failure when the chunks are already marked
    io.err(`warning: ${msg}`);
  }
  try {
    for (let i = 0; i < cmds.length; i++) {
      const cmd = cmds[i]!;
      for (let t = 1; ; t++) {
        try {
          await stamper.send(cmd);
          break;
        } catch (e) {
          if (t < tries && UNLOADED.test((e as Error).message)) {
            await sleep(250);
            continue;
          }
          io.err(`failed at command ${i + 2} of ${all.length}: ${cmd}`);
          io.err((e as Error).message);
          return 1;
        }
      }
      const n = i + 2;
      if (n % PROGRESS_EVERY === 0) io.out(`sent ${n}/${all.length}`);
    }
  } finally {
    await stamper.send(remove).catch((e: Error) => io.err(`warning: ${e.message}`));
    stamper.close();
  }
  io.out(`done: ${all.length} commands sent`);
  return 0;
}

function parseArgs(argv: string[]) {
  const opts = { go: false, dryRun: false, undo: false, site: undefined as string | undefined, foremanArgs: [] as string[] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--go') opts.go = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--undo') opts.undo = true;
    else if (a === '--site' || a === '--home' || a === '--profile' || a === '--backend') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) throw new Error(`${a} needs a value`);
      if (a === '--site') opts.site = v;
      else opts.foremanArgs.push(a, v);
    } else throw new Error(`unknown argument "${a}"`);
  }
  return opts;
}

function resolveSite(siteFlag: string | undefined, foremanArgs: string[], env: NodeJS.ProcessEnv): { site: Site; source: string } {
  if (siteFlag) return { site: readSite(path.resolve(siteFlag)), source: path.resolve(siteFlag) };
  const file = path.join(loadConfig(foremanArgs, env).dataDir, 'site.json');
  if (!fs.existsSync(file)) return { site: structuredClone(DEFAULT_SITE), source: `the default site (no ${file} yet)` };
  return { site: readSite(file), source: file };
}

function readSite(file: string): Site {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`site: could not read ${file}: ${(e as Error).message}`);
  }
  const r = Site.safeParse(raw);
  if (!r.success) throw new Error(`site: ${file} is invalid (${formatZodError(r.error)})`);
  return r.data;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const code = await stampCity(process.argv.slice(2), { out: (l) => console.log(l), err: (l) => console.error(l) });
  process.exit(code);
}
