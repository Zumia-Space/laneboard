// Ask ages and measured time from the board's raw records (public/measure.js, shared by src/views.mjs and the page).
// Owner 10-10: a re-asked question (edited text, images/links added, the 10-10 backfill) restarted at "1m"; a 3-day
// wait must stay 3 days and keep its red colour. And the page computes F-04's worked/waited itself, so the Zumi app's
// pinned page shows the fixed numbers while the live server still runs the old code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import '../public/measure.js';
import { createBoard } from '../src/board.mjs';
import { measuredTimes, ownerAttention } from '../src/views.mjs';
import { OWNER, tmpDir } from './helpers.mjs';

const { askSince } = globalThis.LaneMeasure;
const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const APP = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');
const H = 3600000, T0 = Date.parse('2026-10-07T22:35:04.857Z');
const iso = ms => new Date(ms).toISOString();
let n = 0;
const req = (op, target_id, data, extra = {}) => ({ version: 1, request_id: `ask-age-${process.pid}-${++n}`, op, target_id, data, ...extra });

// askSince, the chain rule (decided 10-11): an ask is the SAME ask as the one before it on the same owner step when the earlier one was
// cleared and the owner did not reply in between, whatever the text and whatever the gap. A step-less ask never chains. A new question
// after the owner replied (a message on the step or the ask, an answered ask) is a new wait.
const ask = (id, at, step, text, extra = {}) => ({ id, task_id: 'X-1', attribution: { created_at: iso(at) }, status: 'open', text, ...(step ? { step_id: step } : {}), ...extra });
const cleared = (a, at, note) => ({ ...a, status: 'cleared', cleared: { at: iso(at), ...(note ? { note } : {}) } });
const owner = (at, kind, scope = {}, extra = {}) => ({ id: `m-${at}`, task_id: 'X-1', kind, author: { role: 'owner', name: 'owner' }, ts: iso(at), scope, answers_ask_id: null, ...extra });

test('askSince: a re-ask on the same step keeps the first ask time, whatever the text and the gap', () => {
  const a1 = cleared(ask('a1', T0, 's1', 'Pick the smile (A, B or C).'), T0 + 6 * H), a2 = cleared(ask('a2', T0 + 6 * H + 9000, 's1', 'Totally rewritten question about the ring, with a link.'), T0 + 30 * H, 'row needsAnh changed'), a3 = ask('a3', T0 + 30 * H + 60 * 60000, 's1', 'Refreshed again an hour after the clear.');
  assert.equal(askSince(a2, [a1, a2]), iso(T0), 'a new text on the same step: the same ask');
  assert.equal(askSince(a3, [a1, a2, a3]), iso(T0), 'followed back to the first, with any gap in between (the 5-minute window is gone)');
  assert.equal(askSince(a3, [a1, a2, a3], []), iso(T0), 'no owner message at all: nothing resets the wait');
});

test('askSince: a new wait starts when the owner replied in between, or on another step, or with no step', () => {
  const a1 = cleared(ask('a1', T0, 's1', 'Q1'), T0 + 6 * H), a2 = ask('a2', T0 + 6 * H + 9000, 's1', 'Q2');
  const starts = (msgs, asks = [a1, a2]) => askSince(a2, asks, msgs) === iso(T0 + 6 * H + 9000);
  assert.equal(starts([]), false, 'no reply: the same ask');
  assert.equal(starts([owner(T0 + 2 * H, 'choice', { step_id: 's1' })]), true, 'an owner choice on the step');
  assert.equal(starts([owner(T0 + 2 * H, 'note', { step_id: 's1' })]), true, 'an owner note on the step');
  assert.equal(starts([owner(T0 + 2 * H, 'approve', { ask_id: 'a1' })]), true, 'an owner approval scoped to the ask');
  assert.equal(starts([owner(T0 + 2 * H, 'reject', {}, { answers_ask_id: 'a1' })]), true, 'a message that answers the ask');
  assert.equal(starts([owner(T0 + 2 * H, 'note', {})]), false, 'a note on the whole task is not a reply to this ask');
  assert.equal(starts([owner(T0 + 2 * H, 'note', { step_id: 's2' })]), false, 'a reply on another step does not count');
  assert.equal(starts([{ ...owner(T0 + 2 * H, 'note', { step_id: 's1' }), author: { role: 'coordinator' } }]), false, 'a coordinator message (a receipt, a reply) is not the owner replying');
  assert.equal(starts([owner(T0 - H, 'choice', { step_id: 's1' })]), false, 'a reply from before the earlier ask was raised belongs to an older question');
  assert.equal(starts([owner(T0 + 7 * H, 'choice', { step_id: 's1' })]), false, 'a reply after the new ask was raised does not rewrite its start');
  const answered = { ...ask('ans', T0 + 3 * H, 's1', 'Q1b'), status: 'answered', answer: { at: iso(T0 + 4 * H) } };
  assert.equal(starts([], [a1, answered, a2]), true, 'an ask on the step answered in between');
  // another step, no step, another task
  const b = ask('b', T0 + 6 * H + 9000, 's2', 'Q1');
  assert.equal(askSince(b, [a1, b], []), iso(T0 + 6 * H + 9000), 'the earlier ask sat on another step');
  const noStep = cleared(ask('n1', T0, null, 'Q1'), T0 + 6 * H), n2 = ask('n2', T0 + 6 * H + 9000, 's1', 'Q1');
  assert.equal(askSince(n2, [noStep, n2], []), iso(T0 + 6 * H + 9000), 'a step-less ask has no step to share: the backfilled word-for-word ask is a new wait');
  assert.equal(askSince({ ...n2, step_id: undefined }, [noStep, { ...n2, step_id: undefined }], []), iso(T0 + 6 * H + 9000), 'and a step-less ask never chains');
  const other = { ...cleared(ask('o1', T0 - 9 * H, 's1', 'Q1'), T0 + 6 * H - 10), task_id: 'F-04' };
  assert.equal(askSince(a2, [other, a2], []), iso(T0 + 6 * H + 9000), 'another task never counts');
  // an ask still open when the new one is raised is its own wait (both open)
  const stillOpen = ask('s0', T0, 's1', 'Q0');
  assert.equal(askSince(a2, [stillOpen, a2], []), iso(T0 + 6 * H + 9000));
  // an imported ask: its own waiting_since wins over its import time
  const f = ask('imp', T0 + 5 * H, 's1', 'Q', { waiting_since: iso(T0) });
  assert.equal(askSince(f, [f], []), iso(T0));
});

test('askSince on the live ACME-01 records (state 10-11): anh approved the carried-over question through the step-less ask-555, so ask-608 is a new wait', () => {
  // ask-23 on s5 (imported, waiting since 09-29) was cleared 10-01 15:18:58; 5 s later the step-less ask-555 carried the same question over;
  // anh approved it on 10-02 11:39:42 (fb-603, answers ask-555); 3 minutes later ask-608 re-raised it on s5. Before: 12 days, from 09-29.
  const acme = [
    { id: 'ask-23', task_id: 'ACME-01', step_id: 's5', status: 'cleared', waiting_since: '2026-09-29T12:49:26.230Z', attribution: { created_at: '2026-10-01T03:28:23.080Z' }, cleared: { at: '2026-10-01T15:18:58.714Z' }, text: 'Mở http://127.0.0.1:4310' },
    { id: 'ask-555', task_id: 'ACME-01', status: 'answered', attribution: { created_at: '2026-10-01T15:19:03.730Z' }, answer: { at: '2026-10-02T11:39:42.721Z' }, text: 'Mở http://127.0.0.1:4310' },
    { id: 'ask-608', task_id: 'ACME-01', step_id: 's5', status: 'open', attribution: { created_at: '2026-10-02T11:42:41.195Z' }, text: 'Mở http://127.0.0.1:4310' }
  ];
  const fb603 = { id: 'fb-603', task_id: 'ACME-01', kind: 'approve', author: { role: 'owner' }, ts: '2026-10-02T11:39:42.721Z', scope: { ask_id: 'ask-555' }, answers_ask_id: 'ask-555' };
  assert.equal(askSince(acme[2], acme, [fb603]), '2026-10-02T11:42:41.195Z', 'the answered step-less ask is a reply');
  assert.equal(askSince(acme[2], acme, []), '2026-10-02T11:42:41.195Z', 'the answered ask alone is enough (no message needed)');
  assert.equal(askSince(acme[2], [acme[0], { ...acme[1], status: 'cleared', cleared: { at: '2026-10-02T11:40:00.000Z' }, answer: undefined }, acme[2]], []), '2026-09-29T12:49:26.230Z', 'not answered: the chain still reaches the first ask');
  // an answered ask of another task never counts
  assert.equal(askSince(acme[2], [acme[0], { ...acme[1], task_id: 'F-04' }, acme[2]], []), '2026-09-29T12:49:26.230Z');
});

test('askSince: a step that left waiting (done, active, anything) between two asks starts a new wait', () => {
  const a1 = cleared(ask('a1', T0, 's1', 'Review the draft'), T0 + H), a2 = ask('a2', T0 + 10 * 24 * H, 's1', 'Review the second draft');
  const t = (...tr) => ({ 'X-1/s1': { transitions: tr.map(([at, from, to]) => ({ at: iso(at), from, to })) } });
  assert.equal(askSince(a2, [a1, a2], [], {}), iso(T0), 'no step history: the chain holds');
  assert.equal(askSince(a2, [a1, a2], [], t([T0 + H + 1000, 'waiting', 'done'], [T0 + 10 * 24 * H, 'done', 'waiting'])), iso(T0 + 10 * 24 * H), 'finished and reopened: a new wait');
  assert.equal(askSince(a2, [a1, a2], [], t([T0 + 5 * H, 'waiting', 'active'], [T0 + 6 * H, 'active', 'waiting'])), iso(T0 + 10 * 24 * H), 'any other state counts: the lane worked on it, then asked again');
  assert.equal(askSince(a2, [a1, a2], [], t([T0 - 2 * H, 'waiting', 'done'], [T0 - H, 'done', 'waiting'])), iso(T0), 'a blip from before the earlier ask was raised belongs to an older wait');
  assert.equal(askSince(a2, [a1, a2], [], t([T0 + H, 'todo', 'waiting'])), iso(T0), 'arriving at waiting is not leaving it');
  assert.equal(askSince(a2, [a1, a2], [], { 'X-1/s2': { transitions: [{ at: iso(T0 + 2 * H), from: 'waiting', to: 'done' }] } }), iso(T0), 'another step is not this one');
});

test('askSince on the live ACME-02 and F-04 records (state 10-11): ACME-02 10-10 11:40 stays a new ask on its new step; F-04 16:40 is the same ask now', () => {
  // ACME-02: 1432 (step-less, 10-08 22:35, cleared 10-10 11:40:36) and 8 s later 1499 on a NEW owner step with new text. 5341459: new ask.
  const t31 = [
    { id: 'ask-1432', task_id: 'ACME-02', status: 'cleared', attribution: { created_at: '2026-10-08T22:35:04.857Z' }, cleared: { at: '2026-10-10T11:40:36.173Z' }, text: 'Sáng mai: duyệt gói buổi sáng' },
    { id: 'ask-1499', task_id: 'ACME-02', step_id: 'ask-10101140', status: 'cleared', attribution: { created_at: '2026-10-10T11:40:44.232Z' }, cleared: { at: '2026-10-10T17:54:16.228Z', note: 'row needsAnh changed' }, text: 'Mở Zumi dùng thử' },
    { id: 'ask-1543', task_id: 'ACME-02', step_id: 'ask-10101140', status: 'open', attribution: { created_at: '2026-10-10T17:54:16.228Z' }, text: 'Zumi đã lên bản mới 3c32735' }
  ];
  assert.equal(askSince(t31[1], t31, []), '2026-10-10T11:40:44.232Z', 'ACME-02: the new question on the new step is a new wait, not counted from 10-08');
  assert.equal(askSince(t31[2], t31, []), '2026-10-10T11:40:44.232Z', 'its refreshed text on the same step keeps that age');
  // F-04: 1495 on real-models (10-10 11:40:26, cleared 16:40:43), 1532 on real-models 7 s later with a NEW text. 5341459 called it a new ask;
  // under the 10-11 rule it is the same ask unless the owner replied on the step in between.
  const f04 = [
    { id: 'ask-1495', task_id: 'F-04', step_id: 'real-models', status: 'cleared', attribution: { created_at: '2026-10-10T11:40:26.860Z' }, cleared: { at: '2026-10-10T16:40:43.000Z' }, text: 'Model thật cho 6 nhân vật' },
    { id: 'ask-1532', task_id: 'F-04', step_id: 'real-models', status: 'open', attribution: { created_at: '2026-10-10T16:40:50.000Z' }, text: 'Xem lại các trang tổng hợp model' }
  ];
  assert.equal(askSince(f04[1], f04, []), '2026-10-10T11:40:26.860Z');
  const reply = { id: 'm1', task_id: 'F-04', kind: 'choice', author: { role: 'owner' }, ts: '2026-10-10T15:00:00.000Z', scope: { step_id: 'real-models' }, answers_ask_id: 'ask-1495' };
  assert.equal(askSince(f04[1], f04, [reply]), '2026-10-10T16:40:50.000Z', 'with an owner reply on the step in between it is a new wait');
});

test('owner attention: a re-asked question keeps its age (3 days stays red), on the server and in the page', () => {
  let clock = T0;
  const b = createBoard({ dataDir: tmpDir(), ownerToken: OWNER, now: () => clock });
  const coord = b.write(OWNER, req('token.issue', 'coordinator', { role: 'coordinator' })).token;
  b.write(coord, req('task.create', 'ACME-02', { title: 'Zumi', steps: [{ id: 's1', label: 'build', zone: 'build', state: 'done' }, { id: 'ask-1', label: 'try it', zone: 'owner', state: 'waiting' }] }));
  const first = b.write(coord, req('ask.raise', 'ACME-02', { text: 'Try Zumi', step_id: 'ask-1' }));
  clock += 3 * 24 * H; // three days later the coordinator adds a link: clear + raise the same question
  b.write(coord, req('ask.clear', first.id, {}, { expected_revision: 1 }));
  clock += 15000;
  b.write(coord, req('ask.raise', 'ACME-02', { text: 'Try Zumi\n`D:/data/laneboard/acme-02/QC-CUOI-ANH.md`', step_id: 'ask-1' }));
  const nowMs = clock + 60000, w = ownerAttention(b.state, nowMs).waiting.filter(x => x.kind === 'ask');
  assert.equal(w.length, 1);
  assert.equal(w[0].since, iso(T0));
  assert.ok(w[0].age_ms > 72 * H, 'over three days: the red tone');

  // The page, reading a view whose server still says "15 s" (760501b sends the new ask's created_at): withAskAges fixes it.
  const view = { now: iso(nowMs), asks: Object.values(b.state.asks), attention: { waiting: [{ ...w[0], since: Object.values(b.state.asks).at(-1).attribution.created_at, age_ms: 75000 }] } };
  const lift = name => { const s = APP.indexOf(`function ${name}(`); assert.ok(s >= 0, `app.js has no ${name}`); return APP.slice(s, APP.indexOf('\n}\n', s) + 2); };
  const ctx = vm.createContext({ LM: globalThis.LaneMeasure });
  vm.runInContext(lift('withAskAges'), ctx);
  const out = vm.runInContext(`withAskAges(${JSON.stringify(view)})`, ctx).attention.waiting[0];
  assert.equal(out.since, iso(T0));
  assert.ok(out.age_ms > 72 * H);
  b.close();
});

test('page and server compute the same measured time from the same records (one module), and the page loads it', () => {
  let clock = T0;
  const b = createBoard({ dataDir: tmpDir(), ownerToken: OWNER, now: () => clock });
  const coord = b.write(OWNER, req('token.issue', 'coordinator', { role: 'coordinator' })).token;
  const step = (id, state) => { const s = b.state.steps[`F-4/${id}`]; b.write(coord, req('step.update', s.id, { state }, { expected_revision: s.rev })); };
  b.write(coord, req('task.create', 'F-4', { title: 'Homepage', steps: [{ id: 'build', label: 'b', zone: 'build', state: 'active' }, { id: 'lock', label: 'l', zone: 'owner', state: 'todo' }, { id: 'pick', label: 'p', zone: 'owner', state: 'todo' }] }));
  clock += 10 * H; step('build', 'done'); step('lock', 'waiting'); step('pick', 'waiting');
  clock += 140 * H; step('lock', 'done');
  const nowMs = clock + 3 * H;
  const server = measuredTimes(b.state, 'F-4', nowMs);
  const view = b.view(OWNER), task = view.tasks.find(t => t.id === 'F-4');
  const page = globalThis.LaneMeasure.measuredTimes({ times: view.times, taskTimes: view.task_times, steps: task.steps, taskId: 'F-4', nowMs });
  assert.deepEqual(page, server);
  assert.deepEqual(server, { started_at: iso(T0), work_ms: 10 * H, wait_ms: 143 * H });
  // app.js computes it from the view (not the server's `measured`), and index.html loads measure.js before app.js
  assert.match(APP, /function measured\(task\) \{[^}]*LM\.measuredTimes\(\{ times: S\.data\.times/);
  const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  assert.ok(html.indexOf('src="measure.js"') > 0 && html.indexOf('src="measure.js"') < html.indexOf('src="app.js"'));
  assert.doesNotMatch(APP, /a\.waiting_since \|\| a\.attribution\.created_at/, 'every ask age in the page goes through askSince');
  b.close();
});
