// public/markdown.js: agent-written text renders as lists and tables, long URLs as short labels, and nothing in the
// source can inject HTML or a script URL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../public/markdown.js';

const { render, inline, shortUrl, splitRefs } = globalThis.LaneMarkdown;

test('markdown: HTML in the source is escaped everywhere, script URLs never become links', () => {
  const src = '<script>alert(1)</script> **<b>x</b>**\n- <img src=x onerror=alert(1)>\n\n| a | b |\n|---|---|\n| <i>c</i> | [x](javascript:alert(1)) |\n\n[y](data:text/html,hi) `<u>`';
  const html = render(src);
  assert.doesNotMatch(html, /<script|<b>|<img src=x|<i>|<u>|href="javascript|href="data/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /\[x\]\(javascript:alert\(1\)\)/, 'unsafe link stays literal text');
  assert.doesNotMatch(inline('"><svg onload=alert(1)>'), /<svg/);
});

test('markdown: long URLs become short labels with the full URL in title and href', () => {
  const url = 'https://web.facebook.com/groups/1234567890123456/posts/1001';
  assert.equal(shortUrl(url), 'facebook.com › 1001');
  assert.equal(shortUrl('http://127.0.0.1:4202/r22.html'), '127.0.0.1:4202 › r22.html');
  const html = inline(`see ${url}, then [p1](${url}).`);
  assert.match(html, new RegExp(`<a href="${url}" title="${url}" target="_blank" rel="noopener noreferrer">facebook.com › 1001</a>, then`));
  assert.match(html, />p1<\/a>\.$/);
});

test('markdown: bullet lists (nested) and numbered lists render as real lists', () => {
  const html = render('Intro line\n- **one**\n  - one.a\n- two `code`\n\n1. first\n2. second');
  assert.match(html, /^<p>Intro line<\/p><ul><li><strong>one<\/strong><ul><li>one\.a<\/li><\/ul><\/li><li>two <code>code<\/code><\/li><\/ul><ol><li>first<\/li><li>second<\/li><\/ol>$/);
});

test('markdown: pipe tables render as tables, each cell labelled by its column for narrow screens', () => {
  const html = render('| # | Post | Kept |\n|---|---|---|\n| 1 | [p1](https://web.facebook.com/groups/1/posts/1001) | 7 days |\n| 2 | plain | 30 days |');
  assert.match(html, /<table class="md-table"><thead><tr><th>#<\/th><th>Post<\/th><th>Kept<\/th><\/tr><\/thead><tbody>/);
  assert.match(html, /<td data-label="Post"><span class="cell"><a href="https:\/\/web\.facebook\.com\/groups\/1\/posts\/1001"[^>]*>p1<\/a><\/span><\/td>/);
  assert.equal((html.match(/<tr>/g) || []).length, 3);
});

test('markdown: a list of 3+ records with the same fields renders as a table; a normal list stays a list', () => {
  const jobs = render('- AI agent dev | Acme | remote | https://jobs.example.com/a/123\n- Automation lead | Beta | Hanoi | https://jobs.example.com/b/9\n- Prompt engineer | Gamma | remote | —');
  assert.match(jobs, /<table class="md-table no-head"><tbody>/);
  assert.equal((jobs.match(/<tr>/g) || []).length, 3);
  assert.match(jobs, /jobs\.example\.com › 123/);
  assert.doesNotMatch(render('- a — b\n- c — d\n- e — f'), /<table/, 'two fields is prose, not a record list');
});

// J-05 Part 2 item 2: an older ask (ask-5610) draws the same path twice. splitRefs is the one place every ref is read
// (asks, step details, stream), so de-duplicating there removes the second chip everywhere without a journal rewrite.
test('the same local path twice renders one chip', () => {
  const r = splitRefs('Which mock?\n`D:/data/laneboard/material/shot.png` · `D:\\data\\laneboard\\material\\SHOT.png` · `D:/data/laneboard/material/shot.png`');
  assert.equal(r.body, 'Which mock?', 'the refs line is still consumed, duplicates or not');
  assert.deepEqual(r.links, [{ label: 'shot.png', url: 'D:/data/laneboard/material/shot.png', local: true }], 'one link entry -> the page draws one chip');
  // The same URL with slashes or case spelled differently in its scheme/host is the same chip; a different query is not.
  const web = splitRefs('x\n[a](https://EXAMPLE.com/p/1) · [b](https://example.com//p/1) · [c](https://example.com/p/1?v=2)');
  assert.equal(web.links.length, 2);
  assert.deepEqual(web.links.map(l => l.url), ['https://EXAMPLE.com/p/1', 'https://example.com/p/1?v=2']);
  // A URL path is case-sensitive (review N2): only the scheme and host fold, so these stay two chips.
  assert.equal(splitRefs('x\n[a](https://example.com/A) · [b](https://EXAMPLE.com/a)').links.length, 2);
  assert.equal(splitRefs('x\n[a](https://example.com?q=A) · [b](https://example.com?q=a)').links.length, 2, 'a pathless URL still keeps its query case');
  // Images are the same file when they share a name, whichever media URL names it.
  const img = splitRefs('x\n[a](https://h/media/3f2a.png) · [b](https://H/MEDIA/3F2A.PNG)');
  assert.equal(img.images.length, 1);
  assert.equal(img.images[0].caption, 'a');
});

test('markdown: media references resolve to board attachments when known', () => {
  const html = render('![Overview](media/j05-overview.png) and ![x](media/missing.png)', { resolveMedia: n => (n === 'j05-overview.png' ? 'att-7' : null) });
  assert.match(html, /<img class="md-img" data-att="att-7" alt="Overview"/);
  assert.match(html, /<span class="chip md-file" title="media\/missing\.png">x<\/span>/);
});
