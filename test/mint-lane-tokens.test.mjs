// scripts/mint-lane-tokens.mjs: one reporter token per lane, written ONLY to the path given on the CLI
// (user-only ACL on Windows, mode 0600 elsewhere) and never printed. The test board is local; the live board
// is never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer, OWNER, tmpDir } from './helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'mint-lane-tokens.mjs');
const run = (args, timeout = 30000) => new Promise(resolve => {
  execFile(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout }, (e, out, err) => resolve({ code: e ? e.code : 0, out, err }));
});

test('mint: writes a lane token to the given file only, with its role, lane and scope, and prints no secret', async () => {
  const s = await startServer();
  const dir = s.dataDir;
  const ownerFile = path.join(dir, 'owner-mint.token');
  fs.writeFileSync(ownerFile, OWNER);
  try {
    const workeraOut = path.join(dir, 'secrets', 'workera.token');
    const workera = await run(['--board', s.url, '--owner-token-file', ownerFile, '--lane', 'workera', '--out', workeraOut]);
    assert.equal(workera.code, 0, workera.err);
    const workeraSecret = fs.readFileSync(workeraOut, 'utf8').trim();
    assert.match(workeraSecret, /^lb_[A-Za-z0-9_-]{20,}$/);
    assert.ok(!workera.out.includes(workeraSecret) && !workera.err.includes(workeraSecret), 'the secret is never printed');
    const actor = s.board.authenticate(workeraSecret);
    assert.equal(actor.role, 'reporter'); assert.equal(actor.lane, 'workera');
    assert.deepEqual(actor.scope_tasks, ['*']);
    assert.match(workera.out, /issued workera -> /);

    const laptopOut = path.join(dir, 'secrets', 'acme-laptop.token');
    const laptop = await run(['--board', s.url, '--owner-token-file', ownerFile, '--lane', 'acme-laptop', '--scope', 'ACME-01', '--label', 'new laptop', '--out', laptopOut]);
    assert.equal(laptop.code, 0, laptop.err);
    const laptopSecret = fs.readFileSync(laptopOut, 'utf8').trim();
    assert.ok(!laptop.out.includes(laptopSecret) && !laptop.err.includes(laptopSecret));
    const la = s.board.authenticate(laptopSecret);
    assert.equal(la.lane, 'acme-laptop'); assert.deepEqual(la.scope_tasks, ['ACME-01']); assert.equal(la.label, 'new laptop');

    if (process.platform !== 'win32') assert.equal(fs.statSync(workeraOut).mode & 0o777, 0o600, 'mode 0600 elsewhere');

    const again = await run(['--board', s.url, '--owner-token-file', ownerFile, '--lane', 'workera', '--out', workeraOut]);
    assert.equal(again.code, 1, 'an existing secret file is never overwritten silently');
    assert.equal(fs.readFileSync(workeraOut, 'utf8').trim(), workeraSecret);
    const forced = await run(['--board', s.url, '--owner-token-file', ownerFile, '--lane', 'workera', '--out', workeraOut, '--force']);
    assert.equal(forced.code, 0, forced.err);
    assert.notEqual(fs.readFileSync(workeraOut, 'utf8').trim(), workeraSecret, '--force replaces the token');
    assert.ok(!forced.out.includes(fs.readFileSync(workeraOut, 'utf8').trim()));
  } finally { await s.close(); }
});

test('mint: a non-loopback plain-http board URL is refused before the owner token is read or a file is written', async () => {
  const dir = tmpDir();
  const ownerFile = path.join(dir, 'owner-mint.token');
  fs.writeFileSync(ownerFile, OWNER);
  const out = path.join(dir, 'secrets', 'workera.token');
  const r = await run(['--board', 'http://board.example.test', '--owner-token-file', ownerFile, '--lane', 'workera', '--out', out]);
  assert.equal(r.code, 2, r.err);
  assert.match(r.err, /https/);
  assert.equal(fs.existsSync(out), false);
});

test('mint: a reserved lane is refused by the board and leaves no file', async () => {
  const s = await startServer();
  const dir = s.dataDir;
  const ownerFile = path.join(dir, 'owner-mint.token');
  fs.writeFileSync(ownerFile, OWNER);
  try {
    const out = path.join(dir, 'secrets', 'anh.token');
    const r = await run(['--board', s.url, '--owner-token-file', ownerFile, '--lane', 'anh', '--out', out]);
    assert.equal(r.code, 1);
    assert.match(r.err, /reserved_lane/);
    assert.equal(fs.existsSync(out), false);
    assert.match(r.err, /anh/);
  } finally { await s.close(); }
});

test('mint: a password in the board URL is refused (exit 2), never printed, and no file is written', async () => {
  const dir = tmpDir();
  const ownerFile = path.join(dir, 'owner-mint.token');
  fs.writeFileSync(ownerFile, OWNER);
  const out = path.join(dir, 'secrets', 'workera.token');
  const pw = 'Zq9-not-a-real-password';
  const r = await run(['--board', `https://user:${pw}@board.example.test`, '--owner-token-file', ownerFile, '--lane', 'workera', '--out', out]);
  assert.equal(r.code, 2, r.err);
  assert.ok(!(r.out + r.err).includes(pw));
  assert.equal(fs.existsSync(out), false);
});
