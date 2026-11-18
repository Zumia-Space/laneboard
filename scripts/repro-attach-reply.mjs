// Repro: attach an image to a reply in the composer, then send. Headless Chrome at 390 px, local board only.
//   node scripts/repro-attach-reply.mjs --playwright <playwright-core dir> --chromium <binary>
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import crypto from 'node:crypto';
import { createRequire } from 'node:module'; import { fileURLToPath, pathToFileURL } from 'node:url';
const args = process.argv.slice(2), arg = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : ''; };
const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createBoard } = await import(pathToFileURL(path.join(HERE, 'src/board.mjs')));
const { createServer } = await import(pathToFileURL(path.join(HERE, 'src/server.mjs')));
const pw = createRequire(path.join(arg('--playwright'), 'package.json'))(arg('--playwright'));
const engine = arg('--engine') === 'webkit' ? pw.webkit : pw.chromium; // webkit = what iPhone Safari uses
const secret = crypto.randomBytes(32).toString('base64url'), data = fs.mkdtempSync(path.join(os.tmpdir(), 'repro-'));
const board = createBoard({ dataDir: data }), server = createServer(board, { ownerProxySecret: secret });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`, OWN = { 'X-Laneboard-Owner-Proxy': secret, 'X-Requested-With': 'laneboard' };
const w = async (h, op, id, d) => (await fetch(base + '/api/v1/write', { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify({ version: 1, request_id: 'r-' + crypto.randomUUID(), op, target_id: id, data: d }) })).json();
const coord = (await w(OWN, 'token.issue', 'c', { role: 'coordinator', replace_coordinator: true, label: 'c' })).token;
await w({ Authorization: 'Bearer ' + coord }, 'task.create', 'T-1', { title: 'Task', lane: 'x', now: 'n', next: 'n', steps: [{ id: 's1', label: 'S', zone: 'build', state: 'active' }] });
const browser = await engine.launch(arg('--chromium') && engine === pw.chromium ? { executablePath: arg('--chromium'), headless: true } : { headless: true });
const cases = [['jpeg-1400px', 'image/jpeg', 'jpeg', 1400, 0.9], ['jpeg-2400px', 'image/jpeg', 'jpeg', 2400, 0.9]];
let bad = 0;
for (const [label, mime, ext, px, q] of cases) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true, extraHTTPHeaders: { 'X-Laneboard-Owner-Proxy': secret } });
  const page = await ctx.newPage(), net = [];
  page.on('response', r => { if (r.url().includes('/api/v1/upload') || (r.request().method() === 'POST' && r.url().includes('/write'))) net.push(`${r.request().method()} ${new URL(r.url()).pathname} ${r.status()}`); });
  // --no-webp-encode: what Safari does for canvas.toBlob('image/webp') -- it hands back a PNG instead of failing.
  if (args.includes('--no-webp-encode')) await page.addInitScript(() => { const o = HTMLCanvasElement.prototype.toBlob; HTMLCanvasElement.prototype.toBlob = function (cb, t, q) { return o.call(this, cb, t === 'image/webp' ? 'image/png' : t, q); }; });
  await page.goto(base + '/#/task/T-1', { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-compose-text]');
  await page.fill('[data-compose-text]', 'reply with image ' + label);
  await page.evaluate(async ([mime, ext, px, q]) => {
    let file;
    if (px) { const c = document.createElement('canvas'); c.width = c.height = px; const g = c.getContext('2d'), im = g.createImageData(px, px); for (let i = 0; i < im.data.length; i += 65536) crypto.getRandomValues(im.data.subarray(i, Math.min(i + 65536, im.data.length))); for (let i = 3; i < im.data.length; i += 4) im.data[i] = 255; g.putImageData(im, 0, 0); const b = await new Promise(r => c.toBlob(r, mime, q)); file = new File([b], 'IMG_0001.' + ext, { type: mime }); }
    else file = new File([new Uint8Array(3 * 1024 * 1024)], 'IMG_0002.' + ext, { type: mime });
    window.__size = file.size;
    const dt = new DataTransfer(); dt.items.add(file);
    document.querySelector('[data-compose-text]').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, [mime, ext, px, q]);
  await page.waitForTimeout(2500);
  const thumbs = await page.locator('.thumb').count();
  await page.locator('.composer .btn.primary').click(); await page.waitForTimeout(2000);
  const toast = await page.locator('.toast').allInnerTexts().catch(() => []);
  const sent = await page.evaluate(async () => { const s = await (await fetch('api/v1/state')).json(); return (s.messages || []).length; });
  console.log(JSON.stringify({ case: label, fileBytes: await page.evaluate(() => window.__size), thumbsAdded: thumbs, network: net, toast, messagesOnBoard: sent }));
  await ctx.close();
}
await browser.close(); server.closeAllConnections(); server.close(); board.close();
