// s21 / Sol conditions 1 and 6: a push merges by lane. An omitted lane never authorises a destructive replacement,
// a lane only ever writes its own steps, the task owner is the server's (immutable), step order follows Sol's rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { s21Board, seedShared, withLane, row, step } from './s21-helpers.mjs';

const WORKERA = 'Workera CoS';
// F-04 as its owner lane sends it: same headline fields the board holds, so only steps differ.
const f04 = (steps, extra = {}) => row('F-04', WORKERA, steps, { title: 'Trang chủ', now: 'Workera now', next: 'Workera next', order: 1, health: 'yellow', ...extra });

test('Sol 1: a push without lane on a shared task is refused 428 lane_required and writes nothing (the F-04 clobber)', async () => {
  const s = await s21Board();
  try {
    seedShared(s);
    const seq = s.board.state.seq;
    // What Workera sent on 12-10: the whole F-04 row, without Workerb's step video-ad.
    const r = await s.push([f04([step('s1', 'done'), step('workera-step', 'waiting', 'anh')])]);
    assert.equal(r.status, 428, JSON.stringify(r.body)); assert.equal(r.body.error, 'lane_required'); assert.deepEqual(r.body.tasks, ['F-04']);
    assert.equal(s.board.state.seq, seq, 'nothing written');
    assert.ok(s.steps('F-04').includes('video-ad'), "Workerb's step survived");
    // One refused row refuses the whole PUT: another task in the same push is not applied either.
    const mixed = await s.push([row('V-1', 'Workerb', [step('v1', 'done')], { now: 'changed' }), f04([step('s1', 'done')])]);
    assert.equal(mixed.status, 428); assert.equal(s.board.state.seq, seq);
  } finally { await s.close(); }
});

test('Sol 1: a single-lane task keeps the legacy whole-row push without a lane (a missing step is deleted)', async () => {
  const s = await s21Board();
  try {
    seedShared(s);
    s.w('step.create', 'V-1/v2', { label: 'x', zone: 'build', state: 'todo' });
    const r = await s.push([row('V-1', 'Workerb', [step('v1', 'active')], { order: 2 })]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(s.steps('V-1'), ['v1']);
  } finally { await s.close(); }
});

test("Sol 1: a lane push upserts its own steps and never drops another lane's step, with or without replaceLane", async () => {
  const s = await s21Board();
  try {
    seedShared(s);
    const workeraRow = f04([step('s1', 'done'), step('workera-step', 'waiting', 'anh'), step('s2', 'todo')]);
    let r = await s.push([workeraRow], { lane: WORKERA });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(s.steps('F-04'), ['s1', 'workera-step', 'video-ad', 's2'], 'new own step appended after the foreign one; video-ad kept');
    assert.equal(s.board.state.steps['F-04/s2'].lane, undefined, "a step of the task's own lane carries no lane (absent = task lane)");
    // Missing own step is kept without replaceLane ...
    r = await s.push([f04([step('s1', 'done'), step('workera-step', 'waiting', 'anh')])], { lane: WORKERA });
    assert.equal(r.status, 200); assert.ok(s.steps('F-04').includes('s2'), 'upsert only: an omitted own step stays');
    // ... and is deleted with replaceLane, still inside the lane.
    r = await s.push([f04([step('s1', 'done'), step('workera-step', 'waiting', 'anh')])], { lane: WORKERA, replaceLane: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(s.steps('F-04'), ['s1', 'workera-step', 'video-ad'], 'replaceLane drops Workera\'s s2 and nothing of Workerb\'s');
  } finally { await s.close(); }
});

test('Sol 1: an unknown lane name is refused 400 unknown_lane (workerbb creates no third lane); the case of a known one is resolved', async () => {
  const s = await s21Board();
  try {
    seedShared(s);
    const seq = s.board.state.seq;
    const r = await s.push([f04([step('s1', 'done')])], { lane: 'workerbb' });
    assert.equal(r.status, 400); assert.equal(r.body.error, 'unknown_lane'); assert.equal(s.board.state.seq, seq);
    const a = await s.ask({ code: 'F-04', text: 'q', lane: 'workerbb' });
    assert.equal(a.status, 400); assert.equal(a.body.error, 'unknown_lane');
    // 'workerb' is the lane Workerb; its new step is stamped with the board's spelling.
    const ok = await s.push([f04([step('vs2', 'todo', 'build')])], { lane: 'workerb' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(s.board.state.steps['F-04/vs2'].lane, 'Workerb');
  } finally { await s.close(); }
});

test("Sol 1: a lane cannot adopt another lane's step by pushing its id: 409 lane_mismatch, nothing written", async () => {
  const s = await s21Board();
  try {
    seedShared(s);
    const seq = s.board.state.seq;
    const r = await s.push([f04([step('s1', 'done'), step('video-ad', 'done', 'anh')])], { lane: WORKERA });
    assert.equal(r.status, 409); assert.equal(r.body.error, 'lane_mismatch'); assert.deepEqual(r.body.steps, ['video-ad']);
    assert.equal(s.board.state.seq, seq);
    assert.equal(s.board.state.steps['F-04/video-ad'].state, 'waiting');
    // Workerb pushing Workera's step id is the same refusal the other way round.
    const r2 = await s.push([f04([step('workera-step', 'done', 'anh')])], { lane: 'Workerb' });
    assert.equal(r2.status, 409); assert.equal(r2.body.error, 'lane_mismatch'); assert.equal(s.board.state.seq, seq);
    // An explicit step.lane in the row that is not the pusher's is the same refusal.
    const r3 = await s.push([f04([step('zz', 'todo', 'build', { lane: 'Workerb' })])], { lane: WORKERA });
    assert.equal(r3.status, 409); assert.equal(r3.body.error, 'lane_mismatch');
  } finally { await s.close(); }
});

test('Sol 1 / J-05 step-owner: the pusher of a non-owner lane may write steps and its own ask; a changed task-level field is ignored, with a note', async () => {
  const s = await s21Board();
  try {
    seedShared(s);
    // Workerb's row repeats the task fields as they are (or leaves them out): fine.
    let r = await s.push([f04([step('video-ad', 'active', 'anh')])], { lane: 'Workerb' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(s.board.state.steps['F-04/video-ad'].state, 'active');
    r = await s.push([{ code: 'F-04', steps: [step('video-ad', 'active', 'anh', { label: 'Video ad v2' })] }], { lane: 'Workerb' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(s.board.state.steps['F-04/video-ad'].label, 'Video ad v2');
    // A changed headline is the owner lane's alone: ignored with a note, while the step change in the same PUT applies (J-05).
    const before = s.board.state.seq;
    r = await s.push([f04([step('video-ad', 'done', 'anh', { label: 'Video ad v2' })], { now: 'Workerb wrote this' })], { lane: 'Workerb' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.ignored, [{ task: 'F-04', fields: ['now'] }], 'the ignored field is a note, never a failed push');
    assert.equal(s.board.state.steps['F-04/video-ad'].state, 'done', 'the step change went through');
    assert.equal(s.board.state.tasks['F-04'].now, 'Workera now', "the row owner's field is untouched");
    assert.ok(before < s.board.state.seq, 'the applied step change is journaled');
  } finally { await s.close(); }
});

test('Sol 1: the task owner is immutable: a push or a task.update that changes lane is 409 lane_immutable', async () => {
  const s = await s21Board();
  try {
    seedShared(s);
    const seq = s.board.state.seq;
    const r = await s.push([f04([step('s1', 'done')], { lane: 'Workerb' })], { lane: WORKERA });
    assert.equal(r.status, 409); assert.equal(r.body.error, 'lane_immutable'); assert.equal(s.board.state.seq, seq);
    const legacy = await s.push([row('V-1', WORKERA, [step('v1', 'active')], { order: 2 })]);
    assert.equal(legacy.status, 409); assert.equal(legacy.body.error, 'lane_immutable', 'also without a declared lane');
    let u; try { s.ownerW('task.update', 'F-04', { lane: 'Workerb' }, { expected_revision: s.board.state.tasks['F-04'].rev }); } catch (e) { u = e; }
    assert.equal(u?.status, 409); assert.equal(u?.code, 'lane_immutable');
    assert.equal(s.board.state.tasks['F-04'].lane, WORKERA);
    // The same lane written again is not a change.
    s.w('task.update', 'F-04', { lane: WORKERA, now: 'ok' }, { expected_revision: s.board.state.tasks['F-04'].rev });
  } finally { await s.close(); }
});

test("Sol 6: foreign steps keep their positions; own steps reorder inside their own slots; new own steps append", async () => {
  const s = await s21Board();
  try {
    const mixed = lane => [step('a', 'todo'), step('v1', 'todo', 'build', lane), step('b', 'todo'), step('v2', 'todo', 'build', lane), step('c', 'todo')];
    s.w('task.create', 'V-1', { title: 'Workerb own task', lane: 'Workerb', steps: [step('x', 'active')] });
    withLane(() => s.w('task.create', 'T-9', { title: 'Mixed', lane: WORKERA, order: 5, steps: mixed({ lane: 'Workerb' }) }), () => s.w('task.create', 'T-9', { title: 'Mixed', lane: WORKERA, order: 5, steps: mixed({}) }));
    const base = { title: 'Mixed', health: 'yellow', order: 5 };
    // Workera sends its steps reversed plus a new one, with replaceLane: [c, b, a, n].
    let r = await s.push([row('T-9', WORKERA, [step('c', 'todo'), step('b', 'todo'), step('a', 'todo'), step('n', 'todo')], base)], { lane: WORKERA, replaceLane: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(s.steps('T-9'), ['c', 'v1', 'b', 'v2', 'a', 'n'], 'v1 and v2 stay in slots 1 and 3; own steps take slots 0,2,4 and the appended slot 5');
    // Without replaceLane, an own step that is not sent keeps its slot; the sent ones fill the other own slots in the sent order.
    r = await s.push([row('T-9', WORKERA, [step('a', 'todo'), step('c', 'todo')], base)], { lane: WORKERA });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(s.steps('T-9'), ['a', 'v1', 'b', 'v2', 'c', 'n']);
    // A submitted step_order is never read: the order comes from the server's rule.
    r = await s.push([row('T-9', WORKERA, [step('a', 'todo'), step('c', 'todo')], { ...base, step_order: ['n', 'c', 'b', 'a', 'v2', 'v1'] })], { lane: WORKERA });
    assert.equal(r.status, 200);
    assert.deepEqual(s.steps('T-9'), ['a', 'v1', 'b', 'v2', 'c', 'n']);
    // Workerb reorders her two steps only.
    const vrow = { code: 'T-9', steps: [step('v2', 'todo'), step('v1', 'todo')] };
    r = await s.push([vrow], { lane: 'Workerb' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(s.steps('T-9'), ['a', 'v2', 'b', 'v1', 'c', 'n']);
  } finally { await s.close(); }
});

test('Sol 1 (guard): re-pushing the same lane row twice writes no event the second time', async () => {
  const s = await s21Board();
  try {
    seedShared(s);
    const workeraRow = f04([step('s1', 'done'), step('workera-step', 'waiting', 'anh')]);
    assert.equal((await s.push([workeraRow], { lane: WORKERA })).status, 200);
    const seq = s.board.state.seq;
    assert.equal((await s.push([workeraRow], { lane: WORKERA })).status, 200);
    assert.equal(s.board.state.seq, seq);
  } finally { await s.close(); }
});

test("Sol 6: waiting_before_done is judged per lane: Workerb can finish her step while Workera's ask step waits before it, through push and through the v1 ops", async () => {
  const s = await s21Board();
  try {
    seedShared(s); // workera-step (Workera) waits before video-ad (Workerb)
    const r = await s.push([{ code: 'F-04', steps: [step('video-ad', 'done', 'anh')] }], { lane: 'Workerb' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(s.board.state.steps['F-04/video-ad'].state, 'done'); assert.equal(s.board.state.steps['F-04/workera-step'].state, 'waiting');
    // Inside one lane the rule is what it always was.
    s.w('step.create', 'F-04/workera-late', { label: 'later', zone: 'build', state: 'todo' });
    let err; try { s.w('step.update', 'F-04/workera-late', { state: 'done' }, { expected_revision: 1 }); } catch (e) { err = e; }
    assert.equal(err?.code, 'waiting_before_done', 'a Workera step done behind a waiting Workera step is still refused');
    // and the other way round: Workerb's waiting step does not block Workera's done step
    s.w('step.update', 'F-04/video-ad', { state: 'waiting' }, { expected_revision: s.board.state.steps['F-04/video-ad'].rev });
    s.w('step.update', 'F-04/workera-step', { state: 'done' }, { expected_revision: s.board.state.steps['F-04/workera-step'].rev });
    assert.equal(s.board.state.steps['F-04/workera-step'].state, 'done');
  } finally { await s.close(); }
});

test("Sol 6: a result the board rules refuse is 409 (never a loop, nothing written): a lane's own waiting step it did not send stays before the step it marks done", async () => {
  const s = await s21Board();
  try {
    s.w('task.create', 'V-1', { title: 'Workerb own task', lane: 'Workerb', steps: [step('x', 'active')] });
    withLane(() => s.w('task.create', 'T-8', { title: 'Mixed', lane: WORKERA, order: 5, steps: [step('a', 'todo'), step('va', 'waiting', 'owner', { lane: 'Workerb' }), step('vb', 'todo', 'build', { lane: 'Workerb' })] }),
      () => s.w('task.create', 'T-8', { title: 'Mixed', lane: WORKERA, order: 5, steps: [step('a', 'todo'), step('va', 'waiting', 'owner'), step('vb', 'todo')] }));
    const seq = s.board.state.seq;
    const r = await s.push([{ code: 'T-8', steps: [step('vb', 'done')] }], { lane: 'Workerb' });
    assert.equal(r.status, 409, JSON.stringify(r.body)); assert.equal(r.body.error, 'waiting_before_done'); assert.equal(r.body.step, 'va');
    assert.equal(s.board.state.seq, seq);
    // Sending the waiting step too (finished) is fine.
    assert.equal((await s.push([{ code: 'T-8', steps: [step('va', 'done', 'anh'), step('vb', 'done')] }], { lane: 'Workerb' })).status, 200);
  } finally { await s.close(); }
});
