import { afterEach, describe, expect, it } from 'vitest';
import type { Zone } from '../src/protocol.js';
import { makeForeman, rmrf, tempDir, type Harness } from './helpers.js';

let h: Harness;
let home: string;

function setup(): Harness {
  home = tempDir();
  h = makeForeman(home, ['--backend', 'sim']);
  return h;
}

afterEach(async () => {
  await h?.fm.close();
  rmrf(home);
});

describe('TaskGraph', () => {
  it('creates tasks with sequential ids and validates deps', () => {
    const { fm } = setup();
    const a = fm.tasks.create({ title: 'A', createdBy: 'marlow' });
    const b = fm.tasks.create({ title: 'B', deps: [a.id], createdBy: 'marlow' });
    expect([a.id, b.id]).toEqual(['t1', 't2']);
    expect(b.deps).toEqual(['t1']);
    expect(() => fm.tasks.create({ title: 'C', deps: ['t99'], createdBy: 'marlow' })).toThrow(/unknown dependency/);
    expect(() => fm.tasks.create({ title: '   ', createdBy: 'marlow' })).toThrow(/empty/);
  });

  it('rejects self-deps and cycles', () => {
    const { fm } = setup();
    const a = fm.tasks.create({ title: 'A', createdBy: 'marlow' });
    const b = fm.tasks.create({ title: 'B', deps: [a.id], createdBy: 'marlow' });
    const c = fm.tasks.create({ title: 'C', deps: [b.id], createdBy: 'marlow' });
    expect(() => fm.tasks.update(a.id, { deps: [a.id] })).toThrow(/itself/);
    expect(() => fm.tasks.update(a.id, { deps: [c.id] })).toThrow(/cycle/);
    expect(fm.tasks.wouldCycle(a.id, [c.id])).toBe(true);
    expect(fm.tasks.wouldCycle(c.id, [a.id])).toBe(false);
  });

  it('only starts a task when it has an assignee and its deps are done', () => {
    const { fm } = setup();
    const a = fm.tasks.create({ title: 'A', createdBy: 'marlow' });
    const b = fm.tasks.create({ title: 'B', deps: [a.id], createdBy: 'marlow' });
    expect(() => fm.tasks.setStatus(a.id, 'doing')).toThrow(/no assignee/);
    fm.tasks.update(b.id, { assignee: 'kit' });
    expect(() => fm.tasks.setStatus(b.id, 'doing')).toThrow(/waiting on t1/);
    expect(fm.tasks.ready().map((t) => t.id)).toEqual(['t1']);
    fm.tasks.update(a.id, { assignee: 'juniper' });
    fm.tasks.setStatus(a.id, 'doing');
    fm.tasks.setStatus(a.id, 'review');
    fm.tasks.setStatus(a.id, 'done');
    expect(fm.tasks.ready().map((t) => t.id)).toEqual(['t2']);
    fm.tasks.setStatus(b.id, 'doing');
    expect(fm.tasks.get(b.id)!.status).toBe('doing');
  });

  it('enforces the transition table', () => {
    const { fm } = setup();
    const a = fm.tasks.create({ title: 'A', assignee: 'kit', createdBy: 'marlow' });
    fm.tasks.setStatus(a.id, 'doing');
    fm.tasks.setStatus(a.id, 'review');
    fm.tasks.setStatus(a.id, 'done');
    expect(() => fm.tasks.setStatus(a.id, 'review')).toThrow(/cannot move/);
    fm.tasks.setStatus(a.id, 'todo'); // retry
    fm.tasks.setStatus(a.id, 'cancelled');
    expect(() => fm.tasks.setStatus(a.id, 'doing')).toThrow(/cannot move/);
  });

  it('a task with a worktree becomes done only via an approved merge', () => {
    const { fm } = setup();
    const a = fm.tasks.create({ title: 'A', assignee: 'kit', createdBy: 'marlow' });
    fm.tasks.update(a.id, { worktree: 'kit-t1' });
    fm.tasks.setStatus(a.id, 'doing');
    fm.tasks.setStatus(a.id, 'review');
    expect(() => fm.tasks.setStatus(a.id, 'done')).toThrow(/approved merge/);
    fm.tasks.setStatus(a.id, 'done', { viaMerge: true });
    expect(fm.tasks.get(a.id)!.status).toBe('done');
  });

  it('blocked tasks record a reason that clears on unblock', () => {
    const { fm } = setup();
    const a = fm.tasks.create({ title: 'A', createdBy: 'marlow' });
    fm.tasks.setStatus(a.id, 'blocked', { reason: 'needs credentials' });
    expect(fm.tasks.get(a.id)!.blockedReason).toBe('needs credentials');
    fm.tasks.setStatus(a.id, 'todo');
    expect(fm.tasks.get(a.id)!.blockedReason).toBeUndefined();
  });

  it('orders ready tasks by priority then age, and computes goal progress', () => {
    const { fm } = setup();
    const g = fm.createGoal('test goal');
    fm.setGoal(g.id, { status: 'active' });
    const a = fm.tasks.create({ title: 'A', goalId: g.id, createdBy: 'marlow', assignee: 'kit' });
    const b = fm.tasks.create({ title: 'B', goalId: g.id, createdBy: 'marlow', priority: 5 });
    const c = fm.tasks.create({ title: 'C', goalId: g.id, createdBy: 'marlow' });
    expect(fm.tasks.ready(g.id).map((t) => t.id)).toEqual([b.id, a.id, c.id]);
    fm.tasks.setStatus(a.id, 'doing');
    fm.tasks.setStatus(a.id, 'review');
    fm.tasks.setStatus(a.id, 'done');
    fm.tasks.setStatus(c.id, 'cancelled');
    expect(fm.tasks.progress(g.id)).toBe(0.5);
    expect(fm.tasks.goalComplete(g.id)).toBe(false);
    fm.tasks.update(b.id, { assignee: 'wren' });
    fm.tasks.setStatus(b.id, 'doing');
    fm.tasks.setStatus(b.id, 'done');
    expect(fm.tasks.goalComplete(g.id)).toBe(true);
  });

  it('broadcasts task.upsert and goal progress', async () => {
    const { fm, events } = setup();
    const g = fm.createGoal('broadcast goal');
    fm.setGoal(g.id, { status: 'active' });
    const a = fm.tasks.create({ title: 'A', goalId: g.id, createdBy: 'marlow', assignee: 'kit' });
    fm.tasks.setStatus(a.id, 'doing');
    fm.tasks.setStatus(a.id, 'done');
    await new Promise((r) => setTimeout(r, 10));
    expect(events.filter((e) => e.type === 'task.upsert').length).toBeGreaterThanOrEqual(3);
    const goalEvents = events.filter((e) => e.type === 'goal.upsert');
    const last = goalEvents[goalEvents.length - 1];
    expect(last && last.type === 'goal.upsert' && last.goal.status).toBe('done');
  });
});

describe('TaskGraph zones', () => {
  const zoneB: Zone = { letter: 'B', box: { x: 30, y: 64, z: 10, w: 16, h: 16, d: 14 } };
  const zoneC: Zone = { letter: 'C', box: { x: 46, y: 64, z: 10, w: 16, h: 16, d: 14 } };

  it('keeps a zone through create and update, and clears it with null', () => {
    const { fm } = setup();
    const a = fm.tasks.create({ title: 'Zone B: west shop', zone: zoneB, createdBy: 'marlow' });
    expect(a.zone).toEqual(zoneB);
    expect(a.zone).not.toBe(zoneB); // stored as a copy
    fm.tasks.update(a.id, { title: 'Zone B: bakery', assignee: 'kit', priority: 5 });
    expect(fm.tasks.get(a.id)!.zone).toEqual(zoneB);
    fm.tasks.update(a.id, { zone: zoneC });
    expect(fm.tasks.get(a.id)!.zone).toEqual(zoneC);
    fm.tasks.setStatus(a.id, 'doing');
    expect(fm.tasks.get(a.id)!.zone).toEqual(zoneC);
    fm.tasks.update(a.id, { zone: null });
    expect('zone' in fm.tasks.get(a.id)!).toBe(false);
  });

  it('leaves tasks without a zone untouched', () => {
    const { fm } = setup();
    const a = fm.tasks.create({ title: 'Add a --version flag', createdBy: 'marlow' });
    expect('zone' in a).toBe(false);
    fm.tasks.update(a.id, { description: 'print it', assignee: 'kit' });
    fm.tasks.update(a.id, { zone: null });
    expect('zone' in fm.tasks.get(a.id)!).toBe(false);
    expect(JSON.stringify(fm.tasks.get(a.id))).not.toContain('zone');
  });

  it('broadcasts the zone on task.upsert, and only for tasks that have one', () => {
    const { fm, events } = setup();
    const a = fm.tasks.create({ title: 'Zone B', zone: zoneB, createdBy: 'marlow' });
    const b = fm.tasks.create({ title: 'plain', createdBy: 'marlow' });
    const upserts = events.flatMap((e) => (e.type === 'task.upsert' ? [e.task] : []));
    expect(upserts.find((t) => t.id === a.id)!.zone).toEqual(zoneB);
    expect('zone' in upserts.find((t) => t.id === b.id)!).toBe(false);
    fm.tasks.update(a.id, { zone: null });
    const last = events.filter((e) => e.type === 'task.upsert').pop();
    expect(last?.type === 'task.upsert' && 'zone' in last.task).toBe(false);
  });

  it('keeps zones across a save and reload', async () => {
    const { fm } = setup();
    const a = fm.tasks.create({ title: 'Zone B', zone: zoneB, createdBy: 'marlow' });
    const b = fm.tasks.create({ title: 'plain', createdBy: 'marlow' });
    await fm.close();
    h = makeForeman(home, ['--backend', 'sim']);
    expect(h.fm.tasks.get(a.id)!.zone).toEqual(zoneB);
    expect('zone' in h.fm.tasks.get(b.id)!).toBe(false);
    const snap = h.fm.snapshot();
    expect(snap.type === 'snapshot' && snap.tasks.find((t) => t.id === a.id)!.zone).toEqual(zoneB);
  });
});
