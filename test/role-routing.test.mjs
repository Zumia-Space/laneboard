// Role slots (ADR 2026-10-09): defaults, the review rule, owner overrides, auto-escalation, replay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startSeeded, OWNER } from './helpers.mjs';
import { createBoard } from '../src/board.mjs';
import { resolveRoles, applyReviewRule, escalateDecision } from '../src/roles.mjs';

const roles = async s => (await s.state(OWNER)).tasks.find(t => t.id === 'WEB-3').roles;

test('defaults: plan opus/high, code sonnet/high, review opus/high, scout haiku/low, all by the coordinator', async () => {
  const s = await startSeeded();
  try {
    const r = await roles(s);
    assert.deepEqual(['plan', 'code', 'review', 'scout'].map(k => `${r[k].model}/${r[k].effort}/${r[k].by}`),
      ['opus/high/coordinator', 'sonnet/high/coordinator', 'opus/high/coordinator', 'haiku/low/coordinator']);
    assert.equal(r.scout.can_verdict, false);
  } finally { await s.close(); }
});

test('an owner routing override is the code slot; the review rule moves a same-model reviewer up a tier', async () => {
  const s = await startSeeded();
  try {
    await s.write(OWNER, 'routing.set', 'WEB-3', { model: 'sonnet', effort: 'xhigh' });
    let r = await roles(s);
    assert.equal(r.code.by, 'owner'); assert.equal(r.review.model, 'opus');
    await s.write(OWNER, 'roles.set', 'WEB-3', { role: 'review', model: 'sonnet', effort: 'high' });
    r = await roles(s);
    assert.equal(r.review.model, 'opus', 'review == code (sonnet) -> bumped to opus');
    assert.deepEqual(r.review.adjusted_from, { model: 'sonnet', effort: 'high' });
    await s.write(OWNER, 'roles.reset', 'WEB-3', { role: 'review' });
    await s.write(OWNER, 'routing.set', 'WEB-3', { model: 'opus', effort: 'xhigh' });
    r = await roles(s);
    assert.equal(r.review.conflict, true, 'coder already on the top tier: the rule cannot be met by model alone, and says so');
  } finally { await s.close(); }
});

test('roles.set / roles.reset: owner only; reset returns the default', async () => {
  const s = await startSeeded();
  try {
    assert.equal((await s.write(s.coord, 'roles.set', 'WEB-3', { role: 'scout', model: 'sonnet', effort: 'low' })).status, 403);
    assert.equal((await s.write(OWNER, 'roles.set', 'WEB-3', { role: 'code', model: 'sonnet', effort: 'low' })).status, 400, 'the code slot is routing.set');
    assert.equal((await s.write(OWNER, 'roles.set', 'WEB-3', { role: 'scout', model: 'deepseek', effort: 'low' })).status, 200);
    const bad = await s.write(OWNER, 'roles.set', 'WEB-3', { role: 'review', model: 'haiku', effort: 'low' });
    assert.equal(bad.status, 400, 'haiku never rules pass/fail: refused in the review slot');
    assert.equal(bad.body.error, 'review_model_not_allowed');
    assert.equal((await s.write(OWNER, 'roles.set', 'WEB-3', { role: 'review', model: 'deepseek', effort: 'low' })).status, 200);
    assert.equal((await roles(s)).scout.by, 'owner');
    await s.write(OWNER, 'roles.reset', 'WEB-3', { role: 'scout' });
    assert.equal((await roles(s)).scout.model, 'haiku');
  } finally { await s.close(); }
});

test('escalate: first fail only counts; the second fail on the same gate bumps the code slot one tier; another gate counts apart', async () => {
  const s = await startSeeded();
  try {
    const wk = (await s.state(OWNER)).tasks.find(t => t.id === 'WEB-3');
    const up = await s.write(s.coord, 'task.update', 'WEB-3', { worker: { model: 'deepseek', effort: 'medium' } }, { expected_revision: wk.rev });
    assert.equal(up.status, 200, JSON.stringify(up.body));
    await s.write(s.coord, 'roles.escalate', 'WEB-3', { gate: 'tsc', lane: 'CoS' });
    assert.equal((await roles(s)).code.model, 'deepseek');
    await s.write(s.coord, 'roles.escalate', 'WEB-3', { gate: 'lint', lane: 'CoS' });
    assert.equal((await roles(s)).code.model, 'deepseek', 'a different gate does not add up');
    await s.write(s.coord, 'roles.escalate', 'WEB-3', { gate: 'tsc', lane: 'CoS' });
    const r = await roles(s);
    assert.deepEqual([r.code.model, r.code.effort, r.code.by], ['sonnet', 'high', 'auto']);
    assert.match(r.code.reason, /tsc/);
    await s.write(s.coord, 'roles.escalate', 'WEB-3', { gate: 'tsc', lane: 'CoS' }); await s.write(s.coord, 'roles.escalate', 'WEB-3', { gate: 'tsc', lane: 'CoS' });
    assert.equal((await roles(s)).code.model, 'opus');
    await s.write(s.coord, 'roles.escalate', 'WEB-3', { gate: 'tsc', lane: 'CoS' }); await s.write(s.coord, 'roles.escalate', 'WEB-3', { gate: 'tsc', lane: 'CoS' });
    assert.equal((await roles(s)).code.model, 'opus', 'top of the ladder: no bump');
    assert.equal((await s.state(OWNER)).tasks.find(x => x.id === 'WEB-3').worker.by, 'auto');
  } finally { await s.close(); }
});

test('escalate never bumps a code slot the owner set, and a restart replays the same result', async () => {
  const s = await startSeeded();
  let before;
  try {
    await s.write(OWNER, 'routing.set', 'WEB-3', { model: 'deepseek', effort: 'high' });
    await s.write(s.coord, 'roles.escalate', 'WEB-3', { gate: 'g', lane: 'CoS' }); await s.write(s.coord, 'roles.escalate', 'WEB-3', { gate: 'g', lane: 'CoS' });
    const r = await roles(s);
    assert.deepEqual([r.code.model, r.code.by], ['deepseek', 'owner']);
    assert.match((await s.state(OWNER)).tasks.find(x => x.id === 'WEB-3').gate_fails.g.blocked, /owner/);
    before = JSON.stringify(s.board.state);
  } finally { await s.close(); }
  const again = createBoard({ dataDir: s.dataDir, ownerToken: OWNER });
  assert.equal(JSON.stringify(again.state), before);
  again.close();
});

test('pure resolver: review rule and ladder edge cases', () => {
  assert.equal(applyReviewRule({ model: 'opus', effort: 'high' }, { model: 'deepseek' }).model, 'opus');
  assert.equal(applyReviewRule({ model: 'deepseek', effort: 'high' }, { model: 'deepseek' }).model, 'sonnet');
  assert.equal(applyReviewRule({ model: 'haiku', effort: 'low' }, { model: 'haiku' }).model, 'deepseek');
  assert.ok(escalateDecision({ id: 'X-1', worker: { model: 'gemini', effort: 'high' } }, {}, {}, { g: { count: 1 } }, 'g').blocked.includes('ladder'));
  assert.equal(resolveRoles({ id: 'X-1' }, {}, {}).code.default, true);
});

// ---- the page: four slots per task row, eight selects for the owner, none for a viewer (app.js lifted into a vm) ----
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const APP = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');
const LOC = JSON.parse(fs.readFileSync(path.join(PUB, 'locales', 'en.json'), 'utf8'));
const REG = fs.readFileSync(path.join(PUB, 'machines.js'), 'utf8'); // the machine registry (J-05 worker-machine-0811): each row also has a machine chip
const lift = name => {
  const line = APP.match(new RegExp(`^const ${name} = .*;(?: //.*)?$`, 'm'));
  if (line) return line[0];
  const start = APP.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `app.js has no ${name}`);
  return APP.slice(start, APP.indexOf('\n}\n', start) + 2);
};

test('page: workers table = one row per task, four chips, a Defaults row; the owner gets the selects only in the open popover', async () => {
  const s = await startSeeded();
  try {
    await s.write(OWNER, 'routing.set', 'WEB-3', { model: 'opus', effort: 'xhigh' });
    const data = await s.state(OWNER);
    const esc = v => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    const render = (own, wkPop = '') => {
      const ctx = vm.createContext({ window: {}, S: { dict: LOC, en: LOC, data, errors: {}, history: {}, wkPop }, esc, liveTask: () => true, isOwner: () => own, violationsBox: () => '', fmtTime: () => 't' });
      vm.runInContext(REG, ctx);
      vm.runInContext(REG, ctx);
    vm.runInContext(['t', 'modelName', 'EFFORTS', 'GEMINI_EFFORTS', 'GEMINI_DEFAULT_EFFORT', 'effortsFor', 'fixEffort', 'workerText', 'ROLE_DEFAULTS', 'REVIEW_MODELS', 'MODEL_SHORT', 'shortModel', 'chipText', 'wkChip', 'MC', 'machineOf', 'machineFields', 'wkMachineChip', 'workersTable'].map(lift).join('\n') + "\nconst ROLE_SLOTS = ['plan', 'code', 'review', 'scout'], SLOT_MODELS = ['opus', 'sonnet', 'deepseek', 'haiku', 'gemini-3.8-flash', 'gemini-4-argon'];", ctx);
      return vm.runInContext('workersTable()', ctx);
    };
    const html = render(true), row = html.match(/<div class="wk-trow" data-route-box="WEB-3">[\s\S]*?<\/div><\/div>(?=<div class="wk-trow"|<\/div><\/section>)/)[0];
    assert.deepEqual([...html.match(/wk-head[\s\S]*?<\/div><\/div>/)[0].matchAll(/<span>([^<]+)<\/span>/g)].map(m => m[1]), ['Plan', 'Code', 'Review', 'Scout']);
    assert.match(html, /class="wk-trow wk-defaults"[\s\S]*?Opus · high[\s\S]*?Sonnet · high[\s\S]*?Opus · high[\s\S]*?Haiku · low/, 'Defaults row pinned above the tasks');
    assert.ok(html.indexOf('wk-defaults') < html.indexOf('data-route-box="WEB-3"'));
    assert.equal((row.match(/data-key="WEB-3:(?:plan|code|review|scout)"/g) || []).length, 4, 'four model chips');
    assert.equal((row.match(/data-key="WEB-3:machines"/g) || []).length, 1, 'and one machine chip under them');
    assert.equal((row.match(/<select/g) || []).length, 0, 'closed popovers render no selects');
    assert.match(row, /Opus · xhigh/, 'the owner-set code slot, short name');
    assert.equal((row.match(/class="wk-dot"/g) || []).length, 1, 'one solid dot: only the code slot was chosen by the owner');
    assert.match(row, /data-key="WEB-3:plan"[^>]*title="Plan: [^"]*coordinator default"/, 'the full provenance meaning is in the tooltip');
    assert.equal((row.match(/wk-chip dim/g) || []).length, 4, 'plan, review and scout equal the defaults and are dimmed (so is the machine chip: no pick yet); the owner code exception is not');
    assert.equal((row.match(/class="wk-warn"/g) || []).length, 1, 'opus coder: the review slot carries the conflict "!" icon');
    assert.match(row, /data-key="WEB-3:review"[\s\S]*?class="wk-warn"/);
    const open = render(true, 'WEB-3:scout'), orow = open.match(/<div class="wk-trow" data-route-box="WEB-3">[\s\S]*?<\/div><\/div>(?=<div class="wk-trow"|<\/div><\/section>)/)[0];
    assert.equal((orow.match(/<select/g) || []).length, 2, 'one open popover: model + effort');
    assert.equal((orow.match(/data-role-slot="WEB-3" data-role="scout"/g) || []).length, 2, 'scout writes roles.set');
    const revOpen = render(true, 'WEB-3:review').match(/data-role="review" data-field="model">[\s\S]*?<\/select>/)[0];
    assert.deepEqual([...revOpen.matchAll(/<option value="([^"]+)"/g)].map(m => m[1]), ['opus', 'sonnet', 'fable', 'deepseek', 'gemini-4-argon'], 'review never offers haiku');
    assert.ok(/value="haiku"/.test(orow), 'the scout popover still offers haiku');
    assert.match(html, /<span class="wk-code">Task<\/span>/, 'task column header is Task, not Code');
    const codeOpen = render(true, 'WEB-3:code');
    assert.equal((codeOpen.match(/data-route="WEB-3"/g) || []).length, 2, 'code writes routing.set');
    assert.equal((render(false, 'WEB-3:code').match(/<select|<button/g) || []).length, 0, 'a viewer sees chips, not buttons or selects');
  } finally { await s.close(); }
});

test('roleSlots: false (an embedder that must not show lane models): no roles in the view, so no workers table rows', async () => {
  const s = await startSeeded({ roleSlots: false });
  try {
    await s.write(OWNER, 'routing.set', 'WEB-3', { model: 'opus', effort: 'xhigh' });
    const data = await s.state(OWNER);
    assert.ok(data.tasks.length >= 2);
    assert.ok(data.tasks.every(t => !('roles' in t) && !('gate_fails' in t)), 'no task carries role slots');
    assert.ok(!('roles' in data), 'no top-level roles map');
    assert.equal(data.tasks.find(t => t.id === 'WEB-3').worker.model, 'opus', 'the single routing override still shows');
    const esc = v => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    const ctx = vm.createContext({ window: {}, S: { dict: LOC, en: LOC, data, errors: {}, history: {}, wkPop: '' }, esc, liveTask: () => true, isOwner: () => true, violationsBox: () => '', fmtTime: () => 't' });
    vm.runInContext(['t', 'modelName', 'EFFORTS', 'GEMINI_EFFORTS', 'GEMINI_DEFAULT_EFFORT', 'effortsFor', 'fixEffort', 'workerText', 'ROLE_DEFAULTS', 'REVIEW_MODELS', 'MODEL_SHORT', 'shortModel', 'chipText', 'wkChip', 'MC', 'machineOf', 'machineFields', 'wkMachineChip', 'workersTable'].map(lift).join('\n') + "\nconst ROLE_SLOTS = ['plan', 'code', 'review', 'scout'], SLOT_MODELS = ['opus', 'sonnet', 'deepseek', 'haiku', 'gemini-3.8-flash', 'gemini-4-argon'];", ctx);
    const html = vm.runInContext('workersTable()', ctx);
    assert.equal(html, '', 'no workers table');
    assert.ok(!html.includes('wk-trow'));
  } finally { await s.close(); }
  const on = await startSeeded();
  try { assert.ok((await on.state(OWNER)).tasks.every(t => t.roles?.plan), 'the default (live) board keeps the four slots'); } finally { await on.close(); }
});
