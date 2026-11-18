// Gap G2 of the live-board migration: board-level documents (summary + task registry), written whole under
// their own revision by the owner or the coordinator, readable by any token holder, never by anonymous readers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startSeeded, OWNER } from './helpers.mjs';

const ENTRY = { id: 'c8bd0a29dfbf', code: 'A1', title: 'Video clip', file: 'A1 — Video clip', note: 'active', updated: '2026-07-24', on_board: false, status: 'open' };

test('summary.set / registry.set: revision-guarded whole-document writes by owner or coordinator', async () => {
  const s = await startSeeded();
  try {
    let r = await s.write(s.coord, 'summary.set', 'board', { items: ['line one', 'line two'] });
    assert.equal(r.status, 400); assert.equal(r.body.error, 'expected_revision_required');
    r = await s.write(s.coord, 'summary.set', 'board', { items: ['line one', 'line two'] }, { expected_revision: 0 });
    assert.equal(r.status, 200); assert.equal(r.body.revision, 1);
    r = await s.write(OWNER, 'summary.set', 'board', { items: ['stale edit'] }, { expected_revision: 0 });
    assert.equal(r.status, 409); assert.equal(r.body.current_revision, 1);
    r = await s.write(OWNER, 'summary.set', 'board', { items: ['owner edit'] }, { expected_revision: 1 });
    assert.equal(r.status, 200); assert.equal(r.body.revision, 2);

    r = await s.write(s.alpha, 'registry.set', 'board', { entries: [ENTRY] }, { expected_revision: 0 });
    assert.equal(r.status, 403, 'reporters cannot edit board documents');
    r = await s.write(OWNER, 'registry.set', 'board', { entries: [ENTRY, ENTRY] }, { expected_revision: 0 });
    assert.equal(r.status, 400); assert.equal(r.body.error, 'duplicate_entry_id');
    r = await s.write(OWNER, 'registry.set', 'board', { entries: [{ ...ENTRY, status: 'archived' }] }, { expected_revision: 0 });
    assert.equal(r.status, 400); assert.equal(r.body.error, 'invalid_data');
    r = await s.write(OWNER, 'registry.set', 'board', { entries: [ENTRY] }, { expected_revision: 0 });
    assert.equal(r.status, 200);
    r = await s.write(s.coord, 'registry.set', 'board', { entries: [{ ...ENTRY, status: 'paused', status_by: 'coordinator' }] }, { expected_revision: 1 });
    assert.equal(r.status, 200);
    r = await s.write(OWNER, 'summary.set', 'WEB-3', { items: ['x'] }, { expected_revision: 2 });
    assert.equal(r.status, 400); assert.equal(r.body.error, 'invalid_target_id');

    const st = await s.state(s.coord);
    assert.deepEqual(st.docs.summary.items, ['owner edit']);
    assert.equal(st.docs.summary.attribution.updated_by.name, 'owner');
    assert.equal(st.docs.registry.rev, 2);
    assert.equal(st.docs.registry.entries[0].status, 'paused');
    assert.equal(st.docs.registry.entries[0].status_by, 'coordinator');
    assert.equal((await s.state(null)).docs, undefined, 'anonymous readers never see board documents');
  } finally { await s.close(); }
});
