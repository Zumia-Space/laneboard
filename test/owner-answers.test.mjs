// Owner feedback on a task or step that waits on the owner answers the open ask there: the card leaves "Waiting on
// you" (answered, with when and which feedback), the step state stays the coordinator's call, and the feedback stays
// open in the coordinator's feed. Incident 01-10: a QC verdict on L-01-3D/qc22 left the task's ask open. Since 15-10 a plain note or
// redirect answers only an ask it names (ask_id): see receipt-ask.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startSeeded, OWNER } from './helpers.mjs';

const ok = r => { assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
const ask = (s, id) => s.board.state.asks[id];

test('a step verdict (approve, reject, choice) answers that step\'s ask only; the step state is unchanged and the note stays open for the coordinator', async () => {
  const s = await startSeeded();
  try {
    const onS3 = ok(await s.write(s.coord, 'ask.raise', 'WEB-3', { text: 'Pick the hero', step_id: 's3', options: [{ key: 'A', label: 'Photo' }] }));
    const onS2 = ok(await s.write(s.coord, 'ask.raise', 'WEB-3', { text: 'Build ok?', step_id: 's2' }));
    const other = ok(await s.write(s.coord, 'ask.raise', 'API-2', { text: 'Ship?' }));
    const note = ok(await s.write(OWNER, 'feedback.add', 'WEB-3', { kind: 'approve', text: 'Looks fine, but bigger', step_id: 's3' }));
    const a = ask(s, onS3.id);
    assert.equal(a.status, 'answered');
    assert.equal(a.answer.feedback_id, note.id);
    assert.ok(Date.parse(a.answer.at) > 0);
    assert.equal(a.answer.by.role, 'owner');
    assert.equal(ask(s, onS2.id).status, 'open', 'an ask on another step stays');
    assert.equal(ask(s, other.id).status, 'open', 'an ask on another task stays');
    assert.equal(s.board.state.steps['WEB-3/s3'].state, 'waiting', 'the coordinator decides the step');
    const st = await s.state(OWNER);
    assert.ok(!st.attention.waiting.some(w => w.id === onS3.id || (w.task_id === 'WEB-3' && w.step_id === 's3')), 'the card left Waiting on you');
    assert.ok(st.attention.waiting.some(w => w.id === onS2.id));
    assert.ok(st.attention.answered.some(x => x.id === onS3.id), 'listed as answered');
    const fb = st.feedback.find(f => f.id === note.id);
    assert.deepEqual([fb.status, fb.kind, fb.answers_asks], ['open', 'approve', [onS3.id]], 'still new owner feedback in the feed');
    const ev = s.board.events(OWNER, 0, 1000).find(e => e.result.id === note.id);
    assert.deepEqual(ev.data.answers_asks, [onS3.id], 'decided at write time and journaled');
  } finally { await s.close(); }
});

test('a task note answers the task\'s step-less ask, not step asks; a step note also answers the task\'s step-less ask', async () => {
  const s = await startSeeded();
  try {
    const task1 = ok(await s.write(s.coord, 'ask.raise', 'WEB-3', { text: 'QC the build?' }));
    const step = ok(await s.write(s.coord, 'ask.raise', 'WEB-3', { text: 'Pick the hero', step_id: 's3' }));
    ok(await s.write(OWNER, 'feedback.add', 'WEB-3', { kind: 'approve', text: 'ok' }));
    assert.equal(ask(s, task1.id).status, 'answered');
    assert.equal(ask(s, step.id).status, 'open', 'a task-level note leaves step asks');
    // L-01-3D: the ask was on the task, the owner's QC note on a step.
    const task2 = ok(await s.write(s.coord, 'ask.raise', 'API-2', { text: 'QC gameplay?' }));
    ok(await s.write(OWNER, 'feedback.add', 'API-2', { kind: 'reject', text: 'needs more', step_id: 's1' }));
    assert.equal(ask(s, task2.id).status, 'answered');
  } finally { await s.close(); }
});

test('only owner answers count: a coordinator reply, an owner new-task request or a migrated row answer nothing', async () => {
  const s = await startSeeded();
  try {
    const a = ok(await s.write(s.coord, 'ask.raise', 'WEB-3', { text: 'Hero?', step_id: 's3' }));
    ok(await s.write(s.coord, 'feedback.add', 'WEB-3', { kind: 'reply', text: 'working on it', step_id: 's3' }));
    ok(await s.write(OWNER, 'feedback.add', 'WEB-3', { kind: 'approve', text: 'old', step_id: 's3' }, { origin: 'legacy anh 2026-09-01T00:00:00.000Z' }));
    assert.equal(ask(s, a.id).status, 'open');
    const r = await s.write(OWNER, 'feedback.add', 'WEB-3', { kind: 'note', text: 'x', step_id: 's3', answers_asks: [a.id] });
    assert.equal(r.status, 400, 'a client cannot name the asks itself');
  } finally { await s.close(); }
});

test('an owner message never answers an ask raised after it (the answer is decided when the message is written)', async () => {
  const s = await startSeeded();
  try {
    ok(await s.write(OWNER, 'feedback.add', 'WEB-3', { kind: 'approve', text: 'early note', step_id: 's3' }));
    ok(await s.write(OWNER, 'feedback.add', 'WEB-3', { kind: 'approve', text: 'early task note' }));
    const later = ok(await s.write(s.coord, 'ask.raise', 'WEB-3', { text: 'QC now?' }));         // step-less, raised after
    const laterStep = ok(await s.write(s.coord, 'ask.raise', 'WEB-3', { text: 'Hero?', step_id: 's3' }));
    assert.equal(ask(s, later.id).status, 'open');
    assert.equal(ask(s, laterStep.id).status, 'open');
    const st = await s.state(OWNER);
    assert.ok(st.attention.waiting.some(w => w.id === later.id) && st.attention.waiting.some(w => w.id === laterStep.id));
  } finally { await s.close(); }
});
