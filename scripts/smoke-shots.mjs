#!/usr/bin/env node
// Pre-ship smoke: run before every swap. Starts a scratch board on a COPY of a data dir (or an empty one), seeds the
// states that empty boards never show — an answered ask (Home's "answered" list), a coordinator receipt, an
// owner-paused task, an owner message with a pasted image — through the real HTTP write APIs, then renders Home, a
// task page, the Task list and the Thợ tab at 1440, 1366 and 390 in headless Chromium. Exit 1 on any page error,
// any console error, or Home still showing "Loading…" (01-10: a removed helper left Home on "Loading…" forever once
// the first owner answer existed; an empty-state shot never hit it).
//
//   node scripts/smoke-shots.mjs --playwright <playwright-core dir> --chromium <chromium/headless-shell binary>
//        [--data <board data dir to COPY>] [--code <Laneboard code dir to run, default this repo>] [--out <dir>] [--scheme dark|light] [--query embed=1&lang=en]
//
// The source data dir is only read (copied with fs.cpSync); the copy is deleted at the end. Nothing listens beyond
// 127.0.0.1. The owner is the scratch login-proxy owner; the coordinator is a scratch token issued in the copy.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { demoPng } from './seed.mjs';

const args = process.argv.slice(2), arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CODE = path.resolve(arg('--code', HERE)), SRC_DATA = arg('--data', ''), OUT = path.resolve(arg('--out', path.join(os.tmpdir(), 'laneboard-smoke')));
const PW = arg('--playwright'), EXE = arg('--chromium'), SCHEME = arg('--scheme', 'dark') === 'light' ? 'light' : 'dark';
const QUERY = arg('--query', ''); // e.g. embed=1&lang=en: render the page the way the Zumi desktop app embeds it
if (!PW || !EXE) { console.error('usage: smoke-shots.mjs --playwright <playwright-core dir> --chromium <binary> [--data <dir>] [--code <dir>] [--out <dir>]'); process.exit(2); }
const VIEWPORTS = [[1440, 900], [1366, 768], [390, 844]];
const log = [], failures = [];
const L = s => { log.push(s); console.log(s); };
const fail = s => { failures.push(s); L('FAIL ' + s); };

const { createBoard } = await import(pathToFileURL(path.join(CODE, 'src', 'board.mjs')));
const { createServer } = await import(pathToFileURL(path.join(CODE, 'src', 'server.mjs')));
const { chromium } = createRequire(path.join(PW, 'package.json'))(PW);

fs.mkdirSync(OUT, { recursive: true });
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'laneboard-smoke-data-'));
let server, board;
try {
  if (SRC_DATA) { fs.cpSync(SRC_DATA, scratch, { recursive: true }); fs.rmSync(path.join(scratch, 'owner.token'), { force: true }); }
  const proxySecret = crypto.randomBytes(32).toString('base64url');
  board = createBoard({ dataDir: scratch });
  server = createServer(board, { ownerProxySecret: proxySecret });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  L(`smoke: code ${CODE} · data ${SRC_DATA ? 'copy of ' + SRC_DATA : 'empty board'} · ${base}`);

  // ---- seeding through the real write APIs (owner via the login proxy, coordinator via a scratch token) ----
  const OWNER = { 'X-Laneboard-Owner-Proxy': proxySecret, 'X-Requested-With': 'laneboard' };
  const rid = () => 'smoke-' + crypto.randomBytes(6).toString('hex');
  const api = async (headers, op, target_id, data, extra = {}) => {
    const r = await fetch(base + '/api/v1/write', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ version: 1, request_id: rid(), op, target_id, data, ...extra }) });
    const body = await r.json();
    if (!r.ok) throw new Error(`seed ${op} ${target_id}: ${r.status} ${JSON.stringify(body)}`);
    return body;
  };
  const state = async () => (await fetch(base + '/api/v1/state', { headers: OWNER })).json();
  const coordToken = (await api(OWNER, 'token.issue', 'smoke-coordinator-' + crypto.randomBytes(3).toString('hex'), { role: 'coordinator', replace_coordinator: true, label: 'smoke coordinator' })).token;
  const COORD = { Authorization: `Bearer ${coordToken}` };
  const steps = [{ id: 's1', label: 'Build', zone: 'build', state: 'done' }, { id: 's2', label: 'Owner QC', zone: 'owner', state: 'waiting' }, { id: 's3', label: 'Ship', zone: 'ship', state: 'todo' }, { id: 's4', label: 'Smoke: a long step report', zone: 'build', state: 'todo' }];
  // A synthetic long report so the reader view has a read button to open (no real content).
  const LONG_REPORT = ['# Smoke long report', ...Array.from({ length: 30 }, (_, i) => `- synthetic line ${i + 1} of the smoke reader fixture, long enough to open in the reader`)].join('\n');
  await api(COORD, 'task.create', 'SMOKE-1', { title: 'Smoke: answered ask, receipt, pasted image', lane: 'smoke', now: 'Seeded by scripts/smoke-shots.mjs', next: 'Render every view', steps, worker: { model: 'opus', effort: 'high', reason: 'smoke' } });
  await api(COORD, 'task.create', 'SMOKE-2', { title: 'Smoke: paused by the owner', lane: 'smoke', steps: [{ id: 's1', label: 'Work', zone: 'build', state: 'active' }] });
  const stSteps = await state();
  await api(COORD, 'step.update', 'SMOKE-1/s4', { detail: LONG_REPORT }, { expected_revision: stSteps.tasks.find(t => t.id === 'SMOKE-1').steps.find(s => s.id === 'SMOKE-1/s4').rev });
  const ask = await api(COORD, 'ask.raise', 'SMOKE-1', { text: 'Smoke: does the build pass QC?', step_id: 's2' });
  const answer = await api(OWNER, 'feedback.add', 'SMOKE-1', { kind: 'note', text: 'Smoke: QC ok, go on.', ask_id: ask.id, step_id: 's2' });
  await api(COORD, 'feedback.add', 'SMOKE-1', { kind: 'receipt', reply_to: answer.id, text: 'Đổi: nothing\nLịch: unchanged\nBước tiếp: s3' });
  await api(COORD, 'ask.raise', 'SMOKE-1', { text: 'Smoke: an ask still waiting on the owner' });
  const s0 = await state();
  await api(OWNER, 'task.update', 'SMOKE-2', { status: 'paused' }, { expected_revision: s0.tasks.find(t => t.id === 'SMOKE-2').rev });
  const up = await fetch(`${base}/api/v1/upload?request_id=${rid()}&task_id=SMOKE-1&name=smoke-paste.png&mime=image%2Fpng&purpose=message`, { method: 'POST', headers: { ...OWNER, 'Content-Type': 'image/png' }, body: demoPng(320, 180) });
  const upBody = await up.json();
  if (!up.ok) throw new Error(`seed upload: ${up.status} ${JSON.stringify(upBody)}`);
  await api(OWNER, 'feedback.add', 'SMOKE-1', { kind: 'note', text: 'Smoke: pasted screenshot.', attachments: [upBody.id] });
  const reg = (await state()).docs?.registry;
  const entries = [...(reg?.entries || []).filter(e => !/^smoke-/.test(e.id)), { id: 'smoke-1', code: 'SMOKE-1', title: 'Smoke task', status: 'doing', on_board: true }, { id: 'smoke-2', code: 'SMOKE-2', title: 'Smoke paused', status: 'doing', on_board: true }];
  await api(COORD, 'registry.set', 'board', { entries }, { expected_revision: reg?.rev || 0 });
  const st = await state();
  L(`seeded: answered asks ${st.attention.answered.length} · waiting ${st.attention.waiting.length} · SMOKE-2 ${st.tasks.find(t => t.id === 'SMOKE-2').status} · image ${upBody.id}`);
  if (!st.attention.answered.length) fail('seed: attention.answered is empty');

  // ---- render every view at every width; collect page errors and console errors ----
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  try {
    for (const [w, h] of VIEWPORTS) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, extraHTTPHeaders: { 'X-Laneboard-Owner-Proxy': proxySecret }, colorScheme: SCHEME });
      const page = await ctx.newPage();
      const errs = [];
      page.on('pageerror', e => errs.push('pageerror: ' + e.message));
      page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
      const view = async (name, hash, after) => {
        const before = errs.length;
        await page.goto(base + '/' + (QUERY ? '?' + QUERY : '') + hash, { waitUntil: 'networkidle' });
        await page.reload({ waitUntil: 'networkidle' }); // a fresh render of exactly this view
        await page.waitForTimeout(1200);
        // --scheme light: the owner's stored theme (often dark) would win over the browser's scheme, so the light theme
        // is applied the way the Appearance setting does it, in this page only (nothing is written).
        if (SCHEME === 'light') await page.evaluate(() => { try { S.prefs.theme = 'light'; applyPrefs(); } catch { document.documentElement.classList.remove('dark'); } });
        if (after) await after();
        const loading = await page.evaluate(() => { const m = document.getElementById('main'); return !!m && (!!m.querySelector('[data-loading]') || /^\s*(Loading…|Đang tải…|加载中…)\s*$/.test(m.innerText)); });
        await page.screenshot({ path: path.join(OUT, `${name}-${w}${SCHEME === 'light' ? '-light' : ''}.png`) });
        const mine = errs.slice(before);
        if (loading) fail(`${name} ${w}: main pane still shows "Loading…"`);
        for (const e of mine) fail(`${name} ${w}: ${e}`);
        L(`${name} ${w}: ${loading ? 'LOADING' : 'rendered'} · errors ${mine.length}`);
      };
      await view('home', '#/home');
      await view('task', '#/task/SMOKE-1');
      await view('tasklist', '#/registry');
      await view('worker-tab', '#/task/SMOKE-1', async () => {
        const tab = page.locator('.tab[data-tab="worker"]');
        if (await tab.count()) { await tab.click(); await page.waitForTimeout(500); } else fail(`worker-tab ${w}: no Thợ tab`);
      });
      await view('reader', '#/task/SMOKE-1', async () => {
        const stepsTab = page.locator('.tab[data-tab="steps"]');
        if (await stepsTab.count()) { await stepsTab.click(); await page.waitForTimeout(400); }
        const row = page.locator('.srow-main[data-step="SMOKE-1/s4"]');
        if (!(await row.count())) { fail(`reader ${w}: no long-report step`); return; }
        await row.click();
        await page.waitForTimeout(400);
        const read = page.locator('.sdetail .read-open[data-step="SMOKE-1/s4"]');
        if (!(await read.count())) { fail(`reader ${w}: the long report shows no read button`); return; }
        await read.click();
        await page.waitForTimeout(500);
      });
      await ctx.close();
    }
  } finally { await browser.close(); }
} catch (e) {
  fail('smoke run: ' + e.message);
} finally {
  if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  board?.close();
  fs.rmSync(scratch, { recursive: true, force: true }); // the scratch copy never outlives the run
  L(failures.length ? `SMOKE FAILED (${failures.length})` : 'SMOKE PASSED');
  fs.writeFileSync(path.join(OUT, 'smoke.log'), log.join('\n') + '\n');
  process.exitCode = failures.length ? 1 : 0;
}
