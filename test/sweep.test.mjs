// J-05 "Cập nhật" (sweep) button: the owner asks the coordinator to re-check every task's status. It is a feedback.add of
// kind `sweep` on the whole-board target `*` (no new op: a journal that replays on an older build must not hit an
// unknown op). One open sweep at a time, enforced by the server; the coordinator's reply (or feedback.resolve) closes it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createBoard } from '../src/board.mjs';
import { createServer } from '../src/server.mjs';
import { createLegacyCompat } from '../src/legacy-compat.mjs';
import { OWNER, startSeeded, tmpDir, rid } from './helpers.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..'), PUB = path.join(ROOT, 'public');
const TEXT = 'Anh yêu cầu rà lại tình trạng các task';
const sweep = (s, token = OWNER, extra = {}) => s.write(token, 'feedback.add', '*', { kind: 'sweep', text: TEXT }, extra);
const clone = o => JSON.parse(JSON.stringify(o));
/** A view without its live clock fields (measured work/wait times move with every read). */
const steady = o => JSON.parse(JSON.stringify(o, (k, v) => (/_ms$/.test(k) ? undefined : v)));

test('an owner sweep on * is accepted: one open feedback record, no activity key "*", no task touched', async () => {
  const s = await startSeeded();
  try {
    const before = clone(s.board.state);
    const r = await sweep(s);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const f = s.board.state.feedback[r.body.id];
    assert.deepEqual([f.kind, f.task_id, f.status, f.attribution.created_by.role], ['sweep', '*', 'open', 'owner']);
    assert.ok(!('*' in s.board.state.activity), 'activity has no fake key');
    assert.deepEqual(s.board.state.activity, before.activity);
    assert.deepEqual(s.board.state.tasks, before.tasks);
    assert.deepEqual(s.board.state.asks, before.asks);
  } finally { await s.close(); }
});

test('a second sweep while one is open: 409 sweep_open with the open id; nothing journaled; a same request_id retry still dedupes', async () => {
  const s = await startSeeded();
  try {
    const first = await sweep(s, OWNER, { request_id: 'sweep-req-1' });
    assert.equal(first.status, 200);
    const seq = s.board.state.seq;
    const again = await sweep(s);
    assert.equal(again.status, 409);
    assert.equal(again.body.error, 'sweep_open');
    assert.equal(again.body.feedback_id, first.body.id);
    assert.equal(s.board.state.seq, seq, 'journal unchanged');
    const retry = await sweep(s, OWNER, { request_id: 'sweep-req-1' });
    assert.equal(retry.status, 200);
    assert.equal(retry.body.deduped, true);
    assert.equal(retry.body.id, first.body.id);
  } finally { await s.close(); }
});

test('refusals: a coordinator or reporter sweep gets 403; a sweep on a task id gets 400; a note on * gets 400', async () => {
  const s = await startSeeded();
  try {
    const seq = s.board.state.seq;
    let r = await sweep(s, s.coord);
    assert.equal(r.status, 403); assert.equal(r.body.error, 'owner_only_kind');
    r = await sweep(s, s.alpha);
    assert.equal(r.status, 403);
    r = await s.write(OWNER, 'feedback.add', 'WEB-3', { kind: 'sweep', text: TEXT });
    assert.equal(r.status, 400); assert.equal(r.body.error, 'sweep_target');
    r = await s.write(OWNER, 'feedback.add', '*', { kind: 'note', text: 'hello' });
    assert.equal(r.status, 400); assert.equal(r.body.error, 'not_a_task');
    r = await s.write(OWNER, 'feedback.add', '*', { kind: 'sweep', text: TEXT, step_id: 's1' });
    assert.equal(r.status, 400, 'a sweep carries no step');
    r = await s.write(OWNER, 'feedback.add', '*', { kind: 'sweep', text: TEXT, ask_id: 'ask-1' });
    assert.equal(r.status, 400, 'a sweep carries no ask');
    r = await s.write(OWNER, 'feedback.add', '*', { kind: 'sweep', text: TEXT, attachments: ['att-1'] });
    assert.equal(r.status, 400, 'a sweep carries no attachment');
    assert.equal(s.board.state.seq, seq, 'nothing journaled');
    assert.ok(!Object.values(s.board.state.feedback).some(f => f.task_id === '*'));
  } finally { await s.close(); }
});

test('the coordinator closes a sweep with a reply (resolve_reply_to) or feedback.resolve; a new sweep is then accepted', async () => {
  const s = await startSeeded();
  try {
    const a = (await sweep(s)).body.id;
    const reply = await s.write(s.coord, 'feedback.add', '*', { kind: 'reply', text: 'Rà xong', reply_to: a, resolve_reply_to: true });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.equal(s.board.state.feedback[a].status, 'resolved');
    assert.ok(!('*' in s.board.state.activity));
    const b = await sweep(s);
    assert.equal(b.status, 200);
    const res = await s.write(s.coord, 'feedback.resolve', b.body.id, {}, { expected_revision: s.board.state.feedback[b.body.id].rev });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(s.board.state.feedback[b.body.id].status, 'resolved');
    assert.ok(!('*' in s.board.state.activity));
    assert.equal((await sweep(s)).status, 200);
    // `*` takes only a sweep, or a reply to one
    const open = Object.values(s.board.state.feedback).find(f => f.kind === 'sweep' && f.status === 'open').id;
    const stray = await s.write(s.coord, 'feedback.add', '*', { kind: 'reply', text: 'x' });
    assert.equal(stray.status, 400); assert.equal(stray.body.error, 'not_a_task');
    const other = await s.write(s.coord, 'feedback.add', 'WEB-3', { kind: 'note', text: 'n' });
    assert.equal(other.status, 200);
    const wrong = await s.write(s.coord, 'feedback.add', '*', { kind: 'reply', text: 'x', reply_to: other.body.id });
    assert.equal(wrong.status, 400); assert.equal(wrong.body.error, 'not_a_task');
    assert.equal(s.board.state.feedback[open].status, 'open');
  } finally { await s.close(); }
});

test('the predecessor API: /api/admin/reply {task:"*", replyTo, close:true} resolves the sweep; /api/state lists it; a new sweep then returns 200', async () => {
  const dataDir = tmpDir(), tokenFile = path.join(tmpDir(), 'coord.token');
  const board = createBoard({ dataDir, ownerToken: OWNER });
  const coord = board.write(OWNER, { version: 1, request_id: rid(), op: 'token.issue', target_id: 'coordinator', data: { role: 'coordinator' } }).token;
  fs.writeFileSync(tokenFile, coord);
  board.write(coord, { version: 1, request_id: rid(), op: 'task.create', target_id: 'A-1', data: { title: 'Alpha', lane: 'workera', steps: [{ id: 's1', label: 'one', zone: 'build', state: 'active' }] } });
  const server = createServer(board, { legacyCompat: createLegacyCompat(board, { tokenFile, dataDir, mediaDir: '' }) });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, route, body, headers = {}) => {
    const res = await fetch(url + route, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json };
  };
  const ownerWrite = () => call('POST', '/api/v1/write', { version: 1, request_id: rid(), op: 'feedback.add', target_id: '*', data: { kind: 'sweep', text: TEXT } }, { Authorization: `Bearer ${OWNER}` });
  try {
    const first = await ownerWrite();
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const st = await call('GET', '/api/state', undefined, { 'X-Forwarded-For': 't31-coordinator' });
    const row = st.body.feedback.find(f => f.task === '*');
    assert.ok(row, 'the compat state lists the sweep');
    assert.deepEqual([row.kind, row.by, row.status], ['sweep', 'anh', 'open']);
    assert.ok(!st.body.tasks.some(t => t.code === '*'));
    // the sweep CLI asks for each row's task status; the pinned wires never carry it
    assert.equal((await call('GET', '/api/state?v=2&status=1', undefined, { 'X-Forwarded-For': 't31-coordinator' })).body.tasks[0].status, 'doing');
    assert.ok(!('status' in (await call('GET', '/api/state?v=2', undefined, { 'X-Forwarded-For': 't31-coordinator' })).body.tasks[0]));
    const r = await call('POST', '/api/admin/reply', { task: '*', step: '', text: 'Rà xong', replyTo: row.id, close: true });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(board.state.feedback[first.body.id].status, 'resolved');
    assert.equal((await ownerWrite()).status, 200, 'a new sweep after the close');
    assert.equal((await call('POST', '/api/admin/reply', { task: '*', text: 'x' })).status, 400, 'a reply to nothing on * is still refused');
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); board.close(); }
});

test('replay: deleting the projection and reopening the store gives the identical state, sweep included', async () => {
  const s = await startSeeded();
  try {
    const a = (await sweep(s)).body.id;
    await s.write(s.coord, 'feedback.add', '*', { kind: 'reply', text: 'ok', reply_to: a, resolve_reply_to: true });
    await sweep(s);
    const final = clone(s.board.state), dir = s.dataDir;
    s.board.close();
    fs.rmSync(path.join(dir, 'state.json'));
    const b2 = createBoard({ dataDir: dir, ownerToken: OWNER });
    assert.deepEqual(clone(b2.state), final);
    assert.equal(Object.values(b2.state.feedback).filter(f => f.kind === 'sweep' && f.status === 'open').length, 1);
    b2.close();
  } finally { s.server.closeAllConnections(); await new Promise(r => s.server.close(r)); }
});

test('an open sweep changes no task row, no attention item, no compat task list, and no read throws', async () => {
  const s = await startSeeded();
  try {
    const read = async () => {
      const v = await s.call(OWNER, 'GET', '/api/v1/state?v=2');
      assert.equal(v.status, 200);
      return v.body;
    };
    const before = await read();
    assert.equal((await sweep(s)).status, 200);
    const after = await read();
    assert.deepEqual(steady(after.tasks), steady(before.tasks));
    assert.deepEqual(steady(after.attention.waiting), steady(before.attention.waiting));
    assert.deepEqual(steady(after.stalled), steady(before.stalled));
    assert.ok(after.feedback.some(f => f.kind === 'sweep' && f.task_id === '*' && f.status === 'open'), 'the page can find it in feedback');
    for (const route of ['/api/v1/state', '/api/v1/state?v=2', '/api/v1/events?limit=1000', '/api/v1/messages']) {
      const r = await s.call(OWNER, 'GET', route);
      assert.ok(r.status < 500, `${route}: ${r.status}`);
    }
    const coordView = await s.call(s.coord, 'GET', '/api/v1/state?v=2');
    assert.equal(coordView.status, 200);
    const scoped = await s.call(s.alpha, 'GET', '/api/v1/state?v=2');
    assert.equal(scoped.status, 200);
    assert.ok(!(scoped.body.feedback || []).some(f => f.task_id === '*'), 'a lane scoped to its task never sees a whole-board sweep');
  } finally { await s.close(); }
});

// ---------- the page ----------
const APP = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');
const loc = l => JSON.parse(fs.readFileSync(path.join(PUB, 'locales', `${l}.json`), 'utf8'));
const LOC = { en: loc('en'), vi: loc('vi'), zh: loc('zh') };
function lift(name) {
  const line = APP.match(new RegExp(`^const ${name} = .*;$`, 'm'));
  if (line) return line[0];
  const start = APP.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `app.js has no ${name}`);
  return APP.slice(start, APP.indexOf('\n}\n', start) + 2);
}
const NOW = Date.parse('2026-05-01T09:00:00.000Z'); // 16:00 in Vietnam
function page(lang, data) {
  const ctx = vm.createContext({ S: { dict: LOC[lang], en: LOC.en, data, sweepBusy: false }, mdInline: s => String(s), fmtTime: ts => ts, serverNow: () => NOW });
  vm.runInContext(['esc', 't', 'VN_MS', 'vnDate', 'vnHM', 'vnDay', 'vnWhen', 'role', 'isOwner', 'readOnly', 'sweepOf', 'sweepButton'].map(lift).join('\n'), ctx);
  return ctx;
}
const fb = (id, status, at, over = {}) => ({ id, task_id: '*', kind: 'sweep', text: TEXT, status, attribution: { created_at: at, created_by: { role: 'owner' } }, ...(status === 'resolved' ? { resolved: { at: '2026-05-01T08:30:00.000Z' } } : {}), ...over });
const data = (feedback, over = {}) => ({ me: { role: 'owner' }, config: {}, feedback, ...over });
const html = (lang, d, busy = false) => { const p = page(lang, d); p.S.sweepBusy = busy; return vm.runInContext('sweepButton()', p); };

test('page: idle shows an enabled "Cập nhật" button, and the last closed sweep time once there is one', () => {
  for (const lang of ['en', 'vi', 'zh']) {
    const idle = html(lang, data([]));
    assert.match(idle, /data-action="sweep"/, `${lang}: ${idle}`);
    assert.ok(!/disabled/.test(idle), `${lang}: enabled`);
    assert.ok(idle.includes(LOC[lang]['sweep.button']) && idle.includes(`title="${LOC[lang]['sweep.title']}"`), lang);
    assert.ok(!idle.includes(LOC[lang]['sweep.last'].replace('{time}', '')), `${lang}: no "last" before any sweep closed`);
    const closed = html(lang, data([fb('fb-1', 'resolved', '2026-05-01T08:00:00.000Z')]));
    assert.match(closed, /data-action="sweep"/);
    assert.ok(closed.includes(LOC[lang]['sweep.last'].replace('{time}', '15:30')), `${lang}: ${closed}`);
  }
  assert.equal(vm.runInContext('t("sweep.button")', page('vi', data([]))), 'Cập nhật');
});

test('page: an open sweep is a disabled chip "Đã gửi, CoS đang rà · HH:MM"; sending disables the button; not rendered for a non-owner or a preview', () => {
  const open = html('vi', data([fb('fb-2', 'open', '2026-05-01T08:00:00.000Z')]));
  assert.ok(open.includes('Đã gửi, CoS đang rà · 15:00'), open);
  assert.ok(/disabled/.test(open) && !/data-action="sweep"/.test(open), 'no live click target while open');
  const sending = html('vi', data([]), true);
  assert.match(sending, /disabled/); assert.ok(!/data-action="sweep"/.test(sending));
  assert.equal(html('vi', data([], { me: { role: 'coordinator' } })), '');
  assert.equal(html('vi', data([], { me: null })), '');
  assert.equal(html('vi', data([], { config: { read_only: true } })), '');
  // a resolved older sweep plus an open newer one is still "open"
  assert.ok(html('en', data([fb('fb-1', 'resolved', '2026-05-01T07:00:00.000Z'), fb('fb-3', 'open', '2026-05-01T08:00:00.000Z')])).includes(LOC.en['sweep.open'].replace('{time}', '15:00')));
});

test('page wiring: the button sits in the top row (railShell .brand, also in embed mode); the click writes a sweep on * and a 409 only refreshes', () => {
  const shell = APP.slice(APP.indexOf('function railShell('), APP.indexOf('// Gear icon'));
  assert.match(shell, /sweepButton\(\)/);
  assert.match(shell, /<div class="brand">.*\$\{sweepButton\(\)\}/s, 'inside the brand row');
  assert.match(APP, /action === 'sweep'/);
  assert.match(APP, /write\('feedback\.add', '\*', \{ kind: 'sweep'/);
  assert.match(APP, /sweep_open/);
  assert.match(fs.readFileSync(path.join(PUB, 'styles.css'), 'utf8'), /\.sweep-btn/);
});

test('locales: sweep.button / title / open / last / sentToast and feedback.kind.sweep in vi, en and zh', () => {
  for (const l of ['vi', 'en', 'zh']) for (const k of ['sweep.button', 'sweep.title', 'sweep.open', 'sweep.last', 'sweep.sentToast', 'feedback.kind.sweep']) assert.ok(LOC[l][k], `${l}: ${k}`);
  assert.equal(LOC.vi['sweep.open'], 'Đã gửi, CoS đang rà · {time}');
  assert.equal(LOC.vi['sweep.title'], 'Nhờ CoS rà lại tình trạng mọi task');
});
