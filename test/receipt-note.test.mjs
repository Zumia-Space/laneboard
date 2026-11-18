// J-05 16-10 (ACME-01/acme-b18, and H-04/pick on 15-10): a plain owner NOTE left on an ask's step is not an answer.
// The board must name NO ask for it in the v2 view the CLI reads (feedback[].answersAsks), and the coordinator's
// receipt must leave the ask open and its owner step waiting. A message that NAMES the ask (ask_id) or a
// choice/verdict on the step still answers — the rule of 956806d, kept. This guards the compat layer the client
// consumes (/api/state?v=2), not only the stored answers_asks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { s21Board, step } from './s21-helpers.mjs';

const NOTE = 'Em check file sheet nhé có feedback phía bên đấy trong sheet rồi';
const RECEIPT = 'Đổi: đã ghi nhận\nLịch: ngay\nBước tiếp: làm tiếp';
const fbOf = (st, text) => st.feedback.find(f => f.text === text);

test("a plain note on an ask's step names no ask; a receipt leaves the ask open and its step waiting", async () => {
  const s = await s21Board();
  try {
    s.w('task.create', 'ACME-01', { title: 'Sheet', lane: 'Workerb', order: 1, steps: [step('acme-b18', 'waiting', 'owner')] });
    const ask = s.w('ask.raise', 'ACME-01', { text: 'check the sheet?', step_id: 'acme-b18' }).id;
    // anh posts a plain note on the ask's step: it is about something else, not an answer.
    const note = s.ownerW('feedback.add', 'ACME-01', { kind: 'note', text: NOTE, step_id: 'acme-b18' });
    const seen = fbOf(await s.state(2), NOTE);
    assert.deepEqual(seen.answersAsks, [], 'the v2 view (what the CLI reads) names no ask for a plain note');
    assert.equal(s.board.state.feedback[note.id].answers_asks, undefined, 'and the record carries no answers_asks');
    assert.equal(s.board.state.asks[ask].status, 'open');

    // CoS receipts the note (the CLI's `receipt <fb>`): it closes the note, never the ask or its step.
    const r = await s.call('POST', '/api/admin/reply', { task: 'ACME-01', step: 'acme-b18', text: RECEIPT, replyTo: seen.id, kind: 'receipt' });
    assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.body));
    assert.equal(r.body.msgKind, 'receipt');
    assert.equal(s.board.state.asks[ask].status, 'open', 'the receipt closed no ask');
    assert.equal(s.board.state.steps['ACME-01/acme-b18'].state, 'waiting', 'the ask step still waits');
    const after = await s.state(2);
    assert.deepEqual(after.tasks.find(t => t.code === 'ACME-01').asks.map(a => a.id), [ask], 'the ask is still open on the board');
    assert.equal(fbOf(after, NOTE).status, 'done', 'the note itself is closed by the receipt');
  } finally { await s.close(); }
});

test('a choice on the step, or a note scoped to the ask, still answers (ask_id path kept)', async () => {
  const s = await s21Board();
  try {
    s.w('task.create', 'ACME-01', { title: 'Sheet', lane: 'Workerb', order: 1, steps: [step('acme-b18', 'waiting', 'owner'), step('acme-b19', 'waiting', 'owner')] });
    const onStep = s.w('ask.raise', 'ACME-01', { text: 'pick one', step_id: 'acme-b18' }).id;
    const scoped = s.w('ask.raise', 'ACME-01', { text: 'free text?', step_id: 'acme-b19' }).id;
    // a structured choice on the ask's step answers it, as before
    const choice = s.ownerW('feedback.add', 'ACME-01', { kind: 'choice', text: 'B', step_id: 'acme-b18' });
    assert.equal(s.board.state.asks[onStep].status, 'answered', 'a choice on the step answers the ask there');
    assert.deepEqual(fbOf(await s.state(2), 'B').answersAsks, [onStep], 'the v2 view names the answered ask');
    // a note that explicitly names the ask (the composer's "reply to this ask") answers exactly that ask
    const reply = s.ownerW('feedback.add', 'ACME-01', { kind: 'note', text: 'here is the sheet', step_id: 'acme-b19', ask_id: scoped });
    assert.equal(s.board.state.asks[scoped].status, 'answered', 'a note that names the ask answers it');
    assert.deepEqual(fbOf(await s.state(2), 'here is the sheet').answersAsks, [scoped]);
    assert.equal(s.board.state.feedback[choice.id].answers_asks.join(), onStep, 'the answer is journaled on the note/choice');
    assert.ok(reply.id);
  } finally { await s.close(); }
});
