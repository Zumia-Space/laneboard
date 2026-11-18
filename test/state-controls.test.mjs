// Task status and step state controls (the UI's selects write through the same board.write as every client):
// allowed changes are journaled with who and when and show in the task's history, rule-breaking ones are refused
// with every violation listed, and only owner/coordinator tokens may change state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { violationsForWrite } from '../src/rules.mjs';
import { emptyState } from '../src/ops.mjs';
import { startSeeded } from './helpers.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const rev = (s, id) => s.board.state.tasks[id].rev;
const stepRev = (s, key) => s.board.state.steps[key].rev;

test('task status: the schema enum is the six statuses the UI offers', () => {
  const common = JSON.parse(fs.readFileSync(path.join(ROOT, 'schema', 'v1', 'common.json'), 'utf8'));
  assert.deepEqual(common.$defs.taskStatus.enum, ['open', 'doing', 'waiting', 'blocked', 'paused', 'closed']);
  const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  assert.match(app, /const TASK_STATUS = \['open', 'doing', 'waiting', 'blocked', 'paused', 'closed'\];/);
});

test('task status: coordinator changes are saved, attributed and listed in the task history', async () => {
  const s = await startSeeded();
  try {
    for (const status of ['open', 'doing', 'blocked', 'paused', 'closed', 'doing']) {
      const r = await s.write(s.coord, 'task.update', 'API-2', { status }, { expected_revision: rev(s, 'API-2') });
      assert.equal(r.status, 200, `${status}: ${JSON.stringify(r.body)}`);
      assert.equal(s.board.state.tasks['API-2'].status, status);
    }
    const t = s.board.state.tasks['API-2'];
    assert.equal(t.attribution.updated_by.name, 'coordinator');
    assert.equal(t.attribution.updated_by.role, 'coordinator');
    const h = await s.call(s.coord, 'GET', '/api/v1/events?task=API-2&limit=1000');
    assert.equal(h.status, 200);
    assert.ok(h.body.every(ev => ev.target_id.split('/')[0] === 'API-2'), 'only events of that task');
    const changes = h.body.filter(ev => ev.op === 'task.update').map(ev => [ev.data.status, ev.actor.name, ev.actor.role, typeof ev.at]);
    assert.deepEqual(changes.map(c => c[0]), ['open', 'doing', 'blocked', 'paused', 'closed', 'doing']);
    for (const c of changes) assert.deepEqual(c.slice(1), ['coordinator', 'coordinator', 'string']);
    const other = await s.call(s.coord, 'GET', '/api/v1/events?task=WEB-3&limit=1000');
    assert.ok(other.body.length && other.body.every(ev => ev.op !== 'task.update'), 'WEB-3 history holds none of API-2 changes');
  } finally { await s.close(); }
});

test('task status: waiting (on the owner) needs something the owner can answer; refused otherwise, nothing saved', async () => {
  const s = await startSeeded();
  try {
    // WEB-3 has s3 waiting in the owner zone: allowed.
    let r = await s.write(s.coord, 'task.update', 'WEB-3', { status: 'waiting' }, { expected_revision: rev(s, 'WEB-3') });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    // API-2 has nothing waiting on the owner: refused with the violation listed.
    const seq = s.board.state.seq;
    r = await s.write(s.coord, 'task.update', 'API-2', { status: 'waiting' }, { expected_revision: rev(s, 'API-2') });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'waiting_status_without_ask');
    assert.deepEqual(r.body.violations, [{ error: 'waiting_status_without_ask', task: 'API-2' }]);
    assert.equal(s.board.state.seq, seq, 'nothing journaled');
    assert.equal(s.board.state.tasks['API-2'].status, 'doing');
    // An open ask makes the same write valid.
    await s.write(s.coord, 'ask.raise', 'API-2', { text: 'Which limit?' });
    r = await s.write(s.coord, 'task.update', 'API-2', { status: 'waiting' }, { expected_revision: rev(s, 'API-2') });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    // task.create is checked the same way.
    r = await s.write(s.coord, 'task.create', 'NEW-1', { title: 'x', status: 'waiting', steps: [{ id: 's1', label: 'L', zone: 'build', state: 'waiting' }] });
    assert.equal(r.status, 400);
    assert.deepEqual(r.body.violations, [{ error: 'waiting_status_without_ask', task: 'NEW-1' }]);
    r = await s.write(s.coord, 'task.create', 'NEW-2', { title: 'x', status: 'waiting', steps: [{ id: 's1', label: 'L', zone: 'owner', state: 'waiting' }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  } finally { await s.close(); }
});

test('task status and step state: unknown values are refused by the schema', async () => {
  const s = await startSeeded();
  try {
    const seq = s.board.state.seq;
    let r = await s.write(s.coord, 'task.update', 'API-2', { status: 'pending' }, { expected_revision: rev(s, 'API-2') });
    assert.equal(r.status, 400); assert.equal(r.body.error, 'invalid_data');
    r = await s.write(s.coord, 'step.update', 'API-2/s1', { state: 'doing' }, { expected_revision: stepRev(s, 'API-2/s1') });
    assert.equal(r.status, 400); assert.equal(r.body.error, 'invalid_data');
    assert.deepEqual(r.body.violations, [{ error: 'invalid_step_state', task: 'API-2', step: 's1', state: 'doing' }]);
    assert.equal(s.board.state.seq, seq);
  } finally { await s.close(); }
});

test('step state select: allowed change saved with who/when; a change that breaks the rules lists every violation', async () => {
  const s = await startSeeded();
  try {
    let r = await s.write(s.coord, 'step.update', 'WEB-3/s2', { state: 'done' }, { expected_revision: stepRev(s, 'WEB-3/s2') });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const st = s.board.state.steps['WEB-3/s2'];
    assert.equal(st.state, 'done');
    assert.equal(st.attribution.updated_by.name, 'coordinator');
    assert.ok(Date.parse(st.attribution.updated_at));
    await s.write(s.coord, 'task.create', 'R-1', { title: 'rules', steps: [
      { id: 's1', label: 'Ask', zone: 'owner', state: 'waiting' }, { id: 's2', label: 'Build', zone: 'build', state: 'active' }, { id: 's3', label: 'Ship', zone: 'ship', state: 'todo' }] });
    const seq = s.board.state.seq;
    r = await s.write(s.coord, 'step.update', 'R-1/s3', { state: 'done' }, { expected_revision: stepRev(s, 'R-1/s3') });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'waiting_before_done');
    assert.deepEqual(r.body.violations, [{ error: 'waiting_before_done', task: 'R-1', step: 's1' }]);
    assert.equal(s.board.state.seq, seq, 'nothing journaled');
    assert.equal(s.board.state.steps['R-1/s3'].state, 'todo');
  } finally { await s.close(); }
});

test('non-coordinator: a reporter cannot change task status or step state, nor read task history', async () => {
  const s = await startSeeded();
  try {
    const seq = s.board.state.seq;
    let r = await s.write(s.alpha, 'task.update', 'WEB-3', { status: 'doing' }, { expected_revision: rev(s, 'WEB-3') });
    assert.equal(r.status, 403); assert.equal(r.body.error, 'forbidden_for_role');
    r = await s.write(s.alpha, 'step.update', 'WEB-3/s2', { state: 'done' }, { expected_revision: stepRev(s, 'WEB-3/s2') });
    assert.equal(r.status, 403); assert.equal(r.body.error, 'forbidden_for_role');
    r = await s.write(null, 'task.update', 'WEB-3', { status: 'doing' }, { expected_revision: rev(s, 'WEB-3') });
    assert.equal(r.status, 401);
    assert.equal(s.board.state.seq, seq, 'nothing journaled');
    assert.equal((await s.call(s.alpha, 'GET', '/api/v1/events?task=WEB-3')).status, 403);
  } finally { await s.close(); }
});

test('rules: the waiting-status rule only looks at writes that set status waiting', () => {
  const st = emptyState();
  assert.deepEqual(violationsForWrite(st, { op: 'task.update', target_id: 'A', data: { status: 'blocked' } }), []);
  assert.deepEqual(violationsForWrite(st, { op: 'task.update', target_id: 'A', data: { title: 'x' } }), []);
  assert.deepEqual(violationsForWrite(st, { op: 'task.update', target_id: 'A', data: { status: 'waiting' } }), [{ error: 'waiting_status_without_ask', task: 'A' }]);
  st.inbox['inb-1'] = { id: 'inb-1', task_id: 'A', kind: 'ask', text: 'q' };
  assert.deepEqual(violationsForWrite(st, { op: 'task.update', target_id: 'A', data: { status: 'waiting' } }), [], 'an unresolved ask proposal counts');
});
