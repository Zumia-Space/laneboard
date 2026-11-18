// J-05 CoS route override (op roles.override): Sonnet allowed for one task code until a journaled expiry, with a
// visible step note; CoS-only; replay never recomputes the expiry from a newer clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createBoard } from '../src/board.mjs';
import { createServer } from '../src/server.mjs';
import { createLegacyCompat } from '../src/legacy-compat.mjs';
import { startSeeded, OWNER, rid, tmpDir } from './helpers.mjs';
import { s21Board, step } from './s21-helpers.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli-snapshot', 'cos-board.mjs');

const T0 = Date.parse('2026-05-01T09:00:00.000Z');
const iso = ms => new Date(ms).toISOString();

test('roles.override: CoS sets a 24 h Sonnet allowance and posts a visible note on the current step', async () => {
  const s = await startSeeded({ now: () => T0 });
  try {
    const r = await s.write(s.coord, 'roles.override', 'WEB-3', { reason: 'Ưu tiên việc gấp', lane: 'CoS' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const st = await s.state(OWNER);
    assert.deepEqual(st.route_override['WEB-3'], {
      model: 'sonnet', reason: 'Ưu tiên việc gấp', by: 'cos', at: iso(T0), expires: iso(T0 + 24 * 3600000), expired: false
    });
    const note = st.messages.find(m => m.task_id === 'WEB-3' && m.kind === 'note' && m.body.startsWith('CoS cho Sonnet làm:'));
    assert.ok(note, 'the note is in the task stream');
    assert.equal(note.scope.step_id, 's2', 'the note sits on the current step');
    assert.equal(note.body, 'CoS cho Sonnet làm: Ưu tiên việc gấp, hết hạn 16:00 02-05 giờ VN');
    const rec = st.feedback.find(f => f.id === note.id);
    assert.equal(rec.step_id, 's2');
    assert.equal(rec.info, true, 'the note is informational, not an item to handle');
    assert.equal(note.info, true, 'the message view carries it');
    assert.equal(rec.attribution.created_by.name, 'coordinator', 'attributed to the actor who set it');
  } finally { await s.close(); }
});

test('the CoS note is informational even when the owner sets it: no open-feedback count, no mark handled, legacy reads done', async () => {
  const s = await startSeeded({ now: () => T0 });
  try {
    const set = await s.write(OWNER, 'roles.override', 'WEB-3', { reason: 'owner sets it', lane: 'CoS' });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    const st = await s.state(OWNER);
    const rec = st.feedback.find(f => String(f.text || '').startsWith('CoS cho Sonnet làm:'));
    assert.equal(rec.attribution.created_by.role, 'owner', 'the owner did set it');
    assert.equal(rec.info, true);
    // A later ping reports how many owner items are open: the informational note is not one of them.
    await s.write(s.coord, 'ping.send', 'board', { kind: 'ask', task_id: 'WEB-3' });
    const after = await s.state(OWNER);
    assert.equal(after.pings.at(-1).open, 0, 'the note does not count as open owner feedback');
    const resolved = await s.write(OWNER, 'feedback.resolve', rec.id, {}, { expected_revision: rec.rev });
    assert.equal(resolved.status, 409);
    assert.equal(resolved.body.error, 'informational_note', 'there is nothing to mark handled');
    // A reply receipt may sit under it, but it cannot mark the notice received or resolved either.
    const receipt = await s.write(s.coord, 'feedback.add', 'WEB-3', { kind: 'receipt', reply_to: rec.id, text: 'Đổi: a\nLịch: b\nBước tiếp: c' });
    assert.equal(receipt.status, 200, JSON.stringify(receipt.body));
    const rec2 = (await s.state(OWNER)).feedback.find(f => f.id === rec.id);
    assert.equal(rec2.status, 'open');
    assert.equal(rec2.received, undefined, 'the notice is never received');
  } finally { await s.close(); }
});

test('roles.override: the lane must be CoS; a token lane CoS is accepted, request data cannot skip the check', async () => {
  const s = await startSeeded({ now: () => T0 });
  try {
    const denied = await s.write(s.coord, 'roles.override', 'WEB-3', { reason: 'not my call' });
    assert.equal(denied.status, 403); assert.equal(denied.body.error, 'cos_only');
    assert.equal((await s.state(OWNER)).route_override['WEB-3'], undefined, 'nothing stored');
    // A coordinator token that carries the CoS lane is checked by actor.lane, as every lane-scoped write is.
    const issued = await s.write(OWNER, 'token.issue', 'cos-coord', { role: 'coordinator', lane: 'CoS', replace_coordinator: true });
    assert.equal(issued.status, 200, JSON.stringify(issued.body));
    const ok = await s.write(issued.body.token, 'roles.override', 'WEB-3', { reason: 'actor lane', hours: 2 });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal((await s.state(OWNER)).route_override['WEB-3'].expires, iso(T0 + 2 * 3600000));
  } finally { await s.close(); }
});

test('roles.override: default 24 h, bounds 1..72, reason required and at most 200 characters', async () => {
  const s = await startSeeded({ now: () => T0 });
  try {
    const set = data => s.write(s.coord, 'roles.override', 'WEB-3', { lane: 'CoS', ...data });
    assert.equal((await set({ hours: 0, reason: 'x' })).status, 400, 'hours 0 is out of range');
    assert.equal((await set({ hours: 73, reason: 'x' })).status, 400, 'hours 73 is out of range');
    assert.equal((await set({ hours: 1.5, reason: 'x' })).status, 400, 'hours must be an integer');
    const noReason = await set({});
    assert.equal(noReason.status, 400); assert.equal(noReason.body.error, 'reason_required');
    // The hours are validated before the no-op: bad input is refused even when there is nothing to clear.
    const clearBad = await s.write(s.coord, 'roles.override', 'API-2', { clear: true, hours: 0, lane: 'CoS' });
    assert.equal(clearBad.status, 400, 'bad input is refused even when there is nothing to clear');
    assert.equal((await set({ reason: 'x'.repeat(201) })).status, 400, 'a 201-character reason is refused');
    const one = await set({ reason: 'one hour', hours: 1 });
    assert.equal(one.status, 200); assert.equal((await s.state(OWNER)).route_override['WEB-3'].expires, iso(T0 + 3600000));
    const max = await set({ reason: 'three days', hours: 72 });
    assert.equal(max.status, 200); assert.equal((await s.state(OWNER)).route_override['WEB-3'].expires, iso(T0 + 72 * 3600000));
  } finally { await s.close(); }
});

test('roles.override --clear removes the entry and posts its own note, with or without a reason', async () => {
  const s = await startSeeded({ now: () => T0 });
  try {
    await s.write(s.coord, 'roles.override', 'WEB-3', { reason: 'ưu tiên', lane: 'CoS' });
    const clear = await s.write(s.coord, 'roles.override', 'WEB-3', { clear: true, reason: 'Anh trả lại', lane: 'CoS' });
    assert.equal(clear.status, 200, JSON.stringify(clear.body));
    let st = await s.state(OWNER);
    assert.equal(st.route_override['WEB-3'], undefined);
    assert.ok(st.messages.some(m => m.body === 'CoS bỏ quyền Sonnet: Anh trả lại'));
    await s.write(s.coord, 'roles.override', 'WEB-3', { reason: 'again', lane: 'CoS' });
    await s.write(s.coord, 'roles.override', 'WEB-3', { clear: true, lane: 'CoS' });
    st = await s.state(OWNER);
    assert.ok(st.messages.some(m => m.body === 'CoS bỏ quyền Sonnet'));
    assert.equal(st.route_override['WEB-3'], undefined);
  } finally { await s.close(); }
});

test('an expired entry stays stored, reads as expired, and replay keeps the journaled expiry', async () => {
  let clock = T0;
  const s = await startSeeded({ now: () => clock });
  try {
    await s.write(s.coord, 'roles.override', 'WEB-3', { reason: 'short window', hours: 1, lane: 'CoS' });
    const stored = (await s.state(OWNER)).route_override['WEB-3'];
    assert.equal(stored.expired, false);
    clock += 2 * 3600000;
    const later = (await s.state(OWNER)).route_override['WEB-3'];
    assert.equal(later.expires, stored.expires, 'the expiry does not move');
    assert.equal(later.expired, true, 'past its expiry, the view says so');
    assert.ok(s.board.state.route_override['WEB-3'], 'the record itself is still stored');
    const journal = fs.readFileSync(path.join(s.dataDir, 'events.ndjson'), 'utf8').trim().split('\n').map(JSON.parse)
      .find(e => e.op === 'roles.override');
    assert.equal(journal.data.expires, stored.expires, 'the computed expiry is in the journal');
  } finally { await s.close(); }
  // A fresh board (projection removed, so the journal is replayed) with a later clock yields the same entry.
  fs.rmSync(path.join(s.dataDir, 'state.json'));
  const again = createBoard({ dataDir: s.dataDir, ownerToken: OWNER, now: () => clock });
  try {
    assert.deepEqual(again.state.route_override['WEB-3'], { model: 'sonnet', reason: 'short window', by: 'cos', at: iso(T0), expires: iso(T0 + 3600000) });
    assert.equal(again.view(OWNER).route_override['WEB-3'].expired, true);
  } finally { again.close(); }
});

test('legacy /api/state?v=2 carries routeOverride, with expired derived on every read', async () => {
  let clock = T0;
  const dataDir = tmpDir();
  const board = createBoard({ dataDir, ownerToken: OWNER, now: () => clock });
  const coord = board.write(OWNER, { version: 1, request_id: rid(), op: 'token.issue', target_id: 'coordinator', data: { role: 'coordinator' } }).token;
  board.write(coord, { version: 1, request_id: rid(), op: 'task.create', target_id: 'WEB-3', data: { title: 'Landing page', steps: [{ id: 's1', label: 'Build', zone: 'build', state: 'active' }] } });
  const tokenFile = path.join(tmpDir(), 'coord.token');
  fs.writeFileSync(tokenFile, coord + '\n');
  const server = createServer(board, { legacyCompat: createLegacyCompat(board, { tokenFile, dataDir }) });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const row = async () => (await (await fetch(url + '/api/state?v=2')).json()).tasks[0];
  // The route the CLI's `override` calls (loopback admin, as `escalate` does).
  const adminOverride = body => fetch(url + '/api/admin/override', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
  try {
    const set = await adminOverride({ code: 'WEB-3', reason: 'legacy admin', hours: 1, lane: 'CoS' });
    assert.equal(set.ok, true); assert.equal(set.route_override.model, 'sonnet');
    const first = await row();
    assert.deepEqual([first.routeOverride.model, first.routeOverride.expired], ['sonnet', false]);
    const legacyNote = (await (await fetch(url + '/api/state?v=2')).json()).feedback.find(f => f.text.startsWith('CoS cho Sonnet làm:'));
    assert.equal(legacyNote.status, 'done', 'the informational note is never an open item for a legacy reader');
    clock += 2 * 3600000;
    assert.equal((await row()).routeOverride.expired, true);
    const cleared = await adminOverride({ code: 'WEB-3', clear: true, reason: 'done', lane: 'CoS' });
    assert.deepEqual([cleared.ok, cleared.route_override], [true, null]);
    assert.equal((await row()).routeOverride, null);
    assert.equal(board.state.route_override['WEB-3'], undefined);
    const seq = board.state.seq, again = await adminOverride({ code: 'WEB-3', clear: true, lane: 'CoS' });
    assert.equal(again.ok, true); assert.equal(again.noop, true, 'a second clear writes nothing');
    assert.equal(board.state.seq, seq);
  } finally {
    server.closeAllConnections(); await new Promise(r => server.close(r)); board.close();
  }
});

test('roles.override --clear on a task with no allowance is a no-op: no event, no note (seen live)', async () => {
  const s = await startSeeded({ now: () => T0 });
  try {
    const before = (await s.state(OWNER)).seq;
    const first = await s.write(s.coord, 'roles.override', 'WEB-3', { clear: true, reason: 'nothing to clear', lane: 'CoS' });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.noop, true, 'the board answers success without journaling');
    let st = await s.state(OWNER);
    assert.equal(st.seq, before, 'no event was appended');
    assert.equal(st.route_override['WEB-3'], undefined);
    assert.ok(!st.messages.some(m => m.body.startsWith('CoS bỏ quyền Sonnet')), 'no clear note was written');
    assert.equal(s.board.state.seq, before, 'the projection did not move either');
    const again = await s.write(s.coord, 'roles.override', 'WEB-3', { clear: true, lane: 'CoS' });
    assert.equal(again.status, 200); assert.equal(again.body.noop, true);
    st = await s.state(OWNER);
    assert.equal(st.seq, before, 'a repeated clear is still a no-op');
    assert.ok(!st.messages.some(m => m.body === 'CoS bỏ quyền Sonnet'));
  } finally { await s.close(); }
});

