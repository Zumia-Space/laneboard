// One message stream per task: every owner/coordinator record is a message with a kind and a scope (task, step or
// ask); an owner message scoped to an open ask closes it, "Hỏi lại" keeps it open; the coordinator owes a receipt
// ("Nhận": Đổi / Lịch / Bước tiếp) for an owner answer, and an answer left without one comes back to the owner after 3 h.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startSeeded, OWNER } from './helpers.mjs';
import { ownerAttention, messagesView, RECEIPT_MS } from '../src/views.mjs';

const ok = r => { assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
const RECEIPT = 'Đổi: bước 7-9 làm lại theo hướng mới\nLịch: live 02-10 → 04-10\nBước tiếp: 7';

test('a message scoped to an ask answers that ask only, whatever its kind (Ghi chú, Đổi hướng, Duyệt…)', async () => {
  const s = await startSeeded();
  try {
    const a1 = ok(await s.write(s.coord, 'ask.raise', 'WEB-3', { text: 'Hero?', step_id: 's3' }));
    // s21: one open ask per (task, lane, step), so the second ask on the same step is another lane's.
    ok(await s.write(s.coord, 'task.create', 'LB-1', { title: 'Beta lane task', lane: 'lane-beta' }));
    const a2 = ok(await s.write(s.coord, 'ask.raise', 'WEB-3', { text: 'Also the footer?', step_id: 's3', lane: 'lane-beta' }));
    const m = ok(await s.write(OWNER, 'feedback.add', 'WEB-3', { kind: 'redirect', text: 'Đổi sang ảnh minh hoạ', step_id: 's3', ask_id: a1.id }));
    const st = s.board.state;
    assert.equal(st.asks[a1.id].status, 'answered');
    assert.deepEqual([st.asks[a1.id].answer.kind, st.asks[a1.id].answer.feedback_id], ['redirect', m.id]);
    assert.equal(st.asks[a2.id].status, 'open', 'scoped: the other ask on the same step stays');
    const msg = messagesView(st).find(x => x.id === m.id);
    assert.deepEqual([msg.kind, msg.scope, msg.answers_ask_id, msg.author.role, msg.needs_receipt], ['redirect', { step_id: 's3', ask_id: a1.id }, a1.id, 'owner', true]);
    // the scope must belong to the task (and the step)
    assert.equal((await s.write(OWNER, 'feedback.add', 'API-2', { kind: 'note', text: 'x', ask_id: a2.id })).body.error, 'ask_not_found');
    assert.equal((await s.write(OWNER, 'feedback.add', 'WEB-3', { kind: 'note', text: 'x', step_id: 's2', ask_id: a2.id })).body.error, 'ask_not_on_step');
    assert.equal((await s.write(s.coord, 'feedback.add', 'WEB-3', { kind: 'redirect', text: 'x' })).status, 403, 'Đổi hướng is the owner\'s');
  } finally { await s.close(); }
});

test('"Hỏi lại" keeps the ask open and marks it asked back; the next answer closes it', async () => {
  const s = await startSeeded();
  try {
    const a = ok(await s.write(s.coord, 'ask.raise', 'WEB-3', { text: 'Hero?', step_id: 's3' }));
    const q = ok(await s.write(OWNER, 'feedback.add', 'WEB-3', { kind: 'askback', text: 'Ảnh nào rẻ hơn?', ask_id: a.id }));
    let st = await s.state(OWNER);
    const w = st.attention.waiting.find(x => x.id === a.id);
    assert.ok(w && w.asked_back_at, 'still waiting, marked asked back');
    assert.equal(st.messages.find(x => x.id === q.id).answers_ask_id, null);
    ok(await s.write(OWNER, 'feedback.add', 'WEB-3', { kind: 'approve', text: 'ok ảnh A', ask_id: a.id }));
    st = await s.state(OWNER);
    assert.ok(!st.attention.waiting.some(x => x.id === a.id));
    assert.ok(st.attention.answered.some(x => x.id === a.id && x.kind === 'approve'));
  } finally { await s.close(); }
});

test('receipt: coordinator-only, on an owner message, with the three lines; it is recorded on that message and closes it', async () => {
  const s = await startSeeded();
  try {
    const a = ok(await s.write(s.coord, 'ask.raise', 'WEB-3', { text: 'Hero?', step_id: 's3' }));
    const m = ok(await s.write(OWNER, 'feedback.add', 'WEB-3', { kind: 'note', text: 'QC ok nhưng đổi màu', ask_id: a.id }));
    const coordNote = ok(await s.write(s.coord, 'feedback.add', 'WEB-3', { kind: 'reply', text: 'đang làm', reply_to: m.id }));
    assert.equal((await s.write(OWNER, 'feedback.add', 'WEB-3', { kind: 'receipt', text: RECEIPT, reply_to: m.id })).status, 403);
    assert.equal((await s.write(s.coord, 'feedback.add', 'WEB-3', { kind: 'receipt', text: 'Đổi: x\nBước tiếp: 7', reply_to: m.id })).body.error, 'receipt_lines_required');
    assert.equal((await s.write(s.coord, 'feedback.add', 'WEB-3', { kind: 'receipt', text: RECEIPT, reply_to: coordNote.id })).body.error, 'receipt_needs_owner_message');
    const r = ok(await s.write(s.coord, 'feedback.add', 'WEB-3', { kind: 'receipt', text: RECEIPT, reply_to: m.id }));
    const st = await s.state(OWNER);
    const owner = st.messages.find(x => x.id === m.id), rec = st.messages.find(x => x.id === r.id);
    assert.equal(owner.received.receipt_id, r.id);
    assert.equal(owner.status, 'resolved');
    assert.equal(owner.needs_receipt, false);
    assert.deepEqual(rec.receipt, { change: 'bước 7-9 làm lại theo hướng mới', schedule: 'live 02-10 → 04-10', next: '7' });
    assert.equal(rec.reply_to, m.id);
    const ans = st.attention.answered.find(x => x.id === a.id);
    assert.deepEqual([ans.feedback_id, !!ans.received_at, ans.next], [m.id, true, '7']);
  } finally { await s.close(); }
});

test('an owner answer with no receipt comes back to the owner after 3 h; a receipt or a resolve takes it away', async () => {
  const s = await startSeeded();
  try {
    const a = ok(await s.write(s.coord, 'ask.raise', 'WEB-3', { text: 'Hero?', step_id: 's3' }));
    const m = ok(await s.write(OWNER, 'feedback.add', 'WEB-3', { kind: 'note', text: 'QC xong', ask_id: a.id }));
    const plain = ok(await s.write(OWNER, 'feedback.add', 'API-2', { kind: 'note', text: 'just a thought' }));
    const redirect = ok(await s.write(OWNER, 'feedback.add', 'API-2', { kind: 'redirect', text: 'đổi hướng' }));
    const at = Date.parse(s.board.state.feedback[m.id].attribution.created_at);
    const unreceived = nowMs => ownerAttention(s.board.state, nowMs).waiting.filter(w => w.kind === 'unreceived').map(w => w.id);
    assert.deepEqual(unreceived(at + RECEIPT_MS - 1000), [], 'not before 3 h');
    assert.deepEqual(unreceived(at + RECEIPT_MS + 1000).sort(), [m.id, redirect.id].sort(), 'an answer and a change of direction, not a plain note');
    assert.ok(!unreceived(at + RECEIPT_MS + 1000).includes(plain.id));
    ok(await s.write(s.coord, 'feedback.add', 'WEB-3', { kind: 'receipt', text: RECEIPT, reply_to: m.id }));
    ok(await s.write(s.coord, 'feedback.resolve', redirect.id, {}, { expected_revision: s.board.state.feedback[redirect.id].rev }));
    assert.deepEqual(unreceived(at + RECEIPT_MS + 1000), []);
  } finally { await s.close(); }
});

test('messages: every feedback record (old ones too) reads as a message; ask.answer answers are linked to their ask', async () => {
  const s = await startSeeded();
  try {
    const a = ok(await s.write(s.coord, 'ask.raise', 'WEB-3', { text: 'Ship?', options: [{ key: 'A', label: 'Yes' }] }));
    ok(await s.write(OWNER, 'ask.answer', a.id, { choice: 'A' }, { expected_revision: 1 }));
    ok(await s.write(s.coord, 'feedback.add', 'WEB-3', { kind: 'reply', text: 'ok' }));
    const st = await s.state(OWNER);
    assert.equal(st.messages.length, st.feedback.length);
    const ans = st.messages.find(x => x.answers_ask_id === a.id);
    assert.deepEqual([ans.kind, ans.author.role, ans.needs_receipt], ['choice', 'owner', true]);
    assert.ok(st.messages.every((x, i, arr) => !i || arr[i - 1].ts <= x.ts), 'chronological');
  } finally { await s.close(); }
});
