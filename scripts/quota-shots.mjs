#!/usr/bin/env node
// Visual QC of the Quota panel: starts a scratch board on an EMPTY data dir with a frozen clock (23:41 on 23-10-2026, the instant
// the approved concept was drawn at), writes fixture quota.json documents into it and renders the Quota view in headless Chromium
// (no window is shown). Also measures the inset of the first and last card against the frame (the owner's "third card touches the
// frame" fix) and exits 1 on a page error, a console error or an unequal inset.
//
//   node scripts/quota-shots.mjs --playwright <playwright-core dir> --chromium <chrome binary> --out <dir> [--doc <quota.json from a real quota-pull>]
//
// --doc adds quota-real-pull: that document served by a board on the REAL clock (the frozen clock would misjudge its times).
//
// Shots: quota-concept-scene (the three concept cards, 1440 wide), quota-states (offline / stale / never seen), quota-bad-file (503),
// quota-empty (no file), quota-vi (Vietnamese), quota-mobile (390 wide). Nothing listens beyond 127.0.0.1; the data dir is scratch.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NOW, minutesBefore, premiumA, premiumB, acme, sampleDoc } from '../test/quota-fixtures.mjs';

const args = process.argv.slice(2), arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PW = arg('--playwright'), EXE = arg('--chromium'), OUT = path.resolve(arg('--out', path.join(os.tmpdir(), 'laneboard-quota-shots')));
if (!PW || !EXE) { console.error('usage: quota-shots.mjs --playwright <playwright-core dir> --chromium <binary> [--out <dir>]'); process.exit(2); }
const { createBoard } = await import(pathToFileURL(path.join(HERE, 'src', 'board.mjs')));
const { createServer } = await import(pathToFileURL(path.join(HERE, 'src', 'server.mjs')));
const { chromium } = createRequire(path.join(PW, 'package.json'))(PW);

const OWNER = 'quota-shots-owner-secret-0123456789';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'laneboard-quota-data-'));
const board = createBoard({ dataDir, ownerToken: OWNER, now: () => NOW });
const server = createServer(board);
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}`;
const quotaFile = path.join(dataDir, 'quota.json');
const put = doc => fs.writeFileSync(quotaFile, typeof doc === 'string' ? doc : JSON.stringify(doc));
fs.mkdirSync(OUT, { recursive: true });

const failures = [];
const browser = await chromium.launch({ executablePath: EXE, headless: true });
async function shot(name, { width = 1440, height = 900, lang = 'en', allow503 = false, base = url } = {}) {
  const page = await (await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, locale: lang === 'vi' ? 'vi-VN' : 'en-US' })).newPage();
  page.on('pageerror', e => failures.push(`${name}: page error ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !(allow503 && /503/.test(m.text()))) failures.push(`${name}: console ${m.text()}`); });
  await page.goto(`${base}/#token=${OWNER}&lang=${lang}&theme=dark&view=quota`);
  await page.waitForSelector('.q-frame', { timeout: 8000 });
  await page.waitForTimeout(400);
  const insets = await page.evaluate(() => {
    const f = document.querySelector('.q-frame')?.getBoundingClientRect(), cs = [...document.querySelectorAll('.q-card')].map(c => c.getBoundingClientRect());
    return f && cs.length ? { left: +(cs[0].left - f.left).toFixed(1), right: +(f.right - cs[cs.length - 1].right).toFixed(1), n: cs.length, cols: new Set(cs.map(c => Math.round(c.left))).size } : null;
  });
  await page.locator('.q-frame').screenshot({ path: path.join(OUT, name + '.png') });
  await page.screenshot({ path: path.join(OUT, name + '-page.png') });
  if (insets) {
    console.log(name, JSON.stringify(insets));
    if (Math.abs(insets.left - insets.right) > 1) failures.push(`${name}: card inset left ${insets.left} != right ${insets.right}`);
  } else console.log(name, 'no cards');
  await page.context().close();
}

try {
  put(sampleDoc);
  await shot('quota-concept-scene');
  await shot('quota-vi', { lang: 'vi' });
  await shot('quota-mobile', { width: 390, height: 844 });
  // offline (last values dimmed), stale (31 min without a report, window still open), never seen
  put({ schema: 1, generated_at: minutesBefore(1), accounts: [
    { ...premiumB, label: 'Premium B', reach: { status: 'offline', checked_at: minutesBefore(1), since: minutesBefore(160), msg: 'ssh timeout' } },
    { ...premiumA, window5h: { ...premiumA.window5h, as_of: minutesBefore(31) }, week: { ...premiumA.week, as_of: minutesBefore(31) }, tokens: { ...premiumA.tokens, as_of: minutesBefore(31) } },
    { id: 'acme', label: 'Acme Tours', machine: acme.machine, reach: { status: 'ok', checked_at: minutesBefore(1) } }
  ] });
  await shot('quota-states');
  put('{"accounts": ['); await shot('quota-bad-file', { allow503: true }); // the browser logs the refused request itself
  fs.rmSync(quotaFile); await shot('quota-empty');
  if (arg('--doc')) {
    const realDir = fs.mkdtempSync(path.join(os.tmpdir(), 'laneboard-quota-real-'));
    fs.copyFileSync(path.resolve(arg('--doc')), path.join(realDir, 'quota.json'));
    const realBoard = createBoard({ dataDir: realDir, ownerToken: OWNER });
    const realServer = createServer(realBoard);
    await new Promise(r => realServer.listen(0, '127.0.0.1', r));
    try { await shot('quota-real-pull', { base: `http://127.0.0.1:${realServer.address().port}` }); }
    finally { realServer.closeAllConnections(); await new Promise(r => realServer.close(r)); realBoard.close(); }
  }
} finally { await browser.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); board.close(); }
if (failures.length) { for (const f of failures) console.error('FAIL', f); process.exit(1); }
console.log('ok, shots in', OUT);
