// J-05 D3 (owner 01-11): a token issued for a device (a phone) cannot mint, revoke or escalate, and a revoked token's
// minted children stop working (cascade). Measured flaw: GATE-BRIDGE-OPUS.md §2 probe steps 2, 3, 6, 8.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSeeded, OWNER, tmpDir, rid } from './helpers.mjs';
import { createBoard } from '../src/board.mjs';
import { createServer } from '../src/server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Board administration (owner 01-11 D3 + coordinator follow-up): tokens, role slots, notify, and the migration/freshness ops.
const DEVICE_REFUSED = ['token.issue', 'token.revoke', 'roles.set', 'roles.reset', 'roles.escalate', 'roles.override', 'notify.set', 'times.import', 'goals.import', 'freshness.set'];
const PROXY_SECRET = 'proxy-secret-for-tests-0123456789abcdef';

const issue = async (s, by, name, data) => { const r = await s.write(by, 'token.issue', name, data); assert.equal(r.status, 200, r.body?.error); return r.body; };
const tokenId = async (s, name) => (await s.call(OWNER, 'GET', '/api/v1/tokens')).body.find(t => t.name === name && !t.revoked_at)?.id;
const whoStatus = async (s, tok) => (await s.call(tok, 'GET', '/api/v1/whoami')).status;

/** A server whose loopback requests may carry the owner-proxy header, as nginx sends it after Basic auth. */
async function startProxied() {
  const dataDir = tmpDir();
  const board = createBoard({ dataDir, ownerToken: OWNER });
  const server = createServer(board, { ownerProxySecret: PROXY_SECRET });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const headersFor = who => who === 'proxy' ? { 'X-Laneboard-Owner-Proxy': PROXY_SECRET, 'X-Requested-With': 'laneboard' } : { Authorization: `Bearer ${who}` };
  const call = async (who, method, route, body) => {
    const res = await fetch(url + route, { method, headers: { ...headersFor(who), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const write = (who, op, target_id, data = {}) => call(who, 'POST', '/api/v1/write', { version: 1, request_id: rid(), op, target_id, data });
  const close = async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); board.close(); };
  return { url, dataDir, board, call, write, close };
}

test('a device token is refused token.issue (403 forbidden_for_device) and nothing is journaled', async () => {
  const s = await startSeeded();
  try {
    const phone = (await issue(s, OWNER, 'phone-1', { role: 'owner', label: 'phone-1', device: true })).token;
    const seq = s.board.state.seq;
    const r = await s.write(phone, 'token.issue', 'attacker-backdoor', { role: 'owner', label: 'x' });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'forbidden_for_device');
    assert.equal(s.board.state.seq, seq, 'no event written');
    assert.equal(await tokenId(s, 'attacker-backdoor'), undefined);
  } finally { await s.close(); }
});

test('a device token is refused token.revoke, even of itself, and tok-1 keeps working', async () => {
  const s = await startSeeded();
  try {
    const phone = (await issue(s, OWNER, 'phone-1', { role: 'owner', device: true })).token;
    const r = await s.write(phone, 'token.revoke', 'tok-1');
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'forbidden_for_device');
    assert.equal(await whoStatus(s, OWNER), 200, 'the owner bootstrap token still works');
    assert.equal((await s.write(phone, 'token.revoke', await tokenId(s, 'phone-1'))).status, 403);
  } finally { await s.close(); }
});

test('a device token is refused every op marked x-device:false, and still does ordinary work', async () => {
  const s = await startSeeded();
  try {
    const phone = (await issue(s, OWNER, 'phone-1', { role: 'owner', device: true })).token;
    const bodies = {
      'token.issue': ['x-1', { role: 'reporter' }], 'token.revoke': ['tok-1', {}],
      'roles.set': ['WEB-3', { role: 'review', model: 'opus', effort: 'high' }], 'roles.reset': ['WEB-3', { role: 'review' }],
      'roles.escalate': ['WEB-3', { gate: 'S1 render', reason: 'r' }], 'roles.override': ['WEB-3', { reason: 'r' }],
      'notify.set': ['board', { coordinator_feedback: true }],
      // valid-shaped data where it is small; the device rule runs before data validation either way
      'times.import': ['WEB-3', { steps: {} }], 'goals.import': ['WEB-3', { goal: 'g', output: 'o', outcome: 'c', version: 1, locked_at: '2026-11-01T00:00:00.000Z' }],
      'freshness.set': ['board', { stale_h: 24 }]
    };
    for (const op of DEVICE_REFUSED) {
      const [target, data] = bodies[op];
      const r = await s.write(phone, op, target, data);
      assert.equal(r.status, 403, `${op}: ${r.body?.error}`);
      assert.equal(r.body.error, 'forbidden_for_device', op);
    }
    assert.equal((await s.write(phone, 'inbox.submit', 'WEB-3', { kind: 'report', text: 'from the phone' })).status, 200, 'ordinary owner work still goes through');
    assert.equal((await s.write(OWNER, 'roles.set', 'WEB-3', { role: 'review', model: 'opus', effort: 'high' })).status, 200, 'the same op from a non-device owner is accepted');
  } finally { await s.close(); }
});

test('whoami and the token list say device:true; a token issued without it has no device field', async () => {
  const s = await startSeeded();
  try {
    const phone = (await issue(s, OWNER, 'phone-1', { role: 'owner', device: true })).token;
    assert.equal((await s.call(phone, 'GET', '/api/v1/whoami')).body.device, true);
    assert.equal((await s.call(OWNER, 'GET', '/api/v1/whoami')).body.device, undefined);
    const list = (await s.call(OWNER, 'GET', '/api/v1/tokens')).body;
    assert.equal(list.find(t => t.name === 'phone-1').device, true);
    assert.equal(list.find(t => t.name === 'coordinator').device, undefined);
  } finally { await s.close(); }
});

test('cascade: revoking a token revokes every token it minted, transitively (probe step 8)', async () => {
  const s = await startSeeded();
  try {
    const a = (await issue(s, OWNER, 'leaked-a', { role: 'owner' })).token;
    const b = (await issue(s, a, 'backdoor-b', { role: 'owner' })).token;
    const c = (await issue(s, b, 'backdoor-c', { role: 'reporter', lane: 'lane-c' })).token;
    const sibling = (await issue(s, OWNER, 'sibling', { role: 'owner' })).token;
    const aId = await tokenId(s, 'leaked-a');
    const r = await s.write(OWNER, 'token.revoke', aId, {});
    assert.equal(r.status, 200);
    for (const t of [a, b, c]) assert.equal(await whoStatus(s, t), 401, 'the leaked token and its whole lineage are cut off');
    assert.equal(await whoStatus(s, sibling), 200, 'a token minted by someone else is untouched');
    assert.equal(await whoStatus(s, s.coord), 200, 'the coordinator is untouched');
    const events = (await s.call(OWNER, 'GET', '/api/v1/events?after=0&limit=1000')).body;
    const revoke = events.filter(e => e.op === 'token.revoke').at(-1);
    assert.equal(revoke.data.cascade.length, 2, 'the cascade is journaled with the revoke, so replay applies exactly it');
  } finally { await s.close(); }
});

test('cascade: tokens minted through the owner login (proxy) have no parent and survive any token revoke', async () => {
  const s = await startProxied();
  try {
    const coord = await s.write('proxy', 'token.issue', 'coordinator', { role: 'coordinator', lane: 'CoS' });
    assert.equal(coord.status, 200);
    assert.equal(s.board.state.tokens[coord.body.id].parent, undefined, 'a proxy mint records no parent');
    const bearerMint = await s.write(OWNER, 'token.issue', 'from-bearer', { role: 'reporter', lane: 'lane-x' });
    assert.equal(s.board.state.tokens[bearerMint.body.id].parent, 'tok-1', 'a bearer mint records the minting token');
    const viaProxyIssue = await s.write('proxy', 'token.issue', 'desk-2', { role: 'owner' }); // keeps an owner for the proxy
    assert.equal(viaProxyIssue.status, 200);
    assert.equal((await s.write(OWNER, 'token.revoke', 'tok-1')).status, 200);
    assert.equal((await s.call(coord.body.token, 'GET', '/api/v1/whoami')).status, 200, 'the coordinator minted via the login survives');
    assert.equal((await s.call(bearerMint.body.token, 'GET', '/api/v1/whoami')).status, 401, 'the bearer-minted child of tok-1 is revoked');
  } finally { await s.close(); }
});

test('the owner login (proxy) never resolves to a device token (probe step 6)', async () => {
  const s = await startProxied();
  try {
    assert.equal((await s.write('proxy', 'token.issue', 'phone-1', { role: 'owner', device: true })).status, 200);
    assert.equal((await s.write(OWNER, 'token.revoke', 'tok-1')).status, 200);
    assert.equal((await s.call('proxy', 'GET', '/api/v1/whoami')).status, 401, 'with only a device owner token left, the login is not that device');
  } finally { await s.close(); }
  // A second board: a non-device owner issued after the phone is the login's identity.
  const s2 = await startProxied();
  try {
    await s2.write('proxy', 'token.issue', 'phone-1', { role: 'owner', device: true });
    const desk = await s2.write('proxy', 'token.issue', 'desk', { role: 'owner' });
    assert.equal((await s2.write(OWNER, 'token.revoke', 'tok-1')).status, 200);
    const me = (await s2.call('proxy', 'GET', '/api/v1/whoami')).body;
    assert.equal(me.token_id, desk.body.id);
    assert.equal(me.device, undefined);
    assert.equal((await s2.write('proxy', 'token.issue', 'still-owner', { role: 'reporter', lane: 'l' })).status, 200, 'the login keeps owner power');
  } finally { await s2.close(); }
});

test('replay from the journal yields the same device and cascade state', async () => {
  const s = await startSeeded();
  const dataDir = s.dataDir;
  const a = (await issue(s, OWNER, 'a', { role: 'owner' })).token;
  await issue(s, a, 'b', { role: 'owner', device: true });
  await s.write(OWNER, 'token.revoke', await tokenId(s, 'a'), {});
  const before = JSON.parse(JSON.stringify(s.board.state.tokens));
  await s.close();
  fs.rmSync(path.join(dataDir, 'state.json'));
  const again = createBoard({ dataDir, ownerToken: OWNER });
  try { assert.deepEqual(again.state.tokens, before); } finally { again.close(); }
});

test('schema/v1/index.json device flags equal the op schemas x-device, and AGENTS.md documents the rule', () => {
  const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'schema', 'v1', 'index.json'), 'utf8'));
  const refused = Object.keys(index.ops).filter(op => JSON.parse(fs.readFileSync(path.join(ROOT, 'schema', 'v1', 'ops', `${op}.json`), 'utf8'))['x-device'] === false);
  assert.deepEqual(refused.sort(), [...DEVICE_REFUSED].sort());
  for (const op of Object.keys(index.ops)) assert.equal(index.ops[op].device === false, DEVICE_REFUSED.includes(op), op);
  const agents = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
  assert.ok(agents.includes('forbidden_for_device'), 'AGENTS.md names the device refusal');
  assert.ok(/cascade/i.test(agents), 'AGENTS.md documents the revoke cascade');
});
