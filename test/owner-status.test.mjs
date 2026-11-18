// A status the owner set (paused or closed) is the owner's: a coordinator or lane write may not change it until the
// owner writes on the task again (owner_set_status). Owner writes are always allowed. Incident 01-10: a coordinator
// write un-paused ACME-01 after the owner had paused it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startSeeded, OWNER } from './helpers.mjs';

const rev = (s, id) => s.board.state.tasks[id].rev;

test('owner pauses, a coordinator write status=doing is refused owner_set_status; the owner can still change it', async () => {
  const s = await startSeeded();
  try {
    assert.equal((await s.write(OWNER, 'task.update', 'API-2', { status: 'paused' }, { expected_revision: rev(s, 'API-2') })).status, 200);
    const seq = s.board.state.seq;
    const r = await s.write(s.coord, 'task.update', 'API-2', { status: 'doing' }, { expected_revision: rev(s, 'API-2') });
    assert.equal(r.status, 409);
    assert.deepEqual([r.body.error, r.body.status], ['owner_set_status', 'paused']);
    console.log('refused coordinator write:', JSON.stringify(r.body));
    assert.equal(s.board.state.seq, seq, 'nothing journaled');
    assert.equal(s.board.state.tasks['API-2'].status, 'paused');
    // other fields stay the coordinator's to write
    assert.equal((await s.write(s.coord, 'task.update', 'API-2', { now: 'waiting for the owner' }, { expected_revision: rev(s, 'API-2') })).status, 200);
    assert.equal((await s.write(OWNER, 'task.update', 'API-2', { status: 'doing' }, { expected_revision: rev(s, 'API-2') })).status, 200, 'owner writes are always allowed');
  } finally { await s.close(); }
});

test('owner pauses, then writes a message on the task: the coordinator may change the status again', async () => {
  const s = await startSeeded();
  try {
    assert.equal((await s.write(OWNER, 'task.update', 'API-2', { status: 'paused' }, { expected_revision: rev(s, 'API-2') })).status, 200);
    assert.equal((await s.write(OWNER, 'feedback.add', 'API-2', { kind: 'note', text: 'resume it, the client answered' })).status, 200);
    const r = await s.write(s.coord, 'task.update', 'API-2', { status: 'doing' }, { expected_revision: rev(s, 'API-2') });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(s.board.state.tasks['API-2'].status, 'doing');
  } finally { await s.close(); }
});

test('only the owner holds a status: a coordinator pause, a closed task and the status history', async () => {
  const s = await startSeeded();
  try {
    assert.equal((await s.write(s.coord, 'task.update', 'API-2', { status: 'paused' }, { expected_revision: rev(s, 'API-2') })).status, 200);
    assert.equal((await s.write(s.coord, 'task.update', 'API-2', { status: 'doing' }, { expected_revision: rev(s, 'API-2') })).status, 200, 'a coordinator pause is the coordinator\'s');
    assert.equal((await s.write(OWNER, 'task.update', 'API-2', { status: 'closed' }, { expected_revision: rev(s, 'API-2') })).status, 200);
    assert.equal((await s.write(s.coord, 'task.update', 'API-2', { status: 'doing' }, { expected_revision: rev(s, 'API-2') })).body.error, 'owner_set_status');
    const h = await s.call(OWNER, 'GET', '/api/v1/events?task=API-2&limit=100');
    assert.deepEqual(h.body.filter(e => e.op === 'task.update' && e.data.status).map(e => [e.data.status, e.actor.role]), [['paused', 'coordinator'], ['doing', 'coordinator'], ['closed', 'owner']], 'every change in the history');
  } finally { await s.close(); }
});
