// J-05 worker-machine-0811: the page names the machines next to the model pick. The page functions are lifted out of
// public/app.js and run in a vm with the real locale files and the real registry (public/machines.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const APP = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');
const REG = fs.readFileSync(path.join(PUB, 'machines.js'), 'utf8');
const load = l => JSON.parse(fs.readFileSync(path.join(PUB, 'locales', `${l}.json`), 'utf8'));
const LOC = { en: load('en'), vi: load('vi'), zh: load('zh') };

function lift(name) {
  const line = APP.match(new RegExp(`^const ${name} = .*;$`, 'm'));
  if (line) return line[0];
  const start = APP.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `app.js has no ${name}`);
  return APP.slice(start, APP.indexOf('\n}\n', start) + 2);
}
function page(lang, wkPop = '') {
  const ctx = vm.createContext({ window: {}, S: { dict: LOC[lang], en: LOC.en, wkPop } });
  vm.runInContext(REG, ctx);
  vm.runInContext(['esc', 't', 'ROLE_SLOTS', 'MC', 'machineOf', 'machineLine', 'machineFields', 'wkMachineChip'].map(lift).join('\n'), ctx);
  return ctx;
}
const ACME = { id: 'ACME-01', coordinator: 'main', worker_machines: ['laptop'], machines_by: 'owner',
  roles: { plan: { model: 'opus', effort: 'high', machine: 'laptop' }, code: { model: 'opus', effort: 'high', machine: 'laptop' }, review: { model: 'opus', effort: 'high', machine: 'laptop' }, scout: { model: 'haiku', effort: 'low', machine: 'laptop' } } };
const OLD = { id: 'WEB-3', roles: { plan: { model: 'opus', effort: 'high' }, code: { model: 'sonnet', effort: 'high' }, review: { model: 'opus', effort: 'high' }, scout: { model: 'haiku', effort: 'low' } } };
const run = (p, code) => vm.runInContext(code, p);

test('the task header line reads "Điều phối: Máy 1 · Làm: Máy 3 (laptop)" for ACME-01', () => {
  const p = page('vi');
  const html = run(p, `machineLine(${JSON.stringify(ACME)})`);
  assert.ok(html.includes('Điều phối: Máy 1 · Làm: Máy 3 (laptop)'), html);
  assert.match(html, /data-machines="ACME-01"/);
  for (const lang of ['en', 'zh']) assert.ok(!run(page(lang), `machineLine(${JSON.stringify(ACME)})`).includes('{'), `${lang}: every placeholder filled`);
});

test('a task with no machine fields reads the defaults: Máy 1 coordinates and works', () => {
  const html = run(page('vi'), `machineLine(${JSON.stringify(OLD)})`);
  assert.ok(html.includes('Điều phối: Máy 1 · Làm: Máy 1 (main)'), html);
  assert.equal(run(page('vi'), `machineOf(${JSON.stringify(OLD)}, 'code')`), 'main');
});

test('the owner picker: a coordinator select, one checkbox per machine, a machine select per role slot limited to the workers', () => {
  const p = page('vi');
  const html = run(p, `machineFields(${JSON.stringify({ ...ACME, worker_machines: ['laptop', 'spare'], roles: { ...ACME.roles, review: { ...ACME.roles.review, machine: 'spare' } } })}, true)`);
  assert.match(html, /<select data-machine-coord="ACME-01"/);
  for (const m of ['main', 'spare', 'laptop']) assert.match(html, new RegExp(`<input type="checkbox" data-machine-worker="ACME-01" value="${m}"`), m);
  assert.match(html, /value="laptop"[^>]*checked/);
  assert.match(html, /value="spare"[^>]*checked/);
  assert.doesNotMatch(html, /data-machine-worker="ACME-01" value="main"[^>]*checked/);
  assert.equal((html.match(/data-machine-slot="ACME-01"/g) || []).length, 4, 'one select per role slot');
  const review = html.slice(html.indexOf('data-role="review"'), html.indexOf('</select>', html.indexOf('data-role="review"')));
  assert.match(review, /<option value="spare" selected>/);
  assert.doesNotMatch(review, /value="main"/, 'a slot only offers the worker machines');
  assert.ok(html.includes('Máy 3 (laptop)'));
});

test('read-only readers see the text, no inputs; the chip opens the picker like a model chip', () => {
  const p = page('vi');
  const ro = run(p, `machineFields(${JSON.stringify(ACME)}, false)`);
  assert.doesNotMatch(ro, /<select|<input/);
  assert.ok(ro.includes('Máy 3 (laptop)'));
  const closed = run(p, `wkMachineChip(${JSON.stringify(ACME)}, true)`);
  assert.match(closed, /data-action="wk-pop" data-key="ACME-01:machines"/);
  assert.doesNotMatch(closed, /wk-pop" role="dialog"/);
  const open = run(page('vi', 'ACME-01:machines'), `wkMachineChip(${JSON.stringify(ACME)}, true)`);
  assert.match(open, /class="wk-pop wk-mpop" role="dialog"/);
  assert.match(open, /data-machine-coord="ACME-01"/);
});
