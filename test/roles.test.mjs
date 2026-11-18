// Identity and permissions are enforced by the server, from the token alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startSeeded, OWNER } from './helpers.mjs';

test('writes without a valid token are rejected', async () => {
  const s = await startSeeded();
  try {
    assert.equal((await s.write(null, 'task.create', 'X-1', { title: 'x' })).status, 401);
    assert.equal((await s.write('lb_forged', 'task.create', 'X-1', { title: 'x' })).status, 401);
    assert.equal((await s.call(null, 'GET', '/api/v1/whoami')).status, 401);
  } finally { await s.close(); }
});

test('reporters cannot write task or step state, answer, route, or administer tokens', async () => {
  const s = await startSeeded();
  try {
    const denied = [
      ['task.create', 'NEW-1', { title: 'x' }, {}],
      ['task.update', 'WEB-3', { status: 'closed' }, { expected_revision: 1 }],
      ['step.update', 'WEB-3/s2', { state: 'done' }, { expected_revision: 1 }],
      ['step.create', 'WEB-3/s9', { label: 'x', zone: 'build', state: 'todo' }, {}],
      ['ask.raise', 'WEB-3', { text: 'x' }, {}],
      ['feedback.add', 'WEB-3', { kind: 'note', text: 'x' }, {}],
      ['routing.set', 'WEB-3', { model: 'opus', effort: 'max' }, {}],
      ['token.issue', 'evil', { role: 'owner' }, {}],
      ['token.revoke', 'tok-1', {}, {}]
    ];
    for (const [op, target, data, extra] of denied) {
      const r = await s.write(s.alpha, op, target, data, extra);
      assert.equal(r.status, 403, `${op} -> ${r.status}`);
      assert.equal(r.body.error, 'forbidden_for_role');
    }
    const st = await s.state(OWNER);
    assert.equal(st.tasks.find(t => t.id === 'WEB-3').steps[1].state, 'active', 'state unchanged');
  } finally { await s.close(); }
});

test('reporters submit into the inbox only within their scope', async () => {
  const s = await startSeeded();
  try {
    assert.equal((await s.write(s.alpha, 'inbox.submit', 'WEB-3', { kind: 'report', text: 'ok' })).status, 200);
    const cross = await s.write(s.alpha, 'inbox.submit', 'API-2', { kind: 'ask', text: 'sneaky' });
    assert.equal(cross.status, 403); assert.equal(cross.body.error, 'out_of_scope');
    const crossAttach = await s.write(s.beta, 'attachment.add', 'WEB-3', { name: 'a.txt', mime: 'text/plain', data_base64: Buffer.from('x').toString('base64') });
    assert.equal(crossAttach.status, 403);
    const merge = await s.write(s.alpha, 'inbox.merge', 'inb-1', { action: 'accept' }, { expected_revision: 1 });
    assert.equal(merge.status, 403, 'reporters cannot merge inbox items');
  } finally { await s.close(); }
});

test('the coordinator writes state but cannot take owner-only actions', async () => {
  const s = await startSeeded();
  try {
    const ask = (await s.write(s.coord, 'ask.raise', 'WEB-3', { text: 'A or B?', options: [{ key: 'A', label: 'a' }] })).body;
    let r = await s.write(s.coord, 'ask.answer', ask.id, { choice: 'A' }, { expected_revision: 1 });
    assert.equal(r.status, 403);
    r = await s.write(s.coord, 'routing.set', 'WEB-3', { model: 'opus', effort: 'high' });
    assert.equal(r.status, 403);
    r = await s.write(s.coord, 'token.issue', 'helper', { role: 'reporter' });
    assert.equal(r.status, 403);
    r = await s.write(s.coord, 'feedback.add', 'WEB-3', { kind: 'approve', text: 'I approve on behalf of the owner' });
    assert.equal(r.status, 403); assert.equal(r.body.error, 'owner_only_kind');
    r = await s.write(OWNER, 'ask.answer', ask.id, { choice: 'Z' }, { expected_revision: 1 });
    assert.equal(r.status, 400, 'owner must pick an existing option'); assert.equal(r.body.error, 'unknown_choice');
    r = await s.write(OWNER, 'ask.answer', ask.id, { choice: 'A' }, { expected_revision: 1 });
    assert.equal(r.status, 200);
  } finally { await s.close(); }
});

test('identity comes from the token: request data cannot claim another actor', async () => {
  const s = await startSeeded();
  try {
    let r = await s.write(s.alpha, 'inbox.submit', 'WEB-3', { kind: 'report', text: 'hi', by: 'owner' });
    assert.equal(r.status, 400);
    r = await s.call(s.alpha, 'POST', '/api/v1/write', { version: 1, request_id: 'claim-owner-0001', op: 'inbox.submit', target_id: 'WEB-3', data: { kind: 'report', text: 'hi' }, origin: 'owner' });
    assert.equal(r.status, 200);
    const ev = (await s.call(OWNER, 'GET', '/api/v1/events')).body.find(e => e.request_id === 'claim-owner-0001');
    assert.equal(ev.actor.role, 'reporter'); assert.equal(ev.actor.name, 'lane-alpha');
    assert.equal(ev.actor.origin, 'owner', 'declared origin is recorded as metadata, next to the authenticated executor');
    assert.equal((await s.call(s.alpha, 'GET', '/api/v1/events')).status, 403, 'reporters cannot read the audit journal');
    assert.equal((await s.call(s.coord, 'GET', '/api/v1/tokens')).status, 403, 'token list is owner-only');
  } finally { await s.close(); }
});

test('exactly one coordinator: a second is refused unless the owner hands the role over, which revokes the first', async () => {
  const s = await startSeeded();
  try {
    let r = await s.write(OWNER, 'token.issue', 'coordinator-2', { role: 'coordinator' });
    assert.equal(r.status, 409); assert.equal(r.body.error, 'coordinator_exists');
    r = await s.write(OWNER, 'token.issue', 'coordinator-2', { role: 'coordinator', replace_coordinator: true });
    assert.equal(r.status, 200);
    const next = r.body.token;
    assert.equal((await s.write(s.coord, 'task.update', 'WEB-3', { now: 'x' }, { expected_revision: 1 })).status, 401, 'old coordinator is revoked');
    assert.equal((await s.write(next, 'task.update', 'WEB-3', { now: 'x' }, { expected_revision: 1 })).status, 200);
    const active = (await s.call(OWNER, 'GET', '/api/v1/tokens')).body.filter(t => t.role === 'coordinator' && !t.revoked_at);
    assert.equal(active.length, 1);
  } finally { await s.close(); }
});

test('revocation takes effect on the next request', async () => {
  const s = await startSeeded();
  try {
    assert.equal((await s.write(s.beta, 'inbox.submit', 'API-2', { kind: 'report', text: 'before' })).status, 200);
    const id = (await s.call(OWNER, 'GET', '/api/v1/tokens')).body.find(t => t.name === 'lane-beta').id;
    assert.equal((await s.write(OWNER, 'token.revoke', id, {})).status, 200);
    assert.equal((await s.write(s.beta, 'inbox.submit', 'API-2', { kind: 'report', text: 'after' })).status, 401);
    assert.equal((await s.call(s.beta, 'GET', '/api/v1/whoami')).status, 401);
  } finally { await s.close(); }
});

test('anonymous readers see only records marked public', async () => {
  const s = await startSeeded();
  try {
    let anon = await s.state(null);
    assert.equal(anon.tasks.length, 0); assert.equal(anon.asks, undefined); assert.equal(anon.attention, undefined);
    await s.write(s.coord, 'task.update', 'API-2', { visibility: 'public' }, { expected_revision: 1 });
    anon = await s.state(null);
    assert.deepEqual(anon.tasks.map(t => t.id), ['API-2']);
    assert.equal(anon.tasks[0].attribution, undefined, 'no actor details for anonymous readers');
  } finally { await s.close(); }
});
