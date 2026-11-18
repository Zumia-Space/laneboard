// Contract: envelope + per-op schemas, every op's happy path, projections valid against the published
// record schemas, journal free of secrets, attachments bounded and type-checked, legacy fixtures accepted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, startSeeded, OWNER, rid } from './helpers.mjs';
import { loadSchemas, validate } from '../src/validate.mjs';
import { legacyRowToRequests } from '../src/adapt-legacy.mjs';
import { demoPng } from '../scripts/seed.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schemas = loadSchemas(path.join(ROOT, 'schema', 'v1'));
const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'schema', 'v1', 'index.json'), 'utf8'));

function assertProjectionValid(board) {
  const st = board.state;
  const check = (file, rec) => assert.deepEqual(validate(schemas, file, rec), [], `${file} ${JSON.stringify(rec).slice(0, 200)}`);
  Object.values(st.tasks).forEach(r => check('task.json', r));
  Object.values(st.steps).forEach(r => check('step.json', r));
  Object.values(st.asks).forEach(r => check('ask.json', r));
  Object.values(st.inbox).forEach(r => check('inbox-item.json', r));
  Object.values(st.feedback).forEach(r => check('feedback.json', r));
  Object.values(st.attachments).forEach(r => check('attachment.json', r));
  Object.values(st.routing).forEach(r => check('routing.json', r));
  Object.values(st.route_override || {}).forEach(r => check('route-override.json', r));
  Object.values(st.machines || {}).forEach(r => check('machines.json', r));
  Object.values(st.pins || {}).forEach(r => check('pins.json', r));
  Object.values(st.times).forEach(r => check('time.json', r));
  Object.values(st.task_times || {}).forEach(r => check('task-time.json', r));
  Object.values(st.prefs || {}).forEach(r => check('prefs.json', r));
  if (st.notify) check('notify.json', st.notify);
  if (st.freshness) check('freshness.json', st.freshness);
  Object.values(st.docs || {}).forEach(r => check('board-doc.json', r));
  Object.values(st.goals || {}).forEach(r => check('goal.json', r));
  Object.values(st.plans || {}).flat().forEach(r => check('plan.json', r));
  (st.pings || []).forEach(r => check('ping.json', r));
}

test('envelope is validated before anything else', async () => {
  const s = await startServer();
  try {
    const bad = [
      {},
      { version: 2, request_id: rid(), op: 'task.create', target_id: 'X-1', data: {} },
      { version: 1, request_id: 'short', op: 'task.create', target_id: 'X-1', data: {} },
      { version: 1, request_id: rid(), op: 'file.write', target_id: 'X-1', data: {} },
      { version: 1, request_id: rid(), op: 'task.create', target_id: 'X-1', data: { title: 'x' }, actor: 'owner' }
    ];
    for (const body of bad) {
      const r = await s.call(OWNER, 'POST', '/api/v1/write', body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.body.error, 'invalid_request');
    }
    assert.equal((await s.call(OWNER, 'POST', '/api/v1/write', '{not json')).status, 400);
    assert.equal((await s.call(OWNER, 'POST', '/api/v1/write', 'x'.repeat(3 * 1024 * 1024))).status, 413);
    assert.equal((await s.call(OWNER, 'PUT', '/api/v1/write', {})).status, 405);
  } finally { await s.close(); }
});

test('op data is validated against its own schema; unknown fields and bad targets are rejected', async () => {
  const s = await startSeeded();
  try {
    let r = await s.write(s.coord, 'step.update', 'WEB-3/s2', { state: 'finished' }, { expected_revision: 1 });
    assert.equal(r.status, 400); assert.equal(r.body.error, 'invalid_data');
    r = await s.write(s.coord, 'step.update', 'WEB-3/s2', { state: 'done', updated_by: 'owner' }, { expected_revision: 1 });
    assert.equal(r.status, 400); assert.match(JSON.stringify(r.body.errors), /updated_by/);
    r = await s.write(s.coord, 'task.create', 'bad id!', { title: 'x' });
    assert.equal(r.status, 400); assert.equal(r.body.error, 'invalid_target_id');
    r = await s.write(s.coord, 'step.update', 'WEB-3', { state: 'done' }, { expected_revision: 1 });
    assert.equal(r.status, 400); assert.equal(r.body.error, 'invalid_target_id');
    r = await s.write(s.coord, 'task.create', 'X-1', { title: 'x', steps: [{ id: 's1', label: 'a', zone: 'plan', state: 'todo' }, { id: 's1', label: 'b', zone: 'plan', state: 'todo' }] });
    assert.equal(r.status, 400); assert.equal(r.body.error, 'duplicate_step_id');
  } finally { await s.close(); }
});

test('every published op has a working happy path, returns event id + revision, and projections stay schema-valid', async () => {
  const s = await startSeeded();
  try {
    const ok = r => { assert.equal(r.status, 200, JSON.stringify(r.body)); assert.match(r.body.event_id, /^evt-\d+$/); assert.equal(typeof r.body.revision, 'number'); return r.body; };
    const covered = new Set(['token.issue', 'task.create']);
    const use = op => { covered.add(op); return op; };
    ok(await s.write(s.coord, use('task.update'), 'WEB-3', { health: 'yellow', now: 'building' }, { expected_revision: 1 }));
    ok(await s.write(s.coord, use('step.create'), 'WEB-3/s4', { label: 'Ship', zone: 'ship', state: 'todo' }));
    ok(await s.write(s.coord, use('step.update'), 'WEB-3/s2', { state: 'done' }, { expected_revision: 1 }));
    const ask = ok(await s.write(s.coord, use('ask.raise'), 'WEB-3', { text: 'Hero A or B?', step_id: 's3', options: [{ key: 'A', label: 'Photo' }, { key: 'B', label: 'Drawing' }] }));
    ok(await s.write(OWNER, use('ask.answer'), ask.id, { choice: 'A' }, { expected_revision: 1 }));
    const ask2 = ok(await s.write(s.coord, 'ask.raise', 'WEB-3', { text: 'Obsolete question' }));
    ok(await s.write(s.coord, use('ask.clear'), ask2.id, { note: 'no longer needed' }, { expected_revision: 1 }));
    const ask3 = ok(await s.write(s.coord, 'ask.raise', 'API-2', { text: 'Question of another lane' }));
    ok(await s.write(s.coord, use('ask.update'), ask3.id, { lane: 'lane-alpha' }, { expected_revision: 1, origin: 'migrate-s21 contract' }));
    const inb = ok(await s.write(s.alpha, use('inbox.submit'), 'WEB-3', { kind: 'report', text: 'layout done' }));
    ok(await s.write(s.coord, use('inbox.merge'), inb.id, { action: 'accept' }, { expected_revision: 1 }));
    const fb = ok(await s.write(OWNER, use('feedback.add'), 'WEB-3', { kind: 'note', text: 'bigger button' }));
    ok(await s.write(s.coord, 'feedback.add', 'WEB-3', { kind: 'reply', text: 'done', reply_to: fb.id }));
    ok(await s.write(s.coord, use('feedback.resolve'), fb.id, {}, { expected_revision: 1 }));
    ok(await s.write(OWNER, use('routing.set'), 'WEB-3', { model: 'opus', effort: 'high' }));
    ok(await s.write(OWNER, use('routing.reset'), 'API-2', {}));
    ok(await s.write(OWNER, use('roles.set'), 'WEB-3', { role: 'review', model: 'opus', effort: 'high' }));
    ok(await s.write(OWNER, use('roles.reset'), 'WEB-3', { role: 'review' }));
    ok(await s.write(s.coord, use('roles.escalate'), 'WEB-3', { gate: 'tsc', lane: 'CoS' }));
    ok(await s.write(s.coord, use('roles.override'), 'WEB-3', { reason: 'urgent fix', lane: 'CoS' }));
    ok(await s.write(OWNER, use('machines.set'), 'WEB-3', { coordinator: 'main', worker_machines: ['laptop', 'spare'], role: 'review', machine: 'spare' }));
    ok(await s.write(OWNER, use('pin.set'), 'WEB-3', { pinned: true }));
    ok(await s.write(s.alpha, use('attachment.add'), 'WEB-3', { name: 'hero.png', mime: 'image/png', data_base64: demoPng(20, 10).toString('base64') }));
    const t = ok(await s.write(OWNER, 'token.issue', 'temp', { role: 'reporter' }));
    ok(await s.write(OWNER, use('token.revoke'), t.id, {}));
    ok(await s.write(s.alpha, use('prefs.set'), s.board.authenticate(s.alpha).token_id, { lang: 'zh', font_size: 'large' }));
    ok(await s.write(OWNER, use('notify.set'), 'board', { coordinator_feedback: true, delivery: 'watch' }));
    ok(await s.write(OWNER, use('freshness.set'), 'board', { stale_h: 12, auto_request: false }));
    ok(await s.write(s.coord, use('summary.set'), 'board', { items: ['All lanes green'] }, { expected_revision: 0 }));
    ok(await s.write(OWNER, use('registry.set'), 'board', { entries: [{ id: 'r1', code: 'WEB-3', title: 'Landing page', on_board: true, status: 'doing' }] }, { expected_revision: 0 }));
    ok(await s.write(OWNER, use('times.import'), 'API-2', { task: { first_seen_at: '2026-09-27T01:00:00.000Z', started_at: '2026-09-27T01:00:00.000Z' }, steps: { s1: { first_seen_at: '2026-09-27T01:00:00.000Z', started_at: '2026-09-27T01:00:00.000Z', last_state: 'active', waiting_total_ms: 0, transitions: [] } } }));
    ok(await s.write(OWNER, use('goals.import'), 'API-2', { goal: 'g0', output: 'o0', outcome: 'x0', version: 2, locked_at: '2026-09-27T01:00:00.000Z', history: [{ goal: 'g', output: 'o', outcome: 'x', version: 1, locked_at: '2026-09-26T01:00:00.000Z' }] }));
    ok(await s.write(OWNER, use('goal.lock'), 'WEB-3', { goal: 'Ship the page', output: 'A live URL', outcome: 'Five sign-ups' }));
    ok(await s.write(OWNER, use('rebrief.request'), 'WEB-3', { mode: 'qc', note: 'too slow?' }));
    ok(await s.write(OWNER, use('plans.import'), 'API-2', { plans: [{ legacy_id: 'old-1', reviewer: 'Astra', body: 'VERDICT: on-track', verdict: 'on-track', posted_at: '2026-09-27T02:00:00.000Z', goal_version: 2 }] }));
    const plan = ok(await s.write(s.coord, use('plan.add'), 'WEB-3', { reviewer: 'Fable', body: '# Plan\nVERDICT: adjust\nETA: 2 days' }));
    ok(await s.write(OWNER, 'feedback.add', 'WEB-3', { kind: 'choice', plan_id: plan.id, text: 'Pick Fable' }));
    ok(await s.write(OWNER, 'feedback.add', 'NEW', { kind: 'newtask', text: 'Landing page for the CLI' }));
    ok(await s.write(OWNER, use('ping.send'), 'board', { task_id: 'WEB-3', note: '' }));
    ok(await s.write(s.coord, use('ping.seen'), 'board', {}));
    ok(await s.write(s.coord, use('turn.report'), 'lane-alpha', { turn_id: 'turn-0001', detail: '# Done\nThe landing page is built.' }));
    ok(await s.write(s.coord, use('task.update'), 'WEB-3', { step_order: ['s1', 's2', 's4', 's3'] }, { expected_revision: 2 }));
    ok(await s.write(s.coord, use('step.delete'), 'WEB-3/s4', {}, { expected_revision: 1 }));
    const tmp = ok(await s.write(s.coord, 'task.create', 'TMP-1', { title: 'Scratch', dossier: 'notes/TMP-1.md', draft_output: 'a file', health: 'grey', steps: [{ id: 's1', label: 'Pick', zone: 'owner', state: 'todo', options: [{ key: 'A', label: 'One' }] }] }));
    ok(await s.write(s.coord, use('task.delete'), 'TMP-1', {}, { expected_revision: tmp.revision }));
    const cmp = ok(await s.write(s.coord, 'task.create', 'CMP-1', { title: 'Compaction', steps: [
      { id: 'a', label: 'A', zone: 'build', state: 'done' }, { id: 'b', label: 'B', zone: 'build', state: 'done' }, { id: 'c', label: 'C', zone: 'build', state: 'done' }] }));
    const compact = ok(await s.write(s.coord, use('steps.compact'), 'CMP-1', { keep_last: 1 }, { expected_revision: cmp.revision }));
    ok(await s.write(s.coord, 'task.delete', 'CMP-1', {}, { expected_revision: compact.revision }));
    const fresh = await startServer();
    try { ok(await fresh.write(OWNER, use('pings.import'), 'board', { pings: [{ legacy_id: 'p-1', at: '2026-09-27T01:00:00.000Z', note: 'sent', open: 1 }] })); } finally { await fresh.close(); }
    assert.deepEqual([...covered].sort(), Object.keys(index.ops).sort(), 'every op in schema/v1/index.json is exercised');

    const st = await s.state(OWNER);
    const web = st.tasks.find(x => x.id === 'WEB-3');
    assert.equal(web.worker.by, 'owner'); assert.equal(web.worker.model, 'opus');
    assert.equal(st.feedback.find(f => f.id === fb.id).status, 'resolved');
    assert.equal(st.feedback.find(f => f.kind === 'report').attribution.created_by.name, 'lane-alpha', 'merged report keeps the submitter as author');
    assertProjectionValid(s.board);
  } finally { await s.close(); }
});

test('journal lines match event.json and never contain credentials or raw attachment bytes', async () => {
  const s = await startSeeded();
  try {
    const png = demoPng(30, 10).toString('base64');
    await s.write(s.alpha, 'attachment.add', 'WEB-3', { name: 'a.png', mime: 'image/png', data_base64: png });
    const raw = fs.readFileSync(path.join(s.dataDir, 'events.ndjson'), 'utf8');
    for (const line of raw.trim().split('\n')) assert.deepEqual(validate(schemas, 'event.json', JSON.parse(line)), []);
    for (const secret of [OWNER, s.coord, s.alpha, s.beta]) assert.ok(!raw.includes(secret), 'token plaintext in journal');
    assert.ok(!raw.includes(png.slice(0, 40)), 'attachment bytes in journal');
    const ev = await s.call(OWNER, 'GET', '/api/v1/events?after=0');
    assert.equal(ev.status, 200);
    assert.ok(ev.body.every(e => e.actor && e.actor.name && e.request_id), 'every event names an actor and request');
    const tokens = await s.call(OWNER, 'GET', '/api/v1/tokens');
    assert.ok(tokens.body.every(t => !('sha256' in t)));
  } finally { await s.close(); }
});

test('attachments: bounded base64, content must match the declared type, reads need a token unless public', async () => {
  const s = await startSeeded({ maxAttachmentBytes: 2048 });
  try {
    const png = demoPng(16, 8);
    let r = await s.write(s.alpha, 'attachment.add', 'WEB-3', { name: 'x.png', mime: 'image/png', data_base64: Buffer.from('not a png at all').toString('base64') });
    assert.equal(r.status, 400); assert.equal(r.body.error, 'content_does_not_match_mime');
    r = await s.write(s.alpha, 'attachment.add', 'WEB-3', { name: 'x.exe', mime: 'application/x-msdownload', data_base64: png.toString('base64') });
    assert.equal(r.status, 400);
    r = await s.write(s.alpha, 'attachment.add', 'WEB-3', { name: 'big.txt', mime: 'text/plain', data_base64: Buffer.alloc(4096, 97).toString('base64') });
    assert.equal(r.status, 413); assert.equal(r.body.error, 'attachment_too_large');
    r = await s.write(s.alpha, 'attachment.add', 'WEB-3', { name: '../../etc/passwd', mime: 'text/plain', data_base64: Buffer.from('hi').toString('base64') });
    assert.equal(r.status, 400);
    r = await s.write(s.alpha, 'attachment.add', 'WEB-3', { name: 'ok.png', mime: 'image/png', data_base64: png.toString('base64'), step_id: 's3' });
    assert.equal(r.status, 200);
    const id = r.body.id;
    const withToken = await fetch(`${s.url}/api/v1/media/${id}`, { headers: { Authorization: `Bearer ${s.alpha}` } });
    assert.equal(withToken.status, 200); assert.equal(withToken.headers.get('content-type'), 'image/png');
    assert.ok(Buffer.from(await withToken.arrayBuffer()).equals(png));
    assert.equal((await fetch(`${s.url}/api/v1/media/${id}`)).status, 404, 'internal attachment hidden from anonymous readers');
  } finally { await s.close(); }
});

test('published schemas and the UI are served', async () => {
  const s = await startServer();
  try {
    assert.equal((await s.call(null, 'GET', '/schema/v1/write-request.json')).body.$id, 'write-request.json');
    assert.equal((await s.call(null, 'GET', '/schema/v1/ops/step.update.json')).status, 200);
    assert.equal((await s.call(null, 'GET', '/schema/v1/../../package.json')).status, 404);
    const ui = await fetch(s.url + '/');
    assert.equal(ui.status, 200); assert.match(await ui.text(), /<html/);
    assert.equal((await s.call(null, 'GET', '/healthz')).body.ok, true);
  } finally { await s.close(); }
});

test('legacy-format fixtures convert and are accepted without losing details, loops, worker or the open ask', async () => {
  const s = await startServer();
  try {
    s.coord = (await s.write(OWNER, 'token.issue', 'coordinator', { role: 'coordinator' })).body.token;
    const dir = path.join(ROOT, 'fixtures', 'legacy-rows');
    for (const f of fs.readdirSync(dir)) {
      const row = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      for (const req of legacyRowToRequests(row, { prefix: 'legacy-test' })) {
        const r = await s.call(s.coord, 'POST', '/api/v1/write', req);
        assert.equal(r.status, 200, `${f} ${req.op} ${JSON.stringify(r.body)}`);
      }
      const t = s.board.state.tasks[row.code];
      assert.equal(t.title, row.title);
      assert.deepEqual(t.worker, row.worker);
      assert.equal((t.loops || []).length, (row.loops || []).length);
      for (const st of row.steps) {
        const v1 = s.board.state.steps[`${row.code}/${st.id}`];
        assert.equal(v1.detail || '', st.detail || '');
        assert.equal(v1.zone, st.zone === 'anh' ? 'owner' : st.zone);
      }
    }
    const view = await s.state(OWNER);
    const doc = view.attention.waiting.find(w => w.task_id === 'DOC-1');
    assert.equal(doc.kind, 'ask'); assert.equal(doc.options.length, 2); assert.equal(doc.step_id, 's3');
    assertProjectionValid(s.board);
  } finally { await s.close(); }
});
