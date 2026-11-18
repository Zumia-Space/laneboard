// s21 / Sol conditions 2 and 3: asks have a lane and a stable id, one open ask per (task, lane, step); clears are
// scoped (no omission-based "all"); the legacy /api/state and the v1 view keep their contract with two asks open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { s21Board, seedShared, row, step, OWNER } from './s21-helpers.mjs';

const WORKERA = 'Workera CoS';
const fx = async () => { const s = await s21Board(); try { seedShared(s); } catch (e) { await s.close(); throw e; } return s; };
/** Both lanes ask on F-04: Workera on workera-step, Workerb on video-ad. */
async function bothAsk(s) {
  const a = await s.ask({ code: 'F-04', lane: WORKERA, step: 'workera-step', text: 'Workera question: A or B?' });
  const b = await s.ask({ code: 'F-04', lane: 'Workerb', step: 'video-ad', text: 'Workerb question: idea 1 or 2?' });
  assert.equal(a.status, 200, JSON.stringify(a.body)); assert.equal(b.status, 200, JSON.stringify(b.body));
  return { workeraId: a.body.id, workerbId: b.body.id };
}

test('Sol 2: two lanes ask on one task and both stay open; a lane asking again replaces only its own ask', async () => {
  const s = await fx();
  try {
    const { workeraId, workerbId } = await bothAsk(s);
    assert.match(workeraId, /^ask-\d+$/); assert.match(workerbId, /^ask-\d+$/); assert.notEqual(workeraId, workerbId);
    assert.deepEqual(s.openAsks('F-04').map(a => a.id).sort(), [workeraId, workerbId].sort());
    assert.equal(s.board.state.asks[workerbId].lane, 'Workerb'); assert.equal(s.board.state.asks[workeraId].lane, undefined, 'the task lane is the absent lane');
    const again = await s.ask({ code: 'F-04', lane: WORKERA, step: 'workera-step', text: 'Workera question, reworded' });
    assert.equal(again.status, 200); assert.deepEqual(again.body.replaced, [workeraId]);
    assert.equal(s.board.state.asks[workeraId].status, 'cleared');
    assert.deepEqual(s.openAsks('F-04').map(a => a.text).sort(), ['Workera question, reworded', 'Workerb question: idea 1 or 2?']);
    assert.equal(s.board.state.asks[workerbId].status, 'open', "Workerb's ask was not touched");
  } finally { await s.close(); }
});

test('Sol 2: one open ask per (task, lane, step) is enforced in the op too (409 ask_exists)', async () => {
  const s = await fx();
  try {
    const first = s.w('ask.raise', 'F-04', { text: 'one', step_id: 'workera-step' });
    let err; try { s.w('ask.raise', 'F-04', { text: 'two', step_id: 'workera-step' }); } catch (e) { err = e; }
    assert.equal(err?.status, 409); assert.equal(err?.code, 'ask_exists'); assert.equal(err?.extra.ask_id, first.id);
    // Another lane on the same step, or the same lane on another step, is a different identity.
    s.w('ask.raise', 'F-04', { text: 'three', step_id: 'workera-step', lane: 'Workerb' });
    s.w('ask.raise', 'F-04', { text: 'four', step_id: 'video-ad', lane: 'Workerb' });
    assert.equal(s.openAsks('F-04').length, 3);
  } finally { await s.close(); }
});

test('Sol 2: an ask without lane on a shared task is 428; an unknown step is 400; step-less asks are their own identity', async () => {
  const s = await fx();
  try {
    await bothAsk(s);
    const r = await s.ask({ code: 'F-04', text: 'from an old client' });
    assert.equal(r.status, 428); assert.equal(r.body.error, 'lane_required');
    assert.equal(s.openAsks('F-04').length, 2);
    const bad = await s.ask({ code: 'F-04', lane: WORKERA, step: 'nope', text: 'x' });
    assert.equal(bad.status, 400);
    const stepless = await s.ask({ code: 'F-04', lane: WORKERA, text: 'general question' });
    assert.equal(stepless.status, 200); assert.equal(s.openAsks('F-04').length, 3, 'a step-less Workera ask next to the one on workera-step');
  } finally { await s.close(); }
});

test('Sol 2: /api/state?v=2 exposes every open ask {id, lane, text, step_id, refs, at}; the unversioned view gains no field', async () => {
  const s = await fx();
  try {
    const { workeraId, workerbId } = await bothAsk(s);
    const v2 = await s.code('F-04', 2);
    assert.deepEqual(v2.asks.map(a => [a.id, a.lane, a.text, a.step_id]), [[workeraId, WORKERA, 'Workera question: A or B?', 'workera-step'], [workerbId, 'Workerb', 'Workerb question: idea 1 or 2?', 'video-ad']]);
    for (const a of v2.asks) { assert.deepEqual(a.refs, []); assert.match(a.at, /^\d{4}-\d\d-\d\dT/); }
    assert.equal(v2.steps.find(x => x.id === 'video-ad').lane, 'Workerb'); assert.equal(v2.steps.find(x => x.id === 's1').lane, WORKERA, 'v2 shows the effective lane of every step');
    const v1 = await s.code('F-04');
    for (const k of ['asks', 'refs']) assert.ok(!(k in v1), `unversioned task has no ${k}`);
    assert.ok(v1.steps.every(x => !('lane' in x)), 'unversioned steps gain no field');
    const ALLOWED = new Set(['code', 'title', 'lane', 'health', 'goal', 'now', 'next', 'needsAnh', 'askAt', 'askedBy', 'dossier', 'draftOutput', 'draftOutcome', 'steps', 'worker', 'roles', 'gateFails',
      'workerCos', 'loops', 'context', 'order', 'updated', 'textAt', 'staleText', 'currentStep']);
    assert.deepEqual(Object.keys(v1).filter(k => !ALLOWED.has(k)), []);
  } finally { await s.close(); }
});

test('Sol 2: asks/clear needs an id or lane+step; omission is 400 and clears nothing; clear-all is its own confirmed route', async () => {
  const s = await fx();
  try {
    const { workeraId, workerbId } = await bothAsk(s);
    for (const body of [{ code: 'F-04' }, { code: 'F-04', lane: WORKERA }, {}, { lane: WORKERA, step: 'workera-step' }]) {
      const r = await s.clear(body);
      assert.equal(r.status, 400, JSON.stringify(body)); assert.equal(r.body.error, 'scope_required');
    }
    assert.equal(s.openAsks('F-04').length, 2, 'nothing cleared by a missing scope');
    const byLane = await s.clear({ code: 'F-04', lane: WORKERA, step: 'workera-step' });
    assert.equal(byLane.status, 200); assert.deepEqual(byLane.body.cleared, [workeraId]);
    assert.deepEqual(s.openAsks('F-04').map(a => a.id), [workerbId]);
    // A closed or unknown id is ignored, and never widens to its neighbours.
    const again = await s.clear({ id: workeraId });
    assert.equal(again.status, 200); assert.deepEqual(again.body.cleared, []);
    const unknown = await s.clear({ id: 'ask-999999' });
    assert.equal(unknown.status, 200); assert.deepEqual(unknown.body.cleared, []);
    assert.equal(s.openAsks('F-04').length, 1);
    // The id belongs to a task: with a code that is not its own it is ignored.
    const wrong = await s.clear({ id: workerbId, code: 'V-1' });
    assert.deepEqual(wrong.body.cleared, []); assert.equal(s.openAsks('F-04').length, 1);
    const byId = await s.clear({ id: workerbId });
    assert.deepEqual(byId.body.cleared, [workerbId]); assert.equal(s.openAsks('F-04').length, 0);
    await bothAsk(s);
    assert.equal((await s.call('POST', '/api/admin/asks/clear-all', { code: 'F-04' })).status, 400);
    assert.equal((await s.call('POST', '/api/admin/asks/clear-all', { code: 'F-04', confirm: 'yes' })).status, 400);
    assert.equal(s.openAsks('F-04').length, 2);
    const all = await s.call('POST', '/api/admin/asks/clear-all', { code: 'F-04', confirm: 'ALL' });
    assert.equal(all.status, 200); assert.equal(all.body.cleared.length, 2); assert.equal(s.openAsks('F-04').length, 0);
  } finally { await s.close(); }
});

test("Sol 2: the owner's answer to one ask is journaled with that ask's id, v2 exposes it as answersAsks, and a receipt closes no ask", async () => {
  const s = await fx();
  try {
    const { workeraId, workerbId } = await bothAsk(s);
    // anh answers Workerb's ask (scoped to it, as the page does from "Waiting on you").
    const fb = s.ownerW('feedback.add', 'F-04', { kind: 'note', text: 'Idea 2', ask_id: workerbId });
    assert.deepEqual(s.board.state.feedback[fb.id].answers_asks, [workerbId]);
    assert.equal(s.board.state.asks[workeraId].status, 'open');
    const v2 = await s.state(2), msg = v2.feedback.find(f => f.text === 'Idea 2');
    assert.deepEqual(msg.answersAsks, [workerbId]);
    assert.ok(!('answersAsks' in (await s.state()).feedback.find(f => f.text === 'Idea 2')), 'unversioned feedback gains no field');
    // The coordinator's receipt (Workerb's) must not touch Workera's ask, its step or the other part of the row.
    const r = await s.call('POST', '/api/admin/reply', { task: 'F-04', step: '', text: 'Đổi: chọn ý 2\nLịch: 14-10\nBước tiếp: dựng', replyTo: msg.id, kind: 'receipt' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(s.board.state.asks[workeraId].status, 'open'); assert.equal(s.board.state.steps['F-04/workera-step'].state, 'waiting');
    assert.deepEqual(s.openAsks('F-04').map(a => a.id), [workeraId]);
  } finally { await s.close(); }
});

test('Sol 3: legacy /api/state with two open asks on a task = deterministic joined projection (ordered, blank-line separated, no lane prefix)', async () => {
  const s = await fx();
  try {
    const { workeraId, workerbId } = await bothAsk(s);
    const t = await s.code('F-04');
    assert.equal(t.needsAnh, 'Workera question: A or B?\n\nWorkerb question: idea 1 or 2?');
    const waits = s.board.view(OWNER).attention.waiting.filter(w => w.task_id === 'F-04' && w.kind === 'ask');
    assert.deepEqual(waits.map(w => w.id).sort(), [workeraId, workerbId].sort());
    assert.equal(t.askAt, s.board.state.asks[workeraId].attribution.created_at < s.board.state.asks[workerbId].attribution.created_at ? s.board.state.asks[workeraId].attribution.created_at : s.board.state.asks[workerbId].attribution.created_at,
      'askAt = the oldest wait, the one age rule');
    // Equal times order by id, so the projection never flips between reads.
    for (let i = 0; i < 3; i++) assert.equal((await s.code('F-04')).needsAnh, t.needsAnh);
    // One open ask: exactly its text (the pre-s21 shape).
    await s.clear({ id: workerbId });
    assert.equal((await s.code('F-04')).needsAnh, 'Workera question: A or B?');
  } finally { await s.close(); }
});

test('Sol 3: a client that sends the joined projection back cannot do it quietly: a no-lane push of a shared task is 428', async () => {
  const s = await fx();
  try {
    await bothAsk(s);
    const t = await s.code('F-04');
    const seq = s.board.state.seq;
    const r = await s.push([{ code: 'F-04', title: t.title, lane: t.lane, needsAnh: t.needsAnh, steps: t.steps }]);
    assert.equal(r.status, 428); assert.equal(s.board.state.seq, seq);
  } finally { await s.close(); }
});

test('Sol 3 (guard): v1 attention.waiting keeps one entry per ask; ask.answer, ask.clear and a scoped feedback touch only their ask', async () => {
  const s = await s21Board();
  try {
    seedShared(s);
    // Two simultaneous asks on one task, raised through v1 without lanes (the shape already on the live board).
    s.w('step.create', 'F-04/workera-2', { label: 'second wait', zone: 'owner', state: 'waiting' });
    const a1 = s.w('ask.raise', 'F-04', { text: 'first?', step_id: 'workera-step' }), a2 = s.w('ask.raise', 'F-04', { text: 'second?', step_id: 'workera-2' });
    const wait = async () => (await s.v1state()).attention.waiting.filter(w => w.task_id === 'F-04' && w.kind === 'ask');
    let waits = await wait();
    assert.deepEqual(waits.map(w => w.id).sort(), [a1.id, a2.id].sort(), 'one entry per ask');
    for (const w of waits) assert.deepEqual(Object.keys(w).filter(k => ['task_id', 'text', 'since'].includes(k)).sort(), ['since', 'task_id', 'text']);
    s.ownerW('ask.answer', a1.id, { text: 'yes' }, { expected_revision: 1 });
    assert.deepEqual((await wait()).map(w => w.id), [a2.id], 'answering one leaves the other');
    s.w('ask.clear', a2.id, { note: 'n' }, { expected_revision: 1 });
    assert.equal((await wait()).length, 0);
    const b1 = s.w('ask.raise', 'F-04', { text: 'again 1?', step_id: 'workera-step' }), b2 = s.w('ask.raise', 'F-04', { text: 'again 2?', step_id: 'workera-2' });
    const fb = s.ownerW('feedback.add', 'F-04', { kind: 'note', text: 'about the second', ask_id: b2.id });
    assert.deepEqual(s.board.state.feedback[fb.id].answers_asks, [b2.id]);
    assert.deepEqual((await wait()).map(w => w.id), [b1.id], 'a message scoped to one ask answers only it');
  } finally { await s.close(); }
});

test('Sol 3 (guard): the old POST /api/admin/asks shape still answers {ok:true} and replaces the one ask of a single-lane task', async () => {
  const s = await fx();
  try {
    const r1 = await s.ask({ code: 'V-1', text: 'first', by: 'Workerb' });
    assert.deepEqual(r1.body, { ok: true });
    const r2 = await s.ask({ code: 'V-1', text: 'second', by: 'Workerb' });
    assert.deepEqual(r2.body, { ok: true });
    assert.deepEqual(s.openAsks('V-1').map(a => a.text), ['second']);
    assert.equal((await s.code('V-1')).needsAnh, 'second');
  } finally { await s.close(); }
});

test("Sol 2: a lane's pushed needsAnh is that lane's ask only: two lanes push, both asks stay; a lane dropping its needsAnh clears its own", async () => {
  const s = await fx();
  try {
    const f04 = (steps, extra = {}) => row('F-04', WORKERA, steps, { title: 'Trang chủ', now: 'Workera now', next: 'Workera next', order: 1, health: 'yellow', ...extra });
    let r = await s.push([f04([step('s1', 'done'), step('workera-step', 'waiting', 'anh')], { needsAnh: 'Workera asks' })], { lane: WORKERA });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await s.push([{ code: 'F-04', steps: [step('video-ad', 'waiting', 'anh')], needsAnh: 'Workerb asks' }], { lane: 'Workerb' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(s.openAsks('F-04').map(a => [a.text, a.lane ?? WORKERA, a.step_id]).sort(), [['Workera asks', WORKERA, 'workera-step'], ['Workerb asks', 'Workerb', 'video-ad']]);
    // Workera rewords its ask: only Workera's is replaced.
    const workerb = s.openAsks('F-04').find(a => a.lane === 'Workerb').id;
    r = await s.push([f04([step('s1', 'done'), step('workera-step', 'waiting', 'anh')], { needsAnh: 'Workera asks again' })], { lane: WORKERA });
    assert.equal(r.status, 200);
    assert.deepEqual(s.openAsks('F-04').map(a => a.text).sort(), ['Workera asks again', 'Workerb asks']);
    assert.equal(s.board.state.asks[workerb].status, 'open');
    // Workera's row drops its ask: Workerb's remains.
    r = await s.push([f04([step('s1', 'done'), step('workera-step', 'done', 'anh')], { needsAnh: '' })], { lane: WORKERA });
    assert.equal(r.status, 200);
    assert.deepEqual(s.openAsks('F-04').map(a => a.text), ['Workerb asks']);
    const seq = s.board.state.seq;
    await s.push([f04([step('s1', 'done'), step('workera-step', 'done', 'anh')], { needsAnh: '' })], { lane: WORKERA });
    assert.equal(s.board.state.seq, seq, 'idempotent');
  } finally { await s.close(); }
});

test('Sol 3: five simultaneous asks on one task (F-04 has had five): legacy projection, v1 attention and v2 list agree, in the same order', async () => {
  const s = await fx();
  try {
    for (const id of ['p1', 'p2', 'p3']) s.w('step.create', `F-04/${id}`, { label: id, zone: 'owner', state: 'waiting' });
    for (const id of ['va', 'vb']) s.w('step.create', `F-04/${id}`, { label: id, zone: 'owner', state: 'waiting', lane: 'Workerb' });
    const want = [['p1', WORKERA], ['va', 'Workerb'], ['p2', WORKERA], ['vb', 'Workerb'], ['p3', WORKERA]];
    const ids = [];
    for (const [step, lane] of want) { const r = await s.ask({ code: 'F-04', lane, step, text: `question on ${step}` }); assert.equal(r.status, 200, JSON.stringify(r.body)); ids.push(r.body.id); }
    assert.equal(s.openAsks('F-04').length, 5);
    const texts = want.map(([step]) => `question on ${step}`);
    assert.equal((await s.code('F-04')).needsAnh, texts.join('\n\n'), 'the joined projection follows the order the asks were raised');
    assert.deepEqual((await s.code('F-04', 2)).asks.map(a => a.id), ids);
    const waits = (await s.v1state()).attention.waiting.filter(w => w.task_id === 'F-04' && w.kind === 'ask');
    assert.deepEqual(waits.map(w => w.id).sort(), [...ids].sort(), 'v1 keeps one entry per ask');
    const every = (await s.v1state()).attention.waiting.filter(w => w.task_id === 'F-04');
    assert.equal((await s.code('F-04')).askAt, every.map(w => w.since).sort()[0], 'askAt = the oldest wait of the task (the one age rule), asks and uncovered steps alike');
    // one answered, one cleared: the other three are untouched
    s.ownerW('feedback.add', 'F-04', { kind: 'note', text: 'answer', ask_id: ids[1] });
    await s.clear({ id: ids[3] });
    assert.deepEqual(s.openAsks('F-04').map(a => a.id), [ids[0], ids[2], ids[4]]);
    assert.equal((await s.code('F-04')).needsAnh, [texts[0], texts[2], texts[4]].join('\n\n'));
  } finally { await s.close(); }
});

test('Sol done-gate 1: ask.update only fills an ABSENT lane, with the coordinator token and a migration origin; it never replaces a lane', async () => {
  const s = await fx();
  try {
    const a = s.w('ask.raise', 'F-04', { text: 'legacy ask', step_id: 'workera-step' }); // no lane stored: the task's
    const call = (who, extra) => { try { (who === 'owner' ? s.ownerW : s.w)('ask.update', a.id, { lane: 'Workerb' }, { expected_revision: s.board.state.asks[a.id].rev, ...extra }); } catch (e) { return e; } return null; };
    let e = call('owner', { origin: 'migrate-s21 x' });
    assert.equal(e?.status, 403, 'ordinary owner access is gone'); assert.equal(s.board.state.asks[a.id].lane, undefined);
    e = call('coordinator', {});
    assert.equal(e?.code, 'migration_only', 'no migration origin: refused'); assert.equal(s.board.state.asks[a.id].lane, undefined);
    assert.equal(call('coordinator', { origin: 'something else' })?.code, 'migration_only');
    assert.equal(call('coordinator', { origin: 'migrate-s21 snapshot-1' }), null, 'coordinator + migration origin + absent lane: filled');
    assert.equal(s.board.state.asks[a.id].lane, 'Workerb');
    e = call('coordinator', { origin: 'migrate-s21 snapshot-1' });
    assert.equal(e?.code, 'lane_immutable', 'a lane that is set is never replaced, not even by the same value');
    // waiting_since stays migration-only
    let w; try { s.w('ask.raise', 'V-1', { text: 'q', waiting_since: '2020-01-01T00:00:00.000Z' }); } catch (x) { w = x; }
    assert.equal(w?.code, 'waiting_since_not_allowed');
  } finally { await s.close(); }
});

// s21-multiask: one lane may hold several open asks on one task, one per step. A row has one needsAnh, so a push speaks for the
// ask on ITS ask step only; an ask on another step of the lane that is still waiting in the row is not the row's to replace.
for (const [name, lane, steps] of [['a task lane', WORKERA, ['workera-step', 'workera-b']], ['another lane', 'Workerb', ['video-ad', 'video-b']]]) {
  test(`s21-multiask (${name}): two asks by one lane on two steps stay open through row pushes; a closed step closes only its own ask`, async () => {
    const s = await fx();
    try {
      const [A, B] = steps, ownerRow = lane === WORKERA;
      s.w('step.create', `F-04/${B}`, { label: B, zone: 'owner', state: 'waiting', ...(ownerRow ? {} : { lane }) });
      const f04 = (states, needsAnh) => (ownerRow
        ? row('F-04', WORKERA, [step('s1', 'done'), ...steps.map((id, i) => step(id, states[i], 'anh'))], { title: 'Trang chủ', now: 'Workera now', next: 'Workera next', order: 1, health: 'yellow', needsAnh })
        : { code: 'F-04', steps: steps.map((id, i) => step(id, states[i], 'anh')), needsAnh });
      const open = () => s.openAsks('F-04').filter(a => (a.lane ?? WORKERA) === lane).map(a => [a.step_id, a.text]).sort();
      // the row asks on B first in its step order (the board ties the row's ask to its first waiting owner step), as `ask --step B` leaves it
      let r = await s.push([f04(['waiting', 'waiting'], 'first')], { lane }); assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(open(), [[A, 'first']]);
      const rowB = ownerRow ? row('F-04', WORKERA, [step('s1', 'done'), step(B, 'waiting', 'anh'), step(A, 'waiting', 'anh')], { title: 'Trang chủ', now: 'Workera now', next: 'Workera next', order: 1, health: 'yellow', needsAnh: 'second' })
        : { code: 'F-04', steps: [step(B, 'waiting', 'anh'), step(A, 'waiting', 'anh')], needsAnh: 'second' };
      r = await s.push([rowB], { lane }); assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(open(), [[A, 'first'], [B, 'second']].sort(), "the row's new ask on B did not replace the ask on A");
      const seq = s.board.state.seq;
      assert.equal((await s.push([rowB], { lane })).status, 200); assert.equal(s.board.state.seq, seq, 'a re-push writes nothing');
      // the row finishes A (still asking on B): only A's ask closes
      const done = ownerRow ? row('F-04', WORKERA, [step('s1', 'done'), step(A, 'done', 'anh'), step(B, 'waiting', 'anh')], { title: 'Trang chủ', now: 'Workera now', next: 'Workera next', order: 1, health: 'yellow', needsAnh: 'second' })
        : { code: 'F-04', steps: [step(A, 'done', 'anh'), step(B, 'waiting', 'anh')], needsAnh: 'second' };
      r = await s.push([done], { lane }); assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(open(), [[B, 'second']], "A's ask closed, B's stays");
      // the row then drops its needsAnh with B still waiting in it: B's ask stays (the row did not finish B)
      const none = ownerRow ? row('F-04', WORKERA, [step('s1', 'done'), step(A, 'done', 'anh'), step(B, 'waiting', 'anh')], { title: 'Trang chủ', now: 'Workera now', next: 'Workera next', order: 1, health: 'yellow', needsAnh: '' })
        : { code: 'F-04', steps: [step(A, 'done', 'anh'), step(B, 'waiting', 'anh')], needsAnh: '' };
      r = await s.push([none], { lane }); assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(open(), [[B, 'second']], "a row that merely has no needsAnh does not close an ask on a step it still has waiting");
      // finishing B closes it
      const fin = ownerRow ? row('F-04', WORKERA, [step('s1', 'done'), step(B, 'done', 'anh'), step(A, 'done', 'anh')], { title: 'Trang chủ', now: 'Workera now', next: 'Workera next', order: 1, health: 'yellow', needsAnh: '' })
        : { code: 'F-04', steps: [step(B, 'done', 'anh'), step(A, 'done', 'anh')], needsAnh: '' };
      r = await s.push([fin], { lane }); assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(open(), []);
    } finally { await s.close(); }
  });
}

test('s21-multiask: a single-lane task (no lane named) also keeps a second ask on another step', async () => {
  const s = await fx();
  try {
    s.w('step.create', 'V-1/v2', { label: 'v2', zone: 'owner', state: 'waiting' });
    const v1row = (needsAnh, order, states = {}) => row('V-1', 'Workerb', order.map(id => step(id, states[id] || 'waiting', 'anh')), { title: 'Workerb own task', order: 2, needsAnh });
    let r = await s.push([v1row('first', ['v2', 'v1'], { v1: 'todo' })]); assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await s.push([v1row('second', ['v1', 'v2'])]); assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(s.openAsks('V-1').map(a => [a.step_id, a.text]).sort(), [['v1', 'second'], ['v2', 'first']]);
  } finally { await s.close(); }
});

// ---- review of d371377: the row's ask step is the row's askStep (the client sends it), not a guess ----
const optsStep = (id, state, zone = 'anh') => step(id, state, zone, { options: [{ key: 'A', label: 'Photo' }, { key: 'B', label: 'Drawing' }] });
const vrow = (steps, needsAnh, askStep) => ({ code: 'F-04', steps, needsAnh, ...(askStep ? { askStep } : {}) });
const workerb = s => s.openAsks('F-04').filter(a => a.lane === 'Workerb');

test('review B1: clearing the newer ask (row blank, no askStep) leaves the older ask open even when the older step has options', async () => {
  const s = await fx();
  try {
    s.w('step.create', 'F-04/video-b', { label: 'video-b', zone: 'owner', state: 'todo', lane: 'Workerb' });
    const open = () => workerb(s).map(a => [a.step_id, a.text]).sort();
    let r = await s.push([vrow([optsStep('video-ad', 'waiting'), step('video-b', 'todo', 'anh')], 'QA', 'video-ad')], { lane: 'Workerb' }); assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await s.push([vrow([step('video-b', 'waiting', 'anh'), optsStep('video-ad', 'waiting')], 'QB', 'video-b')], { lane: 'Workerb' }); assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(open(), [['video-ad', 'QA'], ['video-b', 'QB']]);
    // `clear --step video-b`: closeAsk leaves the row blank with no askStep, video-b done; video-ad (options) still waits
    r = await s.push([vrow([step('video-b', 'done', 'anh'), optsStep('video-ad', 'waiting')], '')], { lane: 'Workerb' }); assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(open(), [['video-ad', 'QA']], 'the ask on the options step is not the blank row\'s to clear');
    const seq = s.board.state.seq;
    assert.equal((await s.push([vrow([step('video-b', 'done', 'anh'), optsStep('video-ad', 'waiting')], '')], { lane: 'Workerb' })).status, 200);
    assert.equal(s.board.state.seq, seq, 'a re-push writes nothing');
  } finally { await s.close(); }
});

test('review S1: a reordered set of waiting owner steps does not raise a duplicate ask (with and without askStep)', async () => {
  for (const hint of [true, false]) {
    const s = await fx();
    try {
      s.w('step.create', 'F-04/video-c', { label: 'video-c', zone: 'owner', state: 'todo', lane: 'Workerb' });
      const ask = steps => vrow(steps, 'QA', hint ? 'video-ad' : undefined);
      let r = await s.push([ask([step('video-ad', 'waiting', 'anh'), step('video-c', 'todo', 'anh')])], { lane: 'Workerb' }); assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(workerb(s).length, 1);
      r = await s.push([ask([step('video-c', 'waiting', 'anh'), step('video-ad', 'waiting', 'anh')])], { lane: 'Workerb' }); assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(workerb(s).map(a => [a.step_id, a.text]), [['video-ad', 'QA']], `hint=${hint}`);
    } finally { await s.close(); }
  }
});

test('review S2: a row that carries askStep and blanks needsAnh with the step still waiting clears that ask (ce850a7 behaviour)', async () => {
  const s = await fx();
  try {
    let r = await s.push([vrow([step('video-ad', 'waiting', 'anh')], 'QA', 'video-ad')], { lane: 'Workerb' }); assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(workerb(s).length, 1);
    r = await s.push([vrow([step('video-ad', 'waiting', 'anh')], '', 'video-ad')], { lane: 'Workerb' }); assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(workerb(s).length, 0);
  } finally { await s.close(); }
});

// ---- J-05 16-10 (Workerb on H-03): `ask --step B` set B to waiting but B is a build step, not an owner step, so the board guessed
// its FIRST waiting owner step (the lane's step A) and replaced the lane's open ask there. A named step the board cannot tie an
// ask to must be refused, never guessed onto another step.
test('J-05 ask-step: an ask naming a step that is not a waiting owner step is refused, never moved onto another step', async () => {
  const s = await fx();
  try {
    s.w('step.create', 'F-04/upwork-go', { label: 'Upwork', zone: 'build', state: 'todo', lane: 'Workerb' });
    // Workerb's open ask sits on its owner step video-ad (the row's askStep), as on H-03 before the incident
    let r = await s.push([vrow([step('video-ad', 'waiting', 'anh'), step('upwork-go', 'todo', 'build')], 'video v2.1 …', 'video-ad')], { lane: 'Workerb' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(workerb(s).map(a => [a.step_id, a.text]), [['video-ad', 'video v2.1 …']]);
    // `ask --step upwork-go` sets upwork-go waiting but leaves it a build step: the board must refuse, not tie the ask to video-ad
    const seq = s.board.state.seq;
    r = await s.push([vrow([step('upwork-go', 'waiting', 'build'), step('video-ad', 'waiting', 'anh')], 'n8n text', 'upwork-go')], { lane: 'Workerb' });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.error, 'ask_step_not_waiting_owner');
    assert.equal(s.board.state.seq, seq, 'a refused push writes nothing');
    assert.deepEqual(workerb(s).map(a => [a.step_id, a.text]), [['video-ad', 'video v2.1 …']], "the ask on the lane's owner step is untouched, not replaced");
  } finally { await s.close(); }
});

// ---- J-05 fix round 2: the refusal fired for a row that asks NOTHING (empty needsAnh) and only carried a stale askStep, so one
// such row (askStep on a done step) blocked a lane's whole push. It must be refused only when the row would raise an ask.
test('J-05 ask-step (fix round 2): a row that asks nothing ignores a stale askStep; the same stale askStep with a question is still refused', async () => {
  const s = await fx();
  try {
    // A Workerb-owned row whose askStep points at a DONE owner step: it is not a waiting owner step, but the row raises no ask.
    s.w('task.create', 'V-2', { title: 'Workerb board', lane: 'Workerb', order: 3,
      steps: [step('v-done', 'done', 'owner'), step('v-wait', 'waiting', 'owner')] });
    const v2 = needsAnh => ({ code: 'V-2', title: 'Workerb board', lane: 'Workerb', order: 3, needsAnh, askStep: 'v-done',
      steps: [step('v-done', 'done', 'anh'), step('v-wait', 'waiting', 'anh')] });
    let r = await s.push([v2('')], { lane: 'Workerb' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(s.openAsks('V-2'), [], 'a row that asks nothing is accepted and raises no ask');
    // The same stale askStep WITH a real question is still refused, and nothing is written.
    const seq = s.board.state.seq;
    r = await s.push([v2('a real question')], { lane: 'Workerb' });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.error, 'ask_step_not_waiting_owner');
    assert.equal(s.board.state.seq, seq, 'a refused push writes nothing');
  } finally { await s.close(); }
});
