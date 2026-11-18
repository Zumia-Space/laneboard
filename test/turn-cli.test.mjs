// `cos-board.mjs turn` (the lane poster the Stop hook calls) against a local board with the predecessor-compatible layer on, and the
// admin route behind it (POST /api/admin/turn). The client lives outside this repo (the lanes' live client); set COS_BOARD_CLI to test
// another copy. Without it on this machine the CLI tests are skipped, the route tests still run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { s21Board, step } from './s21-helpers.mjs';
import { tmpDir } from './helpers.mjs';

const CLI = process.env.COS_BOARD_CLI || '/opt/tools/board-cli.mjs';
const hasCli = fs.existsSync(CLI);
const journal = s => fs.readFileSync(path.join(s.dataDir, 'events.ndjson'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const turnEvents = s => journal(s).filter(e => e.op === 'turn.report');

async function board() {
  const s = await s21Board();
  s.w('task.create', 'T-1', { title: 'Seats', lane: 'Workera CoS', steps: [step('s1', 'waiting', 'owner', { label: 'Chọn ghế' })] });
  s.w('ask.raise', 'T-1', { text: 'Ghế A hay B?', step_id: 's1' });
  return s;
}
// Async on purpose: the board runs in this process, a blocking spawn would starve it.
const run = (s, args, { env = {}, api = `${s.url}/api` } = {}) => new Promise(resolve => {
  execFile(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, BOARD_API: api, BOARD_LANE: '', ...env }, timeout: 60000 },
    (e, out, err) => resolve({ code: e ? e.code : 0, out, err }));
});
const file = text => { const f = path.join(tmpDir(), 'report.md'); fs.writeFileSync(f, text); return f; };

test('route: POST /api/admin/turn is a loopback admin call; it answers {ok, seq, quick} and a duplicate is 409 with the original', async () => {
  const s = await board();
  try {
    const ok = await s.call('POST', '/api/admin/turn', { lane: 'Workera CoS', turn_id: 'r-1', detail: '# Xong' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.ok, true);
    assert.match(ok.body.quick.line, /^Workera CoS xong 1 lượt \(\d\d:\d\d\)\nChờ anh 1 việc: T-1 Chọn ghế \(ask-\d+\)$/);
    const dup = await s.call('POST', '/api/admin/turn', { lane: 'workera cos', turn_id: 'r-1', detail: 'other' });
    assert.equal(dup.status, 409);
    assert.deepEqual(dup.body, { error: 'duplicate_turn', seq: ok.body.seq, quick: ok.body.quick });
    assert.equal((await s.call('POST', '/api/admin/turn', { turn_id: 'r-2', detail: 'x' })).body.error, 'lane_required');
    const unknown = await s.call('POST', '/api/admin/turn', { lane: 'Nobody', turn_id: 'r-3', detail: 'x' });
    assert.equal(unknown.status, 404); assert.equal(unknown.body.error, 'unknown_lane');
    assert.equal((await s.call('POST', '/api/admin/turn', { lane: 'Workera CoS', turn_id: 'r-4', detail: '' })).status, 400);
    const proxied = await s.call('POST', '/api/admin/turn', { lane: 'Workera CoS', turn_id: 'r-5', detail: 'x' }, { 'X-Forwarded-For': '1.2.3.4' });
    assert.equal(proxied.status, 404, 'through the public proxy the admin routes do not exist');
    assert.equal(turnEvents(s).length, 1);
    assert.equal(turnEvents(s)[0].actor.role, 'coordinator', 'written by the coordinator token, for the lane in target_id');
  } finally { await s.close(); }
});

test('cli: posts a report; stdout is one JSON line {ok, seq, quick}; the default turn id is sha256(session NUL file)', { skip: !hasCli }, async () => {
  const s = await board();
  try {
    const text = '# Báo cáo\nĐã chọn ghế.\n';
    const r = await run(s, ['turn', '--lane', 'Workera CoS', '--file', file(text), '--session', 'sess-1']);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.trim().split('\n').length, 1);
    const j = JSON.parse(r.out);
    assert.deepEqual(Object.keys(j), ['ok', 'seq', 'quick']);
    assert.equal(j.ok, true);
    assert.match(j.quick.line, /^Workera CoS xong 1 lượt/);
    const [ev] = turnEvents(s);
    assert.equal(ev.seq, j.seq);
    assert.equal(ev.data.detail, text);
    assert.equal(ev.data.turn_id, crypto.createHash('sha256').update('sess-1\0' + text).digest('hex').slice(0, 16));
    assert.equal(ev.data.session, undefined);
  } finally { await s.close(); }
});

test('cli: the same report again is a duplicate: exit 0, the original seq and quick, nothing journaled; another session is a new report', { skip: !hasCli }, async () => {
  const s = await board();
  try {
    const f = file('same text');
    const a = await run(s, ['turn', '--lane', 'Workera CoS', '--file', f, '--session', 's']);
    assert.equal(a.code, 0, a.err);
    const b = await run(s, ['turn', '--lane', 'Workera CoS', '--file', f, '--session', 's']);
    assert.equal(b.code, 0, b.err);
    assert.equal(b.out, a.out, 'the same {ok, seq, quick}');
    assert.equal(turnEvents(s).length, 1);
    const c = await run(s, ['turn', '--lane', 'Workera CoS', '--file', f, '--session', 'other']);
    assert.equal(c.code, 0); assert.notEqual(JSON.parse(c.out).seq, JSON.parse(a.out).seq);
    assert.equal(turnEvents(s).length, 2);
    const d = await run(s, ['turn', '--lane', 'Workera CoS', '--file', f, '--turn-id', 'my-id:1']);
    assert.equal(d.code, 0); assert.equal(turnEvents(s).at(-1).data.turn_id, 'my-id:1');
    const env = await run(s, ['turn', '--file', f, '--turn-id', 'my-id:2'], { env: { BOARD_LANE: 'Workera CoS' } });
    assert.equal(env.code, 0, 'BOARD_LANE names the lane like --lane');
  } finally { await s.close(); }
});

test('cli: a file over 8000 characters is cut to 8000 and ends with the marker; the marker is inside the limit', { skip: !hasCli }, async () => {
  const s = await board();
  try {
    assert.equal((await run(s, ['turn', '--lane', 'Workera CoS', '--file', file('x'.repeat(10000))])).code, 0);
    assert.equal((await run(s, ['turn', '--lane', 'Workera CoS', '--file', file('😀'.repeat(9000) + ' tail')])).code, 0);
    assert.equal((await run(s, ['turn', '--lane', 'Workera CoS', '--file', file('y'.repeat(8000))])).code, 0);
    assert.equal((await run(s, ['turn', '--lane', 'Workera CoS', '--file', file('z'.repeat(8001))])).code, 0);
    const [a, b, c, d] = turnEvents(s).map(e => e.data.detail);
    assert.equal(Array.from(a).length, 8000); assert.ok(a.endsWith('…(cắt)'));
    assert.equal(Array.from(b).length, 8000); assert.ok(b.endsWith('…(cắt)'), 'counted in characters, not UTF-16 units');
    assert.equal(c, 'y'.repeat(8000), 'exactly 8000: untouched');
    assert.equal(Array.from(d).length, 8000); assert.ok(d.endsWith('…(cắt)'));
  } finally { await s.close(); }
});

test('cli: exit 2 with the reason on stderr and nothing on stdout when the report cannot be posted', { skip: !hasCli }, async () => {
  const s = await board();
  try {
    const f = file('ok');
    const cases = [
      [['turn', '--file', f], /--lane/],
      [['turn', '--lane', 'Workera CoS'], /--file/],
      [['turn', '--lane', 'Workera CoS', '--file', path.join(tmpDir(), 'missing.md')], /cannot read/],
      [['turn', '--lane', 'Workera CoS', '--file', file('  \n')], /empty/],
      [['turn', '--lane', 'Workera CoS', '--file', f, '--turn-id', 'bad id'], /--turn-id/],
      [['turn', '--lane', 'Workera CoS', '--file', f, '--session', 's'.repeat(81)], /--session/],
      [['turn', '--lane', 'L'.repeat(65), '--file', f], /--lane/],
      [['turn', '--lane', 'Nobody', '--file', f], /unknown_lane/]
    ];
    for (const [args, why] of cases) {
      const r = await run(s, args);
      assert.equal(r.code, 2, `${args.join(' ')}: ${r.err}`);
      assert.equal(r.out, '', 'nothing on stdout');
      assert.match(r.err, why);
    }
    const down = await run(s, ['turn', '--lane', 'Workera CoS', '--file', f], { api: 'http://127.0.0.1:1/api' });
    assert.equal(down.code, 2); assert.equal(down.out, ''); assert.match(down.err, /board unreachable/);
    assert.equal(turnEvents(s).length, 0);
  } finally { await s.close(); }
});
