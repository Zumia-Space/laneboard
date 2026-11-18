// A step's report (its `detail`) was only visible after clicking the step open and nothing marked that it existed (owner 10-15:
// he could not find the ACME-02 Live2D report). (a) a "report" marker on every step row that has a detail; (b) a step that went done
// in the last 48 h and has a detail starts expanded (the user's own collapse wins); (c) #step-<id> / ?step=<id> open the task and
// expand + scroll to the step, like #ask-<id>; (d) the activity feed's "step done" lines link to the step and carry the marker.
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
const { freshReport, stepDoneAt } = globalThis.LaneMeasure;
const H = 3600000, NOW = Date.parse('2026-10-15T12:00:00.000Z');
const ago = h => new Date(NOW - h * H).toISOString();
const rec = (doneH, extra = {}) => ({ done_at: ago(doneH), transitions: [{ at: ago(doneH), from: 'active', to: 'done' }], ...extra });

// ---- (b) the freshness rule, pure ----
test('freshReport: done + non-blank detail + went done within 48 h', () => {
  const s = (state, detail) => ({ state, detail });
  assert.equal(freshReport(s('done', '# Report'), rec(1), NOW), true);
  assert.equal(freshReport(s('done', '# Report'), rec(47.9), NOW), true);
  assert.equal(freshReport(s('done', '# Report'), rec(48.1), NOW), false, 'older than 48 h');
  assert.equal(freshReport(s('done', ''), rec(1), NOW), false, 'no detail');
  assert.equal(freshReport(s('done', '  \n '), rec(1), NOW), false, 'blank detail');
  assert.equal(freshReport(s('done'), rec(1), NOW), false);
  assert.equal(freshReport(s('active', 'x'), rec(1), NOW), false, 'not done');
  assert.equal(freshReport(s('done', 'x'), undefined, NOW), false, 'no time record');
  assert.equal(freshReport(s('done', 'x'), { done_at: ago(-1) }, NOW), false, 'a done time in the future is not trusted');
});

test('stepDoneAt: the newest transition into done wins over the first done_at (a reopened and re-done step)', () => {
  const r = { done_at: ago(100), transitions: [{ at: ago(100), to: 'done' }, { at: ago(50), to: 'active' }, { at: ago(2), to: 'done' }] };
  assert.equal(stepDoneAt(r), ago(2));
  assert.equal(stepDoneAt({ done_at: ago(7) }), ago(7));
  assert.equal(stepDoneAt(undefined), '');
  assert.equal(freshReport({ state: 'done', detail: 'x' }, r, NOW), true, 're-done 2 h ago is fresh though first done 100 h ago');
});

// ---- the page, lifted from app.js into a vm ----
function lift(name) {
  const line = APP.match(new RegExp(`^const ${name} = .*;$`, 'm'));
  if (line) return line[0];
  const start = APP.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `app.js has no ${name}`);
  const eol = APP.indexOf('\n', start);
  if (APP.slice(start, eol).endsWith('}')) return APP.slice(start, eol); // a one-line function
  return APP.slice(start, APP.indexOf('\n}\n', start) + 2);
}
const escHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const step = (taskId, id, state, label, detail) => ({ id: `${taskId}/${id}`, label, state, zone: 'build', rev: 1, ...(detail ? { detail } : {}) });
const TASKS = [
  { id: 'ACME-02', title: 'Zumi avatar', status: 'doing', steps: [
    step('ACME-02', 'live2d', 'done', 'Live2D rig', '# Live2D report\nrig ok'),
    step('ACME-02', 'old', 'done', 'Old step', '# Old report'),
    step('ACME-02', 'plain', 'done', 'No report step'),
    step('ACME-02', 'next', 'active', 'Next step', 'working notes')] },
  { id: 'L-01', title: 'Game', status: 'doing', steps: [step('L-01', 'live2d', 'todo', 'Same id elsewhere'), step('L-01', 'plan', 'done', 'Plan', 'p')] }
];
const TIMES = { 'ACME-02/live2d': rec(5), 'ACME-02/old': rec(100), 'ACME-02/plain': rec(3), 'ACME-02/next': { first_seen_at: ago(9), transitions: [] }, 'L-01/plan': rec(1) };
function page(lang = 'en', { open = {}, hash = '', paintedTask = '' } = {}) {
  const S = { dict: LOC[lang], en: LOC.en, open, paintedTask, ctxTab: '', stepFocus: '', loadedAt: Date.now(), errors: {}, galleryNavs: {}, hl: null, compose: {},
    data: { now: new Date(Date.now()).toISOString(), tasks: TASKS, times: TIMES, asks: [], messages: [], plans: {}, feedback: [], me: { role: 'owner' } } };
  const ctx = vm.createContext({ S, location: { hash }, esc: escHtml, window: { LaneMeasure: globalThis.LaneMeasure }, Date, URLSearchParams,
    isOwner: () => true, isLead: () => true, fmtDur: ms => Math.round(ms / H) + 'h', fmtTime: x => String(x).slice(11, 16), askedBy: x => x, askSinceOf: a => a.attribution.created_at,
    violationsBox: () => '', stepTime: () => '', mdBlock: text => `<div class="md">${escHtml(text)}</div>`, mdRead: text => `<div class="md">${escHtml(text)}</div>`, mdInline: escHtml, statusChip: () => '', taskStatusSelect: () => '', measured: () => '', historyCard: () => '',
    refsOf: s => ({ body: s || '', images: [], links: [] }), refsHtml: () => '', store: { set() {}, get() { return ''; } } });
  vm.runInContext(['t', 'serverNow', 'LM', 'STEPS_SHOWN', 'STEP_STATES', 'STEP_ICON', 'stepPin', 'safeDecode', 'findStep', 'stepIsOpen', 'setCtxTab', 'showStepReport',
    'route', 'stepsByRecency', 'stepsPanel', 'stepHistory', 'msgsOf', 'asksOf', 'streamEntries'].map(lift).join('\n'), ctx);
  return ctx;
}
// the fixture's clock is the real clock: shift the recorded times so that "NOW" in the fixture is the real now
const shifted = () => {
  const d = Date.now() - NOW;
  const mv = r => JSON.parse(JSON.stringify(r), (k, v) => (typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) ? new Date(Date.parse(v) + d).toISOString() : v));
  return Object.fromEntries(Object.entries(TIMES).map(([k, r]) => [k, mv(r)]));
};
function livePage(lang, opts) { const ctx = page(lang, opts); ctx.S.data.times = shifted(); return ctx; }
const panel = (lang, opts) => vm.runInContext('stepsPanel(S.data.tasks[0])', livePage(lang, opts));
const rowOf = (html, sid) => html.match(new RegExp(`<div class="srow [^"]*" id="step-${sid}">`))[0];

// ---- (a) the marker ----
test('(a) every step row with a detail shows the report marker; a row without one does not', () => {
  const html = panel();
  const markerIn = sid => new RegExp(`id="step-${sid}">[\\s\\S]*?</button>`).exec(html)[0];
  for (const sid of ['live2d', 'old', 'next']) assert.match(markerIn(sid), /<span class="srep">📄 report<\/span>/, `${sid} has a detail`);
  assert.doesNotMatch(markerIn('plain'), /srep/, 'no detail, no marker');
});

test('(a) the marker is translated (en / vi / zh) and the key exists in all three locales', () => {
  for (const [lang, word] of [['en', 'report'], ['vi', 'báo cáo'], ['zh', '报告']]) {
    assert.equal(LOC[lang]['step.report'], word);
    assert.match(panel(lang), new RegExp(`📄 ${word}</span>`));
  }
});

// ---- (b) expanded by default ----
test('(b) a fresh done step with a detail starts expanded; an old one, a step with no detail and an active one start folded', () => {
  const html = panel();
  assert.match(rowOf(html, 'live2d'), /class="srow done\s+open"/, 'fresh report open');
  assert.match(html, /<div class="md"># Live2D report\nrig ok<\/div>/, 'the report text is on the page');
  for (const sid of ['old', 'plain', 'next']) assert.doesNotMatch(rowOf(html, sid), /\bopen\b/, `${sid} folded`);
  assert.doesNotMatch(html, /# Old report/);
});

test("(b) the user's collapse is remembered through S.open; so is an explicit open of an old report", () => {
  const folded = panel('en', { open: { 'sd-ACME-02/live2d': false } });
  assert.doesNotMatch(rowOf(folded, 'live2d'), /\bopen\b/);
  assert.doesNotMatch(folded, /# Live2D report/);
  assert.match(panel('en', { open: { 'sd-ACME-02/old': true } }), /# Old report/);
});

test('(b) the click toggles the EFFECTIVE state: the first click on a fresh report folds it', () => {
  assert.match(APP, /S\.open\[k\] = !\(s \? stepIsOpen\(s\) : S\.open\[k\]\)/, 'step-open reads stepIsOpen, not the raw S.open');
  const ctx = livePage();
  const fresh = 'stepIsOpen(S.data.tasks[0].steps[0])';
  assert.equal(vm.runInContext(fresh, ctx), true);
  ctx.S.open['sd-ACME-02/live2d'] = !vm.runInContext(fresh, ctx); // what the handler does
  assert.equal(vm.runInContext(fresh, ctx), false);
});

// ---- (c) deep link ----
test('(c) #step-<id>, #step-<task>/<id> and ?step=<id> route to the task with that step', () => {
  const r = (hash, opts = {}) => ({ ...vm.runInContext('route()', page('en', { hash, ...opts })) });
  assert.deepEqual(r('#step-live2d'), { view: 'task', id: 'ACME-02', ask: '', msg: '', step: 'live2d' }, 'bare id: the first task that has it');
  assert.equal(r('#step-plan').id, 'L-01', 'a bare id only L-01 has');
  assert.equal(r('#step-live2d', { paintedTask: 'L-01' }).id, 'L-01', 'the task on screen first');
  assert.deepEqual(r('#step-L-01/live2d'), { view: 'task', id: 'L-01', ask: '', msg: '', step: 'live2d' });
  assert.equal(r('#step-ACME-02%2Fold').step, 'old', 'encoded slash');
  assert.deepEqual(r('#/task/ACME-02?step=old'), { view: 'task', id: 'ACME-02', ask: '', msg: '', step: 'old' });
  assert.equal(r('#step-nope').view, 'home', 'unknown step: home, like an unknown ask');
  assert.equal(r('#step-ACME-02/nope').view, 'home');
  assert.equal(r('#L-01').id, 'L-01', 'the short task link still works');
  assert.equal(r('#step-%E0%A4%A').view, 'home', 'malformed escape does not throw');
});

test('(c) the deep link opens the Steps tab, expands the step (even an old one), then scrolls once (mirrors #ask)', () => {
  const ctx = livePage();
  vm.runInContext("showStepReport('ACME-02', 'old')", ctx);
  assert.equal(ctx.S.ctxTab, 'steps');
  assert.equal(ctx.S.open['sd-ACME-02/old'], true);
  assert.equal(ctx.S.open['steps-all-ACME-02'], true, 'an older step is not hidden behind "older"');
  assert.equal(ctx.S.stepFocus, 'old');
  assert.match(vm.runInContext('stepsPanel(S.data.tasks[0])', ctx), /# Old report/);
  // render(): the link is consumed (URL rewritten to the plain task) like #ask; afterTaskPaint scrolls to the row and flashes it
  assert.match(APP, /if \(S\.data && r\.step\) \{[^}]*showStepReport\(r\.id, r\.step\);[^}]*history\.replaceState\(null, '', '#\/task\/' \+ encodeURIComponent\(r\.id\)\)/);
  assert.match(APP, /if \(S\.stepFocus\) \{ const e = document\.getElementById\('step-' \+ S\.stepFocus\); if \(e\) \{ e\.scrollIntoView\(\{ block: 'center' \}\); e\.classList\.add\('flash'\); \} S\.stepFocus = ''; \}/);
  assert.match(fs.readFileSync(path.join(PUB, 'styles.css'), 'utf8'), /\.srow\.flash \{ animation: flash/);
});

// ---- (d) the activity feed ----
test('(d) a "step done" feed line is a button into the step, and carries the marker only when the step has a detail', () => {
  const html = vm.runInContext('streamEntries(S.data.tasks[0])', livePage());
  const line = sid => new RegExp(`<div class="ev sys" data-step="${sid}">[\\s\\S]*?</div></div>`).exec(html)[0];
  assert.match(line('live2d'), /<button type="button" class="linkish" data-action="step-link" data-task="ACME-02" data-step="live2d">/);
  assert.match(line('live2d'), /Step 1/);
  assert.match(line('live2d'), /<span class="srep">📄 report<\/span>/, 'marker on a step with a detail');
  assert.doesNotMatch(line('plain'), /srep/, 'no detail, no marker');
  assert.match(line('plain'), /data-action="step-link"[^>]*data-step="plain"/, 'still a link');
});

test('(d) the feed link uses the same handler as the deep link', () => {
  assert.match(APP, /if \(action === 'step-link'\) \{ showStepReport\(b\.dataset\.task, b\.dataset\.step\); return render\(\); \}/);
});

// ---- (b2) a fresh report is never folded away behind "older" ----
test('(b2) with 7 open steps filling the first rows, a fresh done-with-detail step is still shown without the toggle', () => {
  const open7 = [1, 2, 3, 4, 5, 6, 7].map(n => step('ACME-02', 'o' + n, 'active', 'Open ' + n));
  const olds = [1, 2, 3].map(n => step('ACME-02', 'd' + n, 'done', 'Old done ' + n, '# old ' + n));
  const fresh = step('ACME-02', 'fresh', 'done', 'Fresh report', '# Fresh report body');
  const t31 = { id: 'ACME-02', title: 'Zumi', status: 'doing', steps: [...olds, fresh, ...open7] };
  const times = { 'ACME-02/fresh': rec(5), ...Object.fromEntries(olds.map((s, i) => [s.id, rec(100 + i)])) };
  const ctx = page();
  ctx.S.data.tasks = [t31]; ctx.S.data.times = Object.fromEntries(Object.entries(times).map(([k, r]) => [k, JSON.parse(JSON.stringify(r), (_, v) => (typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) ? new Date(Date.parse(v) + Date.now() - NOW).toISOString() : v))]));
  const html = vm.runInContext('stepsPanel(S.data.tasks[0])', ctx);
  assert.match(html, /id="step-fresh"/, 'the fresh report row is on the page');
  assert.match(html, /# Fresh report body/, 'and expanded');
  assert.doesNotMatch(html, /id="step-d1"/, 'older done steps still fold');
  assert.match(html, /data-action="steps-all"/, 'the toggle remains for the older ones');
  assert.match(html, /Show \d+ older|older/i);
  const ids = [...html.matchAll(/class="srow [^"]*" id="step-([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(ids, ['o1', 'o2', 'o3', 'o4', 'o5', 'o6', 'o7', 'fresh'], 'open steps first in board order, then the fresh report');
});
