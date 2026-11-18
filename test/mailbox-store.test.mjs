// Release 1 of the lane mailbox: the message store is groundwork only. Messages are NOT journal events (the
// reducer is untouched, so rollback never breaks replay); they live in <data>/messages.ndjson and are pruned
// after 30 days. The only board-visible change is that a reporter token can no longer be minted with a
// reserved lane name (anh, cos, all, case-insensitive).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openMessageStore, MAILBOX, RESERVED_LANES, isReservedLane } from '../src/mailbox.mjs';
import { startServer, tmpDir, OWNER } from './helpers.mjs';

const clock = (t = Date.parse('2026-10-01T00:00:00.000Z')) => {
  const c = { t, now: () => c.t, tick: ms => { c.t += ms; } };
  return c;
};
const append = (m, from, to, body, extra = {}) => m.append({ from, to, body, ...extra });

test('messages live in data/messages.ndjson with stable seq ids, never in the journal', () => {
  const dir = tmpDir();
  const c = clock();
  const m = openMessageStore(dir, { now: c.now, daily: false });
  try {
    assert.equal(m.file, path.join(dir, 'messages.ndjson'));
    const a = append(m, 'lane-alpha', 'lane-beta', 'hello');
    const b = append(m, 'lane-beta', 'lane-alpha', 'hi back');
    assert.deepEqual([a.seq, a.id, b.seq, b.id], [1, 'msg-1', 2, 'msg-2']);
    assert.deepEqual([a.from, a.to, a.body, a.at], ['lane-alpha', 'lane-beta', 'hello', '2026-10-01T00:00:00.000Z']);
    const lines = fs.readFileSync(m.file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.deepEqual(lines.map(x => x.id), ['msg-1', 'msg-2']);
    assert.equal(m.lastSeq, 2);
  } finally { m.close(); }

  const reopened = openMessageStore(dir, { now: c.now, daily: false });
  try {
    assert.equal(reopened.lastSeq, 2);
    assert.deepEqual(reopened.list('lane-beta', 0).map(x => x.id), ['msg-1', 'msg-2'], 'received and sent');
    assert.equal(append(reopened, 'lane-alpha', 'lane-beta', 'third').seq, 3, 'seq continues after a reopen');
  } finally { reopened.close(); }
});

test('an inbox lists what is addressed to the lane or to all, plus what that lane sent; after is a seq cursor', () => {
  const dir = tmpDir();
  const m = openMessageStore(dir, { now: clock().now, daily: false });
  try {
    append(m, 'lane-alpha', 'lane-beta', 'a to b');
    append(m, 'lane-alpha', 'all', 'a to all');
    append(m, 'lane-beta', 'lane-alpha', 'b to a');
    append(m, 'lane-alpha', 'lane-alpha', 'a to a');
    assert.deepEqual(m.list('lane-beta').map(x => x.body), ['a to b', 'a to all', 'b to a']);
    assert.deepEqual(m.list('lane-alpha').map(x => x.body), ['a to b', 'a to all', 'b to a', 'a to a'], 'own sent + broadcasts + received');
    assert.deepEqual(m.list('lane-beta', 2).map(x => x.body), ['b to a'], 'after skips older messages');
    assert.deepEqual(m.list('lane-gamma').map(x => x.body), ['a to all'], 'a broadcast reaches a lane nobody addressed');
  } finally { m.close(); }
});

test('30-day retention: startup prunes old bodies, the daily prune keeps recent ones, and seq never rewinds', () => {
  const dir = tmpDir();
  const c = clock();
  let m = openMessageStore(dir, { now: c.now, daily: false });
  append(m, 'lane-alpha', 'lane-beta', 'old one');
  append(m, 'lane-alpha', 'lane-beta', 'old two');
  m.close();

  c.tick(MAILBOX.retentionMs + 1000);
  m = openMessageStore(dir, { now: c.now, daily: false });
  try {
    assert.equal(m.list('lane-beta').length, 0, 'both messages aged out on startup');
    assert.equal(m.lastSeq, 2, 'the meta line keeps the sequence');
    const fresh = append(m, 'lane-alpha', 'lane-beta', 'new');
    assert.equal(fresh.seq, 3, 'a pruned store never reuses an id');
  } finally { m.close(); }

  const dir2 = tmpDir();
  const c2 = clock();
  const m2 = openMessageStore(dir2, { now: c2.now, daily: false });
  try {
    append(m2, 'lane-alpha', 'lane-beta', 'old');
    c2.tick(20 * 24 * 3600 * 1000);
    append(m2, 'lane-alpha', 'lane-beta', 'recent');
    c2.tick(11 * 24 * 3600 * 1000);
    assert.equal(m2.prune(), 1, 'the explicit prune (what the daily timer calls) drops only the aged body');
    assert.deepEqual(m2.list('lane-beta').map(x => x.body), ['recent']);
    assert.equal(append(m2, 'lane-alpha', 'lane-beta', 'next').seq, 3);
  } finally { m2.close(); }
});

test('a torn last line is cut, a corrupt middle line is skipped: messages never stop the board from starting', () => {
  const dir = tmpDir();
  const m = openMessageStore(dir, { now: clock().now, daily: false });
  append(m, 'lane-alpha', 'lane-beta', 'one');
  append(m, 'lane-alpha', 'lane-beta', 'two');
  m.close();

  const file = path.join(dir, 'messages.ndjson');
  const good = fs.readFileSync(file, 'utf8').trim().split('\n');
  fs.writeFileSync(file, `${good[0]}\n{"not":"a message"}\n${good[1]}\n{"seq":`);
  const m2 = openMessageStore(dir, { now: clock().now, daily: false });
  try {
    assert.deepEqual(m2.list('lane-beta').map(x => x.body), ['one', 'two'], 'the bad middle line is skipped, nothing else is lost');
    assert.equal(m2.lastSeq, 2);
  } finally { m2.close(); }
});

test('reserved lane names are refused for reporter tokens only, case-insensitively', async () => {
  const s = await startServer();
  try {
    assert.deepEqual(RESERVED_LANES, ['anh', 'cos', 'all']);
    for (const name of ['anh', 'CoS', 'ALL', ' all ', 'anh (zumi-app)', 'cos (CoS)']) assert.equal(isReservedLane(name), true, name);
    for (const name of ['workera', 'workeraanh', 'cos2', 'all-hands', '']) assert.equal(isReservedLane(name), false, name);

    // A lane that only looks like the owner's `from` ("anh (<label>)") must never be mintable either.
    for (const [i, lane] of ['anh', 'CoS', 'ALL', 'anh (zumi-app)'].entries()) {
      const r = await s.write(OWNER, 'token.issue', `reserved-${i}`, { role: 'reporter', lane, scope_tasks: ['*'] });
      assert.equal(r.status, 400, lane);
      assert.equal(r.body.error, 'reserved_lane', lane);
      assert.equal(r.body.lane, lane);
      assert.ok(Array.isArray(r.body.reserved));
    }
    const ok = await s.write(OWNER, 'token.issue', 'lane-workera', { role: 'reporter', lane: 'workera', scope_tasks: ['*'] });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(s.board.state.tokens[ok.body.id].lane, 'workera');

    // Only reporters are constrained: the live board's coordinator lane is cos and an owner token may carry a label lane.
    assert.equal((await s.write(OWNER, 'token.issue', 'coord', { role: 'coordinator', lane: 'cos' })).status, 200);
    assert.equal((await s.write(OWNER, 'token.issue', 'owner-anh', { role: 'owner', lane: 'anh' })).status, 200);
    assert.deepEqual(Object.values(s.board.state.tokens).map(t => t.name).sort(), ['coord', 'lane-workera', 'owner', 'owner-anh']);
  } finally { await s.close(); }
});

test('the store is capped per sender lane per day, and the refusal happens before the append', () => {
  const dir = tmpDir();
  const c = clock();
  const m = openMessageStore(dir, { now: c.now, daily: false, dailyPerLane: 3 });
  try {
    for (let i = 0; i < 3; i++) append(m, 'lane-alpha', 'lane-beta', `m${i}`);
    assert.throws(() => append(m, 'lane-alpha', 'lane-beta', 'one too many'),
      e => e.code === 'lane_daily_limit' && e.limit === 3, 'a fourth message from the same lane in 24 h is refused');
    assert.equal(m.messages.length, 3, 'nothing was appended');
    assert.equal(append(m, 'lane-beta', 'lane-alpha', 'its own budget').seq, 4, 'the cap is per sender lane, not global');
    c.tick(24 * 3600 * 1000 + 1000); // the window rolls: the first three no longer count
    assert.equal(append(m, 'lane-alpha', 'lane-beta', 'next day').seq, 5);
  } finally { m.close(); }

  // The count survives a restart: it is seeded from the records still inside the 24 h window.
  const again = openMessageStore(dir, { now: c.now, daily: false, dailyPerLane: 3 });
  try {
    assert.equal(again.lastSeq, 5, 'the earlier records are loaded');
    assert.equal(append(again, 'lane-alpha', 'lane-beta', 'restart one').seq, 6);
    assert.equal(append(again, 'lane-alpha', 'lane-beta', 'restart two').seq, 7);
    assert.throws(() => append(again, 'lane-alpha', 'lane-beta', 'restart three'), e => e.code === 'lane_daily_limit');
  } finally { again.close(); }
});

test('the file has a hard byte ceiling, and startup on an oversized file neither throws nor rewrites it', () => {
  const dir = tmpDir();
  const c = clock();
  const file = path.join(dir, 'messages.ndjson');
  const m = openMessageStore(dir, { now: c.now, daily: false, maxBytes: 600 });
  try {
    append(m, 'lane-alpha', 'lane-beta', 'x'.repeat(200));
    assert.throws(() => append(m, 'lane-alpha', 'lane-beta', 'y'.repeat(300)),
      e => e.code === 'store_full' && e.maxBytes === 600, 'a message that would pass the ceiling is refused before the append');
    assert.equal(m.messages.length, 1);
  } finally { m.close(); }

  // Simulate a file left over the ceiling by an older build: it must not be loaded (that read is the OOM), the
  // store must still open, and its bytes must stay on disk untouched.
  fs.appendFileSync(file, JSON.stringify({ seq: 2, id: 'msg-2', at: '2026-10-01T00:00:00.000Z', from: 'lane-alpha', to: 'lane-beta', body: 'z'.repeat(2000) }) + '\n');
  const before = fs.statSync(file);
  const m2 = openMessageStore(dir, { now: c.now, daily: false, maxBytes: 600 });
  try {
    assert.equal(m2.oversize, true);
    assert.deepEqual(m2.list('lane-beta'), [], 'nothing is served from a file that was not loaded');
    assert.equal(m2.prune(), 0, 'prune never rewrites a file it did not load');
    assert.throws(() => append(m2, 'lane-alpha', 'lane-beta', 'still full'), e => e.code === 'store_full');
    assert.equal(fs.statSync(file).size, before.size, 'the oversized file is left as it is for the operator');
    assert.equal(fs.statSync(file).mtimeMs, before.mtimeMs);
  } finally { m2.close(); }
});

test('a daily tick prunes without anyone calling prune(): the timer owns the 30-day rule', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const dir = tmpDir();
  let at = Date.parse('2026-10-01T00:00:00.000Z');
  const m = openMessageStore(dir, { now: () => at }); // daily: true (the default)
  try {
    append(m, 'lane-alpha', 'lane-beta', 'will age out');
    at += MAILBOX.retentionMs + 1000;
    t.mock.timers.tick(24 * 60 * 60 * 1000);
    assert.equal(m.list('lane-beta').length, 0, 'the daily timer dropped the aged body');
    assert.equal(m.lastSeq, 1, 'pruning keeps the sequence');
  } finally { m.close(); }
});

test('lane names are case-insensitive: a lane spelled Workera sees what Workera sent and received', () => {
  const dir = tmpDir();
  const m = openMessageStore(dir, { now: clock().now, daily: false });
  try {
    append(m, 'Workera', 'COORD', 'from Workera');
    append(m, 'coord', 'workera', 'to lower workera');
    assert.deepEqual(m.list('workera').map(x => x.body), ['from Workera', 'to lower workera']);
    assert.deepEqual(m.list('WORKERA').map(x => x.body), ['from Workera', 'to lower workera']);
  } finally { m.close(); }
});
