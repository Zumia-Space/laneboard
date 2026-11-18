// Board honesty rules (src/rules.mjs), ported from the J-05 board: the pure functions, then every write path that
// can change a step state (task.create, step.create, step.update, inbox.merge, the CLI, the legacy importers),
// then the server-derived current step on reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTasks, currentStep, STEP_STATES, violationsForWrite } from '../src/rules.mjs';
import { emptyState } from '../src/ops.mjs';
import { migrate, legacyViolations, loadLegacy } from '../scripts/migrate-from-legacy.mjs';
import { startSeeded, OWNER, tmpDir } from './helpers.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const task = (id, states) => ({ id, steps: states.map((state, i) => ({ id: 's' + (i + 1), label: 'L' + (i + 1), state })) });
const steps = (...states) => states.map((state, i) => ({ id: 's' + (i + 1), label: 'L' + (i + 1), zone: 'build', state }));

// ---------- pure rules: same cases as the J-05 board's own test ----------
test('rules: valid tasks produce no violations; the state set equals the published schema enum', () => {
  assert.deepEqual(validateTasks([task('A', ['done', 'done', 'active', 'todo']), task('B', ['waiting', 'todo']), { id: 'C' }]), []);
  for (const s of STEP_STATES) assert.deepEqual(validateTasks([task('X', [s])]), []);
  const common = JSON.parse(fs.readFileSync(path.join(ROOT, 'schema', 'v1', 'common.json'), 'utf8'));
  assert.deepEqual([...common.$defs.stepState.enum].sort(), [...STEP_STATES].sort(), 'no silent widening or narrowing');
});

test('rules: missing or unknown step state is invalid_step_state', () => {
  const t = { id: 'A', steps: [{ id: 's1', state: 'done' }, { id: 's2' }, { id: 's3', state: 'in-progress' }] };
  assert.deepEqual(validateTasks([t]), [
    { error: 'invalid_step_state', task: 'A', step: 's2', state: null },
    { error: 'invalid_step_state', task: 'A', step: 's3', state: 'in-progress' }
  ]);
});

test('rules: waiting before a later done is waiting_before_done; waiting after the last done is fine', () => {
  assert.deepEqual(validateTasks([task('A', ['done', 'waiting', 'active', 'done', 'todo'])]), [{ error: 'waiting_before_done', task: 'A', step: 's2' }]);
  assert.deepEqual(validateTasks([task('B', ['done', 'done', 'waiting', 'todo'])]), []);
});

test('rules: all violations across all tasks are listed', () => {
  const v = validateTasks([task('A', ['waiting', 'done']), task('B', ['bogus']), task('C', ['done', 'waiting', 'waiting', 'done'])]);
  assert.deepEqual(v.map(x => `${x.error}:${x.task}/${x.step}`), [
    'waiting_before_done:A/s1', 'invalid_step_state:B/s1', 'waiting_before_done:C/s2', 'waiting_before_done:C/s3'
  ]);
});

test('rules: currentStep priority active > waiting > blocked > first todo; none -> null', () => {
  assert.deepEqual(currentStep(task('A', ['done', 'waiting', 'active', 'todo']).steps), { id: 's3', label: 'L3', state: 'active' });
  assert.deepEqual(currentStep(task('A', ['done', 'blocked', 'waiting']).steps), { id: 's3', label: 'L3', state: 'waiting' });
  assert.deepEqual(currentStep(task('A', ['done', 'todo', 'blocked']).steps), { id: 's3', label: 'L3', state: 'blocked' });
  assert.deepEqual(currentStep(task('A', ['done', 'todo', 'todo']).steps), { id: 's2', label: 'L2', state: 'todo' });
  assert.equal(currentStep(task('A', ['done', 'done']).steps), null);
  assert.equal(currentStep(undefined), null);
});

test('rules: ops that cannot change a step state are never checked', () => {
  const st = emptyState();
  for (const op of ['task.update', 'ask.raise', 'inbox.submit', 'times.import', 'feedback.add']) assert.deepEqual(violationsForWrite(st, { op, target_id: 'A', data: { steps: 1 } }), []);
});

// ---------- write paths ----------
// A rule-only failure mirrors the first violation at top level (J-05 format); when the schema also fails (unknown
// or missing state) the error stays invalid_data with errors[], and violations[] still lists every violation.
async function assertRejected(s, res, expected, what, { schema = false } = {}) {
  assert.equal(res.status, 400, `${what}: ${JSON.stringify(res.body)}`);
  assert.deepEqual(res.body.violations, expected, what);
  if (schema) { assert.equal(res.body.error, 'invalid_data', what); assert.ok(res.body.errors.length, what); return; }
  const { error, ...first } = expected[0];
  assert.equal(res.body.error, error, `${what}: first violation mirrored at top level`);
  assert.deepEqual({ task: res.body.task, step: res.body.step }, { task: first.task, step: first.step });
}

test('task.create: every violation listed, nothing saved', async () => {
  const s = await startSeeded();
  try {
    const seq = s.board.state.seq;
    const r = await s.write(s.coord, 'task.create', 'NEW-1', { title: 'x', steps: [...steps('waiting', 'done', 'bogus'), { id: 's4', label: 'L4', zone: 'build' }] });
    await assertRejected(s, r, [
      { error: 'invalid_step_state', task: 'NEW-1', step: 's3', state: 'bogus' },
      { error: 'invalid_step_state', task: 'NEW-1', step: 's4', state: null },
      { error: 'waiting_before_done', task: 'NEW-1', step: 's1' }
    ], 'task.create', { schema: true });
    await assertRejected(s, await s.write(s.coord, 'task.create', 'NEW-1', { title: 'x', steps: steps('done', 'waiting', 'active', 'done') }),
      [{ error: 'waiting_before_done', task: 'NEW-1', step: 's2' }], 'task.create rule only');
    assert.equal(s.board.state.seq, seq, 'nothing journaled');
    assert.equal(s.board.state.tasks['NEW-1'], undefined);
    assert.equal((await s.write(s.coord, 'task.create', 'NEW-1', { title: 'x', steps: steps('done', 'waiting', 'todo') })).status, 200, 'waiting after the last done is fine');
  } finally { await s.close(); }
});

test('step.create: appending done after a waiting step, or a step without a state, is refused', async () => {
  const s = await startSeeded(); // WEB-3: s1 done, s2 active, s3 waiting
  try {
    const seq = s.board.state.seq;
    await assertRejected(s, await s.write(s.coord, 'step.create', 'WEB-3/s4', { label: 'Ship', zone: 'ship', state: 'done' }),
      [{ error: 'waiting_before_done', task: 'WEB-3', step: 's3' }], 'step.create done');
    await assertRejected(s, await s.write(s.coord, 'step.create', 'WEB-3/s4', { label: 'Ship', zone: 'ship' }),
      [{ error: 'invalid_step_state', task: 'WEB-3', step: 's4', state: null }], 'step.create missing state', { schema: true });
    assert.equal(s.board.state.seq, seq);
    assert.equal((await s.write(s.coord, 'step.create', 'WEB-3/s4', { label: 'Ship', zone: 'ship', state: 'todo' })).status, 200);
  } finally { await s.close(); }
});

test('step.update (HTTP and CLI): marking a step done after an open waiting step is refused until the wait is resolved', async () => {
  const s = await startSeeded();
  try {
    await s.write(s.coord, 'task.create', 'T-1', { title: 't', steps: steps('waiting', 'active') });
    const seq = s.board.state.seq;
    const rev = s.board.state.steps['T-1/s2'].rev;
    await assertRejected(s, await s.write(s.coord, 'step.update', 'T-1/s2', { state: 'done' }, { expected_revision: rev }),
      [{ error: 'waiting_before_done', task: 'T-1', step: 's1' }], 'step.update');
    await assertRejected(s, await s.write(s.coord, 'step.update', 'T-1/s2', { state: 'paused' }, { expected_revision: rev }),
      [{ error: 'invalid_step_state', task: 'T-1', step: 's2', state: 'paused' }], 'step.update unknown state', { schema: true });
    const cli = await new Promise(resolve => execFile(process.execPath, [path.join(ROOT, 'bin', 'board.mjs'), 'step', 'T-1/s2', 'done'],
      { env: { ...process.env, BOARD_URL: s.url, BOARD_TOKEN: s.coord } }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stderr })));
    assert.equal(cli.code, 1); assert.match(cli.stderr, /waiting_before_done/);
    assert.equal(s.board.state.seq, seq, 'nothing journaled');
    assert.equal(s.board.state.steps['T-1/s2'].state, 'active');
    // A label-only update is not a state change and is not blocked by the task's other steps.
    assert.equal((await s.write(s.coord, 'step.update', 'T-1/s2', { label: 'renamed' }, { expected_revision: rev })).status, 200);
    // Resolve the wait first, then the done goes through.
    await s.write(s.coord, 'step.update', 'T-1/s1', { state: 'done' }, { expected_revision: 1 });
    assert.equal((await s.write(s.coord, 'step.update', 'T-1/s2', { state: 'done' }, { expected_revision: rev + 1 })).status, 200);
  } finally { await s.close(); }
});

test('inbox.merge: accepting a step proposal that would break the rules is refused and the proposal stays open', async () => {
  const s = await startSeeded(); // WEB-3: s1 done, s2 active, s3 waiting — alpha is in scope
  try {
    await s.write(s.coord, 'step.create', 'WEB-3/s4', { label: 'Ship', zone: 'ship', state: 'todo' });
    const inb = (await s.write(s.alpha, 'inbox.submit', 'WEB-3', { kind: 'step', step_id: 's4', state: 'done', text: 'shipped' })).body.id;
    const seq = s.board.state.seq;
    await assertRejected(s, await s.write(s.coord, 'inbox.merge', inb, { action: 'accept' }, { expected_revision: 1 }),
      [{ error: 'waiting_before_done', task: 'WEB-3', step: 's3' }], 'inbox.merge');
    assert.equal(s.board.state.seq, seq);
    assert.equal(s.board.state.inbox[inb].resolution, undefined);
    assert.equal((await s.write(s.coord, 'inbox.merge', inb, { action: 'dismiss', note: 'owner still deciding' }, { expected_revision: 1 })).status, 200, 'dismiss is always allowed');
  } finally { await s.close(); }
});

test('importers: migrate-from-legacy refuses a snapshot that breaks the rules, whole, before writing anything', async () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'data'));
  const row = (code, states) => ({ code, title: code, steps: states.map((state, i) => ({ id: 's' + (i + 1), label: 'L', zone: 'build', ...(state ? { state } : {}) })) });
  fs.writeFileSync(path.join(dir, 'data', 'tasks.json'), JSON.stringify([row('A-1', ['done', 'active']), row('B-2', ['waiting', 'done']), row('C-3', ['todo', null])]));
  assert.deepEqual(legacyViolations(loadLegacy(dir)).map(v => `${v.error}:${v.task}/${v.step}`), ['waiting_before_done:B-2/s1', 'invalid_step_state:C-3/s2']);
  const to = path.join(tmpDir(), 'board');
  await assert.rejects(migrate({ from: dir, to }), e => e.violations.length === 2 && /nothing imported/.test(e.message));
  assert.equal(fs.existsSync(to), false, 'target directory never created');
});

// ---------- reads ----------
test('reads: current_step is derived by the server for signed-in and anonymous readers; a client cannot send one', async () => {
  const s = await startSeeded();
  try {
    await s.write(s.coord, 'task.create', 'PUB-1', { title: 'p', visibility: 'public', steps: steps('done', 'blocked', 'waiting') });
    await s.write(s.coord, 'task.create', 'ALL-1', { title: 'a', steps: steps('done', 'done') });
    const v = await s.state(OWNER);
    const cur = id => v.tasks.find(t => t.id === id).current_step;
    assert.deepEqual(cur('WEB-3'), { id: 'WEB-3/s2', label: 'Build', state: 'active' });
    assert.deepEqual(cur('PUB-1'), { id: 'PUB-1/s3', label: 'L3', state: 'waiting' });
    assert.equal(cur('ALL-1'), null);
    assert.ok(v.tasks.every(t => typeof t.last_activity_at === 'string'), 'server time the UI ages its staleness badge from');
    const anon = await s.state();
    assert.deepEqual(anon.tasks.map(t => [t.id, t.current_step]), [['PUB-1', { id: 'PUB-1/s3', label: 'L3', state: 'waiting' }]]);
    const r = await s.write(s.coord, 'task.update', 'WEB-3', { current_step: { id: 'WEB-3/s3' } }, { expected_revision: 1 });
    assert.equal(r.status, 400); assert.equal(r.body.error, 'invalid_data');
  } finally { await s.close(); }
});

test('waiting_before_done is judged per lane (s21): another lane\'s later done step does not overtake an ask; without lanes nothing changed', () => {
  const t = steps => [{ id: 'T-1', steps }];
  const w = (id, state, lane) => ({ id, state, ...(lane ? { lane } : {}) });
  assert.deepEqual(validateTasks(t([w('a', 'waiting', 'Workera'), w('b', 'done', 'Workerb')])), [], 'Workera waits, Workerb finished later: fine');
  assert.deepEqual(validateTasks(t([w('a', 'waiting', 'Workera'), w('b', 'done', 'Workerb'), w('c', 'done', 'Workera')])).map(v => [v.error, v.step]), [['waiting_before_done', 'a']], 'a later done step of the SAME lane still overtakes it');
  assert.deepEqual(validateTasks(t([w('a', 'waiting'), w('b', 'done')])).map(v => v.step), ['a'], 'steps without lanes are all one lane: the rule as it was');
});
