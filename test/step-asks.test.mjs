// J-05 part 1 (one ask per waiting owner step): a row may say one ask per step, `asks: {"<step>": "<text>"}`, and the push
// reconciles each on its own (task, lane, step) -- five waiting owner steps are five asks, a reword replaces one, an empty
// entry clears one, and nothing is ever compared across steps. The legacy single needsAnh+askStep row is the map's one-entry
// case: its wire bytes (push reply, /api/state, /api/state?v=2) are pinned against a recording made on 81e3204, before this
// change (STEP_WIRE_WRITE=1 rewrites the recording, as S21_GOLDEN_WRITE does for the s21 golden).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { s21Board, step } from './s21-helpers.mjs';
import { legacyRowToRequests, rowAsks } from '../src/adapt-legacy.mjs';

const GOLDEN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'golden', 'step-asks-wire-legacy.json');
const T = Date.parse('2026-10-20T08:00:00.000Z'); // a fixed clock: every `at` on the wire is reproducible
const ownerStep = (id, state = 'waiting') => step(id, state, 'anh');
const STEPS = ['s1', 's2', 's3', 's4', 's5'].map(id => ownerStep(id));

/** A row that asks on several steps at once, the way the CLI writes it after J-05: needsAnh mirrors the map, joined. */
const mapRow = (asks, steps = STEPS) => ({ code: 'V-5', title: 'Five', lane: 'Workerb', order: 5, needsAnh: Object.values(asks).join('\n\n'), asks, steps });
const open = (s, code = 'V-5') => s.openAsks(code).map(a => [a.step_id, a.text]).sort((a, b) => a[0].localeCompare(b[0]));

test('step-asks: five waiting owner steps raise five asks; a reword or a clear touches only its own step', async () => {
  const s = await s21Board();
  try {
    // The map is deliberately not in step order: the asks are raised (and the joined needsAnh follows) in the ROW's step order.
    const FIVE = { s3: 'C?', s1: 'A?', s5: 'E?', s2: 'B?', s4: 'D?' };
    let r = await s.push([mapRow(FIVE)]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(open(s), [['s1', 'A?'], ['s2', 'B?'], ['s3', 'C?'], ['s4', 'D?'], ['s5', 'E?']], 'one ask per waiting owner step');
    assert.equal((await s.code('V-5')).needsAnh, 'A?\n\nB?\n\nC?\n\nD?\n\nE?', 'the legacy projection joins them in step order');
    const v2 = (await s.code('V-5', 2)).asks;
    assert.deepEqual(v2.map(a => [a.step_id, a.text]), [['s1', 'A?'], ['s2', 'B?'], ['s3', 'C?'], ['s4', 'D?'], ['s5', 'E?']], 'v2 lists every ask with its step');

    // A re-push of the same row writes nothing (per-step identity, no duplicate).
    const seq = s.board.state.seq;
    r = await s.push([mapRow(FIVE)]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.writes, 0);
    assert.equal(s.board.state.seq, seq, 'a re-push writes nothing');

    // A reword on s3 replaces s3's ask and only it (the other four keep their ids).
    const ids = Object.fromEntries(s.openAsks('V-5').map(a => [a.step_id, a.id]));
    r = await s.push([mapRow({ ...FIVE, s3: 'C, reworded?' })]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const after = Object.fromEntries(s.openAsks('V-5').map(a => [a.step_id, a]));
    assert.deepEqual(open(s), [['s1', 'A?'], ['s2', 'B?'], ['s3', 'C, reworded?'], ['s4', 'D?'], ['s5', 'E?']]);
    assert.notEqual(after.s3.id, ids.s3, 'the reworded ask is a new question');
    for (const id of ['s1', 's2', 's4', 's5']) assert.equal(after[id].id, ids[id], `${id}'s ask is untouched`);

    // An entry the row leaves out on a still-waiting step is that step's clear (the CLI's `clear --step A` removes the key):
    // the ask goes, the other four stay.
    r = await s.push([mapRow({ s1: 'A?', s2: 'B?', s4: 'D?', s5: 'E?' })]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(open(s), [['s1', 'A?'], ['s2', 'B?'], ['s4', 'D?'], ['s5', 'E?']], 'dropping one entry closes only its ask');

    // A step that stops waiting closes its own ask, and none other. A map entry still naming a step the owner cannot answer is
    // refused (the H-03 rule: an ask is never re-aimed at another step), so the row drops it as the CLI does.
    const DONE1 = [ownerStep('s1', 'done'), ownerStep('s2'), ownerStep('s3'), ownerStep('s4'), ownerStep('s5')];
    const seq2 = s.board.state.seq;
    r = await s.push([mapRow({ ...FIVE, s3: '' }, DONE1)]);
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.error, 'ask_step_not_waiting_owner');
    assert.equal(s.board.state.seq, seq2, 'a refused push writes nothing');
    r = await s.push([mapRow({ s2: 'B?', s4: 'D?', s5: 'E?' }, DONE1)]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(open(s), [['s2', 'B?'], ['s4', 'D?'], ['s5', 'E?']]);
  } finally { await s.close(); }
});

test('step-asks: an answer on step B leaves C open and answersAsks names B', async () => {
  // One ask per step: answering the one on B (from its ask box, an owner note scoped to its id) closes exactly that ask and
  // names it on the feedback; A and C stay open. A re-push of the unchanged row then asks nothing again, on B or anywhere.
  const s = await s21Board();
  try {
    const THREE = ['s1', 's2', 's3'].map(id => ownerStep(id));
    const r = await s.push([mapRow({ s1: 'A?', s2: 'B?', s3: 'C?' }, THREE)]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(open(s), [['s1', 'A?'], ['s2', 'B?'], ['s3', 'C?']]);
    const idB = s.openAsks('V-5').find(a => a.step_id === 's2').id;
    s.ownerW('feedback.add', 'V-5', { kind: 'note', text: 'B answered', ask_id: idB });
    assert.equal(s.board.state.asks[idB].status, 'answered', 'the answer closes the ask it names');
    assert.deepEqual(open(s), [['s1', 'A?'], ['s3', 'C?']], 'A and C stay open');
    const v2 = await s.state(2), msg = v2.feedback.find(f => f.text === 'B answered');
    assert.deepEqual(msg.answersAsks, [idB], 'the v2 view (what the CLI reads) names B');
    assert.deepEqual(msg.answers, [{ id: idB, lane: 'Workerb', step_id: 's2' }], 'and says which step it answered');
    // The row still names B; pushing it again must not resurrect the answered ask, and must not touch C.
    const seq = s.board.state.seq;
    const again = await s.push([mapRow({ s1: 'A?', s2: 'B?', s3: 'C?' }, THREE)]);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.writes, 0, 'an answered ask is never re-raised');
    assert.equal(s.board.state.seq, seq, 'nothing was written');
    assert.deepEqual(open(s), [['s1', 'A?'], ['s3', 'C?']], 'C is still waiting for an answer');
  } finally { await s.close(); }
});

test('step-asks: a map key naming the history step or an archived step is dropped, never a refused push', async () => {
  // Compaction moves older done steps into state.archive and puts the board's own `lich-su` step first. A stale row can still name
  // either in its map; the push cleans them the way it cleans askStep, so a lane is never stalled over an ask on a gone step.
  const s = await s21Board();
  try {
    s.w('task.create', 'V-6', { title: 'Compact', lane: 'Workerb', order: 6,
      steps: [step('s1', 'done'), step('s2', 'done'), step('w', 'waiting', 'owner')] });
    s.w('steps.compact', 'V-6', { keep_last: 1 }, { expected_revision: s.board.state.tasks['V-6'].rev });
    assert.deepEqual(s.board.state.archive['V-6'].order, ['s1'], 'the older done step folded (s2 and the waiting step stay live)');
    const row = { code: 'V-6', title: 'Compact', lane: 'Workerb', order: 6, asks: { 'lich-su': 'never', s1: 'stale', w: 'Live Q?' },
      steps: [step('w', 'waiting', 'owner')] };
    const r = await s.push([row]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(open(s, 'V-6'), [['w', 'Live Q?']], 'only the live waiting owner step gets an ask');
    assert.deepEqual(r.body.ignored, [{ task: 'V-6', archived: ['s1'] }], 'the archived key is reported, as an archived step id is');
  } finally { await s.close(); }
});

test('step-asks: a duplicated refs line in a map entry is normalised once, like needsAnh (review S1)', async () => {
  // The map entries are ask texts the renderer may have written refs onto, exactly like needsAnh: a client that pushes back
  // /state text must not store the same refs line twice, and both ask forms must raise the same text for the same input.
  const s = await s21Board();
  try {
    const LINE = '[plan.md](https://x.test/p) · `D:/data/laneboard/acme-03/PLAN.md`';
    const dup = `Which mock?\n${LINE}\n${LINE}`, one = `Which mock?\n${LINE}`;
    let r = await s.push([mapRow({ s1: dup }, [ownerStep('s1')])]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(open(s), [['s1', one]], 'the map entry is stored with its refs line deduped, as one ask');
    // Clear it, then raise the same text through the legacy single-ask path: the two paths agree byte for byte.
    r = await s.push([mapRow({ s1: '' }, [ownerStep('s1')])]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await s.push([{ code: 'V-5', title: 'Five', lane: 'Workerb', order: 5, needsAnh: dup, askStep: 's1', steps: [ownerStep('s1')] }]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(open(s), [['s1', one]], 'needsAnh and a map entry raise the same deduped text');
  } finally { await s.close(); }
});

test("step-asks: a map row clears this lane's step-less ask left by an older client (review S2)", async () => {
  // Before per-step maps a row could ask with no waiting owner step: the ask was step-less. Every CLI ask now writes a map,
  // and a lane's own map is its whole answer -- so a keyless ask of that lane follows the row out, as the legacy path did.
  const s = await s21Board();
  const pairs = () => s.openAsks('V-5').map(a => [a.step_id || '', a.text]).sort((a, b) => a[0].localeCompare(b[0]));
  try {
    let r = await s.push([{ code: 'V-5', title: 'Five', lane: 'Workerb', order: 5, needsAnh: 'Old?', steps: [step('s1', 'active')] }]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(pairs(), [['', 'Old?']], 'the older client left one step-less ask');
    r = await s.push([mapRow({ s1: 'New?' }, [ownerStep('s1')])]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(pairs(), [['s1', 'New?']], 'the lane\'s map cleared the step-less ask and raised its own');
  } finally { await s.close(); }
});

test('step-asks: a map clears only the pusher lane\'s own steps -- another lane\'s asks survive a full-row push', async () => {
  // The shared rows dir: one lane pushes the whole row, whose `asks` map belongs to the row owner. Omitting another lane's step must
  // not clear that lane's ask; the owner's own omission still clears (the map is its answer for its own steps).
  const s = await s21Board();
  try {
    s.w('task.create', 'V-1', { title: 'Workerb own task', lane: 'Workerb', order: 2, steps: [step('v1', 'active')] });
    s.w('task.create', 'F-04', { title: 'Trang chủ', lane: 'Workera CoS', order: 1, steps: [step('a-step', 'waiting', 'owner')] });
    s.w('step.create', 'F-04/video-ad', { label: 'Video ad', zone: 'owner', state: 'waiting', lane: 'Workerb' });
    const workeraRow = map => ({ code: 'F-04', title: 'Trang chủ', lane: 'Workera CoS', order: 1, asks: map, steps: [step('a-step', 'waiting', 'owner')] });
    // The task lane pushes its own row with its own map.
    let r = await s.push([workeraRow({ 'a-step': 'Workera Q?' })], { lane: 'Workera CoS' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    // Workerb raises her ask on her own step (a legacy row, no map).
    r = await s.push([{ code: 'F-04', lane: 'Workera CoS', needsAnh: 'Workerb Q?', steps: [step('video-ad', 'waiting', 'owner', { lane: 'Workerb' })] }], { lane: 'Workerb' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(open(s, 'F-04'), [['a-step', 'Workera Q?'], ['video-ad', 'Workerb Q?']], "Workera's map speaks for Workera's step only");
    // Workerb pushes her lane-scoped row carrying the row owner's map (as a shared rows dir would): it omits her step, and her ask stays.
    const shared = map => ({ code: 'F-04', lane: 'Workera CoS', asks: map, steps: [step('video-ad', 'waiting', 'owner', { lane: 'Workerb' })] });
    r = await s.push([shared({ 'a-step': 'Workera Q?' })], { lane: 'Workerb' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(open(s, 'F-04'), [['a-step', 'Workera Q?'], ['video-ad', 'Workerb Q?']], "another lane's map neither raises nor clears Workerb's ask");
    // Her own map does speak for her step: an explicit blank entry is her clear.
    r = await s.push([shared({ 'video-ad': '' })], { lane: 'Workerb' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(open(s, 'F-04'), [['a-step', 'Workera Q?']]);
  } finally { await s.close(); }
});

test('adapt-legacy: a blank needsAnh on a waiting options owner step still imports the step label as its ask', () => {
  // The predecessor's decision card: options on a waiting owner step ARE the question. Only the import does this (a push of a blank
  // row is a clear, never a new ask on a guessed step), so it must survive rowAsks being the one place that reads asks.
  const card = { code: 'A-1', lane: 'workera', needsAnh: '', steps: [{ id: 'a', label: 'Pick one', zone: 'anh', state: 'waiting', options: [{ key: 'A', label: 'X' }, { key: 'B', label: 'Y' }] }] };
  assert.deepEqual(rowAsks(card), [], 'rowAsks itself says nothing: a blank row never clears or raises on a guessed step');
  const asks = legacyRowToRequests(card).filter(r => r.op === 'ask.raise');
  assert.deepEqual(asks.map(r => [r.request_id, r.data.step_id, r.data.text, r.data.options.length]), [['legacy-A-1-ask', 'a', 'Pick one', 2]]);
});

test('step-asks: an old single-ask row (needsAnh + askStep) is byte-identical on the wire', async () => {
  // The scenario test/_record-step-wire.mjs ran on 81e3204 -- create, ask, re-push, reword, answer, clear, re-ask, finish --
  // recorded as the exact response text of every push reply, every /api/state and every /api/state?v=2. The clock is fixed, so
  // the whole transcript is comparable as one string: the new per-step reconcile must not move a single byte for one ask.
  const s = await s21Board({ now: () => T });
  const raw = async (method, route, body) => {
    // Admin writes answer a direct loopback caller only (no X-Forwarded-For); state reads carry one, as the page does.
    const headers = { 'Content-Type': 'application/json', ...(method === 'GET' ? { 'X-Forwarded-For': 't31' } : {}) };
    const res = await fetch(s.url + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.text() };
  };
  const row = (steps, needsAnh, askStep) => ({ code: 'V-9', title: 'Single', lane: 'Workerb', health: 'yellow', order: 9, now: 'n', next: 'x', needsAnh, ...(askStep ? { askStep } : {}), steps });
  const S = (id, state) => ownerStep(id, state);
  const steps = (a, b = 'todo', z = 'todo') => [S('a', a), step('b', b, 'anh'), step('z', z, 'anh')];
  const out = [];
  const snap = async (label, rows) => {
    out.push({ label, push: await raw('PUT', '/api/admin/tasks', { tasks: rows }), state: await raw('GET', '/api/state'), state2: await raw('GET', '/api/state?v=2') });
  };
  try {
    await snap('create', [row(steps('waiting'), '', 'a')]);
    await snap('ask Q1 on a', [row(steps('waiting'), 'Q1', 'a')]);
    await snap('same row again', [row(steps('waiting'), 'Q1', 'a')]);
    await snap('reworded on a', [row(steps('waiting'), 'Q1 reworded', 'a')]);
    s.ownerW('feedback.add', 'V-9', { kind: 'note', text: 'answered', ask_id: s.openAsks('V-9')[0].id });
    await snap('answered, same row again', [row(steps('waiting'), 'Q1 reworded', 'a')]);
    await snap('blank, step still waiting', [row(steps('waiting'), '', 'a')]);
    await snap('ask Q2 on a', [row(steps('waiting'), 'Q2', 'a')]);
    await snap('finished', [row(steps('done'), '')]);
  } finally { await s.close(); }
  const got = JSON.stringify(out, null, 1) + '\n';
  if (process.env.STEP_WIRE_WRITE) { fs.writeFileSync(GOLDEN, got); return; }
  assert.equal(got, fs.readFileSync(GOLDEN, 'utf8'), 'the legacy wire did not move');
});
