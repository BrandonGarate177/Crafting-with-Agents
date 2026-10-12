// A zone task's CI parses its blueprint: a broken `zones/<letter>.json` fails CI with the parser's
// error and goes back to the worker once, like a failing test suite. Fake SDK like
// claude-backend.test.ts: the lead plans one task per goal, Kit writes the zone file the task's
// title asks for. No lead review, so a task that clears CI lands straight on a merge decision.
import fs from 'node:fs';
import path from 'node:path';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClaudeBackend } from '../src/agents/claude/index.js';
import { demoRepo, makeForeman, rmrf, tempDir, until, type Harness } from './helpers.js';

type ToolServer = { instance: { _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<{ content: Array<{ text: string }> }> }> } };

async function callTool(options: Options, name: string, args: Record<string, unknown>): Promise<string> {
  const server = options.mcpServers!.agentcraft as unknown as ToolServer;
  const res = await server.instance._registeredTools[name]!.handler(args, {});
  return res.content.map((c) => c.text).join('\n');
}

const VALID = JSON.stringify({ zone: 'B', boxes: [{ from: [0, 0, 0], to: [3, 0, 3], block: 'minecraft:cobblestone' }] });
// clamped (x 99 is past the 16-wide slot) and an unknown block: notes, not failures
const NOTED = JSON.stringify({ zone: 'B', boxes: [{ from: [0, 0, 0], to: [99, 0, 0], block: 'minecraft:gold_block' }] });
const BROKEN = '{ "zone": "B", "boxes": [';

/** What Kit writes on the first turn and on each follow-up, by task title. */
const PLANS: Record<string, { file?: string; first: string; again: string }> = {
  'fix it': { file: 'B', first: BROKEN, again: VALID },
  'stay broken': { file: 'B', first: BROKEN, again: BROKEN },
  'valid': { file: 'B', first: NOTED, again: NOTED },
  'no zone': { first: 'plain notes\n', again: 'plain notes\n' },
};

const sid = (k: string) => `00000000-0000-4000-8000-${k.padStart(12, '0')}`;
let n = 0;
const msg = (o: Record<string, unknown>) => ({ parent_tool_use_id: null, uuid: sid(String(++n)), ...o }) as unknown as SDKMessage;
const init = (session: string) => msg({ type: 'system', subtype: 'init', session_id: session, model: 'fake-model', cwd: '', tools: [] });
const result = (session: string, text = 'done') => msg({ type: 'result', subtype: 'success', is_error: false, result: text, num_turns: 1, total_cost_usd: 0.001, session_id: session, duration_ms: 1, duration_api_ms: 1, usage: {}, modelUsage: {}, permission_denials: [] });

const followups: Array<{ task: string; prompt: string }> = [];

function fakeQuery(h: Harness) {
  return ({ prompt, options }: { prompt: string | AsyncIterable<unknown>; options?: Options }) => {
    const opts = options!;
    const p = String(prompt);
    async function* run(): AsyncGenerator<SDKMessage> {
      if (p.startsWith('New goal')) {
        const s = sid(String(++n));
        yield init(s);
        const title = Object.keys(PLANS).find((k) => p.includes(`zone check: ${k}`))!;
        const plan = PLANS[title]!;
        await callTool(opts, 'create_task', { title, description: 'build the zone', assignee: 'kit', ...(plan.file ? { zone: plan.file } : {}) });
        yield result(s, 'planned');
        return;
      }
      const first = /Your task: (t\d+)/.exec(p)?.[1];
      const again = /for (t\d+)/.exec(p)?.[1];
      const taskId = first ?? again;
      if (taskId && opts.cwd!.includes('kit-')) {
        const t = h.fm.tasks.require(taskId);
        const plan = PLANS[t.title]!;
        if (!first) followups.push({ task: taskId, prompt: p });
        const s = sid(`7${taskId.slice(1)}`);
        yield init(s);
        const rel = plan.file ? path.join('zones', `${plan.file}.json`) : 'NOTES.md';
        fs.mkdirSync(path.join(opts.cwd!, path.dirname(rel)), { recursive: true });
        fs.writeFileSync(path.join(opts.cwd!, rel), first ? plan.first : plan.again);
        await callTool(opts, 'update_task', { task_id: taskId, status: 'review', summary: `wrote ${rel}` });
        yield result(s, 'written');
        return;
      }
      const s = sid('9999');
      yield init(s);
      yield result(s, 'ok');
    }
    return Object.assign(run(), { close() {}, accountInfo: async () => ({ email: 'x' }) });
  };
}

let h: Harness;
let home: string;
let repoPath: string;

beforeAll(async () => {
  home = tempDir();
  repoPath = await demoRepo();
  // the demo repo's own tests pass; `--ci` keeps the run fast and the blueprint the only thing that can fail
  h = makeForeman(home, ['--backend', 'claude', '--workers', 'kit', '--repo', repoPath, '--no-lead-review', '--ci', 'node -e ""']);
  await h.fm.start(new ClaudeBackend(h.fm, h.cfg.claude, { queryFn: fakeQuery(h) as never, skipAuthCheck: true }));
});

afterAll(async () => {
  await h.fm.close();
  rmrf(home);
  rmrf(path.dirname(repoPath));
});

/** Plan one task through the lead and wait until it reaches a merge decision. */
async function runToMerge(title: string) {
  const goal = await h.fm.submitGoal(`zone check: ${title}`);
  await until(() => h.fm.tasks.list().some((t) => t.goalId === goal.id));
  const t = h.fm.tasks.list().find((x) => x.goalId === goal.id)!;
  await until(() => h.fm.decisions.open().some((d) => d.kind === 'merge' && d.taskId === t.id), 60_000);
  const decision = h.fm.decisions.open().find((d) => d.kind === 'merge' && d.taskId === t.id)!;
  const feed = h.fm.store.data.feed.filter((f) => f.kind === 'ci' && f.text.startsWith(`${t.id}:`)).map((f) => f.text);
  return { task: h.fm.tasks.require(t.id), decision, feed, sentBack: followups.filter((f) => f.task === t.id) };
}

describe('zone blueprint check in CI', () => {
  it('fails a broken blueprint with the parser error and sends it back once', async () => {
    const r = await runToMerge('fix it');
    expect(r.task.zone?.letter).toBe('B');
    expect(r.sentBack).toHaveLength(1);
    expect(r.sentBack[0]!.prompt).toContain(`CI failed for ${r.task.id}`);
    expect(r.sentBack[0]!.prompt).toContain('zones/B.json: not valid JSON');
    expect(r.feed.some((f) => f.includes('blueprint zones/B.json fail: zones/B.json: not valid JSON'))).toBe(true);
    // the fixed file passes on the second run
    expect(r.feed.some((f) => f.includes('blueprint zones/B.json ok, 1 fills'))).toBe(true);
    expect(r.task.ci).toBe('pass');
  });

  it('does not send a second broken blueprint back again', async () => {
    const r = await runToMerge('stay broken');
    expect(r.sentBack).toHaveLength(1);
    // retries spent: the task goes on to the merge decision with CI failed and the error on record
    expect(r.task.ci).toBe('fail');
    expect(r.decision.context).toContain('tests: fail');
    expect(r.feed.filter((f) => f.includes('blueprint zones/B.json fail'))).toHaveLength(2);
    expect(r.feed.some((f) => f.includes('tests fail') && f.includes('zones/B.json check'))).toBe(true);
  });

  it('passes a valid blueprint and reports clamp and palette notes as information', async () => {
    const r = await runToMerge('valid');
    expect(r.sentBack).toHaveLength(0);
    expect(r.task.ci).toBe('pass');
    const line = r.feed.find((f) => f.includes('blueprint zones/B.json ok'))!;
    expect(line).toContain('clamped');
    expect(line).toContain('"minecraft:gold_block" is not in the palette');
  });

  it('skips the check for a task without a zone', async () => {
    const r = await runToMerge('no zone');
    expect(r.task.zone).toBeUndefined();
    expect(r.sentBack).toHaveLength(0);
    expect(r.task.ci).toBe('pass');
    expect(r.feed.some((f) => f.includes('blueprint'))).toBe(false);
    expect(r.feed.some((f) => f.includes('tests pass'))).toBe(true);
  });
});
