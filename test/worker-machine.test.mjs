// J-05 worker-machine-0811: the worker pick names the MACHINE as well as the model (owner 08-11). A task's route gains
// `coordinator` (default main) and `worker_machines` (default [main]); every role slot gains `machine`, defaulting to
// worker_machines[0]. Old boards and old routes carry none of these fields and read as the defaults.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MACHINES, MACHINE_IDS, resolveMachines, slotMachine, machineText } from '../src/machines.mjs';
import { startSeeded, OWNER } from './helpers.mjs';
import { s21Board, step } from './s21-helpers.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli-snapshot', 'cos-board.mjs');
const runCli = (env, args) => new Promise(resolve => execFile(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 60000, env: { ...process.env, ...env } },
  (e, out, err) => resolve({ code: e ? e.code : 0, out, err })));

test('registry: three machines, Máy 1 main coordinator, Máy 2 spare (Worker-A/Worker-B by mail lanes), Máy 3 laptop (ssh claude -p)', () => {
  assert.deepEqual(MACHINE_IDS, ['main', 'spare', 'laptop']);
  assert.equal(MACHINES.main.label, 'Máy 1');
  assert.equal(MACHINES.spare.label, 'Máy 2');
  assert.deepEqual(MACHINES.spare.lanes, ['worker-a', 'worker-b']);
  assert.equal(MACHINES.laptop.label, 'Máy 3');
  for (const id of MACHINE_IDS) assert.ok(!('host' in MACHINES[id]), `${id}: the served registry names no hostname (J-05 machines-scrub)`);
  assert.match(MACHINES.laptop.reach, /claude -p/);
  assert.match(MACHINES.spare.reach, /mail/);
  assert.deepEqual(resolveMachines(undefined), { coordinator: 'main', worker_machines: ['main'], by: 'default' });
});

test('an old task with no machine entry sends no machine fields (older views stay byte-identical); readers apply the defaults', async () => {
  const s = await startSeeded();
  try {
    const st = await s.state(OWNER);
    const t = st.tasks.find(x => x.id === 'WEB-3');
    assert.equal(t.coordinator, undefined);
    assert.equal(t.worker_machines, undefined);
    assert.equal(t.roles.code.machine, undefined);
    assert.equal(st.machine_registry, undefined, 'the page reads the registry from public/machines.js, not the state');
    assert.deepEqual(resolveMachines(undefined), { coordinator: 'main', worker_machines: ['main'], by: 'default' });
    assert.equal(slotMachine(undefined, 'code'), 'main');
    assert.equal(slotMachine({ coordinator: 'main', worker_machines: ['laptop'], slots: { review: 'spare' } }, 'review'), 'laptop', 'a pick outside the workers falls back');
    assert.equal(machineText('laptop', true), 'Máy 3 (laptop)');
  } finally { await s.close(); }
});

test('machines.set: the owner picks coordinator + worker machines and one slot machine; slots default to worker_machines[0]', async () => {
  const s = await startSeeded();
  try {
    let r = await s.write(OWNER, 'machines.set', 'WEB-3', { coordinator: 'main', worker_machines: ['laptop'] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    let t = (await s.state(OWNER)).tasks.find(x => x.id === 'WEB-3');
    assert.equal(t.coordinator, 'main');
    assert.deepEqual(t.worker_machines, ['laptop']);
    assert.equal(t.machines_by, 'owner');
    for (const role of ['plan', 'code', 'review', 'scout']) assert.equal(t.roles[role].machine, 'laptop', role);
    assert.equal(t.roles.code.model, 'sonnet', 'the model slot is untouched');
    r = await s.write(OWNER, 'machines.set', 'WEB-3', { worker_machines: ['laptop', 'spare'], role: 'review', machine: 'spare' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    t = (await s.state(OWNER)).tasks.find(x => x.id === 'WEB-3');
    assert.equal(t.roles.review.machine, 'spare');
    assert.equal(t.roles.code.machine, 'laptop');
    // Narrowing the workers drops a slot pick that is no longer one of them, so the slot falls back to worker_machines[0].
    r = await s.write(OWNER, 'machines.set', 'WEB-3', { worker_machines: ['laptop'] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    t = (await s.state(OWNER)).tasks.find(x => x.id === 'WEB-3');
    assert.equal(t.roles.review.machine, 'laptop');
    const ev = (await s.call(OWNER, 'GET', '/api/v1/events?task=WEB-3')).body;
    const list = Array.isArray(ev) ? ev : ev.events || [];
    if (list.length) assert.ok(list.some(e => e.op === 'machines.set' && e.data.previous), 'the change journals what it replaced');
  } finally { await s.close(); }
});

test('machines.set refuses an unknown machine, a slot machine outside the workers, and a coordinator overwriting the owner', async () => {
  const s = await startSeeded();
  try {
    let r = await s.write(OWNER, 'machines.set', 'WEB-3', { worker_machines: ['moon'] });
    assert.equal(r.status, 400); assert.equal(r.body.error, 'unknown_machine');
    r = await s.write(OWNER, 'machines.set', 'WEB-3', { coordinator: 'moon' });
    assert.equal(r.status, 400); assert.equal(r.body.error, 'unknown_machine');
    r = await s.write(OWNER, 'machines.set', 'WEB-3', { worker_machines: ['laptop'], role: 'code', machine: 'spare' });
    assert.equal(r.status, 400); assert.equal(r.body.error, 'machine_not_in_workers');
    r = await s.write(OWNER, 'machines.set', 'WEB-3', { role: 'code' });
    assert.equal(r.status, 400, 'role and machine come together');
    // The coordinator may seed a task the owner has not set ...
    r = await s.write(s.coord, 'machines.set', 'API-2', { worker_machines: ['spare'] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    // ... but never overwrite the owner's pick.
    await s.write(OWNER, 'machines.set', 'WEB-3', { worker_machines: ['laptop'] });
    r = await s.write(s.coord, 'machines.set', 'WEB-3', { worker_machines: ['main'] });
    assert.equal(r.status, 409); assert.equal(r.body.error, 'owner_set');
    const reporter = await s.write(s.alpha, 'machines.set', 'WEB-3', { worker_machines: ['main'] });
    assert.equal(reporter.status, 403);
  } finally { await s.close(); }
});

test('task.delete drops the machine entry, so a re-created id reads the defaults again', async () => {
  const s = await startSeeded();
  try {
    await s.write(OWNER, 'machines.set', 'API-2', { worker_machines: ['laptop'] });
    const t = (await s.state(OWNER)).tasks.find(x => x.id === 'API-2');
    const del = await s.write(OWNER, 'task.delete', 'API-2', {}, { expected_revision: t.rev });
    assert.equal(del.status, 200, JSON.stringify(del.body));
    await s.write(s.coord, 'task.create', 'API-2', { title: 'again', steps: [{ id: 's1', label: 'x', zone: 'build', state: 'active' }] });
    const again = (await s.state(OWNER)).tasks.find(x => x.id === 'API-2');
    assert.equal(again.worker_machines, undefined, 'no entry left: the defaults apply');
  } finally { await s.close(); }
});


test('legacy /api/state v2 rows carry the machine fields (server half); a task with no entry sends none', async () => {
  const s = await s21Board();
  try {
    s.w('task.create', 'ACME-01', { title: 'Acme', lane: 'CoS', steps: [step('s1', 'active')] });
    s.w('task.create', 'J-05', { title: 'Board', lane: 'CoS', steps: [step('s1', 'active')] });
    s.w('machines.set', 'ACME-01', { coordinator: 'main', worker_machines: ['laptop'] });
    const row = await s.code('ACME-01', 2);
    assert.equal(row.coordinator, 'main');
    assert.deepEqual(row.workerMachines, ['laptop']);
    assert.equal(row.roles.code.machine, 'laptop');
    const plain = await s.code('J-05', 2);
    assert.equal(plain.coordinator, undefined, 'no entry: no machine fields on the row (readers apply the defaults)');
    assert.equal(plain.workerMachines, undefined);
  } finally { await s.close(); }
});
