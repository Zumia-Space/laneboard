#!/usr/bin/env node
// J-05 route-override visibility check: where the CoS "Sonnet" allowance note shows on the board, and the badge that
// marks an active allowance on the task row (left list) and in the task header.
//
//   node scripts/check-override-ui.mjs --playwright <playwright-core dir> --chromium <chromium binary> \
//        [--code <Laneboard code dir, default this repo>] [--out <dir>] [--before]
//
// Seeds a SYNTHETIC board through the real write API: OVR-1 with an active 24 h allowance (its current step s2),
// OVR-2 whose 1 h allowance has expired (the fixture clock moves 2 h after seeding), OVR-3 whose allowance was cleared.
// --before only saves the current shots and reports where the note is visible (no badge assertions); the default run
// asserts the badge is on the row and the header for OVR-1 only, absent for OVR-2/OVR-3, and the step's history shows
// the note. Shots: before-*.png / after-*.png in --out, Vietnamese, dark and light, 1204 and 948 px.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2), arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CODE = path.resolve(arg('--code', HERE)), OUT = path.resolve(arg('--out', path.join(os.tmpdir(), 'laneboard-override-ui')));
const PW = arg('--playwright'), EXE = arg('--chromium'), BEFORE = args.includes('--before');
if (!PW || !EXE) { console.error('usage: check-override-ui.mjs --playwright <playwright-core dir> --chromium <binary> [--code <dir>] [--out <dir>] [--before]'); process.exit(2); }
const PREFIX = BEFORE ? 'before' : 'after';
const log = [], failures = [];
const L = s => { log.push(s); console.log(s); };
const fail = s => { failures.push(s); L('FAIL ' + s); };
const ok = (cond, msg) => { if (cond) L('ok ' + msg); else fail(msg); };
const VI = JSON.parse(fs.readFileSync(path.join(CODE, 'public', 'locales', 'vi.json'), 'utf8'));

const STEPS = [
  { id: 's1', label: 'Scope the override fixture', zone: 'plan', state: 'done' },
  { id: 's2', label: 'Wire the allowance note', zone: 'build', state: 'active' },
  { id: 's3', label: 'Read it on the board', zone: 'test', state: 'todo' }];

const { createBoard } = await import(pathToFileURL(path.join(CODE, 'src', 'board.mjs')));
const { createServer } = await import(pathToFileURL(path.join(CODE, 'src', 'server.mjs')));
const { chromium } = createRequire(path.join(PW, 'package.json'))(PW);

fs.mkdirSync(OUT, { recursive: true });
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'laneboard-override-ui-data-'));
let server, board;
const clock = { t: Date.parse('2026-10-20T03:00:00.000Z') }; // 10:00 VN
try {
  const proxySecret = crypto.randomBytes(32).toString('base64url');
  board = createBoard({ dataDir: scratch, now: () => clock.t });
  server = createServer(board, { ownerProxySecret: proxySecret });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  L(`check: code ${CODE} · out ${OUT} · ${base} · ${BEFORE ? 'before' : 'after'}`);

  const OWNER = { 'X-Laneboard-Owner-Proxy': proxySecret, 'X-Requested-With': 'laneboard' };
  const rid = () => 'ovr-' + crypto.randomBytes(6).toString('hex');
  const write = async (headers, op, target_id, data) => {
    const r = await fetch(base + '/api/v1/write', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ version: 1, request_id: rid(), op, target_id, data }) });
    const body = await r.json();
    if (!r.ok) throw new Error(`seed ${op} ${target_id}: ${r.status} ${JSON.stringify(body)}`);
    return body;
  };
  const api = (op, target_id, data) => write(OWNER, op, target_id, data);
  await api('task.create', 'OVR-1', { title: 'Route override fixture: active allowance', lane: 'CoS', health: 'green', now: 'Wiring the allowance note', next: 'Read the badge', steps: STEPS });
  await api('task.create', 'OVR-2', { title: 'Route override fixture: expired allowance', lane: 'CoS', health: 'green', now: 'Expired window', next: 'Nothing to see', steps: STEPS });
  await api('task.create', 'OVR-3', { title: 'Route override fixture: cleared allowance', lane: 'CoS', health: 'green', now: 'Cleared window', next: 'Nothing to see', steps: STEPS });
  // The allowance is CoS's, so the fixture writes it as the coordinator token with the CoS lane — the note is then
  // attributed to CoS, never to the owner (the reviewed shot read "anh" only because the harness used the owner proxy).
  const cosToken = (await api('token.issue', 'cos-coord', { role: 'coordinator', lane: 'CoS', label: 'CoS' })).token;
  const cos = { Authorization: `Bearer ${cosToken}` };
  await write(cos, 'roles.override', 'OVR-1', { reason: 'Ưu tiên việc gấp', hours: 24, lane: 'CoS' });
  await write(cos, 'roles.override', 'OVR-2', { reason: 'Cửa sổ ngắn', hours: 1, lane: 'CoS' });
  await write(cos, 'roles.override', 'OVR-3', { reason: 'Thử rồi bỏ', hours: 24, lane: 'CoS' });
  await write(cos, 'roles.override', 'OVR-3', { clear: true, reason: 'Anh trả lại', lane: 'CoS' });
  clock.t += 2 * 3600000; // OVR-2's 1 h window is now in the past; OVR-1's 24 h window is still open
  L('seeded OVR-1 active 24 h · OVR-2 expired after 2 h · OVR-3 cleared, then moved the fixture clock 2 h');

  const state = await (await fetch(base + '/api/v1/state', { headers: OWNER })).json();
  for (const code of ['OVR-1', 'OVR-2', 'OVR-3']) {
    const o = state.route_override[code];
    L(`state ${code}: ${o ? `${o.model} expired=${o.expired} expires=${o.expires}` : 'none'}`);
  }
  const noteRec = state.feedback.find(f => String(f.text || '').startsWith('CoS cho Sonnet làm:'));
  L(`note: info=${noteRec?.info} status=${noteRec?.status} by=${noteRec?.attribution?.created_by?.name}/${noteRec?.attribution?.created_by?.role} step=${noteRec?.step_id}`);
  // A clear with nothing to clear changes nothing: no event, no second note.
  const seqBefore = (await (await fetch(base + '/api/v1/state', { headers: OWNER })).json()).seq;
  const noop = await write(cos, 'roles.override', 'OVR-3', { clear: true, lane: 'CoS' });
  const seqAfter = (await (await fetch(base + '/api/v1/state', { headers: OWNER })).json()).seq;
  L(`second clear of OVR-3: noop=${noop.noop} seq ${seqBefore} -> ${seqAfter}`);
  if (!BEFORE) {
    ok(noteRec?.info === true, 'the override note is informational');
    ok(noteRec?.attribution?.created_by?.name === 'cos-coord', 'the note is attributed to the CoS actor, not the owner');
    ok(noop.noop === true && seqAfter === seqBefore, 'clearing an already-null allowance is a no-op (no event)');
  }

  const probe = () => {
    const txt = el => el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
    const task = 'OVR-1';
    const row = [...document.querySelectorAll('.lrow.task')].find(r => r.textContent.includes(task));
    const head = document.querySelector('.tv-head');
    const detail = document.querySelector('.sdetail');
    const stream = document.querySelector('#stream-scroll');
    const hist = document.querySelector('details.docs[data-open="hist"]');
    const badge = el => { const b = el && el.querySelector('[data-override]'); return b ? { text: txt(b), title: b.getAttribute('title') || '', aria: b.getAttribute('aria-label') || '', width: Math.round(b.getBoundingClientRect().width) } : null; };
    const ttl = row && row.querySelector('.ttl'), note = [...document.querySelectorAll('.ev.msg')].find(e => e.textContent.includes('CoS cho Sonnet'));
    return {
      lang: document.documentElement.lang,
      row: txt(row), rowBadge: badge(row), rowOpen: row ? [...row.querySelectorAll('.badge')].map(b => txt(b)) : [],
      titleWidth: ttl ? { w: Math.round(ttl.getBoundingClientRect().width), scroll: ttl.scrollWidth } : null,
      head: txt(head), headBadge: badge(head),
      stepOpen: !!detail, step: txt(detail),
      stream: txt(stream), hist: txt(hist),
      noteAuthor: note ? txt(note.querySelector('.ev-meta b')) : '', noteResolve: !!(note && note.querySelector('[data-action="resolve"]')),
      noteIn: { row: txt(row).includes('CoS cho Sonnet'), head: txt(head).includes('CoS cho Sonnet'), step: txt(detail).includes('CoS cho Sonnet'), stream: txt(stream).includes('CoS cho Sonnet'), hist: txt(hist).includes('CoS cho Sonnet') },
      noteEls: [...document.querySelectorAll('.ev')].filter(e => e.textContent.includes('CoS cho Sonnet')).map(e => `${e.className} step=${e.getAttribute('data-step') || '—'}`),
      page: document.documentElement.scrollWidth - window.innerWidth,
      csp: (window.__csp || []).slice()
    };
  };

  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  try {
    // The rail contract. >= 900px (B2: Tasks is a permanent pane, not run with --before): the toggle is hidden and the list is shown.
    // < 900px, and the old layout up to 960px: the list folds behind the toggle, which is visible and clicked.
    const railContract = async (page, w, back) => {
      const b2 = await page.evaluate(() => document.documentElement.classList.contains('b2'));
      const toggleShown = await page.isVisible('[data-action="rail"]');
      if (!BEFORE && w >= 900) { if (!back) { ok(b2, `${w}: B2 is active at >= 900px`); ok(!toggleShown, `${w}: the rail toggle is hidden`); ok(await page.isVisible('.rail-tasks'), `${w}: the task list is shown without it`); } return; }
      if (w <= 960) { if (!back) ok(toggleShown, `${w}: the rail toggle is visible`); await page.click('[data-action="rail"]'); }
    };
    const shoot = async (w, h, scheme, tag) => {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, extraHTTPHeaders: { 'X-Laneboard-Owner-Proxy': proxySecret }, colorScheme: scheme });
      await ctx.addInitScript(() => { window.__csp = []; document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI)); });
      const page = await ctx.newPage();
      const errs = [];
      page.on('pageerror', e => errs.push('pageerror: ' + e.message));
      page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
      await page.goto(`${base}/?lang=vi#/task/OVR-1?step=s2`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(700);
      await page.evaluate(() => { const d = document.querySelector('details.docs[data-open="hist"]'); if (d && !d.open) d.open = true; }); // the journal card starts folded
      await page.waitForTimeout(200);
      await railContract(page, w, false);
      await page.waitForTimeout(250); // only now is the row laid out, so the title width probe means something (948 px)
      const p = await page.evaluate(probe);
      // Element shots by measured clip: a locator screenshot retries while the page repaints itself (15 s refresh) and
      // then reports the node as detached. The app repaints on a timer, so measure, capture at once.
      const shot = async (name, selector) => {
        const r = await page.evaluate(sel => {
          const el = document.querySelector(sel);
          if (!el) return null;
          el.scrollIntoView({ block: 'center', inline: 'nearest' });
          const q = el.getBoundingClientRect();
          return { x: Math.max(0, q.left), y: Math.max(0, q.top), width: Math.min(q.width, innerWidth - Math.max(0, q.left)), height: Math.min(q.height, innerHeight - Math.max(0, q.top)) };
        }, selector);
        if (!r || r.width < 2 || r.height < 2) { L(`${tag}: no visible ${name} (${selector})`); return; }
        await page.waitForTimeout(120);
        await page.screenshot({ path: path.join(OUT, `${PREFIX}-${name}${tag}.png`), clip: r });
      };
      await shot('row', '.rail-tasks .lrow.task');
      await railContract(page, w, true);
      await page.waitForTimeout(250);
      await page.evaluate(() => { const d = document.querySelector('details.docs[data-open="hist"]'); if (d && !d.open) d.open = true; }); // a repaint folded it again
      await page.waitForTimeout(150);
      await shot('header', '.tv-head');
      await shot('step', '.sdetail');
      await shot('stream', '#stream-scroll');
      await shot('history', 'details.docs[data-open="hist"]');
      await page.screenshot({ path: path.join(OUT, `${PREFIX}-page${tag}.png`) });
      for (const e of errs) fail(`${tag}: ${e}`);
      for (const v of p.csp) fail(`${tag}: CSP violation ${v}`);
      ok(p.lang === 'vi', `${tag}: the page is in Vietnamese (${p.lang})`);
      ok(p.page <= 0, `${tag}: no page sideways overflow (${p.page})`);
      L(`${tag}: note in row=${p.noteIn.row} header=${p.noteIn.head} step=${p.noteIn.step} stream=${p.noteIn.stream} history=${p.noteIn.hist}`);
      if (p.noteEls.length) L(`${tag}: note entries ${p.noteEls.join(' | ')}`);
      L(`${tag}: row=${JSON.stringify(p.row)}`);
      L(`${tag}: title=${JSON.stringify(p.titleWidth)} rowBadge=${JSON.stringify(p.rowBadge)} rowOpen=${JSON.stringify(p.rowOpen)} note=${p.noteAuthor}/${p.noteResolve}`);
      L(`${tag}: step=${JSON.stringify(p.step.slice(0, 300))}`);
      if (!BEFORE) {
        const time = '10:00 21-10'; // the expiry is tomorrow on the VN clock (the fixture starts at 10:00 20-10)
        ok(p.rowBadge && p.rowBadge.text === 'S', `${tag}: the row carries only a compact badge (${p.rowBadge ? p.rowBadge.text : 'no badge'})`);
        ok(p.rowBadge && p.rowBadge.title === `Sonnet đến ${time} · Ưu tiên việc gấp`, `${tag}: the compact badge's tooltip is the full text and reason (${p.rowBadge && p.rowBadge.title})`);
        ok(p.rowBadge && p.rowBadge.aria === `Sonnet đến ${time} · Ưu tiên việc gấp`, `${tag}: the compact badge's accessible name is the same (${p.rowBadge && p.rowBadge.aria})`);
        ok(p.rowBadge && p.rowBadge.width <= 26, `${tag}: the compact badge is small (${p.rowBadge && p.rowBadge.width}px)`);
        ok(p.headBadge && p.headBadge.text === `Sonnet đến ${time}`, `${tag}: the header keeps the full text (${p.headBadge ? p.headBadge.text : 'no badge'})`);
        ok(p.headBadge && p.headBadge.title === `Sonnet đến ${time} · Ưu tiên việc gấp`, `${tag}: the header tooltip carries the reason (${p.headBadge && p.headBadge.title})`);
        ok(p.titleWidth && p.titleWidth.w >= 80, `${tag}: the task title keeps its width (${p.titleWidth && p.titleWidth.w}px)`);
        ok(p.rowOpen.length === 0, `${tag}: the informational note adds no open-feedback count (${JSON.stringify(p.rowOpen)})`);
        ok(p.noteAuthor === 'cos-coord', `${tag}: the note is attributed to the CoS actor (${p.noteAuthor})`);
        ok(!p.noteResolve, `${tag}: the note has no "mark handled" action`);
        ok(p.step.includes('CoS cho Sonnet làm: Ưu tiên việc gấp'), `${tag}: the step's history shows the set note (${p.step.slice(0, 160)})`);
        ok(p.noteIn.stream, `${tag}: the task stream shows the set note`);
        const others = await page.evaluate(() => [...document.querySelectorAll('.lrow.task')].filter(r => !r.textContent.includes('OVR-1')).map(r => [r.textContent.replace(/\s+/g, ' ').trim(), !!r.querySelector('[data-override]')]));
        ok(others.every(([, has]) => !has), `${tag}: expired and cleared tasks carry no badge (${JSON.stringify(others)})`);
      }
      await ctx.close();
    };
    await shoot(1204, 1000, 'dark', '-1204');
    await shoot(1204, 1000, 'light', '-1204-light');
    await shoot(948, 900, 'dark', '-948');
    await shoot(948, 900, 'light', '-948-light');
    await shoot(860, 900, 'dark', '-860');
  } finally { await browser.close(); }
} catch (e) {
  fail('check run: ' + e.message);
} finally {
  if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  board?.close();
  fs.rmSync(scratch, { recursive: true, force: true });
  L(failures.length ? `OVERRIDE-UI CHECK FAILED (${failures.length})` : 'OVERRIDE-UI CHECK PASSED');
  fs.writeFileSync(path.join(OUT, `check-override-ui-${PREFIX}.log`), log.join('\n') + '\n');
  process.exitCode = failures.length ? 1 : 0;
}
