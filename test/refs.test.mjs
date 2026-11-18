// Images and links on an ask or a card line (owner 10-10: "phải lặn đi tìm hoặc copy link để xem ảnh"): the CoS CLI
// writes them as the text's last line (cos-board.mjs ask --img/--link), public/markdown.js splitRefs reads them back,
// app.js refsHtml shows thumbnails and link chips, and a path on the owner's computer is a copy button on the web,
// a /__zumi-open link in the Zumi owner app (?local=open) and nothing in an embed without local files (?local=hide).
// Also: the steps list is newest first with the owner's and active steps pinned on top, and folds after 6.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import '../public/markdown.js';
import '../public/measure.js';
import '../public/reading.js';

const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const APP = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');
const EN = JSON.parse(fs.readFileSync(path.join(PUB, 'locales', 'en.json'), 'utf8'));
const { splitRefs, inline } = globalThis.LaneMarkdown;

function lift(name) {
  const line = APP.match(new RegExp(`^const ${name} = .*;$`, 'm'));
  if (line) return line[0];
  const start = APP.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `app.js has no ${name}`);
  return APP.slice(start, APP.indexOf('\n}\n', start) + 2);
}
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function page(mode, data) {
  const ctx = vm.createContext({ S: { dict: EN, en: EN, open: {}, galleryNavs: {}, data }, esc, MD: globalThis.LaneMarkdown, LR: globalThis.LaneReading, LM: globalThis.LaneMeasure, serverNow: () => Date.now(), URLSearchParams, LOCAL_LINKS: mode });
  vm.runInContext(['t', 'LOOPBACK', 'zumiOpen', 'refsOf', 'docButton', 'refsHtml', 'STEPS_SHOWN', 'stepPin', 'stepsByRecency'].map(lift).join('\n'), ctx);
  return ctx;
}

const ASK = 'Pick the look: see `contact-sheet.png` (A, B or C).\n'
  + '[contact-sheet.png](https://board.example/laneboard/media/3f2a9c1d00aa11bb.png) · [hero before/after](https://board.example/laneboard/media/77aa.jpg) · '
  + '[127.0.0.1:4320](http://127.0.0.1:4320/) · `D:/data/laneboard/acme-03/REAL-MODELS-OPTIONS.md` · Morning pack `D:/data/laneboard/acme-01/MORNING-0910/`';

test('splitRefs: the last line of links and backticked paths is the refs; the body keeps the prose', () => {
  const r = splitRefs(ASK);
  assert.equal(r.body, 'Pick the look: see `contact-sheet.png` (A, B or C).');
  assert.deepEqual(r.images, [
    { name: '3f2a9c1d00aa11bb.png', caption: 'contact-sheet.png', url: 'https://board.example/laneboard/media/3f2a9c1d00aa11bb.png' },
    { name: '77aa.jpg', caption: 'hero before/after', url: 'https://board.example/laneboard/media/77aa.jpg' }]);
  assert.deepEqual(r.links, [
    { label: '127.0.0.1:4320', url: 'http://127.0.0.1:4320/', local: false },
    { label: 'REAL-MODELS-OPTIONS.md', url: 'D:/data/laneboard/acme-03/REAL-MODELS-OPTIONS.md', local: true },
    { label: 'Morning pack', url: 'D:/data/laneboard/acme-01/MORNING-0910/', local: true }]);
  // A text without refs comes back whole; a prose line that merely ends on a link is not a refs line.
  for (const plain of ['Just a question?', 'Board http://127.0.0.1:4331/ updated', 'see [the sheet](https://docs.google.com/x) please']) assert.deepEqual(splitRefs(plain), { body: plain, images: [], links: [] });
  // Backslash paths are kept as forward slashes; a folder's label ends with "/".
  assert.deepEqual(splitRefs('x\n`D:\\data\\laneboard\\material\\ACME-02\\`').links, [{ label: 'ACME-02/', url: 'D:/data/laneboard/material/ACME-02/', local: true }]);
  // A question whose own last line ends on a path is PROSE, not a refs line: cos-board writes "Kế hoạch: `D:/…/PLAN.md`"
  // as the last line of an ask, and the label rule took the whole question for one label — ask-6568 on V-03 showed a
  // chip and no question at all. A label is a name ("Morning pack `D:/…`"), not a sentence.
  const Q = 'Opus phát hiện 2 lỗ hổng, cần anh duyệt.\nKế hoạch: `D:/data/laneboard/acme-04/studio-mcp/PLAN-L1-L2.md`';
  assert.deepEqual(splitRefs(Q), { body: Q, images: [], links: [] });
  assert.deepEqual(splitRefs('x\nChi tiết: `D:/data/laneboard/acme-03/PLAN.md`').links, [], 'a colon means the path is part of the sentence');
  assert.deepEqual(splitRefs('x\nChi tiết `D:/data/laneboard/acme-03/PLAN.md`').links, [{ label: 'Chi tiết', url: 'D:/data/laneboard/acme-03/PLAN.md', local: true }], 'without the colon it is a label, as before');
});

test('the old page (no splitRefs) shows the refs line as plain links and code, never as an inline image', () => {
  const html = inline(ASK, { resolveMedia: () => 'att-1' });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /<a href="https:\/\/board\.example\/laneboard\/media\/3f2a9c1d00aa11bb\.png"[^>]*>contact-sheet\.png<\/a>/);
  assert.match(html, /<code>D:\/data\/laneboard\/acme-03\/REAL-MODELS-OPTIONS\.md<\/code>/);
});

const DATA = { attachments: [{ id: 'att-9', task_id: 'F-04', name: '3f2a9c1d00aa11bb.png', mime: 'image/png' }] };

test('refsHtml: thumbnails from the task attachments, link chips, local links per mode', () => {
  const html = mode => vm.runInContext(`refsHtml('F-04', refsOf(${JSON.stringify(ASK)}), 'ask-1')`, page(mode, DATA));
  const web = html('copy');
  assert.equal((web.match(/class="ref-img"/g) || []).length, 2);
  assert.match(web, /data-att="att-9" data-w="480"/, 'an attached image loads through the board API (works behind the Zumi bridge)');
  assert.match(web, /src="media\/77aa\.jpg"/, 'an image the task does not carry falls back to the media folder');
  assert.match(web, /<a class="chip ref-link" href="http:\/\/127\.0\.0\.1:4320\/"[^>]*target="_blank"/);
  assert.equal((web.match(/data-action="copy-path"/g) || []).length, 2, 'web: each local path has a copy button');
  assert.doesNotMatch(web, /__zumi-open/);

  const zumi = html('open');
  assert.match(zumi, /href="\/__zumi-open\?path=D%3A%2Fdata%2Flaneboard%2Facme-01%2FMORNING-0910%2F"/, 'a folder still opens through the main process');
  assert.match(zumi, /href="\/__zumi-open\?url=http%3A%2F%2F127\.0\.0\.1%3A4320%2F"/, 'a loopback URL opens through the main process too');
  assert.doesNotMatch(zumi, /__zumi-open\?path=D%3A%2Fdata%2Flaneboard%2Facme-03/, 'a .md the board holds no copy of is never opened as a raw file in another app');
  assert.match(zumi, /data-action="copy-path" data-path="D:\/data\/laneboard\/acme-03\/REAL-MODELS-OPTIONS\.md"/, 'it keeps the copy-path chip');

  const user = html('hide');
  assert.doesNotMatch(user, /local|__zumi-open|copy-path/, 'Zumi user build: no local links at all');
  assert.match(user, /127\.0\.0\.1:4320/);
  const ctx = page('copy', DATA);
  vm.runInContext(`refsHtml('F-04', refsOf(${JSON.stringify(ASK)}), 'ask-1')`, ctx);
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.S.galleryNavs['ask-1'])).map(it => it.att ? it.att.id : it.legacy.name), ['att-9', '77aa.jpg'], 'lightbox order = thumbnail order');
  assert.equal(vm.runInContext(`refsHtml('F-04', refsOf('no refs here'), 'x')`, ctx), '');
});

test('refsHtml: a local .md the board holds a copy of is a reader button in every mode that shows local links', () => {
  const md = { id: 'att-12', task_id: 'F-04', name: 'REAL-MODELS-OPTIONS.md', mime: 'text/markdown', caption: 'D:/data/laneboard/acme-03/REAL-MODELS-OPTIONS.md' };
  const html = mode => vm.runInContext(`refsHtml('F-04', refsOf(${JSON.stringify(ASK)}), 'ask-1')`, page(mode, { attachments: [...DATA.attachments, md] }));
  for (const mode of ['copy', 'open']) {
    const h = html(mode);
    assert.ok(h.includes('<button type="button" class="chip ref-link local doc" data-action="read-doc" data-task="F-04" data-att="att-12" data-label="REAL-MODELS-OPTIONS.md" data-path="D:/data/laneboard/acme-03/REAL-MODELS-OPTIONS.md"'), mode);
    assert.ok(h.includes('data-action="copy-path" data-path="D:/data/laneboard/acme-03/REAL-MODELS-OPTIONS.md"'), `${mode}: the copy chip stays as the secondary action`);
    assert.ok(!h.includes('__zumi-open?path=D%3A%2Fdata%2Flaneboard%2Facme-03'), 'a .md is never opened as a raw file in another app');
    assert.ok(h.includes(mode === 'copy' ? 'data-action="copy-path" data-path="D:/data/laneboard/acme-01/MORNING-0910/"' : '__zumi-open?path=D%3A%2Fdata%2Flaneboard%2Facme-01%2FMORNING-0910%2F'), 'the folder (not a .md) keeps the usual chip');
  }
  assert.doesNotMatch(html('hide'), /read-doc/, 'Zumi user build: no local links, so no reader chip either');
});

// J-05 Part 2 item 1 (c): a link the board holds a copy of opens from its chip — .md in the reader, a picture in the
// lightbox, an .mp4 in a <video controls> inline — and the copy-path chip stays beside it.
const OPEN_LINKS = 'Four files:\n`D:/data/laneboard/material/shot.png` · `D:/data/laneboard/material/clip.mp4` · `D:/data/laneboard/material/board.png` · `D:/data/laneboard/acme-03/REAL-MODELS-OPTIONS.md`';
const OPEN_ATTS = [
  { id: 'att-5', task_id: 'F-04', name: 'shot.png', mime: 'image/png', caption: 'D:/data/laneboard/material/shot.png' },
  { id: 'att-6', task_id: 'F-04', name: 'clip.mp4', mime: 'video/mp4', caption: 'D:/data/laneboard/material/clip.mp4' },
  { id: 'att-8', task_id: 'F-04', name: 'board.png', mime: 'image/png', caption: 'D:/data/laneboard/material/board.png' },
  { id: 'att-7', task_id: 'F-04', name: 'REAL-MODELS-OPTIONS.md', mime: 'text/markdown', caption: 'D:/data/laneboard/acme-03/REAL-MODELS-OPTIONS.md' }
];
const openHtml = ctx => vm.runInContext(`refsHtml('F-04', refsOf(${JSON.stringify(OPEN_LINKS)}), 'ask-1')`, ctx);

test('the png link opens the lightbox and keeps its copy chip', () => {
  const ctx = page('copy', { attachments: OPEN_ATTS });
  const html = openHtml(ctx);
  assert.match(html, /<button type="button" class="chip ref-link local open" data-action="lightbox" data-nav="ask-1:open" data-i="0"[^>]*>▣ shot\.png<\/button>/, 'the first picture is the lightbox button at index 0');
  assert.match(html, /data-action="lightbox" data-nav="ask-1:open" data-i="1"[^>]*>▣ board\.png<\/button>/, 'a second picture after the mp4 is index 1 (the mp4 is not in the lightbox)');
  assert.match(html, /class="ref-copy" data-action="copy-path" data-path="D:\/data\/laneboard\/material\/shot\.png"/, 'the copy chip stays');
  const nav = JSON.parse(JSON.stringify(ctx.S.galleryNavs['ask-1:open']));
  assert.deepEqual(nav.map(it => [it.att.id, it.att.mime]), [['att-5', 'image/png'], ['att-8', 'image/png']], 'the lightbox opens on the board copies, in chip order, not the paths');
});

test('the md link opens the reader and keeps its copy chip', () => {
  const html = openHtml(page('copy', { attachments: OPEN_ATTS }));
  assert.match(html, /<button type="button" class="chip ref-link local doc" data-action="read-doc" data-task="F-04" data-att="att-7" data-label="REAL-MODELS-OPTIONS\.md" data-path="D:\/data\/laneboard\/acme-03\/REAL-MODELS-OPTIONS\.md"[^>]*>▤ REAL-MODELS-OPTIONS\.md<\/button>/, 'the chip is the reader button');
  assert.match(html, /class="ref-copy" data-action="copy-path" data-path="D:\/data\/laneboard\/acme-03\/REAL-MODELS-OPTIONS\.md"/, 'the copy chip stays');
  assert.doesNotMatch(html, /__zumi-open/, 'an attached .md opens in the reader, never as a raw file in another app');
});

test('the mp4 link opens an inline <video controls> and keeps its copy chip', () => {
  const ctx = page('copy', { attachments: OPEN_ATTS });
  let html = openHtml(ctx);
  assert.match(html, /<button type="button" class="chip ref-link local open" data-action="file-open" data-key="file-ask-1-att-6"[^>]*aria-expanded="false">▶ clip\.mp4<\/button>/, 'the chip is the player toggle, keyed to its own refs block');
  assert.match(html, /class="ref-copy" data-action="copy-path" data-path="D:\/data\/laneboard\/material\/clip\.mp4"/, 'the copy chip stays');
  assert.doesNotMatch(html, /<video/, 'the player appears only once the chip is opened');
  // The key the chip carries is the one the page's file-open action toggles (S.open[b.dataset.key]).
  const key = /data-key="(file-ask-1-att-6)"/.exec(html)[1];
  vm.runInContext(`S.open[${JSON.stringify(key)}] = !S.open[${JSON.stringify(key)}]`, ctx);
  html = openHtml(ctx);
  assert.match(html, /<video controls playsinline preload="metadata" data-media="att-6" data-keep="file-ask-1-att-6"><\/video>/, 'the player streams from the attachment URL (loadImages fills src from /media/att-6/link, Range is served)');
  assert.match(html, /data-key="file-ask-1-att-6"[^>]*aria-expanded="true"/);
  const other = vm.runInContext(`refsHtml('F-04', refsOf(${JSON.stringify(OPEN_LINKS)}), 'ask-2')`, ctx);
  assert.doesNotMatch(other, /<video/, 'the same clip in another refs block (Needs-you card vs stream) stays closed');
  const hide = page('hide', { attachments: OPEN_ATTS });
  vm.runInContext(`S.open['file-ask-1-att-6'] = true`, hide); // even a chip left open shows nothing in the user build
  assert.doesNotMatch(openHtml(hide), /<video|file-open/, 'Zumi user build: no local player at all');
});

test('steps: owner waits and active work on top, then newest state change first; the board number is kept', () => {
  const st = (id, state, zone = 'build') => ({ id: `F-04/${id}`, state, zone, label: id });
  const steps = [st('s1', 'done'), st('s2', 'done'), st('ask', 'waiting', 'owner'), st('s3', 'done'), st('s4', 'active'), st('s5', 'done'), st('s6', 'todo'), st('s7', 'done')];
  const tr = at => ({ transitions: [{ at, from: 'active', to: 'done' }], first_seen_at: '2026-09-01T00:00:00.000Z' });
  const times = { 'F-04/s1': tr('2026-10-01T00:00:00.000Z'), 'F-04/s2': tr('2026-10-09T00:00:00.000Z'), 'F-04/s3': tr('2026-10-03T00:00:00.000Z'), 'F-04/s5': tr('2026-10-10T00:00:00.000Z') };
  const ctx = page('copy', { times });
  const order = JSON.parse(JSON.stringify(vm.runInContext(`stepsByRecency(${JSON.stringify({ steps })})`, ctx)));
  // s7 and s6 have no history (same push): later in the board first, after the dated ones that are newer.
  assert.deepEqual(order.map(x => `${x.s.id.split('/')[1]}#${x.i + 1}`), ['ask#3', 's4#5', 's5#6', 's2#2', 's3#4', 's1#1', 's7#8', 's6#7']);
  assert.equal(vm.runInContext('STEPS_SHOWN', ctx), 6);
});

test('a step waiting on the owner shows the images and links of its detail on the Needs-you card', () => {
  const ctx = page('copy', DATA);
  vm.runInContext(lift('stepRefs'), ctx);
  const step = { id: 'F-04/hero-r4', label: 'Homepage round 4', detail: '**Now vs B3:**\n\n![Hero vs B3](media/3f2a9c1d00aa11bb.png)\n\n![Expr A/B/C](media/f04-1010-expr.png)\n\nLive: [http://127.0.0.1:4320/](http://127.0.0.1:4320/) and [notes](https://example.com/n)\n`D:/data/laneboard/acme-03/REAL-MODELS-OPTIONS.md`' };
  const r = JSON.parse(JSON.stringify(vm.runInContext(`stepRefs(${JSON.stringify(step)})`, ctx)));
  assert.equal(r.body, 'Homepage round 4');
  assert.deepEqual(r.images.map(i => [i.name, i.caption]), [['3f2a9c1d00aa11bb.png', 'Hero vs B3'], ['f04-1010-expr.png', 'Expr A/B/C']]);
  assert.deepEqual(r.links.map(l => [l.label, l.url, l.local]), [['127.0.0.1:4320', 'http://127.0.0.1:4320/', false], ['notes', 'https://example.com/n', false], ['REAL-MODELS-OPTIONS.md', 'D:/data/laneboard/acme-03/REAL-MODELS-OPTIONS.md', true]]);
});
