// A reporter token reads only its scope_tasks (every read path) and is rate limited on writes.
// Golden: test/golden/reporter-scope-views.json holds the owner, coordinator, reporter('*') and anonymous views as the
// code before this change (2b790b0) produced them from the same seed; the change must not move a byte of them.
// Regenerate only on purpose, from a tree at the new baseline, with the generator that wrote it (same seed, same clock).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBoard, DEFAULTS } from '../src/board.mjs';
import { createServer } from '../src/server.mjs';
import { createLegacyCompat } from '../src/legacy-compat.mjs';
import { tmpDir } from './helpers.mjs';
import { OWNER, MARK, makeClock, seedScopeBoard } from './reporter-scope-seed.mjs';

const GOLDEN = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'golden', 'reporter-scope-views.json'), 'utf8'));

async function setup(opts = {}) {
  const clock = makeClock(), dataDir = opts.dataDir || tmpDir();
  const { dataDir: _d, ...boardOpts } = opts;
  const board = createBoard({ dataDir, ownerToken: OWNER, now: clock.now, ...boardOpts });
  const t = seedScopeBoard(board, clock);
  const tokenFile = path.join(tmpDir(), 'coord.token'); fs.writeFileSync(tokenFile, t.coord);
  const legacyCompat = createLegacyCompat(board, { tokenFile, dataDir, mediaDir: '' });
  const server = createServer(board, { legacyCompat });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const get = async (route, token) => {
    const res = await fetch(url + route, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    const text = await res.text(); let body = text; try { body = JSON.parse(text); } catch { /* bytes */ }
    return { status: res.status, body, text };
  };
  let n = 0;
  const submit = async (token, task = 'WEB-3', extra = {}) => {
    const res = await fetch(url + '/api/v1/write', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: 1, request_id: `scope-flood-${String(++n).padStart(4, '0')}`, op: 'inbox.submit', target_id: task, data: { kind: 'report', text: 'x' }, ...extra }) });
    return { status: res.status, body: await res.json() };
  };
  const close = async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); board.close(); };
  const post = async (token, op, target_id, data) => {
    const res = await fetch(url + '/api/v1/write', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: 1, request_id: `scope-post-${String(++n).padStart(4, '0')}`, op, target_id, data }) });
    return { status: res.status, body: await res.json() };
  };
  return { board, clock, t, dataDir, get, submit, post, close };
}
const ids = list => list.map(x => x.id).sort();

test('golden: owner, coordinator, reporter with scope * and anonymous views are byte-identical to the baseline', async () => {
  const s = await setup();
  try {
    assert.deepEqual(JSON.parse(JSON.stringify(s.board.view(OWNER))), GOLDEN.owner);
    assert.deepEqual(JSON.parse(JSON.stringify(s.board.view(s.t.coord))), GOLDEN.coordinator);
    assert.deepEqual(JSON.parse(JSON.stringify(s.board.view(s.t.star))), GOLDEN.reporter_star);
    assert.deepEqual(JSON.parse(JSON.stringify(s.board.view(undefined))), GOLDEN.anonymous);
    assert.equal(JSON.stringify(s.board.view(OWNER)), JSON.stringify(GOLDEN.owner), 'same bytes, not only same values');
  } finally { await s.close(); }
});

test('a reporter scoped to WEB-3 sees nothing of API-2 in /api/v1/state', async () => {
  const s = await setup();
  try {
    const r = await s.get('/api/v1/state', s.t.alpha);
    assert.equal(r.status, 200);
    assert.ok(!r.text.includes(MARK), 'no API-2 text anywhere in the view');
    assert.ok(!r.text.includes('API-2'), 'no API-2 id anywhere in the view');
    const v = r.body;
    assert.deepEqual(v.tasks.map(t => t.id), ['WEB-3']);
    assert.ok(v.tasks[0].steps.length === 2 && v.tasks[0].steps.every(st => st.id.startsWith('WEB-3/')));
    for (const k of ['asks', 'feedback', 'messages', 'attachments', 'inbox']) {
      assert.ok(v[k].length > 0, `${k} still carries WEB-3 records`);
      assert.ok(v[k].every(x => x.task_id === 'WEB-3'), `${k} is WEB-3 only`);
    }
    assert.deepEqual(Object.keys(v.goals), ['WEB-3']);
    assert.deepEqual(Object.keys(v.plans), ['WEB-3']);
    assert.deepEqual(Object.keys(v.routing), []);
    assert.deepEqual(Object.keys(v.task_times), ['WEB-3']);
    assert.ok(Object.keys(v.times).every(k => k.startsWith('WEB-3/')));
    assert.ok(v.pings.length > 0 && v.pings.every(p => p.task_id === 'WEB-3'));
    assert.equal(v.docs.summary, undefined, 'the board-wide summary is not a scoped record');
    assert.deepEqual(v.docs.registry.entries.map(e => e.code), ['WEB-3']);
    assert.ok(v.attention.waiting.length > 0 && v.attention.waiting.every(w => w.task_id === 'WEB-3'));
    assert.ok(v.attention.answered.every(a => a.task_id === 'WEB-3'));
    assert.ok(v.stalled.every(x => x.task_id === 'WEB-3') && v.stale_text.every(x => x.task_id === 'WEB-3'));
    assert.deepEqual(v.me.scope_tasks, ['WEB-3'], 'its own identity is unchanged');
  } finally { await s.close(); }
});

test('the other reporter sees the mirror image; a two-task scope sees both; scope * sees all', async () => {
  const s = await setup();
  try {
    const beta = (await s.get('/api/v1/state', s.t.beta)).body;
    assert.deepEqual(beta.tasks.map(t => t.id), ['API-2']);
    assert.ok(!JSON.stringify(beta).includes('WEB-3') && !JSON.stringify(beta).includes('Landing page'));
    assert.deepEqual((await s.get('/api/v1/state', s.t.both)).body.tasks.map(t => t.id), ['API-2', 'WEB-3']);
    assert.deepEqual((await s.get('/api/v1/state', s.t.star)).body.tasks.map(t => t.id), ['API-2', 'WEB-3']);
    assert.deepEqual(ids((await s.get('/api/v1/state', s.t.coord)).body.asks), ids((await s.get('/api/v1/state', OWNER)).body.asks));
  } finally { await s.close(); }
});

test('attachments: a reporter reads the bytes of its own task only, by header and by link', async () => {
  const s = await setup();
  try {
    assert.equal((await s.get(`/api/v1/media/${s.t.attWeb}`, s.t.alpha)).text, 'web bytes');
    assert.equal((await s.get(`/api/v1/media/${s.t.attApi}`, s.t.alpha)).status, 404);
    assert.equal((await s.get(`/api/v1/media/${s.t.attApi}/link`, s.t.alpha)).status, 404);
    assert.equal((await s.get(`/api/v1/media/${s.t.attWeb}/link`, s.t.alpha)).status, 200);
    assert.equal((await s.get(`/api/v1/media/${s.t.attApi}`, s.t.coord)).text, `api bytes ${MARK}`, 'coordinator unchanged');
    assert.equal((await s.get(`/api/v1/media/${s.t.attApi}`, OWNER)).text, `api bytes ${MARK}`, 'owner unchanged');
    assert.equal((await s.get(`/api/v1/media/${s.t.attApi}`, s.t.star)).text, `api bytes ${MARK}`, 'reporter with scope * unchanged');
  } finally { await s.close(); }
});

test('the predecessor routes (/api/state, ?v=2, /api/times) refuse a reporter token and answer everyone else as before', async () => {
  const s = await setup();
  try {
    for (const route of ['/api/state', '/api/state?v=2', '/api/times']) {
      assert.equal((await s.get(route, s.t.alpha)).status, 403, `${route} for a reporter`);
      assert.equal((await s.get(route, s.t.star)).status, 403, `${route} for a reporter with scope *`);
      assert.equal((await s.get(route, s.t.coord)).status, 200, `${route} for the coordinator`);
      assert.equal((await s.get(route, OWNER)).status, 200, `${route} for the owner`);
      assert.equal((await s.get(route)).status, 200, `${route} with no token (nginx basic auth is its gate)`);
    }
    const r = await s.get('/api/state', s.t.alpha);
    assert.ok(!r.text.includes(MARK));
  } finally { await s.close(); }
});

test('the other read paths still refuse a reporter: events and tokens', async () => {
  const s = await setup();
  try {
    for (const route of ['/api/v1/events', '/api/v1/tokens']) assert.equal((await s.get(route, s.t.alpha)).status, 403, route);
    assert.equal((await s.get('/api/v1/whoami', s.t.alpha)).body.scope_tasks[0], 'WEB-3');
  } finally { await s.close(); }
});

test('rate limit: a reporter token gets 429 after reporterWritesPerMin attempts in a minute, and its window slides', async () => {
  const s = await setup({ reporterWritesPerMin: 3 });
  try {
    s.clock.tick(61000); // the seed's own reporter writes are out of the window
    for (let i = 0; i < 3; i++) assert.equal((await s.submit(s.t.alpha)).status, 200, `write ${i + 1}`);
    const over = await s.submit(s.t.alpha);
    assert.equal(over.status, 429);
    assert.equal(over.body.error, 'rate_limited');
    assert.equal(over.body.limit_per_minute, 3);
    assert.ok(over.body.retry_after_s >= 1 && over.body.retry_after_s <= 60);
    assert.equal((await s.get('/api/v1/state', s.t.alpha)).status, 200, 'reads are not limited');
    assert.equal((await s.submit(s.t.beta, 'API-2')).status, 200, 'another token has its own budget');
    s.clock.tick(61000);
    assert.equal((await s.submit(s.t.alpha)).status, 200, 'a minute later the budget is back');
  } finally { await s.close(); }
});

test('rate limit: refused writes (out of scope, invalid) use the budget too; owner and coordinator are never limited', async () => {
  const s = await setup({ reporterWritesPerMin: 3 });
  try {
    s.clock.tick(61000); // the seed's own reporter writes are out of the window
    assert.equal((await s.submit(s.t.alpha, 'API-2')).status, 403, 'out of scope');
    assert.equal((await s.submit(s.t.alpha, 'WEB-3', { data: { kind: 'nope' } })).status, 400, 'invalid data');
    assert.equal((await s.submit(s.t.alpha)).status, 200);
    assert.equal((await s.submit(s.t.alpha)).status, 429, 'the two refused ones counted');
    for (let i = 0; i < 10; i++) {
      assert.equal((await s.submit(s.t.coord)).status, 200, 'coordinator');
      assert.equal((await s.submit(OWNER)).status, 200, 'owner');
    }
  } finally { await s.close(); }
});

test('rate limit default: 30 per minute, a constant in DEFAULTS', async () => {
  assert.equal(DEFAULTS.reporterWritesPerMin, 30);
  const s = await setup();
  try {
    s.clock.tick(61000);
    const codes = [];
    for (let i = 0; i < 32; i++) codes.push((await s.submit(s.t.alpha)).status);
    assert.equal(codes.filter(c => c === 200).length, 30);
    assert.deepEqual(codes.slice(30), [429, 429]);
  } finally { await s.close(); }
});

test('a scoped reporter is authorised and scope-checked BEFORE its data is validated: no error detail describes another task', async () => {
  const s = await setup();
  try {
    s.clock.tick(61000);
    const missing = 'ZZ-99'; // a task that does not exist
    // an op reporters may not use: the same refusal whatever the target
    const a = await s.post(s.t.alpha, 'task.update', 'API-2', { status: 'waiting' }); // API-2 has an open ask: the honesty rules would answer differently
    const b = await s.post(s.t.alpha, 'task.update', missing, { status: 'waiting' });
    assert.equal(a.status, 403); assert.deepEqual(a.body, b.body);
    const c = await s.post(s.t.alpha, 'step.update', 'API-2/s1', { state: 'done' });
    assert.equal(c.status, 403); assert.ok(!JSON.stringify(c.body).includes('API-2'), 'the refusal does not echo the other task');
    // an allowed op with bad data: out of scope or missing task -> the same 403, no schema errors; in scope -> the schema answer
    const d = await s.post(s.t.alpha, 'inbox.submit', 'API-2', { kind: 'nope' });
    const e = await s.post(s.t.alpha, 'inbox.submit', missing, { kind: 'nope' });
    assert.equal(d.status, 403); assert.equal(d.body.error, 'out_of_scope'); assert.equal(d.body.errors, undefined);
    assert.equal(e.status, 403); assert.equal(e.body.error, 'out_of_scope'); assert.equal(e.body.errors, undefined);
    const f = await s.post(s.t.alpha, 'inbox.submit', 'WEB-3', { kind: 'nope' });
    assert.equal(f.status, 400); assert.equal(f.body.error, 'invalid_data');
    // other roles keep their old order: the owner still gets the schema answer first
    assert.equal((await s.post(OWNER, 'inbox.submit', 'API-2', { kind: 'nope' })).status, 400);
  } finally { await s.close(); }
});

test('revocation holds: a revoked reporter token is refused at once and after a restart on the same journal', async () => {
  const s = await setup();
  const dataDir = s.dataDir;
  try {
    s.clock.tick(61000);
    const me = (await s.get('/api/v1/whoami', s.t.alpha)).body;
    assert.equal((await s.post(OWNER, 'token.revoke', me.token_id, {})).status, 200);
    assert.equal((await s.get('/api/v1/whoami', s.t.alpha)).status, 401);
    assert.equal((await s.submit(s.t.alpha)).status, 401);
    const anon = (await s.get('/api/v1/state', s.t.alpha)).body;
    assert.equal(anon.me, null, 'a revoked bearer reads as anonymous (public records only), never as the reporter');
    assert.ok(!JSON.stringify(anon).includes('Landing page'), 'no private task');
    assert.equal((await s.get(`/api/v1/media/${s.t.attWeb}`, s.t.alpha)).status, 404);
  } finally { await s.close(); }
  const again = createBoard({ dataDir, ownerToken: OWNER, now: makeClock().now });
  try {
    assert.equal(again.authenticate(s.t.alpha), null, 'still revoked after replay');
    assert.ok(again.authenticate(s.t.beta), 'the other reporter lives');
  } finally { again.close(); }
});
