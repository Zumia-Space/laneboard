// J-05 step-owner (16-10): the lane that owns a STEP may close or update it on a row ANOTHER lane owns. Row-level
// fields stay the row owner's: a non-owner lane that sends a changed row field (now / next / health / title / goal /
// order / worker / loops) has it IGNORED, with a note, while its own step change is applied. This breaks the F-04
// deadlock: Workera CoS owns the row, Workerb owns step video-ad, and neither could close it (Workerb refused at the row level
// for a stale `now`, Workera refused at the step level for adopting a foreign step). Every protection stays: a lane still
// may not edit or create a step another lane owns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { s21Board, seedShared, row, step } from './s21-helpers.mjs';

const WORKERA = 'Workera CoS';

test("J-05 step-owner: the lane owning a step closes it on another lane's row; its row-field write is ignored with a note", async () => {
  const s = await s21Board();
  try {
    seedShared(s); // F-04 is Workera CoS's row; step video-ad is Workerb's
    assert.equal(s.board.state.tasks['F-04'].lane, WORKERA);
    assert.equal(s.board.state.steps['F-04/video-ad'].lane, 'Workerb');
    // Workerb's row is her slice: her step plus (wrongly) a changed row field, `now`, which is Workera CoS's alone.
    const r = await s.push([{ code: 'F-04', now: 'Workerb wrote this', steps: [step('video-ad', 'done', 'anh')] }], { lane: 'Workerb' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(s.board.state.steps['F-04/video-ad'].state, 'done', 'the step owner closed its own step');
    assert.equal(s.board.state.tasks['F-04'].now, 'Workera now', 'the row field a non-owner lane sent is ignored');
    assert.deepEqual(r.body.ignored, [{ task: 'F-04', fields: ['now'] }], 'the ignored field is a note, never a failed push');
    assert.ok(r.body.writes > 0, 'the applied step change is journaled');
  } finally { await s.close(); }
});

test("J-05 step-owner: the row owner still cannot change another lane's step (lane_mismatch, nothing written)", async () => {
  const s = await s21Board();
  try {
    seedShared(s);
    const seq = s.board.state.seq;
    // Workera CoS owns F-04 but not Workerb's video-ad: adopting it is still refused, whole push.
    const r = await s.push([row('F-04', WORKERA, [step('s1', 'done'), step('video-ad', 'done', 'anh')], { title: 'Trang chủ', now: 'Workera now', next: 'Workera next', order: 1, health: 'yellow' })], { lane: WORKERA });
    assert.equal(r.status, 409); assert.equal(r.body.error, 'lane_mismatch'); assert.deepEqual(r.body.steps, ['video-ad']);
    assert.equal(s.board.state.seq, seq, 'nothing written');
    assert.equal(s.board.state.steps['F-04/video-ad'].state, 'waiting', "Workerb's step is untouched");
  } finally { await s.close(); }
});

test("J-05 step-owner: the row owner's field change still applies; a non-owner push with no row change carries no note", async () => {
  const s = await s21Board();
  try {
    seedShared(s);
    // Workera CoS, the row owner, changes `now`: applied as before.
    let r = await s.push([row('F-04', WORKERA, [step('s1', 'done'), step('workera-step', 'waiting', 'anh')], { title: 'Trang chủ', now: 'Workera wrote this', next: 'Workera next', order: 1, health: 'yellow' })], { lane: WORKERA });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(s.board.state.tasks['F-04'].now, 'Workera wrote this');
    assert.equal(r.body.ignored, undefined, 'the row owner gets no ignore note');
    // Workerb repeats the row fields as they are: her step change applies and nothing is ignored.
    r = await s.push([{ code: 'F-04', now: 'Workera wrote this', steps: [step('video-ad', 'active', 'anh')] }], { lane: 'Workerb' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(s.board.state.steps['F-04/video-ad'].state, 'active');
    assert.equal(r.body.ignored, undefined, "a field equal to the board's is not a change");
  } finally { await s.close(); }
});

test('J-05 step-owner: a non-owner push that changes only row fields writes no row event (the row stays the owner\'s)', async () => {
  const s = await s21Board();
  try {
    seedShared(s);
    const before = s.board.state.activity['F-04'], seq = s.board.state.seq;
    // Workerb sends a changed `now`/`health` and no step change -- and a future `updated`, which alone used to move the
    // row's activity clock. All of it is a row-level write of Workera CoS's row: ignored, with a note, nothing written.
    const r = await s.push([{ code: 'F-04', now: 'Workerb wrote this', health: 'red', updated: new Date(Date.now() + 60_000).toISOString() }], { lane: 'Workerb' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.writes, 0, 'nothing applied');
    assert.equal(s.board.state.seq, seq, 'no event for an ignored row-field-only push');
    assert.equal(s.board.state.activity['F-04'], before, "the row owner's activity clock is untouched");
    assert.deepEqual(r.body.ignored, [{ task: 'F-04', fields: ['health', 'now'] }]);
    assert.equal(s.board.state.tasks['F-04'].now, 'Workera now');
    assert.equal(s.board.state.tasks['F-04'].health, 'yellow');
  } finally { await s.close(); }
});

test("J-05 step-owner: a non-owner row that carries the owner's ask text does not re-raise it under the pusher's lane", async () => {
  const s = await s21Board();
  try {
    seedShared(s);
    s.w('ask.raise', 'F-04', { text: 'Workera question: A or B?', step_id: 'workera-step' }); // Workera's ask on Workera's owner step
    assert.equal(s.openAsks('F-04').length, 1);
    // Workerb pushes a full F-04 row (as a shared rows dir would): the owner's needsAnh, a stale `now`/`next`, her step done.
    const r = await s.push([{ code: 'F-04', now: 'Workerb stale', next: 'Workerb stale', needsAnh: 'Workera question: A or B?', steps: [step('video-ad', 'done', 'anh')] }], { lane: 'Workerb' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(s.board.state.steps['F-04/video-ad'].state, 'done', 'her own step closed');
    assert.deepEqual(r.body.ignored, [{ task: 'F-04', fields: ['now', 'next'] }]);
    assert.equal(s.openAsks('F-04').length, 1, "the owner's ask is not duplicated under Workerb's lane");
    assert.ok(!s.openAsks('F-04').some(a => a.lane === 'Workerb'), 'no ask was raised for Workerb');
  } finally { await s.close(); }
});
