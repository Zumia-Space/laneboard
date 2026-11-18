// The activity feed (ACME-02 board-read, owner 19-10: "file chi tiết góc tròn … bấm vào đọc nó ra file full chi tiết"): an ask or an answer shows four
// lines then its own Xem thêm / Thu gọn; "Chi tiết: `D:/…/file.md`" becomes a reader button when the board holds a copy and is plain text otherwise
// (never a raw-file link); web URLs are clickable and safe; nothing in agent text can make a javascript: / data: link.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import '../public/markdown.js';
import '../public/reading.js';

const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const APP = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');
const EN = JSON.parse(fs.readFileSync(path.join(PUB, 'locales', 'en.json'), 'utf8'));
const { render, inline } = globalThis.LaneMarkdown;
const { linkDocPaths, pickMdAttachment } = globalThis.LaneReading;

const MD_FILE = 'D:/data/laneboard/acme-01/sourcing/REPORT-links.md';
const PAGE_CSS = fs.readFileSync(path.join(PUB, 'styles.css'), 'utf8');

// ---------- the link renderer ----------
test('links: http(s) become safe anchors; javascript:, data:, vbscript:, file: and protocol-relative stay literal text', () => {
  const url = 'https://detail.1688.com/offer/7123456789012.html?spm=a261y.7663282.0.0&scm=1007.34127.0.0&sk=consign';
  const ok = inline(`mua ở ${url} nhé`);
  assert.match(ok, /<a href="https:\/\/detail\.1688\.com\/offer\/7123456789012\.html\?spm=a261y\.7663282\.0\.0&amp;scm=1007\.34127\.0\.0&amp;sk=consign" title="[^"]+" target="_blank" rel="noopener noreferrer">detail\.1688\.com › 7123456789012\.html<\/a>/);
  assert.match(inline('[shopee](http://shopee.vn/product/1/2)'), /<a href="http:\/\/shopee\.vn\/product\/1\/2"[^>]*rel="noopener noreferrer"/);
  for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,hi', 'vbscript:msgbox(1)', 'file:///D:/x.md', '//evil.example/x', '\tjavascript:alert(1)', 'java\nscript:alert(1)']) {
    for (const html of [inline(`[x](${bad})`), render(`[x](${bad})\n\n${bad}`)]) assert.doesNotMatch(html, /<a\b[^>]*href="(?!https?:\/\/)/i, bad);
  }
  assert.doesNotMatch(inline('[x](https://a.example/"onmouseover="alert(1))'), /\sonmouseover=/, 'a quote cannot break out of the href: it is escaped inside the attribute');
});

// ---------- "Chi tiết: <path>" ----------
const render1 = p => (p === MD_FILE ? `<button class="inline-doc" data-path="${p}">${p.split('/').pop()}</button>` : null);

test('doc path: a code span or a bare path that the board holds a copy of becomes the reader button; the rest is untouched', () => {
  assert.equal(linkDocPaths(`<p>Chi tiết: <code>${MD_FILE}</code></p>`, render1), '<p>Chi tiết: <button class="inline-doc" data-path="D:/data/laneboard/acme-01/sourcing/REPORT-links.md">REPORT-links.md</button></p>');
  assert.equal(linkDocPaths(`<p>Chi tiết: ${MD_FILE}.</p>`, render1), '<p>Chi tiết: <button class="inline-doc" data-path="D:/data/laneboard/acme-01/sourcing/REPORT-links.md">REPORT-links.md</button>.</p>');
  const other = '<p>Chi tiết: <code>D:/data/laneboard/acme-01/other.md</code> và D:/data/laneboard/x.md</p>';
  assert.equal(linkDocPaths(other, render1), other, 'no copy on the board: left as text (the copy-path chip sits under it)');
  assert.equal(linkDocPaths('<p>no path here, D:/data/laneboard/a.mdx and D:/data/laneboard/dir/ and a.md</p>', () => 'X'), '<p>no path here, D:/data/laneboard/a.mdx and D:/data/laneboard/dir/ and a.md</p>', 'only absolute .md paths');
});

test('doc path: text inside a link, a button or a code block is never rewritten; the renderer never builds a URL', () => {
  const html = `<a href="https://x.example/?f=${MD_FILE}">${MD_FILE}</a> <pre><code>${MD_FILE}</code></pre> <button>${MD_FILE}</button>`;
  assert.equal(linkDocPaths(html, () => 'X'), html.replace(`<pre><code>${MD_FILE}</code></pre>`, '<pre><code>' + MD_FILE + '</code></pre>'));
  // whatever the text says, the only things linkDocPaths emits are what `render` returned
  const seen = [];
  linkDocPaths('<p>D:/data/laneboard/a.md <code>D:/data/laneboard/b.md</code> D:/data/laneboard/javascript:alert(1).md</p>', p => (seen.push(p), null));
  assert.deepEqual(seen.slice(0, 2), ['D:/data/laneboard/b.md', 'D:/data/laneboard/a.md']);
  assert.ok(seen.every(p => /^[A-Za-z]:[\\/][^<>&"']*\.md$/.test(p)), 'paths handed to render hold no markup characters');
});

test('doc path: the page wires it to the newest attachment of that path and escapes every attribute', () => {
  const att = (id, over = {}) => ({ id, task_id: 'BR-4', mime: 'text/markdown', caption: MD_FILE, ...over });
  const lift = name => { const m = new RegExp(`^(?:const ${name} = .*;|function ${name}\\()`, 'm').exec(APP); assert.ok(m, name); return m[0].startsWith('const') ? m[0] : APP.slice(m.index, APP.indexOf('\n}\n', m.index) + 2); };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const ctx = vm.createContext({ S: { data: { attachments: [att('att-3'), att('att-9'), att('att-20', { task_id: 'OTHER' })] } }, esc, LR: globalThis.LaneReading });
  vm.runInContext([lift('docButton'), lift('mdDocs')].join('\n'), ctx);
  const html = vm.runInContext(`mdDocs(${JSON.stringify(`<p>Chi tiết: <code>${MD_FILE}</code></p>`)}, 'BR-4')`, ctx);
  assert.match(html, /<button type="button" class="inline-doc" data-action="read-doc" data-task="BR-4" data-att="att-9" data-label="REPORT-links\.md" data-path="D:\/data\/laneboard\/acme-01\/sourcing\/REPORT-links\.md" title="[^"]+" aria-haspopup="dialog">REPORT-links\.md<\/button>/);
  assert.doesNotMatch(html, /href=/, 'a button, not a link: nothing here can navigate to a file');
  const other = vm.runInContext(`mdDocs(${JSON.stringify(`<p><code>${MD_FILE}</code></p>`)}, 'NO-COPY')`, ctx);
  assert.equal(other, `<p><code>${MD_FILE}</code></p>`);
  assert.equal(pickMdAttachment([att('att-1', { caption: 'D:/data/laneboard/x"onclick="y.md' })], 'BR-4', 'D:/data/laneboard/x"onclick="y.md').id, 'att-1');
  const evil = { id: 'att-5', task_id: 'T', mime: 'text/markdown', caption: 'D:/data/laneboard/a"><img src=x onerror=alert(1)>.md' };
  const c2 = vm.createContext({ S: { data: { attachments: [evil] } }, esc, LR: globalThis.LaneReading });
  vm.runInContext(lift('docButton'), c2);
  assert.doesNotMatch(vm.runInContext(`docButton('T', 'lbl', ${JSON.stringify(evil.caption)}, 'c', '')`, c2), /<img/, 'a hostile path is escaped in every attribute');
});

// ---------- the clamp ----------
test('feed body: four lines, an inline toggle, a read button only for long text; the toggle and the open state keys are the feed\'s own', () => {
  const lift = name => { const m = new RegExp(`^(?:const ${name} = .*;|function ${name}\\()`, 'm').exec(APP); assert.ok(m, name); return m[0].startsWith('const') ? m[0] : APP.slice(m.index, APP.indexOf('\n}\n', m.index) + 2); };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const S = { dict: EN, en: EN, open: {}, data: { attachments: [] } };
  const ctx = vm.createContext({ S, esc, t: (k, v) => String(EN[k] ?? k).replace(/\{(\w+)\}/g, (_, n) => v?.[n]), MD: globalThis.LaneMarkdown, LR: globalThis.LaneReading });
  vm.runInContext(['mediaOf', 'mdDocs', 'mdHtml', 'isLongText', 'readMins', 'docButton', 'evBody'].map(lift).join('\n'), ctx);
  const body = (text, key = 'ev-ask-ask-7') => vm.runInContext(`evBody(${JSON.stringify(text)}, ${JSON.stringify(key)}, 'BR-4', { kind: 'ask', ref: 'ask-7' })`, ctx);
  const short = body('một dòng ngắn');
  assert.match(short, /^<div class="md ev-body clamp4 " data-clamp>/, 'clamped to four lines by CSS; fitClamps decides whether the toggle shows');
  assert.match(short, /<\/div><button type="button" class="more" data-action="more" data-key="ev-ask-ask-7" aria-expanded="false">Show more<\/button>$/, 'the toggle is the very next sibling (fitClamps reads nextElementSibling)');
  assert.doesNotMatch(short, /read-open/, 'short text has no read button');
  const long = body(Array.from({ length: 14 }, (_, i) => `dòng ${i}`).join('\n'));
  assert.match(long, /data-action="read" data-kind="ask" data-task="BR-4" data-ref="ask-7" aria-haspopup="dialog"><span>Read the full report<\/span>/);
  S.open['md-ev-ask-ask-7'] = true;
  const open = body('x');
  assert.match(open, /class="md ev-body clamp4 open"/);
  assert.match(open, /aria-expanded="true">Show less<\/button>/);
  assert.ok(!('md-ask-ask-7' in S.open), 'a different key from the Needs-you card (ask-<id>), so the two do not toggle together');
  assert.match(PAGE_CSS, /\.md\.clamp4:not\(\.open\) \{ display: -webkit-box; -webkit-line-clamp: 4;/);
});

test('chips are rectangles with a small radius, and a long path or URL wraps inside them', () => {
  const rule = PAGE_CSS.match(/^\.chip\.ref-link \{[^}]*\}/m)[0];
  assert.match(rule, /border-radius: var\(--radius-sm\)/);
  assert.doesNotMatch(rule, /999px|white-space: nowrap/);
  assert.match(rule, /white-space: normal/);
  assert.match(rule, /overflow-wrap: anywhere/);
  assert.doesNotMatch(PAGE_CSS, /^a\.chip\.ref-link \{[^}]*text-overflow: ellipsis/m, 'no ellipsis: nothing is cut');
});
