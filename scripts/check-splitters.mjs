#!/usr/bin/env node
// ACME-02 liveboard B2 check: the adjustable panes, measured in headless Chromium.
//
//   node scripts/check-splitters.mjs --playwright <playwright-core dir> --chromium <chromium binary> [--code <dir>] [--out <dir>]
//
// Seeds a SYNTHETIC board through the real write API, then at 1280x800 checks: drag clamps to the pane minimums and to
// "Detail keeps 320px", double-click and Home reset, arrow nudge, collapse to a 36px strip and back, sizes persist in
// localStorage key lbp2:B2 across a reload, corrupt or blocked storage still renders, the reader presets (Medium / Wide / Full pane)
// fold Inspector / both side panes while the reader is open and Close or Esc restores them,
// the reader docks beside the Tasks pane, no element carries a style="" attribute (CSP style-src 'self'), no sideways overflow.
// At 900x600 the panes still fit; at 800x600 B2 is off and the page keeps the stacked layout it had before. Shots go to --out.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2), arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CODE = path.resolve(arg('--code', HERE)), OUT = path.resolve(arg('--out', path.join(os.tmpdir(), 'laneboard-splitters')));
const PW = arg('--playwright'), EXE = arg('--chromium');
if (!PW || !EXE) { console.error('usage: check-splitters.mjs --playwright <playwright-core dir> --chromium <binary> [--code <dir>] [--out <dir>]'); process.exit(2); }
const log = [], failures = [];
const L = s => { log.push(s); console.log(s); };
const fail = s => { failures.push(s); L('FAIL ' + s); };
const ok = (cond, msg) => { if (cond) L('ok ' + msg); else fail(msg); };
const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;

const { createBoard } = await import(pathToFileURL(path.join(CODE, 'src', 'board.mjs')));
const { createServer } = await import(pathToFileURL(path.join(CODE, 'src', 'server.mjs')));
const { chromium } = createRequire(path.join(PW, 'package.json'))(PW);

fs.mkdirSync(OUT, { recursive: true });
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'laneboard-splitters-data-'));
let server, board;
try {
  const proxySecret = crypto.randomBytes(32).toString('base64url');
  board = createBoard({ dataDir: scratch });
  server = createServer(board, { ownerProxySecret: proxySecret });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  L(`check: code ${CODE} · out ${OUT} · ${base}`);
  const OWNER = { 'X-Laneboard-Owner-Proxy': proxySecret, 'X-Requested-With': 'laneboard' };
  const rid = () => 'spl-' + crypto.randomBytes(6).toString('hex');
  const api = async (headers, op, target_id, data, extra = {}) => {
    const r = await fetch(base + '/api/v1/write', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ version: 1, request_id: rid(), op, target_id, data, ...extra }) });
    const body = await r.json();
    if (!r.ok) throw new Error(`seed ${op} ${target_id}: ${r.status} ${JSON.stringify(body)}`);
    return body;
  };
  const coordToken = (await api(OWNER, 'token.issue', 'spl-coordinator-' + crypto.randomBytes(3).toString('hex'), { role: 'coordinator', replace_coordinator: true, label: 'splitters check' })).token;
  const COORD = { Authorization: `Bearer ${coordToken}` };
  const TASKS = [['SP-1', 'Synthetic task one with a long title to wrap in the list'], ['SP-2', 'Synthetic task two'], ['SP-3', 'Synthetic task three'], ['SP-4', 'Synthetic task four']];
  for (const [id, title] of TASKS) await api(COORD, 'task.create', id, { title, lane: 'fixture', now: 'Reading the synthetic fixture.', next: 'Nothing', steps: [{ id: 's1', label: 'First step', zone: 'build', state: 'active' }] });
  await api(COORD, 'task.create', 'SP-5', { title: 'Synthetic task with a structure diagram', lane: 'fixture', now: 'x', next: 'y', steps: [{ id: 's1', label: 'First step', zone: 'build', state: 'active' }], architecture: { format: 'graph', groups: [{ id: 'a', label: 'Flow' }, { id: 'b', label: 'Studio' }], nodes: [{ id: 'n1', label: 'Brief', group: 'a' }, { id: 'n2', label: 'Script', group: 'b' }, { id: 'n3', label: 'Render', group: 'b' }], edges: [{ from: 'n1', to: 'n2' }, { from: 'n2', to: 'n3' }] } });
  const rev = async () => (await (await fetch(base + '/api/v1/state', { headers: OWNER })).json()).tasks.find(t => t.id === 'SP-1').steps[0].rev;
  const report = ['# Synthetic report', ...Array.from({ length: 30 }, (_, i) => `Paragraph ${i}: capacity report synthetic fixture row column value export batch window ledger timeline.`)].join('\n\n');
  await api(COORD, 'step.update', 'SP-1/s1', { detail: report }, { expected_revision: await rev() });
  await api(COORD, 'ask.raise', 'SP-1', { text: 'Synthetic ask one?', step_id: 's1' });

  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  try {
    const open = async (w, h, init) => {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, extraHTTPHeaders: { 'X-Laneboard-Owner-Proxy': proxySecret }, colorScheme: 'dark' });
      const page = await ctx.newPage(), errs = [];
      page.on('pageerror', e => errs.push(e.message));
      page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
      if (init) await page.addInitScript(init);
      await page.goto(`${base}/#/task/SP-1`, { waitUntil: 'networkidle' });
      await page.waitForSelector('.tv .ctx');
      return { ctx, page, errs };
    };
    const probe = page => page.evaluate(() => {
      const w = s => { const e = document.querySelector(s); return e ? Math.round(e.getBoundingClientRect().width) : -1; };
      const css = n => document.documentElement.style.getPropertyValue(n);
      return {
        b2: document.documentElement.classList.contains('b2'), rail: w('.rail'), center: w('.center'), ctx: w('.ctx'),
        tasksVar: css('--b2-tasks'), inspVar: css('--b2-insp'), overflow: document.documentElement.scrollWidth - window.innerWidth,
        // <html> holds the CSSOM custom properties (CSP allows that); the splitters and the panes they size must carry no style attribute
        styleAttrs: [...document.querySelectorAll('.split, .split-btn, .rail, .shell, .main, .tv, .center, .ctx, .reader')].filter(e => e.hasAttribute('style')).map(e => e.tagName + '.' + e.className),
        store: (() => { try { return localStorage.getItem('lbp2:B2'); } catch { return 'ERR'; } })(),
        railColl: document.documentElement.classList.contains('b2-tasks-c'), inspColl: document.documentElement.classList.contains('b2-insp-c')
      };
    });
    const dragBy = async (page, sel, dx) => {
      const b = await page.locator(sel).boundingBox(), x = b.x + b.width / 2, y = b.y + b.height / 2 + 120;
      await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + dx / 2, y, { steps: 4 }); await page.mouse.move(x + dx, y, { steps: 4 }); await page.mouse.up();
    };

    // ---------- static: the source emits no inline style (a CSP-blocked write would be silent in some hosts)
    {
      const src = fs.readFileSync(path.join(CODE, 'public', 'splitters.js'), 'utf8').replace(/\/\/.*$/gm, '');
      ok(!/cssText|setAttribute\(\s*['"]style|[^.\w]style\s*=/.test(src), 'splitters.js never writes a style attribute, cssText or inline style markup');
      ok(/style\.setProperty/.test(src), 'sizes are set through CSSOM style.setProperty');
      const idx = fs.readFileSync(path.join(CODE, 'public', 'index.html'), 'utf8');
      ok(!/\sstyle=|<style|<script(?![^>]*\bsrc=)/.test(idx), 'index.html has no inline style or inline script');
    }
    // ---------- 1280x800
    {
      const { ctx, page, errs } = await open(1280, 800);
      let p = await probe(page);
      ok(p.b2, 'B2 is on at 1280px');
      ok(p.rail === 256 && p.ctx === 340, `defaults: Tasks 256, Inspector 340 (got ${p.rail}, ${p.ctx})`);
      ok(p.center >= 320 && p.overflow <= 0, `Detail ${p.center}px >= 320, no sideways overflow (${p.overflow})`);
      ok(p.styleAttrs.length === 0, `no style attribute on the splitters or the panes (${p.styleAttrs.join(',') || 'none'})`);
      const sp = await page.evaluate(() => { const e = document.querySelector('.split-tasks'), r = e.getBoundingClientRect(), cs = getComputedStyle(e); return { w: r.width, cursor: cs.cursor, role: e.getAttribute('role'), now: e.getAttribute('aria-valuenow') }; });
      ok(sp.w === 7 && sp.cursor === 'col-resize' && sp.role === 'separator' && sp.now === '256', `Tasks splitter: 7px hit area, col-resize, separator, aria-valuenow 256 (${JSON.stringify(sp)})`);
      await page.hover('.split-tasks'); await page.waitForTimeout(250);
      const bar = await page.evaluate(() => { const cs = getComputedStyle(document.querySelector('.split-tasks'), '::after'); return { w: cs.width, o: cs.opacity }; });
      ok(bar.w === '3px' && parseFloat(bar.o) >= 0.85, `hover shows the 3px accent bar (${bar.w}, opacity ${bar.o})`);
      await page.screenshot({ path: path.join(OUT, 'b2-1280-hover.png') });
      await page.mouse.move(640, 400); await page.waitForTimeout(250);

      await page.screenshot({ path: path.join(OUT, 'b2-1280-default.png') });
      await dragBy(page, '.split-tasks', 100); p = await probe(page);
      ok(p.rail === 356, `drag right 100px: Tasks 356 (got ${p.rail})`);
      await dragBy(page, '.split-tasks', -900); p = await probe(page);
      ok(p.rail === 150, `drag far left: Tasks clamps to 150 (got ${p.rail})`);
      await dragBy(page, '.split-tasks', 1200); p = await probe(page);
      ok(near(p.center, 320, 1) && p.rail <= 760, `drag far right: Detail keeps 320 (center ${p.center}, Tasks ${p.rail})`);
      await dragBy(page, '.split-inspector', -900); p = await probe(page);
      ok(p.ctx <= 520 && p.center >= 320, `Inspector drag left stops at max or the Detail floor (Inspector ${p.ctx}, center ${p.center})`);
      await page.dblclick('.split-tasks'); await page.dblclick('.split-inspector'); p = await probe(page);
      ok(p.rail === 256 && p.ctx === 340, `double-click resets both (${p.rail}, ${p.ctx})`);
      await dragBy(page, '.split-inspector', 400); p = await probe(page);
      ok(p.ctx === 180, `Inspector drag right clamps to 180 (got ${p.ctx})`);
      await page.focus('.split-inspector'); await page.keyboard.press('Home'); p = await probe(page);
      ok(p.ctx === 340, `Home resets the Inspector (${p.ctx})`);
      await page.focus('.split-tasks'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); p = await probe(page);
      ok(p.rail === 256 + 48, `two ArrowRight nudge Tasks +48 (${p.rail})`);
      await page.keyboard.press('ArrowLeft'); p = await probe(page);
      ok(p.rail === 256 + 24, `ArrowLeft nudges back 24 (${p.rail})`);
      await page.focus('.split-inspector'); await page.keyboard.press('ArrowLeft'); p = await probe(page);
      ok(p.ctx === 364, `ArrowLeft on the Inspector splitter grows it +24 (${p.ctx})`);
      const saved = p.store && JSON.parse(p.store);
      ok(saved && saved.tasksW === 280 && saved.inspectorW === 364, `keyboard nudges persist (${p.store})`);
      ok(p.styleAttrs.length === 0, 'still no style attribute after dragging (' + p.styleAttrs.join(',') + ')');

      await page.click('.split-tasks .split-btn'); p = await probe(page);
      ok(p.rail === 36 && p.railColl, `collapse button: Tasks is a 36px strip (${p.rail})`);
      await page.screenshot({ path: path.join(OUT, 'b2-1280-left-collapsed.png') });
      await page.click('.split-tasks .split-btn'); p = await probe(page);
      ok(p.rail === 280 && !p.railColl, `expand restores the last width (${p.rail})`);
      await page.click('.split-inspector .split-btn'); p = await probe(page);
      ok(p.ctx === 36 && p.inspColl, `Inspector collapses to 36px (${p.ctx})`);
      await page.focus('.split-inspector'); await page.keyboard.press('Enter'); p = await probe(page);
      ok(p.ctx === 364 && !p.inspColl, `Enter on the splitter expands it (${p.ctx})`);

      await page.click('.split-tasks .split-btn'); await dragBy(page, '.split-inspector', -60); const before = await probe(page);
      await page.reload({ waitUntil: 'networkidle' }); await page.waitForSelector('.tv .ctx'); p = await probe(page);
      ok(p.railColl && p.rail === 36 && p.ctx === before.ctx, `sizes and collapse survive a reload (rail ${p.rail}, Inspector ${p.ctx} vs ${before.ctx})`);
      await page.click('.split-tasks .split-btn');

      await page.dblclick('.split-tasks'); await page.dblclick('.split-inspector');
      await page.click('.srow-main').catch(() => {}); await page.click('[data-action="read"]').catch(() => {});
      await page.waitForSelector('#reader', { timeout: 4000 }).catch(() => {});
      const r = await page.evaluate(() => { const e = document.getElementById('reader'); if (!e) return null; const b = e.getBoundingClientRect(), rail = document.querySelector('.rail').getBoundingClientRect(); return { left: Math.round(b.left), right: Math.round(b.right), railRight: Math.round(rail.right) }; });
      await page.click('#reader [data-action="reader-width"][data-w="m"]');
      const r2 = await page.evaluate(() => { const b = document.getElementById('reader').getBoundingClientRect(); return { left: Math.round(b.left), right: Math.round(b.right) }; });
      ok(r && r2.left === r.railRight && r2.right === 1280 - 340, `reader is docked between Tasks (left ${r && r.left} = rail edge ${r && r.railRight}) and Inspector (right ${r2.right}) at Medium`);
      await page.click('#reader [data-action="reader-width"][data-w="f"]'); await page.mouse.move(640, 700); await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(OUT, 'b2-1280-reader.png') });
      await page.keyboard.press('Escape');
      await page.goto(`${base}/#/home`, { waitUntil: 'networkidle' }); await page.waitForTimeout(200);
      ok(await page.evaluate(() => getComputedStyle(document.querySelector('.split-inspector')).display) === 'none', 'no right pane on the home view: the Inspector splitter is hidden');
      for (const e of errs) fail('console: ' + e);
      await ctx.close();
    }

    // ---------- storage: corrupt, blocked, migrated
    {
      const { ctx, page, errs } = await open(1280, 800, () => { localStorage.setItem('lbp2:B2', '{broken json'); });
      const p = await probe(page);
      ok(p.b2 && p.rail === 256 && p.ctx === 340, `corrupt lbp2:B2 falls back to the defaults (${p.rail}, ${p.ctx})`);
      for (const e of errs) fail('corrupt storage: ' + e);
      await ctx.close();
    }
    {
      const { ctx, page, errs } = await open(1280, 800, () => {
        Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('blocked', 'SecurityError'); } });
      });
      let p = await probe(page);
      ok(p.b2 && p.rail === 256, `blocked storage: the layout still renders (${p.rail})`);
      await page.focus('.split-tasks'); await page.keyboard.press('ArrowRight'); p = await probe(page);
      ok(p.rail === 280, `blocked storage: resizing still works in memory (${p.rail})`);
      for (const e of errs) fail('blocked storage: ' + e);
      await ctx.close();
    }
    // ---------- reader presets act on the panes while the reader is open, and Close restores them
    {
      const { ctx, page, errs } = await open(1280, 800);
      await page.dblclick('.split-tasks'); await page.dblclick('.split-inspector'); // known sizes: 256 / 340
      await page.click('.srow-main'); await page.click('[data-action="read"]'); await page.waitForSelector('#reader');
      const setPreset = async v => { await page.click(`#reader [data-action="reader-width"][data-w="${v}"]`); await page.waitForTimeout(150); return probe(page); };
      let p = await setPreset('m');
      ok(p.rail === 256 && p.ctx === 340, `Medium: panes stay as they are (${p.rail}, ${p.ctx})`);
      const rd = () => page.evaluate(() => Math.round(document.getElementById('reader').getBoundingClientRect().width));
      ok(await rd() >= 320, `Medium: the reader is at least the 320px Detail minimum (${await rd()})`);
      p = await setPreset('w');
      ok(p.rail === 256 && p.ctx === 36 && p.inspColl, `Wide: the Inspector folds to its strip (${p.rail}, ${p.ctx})`);
      const wide = await rd();
      p = await setPreset('f');
      ok(p.rail === 36 && p.ctx === 36 && p.railColl, `Full pane: Tasks and Inspector both fold (${p.rail}, ${p.ctx})`);
      ok(await rd() > wide && await rd() === 1280 - 72, `Full pane: the reader takes everything between the strips (${await rd()})`);
      const saved = await page.evaluate(() => { try { return localStorage.getItem('lbp2:B2'); } catch { return null; } });
      ok(!saved || (JSON.parse(saved).tasksC === false && JSON.parse(saved).inspectorC === false), `the preset folds are transient: lbp2:B2 keeps the saved sizes open (${saved})`);
      await page.click('.split-inspector .split-btn'); p = await probe(page);
      ok(p.ctx === 340 && p.rail === 36, `a pane opened by hand while a preset is on stays open (${p.ctx})`);
      await page.click('.split-inspector .split-btn');
      await page.keyboard.press('Escape'); await page.waitForTimeout(200); p = await probe(page);
      ok(p.rail === 256 && p.ctx === 340 && !p.railColl && !p.inspColl, `Esc closes the reader and restores the sizes (${p.rail}, ${p.ctx})`);
      ok(await page.evaluate(() => localStorage.getItem('laneboard.readerWidth')) === 'f', 'the preset is still persisted in laneboard.readerWidth');
      await page.click('[data-action="read"]'); await page.waitForSelector('#reader'); await page.waitForTimeout(200); p = await probe(page);
      ok(p.rail === 36 && p.ctx === 36, `reopening applies the remembered preset again (${p.rail}, ${p.ctx})`);
      p = await setPreset('m');
      ok(p.rail === 256 && p.ctx === 340, `switching back to Medium restores the sizes (${p.rail}, ${p.ctx})`);
      await page.click('#reader [data-action="reader-close"]'); await page.waitForTimeout(200); p = await probe(page);
      ok(p.rail === 256 && p.ctx === 340, `Close leaves the sizes as they were (${p.rail}, ${p.ctx})`);
      for (const e of errs) fail('presets: ' + e);
      await ctx.close();
    }

    // ---------- other sizes
    {
      const { ctx, page } = await open(900, 600);
      const p = await probe(page);
      ok(p.b2 && p.center >= 320 && p.overflow <= 0, `900x600: panes fit, Detail ${p.center}px, no sideways overflow (${p.overflow})`);
      await page.screenshot({ path: path.join(OUT, 'b2-900.png') });
      await ctx.close();
    }
    {
      const { ctx, page } = await open(800, 600);
      const p = await probe(page);
      ok(!p.b2 && p.tasksVar === '' && p.inspVar === '', 'below 900px B2 is off and sets no size variables');
      ok(await page.evaluate(() => [...document.querySelectorAll('.split')].every(e => getComputedStyle(e).display === 'none')), 'below 900px the splitters are not shown');
      await ctx.close();
    }
    {
      const { ctx, page } = await open(1280, 800);
      await page.setViewportSize({ width: 800, height: 600 }); await page.waitForTimeout(200);
      let p = await probe(page);
      ok(!p.b2, 'shrinking the window below 900px switches B2 off');
      await page.setViewportSize({ width: 1000, height: 700 }); await page.waitForTimeout(200);
      p = await probe(page);
      ok(p.b2 && p.center >= 320, `growing back re-clamps: Detail ${p.center}px >= 320`);
      await ctx.close();
    }
    // ---------- the Diagram tab lends the Inspector 520px as ONE transient layer over the saved state (1024x768)
    {
      const { ctx, page } = await open(1024, 768);
      const seen = () => page.evaluate(() => { const t = document.querySelector('.split-tasks'), i = document.querySelector('.split-inspector'), b = t.firstElementChild; return { rail: Math.round(document.querySelector('.rail').getBoundingClientRect().width), ctx: Math.round(document.querySelector('.ctx').getBoundingClientRect().width), tColl: t.dataset.collapsed, tExp: b.getAttribute('aria-expanded'), tGlyph: b.textContent, iNow: i.getAttribute('aria-valuenow'), store: (() => { try { return localStorage.getItem('lbp2:B2'); } catch { return 'ERR'; } })() }; });
      const saved0 = (await seen()).store;
      await page.goto(base + '/#/task/SP-5', { waitUntil: 'networkidle' }); await page.waitForSelector('.tv .ctx');
      await page.click('.tab[data-tab="diagram"]'); await page.waitForTimeout(300);
      let q = await seen();
      ok(q.ctx === 520 && q.rail === 36 && q.tColl === 'true' && q.tExp === 'false' && q.tGlyph === '›', `Diagram at 1024: Inspector 520, Tasks folded, and the separator tells the truth (rail ${q.rail}, ctx ${q.ctx}, collapsed ${q.tColl}, aria-expanded ${q.tExp}, glyph ${q.tGlyph})`);
      ok(q.store === saved0, 'the lend and fold saved nothing');
      await page.click('.split-tasks .split-btn'); await page.waitForTimeout(200);
      q = await seen();
      ok(q.rail === 256 && q.tColl === 'false' && q.tExp === 'true' && q.ctx === 1024 - 256 - 320, `the expand button opens Tasks and the Inspector shrinks to what is left (rail ${q.rail}, ctx ${q.ctx})`);
      ok(q.store === saved0, 'opening Tasks over the Diagram fold saved nothing');
      await dragBy(page, '.split-inspector', 80); await page.waitForTimeout(150);
      const q2 = await seen();
      ok(q2.ctx === q.ctx - 80, `an Inspector drag (80px right) changes the visible width (${q.ctx} -> ${q2.ctx}) and reads the visible pane`);
      ok(q2.store === saved0, 'the Inspector drag during the Diagram saved no width');
      await page.click('.tab[data-tab="steps"]'); await page.waitForTimeout(300);
      const q3 = await seen();
      ok(q3.store === saved0 && q3.ctx === 340 && q3.tColl === 'false', `leaving the tab restores the saved sizes byte for byte (ctx ${q3.ctx}, store unchanged)`);
      await ctx.close();
    }
  } finally { await browser.close(); }
} catch (e) {
  fail('check run: ' + e.message);
} finally {
  if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  board?.close();
  fs.rmSync(scratch, { recursive: true, force: true });
  L(failures.length ? `SPLITTERS CHECK FAILED (${failures.length})` : 'SPLITTERS CHECK PASSED');
  fs.writeFileSync(path.join(OUT, 'check-splitters.log'), log.join('\n') + '\n');
  process.exitCode = failures.length ? 1 : 0;
}
