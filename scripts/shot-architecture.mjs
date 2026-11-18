#!/usr/bin/env node
// J-05 24-10: screenshots of the Diagram tab with and without a structure diagram (task.architecture), headless Chromium
// against a scratch board served with the REAL Content-Security-Policy (so inline styles or scripts would show up as console errors).
//   node scripts/shot-architecture.mjs --playwright <playwright-core dir> --chromium <binary> --out <dir> [--data <scratch data dir>] [--query "lang=vi"]
// Writes <out>/architecture-with-<w>.png and architecture-empty-<w>.png. Exit 1 on a page error, a console error (CSP included)
// or a missing section. Nothing listens beyond 127.0.0.1; the scratch data dir is deleted at the end.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2), arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PW = arg('--playwright'), EXE = arg('--chromium'), OUT = path.resolve(arg('--out', 'shots')), QUERY = arg('--query', 'lang=vi');
const DATA = path.resolve(arg('--data', path.join(OUT, '.scratch-data')));
if (!PW || !EXE) { console.error('usage: shot-architecture.mjs --playwright <dir> --chromium <binary> --out <dir>'); process.exit(2); }
const { createBoard } = await import(pathToFileURL(path.join(HERE, 'src', 'board.mjs')));
const { createServer } = await import(pathToFileURL(path.join(HERE, 'src', 'server.mjs')));
const { chromium } = createRequire(path.join(PW, 'package.json'))(PW);

const ARCH = {
  format: 'graph',
  groups: [{ id: 'flow', label: 'Luồng người dùng' }, { id: 'studio', label: 'Studio · chức năng' }, { id: 'mcp', label: 'MCP · tích hợp' }],
  nodes: [
    { id: 'brief', label: 'Nhập brief', sub: 'ý tưởng, link, ảnh', group: 'flow' },
    { id: 'script', label: 'Soạn kịch bản', sub: 'AI viết, anh sửa', group: 'studio' },
    { id: 'voice', label: 'Giọng đọc', sub: 'TTS, chọn giọng', group: 'studio' },
    { id: 'visual', label: 'Hình và cảnh', sub: 'ảnh, chuyển động', group: 'studio' },
    { id: 'render', label: 'Dựng video', sub: 'ghép, phụ đề', group: 'studio' },
    { id: 'review', label: 'Anh duyệt', group: 'flow' },
    { id: 'publish', label: 'Đăng lên kênh', group: 'flow' },
    { id: 'files', label: 'MCP · tệp', sub: 'đọc ghi thư mục dự án', group: 'mcp' },
    { id: 'browser', label: 'MCP · trình duyệt', sub: 'lấy tư liệu', group: 'mcp' }
  ],
  edges: [
    { from: 'brief', to: 'script' }, { from: 'script', to: 'voice' }, { from: 'script', to: 'visual' }, { from: 'voice', to: 'render' }, { from: 'visual', to: 'render' },
    { from: 'render', to: 'review', label: 'bản nháp' }, { from: 'review', to: 'publish', label: 'duyệt' }, { from: 'review', to: 'script', label: 'chưa đạt', dashed: true },
    { from: 'script', to: 'files', dashed: true }, { from: 'browser', to: 'brief', dashed: true }
  ]
};

const failures = [];
const fail = s => { failures.push(s); console.log('FAIL ' + s); };
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(DATA, { recursive: true });
let server, board;
try {
  const secret = crypto.randomBytes(32).toString('base64url');
  board = createBoard({ dataDir: DATA });
  server = createServer(board, { ownerProxySecret: secret });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const OWNER = { 'X-Laneboard-Owner-Proxy': secret, 'X-Requested-With': 'laneboard' };
  const api = async (headers, op, target_id, data) => {
    const r = await fetch(base + '/api/v1/write', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ version: 1, request_id: 'shot-' + crypto.randomBytes(6).toString('hex'), op, target_id, data }) });
    const body = await r.json(); if (!r.ok) throw new Error(`seed ${op} ${target_id}: ${r.status} ${JSON.stringify(body)}`); return body;
  };
  const tok = (await api(OWNER, 'token.issue', 'shot-coordinator', { role: 'coordinator', replace_coordinator: true, label: 'shot' })).token;
  const COORD = { Authorization: `Bearer ${tok}` };
  const steps = [{ id: 's1', label: 'Chốt phạm vi studio', zone: 'plan', state: 'done' }, { id: 's2', label: 'Dựng bản thử', zone: 'build', state: 'active' }, { id: 's3', label: 'Anh duyệt bản thử', zone: 'owner', state: 'waiting' }];
  await api(COORD, 'task.create', 'V-03', { title: 'Studio video', lane: 'Workerb', now: 'Đang dựng bản thử', steps, architecture: ARCH });
  await api(COORD, 'task.create', 'H-03', { title: 'Hunter quét việc', lane: 'Workerb', now: 'Quét thử', steps });

  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  try {
    for (const [w, h] of [[1440, 900], [390, 844], [1024, 800]]) { // 1440: the tab column is ~278 px; 390: phone; 1024: a narrow window
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, extraHTTPHeaders: { 'X-Laneboard-Owner-Proxy': secret }, colorScheme: 'dark' });
      const page = await ctx.newPage();
      const errs = [];
      page.on('pageerror', e => errs.push('pageerror: ' + e.message));
      page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
      for (const [name, code] of [['with', 'V-03'], ['empty', 'H-03']]) {
        const before = errs.length;
        await page.goto(`${base}/${QUERY ? '?' + QUERY : ''}#/task/${code}`, { waitUntil: 'networkidle' });
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(800);
        await page.locator('.tab[data-tab="diagram"]').click();
        await page.waitForTimeout(500);
        const text = await page.evaluate(() => document.querySelector('.tabpanel')?.innerText || '');
        const hasSvg = await page.locator('.arch-svg').count();
        const order = await page.evaluate(() => [...document.querySelectorAll('.tabpanel h3')].map(x => x.textContent.trim()));
        console.log(`${name} ${w}: headings ${JSON.stringify(order)} · arch svg ${hasSvg}`);
        if (order[0] !== 'Sơ đồ cấu trúc' || order[1] !== 'Các bước kế hoạch') fail(`${name} ${w}: headings are ${JSON.stringify(order)}`);
        if (name === 'with' && !hasSvg) fail(`with ${w}: no structure svg`);
        if (name === 'with' && hasSvg) { // the WHOLE graph is in view, at a readable scale (review S2)
          const m = await page.evaluate(() => {
            const sc = document.querySelector('.arch-scroll'), svg = sc.querySelector('.arch-svg'), r = sc.getBoundingClientRect(), nodes = [...svg.querySelectorAll('.abox')];
            const out = nodes.filter(b => { const q = b.getBoundingClientRect(); return q.left < r.left - 1 || q.right > r.right + 1; }).length;
            const fs = sel => parseFloat(getComputedStyle(svg.querySelector(sel)).fontSize) * (svg.getBoundingClientRect().width / Number(svg.dataset.w));
            return { nodes: nodes.length, outside: out, col: Math.round(r.width), svgW: Math.round(svg.getBoundingClientRect().width), natural: Number(svg.dataset.w), scroll: sc.scrollWidth - sc.clientWidth, title: fs('.anode-t'), sub: svg.querySelector('.anode-s') ? fs('.anode-s') : 99 };
          });
          console.log(`with ${w}: column ${m.col}px, svg ${m.svgW}/${m.natural}px, ${m.nodes} nodes, ${m.outside} outside the column, sideways scroll ${m.scroll}px, scaled text title ${m.title.toFixed(1)}px sub ${m.sub.toFixed(1)}px`);
          // what the first check cannot see (delta review F1-F3): an edge under a box, a label on a box, a title on its sub-label
          const g = await page.evaluate(() => {
            const svg = document.querySelector('.arch-scroll .arch-svg'), R = el => el.getBBox(), bad = [];
            const boxes = [...svg.querySelectorAll('.anode')].map(n => ({ id: n.dataset.id, ...(r => ({ x: r.x, y: r.y, w: r.width, h: r.height }))(R(n.querySelector('.abox'))), n }));
            const hit = (x1, y1, x2, y2, b) => Math.max(Math.min(x1, x2), b.x + .5) <= Math.min(Math.max(x1, x2), b.x + b.w - .5) && Math.max(Math.min(y1, y2), b.y + .5) <= Math.min(Math.max(y1, y2), b.y + b.h - .5);
            for (const p of svg.querySelectorAll('.aedge')) {
              const nums = (p.getAttribute('d').match(/-?\d+(\.\d+)?/g) || []).map(Number), pts = []; for (let i = 0; i < nums.length; i += 2) pts.push([nums[i], nums[i + 1]]);
              for (let i = 1; i < pts.length; i++) for (const b of boxes) if (hit(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], b) && !(pts[i - 1][0] === pts[i][0] && (pts[i][0] <= b.x + .5 || pts[i][0] >= b.x + b.w - .5)) && !(pts[i - 1][1] === pts[i][1] && (pts[i][1] <= b.y + .5 || pts[i][1] >= b.y + b.h - .5))) bad.push(`edge ${p.dataset.from}->${p.dataset.to} under box ${b.id}`);
            }
            for (const t of svg.querySelectorAll('.aedge-t')) { const q = R(t); for (const b of boxes) if (q.x < b.x + b.w && b.x < q.x + q.width && q.y + 2 < b.y + b.h && b.y < q.y + q.height - 2) bad.push(`label "${t.textContent}" on box ${b.id}`); }
            for (const b of boxes) { const ts = [...b.n.querySelectorAll('.anode-t')], sub = b.n.querySelector('.anode-s'); if (ts.length && sub) { const a = R(ts[ts.length - 1]), c = R(sub); if (a.y + a.height - 4 > c.y + 2) bad.push(`title overlaps sub-label in ${b.id}`); } }
            return bad;
          });
          for (const e of g) fail(`with ${w}: ${e}`);
          console.log(`with ${w}: edges/labels/text overlap check: ${g.length} problem(s)`);
          if (m.nodes !== 9) fail(`with ${w}: ${m.nodes} nodes drawn, expected 9`);
          if (m.outside) fail(`with ${w}: ${m.outside} node(s) outside the column: the preview does not fit`);
          if (m.scroll > 1) fail(`with ${w}: the preview still scrolls sideways by ${m.scroll}px`);
          if (m.title < 8.5 || m.sub < 7) fail(`with ${w}: scaled text too small (title ${m.title.toFixed(1)}px, sub ${m.sub.toFixed(1)}px)`);
        }
        if (name === 'with' && !text.includes('Soạn')) fail(`with ${w}: node text missing`);
        if (name === 'empty' && (hasSvg || !text.includes('Chưa có sơ đồ cấu trúc'))) fail(`empty ${w}: empty state not shown`);
        await page.locator(".tabpanel").first().screenshot({ path: path.join(OUT, `architecture-${name}-${w}.png`) }); await page.screenshot({ path: path.join(OUT, `architecture-page-${name}-${w}.png`) });
        if (name === 'with') { // the full-window view of the same diagram (the tab's column is narrow)
          await page.locator('.arch-sec .diag-full-btn').click();
          await page.waitForTimeout(600);
          if (!(await page.locator('#diagram-full .arch-svg').count())) fail(`with ${w}: the full view has no structure svg`);
          await page.screenshot({ path: path.join(OUT, `architecture-full-${w}.png`) });
          await page.keyboard.press('Escape');
        }
        for (const e of errs.slice(before)) fail(`${name} ${w}: ${e}`);
      }
      await ctx.close();
    }
  } finally { await browser.close(); }
} catch (e) { fail('run: ' + e.message); } finally {
  if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  board?.close();
  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(failures.length ? `SHOTS FAILED (${failures.length})` : 'SHOTS PASSED');
  process.exitCode = failures.length ? 1 : 0;
}
