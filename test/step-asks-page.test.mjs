// J-05 part 1 step 5: the page shows one ask per waiting owner step. The composer offers one scope per OPEN ask (answered
// and cleared asks are offered nowhere), an open ask card keeps its "answer" link that scopes the composer to that ask, and
// a card names its step as a link to that step's row (the action the stream's "step done" lines already use).
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
const step = (id, label) => ({ id: `V-5/${id}`, label, state: 'waiting', zone: 'owner', rev: 1 });
const TASK = { id: 'V-5', title: 'Five', status: 'waiting', steps: [step('a', 'Design'), step('b', 'Copy'), step('c', 'Ship')] };
const ASK = (id, stepId, status, text) => ({ id, task_id: 'V-5', status, text, attribution: { created_at: '2026-10-20T08:00:00.000Z', created_by: 'cos' },
  ...(stepId ? { step_id: stepId } : {}), ...(status === 'answered' ? { answer: { feedback_id: 'fb-1' } } : {}), ...(status === 'cleared' ? { cleared: { at: '2026-10-20T09:00:00.000Z' } } : {}) });
const ASKS = [
  ASK('ask-a', 'a', 'open', 'Photo or drawing?\n`D:/data/laneboard/material/hero.png`'),
  ASK('ask-old', 'a', 'answered', 'The old question'),
  ASK('ask-b', 'b', 'open', 'Friendly or formal?'),
  ASK('ask-c', 'c', 'open', 'Ship today?'),
  ASK('ask-task', '', 'open', 'Who signs off?'),
  ASK('ask-gone', 'b', 'cleared', 'Withdrawn question')
];
const OPEN = ASKS.filter(a => a.status === 'open');

/** The page functions under test, lifted into a vm: the real locales, a stubbed S carrying the asks. */
function page(lang = 'en') {
  const S = { dict: LOC[lang], en: LOC.en, compose: {}, composeFiles: {}, open: {}, galleryNavs: {}, hl: null,
    data: { tasks: [TASK], asks: ASKS, messages: [], times: {}, plans: {}, feedback: [], me: { role: 'owner' } } };
  const ctx = vm.createContext({ S, esc: escHtml, Date, isOwner: () => true, isLead: () => true, serverNow: () => Date.parse('2026-10-20T10:00:00.000Z'),
    askSinceOf: a => a.attribution.created_at, askedBy: x => x, fmtDur: ms => Math.round(ms / 3600000) + 'h', fmtTime: x => String(x).slice(11, 16),
    refsOf: s => ({ body: s || '', images: [], links: [] }), refsHtml: () => '', evBody: t => escHtml(t), mdInline: escHtml,
    store: { get: () => '', set() {} } });
  vm.runInContext(['t', 'OWNER_KINDS', 'msgsOf', 'asksOf', 'compose', 'saveDraft', 'thumbsHtml', 'composer', 'streamEntries'].map(lift).join('\n'), ctx);
  return ctx;
}
const composerHtml = (ctx = page()) => vm.runInContext('composer(S.data.tasks[0])', ctx);
const optionValues = html => [...html.matchAll(/<option value="([^"]*)"( selected)?/g)].map(m => [m[1], !!m[2]]);

test('composer lists one scope per open ask', () => {
  const html = composerHtml();
  const opts = optionValues(html);
  const askOpts = opts.filter(([v]) => v.startsWith('ask:')).map(([v]) => v.slice(4));
  assert.deepEqual(askOpts, OPEN.map(a => a.id), 'every open ask, once, in the asks order');
  assert.equal(new Set(askOpts).size, OPEN.length, 'no ask is listed twice');
  assert.deepEqual(opts.map(([v]) => v), ['', 'ask:ask-a', 'ask:ask-b', 'ask:ask-c', 'ask:ask-task', 'step:a', 'step:b', 'step:c'],
    'task, one scope per open ask, then the steps');
  assert.ok(!opts.some(([v]) => /ask-old|ask-gone/.test(v)), 'an answered or cleared ask is offered nowhere');
  // Each label names its ask and a readable slice of its own text (never another ask's).
  const label = id => html.match(new RegExp(`<option value="ask:${id}"[^>]*>([^<]*)</option>`))[1];
  for (const a of OPEN) {
    assert.match(label(a.id), new RegExp(`Question ${a.id}:`));
    assert.ok(label(a.id).includes(a.text.replace(/\s+/g, ' ').slice(0, 60)));
  }
  // The field follows the selection: exactly one scope is selected, and it is the ask the owner picked.
  for (const a of OPEN) {
    const ctx = page();
    vm.runInContext(`compose('V-5').scope = ${JSON.stringify('ask:' + a.id)}`, ctx);
    const selected = optionValues(composerHtml(ctx)).filter(([, sel]) => sel).map(([v]) => v);
    assert.deepEqual(selected, ['ask:' + a.id], `only ${a.id}'s scope is selected`);
  }
});

test('each open ask keeps its own answer link; every ask links to its step row', () => {
  const ctx = page();
  const html = vm.runInContext('streamEntries(S.data.tasks[0])', ctx);
  const card = id => {
    const at = html.indexOf(`id="ev-${id}"`);
    assert.ok(at >= 0, `no card for ${id}`);
    const next = html.indexOf('<div class="ev ', at + 10);
    return html.slice(at, next < 0 ? html.length : next);
  };
  for (const a of OPEN) {
    assert.match(card(a.id), new RegExp(`data-action="reply-ask"[^>]*data-ask="${a.id}"`), `${a.id}'s answer link scopes the composer to it`);
    if (a.step_id) assert.match(card(a.id), new RegExp(`data-action="step-link"[^>]*data-task="V-5"[^>]*data-step="${a.step_id}"`), `${a.id} links to step ${a.step_id}`);
  }
  assert.doesNotMatch(card('ask-task'), /data-action="step-link"/, 'a task-level ask has no step row to link to');
  for (const id of ['ask-old', 'ask-gone']) assert.doesNotMatch(card(id), /data-action="reply-ask"/, `${id} is not open, so it offers no answer`);
  assert.equal((html.match(/data-action="reply-ask"/g) || []).length, OPEN.length, 'one answer link per open ask');
  // The step-row link is the existing handler: it opens the Steps tab, expands and scrolls to that row.
  assert.match(APP, /if \(action === 'step-link'\) \{ showStepReport\(b\.dataset\.task, b\.dataset\.step\); return render\(\); \}/);
});
