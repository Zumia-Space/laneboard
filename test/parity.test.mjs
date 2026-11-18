// Parity with the predecessor J-05 board: goal lock, re-brief, reviewer plans, one ping per "send", decision cards
// on steps, the new-task thread, task/step delete and step reorder, owner identity behind a login proxy, and the
// predecessor-API shapes of all of it (src/legacy-compat.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startSeeded, startServer, OWNER, rid, tmpDir } from './helpers.mjs';
import { createBoard } from '../src/board.mjs';
import { createServer } from '../src/server.mjs';
import { createLegacyCompat } from '../src/legacy-compat.mjs';
import { migrate } from '../scripts/migrate-from-legacy.mjs';
import { demoPng } from '../scripts/seed.mjs';

const ok = r => { assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };

test('goal.lock: versions with history, an open goal-lock feedback and a ping; goals.import once', async () => {
  const s = await startSeeded();
  try {
    ok(await s.write(OWNER, 'goal.lock', 'WEB-3', { goal: 'g1', output: 'o1', outcome: 'x1' }));
    const r2 = ok(await s.write(OWNER, 'goal.lock', 'WEB-3', { goal: 'g2', output: 'o2', outcome: 'x2' }));
    assert.equal(r2.revision, 2);
    const st = await s.state(OWNER);
    const g = st.goals['WEB-3'];
    assert.deepEqual([g.version, g.goal, g.history.map(h => [h.version, h.goal])], [2, 'g2', [[1, 'g1']]]);
    const locks = st.feedback.filter(f => f.kind === 'goal-lock');
    assert.deepEqual(locks.map(f => [f.goal_version, f.status, f.attribution.created_by.role]), [[1, 'open', 'owner'], [2, 'open', 'owner']]);
    assert.deepEqual(st.pings.filter(p => p.kind === 'goal-lock').map(p => p.detail.version), [1, 2]);
    assert.equal((await s.write(s.coord, 'goal.lock', 'WEB-3', { goal: 'g', output: 'o', outcome: 'x' })).status, 403, 'owner only');
    assert.equal((await s.write(OWNER, 'goal.lock', 'WEB-3', { goal: '', output: 'o', outcome: 'x' })).status, 400, 'all three required');
    assert.equal((await s.write(OWNER, 'goals.import', 'WEB-3', { goal: 'g', output: 'o', outcome: 'x', version: 1, locked_at: '2026-09-27T01:00:00.000Z' })).status, 409);
  } finally { await s.close(); }
});

test('rebrief.request and plan.add: mode/note kept, VERDICT/ETA read from the body, goal version recorded', async () => {
  const s = await startSeeded();
  try {
    ok(await s.write(OWNER, 'goal.lock', 'WEB-3', { goal: 'g', output: 'o', outcome: 'x' }));
    const rb = ok(await s.write(OWNER, 'rebrief.request', 'WEB-3', { note: 'too slow?' }));
    const plan = ok(await s.write(s.coord, 'plan.add', 'WEB-3', { reviewer: 'Fable', body: '## Plan\n**VERDICT:** adjust\nETA: 2 days\nrest', written_at: '2026-09-30T10:00:00.000Z' }));
    const st = await s.state(OWNER);
    const f = st.feedback.find(x => x.id === rb.id);
    assert.deepEqual([f.kind, f.mode, f.note, f.status], ['rebrief', 'strategy', 'too slow?', 'open']);
    const p = st.plans['WEB-3'].find(x => x.id === plan.id);
    assert.deepEqual([p.verdict, p.eta, p.goal_version, p.written_at], ['adjust', '2 days', 1, '2026-09-30T10:00:00.000Z']);
    assert.ok(p.posted_at > f.attribution.created_at, 'a plan posted after the request answers it (the page stops showing "re-brief under way")');
    assert.ok(st.pings.some(x => x.kind === 'rebrief' && x.detail.mode === 'strategy'));
    // the owner picks a plan: a choice feedback naming it
    ok(await s.write(OWNER, 'feedback.add', 'WEB-3', { kind: 'choice', plan_id: plan.id, text: 'Chose Fable' }));
    assert.equal((await s.write(OWNER, 'feedback.add', 'WEB-3', { kind: 'choice', plan_id: 'plan-999', text: 'x' })).status, 404);
  } finally { await s.close(); }
});

test('pings: notes do not ping, "send" pings once with the open count; routing and owner registry changes ping; seen marks; migrations never ping', async () => {
  const s = await startSeeded();
  try {
    ok(await s.write(OWNER, 'feedback.add', 'WEB-3', { kind: 'note', text: 'a' }));
    ok(await s.write(OWNER, 'feedback.add', 'WEB-3', { kind: 'note', text: 'b' }));
    assert.equal((await s.state(OWNER)).pings.length, 0);
    ok(await s.write(OWNER, 'ping.send', 'board', { task_id: 'WEB-3', note: '' }));
    let st = await s.state(OWNER);
    assert.deepEqual(st.pings.map(p => [p.kind, p.task_id, p.open, !!p.seen_at]), [['send', 'WEB-3', 2, false]]);
    assert.equal((await s.write(OWNER, 'ping.send', 'board', { kind: 'ask' })).status, 403, 'kind ask is the coordinator\'s');
    ok(await s.write(OWNER, 'routing.set', 'WEB-3', { model: 'opus', effort: 'high' }));
    ok(await s.write(OWNER, 'routing.reset', 'API-2', {}));
    ok(await s.write(s.coord, 'registry.set', 'board', { entries: [{ id: 'r1', code: 'WEB-3', title: 'W', status: 'open' }] }, { expected_revision: 0 }));
    ok(await s.write(OWNER, 'registry.set', 'board', { entries: [{ id: 'r1', code: 'WEB-3', title: 'W', status: 'paused', status_by: 'owner' }] }, { expected_revision: 1 }));
    ok(await s.write(OWNER, 'routing.set', 'API-2', { model: 'sonnet', effort: 'low' }, { origin: 'legacy anh 2026-09-27T01:00:00.000Z' }));
    st = await s.state(OWNER);
    assert.deepEqual(st.pings.map(p => p.kind), ['send', 'routing', 'status'], 'reset without an override, the coordinator\'s registry write and a migration write do not ping');
    assert.equal(st.pings.at(-1).detail.status, 'paused');
    assert.equal(st.tasks.find(t => t.id === 'API-2').worker.at, '2026-09-27T01:00:00.000Z', 'an imported override shows its original time');
    ok(await s.write(s.coord, 'ping.seen', 'board', {}));
    assert.ok((await s.state(OWNER)).pings.every(p => p.seen_at));
    assert.equal((await s.write(s.coord, 'ping.seen', 'board', {})).status, 409, 'nothing unseen');
  } finally { await s.close(); }
});

test('ask.answer is also an owner feedback (choice, approve/reject, note); a migration links its existing row', async () => {
  const s = await startSeeded();
  try {
    const a1 = ok(await s.write(s.coord, 'ask.raise', 'WEB-3', { text: 'Hero?', step_id: 's3', options: [{ key: 'A', label: 'Photo' }] }));
    ok(await s.write(OWNER, 'ask.answer', a1.id, { choice: 'A', text: 'bigger' }, { expected_revision: 1 }));
    const a2 = ok(await s.write(s.coord, 'ask.raise', 'API-2', { text: 'Ship it?' }));
    ok(await s.write(OWNER, 'ask.answer', a2.id, { verdict: 'approve' }, { expected_revision: 1 }));
    const a3 = ok(await s.write(s.coord, 'ask.raise', 'API-2', { text: 'Again?' }));
    // A migration imports the predecessor's feedback row first (origin "legacy …", so it answers nothing), then links it.
    const row = ok(await s.write(OWNER, 'feedback.add', 'API-2', { kind: 'choice', text: 'Chọn B: later' }, { origin: 'legacy anh 2026-09-27T01:00:00.000Z' }));
    ok(await s.write(OWNER, 'ask.answer', a3.id, { text: 'later', feedback_id: row.id }, { expected_revision: 1, origin: 'legacy anh 2026-09-27T01:00:00.000Z' }));
    const st = await s.state(OWNER);
    const f1 = st.feedback.find(f => f.ask_id === a1.id), f2 = st.feedback.find(f => f.ask_id === a2.id);
    assert.deepEqual([f1.kind, f1.step_id, f1.text, f1.choice, f1.status], ['choice', 's3', 'A: Photo\nbigger', 'A', 'open']);
    assert.deepEqual([f2.kind, f2.text], ['approve', 'approve: Ship it?']);
    assert.equal(st.feedback.filter(f => f.task_id === 'API-2' && f.kind === 'choice').length, 1, 'linked, not duplicated');
    assert.ok(!st.attention.waiting.some(w => w.id === a1.id || w.step_id === 's3'), 'the step is no longer the owner\'s move');
  } finally { await s.close(); }
});

test('decision cards on steps, task.delete, step.delete, step_order under the board rules, NEW request thread', async () => {
  const s = await startSeeded();
  try {
    ok(await s.write(s.coord, 'task.create', 'D-1', { title: 'Decide', dossier: 'notes/D-1.md', draft_output: 'a list', draft_outcome: 'five calls', health: 'grey', loops: [{ from: 's1', to: 's2', label: 'retry' }], steps: [
      { id: 's1', label: 'Pick', zone: 'owner', state: 'done', options: [{ key: 'A', label: 'One', desc: 'first' }, { key: 'B', label: 'Two' }] },
      { id: 's2', label: 'Build', zone: 'build', state: 'active' }, { id: 's3', label: 'Ask', zone: 'owner', state: 'waiting' }] }));
    let st = await s.state(OWNER);
    const d1 = st.tasks.find(t => t.id === 'D-1');
    assert.deepEqual([d1.dossier, d1.draft_output, d1.draft_outcome, d1.health, d1.steps[0].options.length], ['notes/D-1.md', 'a list', 'five calls', 'grey', 2]);
    // reorder: putting the waiting s3 before the done s1 is refused whole; a valid order is applied
    let r = await s.write(s.coord, 'task.update', 'D-1', { step_order: ['s3', 's1', 's2'] }, { expected_revision: 1 });
    assert.equal(r.body.error, 'waiting_before_done');
    assert.equal((await s.write(s.coord, 'task.update', 'D-1', { step_order: ['s1', 's2'] }, { expected_revision: 1 })).body.error, 'step_order_mismatch');
    ok(await s.write(s.coord, 'task.update', 'D-1', { step_order: ['s2', 's1', 's3'] }, { expected_revision: 1 }));
    ok(await s.write(s.coord, 'step.delete', 'D-1/s2', {}, { expected_revision: 1 }));
    st = await s.state(OWNER);
    assert.deepEqual([st.tasks.find(t => t.id === 'D-1').steps.map(x => x.id), st.tasks.find(t => t.id === 'D-1').loops], [['D-1/s1', 'D-1/s3'], []], 'a loop needs both its steps');
    // delete, then re-create: the timing history continues
    const rev = st.tasks.find(t => t.id === 'D-1').rev;
    ok(await s.write(s.coord, 'task.delete', 'D-1', {}, { expected_revision: rev }));
    st = await s.state(OWNER);
    assert.ok(!st.tasks.some(t => t.id === 'D-1') && st.times['D-1/s3'], 'gone from the board, history kept');
    ok(await s.write(s.coord, 'task.create', 'D-1', { title: 'Decide', steps: [{ id: 's3', label: 'Ask', zone: 'owner', state: 'done' }] }));
    const tr = (await s.state(OWNER)).times['D-1/s3'];
    assert.deepEqual(tr.transitions.map(x => [x.from, x.to]), [['waiting', 'done']]);
    // NEW: the owner's new-task requests, and the coordinator's reply to them
    const nt = ok(await s.write(OWNER, 'feedback.add', 'NEW', { kind: 'newtask', text: 'Landing page' }));
    ok(await s.write(s.coord, 'feedback.add', 'NEW', { kind: 'reply', text: 'Named it C-60', reply_to: nt.id, resolve_reply_to: true }));
    assert.equal((await s.write(OWNER, 'feedback.add', 'NEW', { kind: 'note', text: 'x', step_id: 's1' })).body.error, 'not_a_task');
    assert.equal((await s.state(OWNER)).feedback.find(f => f.id === nt.id).status, 'resolved');
  } finally { await s.close(); }
});

test('owner behind a login proxy: secret header from a loopback peer only, CSRF header on writes, a bearer token wins', async () => {
  const dataDir = tmpDir(), SECRET = 'proxy-secret-0123456789-abcdefghijklmnop';
  const board = createBoard({ dataDir, ownerToken: OWNER });
  const server = createServer(board, { ownerProxySecret: SECRET });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, route, headers = {}, body) => { const res = await fetch(url + route, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body && JSON.stringify(body) }); return { status: res.status, body: await res.json() }; };
  const write = data => ({ version: 1, request_id: rid(), op: 'task.create', target_id: data, data: { title: data } });
  try {
    const H = { 'X-Laneboard-Owner-Proxy': SECRET, 'X-Forwarded-For': '203.0.113.9' };
    assert.equal((await call('GET', '/api/v1/whoami', H)).body.role, 'owner');
    assert.equal((await call('GET', '/api/v1/whoami', { 'X-Laneboard-Owner-Proxy': 'wrong' + SECRET })).status, 401);
    assert.equal((await call('GET', '/api/v1/whoami')).status, 401, 'no header, no token: anonymous');
    assert.equal((await call('GET', '/api/v1/state', H)).body.me.via, 'proxy');
    assert.equal((await call('POST', '/api/v1/write', H, write('P-1'))).status, 401, 'a write without X-Requested-With is not trusted (cross-site forms cannot set it)');
    assert.equal((await call('POST', '/api/v1/write', { ...H, 'X-Requested-With': 'laneboard' }, write('P-1'))).status, 200);
    const coord = (await call('POST', '/api/v1/write', { Authorization: `Bearer ${OWNER}` }, { version: 1, request_id: rid(), op: 'token.issue', target_id: 'coordinator', data: { role: 'coordinator' } })).body.token;
    assert.equal((await call('GET', '/api/v1/whoami', { ...H, Authorization: `Bearer ${coord}` })).body.role, 'coordinator', 'a bearer token through the proxy stays itself');
    const ev = board.state.tasks['P-1'].attribution.created_by;
    assert.deepEqual([ev.role, ev.name], ['owner', 'owner'], 'journaled as the owner');
    // A non-loopback peer is never trusted, whatever header it sends (checked on the function, sockets are loopback here).
    const { proxyOwner } = await import('../src/server.mjs');
    assert.equal(proxyOwner({ socket: { remoteAddress: '203.0.113.9' }, headers: { 'x-laneboard-owner-proxy': SECRET }, method: 'GET' }, SECRET), false);
    assert.equal(proxyOwner({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-laneboard-owner-proxy': SECRET }, method: 'GET' }, ''), false, 'off without a secret');
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); board.close(); }
});

// X-Laneboard-Token: the Zumi desktop app's own revocable owner token. nginx's basic auth occupies Authorization
// on every request on this path (including the app's), so the app cannot send it as a bearer; it sends it here
// instead, and this header, when present, ALONE decides the actor — src/server.mjs (around the X-Laneboard-Token
// read), never falling back to the proxy-owner header.
test('X-Laneboard-Token decides the actor alone: valid wins, invalid/revoked never falls back to the proxy', async () => {
  const dataDir = tmpDir(), SECRET = 'proxy-secret-0123456789-abcdefghijklmnop';
  const board = createBoard({ dataDir, ownerToken: OWNER });
  const server = createServer(board, { ownerProxySecret: SECRET });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, route, headers = {}, body) => { const res = await fetch(url + route, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body && JSON.stringify(body) }); return { status: res.status, body: await res.json() }; };
  const PROXY_H = { 'X-Laneboard-Owner-Proxy': SECRET, 'X-Requested-With': 'laneboard' };
  const write = (target_id, data = { title: target_id }) => ({ version: 1, request_id: rid(), op: 'task.create', target_id, data });
  try {
    const zumi = (await call('POST', '/api/v1/write', { Authorization: `Bearer ${OWNER}` }, { version: 1, request_id: rid(), op: 'token.issue', target_id: 'zumi-desktop', data: { role: 'owner', label: 'Zumi app' } })).body.token;

    // valid X-Laneboard-Token -> actor = zumi-desktop, and a write is journaled with that actor
    const who = await call('GET', '/api/v1/whoami', { 'X-Laneboard-Token': zumi });
    assert.equal(who.status, 200);
    assert.deepEqual([who.body.name, who.body.role], ['zumi-desktop', 'owner']);
    const w = await call('POST', '/api/v1/write', { 'X-Laneboard-Token': zumi }, write('Z-1'));
    assert.equal(w.status, 200, JSON.stringify(w.body));
    assert.equal(board.state.tasks['Z-1'].attribution.created_by.name, 'zumi-desktop', 'journaled as the app token, not the generic owner');

    // revoked token + a valid proxy-owner header present at the same time -> 401, no fallback to the proxy
    const tokId = (await call('GET', '/api/v1/tokens', { Authorization: `Bearer ${OWNER}` })).body.find(t => t.name === 'zumi-desktop').id;
    await call('POST', '/api/v1/write', { Authorization: `Bearer ${OWNER}` }, { version: 1, request_id: rid(), op: 'token.revoke', target_id: tokId, data: {} });
    const revoked = await call('GET', '/api/v1/whoami', { 'X-Laneboard-Token': zumi, ...PROXY_H });
    assert.equal(revoked.status, 401, 'a revoked app token never falls back to the owner-proxy header');

    // a garbage token -> 401, even with a valid proxy header alongside it
    const garbage = await call('GET', '/api/v1/whoami', { 'X-Laneboard-Token': 'not-a-real-token', ...PROXY_H });
    assert.equal(garbage.status, 401);

    // no X-Laneboard-Token header -> owner via the proxy exactly as before
    const viaProxy = await call('GET', '/api/v1/whoami', PROXY_H);
    assert.equal(viaProxy.status, 200);
    assert.deepEqual([viaProxy.body.role, viaProxy.body.via], ['owner', 'proxy']);

    // agents' Authorization bearer is unchanged when no X-Laneboard-Token header is sent
    const coord = (await call('POST', '/api/v1/write', { Authorization: `Bearer ${OWNER}` }, { version: 1, request_id: rid(), op: 'token.issue', target_id: 'coordinator', data: { role: 'coordinator' } })).body.token;
    assert.equal((await call('GET', '/api/v1/whoami', { Authorization: `Bearer ${coord}` })).body.role, 'coordinator');

    // edge case: both an Authorization bearer and X-Laneboard-Token present -> the header alone wins, the bearer
    // is ignored for that request (re-issue a live app key first, since the earlier one was revoked above)
    const zumi2 = (await call('POST', '/api/v1/write', { Authorization: `Bearer ${OWNER}` }, { version: 1, request_id: rid(), op: 'token.issue', target_id: 'zumi-desktop', data: { role: 'owner', label: 'Zumi app' } })).body.token;
    const both = await call('GET', '/api/v1/whoami', { Authorization: `Bearer ${coord}`, 'X-Laneboard-Token': zumi2 });
    assert.equal(both.status, 200);
    assert.deepEqual([both.body.name, both.body.role], ['zumi-desktop', 'owner'], 'X-Laneboard-Token wins over a simultaneous Authorization bearer');
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); board.close(); }
});

// ---------- predecessor API (compat) ----------
const T0 = '2026-09-27T01:00:00.000Z', T1 = '2026-09-27T05:00:00.000Z';
const step = (id, state, zone = 'build', extra = {}) => ({ id, label: `Step ${id}`, sub: '', state, zone, ...extra });
const ROWS = [
  { code: 'A-1', title: 'Alpha', lane: 'workera', health: 'yellow', needsAnh: '', order: 1, updated: T1, dossier: 'vault/A-1.md', draftOutput: 'a doc', draftOutcome: 'a call',
    worker: { model: 'sonnet', effort: 'medium', reason: 'cheap' }, loops: [{ from: 's3', to: 's2', label: 'retest' }],
    steps: [step('s1', 'done', 'plan', { options: [{ key: 'A', label: 'Fast', desc: 'd' }] }), step('s2', 'waiting', 'anh', { options: [{ key: 'X', label: 'Yes' }, { key: 'Y', label: 'No' }] }), step('s3', 'todo')] },
  { code: 'B-2', title: 'Beta', lane: 'workerb', health: 'grey', now: 'TẠM HOÃN theo anh', order: 2, updated: T1, steps: [step('s1', 'active')] },
  { code: 'C-3', title: 'Gamma', lane: 'workera', health: 'green', order: 3, updated: T1, steps: [step('s1', 'active')] }
];
async function setupCompat() {
  const src = tmpDir(), media = path.join(src, 'media');
  fs.mkdirSync(path.join(src, 'data')); fs.mkdirSync(media);
  const put = (n, v) => fs.writeFileSync(path.join(src, 'data', `${n}.json`), JSON.stringify(v));
  put('tasks', ROWS);
  put('feedback', [
    { id: 'f-goal', task: 'A-1', step: '', text: 'Anh chốt mục tiêu v2\nMục tiêu: g2', kind: 'goal-lock', by: 'anh', status: 'done', at: T1, doneAt: T1 },
    { id: 'f-pick', task: 'A-1', step: 'plan', text: 'Chọn phương án của Fable (aaaaaaaa) · Chỉnh', kind: 'choice', by: 'anh', status: 'open', at: T1 },
    { id: 'f-rb', task: 'A-1', step: '', text: 'Anh yêu cầu rà lại (Chỉ QC: tiếp tục hay đổi hướng)\nchậm', kind: 'rebrief', mode: 'qc', note: 'chậm', by: 'anh', status: 'open', at: T1 },
    { id: 'f-new', task: 'NEW', step: '', text: 'Landing page', kind: 'newtask', by: 'anh', status: 'open', at: T0 }
  ]);
  put('goals', { 'A-1': { goal: 'g2', output: 'o2', outcome: 'x2', lockedAt: T1, lockedBy: 'anh', version: 2, history: [{ goal: 'g1', output: 'o1', outcome: 'x1', lockedAt: T0, lockedBy: 'anh', version: 1 }] } });
  put('plans', { 'A-1': [{ id: 'aaaaaaaa-0000-4000-8000-000000000001', reviewer: 'Fable', verdict: 'adjust', eta: '2d', body: 'VERDICT: adjust', at: T0, postedAt: T1, goalVersion: 2 }] });
  put('pings', [{ id: 'p-1', note: 'sent', task: 'A-1', open: 2, at: T0, seenAt: T1 }, { id: 'p-2', note: 'anh đổi thợ A-1: Opus 5.5 · high', task: 'A-1', open: 0, at: T1, seenAt: '', kind: 'routing' }]);
  put('routing', { 'A-1': { model: 'opus', effort: 'high', by: 'anh', at: T0 } });
  put('registry', [{ id: 'r1', code: 'A-1', title: 'Alpha', onBoard: true, status: 'doing' }, { id: 'r2', code: 'B-2', title: 'Beta', onBoard: true, status: 'doing' }, { id: 'r3', code: 'C-3', title: 'Gamma', onBoard: true, status: 'doing' }]);
  fs.writeFileSync(path.join(media, 'shot.png'), demoPng(40, 20));
  const dataDir = path.join(tmpDir(), 'board'), tokenFile = path.join(tmpDir(), 'coord.token');
  const report = await migrate({ from: src, to: dataDir, coordinatorTokenOut: tokenFile, ownerLang: 'vi', ownerTheme: 'dark' });
  const board = createBoard({ dataDir });
  const server = createServer(board, { legacyCompat: createLegacyCompat(board, { tokenFile, dataDir, mediaDir: media }) });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const owner = fs.readFileSync(path.join(dataDir, 'owner.token'), 'utf8').trim();
  const call = async (method, route, body, headers = {}) => {
    const res = await fetch(url + route, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json, headers: res.headers };
  };
  const state = () => call('GET', '/api/state', undefined, { 'X-Forwarded-For': 'x' }).then(r => r.body);
  const ownerWrite = (op, target_id, data, extra = {}) => call('POST', '/api/v1/write', { version: 1, request_id: rid(), op, target_id, data, ...extra }, { Authorization: `Bearer ${owner}` });
  const close = async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); board.close(); };
  return { report, board, call, state, ownerWrite, close, dataDir };
}

test('import + compat: goals, plans, plan choice, goal-lock and re-brief rows, NEW thread, pings, options, drafts in the predecessor shapes', async () => {
  const s = await setupCompat();
  try {
    assert.deepEqual(s.report.warnings.filter(w => /feedback|plan|goal|ping/.test(w)), [], 'every goal, plan, ping and feedback row imported');
    const st = await s.state();
    const a1 = st.tasks.find(t => t.code === 'A-1');
    assert.deepEqual([a1.dossier, a1.draftOutput, a1.draftOutcome, a1.health], ['vault/A-1.md', 'a doc', 'a call', 'yellow']);
    assert.deepEqual(a1.steps.map(x => (x.options || []).map(o => o.key).join('')), ['A', 'XY', '']);
    assert.equal(st.tasks.find(t => t.code === 'C-3').health, 'green');
    assert.deepEqual([st.goals['A-1'].version, st.goals['A-1'].lockedAt, st.goals['A-1'].history.map(h => [h.version, h.lockedAt])], [2, T1, [[1, T0]]]);
    assert.deepEqual(st.plans['A-1'].map(p => [p.id, p.verdict, p.at, p.postedAt, p.goalVersion]), [['aaaaaaaa-0000-4000-8000-000000000001', 'adjust', T0, T1, 2]]);
    const fb = id => st.feedback.find(f => f.id === id);
    assert.deepEqual([fb('f-goal').kind, fb('f-goal').text.split('\n')[0], fb('f-goal').status], ['goal-lock', 'Anh chốt mục tiêu v2', 'done']);
    assert.deepEqual([fb('f-pick').step, fb('f-pick').kind], ['plan', 'choice']);
    assert.deepEqual([fb('f-rb').kind, fb('f-rb').mode, fb('f-rb').note, fb('f-rb').text], ['rebrief', 'qc', 'chậm', 'Anh yêu cầu rà lại (Chỉ QC: tiếp tục hay đổi hướng)\nchậm']);
    assert.deepEqual([fb('f-new').task, fb('f-new').kind], ['NEW', 'newtask']);
    assert.deepEqual(st.pings.map(p => [p.id, p.seenAt, p.kind || '']), [['p-1', T1, ''], ['p-2', '', 'routing']], 'the import itself pinged no one');
    assert.equal(a1.worker.at, T0);
    assert.equal(s.board.view(fs.readFileSync(path.join(s.dataDir, 'owner.token'), 'utf8').trim()).me.prefs.lang, 'vi', 'the owner keeps the language of the predecessor page');
    assert.equal(s.board.view(fs.readFileSync(path.join(s.dataDir, 'owner.token'), 'utf8').trim()).me.prefs.theme, 'dark', 'and its dark-only theme');
    // the owner's plan choice is linked to the imported plan
    const plan = s.board.state.plans['A-1'][0];
    assert.equal(Object.values(s.board.state.feedback).find(f => f.plan_id)?.plan_id, plan.id);
  } finally { await s.close(); }
});

test('compat: plans, times, media (ranges, copies), and the new owner actions in the old shapes', async () => {
  const s = await setupCompat();
  try {
    const r = await s.call('POST', '/api/admin/plans', { task: 'A-1', reviewer: 'Astra', body: '# x\nVERDICT: on-track\nETA: 1 week' });
    assert.equal(r.status, 201);
    assert.deepEqual([r.body.reviewer, r.body.verdict, r.body.eta, r.body.goalVersion], ['Astra', 'on-track', '1 week', 2]);
    assert.equal((await s.call('POST', '/api/admin/plans', { task: 'NOPE', reviewer: 'x', body: 'y' })).body.error, 'unknown_task');
    assert.equal((await s.call('POST', '/api/admin/plans', { task: 'A-1', reviewer: 'x', body: 'y' }, { 'X-Forwarded-For': '1.2.3.4' })).status, 404);
    assert.ok((await s.call('GET', '/api/times')).body.tasks);
    const media = (await s.call('GET', '/api/media')).body;
    assert.deepEqual(media.map(m => [m.name, m.type]), [['shot.png', 'image']]);
    const st = await s.state();
    assert.deepEqual(Object.keys(st.mediaInfo), ['shot.png']);
    assert.deepEqual([st.mediaInfo['shot.png'].w, st.mediaInfo['shot.png'].h], [40, 20]);
    const part = await s.call('GET', '/media/shot.png', undefined, { Range: 'bytes=0-7' });
    assert.equal(part.status, 206);
    const copy = await s.call('GET', '/media/_t/shot.png.webp?v=1');
    assert.deepEqual([copy.status, copy.headers.get('location')], [302, '../shot.png?v=1']);
    // the owner's new actions reach the old API's readers
    await s.ownerWrite('goal.lock', 'A-1', { goal: 'g3', output: 'o3', outcome: 'x3' });
    await s.ownerWrite('rebrief.request', 'A-1', { mode: 'strategy' });
    await s.ownerWrite('ping.send', 'board', { task_id: 'A-1', note: '' });
    const st2 = await s.state();
    const lock = st2.feedback.filter(f => f.kind === 'goal-lock').at(-1);
    assert.deepEqual([lock.by, lock.status, lock.text.split('\n')[0]], ['anh', 'open', 'Anh chốt mục tiêu v3']);
    assert.equal(st2.feedback.filter(f => f.kind === 'rebrief').at(-1).mode, 'strategy');
    assert.deepEqual(st2.pings.slice(-3).map(p => [p.note, p.kind || '']), [['A-1: anh chốt mục tiêu v3', 'goal-lock'], ['A-1: anh yêu cầu rà lại (strategy)', 'rebrief'], ['', '']]);
    assert.equal(st2.goals['A-1'].version, 3);
    // new records carry ids in the predecessor's shape (wait-feedback.sh matches ^[0-9a-f-]{36}), and replies resolve them
    await s.ownerWrite('feedback.add', 'A-1', { kind: 'note', text: 'fresh note' });
    const fresh = (await s.state()).feedback.find(f => f.text === 'fresh note');
    assert.match(fresh.id, /^[0-9a-f-]{36}$/);
    const rr = await s.call('POST', '/api/admin/reply', { task: 'A-1', step: '', text: 'ok', replyTo: fresh.id, close: true });
    assert.deepEqual([rr.status, /^[0-9a-f-]{36}$/.test(rr.body.id), rr.body.replyTo], [201, true, fresh.id]);
    assert.equal((await s.state()).feedback.find(f => f.id === fresh.id).status, 'done');
    // a coordinator reply on the NEW thread (cos-board reply on a "+ new task" request)
    const nt = st2.feedback.find(f => f.kind === 'newtask');
    assert.equal((await s.call('POST', '/api/admin/reply', { task: 'NEW', step: '', text: 'Named it C-60', replyTo: nt.id, close: true })).status, 201);
    assert.equal((await s.state()).feedback.find(f => f.id === nt.id).status, 'done');
  } finally { await s.close(); }
});

test('compat push resets a task\'s last-activity clock only when its row changed (fields, steps or a newer `updated`)', async () => {
  const s = await setupCompat();
  try {
    const act = code => s.board.state.activity[code];
    const rows = structuredClone(ROWS);
    await s.call('PUT', '/api/admin/tasks', { tasks: rows }); // settle: the imported rows pushed once
    const before = { A: act('A-1'), B: act('B-2'), C: act('C-3') };
    await new Promise(r => setTimeout(r, 15));
    // 1. the same rows again: nothing written, no clock moves
    assert.equal((await s.call('PUT', '/api/admin/tasks', { tasks: rows })).body.writes, 0);
    assert.deepEqual({ A: act('A-1'), B: act('B-2'), C: act('C-3') }, before);
    // 2. A-1 changes a field, C-3 only bumps `updated` (the old board reset its clocks on that too); B-2 unchanged
    rows[0].now = 'pushed again'; rows[2].updated = new Date().toISOString();
    const r = await s.call('PUT', '/api/admin/tasks', { tasks: rows });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(act('A-1') > before.A && act('C-3') > before.C, 'changed rows record a change (server clock)');
    assert.equal(act('B-2'), before.B, 'an unchanged row keeps its clock');
    assert.equal((await s.state()).tasks.find(t => t.code === 'A-1').updated, act('A-1'), 'the predecessor API shows the new time');
    // 3. the same push again is a no-op (no clock creep)
    const seq = s.board.state.seq;
    await s.call('PUT', '/api/admin/tasks', { tasks: rows });
    assert.equal(s.board.state.seq, seq);
  } finally { await s.close(); }
});

test('compat push: a task missing from the rows is left untouched (close is explicit); steps deleted/reordered, worker default, fields; idempotent', async () => {
  const s = await setupCompat();
  try {
    const rows = structuredClone(ROWS).filter(r => r.code !== 'C-3');
    const a = rows[0];
    a.worker = { model: 'opus', effort: 'low', reason: 'harder now' }; a.dossier = 'vault/A-1-v2.md'; delete a.draftOutcome; a.health = 'red';
    // s2 (waiting) moves after a new done step? No: the row stays valid — s3 is dropped, s4 is new, order s4, s1, s2.
    a.steps = [step('s4', 'todo'), a.steps[0], { ...a.steps[1], state: 'done', options: [] }];
    a.loops = [];
    const r = await s.call('PUT', '/api/admin/tasks', { tasks: rows });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.kept, r.body.untouched], [[], ['C-3']]);
    const st = await s.state();
    const t = st.tasks.find(x => x.code === 'A-1');
    assert.deepEqual(st.tasks.map(x => x.code), ['A-1', 'B-2', 'C-3'], 'C-3 is not in the push and stays as it was');
    assert.deepEqual(t.steps.map(x => [x.id, x.state]), [['s4', 'todo'], ['s1', 'done'], ['s2', 'done']]);
    assert.deepEqual([t.workerCos.model, t.workerCos.effort, t.dossier, 'draftOutcome' in t, t.health], ['opus', 'low', 'vault/A-1-v2.md', false, 'red']);
    assert.notEqual(s.board.state.tasks['C-3'].status, 'closed');
    // the only way to remove it: an explicit close (never a delete)
    assert.deepEqual((await s.call('POST', '/api/admin/close', { code: 'C-3' })).body, { ok: true, code: 'C-3', status: 'closed', writes: 1 });
    assert.equal(s.board.state.tasks['C-3'].status, 'closed');
    const seq = s.board.state.seq;
    assert.equal((await s.call('PUT', '/api/admin/tasks', { tasks: rows })).body.writes, 0, 're-pushing the same rows writes nothing');
    assert.equal(s.board.state.seq, seq);
    // A push only reachable through a parked step: s2 waiting -> done while the waiting s1 moves after it.
    const rows2 = structuredClone(rows);
    rows2[0].steps = [{ ...rows2[0].steps[2] }, { ...rows2[0].steps[1], state: 'waiting' }, rows2[0].steps[0]];
    await s.call('PUT', '/api/admin/tasks', { tasks: rows });
    const r2 = await s.call('PUT', '/api/admin/tasks', { tasks: rows2 });
    assert.equal(r2.status, 200, JSON.stringify(r2.body));
    assert.deepEqual((await s.state()).tasks[0].steps.map(x => [x.id, x.state]), [['s2', 'done'], ['s1', 'waiting'], ['s4', 'todo']]);
  } finally { await s.close(); }
});
