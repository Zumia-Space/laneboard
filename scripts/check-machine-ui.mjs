#!/usr/bin/env node
// J-05 worker-machine-0811 browser check: the task header names the machines ("Điều phối: Máy 1 · Làm: Máy 3 (laptop)"),
// and the owner picks the coordinator, the worker machines and a slot's machine with the same chip + popover UX as the
// model, written at once and still there after a reload.
//
//   node scripts/check-machine-ui.mjs --playwright <playwright-core dir> --chromium <chromium binary> [--code <dir>] [--out <dir>]
//
// Seeds a SYNTHETIC board through the real write API: ACME-01 seeded by the coordinator (CoS) as main -> laptop, J-05 as
// main -> spare, WEB-1 with no pick (defaults). Shots (Vietnamese, light and dark, 1280 and 375 px) go to --out.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2), arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CODE = path.resolve(arg('--code', HERE)), OUT = path.resolve(arg('--out', path.join(os.tmpdir(), 'laneboard-machine-ui')));
const PW = arg('--playwright'), EXE = arg('--chromium');
if (!PW || !EXE) { console.error('usage: check-machine-ui.mjs --playwright <playwright-core dir> --chromium <binary> [--code <dir>] [--out <dir>]'); process.exit(2); }
const failures = [];
const L = s => console.log(s);
const ok = (cond, msg) => { if (cond) L('ok ' + msg); else { failures.push(msg); L('FAIL ' + msg); } };
const STEPS = [{ id: 's1', label: 'Brief', zone: 'plan', state: 'done' }, { id: 's2', label: 'Build', zone: 'build', state: 'active' }];

const { createBoard } = await import(pathToFileURL(path.join(CODE, 'src', 'board.mjs')));
const { createServer } = await import(pathToFileURL(path.join(CODE, 'src', 'server.mjs')));
const { chromium } = createRequire(path.join(PW, 'package.json'))(PW);
fs.mkdirSync(OUT, { recursive: true });
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'laneboard-machine-ui-data-'));
let server, board;
try {
  const proxySecret = crypto.randomBytes(32).toString('base64url');
  board = createBoard({ dataDir: scratch });
  server = createServer(board, { ownerProxySecret: proxySecret });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const OWNER = { 'X-Laneboard-Owner-Proxy': proxySecret, 'X-Requested-With': 'laneboard' };
  const write = async (headers, op, target_id, data) => {
    const r = await fetch(base + '/api/v1/write', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ version: 1, request_id: 'mc-' + crypto.randomBytes(6).toString('hex'), op, target_id, data }) });
    const body = await r.json();
    if (!r.ok) throw new Error(`seed ${op} ${target_id}: ${r.status} ${JSON.stringify(body)}`);
    return body;
  };
  for (const [id, title] of [['ACME-01', 'ACME-01: tour operations'], ['J-05', 'Bảng việc'], ['WEB-1', 'Trang chủ']]) {
    await write(OWNER, 'task.create', id, { title, lane: 'CoS', health: 'green', now: 'Đang làm', next: 'Tiếp', steps: STEPS, worker: { model: 'opus', effort: 'high' } });
  }
  const cos = { Authorization: `Bearer ${(await write(OWNER, 'token.issue', 'cos-coord', { role: 'coordinator', lane: 'CoS', label: 'CoS' })).token}` };
  await write(cos, 'machines.set', 'ACME-01', { coordinator: 'main', worker_machines: ['laptop'] });
  await write(cos, 'machines.set', 'J-05', { coordinator: 'main', worker_machines: ['spare'] });
  const task = async id => (await (await fetch(base + '/api/v1/state', { headers: OWNER })).json()).tasks.find(t => t.id === id);

  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  try {
    const shoot = async (w, h, scheme, tag, interact) => {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, extraHTTPHeaders: { 'X-Laneboard-Owner-Proxy': proxySecret }, colorScheme: scheme });
      const page = await ctx.newPage();
      const errs = [];
      page.on('pageerror', e => errs.push('pageerror: ' + e.message));
      page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
      const clipShot = async (name, selector) => {
        const r = await page.evaluate(sel => {
          const els = [...document.querySelectorAll(sel)]; // several matches: the shot is their union (a row and its open popover)
          if (!els.length) return null;
          els[0].scrollIntoView({ block: 'center', inline: 'nearest' });
          const rs = els.map(e => e.getBoundingClientRect()), left = Math.min(...rs.map(r => r.left)), top = Math.min(...rs.map(r => r.top));
          const q = { left, top, width: Math.max(...rs.map(r => r.right)) - left, height: Math.max(...rs.map(r => r.bottom)) - top };
          return { x: Math.max(0, q.left), y: Math.max(0, q.top), width: Math.min(q.width, innerWidth - Math.max(0, q.left)), height: Math.min(q.height, innerHeight - Math.max(0, q.top)) };
        }, selector);
        if (!r || r.width < 2 || r.height < 2) { ok(false, `${tag}: ${name} is visible (${selector})`); return; }
        await page.waitForTimeout(120);
        await page.screenshot({ path: path.join(OUT, `${name}${tag}.png`), clip: r });
      };
      // 1. Task header: both machines named.
      await page.goto(`${base}/?lang=vi#/task/ACME-01`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(500);
      const head = await page.evaluate(() => { const el = document.querySelector('.tv-head [data-machines]'); return el ? el.textContent.replace(/\s+/g, ' ').trim() : ''; });
      ok(head === 'Điều phối: Máy 1 · Làm: Máy 3 (laptop)', `${tag}: the ACME-01 header reads "${head}"`);
      await clipShot('task-header', '.tv-head');
      // 2. The Thợ tab: the inline picker.
      if (await page.isVisible('.tv-head [data-machines]')) await page.click('.tv-head [data-machines]');
      await page.waitForTimeout(400);
      const inline = await page.evaluate(() => !!document.querySelector('.ctx .wk-mpick select[data-machine-coord="ACME-01"]'));
      ok(inline, `${tag}: the Thợ tab shows the machine picker`);
      await clipShot('worker-tab', '.ctx .wk-mpick');
      // 3. Home "Thợ theo task": the machine chip opens the picker like a model chip.
      await page.goto(`${base}/?lang=vi#/`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(500);
      const chip = '[data-action="wk-pop"][data-key="ACME-01:machines"]';
      ok(await page.isVisible(chip), `${tag}: ACME-01 has a machine chip in "Thợ theo task"`);
      const chipText = await page.evaluate(sel => document.querySelector(sel)?.textContent.replace(/\s+/g, ' ').trim(), chip);
      ok(/Máy 1/.test(chipText) && /Máy 3/.test(chipText), `${tag}: the chip names both machines ("${chipText}")`);
      if (await page.isVisible(chip)) await page.click(chip);
      await page.waitForTimeout(300);
      ok(await page.isVisible('.wk-mpop select[data-machine-coord="ACME-01"]'), `${tag}: the chip opens the picker`);
      await clipShot('picker', '.wk-trow[data-route-box="ACME-01"], .wk-mpop');
      await page.screenshot({ path: path.join(OUT, `page-home${tag}.png`) });
      if (interact && await page.isVisible('.wk-mpop')) {
        await page.check('.wk-mpop input[data-machine-worker="ACME-01"][value="spare"]');
        await page.waitForTimeout(600);
        let t = await task('ACME-01');
        ok(JSON.stringify(t.worker_machines) === '["laptop","spare"]', `${tag}: ticking Máy 2 writes worker_machines ${JSON.stringify(t.worker_machines)}`);
        ok(t.machines_by === 'owner', `${tag}: the pick is the owner's (${t.machines_by})`);
        if (!(await page.isVisible('.wk-mpop'))) await page.click(chip);
        await page.waitForTimeout(300);
        await page.selectOption('.wk-mpop select[data-machine-slot="ACME-01"][data-role="review"]', 'spare');
        await page.waitForTimeout(600);
        t = await task('ACME-01');
        ok(t.roles.review.machine === 'spare' && t.roles.code.machine === 'laptop', `${tag}: the review slot moved to spare, code stays on laptop (${t.roles.review.machine}/${t.roles.code.machine})`);
        if (!(await page.isVisible('.wk-mpop'))) await page.click(chip);
        await page.waitForTimeout(300);
        await page.selectOption('.wk-mpop select[data-machine-coord="ACME-01"]', 'main');
        await page.goto(`${base}/?lang=vi#/task/ACME-01`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(500);
        const after = await page.evaluate(() => document.querySelector('.tv-head [data-machines]')?.textContent.replace(/\s+/g, ' ').trim());
        ok(after === 'Điều phối: Máy 1 · Làm: Máy 3 (laptop), Máy 2 (spare)', `${tag}: after a reload the header reads "${after}"`);
        await clipShot('task-header-after', '.tv-head');
      }
      // The shell itself is 26 px wider than a 375 px viewport on 0b21b9d too (aside.rail / main.main, measured on the base
      // commit with this harness), so the page overflow is logged, and the check is that the machine line, chip and picker
      // (this change) never run past the main pane.
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      const wide = await page.evaluate(() => { const edge = document.querySelector('.main').getBoundingClientRect().right + 1;
        return [...document.querySelectorAll('.mc-line, .wk-mrow, .wk-mrow *, .wk-mpick, .wk-mpick *')].filter(el => el.getBoundingClientRect().right > edge && getComputedStyle(el).position !== 'fixed').slice(0, 6).map(el => `${el.tagName.toLowerCase()}.${String(el.className).split(' ').join('.')}`); });
      L(`${tag}: page overflow ${overflow}px (base commit: 0 at 1280, 26 at 375)`);
      ok(!wide.length, `${tag}: no machine line, chip or picker runs past the main pane ${wide.join(' | ')}`);
      for (const e of errs) ok(false, `${tag}: ${e}`);
      await ctx.close();
    };
    await shoot(1280, 900, 'light', '-1280', false);
    await shoot(1280, 900, 'dark', '-1280-dark', false);
    await shoot(375, 812, 'light', '-375', false);
    await shoot(375, 812, 'dark', '-375-dark', false);
    await shoot(1280, 900, 'light', '-1280-edit', true); // last: it changes ACME-01's machines
  } finally { await browser.close(); }
} finally {
  if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  board?.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}
L(failures.length ? `FAILED ${failures.length}` : 'PASS');
process.exit(failures.length ? 1 : 0);
