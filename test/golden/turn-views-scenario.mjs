// One deterministic board, read through every view that existed BEFORE turn.report: GET /api/v1/state (with and without ?v=1) and
// the predecessor-compatible /api/state (plain and ?v=2) and /api/times. `viewsOf(srcRoot)` runs it against ANY checkout of the
// code, so turn-views-baseline.json was produced by the commit before turn.report (2b790b0) and the current code is held to it,
// byte for byte. The clock is a variable the scenario moves, so how many times the code reads it cannot change a result.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const OWNER = 'golden-owner-secret-0123456789';
const step = (id, state, zone, extra = {}) => ({ id, label: `Step ${id}`, sub: '', state, zone, ...extra });

export async function viewsOf(srcRoot, { withTurns = false } = {}) {
  const load = f => import(pathToFileURL(path.join(srcRoot, 'src', f)).href);
  const [{ createBoard }, { createServer }, { createLegacyCompat }] = await Promise.all([load('board.mjs'), load('server.mjs'), load('legacy-compat.mjs')]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'laneboard-golden-'));
  const dataDir = path.join(dir, 'data'), mediaDir = path.join(dir, 'media');
  fs.mkdirSync(dataDir); fs.mkdirSync(mediaDir);
  let clock = Date.parse('2026-10-13T08:00:00.000Z');
  const tick = ms => { clock += ms; };
  const board = createBoard({ dataDir, ownerToken: OWNER, now: () => clock });
  let n = 0;
  const w = (token, op, target_id, data = {}, extra = {}) => { tick(60000); return board.write(token, { version: 1, request_id: `golden-${op}-${++n}-padding`, op, target_id, data, ...extra }); };
  const coord = w(OWNER, 'token.issue', 'coordinator', { role: 'coordinator', lane: 'coordination' }).token;
  const alpha = w(OWNER, 'token.issue', 'lane-alpha', { role: 'reporter', lane: 'Workera CoS', scope_tasks: ['*'] }).token;
  w(coord, 'task.create', 'G-1', { title: 'Landing page', lane: 'Workera CoS', now: 'building', next: 'ship', steps: [step('s1', 'done', 'plan'), step('s2', 'active', 'build'), step('s3', 'waiting', 'owner')] });
  w(coord, 'task.create', 'G-2', { title: 'Rate limiter', lane: 'Workerb', steps: [step('s1', 'waiting', 'owner')] });
  w(coord, 'ask.raise', 'G-1', { text: 'Hero A or B?', step_id: 's3', options: [{ key: 'A', label: 'Photo' }, { key: 'B', label: 'Drawing' }] });
  w(coord, 'ask.raise', 'G-2', { text: 'Which limit?', step_id: 's1' });
  w(OWNER, 'feedback.add', 'G-1', { kind: 'note', text: 'bigger button' });
  w(OWNER, 'routing.set', 'G-1', { model: 'opus', effort: 'high' });
  w(alpha, 'inbox.submit', 'G-1', { kind: 'report', text: 'layout done' });
  w(OWNER, 'ping.send', 'board', { task_id: 'G-1', note: '' });
  tick(3600000);
  if (withTurns) { // reports must leave every other view exactly as it was (apart from the board's own seq); the clock goes back so every age is the same
    const at = clock;
    w(alpha, 'turn.report', 'Workera CoS', { turn_id: 'golden-turn-1', detail: '# Done\nLayout built.' });
    w(coord, 'turn.report', 'Workerb', { turn_id: 'golden-turn-2', detail: 'x' });
    clock = at;
  }

  const tokenFile = path.join(dir, 'coord.token');
  fs.writeFileSync(tokenFile, coord);
  const compat = createLegacyCompat(board, { tokenFile, dataDir, mediaDir });
  const server = createServer(board, { legacyCompat: compat });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const get = async (route, headers = {}) => (await fetch(url + route, { headers })).text();
  try {
    return {
      v1: await get('/api/v1/state', { Authorization: `Bearer ${OWNER}` }),
      v1explicit: await get('/api/v1/state?v=1', { Authorization: `Bearer ${OWNER}` }),
      v1coordinator: await get('/api/v1/state', { Authorization: `Bearer ${coord}` }),
      v1anonymous: await get('/api/v1/state'),
      legacy: await get('/api/state', { 'X-Forwarded-For': 't31' }),
      legacyV2: await get('/api/state?v=2', { 'X-Forwarded-For': 't31' }),
      legacyTimes: await get('/api/times', { 'X-Forwarded-For': 't31' })
    };
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); board.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}
