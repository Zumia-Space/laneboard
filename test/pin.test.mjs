// J-05 pin-0811: the owner pins key tasks. A pin lives in its own map (state.pins), so a lane's row push or a
// task.update never touches it; the board view adds pinned/pinned_at only to a pinned task, the legacy v2 row adds
// pinned/pinnedAt, and the CLI reads both. Closing or deleting a task drops its pin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer, startSeeded, OWNER, tmpDir } from './helpers.mjs';
import { s21Board, step, rowOf } from './s21-helpers.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli-snapshot', 'cos-board.mjs');
const runCli = (env, args) => new Promise(resolve => execFile(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 60000, env: { ...process.env, ...env } },
  (e, out, err) => resolve({ code: e ? e.code : 0, out, err })));

test('pin.set toggles on and off, re-pinning keeps the first time, and the pin survives a restart (journal replay)', async () => {
  const dataDir = tmpDir();
  const s1 = await startSeeded({ dataDir });
  let first;
  try {
    assert.equal((await s1.state(OWNER)).tasks.find(x => x.id === 'WEB-3').pinned, undefined, 'an unpinned task sends no field');
    let r = await s1.write(OWNER, 'pin.set', 'WEB-3', { pinned: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    let t = (await s1.state(OWNER)).tasks.find(x => x.id === 'WEB-3');
    assert.equal(t.pinned, true);
    assert.match(t.pinned_at, /^\d{4}-\d\d-\d\dT/);
    first = t.pinned_at;
    assert.equal(s1.board.state.pins['WEB-3'].by.role, 'owner');
    r = await s1.write(OWNER, 'pin.set', 'WEB-3', { pinned: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await s1.state(OWNER)).tasks.find(x => x.id === 'WEB-3').pinned_at, first, 're-pinning keeps the original pinned_at');
    r = await s1.write(OWNER, 'pin.set', 'WEB-3', { pinned: false });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await s1.state(OWNER)).tasks.find(x => x.id === 'WEB-3').pinned, undefined);
    assert.equal(s1.board.state.pins['WEB-3'], undefined, 'unpinning deletes the entry');
    assert.equal((await s1.write(OWNER, 'pin.set', 'API-2', { pinned: true })).status, 200);
  } finally { await s1.close(); }
  const s2 = await startServer({ dataDir });
  try {
    const again = await s2.state(OWNER);
    assert.equal(again.tasks.find(x => x.id === 'API-2').pinned, true, 'the journal replay restores the pin');
    assert.match(again.tasks.find(x => x.id === 'API-2').pinned_at, /^\d{4}-\d\d-\d\dT/);
    assert.equal(again.tasks.find(x => x.id === 'WEB-3').pinned, undefined);
  } finally { await s2.close(); }
});

test('pin.set is owner-only and refuses an unknown task', async () => {
  const s = await startSeeded();
  try {
    let r = await s.write(s.coord, 'pin.set', 'WEB-3', { pinned: true });
    assert.equal(r.status, 403); assert.equal(r.body.error, 'forbidden_for_role');
    r = await s.write(s.alpha, 'pin.set', 'WEB-3', { pinned: true });
    assert.equal(r.status, 403);
    r = await s.write(OWNER, 'pin.set', 'NOPE-1', { pinned: true });
    assert.equal(r.status, 404); assert.equal(r.body.error, 'task_not_found');
    r = await s.write(OWNER, 'pin.set', 'WEB-3', { pinned: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  } finally { await s.close(); }
});

test('a lane row push and a task.update keep the pin: pins live in their own map', async () => {
  const s = await s21Board();
  try {
    s.w('task.create', 'ACME-01', { title: 'Acme Tours', lane: 'CoS', now: 'before', steps: [step('s1', 'active')] });
    s.ownerW('pin.set', 'ACME-01', { pinned: true });
    const at = s.board.state.pins['ACME-01'].pinned_at, rev = s.board.state.tasks['ACME-01'].rev;
    s.w('task.update', 'ACME-01', { now: 'after the op update' }, { expected_revision: rev });
    assert.equal(s.board.state.pins['ACME-01'].pinned_at, at, 'task.update never touches the pin');
    const r = await s.push([rowOf(s, 'ACME-01', { now: 'after the row push' })], { lane: 'CoS' }); // the path cos-board.mjs push uses
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(s.board.state.pins['ACME-01'].pinned_at, at, 'a row push never touches the pin');
    const row = await s.code('ACME-01', 2);
    assert.equal(row.pinned, true);
    assert.equal(row.pinnedAt, at);
    assert.equal((await s.v1state()).tasks.find(x => x.id === 'ACME-01').pinned, true);
  } finally { await s.close(); }
});

test('closing or deleting a task drops its pin', async () => {
  const s = await startSeeded();
  try {
    await s.write(OWNER, 'pin.set', 'WEB-3', { pinned: true });
    const t = (await s.state(OWNER)).tasks.find(x => x.id === 'WEB-3');
    const r = await s.write(OWNER, 'task.update', 'WEB-3', { status: 'closed' }, { expected_revision: t.rev });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await s.state(OWNER)).tasks.find(x => x.id === 'WEB-3').pinned, undefined);
    assert.equal(s.board.state.pins['WEB-3'], undefined);
    await s.write(OWNER, 'pin.set', 'API-2', { pinned: true });
    const api = (await s.state(OWNER)).tasks.find(x => x.id === 'API-2');
    const del = await s.write(OWNER, 'task.delete', 'API-2', {}, { expected_revision: api.rev });
    assert.equal(del.status, 200, JSON.stringify(del.body));
    assert.equal(s.board.state.pins['API-2'], undefined, 'a deleted task leaves no pin');
  } finally { await s.close(); }
});

test('a closed task cannot be pinned (409 task_closed), so no pin outlives its task; unpinning it is still allowed', async () => {
  const s = await startSeeded();
  try {
    const t = (await s.state(OWNER)).tasks.find(x => x.id === 'WEB-3');
    assert.equal((await s.write(OWNER, 'task.update', 'WEB-3', { status: 'closed' }, { expected_revision: t.rev })).status, 200);
    const r = await s.write(OWNER, 'pin.set', 'WEB-3', { pinned: true });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(s.board.state.pins['WEB-3'], undefined);
    assert.equal((await s.write(OWNER, 'pin.set', 'WEB-3', { pinned: false })).status, 200);
  } finally { await s.close(); }
});

test('the owner phone (device token) may pin: the mobile Board tab uses the same op', async () => {
  const s = await startSeeded();
  try {
    const phone = (await s.write(OWNER, 'token.issue', 'phone-1', { role: 'owner', label: 'phone-1', device: true })).body.token;
    const r = await s.write(phone, 'pin.set', 'WEB-3', { pinned: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await s.state(OWNER)).tasks.find(x => x.id === 'WEB-3').pinned, true);
  } finally { await s.close(); }
});
