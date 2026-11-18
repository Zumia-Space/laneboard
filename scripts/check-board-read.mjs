#!/usr/bin/env node
// ACME-02 board-read check: the right pane, the step rows and the reader, measured in headless Chromium.
//
//   node scripts/check-board-read.mjs --playwright <playwright-core dir> --chromium <chromium binary> \
//        [--code <Laneboard code dir, default this repo>] [--out <dir>] [--before]
//
// Seeds a SYNTHETIC task (no real content: the app is open source) through the real write API — a 10k+ character
// report, three tables (one with four columns), a code block, an image attachment, long step titles, a long ask and a
// long "Hiện tại"
// line — then measures the board at 1204x754, 1844x1034 and 948x594 (the Zumi board area at 100% and 125%).
// Checks: nothing in the right pane .ctx crosses its right edge, no sideways overflow, no nested scroller (steps
// open and reader open), step titles wrap to two lines with the full text in @title, a long report shows a read
// button (label + muted reading time) while a short one shows in full, the reader is one-scroller dialog with a 60-85ch
// column and no table wider than its box, its image loads on open (not on the next poll), the header carries the task
// title and a primary reply, Esc closes it and returns the focus, a poll refresh keeps it open at the same scroll
// position, the text column is LEFT-aligned (its left edge is the header's, not centred) with a Vừa/Rộng/Đầy khung width
// toggle whose lines measure ~74ch / ~100ch / the whole pane, no element passes the pane, the choice survives a reload,
// "Trả lời bước này" scopes the composer, and a reporter viewer gets no reply button. --before renders the
// base tree's pages and only saves the shots
// (before-board-*, before-pane-*, before-centre-*), so the same run can shoot before and after.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { demoPng } from './seed.mjs';

const args = process.argv.slice(2), arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CODE = path.resolve(arg('--code', HERE)), OUT = path.resolve(arg('--out', path.join(os.tmpdir(), 'laneboard-board-read')));
const PW = arg('--playwright'), EXE = arg('--chromium'), BEFORE = args.includes('--before');
if (!PW || !EXE) { console.error('usage: check-board-read.mjs --playwright <playwright-core dir> --chromium <binary> [--code <dir>] [--out <dir>] [--before]'); process.exit(2); }
const SIZES = [[1204, 754], [1844, 1034], [948, 594]];
const log = [], failures = [];
const L = s => { log.push(s); console.log(s); };
const fail = s => { failures.push(s); L('FAIL ' + s); };
const ok = (cond, msg) => { if (cond) L('ok ' + msg); else fail(msg); };
const tag = BEFORE ? 'before' : 'after';

// ---- synthetic fixture (deterministic, no real text) ----
const WORDS = 'capacity report synthetic fixture row column value export batch window ledger timeline status owner note review confirm sample'.split(' ');
const sentence = i => { const w = []; for (let k = 0; k < 16; k++) w.push(WORDS[(i * 7 + k * 5) % WORDS.length]); const s = w.join(' '); return s[0].toUpperCase() + s.slice(1) + '.'; };
const para = n => [0, 1, 2, 3].map(k => sentence(n * 4 + k)).join(' ');
const table = (cols, rows) => [`| ${cols.join(' | ')} |`, `| ${cols.map(() => '---').join(' | ')} |`, ...rows.map(r => `| ${r.join(' | ')} |`)].join('\n');
const TABLE3 = table(['Item', 'Owner', 'State'], [['Row one', 'lane-a', 'active'], ['Row two', 'workerb', 'todo'], ['Row three', 'lane-a', 'done']]);
const TABLE4 = table(['Item', 'Owner', 'State', 'Note'], [['Row one', 'lane-a', 'active', 'short note'], ['Row two', 'workerb', 'todo', 'short note'], ['Row three', 'lane-a', 'done', 'short note']]);
const TABLE2 = table(['Measure', 'Value'], [['Rows', '3'], ['Columns', '4']]);
const CODE_BLOCK = ['```js', "const rows = [{ item: 'row one', state: 'active' }];", 'for (const row of rows) { console.log(row.item, row.state); }', '```'].join('\n');
const IMG_NAME = 'fixture-shot.png'; // a real attachment on BR-1, so the reader's image resolves through resolveMedia
const IMG_MD = `![Synthetic fixture image](media/${IMG_NAME})`;
function report() {
  const parts = ['# Synthetic capacity report', para(0)];
  let i = 1;
  while (parts.join('\n\n').length < 9400) parts.push(`## Section ${i}`, para(i * 4), para(i * 4 + 1)), i++;
  parts.push('## Reference tables', TABLE3, TABLE4, TABLE2, '## Sample', CODE_BLOCK, '## Fixture image', IMG_MD);
  parts.push('FixtureEndMarker: the synthetic report ends here.');
  return parts.join('\n\n');
}
const REPORT = report();
const TLDR_REPORT = ['# Synthetic report with a summary', para(900), '## Tóm tắt', '- SummaryMarker: three rows match', '- one row needs a second look', '## Chi tiết', para(901), para(902), para(903), 'DetailEndMarker: the long part ends here.'].join('\n\n');
const MD_PATH = 'D:/data/laneboard/fixture/report.md', MD_NONE = 'D:/data/laneboard/fixture/none.md'; // an attached local .md, and one nobody attached
const MD_NOW = 'Reading the attached file.\nreport `' + MD_PATH + '` · other `' + MD_NONE + '`';
const FEED_MD = 'D:/data/laneboard/acme-01/full-report.md', FEED_MD2 = 'D:/data/laneboard/acme-01/other-notes.md';
const FEED_URL = 'https://detail.1688.com/offer/7123456789012.html?spm=a261y.7663282.0.0&scm=1007.34127.0.0&sk=consign&tracelog=sellerrecommend_very_long_query_that_must_wrap';
const FEED_ASK = ['Báo cáo nguồn hàng đã xong, anh chọn giúp em hướng nào để em đẩy tiếp:', 'Dòng 2: so sánh giá 1688 và Shopee cho 12 mã hàng chủ lực.', 'Dòng 3: các shop có phản hồi tốt trên 4.8 sao.', 'Dòng 4: ba shop vận chuyển nhanh nhất về kho Hà Nội.', 'Dòng 5: chi phí ước tính cho lô thử đầu tiên.', 'Dòng 6: rủi ro thuế và phí nhập khẩu.'].join('\n');
const FEED_ANSWER = Array.from({ length: 8 }, (_, k) => `Trả lời dòng ${k + 1}: ${sentence(500 + k)}`).join('\n');
const SHORT_REPORT = 'A short synthetic report. It fits in the pane, so it shows in full with no read button. ShortReportEnd.';
const LONG_TITLE_1 = 'Review the synthetic capacity report and confirm every row matches the source export before the weekly handover';
const LONG_TITLE_2 = 'Reconcile the four-column reference table against the export and record any row that still looks wrong';
const SHORT_TITLE = 'Short step with a short report';
const LONG_NOW = Array.from({ length: 7 }, (_, k) => sentence(300 + k)).join(' ');
const NOW_TEXT = LONG_NOW + '\n\n[fixture link](https://example.com/brard)'; // a refs line: its row must stay unclipped under a folded card
const SHORT_NOW = 'Reconciling the synthetic export.';
const LONG_ASK = Array.from({ length: 6 }, (_, k) => sentence(400 + k)).join(' ');
const EN = JSON.parse(fs.readFileSync(path.join(CODE, 'public', 'locales', 'en.json'), 'utf8')); // the page renders in English by default

const { createBoard } = await import(pathToFileURL(path.join(CODE, 'src', 'board.mjs')));
const { createServer } = await import(pathToFileURL(path.join(CODE, 'src', 'server.mjs')));
const { chromium } = createRequire(path.join(PW, 'package.json'))(PW);

fs.mkdirSync(OUT, { recursive: true });
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'laneboard-board-read-data-'));
let server, board;
try {
  const proxySecret = crypto.randomBytes(32).toString('base64url');
  board = createBoard({ dataDir: scratch });
  server = createServer(board, { ownerProxySecret: proxySecret });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  L(`check: code ${CODE} · out ${OUT} · ${base}`);
  L(`fixture: report ${REPORT.length} chars · long ask ${LONG_ASK.length} · long now ${LONG_NOW.length}`);
  if (REPORT.length < 10000) fail(`fixture report is only ${REPORT.length} chars`);

  const OWNER = { 'X-Laneboard-Owner-Proxy': proxySecret, 'X-Requested-With': 'laneboard' };
  const rid = () => 'brard-' + crypto.randomBytes(6).toString('hex');
  const api = async (headers, op, target_id, data, extra = {}) => {
    const r = await fetch(base + '/api/v1/write', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ version: 1, request_id: rid(), op, target_id, data, ...extra }) });
    const body = await r.json();
    if (!r.ok) throw new Error(`seed ${op} ${target_id}: ${r.status} ${JSON.stringify(body)}`);
    return body;
  };
  const coordToken = (await api(OWNER, 'token.issue', 'brard-coordinator-' + crypto.randomBytes(3).toString('hex'), { role: 'coordinator', replace_coordinator: true, label: 'board-read check' })).token;
  const COORD = { Authorization: `Bearer ${coordToken}` };
  const viewerToken = (await api(OWNER, 'token.issue', 'brard-viewer-' + crypto.randomBytes(3).toString('hex'), { role: 'reporter', scope_tasks: ['*'], label: 'board-read viewer' })).token;
  await api(COORD, 'task.create', 'BR-1', { title: 'Board-read fixture: synthetic capacity report', lane: 'fixture', now: NOW_TEXT, next: 'Confirm the short step shows in full', steps: [
    { id: 's1', label: LONG_TITLE_1, zone: 'build', state: 'active' },
    { id: 's2', label: SHORT_TITLE, zone: 'build', state: 'todo' },
    { id: 's3', label: LONG_TITLE_2, zone: 'test', state: 'todo' }] });
  await api(COORD, 'task.create', 'BR-2', { title: 'Board-read fixture: short lines', lane: 'fixture', now: SHORT_NOW, next: 'Nothing to read', steps: [
    { id: 's1', label: 'Short step', zone: 'build', state: 'todo' }] });
  await api(COORD, 'task.create', 'BR-3', { title: 'Board-read fixture: report with a summary', lane: 'fixture', now: MD_NOW, next: 'Read the summary', steps: [
    { id: 's1', label: 'Read the summary first', zone: 'build', state: 'todo' }] });
  const revOf = async (taskId, sid) => (await (await fetch(base + '/api/v1/state', { headers: OWNER })).json()).tasks.find(t => t.id === taskId).steps.find(s => s.id === sid).rev;
  await api(COORD, 'step.update', 'BR-1/s1', { detail: REPORT }, { expected_revision: await revOf('BR-1', 'BR-1/s1') });
  await api(COORD, 'step.update', 'BR-1/s2', { detail: SHORT_REPORT }, { expected_revision: await revOf('BR-1', 'BR-1/s2') });
  await api(COORD, 'step.update', 'BR-3/s1', { detail: TLDR_REPORT }, { expected_revision: await revOf('BR-3', 'BR-3/s1') });
  await api(COORD, 'step.update', 'BR-2/s1', { detail: SHORT_REPORT }, { expected_revision: await revOf('BR-2', 'BR-2/s1') });
  await api(COORD, 'ask.raise', 'BR-1', { text: LONG_ASK, step_id: 's1' });
  const mdUp = await fetch(`${base}/api/v1/upload?request_id=${rid()}&task_id=BR-3&name=report.md&mime=${encodeURIComponent('text/markdown')}&caption=${encodeURIComponent(MD_PATH)}`, { method: 'POST', headers: { ...OWNER, 'Content-Type': 'text/markdown' }, body: TLDR_REPORT });
  if (!mdUp.ok) throw new Error(`seed md upload: ${mdUp.status} ${JSON.stringify(await mdUp.json())}`);
  const up = await fetch(`${base}/api/v1/upload?request_id=${rid()}&task_id=BR-1&name=${IMG_NAME}&mime=${encodeURIComponent('image/png')}`, { method: 'POST', headers: { ...OWNER, 'Content-Type': 'image/png' }, body: demoPng(240, 160) });
  const upBody = await up.json();
  if (!up.ok) throw new Error(`seed upload: ${up.status} ${JSON.stringify(upBody)}`);
  L(`seeded BR-1 (long report + image, long ask, long now) and BR-2 (short lines)`);
  // BR-4: the activity feed. A long ask whose "Chi tiết:" line names an attached .md (a code span, as cos-board writes it), a second .md nobody
  // attached, a long web URL, an unsafe link, and an owner answer with many lines.
  await api(COORD, 'task.create', 'BR-4', { title: 'Board-read fixture: activity feed', lane: 'fixture', now: SHORT_NOW, next: 'Read the feed', steps: [
    { id: 's1', label: 'Answer the sourcing question', zone: 'owner', state: 'waiting' }] });
  await api(COORD, 'ask.raise', 'BR-4', { step_id: 's1', text: [FEED_ASK, `Chi tiết: \`${FEED_MD}\``, '', `Unsafe: [x](javascript:alert(1)) and [y](data:text/html,hi) and ${FEED_URL}`, `report \`${FEED_MD}\` · other \`${FEED_MD2}\` · [offer](${FEED_URL})`].join('\n') });
  await api(OWNER, 'feedback.add', 'BR-4', { kind: 'note', text: FEED_ANSWER });
  const feedUp = await fetch(`${base}/api/v1/upload?request_id=${rid()}&task_id=BR-4&name=sourcing.md&mime=${encodeURIComponent('text/markdown')}&caption=${encodeURIComponent(FEED_MD)}`, { method: 'POST', headers: { ...OWNER, 'Content-Type': 'text/markdown' }, body: TLDR_REPORT });
  if (!feedUp.ok) throw new Error(`seed feed upload: ${feedUp.status} ${JSON.stringify(await feedUp.json())}`);

  // ---- in-page probes (returned as plain data; every assertion runs in Node) ----
  const PROBE = () => {
    const main = document.getElementById('main');
    const scrollers = root => {
      const all = [...root.querySelectorAll('*')].filter(el => {
        const cs = getComputedStyle(el);
        const o = /(auto|scroll)/.test(cs.overflowX) || /(auto|scroll)/.test(cs.overflowY);
        return o && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1);
      });
      return all.map(el => ({ sel: String(el.className || el.tagName), nested: all.some(x => x !== el && x.contains(el)) }));
    };
    const ctx = document.querySelector('#ctx'), ctxRect = ctx?.getBoundingClientRect();
    const past = ctx ? [...ctx.querySelectorAll('*')].filter(el => { const r = el.getBoundingClientRect(); return r.width > 1 && r.right > ctxRect.right + 1; }).map(el => `${el.tagName}.${el.className}@${Math.round(el.getBoundingClientRect().right)}`) : [];
    const titles = [...document.querySelectorAll('.srow')].map(row => {
      const sl = row.querySelector('.sl'), main = row.querySelector('.srow-main'), cs = getComputedStyle(sl);
      return { text: sl.textContent, whiteSpace: cs.whiteSpace, textOverflow: cs.textOverflow, clamp: cs.webkitLineClamp || cs.getPropertyValue('-webkit-line-clamp'), title: main.getAttribute('title'), lines: Math.round(sl.getBoundingClientRect().height / parseFloat(cs.lineHeight)) };
    });
    return {
      ctxOverflow: ctx ? ctx.scrollWidth - ctx.clientWidth : -1,
      pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
      past, titles, scrollers: scrollers(main), stepOpen: !!document.querySelector('.sdetail')
    };
  };
  const READER_PROBE = () => {
    const el = document.getElementById('reader');
    if (!el) return { present: false };
    const body = el.querySelector('.reader-body'), doc = el.querySelector('.reader-doc');
    const scrollers = root => {
      const all = [...root.querySelectorAll('*')].filter(x => {
        const cs = getComputedStyle(x);
        const o = /(auto|scroll)/.test(cs.overflowX) || /(auto|scroll)/.test(cs.overflowY);
        return o && (x.scrollWidth > x.clientWidth + 1 || x.scrollHeight > x.clientHeight + 1);
      });
      return all.map(x => ({ sel: String(x.className || x.tagName), nested: all.some(y => y !== x && y.contains(x)) }));
    };
    const span = document.createElement('span');
    span.style.cssText = 'position:absolute;visibility:hidden;width:100ch;font:' + getComputedStyle(doc).font;
    document.body.append(span);
    const ch = span.getBoundingClientRect().width / 100;
    span.remove();
    const docR = doc.getBoundingClientRect();
    return {
      present: true, role: el.getAttribute('role'), modal: el.getAttribute('aria-modal'), probe: el.dataset.probe || '',
      scrollers: scrollers(el), bodyScrolls: body.scrollHeight > body.clientHeight + 1,
      docCh: Math.round((doc.clientWidth - 48) / ch), widthCh: Math.round(docR.width / ch),
      tables: [...el.querySelectorAll('.md-table-wrap')].map(w => w.scrollWidth - w.clientWidth),
      tablesPast: [...el.querySelectorAll('.md-table')].filter(t => t.getBoundingClientRect().right > docR.right + 1).length,
      text: doc.textContent, reading: document.documentElement.classList.contains('reading'), focusedBody: document.activeElement === body,
      scrollTop: body.scrollTop
    };
  };
  // The reader's text column: where it starts, how long a line is, and whether anything passes the pane (ACME-02 reader width).
  const WIDTH_PROBE = () => {
    const el = document.getElementById('reader'), body = el.querySelector('.reader-body'), doc = el.querySelector('.reader-doc');
    const chOf = node => { const sp = document.createElement('span'); sp.style.cssText = 'position:absolute;visibility:hidden;width:100ch;font:' + getComputedStyle(node).font; document.body.append(sp); const c = sp.getBoundingClientRect().width / 100; sp.remove(); return c; };
    const p = el.querySelector('.md > p'), pr = p.getBoundingClientRect();
    const br = body.getBoundingClientRect(), pane = body.clientWidth, chDoc = chOf(doc);
    const first = sel => el.querySelector(sel)?.getBoundingClientRect();
    return {
      width: el.dataset.width, pane, chDoc, b2: document.documentElement.classList.contains('b2'), pad: parseFloat(getComputedStyle(doc).paddingLeft) + parseFloat(getComputedStyle(doc).paddingRight), vw: document.documentElement.clientWidth, rail: Math.round(document.querySelector('.rail').getBoundingClientRect().width), pCh: pr.width / chOf(p), pPx: pr.width, pLeft: pr.left - br.left, headLeft: el.querySelector('#reader-title').getBoundingClientRect().left - br.left,
      h2Left: first('.md-h2') ? first('.md-h2').left - br.left : -1, imgLeft: first('.md-img') ? first('.md-img').left - br.left : -1, imgRight: first('.md-img') ? first('.md-img').right - br.left : -1, pRight: pr.right - br.left,
      pressed: [...el.querySelectorAll('[data-action="reader-width"]')].filter(b => b.getAttribute('aria-checked') === 'true').map(b => b.dataset.w),
      labels: [...el.querySelectorAll('[data-action="reader-width"]')].map(b => b.textContent),
      past: [...body.querySelectorAll('*')].filter(x => { const r = x.getBoundingClientRect(); return r.width > 1 && r.right > br.left + pane + 1; }).map(x => x.tagName + '.' + x.className),
      hscroll: body.scrollWidth - body.clientWidth, tables: [...el.querySelectorAll('.md-table-wrap')].map(w => w.scrollWidth - w.clientWidth),
      tableMaxPx: Math.max(0, ...[...el.querySelectorAll('.md-table-wrap')].map(w => w.getBoundingClientRect().width)), scrollTop: body.scrollTop,
      focus: document.activeElement?.dataset?.w || ''
    };
  };
  const focusInfo = () => ({ action: document.activeElement?.dataset?.action || '', kind: document.activeElement?.dataset?.kind || '', step: document.activeElement?.dataset?.step || '', textarea: document.activeElement?.tagName === 'TEXTAREA', scope: document.querySelector('select[data-compose-scope]')?.value || '' });

  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  try {
    for (const [w, h] of SIZES) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, extraHTTPHeaders: { 'X-Laneboard-Owner-Proxy': proxySecret }, colorScheme: 'dark' });
      const page = await ctx.newPage();
      const errs = [];
      page.on('pageerror', e => errs.push('pageerror: ' + e.message));
      page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
      const shot = (name, full = false) => page.screenshot({ path: path.join(OUT, `${tag}-${name}-${w}.png`), fullPage: full });
      await page.goto(`${base}/#/task/BR-1`, { waitUntil: 'networkidle' });
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForTimeout(900);
      const errBase = errs.length;
      await shot('board', true);
      await page.goto(`${base}/#/task/BR-4`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(800);
      await page.setViewportSize({ width: w, height: 1500 }); // tall, so the whole activity feed is in the shot
      await page.waitForTimeout(300);
      await page.evaluate(() => document.getElementById('stream-scroll')?.scrollTo(0, 0));
      await shot('feed');
      await page.setViewportSize({ width: w, height: h });
      await page.waitForTimeout(300);
      if (!BEFORE) {
        const FEED = () => {
          const ask = document.querySelector('.ev.ask'), msg = document.querySelector('.ev.msg'), clampOf = el => { const b = el?.querySelector('.ev-body'), lh = parseFloat(getComputedStyle(b).lineHeight) || 0; return { h: b.clientHeight, lh, full: b.scrollHeight, open: b.classList.contains('open'), toggle: b.nextElementSibling?.classList.contains('more') && getComputedStyle(b.nextElementSibling).display !== 'none' ? b.nextElementSibling.textContent : '' }; };
          const chips = [...ask.querySelectorAll('.chip.ref-link')].map(c => ({ radius: parseFloat(getComputedStyle(c).borderTopLeftRadius), clipV: c.scrollHeight - c.clientHeight, clipH: c.scrollWidth - c.clientWidth, over: c.getBoundingClientRect().right - ask.getBoundingClientRect().right, text: c.textContent }));
          const anchors = [...document.querySelectorAll('.stream-scroll a[href]')].map(a => ({ href: a.getAttribute('href'), rel: a.getAttribute('rel'), target: a.getAttribute('target') }));
          return { ask: clampOf(ask), msg: clampOf(msg), chips, anchors, doc: [...ask.querySelectorAll('.ev-body button.inline-doc')].map(b => b.textContent), zumi: !!document.querySelector('.stream-scroll a[href*="__zumi-open"]') };
        };
        const f0 = await page.evaluate(FEED);
        ok(f0.ask.lh > 0 && f0.ask.h <= f0.ask.lh * 4 + 2 && f0.ask.full > f0.ask.h + 1 && f0.ask.toggle === EN['common.showMore'], `${w}: the long ask shows four lines with "${EN['common.showMore']}" (${JSON.stringify(f0.ask)})`);
        ok(f0.msg.h <= f0.msg.lh * 4 + 2 && f0.msg.full > f0.msg.h + 1 && f0.msg.toggle === EN['common.showMore'], `${w}: a long answer shows four lines with "${EN['common.showMore']}" (${JSON.stringify(f0.msg)})`);
        ok(f0.chips.length >= 3 && f0.chips.every(c => c.radius <= 8 && c.clipV <= 1 && c.clipH <= 1 && c.over <= 1), `${w}: the ref chips are rectangles (radius <= 8px) that clip nothing and stay inside the card (${JSON.stringify(f0.chips.map(c => [c.radius, c.clipV, c.clipH, Math.round(c.over)]))})`);
        ok(f0.anchors.length > 0 && f0.anchors.every(a => /^https?:\/\//.test(a.href) && /noopener/.test(a.rel || '') && a.target === '_blank'), `${w}: every link in the feed is http(s), noopener, new tab (${JSON.stringify(f0.anchors.map(a => a.href.slice(0, 40)))})`);
        ok(!f0.zumi, `${w}: no feed link opens a raw file in another app`);
        ok(f0.doc.length === 1 && f0.doc[0] === FEED_MD.split('/').pop(), `${w}: "Chi tiết:" shows the attached file as a reader button (${JSON.stringify(f0.doc)})`);
        await page.click('.ev.ask .ev-body + .more');
        await page.waitForTimeout(250);
        const f1 = await page.evaluate(FEED);
        ok(f1.ask.open && f1.ask.h >= f1.ask.full - 1 && f1.ask.toggle === EN['common.showLess'], `${w}: "${EN['common.showMore']}" opens the whole ask, the toggle reads "${EN['common.showLess']}" (${JSON.stringify(f1.ask)})`);
        await page.click('.ev.ask .ev-body button.inline-doc');
        await page.waitForTimeout(500);
        const fd = await page.evaluate(() => ({ text: document.querySelector('#reader .md')?.textContent || '', title: document.getElementById('reader-title')?.textContent || '' }));
        ok(fd.text.includes('SummaryMarker') && !fd.text.includes('DetailEndMarker'), `${w}: the "Chi tiết:" button opens the attached file in the reader on its summary (${fd.title})`);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(250);
        await page.click('.ev.ask .ev-body + .more');
        await page.waitForTimeout(250);
        const f2 = await page.evaluate(FEED);
        ok(!f2.ask.open && f2.ask.h <= f2.ask.lh * 4 + 2, `${w}: "${EN['common.showLess']}" folds the ask back to four lines`);
      }
      await page.goto(`${base}/#/task/BR-1`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(500);

      if (!BEFORE) {
        // 1. the right pane, no step open
        const a = await page.evaluate(PROBE);
        ok(a.ctxOverflow <= 0, `${w}: .ctx has no sideways overflow (${a.ctxOverflow})`);
        ok(a.pageOverflow <= 0, `${w}: page has no sideways overflow (${a.pageOverflow})`);
        ok(a.past.length === 0, `${w}: nothing in .ctx crosses its right edge (${a.past.join(', ')})`);
        ok(a.scrollers.every(s => !s.nested), `${w}: no nested scroller with the steps closed (${a.scrollers.filter(s => s.nested).map(s => s.sel).join(', ')})`);
        ok(a.titles.length > 0 && a.titles.every(t => t.whiteSpace === 'normal' && t.textOverflow !== 'ellipsis' && String(t.clamp) === '2'), `${w}: every step title wraps to two lines`);
        ok(a.titles.every(t => t.title && t.title === t.text), `${w}: every clamped step title keeps its full text in @title`);
      }

      if (!BEFORE) {
        // the floating state select must not cover the step title on hover
        await page.hover('#step-s1');
        await page.waitForTimeout(150);
        const hov = await page.evaluate(() => {
          const row = document.getElementById('step-s1'), edit = row?.querySelector('.srow-edit'), sl = row?.querySelector('.sl');
          if (!edit || !sl) return null;
          const a = sl.getBoundingClientRect(), b = edit.getBoundingClientRect();
          const intersect = a.right > b.left + 0.5 && a.left < b.right - 0.5 && a.bottom > b.top + 0.5 && a.top < b.bottom - 0.5;
          return { opacity: getComputedStyle(edit).opacity, intersect, slRight: Math.round(a.right), editLeft: Math.round(b.left), slLines: Math.round(a.height / parseFloat(getComputedStyle(sl).lineHeight)) };
        });
        ok(hov && hov.opacity === '1' && !hov.intersect, `${w}: on hover the state select does not cover the step title (${JSON.stringify(hov)})`);
      }

      // open the long step
      await page.click('.srow-main[data-step="BR-1/s1"]');
      await page.waitForTimeout(400);
      await shot('pane', true);
      if (!BEFORE) {
        const open = await page.evaluate(PROBE);
        ok(open.stepOpen, `${w}: the long step opened`);
        ok(open.ctxOverflow <= 0 && open.past.length === 0, `${w}: nothing crosses .ctx's right edge with the step open`);
        ok(open.scrollers.every(s => !s.nested), `${w}: no nested scroller with the step open (${open.scrollers.filter(s => s.nested).map(s => s.sel).join(', ')})`);
        const btn = page.locator('.sdetail .read-open[data-step="BR-1/s1"]');
        ok(await btn.count() === 1, `${w}: the long report shows a read button`);
        ok(/\d+/.test((await btn.first().innerText()) || ''), `${w}: the read button is labelled with a reading time`);
        const binfo = await btn.first().evaluate(el => ({ label: el.innerText, popup: el.getAttribute('aria-haspopup'), aria: el.getAttribute('aria-label'), muted: !!el.querySelector('.muted') }));
        ok(binfo.popup === 'dialog' && binfo.aria === null, `${w}: the read button is a haspopup dialog with no aria-label shadowing its text`);
        ok(binfo.label.includes(EN['step.readFull']) && binfo.muted && /\d+/.test(binfo.label), `${w}: the read button shows "${EN['step.readFull']}" plus a muted reading time`);
      }

      // the short step shows in full
      await page.click('.srow-main[data-step="BR-1/s2"]');
      await page.waitForTimeout(400);
      if (!BEFORE) {
        const short = await page.evaluate(() => {
          const row = document.getElementById('step-s2'), d = row?.nextElementSibling?.classList.contains('sdetail') ? row.nextElementSibling : null;
          const t = d?.querySelector('.md');
          return { has: !!t, clamped: !!t?.classList.contains('clamp'), text: t?.textContent || '', fits: t ? t.scrollHeight <= t.clientHeight + 1 : false, read: !!d?.querySelector('.read-open') };
        });
        ok(short.has && !short.clamped && !short.read && short.text.includes('ShortReportEnd.'), `${w}: the short report shows in full with no read button`);
        if (!short.fits) L(`note ${w}: the short report is not clipped (${short.fits})`);
      }
      await page.click('.srow-main[data-step="BR-1/s2"]'); // close it again
      await page.waitForTimeout(250);

      // 3. short centre lines stay full
      await page.goto(`${base}/#/task/BR-2`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(700);
      if (!BEFORE) {
        const short = await page.evaluate(() => { const d = document.querySelector('.situation .now-line'); return { text: d?.textContent || '', read: !!document.querySelector('.situation .now-open'), fits: d ? d.scrollHeight <= d.clientHeight + 1 : false, toggleHidden: getComputedStyle(d.nextElementSibling).display === 'none' }; });
        ok(short.text.includes('Reconciling the synthetic export.') && !short.read && short.fits && short.toggleHidden, `${w}: a short "Hiện tại" line shows in full with no read button and no Xem thêm toggle`);
      }

      // 4. the long "Hiện tại" line opens in the reader
      await page.goto(`${base}/#/task/BR-1`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(700);
      await shot('centre', true);
      if (!BEFORE) {
        const nowBtn = page.locator('.situation [data-action="read"][data-kind="now"]');
        ok(await nowBtn.count() === 1, `${w}: the long "Hiện tại" line shows a read button`);
        const ninfo = await nowBtn.first().evaluate(el => ({ popup: el.getAttribute('aria-haspopup'), aria: el.getAttribute('aria-label'), label: el.innerText }));
        ok(ninfo.popup === 'dialog' && ninfo.aria === null && ninfo.label.includes(EN['step.readFull']), `${w}: the "Hiện tại" read button shows the full-report label (${JSON.stringify(ninfo)})`);
        // the long "Hiện tại" is three lines with its own Xem thêm / Thu gọn; the read button stays
        const clampProbe = () => { const d = document.querySelector('.situation .now-line'), b = d?.nextElementSibling?.querySelector('.more'); const lh = parseFloat(getComputedStyle(d).lineHeight) || 0; return { h: d.clientHeight, lh, full: d.scrollHeight, open: d.classList.contains('open'), label: b?.textContent || '', shown: !!b && getComputedStyle(b.parentElement).display !== 'none', expanded: b?.getAttribute('aria-expanded') }; };
        const c0 = await page.evaluate(clampProbe);
        ok(c0.lh > 0 && c0.h <= c0.lh * 3 + 2 && c0.full > c0.h + 1 && c0.shown && c0.label === EN['common.showMore'] && c0.expanded === 'false', `${w}: the long "Hiện tại" clamps to 3 lines with "${EN['common.showMore']}" (${JSON.stringify(c0)})`);
        await page.click('.situation .now-more .more');
        await page.waitForTimeout(250);
        const c1 = await page.evaluate(clampProbe);
        ok(c1.open && c1.h >= c1.full - 1 && c1.label === EN['common.showLess'] && c1.expanded === 'true', `${w}: "${EN['common.showMore']}" opens the whole line and the toggle reads "${EN['common.showLess']}" (${JSON.stringify(c1)})`);
        await page.click('.situation .now-more .more');
        await page.waitForTimeout(250);
        const c2 = await page.evaluate(clampProbe);
        ok(!c2.open && c2.h <= c2.lh * 3 + 2, `${w}: "${EN['common.showLess']}" folds it back to 3 lines`);
        const askBtn = page.locator('.ev.ask [data-action="read"][data-kind="ask"]');
        ok(await askBtn.count() === 1, `${w}: a long ask in the stream shows a read button`);
        const refs = await page.evaluate(() => { const d = document.querySelector('.situation dl.kv dd.refs-row'); if (!d) return null; const cs = getComputedStyle(d); return { display: cs.display, clip: d.scrollHeight - d.clientHeight, chips: d.querySelectorAll('.ref-link').length }; });
        ok(refs && refs.display === 'block' && refs.clip <= 1 && refs.chips >= 1, `${w}: a refs row under a folded line keeps its links unclipped (${JSON.stringify(refs)})`);
        await nowBtn.click();
        await page.waitForTimeout(400);
        const r = await page.evaluate(READER_PROBE);
        ok(r.present && r.role === 'dialog' && r.modal === 'true', `${w}: the reader is a modal dialog`);
        ok(r.scrollers.filter(s => s.nested).length === 0 && r.scrollers.length <= 1, `${w}: the reader has no nested scroller (${r.scrollers.map(s => s.sel).join(', ')})`);
        ok(r.bodyScrolls || r.scrollers.length === 0, `${w}: the reader scrolls only in .reader-body`);
        const d0 = await page.evaluate(WIDTH_PROBE);
        ok(d0.width === 'w' && d0.pressed.join() === 'w', `${w}: a fresh device opens the reader at Rộng (${d0.width}, pressed ${d0.pressed})`);
        ok(Math.abs(d0.pLeft - d0.headLeft) <= 1 && d0.pLeft <= 40, `${w}: the text column is left-aligned, on the header's left edge (text ${Math.round(d0.pLeft)}px, header ${Math.round(d0.headLeft)}px, not centred)`);
        ok(r.tables.every(x => x <= 0) && r.tablesPast === 0, `${w}: no table is wider than its box in the reader`);
        ok(r.text.includes(LONG_NOW.slice(-40)), `${w}: the reader shows the whole "Hiện tại" line`);
        ok(r.reading, `${w}: the page is frozen while the reader is open`);
        ok(r.focusedBody, `${w}: the reader body takes the focus`);
        await shot('reader-now');
        await page.keyboard.press('Escape');
        await page.waitForTimeout(250);
        const f = await page.evaluate(focusInfo);
        ok(!(await page.locator('#reader').count()) && !(await page.evaluate(() => document.documentElement.classList.contains('reading'))), `${w}: Esc closes the reader`);
        ok(f.kind === 'now' && f.action === 'read', `${w}: the focus returns to the button that opened the reader (${f.kind}/${f.action})`);
        // the "Hiện tại" button keeps its identity across a repaint, so Esc returns the focus to it
        await page.click('.situation [data-action="read"][data-kind="now"]');
        await page.waitForTimeout(300);
        await page.evaluate(() => window.refresh());
        await page.waitForTimeout(600);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(250);
        const fr = await page.evaluate(focusInfo);
        ok(fr.kind === 'now' && fr.action === 'read', `${w}: after a repaint, Esc returns the focus to the "Hiện tại" read button (${fr.kind}/${fr.action})`);
      }

      // 5. the step reader: full text, one scroller, scroll kept across a refresh, reply scopes the composer
      if (!BEFORE) {
        if (!(await page.locator('.sdetail .read-open[data-step="BR-1/s1"]').count())) { await page.click('.srow-main[data-step="BR-1/s1"]'); await page.waitForTimeout(400); }
        await page.click('.sdetail .read-open[data-step="BR-1/s1"]');
        // the reader's images must load on render, not on the next poll (up to 15 s)
        let imgLoaded = false;
        try { await page.waitForFunction(() => { const im = document.querySelector('#reader .md-img[data-att]'); return !!im && im.complete && im.naturalWidth > 0; }, null, { timeout: 2000 }); imgLoaded = true; } catch { /* timed out */ }
        ok(await page.locator('#reader .md-img[data-att]').count() === 1, `${w}: the long report keeps its image`);
        ok(imgLoaded, `${w}: the reader's image loads within 2 s of opening`);
        await page.waitForTimeout(400);
        const r = await page.evaluate(READER_PROBE);
        ok(r.text.includes('FixtureEndMarker'), `${w}: the reader shows the end of the long report`);
        ok(r.scrollers.length === 1 && !r.scrollers[0]?.nested && r.bodyScrolls, `${w}: the step reader has exactly one scroller, .reader-body (${r.scrollers.map(s => s.sel).join(', ')})`);
        const hdr = await page.evaluate(() => {
          const cr = document.querySelector('#reader .crumbs'), rp = document.querySelector('#reader [data-action="reader-reply"]'), cl = document.querySelector('#reader [data-action="reader-close"]');
          return { crumb: cr?.textContent || '', replyCls: rp ? rp.className : '', close: cl?.textContent || '', keys: cl?.getAttribute('aria-keyshortcuts') || '', muted: cl?.querySelector('.muted')?.textContent || '' };
        });
        ok(hdr.crumb.includes('Board-read fixture: synthetic capacity report'), `${w}: the reader crumbs include the task title`);
        ok(/\bprimary\b/.test(hdr.replyCls), `${w}: the reply button is a primary button`);
        ok(hdr.close.includes(EN['common.close']) && hdr.muted === 'Esc' && !/\(Esc\)/.test(hdr.close), `${w}: Close reads "${EN['common.close']}" plus a muted Esc key`);
        ok(hdr.keys === 'Escape', `${w}: the Close button declares its Esc shortcut`);
        await shot('reader');
        // 5a. left-aligned column + the Vừa / Rộng / Đầy khung toggle
        const TARGET = { m: 74, w: 100 };
        const states = {};
        for (const v of ['m', 'w', 'f']) {
          await page.evaluate(() => { document.querySelector('#reader .reader-body').scrollTop = 700; });
          await page.click(`#reader [data-action="reader-width"][data-w="${v}"]`);
          await page.waitForTimeout(150);
          const q = states[v] = await page.evaluate(WIDTH_PROBE);
          ok(q.width === v && q.pressed.join() === v, `${w}: toggle ${v} sets the column and marks only that button pressed (${q.width}, ${q.pressed})`);
          ok(Math.abs(q.pLeft - q.headLeft) <= 1 && Math.abs(q.h2Left - q.headLeft) <= 1 && q.pLeft <= 40, `${w}: [${v}] text and headings start on the header's left edge, not centred (p ${Math.round(q.pLeft)}, h2 ${Math.round(q.h2Left)}, header ${Math.round(q.headLeft)})`);
          const want = v === 'f' ? q.pane - q.pad : Math.min(TARGET[v] * q.chDoc, q.pane - q.pad); // q.pad: 48px, or 32px in a narrow docked reader
          ok(Math.abs(q.pPx - want) <= 2, `${w}: [${v}] a line is ${Math.round(q.pPx)}px = ${(q.pPx / q.chDoc).toFixed(0)}ch (want ${Math.round(want)}px)`);
          const chs = q.pPx / q.chDoc; // ch of the document font: the unit the CSS column is written in
          if (v === 'm' && q.pane - q.pad >= TARGET.m * q.chDoc) ok(chs >= 70 && chs <= 78, `${w}: [m] line length ${chs.toFixed(0)}ch is in 70-78`);
          if (v === 'w' && q.pane - 48 >= 100 * q.chDoc) ok(chs >= 94 && chs <= 106, `${w}: [w] line length ${chs.toFixed(0)}ch is in 94-106`);
          if (v === 'f') ok(q.pPx >= q.pane - 50, `${w}: [f] the column fills the pane (${Math.round(q.pPx)} of ${q.pane - 48}px)`);
          { const hh = await page.evaluate(() => { const h = document.querySelector('#reader .reader-head'), t = h.querySelector('h1'); return { head: Math.round(h.getBoundingClientRect().height), lines: Math.round(t.getBoundingClientRect().height / parseFloat(getComputedStyle(t).lineHeight)) }; });
            ok(hh.lines <= 3 && hh.head <= 210, `${w}: [${v}] the reader header stays readable (title ${hh.lines} line(s), header ${hh.head}px)`); }
          if (q.b2) {
            // B2 (>= 900px): the reader is a docked pane and the presets fold panes (public/splitters.js). Medium keeps the docked
            // width (>= the 320px Detail minimum); Wide folds the Inspector, Full pane folds Tasks and Inspector, and the text
            // column then takes the room that leaves: at least min(the old 100ch column, the pane).
            if (v === 'm') ok(q.pane >= 320, `${w}: [m] B2: the docked reader is at least the 320px Detail minimum (${q.pane})`);
            if (v === 'w') ok(Math.abs(q.pane - (q.vw - q.rail - 36)) <= 20 && q.pPx >= Math.min(100 * q.chDoc, q.pane - q.pad) - 2, `${w}: [w] B2: Inspector folded (pane ${q.pane} = ${q.vw} - ${q.rail} - 36), the column is ${Math.round(q.pPx / q.chDoc)}ch, at least min(100ch, pane)`);
            if (v === 'f') ok(Math.abs(q.pane - (q.vw - 72)) <= 20 && q.pPx >= q.pane - q.pad - 2, `${w}: [f] B2: both side panes folded (pane ${q.pane} = ${q.vw} - 72), the column fills it (${Math.round(q.pPx)}px)`);
          }
          ok(q.imgRight <= q.pRight + 1 && q.imgLeft >= q.pLeft - 1, `${w}: [${v}] the image stays inside the column`);
          ok(q.past.length === 0 && q.hscroll <= 0 && q.tables.every(x => x <= 0), `${w}: [${v}] nothing is wider than the pane, no sideways scroll (${q.past.join(', ')} ${q.hscroll})`);
          ok(q.tableMaxPx <= q.pane - 48 + 1, `${w}: [${v}] tables fit the pane (${Math.round(q.tableMaxPx)}px)`);
          ok(Math.abs(q.scrollTop - 700) <= 2 && q.focus === v, `${w}: [${v}] switching keeps the scroll position and the focus on the button (${q.scrollTop}, focus ${q.focus})`);
          await shot('reader-' + v);
        }
        ok(states.m.pPx <= states.w.pPx + 1 && states.w.pPx <= states.f.pPx + 1 && (states.f.pPx > states.m.pPx || states.f.pane < 700), `${w}: the three states widen in order (${Math.round(states.m.pPx)} <= ${Math.round(states.w.pPx)} <= ${Math.round(states.f.pPx)})`);
        ok(states.m.labels.join('|') === [EN['reader.w.m'], EN['reader.w.w'], EN['reader.w.f']].join('|'), `${w}: the toggle reads ${states.m.labels.join(' / ')}`);
        await page.click('#reader [data-action="reader-width"][data-w="w"]'); // back to the default for the checks below
        await page.waitForTimeout(100);
        await page.evaluate(() => { const el = document.getElementById('reader'); el.dataset.probe = 'keep'; el.querySelector('.reader-body').scrollTop = 1500; });
        await page.evaluate(() => window.refresh());
        await page.waitForTimeout(600);
        const kept = await page.evaluate(READER_PROBE);
        ok(kept.present, `${w}: a poll refresh keeps the reader open`);
        ok(kept.probe === 'keep', `${w}: a poll refresh rebuilds the reader only when the text changed`);
        ok(Math.abs(kept.scrollTop - 1500) <= 2, `${w}: a poll refresh keeps the scroll position (${kept.scrollTop})`);
        await page.click('#reader [data-action="reader-reply"]');
        await page.waitForTimeout(500);
        const f = await page.evaluate(focusInfo);
        ok(!(await page.locator('#reader').count()), `${w}: "Trả lời bước này" closes the reader`);
        ok(f.scope === 'step:s1', `${w}: "Trả lời bước này" scopes the composer (${f.scope})`);
        ok(f.textarea, `${w}: "Trả lời bước này" puts the cursor in the composer`);
        // 5b. the width choice is remembered per device: pick Vừa, reload, reopen
        await page.click('.sdetail .read-open[data-step="BR-1/s1"]');
        await page.waitForTimeout(300);
        await page.click('#reader [data-action="reader-width"][data-w="m"]');
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(900);
        if (!(await page.locator('.sdetail .read-open[data-step="BR-1/s1"]').count())) { await page.click('.srow-main[data-step="BR-1/s1"]'); await page.waitForTimeout(400); }
        await page.click('.sdetail .read-open[data-step="BR-1/s1"]');
        await page.waitForTimeout(400);
        const kept2 = await page.evaluate(WIDTH_PROBE);
        ok(kept2.width === 'm' && kept2.pressed.join() === 'm', `${w}: the width choice survives a reload (${kept2.width})`);
        ok(await page.evaluate(() => { try { return localStorage.getItem('laneboard.readerWidth'); } catch { return 'x'; } }) === 'm', `${w}: it is stored in localStorage (laneboard.readerWidth)`);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(250);
        ok(!(await page.locator('#reader').count()), `${w}: Esc still closes the reader after a width change`);
        await page.evaluate(() => { try { localStorage.setItem('laneboard.readerWidth', 'bogus'); } catch { /* storage refused */ } });
        await page.click('.sdetail .read-open[data-step="BR-1/s1"]');
        await page.waitForTimeout(300);
        ok((await page.evaluate(WIDTH_PROBE)).width === 'w', `${w}: a corrupt stored value falls back to Rộng`);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(200);

        // 5b. a report with a Tóm tắt section opens on that section; "Xem toàn bộ" shows the rest
        await page.goto(`${base}/#/task/BR-3`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(700);
        if (!(await page.locator('.sdetail .read-open[data-step="BR-3/s1"]').count())) { await page.click('.srow-main[data-step="BR-3/s1"]'); await page.waitForTimeout(400); }
        await page.click('.sdetail .read-open[data-step="BR-3/s1"]');
        await page.waitForTimeout(400);
        const sum = await page.evaluate(() => { const r = document.getElementById('reader'); return { text: r?.querySelector('.md')?.textContent || '', btn: r?.querySelector('[data-action="reader-full"]')?.textContent || '', scrollers: 0 }; });
        ok(sum.text.includes('SummaryMarker') && !sum.text.includes('DetailEndMarker') && sum.btn === EN['reader.showAll'], `${w}: a report with a Tóm tắt section opens on the summary alone with a "${EN['reader.showAll']}" button`);
        await page.click('#reader [data-action="reader-full"]');
        await page.waitForTimeout(300);
        const all = await page.evaluate(() => { const r = document.getElementById('reader'); return { text: r?.querySelector('.md')?.textContent || '', btn: !!r?.querySelector('[data-action="reader-full"]'), open: !!r }; });
        ok(all.open && all.text.includes('SummaryMarker') && all.text.includes('DetailEndMarker') && !all.btn, `${w}: the button shows the whole report and goes away`);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(200);
        // 5b2. a local .md that was attached opens in the reader from its chip; one that was not keeps the copy-path chip
        await page.goto(`${base}/#/task/BR-3`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(700);
        const chips = await page.evaluate(() => ({ doc: [...document.querySelectorAll('.situation button.ref-link.doc')].map(b => b.textContent), copy: [...document.querySelectorAll('.situation .ref-link.local:not(.doc) .ref-path')].map(b => b.textContent) }));
        ok(chips.doc.length === 1 && chips.doc[0].includes('report') && chips.copy.length === 2 && chips.copy.some((c) => c.endsWith('report.md')) && chips.copy.some((c) => c.endsWith('none.md')), `${w}: an attached .md is a reader button with copy as the secondary chip (J-05 Part 2), an unattached one keeps its copy-path chip (${JSON.stringify(chips)})`);
        await page.click('.situation button.ref-link.doc');
        await page.waitForTimeout(500);
        const dd = await page.evaluate(() => { const r = document.getElementById('reader'); return { text: r?.querySelector('.md')?.textContent || '', title: document.getElementById('reader-title')?.textContent || '', sub: r?.querySelector('.reader-doc .sub')?.textContent || '', full: !!r?.querySelector('[data-action="reader-full"]') }; });
        ok(dd.text.includes('SummaryMarker') && !dd.text.includes('DetailEndMarker') && dd.full && dd.title === 'report' && dd.sub.includes('fixture/report.md'), `${w}: the .md chip opens the fetched file in the reader on its Tóm tắt (${dd.title} · ${dd.sub})`);
        await page.click('#reader [data-action="reader-full"]');
        await page.waitForTimeout(250);
        ok((await page.evaluate(() => document.querySelector('#reader .md')?.textContent || '')).includes('DetailEndMarker'), `${w}: "${EN['reader.showAll']}" shows the whole attached file`);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(200);
        // 5c. the reader takes a markdown string (the door for an attached .md), summary first, no throw on Esc with no opener row
        await page.evaluate(() => openDoc({ taskId: 'BR-3', title: 'attached.md', meta: ['file'], text: '# Doc\n\n## TL;DR\nDocSummaryMarker\n\n## Rest\nDocRestMarker' }));
        await page.waitForTimeout(300);
        const dsum = await page.evaluate(() => ({ text: document.querySelector('#reader .md')?.textContent || '', title: document.getElementById('reader-title')?.textContent || '' }));
        ok(dsum.title === 'attached.md' && dsum.text.includes('DocSummaryMarker') && !dsum.text.includes('DocRestMarker'), `${w}: a markdown-string source opens on its TL;DR`);
        await page.click('#reader [data-action="reader-full"]');
        await page.waitForTimeout(250);
        ok((await page.evaluate(() => document.querySelector('#reader .md')?.textContent || '')).includes('DocRestMarker'), `${w}: a markdown-string source expands to the whole file`);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(200);
        ok(!(await page.locator('#reader').count()), `${w}: Esc closes a markdown-string reader`);
      }

      const mine = errs.slice(errBase);
      for (const e of mine) fail(`${w}: ${e}`);
      L(`${w}: ${BEFORE ? 'before' : 'after'} shots saved · errors ${mine.length}`);
      await ctx.close();
    }

    // 6. a viewer (a reporter, who has no composer) gets no "Trả lời bước này"
    if (!BEFORE) {
      const ctx = await browser.newContext({ viewport: { width: 1204, height: 754 }, colorScheme: 'dark' });
      const page = await ctx.newPage();
      const errs = [];
      page.on('pageerror', e => errs.push('pageerror: ' + e.message));
      page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
      await page.addInitScript(tok => { try { localStorage.setItem('laneboard.token', tok); } catch { /* storage refused */ } }, viewerToken);
      await page.goto(`${base}/#/task/BR-1`, { waitUntil: 'networkidle' });
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForTimeout(900);
      const role = await page.evaluate(() => S.data?.me?.role || '');
      await page.click('.srow-main[data-step="BR-1/s1"]');
      await page.waitForTimeout(400);
      await page.click('.sdetail .read-open[data-step="BR-1/s1"]');
      await page.waitForTimeout(400);
      const v = await page.evaluate(() => ({ reader: !!document.getElementById('reader'), reply: !!document.querySelector('#reader [data-action="reader-reply"]'), close: !!document.querySelector('#reader [data-action="reader-close"]'), composer: !!document.getElementById('composer') }));
      await page.screenshot({ path: path.join(OUT, `${tag}-reader-viewer.png`) });
      ok(role === 'reporter', `viewer: the session is a reporter (${role})`);
      ok(v.reader && v.close, 'viewer: the reader opens with its Close button');
      ok(!v.reply && !v.composer, `viewer: "Trả lời bước này" and the composer are hidden (reply ${v.reply}, composer ${v.composer})`);
      for (const e of errs) fail(`viewer: ${e}`);
      await ctx.close();
    }
  } finally { await browser.close(); }
} catch (e) {
  fail('check run: ' + e.message);
} finally {
  if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  board?.close();
  fs.rmSync(scratch, { recursive: true, force: true });
  L(failures.length ? `BOARD-READ CHECK FAILED (${failures.length})` : 'BOARD-READ CHECK PASSED');
  fs.writeFileSync(path.join(OUT, `check-board-read-${tag}.log`), log.join('\n') + '\n');
  process.exitCode = failures.length ? 1 : 0;
}
