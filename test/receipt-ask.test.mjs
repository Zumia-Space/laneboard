// J-05 15-10 (fb-2707 on L-01-3D/pacing-route, fb-2709 on H-03/muse-handoff): an owner NOTE about something else on a step
// that holds an ask closed that ask, and the coordinator's receipt then closed the row's step too. A plain note, scoped to a
// step or the task, answers nothing; the ask closes only when the owner names it (ask_id, the answer button) or sends a
// verdict kind (approve / reject / choice) on its step/task. A receipt closes the NOTE and never an ask.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startSeeded, OWNER } from './helpers.mjs';

const ok = r => { assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
const ask = (s, id) => s.board.state.asks[id];
const RECEIPT = 'Đổi: đã ghi nhận\nLịch: ngay\nBước tiếp: làm tiếp';

test('a plain note on the ask\'s step (about something else) answers no ask, and its receipt closes the note only', async () => {
  const s = await startSeeded();
  try {
    const a = ok(await s.write(s.coord, 'ask.raise', 'WEB-3', { text: 'Pick the hero', step_id: 's3' }));
    const taskAsk = ok(await s.write(s.coord, 'ask.raise', 'WEB-3', { text: 'QC the build?' }));
    const note = ok(await s.write(OWNER, 'feedback.add', 'WEB-3', { kind: 'note', text: 'do we need more assets?', step_id: 's3' }));
    assert.equal(ask(s, a.id).status, 'open', 'the note did not answer the step ask');
    assert.equal(ask(s, taskAsk.id).status, 'open', 'nor the task-level ask');
    assert.equal(s.board.state.feedback[note.id].answers_asks, undefined);
    ok(await s.write(s.coord, 'feedback.add', 'WEB-3', { kind: 'receipt', text: RECEIPT, reply_to: note.id, step_id: 's3' }));
    assert.equal(s.board.state.feedback[note.id].status, 'resolved', 'the receipt closes the note');
    assert.equal(ask(s, a.id).status, 'open', 'the receipt closed no ask');
    assert.equal(ask(s, taskAsk.id).status, 'open');
    const st = await s.state(OWNER);
    assert.ok(st.attention.waiting.some(w => w.id === a.id), 'the ask still waits on the owner');
    assert.equal(st.feedback.find(f => f.id === note.id).answers_ask_id ?? null, null);
  } finally { await s.close(); }
});

test('a note scoped to the ask (ask_id, the composer\'s "reply to this ask") answers that ask only; its receipt changes nothing more', async () => {
  const s = await startSeeded();
  try {
    const a = ok(await s.write(s.coord, 'ask.raise', 'WEB-3', { text: 'Pick the hero', step_id: 's3' }));
    const other = ok(await s.write(s.coord, 'ask.raise', 'WEB-3', { text: 'QC the build?' }));
    const note = ok(await s.write(OWNER, 'feedback.add', 'WEB-3', { kind: 'note', text: 'photo', step_id: 's3', ask_id: a.id }));
    assert.equal(ask(s, a.id).status, 'answered');
    assert.equal(ask(s, a.id).answer.feedback_id, note.id);
    assert.equal(ask(s, other.id).status, 'open');
    assert.deepEqual(s.board.state.feedback[note.id].answers_asks, [a.id]);
  } finally { await s.close(); }
});

test('verdict kinds (approve / reject / choice) on a step or the task still answer the asks there; redirect does not unless scoped', async () => {
  const s = await startSeeded();
  try {
    const onStep = ok(await s.write(s.coord, 'ask.raise', 'WEB-3', { text: 'Pick the hero', step_id: 's3', options: [{ key: 'A', label: 'Photo' }] }));
    ok(await s.write(OWNER, 'feedback.add', 'WEB-3', { kind: 'redirect', text: 'go another way', step_id: 's3' }));
    assert.equal(ask(s, onStep.id).status, 'open', 'an unscoped redirect is a change of direction, not an answer');
    ok(await s.write(OWNER, 'feedback.add', 'WEB-3', { kind: 'choice', text: 'A', step_id: 's3' }));
    assert.equal(ask(s, onStep.id).status, 'answered', 'a choice on the ask\'s step answers it');
    const t = ok(await s.write(s.coord, 'ask.raise', 'API-2', { text: 'Ship?' }));
    ok(await s.write(OWNER, 'feedback.add', 'API-2', { kind: 'approve', text: 'ok' }));
    assert.equal(ask(s, t.id).status, 'answered', 'approve on the task answers its step-less ask');
    const r = ok(await s.write(s.coord, 'ask.raise', 'API-2', { text: 'Again?' }));
    ok(await s.write(OWNER, 'feedback.add', 'API-2', { kind: 'redirect', text: 'x', ask_id: r.id }));
    assert.equal(ask(s, r.id).status, 'answered', 'a redirect scoped to the ask answers it');
  } finally { await s.close(); }
});

// ---- Sol condition 1 (SOL-ANSWER.md): each reply control of an ask sends ask_id, so the narrower rule loses no real answer ----
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
const APP = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'app.js'), 'utf8');
const lift = name => { // a top-level `const name = ...;` line or `function name(...) {...}` / `async function` block of app.js, verbatim
  const line = APP.match(new RegExp(`^const ${name} = .*;$`, 'm'));
  if (line) return line[0];
  let start = APP.indexOf(`async function ${name}(`); if (start < 0) start = APP.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `app.js has no ${name}`);
  return APP.slice(start, APP.indexOf('\n}\n', start) + 2);
};

test('UI: the composer scoped to an ask (the "reply" link of an ask card) sends ask_id; scoped to a step or the task it sends none; an ask card button writes ask.answer', async () => {
  const writes = [];
  const ctx = vm.createContext({
    S: { dict: {}, en: {}, compose: {}, composeFiles: {}, hl: {}, data: { tasks: [{ id: 'T-1', steps: [{ id: 'T-1/s2' }] }], asks: [{ id: 'ask-7', task_id: 'T-1', status: 'open', text: 'QC?', step_id: 's2' }] } },
    isOwner: () => true, store: { get: () => '', set() {} }, toast() {}, refresh: async () => {}, uploadImage: async () => null, URL: { revokeObjectURL() {} },
    write: async (op, target, data) => { writes.push({ op, target, data }); return { ok: true }; }
  });
  vm.runInContext(['t', 'OWNER_KINDS', 'asksOf', 'compose', 'saveDraft', 'focusAsk', 'sendCompose'].map(lift).join('\n'), ctx);
  const send = async (setup, text) => { writes.length = 0; vm.runInContext(setup + `; compose('T-1').text = ${JSON.stringify(text)}`, ctx); await vm.runInContext(`sendCompose('T-1')`, ctx); return writes.find(w => w.op === 'feedback.add').data; };
  const onAsk = await send(`focusAsk('T-1', 'ask-7')`, 'a free-text answer');
  assert.equal(onAsk.ask_id, 'ask-7');
  assert.equal(onAsk.kind, 'note');
  assert.equal(onAsk.step_id, 's2', 'the ask\'s step rides along');
  const onStep = await send(`compose('T-1').scope = 'step:s2'`, 'about something else');
  assert.equal(onStep.ask_id, undefined, 'a step scope names no ask');
  const onTask = await send(`compose('T-1').scope = ''`, 'task note');
  assert.equal(onTask.ask_id, undefined);
  // the card's buttons: the page writes ask.answer on the ask itself (the op links the feedback it creates through ask_id)
  assert.match(APP, /write\('ask\.answer', askId, data, askRev\)/);
  assert.match(APP, /if \(action === 'reply-ask'\) \{ focusAsk\(b\.dataset\.task, b\.dataset\.ask\)/, 'the reply link scopes the composer to the ask');
  assert.match(APP, /\?ask=' \+ encodeURIComponent\(w\.id\)/, 'an ask card links to its task with ?ask=<id>');
  assert.match(APP, /if \(r\.ask\) focusAsk\(r\.id, r\.ask\)/, 'opening that link scopes the composer to the ask');
});

test('server: an unlinked note or redirect closes no ask even when exactly ONE ask is open (no singleton exception); ask_id closes only the named ask', async () => {
  const s = await startSeeded();
  try {
    const only = ok(await s.write(s.coord, 'ask.raise', 'WEB-3', { text: 'Pick the hero', step_id: 's3' }));
    ok(await s.write(OWNER, 'feedback.add', 'WEB-3', { kind: 'note', text: 'unrelated', step_id: 's3' }));
    ok(await s.write(OWNER, 'feedback.add', 'WEB-3', { kind: 'redirect', text: 'unrelated', step_id: 's3' }));
    ok(await s.write(OWNER, 'feedback.add', 'WEB-3', { kind: 'note', text: 'task level' }));
    assert.equal(ask(s, only.id).status, 'open', 'the only open ask stays open');
    const two = ok(await s.write(s.coord, 'ask.raise', 'WEB-3', { text: 'Second', step_id: 's2' }));
    const n = ok(await s.write(OWNER, 'feedback.add', 'WEB-3', { kind: 'note', text: 'answer', step_id: 's3', ask_id: only.id }));
    assert.equal(ask(s, only.id).status, 'answered');
    assert.equal(ask(s, two.id).status, 'open', 'only the named ask closes');
    assert.deepEqual(s.board.state.feedback[n.id].answers_asks, [only.id]);
  } finally { await s.close(); }
});
