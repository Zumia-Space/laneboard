// The page never shows a raw journal op name (task.create, times.import, ...) in a task's history, a refused save's
// toast says what was refused instead of ending on a colon, and on a phone the rail folds into a menu drawer.
// app.js is a browser script, so the pieces under test are lifted out of it and run in a vm with the real locales.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { OPS } from '../src/ops.mjs';
import { startSeeded, OWNER } from './helpers.mjs';

const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const APP = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');
const CSS = fs.readFileSync(path.join(PUB, 'styles.css'), 'utf8');
const load = l => JSON.parse(fs.readFileSync(path.join(PUB, 'locales', `${l}.json`), 'utf8'));
const LOC = { en: load('en'), vi: load('vi'), zh: load('zh') };
const RAW_OP = new RegExp(`\\b(?:${Object.keys(OPS).map(o => o.replace('.', '\\.')).join('|')})\\b`);

/** A top-level `const name = ...;` line or `function name(...) {...}` block of app.js, verbatim. */
function lift(name) {
  const line = APP.match(new RegExp(`^const ${name} = .*;$`, 'm'));
  if (line) return line[0];
  const start = APP.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `app.js has no ${name}`);
  return APP.slice(start, APP.indexOf('\n}\n', start) + 2);
}
function page(lang, extra = {}) {
  const ctx = vm.createContext({ S: { dict: LOC[lang], en: LOC.en, open: {}, history: {} }, esc: s => String(s), ago: () => '1m', ...extra });
  vm.runInContext(['t', 'opLabel', 'refusedToast', 'STEPS_SHOWN', 'historyCard'].map(lift).join('\n'), ctx);
  return ctx;
}

test('every journal op has a short label in every locale, and no label is left for an op that no longer exists', () => {
  for (const [lang, loc] of Object.entries(LOC)) {
    for (const op of Object.keys(OPS)) {
      const label = loc['op.' + op];
      assert.ok(label, `${lang}: missing op.${op}`);
      assert.doesNotMatch(label, RAW_OP, `${lang}: op.${op} is still the raw op name`);
    }
    const stale = Object.keys(loc).filter(k => k.startsWith('op.') && !(k.slice(3) in OPS));
    assert.deepEqual(stale, [], `${lang}: labels for unknown ops`);
  }
  assert.equal(LOC.vi['op.task.create'], 'tạo task');
  assert.equal(LOC.vi['op.times.import'], 'nhập từ bảng cũ');
});

test('opLabel: page language first, English next, and an op this build does not know stays readable as itself', () => {
  const vi = page('vi');
  assert.equal(vm.runInContext(`opLabel('task.create')`, vi), 'tạo task');
  assert.equal(vm.runInContext(`opLabel('times.import')`, vi), 'nhập từ bảng cũ');
  assert.equal(vm.runInContext(`opLabel('future.op')`, vi), 'future.op');
});

test('history card: a real task journal (every kind of event on it) renders with no raw op name', async () => {
  const s = await startSeeded();
  try {
    const at = '2026-09-27T01:00:00.000Z';
    const rec = { first_seen_at: at, started_at: at, last_state: 'active', waiting_total_ms: 0, transitions: [] };
    const ok = r => assert.equal(r.status, 200, JSON.stringify(r.body));
    ok(await s.write(OWNER, 'times.import', 'WEB-3', { task: { first_seen_at: at }, steps: { s2: rec } }));
    ok(await s.write(s.coord, 'step.create', 'WEB-3/s4', { label: 'Ship', zone: 'build', state: 'todo' }));
    ok(await s.write(s.coord, 'step.delete', 'WEB-3/s4', {}, { expected_revision: s.board.state.steps['WEB-3/s4'].rev }));
    ok(await s.write(OWNER, 'feedback.add', 'WEB-3', { kind: 'note', text: 'Looks good' }));
    ok(await s.write(s.coord, 'task.update', 'WEB-3', { title: 'Landing page v2' }, { expected_revision: s.board.state.tasks['WEB-3'].rev }));
    const evs = s.board.events(OWNER, 0, 1000, { task: 'WEB-3' });
    assert.ok(evs.some(e => e.op === 'task.create') && evs.some(e => e.op === 'times.import') && evs.some(e => e.op === 'step.delete'));
    for (const lang of ['vi', 'en', 'zh']) {
      const ctx = page(lang);
      ctx.S.history['WEB-3'] = evs;
      const html = vm.runInContext(`historyCard({ id: 'WEB-3' })`, ctx);
      const items = [...html.matchAll(/<li[^>]*>(.*?)<\/li>/g)].map(m => m[1].replace(/<[^>]+>/g, ''));
      assert.equal(items.length, evs.length);
      for (const item of items) assert.doesNotMatch(item, RAW_OP, `${lang}: ${item}`);
      if (lang === 'vi') {
        assert.ok(items.some(i => i.endsWith('· tạo task')), items.join('\n'));
        assert.ok(items.some(i => i.endsWith('· nhập từ bảng cũ')), items.join('\n'));
        assert.ok(items.some(i => i.endsWith('· xoá bước s4')), 'a step event names the step, not the whole target id');
        assert.ok(items.every(i => !/WEB-3$/.test(i)), 'a task-level event does not repeat the task id');
      }
    }
  } finally { await s.close(); }
});

test('refused-save toast: one violation is spelled out, several are counted and pointed at the inline list', () => {
  const vi = page('vi'), en = page('en');
  const one = [{ error: 'waiting_status_without_ask', task: 'QC-1' }];
  const msg1 = vm.runInContext(`refusedToast(${JSON.stringify(one)})`, vi);
  assert.equal(msg1, 'Chưa lưu — ' + LOC.vi['rule.waiting_status_without_ask'].replace('{task}', 'QC-1'));
  assert.doesNotMatch(msg1, /:\s*$/);
  const two = [{ error: 'waiting_before_done', step: 's2' }, { error: 'invalid_step_state', step: 's3', state: 'x' }];
  const msg2 = vm.runInContext(`refusedToast(${JSON.stringify(two)})`, vi);
  assert.match(msg2, /phạm 2 luật/);
  assert.match(msg2, /ngay dưới ô vừa sửa/);
  assert.match(vm.runInContext(`refusedToast(${JSON.stringify(two)})`, en), /breaks 2 board rules\. They are listed in red/);
  assert.match(APP, /toast\(refusedToast\(out\.violations\)\)/, 'write() uses it for a refusal with violations');
  assert.doesNotMatch(APP, /toast\(t\('rule\.refused'\)\)/);
});

test('phone: the rail is a top bar with a menu button; its body is a drawer that closes on navigation', () => {
  assert.match(APP, /function railShell\(/);
  assert.equal((APP.match(/railShell\(/g) || []).length, 3, 'both rails (signed in and sign-in) go through railShell');
  assert.match(APP, /if \(action === 'menu'\) \{ S\.open\.menu = !S\.open\.menu; return render\(\); \}/);
  assert.match(APP, /S\.open\.rail = false; S\.open\.menu = false;/, 'a route change closes the drawer');
  assert.match(APP, /\{ S\.open\.menu = false; return go\(nav\.dataset\.go\); \}/, 'a nav tap closes it even on the same route');
  // Desktop: button hidden, body lays out as part of the rail. Phone: body hidden until the menu is open.
  assert.match(CSS, /^\.menu-btn \{ display: none; \}$/m);
  assert.match(CSS, /^\.rail-body \{ display: contents; \}/m);
  const phone = CSS.split('@media (max-width: 640px)').slice(1).join(''); // every phone block
  assert.match(phone, /\.rail-body \{ display: none; \}/);
  assert.match(phone, /\.rail\.menu-open \.rail-body \{ display: flex;/);
  assert.match(phone, /\.menu-btn \{ display: inline-flex;/);
  for (const loc of Object.values(LOC)) assert.ok(loc['nav.menu'] && loc['nav.menuClose']);
});

test('owner block: wait colour is plain under a day, amber over a day, red over three days; rail titles stay one line', () => {
  const ctx = vm.createContext({});
  vm.runInContext(lift('waitTone'), ctx);
  const h = 3600000, tone = ms => vm.runInContext(`waitTone(${ms})`, ctx);
  assert.deepEqual([tone(0), tone(23 * h), tone(24 * h), tone(24 * h + 1), tone(72 * h), tone(72 * h + 1), tone(200 * h)], ['', '', '', 'warn', 'warn', 'late', 'late']);
  assert.match(lift('attentionRow'), /class="\$\{waitTone\(w\.age_ms\)\}"/, 'the waited time is coloured by waitTone');
  assert.match(CSS, /\.row \.sub \.warn \{ color: var\(--warn\);/);
  assert.match(CSS, /\.lrow \.ttl \{[^}]*white-space: nowrap;/, 'a left-list task title is one line with an ellipsis');
  assert.match(lift('renderRail'), /title="\$\{esc\(`\$\{task\.id\} \$\{task\.title\}`\)\}"/, 'the full title is the tooltip');
});

test('activity view: every op is named with the history labels (one label map), the raw op only in the tooltip', () => {
  for (const lang of ['vi', 'en', 'zh']) {
    const ctx = page(lang);
    vm.runInContext(lift('activityRow'), ctx);
    for (const op of Object.keys(OPS)) {
      const ev = { at: '2026-10-01T00:00:00Z', op, target_id: 'WEB-3/s2', actor: { name: 'coordinator', role: 'coordinator' } };
      const html = vm.runInContext(`activityRow(${JSON.stringify(ev)})`, ctx);
      const visible = html.replace(/<[^>]+>/g, ' ');
      assert.doesNotMatch(visible, RAW_OP, `${lang}: ${op}`);
      assert.ok(visible.includes(LOC[lang]['op.' + op]), `${lang}: ${op} uses its label`);
      assert.match(html, new RegExp(`title="${op.replace('.', '\.')}"`));
    }
  }
  assert.match(APP, /events\.reverse\(\)\.map\(activityRow\)/);
});

test('owner block: the card header (code chip + task title) is one link to the task, with a visible focus ring', () => {
  const row = lift('attentionRow');
  assert.match(row, /<a class="ask-head" href="\$\{esc\(href\)\}"/);
  assert.match(row, /<span class="code">\$\{esc\(w\.task_id\)\}/, 'the chip is inside the link, not a link of its own');
  assert.match(CSS, /\.ask-head:focus-visible \{ outline: 2px solid var\(--focus\);/);
});

test('composer: one per task, five kind chips, a scope select (task / open asks / steps), a 6-line box and one send button; no footer send bar', () => {
  const stored = {};
  const ctx = vm.createContext({ S: { dict: LOC.vi, en: LOC.en, compose: {}, composeFiles: {}, data: { asks: [{ id: 'ask-7', task_id: 'T-1', status: 'open', text: 'QC xong chưa?', step_id: 's2' }, { id: 'ask-8', task_id: 'T-1', status: 'answered', text: 'old' }] } },
    esc: s => String(s), isOwner: () => true, store: { get: k => stored[k] || '', set: (k, v) => { stored[k] = v; } } });
  vm.runInContext(['t', 'OWNER_KINDS', 'asksOf', 'compose', 'saveDraft', 'thumbsHtml', 'composer'].map(lift).join('\n'), ctx);
  const task = { id: 'T-1', steps: [{ id: 'T-1/s1', label: 'Build' }, { id: 'T-1/s2', label: 'QC' }] };
  vm.runInContext(`compose('T-1').scope = 'ask:ask-7'`, ctx);
  const html = vm.runInContext(`composer(${JSON.stringify(task)})`, ctx);
  const chips = [...html.matchAll(/role="radio"[^>]*data-kind="(\w+)"[^>]*>([^<]+)</g)].map(m => [m[1], m[2]]);
  assert.deepEqual(chips, [['approve', 'Duyệt'], ['reject', 'Chưa đạt'], ['redirect', 'Đổi hướng'], ['askback', 'Hỏi lại'], ['note', 'Ghi chú']]);
  assert.match(html, /aria-checked="true" data-action="compose-kind" data-task="T-1" data-kind="note"/, 'Ghi chú is the default');
  assert.match(html, /<textarea name="text" rows="3"/, '3 lines while empty; CSS grows it to 6 on focus or content');
  assert.match(CSS, /\.composer textarea:placeholder-shown:not\(:focus\) \{ min-height: calc\(3 \* 1\.5em \+ 14px\)/);
  assert.equal((html.match(/<button class="btn primary">/g) || []).length, 1);
  assert.match(html, />Gửi cho CoS</);
  const opts = [...html.matchAll(/<option value="([^"]*)"( selected)?/g)].map(m => m[1] + (m[2] ? '*' : ''));
  assert.deepEqual(opts, ['', 'ask:ask-7*', 'step:s1', 'step:s2'], 'task, the open ask (preset), each step; an answered ask is not offered');
  // autosave: the draft goes to storage per task, and an empty draft is removed
  vm.runInContext(`compose('T-1').text = 'nháp'; saveDraft('T-1')`, ctx);
  assert.equal(JSON.parse(stored['draft.T-1']).text, 'nháp');
  vm.runInContext(`compose('T-1').text = ''; saveDraft('T-1')`, ctx);
  assert.equal(stored['draft.T-1'], '');
  assert.doesNotMatch(APP, /function sendBar|send-ping|data-form="answer"|data-form="feedback"/, 'no footer send bar, no per-card reply box, no second composer');
  assert.match(APP, /e\.key === 'Enter' && \(e\.ctrlKey \|\| e\.metaKey\) && e\.target\.dataset\?\.composeText/, 'Ctrl+Enter sends');
  for (const loc of Object.values(LOC)) assert.ok(!('feedback.save' in loc) && !('send.button' in loc));
});

test('Chờ bạn: an ask row links to its task with the composer scoped to it; an unacknowledged answer links to that message', () => {
  const ctx = vm.createContext({});
  vm.runInContext(lift('askHref'), ctx);
  assert.equal(vm.runInContext(`askHref({ kind: 'ask', id: 'ask-23', task_id: 'ACME-01' })`, ctx), '#/task/ACME-01?ask=ask-23');
  assert.equal(vm.runInContext(`askHref({ kind: 'unreceived', id: 'fb-470', task_id: 'H-03' })`, ctx), '#/task/H-03?msg=fb-470');
  assert.equal(vm.runInContext(`askHref({ kind: 'step', id: 'T/s1', task_id: 'T' })`, ctx), '#/task/T');
  assert.match(lift('attentionRow'), /const href = askHref\(w\)/);
  assert.match(lift('renderRail'), /href="\$\{esc\(askHref\(w\)\)\}"/, 'the left CẦN ANH rows open the same place');
  assert.match(lift('route'), /q\.get\('ask'\)/);
  assert.match(lift('render'), /if \(r\.ask\) focusAsk\(r\.id, r\.ask\)/);
});

test('one status vocabulary; the task list shows the task status read only; the popover flips up; Tình hình folds', () => {
  for (const [lang, words] of Object.entries({ en: ['Active', 'Waiting on owner', 'Blocked', 'Paused', 'Done'], vi: ['Đang làm', 'Chờ anh', 'Bị chặn', 'Tạm dừng', 'Xong'] })) {
    assert.deepEqual(['doing', 'waiting', 'blocked', 'paused', 'closed'].map(k => LOC[lang]['status.' + k]), words, `${lang}: header select, right pane and chips share these`);
    assert.ok(!Object.keys(LOC[lang]).some(k => k.startsWith('status.pick.')), 'no second vocabulary');
  }
  assert.match(LOC.en['left.needsTip.one'], /^1 question waiting — status stays \{status\}$/);
  // the registry page: no status control, the task's own status as a link to the task
  const reg = lift('renderRegistry');
  assert.doesNotMatch(reg, /<select|data-registry/);
  assert.match(reg, /<a class="reg-status" href="#\/task\/\$\{encodeURIComponent\(task\.id\)\}"[^>]*>\$\{statusChip\(task\.status\)\}<\/a>/);
  assert.doesNotMatch(APP, /dataset\.registry/, 'no registry status writes from the page');
  const ctx = vm.createContext({ S: { dict: LOC.en, en: LOC.en, regFilter: 'all', regQuery: '', data: { tasks: [{ id: 'ACME-01', status: 'paused', worker: null }], docs: { registry: { rev: 3, entries: [{ id: 'r1', code: 'ACME-01', title: 'Workspace', status: 'doing', on_board: true }, { id: 'r2', code: 'X-9', title: 'Archive', status: 'closed', on_board: false }] } } } },
    esc: s => String(s), isOwner: () => true, isLead: () => true, goalOf: () => ({}), mdInline: s => s, workerChip: () => '' });
  vm.runInContext(['t', 'TASK_STATUS', 'REG_STATUS', 'statusChip', 'renderRegistry'].map(lift).join('\n'), ctx);
  const html = vm.runInContext('renderRegistry()', ctx);
  assert.match(html, /<h2>Paused <span class="badge">1<\/span><\/h2>.*ACME-01/s, 'ACME-01 is listed under its task status (paused), not the registry word (doing)');
  assert.doesNotMatch(html, /<select/);
  assert.match(CSS, /\.st-pop\.up \{ top: auto; bottom: 100%; \}/);
  assert.match(APP, /if \(r\.bottom > window\.innerHeight - 4\) pop\.classList\.add\('up'\);/);
  assert.match(lift('situationCard'), /const more = open \?/, 'Next / Milestone / Updated only when opened');
});
