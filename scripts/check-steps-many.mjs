#!/usr/bin/env node
// J-05 steps-overlap check, round 2 (owner 02-11, ACME-02: 36 steps, ~340 px right column, 2-line labels ran into the next row).
// Seeds a SYNTHETIC task whose step labels are ACME-02's real ones (up to 137 chars, Vietnamese) and measures, in the real UI, for every
// row of the Steps list (and the opened step's detail): no box starts above the previous box's bottom, every part of a row (icon,
// number, label, report chip, state) sits inside the row, parts of a row never share pixels, and a label is never clipped unless it
// has a title AND opening the row shows it whole.
//
//   node scripts/check-steps-many.mjs --playwright <dir> --engine chromium|firefox|webkit [--exe <binary>] [--steps 36,50] [--steps-json <file>] [--break-grid] [--shots] [--out <dir>]
//   --steps-json: seed the 36 steps of a real task instead (array of {label,sub,state,zone,detail}); --break-grid: re-create the old defect (.slist as a grid)
//   to prove the detector bites. A task holds at most 50 steps (STEP_CAP), so 50 is the largest list the board can show.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2), arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(arg('--out', path.join(os.tmpdir(), 'laneboard-steps-many'))), PW = arg('--playwright'), ENGINE = arg('--engine', 'chromium'), EXE = arg('--exe');
const STEPS_JSON = arg('--steps-json'), BREAK = args.includes('--break-grid');
const COUNTS = STEPS_JSON ? [JSON.parse(fs.readFileSync(STEPS_JSON, 'utf8')).length] : arg('--steps', '36,50').split(',').map(Number), SHOTS = args.includes('--shots');
if (!PW) { console.error('usage: check-steps-many.mjs --playwright <dir> [--engine chromium|firefox|webkit] [--exe <binary>] [--steps 36,50] [--steps-json <file>] [--break-grid] [--shots] [--out <dir>]'); process.exit(2); }
const log = [], failures = [];
const L = s => { log.push(s); console.log(s); };
const fail = s => { failures.push(s); L('FAIL ' + s); };
const ok = (cond, msg) => { if (cond) L('ok ' + msg); else fail(msg); };

const { createBoard } = await import(pathToFileURL(path.join(HERE, 'src', 'board.mjs')));
const { createServer } = await import(pathToFileURL(path.join(HERE, 'src', 'server.mjs')));
const pw = createRequire(path.join(PW, 'package.json'))(PW);

// ACME-02's real labels and states (read from the live board 02-11). [label, state, zone, has report]
const REAL = [
  ['Lịch sử (gộp)', 'done', 'build', true], ['06-10 Phòng B r4 — sửa theo feedback anh: avatar nhỏ so với ghế + chi tiết lòi khỏi ghế', 'todo', 'owner', true],
  ['06-10 Phòng 3D từ ảnh — bản thử Blender: KHÔNG ĐẠT, chờ anh chọn Marble', 'todo', 'owner', true], ['Vòng QC tiếp của anh: nhân vật Zumi và phòng', 'todo', 'owner', false],
  ['Làm giao diện mới: phòng video + đổi phòng bằng link, giữ 1 góc cam, chế độ lơ lửng, HUD, hiện đồng hồ đếm giờ và thanh trạng thái của từng phòng trong cùng một màn hình', 'todo', 'build', false],
  ['QC năng lực lõi', 'todo', 'build', true], ['Chạy thật trên bảng', 'todo', 'build', true], ['QC trí nhớ', 'todo', 'build', true],
  ['Áp ghế anh chọn cho phòng hiện tại + 7 phòng video', 'todo', 'build', false], ['Lỗi phòng bị cắt trong app (vẫn còn ở 0.2.1) — ưu tiên P1 cho bản sau', 'active', 'build', false],
  ['Độ nét phòng video', 'todo', 'build', false], ['Đo Whisper trên máy phụ (tiếng Việt/Anh, độ trễ, RAM)', 'todo', 'build', false],
  ['Bộ phòng mới 2K: làm mẫu (Qwen + H3)', 'active', 'build', false], ['Sửa giao diện Bảng trong app Zumi cho dễ đọc (anh 18-10)', 'active', 'build', true],
  ['Rà giấy phép mọi tài nguyên trong app (ghế, phòng, âm thanh, font)', 'active', 'build', false],
  ['Lát 2: trang Kỹ năng (cây 8 nút, danh mục, bảng tính derive, kho tiến độ zumi.progress), hiển thị tiến độ từng nút theo thời gian thực cho người dùng', 'active', 'build', false],
  ['Lane 1 trước khi mở mã nguồn: hỏi-mở-file, bộ đếm token theo task, QC sơ đồ, kéo thả bị trượt', 'active', 'build', false],
  ['Tách bản công khai kiểu open-core: bỏ model, phòng, giọng khỏi bản công khai; thêm giấy phép và hướng dẫn cài đặt cho người đóng góp bên ngoài', 'todo', 'build', false],
  ['Anh dán khoá AI để chat chạy', 'done', 'owner', false], ['Anh chốt 4 câu đăng nhập giọng + chat', 'done', 'owner', false], ['Fable soát hình alpha.12', 'done', 'build', false],
  ['Anh chốt email admin cho giọng trên web', 'done', 'owner', false], ['Tra cách làm phòng đẹp theo clip anh gửi, có nặng không', 'done', 'build', false],
  ['Anh chốt 3 câu giọng tự nhập khoá', 'done', 'owner', false], ['alpha.14: Marketplace, giọng, sửa lỗi app không thoát', 'active', 'build', false],
  ['Mở nguồn: kiểm đường cập nhật, so với Orca', 'done', 'build', false], ['Mở nguồn: làm bộ cập nhật giống Orca, qua GitHub Releases', 'active', 'build', false],
  ['Mở nguồn: test cài và hướng dẫn trên hồ sơ trống', 'todo', 'build', false], ['Mở nguồn: quét khoá, dữ liệu riêng, giấy phép', 'active', 'build', false],
  ['Mở nguồn: chuẩn bị video ra mắt', 'todo', 'build', false], ['Anh duyệt lần cuối trước khi công khai', 'todo', 'owner', false],
  ['Đóng hở giọng + chat trên máy chủ, chỉ anh dùng', 'done', 'build', false], ['Anh ok cài alpha.12', 'done', 'owner', false],
  ['GÌ: làm phòng đẹp như ảnh anh gửi, tài liệu D:/data/laneboard/acme-02/OPTIONS.md và bản so sánh ba hướng dựng phòng cho anh chọn', 'done', 'build', true],
  ['GÌ: chốt điều kiện mở mã nguồn Zumi. ĐỀ XUẤT: không theo ngày, đủ 5 điều kiện là mở: (1) không còn khoá trong mã (2) giấy phép từng tài nguyên rõ', 'done', 'build', true],
  ['GÌ: làm bộ cập nhật cho Zumi giống Orca, báo cáo D:/data/laneboard/acme-02/REPORT.md khi xong, anh duyệt bản chạy thử', 'waiting', 'owner', true],
];
// beyond the real 36: long Vietnamese, one unbreakable token, one short label
const EXTRA = ['Kiểm tra toàn bộ đường dẫn tệp không có khoảng trắng và không có ký tự đặc biệt trong thư mục dữ liệu của người dùng Việt Nam', 'Một nhãn rất dài không có khoảng trắng nào cả_' + 'x'.repeat(90), 'Ngắn', 'Anh xem lại bản dựng phòng thứ ba, đặc biệt là phần ghế và ánh sáng buổi tối'];
const REALJSON = STEPS_JSON && JSON.parse(fs.readFileSync(STEPS_JSON, 'utf8'));
const stepsFor = n => REALJSON ? REALJSON.map(x => [x.label, x.state === 'done' || x.state === 'active' || x.state === 'waiting' || x.state === 'blocked' ? x.state : 'todo', x.zone === 'anh' ? 'owner' : (x.zone || 'build'), !!x.detail, x.sub, x.detail]) : Array.from({ length: n }, (_, i) => i < REAL.length ? REAL[i] : [`${EXTRA[i % EXTRA.length]} (${i + 1})`, ['todo', 'active', 'todo'][i % 3], 'build', i % 4 === 0]);

const MEASURE = () => {
  const list = document.querySelector('.slist'), r = e => e.getBoundingClientRect(), problems = [];
  const boxes = [...list.children].filter(e => r(e).height > 0 && !e.matches('.steps-head')); // the count line is sticky on purpose: it rides over scrolled rows // the count line, rows, opened details, violations: in flow order
  boxes.forEach((b, i) => { const p = i ? boxes[i - 1] : null; if (p && r(b).top < r(p).bottom - 0.5) problems.push({ kind: 'overlap', at: i, cls: b.className, prevCls: p.className, by: Math.round((r(p).bottom - r(b).top) * 10) / 10 }); });
  const rows = [...list.querySelectorAll('.srow')], info = rows.map((row, i) => {
    const rb = r(row), sl = row.querySelector('.sl'), sb = r(sl), open = row.classList.contains('open'), lh = parseFloat(getComputedStyle(sl).lineHeight) || 19;
    const parts = [...row.querySelectorAll('.si,.sn,.sl,.srep,.sr,.srow-edit')].filter(e => r(e).width > 1.5 && (!e.matches('.srow-edit') || parseFloat(getComputedStyle(e).opacity) > 0.01)).map(e => [e.className, r(e)]); // .sr is the global screen-reader-only class (1px, clipped): not a visible part
    const outside = parts.filter(([, b]) => b.top < rb.top - 0.5 || b.bottom > rb.bottom + 0.5).map(([c]) => c);
    const hits = []; // two parts of one row must not share pixels: label vs report chip vs state
    for (let a = 0; a < parts.length; a++) for (let b = a + 1; b < parts.length; b++) { const A = parts[a][1], B = parts[b][1]; if (A.left < B.right - 0.5 && B.left < A.right - 0.5 && A.top < B.bottom - 0.5 && B.top < A.bottom - 0.5) hits.push(parts[a][0] + 'x' + parts[b][0]); }
    const clipped = sl.scrollHeight > sl.clientHeight + 1 || sl.scrollWidth > sl.clientWidth + 1;
    return { n: i + 1, id: row.id, text: sl.textContent, h: Math.round(rb.height), lines: Math.round(sb.height / lh), open, outside, hits, clipped, title: !!row.querySelector('.srow-main').title };
  });
  info.forEach(x => { if (x.outside.length) problems.push({ kind: 'part-outside-row', n: x.n, parts: x.outside, h: x.h }); if (x.hits.length) problems.push({ kind: 'parts-collide', n: x.n, hits: x.hits }); });
  const cs = getComputedStyle(list);
  return { problems, info, list: { w: Math.round(r(list).width), h: Math.round(r(list).height), display: cs.display, maxH: cs.maxHeight, sH: list.scrollHeight, cH: list.clientHeight } };
};

let server, board;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'laneboard-steps-many-'));
try {
  fs.mkdirSync(OUT, { recursive: true });
  const secret = crypto.randomBytes(32).toString('base64url');
  board = createBoard({ dataDir: tmp }); server = createServer(board, { ownerProxySecret: secret });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`, OWNER = { 'X-Laneboard-Owner-Proxy': secret, 'X-Requested-With': 'laneboard' };
  const api = async (headers, op, target_id, data, extra = {}) => {
    const r = await fetch(base + '/api/v1/write', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ version: 1, request_id: 'sm-' + crypto.randomBytes(6).toString('hex'), op, target_id, data, ...extra }) });
    const body = await r.json(); if (!r.ok) throw new Error(`seed ${op} ${target_id}: ${r.status} ${JSON.stringify(body)}`); return body;
  };
  const tok = (await api(OWNER, 'token.issue', 'sm-coord-' + crypto.randomBytes(3).toString('hex'), { role: 'coordinator', replace_coordinator: true, label: 'steps-many check' })).token, COORD = { Authorization: `Bearer ${tok}` };
  const DETAIL = '## Report\n\n' + Array.from({ length: 6 }, (_, i) => `Synthetic paragraph ${i + 1}: Anh xem bản dựng, so sánh ba hướng, chọn một hướng rồi báo lại cho em để em làm tiếp phần còn lại của bước này.`).join('\n\n');
  const browser = await pw[ENGINE].launch(EXE ? { executablePath: EXE, headless: true } : { headless: true });
  try {
    for (const N of COUNTS) {
      const code = 'SM-' + N, steps = stepsFor(N);
      const mk = ([label, , zone, , sub], i) => ({ id: 's' + (i + 1), label, zone, state: 'todo', ...(sub ? { sub } : {}) });
      await api(COORD, 'task.create', code, { title: `Steps ${N}`, lane: 'fixture', now: 'Synthetic.', steps: steps.slice(0, 50).map(mk) }); // task.create takes at most 50
      for (const [i, step] of steps.entries()) if (i >= 50) { const { id, ...d } = mk(step, i); await api(COORD, 'step.create', `${code}/${id}`, d); }
      const st = async () => (await (await fetch(base + '/api/v1/state?v=2', { headers: OWNER })).json()).tasks.find(t => t.id === code).steps;
      for (const [i, [, state, , report, , detail]] of steps.entries()) {
        if (state === 'todo' && !report) continue;
        const cur = (await st()).find(s => s.id === `${code}/s${i + 1}`), data = { state }; if (report) data.detail = detail || DETAIL;
        await api(COORD, 'step.update', cur.id, data, { expected_revision: cur.rev });
      }
      L(`seeded ${code} with ${N} steps (${ENGINE})`);
      for (const [name, vw, vh, paneW] of [['desktop1204', 1204, 900, 0], ['desktop1500', 1500, 900, 0], ['desktop1844', 1844, 971, 0], ['tablet820', 820, 1000, 0], ['phone390', 390, 844, 0]]) {
        const tag = `${ENGINE} ${N} steps ${name}`;
        const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, extraHTTPHeaders: { 'X-Laneboard-Owner-Proxy': secret }, colorScheme: 'dark' });
        const page = await ctx.newPage(), errs = [];
        page.on('pageerror', e => errs.push('pageerror: ' + e.message));
        await page.goto(`${base}/#/task/${code}`, { waitUntil: 'networkidle' });
        await page.waitForSelector('.srow-main', { timeout: 20000 });
        await page.evaluate(`window.MEASURE_ = ${MEASURE.toString()}`);
        if (paneW) await page.evaluate(w => { const c = document.querySelector('.ctx'); for (const [k, v] of [['width', w + 'px'], ['max-width', w + 'px'], ['flex', 'none']]) c.style.setProperty(k, v, 'important'); }, paneW);
        if (BREAK) await page.evaluate(() => { const sh = [...document.styleSheets].find(x => /styles\.css/.test(x.href || '')); sh.insertRule('.slist { display: grid !important; }', sh.cssRules.length); });
        const folded = await page.evaluate(MEASURE);
        if (await page.$('.more[data-action="steps-all"][aria-expanded="false"]')) await page.click('.more[data-action="steps-all"]');
        await page.waitForTimeout(300);
        const all = await page.evaluate(MEASURE);
        L(`${tag}: list ${all.list.w}px, ${all.info.length} rows (${folded.info.length} folded), display ${all.list.display}, max-height ${all.list.maxH}, row heights ${[...new Set(all.info.map(x => x.h))].join('/')}`);
        const probs = [...folded.problems, ...all.problems];
        ok(probs.length === 0, `${tag}: no box overlaps the previous one, every part sits inside its row, no parts collide${probs.length ? ' — ' + JSON.stringify(probs.slice(0, 5)) + ` (+${probs.length} total)` : ''}`);
        const clipped = all.info.filter(x => x.clipped);
        ok(clipped.every(x => x.title), `${tag}: every clipped label has a title tooltip (${clipped.length} clipped)`);
        // the visible way to read a clamped label: open the row and the whole label shows
        const target = clipped[0] || all.info[1];
        await page.click(`#${target.id} .srow-main`); await page.waitForTimeout(300);
        const opened = await page.evaluate(id => { const row = document.getElementById(id), sl = row.querySelector('.sl'); return { clipped: sl.scrollHeight > sl.clientHeight + 1 || sl.scrollWidth > sl.clientWidth + 1, open: row.classList.contains('open'), detail: !!row.nextElementSibling?.matches?.('.sdetail') }; }, target.id);
        ok(opened.open && opened.detail, `${tag}: click opens the row and its detail`);
        ok(!opened.clipped, `${tag}: an opened row shows its whole label (${target.text.slice(0, 30)}...)`);
        const afterOpen = await page.evaluate(MEASURE);
        // hovering a row reserves room for the state select (padding-right): the label reflows, rows below must still not touch it
        let hoverBad = [];
        for (const x of all.info) {
          await page.hover(`#${x.id} .srow-main`);
          const hv = await page.evaluate(() => { const m = MEASURE_(); return m; });
          if (hv.problems.length) hoverBad.push([x.n, hv.problems.slice(0, 2)]);
        }
        await page.mouse.move(0, 0);
        ok(hoverBad.length === 0, `${tag}: hovering any row (state select shown) leaves no overlap or collision${hoverBad.length ? ' — ' + JSON.stringify(hoverBad.slice(0, 3)) + ` (+${hoverBad.length} rows)` : ''}`);
        ok(afterOpen.problems.length === 0, `${tag}: still no overlap with a step opened${afterOpen.problems.length ? ' — ' + JSON.stringify(afterOpen.problems.slice(0, 4)) : ''}`);
        const sc = await page.evaluate(() => { const l = document.querySelector('.slist'); l.scrollTop = 0; const b = l.scrollTop; l.scrollTop = l.scrollHeight; return { scrolls: l.scrollHeight > l.clientHeight + 1, moved: l.scrollTop > b, hscroll: l.scrollWidth > l.clientWidth + 1 }; });
        ok(sc.scrolls && sc.moved && !sc.hscroll, `${tag}: inner list scrolls vertically, no sideways scroll (${JSON.stringify(sc)})`);
        ok(errs.length === 0, `${tag}: no page errors (${errs.join(' | ')})`);
        if (SHOTS && N === COUNTS[0] && ['pane340', 'desktop1844', 'phone390'].includes(name)) {
          await page.evaluate(id => document.getElementById(id).scrollIntoView({ block: 'center' }), target.id);
          await page.locator('.ctx').screenshot({ path: path.join(OUT, `steps-${ENGINE}-${N}-${name}-opened.png`) }); // the clamped row, opened
          await page.click(`#${target.id} .srow-main`); await page.waitForTimeout(200); // fold it again for the picture
          await page.evaluate(() => { document.querySelector('.slist').scrollTop = 0; });
          await page.locator('.ctx').screenshot({ path: path.join(OUT, `steps-${ENGINE}-${N}-${name}.png`) });
        }
        await ctx.close();
      }
    }
  } finally { await browser.close(); }
} catch (e) { fail('check crashed: ' + (e.stack || e.message)); }
finally {
  if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  board?.close(); fs.rmSync(tmp, { recursive: true, force: true });
  L(failures.length ? `STEPS-MANY CHECK FAILED (${failures.length})` : 'STEPS-MANY CHECK PASSED');
  fs.writeFileSync(path.join(OUT, `check-steps-many-${ENGINE}.log`), log.join('\n') + '\n');
  process.exitCode = failures.length ? 1 : 0;
}
