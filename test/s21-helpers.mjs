// Shared fixture for the s21 (shared rows) tests: a board with the predecessor-compat layer on, a coordinator token,
// and tasks in several lanes, one of them (F-04) shared by Workera CoS and Workerb the way the live board has it.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createBoard } from '../src/board.mjs';
import { createServer } from '../src/server.mjs';
import { createLegacyCompat } from '../src/legacy-compat.mjs';
import { OWNER, tmpDir } from './helpers.mjs';

export { OWNER };
let n = 0;
export const step = (id, state, zone = 'build', extra = {}) => ({ id, label: `Step ${id}`, sub: '', state, zone, ...extra });

/** A board on a fresh (or given) data dir with /api/state, /api/admin/* and the v1 API on one local server. */
export async function s21Board({ dataDir = path.join(tmpDir(), 'board'), keepOpen = false, autoCompact = false, now } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const board = createBoard({ dataDir, ownerToken: OWNER, ...(now ? { now } : {}) });
  const tokenFile = path.join(tmpDir(), 'coord.token');
  const coord = fs.existsSync(path.join(dataDir, 'coord.token')) ? fs.readFileSync(path.join(dataDir, 'coord.token'), 'utf8').trim()
    : board.write(OWNER, { version: 1, request_id: 'coord-' + crypto.randomBytes(6).toString('hex'), op: 'token.issue', target_id: 'coordinator', data: { role: 'coordinator' } }).token;
  fs.writeFileSync(tokenFile, coord);
  fs.writeFileSync(path.join(dataDir, 'coord.token'), coord);
  const media = path.join(tmpDir(), 'media'); fs.mkdirSync(media, { recursive: true });
  const legacyCompat = createLegacyCompat(board, { tokenFile, dataDir, mediaDir: media, autoCompact });
  const server = createServer(board, { legacyCompat });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  // Admin routes answer a direct loopback caller only (no X-Forwarded-For); state reads can carry one (ACME-02 shape).
  const call = async (method, route, body, headers = {}) => {
    const res = await fetch(url + route, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json };
  };
  const state = (v) => call('GET', '/api/state' + (v ? `?v=${v}` : ''), undefined, { 'X-Forwarded-For': 't31' }).then(r => r.body);
  const code = async (c, v) => (await state(v)).tasks.find(t => t.code === c);
  const push = (tasks, extra = {}) => call('PUT', '/api/admin/tasks', { tasks, ...extra });
  const ask = (body) => call('POST', '/api/admin/asks', body);
  const clear = (body) => call('POST', '/api/admin/asks/clear', body);
  /** Direct coordinator write (fixtures); throws on a refusal so a setup problem fails loudly. */
  const w = (op, target_id, data = {}, extra = {}) => board.write(coord, { version: 1, request_id: `s21-${process.pid}-${++n}`, op, target_id, data, ...extra });
  const ownerW = (op, target_id, data = {}, extra = {}) => board.write(OWNER, { version: 1, request_id: `s21o-${process.pid}-${++n}`, op, target_id, data, ...extra });
  const v1 = async (token, method, route, body) => {
    const res = await fetch(url + route, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const v1state = () => v1(OWNER, 'GET', '/api/v1/state').then(r => r.body);
  const openAsks = (task) => Object.values(board.state.asks).filter(a => a.status === 'open' && (!task || a.task_id === task));
  const steps = (task) => board.state.tasks[task].step_ids.slice();
  const close = async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); board.close(); };
  return { board, dataDir, url, call, state, code, push, ask, clear, w, ownerW, v1, v1state, openAsks, steps, coord, close, media };
}

/** Runs `withLane`; on a board that does not know a lane on steps yet (076010f) runs `without` instead, so the same fixture
 *  shows what that build does (the red run of these tests) instead of failing in the set-up. */
export function withLane(withLane, without) {
  try { return withLane(); } catch (e) { if (e.code !== 'invalid_data') throw e; return without(); }
}

/** The live shape: F-04 is Workera CoS's task; Workerb owns its step video-ad. Lanes known to the board: Workera CoS, Workerb, Fable. */
export function seedShared(s) {
  // Lanes exist because tasks have them: the other lanes' tasks first, so Workerb is known before a step is stamped with it.
  s.w('task.create', 'V-1', { title: 'Workerb own task', lane: 'Workerb', order: 2, steps: [step('v1', 'active')] });
  s.w('task.create', 'FB-1', { title: 'Fable own task', lane: 'Fable', order: 3, steps: [step('f1', 'active')] });
  s.w('task.create', 'F-04', { title: 'Trang chủ', lane: 'Workera CoS', health: 'yellow', now: 'Workera now', next: 'Workera next', order: 1,
    steps: [step('s1', 'done'), step('workera-step', 'waiting', 'owner')] });
  withLane(() => s.w('step.create', 'F-04/video-ad', { label: 'Video ad', zone: 'owner', state: 'waiting', lane: 'Workerb' }),
    () => s.w('step.create', 'F-04/video-ad', { label: 'Video ad', zone: 'owner', state: 'waiting' }));
}

/** A legacy row as the CLI pushes it. */
export const row = (code, lane, steps, extra = {}) => ({ code, title: extra.title ?? code, lane, health: 'yellow', order: extra.order ?? 1, ...extra, steps });
export const rowOf = (s, code, over = {}) => {
  // The task as the board holds it, as a row (what a lane sends after reading /api/state).
  const t = s.board.state.tasks[code];
  return { code, title: t.title, lane: t.lane, health: t.health, goal: t.goal ?? '', now: t.now ?? '', next: t.next ?? '', order: t.order, ...over,
    steps: (over.steps ?? t.step_ids.map(id => s.board.state.steps[`${code}/${id}`]).map(st => ({ id: st.id.split('/')[1], label: st.label, sub: st.sub ?? '', state: st.state, zone: st.zone === 'owner' ? 'anh' : st.zone }))) };
};
