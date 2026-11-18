#!/usr/bin/env node
// ACME-02 context-jump check (owner evt-9810): clicking a question in the task status panel ("Tình hình") must bring the
// middle reader (the "Trao đổi" stream) to THAT question's thread, and a poll refresh must leave it there.
//
//   node scripts/check-ask-context-jump.mjs --playwright <playwright-core dir> --chromium <chromium binary> [--code <dir>] [--out <dir>]
//
// Seeds a SYNTHETIC task through the real write API: three open asks, each after a run of 20 filler notes, so their
// threads sit at clearly different heights in the stream, and a tail of notes after the last one. The oldest ask lies
// outside the stream's newest-40 window, as on a long-running task. At 1204x754 (the
// Zumi board area) and 1844x1034 it clicks the 2nd ask card, then the 3rd, then the 1st; after each click and after a
// poll refresh (window.refresh) it measures the ask's stream entry against the stream's visible box.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2), arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CODE = path.resolve(arg('--code', HERE)), OUT = path.resolve(arg('--out', path.join(os.tmpdir(), 'laneboard-ask-jump')));
const PW = arg('--playwright'), EXE = arg('--chromium');
if (!PW || !EXE) { console.error('usage: check-ask-context-jump.mjs --playwright <playwright-core dir> --chromium <binary> [--code <dir>] [--out <dir>]'); process.exit(2); }
const SIZES = [[1204, 754], [1844, 1034]];
const log = [], failures = [];
const L = s => { log.push(s); console.log(s); };
const fail = s => { failures.push(s); L('FAIL ' + s); };
const ok = (cond, msg) => { if (cond) L('ok ' + msg); else fail(msg); };

const WORDS = 'capacity report synthetic fixture row column value export batch window ledger timeline status owner note review'.split(' ');
const sentence = i => { const w = []; for (let k = 0; k < 14; k++) w.push(WORDS[(i * 7 + k * 5) % WORDS.length]); const s = w.join(' '); return s[0].toUpperCase() + s.slice(1) + '.'; };

const { createBoard } = await import(pathToFileURL(path.join(CODE, 'src', 'board.mjs')));
const { createServer } = await import(pathToFileURL(path.join(CODE, 'src', 'server.mjs')));
const { chromium } = createRequire(path.join(PW, 'package.json'))(PW);

fs.mkdirSync(OUT, { recursive: true });
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'laneboard-ask-jump-data-'));
let server, board;
try {
  const proxySecret = crypto.randomBytes(32).toString('base64url');
  board = createBoard({ dataDir: scratch });
  server = createServer(board, { ownerProxySecret: proxySecret });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  L(`check: code ${CODE} · out ${OUT} · ${base}`);
  const OWNER = { 'X-Laneboard-Owner-Proxy': proxySecret, 'X-Requested-With': 'laneboard' };
  const rid = () => 'cj-' + crypto.randomBytes(6).toString('hex');
  const api = async (headers, op, target_id, data, extra = {}) => {
    const r = await fetch(base + '/api/v1/write', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ version: 1, request_id: rid(), op, target_id, data, ...extra }) });
    const body = await r.json();
    if (!r.ok) throw new Error(`seed ${op} ${target_id}: ${r.status} ${JSON.stringify(body)}`);
    return body;
  };
  const coordToken = (await api(OWNER, 'token.issue', 'cj-coordinator-' + crypto.randomBytes(3).toString('hex'), { role: 'coordinator', replace_coordinator: true, label: 'ask-jump check' })).token;
  const COORD = { Authorization: `Bearer ${coordToken}` };
  await api(COORD, 'task.create', 'CJ-1', { title: 'Context-jump fixture: three open questions', lane: 'fixture', now: 'Waiting on three synthetic questions.', next: 'Answer them', steps: [
    { id: 's1', label: 'First synthetic step', zone: 'owner', state: 'waiting' },
    { id: 's2', label: 'Second synthetic step', zone: 'owner', state: 'waiting' },
    { id: 's3', label: 'Third synthetic step', zone: 'owner', state: 'waiting' }] });
  let n = 0;
  const filler = async k => { for (let i = 0; i < k; i++) await api(OWNER, 'feedback.add', 'CJ-1', { kind: 'note', text: `Filler note ${++n}. ${sentence(n)} ${sentence(n + 50)}` }); };
  const askIds = []; // one open ask per step (the board refuses a second one on the same step)
  for (const [q, sid] of [['Alpha', 's1'], ['Bravo', 's2'], ['Charlie', 's3']]) {
    await filler(20);
    askIds.push((await api(COORD, 'ask.raise', 'CJ-1', { text: `QuestionMarker${q}: ${sentence(q.length * 11)}`, step_id: sid })).id);
  }
  await filler(6);
  L(`seeded CJ-1: ${n} filler notes, asks ${askIds.join(', ')}`);

  // In-page probe: where the clicked ask's stream entry sits inside the stream's visible box.
  const PROBE = askId => {
    const st = document.getElementById('stream-scroll'), el = document.getElementById('ev-' + askId), center = document.querySelector('.center');
    if (!st || !el) return { missing: !st ? 'stream' : 'entry' };
    const s = st.getBoundingClientRect(), e = el.getBoundingClientRect();
    const visible = Math.max(0, Math.min(e.bottom, s.bottom) - Math.max(e.top, s.top));
    return { sTop: Math.round(s.top), sBottom: Math.round(s.bottom), eTop: Math.round(e.top), eBottom: Math.round(e.bottom), visible: Math.round(visible), eH: Math.round(e.height),
      scrollTop: Math.round(st.scrollTop), scrollMax: st.scrollHeight - st.clientHeight, centerTop: center ? Math.round(center.scrollTop) : -1,
      pageTop: Math.round(document.scrollingElement.scrollTop), b2: document.documentElement.classList.contains('b2'),
      text: el.textContent.match(/QuestionMarker\w+/)?.[0] || '' };
  };
  // "In view": the entry is fully inside the stream's box, or (a tall entry) its top sits at the box's top.
  const inView = p => !p.missing && ((p.eTop >= p.sTop - 2 && p.eBottom <= p.sBottom + 2) || (Math.abs(p.eTop - p.sTop) <= 24 && p.visible >= Math.min(p.eH, p.sBottom - p.sTop) - 2));

  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  try {
    for (const [w, h] of SIZES) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, extraHTTPHeaders: { 'X-Laneboard-Owner-Proxy': proxySecret }, colorScheme: 'dark' });
      const page = await ctx.newPage();
      const errs = [];
      page.on('pageerror', e => errs.push('pageerror: ' + e.message));
      page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
      await page.goto(`${base}/#/task/CJ-1`, { waitUntil: 'networkidle' });
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForTimeout(800);
      const cards = await page.evaluate(() => [...document.querySelectorAll('#situation [data-action="ask-card"]')].map(b => b.dataset.ask));
      ok(cards.length === 3, `${w}: the status panel shows three ask cards (${cards.join(', ')})`);
      const start = await page.evaluate(() => { const st = document.getElementById('stream-scroll'); return { top: Math.round(st.scrollTop), max: st.scrollHeight - st.clientHeight }; });
      L(`${w}: stream on open: scrollTop ${start.top} of ${start.max}`);
      for (const [label, idx] of [['2nd', 1], ['3rd', 2], ['1st', 0]]) {
        const askId = cards[idx];
        if (!askId) { fail(`${w}: no ${label} ask card`); continue; }
        await page.click(`#situation [data-action="ask-card"][data-ask="${askId}"]`);
        await page.waitForTimeout(350);
        const p = await page.evaluate(PROBE, askId);
        ok(inView(p), `${w}: clicking the ${label} ask (${askId} ${p.text}) puts its thread in the reader's view (${JSON.stringify(p)})`);
        await page.screenshot({ path: path.join(OUT, `ask-${label}-${w}.png`) });
        await page.evaluate(() => window.refresh());
        await page.waitForTimeout(600);
        const q = await page.evaluate(PROBE, askId);
        ok(inView(q) && Math.abs(q.scrollTop - p.scrollTop) <= 2, `${w}: after a poll refresh the ${label} ask's thread stays in view (${q.scrollTop} vs ${p.scrollTop}, ${JSON.stringify(q)})`);
      }
      ok(errs.length === 0, `${w}: no page errors (${errs.join(' | ')})`);
      await ctx.close();
    }
  } finally { await browser.close(); }
} catch (e) {
  fail('check crashed: ' + (e.stack || e.message));
} finally {
  if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  board?.close();
  fs.rmSync(scratch, { recursive: true, force: true });
  L(failures.length ? `ASK-CONTEXT-JUMP CHECK FAILED (${failures.length})` : 'ASK-CONTEXT-JUMP CHECK PASSED');
  fs.writeFileSync(path.join(OUT, 'check-ask-context-jump.log'), log.join('\n') + '\n');
  process.exitCode = failures.length ? 1 : 0;
}
