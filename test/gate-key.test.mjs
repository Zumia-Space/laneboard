// J-05: a failed gate is counted on a stable key, so repeated attempts of one gate add up. The old labels
// ("S1 render r1 (timeout)", "S1 render r2 (slow)") share one key; the raw text stays in the journal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createBoard } from '../src/board.mjs';
import { normalizeGate } from '../src/gates.mjs';
import { startSeeded, OWNER } from './helpers.mjs';
import { s21Board, step } from './s21-helpers.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli-snapshot', 'cos-board.mjs');
const gateOf = async (s, id) => (await s.state(OWNER)).tasks.find(t => t.id === id).gate_fails;

test('normalizeGate: attempt markers and parentheticals do not make a new gate', () => {
  const raws = ['S1 render r1 (timeout: hung ssh, zero diff)', 'S1 render r2 (slow)', 'S1 render round 3', 'S1 render #4'];
  assert.deepEqual([...new Set(raws.map(r => normalizeGate(r)))], ['s1-render']);
  assert.equal(normalizeGate('  TSC --noEmit  '), 'tsc-noemit');
  assert.equal(normalizeGate('Deploy smoke  test'), 'deploy-smoke-test');
  assert.equal(normalizeGate('r1'), 'r1', 'a label that is only a round marker keeps a key');
  assert.equal(normalizeGate('(timeout)'), '', 'nothing but symptoms has no key');
  assert.equal(normalizeGate('x'.repeat(60)).length, 40);
});

test('roles.escalate: two attempts of one gate share a key and the count reaches 2', async () => {
  const s = await startSeeded();
  try {
    assert.equal((await s.write(s.coord, 'roles.escalate', 'WEB-3', { gate: 'S1 render r1 (timeout: hung ssh, zero diff)', reason: 'hung ssh', lane: 'CoS' })).status, 200);
    assert.equal((await s.write(s.coord, 'roles.escalate', 'WEB-3', { gate: 'S1 render r2 (slow)', reason: 'slow', lane: 'CoS' })).status, 200);
    const fails = await gateOf(s, 'WEB-3');
    assert.deepEqual(Object.keys(fails), ['s1-render'], 'one key, not one per attempt');
    assert.equal(fails['s1-render'].total, 2);
    assert.equal(fails['s1-render'].last_reason, 'slow');
    const code = (await s.state(OWNER)).tasks.find(t => t.id === 'WEB-3').roles.code;
    assert.deepEqual([code.model, code.by], ['opus', 'auto'], 'the 2-fail fallback fires on the shared key');
    // The event carries the key the count sits on and the text CoS wrote.
    const events = fs.readFileSync(path.join(s.dataDir, 'events.ndjson'), 'utf8').trim().split('\n').map(JSON.parse).filter(e => e.op === 'roles.escalate');
    assert.equal(events.at(-1).data.gate, 's1-render');
    assert.equal(events.at(-1).data.gate_raw, 'S1 render r2 (slow)');
  } finally { await s.close(); }
});

test('replay applies the journaled key, never re-normalising older events', async () => {
  const s = await startSeeded();
  let before;
  try {
    await s.write(s.coord, 'roles.escalate', 'WEB-3', { gate: 'S1 render r1', lane: 'CoS' });
    await s.write(s.coord, 'roles.escalate', 'WEB-3', { gate: 'S1 render r2', lane: 'CoS' });
    before = JSON.stringify(s.board.state);
  } finally { await s.close(); }
  fs.rmSync(path.join(s.dataDir, 'state.json'));
  const again = createBoard({ dataDir: s.dataDir, ownerToken: OWNER });
  try { assert.equal(JSON.stringify(again.state), before); } finally { again.close(); }
});


test('roles.escalate is CoS-only on the server: a coordinator without a CoS lane and /api/admin/escalate without one get 403 cos_only', async () => {
  const s = await s21Board();
  try {
    s.w('task.create', 'GATE-1', { title: 'Gate guard', lane: 'CoS', steps: [step('s1', 'active')] });
    const journalLines = () => fs.readFileSync(path.join(s.dataDir, 'events.ndjson'), 'utf8').trim().split('\n').length;
    const lines = journalLines();
    const w = (token, data) => s.v1(token, 'POST', '/api/v1/write', {
      version: 1, request_id: 'guard-' + crypto.randomBytes(6).toString('hex'), op: 'roles.escalate', target_id: 'GATE-1', data });
    // A coordinator token carries no lane: with no data.lane, or a lane that is not CoS, the write is refused.
    const noLane = await w(s.coord, { gate: 's1-render' });
    assert.equal(noLane.status, 403);
    assert.equal(noLane.body.error, 'cos_only');
    const otherLane = await w(s.coord, { gate: 's1-render', lane: 'worker-a' });
    assert.equal(otherLane.status, 403);
    assert.equal(otherLane.body.error, 'cos_only');
    // The loopback admin route forwards its caller's lane instead of blessing it: a lane that is not CoS is
    // refused, and a caller that names no lane is refused too (the adapter never invents a CoS identity).
    for (const body of [{ code: 'GATE-1', gate: 's1-render', lane: 'worker-a' }, { code: 'GATE-1', gate: 's1-render' }]) {
      const admin = await s.call('POST', '/api/admin/escalate', body);
      assert.equal(admin.status, 403, JSON.stringify(body));
      assert.equal(admin.body.error, 'cos_only');
    }
    assert.equal(journalLines(), lines, 'a refused escalation writes nothing');
    // A lane that says CoS and the owner may write it; the admin route passes a CoS lane through.
    assert.equal((await w(s.coord, { gate: 's1-render', lane: 'CoS' })).status, 200);
    assert.equal((await s.call('POST', '/api/admin/escalate', { code: 'GATE-1', gate: 's1-render', lane: 'CoS' })).status, 200);
    assert.equal((await w(OWNER, { gate: 's1-render' })).status, 200);
    assert.equal(s.board.state.gate_fails['GATE-1']['s1-render'].total, 3);
  } finally { await s.close(); }
});
