// turn.report (J-05 + ACME-02, spec v2 + Sol's gate): a lane finished a turn. The server builds the quick report inside the write;
// the detail lives in the same event. These tests are Sol's minimum list (numbers in the titles) plus the owner override that
// keeps quick.speech.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, startSeeded, OWNER, rid, tmpDir } from './helpers.mjs';
import { createBoard } from '../src/board.mjs';
import { loadSchemas, validate } from '../src/validate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schemas = loadSchemas(path.join(ROOT, 'schema', 'v1'));
const T0 = Date.parse('2026-10-14T11:42:00.000Z'); // 18:42 in Ho Chi Minh City

const report = (s, token, lane, turn_id, detail = '# Xong\nĐã làm phần A.', extra = {}) => s.write(token, 'turn.report', lane, { turn_id, detail, ...extra });
const turns = (s, token, lane, q = '') => s.call(token, 'GET', `/api/v1/turns?lane=${encodeURIComponent(lane)}${q}`);
const journal = s => fs.readFileSync(path.join(s.dataDir, 'events.ndjson'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const lineCount = s => journal(s).length;

/** Seeded board + a task of lane-alpha with N owner steps, so asks can be raised on them. */
async function withAsks(s, n, { lane = 'lane-alpha', text = i => `Câu hỏi số ${i}` } = {}) {
  const ids = [];
  for (let i = 1; i <= n; i++) {
    const code = `ASK-${i}`;
    assert.equal((await s.write(s.coord, 'task.create', code, { title: `Task ${i}`, lane, steps: [{ id: 's1', label: `Việc ${i}`, zone: 'owner', state: 'waiting' }] })).status, 200);
    const r = await s.write(s.coord, 'ask.raise', code, { text: text(i), step_id: 's1' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    ids.push(r.body.id);
  }
  return ids;
}

test('1: a report is accepted, the server writes the quick report, and it is stored with the event', async () => {
  const s = await startSeeded({ now: () => T0 });
  try {
    const [ask] = await withAsks(s, 1, { text: () => 'Chọn   ghế\nnào?' });
    const r = await report(s, OWNER, 'lane-alpha', 'turn-0001', '# Báo cáo\nNội dung đầy đủ.');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(r.body.id, /^turn-\d+$/);
    const q = r.body.quick;
    assert.deepEqual(Object.keys(q).sort(), ['asks', 'changed', 'line', 'speech']);
    assert.deepEqual(q.asks, [{ id: ask, task: 'ASK-1', step_id: 's1', text: 'Chọn ghế nào?' }]);
    assert.deepEqual(q.changed, []);
    assert.equal(q.line, `lane-alpha xong 1 lượt (18:42)\nChờ anh 1 việc: ASK-1 Việc 1 (${ask})`);
    const ev = journal(s).at(-1);
    assert.equal(ev.op, 'turn.report');
    assert.deepEqual(ev.data.quick, q, 'the quick report is journaled with the event, never recomputed');
    assert.equal(ev.data.detail, '# Báo cáo\nNội dung đầy đủ.');
    assert.equal(ev.data.session, undefined, 'no session on the server');
    assert.deepEqual(validate(schemas, 'event.json', ev), []);
    const stored = s.board.state.turn_history['lane-alpha'][0];
    assert.deepEqual(stored, { seq: r.body.seq, at: ev.at, turn_id: 'turn-0001', quick: q, detail: ev.data.detail });
  } finally { await s.close(); }
});

test('1b: no asks and nothing changed: one line; the time is the event time on the Vietnam clock', async () => {
  const s = await startSeeded({ now: () => T0 });
  try {
    const r = await report(s, OWNER, 'lane-alpha', 'turn-0001');
    assert.equal(r.body.quick.line, 'lane-alpha xong 1 lượt (18:42)');
    assert.equal(r.body.quick.speech, 'lane-alpha vừa xong một lượt.');
    assert.equal(journal(s).at(-1).at, '2026-10-14T11:42:00.000Z');
  } finally { await s.close(); }
});

test('2: a client cannot send quick (or lane, or session): 400 invalid_data, nothing journaled', async () => {
  const s = await startSeeded();
  try {
    const before = lineCount(s);
    for (const extra of [{ quick: { line: 'x', asks: [], changed: [] } }, { lane: 'lane-alpha' }, { session: 'abc' }]) {
      const r = await report(s, OWNER, 'lane-alpha', 'turn-0001', 'x', extra);
      assert.equal(r.status, 400, JSON.stringify(extra));
      assert.equal(r.body.error, 'invalid_data');
      assert.match(JSON.stringify(r.body.errors), /is not allowed/);
    }
    assert.equal(lineCount(s), before);
  } finally { await s.close(); }
});

test('3: the same lane and turn_id: 409 duplicate_turn with the original seq and quick, nothing journaled', async () => {
  const s = await startSeeded();
  try {
    await withAsks(s, 1);
    const first = await report(s, OWNER, 'lane-alpha', 'turn-0001');
    const again = await report(s, OWNER, 'LANE-ALPHA', 'turn-0001', 'a different text, same key');
    assert.equal(again.status, 409);
    assert.equal(again.body.error, 'duplicate_turn');
    assert.equal(again.body.seq, first.body.seq);
    assert.deepEqual(again.body.quick, first.body.quick);
    assert.equal(s.board.state.turn_history['lane-alpha'].length, 1);
    assert.equal(journal(s).filter(e => e.op === 'turn.report').length, 1);
  } finally { await s.close(); }
});

test('4: the same turn_id from another lane is a different turn', async () => {
  const s = await startSeeded();
  try {
    assert.equal((await report(s, OWNER, 'lane-alpha', 'same-key')).status, 200);
    const r = await report(s, OWNER, 'lane-beta', 'same-key');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const ib0 = (await s.write(OWNER, 'token.issue', 'inner-beta', { role: 'reporter', lane: 'lane-beta', scope_tasks: ['*'] })).body.token; // a lane token: reporter, lane, every task
    assert.equal((await report(s, ib0, 'lane-beta', 'same-key')).status, 409);
  } finally { await s.close(); }
});

test('5: a duplicate is recognised after more than 50 reports and after a restart (also with the projection rebuilt from the journal)', async () => {
  const dataDir = tmpDir();
  let s = await startSeeded({ dataDir });
  const first = await report(s, OWNER, 'lane-alpha', 'old-key');
  for (let i = 0; i < 55; i++) assert.equal((await report(s, OWNER, 'lane-alpha', `k-${i}`)).status, 200);
  assert.equal(s.board.state.turn_history['lane-alpha'].length, 50);
  assert.ok(!s.board.state.turn_history['lane-alpha'].some(e => e.turn_id === 'old-key'), 'old-key left the 50-report history');
  let dup = await report(s, OWNER, 'lane-alpha', 'old-key');
  assert.equal(dup.status, 409);
  assert.equal(dup.body.seq, first.body.seq);
  assert.deepEqual(dup.body.quick, first.body.quick, 'the original quick comes from the journal once the history has dropped it');
  await s.close();

  s = await startServer({ dataDir });
  try {
    dup = await report(s, OWNER, 'lane-alpha', 'old-key');
    assert.equal(dup.status, 409, 'after a restart');
    assert.equal(dup.body.seq, first.body.seq);
    assert.deepEqual(dup.body.quick, first.body.quick);
  } finally { await s.close(); }

  fs.rmSync(path.join(dataDir, 'state.json')); // the projection is lost: the journal rebuilds it, index included
  s = await startServer({ dataDir });
  try {
    dup = await report(s, OWNER, 'lane-alpha', 'old-key');
    assert.equal(dup.status, 409, 'after a rebuild from the journal');
    assert.equal(dup.body.seq, first.body.seq);
    assert.deepEqual(dup.body.quick, first.body.quick);
    assert.equal(s.board.state.turn_history['lane-alpha'].length, 50);
  } finally { await s.close(); }
});

test('6: changed = tasks the lane\'s own token wrote since that lane\'s previous report, each once; other lanes and the coordinator do not count', async () => {
  const s = await startSeeded();
  try {
    const sub = (token, task, text = 'progress') => s.write(token, 'inbox.submit', task, { kind: 'report', text });
    assert.equal((await sub(s.alpha, 'WEB-3')).status, 200);               // alpha wrote WEB-3
    assert.equal((await s.write(s.coord, 'task.update', 'API-2', { now: 'x' }, { expected_revision: 1 })).status, 200); // the coordinator: counts for no lane
    assert.equal((await sub(s.beta, 'API-2')).status, 200);                // beta wrote API-2
    const png = (await import('../scripts/seed.mjs')).demoPng(10, 10).toString('base64');
    assert.equal((await s.write(s.alpha, 'attachment.add', 'WEB-3', { name: 'a.png', mime: 'image/png', data_base64: png })).status, 200); // WEB-3 again: once
    assert.equal((await s.write(OWNER, 'feedback.add', 'WEB-3', { kind: 'note', text: 'owner note' })).status, 200);                      // the owner: counts for no lane
    const a1 = await report(s, OWNER, 'lane-alpha', 't-1');
    assert.deepEqual(a1.body.quick.changed, ['WEB-3']);
    assert.match(a1.body.quick.line, /^lane-alpha xong 1 lượt \(\d\d:\d\d\) · đổi: WEB-3$/);
    const b1 = await report(s, OWNER, 'lane-beta', 't-1');
    assert.deepEqual(b1.body.quick.changed, ['API-2'], 'beta\'s own writes; alpha\'s are not beta\'s');
    // nothing written since alpha's report: the next one has an empty changed (events before the previous report are not taken)
    const a2 = await report(s, OWNER, 'lane-alpha', 't-2');
    assert.deepEqual(a2.body.quick.changed, []);
    assert.doesNotMatch(a2.body.quick.line, /đổi:/);
    assert.equal((await sub(s.alpha, 'WEB-3')).status, 200);
    assert.equal((await sub(s.alpha, 'WEB-3')).status, 200);
    assert.deepEqual((await report(s, OWNER, 'lane-alpha', 't-3')).body.quick.changed, ['WEB-3']);
    // the coordinator reporting FOR a lane does not make its own writes that lane's
    assert.equal((await s.write(s.coord, 'task.update', 'WEB-3', { now: 'y' }, { expected_revision: 1 })).status, 200);
    assert.deepEqual((await report(s, s.coord, 'lane-alpha', 't-4')).body.quick.changed, []);
  } finally { await s.close(); }
});

test('6b: changed keeps the first 10 distinct tasks in first-seen order; a restart does not lose or change it', async () => {
  const dataDir = tmpDir();
  let s = await startSeeded({ dataDir });
  const gamma = (await s.write(OWNER, 'token.issue', 'lane-gamma', { role: 'reporter', lane: 'lane-gamma', scope_tasks: ['*'] })).body.token;
  for (let i = 1; i <= 12; i++) await s.write(s.coord, 'task.create', `G-${i}`, { title: `G ${i}`, lane: 'lane-gamma' });
  for (const i of [3, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) assert.equal((await s.write(gamma, 'inbox.submit', `G-${i}`, { kind: 'report', text: 'x' })).status, 200);
  await s.close();
  s = await startServer({ dataDir }); // the pending list is part of the projection: still there
  try {
    const r = await report(s, OWNER, 'lane-gamma', 'g-1');
    assert.deepEqual(r.body.quick.changed, ['G-3', 'G-1', 'G-2', 'G-4', 'G-5', 'G-6', 'G-7', 'G-8', 'G-9', 'G-10']);
  } finally { await s.close(); }
});

test('7: asks are the lane\'s open asks, oldest first, at most 8, text folded and cut at 80 characters; the line counts them all', async () => {
  const s = await startSeeded();
  try {
    const long = i => `Dòng ${i}   đầu\n` + 'Ê'.repeat(60) + ' 😀'.repeat(30);
    const ids = await withAsks(s, 10, { text: long });
    // another lane's ask, and an ask on a paused task, are not this lane's waiting list
    await s.write(s.coord, 'task.create', 'OTHER-1', { title: 'Other', lane: 'lane-beta', steps: [{ id: 's1', label: 'x', zone: 'owner', state: 'waiting' }] });
    await s.write(s.coord, 'ask.raise', 'OTHER-1', { text: 'not mine', step_id: 's1' });
    const paused = await s.write(s.coord, 'task.update', 'ASK-2', { status: 'paused' }, { expected_revision: 1 });
    assert.equal(paused.status, 200, JSON.stringify(paused.body));
    const r = await report(s, OWNER, 'lane-alpha', 'a-1');
    const q = r.body.quick;
    const want = ids.filter((_, i) => i !== 1);                       // 9 open (ASK-2 is paused)
    assert.equal(q.asks.length, 8);
    assert.deepEqual(q.asks.map(a => a.id), want.slice(0, 8), 'oldest first');
    for (const a of q.asks) { assert.ok(Array.from(a.text).length <= 80, a.text); assert.doesNotMatch(a.text, /\s\s|\n/); }
    assert.equal(Array.from(q.asks[0].text).length, 80);
    assert.match(q.line, /\nChờ anh 9 việc: ASK-1 Việc 1 \(ask-\d+\) · ASK-3 Việc 3 \(ask-\d+\) · …$/, 'the count is the total, not the 8 listed');
    assert.ok(q.line.split('\n').length <= 3);
    assert.ok(q.asks.every(a => a.task !== 'OTHER-1'));
  } finally { await s.close(); }
});

test('7b: the ask link in the chips is the ask id as is: ask-2402 gives #ask-2402, never #ask-ask-2402 (the id already carries its prefix)', async () => {
  const s = await startSeeded();
  try {
    const [id] = await withAsks(s, 1);
    assert.match(id, /^ask-\d+$/, 'board ask ids already start with ask-');
    const q = (await report(s, OWNER, 'lane-alpha', 'l-1')).body.quick;
    assert.equal(q.asks[0].id, id);
    assert.equal(`#${q.asks[0].id}`, `#${id}`);
    assert.doesNotMatch(`#${q.asks[0].id}`, /ask-ask-/);
  } finally { await s.close(); }
});

test('speech (owner override: kept): at most 25 words, no ids or codes, step labels instead', async () => {
  const s = await startSeeded();
  try {
    // the oldest ask waits on a step whose label is full of ids, a link and words
    await s.write(s.coord, 'task.create', 'LONG-1', { title: 'Long', lane: 'lane-alpha', steps: [{ id: 's1', label: 'Khóa worker cho ACME-02 theo ask-2534 và https://x.test/a?b=1 cực kỳ dài dòng một hai ba bốn năm sáu bảy tám chín mười', zone: 'owner', state: 'waiting' }] });
    await s.write(s.coord, 'ask.raise', 'LONG-1', { text: 'x', step_id: 's1' });
    await withAsks(s, 2, { text: i => `Hỏi ${i}` });
    const sp = (await report(s, OWNER, 'lane-alpha', 'sp-1')).body.quick.speech;
    assert.ok(sp.split(/\s+/).length <= 25, sp);
    assert.doesNotMatch(sp, /[A-Za-z]-\d|ask-|https?:|\[|\d{3,}/, sp);
    assert.equal(sp, 'lane-alpha vừa xong một lượt. Có 3 việc chờ anh: Khóa worker cho theo và cực, Việc và 1 việc nữa.');
    const one = (await report(s, OWNER, 'lane-beta', 'sp-2')).body.quick.speech;
    assert.equal(one, 'lane-beta vừa xong một lượt.');
  } finally { await s.close(); }
});

test('8: the projection keeps exactly 50 reports; /turns answers newest first with the documented bounds', async () => {
  const s = await startSeeded();
  try {
    const seqs = [];
    for (let i = 0; i < 53; i++) seqs.push((await report(s, OWNER, 'lane-alpha', `n-${i}`, `detail ${i}`)).body.seq);
    assert.equal(s.board.state.turn_history['lane-alpha'].length, 50);
    const def = await turns(s, OWNER, 'lane-alpha');
    assert.equal(def.status, 200);
    assert.equal(def.body.lane, 'lane-alpha');
    assert.equal(def.body.turns.length, 20, 'default limit 20');
    assert.deepEqual(def.body.turns.map(t => t.seq), seqs.slice(-20).reverse(), 'newest first');
    assert.deepEqual(Object.keys(def.body.turns[0]).sort(), ['at', 'detail', 'quick', 'seq', 'turn_id']);
    assert.equal(def.body.turns[0].detail, 'detail 52');
    assert.equal((await turns(s, OWNER, 'lane-alpha', '&limit=50')).body.turns.length, 50);
    assert.equal((await turns(s, OWNER, 'lane-alpha', '&limit=500')).body.turns.length, 50, 'capped at the 50 kept');
    assert.equal((await turns(s, OWNER, 'lane-alpha', '&limit=3')).body.turns.length, 3);
    for (const bad of ['0', '-1', 'x', '2.5']) assert.equal((await turns(s, OWNER, 'lane-alpha', `&limit=${bad}`)).body.error, 'invalid_limit', bad);
    assert.equal((await turns(s, OWNER, 'lane-beta')).body.turns.length, 0, 'a known lane without reports: an empty list');
    assert.equal((await turns(s, OWNER, 'lane-alpha').then(r => r.body.turns.at(-1).detail)), 'detail 33');
  } finally { await s.close(); }
});

test('9: read and write permissions: owner and coordinator any lane, a lane token its own lane, a token without a lane none', async () => {
  const s = await startSeeded();
  try {
    const bare = (await s.write(OWNER, 'token.issue', 'bare', { role: 'reporter' })).body.token; // a reporter with no lane
    const inner = async name => (await s.write(OWNER, 'token.issue', 'inner-' + name, { role: 'reporter', lane: name, scope_tasks: ['*'] })).body.token; // lane tokens
    const ia = await inner('lane-alpha'), ib = await inner('lane-beta');
    await withAsks(s, 1);
    assert.equal((await report(s, s.coord, 'lane-alpha', 'p-1')).status, 200, 'coordinator, any lane');
    assert.equal((await report(s, OWNER, 'lane-beta', 'p-2')).status, 200, 'owner, any lane');
    assert.equal((await report(s, ia, 'lane-alpha', 'p-3')).status, 200, 'a lane token, its own lane');
    let r = await report(s, ia, 'lane-beta', 'p-4');
    assert.equal(r.status, 403); assert.equal(r.body.error, 'forbidden_lane');
    assert.equal((await report(s, ia, 'no-such-lane', 'p-5')).status, 403, 'a lane token learns nothing about lanes it does not own');
    assert.equal((await report(s, bare, 'lane-alpha', 'p-6')).status, 403, 'no lane on the token');
    assert.equal((await report(s, null, 'lane-alpha', 'p-7')).status, 401);
    r = await report(s, OWNER, 'no-such-lane', 'p-8');
    assert.equal(r.status, 404); assert.equal(r.body.error, 'unknown_lane');
    assert.equal((await s.write(OWNER, 'turn.report', 'x'.repeat(65), { turn_id: 'p-9', detail: 'x' })).body.error, 'invalid_target_id');

    // reads
    assert.equal((await turns(s, OWNER, 'lane-alpha')).status, 200);
    assert.equal((await turns(s, s.coord, 'lane-beta')).status, 200);
    assert.equal((await turns(s, ia, 'lane-alpha')).status, 200);
    assert.equal((await turns(s, ia, 'lane-beta')).status, 403);
    assert.equal((await turns(s, ia, 'no-such-lane')).status, 403);
    assert.equal((await turns(s, bare, 'lane-alpha')).status, 403, 'a reporter without a lane reads neither quick nor detail');
    assert.equal((await turns(s, null, 'lane-alpha')).status, 401);
    assert.equal((await turns(s, 'wrong-token', 'lane-alpha')).status, 401);
    assert.equal((await turns(s, OWNER, 'no-such-lane')).status, 404);
    assert.equal((await s.call(OWNER, 'GET', '/api/v1/turns')).body.error, 'lane_required');

    // /state?v=2 filters the same way; v=1 and no v carry no turns at all
    const st = async (token, q = '?v=2') => (await s.call(token, 'GET', '/api/v1/state' + q)).body;
    assert.deepEqual(Object.keys((await st(OWNER)).turns).sort(), ['lane-alpha', 'lane-beta']);
    assert.deepEqual(Object.keys((await st(s.coord)).turns).sort(), ['lane-alpha', 'lane-beta']);
    assert.deepEqual(Object.keys((await st(ia)).turns), ['lane-alpha']);
    assert.deepEqual((await st(ib)).turns && Object.keys((await st(ib)).turns), ['lane-beta']);
    assert.deepEqual((await st(bare)).turns, {});
    assert.equal('turns' in (await st(null)), false, 'anonymous: no turns field');
    for (const q of ['', '?v=1', '?v=3']) assert.equal('turns' in (await st(OWNER, q)), false, `v=${q}`);
    const t = (await st(OWNER)).turns['lane-alpha'];
    assert.deepEqual(Object.keys(t).sort(), ['at', 'quick', 'seq'], 'latest only, no detail');
    assert.equal(t.seq, (await turns(s, OWNER, 'lane-alpha')).body.turns[0].seq);
  } finally { await s.close(); }
});

test('9b: one entry per lane in /state?v=2 however many reports came in between two polls (the app shows one card per lane)', async () => {
  const s = await startSeeded();
  try {
    for (let i = 0; i < 5; i++) { await report(s, OWNER, 'lane-alpha', `a-${i}`); await report(s, OWNER, 'lane-beta', `b-${i}`); }
    const turnsView = (await s.call(OWNER, 'GET', '/api/v1/state?v=2')).body.turns;
    assert.equal(Object.keys(turnsView).length, 2);
    assert.equal(turnsView['lane-alpha'].seq, s.board.state.turn_history['lane-alpha'].at(-1).seq);
  } finally { await s.close(); }
});

test('10: the server enforces the 8000-character limit on detail (code points, not UTF-16 units)', async () => {
  const s = await startSeeded();
  try {
    assert.equal((await report(s, OWNER, 'lane-alpha', 'd-1', 'a'.repeat(8000))).status, 200);
    assert.equal((await report(s, OWNER, 'lane-alpha', 'd-2', '😀'.repeat(8000))).status, 200, '8000 characters, 16000 UTF-16 units');
    const over = await report(s, OWNER, 'lane-alpha', 'd-3', 'a'.repeat(8001));
    assert.equal(over.status, 400); assert.equal(over.body.error, 'invalid_data');
    assert.equal((await report(s, OWNER, 'lane-alpha', 'd-4', '   \n ')).body.error, 'detail_required');
    assert.equal((await report(s, OWNER, 'lane-alpha', 'x'.repeat(81), 'x')).status, 400, 'turn_id is at most 80');
    assert.equal((await report(s, OWNER, 'lane-alpha', 'bad id', 'x')).status, 400);
  } finally { await s.close(); }
});

test('atomic: the quick report is the board at the append: the same event time, the same asks, replayed unchanged after a crash', async () => {
  const dataDir = tmpDir();
  let s = await startSeeded({ dataDir, now: () => T0 });
  const [ask] = await withAsks(s, 1);
  assert.throws(() => s.board.write(OWNER, { version: 1, request_id: rid(), op: 'turn.report', target_id: 'lane-alpha', data: { turn_id: 'c-1', detail: 'x' } }, { crashAfterJournal: true }), /simulated crash/);
  const line = journal(s).at(-1);
  assert.equal(line.op, 'turn.report');
  assert.equal(line.data.quick.asks[0].id, ask);
  assert.match(line.data.quick.line, /\(18:42\)/);
  await s.close();
  s = await startServer({ dataDir, now: () => T0 + 3600000 }); // a later clock: replay must not recompute anything
  try {
    assert.equal(s.board.replayed, 1);
    assert.deepEqual(s.board.state.turn_history['lane-alpha'][0].quick, line.data.quick);
    assert.equal((await report(s, OWNER, 'lane-alpha', 'c-1')).status, 409);
  } finally { await s.close(); }
});

test('streams: turn is an opt-in signal type; the default stream is unchanged', async () => {
  const s = await startSeeded();
  try {
    const got = { def: [], turn: [] };
    const stop1 = s.board.watch(OWNER, {}, { onSignal: x => got.def.push(x) });
    const stop2 = s.board.watch(s.coord, { types: ['turn'] }, { onSignal: x => got.turn.push(x) });
    const r = await report(s, OWNER, 'lane-alpha', 'sse-1');
    await new Promise(res => setTimeout(res, 20));
    stop1(); stop2();
    assert.deepEqual(got.def, [], 'feedback,answer,ask only');
    assert.equal(got.turn.length, 1);
    assert.deepEqual({ type: got.turn[0].type, lane: got.turn[0].lane, id: got.turn[0].id, line: got.turn[0].line }, { type: 'turn', lane: 'lane-alpha', id: r.body.id, line: r.body.quick.line });
    const ac = new AbortController();
    const res = await fetch(`${s.url}/api/v1/events?types=turn`, { headers: { Authorization: `Bearer ${OWNER}`, Accept: 'text/event-stream' }, signal: ac.signal });
    assert.equal(res.status, 200); ac.abort();
    const bad = await fetch(`${s.url}/api/v1/events?types=nope`, { headers: { Authorization: `Bearer ${OWNER}`, Accept: 'text/event-stream' } });
    assert.equal(bad.status, 400);
  } finally { await s.close(); }
});

test('a report does not disturb the board: no activity, no ping, no change to the v1 task views', async () => {
  const s = await startSeeded({ now: () => T0 });
  try {
    const strip = v => { const { seq, ...rest } = v; return JSON.stringify(rest); };
    const before = (await s.call(OWNER, 'GET', '/api/v1/state')).body;
    await report(s, OWNER, 'lane-alpha', 'q-1');
    const after = (await s.call(OWNER, 'GET', '/api/v1/state')).body;
    assert.equal(strip(after), strip(before));
    assert.equal(after.seq, before.seq + 1);
  } finally { await s.close(); }
});
