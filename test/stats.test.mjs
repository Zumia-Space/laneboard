// The board's task-statistics document (J-05): DERIVED data, not a board op. PUT /api/admin/stats validates it against
// schema/v1/stats.json, caps it at 512 KiB and writes it atomically to <data>/stats.json — never to the journal — so an
// older board (no stats op) can replay this journal and start (rollback is safe). GET /api/stats reads it back to the
// same audience as /api/state. Covered here: admin auth, shape refusal, the cap, read-back, no journal write,
// persistence across a restart, the write op being gone, and a corrupt file never crashing the server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { s21Board, OWNER } from './s21-helpers.mjs';
import { tmpDir } from './helpers.mjs';

const DOC = {
  schema: 1,
  generated_at: '2026-10-16T05:00:00.000Z',
  attributed_pct: 27.313,
  window_days: 14,
  tasks: {
    'ACME-02': {
      title: 'Agent tong hop',
      days: [{ date: '2026-10-15', weekday: 3, active_ms: 24120000, tokens: 64700000, by_model: { sonnet: 38200000 }, by_role: { code: 52100000 }, qc: { pass: 4, fail: 1 } }],
      by_model: { sonnet: 38200000 }, by_role: { code: 52100000 }, qc: { pass: 4, fail: 1 }
    }
  },
  top: { w7: [{ code: 'ACME-02', title: 'Agent tong hop', tokens: 493000000, share_pct: 34.4, trend: 'up', trend_pct: 12, model: 'sonnet', qc_per_round: 8200000, qc_fail: 2 }], today: [] }
};

/** A schema-valid document larger than 512 KiB (2000 tasks, each with a 300-char title). */
function oversizeDoc() {
  const tasks = {};
  for (let i = 0; i < 2000; i += 1) tasks[`T-${i}`] = { title: 'x'.repeat(300), days: [], qc: { pass: 0, fail: 0 } };
  return { generated_at: '2026-10-16T05:00:00.000Z', attributed_pct: 61, tasks, top: {} };
}

test('stats: admin auth, shape refusal, 512 KiB cap, read-back; nothing is journaled', async () => {
  const s = await s21Board();
  try {
    const journalPath = path.join(s.dataDir, 'events.ndjson');
    const before = fs.readFileSync(journalPath, 'utf8'), seqBefore = s.board.state.seq;

    // admin auth like the other /admin routes: only a direct loopback caller (no X-Forwarded-For) reaches it
    assert.equal((await s.call('PUT', '/api/admin/stats', { doc: DOC }, { 'X-Forwarded-For': '1.2.3.4' })).status, 404, 'a proxied caller never reaches the admin route');

    // shape refusal: the stats.json schema rejects a missing field, an out-of-range number and an unknown field
    assert.equal((await s.call('PUT', '/api/admin/stats', { doc: { generated_at: 'x' } })).body.error, 'invalid_data');
    assert.equal((await s.call('PUT', '/api/admin/stats', { doc: { ...DOC, attributed_pct: 150 } })).body.error, 'invalid_data');
    assert.equal((await s.call('PUT', '/api/admin/stats', { doc: { ...DOC, nope: 1 } })).body.error, 'invalid_data');
    assert.equal((await s.call('PUT', '/api/admin/stats', {})).body.error, 'invalid_data', 'the wrapper needs a doc');

    // size cap: a document over 512 KiB is refused, nothing is stored
    const over = oversizeDoc();
    assert.ok(Buffer.byteLength(JSON.stringify(over)) > 512 * 1024);
    const tooBig = await s.call('PUT', '/api/admin/stats', { doc: over });
    assert.equal(tooBig.status, 413); assert.equal(tooBig.body.error, 'too_large'); assert.equal(tooBig.body.max_bytes, 512 * 1024);

    // read-back: is not there before the first write
    assert.equal((await s.call('GET', '/api/stats')).body, null);

    // a valid document is stored; the revision is a per-process counter (nothing is journaled to carry it)
    const r = await s.call('PUT', '/api/admin/stats', { doc: DOC });
    assert.equal(r.status, 200); assert.deepEqual(r.body, { ok: true, revision: 1, generated_at: DOC.generated_at });
    const g = await s.call('GET', '/api/stats');
    assert.equal(g.status, 200);
    assert.equal(g.body.attributed_pct, 27.313);
    assert.equal(g.body.top.w7[0].code, 'ACME-02');
    assert.equal(g.body.tasks['ACME-02'].days[0].qc.fail, 1);
    assert.equal((await s.call('PUT', '/api/admin/stats', { doc: DOC })).body.revision, 2);

    // kept out of the projection, so it never rides along in GET /api/v1/state
    assert.equal(s.board.stats().generated_at, DOC.generated_at);
    assert.equal(s.board.state.stats, undefined, 'stats is not a projection field');
    assert.equal(s.board.state.docs.stats, undefined, 'kept out of docs, so it stays out of GET /api/v1/state');

    // nothing was journaled: the same seq and a byte-identical journal
    assert.equal(s.board.state.seq, seqBefore, 'no event was appended');
    assert.equal(fs.readFileSync(journalPath, 'utf8'), before, 'the journal is unchanged');

    // and the document is on disk, where the board keeps its journal and projection
    assert.equal(JSON.parse(fs.readFileSync(path.join(s.dataDir, 'stats.json'), 'utf8')).generated_at, DOC.generated_at);
  } finally { await s.close(); }
});

test('stats: the PUT persists across a server restart (read from stats.json, never replayed)', async () => {
  const dir = path.join(tmpDir(), 'board');
  const s1 = await s21Board({ dataDir: dir });
  let seqBefore;
  try {
    seqBefore = s1.board.state.seq;
    assert.equal((await s1.call('PUT', '/api/admin/stats', { doc: DOC })).body.revision, 1);
    assert.equal(s1.board.state.seq, seqBefore, 'the PUT appended nothing to the journal');
  } finally { await s1.close(); }

  const s2 = await s21Board({ dataDir: dir });
  try {
    const g = await s2.call('GET', '/api/stats');
    assert.equal(g.status, 200);
    assert.equal(g.body.generated_at, DOC.generated_at, 'loaded from <data>/stats.json at startup');
    assert.equal(g.body.attributed_pct, 27.313);
    assert.equal(s2.board.state.seq, seqBefore, 'the restart replayed the same journal: no stats event exists');
  } finally { await s2.close(); }
});

test('stats: POST /api/v1/write no longer accepts a stats.set op', async () => {
  const s = await s21Board();
  try {
    const seqBefore = s.board.state.seq;
    const r = await s.v1(s.coord, 'POST', '/api/v1/write', { version: 1, request_id: 's-rej-' + crypto.randomBytes(6).toString('hex'), op: 'stats.set', target_id: 'board', data: { doc: DOC }, expected_revision: 0 });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'invalid_request', 'the envelope no longer lists the op');
    assert.match(JSON.stringify(r.body.errors), /op/);
    assert.equal(s.board.stats(), null, 'the rejected write stored nothing');
    assert.equal(s.board.state.seq, seqBefore, 'and nothing was journaled');
  } finally { await s.close(); }
});

test('stats: GET /api/stats has the audience of /api/state (a reporter token is refused, a stranger reads it)', async () => {
  const s = await s21Board();
  try {
    await s.call('PUT', '/api/admin/stats', { doc: DOC });
    const rep = s.board.write(OWNER, { version: 1, request_id: 'stats-rep-' + crypto.randomBytes(6).toString('hex'), op: 'token.issue', target_id: 'rep', data: { role: 'reporter', scope_tasks: ['*'] } }).token;
    const callRep = async route => {
      const res = await fetch(s.url + route, { headers: { Authorization: `Bearer ${rep}` } });
      return { status: res.status, body: await res.json().catch(() => null) };
    };
    assert.equal((await callRep('/api/state')).status, 403, 'reporters are refused the predecessor reads');
    assert.equal((await callRep('/api/stats')).status, 403);
    assert.equal((await s.call('GET', '/api/stats')).status, 200, 'a direct reader gets the document');
  } finally { await s.close(); }
});

test('stats: a corrupt or schema-invalid stats.json yields null and does not crash the server', async () => {
  const dir = path.join(tmpDir(), 'board');
  fs.mkdirSync(dir, { recursive: true });

  // unreadable JSON
  fs.writeFileSync(path.join(dir, 'stats.json'), '{ this is not json');
  let s = await s21Board({ dataDir: dir });
  try {
    const g = await s.call('GET', '/api/stats');
    assert.equal(g.status, 200, 'the server answers, it did not crash');
    assert.equal(g.body, null, 'an unreadable file means null');
  } finally { await s.close(); }

  // valid JSON, wrong shape
  fs.writeFileSync(path.join(dir, 'stats.json'), JSON.stringify({ generated_at: 'x' }));
  s = await s21Board({ dataDir: dir });
  try {
    assert.equal((await s.call('GET', '/api/stats')).body, null, 'a schema-invalid file means null');
  } finally { await s.close(); }

  // a missing file (the normal case) is null too
  fs.rmSync(path.join(dir, 'stats.json'));
  s = await s21Board({ dataDir: dir });
  try {
    assert.equal((await s.call('GET', '/api/stats')).body, null);
  } finally { await s.close(); }
});
