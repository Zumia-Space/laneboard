// The external edge: a request carrying X-Laneboard-Ext (set by the proxy's /laneboard/ext/api/v1/ location only) is an outsider.
// The critical case is owner escalation: server.mjs treats a no-bearer loopback request with the right X-Laneboard-Owner-Proxy as
// the OWNER. These tests send that exact request (the real secret, from loopback) and prove it is not the owner on the edge,
// with a control that proves the same request IS the owner without the marker (so the probe can see an escalation).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBoard } from '../src/board.mjs';
import { createServer } from '../src/server.mjs';
import { tmpDir } from './helpers.mjs';
import { OWNER, makeClock, seedScopeBoard } from './reporter-scope-seed.mjs';

const SECRET = 'owner-proxy-secret-0123456789-abcdefghijklmnop';
const EXT = { 'X-Laneboard-Ext': '1' };

async function setup() {
  const clock = makeClock(), board = createBoard({ dataDir: tmpDir(), ownerToken: OWNER, now: clock.now });
  const t = seedScopeBoard(board, clock);
  clock.tick(61000);
  const server = createServer(board, { ownerProxySecret: SECRET });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); // loopback peer, like the proxy on the same host
  const url = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, route, { headers = {}, bearer, body } = {}) => {
    const res = await fetch(url + route, { method, headers: { ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text(); let json = text; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, body: json, text };
  };
  let n = 0;
  const submit = (bearer, task, op = 'inbox.submit', data = { kind: 'report', text: 'from outside' }) =>
    call('POST', '/api/v1/write', { headers: EXT, bearer, body: { version: 1, request_id: `ext-req-${String(++n).padStart(4, '0')}`, op, target_id: task, data } });
  const close = async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); board.close(); };
  return { board, t, call, submit, close };
}

test('control: without the marker, the owner-proxy header on a no-bearer loopback request IS the owner (the probe can see an escalation)', async () => {
  const s = await setup();
  try {
    const r = await s.call('GET', '/api/v1/whoami', { headers: { 'X-Laneboard-Owner-Proxy': SECRET } });
    assert.equal(r.status, 200); assert.equal(r.body.role, 'owner');
  } finally { await s.close(); }
});

test('on the edge, the real owner-proxy secret with no bearer is never the owner, for whoami and for write', async () => {
  const s = await setup();
  try {
    const proxy = { ...EXT, 'X-Laneboard-Owner-Proxy': SECRET, 'X-Requested-With': 'laneboard' };
    assert.equal((await s.call('GET', '/api/v1/whoami', { headers: proxy })).status, 401);
    const w = await s.call('POST', '/api/v1/write', { headers: proxy, body: { version: 1, request_id: 'ext-owner-0001', op: 'task.create', target_id: 'EVIL-1', data: { title: 'x' } } });
    assert.equal(w.status, 401);
    assert.equal(s.board.state.tasks['EVIL-1'], undefined, 'nothing was written');
    const forged = { ...EXT, 'X-Laneboard-Owner-Proxy': 'f'.repeat(48) };
    assert.equal((await s.call('GET', '/api/v1/whoami', { headers: forged })).status, 401);
  } finally { await s.close(); }
});

test('on the edge, the owner-proxy header and X-Laneboard-Token never override the reporter bearer', async () => {
  const s = await setup();
  try {
    const r = await s.call('GET', '/api/v1/whoami', { headers: { ...EXT, 'X-Laneboard-Owner-Proxy': SECRET, 'X-Laneboard-Token': OWNER }, bearer: s.t.alpha });
    assert.equal(r.status, 200); assert.equal(r.body.role, 'reporter'); assert.equal(r.body.name, 'lane-alpha');
    assert.deepEqual(Object.keys(r.body).sort(), ['name', 'role', 'scope_tasks', 'token_id'], 'whoami on the edge: principal, role and scope only');
    assert.deepEqual(r.body.scope_tasks, ['WEB-3']);
    assert.equal((await s.call('GET', '/api/v1/whoami', { headers: { ...EXT, 'X-Laneboard-Token': OWNER } })).status, 401, 'X-Laneboard-Token alone is not an identity on the edge');
    assert.equal((await s.call('GET', '/api/v1/whoami', { headers: { 'X-Laneboard-Token': OWNER } })).body.role, 'owner', 'control: it is one without the marker');
  } finally { await s.close(); }
});

test('on the edge, only a reporter token is accepted: owner and coordinator get 403, no bearer 401, unknown 401', async () => {
  const s = await setup();
  try {
    for (const [name, tok] of [['owner', OWNER], ['coordinator', s.t.coord]]) {
      const r = await s.call('GET', '/api/v1/whoami', { headers: EXT, bearer: tok });
      assert.equal(r.status, 403, name); assert.deepEqual(r.body, { error: 'forbidden_on_ext' }, 'no role echoed');
      assert.equal((await s.submit(tok, 'WEB-3')).status, 403, `${name} write`);
    }
    assert.equal((await s.call('GET', '/api/v1/whoami', { headers: EXT })).status, 401);
    assert.equal((await s.call('GET', '/api/v1/whoami', { headers: EXT, bearer: 'lb_' + 'x'.repeat(43) })).status, 401);
    assert.equal((await s.call('GET', '/api/v1/whoami', { headers: EXT, bearer: s.t.alpha })).status, 200);
  } finally { await s.close(); }
});

test('on the edge, only inbox.submit is writable, and only inside the token scope; the audit actor is the reporter token', async () => {
  const s = await setup();
  try {
    const ok = await s.submit(s.t.alpha, 'WEB-3');
    assert.equal(ok.status, 200);
    const ev = s.board.events(OWNER, 0, 1000).find(e => e.id === ok.body.event_id);
    assert.equal(ev.actor.name, 'lane-alpha'); assert.equal(ev.actor.role, 'reporter'); assert.equal(ev.op, 'inbox.submit');
    const oos = await s.submit(s.t.alpha, 'API-2');
    assert.equal(oos.status, 403); assert.equal(oos.body.error, 'out_of_scope');
    for (const op of ['attachment.add', 'prefs.set', 'task.create', 'token.issue']) {
      const r = await s.submit(s.t.alpha, 'WEB-3', op, {});
      assert.equal(r.status, 403, op); assert.equal(r.body.error, 'op_not_allowed_on_ext', op);
    }
  } finally { await s.close(); }
});

test('on the edge, every other path or method does not exist (404), whatever the token', async () => {
  const s = await setup();
  try {
    for (const [m, route] of [['GET', '/api/v1/state'], ['GET', '/api/v1/events'], ['GET', '/api/v1/tokens'], ['GET', `/api/v1/media/${s.t.attWeb}`], ['GET', '/api/state'], ['GET', '/healthz'], ['GET', '/'],
      ['GET', '/api/v1/write'], ['POST', '/api/v1/whoami'], ['POST', '/api/v1/upload'], ['GET', '/schema/v1/write-request.json']]) {
      const r = await s.call(m, route, { headers: EXT, bearer: s.t.alpha });
      assert.equal(r.status, 404, `${m} ${route}`);
      assert.ok(!/"tasks"|WEB-3/.test(r.text), `${m} ${route} carries no board data`);
    }
  } finally { await s.close(); }
});

test('the marker only restricts: without it nothing changes (owner whoami, lane write of another op)', async () => {
  const s = await setup();
  try {
    assert.equal((await s.call('GET', '/api/v1/whoami', { bearer: OWNER })).body.role, 'owner');
    assert.equal((await s.call('GET', '/api/v1/state', { bearer: s.t.alpha })).status, 200);
  } finally { await s.close(); }
});
