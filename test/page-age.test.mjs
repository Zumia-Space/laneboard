// The task page ages a wait with the same rule as the rail and /state askAt (public/measure.js rowWaitSince). Regression for 10-11:
// W-41's step row read 4.8 days (its own old wait) under a question filed that day, and the situation-card line ignored waiting
// owner steps that have no ask on them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import '../public/measure.js';
import { createBoard } from '../src/board.mjs';
import { OWNER, tmpDir } from './helpers.mjs';

const LM = globalThis.LaneMeasure;
const APP = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'app.js'), 'utf8');
const H = 3600000, T0 = Date.parse('2026-10-06T17:52:22.000Z');
let n = 0;
const req = (op, target_id, data, extra = {}) => ({ version: 1, request_id: `page-age-${process.pid}-${++n}`, op, target_id, data, ...extra });
const lift = name => { const s = APP.indexOf(`function ${name}(`); assert.ok(s >= 0, `app.js has no ${name}`); return APP.slice(s, APP.indexOf('\n}\n', s) + 2); };

/** A board with the page's own functions (lifted from app.js) running on its view, "now" = nowMs; durations come back as whole hours. */
function pageOn(board, nowMs) {
  const view = board.view(OWNER);
  const S = { data: { ...view, now: new Date(nowMs).toISOString() }, loadedAt: Date.now() };
  const ctx = vm.createContext({ LM, S, serverNow: () => nowMs, t: (key, p) => (p ? `${key}:${p.n ?? ''}:${p.dur ?? ''}` : key), fmtDur: ms => `${Math.round(ms / H)}h`, fmtTime: x => x });
  vm.runInContext(`const askSinceOf = a => LM.askSince(a, S.data.asks || []);\nconst asksOf = taskId => (S.data.asks || []).filter(a => a.task_id === taskId);\nconst msgsOf = () => [];\n${lift('stepTime')}\n${lift('needsOwnerLine')}`, ctx);
  const task = id => view.tasks.find(x => x.id === id);
  return {
    stepRow: (taskId, stepId) => vm.runInContext(`stepTime(${JSON.stringify(task(taskId))}, ${JSON.stringify(task(taskId).steps.find(s => s.id === `${taskId}/${stepId}` || s.id === stepId))})`, ctx),
    line: taskId => vm.runInContext(`needsOwnerLine(${JSON.stringify(task(taskId))})`, ctx),
    rail: taskId => nowMs - Date.parse(LM.needRows(view.attention.waiting).find(r => r.task_id === taskId).since),   // the rail entry's age at the page's "now"
    view
  };
}

function boardWith(setup) {
  let clock = T0;
  const b = createBoard({ dataDir: tmpDir(), ownerToken: OWNER, now: () => clock });
  const coord = b.write(OWNER, req('token.issue', 'coordinator', { role: 'coordinator' })).token;
  const w = (op, target, data, extra) => b.write(coord, req(op, target, data, extra));
  setup({ b, w, at: ms => { clock = ms; } });
  return b;
}

test('a step an open ask sits on shows the ask age, not its own older wait (W-41 10-11: 4.8 days)', () => {
  const b = boardWith(({ w, at }) => {
    w('task.create', 'W-1', { title: 'W-41', steps: [{ id: 'plan', label: 'Close W-41', zone: 'owner', state: 'waiting' }] });   // waits since T0
    at(T0 + 5 * 24 * H); w('ask.raise', 'W-1', { text: 'Close it?', step_id: 'plan' });
  });
  const page = pageOn(b, T0 + 5 * 24 * H + 3 * H);
  assert.equal(page.stepRow('W-1', 'plan'), 'time.waiting::3h', 'the step row counts from the ask (3 h), not from the step (123 h)');
  assert.equal(page.line('W-1'), 'situation.asks:1:3h');
  assert.equal(page.rail('W-1'), 3 * H, 'the rail says the same');
  b.close();
});

test('a waiting owner step with no ask on it counts in the situation line; the row age is the oldest item (the rail rule)', () => {
  const b = boardWith(({ w, at }) => {
    w('task.create', 'C-1', { title: 'C', steps: [{ id: 'o1', label: 'A/B/C', zone: 'owner', state: 'waiting' }, { id: 'o2', label: 'camera', zone: 'owner', state: 'waiting' }] });   // both wait since T0
    at(T0 + 2 * 24 * H); w('ask.raise', 'C-1', { text: 'Pick the camera?', step_id: 'o2' });                                                                       // an ask on o2 only
    w('task.create', 'N-1', { title: 'N', steps: [{ id: 'p1', label: 'plain wait', zone: 'owner', state: 'waiting' }] });
  });
  const now = T0 + 2 * 24 * H + 5 * H, page = pageOn(b, now);
  assert.equal(page.line('C-1'), 'situation.asks:2:53h', 'o1 (no ask) from T0 = 53 h, the ask on o2 from its own time: the oldest of the two, 2 items');
  assert.equal(page.rail('C-1'), 53 * H);
  assert.equal(page.stepRow('C-1', 'o1'), 'time.waiting::53h');
  assert.equal(page.stepRow('C-1', 'o2'), 'time.waiting::5h', 'o2 is covered by the ask');
  assert.equal(page.line('N-1'), 'situation.asks:1:5h', 'a waiting owner step with no ask at all is still a wait');
  assert.equal(page.rail('N-1'), 5 * H);
  b.close();
});

test('the page uses the shared rule, with no copy of it', () => {
  assert.match(APP, /LM\.rowWaits\(/); assert.match(APP, /LM\.rowWaitSince\(items\)/);
  assert.doesNotMatch(APP, /\[tr\.waiting_since, askSinceOf\(ask\)\]/, 'the step row no longer takes the older of the step and the ask');
});
