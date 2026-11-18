// GET /api/v1/quota (J-05 quota-view): the Claude-account quota document is a SIDE FILE <data>/quota.json written by an
// external publisher. Covered: auth (any signed-in token; anonymous 401; not on the ext edge), the missing file (200 + empty
// + reason, never 500), bad JSON / bad shape / oversize (503 + short reason), a valid document served as published, and
// rollback safety (the board never writes the file, never journals it, and boots with any file there).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startSeeded, startServer, tmpDir, OWNER } from './helpers.mjs';
import { createBoard } from '../src/board.mjs';

const DOC = {
  schema: 1,
  generated_at: '2026-10-24T09:41:00.000Z',
  accounts: [
    { id: 'premium-a', label: 'Premium A', machine: 'Main PC', reach: { status: 'ok', checked_at: '2026-10-24T09:41:00.000Z' },
      window5h: { pct: 62, resets_at: '2026-10-24T12:30:00.000Z', as_of: '2026-10-24T09:41:00.000Z' }, week: null,
      tokens: { today: 18400000, d7: 96100000, today_cache_read: 212000000, as_of: '2026-10-24T09:41:00.000Z' }, extra_field_from_a_newer_publisher: 1 },
    { id: 'acme', label: 'Acme Tours', machine: 'Laptop', reach: { status: 'offline', checked_at: '2026-10-24T09:40:00.000Z', since: '2026-10-24T08:00:00.000Z', msg: 'ssh timeout' } }
  ]
};
const put = (dir, text) => fs.writeFileSync(path.join(dir, 'quota.json'), typeof text === 'string' ? text : JSON.stringify(text));

test('quota: every signed-in role reads it, anonymous and a revoked token do not', async () => {
  const s = await startSeeded();
  try {
    put(s.dataDir, DOC);
    for (const [who, tok] of [['owner', OWNER], ['coordinator', s.coord], ['reporter', s.alpha]]) {
      const r = await s.call(tok, 'GET', '/api/v1/quota');
      assert.equal(r.status, 200, who); assert.deepEqual(r.body, DOC, `${who} gets the document as published`);
      assert.equal(r.headers.get('cache-control'), 'no-store');
    }
    assert.equal((await s.call(null, 'GET', '/api/v1/quota')).status, 401);
    assert.equal((await s.call('lb_not-a-token', 'GET', '/api/v1/quota')).status, 401);
    assert.equal((await s.call(OWNER, 'POST', '/api/v1/quota', {})).status, 405, 'read-only: no write verb');
  } finally { await s.close(); }
});

test('quota: not published yet is 200 with an empty list and a reason, never a 500', async () => {
  const s = await startServer();
  try {
    const r = await s.call(OWNER, 'GET', '/api/v1/quota');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { schema: 1, generated_at: null, accounts: [], reason: 'no_quota_file' });
  } finally { await s.close(); }
});

test('quota: a bad file is 503 with a short reason (invalid JSON, wrong shape, too large, not a file), and fixing it recovers at once', async () => {
  const s = await startServer();
  try {
    const get = () => s.call(OWNER, 'GET', '/api/v1/quota');
    put(s.dataDir, '{"accounts": [');
    let r = await get(); assert.equal(r.status, 503); assert.deepEqual(r.body, { error: 'quota_unreadable', reason: 'invalid_json' });
    put(s.dataDir, { generated_at: '2026-10-24T09:41:00.000Z' });
    r = await get(); assert.equal(r.status, 503); assert.match(r.body.reason, /^invalid_shape: \$\.accounts is required/);
    put(s.dataDir, { ...DOC, accounts: [{ ...DOC.accounts[0], reach: { status: 'asleep', checked_at: DOC.generated_at } }] });
    r = await get(); assert.equal(r.status, 503); assert.match(r.body.reason, /\.reach\.status must be one of/);
    put(s.dataDir, { ...DOC, accounts: [{ ...DOC.accounts[0], window5h: { pct: 140, resets_at: DOC.generated_at, as_of: DOC.generated_at } }] });
    r = await get(); assert.equal(r.status, 503); assert.match(r.body.reason, /window5h\.pct greater than 100/);
    put(s.dataDir, JSON.stringify({ ...DOC, pad: 'x'.repeat(300 * 1024) }));
    r = await get(); assert.equal(r.status, 503); assert.equal(r.body.reason, 'too_large');
    fs.rmSync(path.join(s.dataDir, 'quota.json')); fs.mkdirSync(path.join(s.dataDir, 'quota.json'));
    r = await get(); assert.equal(r.status, 503); assert.equal(r.body.reason, 'unreadable_file');
    fs.rmdirSync(path.join(s.dataDir, 'quota.json')); put(s.dataDir, DOC);
    r = await get(); assert.equal(r.status, 200, 'a valid file is served on the next request, no restart');
  } finally { await s.close(); }
});

test('quota: never reachable through the external edge (404 for any bearer, before auth)', async () => {
  const s = await startSeeded();
  try {
    put(s.dataDir, DOC);
    const ext = tok => fetch(s.url + '/api/v1/quota', { headers: { 'X-Laneboard-Ext': '1', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) } }).then(r => r.status);
    for (const tok of [null, s.alpha, s.coord, OWNER]) assert.equal(await ext(tok), 404);
    assert.equal((await s.call(s.alpha, 'GET', '/api/v1/quota')).status, 200, 'control: the same reporter without the edge marker reads it');
  } finally { await s.close(); }
});

test('quota: rollback safe — the board never writes or journals it, and boots with a good, bad or missing file in its data dir', async () => {
  const dir = tmpDir();
  const first = createBoard({ dataDir: dir, ownerToken: OWNER });
  first.close();
  const journalBefore = fs.readFileSync(path.join(dir, 'events.ndjson'), 'utf8'), filesBefore = fs.readdirSync(dir).sort();
  for (const content of [JSON.stringify(DOC), '\u0000not json', '']) {
    put(dir, content);
    const b = createBoard({ dataDir: dir, ownerToken: OWNER });
    try { b.quota(OWNER); } catch (e) { assert.equal(e.status, 503); } // a bad file is a refusal on the route, never a crash at boot
    b.close();
    assert.equal(fs.readFileSync(path.join(dir, 'quota.json'), 'utf8'), content, 'the board never rewrites the file');
  }
  assert.equal(fs.readFileSync(path.join(dir, 'events.ndjson'), 'utf8'), journalBefore, 'nothing was journaled');
  fs.rmSync(path.join(dir, 'quota.json'));
  assert.deepEqual(fs.readdirSync(dir).sort(), filesBefore, 'no new file appears beside the journal (no temp, no cache)');
});

test('quota: the publisher states a never-installed collector (snap) and collector notes (warnings); a window may omit resets_at; bad values are refused', async () => {
  const s = await startServer();
  try {
    const get = () => s.call(OWNER, 'GET', '/api/v1/quota');
    const acct = over => ({ ...DOC, accounts: [{ ...DOC.accounts[0], ...over }] });
    const good = acct({ snap: 'never_seen', window5h: null, tokens: null, warnings: ['transcripts folder not readable (ENOENT)'], week: { pct: 5, as_of: DOC.generated_at } });
    put(s.dataDir, good);
    let r = await get(); assert.equal(r.status, 200); assert.deepEqual(r.body, good);
    const fb = acct({ snap: 'fallback' });
    put(s.dataDir, fb); r = await get(); assert.equal(r.status, 200, 'S3: fallback is a stated snap value'); assert.deepEqual(r.body, fb);
    put(s.dataDir, acct({ snap: 'installed' })); r = await get(); assert.equal(r.status, 503); assert.match(r.body.reason, /\.snap must be one of/);
    put(s.dataDir, acct({ warnings: ['x'.repeat(161)] })); r = await get(); assert.equal(r.status, 503); assert.match(r.body.reason, /warnings\[0\] longer than 160/);
    put(s.dataDir, acct({ week: { pct: 5, as_of: DOC.generated_at, seen_at: 5 } })); r = await get(); assert.equal(r.status, 503); assert.match(r.body.reason, /seen_at/);
    put(s.dataDir, acct({ week: { pct: 5, as_of: DOC.generated_at, seen_at: DOC.generated_at } })); r = await get(); assert.equal(r.status, 200, 'seen_at is a stated optional window field');
    put(s.dataDir, acct({ week: { pct: 5 } })); r = await get(); assert.equal(r.status, 503); assert.match(r.body.reason, /week\.as_of is required/);
  } finally { await s.close(); }
});
