// The owner-only "Create a key for the Zumi app" control.
// The guard is the server (token.issue / token.revoke carry x-roles ["owner"] in schema/v1/ops and are checked in
// src/board.mjs); hiding the controls in the UI is a courtesy, not the guard. And the plaintext key must never be
// stored: the journal keeps only its sha256, and GET /api/v1/tokens strips the hash (src/views.mjs publicToken).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { startSeeded, OWNER } from './helpers.mjs';

const ZUMI = 'zumi-desktop';
const ZUMI_DATA = { role: 'owner', label: 'Zumi app' };
const idOf = (list, name) => list.find(k => k.name === name)?.id;

test('the owner can create, revoke and reissue the Zumi app key', async () => {
  const s = await startSeeded();
  try {
    const issued = await s.write(OWNER, 'token.issue', ZUMI, ZUMI_DATA);
    assert.equal(issued.status, 200);
    assert.match(issued.body.token, /^lb_/, 'the plaintext key is returned once, in this response only');
    assert.ok(idOf((await s.call(OWNER, 'GET', '/api/v1/tokens')).body, ZUMI), 'the key is listed');

    const old = issued.body.token;
    assert.equal((await s.call(old, 'GET', '/api/v1/whoami')).status, 200, 'the key authenticates as a token');

    const id = idOf((await s.call(OWNER, 'GET', '/api/v1/tokens')).body, ZUMI);
    assert.equal((await s.write(OWNER, 'token.revoke', id, {})).status, 200);
    assert.equal((await s.call(old, 'GET', '/api/v1/whoami')).status, 401, 'the revoked key stops working at once');
    assert.equal((await s.call(OWNER, 'GET', '/api/v1/tokens')).body.find(k => k.id === id).revoked_at != null, true);

    // Reissue = revoke then issue; the name is free once the old one is revoked, so it never hits name_taken.
    const again = await s.write(OWNER, 'token.issue', ZUMI, ZUMI_DATA);
    assert.equal(again.status, 200, 'reissue after revoke is accepted');
    assert.notEqual(again.body.token, old);
    assert.equal((await s.write(OWNER, 'token.issue', ZUMI, ZUMI_DATA)).status, 409, 'a second live key with the same name is refused');
  } finally { await s.close(); }
});

test('the coordinator and a reporter are refused token.issue and token.revoke (server-side)', async () => {
  const s = await startSeeded();
  try {
    for (const who of [s.coord, s.alpha]) {
      const issue = await s.write(who, 'token.issue', ZUMI, ZUMI_DATA);
      assert.equal(issue.status, 403, 'token.issue is owner-only');
      assert.equal(issue.body.error, 'forbidden_for_role');
      const revoke = await s.write(who, 'token.revoke', 'tok-1', {});
      assert.equal(revoke.status, 403, 'token.revoke is owner-only');
      assert.equal(revoke.body.error, 'forbidden_for_role');
    }
    assert.equal((await s.call(OWNER, 'GET', '/api/v1/tokens')).body.some(k => k.name === ZUMI), false, 'nothing was issued');
  } finally { await s.close(); }
});

test('the plaintext key is never written to disk, and the token list never returns a secret', async () => {
  const s = await startSeeded();
  try {
    const { token } = (await s.write(OWNER, 'token.issue', ZUMI, ZUMI_DATA)).body;
    assert.match(token, /^lb_/);

    // Walk the data dir: the secret must appear in no file (journal, projection, owner.token, media.secret, …),
    // while its sha256 does appear in the journal.
    const files = [];
    const walk = dir => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); e.isDirectory() ? walk(p) : files.push(p); } };
    walk(s.dataDir);
    const offenders = files.filter(f => fs.readFileSync(f).includes(token));
    assert.deepEqual(offenders, [], 'no file under the data dir holds the plaintext key');

    const journal = fs.readFileSync(path.join(s.dataDir, 'events.ndjson'), 'utf8');
    assert.ok(journal.includes(`token.issue`), 'the issue is journaled');
    assert.equal(journal.includes(token), false, 'the journal stores no plaintext key');
    const expected = crypto.createHash('sha256').update(token).digest('hex');
    assert.ok(journal.includes(`"token_sha256":"${expected}"`), 'the journal stores exactly sha256(plaintext), nothing else');

    const listed = (await s.call(OWNER, 'GET', '/api/v1/tokens')).body;
    const row = listed.find(k => k.name === ZUMI);
    assert.ok(row, 'the token is listed');
    assert.equal(row.sha256, undefined, 'the token list strips the hash (src/views.mjs publicToken)');
    assert.equal(JSON.stringify(listed).includes(token), false, 'no secret in the token list');
    assert.equal(JSON.stringify(await s.state(OWNER)).includes(token), false, 'no secret in the board state');
  } finally { await s.close(); }
});
