// J-05 Part 2 item 3: asks the coordinator withdrew (status 'cleared') used to take a full block each. They fold into
// one collapsed row ("N withdrawn asks") at the oldest one's place: closed by default, the cards inside, the open asks
// still full and answerable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const APP = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');
const LOC = Object.fromEntries(['en', 'vi', 'zh'].map(l => [l, JSON.parse(fs.readFileSync(path.join(PUB, 'locales', `${l}.json`), 'utf8'))]));

/** A top-level `const name = ...;` line or `function name(...) {...}` block of app.js, verbatim. */
function lift(name) {
  const line = APP.match(new RegExp(`^const ${name} = .*;$`, 'm'));
  if (line) return line[0];
  const start = APP.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `app.js has no ${name}`);
  const eol = APP.indexOf('\n', start);
  if (APP.slice(start, eol).endsWith('}')) return APP.slice(start, eol);
  return APP.slice(start, APP.indexOf('\n}\n', start) + 2);
}
const escHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtTime = iso => String(iso).slice(11, 16); // HH:MM, enough for the id · date line
const TASK = { id: 'W-1', title: 'Withdrawn', status: 'open', steps: [{ id: 'W-1/a', label: 'Copy', state: 'waiting', zone: 'owner', rev: 1 }] };
const ASK = (id, status, at, clearedAt) => ({ id, task_id: 'W-1', status, text: id, attribution: { created_at: at, created_by: 'cos' },
  ...(clearedAt ? { cleared: { at: clearedAt } } : {}) });
const ASKS = [
  ASK('ask-1', 'cleared', '2026-10-20T08:00:00.000Z', '2026-10-20T09:00:00.000Z'),
  ASK('ask-2', 'open', '2026-10-20T08:20:00.000Z'),
  ASK('ask-3', 'cleared', '2026-10-20T08:30:00.000Z', '2026-10-20T09:30:00.000Z')
];

function page(lang = 'en') {
  const S = { dict: LOC[lang], en: LOC.en, open: {}, galleryNavs: {}, hl: null,
    data: { tasks: [TASK], asks: ASKS, messages: [], times: {}, plans: {}, feedback: [], me: { role: 'owner' } } };
  const ctx = vm.createContext({ S, esc: escHtml, Date, isOwner: () => true, isLead: () => true, serverNow: () => Date.parse('2026-10-20T10:00:00.000Z'),
    askSinceOf: a => a.attribution.created_at, askedBy: x => x, fmtDur: ms => Math.round(ms / 3600000) + 'h', fmtTime,
    refsOf: s => ({ body: s || '', images: [], links: [] }), refsHtml: () => '', evBody: t => escHtml(t), mdInline: escHtml,
    store: { get: () => '', set() {} } });
  vm.runInContext(['t', 'msgsOf', 'asksOf', 'streamEntries'].map(lift).join('\n'), ctx);
  return ctx;
}
const stream = (ctx = page()) => vm.runInContext('streamEntries(S.data.tasks[0])', ctx);
const details = html => {
  const at = html.indexOf('<details class="ev-withdrawn"');
  assert.ok(at >= 0, 'no folded row');
  return html.slice(at, html.indexOf('</details>', at));
};
const openTag = html => details(html).slice(0, details(html).indexOf('>') + 1);

test('two cleared asks render one collapsed row; the open ask stays expanded', () => {
  const html = stream();
  assert.equal((html.match(/<details class="ev-withdrawn"/g) || []).length, 1, 'one row for both cleared asks');
  const tag = openTag(html);
  assert.match(tag, /data-open="wd-W-1"/, 'the row keys the shared S.open flag');
  assert.doesNotMatch(tag, / open>/, 'closed by default');
  assert.match(details(html), /2 withdrawn asks/);
  for (const id of ['ask-1', 'ask-3']) assert.ok(details(html).includes(`id="ev-${id}"`), `${id} is inside the row`);
  assert.ok(details(html).includes(`ask-1 · <time title="2026-10-20T09:00:00.000Z">${fmtTime('2026-10-20T09:00:00.000Z')}</time>`), 'the summary names each id and date');
  assert.ok(details(html).includes(`ask-3 · <time title="2026-10-20T09:30:00.000Z">${fmtTime('2026-10-20T09:30:00.000Z')}</time>`));
  // The open ask is a full card outside the row, still carrying its answer link.
  assert.ok(!details(html).includes('id="ev-ask-2"'), 'the open ask is not folded');
  assert.match(html, /<div class="ev ask open " id="ev-ask-2"/);
  assert.match(html, /data-action="reply-ask"[^>]*data-ask="ask-2"/);
  // Opening the row (S.open, the page's persisted toggle) shows both cards.
  const ctx = page();
  vm.runInContext("S.open['wd-W-1'] = true", ctx);
  const opened = stream(ctx);
  assert.match(openTag(opened), / open>/);
  const inside = details(opened);
  for (const id of ['ask-1', 'ask-3']) assert.ok(inside.includes(`id="ev-${id}"`), `${id} shows when opened`);
});

test('the folded row speaks the page language', () => {
  assert.match(details(stream(page('vi'))), /2 câu đã rút/);
  assert.match(details(stream(page('zh'))), /2 个已撤回的提问/);
});

test('a deep link to a withdrawn ask opens the folded row (review S3)', () => {
  // focusAsk (a "Waiting on you" link) sets S.hl on the ask; its card lives inside the closed fold, so the fold must open.
  const linked = page();
  linked.S.hl = { task: 'W-1', id: 'ask-3' };
  const html = stream(linked);
  assert.match(openTag(html), / open>/, 'the fold opens so the target is visible');
  assert.ok(details(html).includes('id="ev-ask-3"'), 'the linked card is inside it');
  // A highlight elsewhere (an open ask, another task) leaves the fold closed.
  const openAsk = page();
  openAsk.S.hl = { task: 'W-1', id: 'ask-2' };
  assert.doesNotMatch(openTag(stream(openAsk)), / open>/);
  const other = page();
  other.S.hl = { task: 'OTHER', id: 'ask-1' };
  assert.doesNotMatch(openTag(stream(other)), / open>/);
  // Once the owner closes it by hand, that choice wins: the persisted toggle is not overridden by the link.
  linked.S.open['wd-W-1'] = false;
  assert.doesNotMatch(openTag(stream(linked)), / open>/);
});
