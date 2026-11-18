#!/usr/bin/env node
// J-05 step-list overlap check (owner askback 12103, 31-10): in the Steps list, a long step label wrapped to 2 lines and
// overlapped the next row. Seeds a SYNTHETIC task (the L-01-3D labels from the owner's screenshot plus short controls)
// through the real write API and measures, per row, that the row box contains its label box and that no row starts above
// the previous row's bottom.
//
//   node scripts/check-step-overlap.mjs --playwright <playwright-core dir> --chromium <binary> [--code <dir>] [--out <dir>]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2), arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CODE = path.resolve(arg('--code', HERE)), OUT = path.resolve(arg('--out', path.join(os.tmpdir(), 'laneboard-step-overlap')));
const PW = arg('--playwright'), EXE = arg('--chromium');
if (!PW || !EXE) { console.error('usage: check-step-overlap.mjs --playwright <dir> --chromium <binary> [--code <dir>] [--out <dir>]'); process.exit(2); }
const log = [], failures = [];
const L = s => { log.push(s); console.log(s); };
const fail = s => { failures.push(s); L('FAIL ' + s); };
const ok = (cond, msg) => { if (cond) L('ok ' + msg); else fail(msg); };

const { createBoard } = await import(pathToFileURL(path.join(CODE, 'src', 'board.mjs')));
const { createServer } = await import(pathToFileURL(path.join(CODE, 'src', 'server.mjs')));
const { chromium } = createRequire(path.join(PW, 'package.json'))(PW);

// [label, state, has report]. Long labels are the ones from the screenshot; the short ones are the negative control.
const STEPS = [
  ['Chọn engine', 'done', false],
  ['Kiểm 3D đời thơ (thiếu, đóng, chiều cao)', 'done', true],
  ['Chạy dựng 3D thời kỳ đầu trên Colab', 'done', true],
  ['Gói kết quả Colab kèm log bước cải', 'done', true],
  ['Notebook chép đủ ảnh vào bộ cải', 'done', true],
  ['Sửa lỗi build game (thiếu mã phỏng GP-1c)', 'done', true],
  ['Bộ kiểm 3D cho thời kỳ', 'done', true],
  ['Gói Colab chỉ gắn xương (4 mẫu thiếu + đo độ lệch)', 'done', true],
  ['Anh xem nhân vật thời 2026', 'done', true],
  ['Đặt nhân vật 2026 vào đúng cảnh thời trần 2026 + clip cho anh', 'done', true],
  ['Xoá khỏi cửa thừa + thử chuyển động trong cảnh 2026 + clip cho anh', 'done', false],
  ['Nghiên cứu repo claude-code-game-studios (anh gửi)', 'done', false],
  ['Anh xem clip chuyển động 8 giây trong thị trấn 2026', 'active', false],
  ['Anh xem 5 map theo năm (thêm 1916 và 2026)', 'todo', false],
  ['Short todo', 'todo', false],
];
const fs0 = fs.mkdtempSync(path.join(os.tmpdir(), 'laneboard-step-overlap-data-'));
let server, board;
try {
  fs.mkdirSync(OUT, { recursive: true });
  const proxySecret = crypto.randomBytes(32).toString('base64url');
  board = createBoard({ dataDir: fs0 });
  server = createServer(board, { ownerProxySecret: proxySecret });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const OWNER = { 'X-Laneboard-Owner-Proxy': proxySecret, 'X-Requested-With': 'laneboard' };
  const api = async (headers, op, target_id, data, extra = {}) => {
    const r = await fetch(base + '/api/v1/write', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ version: 1, request_id: 'so-' + crypto.randomBytes(6).toString('hex'), op, target_id, data, ...extra }) });
    const body = await r.json();
    if (!r.ok) throw new Error(`seed ${op} ${target_id}: ${r.status} ${JSON.stringify(body)}`);
    return body;
  };
  const tok = (await api(OWNER, 'token.issue', 'so-coordinator-' + crypto.randomBytes(3).toString('hex'), { role: 'coordinator', replace_coordinator: true, label: 'step-overlap check' })).token;
  const COORD = { Authorization: `Bearer ${tok}` };
  await api(COORD, 'task.create', 'SO-1', { title: 'Step overlap fixture', lane: 'fixture', now: 'Synthetic.', steps: STEPS.map(([label], i) => ({ id: 's' + (i + 1), label, zone: 'build', state: 'todo' })) });
  const st = async () => (await (await fetch(base + '/api/v1/state?v=2', { headers: OWNER })).json()).tasks.find(t => t.id === 'SO-1').steps;
  for (const [i, [, state, report]] of STEPS.entries()) {
    if (state === 'todo' && !report) continue;
    const cur = (await st()).find(s => s.id === 'SO-1/s' + (i + 1));
    const data = { state }; if (report) data.detail = '## Report\n\nSynthetic report text.';
    await api(COORD, 'step.update', cur.id, data, { expected_revision: cur.rev });
  }
  L(`seeded SO-1 with ${STEPS.length} steps · ${base}`);

  const MEASURE = () => {
    const rows = [...document.querySelectorAll('.slist .srow')];
    return rows.map((r, i) => {
      const rb = r.getBoundingClientRect(), main = r.querySelector('.srow-main').getBoundingClientRect(), sl = r.querySelector('.sl'), sb = sl.getBoundingClientRect();
      const prev = i ? rows[i - 1].getBoundingClientRect() : null;
      const lines = Math.round(sb.height / parseFloat(getComputedStyle(sl).lineHeight));
      return { n: i + 1, text: sl.textContent, h: Math.round(rb.height), lines, labelInsideRow: sb.top >= rb.top - 0.5 && sb.bottom <= rb.bottom + 0.5, overlapsPrev: prev ? rb.top < prev.bottom - 0.5 : false,
        scrollClipped: sl.scrollHeight > sl.clientHeight + 1, chipInside: [...r.querySelectorAll('.srep,.sr')].every(c => { const cb = c.getBoundingClientRect(); return !cb.width || (cb.bottom <= rb.bottom + 0.5 && cb.top >= rb.top - 0.5); }), mainBottomEqRow: Math.abs(main.bottom - rb.bottom) < 1.5 };
    });
  };
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  try {
    // 331 px pane = the owner's screenshot; 1204 and 1844 are the board's usual desktop widths; 390 is a phone.
    for (const [name, w, h, paneW] of [['pane331', 1204, 900, 331], ['desktop1204', 1204, 900, 0], ['desktop1844', 1844, 971, 0], ['phone390', 390, 844, 0]]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, extraHTTPHeaders: { 'X-Laneboard-Owner-Proxy': proxySecret }, colorScheme: 'dark' });
      const page = await ctx.newPage();
      const errs = [];
      page.on('pageerror', e => errs.push('pageerror: ' + e.message));
      page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
      await page.goto(`${base}/#/task/SO-1`, { waitUntil: 'networkidle' });
      await page.waitForSelector('.srow-main', { timeout: 20000 });
      if (await page.$('.more[data-action="steps-all"][aria-expanded="false"]')) await page.click('.more[data-action="steps-all"]');
      if (paneW) await page.evaluate(w => { const c = document.querySelector('.ctx'); for (const [k, v] of [['width', w + 'px'], ['max-width', w + 'px'], ['flex', 'none']]) c.style.setProperty(k, v, 'important'); }, paneW); // CSSOM, the page CSP forbids a <style>
      await page.waitForTimeout(500);
      const m = await page.evaluate(MEASURE);
      const pw = await page.evaluate(() => Math.round(document.querySelector('.slist').getBoundingClientRect().width));
      L(`${name}: list width ${pw}px, ${m.length} rows, row heights ${m.map(x => x.h).join(',')}`);
      const bad = m.filter(x => !x.labelInsideRow || x.overlapsPrev || !x.chipInside);
      ok(bad.length === 0, `${name}: every label sits inside its row, no row starts above the previous row's bottom${bad.length ? ' — ' + JSON.stringify(bad.map(b => [b.n, b.text.slice(0, 24), b.h, b.lines])) : ''}`);
      const short = m.find(x => x.text === 'Short todo');
      ok(short && short.lines === 1, `${name}: negative control, a short label is one line (${short && short.lines} line, row ${short && short.h}px)`);
      ok(errs.length === 0, `${name}: no page errors (${errs.join(' | ')})`);
      const el = await page.$('.slist');
      await el.screenshot({ path: path.join(OUT, `steps-${name}.png`) });
      await ctx.close();
    }
  } finally { await browser.close(); }
} catch (e) {
  fail('check crashed: ' + (e.stack || e.message));
} finally {
  if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  board?.close();
  fs.rmSync(fs0, { recursive: true, force: true });
  L(failures.length ? `STEP-OVERLAP CHECK FAILED (${failures.length})` : 'STEP-OVERLAP CHECK PASSED');
  fs.writeFileSync(path.join(OUT, 'check-step-overlap.log'), log.join('\n') + '\n');
  process.exitCode = failures.length ? 1 : 0;
}
