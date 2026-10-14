// Offline check of the zone worker prompt: does a cheap worker write a blueprint that parses?
//
//   node --import tsx scripts/zone-prompt-check.ts [--runs 5] [--model haiku] [--effort low]
//
// Builds the zone worker's system prompt and task prompt for a sample task card (zone B, a small
// shop), asks Claude through the Agent SDK for only the file's content (no tools, one turn), writes
// each answer to a temp worktree as zones/B.json and runs the blueprint parser on it. Prints one
// row per run and "N of M parsed". Uses the claude.ai login, like --use-claude-login. Calls the real
// API, so it is not part of `npm test`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { withAuthMode } from '../src/agents/claude/auth.js';
import { workPrompt, zoneWorkerSystemPrompt } from '../src/agents/prompts.js';
import { readBlueprint } from '../src/blueprint.js';
import type { Foreman } from '../src/foreman.js';
import type { Task, Worktree, Zone } from '../src/protocol.js';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
const runs = Number(arg('runs', '5'));
const model = arg('model', 'haiku');
const effort = arg('effort', 'low') as 'low' | 'medium' | 'high';

// zone B of the default site (site.ts DEFAULT_SITE): 16 by 16 by 14
const zone: Zone = { letter: 'B', box: { x: 55, y: 64, z: 10, w: 16, h: 16, d: 14 } };
const task: Task = {
  id: 't3',
  title: 'Zone B: the east shop',
  description: [
    'A small shop with a door and two windows.',
    'Palette: stone bricks, cobblestone, spruce planks, spruce log, glass, oak door, lantern.',
    'It faces the plaza (zone D), which is on the z = 13 side, so the door goes on that side.',
  ].join('\n'),
  status: 'doing',
  assignee: 'kit',
  deps: [],
  priority: 10,
  ci: 'unknown',
  zone,
  createdBy: 'marlow',
  createdAt: 0,
  updatedAt: 0,
};
// just enough of a Foreman for the prompt builders: one task on the board, no plan, no answered questions
const fm = {
  nameOf: (id: string) => (id === 'kit' ? 'Kit' : id),
  tasks: { list: () => [task] },
  memory: { list: () => [] },
  store: { data: { decisions: [] } },
} as unknown as Foreman;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zone-prompt-check-'));
const wtFor = (i: number): Worktree => ({ id: `w${i}`, path: path.join(root, `run-${i}`), branch: 'agentcraft/kit/t3-east-shop', base: 'main' }) as Worktree;

const DRY_RUN = `\n\nThis is a dry run with no tools. Reply with only the full content of zones/${zone.letter}.json, exactly as it would be written to the file.`;

interface Row {
  run: number;
  parsed: boolean;
  boxes: number | string;
  cost: string;
  notes: string;
  error: string;
}

async function ask(wt: Worktree): Promise<{ text: string; cost: number }> {
  const q = query({
    prompt: workPrompt(fm, task, { text: 'Build the market square by the docks.' } as never, wt, '') + DRY_RUN,
    options: {
      cwd: wt.path,
      model,
      effort,
      maxTurns: 1,
      tools: [],
      settingSources: [],
      persistSession: false,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: zoneWorkerSystemPrompt(fm, 'kit', wt, zone) },
      env: withAuthMode({ ...process.env }, true),
    },
  });
  let text = '';
  let cost = 0;
  for await (const m of q) {
    if (m.type !== 'result') continue;
    cost = m.total_cost_usd;
    if (m.subtype !== 'success') throw new Error(`${m.subtype}: ${'errors' in m ? m.errors.join('; ') : ''}`);
    if (m.is_error) throw new Error(m.result);
    text = m.result;
  }
  return { text, cost };
}

function boxCount(text: string): number | string {
  try {
    const boxes = (JSON.parse(text) as { boxes?: unknown }).boxes;
    return Array.isArray(boxes) ? boxes.length : '-';
  } catch {
    return '-';
  }
}

const rows: Row[] = [];
console.log(`zone prompt check: ${runs} runs on ${model} (effort ${effort}), samples in ${root}`);
for (let i = 1; i <= runs; i++) {
  const wt = wtFor(i);
  fs.mkdirSync(path.join(wt.path, 'zones'), { recursive: true });
  try {
    const { text, cost } = await ask(wt);
    fs.writeFileSync(path.join(wt.path, 'zones', `${zone.letter}.json`), text);
    const r = readBlueprint(wt.path, zone);
    const notes = [/^\s*```/.test(text) ? 'code fence' : '', ...(r.ok ? r.notes : [])].filter(Boolean);
    rows.push({ run: i, parsed: r.ok, boxes: boxCount(text), cost: `$${cost.toFixed(4)}`, notes: notes.join(' ') || '-', error: r.ok ? '-' : r.error });
  } catch (e) {
    rows.push({ run: i, parsed: false, boxes: '-', cost: '-', notes: 'call failed', error: (e as Error).message });
  }
  const row = rows.at(-1)!;
  console.log(`run ${i}: ${row.parsed ? 'parsed' : 'did not parse'}`);
}

const cell = (s: string | number) => String(s).replace(/\|/g, '\\|').replace(/\s+/g, ' ');
console.log('\n| run | parsed | boxes | cost | notes | error |\n|---|---|---|---|---|---|');
for (const r of rows) console.log(`| ${r.run} | ${r.parsed ? 'yes' : 'no'} | ${r.boxes} | ${r.cost} | ${cell(r.notes)} | ${cell(r.error)} |`);
console.log(`\n${rows.filter((r) => r.parsed).length} of ${rows.length} parsed`);
