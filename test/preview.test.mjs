// BOARD_PREVIEW_READONLY: a read-only preview of the board (a new UI over a copy of the data). Every write route is
// refused 403 preview_readonly — v1 writes, uploads, the compat admin routes, any other method — and nothing is journaled;
// reads still work and the state tells the page it is a preview.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createBoard } from '../src/board.mjs';
import { createServer } from '../src/server.mjs';
import { createLegacyCompat, createLegacyMedia } from '../src/legacy-compat.mjs';
import { tmpDir, OWNER } from './helpers.mjs';
import { demoPng } from '../scripts/seed.mjs';

async function preview() {
  const dataDir = tmpDir(), media = tmpDir();
  fs.writeFileSync(path.join(media, 'a.png'), demoPng(4, 4));
  const board = createBoard({ dataDir, ownerToken: OWNER });
  const w = (op, target_id, data) => board.write(OWNER, { version: 1, request_id: 'seed-' + op + target_id, op, target_id, data });
  const coord = w('token.issue', 'coordinator', { role: 'coordinator' }).token;
  w('task.create', 'T-1', { title: 'Task', steps: [{ id: 's1', label: 'One', zone: 'build', state: 'active' }] });
  const tokenFile = path.join(dataDir, 'coord.token'); fs.writeFileSync(tokenFile, coord);
  const legacyCompat = createLegacyCompat(board, { tokenFile, dataDir, mediaDir: media });
  const servers = [createServer(board, { legacyCompat, readOnly: true, mainUrl: '/laneboard/' }), createServer(board, { legacyMedia: createLegacyMedia(media), readOnly: true })];
  for (const s of servers) await new Promise(r => s.listen(0, '127.0.0.1', r));
  const url = s => `http://127.0.0.1:${s.address().port}`;
  const close = async () => { for (const s of servers) { s.closeAllConnections(); await new Promise(r => s.close(r)); } board.close(); };
  return { board, coord, compatUrl: url(servers[0]), mediaUrl: url(servers[1]), close };
}

test('preview: every write route is refused 403 preview_readonly and nothing is written', async () => {
  const p = await preview();
  try {
    const seq = p.board.state.seq;
    const json = { 'Content-Type': 'application/json' };
    const write = { version: 1, request_id: 'pv-1', op: 'feedback.add', target_id: 'T-1', data: { kind: 'note', text: 'x' } };
    const routes = [
      ['POST', '/api/v1/write', write, { ...json, Authorization: `Bearer ${OWNER}` }],
      ['POST', '/api/v1/write', { ...write, request_id: 'pv-2', op: 'prefs.set', target_id: 'tok-1', data: { lang: 'vi' } }, { ...json, Authorization: `Bearer ${OWNER}` }],
      ['POST', '/api/v1/upload?request_id=pv-3&task_id=T-1&name=a.png&mime=image/png', 'x', { Authorization: `Bearer ${OWNER}`, 'Content-Type': 'application/octet-stream' }],
      ['POST', '/api/admin/reply', { task: 'T-1', text: 'hi' }, json],
      ['POST', '/api/admin/asks', { code: 'T-1', text: 'q?' }, json],
      ['POST', '/api/admin/asks/clear', { code: 'T-1' }, json],
      ['POST', '/api/admin/pings/seen', {}, json],
      ['POST', '/api/admin/plans', { task: 'T-1', reviewer: 'Fable', body: 'b' }, json],
      ['PUT', '/api/admin/tasks', { tasks: [] }, json],
      ['PUT', '/api/admin/registry', { registry: [] }, json],
      ['PATCH', '/api/v1/write', write, json], ['DELETE', '/api/v1/state', undefined, {}], ['POST', '/anything', {}, json]
    ];
    for (const base of [p.compatUrl, p.mediaUrl]) {
      for (const [method, route, body, headers] of routes) {
        const r = await fetch(base + route, { method, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
        assert.equal(r.status, 403, `${method} ${route}`);
        assert.deepEqual(await r.json(), { error: 'preview_readonly' }, `${method} ${route}`);
      }
    }
    assert.equal(p.board.state.seq, seq, 'nothing journaled');
    // reads still work, and tell the page it is a preview
    const st = await (await fetch(p.compatUrl + '/api/v1/state', { headers: { Authorization: `Bearer ${OWNER}` } })).json();
    assert.deepEqual([st.config.read_only, st.config.main_url, st.tasks.length], [true, '/laneboard/', 1]);
    assert.equal((await fetch(p.compatUrl + '/api/state', { headers: { 'X-Forwarded-For': 'x' } })).status, 200);
    assert.equal((await fetch(p.compatUrl + '/healthz')).status, 200);
    // without a compat token the media folder is still served, read only
    const img = await fetch(p.mediaUrl + '/media/a.png');
    assert.equal(img.status, 200); assert.equal(img.headers.get('content-type'), 'image/png');
    assert.deepEqual((await (await fetch(p.mediaUrl + '/api/media')).json()).map(f => f.name), ['a.png']);
  } finally { await p.close(); }
});

test('preview page: a banner linking the main board, writes stopped in the page too', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /if \(readOnly\(\)\) \{ toast\(t\('preview\.refused'\)\); return null; \}/);
  assert.match(app, /bar\.innerHTML = `\$\{esc\(t\('preview\.banner'\)\)\} <a href="\$\{esc\(main\)\}">/);
  assert.match(app, /'#main textarea'/);
  const vi = JSON.parse(fs.readFileSync(new URL('../public/locales/vi.json', import.meta.url), 'utf8'));
  assert.equal(vi['preview.banner'], 'BẢN XEM THỬ — trả lời ở bảng chính');
});

// The documented compatibility promise: without BOARD_PREVIEW_MAIN_URL the preview banner links to /zumia/.
// createServer takes the value as an option, so the default lives in the start-up code: run the real entry point.
test('preview: BOARD_PREVIEW_MAIN_URL defaults to /zumia/ and an env value replaces it', async () => {
  const { spawn } = await import('node:child_process');
  const entry = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..', 'src', 'server.mjs');
  async function mainUrl(extraEnv) {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const child = spawn(process.execPath, [entry], {
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', BOARD_DATA: tmpDir(), BOARD_OWNER_TOKEN: OWNER, BOARD_PREVIEW_READONLY: '1', ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('server did not start')), 15000);
        child.stdout.on('data', d => { if (String(d).includes('laneboard listening')) { clearTimeout(timer); resolve(); } });
        child.on('exit', code => reject(new Error('server exited ' + code)));
      });
      const st = await (await fetch(`http://127.0.0.1:${port}/api/v1/state`, { headers: { Authorization: `Bearer ${OWNER}` } })).json();
      assert.equal(st.config.read_only, true);
      return st.config.main_url;
    } finally { child.kill(); }
  }
  assert.equal(await mainUrl({ BOARD_PREVIEW_MAIN_URL: '' }), '/zumia/', 'the default is kept');
  assert.equal(await mainUrl({ BOARD_PREVIEW_MAIN_URL: '/board/' }), '/board/', 'the env value wins');
});
