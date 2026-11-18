// J-05 route-override badge and step history: the allowance is visible where the owner reads the board.
// The page functions are lifted out of public/app.js and run in a vm with the real locale files, as ui-labels does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const APP = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');
const load = l => JSON.parse(fs.readFileSync(path.join(PUB, 'locales', `${l}.json`), 'utf8'));
const LOC = { en: load('en'), vi: load('vi'), zh: load('zh') };

/** A top-level `const name = ...;` line or `function name(...) {...}` block of app.js, verbatim. */
function lift(name) {
  const line = APP.match(new RegExp(`^const ${name} = .*;$`, 'm'));
  if (line) return line[0];
  const start = APP.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `app.js has no ${name}`);
  return APP.slice(start, APP.indexOf('\n}\n', start) + 2);
}
const NOW = Date.parse('2026-05-01T09:00:00.000Z'); // 16:00 VN, 01-05
function page(lang, data) {
  const sandbox = { S: { dict: LOC[lang], en: LOC.en, data }, mdInline: s => String(s), fmtTime: ts => ts, serverNow: () => NOW };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(['esc', 't', 'VN_MS', 'vnDate', 'vnHM', 'vnDay', 'vnWhen', 'activeOverride', 'overrideBadge', 'msgsOf', 'stepHistory', 'openOwnerFeedback'].map(lift).join('\n'), ctx);
  return ctx;
}
const ACTIVE = { model: 'sonnet', reason: 'Ưu tiên việc gấp', by: 'cos', at: '2026-05-01T09:00:00.000Z', expires: '2026-05-02T09:00:00.000Z', expired: false };
const state = (o, messages = []) => ({ route_override: o ? { 'WEB-3': o } : {}, messages });

test('the header badge is on the task while the allowance holds, with the full text and reason as its tooltip', () => {
  for (const lang of ['en', 'vi', 'zh']) {
    const p = page(lang, state(ACTIVE));
    const html = vm.runInContext(`overrideBadge({ id: 'WEB-3' })`, p);
    assert.match(html, /data-override="sonnet"/, `${lang}: ${html}`);
    const full = LOC[lang]['override.badge'].replace('{time}', '16:00 02-05') + ' · Ưu tiên việc gấp';
    assert.ok(html.includes(`title="${full}"`), `${lang}: the tooltip is the full text plus the reason (${html})`);
    assert.ok(html.includes(LOC[lang]['override.badge'].replace('{time}', '16:00 02-05')), `${lang}: ${html}`);
    assert.ok(!html.includes('ovr-c'), `${lang}: the header keeps the full chip`);
  }
});

test('the left-list row carries only a compact badge, so the task title keeps its width', () => {
  const p = page('vi', state(ACTIVE));
  const html = vm.runInContext(`overrideBadge({ id: 'WEB-3' }, true)`, p);
  assert.match(html, /class="chip info ovr ovr-c"/, html);
  assert.ok(html.includes('>S</span>'), 'one letter, not the whole sentence');
  assert.match(html, /aria-label="Sonnet đến 16:00 02-05 · Ưu tiên việc gấp"/, 'the accessible name is the full text');
  assert.match(html, /title="Sonnet đến 16:00 02-05 · Ưu tiên việc gấp"/, 'the tooltip is the full text');
  assert.ok(!html.includes('Sonnet đến 16:00 02-05</span>'), 'the full text is not printed in the row');
});

test('no badge once the allowance has expired, was cleared, or never existed', () => {
  const expired = page('vi', state({ ...ACTIVE, expired: true }));
  assert.equal(vm.runInContext(`overrideBadge({ id: 'WEB-3' })`, expired), '', 'expired entry draws nothing');
  const cleared = page('vi', state(null));
  assert.equal(vm.runInContext(`overrideBadge({ id: 'WEB-3' })`, cleared), '', 'a cleared entry draws nothing');
  const other = page('vi', state(ACTIVE));
  assert.equal(vm.runInContext(`overrideBadge({ id: 'API-2' })`, other), '', 'another task draws nothing');
});

test('the badge time is the Vietnam clock the server note prints, with the date once it is not today', () => {
  const p = page('vi', state(ACTIVE));
  assert.equal(vm.runInContext(`vnHM('2026-05-02T09:00:00.000Z')`, p), '16:00');
  assert.equal(vm.runInContext(`vnHM('2026-05-01T17:05:00.000Z')`, p), '00:05');
  assert.equal(vm.runInContext(`vnHM('not a date')`, p), '');
  assert.equal(vm.runInContext(`vnWhen('2026-05-01T10:30:00.000Z')`, p), '17:30', 'still today: time only');
  assert.equal(vm.runInContext(`vnWhen('2026-05-02T09:00:00.000Z')`, p), '16:00 02-05', 'tomorrow: the date too');
  assert.equal(vm.runInContext(`vnWhen('2026-05-01T16:30:00.000Z')`, p), '23:30', 'late today is still today on the VN clock');
  assert.equal(vm.runInContext(`vnWhen('2026-05-01T17:30:00.000Z')`, p), '00:30 02-05', 'the VN day rolls at 17:00 UTC');
});

test('the CoS note is informational: not counted as owner feedback and never marked handled', () => {
  const by = { created_by: { name: 'CoS', role: 'owner' } };
  const note = { id: 'fb-9', task_id: 'WEB-3', scope: { step_id: 's2' }, kind: 'note', info: true, attribution: by, body: 'CoS cho Sonnet làm: Ưu tiên việc gấp', ts: NOW, status: 'open' };
  const ask = { ...note, id: 'fb-10', info: undefined, body: 'a real owner note' };
  const p = page('vi', { route_override: {}, messages: [note, ask], feedback: [note, ask] });
  assert.equal(vm.runInContext(`openOwnerFeedback('WEB-3').length`, p), 1, 'only the note without info counts');
  assert.equal(vm.runInContext(`openOwnerFeedback('WEB-3')[0].id`, p), 'fb-10');
});

test('the step detail shows the messages scoped to that step, the override note among them', () => {
  const note = { id: 'fb-9', task_id: 'WEB-3', scope: { step_id: 's2' }, kind: 'note', author: { name: 'CoS' }, body: 'CoS cho Sonnet làm: Ưu tiên việc gấp, hết hạn 16:00 02-05 giờ VN', ts: '2026-05-01T09:00:00.000Z', status: 'open' };
  const other = { ...note, id: 'fb-10', scope: { step_id: 's1' }, body: 'an older note' };
  const p = page('vi', state(ACTIVE, [other, note]));
  const html = vm.runInContext(`stepHistory({ id: 'WEB-3' }, 's2')`, p);
  assert.match(html, /Lịch sử bước/, 'the history heading');
  assert.ok(html.includes('CoS cho Sonnet làm: Ưu tiên việc gấp'), 'the override note is beside its step');
  assert.ok(!html.includes('an older note'), 'a note on another step stays there');
  assert.equal(vm.runInContext(`stepHistory({ id: 'WEB-3' }, 's9')`, p), '', 'a step with no messages has no history');
});

test('the override badge and the step history are translated in en, vi and zh', () => {
  for (const lang of ['en', 'vi', 'zh']) {
    assert.equal(typeof LOC[lang]['override.badge'], 'string');
    assert.equal(typeof LOC[lang]['step.history'], 'string');
    assert.match(LOC[lang]['override.badge'], /\{time\}/);
  }
  assert.equal(LOC.en['override.badge'], 'Sonnet until {time}');
  assert.equal(LOC.vi['override.badge'], 'Sonnet đến {time}');
  assert.notEqual(LOC.zh['override.badge'], LOC.en['override.badge']);
  assert.notEqual(LOC.vi['step.history'], LOC.en['step.history']);
});
