// Retries, conflicts and concurrent writers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startSeeded, OWNER } from './helpers.mjs';

const journalLines = s => fs.readFileSync(path.join(s.dataDir, 'events.ndjson'), 'utf8').trim().split('\n').map(l => JSON.parse(l));

test('a retried request is applied once and returns the original result', async () => {
  const s = await startSeeded();
  try {
    const body = { version: 1, request_id: 'retry-same-0001', op: 'inbox.submit', target_id: 'WEB-3', data: { kind: 'ask', text: 'Ship Friday?' } };
    const a = await s.call(s.alpha, 'POST', '/api/v1/write', body);
    const b = await s.call(s.alpha, 'POST', '/api/v1/write', body);
    assert.equal(a.status, 200); assert.equal(b.status, 200);
    assert.equal(b.body.deduped, true);
    assert.equal(b.body.event_id, a.body.event_id); assert.equal(b.body.id, a.body.id);
    assert.equal(journalLines(s).filter(e => e.request_id === body.request_id).length, 1);
    assert.equal((await s.state(OWNER)).inbox.length, 1);
  } finally { await s.close(); }
});

test('reusing a request_id for a different body is a conflict, not a silent overwrite', async () => {
  const s = await startSeeded();
  try {
    const base = { version: 1, request_id: 'retry-diff-0001', op: 'inbox.submit', target_id: 'WEB-3' };
    assert.equal((await s.call(s.alpha, 'POST', '/api/v1/write', { ...base, data: { kind: 'report', text: 'one' } })).status, 200);
    const r = await s.call(s.alpha, 'POST', '/api/v1/write', { ...base, data: { kind: 'report', text: 'two' } });
    assert.equal(r.status, 409); assert.equal(r.body.error, 'request_id_reused');
  } finally { await s.close(); }
});

test('stale expected_revision is rejected with the current revision; missing revision is rejected', async () => {
  const s = await startSeeded();
  try {
    assert.equal((await s.write(s.coord, 'step.update', 'WEB-3/s2', { state: 'blocked' }, { expected_revision: 1 })).status, 200);
    const stale = await s.write(s.coord, 'step.update', 'WEB-3/s2', { state: 'done' }, { expected_revision: 1 });
    assert.equal(stale.status, 409); assert.equal(stale.body.error, 'revision_conflict'); assert.equal(stale.body.current_revision, 2);
    const missing = await s.write(s.coord, 'step.update', 'WEB-3/s2', { state: 'done' });
    assert.equal(missing.status, 400); assert.equal(missing.body.error, 'expected_revision_required');
    const exists = await s.write(s.coord, 'task.create', 'WEB-3', { title: 'again' });
    assert.equal(exists.status, 409); assert.equal(exists.body.error, 'exists');
    const answeredTwice = (await s.write(s.coord, 'ask.raise', 'WEB-3', { text: 'q' })).body.id;
    assert.equal((await s.write(OWNER, 'ask.answer', answeredTwice, { text: 'yes' }, { expected_revision: 1 })).status, 200);
    assert.equal((await s.write(OWNER, 'ask.answer', answeredTwice, { text: 'no' }, { expected_revision: 2 })).status, 409);
  } finally { await s.close(); }
});

test('two concurrent writers on the same revision: exactly one wins', async () => {
  const s = await startSeeded();
  try {
    const [a, b] = await Promise.all([
      s.write(s.coord, 'step.update', 'WEB-3/s2', { state: 'done' }, { expected_revision: 1 }),
      s.write(OWNER, 'step.update', 'WEB-3/s2', { state: 'blocked' }, { expected_revision: 1 })
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    const st = await s.state(OWNER);
    const step = st.tasks.find(t => t.id === 'WEB-3').steps.find(x => x.id === 'WEB-3/s2');
    assert.equal(step.rev, 2);
    assert.equal(step.state, a.status === 200 ? 'done' : 'blocked');
  } finally { await s.close(); }
});

test('an inbox item is resolved once', async () => {
  const s = await startSeeded();
  try {
    const id = (await s.write(s.alpha, 'inbox.submit', 'WEB-3', { kind: 'step', step_id: 's2', state: 'done', text: '' })).body.id;
    assert.equal((await s.write(s.coord, 'inbox.merge', id, { action: 'accept' }, { expected_revision: 1 })).status, 200);
    const again = await s.write(s.coord, 'inbox.merge', id, { action: 'dismiss' }, { expected_revision: 2 });
    assert.equal(again.status, 409); assert.equal(again.body.error, 'already_resolved');
    const st = await s.state(OWNER);
    assert.equal(st.tasks.find(t => t.id === 'WEB-3').steps[1].state, 'done', 'accepted step proposal was applied');
    assert.equal(st.inbox[0].text, '', 'inbox content unchanged by the merge');
  } finally { await s.close(); }
});
