// Durability: journal before projection, replay after crash, owner attention survives restart,
// stall and timing from the server clock only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createBoard } from '../src/board.mjs';
import { OWNER, tmpDir } from './helpers.mjs';

let n = 0;
const req = (op, target_id, data, extra = {}) => ({ version: 1, request_id: `replay-${process.pid}-${++n}`, op, target_id, data, ...extra });
function seeded(dataDir, opts = {}) {
  const b = createBoard({ dataDir, ownerToken: OWNER, ...opts });
  const coord = b.write(OWNER, req('token.issue', 'coordinator', { role: 'coordinator' })).token;
  const lane = b.write(OWNER, req('token.issue', 'workera-lane', { role: 'reporter', lane: 'workera-lane' })).token;
  b.write(coord, req('task.create', 'REL-1', { title: 'Release train', lane: 'workera-lane', steps: [
    { id: 's1', label: 'Cut release', zone: 'build', state: 'active' },
    { id: 's2', label: 'Owner GO', zone: 'owner', state: 'todo' }] }));
  return { b, coord, lane };
}
const clone = o => JSON.parse(JSON.stringify(o));

test('crash between journal and projection: restart replays the event; the client retry is deduped', async () => {
  const dir = tmpDir();
  const { b, coord } = seeded(dir);
  const body = req('step.update', 'REL-1/s1', { state: 'done' }, { expected_revision: 1 });
  assert.throws(() => b.write(coord, body, { crashAfterJournal: true }), /simulated crash/);
  b.close();

  const b2 = createBoard({ dataDir: dir, ownerToken: OWNER });
  assert.equal(b2.replayed, 1);
  assert.equal(b2.state.steps['REL-1/s1'].state, 'done');
  const retry = b2.write(coord, body);
  assert.equal(retry.deduped, true);
  const lines = fs.readFileSync(path.join(dir, 'events.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(lines.filter(e => e.request_id === body.request_id).length, 1, 'exactly one accepted event');
  b2.close();
});

test('deleted or stale projections are rebuilt from the journal to the same state', async () => {
  const dir = tmpDir();
  const { b, coord, lane } = seeded(dir);
  const early = fs.readFileSync(path.join(dir, 'state.json'), 'utf8');
  b.write(lane, req('inbox.submit', 'REL-1', { kind: 'ask', text: 'GO for release?' }));
  b.write(coord, req('step.update', 'REL-1/s1', { state: 'done' }, { expected_revision: 1 }));
  const final = clone(b.state);
  b.close();

  fs.writeFileSync(path.join(dir, 'state.json'), early); // stale snapshot
  let b2 = createBoard({ dataDir: dir, ownerToken: OWNER });
  assert.equal(b2.replayed, 2);
  assert.deepEqual(clone(b2.state), final);
  b2.close();

  fs.rmSync(path.join(dir, 'state.json')); // lost snapshot
  b2 = createBoard({ dataDir: dir, ownerToken: OWNER });
  assert.deepEqual(clone(b2.state), final);
  b2.close();
});

test('a torn final journal line is cut; a projection ahead of the journal refuses to start', async () => {
  const dir = tmpDir();
  const { b } = seeded(dir);
  const seq = b.state.seq;
  b.close();
  fs.appendFileSync(path.join(dir, 'events.ndjson'), '{"seq":99,"id":"evt-99","at":"2026');
  const b2 = createBoard({ dataDir: dir, ownerToken: OWNER });
  assert.equal(b2.state.seq, seq);
  assert.ok(fs.readFileSync(path.join(dir, 'events.ndjson'), 'utf8').endsWith('\n'));
  b2.close();

  const st = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  st.seq += 5;
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(st));
  assert.throws(() => createBoard({ dataDir: dir, ownerToken: OWNER }), /ahead of the journal/);
});

test('incident replay: a lane ask reaches the owner at once, survives restart, and leaves only when resolved', async () => {
  const dir = tmpDir();
  const { b, coord, lane } = seeded(dir);
  // The lane raises its ask the only way it can: into the inbox. No coordinator summary involved.
  const inb = b.write(lane, req('inbox.submit', 'REL-1', { kind: 'ask', step_id: 's2', text: 'Backend cut ready. GO?', options: [{ key: 'GO', label: 'Go' }, { key: 'WAIT', label: 'Wait' }] }));
  let waiting = b.view(OWNER).attention.waiting;
  assert.deepEqual(waiting.map(w => [w.kind, w.id, w.from.name]), [['proposal', inb.id, 'workera-lane']]);
  b.close();

  const b2 = createBoard({ dataDir: dir, ownerToken: OWNER });
  waiting = b2.view(OWNER).attention.waiting;
  assert.equal(waiting.length, 1, 'still visible after restart'); assert.equal(waiting[0].id, inb.id);

  const merged = b2.write(coord, req('inbox.merge', inb.id, { action: 'accept' }, { expected_revision: 1 }));
  assert.equal(merged.ok, true);
  waiting = b2.view(OWNER).attention.waiting;
  assert.equal(waiting.length, 1); assert.equal(waiting[0].kind, 'ask'); assert.equal(waiting[0].from.name, 'workera-lane', 'the ask keeps its original author');
  const askId = waiting[0].id;
  b2.write(OWNER, req('ask.answer', askId, { choice: 'GO' }, { expected_revision: 1 }));
  const att = b2.view(OWNER).attention;
  assert.equal(att.waiting.length, 0);
  assert.deepEqual(att.answered.map(a => [a.id, a.choice]), [[askId, 'GO']]);
  b2.close();
});

test('a step waiting in the owner zone shows even without an ask; paused tasks drop out', async () => {
  const dir = tmpDir();
  const { b, coord } = seeded(dir);
  b.write(coord, req('step.update', 'REL-1/s2', { state: 'waiting' }, { expected_revision: 1 }));
  assert.deepEqual(b.view(OWNER).attention.waiting.map(w => [w.kind, w.id]), [['step', 'REL-1/s2']]);
  b.write(coord, req('task.update', 'REL-1', { status: 'paused' }, { expected_revision: 1 }));
  assert.equal(b.view(OWNER).attention.waiting.length, 0);
  b.close();
});

test('stalled list and step timing come from the server clock', async () => {
  let clock = Date.parse('2026-05-01T09:00:00.000Z');
  const now = () => clock;
  const dir = tmpDir();
  const { b, coord } = seeded(dir, { now, stallMs: 3 * 3600000 });
  assert.equal(b.view(OWNER).stalled.length, 0);
  clock += 3 * 3600000 + 1000;
  assert.deepEqual(b.view(OWNER).stalled.map(x => x.task_id), ['REL-1']);
  b.write(coord, req('step.update', 'REL-1/s2', { state: 'waiting' }, { expected_revision: 1 }));
  assert.equal(b.view(OWNER).stalled.length, 0, 'any accepted event on the task resets idleness');
  clock += 20 * 60000;
  b.write(coord, req('step.update', 'REL-1/s2', { state: 'done' }, { expected_revision: 2 }));
  const t = b.state.times['REL-1/s2'];
  assert.equal(t.waiting_total_ms, 20 * 60000);
  assert.equal(t.done_at, new Date(clock).toISOString());
  assert.deepEqual(t.transitions.map(x => x.to), ['waiting', 'done']);
  b.close();
});

test('a waiting owner step whose ask was answered during this wait leaves the owner block until it waits again', async () => {
  const dir = tmpDir();
  let clock = Date.parse('2026-09-28T06:00:00.000Z');
  const { b, coord } = seeded(dir, { now: () => clock });
  b.write(coord, req('step.update', 'REL-1/s2', { state: 'waiting' }, { expected_revision: 1 }));
  clock += 1000;
  const ask = b.write(coord, req('ask.raise', 'REL-1', { step_id: 's2', text: 'GO?', options: [{ key: 'GO', label: 'Go' }] }));
  clock += 1000;
  b.write(OWNER, req('ask.answer', ask.id, { choice: 'GO' }, { expected_revision: 1 }));
  assert.deepEqual(b.view(OWNER).attention.waiting, [], 'answered: the step no longer asks the owner');
  clock += 1000; b.write(coord, req('step.update', 'REL-1/s2', { state: 'active' }, { expected_revision: 2 }));
  clock += 1000; b.write(coord, req('step.update', 'REL-1/s2', { state: 'waiting' }, { expected_revision: 3 }));
  assert.deepEqual(b.view(OWNER).attention.waiting.map(w => [w.kind, w.id]), [['step', 'REL-1/s2']], 'a new wait shows again');
  b.close();
});
