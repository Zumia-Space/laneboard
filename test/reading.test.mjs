// public/reading.js: the small pure decisions behind the reader and the clamped "Hiện tại" line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../public/reading.js';

const { clampOverflows } = globalThis.LaneReading;

test('clamp: a block hides text only when its content is taller than its box (1px rounding slack)', () => {
  assert.equal(clampOverflows(120, 60), true, 'three lines shown of six: the toggle is needed');
  assert.equal(clampOverflows(60, 60), false, 'fits exactly: no toggle');
  assert.equal(clampOverflows(61, 60), false, 'one pixel of rounding is not hidden text');
  assert.equal(clampOverflows(62, 60), true);
  assert.equal(clampOverflows(0, 0), false, 'a block that is not laid out (hidden tab) shows no toggle');
});

const { splitTldr } = globalThis.LaneReading;

test('tl;dr: a "## Tóm tắt" section is returned alone, up to the next heading of the same level', () => {
  const md = '# Report\n\nintro\n\n## Tóm tắt\n- one\n- two\n\n### Detail under it\nstill part of the summary\n\n## Findings\nlong body';
  const r = splitTldr(md);
  assert.equal(r.summary, '## Tóm tắt\n- one\n- two\n\n### Detail under it\nstill part of the summary');
  assert.equal(r.full, md, 'the full text is handed back untouched');
});

test('tl;dr: any heading level, any case, with emphasis and a trailing colon or words', () => {
  for (const h of ['# TL;DR', '### tl;dr', '## TLDR', '#### **TL;DR:** quick', '## tóm tắt', '## TÓM TẮT nhanh', '## Tóm tắt:', '## Tom tat']) {
    const r = splitTldr(`# Title\n\n${h}\nshort answer\n\n# Next\nrest`);
    assert.ok(r.summary && r.summary.includes('short answer') && !r.summary.includes('rest'), h);
  }
});

test('tl;dr: a section at the end of the file runs to the end; a higher heading ends a deeper one', () => {
  assert.equal(splitTldr('# A\n\nbody\n\n### TL;DR\nlast words').summary, '### TL;DR\nlast words');
  assert.equal(splitTldr('# A\n### TL;DR\nsum\n## B\nnext').summary, '### TL;DR\nsum');
});

test('tl;dr: no section, an empty one, one that is the whole text, or only a word that starts alike gives null', () => {
  assert.equal(splitTldr('# Report\n\nNo summary here.\n').summary, null);
  assert.equal(splitTldr('## Summary\nenglish word does not count').summary, null);
  assert.equal(splitTldr('# A\n\n## Tóm tắt\n\n## B\nbody').summary, null, 'a heading with nothing under it');
  assert.equal(splitTldr('## Tóm tắt\nonly this').summary, null, 'the summary is the whole file: nothing to expand');
  assert.equal(splitTldr('## Tóm tắtcủa\nx\n## B\ny').summary, null, 'a longer word is not the heading');
  assert.equal(splitTldr('').summary, null);
  assert.equal(splitTldr(null).summary, null);
});

test('tl;dr: a "# Tóm tắt" line inside a code fence is not a heading', () => {
  const md = '# A\n\n```md\n## Tóm tắt\nfake\n```\n\nreal body\n\n## Tóm tắt\nreal summary\n\n## End\nx';
  assert.equal(splitTldr(md).summary, '## Tóm tắt\nreal summary');
});

test('tl;dr: CRLF text works', () => {
  assert.equal(splitTldr('# A\r\n\r\n## Tóm tắt\r\nfine\r\n\r\n## B\r\nx').summary, '## Tóm tắt\nfine');
});

const { attKind, pickAttachment, pickMdAttachment } = globalThis.LaneReading;

test('md chip: the newest text/markdown attachment of the task with the file path as caption wins', () => {
  const att = (id, over = {}) => ({ id, task_id: 'T-1', mime: 'text/markdown', caption: 'D:/data/laneboard/reports/report.md', name: 'report.md', ...over });
  const list = [att('att-3'), att('att-12'), att('att-9'), att('att-20', { task_id: 'T-2' }), att('att-30', { mime: 'text/plain' }), att('att-31', { caption: 'D:/data/laneboard/reports/other.md' })];
  assert.equal(pickMdAttachment(list, 'T-1', 'D:/data/laneboard/reports/report.md').id, 'att-12', 'numeric order: att-12 is newer than att-9');
  assert.equal(pickMdAttachment(list, 'T-1', String.raw`d:\data\laneboard\reports\REPORT.md`).id, 'att-12', 'slash and case do not matter on Windows paths');
  assert.equal(pickMdAttachment(list, 'T-3', 'D:/data/laneboard/reports/report.md'), null, 'another task has none');
  assert.equal(pickMdAttachment(list, 'T-1', 'D:/data/laneboard/reports/missing.md'), null, 'a file nobody attached keeps its copy-path chip');
  assert.equal(pickMdAttachment(list, 'T-1', 'D:/data/laneboard/reports/report.txt'), null, 'only .md paths');
  assert.equal(pickMdAttachment([...list, att('att-40', { mime: 'image/png' })], 'T-1', 'D:/data/laneboard/reports/report.md').id, 'att-12',
    'a newer copy of another type does not hide the markdown one (the reader only ever reads text)');
  assert.equal(pickMdAttachment(undefined, 'T-1', 'D:/x.md'), null);
});

test('open chip: the newest attachment the page can show (markdown, image, mp4) with the path as caption wins', () => {
  const att = (id, mime, over = {}) => ({ id, task_id: 'T-1', mime, caption: 'D:/data/laneboard/material/clip.mp4', name: 'clip.mp4', ...over });
  const list = [att('att-3', 'video/mp4'), att('att-10', 'video/mp4'), att('att-11', 'text/plain'), att('att-12', 'application/pdf'),
    att('att-13', 'video/mp4', { task_id: 'T-2' }), att('att-14', 'video/mp4', { caption: 'D:/data/laneboard/material/other.mp4' }),
    att('att-15', 'image/png', { caption: 'D:/data/laneboard/material/shot.png' })];
  assert.equal(pickAttachment(list, 'T-1', 'D:/data/laneboard/material/clip.mp4').id, 'att-10', 'numeric order: att-10 is newer than att-3');
  assert.equal(pickAttachment(list, 'T-1', 'D:/data/laneboard/material/shot.png').id, 'att-15', 'an image copy is picked too');
  assert.equal(pickAttachment(list, 'T-3', 'D:/data/laneboard/material/clip.mp4'), null, 'another task has none');
  assert.equal(pickAttachment([att('att-20', 'application/pdf')], 'T-1', 'D:/data/laneboard/material/clip.mp4'), null, 'a type the page cannot show keeps the copy chip');
  assert.equal(pickAttachment(undefined, 'T-1', 'D:/x'), null);
  assert.deepEqual(['text/markdown', 'video/mp4', 'image/png', 'image/jpeg', 'application/pdf', undefined].map(attKind), ['md', 'video', 'image', 'image', null, null],
    'one classifier decides the lookup and the open button');
});
