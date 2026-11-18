#!/usr/bin/env node
// J-05 diagrams check: the per-task "Sơ đồ" tab and the Home overview (task map) in headless Chromium.
//
//   node scripts/check-board-diagram.mjs --playwright <playwright-core dir> --chromium <chromium binary> \
//        [--code <Laneboard code dir, default this repo>] [--out <dir>]
//
// Seeds a SYNTHETIC board (no real content) through the real write API — a five-phase task with a merged `lich-su`
// step of 60 archived lines, a task per health, a paused task and a closed one — then measures at 948x594, 1204x754
// and 1844x1034 (the check-board-read widths), dark, plus one light pass at 1204.
// Checks: the Sơ đồ tab exists and renders one box per live step (the history step is not a box), exactly one
// current box, the owner hand-off marked, done boxes dimmed, the history box collapsed (its 50-line cap and
// "… and N more" when opened), clicking a box opens that step on the Steps tab, no page sideways overflow while the
// diagram pane scrolls itself, no `style=` attribute and no CSP violation, and Home's map with one box per task,
// the health counts and the owner-wait count, its map/list choice remembered in this browser. Any console error,
// page error or CSP violation fails the run. The same two views then run in Vietnamese (?lang=vi, the browser's own
// language key) at the three widths and in light: every label must be the VI dictionary's, with no English word left
// on screen. Screenshots go to --out as after-home-map-<w>.png / after-diagram-<w>.png and the VI pair as
// after-home-map-vi-<w>.png / after-diagram-vi-<w>.png.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2), arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CODE = path.resolve(arg('--code', HERE)), OUT = path.resolve(arg('--out', path.join(os.tmpdir(), 'laneboard-board-diagram')));
const PW = arg('--playwright'), EXE = arg('--chromium');
if (!PW || !EXE) { console.error('usage: check-board-diagram.mjs --playwright <playwright-core dir> --chromium <binary> [--code <dir>] [--out <dir>]'); process.exit(2); }
const SIZES = [[948, 594], [1204, 754], [1844, 1034]];
const log = [], failures = [];
const L = s => { log.push(s); console.log(s); };
const fail = s => { failures.push(s); L('FAIL ' + s); };
const ok = (cond, msg) => { if (cond) L('ok ' + msg); else fail(msg); };
const EN = JSON.parse(fs.readFileSync(path.join(CODE, 'public', 'locales', 'en.json'), 'utf8')); // the page renders in English by default
const VI = JSON.parse(fs.readFileSync(path.join(CODE, 'public', 'locales', 'vi.json'), 'utf8')); // and in Vietnamese when the browser picks it
const fill = (s, vars = {}) => String(s).replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
// Every English word these two views put on screen. A VI label that still carries one is a hard-coded string or a
// dictionary miss — the owner reads the board in Vietnamese, so a half-translated diagram is a real defect.
const EN_WORDS = [...new Set(['diagram.view.map', 'diagram.view.list', 'diagram.overviewTitle', 'diagram.waiting',
  'diagram.waitingOne', 'diagram.ownerTag', 'diagram.history', 'diagram.historyCount.one', 'diagram.historyCount.other', 'diagram.historyMore',
  'diagram.laneSteps.one', 'diagram.laneSteps.other', 'diagram.legend.current', 'diagram.legend.owner', 'diagram.legend.done', 'diagram.hint',
  'diagram.noLane', 'diagram.emptyMap', 'ctx.tab.diagram', 'head.steps.one', 'head.steps.other',
  'zone.plan', 'zone.build', 'zone.test', 'zone.owner', 'zone.ship',
  'state.todo', 'state.active', 'state.waiting', 'state.blocked', 'state.done',
  'health.green', 'health.yellow', 'health.red', 'health.grey']
  .flatMap(k => fill(EN[k]).replace(/[…()·]/g, ' ').split(/\s+/))
  .filter(w => w.length >= 3 && /^[A-Za-z]+$/.test(w)).map(w => w.toLowerCase()))];
const englishIn = label => EN_WORDS.filter(w => new RegExp('\\b' + w + '\\b', 'i').test(label));

// ---- synthetic fixture: the five phases, an owner hand-off, a merged history step of 60 lines, one task per health ----
const HIST_LINES = Array.from({ length: 60 }, (_, i) => `${String((i % 28) + 1).padStart(2, '0')}/09 · archived step ${i + 1} · fixture result ${i + 1}`);
const LONG_STEP = 'Owner signs off on the whole deliverable before the release window closes';
const DG1_STEPS = [
  { id: 'lich-su', label: 'Lịch sử (gộp)', zone: 'build', state: 'done', detail: HIST_LINES.join('\n') },
  { id: 's1', label: 'Scope the fixture work', zone: 'plan', state: 'done' },
  { id: 's2', label: 'Build the fixture layout', zone: 'build', state: 'done' },
  { id: 's3', label: 'Check the fixture in the browser', zone: 'build', state: 'active' },
  { id: 's4', label: 'Measure the three widths', zone: 'test', state: 'todo' },
  { id: 's5', label: LONG_STEP, zone: 'owner', state: 'waiting' },
  { id: 's6', label: 'Ship it', zone: 'ship', state: 'todo' }];
const LIVE = DG1_STEPS.length - 1;

const { createBoard } = await import(pathToFileURL(path.join(CODE, 'src', 'board.mjs')));
const { createServer } = await import(pathToFileURL(path.join(CODE, 'src', 'server.mjs')));
const { chromium } = createRequire(path.join(PW, 'package.json'))(PW);

fs.mkdirSync(OUT, { recursive: true });
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'laneboard-board-diagram-data-'));
let server, board;
try {
  const proxySecret = crypto.randomBytes(32).toString('base64url');
  board = createBoard({ dataDir: scratch });
  server = createServer(board, { ownerProxySecret: proxySecret });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  L(`check: code ${CODE} · out ${OUT} · ${base}`);

  const OWNER = { 'X-Laneboard-Owner-Proxy': proxySecret, 'X-Requested-With': 'laneboard' };
  const rid = () => 'diag-' + crypto.randomBytes(6).toString('hex');
  const api = async (op, target_id, data) => {
    const r = await fetch(base + '/api/v1/write', { method: 'POST', headers: { 'Content-Type': 'application/json', ...OWNER }, body: JSON.stringify({ version: 1, request_id: rid(), op, target_id, data }) });
    const body = await r.json();
    if (!r.ok) throw new Error(`seed ${op} ${target_id}: ${r.status} ${JSON.stringify(body)}`);
    return body;
  };
  await api('task.create', 'DG-1', { title: 'Diagram fixture: five phases and a history step', lane: 'fixture', health: 'green', now: 'Checking the diagram at three widths', next: 'Read the shots', steps: DG1_STEPS });
  await api('task.create', 'DG-2', { title: 'Diagram fixture: in trouble', lane: 'fixture', health: 'red', now: 'Blocked on the fixture', next: 'Unblock', steps: [
    { id: 's1', label: 'Build the fixture', zone: 'build', state: 'active' }, { id: 's2', label: 'Test the fixture', zone: 'test', state: 'todo' }] });
  await api('task.create', 'DG-3', { title: 'Diagram fixture: another lane', lane: 'fixture-b', health: 'yellow', now: 'Waiting on a fixture answer', next: 'Answer', steps: [
    { id: 's1', label: 'Plan the fixture', zone: 'plan', state: 'done' }] });
  await api('task.create', 'DG-4', { title: 'Diagram fixture: parked', lane: 'fixture-b', health: 'grey', status: 'paused', steps: [
    { id: 's1', label: 'Parked fixture step', zone: 'build', state: 'todo' }] });
  await api('task.create', 'DG-5', { title: 'Diagram fixture: closed and out of the map', lane: 'fixture', health: 'green', status: 'closed', steps: [
    { id: 's1', label: 'Closed fixture step', zone: 'build', state: 'done' }] });
  L(`seeded DG-1 (${LIVE} live steps + ${HIST_LINES.length} history lines), DG-2 red, DG-3 yellow, DG-4 paused, DG-5 closed`);

  // ---- in-page probes ----
  const DIAG = () => {
    const svg = document.querySelector('.diag-svg'), scroll = document.querySelector('.diag-scroll'), hist = document.querySelector('.diag-hist');
    const cls = el => String(el.getAttribute('class') || '');
    const ctx = document.querySelector('#ctx'), cr = ctx?.getBoundingClientRect();
    return {
      tab: [...document.querySelectorAll('[data-action="ctx-tab"]')].find(b => b.getAttribute('aria-selected') === 'true')?.textContent.trim() || '',
      hasSvg: !!svg, svgW: Number(svg?.getAttribute('width') || 0), svgH: Number(svg?.getAttribute('height') || 0),
      scrollW: scroll?.scrollWidth || 0, clientW: scroll?.clientWidth || 0, overflowX: scroll ? getComputedStyle(scroll).overflowX : '',
      boxes: [...document.querySelectorAll('.dnode')].map(a => ({ cls: cls(a), href: a.getAttribute('href') || '', label: a.textContent })),
      lanes: [...document.querySelectorAll('.dlane-t')].map(t => t.textContent),
      laneCounts: [...document.querySelectorAll('.dlane-s')].map(t => t.textContent),
      legend: [...document.querySelectorAll('.diag-legend span')].map(s => s.textContent.trim()),
      hist: { present: !!hist, expanded: hist?.getAttribute('aria-expanded'), text: hist?.textContent || '', lines: document.querySelectorAll('.diag-hist-lines li').length, last: document.querySelector('.diag-hist-lines li:last-child')?.textContent || '' },
      styled: document.querySelectorAll('.diag-card [style], .diag-overview [style]').length,
      page: document.documentElement.scrollWidth - window.innerWidth,
      // the flow inside .diag-scroll is clipped by its own scroller on purpose: measure everything OUTSIDE it
      past: ctx ? [...ctx.querySelectorAll('*')].filter(el => !el.closest('.diag-scroll, .diag-map-scroll') && el.getBoundingClientRect().width > 1 && el.getBoundingClientRect().right > cr.right + 1).map(el => `${el.tagName}.${cls(el)}@${Math.round(el.getBoundingClientRect().right - cr.right)}`) : [],
      chain: (() => { const sc = document.querySelector('.diag-scroll'); const out = []; for (let el = sc; el && el !== document.body; el = el.parentElement) out.push(`${el.tagName}.${cls(el)} ${el.clientWidth}/${el.scrollWidth} ${getComputedStyle(el).display}`); return out; })(),
      csp: (window.__csp || []).slice(), focus: document.activeElement?.getAttribute?.('href') || ''
    };
  };
  const HOME = () => {
    const boxes = [...document.querySelectorAll('.diag-task')];
    const counts = [...document.querySelectorAll('.diag-count')].map(c => c.textContent.trim());
    return {
      present: !!document.querySelector('.diag-overview'),
      title: document.querySelector('.diag-overview-head h2')?.textContent || '',
      boxes: boxes.length, links: boxes.map(a => a.getAttribute('href')),
      dotted: boxes.map(a => String(a.querySelector('.diag-task-top .dot')?.getAttribute('class') || '').split(' ').pop()),
      counts, waiting: boxes.filter(a => a.querySelector('.chip.q')).length,
      list: document.querySelectorAll('.diag-row').length, lanes: [...document.querySelectorAll('.diag-lane-head b')].map(b => b.textContent),
      selected: [...document.querySelectorAll('[data-action="home-view"]')].filter(b => b.getAttribute('aria-checked') === 'true').map(b => b.getAttribute('data-view')),
      page: document.documentElement.scrollWidth - window.innerWidth,
      scroll: (() => { const s = document.querySelector('.diag-map-scroll'); return s ? { w: s.scrollWidth, c: s.clientWidth, ox: getComputedStyle(s).overflowX } : null; })(),
      styled: document.querySelectorAll('.diag-overview [style]').length, csp: (window.__csp || []).slice()
    };
  };
  // The words the diagram and the map themselves put on screen — and nothing else: step labels, task titles and lane
  // names are content the agents wrote, so they stay in whatever language they were written.
  const LABELS = () => {
    const txt = sel => [...document.querySelectorAll(sel)].map(e => e.textContent.trim());
    const tab = [...document.querySelectorAll('[data-action="ctx-tab"]')].find(b => b.dataset.tab === 'diagram');
    return {
      lang: document.documentElement.lang,
      stored: (() => { try { return localStorage.getItem('laneboard.uiLang') || ''; } catch { return ''; } })(),
      tab: tab ? tab.textContent.trim() : '',
      lanes: txt('.diag-lane-tags .dlane-t'), laneSteps: txt('.diag-lane-tags .dlane-s'),
      subs: txt('.dnode .dnode-s'), ownerTags: txt('.dtag text'), legend: txt('.diag-legend span'),
      histTitle: txt('.diag-hist-t'), histCount: txt('.diag-hist .muted'), hint: txt('.diag-card .plan-sec > p.sub.muted'),
      overviewTitle: txt('.diag-overview-head h2'), segs: txt('[data-action="home-view"]'), counts: txt('.diag-count'),
      boxes: document.querySelectorAll('.dnode').length, svg: !!document.querySelector('.diag-svg'),
      page: document.documentElement.scrollWidth - window.innerWidth, csp: (window.__csp || []).slice()
    };
  };

  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  try {
    for (const [w, h] of SIZES) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, extraHTTPHeaders: { 'X-Laneboard-Owner-Proxy': proxySecret }, colorScheme: 'dark' });
      await ctx.addInitScript(() => { window.__csp = []; document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI)); });
      const page = await ctx.newPage();
      const errs = [];
      page.on('pageerror', e => errs.push('pageerror: ' + e.message));
      page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
      const shot = name => page.screenshot({ path: path.join(OUT, `after-${name}-${w}.png`) });

      // ---- Home: the map ----
      await page.goto(`${base}/#/home`, { waitUntil: 'networkidle' });
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForTimeout(700);
      const h0 = await page.evaluate(HOME);
      ok(h0.present && h0.title === EN['diagram.overviewTitle'], `${w}: Home shows "${EN['diagram.overviewTitle']}"`);
      ok(h0.boxes === 4, `${w}: one box per open task, the closed one left out (${h0.boxes})`);
      ok(h0.boxes === 0 || h0.links.every(l => /^#\/task\//.test(l)), `${w}: every map box links to its task`);
      ok(h0.dotted.filter(d => d === 'red').length === 1 && h0.dotted.filter(d => d === 'yellow').length === 1 && h0.dotted.filter(d => d === 'grey').length === 1, `${w}: boxes carry their health dot (${JSON.stringify(h0.dotted)})`);
      ok(h0.counts.length === 5 && h0.counts.some(c => c.includes(EN['diagram.waiting'])), `${w}: the health counts and the owner-wait count (${JSON.stringify(h0.counts)})`);
      ok(h0.waiting >= 1, `${w}: the owner hand-off is flagged on the task's box (${h0.waiting})`);
      ok(h0.page <= 0, `${w}: Home has no page sideways overflow (${h0.page})`);
      ok(h0.scroll && /(auto|scroll)/.test(h0.scroll.ox), `${w}: the map scrolls inside its own container (${JSON.stringify(h0.scroll)})`);
      ok(h0.styled === 0, `${w}: no style="" attribute in the overview`);
      await page.evaluate(() => document.querySelector('.diag-overview')?.scrollIntoView({ block: 'center' }));
      await page.waitForTimeout(200);
      await shot('home-map');

      // the map/list choice is this browser's, not the server's
      await page.click('[data-action="home-view"][data-view="list"]');
      await page.waitForTimeout(250);
      const h1 = await page.evaluate(HOME);
      ok(h1.list === 4 && h1.boxes === 0, `${w}: "List" swaps the map for rows (rows ${h1.list})`);
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForTimeout(600);
      const h2 = await page.evaluate(HOME);
      ok(h2.list === 4 && h2.selected[0] === 'list', `${w}: the choice survives a reload (${JSON.stringify(h2.selected)})`);
      await page.click('[data-action="home-view"][data-view="map"]');
      await page.waitForTimeout(250);

      // ---- the task's Sơ đồ tab ----
      await page.goto(`${base}/#/task/DG-1?tab=diagram`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(700);
      const d0 = await page.evaluate(DIAG);
      ok(d0.tab === EN['ctx.tab.diagram'], `${w}: the task opens on "${EN['ctx.tab.diagram']}" (${d0.tab})`);
      ok(d0.hasSvg && d0.svgW >= 200 && d0.svgH >= 90, `${w}: the flow is an SVG with a natural size (${d0.svgW}x${d0.svgH})`);
      ok(d0.boxes.length === LIVE, `${w}: one box per live step, the history step is not one (${d0.boxes.length}/${LIVE})`);
      ok(d0.boxes.filter(b => b.cls.includes('current')).length === 1, `${w}: exactly one current step is highlighted`);
      ok(d0.boxes.filter(b => /st-done/.test(b.cls) && /done/.test(b.cls)).length === 2, `${w}: done steps are dimmed, the other states are not`);
      ok(d0.boxes.filter(b => /\bowner\b/.test(b.cls)).length === 1 && d0.boxes.some(b => b.label.includes(EN['diagram.ownerTag'])), `${w}: the owner hand-off is marked`);
      ok(d0.boxes.every(b => /\?step=/.test(b.href)), `${w}: every box links to its step`);
      ok(d0.lanes.length === 5, `${w}: one swimlane per phase (${JSON.stringify(d0.lanes)})`);
      ok(d0.laneCounts.filter(c => c === '1 step').length === 4 && d0.laneCounts.includes('2 steps') && !d0.laneCounts.some(c => /^1 steps\b/.test(c)), `${w}: a one-step lane reads "1 step", not "1 steps" (${d0.laneCounts.join(', ')})`);
      ok(d0.legend.length === 3, `${w}: the legend names the current, owner and done states`);
      ok(d0.hist.present && d0.hist.expanded === 'false' && d0.hist.lines === 0, `${w}: the history step is ONE collapsed box (${d0.hist.text.trim()})`);
      ok(d0.hist.text.includes('60'), `${w}: the collapsed box says how many old steps it holds (${d0.hist.text.trim()})`);
      ok(d0.styled === 0, `${w}: no style="" attribute in the diagram (sizes are SVG attributes)`);
      ok(d0.page <= 0, `${w}: the task pane has no page sideways overflow (${d0.page})`);
      ok(d0.past.length === 0, `${w}: nothing in .ctx crosses its right edge unless its own scroller clips it (${d0.past.slice(0, 4).join(', ')})`);
      ok(/(auto|scroll)/.test(d0.overflowX), `${w}: the diagram scrolls inside its own container (overflow-x ${d0.overflowX})`);
      ok(d0.svgW <= d0.scrollW + 1, `${w}: the flow is not shrunk below its natural width (svg ${d0.svgW} <= scroller ${d0.scrollW})`);
      // the shot shows the flow itself (at 948 it sits below the fold). The page scrolls the flow to the current step
      // itself (afterTaskPaint), so the harness must NOT scroll it by hand: it measures the app's own position — the
      // current box whole, no box sliced by the left edge unless the range ends, and lane labels that stay put.
      await page.evaluate(() => document.querySelector('.diag-card')?.scrollIntoView({ block: 'center' }));
      await page.waitForTimeout(250);
      const EDGES = () => {
        const sc = document.querySelector('.diag-scroll'), sr = sc.getBoundingClientRect();
        const boxes = [...document.querySelectorAll('.dnode .dbox')].map(b => { const r = b.getBoundingClientRect(); return { l: r.left, r: r.right, cur: !!b.closest('.dnode.current') }; });
        const tags = [...document.querySelectorAll('.diag-lane-tags .dlane-t')].map(t => { const r = t.getBoundingClientRect(); return { text: t.textContent, x: Math.round(r.left), visible: r.width > 1 && r.height > 1 }; });
        return {
          left: sr.left, right: sr.right, scrollLeft: sc.scrollLeft, max: sc.scrollWidth - sc.clientWidth, overflow: sc.scrollWidth > sc.clientWidth,
          boxes, tags,
          fadeL: Number(getComputedStyle(document.querySelector('.diag-fade.l')).opacity), fadeR: Number(getComputedStyle(document.querySelector('.diag-fade.r')).opacity)
        };
      };
      const e0 = await page.evaluate(EDGES);
      const cur = e0.boxes.find(b => b.cur);
      ok(e0.tags.length === 5 && e0.tags.every(t => t.visible && t.text.trim()), `${w}: the zone labels are a fixed column of their own (${JSON.stringify(e0.tags.map(t => t.text))})`);
      ok(cur && cur.l >= e0.left - 1 && cur.r <= e0.right + 1, `${w}: the flow opens on the current step, whole (${cur && Math.round(cur.l - e0.left)}…${cur && Math.round(cur.r - e0.left)} of ${Math.round(e0.right - e0.left)})`);
      const cuts = side => e0.boxes.filter(b => (side === 'l' ? b.l < e0.left - 1 && b.r > e0.left + 1 : b.l < e0.right - 1 && b.r > e0.right + 1));
      ok(cuts('l').every(b => !b.cur) && (!cuts('l').length || e0.scrollLeft >= e0.max - 1), `${w}: the left edge slices no box unless the range ends there (${cuts('l').length} cut, scrollLeft ${e0.scrollLeft}/${e0.max})`);
      ok((cuts('l').length > 0) === (e0.fadeL > .5) && (cuts('r').length > 0) === (e0.fadeR > .5), `${w}: an edge fade marks exactly the cut sides (left ${cuts('l').length}/${e0.fadeL}, right ${cuts('r').length}/${e0.fadeR})`);
      // the labels do not move while the flow does: that is the whole point of the separate column
      const moved = await page.evaluate(prev => {
        const sc = document.querySelector('.diag-scroll'), at = sc.scrollLeft;
        sc.scrollLeft = prev + 60 <= sc.scrollWidth - sc.clientWidth ? prev + 60 : Math.max(0, prev - 60);
        const now = [...document.querySelectorAll('.diag-lane-tags .dlane-t')].map(t => Math.round(t.getBoundingClientRect().left));
        sc.scrollLeft = at;
        return now;
      }, e0.scrollLeft);
      ok(moved.every((x, i) => x === e0.tags[i].x), `${w}: the zone labels stay put while the flow scrolls (${moved.join(',')} vs ${e0.tags.map(t => t.x).join(',')})`);
      await page.waitForTimeout(200);
      await shot('diagram');

      // open the history box: the 50-line cap and the "… and N more" line
      await page.click('.diag-hist');
      await page.waitForTimeout(300);
      const d1 = await page.evaluate(DIAG);
      ok(d1.hist.expanded === 'true' && d1.hist.lines === 51, `${w}: opening the history box shows 50 lines plus the "more" line (${d1.hist.lines})`);
      ok(/…/.test(d1.hist.last) && d1.hist.last.includes('10'), `${w}: the last line says 10 more are held back (${d1.hist.last.trim()})`);
      ok(d1.page <= 0, `${w}: the open history box does not push the page sideways (${d1.page})`);
      await page.click('.diag-hist');
      await page.waitForTimeout(250);

      // a box opens that step's detail, exactly like the Steps row
      await page.click('.dnode.current');
      await page.waitForTimeout(500);
      const open = await page.evaluate(() => ({
        hash: location.hash,
        tab: [...document.querySelectorAll('[data-action="ctx-tab"]')].find(b => b.getAttribute('aria-selected') === 'true')?.dataset.tab || '',
        row: document.querySelector('.srow.open .sl')?.textContent || '',
        detail: !!document.querySelector('.sdetail')
      }));
      ok(open.hash === '#/task/DG-1', `${w}: clicking a box leaves a clean task hash (${open.hash})`);
      ok(open.tab === 'steps' && open.row === 'Check the fixture in the browser' && open.detail, `${w}: the box opens that step, expanded, on the Steps tab (${open.tab} · ${open.row})`);

      const mine = errs.slice();
      for (const e of mine) fail(`${w}: ${e}`);
      const csp = [...d0.csp, ...d1.csp, ...h0.csp, ...h1.csp];
      for (const v of csp) fail(`${w}: CSP violation ${v}`);
      L(`${w}: shots saved · console errors ${mine.length} · CSP violations ${csp.length}`);
      await ctx.close();
    }

    // ---- light theme: the same diagram, same colours from the tokens ----
    const lctx = await browser.newContext({ viewport: { width: 1204, height: 754 }, extraHTTPHeaders: { 'X-Laneboard-Owner-Proxy': proxySecret }, colorScheme: 'light' });
    await lctx.addInitScript(() => { window.__csp = []; document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI)); });
    const lp = await lctx.newPage();
    const lerrs = [];
    lp.on('pageerror', e => lerrs.push('pageerror: ' + e.message));
    lp.on('console', m => { if (m.type() === 'error') lerrs.push('console: ' + m.text()); });
    await lp.goto(`${base}/#/task/DG-1?tab=diagram`, { waitUntil: 'networkidle' });
    await lp.waitForTimeout(700);
    await lp.evaluate(() => document.querySelector('.diag-card')?.scrollIntoView({ block: 'center' }));
    await lp.waitForTimeout(200);
    const light = await lp.evaluate(DIAG);
    const lightEdges = await lp.evaluate(() => {
      const sc = document.querySelector('.diag-scroll'), sr = sc.getBoundingClientRect();
      const cur = [...document.querySelectorAll('.dnode.current .dbox')][0]?.getBoundingClientRect();
      const tag = document.querySelector('.diag-lane-tags .dlane-t')?.getBoundingClientRect();
      return { cur: cur && cur.left >= sr.left - 1 && cur.right <= sr.right + 1, tags: document.querySelectorAll('.dlane-t').length, tagX: tag ? Math.round(tag.left) : -1, scroll: sc.scrollLeft };
    });
    ok(lightEdges.cur && lightEdges.tags === 5 && lightEdges.tagX >= 0, 'light: the current step whole, the zone labels in their fixed column');
    const bg = await lp.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const lum = Number((/rgba?\((\d+), (\d+), (\d+)/.exec(bg) || [, 0, 0, 0]).slice(1, 4).reduce((a, v) => a + Number(v), 0)) / 3;
    ok(light.hasSvg && light.boxes.length === LIVE, `light: the diagram renders with every live step (${light.boxes.length})`);
    ok(light.styled === 0 && light.page <= 0, `light: no style="" attribute, no page overflow (${light.page})`);
    ok(lum > 180, `light: the page really is the light theme (${bg})`);
    await lp.screenshot({ path: path.join(OUT, 'after-diagram-light-1204.png') });
    await lp.goto(`${base}/#/home`, { waitUntil: 'networkidle' });
    await lp.waitForTimeout(600);
    const lhome = await lp.evaluate(HOME);
    ok(lhome.present && lhome.boxes === 4 && lhome.page <= 0, `light: Home's map renders without overflowing (${lhome.boxes} boxes)`);
    await lp.screenshot({ path: path.join(OUT, 'after-home-map-light-1204.png') });
    for (const e of lerrs) fail('light: ' + e);
    for (const v of [...light.csp, ...lhome.csp]) fail('light: CSP violation ' + v);
    await lctx.close();

    // ---- Vietnamese: the same two views as the owner reads them (the lang-boot storage key, picked with ?lang=vi) ----
    const ZONE_ORDER = ['plan', 'build', 'test', 'owner', 'ship'];
    const noEnglish = (v, tag) => {
      const labels = [v.tab, ...v.lanes, ...v.laneSteps, ...v.subs, ...v.ownerTags, ...v.legend, ...v.histTitle,
        ...v.histCount, ...v.hint, ...v.overviewTitle, ...v.segs, ...v.counts];
      const leaks = labels.flatMap(l => englishIn(l).map(word => `"${word}" in "${l}"`));
      ok(v.lang === 'vi' && v.stored === 'vi', `${tag}: the page is in Vietnamese (lang ${v.lang}, stored ${v.stored || '—'})`);
      ok(!leaks.length, `${tag}: no English label left on the diagram or the map (${leaks.slice(0, 3).join('; ') || 'none'})`);
    };
    const checkViHome = (v, tag) => {
      noEnglish(v, tag);
      ok(v.overviewTitle.length === 1 && v.overviewTitle[0] === VI['diagram.overviewTitle'], `${tag}: Home says "${VI['diagram.overviewTitle']}" (${v.overviewTitle.join('')})`);
      ok(v.segs.join('|') === [VI['diagram.view.map'], VI['diagram.view.list']].join('|'), `${tag}: the switch reads "${VI['diagram.view.map']}" / "${VI['diagram.view.list']}" (${v.segs.join(' | ')})`);
      const health = ['green', 'yellow', 'red', 'grey'];
      ok(v.counts.length === 5 && health.every((h, i) => v.counts[i].endsWith(VI['health.' + h])) && v.counts[4].endsWith(VI['diagram.waiting']), `${tag}: the counts read in Vietnamese (${v.counts.join(' ')})`);
      ok(v.page <= 0, `${tag}: no page sideways overflow (${v.page})`);
    };
    const LANE_MID = VI['diagram.laneSteps.other'].split('{n}');
    const checkViDiagram = (v, tag) => {
      noEnglish(v, tag);
      ok(v.tab === VI['ctx.tab.diagram'], `${tag}: the task opens on "${VI['ctx.tab.diagram']}" (${v.tab})`);
      ok(v.lanes.join('|') === ZONE_ORDER.map(z => VI['zone.' + z]).join('|'), `${tag}: the five swimlanes read in Vietnamese (${v.lanes.join(' · ')})`);
      ok(v.laneSteps.length === 5 && v.laneSteps.every(l => /\d/.test(l) && l.startsWith(LANE_MID[0]) && l.endsWith(LANE_MID[1])), `${tag}: the lane counts follow "${VI['diagram.laneSteps.other']}" (${v.laneSteps.join(' · ')})`);
      ok(v.subs.length === LIVE && v.subs.every(s => ZONE_ORDER.some(z => s.startsWith(VI['zone.' + z] + ' · ')) && ['todo', 'active', 'waiting', 'blocked', 'done'].some(st => s.includes(' · ' + VI['state.' + st]))), `${tag}: every box's zone/state line is Vietnamese (${v.subs.slice(0, 3).join(' | ')})`);
      ok(v.ownerTags.length === 1 && v.ownerTags[0] === VI['diagram.ownerTag'], `${tag}: the owner tag reads "${VI['diagram.ownerTag']}"`);
      ok(v.legend.join('|') === ['current', 'owner', 'done'].map(k => VI['diagram.legend.' + k]).join('|'), `${tag}: the legend reads in Vietnamese (${v.legend.join(' | ')})`);
      ok(v.histTitle.length === 1 && v.histTitle[0] === VI['diagram.history'] && v.histCount[0] === fill(VI['diagram.historyCount.other'], { n: HIST_LINES.length }), `${tag}: the history box reads "${VI['diagram.history']}" · ${v.histCount[0]}`);
      ok(v.hint.length === 1 && v.hint[0] === VI['diagram.hint'], `${tag}: the hint reads in Vietnamese (${v.hint[0]})`);
      ok(v.svg && v.boxes === LIVE, `${tag}: the flow renders with every live step (${v.boxes}/${LIVE})`);
      ok(v.page <= 0, `${tag}: no page sideways overflow (${v.page})`);
    };

    for (const [w, h] of SIZES) {
      const vctx = await browser.newContext({ viewport: { width: w, height: h }, extraHTTPHeaders: { 'X-Laneboard-Owner-Proxy': proxySecret }, colorScheme: 'dark' });
      await vctx.addInitScript(() => { window.__csp = []; document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI)); });
      const vp = await vctx.newPage();
      const verrs = [];
      vp.on('pageerror', e => verrs.push('pageerror: ' + e.message));
      vp.on('console', m => { if (m.type() === 'error') verrs.push('console: ' + m.text()); });
      await vp.goto(`${base}/?lang=vi#/home`, { waitUntil: 'networkidle' });
      await vp.waitForTimeout(700);
      const vh = await vp.evaluate(LABELS);
      checkViHome(vh, `${w} vi`);
      await vp.evaluate(() => document.querySelector('.diag-overview')?.scrollIntoView({ block: 'center' }));
      await vp.waitForTimeout(200);
      await vp.screenshot({ path: path.join(OUT, `after-home-map-vi-${w}.png`) });
      await vp.goto(`${base}/?lang=vi#/task/DG-1?tab=diagram`, { waitUntil: 'networkidle' });
      await vp.waitForTimeout(700);
      await vp.evaluate(() => document.querySelector('.diag-card')?.scrollIntoView({ block: 'center' }));
      await vp.waitForTimeout(250);
      const vd = await vp.evaluate(LABELS);
      checkViDiagram(vd, `${w} vi`);
      await vp.screenshot({ path: path.join(OUT, `after-diagram-vi-${w}.png`) });
      for (const e of verrs) fail(`${w} vi: ${e}`);
      for (const x of [...vh.csp, ...vd.csp]) fail(`${w} vi: CSP violation ${x}`);
      await vctx.close();
    }

    // light, Vietnamese
    const vlctx = await browser.newContext({ viewport: { width: 1204, height: 754 }, extraHTTPHeaders: { 'X-Laneboard-Owner-Proxy': proxySecret }, colorScheme: 'light' });
    await vlctx.addInitScript(() => { window.__csp = []; document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI)); });
    const vlp = await vlctx.newPage();
    const vlerrs = [];
    vlp.on('pageerror', e => vlerrs.push('pageerror: ' + e.message));
    vlp.on('console', m => { if (m.type() === 'error') vlerrs.push('console: ' + m.text()); });
    await vlp.goto(`${base}/?lang=vi#/task/DG-1?tab=diagram`, { waitUntil: 'networkidle' });
    await vlp.waitForTimeout(700);
    await vlp.evaluate(() => document.querySelector('.diag-card')?.scrollIntoView({ block: 'center' }));
    await vlp.waitForTimeout(250);
    const vld = await vlp.evaluate(LABELS);
    checkViDiagram(vld, '1204 vi light');
    await vlp.screenshot({ path: path.join(OUT, 'after-diagram-vi-light-1204.png') });
    await vlp.goto(`${base}/?lang=vi#/home`, { waitUntil: 'networkidle' });
    await vlp.waitForTimeout(600);
    const vlh = await vlp.evaluate(LABELS);
    checkViHome(vlh, '1204 vi light');
    await vlp.evaluate(() => document.querySelector('.diag-overview')?.scrollIntoView({ block: 'center' }));
    await vlp.waitForTimeout(200);
    await vlp.screenshot({ path: path.join(OUT, 'after-home-map-vi-light-1204.png') });
    for (const e of vlerrs) fail('1204 vi light: ' + e);
    for (const x of [...vld.csp, ...vlh.csp]) fail('1204 vi light: CSP violation ' + x);
    await vlctx.close();
  } finally { await browser.close(); }
} catch (e) {
  fail('check run: ' + e.message);
} finally {
  if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  board?.close();
  fs.rmSync(scratch, { recursive: true, force: true });
  L(failures.length ? `BOARD-DIAGRAM CHECK FAILED (${failures.length})` : 'BOARD-DIAGRAM CHECK PASSED');
  fs.writeFileSync(path.join(OUT, 'check-board-diagram.log'), log.join('\n') + '\n');
  process.exitCode = failures.length ? 1 : 0;
}
