// Release 2 of the lane mailbox: POST /api/v1/msg and the long-poll GET /api/v1/inbox.
// Rules under test: `from` is stamped by the server (never the body); mayUseInbox (owner/coordinator all,
// reporter its own lane + all + own sent, 403 never 404); 8 KB plain text and 5 https links; a secret-shaped
// body/link is refused without echoing the match; 30 sends/min per token; one open poll per token; and the
// messages stay out of the journal. Ext-edge coverage lives at the end of this file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { startSeeded, startServer, OWNER, tmpDir } from './helpers.mjs';
import { createBoard } from '../src/board.mjs';
import { MAILBOX } from '../src/mailbox.mjs';
import { createServer } from '../src/server.mjs';
import { makeClock, seedScopeBoard, OWNER as SCOPE_OWNER } from './reporter-scope-seed.mjs';

const msg = (s, token, body) => s.call(token, 'POST', '/api/v1/msg', body);
const inbox = (s, token, query = '') => s.call(token, 'GET', `/api/v1/inbox${query}`);
const bodies = r => r.body.messages.map(m => m.body);
const of = (r, body) => r.body.messages.find(m => m.body === body);

test('send-as-self: from is the token lane, the owner posts as "anh (<label>)", the body cannot set from/id/at', async () => {
  const s = await startSeeded();
  try {
    const sent = await msg(s, s.alpha, { to: 'lane-beta', body: 'hello beta' });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.match(sent.body.id, /^msg-\d+$/);
    assert.equal(sent.body.from, 'lane-alpha', 'the server stamps the sender from the token');
    const beta = await inbox(s, s.beta, '?lane=lane-beta');
    assert.equal(beta.status, 200);
    assert.equal(of(beta, 'hello beta').from, 'lane-alpha');
    assert.equal(of(beta, 'hello beta').to, 'lane-beta');

    const own = await inbox(s, s.alpha, '?lane=lane-alpha');
    assert.ok(bodies(own).includes('hello beta'), 'a lane reads what it sent');

    const app = await s.write(OWNER, 'token.issue', 'zumi-app', { role: 'owner', label: 'zumi-app' });
    assert.equal((await msg(s, app.body.token, { to: 'lane-alpha', body: 'from the app' })).status, 200);
    let alpha = await inbox(s, s.alpha, '?lane=lane-alpha');
    assert.equal(of(alpha, 'from the app').from, 'anh (zumi-app)');
    assert.equal((await msg(s, OWNER, { to: 'lane-alpha', body: 'from the owner token' })).status, 200);
    alpha = await inbox(s, s.alpha, '?lane=lane-alpha');
    assert.equal(of(alpha, 'from the owner token').from, 'anh (owner)');
    assert.equal((await msg(s, s.coord, { to: 'lane-alpha', body: 'from cos' })).status, 200);
    alpha = await inbox(s, s.alpha, '?lane=lane-alpha');
    assert.equal(of(alpha, 'from cos').from, 'coordination', 'the coordinator posts as its lane');

    for (const extra of [{ from: 'cos' }, { id: 'msg-999' }, { at: '2020-01-01T00:00:00.000Z' }, { seq: 1 }]) {
      const r = await msg(s, s.alpha, { to: 'lane-beta', body: 'smuggled', ...extra });
      assert.equal(r.status, 400, JSON.stringify(extra));
      assert.equal(r.body.error, 'invalid_msg');
      assert.ok(r.body.errors.some(e => Object.keys(extra).some(k => e.path === `$.${k}`)));
    }
  } finally { await s.close(); }
});

test('mayUseInbox: own lane, broadcasts and own sent; another lane or an unknown lane is 403, never 404', async () => {
  const s = await startSeeded();
  try {
    await msg(s, s.alpha, { to: 'lane-beta', body: 'a to b' });
    await msg(s, s.alpha, { to: 'all', body: 'a to all' });
    await msg(s, s.beta, { to: 'lane-alpha', body: 'b to a' });
    await msg(s, s.alpha, { to: 'lane-alpha', body: 'a to a' });

    assert.deepEqual(bodies(await inbox(s, s.beta, '?lane=lane-beta')).sort(), ['a to all', 'a to b', 'b to a']);
    assert.equal((await inbox(s, s.beta)).body.lane, 'lane-beta', 'a reporter defaults to its own lane');
    assert.deepEqual(bodies(await inbox(s, s.beta, '?lane=all')), ['a to all'], 'a reporter may name the broadcast lane');

    for (const q of ['?lane=lane-alpha', '?lane=nope', '?lane=CoS']) {
      const r = await inbox(s, s.beta, q);
      assert.equal(r.status, 403, q);
      assert.equal(r.body.error, 'forbidden_lane');
      assert.equal(r.body.lane, q.slice('?lane='.length));
      assert.equal(r.body.known, undefined, 'the refusal never lists the lanes that exist');
    }
    assert.equal((await inbox(s, null, '?lane=lane-beta')).status, 401);
    assert.equal((await inbox(s, OWNER)).body.error, 'lane_required');
    assert.equal((await inbox(s, OWNER, '?lane=ghost')).status, 200, 'the owner may name any lane');
    assert.deepEqual(bodies(await inbox(s, OWNER, '?lane=ghost')), ['a to all'], 'broadcasts reach every lane; direct messages do not');
    assert.equal((await inbox(s, s.coord, '?lane=LANE-BETA')).status, 200, 'lanes match case-insensitively');

    const noLane = await s.write(OWNER, 'token.issue', 'outside', { role: 'reporter', scope_tasks: ['*'] });
    assert.equal((await msg(s, noLane.body.token, { to: 'lane-beta', body: 'x' })).status, 403);
    assert.equal((await msg(s, noLane.body.token, { to: 'lane-beta', body: 'x' })).body.error, 'lane_required');
    assert.equal((await inbox(s, noLane.body.token)).status, 403, 'a reporter without a lane cannot read an inbox');
  } finally { await s.close(); }
});

test('to: a known lane, cos or all; an unknown name gets the same 403 as a forbidden lane, never a lane list', async () => {
  const s = await startSeeded();
  try {
    assert.equal((await msg(s, s.alpha, { to: 'lane-beta', body: 'known' })).status, 200);
    assert.equal((await msg(s, s.alpha, { to: 'LANE-BETA', body: 'case-insensitive' })).status, 200);
    const b = await inbox(s, s.beta, '?lane=lane-beta');
    assert.ok(bodies(b).includes('case-insensitive'));
    assert.equal(of(b, 'case-insensitive').to, 'lane-beta', 'stored with the board spelling');
    assert.equal((await msg(s, s.alpha, { to: 'cos', body: 'to the coordinator lane' })).status, 200);
    assert.equal((await msg(s, s.alpha, { to: 'all', body: 'broadcast' })).status, 200);
    // An unknown name is refused exactly like a lane the reader may not use, so a send cannot enumerate lanes.
    for (const to of ['nope', 'anh']) {
      const r = await msg(s, s.alpha, { to, body: 'x' });
      assert.equal(r.status, 403, to);
      assert.equal(r.body.error, 'forbidden_lane', to);
      assert.equal(r.body.lane, to);
      assert.equal(r.body.known, undefined, 'no lane list leaks to a reporter');
    }
    assert.equal((await msg(s, s.alpha, { to: '', body: 'x' })).status, 400, 'an empty target is malformed, not unknown');
    const ownerProbe = await msg(s, OWNER, { to: 'nope', body: 'x' });
    assert.equal(ownerProbe.status, 403, 'the owner sees the same refusal');
    assert.equal(ownerProbe.body.error, 'forbidden_lane');
  } finally { await s.close(); }
});

test('limits: 8 KB plain text, 5 https links, 30 sends a minute per token', async () => {
  const clock = makeClock();
  const s = await startSeeded({ now: clock.now });
  try {
    assert.equal((await msg(s, s.alpha, { to: 'all', body: 'a'.repeat(8192) })).status, 200);
    let r = await msg(s, s.alpha, { to: 'all', body: 'a'.repeat(8193) });
    assert.equal(r.status, 413); assert.equal(r.body.error, 'body_too_long'); assert.equal(r.body.max_bytes, 8192);
    // 8 KB is bytes, not characters: 4096 two-byte characters fit, 4097 do not.
    assert.equal((await msg(s, s.alpha, { to: 'all', body: 'é'.repeat(4096) })).status, 200);
    r = await msg(s, s.alpha, { to: 'all', body: 'é'.repeat(4097) });
    assert.equal(r.status, 413); assert.equal(r.body.error, 'body_too_long');
    r = await msg(s, s.alpha, { to: 'all', body: 'bad\u0000text' });
    assert.equal(r.status, 400); assert.equal(r.body.error, 'body_not_text');
    assert.equal((await msg(s, s.alpha, { to: 'all', body: 42 })).status, 400);

    const five = Array.from({ length: 5 }, (_, i) => `https://example.test/${i}`);
    assert.equal((await msg(s, s.alpha, { to: 'all', body: 'five links', links: five })).status, 200);
    r = await msg(s, s.alpha, { to: 'all', body: 'six links', links: [...five, 'https://example.test/5'] });
    assert.equal(r.status, 400); assert.equal(r.body.error, 'too_many_links'); assert.equal(r.body.max, 5);
    r = await msg(s, s.alpha, { to: 'all', body: 'http', links: ['http://example.test/x'] });
    assert.equal(r.status, 400); assert.equal(r.body.error, 'link_not_https'); assert.equal(r.body.index, 0);
    r = await msg(s, s.alpha, { to: 'all', body: 'not a url', links: ['javascript:alert(1)'] });
    assert.equal(r.body.error, 'link_not_https');

    // 30 sends a minute, a fresh bucket for messages (not the reporter write cap).
    clock.tick(61000);
    for (let i = 0; i < 30; i++) assert.equal((await msg(s, s.alpha, { to: 'all', body: `rate ${i}` })).status, 200, `send ${i}`);
    r = await msg(s, s.alpha, { to: 'all', body: 'one too many' });
    assert.equal(r.status, 429); assert.equal(r.body.error, 'rate_limited');
    assert.equal(r.body.limit_per_minute, 30); assert.ok(r.body.retry_after_s >= 1);
    clock.tick(61000);
    assert.equal((await msg(s, s.alpha, { to: 'all', body: 'after the window' })).status, 200);
  } finally { await s.close(); }
});

test('a secret-shaped body or link is refused, and the refusal never echoes the match', async () => {
  const s = await startSeeded();
  try {
    const secret = 'lb_' + 'A1b2C3d4'.repeat(6);
    let r = await msg(s, s.alpha, { to: 'lane-beta', body: `here is a token ${secret}` });
    assert.equal(r.status, 400); assert.equal(r.body.error, 'secret_shape');
    assert.deepEqual(r.body.fields, ['body']);
    assert.ok(!JSON.stringify(r.body).includes(secret), 'the match is not echoed');

    const key = 'sk-' + 'a1B2c3D4'.repeat(4);
    r = await msg(s, s.alpha, { to: 'lane-beta', body: 'a link', links: [`https://example.test/?k=${key}`] });
    assert.equal(r.status, 400); assert.equal(r.body.error, 'secret_shape');
    assert.deepEqual(r.body.fields, ['links[0]']);
    assert.ok(!JSON.stringify(r.body).includes(key));

    assert.equal((await msg(s, s.alpha, { to: 'lane-beta', body: 'the token bucket is fine, say it in prose' })).status, 200);
  } finally { await s.close(); }
});

test('a link with user:pass@ (basic-auth credentials) is refused, and the refusal never echoes it', async () => {
  const s = await startSeeded();
  try {
    for (const link of ['https://user:secret@example.com/laneboard/', 'https://user@example.com/laneboard/']) {
      const r = await msg(s, s.alpha, { to: 'all', body: 'see this', links: [link] });
      assert.equal(r.status, 400, link);
      assert.equal(r.body.error, 'link_credentials', link);
      assert.equal(r.body.index, 0);
      assert.ok(!JSON.stringify(r.body).includes('hunter2'), 'the credential is not echoed');
    }
    assert.equal((await msg(s, s.alpha, { to: 'all', body: 'plain', links: ['https://example.test/plain'] })).status, 200);
  } finally { await s.close(); }
});

test('the store is capped at the API: a per-sender daily count is 429 and a full file is 507, neither appends', async () => {
  const s = await startSeeded({ mailboxLimits: { dailyPerLane: 3 } });
  try {
    for (let i = 0; i < 3; i++) assert.equal((await msg(s, s.alpha, { to: 'all', body: `cap ${i}` })).status, 200, `message ${i}`);
    const r = await msg(s, s.alpha, { to: 'all', body: 'one too many' });
    assert.equal(r.status, 429); assert.equal(r.body.error, 'lane_daily_limit');
    assert.equal(r.body.limit_per_day, 3); assert.ok(r.body.retry_after_s >= 1);
    assert.equal((await msg(s, s.beta, { to: 'all', body: 'another lane' })).status, 200, 'the cap is per sender lane');
    const all = await inbox(s, s.beta, '?lane=all');
    assert.ok(!bodies(all).includes('one too many'), 'the refused message was never appended');
  } finally { await s.close(); }

  const small = await startSeeded({ mailboxLimits: { maxBytes: 600 } });
  try {
    assert.equal((await msg(small, small.alpha, { to: 'all', body: 'a'.repeat(300) })).status, 200);
    const full = await msg(small, small.alpha, { to: 'all', body: 'b'.repeat(300) });
    assert.equal(full.status, 507); assert.equal(full.body.error, 'store_full');
    assert.equal(full.body.max_bytes, 600);
    const all = await inbox(small, small.beta, '?lane=all');
    assert.ok(!bodies(all).includes('b'.repeat(300)), 'the refused message was never appended');
  } finally { await small.close(); }
});

test('startup on an oversized messages.ndjson still serves the board; sends are 507 until the file is rotated', async () => {
  const dir = tmpDir();
  let s = await startSeeded({ dataDir: dir, mailboxLimits: { maxBytes: 512 } });
  const alpha = s.alpha;
  await s.close();
  const file = path.join(dir, 'messages.ndjson');
  fs.appendFileSync(file, JSON.stringify({ seq: 1, id: 'msg-1', at: new Date().toISOString(), from: 'lane-alpha', to: 'all', body: 'x'.repeat(4000) }) + '\n');
  const before = fs.statSync(file).size;
  s = await startServer({ dataDir: dir, mailboxLimits: { maxBytes: 512 } });
  try {
    assert.equal((await s.call(OWNER, 'GET', '/api/v1/state')).status, 200, 'the board starts and serves its tasks');
    const r = await msg(s, alpha, { to: 'all', body: 'while the file is oversized' });
    assert.equal(r.status, 507); assert.equal(r.body.error, 'store_full');
    assert.equal(r.body.oversize, true, 'the reason is reported, not hidden');
    assert.equal(fs.statSync(file).size, before, 'nothing was rewritten or appended');
  } finally { await s.close(); }
});

test('a reporter token minted before the reserved-lane rule cannot send as, or read, that lane', async () => {
  const s = await startSeeded();
  const dir = s.dataDir, seq = s.board.state.seq + 1;
  const secret = 'lb_' + crypto.randomBytes(32).toString('base64url');
  const sha = crypto.createHash('sha256').update(secret).digest('hex');
  await s.close();
  // A pre-R1 journal event: the mint rule cannot stop it, so the send/read paths must.
  fs.appendFileSync(path.join(dir, 'events.ndjson'), JSON.stringify({
    seq, id: `evt-${seq}`, at: new Date().toISOString(), request_id: `legacy-reserved-${seq}`, body_sha256: sha,
    actor: { token_id: 'system', name: 'system', role: 'owner' },
    op: 'token.issue', target_id: 'legacy-cos',
    data: { role: 'reporter', lane: 'CoS', scope_tasks: ['*'], token_sha256: sha },
    result: { id: `tok-${seq}`, revision: 1 }
  }) + '\n');
  const board = createBoard({ dataDir: dir, ownerToken: OWNER });
  try {
    assert.equal(board.authenticate(secret).lane, 'CoS', 'the legacy token replays: the mint check only guards new tokens');
    assert.throws(() => board.sendMessage(secret, { to: 'lane-beta', body: 'as cos' }),
      e => e.status === 403 && e.code === 'reserved_lane', 'a send is stamped with the reserved lane, so it is refused');
    await assert.rejects(board.inbox(secret, { lane: 'CoS' }), e => e.status === 403 && e.code === 'reserved_lane');
    await assert.rejects(board.inbox(secret, { lane: 'all' }), e => e.status === 403 && e.code === 'reserved_lane');
  } finally { board.close(); }
});

test('reply_to: only a message the sender can see; a bad shape is 400, a missing id is 404', async () => {
  const s = await startSeeded();
  try {
    const first = await msg(s, s.alpha, { to: 'lane-beta', body: 'question' });
    const reply = await msg(s, s.beta, { to: 'lane-alpha', body: 'answer', reply_to: first.body.id });
    assert.equal(reply.status, 200);
    const a = await inbox(s, s.alpha, '?lane=lane-alpha');
    assert.equal(of(a, 'answer').reply_to, first.body.id);

    const privateToBeta = await msg(s, s.beta, { to: 'lane-beta', body: 'note to self' });
    const blind = await msg(s, s.alpha, { to: 'lane-beta', body: 'snoop', reply_to: privateToBeta.body.id });
    assert.equal(blind.status, 403); assert.equal(blind.body.error, 'not_your_message');

    assert.equal((await msg(s, s.alpha, { to: 'lane-beta', body: 'x', reply_to: 'ask-1' })).status, 400);
    assert.equal((await msg(s, s.alpha, { to: 'lane-beta', body: 'x', reply_to: 'msg-9999' })).status, 404);
  } finally { await s.close(); }
});

test('GET /api/v1/inbox: after is a msg cursor and the long poll wakes on the next send', async () => {
  const s = await startSeeded();
  try {
    const one = await msg(s, s.alpha, { to: 'lane-beta', body: 'one' });
    const two = await msg(s, s.alpha, { to: 'lane-beta', body: 'two' });
    const first = await inbox(s, s.beta, '?lane=lane-beta');
    assert.deepEqual(bodies(first), ['one', 'two']);
    assert.equal(first.body.next, two.body.seq);
    assert.equal(first.body.more, false);
    assert.deepEqual((await inbox(s, s.beta, `?lane=lane-beta&after=${two.body.seq}`)).body.messages, []);

    const started = Date.now();
    const pending = inbox(s, s.beta, `?lane=lane-beta&after=${two.body.seq}&wait=3`);
    await new Promise(r => setTimeout(r, 150));
    const three = await msg(s, s.alpha, { to: 'lane-beta', body: 'three' });
    const woke = await pending;
    assert.equal(woke.status, 200);
    assert.deepEqual(bodies(woke), ['three']);
    assert.equal(woke.body.next, three.body.seq);
    assert.ok(Date.now() - started < 2500, 'woke before the 3 s wait expired');

    const timed = await inbox(s, s.beta, `?lane=lane-beta&after=${three.body.seq}&wait=1`);
    assert.deepEqual(timed.body.messages, []);
    assert.equal(timed.body.next, three.body.seq);

    const t0 = Date.now();
    assert.equal((await inbox(s, s.beta, '?lane=lane-beta&wait=0')).status, 200);
    assert.ok(Date.now() - t0 < 1000, 'wait=0 never parks');

    for (const q of ['?lane=lane-beta&wait=26', '?lane=lane-beta&wait=abc', '?lane=lane-beta&after=-1', '?lane=lane-beta&after=abc']) {
      const r = await inbox(s, s.beta, q);
      assert.equal(r.status, 400, q);
      assert.ok(['invalid_wait', 'invalid_after'].includes(r.body.error), `${q}: ${r.body.error}`);
    }
    assert.equal(one.body.seq + 1, two.body.seq);
  } finally { await s.close(); }
});

test('at most one open long poll per token: a new poll closes the old one', async () => {
  const s = await startSeeded();
  try {
    const first = inbox(s, s.beta, '?lane=lane-beta&wait=10');
    await new Promise(r => setTimeout(r, 200));
    const second = inbox(s, s.beta, '?lane=lane-beta&wait=1');
    const old = await first;
    assert.equal(old.status, 200);
    assert.equal(old.body.closed, true);
    assert.deepEqual(old.body.messages, []);
    const fresh = await second;
    assert.notEqual(fresh.body.closed, true);
    assert.deepEqual(fresh.body.messages, []);
  } finally { await s.close(); }
});

test('a long poll a client abandons is released: the next poll for that token is not "closed"', async () => {
  const s = await startSeeded();
  try {
    const gone = new AbortController();
    const abandoned = fetch(`${s.url}/api/v1/inbox?lane=lane-beta&wait=25`, {
      headers: { Authorization: `Bearer ${s.beta}` }, signal: gone.signal
    });
    await new Promise(r => setTimeout(r, 200));
    gone.abort();
    await assert.rejects(abandoned, /abort/i);

    await msg(s, s.alpha, { to: 'lane-beta', body: 'after the disconnect' });
    const next = await inbox(s, s.beta, '?lane=lane-beta&wait=1');
    assert.equal(next.status, 200);
    assert.notEqual(next.body.closed, true, 'the abandoned poll no longer holds the token');
    assert.deepEqual(bodies(next), ['after the disconnect']);
  } finally { await s.close(); }
});

test('messages are not journal events: the journal, the reducer and the board seq are untouched', async () => {
  const s = await startSeeded();
  const dir = s.dataDir;
  try {
    const before = s.board.state.seq;
    await msg(s, s.alpha, { to: 'lane-beta', body: 'not an event' });
    await msg(s, OWNER, { to: 'all', body: 'still not an event' });
    assert.equal(s.board.state.seq, before, 'no journal event was appended');
    const journal = fs.readFileSync(path.join(dir, 'events.ndjson'), 'utf8');
    assert.ok(!journal.includes('not an event'), 'the body is not in the journal');
    assert.ok(!journal.includes('msg-'), 'no msg.op is in the journal');
    assert.deepEqual(s.board.events(OWNER, 0, 1000).filter(e => e.op.startsWith('msg')), []);
    const lines = fs.readFileSync(path.join(dir, 'messages.ndjson'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.deepEqual(lines.map(l => [l.from, l.to, l.body]), [['lane-alpha', 'lane-beta', 'not an event'], ['anh (owner)', 'all', 'still not an event']]);
  } finally { await s.close(); }

  // A fresh board on the same data dir replays the journal (no unknown msg op) and still sees the messages.
  const board = createBoard({ dataDir: dir, ownerToken: OWNER });
  const server = createServer(board);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    assert.equal(board.state.seq > 0, true);
    const url = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(`${url}/api/v1/inbox?lane=lane-beta`, { headers: { Authorization: `Bearer ${OWNER}` } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.messages.some(m => m.body === 'not an event'));
  } finally {
    server.closeAllConnections(); await new Promise(r => server.close(r)); board.close();
  }
});

test('ext edge: a scoped reporter sends and long-polls its own inbox; no state, no owner/coordinator', async () => {
  const clock = makeClock();
  const dir = tmpDir();
  const board = createBoard({ dataDir: dir, ownerToken: SCOPE_OWNER, now: clock.now });
  const t = seedScopeBoard(board, clock);
  const server = createServer(board);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const EXT = { 'X-Laneboard-Ext': '1' };
  const call = async (method, route, { bearer, body } = {}) => {
    const res = await fetch(url + route, { method, headers: { ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...EXT }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text(); let json = text; try { json = JSON.parse(text); } catch { /* text */ }
    return { status: res.status, body: json, text };
  };
  try {
    const sent = await call('POST', '/api/v1/msg', { bearer: t.alpha, body: { to: 'lane-beta', body: 'from the laptop lane' } });
    assert.equal(sent.status, 200, sent.text);
    const own = await call('GET', '/api/v1/inbox?lane=lane-alpha&wait=0', { bearer: t.alpha });
    assert.equal(own.status, 200);
    assert.equal(own.body.messages.find(m => m.body === 'from the laptop lane').from, 'lane-alpha');
    assert.equal((await call('GET', '/api/v1/inbox?lane=lane-beta&wait=0', { bearer: t.alpha })).status, 403);
    assert.equal((await call('GET', '/api/v1/state', { bearer: t.alpha })).status, 404, 'the edge still has no state route');
    for (const [name, tok] of [['owner', SCOPE_OWNER], ['coordinator', t.coord]]) {
      assert.equal((await call('POST', '/api/v1/msg', { bearer: tok, body: { to: 'lane-alpha', body: 'not allowed' } })).status, 403, name);
    }
    assert.equal((await call('POST', '/api/v1/msg', { body: { to: 'lane-alpha', body: 'no token' } })).status, 401);
  } finally {
    server.closeAllConnections(); await new Promise(r => server.close(r)); board.close();
  }
});

// ---- R2 fix round 2, item A: a link and the links as a whole are length-capped before anything is appended ----
const linkOf = bytes => 'https://example.test/' + 'a'.repeat(bytes - 'https://example.test/'.length);

test('a link longer than 2 KB is 413 link_too_long before the append, and the refusal never echoes it', async () => {
  const s = await startSeeded();
  try {
    assert.equal((await msg(s, s.alpha, { to: 'all', body: 'edge', links: [linkOf(2048)] })).status, 200, '2048 bytes is the largest accepted link');
    const file = path.join(s.dataDir, 'messages.ndjson');
    const before = fs.statSync(file).size;
    for (const bytes of [2049, 1_800_000]) {
      const r = await msg(s, s.alpha, { to: 'all', body: 'big link', links: [linkOf(bytes)] });
      assert.equal(r.status, 413, `${bytes} bytes`);
      assert.equal(r.body.error, 'link_too_long'); assert.equal(r.body.index, 0); assert.equal(r.body.max_bytes, 2048);
      assert.ok(JSON.stringify(r.body).length < 500, 'the reply does not echo the link');
    }
    assert.equal(fs.statSync(file).size, before, 'nothing was appended for the oversized links');
    // The second link is the oversized one: the index names it.
    const second = await msg(s, s.alpha, { to: 'all', body: 'second', links: ['https://example.test/ok', linkOf(3000)] });
    assert.equal(second.status, 413); assert.equal(second.body.index, 1);
    // A non-ASCII link counts bytes, not characters.
    const wide = await msg(s, s.alpha, { to: 'all', body: 'wide', links: ['https://example.test/' + 'é'.repeat(1100)] });
    assert.equal(wide.status, 413); assert.equal(wide.body.error, 'link_too_long');
  } finally { await s.close(); }
});

test('the links of one message may not pass 8 KB in total (413 links_too_long)', async () => {
  const s = await startSeeded();
  try {
    const four = Array.from({ length: 4 }, (_, i) => linkOf(2048).replace('/aa', `/${i}a`));
    assert.equal((await msg(s, s.alpha, { to: 'all', body: 'four big', links: four })).status, 200);
    const five = [...four, linkOf(2048)];
    const r = await msg(s, s.alpha, { to: 'all', body: 'five big', links: five });
    assert.equal(r.status, 413); assert.equal(r.body.error, 'links_too_long'); assert.equal(r.body.max_bytes, 8192);
  } finally { await s.close(); }
});

test('one token cannot fill the store: its worst day is a small fraction of maxBytes, and a minute of max-size sends stays tiny', async () => {
  // Worst accepted line = 8 KB body + 8 KB of links + the JSON envelope. At 200 messages a day that is the most one
  // sender lane can add; it must stay far under the 64 MB ceiling (the review measured 1.8 MB links filling it in 2 minutes).
  const worstLine = MAILBOX.bodyBytes + MAILBOX.linksBytes + 1024;
  assert.ok(MAILBOX.dailyPerLane * worstLine * 8 <= MAILBOX.maxBytes, `one sender-day (${MAILBOX.dailyPerLane * worstLine} bytes) must be <= 1/8 of ${MAILBOX.maxBytes}`);

  const s = await startSeeded();
  try {
    const file = path.join(s.dataDir, 'messages.ndjson');
    const base = fs.statSync(file).size;
    let accepted = 0, refused = 0;
    for (let i = 0; i < 40; i++) {
      const r = await msg(s, s.alpha, { to: 'all', body: 'b'.repeat(8192), links: [linkOf(1_800_000)] });
      if (r.status === 200) accepted++; else if (r.status === 413) refused++;
    }
    assert.equal(accepted, 0, 'a 1.8 MB link never reaches the store');
    assert.equal(refused, 30, 'the 30/min bucket still counts the attempts');
    assert.equal(fs.statSync(file).size, base, 'the file did not grow');
    const fat = Array.from({ length: 4 }, (_, i) => linkOf(2048).replace('/aa', `/${i}a`));
    const s2 = await startSeeded();
    try {
      const f2 = path.join(s2.dataDir, 'messages.ndjson');
      const b2 = fs.statSync(f2).size;
      for (let i = 0; i < 30; i++) assert.equal((await msg(s2, s2.alpha, { to: 'all', body: 'b'.repeat(8192), links: fat })).status, 200);
      assert.ok(fs.statSync(f2).size - b2 <= 30 * worstLine, 'thirty max-size sends in one minute add at most 30 worst lines');
      assert.ok(fs.statSync(f2).size < MAILBOX.maxBytes / 50, 'and that is under 2% of the store ceiling');
    } finally { await s2.close(); }
  } finally { await s.close(); }
});
