// Gap G1 of the live-board migration: a predecessor board's server-measured timing history is imported
// losslessly (field-for-field); the per-task totals equal the predecessor's except where it double-counted waits
// (parallel waits, non-owner steps: see test/measured.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createBoard } from '../src/board.mjs';
import { legacyTimesToRequests } from '../src/adapt-legacy.mjs';
import { measuredTimes } from '../src/views.mjs';
import { OWNER, tmpDir } from './helpers.mjs';

let n = 0;
const req = (op, target_id, data, extra = {}) => ({ version: 1, request_id: `times-${process.pid}-${++n}`, op, target_id, data, ...extra });
const NOW = Date.parse('2026-09-28T06:00:00.000Z');

// Predecessor format, as written by its updateTimes(): camelCase, null for "absent", `t` on transitions.
const LEGACY = {
  tasks: {
    'T-1': {
      firstSeenAt: '2026-09-27T01:00:00.000Z', startedAt: '2026-09-27T01:00:00.000Z', doneAt: null,
      steps: {
        s1: { firstSeenAt: '2026-09-27T01:00:00.000Z', startedAt: null, doneAt: null, waitingSince: null, waitingTotalMs: 0, lastState: 'done', untracked: true, transitions: [] },
        s2: { firstSeenAt: '2026-09-27T01:00:00.000Z', startedAt: '2026-09-27T01:00:00.000Z', doneAt: '2026-09-27T03:00:00.000Z', waitingSince: null, waitingTotalMs: 1800000, lastState: 'done', untracked: false,
          transitions: [{ t: '2026-09-27T02:00:00.000Z', from: 'active', to: 'waiting' }, { t: '2026-09-27T02:30:00.000Z', from: 'waiting', to: 'active' }, { t: '2026-09-27T03:00:00.000Z', from: 'active', to: 'done' }] },
        s3: { firstSeenAt: '2026-09-27T03:00:00.000Z', startedAt: null, doneAt: null, waitingSince: '2026-09-28T04:00:00.000Z', waitingTotalMs: 0, lastState: 'waiting', untracked: false,
          transitions: [{ t: '2026-09-28T04:00:00.000Z', from: 'todo', to: 'waiting' }] },
        s4: { firstSeenAt: '2026-09-27T03:00:00.000Z', startedAt: null, doneAt: null, waitingSince: null, waitingTotalMs: 0, lastState: 'todo', untracked: false, transitions: [] },
        gone: { firstSeenAt: '2026-09-27T01:00:00.000Z', startedAt: null, doneAt: null, waitingSince: null, waitingTotalMs: 600000, lastState: 'todo', untracked: false, transitions: [] }
      }
    },
    OLD: { firstSeenAt: '2026-09-26T00:00:00.000Z', startedAt: '2026-09-26T00:00:00.000Z', doneAt: '2026-09-26T05:00:00.000Z',
      steps: { s1: { firstSeenAt: '2026-09-26T00:00:00.000Z', startedAt: '2026-09-26T00:00:00.000Z', doneAt: '2026-09-26T05:00:00.000Z', waitingSince: null, waitingTotalMs: 0, lastState: 'done', untracked: false, transitions: [] } } }
  }
};

/** The predecessor page's taskTimeSummary(), verbatim in arithmetic: returns { work, wait } in ms. */
function legacyTotals(tt, now) {
  if (!tt || !tt.startedAt) return null;
  const started = Date.parse(tt.startedAt), end = tt.doneAt ? Date.parse(tt.doneAt) : now;
  let waitMs = 0; Object.values(tt.steps || {}).forEach(s => { waitMs += s.waitingTotalMs || 0; if (s.waitingSince) waitMs += now - Date.parse(s.waitingSince); });
  return { work: Math.max(0, (end - started) - waitMs), wait: waitMs };
}

function board(dir) {
  const b = createBoard({ dataDir: dir, ownerToken: OWNER, now: () => NOW });
  const coord = b.write(OWNER, req('token.issue', 'coordinator', { role: 'coordinator' })).token;
  // Current rows: s4 moved todo -> active since the history was taken.
  b.write(coord, req('task.create', 'T-1', { title: 'Imported', steps: [
    { id: 's1', label: 'a', zone: 'plan', state: 'done' }, { id: 's2', label: 'b', zone: 'build', state: 'done' },
    { id: 's3', label: 'c', zone: 'owner', state: 'waiting' }, { id: 's4', label: 'd', zone: 'build', state: 'active' }] }));
  return { b, coord };
}

test('times.import: owner only, once per task, field-for-field, and the same totals as the predecessor', () => {
  const dir = tmpDir();
  const { b, coord } = board(dir);
  const reqs = legacyTimesToRequests(LEGACY, { prefix: 'mig' });
  assert.deepEqual(reqs.map(r => r.target_id), ['T-1', 'OLD']);

  assert.throws(() => b.write(coord, reqs[0]), e => e.status === 403);
  for (const r of reqs) assert.equal(b.write(OWNER, r).ok, true);
  assert.equal(b.write(OWNER, reqs[0]).deduped, true, 'same request is a no-op retry');
  assert.throws(() => b.write(OWNER, { ...reqs[0], request_id: 'mig-again-T-1' }), e => e.status === 409 && e.code === 'already_imported');

  const st = b.state;
  // Lossless: every legacy value is present under its v1 name, nothing invented.
  for (const [sid, r] of Object.entries(LEGACY.tasks['T-1'].steps)) {
    if (sid === 's4') continue; // moved since the history was taken: checked below
    const v = st.times[`T-1/${sid}`];
    assert.equal(v.first_seen_at, r.firstSeenAt);
    assert.equal(v.started_at, r.startedAt ?? undefined);
    assert.equal(v.done_at, r.doneAt ?? undefined);
    assert.equal(v.waiting_since, r.waitingSince ?? undefined);
    assert.equal(v.waiting_total_ms, r.waitingTotalMs);
    assert.equal(!!v.untracked, r.untracked);
    assert.deepEqual(v.transitions.slice(0, r.transitions.length), r.transitions.map(x => ({ at: x.t, from: x.from, to: x.to })));
  }
  assert.equal(st.task_times['T-1'].first_seen_at, LEGACY.tasks['T-1'].firstSeenAt);
  assert.equal(st.task_times['T-1'].started_at, LEGACY.tasks['T-1'].startedAt);
  assert.equal(st.task_times['T-1'].done_at, undefined);
  assert.equal(st.times['OLD/s1'].done_at, '2026-09-26T05:00:00.000Z', 'history of a task no longer on the board is kept');

  // Only the step that moved since the history was taken gets a transition, stamped at import time.
  assert.deepEqual(st.times['T-1/s4'].transitions, [{ at: new Date(NOW).toISOString(), from: 'todo', to: 'active' }]);
  assert.equal(st.times['T-1/s4'].started_at, new Date(NOW).toISOString());
  assert.equal(st.times['T-1/s3'].transitions.length, 1, 'unchanged steps are verbatim');

  // OLD: the predecessor's totals exactly. T-1: on purpose not the predecessor's (it summed every step's waits, any
  // zone): only the owner-zone step s3 counts as waiting on the owner (04:00 -> now = 2 h); s2's 30 min wait was in
  // the build zone and 'gone' is no longer on the board (test/measured.test.mjs).
  const old = measuredTimes(st, 'OLD', NOW);
  assert.deepEqual({ work: old.work_ms, wait: old.wait_ms }, legacyTotals(LEGACY.tasks.OLD, NOW), 'OLD');
  const t1 = measuredTimes(st, 'T-1', NOW), H = 3600000;
  assert.deepEqual({ work: t1.work_ms, wait: t1.wait_ms }, { work: NOW - Date.parse(LEGACY.tasks['T-1'].startedAt) - 2 * H, wait: 2 * H }, 'T-1');
  const view = b.view(OWNER);
  assert.equal(view.tasks.find(t => t.id === 'T-1').measured.wait_ms, 2 * H);

  // Replay from the journal alone reproduces the imported history.
  const before = JSON.stringify({ times: st.times, task_times: st.task_times });
  b.close();
  fs.rmSync(path.join(dir, 'state.json'));
  const b2 = createBoard({ dataDir: dir, ownerToken: OWNER, now: () => NOW });
  assert.equal(JSON.stringify({ times: b2.state.times, task_times: b2.state.task_times }), before);
  b2.close();
});

test('task-level clock is kept live: start = first step start, done = first moment every step is done', () => {
  const dir = tmpDir();
  let clock = NOW;
  const b = createBoard({ dataDir: dir, ownerToken: OWNER, now: () => clock });
  const coord = b.write(OWNER, req('token.issue', 'coordinator', { role: 'coordinator' })).token;
  b.write(coord, req('task.create', 'L-1', { title: 'Live', steps: [{ id: 's1', label: 'a', zone: 'build', state: 'todo' }, { id: 's2', label: 'b', zone: 'build', state: 'todo' }] }));
  assert.equal(b.state.task_times['L-1'].started_at, undefined);
  clock += 60000; b.write(coord, req('step.update', 'L-1/s1', { state: 'active' }, { expected_revision: 1 }));
  assert.equal(b.state.task_times['L-1'].started_at, new Date(NOW + 60000).toISOString());
  clock += 60000; b.write(coord, req('step.update', 'L-1/s1', { state: 'done' }, { expected_revision: 2 }));
  clock += 60000; b.write(coord, req('step.update', 'L-1/s2', { state: 'done' }, { expected_revision: 1 }));
  assert.equal(b.state.task_times['L-1'].done_at, new Date(NOW + 180000).toISOString());
  assert.deepEqual(measuredTimes(b.state, 'L-1', clock + 999999), { started_at: new Date(NOW + 60000).toISOString(), done_at: new Date(NOW + 180000).toISOString(), work_ms: 120000, wait_ms: 0 });
  b.close();
});

test('times.import carries the predecessor ages: ask waits and the idle clock do not restart at the import', () => {
  const dir = tmpDir();
  const { b, coord } = board(dir);
  b.write(coord, req('task.create', 'T-2', { title: 'Other', steps: [{ id: 's1', label: 'x', zone: 'build', state: 'active' }] }));
  const ask = b.write(coord, req('ask.raise', 'T-1', { text: 'Pick one', step_id: 's3' })).id;
  const other = b.write(coord, req('ask.raise', 'T-2', { text: 'Elsewhere' })).id;
  const [t1] = legacyTimesToRequests(LEGACY, { prefix: 'age' });
  const since = '2026-09-27T20:00:00.000Z', last = '2026-09-28T04:00:00.000Z';

  // Only asks of the target task, only for a task on the board.
  assert.throws(() => b.write(OWNER, { ...t1, data: { ...t1.data, asks: { [other]: { waiting_since: since } } } }), e => e.status === 400 && e.code === 'ask_not_on_task');
  assert.throws(() => b.write(OWNER, req('times.import', 'OLD', { steps: {}, last_activity_at: last })), e => e.status === 404);

  b.write(OWNER, { ...t1, data: { ...t1.data, last_activity_at: last, asks: { [ask]: { waiting_since: since } } } });
  const v = b.view(OWNER);
  const w = v.attention.waiting.find(x => x.id === ask);
  assert.equal(w.since, since);
  assert.equal(w.age_ms, NOW - Date.parse(since));
  assert.deepEqual(v.stalled.map(s => [s.task_id, s.last_at]), [], 'T-1 idle 2h < 3h; T-2 was just created');
  assert.equal(b.state.activity['T-1'], last);
  const later = createBoard({ dataDir: dir, ownerToken: OWNER, now: () => NOW + 3600001 });
  b.close();
  assert.deepEqual(later.view(OWNER).stalled.map(s => [s.task_id, s.last_at]), [['T-1', last]], 'idle counted from the predecessor clock');
  later.close();
});
