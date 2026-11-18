// Measured time (src/views.mjs measuredTimes): "waited on owner" is the time at least one owner-zone step waited
// (waits of several steps at once count once), and a task reopened with new steps is not "done" any more.
// Regression for F-04 on 10-10: "worked 1 s · waited on owner 18 d 13 h" over a 10-day task, because waits of steps
// that waited in parallel (and of build steps parked in 'waiting') were summed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBoard } from '../src/board.mjs';
import { measuredTimes } from '../src/views.mjs';
import { OWNER, tmpDir } from './helpers.mjs';

const H = 3600000, T0 = Date.parse('2026-09-27T06:00:00.000Z');
let n = 0;
const req = (op, target_id, data, extra = {}) => ({ version: 1, request_id: `measured-${process.pid}-${++n}`, op, target_id, data, ...extra });

test('parallel owner waits count once; a reopened task counts to now, not to its old done time', () => {
  let clock = T0;
  const b = createBoard({ dataDir: tmpDir(), ownerToken: OWNER, now: () => clock });
  const coord = b.write(OWNER, req('token.issue', 'coordinator', { role: 'coordinator' })).token;
  const step = (id, state) => { const s = b.state.steps[`F-4/${id}`]; b.write(coord, req('step.update', s.id, { state }, { expected_revision: s.rev })); };
  b.write(coord, req('task.create', 'F-4', { title: 'Homepage', steps: [
    { id: 'build', label: 'build', zone: 'build', state: 'active' },
    { id: 'lock', label: 'lock the goal', zone: 'owner', state: 'todo' },
    { id: 'assets', label: 'pick assets', zone: 'owner', state: 'todo' }] }));
  clock += 10 * H; step('build', 'done');
  step('lock', 'waiting'); step('assets', 'waiting');            // both wait on the owner from T0+10h ...
  clock += 140 * H; step('lock', 'done');                        // ... one for 140 h
  clock += 20 * H; step('assets', 'done');                       // ... the other for 160 h, overlapping
  const doneAt = clock;
  // Summing per step would say 300 h of waiting over a 170 h task (work clamped to 0).
  assert.deepEqual(measuredTimes(b.state, 'F-4', doneAt + 5 * H), { started_at: new Date(T0).toISOString(), done_at: new Date(doneAt).toISOString(), work_ms: 10 * H, wait_ms: 160 * H });

  // Reopened: a new step after the task was done. The clock runs to now again, and the new wait counts.
  clock += 24 * H;
  b.write(coord, req('step.create', 'F-4/r2', { label: 'round 2', zone: 'owner', state: 'waiting' }));
  assert.equal(b.state.task_times['F-4'].done_at, new Date(doneAt).toISOString(), 'the recorded done time itself is kept');
  const now = clock + 2 * H, m = measuredTimes(b.state, 'F-4', now);
  assert.equal(m.done_at, undefined, 'not done while a step is open');
  assert.equal(m.wait_ms, 160 * H + 2 * H);
  assert.equal(m.work_ms, (now - T0) - (162 * H));
  b.close();
});

test('a wait whose start fell off the kept transitions is placed by its known length; only owner-zone waits count', () => {
  const st = { tasks: { X: { step_ids: ['a', 'b', 'c'] } }, steps: { 'X/a': { state: 'done', zone: 'owner' }, 'X/b': { state: 'done', zone: 'owner' }, 'X/c': { state: 'done', zone: 'build' } },
    task_times: { X: { first_seen_at: '2026-10-01T00:00:00.000Z', started_at: '2026-10-01T00:00:00.000Z', done_at: '2026-10-01T10:00:00.000Z' } },
    times: {
      // 'a' waited 3 h; only its last transition (waiting -> done at 05:00) is kept: the wait is 02:00-05:00
      'X/a': { first_seen_at: '2026-10-01T00:00:00.000Z', waiting_total_ms: 3 * H, last_state: 'done', transitions: [{ at: '2026-10-01T05:00:00.000Z', from: 'waiting', to: 'done' }] },
      // 'b' waited 04:00-06:00, overlapping 'a' by one hour
      'X/b': { first_seen_at: '2026-10-01T00:00:00.000Z', waiting_total_ms: 2 * H, last_state: 'done', transitions: [{ at: '2026-10-01T04:00:00.000Z', from: 'active', to: 'waiting' }, { at: '2026-10-01T06:00:00.000Z', from: 'waiting', to: 'done' }] },
      // 'c' is a build step parked in 'waiting' 06:00-09:00: not a wait on the owner
      'X/c': { first_seen_at: '2026-10-01T00:00:00.000Z', waiting_total_ms: 3 * H, last_state: 'done', transitions: [{ at: '2026-10-01T06:00:00.000Z', from: 'active', to: 'waiting' }, { at: '2026-10-01T09:00:00.000Z', from: 'waiting', to: 'done' }] }
    } };
  assert.deepEqual(measuredTimes(st, 'X', Date.parse('2026-10-02T00:00:00.000Z')), { started_at: '2026-10-01T00:00:00.000Z', done_at: '2026-10-01T10:00:00.000Z', work_ms: 6 * H, wait_ms: 4 * H });
});
