// Worker prompts: a zone task gets the builder prompt, everything else the coding prompt as before.
// The routing test drives a real team over a fake SDK (like claude-zone-ci.test.ts) and records the
// system prompt each worker turn was started with.
import fs from 'node:fs';
import path from 'node:path';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClaudeBackend } from '../src/agents/claude/index.js';
import { workerSystemPrompt, workPrompt, zoneWorkerSystemPrompt } from '../src/agents/prompts.js';
import { BLOCK_PALETTE, MAX_BOXES } from '../src/blueprint.js';
import type { Worktree } from '../src/protocol.js';
import { demoRepo, makeForeman, rmrf, tempDir, until, type Harness } from './helpers.js';

const wt = { id: 'w1', path: '/work/kit-t1', branch: 'agentcraft/kit/t1-shop', base: 'main' } as Worktree;

let h: Harness;
let home: string;

beforeAll(() => {
  home = tempDir();
  h = makeForeman(home, ['--workers', 'kit']);
});

afterAll(async () => {
  await h.fm.close();
  rmrf(home);
});

describe('coding worker prompts', () => {
  it('a task without a zone gets the coding prompts unchanged', () => {
    const t = h.fm.tasks.create({ title: 'Add a tag parser', description: 'Parse #tags out of notes.', createdBy: 'marlow' });
    expect(workerSystemPrompt(h.fm, 'kit', wt)).toMatchInlineSnapshot(`
      "# You are Kit, a worker on an AgentCraft team led by Marlow
      The user is Alex. You work ONLY inside your git worktree:
        /work/kit-t1
      on branch agentcraft/kit/t1-shop (based on main). Edit files and run commands there; never touch anything outside it.
      Your branch started from the current local main, which already includes every merged task. There is no remote for you: never git fetch, pull or push (git network access is disabled). To pick up work merged after you started, run \`git merge main\`.

      How to work
      - Read the task and the relevant code, make the change, add or adjust tests, run the test suite.
      - Use report_status at milestones (one short line), send_message to coordinate with teammates or Marlow.
      - Decide technical details yourself. Call ask_user only for something genuinely Alex's (product choice, credentials, scope).
      - Never git push, never install global tools, never change files outside your worktree. Committing is optional (the Foreman commits your work when Alex approves the merge).
      - Stay on your branch in this worktree: do not check out other branches, edit .git, or point git elsewhere (GIT_DIR and friends); those need Alex's permission. Your commits are made as AgentCraft Kit and are never signed (no -S).
      - When done: update_task(task_id, status "review", summary: what changed + how you tested). If you cannot finish: update_task(status "blocked", blocked_reason). Then end your turn."
    `);
    expect(workPrompt(h.fm, t, undefined, wt, '')).toMatchInlineSnapshot(`
      "Your task: t1 "Add a tag parser"

      Parse #tags out of notes.

      Goal: (none)
      Worktree: /work/kit-t1 (branch agentcraft/kit/t1-shop)

      Plan (shared memory):
      (no plan in memory)

      Task board:
      - t1 [todo] Add a tag parser

      Start now. When finished call update_task("t1", status "review", summary)."
    `);
  });
});

describe('zone worker prompts', () => {
  it('names the file, the letter, the box size, the palette and the box limit', () => {
    const zone = h.fm.zone('B')!;
    const sys = zoneWorkerSystemPrompt(h.fm, 'kit', wt, zone);
    expect(sys).toContain('zones/B.json');
    expect(sys).toContain('Zone B: 16 wide (x) by 16 tall (y) by 14 deep (z)');
    expect(sys).toContain('x runs 0 to 15, y runs 0 to 15, z runs 0 to 13');
    for (const block of BLOCK_PALETTE) expect(sys).toContain(block);
    expect(sys).toContain(`At most ${MAX_BOXES} boxes`);
    expect(sys).toContain('"zone": "B"');
    expect(sys).toContain('You are a builder.');
    expect(sys).toContain('/work/kit-t1');
    expect(sys).toContain('update_task(task_id, status "review"');
    // zone-local only: the slot's world corner never reaches the worker
    expect(sys).not.toContain(String(zone.box.y));
    expect(sys).not.toContain('run the test suite');
  });

  it('puts the zone on the task prompt', () => {
    const t = h.fm.tasks.create({ title: 'East shop', description: 'A small shop.', createdBy: 'marlow', zone: h.fm.zone('B')! });
    const p = workPrompt(h.fm, t, undefined, wt, '');
    expect(p).toContain('Zone: B, 16 wide (x) by 16 tall (y) by 14 deep (z). Write zones/B.json.');
    expect(p).toContain(`When zones/B.json is written call update_task("${t.id}", status "review", summary)`);
  });
});

type ToolServer = { instance: { _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<{ content: Array<{ text: string }> }> }> } };

async function callTool(options: Options, name: string, args: Record<string, unknown>): Promise<string> {
  const server = options.mcpServers!.agentcraft as unknown as ToolServer;
  const res = await server.instance._registeredTools[name]!.handler(args, {});
  return res.content.map((c) => c.text).join('\n');
}

describe('team picks the worker prompt by task', () => {
  const sid = (k: string) => `00000000-0000-4000-8000-${k.padStart(12, '0')}`;
  let n = 0;
  const msg = (o: Record<string, unknown>) => ({ parent_tool_use_id: null, uuid: sid(String(++n)), ...o }) as unknown as SDKMessage;
  const init = (s: string) => msg({ type: 'system', subtype: 'init', session_id: s, model: 'fake-model', cwd: '', tools: [] });
  const result = (s: string) => msg({ type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, total_cost_usd: 0.001, session_id: s, duration_ms: 1, duration_api_ms: 1, usage: {}, modelUsage: {}, permission_denials: [] });
  /** The system prompt append of each worker turn, by task title. */
  const started = new Map<string, string>();
  let team: Harness;
  let teamHome: string;
  let repoPath: string;

  function fakeQuery() {
    return ({ prompt, options }: { prompt: string | AsyncIterable<unknown>; options?: Options }) => {
      const opts = options!;
      const p = String(prompt);
      async function* run(): AsyncGenerator<SDKMessage> {
        const s = sid(String(++n));
        yield init(s);
        if (p.startsWith('New goal')) {
          const zoned = p.includes('build the shop');
          await callTool(opts, 'create_task', { title: zoned ? 'shop' : 'notes', description: 'do it', assignee: 'kit', ...(zoned ? { zone: 'B' } : {}) });
        } else {
          const taskId = /Your task: (t\d+)/.exec(p)?.[1];
          if (taskId && opts.cwd!.includes('kit-')) {
            const t = team.fm.tasks.require(taskId);
            const append = (opts.systemPrompt as { append?: string }).append ?? '';
            started.set(t.title, append);
            const rel = t.zone ? path.join('zones', 'B.json') : 'NOTES.md';
            fs.mkdirSync(path.join(opts.cwd!, path.dirname(rel)), { recursive: true });
            fs.writeFileSync(path.join(opts.cwd!, rel), t.zone ? JSON.stringify({ zone: 'B', boxes: [] }) : 'notes\n');
            await callTool(opts, 'update_task', { task_id: taskId, status: 'review', summary: `wrote ${rel}` });
          }
        }
        yield result(s);
      }
      return Object.assign(run(), { close() {}, accountInfo: async () => ({ email: 'x' }) });
    };
  }

  beforeAll(async () => {
    teamHome = tempDir();
    repoPath = await demoRepo();
    team = makeForeman(teamHome, ['--backend', 'claude', '--workers', 'kit', '--repo', repoPath, '--no-lead-review', '--ci', 'node -e ""']);
    await team.fm.start(new ClaudeBackend(team.fm, team.cfg.claude, { queryFn: fakeQuery() as never, skipAuthCheck: true }));
  });

  afterAll(async () => {
    await team.fm.close();
    rmrf(teamHome);
    rmrf(path.dirname(repoPath));
  });

  it('a zone task gets the builder prompt, a plain task the coding prompt', async () => {
    await team.fm.submitGoal('build the shop');
    await until(() => started.has('shop'), 30_000);
    await team.fm.submitGoal('write some notes');
    await until(() => started.has('notes'), 30_000);

    const shop = started.get('shop')!;
    expect(shop).toContain('You are a builder.');
    expect(shop).toContain('zones/B.json');
    expect(shop).not.toContain('run the test suite');

    const notes = team.fm.tasks.list().find((t) => t.title === 'notes')!;
    const wt = team.fm.repos.requireWorktree(notes.repoId!, notes.worktree!);
    expect(started.get('notes')).toBe(workerSystemPrompt(team.fm, 'kit', wt));
  });
});
