// J-05 auto-compact (GATE-auto.md): a compat row push that leaves a task at AUTO_COMPACT_AT (= STEP_CAP - 10) live
// steps folds the task's older done steps RIGHT AFTER the push's own writes, as the compat coordinator token with
// origin `auto-compact lane=<lane>`. Covered here: the threshold (39 -> 40 compacts, 38 -> 39 does not), the post-push
// order, the origin/actor in the journal, no-op compacts never journaled (a retried PUT), a reopened done step never
// archived, the up-front cap refusal (zero journal growth), the kill switch OFF = no compact, owner/asked/waiting
// steps kept, times untouched, and deterministic replay of push + compact.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createBoard } from '../src/board.mjs';
import { measuredTimes } from '../src/views.mjs';
import { OWNER, tmpDir } from './helpers.mjs';
import { s21Board } from './s21-helpers.mjs';

const H = 3600000, T0 = Date.parse('2026-10-01T00:00:00.000Z');
const TASK = 'CAP-1';
const short = n => `s${String(n).padStart(2, '0')}`;
const clone = o => JSON.parse(JSON.stringify(o));
const journal = dir => fs.readFileSync(path.join(dir, 'events.ndjson'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
const compacts = dir => journal(dir).filter(e => e.op === 'steps.compact');

/** A compat board (real HTTP) whose clock the test owns, and a task whose `count` steps are walked to done one hour apart. */
async function seeded({ count = 39, autoCompact = true, steps, complete = true, dataDir } = {}) {
  let clock = T0;
  const s = await s21Board({ autoCompact, now: () => clock, ...(dataDir ? { dataDir } : {}) });
  const ids = steps ?? Array.from({ length: count }, (_, i) => short(i + 1));
  s.w('task.create', TASK, { title: 'Cap task', lane: 'Workera CoS', steps: ids.map((id, i) => ({ id, label: `Bước ${i + 1}`, zone: 'build', state: 'todo' })) });
  if (complete) for (const id of s.board.state.tasks[TASK].step_ids.slice()) {
    if (s.board.state.steps[`${TASK}/${id}`].state === 'done') continue;
    clock += H;
    s.w('step.update', `${TASK}/${id}`, { state: 'done' }, { expected_revision: 1 });
  }
  return { s, clock: () => clock, tick: (h = 1) => { clock += h * H; } };
}

/** The task as the CLI pushes it: the board's own steps, field for field (no drift, so an unchanged row writes nothing). */
function rowOf(s, over = {}) {
  const t = s.board.state.tasks[TASK];
  const steps = t.step_ids.filter(id => id !== 'lich-su').map(id => {
    const st = s.board.state.steps[`${TASK}/${id}`];
    return { id: st.id.slice(st.id.indexOf('/') + 1), label: st.label, sub: st.sub ?? '', state: st.state, zone: st.zone === 'owner' ? 'anh' : st.zone, ...(st.detail !== undefined ? { detail: st.detail } : {}) };
  });
  return { code: TASK, title: t.title, lane: t.lane, health: t.health, goal: t.goal ?? '', now: t.now ?? '', next: t.next ?? '', order: t.order, ...over, steps: over.steps ?? steps };
}
const todo = id => ({ id, label: `Bước ${id}`, sub: '', state: 'todo', zone: 'build' });

test('a push that reaches STEP_CAP - 10 compacts AFTER the push, as the coordinator with an auto-compact origin', async () => {
  const { s } = await seeded({ count: 39 });
  try {
    const timesBefore = clone(s.board.state.times);
    const before = journal(s.dataDir).length;
    const res = await s.push([rowOf(s, { steps: [...rowOf(s).steps, todo('s40')] })]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.compacted, [{ task: TASK, moved: 29 }]);
    assert.equal(res.body.writes, 1, 'the push counts its own write; the compact is reported separately');

    const ev = journal(s.dataDir).slice(before), compactEv = ev.find(e => e.op === 'steps.compact');
    assert.ok(compactEv, 'the compact is journaled');
    assert.equal(compactEv.actor.role, 'coordinator', 'the compat coordinator token, the actor of every push write');
    assert.equal(compactEv.actor.origin, 'auto-compact lane=Workera CoS');
    assert.equal(compactEv.data.keep_last, 10);
    assert.equal(compactEv.data.moved.length, 29);
    assert.equal(ev.at(-1).op, 'steps.compact', 'the compact is the push\'s last write');
    assert.ok(compactEv.seq > ev.find(e => e.op === 'step.create').seq, 'after the push wrote its new step');

    const ids = s.steps(TASK);
    assert.deepEqual(ids.slice(0, 2), ['lich-su', 's30'], 'one history step, then the 10 kept done steps');
    assert.equal(ids.length, 12, '1 history + 10 kept done + the pushed step');
    assert.ok(ids.includes('s40'));
    assert.deepEqual(s.board.state.archive[TASK].order, Array.from({ length: 29 }, (_, i) => short(i + 1)));

    // State.times: the new step has its own record, the compaction itself changed none, and lich-su has none.
    const after = clone(s.board.state.times);
    delete after[`${TASK}/s40`];
    assert.deepEqual(after, timesBefore, 'every pre-existing timing record is byte-identical');
    assert.equal(s.board.state.times[`${TASK}/lich-su`], undefined, 'the folded history is not work: no timing record');
    assert.ok(s.board.state.times[`${TASK}/s01`], 'an archived step keeps its timing history');
  } finally { await s.close(); }
});

test('a push to 39 steps does not compact, and the reply carries no compacted field', async () => {
  const { s } = await seeded({ count: 38 });
  try {
    const before = journal(s.dataDir).length;
    const res = await s.push([rowOf(s, { steps: [...rowOf(s).steps, todo('s39')] })]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal('compacted' in res.body, false);
    assert.equal(s.steps(TASK).length, 39);
    assert.equal(compacts(s.dataDir).length, 0);
    assert.equal(journal(s.dataDir).slice(before).some(e => e.op === 'steps.compact'), false);
  } finally { await s.close(); }
});

test('a retried PUT writes no second compact and journal nothing (no-op compacts never land)', async () => {
  const { s } = await seeded({ count: 39 });
  try {
    const row = rowOf(s, { steps: [...rowOf(s).steps, todo('s40')] });
    const first = await s.push([row]);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(compacts(s.dataDir).length, 1);
    const seq = s.board.state.seq, snapshot = clone(s.board.state.steps);
    const again = await s.push([row]);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.writes, 0, 'the row is already applied');
    assert.equal('compacted' in again.body, false, 'nothing eligible: the auto path writes nothing');
    assert.equal(s.board.state.seq, seq, 'no journal growth at all');
    assert.equal(compacts(s.dataDir).length, 1);
    assert.deepEqual(clone(s.board.state.steps), snapshot);
  } finally { await s.close(); }
});

test('a push that reopens a done step never archives it, and a lane push names that lane in the origin', async () => {
  const { s } = await seeded({ count: 39 });
  try {
    const steps = rowOf(s).steps.map(st => (st.id === 's01' ? { ...st, state: 'active' } : st));
    const res = await s.push([rowOf(s, { steps: [...steps, todo('s40')] })], { lane: 'Workera CoS' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.compacted, [{ task: TASK, moved: 28 }], 's01 is active now: not eligible');
    assert.ok(s.steps(TASK).includes('s01'), 'the reopened step stays live');
    assert.equal(s.board.state.steps[`${TASK}/s01`].state, 'active');
    assert.equal(s.board.state.archive[TASK].steps.s01, undefined, 'never archived');
    assert.equal(compacts(s.dataDir)[0].actor.origin, 'auto-compact lane=Workera CoS');
  } finally { await s.close(); }
});

test('a push that would exceed the cap is refused before the first write: zero journal growth, the new message', async () => {
  const { s } = await seeded({ count: 50 });
  try {
    const before = fs.readFileSync(path.join(s.dataDir, 'events.ndjson'), 'utf8'), seq = s.board.state.seq;
    const res = await s.push([rowOf(s, { steps: [...rowOf(s).steps, todo('s51')] })]);
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.error, 'too_many_steps');
    assert.equal(res.body.message, 'không còn bước cũ đã xong để gộp; hãy đóng hoặc gộp tay');
    assert.equal(res.body.steps, 51); assert.equal(res.body.cap, 50);
    assert.equal(s.board.state.seq, seq, 'nothing written, not even the step that used to land first');
    assert.equal(fs.readFileSync(path.join(s.dataDir, 'events.ndjson'), 'utf8'), before, 'journal byte-identical');
    assert.equal(s.steps(TASK).length, 50);
    assert.equal(compacts(s.dataDir).length, 0);
  } finally { await s.close(); }
});

test('kill switch OFF: the same multi-write push journals exactly the old events (ON = OFF + one compact)', async () => {
  // One push that writes several ops: a row field (now), two new steps, and a needsAnh ask on the waiting owner step.
  const seedSteps = [...Array.from({ length: 38 }, (_, i) => short(i + 1)), 'w1'];
  const pushIt = async autoCompact => {
    const { s } = await seeded({ steps: seedSteps, autoCompact });
    try {
      const t = s.board.state.tasks[TASK], w1 = s.board.state.steps[`${TASK}/w1`];
      s.w('step.update', `${TASK}/w1`, { state: 'waiting', zone: 'owner' }, { expected_revision: w1.rev });
      const row = rowOf(s, { now: 'pushed now', needsAnh: 'Duyệt bước này?', askStep: 'w1', steps: [...rowOf(s).steps, todo('s39'), todo('s40')] });
      const before = journal(s.dataDir).length, seq = s.board.state.seq;
      const res = await s.push([row]);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      return { s, res, seq, ev: journal(s.dataDir).slice(before), steps: s.steps(TASK) };
    } catch (e) { await s.close(); throw e; }
  };
  const off = await pushIt(false);
  try {
    assert.deepEqual(off.ev.map(e => e.op), ['task.update', 'step.create', 'step.create', 'ask.raise'], 'the old push writes exactly these');
    assert.equal('compacted' in off.res.body, false);
    assert.equal(off.steps.length, 41, 'no fold: the task simply grows');
    assert.equal(off.s.board.state.archive[TASK], undefined);
  } finally { await off.s.close(); }
  const on = await pushIt(true);
  try {
    const same = (a, b) => JSON.stringify({ op: a.op, target: a.target_id, data: a.data, role: a.actor.role }) === JSON.stringify({ op: b.op, target: b.target_id, data: b.data, role: b.actor.role });
    assert.equal(on.ev.length, off.ev.length + 1, 'ON adds exactly one event');
    assert.ok(off.ev.every((e, i) => same(e, on.ev[i])), 'the push\'s own events are identical with the switch on');
    assert.equal(on.ev.at(-1).op, 'steps.compact');
    assert.deepEqual(on.res.body.compacted, [{ task: TASK, moved: 28 }]);
  } finally { await on.s.close(); }
});

test('40 live steps with nothing eligible: the push writes nothing and no compact is journaled', async () => {
  // Exactly the threshold, but every step is still todo: the branch is entered and must write nothing.
  const { s } = await seeded({ steps: Array.from({ length: 40 }, (_, i) => short(i + 1)), complete: false });
  try {
    const seq = s.board.state.seq;
    const res = await s.push([rowOf(s)]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.writes, 0);
    assert.equal('compacted' in res.body, false);
    assert.equal(s.board.state.seq, seq, 'not even an empty steps.compact event');
    assert.equal(compacts(s.dataDir).length, 0);
  } finally { await s.close(); }
});

test('a row that fails AFTER an earlier row was written compacts nothing (Q1: no compact behind a refused push)', async () => {
  const { s } = await seeded({ count: 39 });
  try {
    const before = journal(s.dataDir).length;
    const good = rowOf(s, { steps: [...rowOf(s).steps, todo('s40')] });
    const bad = { code: 'NEW-1', steps: [todo('n1')] }; // no title: task.create refuses it at write time
    const res = await s.push([good, bad]);
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.error, 'invalid_data');
    const ops = journal(s.dataDir).slice(before).map(e => e.op);
    assert.ok(ops.includes('step.create'), 'the good row\'s writes landed, as a push always wrote its events one by one');
    assert.equal(ops.includes('steps.compact'), false, 'but the compact did not run');
    assert.equal(s.steps(TASK).length, 40);
    assert.equal(s.board.state.archive[TASK], undefined);
  } finally { await s.close(); }
});

test('a done owner step with nothing open folds; asked and waiting steps are kept; the open ask survives the compact', async () => {
  // o1 is the OLDEST step (so it sits inside the eligible window), a done owner step nobody asked about, k1 the newest done, w1 waits on the owner.
  const ids = ['o1', ...Array.from({ length: 36 }, (_, i) => short(i + 1)), 'k1', 'w1'];
  const { s } = await seeded({ steps: ids });
  try {
    // o1: a done owner-zone step with no open ask (answered, so it folds), s03: a done step with an open ask, w1: waiting on the owner (never compactable).
    s.w('step.update', `${TASK}/o1`, { zone: 'owner' }, { expected_revision: s.board.state.steps[`${TASK}/o1`].rev });
    s.w('step.update', `${TASK}/w1`, { state: 'waiting', zone: 'owner' }, { expected_revision: s.board.state.steps[`${TASK}/w1`].rev });
    s.w('ask.raise', TASK, { step_id: 's03', text: 'Giữ bước này?' });
    const res = await s.push([rowOf(s, { steps: [...rowOf(s).steps, todo('s40')] })]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.compacted[0].moved, 27, 'only the asked step is skipped, the rest of the old done steps (the owner one too) move');
    const live = s.steps(TASK);
    for (const id of ['lich-su', 's03', 'w1', 's40']) assert.ok(live.includes(id), id + ' stays live');
    assert.equal(s.board.state.steps[`${TASK}/w1`].state, 'waiting');
    const ask = s.openAsks(TASK)[0];
    assert.deepEqual([ask.step_id, ask.text, ask.status], ['s03', 'Giữ bước này?', 'open'], 'the ask is still open, on its step');
    assert.ok(!live.includes('o1'), 'the answered owner step folded'); assert.equal(s.board.state.archive[TASK].steps.o1.zone, 'owner', 'whole record archived');
    assert.equal(s.board.state.archive[TASK].steps.s03, undefined);
  } finally { await s.close(); }
});

test('compaction leaves measured time and task time intact (the archive keeps the same records)', async () => {
  const { s } = await seeded({ count: 39 });
  try {
    const now = T0 + 500 * H;
    const measuredBefore = clone(measuredTimes(s.board.state, TASK, now));
    const taskTimesBefore = clone(s.board.state.task_times);
    const res = await s.push([rowOf(s, { steps: [...rowOf(s).steps, todo('s40')] })]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(clone(measuredTimes(s.board.state, TASK, now)), measuredBefore, 'work/wait is identical');
    assert.deepEqual(clone(s.board.state.task_times), taskTimesBefore, 'the task clock did not move because of the fold');
  } finally { await s.close(); }
});

test('journal replay from an empty projection reproduces the push + auto-compact state exactly', async () => {
  const seedDir = path.join(tmpDir(), 'replay');
  const { s } = await seeded({ count: 39, dataDir: seedDir });
  let final;
  try {
    const res = await s.push([rowOf(s, { steps: [...rowOf(s).steps, todo('s40')] })]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(compacts(seedDir).length, 1);
    final = clone(s.board.state);
  } finally { await s.close(); }
  fs.rmSync(path.join(seedDir, 'state.json'));
  const b2 = createBoard({ dataDir: seedDir, ownerToken: OWNER });
  try {
    assert.ok(b2.replayed > 0);
    assert.deepEqual(clone(b2.state), final, 'same journal, same state: the compact is an ordinary event in order');
    assert.ok(b2.state.archive[TASK], 'the archive is rebuilt from the journal');
  } finally { b2.close(); }
});
