#!/usr/bin/env node
// ACME-02 step-click check (owner 30-10: "có cái click đúng có cái click sai"): opening a step row in the Inspector must bring
// a SHOWN stream entry of that step into the reader's view, and a step with no shown entry must leave the stream where it was.
//
//   node scripts/check-step-click.mjs --playwright <playwright-core dir> --chromium <chromium binary> [--code <dir>] [--out <dir>]
//
// Seeds a SYNTHETIC task through the real write API, in stream order:
//   s3 note (outside the newest-40 window) · 45 fillers · s2 ask, then withdrawn (folded in the closed "withdrawn" row
//   near the top) · 12 fillers · s2 note · 6 fillers · s4 note · 6 fillers.
// Cases: s2 (its first DOM match is the hidden withdrawn ask), s3 (no shown entry), s4 (control: one plain shown entry).
// Before the fix s2 and s3 leave the stream at scrollTop 0; s4 is right either way.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2), arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CODE = path.resolve(arg('--code', HERE)), OUT = path.resolve(arg('--out', path.join(os.tmpdir(), 'laneboard-step-click')));
const PW = arg('--playwright'), EXE = arg('--chromium');
if (!PW || !EXE) { console.error('usage: check-step-click.mjs --playwright <playwright-core dir> --chromium <binary> [--code <dir>] [--out <dir>]'); process.exit(2); }
const SIZES = [[1204, 754], [1844, 971]];
const log = [], failures = [];
const L = s => { log.push(s); console.log(s); };
const fail = s => { failures.push(s); L('FAIL ' + s); };
const ok = (cond, msg) => { if (cond) L('ok ' + msg); else fail(msg); };

const { createBoard } = await import(pathToFileURL(path.join(CODE, 'src', 'board.mjs')));
const { createServer } = await import(pathToFileURL(path.join(CODE, 'src', 'server.mjs')));
const { chromium } = createRequire(path.join(PW, 'package.json'))(PW);

fs.mkdirSync(OUT, { recursive: true });
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'laneboard-step-click-data-'));
let server, board;
try {
  const proxySecret = crypto.randomBytes(32).toString('base64url');
  board = createBoard({ dataDir: scratch });
  server = createServer(board, { ownerProxySecret: proxySecret });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  L(`check: code ${CODE} · out ${OUT} · ${base}`);
  const OWNER = { 'X-Laneboard-Owner-Proxy': proxySecret, 'X-Requested-With': 'laneboard' };
  const rid = () => 'sc-' + crypto.randomBytes(6).toString('hex');
  const api = async (headers, op, target_id, data, extra = {}) => {
    const r = await fetch(base + '/api/v1/write', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ version: 1, request_id: rid(), op, target_id, data, ...extra }) });
    const body = await r.json();
    if (!r.ok) throw new Error(`seed ${op} ${target_id}: ${r.status} ${JSON.stringify(body)}`);
    return body;
  };
  const coordToken = (await api(OWNER, 'token.issue', 'sc-coordinator-' + crypto.randomBytes(3).toString('hex'), { role: 'coordinator', replace_coordinator: true, label: 'step-click check' })).token;
  const COORD = { Authorization: `Bearer ${coordToken}` };
  await api(COORD, 'task.create', 'SC-1', { title: 'Step-click fixture', lane: 'fixture', now: 'Synthetic.', next: 'Click steps', steps: [
    { id: 's1', label: 'First synthetic step', zone: 'build', state: 'active' },
    { id: 's2', label: 'Step with a withdrawn ask', zone: 'build', state: 'todo' },
    { id: 's3', label: 'Step with no shown entry', zone: 'build', state: 'todo' },
    { id: 's4', label: 'Control step', zone: 'build', state: 'todo' }] });
  let n = 0;
  const filler = async k => { for (let i = 0; i < k; i++) await api(OWNER, 'feedback.add', 'SC-1', { kind: 'note', text: `Filler note ${++n}.` }); };
  const stepNote = (sid, marker) => api(OWNER, 'feedback.add', 'SC-1', { kind: 'note', text: `${marker} on ${sid}.`, step_id: sid });
  await stepNote('s3', 'OldMarkerS3');
  await filler(45);
  const ask = await api(COORD, 'ask.raise', 'SC-1', { text: 'WithdrawnMarkerS2: a question that gets withdrawn.', step_id: 's2' });
  await api(COORD, 'ask.clear', ask.id, { note: 'withdrawn by the check' }, { expected_revision: ask.rev ?? ask.revision });
  await filler(12);
  await stepNote('s2', 'ShownMarkerS2');
  await filler(6);
  await stepNote('s4', 'ShownMarkerS4');
  await filler(6);
  L(`seeded SC-1: ${n} filler notes, withdrawn ask ${ask.id} on s2`);

  // Where the stream sits and which steps' shown entries are inside its visible box.
  const VIEW = () => {
    const st = document.getElementById('stream-scroll'), r = st.getBoundingClientRect();
    const vis = [...st.querySelectorAll('.ev[data-step]')].filter(e => { const b = e.getBoundingClientRect(); return b.height && b.bottom > r.top && b.top < r.bottom; }).map(e => e.dataset.step);
    return { top: Math.round(st.scrollTop), max: st.scrollHeight - st.clientHeight, visible: [...new Set(vis)].filter(Boolean) };
  };
  const SHOWN = sid => [...document.querySelectorAll(`#stream-scroll .ev[data-step="${CSS.escape(sid)}"]`)].some(e => !e.closest('details:not([open])') && e.getClientRects().length);

  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  try {
    for (const [w, h] of SIZES) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, extraHTTPHeaders: { 'X-Laneboard-Owner-Proxy': proxySecret }, colorScheme: 'dark' });
      const page = await ctx.newPage();
      const errs = [];
      page.on('pageerror', e => errs.push('pageerror: ' + e.message));
      page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
      await page.goto(`${base}/#/task/SC-1`, { waitUntil: 'networkidle' });
      await page.waitForSelector('.srow-main', { timeout: 20000 });
      await page.waitForTimeout(800);
      const fixture = await page.evaluate(() => ({
        hiddenAsk: !!document.querySelector('#stream-scroll details.ev-withdrawn:not([open]) .ev[data-step="s2"]'),
        firstS2Hidden: !!document.querySelector('#stream-scroll [data-step="s2"]')?.closest('details:not([open])'),
        s3InDom: !!document.querySelector('#stream-scroll .ev[data-step="s3"]') }));
      ok(fixture.hiddenAsk && fixture.firstS2Hidden && !fixture.s3InDom, `${w}: fixture shape: s2's first match is the folded withdrawn ask, s3 has no shown entry (${JSON.stringify(fixture)})`);
      for (const sid of ['s2', 's3', 's4']) {
        // start each case from the middle of the stream, so "left at the top" and "kept place" differ
        await page.evaluate(() => { const st = document.getElementById('stream-scroll'); st.scrollTop = Math.round((st.scrollHeight - st.clientHeight) / 2); });
        const before = (await page.evaluate(VIEW)).top;
        await page.click(`.srow-main[data-step="SC-1/${sid}"]`);
        await page.waitForTimeout(350);
        const v = await page.evaluate(VIEW);
        const open = await page.evaluate(s => document.querySelector(`.srow-main[data-step="${CSS.escape(s)}"]`)?.getAttribute('aria-expanded'), `SC-1/${sid}`);
        const shown = await page.evaluate(SHOWN, sid);
        const right = shown ? v.visible.includes(sid) : Math.abs(v.top - before) <= 2;
        ok(open === 'true' && right, `${w}: opening ${sid} ${shown ? 'brings its shown entry into view' : 'keeps the stream in place'} (before ${before}, ${JSON.stringify(v)})`);
        await page.screenshot({ path: path.join(OUT, `step-${sid}-${w}.png`) });
        await page.click(`.srow-main[data-step="SC-1/${sid}"]`); // close it again
        await page.waitForTimeout(250);
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
  L(failures.length ? `STEP-CLICK CHECK FAILED (${failures.length})` : 'STEP-CLICK CHECK PASSED');
  fs.writeFileSync(path.join(OUT, 'check-step-click.log'), log.join('\n') + '\n');
  process.exitCode = failures.length ? 1 : 0;
}
