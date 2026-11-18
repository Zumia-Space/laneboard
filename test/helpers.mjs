import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createBoard } from '../src/board.mjs';
import { createServer } from '../src/server.mjs';

export const OWNER = 'test-owner-secret-0123456789';
export const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'laneboard-test-'));
export const rid = () => 'test-' + crypto.randomBytes(8).toString('hex');

/** In-process HTTP server on a free port with a fresh data dir. */
export async function startServer(opts = {}) {
  const dataDir = opts.dataDir || tmpDir();
  const board = createBoard({ dataDir, ownerToken: OWNER, ...opts });
  const server = createServer(board);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const call = async (token, method, route, body) => {
    const headers = { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) };
    const res = await fetch(url + route, { method, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json, headers: res.headers };
  };
  const write = (token, op, target_id, data = {}, extra = {}) => call(token, 'POST', '/api/v1/write', { version: 1, request_id: rid(), op, target_id, data, ...extra });
  const state = token => call(token, 'GET', '/api/v1/state').then(r => r.body);
  const close = async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); board.close(); }; // SSE streams stay open otherwise
  return { url, dataDir, board, server, call, write, state, close };
}

/** A board with a coordinator, two scoped reporters and one task WEB-3 (s1 done, s2 active, s3 waiting on owner). */
export async function startSeeded(opts = {}) {
  const s = await startServer(opts);
  const issue = async (name, data) => (await s.write(OWNER, 'token.issue', name, data)).body.token;
  s.coord = await issue('coordinator', { role: 'coordinator', lane: 'coordination', model: 'opus' });
  s.alpha = await issue('lane-alpha', { role: 'reporter', lane: 'lane-alpha', model: 'sonnet', scope_tasks: ['WEB-3'] });
  s.beta = await issue('lane-beta', { role: 'reporter', lane: 'lane-beta', scope_tasks: ['API-2'] });
  const r = await s.write(s.coord, 'task.create', 'WEB-3', {
    title: 'Landing page', lane: 'lane-alpha', steps: [
      { id: 's1', label: 'Brief', zone: 'plan', state: 'done' },
      { id: 's2', label: 'Build', zone: 'build', state: 'active' },
      { id: 's3', label: 'Owner picks hero', zone: 'owner', state: 'waiting' }
    ]
  });
  if (r.status !== 200) throw new Error('seed failed ' + JSON.stringify(r.body));
  await s.write(s.coord, 'task.create', 'API-2', { title: 'Rate limiter', steps: [{ id: 's1', label: 'Implement', zone: 'build', state: 'active' }] });
  return s;
}
