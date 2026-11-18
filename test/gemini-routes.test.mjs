// Gemini routes (J-05, 14-10): gemini-3.8-flash (coder tier) and gemini-4-argon (plan/review tier), run through agy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startSeeded, OWNER } from './helpers.mjs';
import { applyReviewRule, escalateDecision, resolveRoles, effortError, LADDER, TIERS } from '../src/roles.mjs';

const FLASH = 'gemini-3.8-flash', ARGON = 'gemini-4-argon';
const roles = async s => (await s.state(OWNER)).tasks.find(t => t.id === 'WEB-3').roles;

test('gemini models are accepted with low, medium and high in every owner-writable slot', async () => {
  const s = await startSeeded();
  try {
    for (const model of [FLASH, ARGON]) for (const effort of ['low', 'medium', 'high']) {
      const r = await s.write(OWNER, 'routing.set', 'WEB-3', { model, effort });
      assert.equal(r.status, 200, `routing.set ${model}/${effort}: ${JSON.stringify(r.body)}`);
      assert.equal((await s.write(OWNER, 'roles.set', 'WEB-3', { role: 'plan', model, effort })).status, 200);
    }
    assert.equal((await s.write(OWNER, 'roles.set', 'WEB-3', { role: 'review', model: ARGON, effort: 'high' })).status, 200);
    assert.deepEqual([(await roles(s)).code.model, (await roles(s)).review.model], [ARGON, 'opus'], 'review argon == code argon -> bumped to opus');
  } finally { await s.close(); }
});

test('gemini models refuse xhigh and max (agy rejects them); claude models keep xhigh', async () => {
  const s = await startSeeded();
  try {
    for (const model of [FLASH, ARGON]) for (const effort of ['xhigh', 'max']) {
      const a = await s.write(OWNER, 'routing.set', 'WEB-3', { model, effort });
      assert.equal(a.status, 400); assert.equal(a.body.error, 'gemini_effort_not_allowed');
      const b = await s.write(OWNER, 'roles.set', 'WEB-3', { role: 'review', model, effort });
      assert.equal(b.status, 400); assert.equal(b.body.error, 'gemini_effort_not_allowed');
    }
    const wk = (await s.state(OWNER)).tasks.find(t => t.id === 'WEB-3');
    const up = await s.write(s.coord, 'task.update', 'WEB-3', { worker: { model: FLASH, effort: 'xhigh' } }, { expected_revision: wk.rev });
    assert.equal(up.status, 400, 'the coordinator seed is checked too');
    assert.equal((await s.write(OWNER, 'routing.set', 'WEB-3', { model: 'opus', effort: 'xhigh' })).status, 200);
    assert.equal((await s.write(OWNER, 'routing.set', 'WEB-3', { model: 'gemini', effort: 'xhigh' })).status, 200, 'the old bare "gemini" id is not a gemini-* model: unchanged');
    assert.equal(effortError(FLASH, 'max') !== null && effortError(ARGON, 'high') === null && effortError('sonnet', 'max') === null, true);
  } finally { await s.close(); }
});

test('ladder: flash -> argon high; argon high -> opus high; the existing LADDER and TIERS are untouched', async () => {
  assert.deepEqual(LADDER, ['deepseek', 'sonnet', 'opus']); assert.deepEqual(TIERS, ['haiku', 'deepseek', 'sonnet', 'opus']);
  const fails = { g: { count: 1 } };
  const f = escalateDecision({ id: 'X-1', worker: { model: FLASH, effort: 'medium' } }, {}, {}, fails, 'g');
  assert.deepEqual([f.bump.model, f.bump.effort], [ARGON, 'high']);
  const a = escalateDecision({ id: 'X-1', worker: { model: ARGON, effort: 'high' } }, {}, {}, fails, 'g');
  assert.deepEqual([a.bump.model, a.bump.effort], ['opus', 'high']);
  assert.equal(escalateDecision({ id: 'X-1', worker: { model: FLASH, effort: 'medium' } }, { 'X-1': { model: FLASH, effort: 'low' } }, {}, fails, 'g').blocked, 'code slot is set by the owner (anh)');
  assert.equal(escalateDecision({ id: 'X-1', worker: { model: 'sonnet', effort: 'low' } }, {}, {}, fails, 'g').bump.model, 'opus', 'sonnet still goes straight to opus');
});

test('ladder end to end: two failed gates move a flash coder to argon', async () => {
  const s = await startSeeded();
  try {
    const wk = (await s.state(OWNER)).tasks.find(t => t.id === 'WEB-3');
    assert.equal((await s.write(s.coord, 'task.update', 'WEB-3', { worker: { model: FLASH, effort: 'medium' } }, { expected_revision: wk.rev })).status, 200);
    await s.write(s.coord, 'roles.escalate', 'WEB-3', { gate: 'tsc', lane: 'CoS' }); await s.write(s.coord, 'roles.escalate', 'WEB-3', { gate: 'tsc', lane: 'CoS' });
    const r = await roles(s);
    assert.deepEqual([r.code.model, r.code.effort, r.code.by], [ARGON, 'high', 'auto']);
  } finally { await s.close(); }
});

test('reviewer independence: soft rule (7 live rows are opus/opus), never a refused write; gemini peers map to their claude tier', async () => {
  // flash codes at the sonnet tier: a flash reviewer is bumped to opus; an argon coder gets an opus reviewer
  assert.equal(applyReviewRule({ model: FLASH, effort: 'high' }, { model: FLASH }).model, 'opus');
  assert.equal(applyReviewRule({ model: ARGON, effort: 'high' }, { model: ARGON }).model, 'opus');
  assert.equal(applyReviewRule({ model: ARGON, effort: 'high' }, { model: FLASH }).model, ARGON, 'different models: kept');
  const same = applyReviewRule({ model: 'opus', effort: 'high' }, { model: 'opus' });
  assert.equal(same.conflict, true, 'opus/opus (as on 7 live rows) is flagged for the UI, not refused');
  const r = resolveRoles({ id: 'X-1', worker: { model: 'opus', effort: 'high' } }, {}, {});
  assert.equal(r.review.conflict, true);
});

test('page helpers: gemini pickers offer low/medium/high only and snap a stale effort to the model default', async () => {
  const fs = await import('node:fs'), vm = await import('node:vm');
  const APP = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const src = ['EFFORTS', 'GEMINI_EFFORTS', 'GEMINI_DEFAULT_EFFORT', 'effortsFor', 'fixEffort'].map(n => APP.match(new RegExp(`^const ${n} = .*;(?: //.*)?$`, 'm'))[0]).join('\n');
  const ctx = vm.createContext({}); vm.runInContext(src + '\nthis.out = { e: effortsFor(model1, "xhigh"), c: effortsFor("opus", "max"), f: fixEffort("gemini-3.8-flash", "xhigh"), g: fixEffort("gemini-4-argon", "max"), k: fixEffort("opus", "xhigh") };', Object.assign(ctx, { model1: FLASH }));
  const out = JSON.parse(JSON.stringify(ctx.out));
  assert.deepEqual(out.e, ['low', 'medium', 'high']);
  assert.deepEqual(out.c, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual([out.f, out.g, out.k], ['medium', 'high', 'xhigh']);
});

test('task.create refuses a gemini worker with max, accepts argon/high; roles.set opus on an opus coder is accepted (flagged, not refused)', async () => {
  const s = await startSeeded();
  try {
    const mk = (id, worker) => s.write(s.coord, 'task.create', id, { title: id, worker, steps: [{ id: 's1', label: 'a', zone: 'build', state: 'active' }] });
    const bad = await mk('GEM-1', { model: ARGON, effort: 'max' });
    assert.equal(bad.status, 400); assert.equal(bad.body.error, 'gemini_effort_not_allowed');
    assert.equal((await mk('GEM-2', { model: ARGON, effort: 'high' })).status, 200);
    await s.write(OWNER, 'routing.set', 'WEB-3', { model: 'opus', effort: 'high' });
    assert.equal((await s.write(OWNER, 'roles.set', 'WEB-3', { role: 'review', model: 'opus', effort: 'high' })).status, 200);
    assert.equal((await roles(s)).review.conflict, true);
  } finally { await s.close(); }
});
