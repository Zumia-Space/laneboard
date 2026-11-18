// src/legacy-compat.mjs: the predecessor board's clients (CoS CLI, Fable watcher, ACME-02 coordinator) keep working
// against an imported board through the predecessor's own routes and shapes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createBoard } from '../src/board.mjs';
import { createServer } from '../src/server.mjs';
import { createLegacyCompat } from '../src/legacy-compat.mjs';
import { migrate } from '../scripts/migrate-from-legacy.mjs';
import { demoPng } from '../scripts/seed.mjs';
import { tmpDir } from './helpers.mjs';

const T0 = '2026-09-27T01:00:00.000Z', T1 = '2026-09-27T05:00:00.000Z';
const step = (id, state, zone = 'build') => ({ id, label: `Step ${id}`, sub: '', state, zone });
const ROWS = [
  { code: 'A-1', title: 'Alpha', lane: 'workera', health: 'yellow', needsAnh: '', order: 1, updated: T1, worker: { model: 'sonnet', effort: 'medium', reason: 'r' },
    steps: [step('s1', 'done'), step('s2', 'waiting', 'anh'), step('s3', 'todo')] },
  { code: 'B-2', title: 'Beta', lane: 'workerb', health: 'grey', now: 'TẠM HOÃN theo anh', order: 2, updated: T1, steps: [step('s1', 'active')] }
];

async function setup(boardOpts = {}) {
  const src = tmpDir(), media = path.join(src, 'media');
  fs.mkdirSync(path.join(src, 'data')); fs.mkdirSync(media);
  const put = (n, v) => fs.writeFileSync(path.join(src, 'data', `${n}.json`), JSON.stringify(v));
  put('tasks', ROWS);
  put('asks', { 'A-1': { text: 'Pick the hero', by: 'workerb', at: T1 } });
  put('feedback', [
    { id: '7f1c0000-0000-4000-8000-000000000001', task: 'A-1', step: '', text: 'Make it bigger', kind: 'note', by: 'anh', status: 'open', at: T0 },
    { id: '7f1c0000-0000-4000-8000-000000000002', task: 'A-1', step: 's2', text: 'And bluer', kind: 'note', by: 'anh', status: 'open', at: T1 }
  ]);
  put('pings', [{ id: 'p-old', note: 'sent', task: 'A-1', open: 2, at: T1, seenAt: '' }]);
  put('meta', { summary: ['one line'], updatedAt: T1 });
  put('registry', [{ id: 'r1', file: 'A-1', code: 'A-1', title: 'Alpha', onBoard: true, status: 'open' }, { id: 'r2', file: 'B-2', code: 'B-2', title: 'Beta', onBoard: true, status: 'doing' }]);
  put('registry-status', { r1: { status: 'doing', statusBy: 'anh', statusAt: T1 } });
  put('goals', { 'A-1': { goal: 'g', output: 'o', outcome: 'oc', version: 1 } });
  fs.writeFileSync(path.join(media, 'later.png'), demoPng(8, 8));
  const dataDir = path.join(tmpDir(), 'board'), tokenFile = path.join(tmpDir(), 'coord.token');
  await migrate({ from: src, to: dataDir, coordinatorTokenOut: tokenFile });
  fs.rmSync(path.join(media, 'later.png')); // reappears later, the way `push` copies new media in
  const board = createBoard({ dataDir, ...boardOpts });
  const legacyCompat = createLegacyCompat(board, { tokenFile, dataDir, mediaDir: media });
  const server = createServer(board, { legacyCompat });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const owner = fs.readFileSync(path.join(dataDir, 'owner.token'), 'utf8').trim();
  // ACME-02 coordinator: GETs carry X-Forwarded-For, admin POSTs carry only Content-Type.
  const call = async (method, route, body, headers = {}) => {
    const res = await fetch(url + route, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json };
  };
  const state = (headers = { 'X-Forwarded-For': 't31-coordinator' }) => call('GET', '/api/state', undefined, headers).then(r => r.body);
  const close = async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); board.close(); };
  return { url, call, state, owner, board, media, close };
}

test('legacy compat: GET /api/state has the predecessor shape, ids and times; watcherAt only from a direct loopback read', async () => {
  const s = await setup();
  try {
    const st = await s.state();
    assert.deepEqual(Object.keys(st).sort(), ['feedback', 'goals', 'mediaInfo', 'meta', 'pings', 'plans', 'registry', 'tasks', 'times', 'watcherAt']);
    assert.deepEqual(st.tasks.map(t => [t.code, t.health, t.currentStep?.id ?? null]), [['A-1', 'yellow', 's2'], ['B-2', 'grey', 's1']]);
    const a1 = st.tasks[0];
    assert.equal(a1.needsAnh, 'Pick the hero'); assert.equal(a1.askedBy, 'workerb'); assert.equal(a1.askAt, T1);
    assert.equal(a1.steps[1].zone, 'anh');
    assert.equal(a1.worker.by, 'cos');
    assert.equal(typeof a1.updated, 'string');
    assert.deepEqual(st.feedback.map(f => [f.id, f.by, f.status, f.at]), [
      ['7f1c0000-0000-4000-8000-000000000001', 'anh', 'open', T0], ['7f1c0000-0000-4000-8000-000000000002', 'anh', 'open', T1]]);
    assert.deepEqual(st.registry.map(r => [r.id, r.status]), [['r1', 'doing'], ['r2', 'paused']]);
    assert.deepEqual(st.meta.summary, ['one line']);
    assert.equal(st.goals['A-1'].version, 1, 'locked goals stay readable from the archive');
    assert.deepEqual(st.pings.map(p => [p.id, p.seenAt]), [['p-old', '']]);
    assert.ok(st.times.tasks['A-1'].steps.s2);
    assert.equal(st.watcherAt, '', 'a proxied/ACME-02 read is not the CoS watcher');
    assert.notEqual((await s.state({})).watcherAt, '', 'a direct loopback read is');
  } finally { await s.close(); }
});

test('legacy compat: admin routes only for a direct loopback caller; reply keeps or closes, by the predecessor id', async () => {
  const s = await setup();
  try {
    const f1 = '7f1c0000-0000-4000-8000-000000000001', f2 = '7f1c0000-0000-4000-8000-000000000002';
    assert.equal((await s.call('POST', '/api/admin/reply', { task: 'A-1', text: 'x', replyTo: f1 }, { 'X-Forwarded-For': '1.2.3.4' })).status, 404);
    assert.equal((await s.call('POST', '/api/admin/plans', { task: 'A-1' })).status, 400, 'a plan needs reviewer and body');
    assert.equal((await s.call('POST', '/api/feedback', { task: 'A-1', text: 'x' })).status, 405, "the predecessor's page-only routes are not answered");
    // ACME-02 shape: exactly five fields, never close.
    const r = await s.call('POST', '/api/admin/reply', { task: 'A-1', step: '', text: '[ACME-02] noted', kind: 'note', replyTo: f1 });
    assert.equal(r.status, 201); assert.equal(r.body.replyTo, f1); assert.equal(r.body.by, 'cos');
    // cos-board reply (closes unless --keep).
    assert.equal((await s.call('POST', '/api/admin/reply', { task: 'A-1', step: 's2', text: 'done', replyTo: f2, close: true })).status, 201);
    const st = await s.state();
    assert.deepEqual(st.feedback.filter(f => f.by === 'anh').map(f => [f.id, f.status]), [[f1, 'open'], [f2, 'done']]);
    assert.ok(st.feedback.some(f => f.by === 'cos' && f.replyTo === f1 && f.text === '[ACME-02] noted'), 'a client finds its own reply by replyTo');
    assert.equal((await s.call('POST', '/api/admin/reply', { task: 'NOPE', text: 'x' })).status, 400);
  } finally { await s.close(); }
});

test('legacy compat: ask replaces the task ask and pings; clear removes it; pings/seen; one ping per "send to CoS", not per note', async () => {
  const s = await setup();
  try {
    assert.deepEqual((await s.call('POST', '/api/admin/asks', { code: 'A-1', text: 'Pick C1 or C2', by: 'workerb' })).body, { ok: true });
    let st = await s.state();
    assert.equal(st.tasks[0].needsAnh, 'Pick C1 or C2'); assert.equal(st.tasks[0].askedBy, 'workerb');
    assert.equal(s.board.view(s.owner).attention.waiting.filter(w => w.kind === 'ask').length, 1, 'one ask per task, like asks.json');
    assert.match(st.pings.at(-1).note, /^workerb hỏi A-1: Pick C1/);
    assert.deepEqual((await s.call('POST', '/api/admin/pings/seen', {})).body, { ok: true, marked: 2 });
    st = await s.state();
    assert.ok(st.pings.every(p => p.seenAt));
    for (const a of Object.values(s.board.state.asks)) if (a.task_id === 'A-1' && a.status === 'open') assert.deepEqual((await s.call('POST', '/api/admin/asks/clear', { id: a.id })).body, { ok: true, cleared: [a.id] }); // s21: a clear names the ask
    assert.equal((await s.state()).tasks[0].needsAnh, '');
    // Owner notes are saved without waking the watcher; "Gửi cho CoS" sends one ping for the whole batch.
    const write = (request_id, op, target_id, data) => fetch(`${s.url}/api/v1/write`, { method: 'POST', headers: { Authorization: `Bearer ${s.owner}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: 1, request_id, op, target_id, data }) });
    const before = (await s.state()).pings.length;
    assert.equal((await write('owner-fb-1', 'feedback.add', 'A-1', { kind: 'note', text: 'New note' })).status, 200);
    assert.equal((await write('owner-fb-2', 'feedback.add', 'A-1', { kind: 'note', text: 'Second note' })).status, 200);
    st = await s.state();
    assert.equal(st.pings.length, before, 'notes alone do not ping');
    assert.ok(st.feedback.some(f => f.by === 'anh' && f.text === 'New note' && f.status === 'open'));
    assert.equal((await write('owner-ping-1', 'ping.send', 'board', { task_id: 'A-1', note: '' })).status, 200);
    st = await s.state();
    assert.equal(st.pings.length, before + 1, 'one ping for the batch');
    const p = st.pings.at(-1);
    assert.deepEqual([p.task, p.note, p.seenAt, p.open, 'kind' in p], ['A-1', '', '', 4, false]);
  } finally { await s.close(); }
});

test('legacy compat: push applies rows as board writes, refuses a rule-breaking push whole, attaches new media', async () => {
  const s = await setup();
  try {
    const seq0 = s.board.state.seq;
    const bad = structuredClone(ROWS); bad[0].steps[2].state = 'done'; // s2 still waiting before a done s3
    const r0 = await s.call('PUT', '/api/admin/tasks', { tasks: bad });
    assert.equal(r0.status, 400); assert.equal(r0.body.error, 'waiting_before_done');
    assert.equal(s.board.state.seq, seq0, 'nothing written');

    fs.writeFileSync(path.join(s.media, 'later.png'), demoPng(8, 8));
    const rows = structuredClone(ROWS);
    rows[0].steps[1].state = 'done'; rows[0].steps[2].state = 'active'; rows[0].now = 'building';
    rows[0].steps.push({ ...step('s4', 'todo'), detail: 'see ![x](media/later.png)' });
    rows[0].needsAnh = 'Row ask';
    const r = await s.call('PUT', '/api/admin/tasks', { tasks: rows, summary: ['two'] });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.attached, 1);
    let st = await s.state();
    assert.deepEqual(st.tasks[0].steps.map(x => [x.id, x.state]), [['s1', 'done'], ['s2', 'done'], ['s3', 'active'], ['s4', 'todo']]);
    assert.deepEqual([st.tasks[0].currentStep.id, st.tasks[0].now, st.meta.summary[0]], ['s3', 'building', 'two']);
    assert.equal(st.tasks[0].needsAnh, 'Pick the hero', 'an open lane ask wins over the row, as asks.json did');
    assert.ok(Object.values(s.board.state.attachments).some(a => a.task_id === 'A-1' && a.name === 'later.png'));
    assert.equal(s.board.state.times['A-1/s3'].last_state, 'active', 'server clock moved by the push');

    for (const a of Object.values(s.board.state.asks)) if (a.task_id === 'A-1' && a.status === 'open') assert.deepEqual((await s.call('POST', '/api/admin/asks/clear', { id: a.id })).body, { ok: true, cleared: [a.id] }); // s21: a clear names the ask
    const again = await s.call('PUT', '/api/admin/tasks', { tasks: rows });
    assert.equal(again.body.attached, 0, 'media attached once');
    st = await s.state();
    assert.equal(st.tasks[0].needsAnh, 'Row ask', 'after clear the row ask shows, as the seed did');
    rows[0].needsAnh = '';
    await s.call('PUT', '/api/admin/tasks', { tasks: rows });
    assert.equal((await s.state()).tasks[0].needsAnh, '', 'a push-raised ask follows the row');
    const idem = s.board.state.seq;
    await s.call('PUT', '/api/admin/tasks', { tasks: rows });
    assert.equal(s.board.state.seq, idem, 're-pushing the same rows writes nothing');
  } finally { await s.close(); }
});

test('legacy compat: registry push keeps a status the owner set', async () => {
  const s = await setup();
  try {
    const registry = [
      { id: 'r1', file: 'A-1', code: 'A-1', title: 'Alpha v2', onBoard: true, status: 'open' },
      { id: 'r3', file: 'C-3', code: 'C-3', title: 'Gamma', onBoard: false, status: 'open' }];
    const r = await s.call('PUT', '/api/admin/registry', { registry });
    assert.deepEqual(r.body, { ok: true, count: 2 });
    const seq = s.board.state.seq;
    await s.call('PUT', '/api/admin/registry', { registry });
    assert.equal(s.board.state.seq, seq, 're-pushing the same registry writes nothing');
    const st = await s.state();
    assert.deepEqual(st.registry.map(e => [e.id, e.title, e.status, e.statusBy || '']), [['r1', 'Alpha v2', 'doing', 'anh'], ['r3', 'Gamma', 'open', '']]);
  } finally { await s.close(); }
});

test('legacy compat: a note answers a push-raised ask; the same row pushed again does not raise it again, the feed still shows the note', async () => {
  const s = await setup();
  try {
    const rows = structuredClone(ROWS);
    rows[1].needsAnh = 'Ship B?';
    assert.equal((await s.call('PUT', '/api/admin/tasks', { tasks: rows })).status, 200);
    assert.equal((await s.state()).tasks[1].needsAnh, 'Ship B?');
    const w = await fetch(s.url + '/api/v1/write', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.owner}` },
      body: JSON.stringify({ version: 1, request_id: 'owner-note-b2', op: 'feedback.add', target_id: 'B-2', data: { kind: 'approve', text: 'QC done, ship it', step_id: 's1' } }) });
    assert.equal(w.status, 200);
    let st = await s.state();
    assert.equal(st.tasks[1].needsAnh, '', 'answered: no longer waiting on anh');
    const fb = st.feedback.find(f => f.task === 'B-2' && f.text === 'QC done, ship it');
    assert.deepEqual([fb.by, fb.status, fb.step], ['anh', 'open', 's1'], 'watchers and ACME-02 still see new owner feedback');
    const seq = s.board.state.seq;
    await s.call('PUT', '/api/admin/tasks', { tasks: rows });
    assert.equal((await s.state()).tasks[1].needsAnh, '', 'not resurrected by the same row');
    assert.equal(s.board.state.seq, seq, 'nothing written');
    rows[1].needsAnh = 'Ship B now?';
    await s.call('PUT', '/api/admin/tasks', { tasks: rows });
    assert.equal((await s.state()).tasks[1].needsAnh, 'Ship B now?', 'a new question is raised');
  } finally { await s.close(); }
});

test('legacy compat: new message kinds read as the predecessor\'s note (+ msgKind); reply kind receipt is the coordinator\'s "Nhận" and closes the item', async () => {
  const s = await setup();
  try {
    const ownerWrite = async (data, n) => {
      const r = await fetch(s.url + '/api/v1/write', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.owner}` },
        body: JSON.stringify({ version: 1, request_id: 'owner-msg-' + n, op: 'feedback.add', target_id: 'B-2', data }) });
      assert.equal(r.status, 200); return (await r.json()).id;
    };
    const before = await s.state();
    const redirect = await ownerWrite({ kind: 'redirect', text: 'làm bản mobile trước' }, 1);
    await ownerWrite({ kind: 'askback', text: 'chi phí bao nhiêu?' }, 2);
    let st = await s.state();
    const rows = st.feedback.slice(-2);
    assert.deepEqual(rows.map(f => [f.kind, f.msgKind, f.by, f.status, f.text]), [
      ['note', 'redirect', 'anh', 'open', 'Đổi hướng: làm bản mobile trước'], ['note', 'askback', 'anh', 'open', 'Hỏi lại: chi phí bao nhiêu?']]);
    const LEGACY_FIELDS = new Set(['id', 'task', 'step', 'text', 'kind', 'by', 'status', 'at', 'replyTo', 'mode', 'note', 'doneAt']);
    assert.ok(st.feedback.every(f => Object.keys(f).every(k => LEGACY_FIELDS.has(k) || k === 'msgKind')), 'predecessor fields only; msgKind is the one addition');
    assert.deepEqual(before.feedback, st.feedback.slice(0, before.feedback.length), 'existing rows unchanged');
    const legacyId = st.feedback.find(f => f.msgKind === 'redirect').id;
    const bad = await s.call('POST', '/api/admin/reply', { task: 'B-2', text: 'Đổi: x', replyTo: legacyId, kind: 'receipt' });
    assert.equal(bad.status, 400); assert.equal(bad.body.error, 'receipt_lines_required');
    const r = await s.call('POST', '/api/admin/reply', { task: 'B-2', text: 'Đổi: bước mobile lên trước\nLịch: 03-10 → 05-10\nBước tiếp: s1', replyTo: legacyId, kind: 'nhan' });
    assert.equal(r.status, 201, JSON.stringify(r.body)); assert.equal(r.body.kind, 'note');
    st = await s.state();
    assert.equal(st.feedback.find(f => f.id === legacyId).status, 'done', 'the receipt closes the owner item');
    assert.equal(st.feedback.find(f => f.id === r.body.id).msgKind, 'receipt');
    assert.equal(s.board.state.feedback[redirect].received.receipt_id.startsWith('fb-'), true);
  } finally { await s.close(); }
});

test('legacy compat: a push cannot un-pause a task the owner paused (health green in the row, status stays paused)', async () => {
  const s = await setup();
  try {
    const ownerW = async (op, target, data, extra = {}) => (await fetch(s.url + '/api/v1/write', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.owner}` },
      body: JSON.stringify({ version: 1, request_id: 'own-' + op + Math.random(), op, target_id: target, data, ...extra }) })).status;
    assert.equal(await ownerW('task.update', 'A-1', { status: 'paused' }, { expected_revision: s.board.state.tasks['A-1'].rev }), 200);
    const rows = structuredClone(ROWS); rows[0].health = 'green'; rows[0].now = 'pushed while paused';
    const r = await s.call('PUT', '/api/admin/tasks', { tasks: rows });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(s.board.state.tasks['A-1'].status, 'paused', 'still the owner\'s pause');
    assert.equal(s.board.state.tasks['A-1'].now, 'pushed while paused', 'the rest of the row applied');
    assert.equal((await s.state()).tasks[0].health, 'grey', 'the predecessor shape still shows it paused (grey)');
  } finally { await s.close(); }
});

test('legacy compat: a receipt reply echoes msgKind receipt and reply_to; pasted images show on the feedback row as URLs the coordinator can GET', async () => {
  const s = await setup();
  try {
    const owner = { Authorization: `Bearer ${s.owner}` };
    const up = await fetch(`${s.url}/api/v1/upload?request_id=paste-compat-1&task_id=B-2&name=shot.png&mime=image%2Fpng&purpose=message`, { method: 'POST', headers: { ...owner, 'Content-Type': 'image/png' }, body: demoPng(8, 8) });
    const att = (await up.json()).id;
    const w = await fetch(s.url + '/api/v1/write', { method: 'POST', headers: { ...owner, 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: 1, request_id: 'img-note-1', op: 'feedback.add', target_id: 'B-2', data: { kind: 'note', text: 'see screenshot', attachments: [att] } }) });
    assert.equal(w.status, 200);
    const row = (await s.state()).feedback.find(f => f.text === 'see screenshot');
    assert.deepEqual(row.attachments, [`api/v1/media/${att}`]);
    // the coordinator's GET of that URL (Bearer coordinator → 200) is in message-images.test.mjs
    const r = await s.call('POST', '/api/admin/reply', { task: 'B-2', text: 'Đổi: không\nLịch: giữ\nBước tiếp: s1', replyTo: row.id, kind: 'receipt' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual([r.body.kind, r.body.msgKind, r.body.reply_to], ['note', 'receipt', row.id]);
    const plain = await s.call('POST', '/api/admin/reply', { task: 'B-2', text: 'ok', replyTo: row.id, close: false });
    assert.equal(plain.body.msgKind, undefined, 'a plain reply keeps the predecessor shape');
  } finally { await s.close(); }
});

test('legacy compat: a push without a task row leaves that task untouched (still paused); close is explicit and respects the owner', async () => {
  const s = await setup();
  try {
    const r0 = await fetch(s.url + '/api/v1/write', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.owner}` },
      body: JSON.stringify({ version: 1, request_id: 'own-pause-a1', op: 'task.update', target_id: 'A-1', data: { status: 'paused' }, expected_revision: s.board.state.tasks['A-1'].rev }) });
    assert.equal(r0.status, 200);
    const r = await s.call('PUT', '/api/admin/tasks', { tasks: structuredClone(ROWS).filter(x => x.code !== 'A-1') });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.untouched, ['A-1']);
    assert.equal(s.board.state.tasks['A-1']?.status, 'paused', 'not deleted, not closed, still the owner\'s pause');
    const c = await s.call('POST', '/api/admin/close', { code: 'A-1' });
    assert.deepEqual([c.status, c.body.error], [409, 'owner_set_status'], 'closing an owner-paused task is the owner\'s call too');
    const c2 = await s.call('POST', '/api/admin/close', { code: 'B-2' });
    assert.equal(c2.status, 200); assert.equal(s.board.state.tasks['B-2'].status, 'closed');
  } finally { await s.close(); }
});

test("compat: the sweep's status request reads as the board's (Bảng tự yêu cầu), the owner's press as anh's, and the sweep leaves `updated` alone", async () => {
  const clock = { ms: Date.parse('2026-10-10T10:00:00.000Z') };
  const s = await setup({ now: () => clock.ms });
  try {
    const f04 = steps => ({ code: 'F-04', title: 'Trang chu', lane: 'workera', health: 'green', now: 'vong 4', next: 'vong 5', needsAnh: '', order: 3, steps });
    const push = row => s.call('PUT', '/api/admin/tasks', { tasks: [row] });
    await push(f04([step('s1', 'active'), step('s2', 'todo')]));
    clock.ms = Date.parse('2026-10-11T10:00:00.000Z');
    await push(f04([step('s1', 'done'), step('s2', 'active')]));
    const before = (await s.state()).tasks.find(t => t.code === 'F-04').updated;
    clock.ms += 20 * 3600000;
    assert.ok(s.board.sweepFreshness() >= 1);
    const st = await s.state();
    assert.equal(st.tasks.find(t => t.code === 'F-04').updated, before, 'the sweep is not lane activity');
    const auto = st.feedback.find(f => f.task === 'F-04' && f.mode === 'status');
    assert.equal(auto.text, 'Bảng tự yêu cầu cập nhật trạng thái');
    assert.equal(auto.by, 'anh', 'still listed by `cos-board.mjs open`, which reads the owner items');
    assert.doesNotMatch(st.pings.at(-1).note, /anh yêu cầu/i);
    s.board.write(s.owner, { version: 1, request_id: 'press-status-0001', op: 'rebrief.request', target_id: 'F-04', data: { mode: 'status' } });
    const pressed = (await s.state()).feedback.filter(f => f.task === 'F-04' && f.mode === 'status').at(-1);
    assert.equal(pressed.text, 'Anh yêu cầu cập nhật trạng thái');
  } finally { await s.close(); }
});

test('compat /state: a push that moves steps but leaves now/next as they were reads staleText steps_newer (F-04, 10-10 to 11-10); new text clears it', async () => {
  const clock = { ms: Date.parse('2026-10-10T10:00:00.000Z') };
  const s = await setup({ now: () => clock.ms });
  try {
    const f04 = (steps, now) => ({ code: 'F-04', title: 'Trang chu', lane: 'workera', health: 'green', now, next: 'vong 5', needsAnh: '', order: 3, steps });
    const push = row => s.call('PUT', '/api/admin/tasks', { tasks: [row] });
    const row = async () => (await s.state()).tasks.find(t => t.code === 'F-04');
    const text = '10-10: trang chu vong 4 xong';
    assert.equal((await push(f04([step('s1', 'active'), step('s2', 'todo')], text))).status, 200);
    assert.equal((await row()).staleText, undefined);
    assert.equal((await row()).textAt, '2026-10-10T10:00:00.000Z');
    clock.ms = Date.parse('2026-11-10T10:00:00.000Z');
    assert.equal((await push(f04([step('s1', 'done'), step('s2', 'active')], text))).status, 200);
    assert.equal((await row()).staleText, 'steps_newer');
    assert.equal((await row()).textAt, '2026-10-10T10:00:00.000Z', 'steps moved, the text did not');
    clock.ms += 1000;
    assert.equal((await push(f04([step('s1', 'done'), step('s2', 'active')], '11-10: vong 5 dang lam'))).status, 200);
    assert.equal((await row()).staleText, undefined);
  } finally { await s.close(); }
});

// The one age rule (public/measure.js rowWaitSince): an ask counts from its own time (same-step re-asks chained), a waiting owner
// step with NO ask on it from its waiting_since, a step an ask sits on is skipped; the row's age is the oldest of those.
// /state askAt (the reminder hook reads it) and the rail (needRows over attention.waiting) must show the same number.
async function ageBoard() {
  const D = 86400000, T0 = Date.parse('2026-10-06T17:52:22.000Z'), at = ms => new Date(ms).toISOString();
  const clock = { now: T0 };
  const s = await setup({ now: () => clock.now });
  const row = (code, steps) => ({ code, title: code, lane: 'workera', health: 'yellow', now: 'n', next: '', needsAnh: '', order: 9, updated: at(clock.now), steps: [step('s1', 'done'), ...steps] });
  const push = async rows => assert.equal((await s.call('PUT', '/api/admin/tasks', { tasks: [...ROWS, ...rows] })).status, 200);
  const write = (op, target_id, data, extra = {}) => s.call('POST', '/api/v1/write', { version: 1, request_id: `age-${op}-${target_id}-${clock.now}-${Math.random()}`, op, target_id, data, ...extra }, { Authorization: `Bearer ${s.owner}` });
  const askAt = async code => (await s.state()).tasks.find(x => x.code === code).askAt;
  const railAt = code => globalThis.LaneMeasure.needRows(s.board.view(s.owner).attention.waiting).find(r => r.task_id === code)?.since;
  return { s, D, T0, at, clock, row, push, write, askAt, railAt };
}

test('age rule: a new ask on an OLD reused waiting step reads from the ask, not from the step (W-41 10-11: 4.8 days)', async () => {
  const { s, D, T0, at, clock, row, push, write, askAt, railAt } = await ageBoard();
  try {
    await push([row('W-1', [step('plan', 'waiting', 'anh')])]);          // the step has waited since T0
    clock.now = T0 + 5 * D;
    assert.equal((await write('ask.raise', 'W-1', { text: 'Close W-41?', step_id: 'plan' })).status, 200);
    assert.equal(await askAt('W-1'), at(T0 + 5 * D), 'the ask own time; the covered step old wait does not count');
    assert.equal(railAt('W-1'), at(T0 + 5 * D), 'the rail says the same');
  } finally { await s.close(); }
});

test('age rule: a same-step near-identical re-ask still counts back to the chain start (H-03)', async () => {
  const { s, D, T0, at, clock, row, push, write, askAt, railAt } = await ageBoard();
  try {
    await push([row('H-1', [step('o1', 'waiting', 'anh')])]);
    const first = await write('ask.raise', 'H-1', { text: 'Pick A, B or C?', step_id: 'o1' });
    assert.equal(first.status, 200);
    clock.now = T0 + 2 * D; assert.equal((await write('ask.clear', first.body.id, {}, { expected_revision: first.body.revision })).status, 200);                       // cleared, then raised again a minute later
    clock.now += 60000; assert.equal((await write('ask.raise', 'H-1', { text: 'Pick A, B or C?', step_id: 'o1' })).status, 200);
    assert.equal(await askAt('H-1'), at(T0), 'the chain starts at the first ask');
    assert.equal(railAt('H-1'), at(T0));
  } finally { await s.close(); }
});

test('age rule: a waiting owner step with NO ask on it still counts; a covered step does not; /state and the rail agree', async () => {
  const { s, D, T0, at, clock, row, push, write, askAt, railAt } = await ageBoard();
  try {
    await push([row('C-1', [step('o1', 'waiting', 'anh'), step('o2', 'todo', 'anh')])]);
    clock.now = T0 + D; await push([row('C-1', [step('o1', 'waiting', 'anh'), step('o2', 'waiting', 'anh')])]);           // o2 waits since T0+1d
    clock.now = T0 + 2 * D; assert.equal((await write('ask.raise', 'C-1', { text: 'Pick the camera?', step_id: 'o2' })).status, 200);
    assert.equal(await askAt('C-1'), at(T0), 'o1 has no ask: its wait since T0 still counts');
    for (const code of ['C-1']) assert.equal(railAt(code), await askAt(code), 'the rail and /state give the same number');
    clock.now = T0 + 3 * D; await push([row('C-1', [step('o1', 'done', 'anh'), step('o2', 'waiting', 'anh')])]);           // o1 closes
    assert.equal(await askAt('C-1'), at(T0 + 2 * D), 'only the ask is left, counted from its own time, not from the older wait of o2 (T0+1d)');
    assert.equal(railAt('C-1'), await askAt('C-1'));
    // every task that has an ask: the same number on both surfaces
    const st = await s.state();
    for (const task of st.tasks.filter(x => x.needsAnh)) assert.equal(railAt(task.code), task.askAt, task.code);
  } finally { await s.close(); }
});

test('age rule: a lane refreshing the text of its ask keeps the age (ACME-01); an owner reply on the step starts a new one; /state and the rail agree', async () => {
  const { s, D, T0, at, clock, row, push, write, askAt, railAt } = await ageBoard();
  try {
    await push([row('R-1', [step('o1', 'waiting', 'anh')])]);
    const first = await write('ask.raise', 'R-1', { text: 'Review the first draft', step_id: 'o1' });
    assert.equal(first.status, 200);
    clock.now = T0 + D;                                                                                                      // the lane refreshes the text a day later: clear + raise
    assert.equal((await write('ask.clear', first.body.id, {}, { expected_revision: first.body.revision })).status, 200);
    const second = await write('ask.raise', 'R-1', { text: 'A completely different wording, refreshed by the freshness rule', step_id: 'o1' });
    assert.equal(await askAt('R-1'), at(T0), 'a new text on the same step, no reply: the age of the first ask');
    assert.equal(railAt('R-1'), at(T0));
    clock.now = T0 + 2 * D;                                                                                                  // anh replies on the step (this answers the open ask), then the lane asks again
    assert.equal((await write('feedback.add', 'R-1', { kind: 'choice', text: 'B', step_id: 'o1' })).status, 200);
    clock.now = T0 + 3 * D;
    assert.equal((await write('ask.raise', 'R-1', { text: 'Next question', step_id: 'o1' })).status, 200);
    assert.equal(await askAt('R-1'), at(T0 + 3 * D), 'after the owner replied it is a new wait');
    assert.equal(railAt('R-1'), at(T0 + 3 * D), 'the rail says the same');
  } finally { await s.close(); }
});

test('age rule: a step finished and reopened is a new wait on /state and the rail, the real step history', async () => {
  const { s, D, T0, at, clock, row, push, write, askAt, railAt } = await ageBoard();
  try {
    await push([row('D-1', [step('o1', 'waiting', 'anh')])]);
    const first = await write('ask.raise', 'D-1', { text: 'Review the draft', step_id: 'o1' });
    assert.equal(first.status, 200);
    clock.now = T0 + D; assert.equal((await write('ask.clear', first.body.id, {}, { expected_revision: first.body.revision })).status, 200);
    await push([row('D-1', [step('o1', 'done', 'anh')])]);                                   // anh answered in chat: the lane closes the step
    clock.now = T0 + 10 * D; await push([row('D-1', [step('o1', 'waiting', 'anh')])]);      // weeks later it is reused
    assert.equal((await write('ask.raise', 'D-1', { text: 'Review the second draft', step_id: 'o1' })).status, 200);
    assert.equal(await askAt('D-1'), at(T0 + 10 * D), 'the step left waiting in between: a new wait, not the old ask');
    assert.equal(railAt('D-1'), at(T0 + 10 * D));
  } finally { await s.close(); }
});

test('age rule: a re-ask that replaces the ask on the same step chains; cos-board clear (the step goes done) and a later ask do not', async () => {
  const { s, D, T0, at, clock, row, push, askAt, railAt } = await ageBoard();
  try {
    const ask = (needsAnh, o1) => [{ ...row('K-1', [step('o1', o1, 'anh')]), needsAnh }];
    // (a) what `cos-board ask` writes for a re-ask: the pushed ask is cleared ("row needsAnh changed") and a new one raised, the step stays waiting
    await push(ask('Question one', 'waiting'));
    clock.now = T0 + D; await push(ask('Question one, rewritten', 'waiting'));
    assert.equal(await askAt('K-1'), at(T0), '(a) replaced by a re-ask on the same step: the same ask');
    assert.equal(railAt('K-1'), at(T0));
    // (b) what `cos-board clear` writes (anh answered in chat): the step goes done, the ask is closed; then a question on the same step later
    clock.now = T0 + 2 * D; await push(ask('', 'done'));
    clock.now = T0 + 3 * D; await push(ask('Question two', 'waiting'));
    assert.equal(await askAt('K-1'), at(T0 + 3 * D), '(b) closed by clear and asked again: a new wait');
    assert.equal(railAt('K-1'), at(T0 + 3 * D));
  } finally { await s.close(); }
});

test('compat: a no-op push writes 0 events and leaves the activity stamp alone (the auto-request 60-min rule reads it)', async () => {
  const clock = { ms: Date.parse('2026-10-10T10:00:00.000Z') };
  const s = await setup({ now: () => clock.ms });
  try {
    const row = { code: 'F-04', title: 'Trang chu', lane: 'workera', health: 'green', now: 'vong 4', next: 'vong 5', needsAnh: '', order: 3, updated: '2026-10-10T10:00:00.000Z', steps: [step('s1', 'active'), step('s2', 'todo')] };
    const push = () => s.call('PUT', '/api/admin/tasks', { tasks: [row] });
    assert.equal((await push()).body.ok, true);
    const stamp = s.board.state.activity['F-04'], seq = s.board.state.seq;
    for (const later of [1, 90]) {
      clock.ms += later * 60000;
      const r = await push();
      assert.equal(r.body.writes, 0, `re-push after ${later} min writes nothing`);
      assert.equal(s.board.state.seq, seq);
      assert.equal(s.board.state.activity['F-04'], stamp, 'the stamp stays at the last real change');
    }
  } finally { await s.close(); }
});
