// Home's Needs-you list (owner 10-15: "sao trên bảng có nhiều mục task trùng nhau thế"): since multi-ask the panel drew one
// row per ask, each titled with the TASK, so ACME-02 read three identical rows. Now one block per task (measure.js needGroups):
// code + title, a count, the oldest ask's age; several asks fold behind the row, each with its own label, age and answer action.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import '../public/measure.js';

const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const APP = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');
const LOC = Object.fromEntries(['en', 'vi', 'zh'].map(l => [l, JSON.parse(fs.readFileSync(path.join(PUB, 'locales', `${l}.json`), 'utf8'))]));
const { needGroups } = globalThis.LaneMeasure;
const H = 3600000, NOW = Date.parse('2026-10-15T12:00:00.000Z');

const ask = (id, task_id, step_id, text, age_h) => ({ kind: 'ask', id, task_id, step_id, text, options: [], rev: 1, from: 'cos', since: new Date(NOW - age_h * H).toISOString(), age_ms: age_h * H });
const TASKS = [
  { id: 'ACME-02', title: 'Zumi avatar', steps: [{ id: 'ACME-02/ask-10101140', label: 'Zumi đã lên bản mới' }, { id: 'ACME-02/qc', label: 'Duyệt gói buổi sáng' }, { id: 'ACME-02/pose', label: 'Pose check' }] },
  { id: 'L-01', title: 'Civ livestream', steps: [{ id: 'L-01/r1', label: 'Pick the map' }] },
  { id: 'F-04', title: 'Dress tool', steps: [{ id: 'F-04/real-models', label: 'Model thật cho 6 nhân vật' }] }
];

test('three asks on one task are one group: the count, the oldest age, items oldest first', () => {
  const g = needGroups([ask('ask-2', 'ACME-02', 'qc', 'B', 5), ask('ask-3', 'ACME-02', 'pose', 'C', 1), ask('ask-1', 'ACME-02', 'ask-10101140', 'A', 30)], TASKS);
  assert.equal(g.length, 1);
  assert.equal(g[0].task_id, 'ACME-02');
  assert.equal(g[0].count, 3);
  assert.equal(g[0].age_ms, 30 * H, 'the group reads the oldest ask');
  assert.deepEqual(g[0].items.map(i => i.id), ['ask-1', 'ask-2', 'ask-3']);
});

test('tasks sort by their oldest ask, oldest first', () => {
  const g = needGroups([ask('a', 'F-04', 'real-models', 'x', 2), ask('b', 'ACME-02', 'qc', 'y', 40), ask('c', 'L-01', 'r1', 'z', 10), ask('d', 'F-04', 'real-models', 'w', 90), ask('e', 'L-01', 'r1', 'v', 11)], TASKS);
  assert.deepEqual(g.map(x => [x.task_id, x.count]), [['F-04', 2], ['ACME-02', 1], ['L-01', 2]], 'F-04 holds the 90 h ask, ACME-02 40 h, L-01 11 h');
  assert.deepEqual(needGroups([], TASKS), []);
  assert.deepEqual(needGroups(undefined, undefined), []);
});

test('label: a real step title wins; an auto-step (ask-… id) uses the ask text, whitespace collapsed and clipped near 60 chars', () => {
  const long = 'Please   open\n the   new  build and tell me whether the sky looks right to you, then pick a colour';
  const g = needGroups([ask('1', 'ACME-02', 'qc', 'anything', 3), ask('2', 'ACME-02', 'ask-10101140', long, 2), ask('3', 'ACME-02', undefined, '  short   one ', 1)], TASKS)[0];
  const by = Object.fromEntries(g.items.map(i => [i.id, i.label]));
  assert.equal(by['1'], 'Duyệt gói buổi sáng');
  assert.equal(by['2'], 'Please open the new build and tell me whether the sky looks…');
  assert.ok(by['2'].length <= 60);
  assert.equal(by['3'], 'short one', 'no step: the text');
});

test('label: asks sharing one step title would repeat the duplicate, so they use their own text', () => {
  const g = needGroups([ask('1', 'F-04', 'real-models', 'Which hero model?', 4), ask('2', 'F-04', 'real-models', 'Which hair?', 3)], TASKS)[0];
  assert.deepEqual(g.items.map(i => i.label), ['Which hero model?', 'Which hair?']);
  const one = needGroups([ask('1', 'F-04', 'real-models', 'Which hero model?', 4)], TASKS)[0];
  assert.equal(one.items[0].label, 'Model thật cho 6 nhân vật', 'a single ask keeps its step title');
});

test('a step item (no ask raised on it) is labelled by the step title it carries', () => {
  const g = needGroups([{ kind: 'step', id: 'ACME-02/pose', task_id: 'ACME-02', step_id: 'pose', text: 'Pose check', options: [], rev: 1, since: new Date(NOW - H).toISOString(), age_ms: H }], TASKS)[0];
  assert.equal(g.items[0].label, 'Pose check');
});

// ---- the page: one block per task, the per-ask actions and deep link untouched ----
function lift(name) {
  const line = APP.match(new RegExp(`^const ${name} = .*;$`, 'm'));
  if (line) return line[0];
  const start = APP.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `app.js has no ${name}`);
  return APP.slice(start, APP.indexOf('\n}\n', start) + 2);
}
function page(lang, open = {}) {
  const S = { dict: LOC[lang], en: LOC.en, open, data: { tasks: TASKS.map(t => ({ ...t, now: 'building' })) } };
  const ctx = vm.createContext({ S, esc: s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]),
    fmtDur: ms => Math.round(ms / H) + 'h', isOwner: () => true, isLead: () => true, askedBy: x => x, mdInline: s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]), // the real mdInline escapes too
    refsOf: s => ({ body: s || '', images: [], links: [] }), refsHtml: () => '', stepRefs: s => ({ body: s.label, images: [], links: [] }) });
  vm.runInContext(['t', 'askHref', 'waitTone', 'attentionRow', 'needGroupHtml'].map(lift).join('\n'), ctx);
  return ctx;
}
const group = (ctx, waiting) => vm.runInContext(`needGroupHtml(${JSON.stringify(needGroups(waiting, TASKS)[0])})`, ctx);
const THREE = [ask('ask-1', 'ACME-02', 'ask-10101140', 'Open the new build', 30), ask('ask-2', 'ACME-02', 'qc', 'B', 5), ask('ask-3', 'ACME-02', 'pose', 'C', 1)];

test('several asks: one folded block with the task once, a "3 items" badge and the oldest age', () => {
  const html = group(page('en'), THREE);
  assert.equal((html.match(/Zumi avatar/g) || []).length, 1, 'the task title is not repeated per ask');
  assert.match(html, /<details class="need-group" data-open="need-ACME-02" >/, 'folded by default');
  assert.match(html, /<span class="code">ACME-02<\/span>/);
  assert.match(html, /<span class="badge q">3 items<\/span>/);
  assert.match(html, /<span class="need-age warn">waiting 30h<\/span>/, 'the oldest ask, in the over-a-day tone');
  assert.equal((html.match(/<div class="row ask">/g) || []).length, 3, 'one line per ask');
  assert.deepEqual([...html.matchAll(/<span class="ask-title">([^<]*)<\/span><\/a>/g)].map(m => m[1]), ['Open the new build', 'Duyệt gói buổi sáng', 'Pose check'], 'each line has its own label');
  assert.match(group(page('en', { 'need-ACME-02': true }), THREE), /<details class="need-group" data-open="need-ACME-02" open>/, 'the open state is remembered');
});

test('the per-ask deep link and answer actions are kept on every line', () => {
  const html = group(page('en'), [{ ...THREE[0], options: [{ key: 'A', label: 'Ship it' }] }, THREE[1]]);
  for (const id of ['ask-1', 'ask-2']) assert.match(html, new RegExp(`href="#/task/ACME-02\\?ask=${id}"`), `${id} deep link`);
  assert.match(html, /data-action="answer"[^>]*data-id="ask-1"[^>]*data-choice="A"/, 'option button');
  assert.match(html, /data-action="answer"[^>]*data-id="ask-2"[^>]*data-verdict="approve"/, 'approve / reject on an ask without options');
});

test('a task with one ask: no fold, no badge, the ask shown with its own label', () => {
  const html = group(page('en'), [THREE[1]]);
  assert.doesNotMatch(html, /<details|<summary|badge/);
  assert.match(html, /<div class="need-group"><a class="need-head" href="#\/task\/ACME-02\?ask=ask-2">/);
  assert.match(html, /<span class="ask-title">Duyệt gói buổi sáng<\/span><\/a>/);
  assert.match(html, /data-action="answer"/);
});

test('Home builds its list from needGroups; the count badge is translated in en, vi and zh', () => {
  assert.match(APP, /LM\.needGroups\(a\.waiting, d\.tasks\)\.map\(needGroupHtml\)/);
  assert.doesNotMatch(APP, /a\.waiting\.map\(w => attentionRow/);
  for (const [l, want] of [['en', '3 items'], ['vi', '3 việc'], ['zh', '3 项']]) assert.equal(LOC[l]['home.nAsks'].replace('{n}', 3), want);
});

test('an auto-step ask shows its text once: the label is the text, so no second copy under it; a clipped label keeps the full body', () => {
  const short = group(page('en'), [ask('ask-9', 'ACME-02', 'ask-10101140', 'Open the   new build', 2)]);
  assert.equal((short.match(/Open the new build/g) || []).length, 1);
  assert.doesNotMatch(short, /class="text md-line|data-action="more"/);
  assert.match(short, /data-action="answer"/, 'the actions stay');
  const long = 'Please open the new build and tell me whether the sky looks right to you, then pick a colour';
  const clipped = group(page('en'), [ask('ask-9', 'ACME-02', 'ask-10101140', long, 2)]);
  assert.match(clipped, new RegExp(`class="text md-line[^>]*>${long}<`), 'the label is cut, so the full text is still shown');
  const real = group(page('en'), [ask('ask-9', 'ACME-02', 'qc', 'Which one?', 2)]);
  assert.match(real, /class="text md-line/, 'a real step title is not the text: the question shows');
});

test('the "Now" line is not shown for a task whose only item is an answer the coordinator has not picked up', () => {
  const unreceived = { kind: 'unreceived', id: 'fb-1', task_id: 'ACME-02', step_id: 'qc', text: 'ok', options: [], rev: 1, from: 'owner', since: new Date(NOW - H).toISOString(), age_ms: H };
  assert.doesNotMatch(group(page('en'), [unreceived]), /class="sit/);
  assert.match(group(page('en'), [unreceived, THREE[1]]), /class="sit/, 'a real wait on the task brings it back');
});

test('task title, label, code and step text are escaped in the group markup', () => {
  const ctx = page('en');
  ctx.S.data.tasks[0] = { id: 'ACME-02', title: '<img src=x onerror=1>"', now: 'n', steps: [{ id: 'ACME-02/qc', label: '<b onclick="x">' }] };
  const html = vm.runInContext(`needGroupHtml(${JSON.stringify(needGroups([ask('a', 'ACME-02', 'qc', 'q', 2), ask('b', 'ACME-02', 'pose', '<script>', 1)], ctx.S.data.tasks)[0])})`, ctx);
  assert.doesNotMatch(html, /<img |<b onclick|<script/);
  assert.match(html, /&lt;img src=x onerror=1&gt;&quot;/);
});
