// J-05 step compaction (op steps.compact): older done steps move into state.archive and fold into one `lich-su` step.
// Covered: the cap is freed while times/measured stay identical, idempotence and merging into one history step, the steps
// that must never move (owner zone / open ask / inbox / loop end / active / waiting), a stale row push with archived ids,
// the 409 on re-creating an archived id, deterministic journal replay, the dry-run read route writing nothing, and the
// archived metadata read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createBoard } from '../src/board.mjs';
import { compactPlan } from '../src/ops.mjs';
import { measuredTimes } from '../src/views.mjs';
import { startServer, OWNER, tmpDir } from './helpers.mjs';
import { s21Board } from './s21-helpers.mjs';

const H = 3600000, T0 = Date.parse('2026-10-01T00:00:00.000Z');
let n = 0;
const req = (op, target_id, data = {}, extra = {}) => ({ version: 1, request_id: `compact-${process.pid}-${++n}`, op, target_id, data, ...extra });
const short = id => `s${String(id).padStart(2, '0')}`;
const todoSteps = count => Array.from({ length: count }, (_, i) => ({ id: short(i + 1), label: `Bước ${i + 1}`, zone: 'build', state: 'todo', detail: `kết quả ${i + 1}\ndòng phụ` }));

/** A board on an injected clock, a coordinator token, and a task whose `count` steps are walked to done one hour apart. */
function seeded(count, { task = 'CAP-1', steps = todoSteps(count), complete = true } = {}) {
  let clock = T0;
  const b = createBoard({ dataDir: tmpDir(), ownerToken: OWNER, now: () => clock });
  const coord = b.write(OWNER, req('token.issue', 'coordinator', { role: 'coordinator' })).token;
  b.write(coord, req('task.create', task, { title: task, steps }));
  if (complete) for (const id of b.state.tasks[task].step_ids.slice()) {
    if (b.state.steps[`${task}/${id}`].state === 'done') continue;
    clock += H;
    b.write(coord, req('step.update', `${task}/${id}`, { state: 'done' }, { expected_revision: 1 }));
  }
  return { b, coord, tick: (h = 1) => { clock += h * H; } };
}
const clone = o => JSON.parse(JSON.stringify(o));

/** The lich-su line of ONE step (the older of two done steps), so a result assertion reads a single line. */
function compactLine(detail, label) {
  const steps = [
    { id: 's1', label, zone: 'build', state: 'done', detail },
    { id: 's2', label: 'Bước mới', zone: 'build', state: 'done' }
  ];
  const { b, coord } = seeded(0, { steps });
  try {
    b.write(coord, req('steps.compact', 'CAP-1', { keep_last: 1 }, { expected_revision: 1 }));
    return b.state.steps['CAP-1/lich-su'].detail.split('\n')[0];
  } finally { b.close(); }
}

test('compact frees the step cap; measured time and state.times are unchanged', () => {
  const { b, coord } = seeded(50);
  try {
    const measuredBefore = measuredTimes(b.state, 'CAP-1', T0 + 200 * H);
    const timesBefore = JSON.stringify(b.state.times);
    let cap; try { b.write(coord, req('step.create', 'CAP-1/extra', { label: 'New', zone: 'build', state: 'todo' })); } catch (e) { cap = e; }
    assert.equal(cap?.status, 400); assert.equal(cap?.code, 'too_many_steps', '50 live steps is the cap');

    const r = b.write(coord, req('steps.compact', 'CAP-1', { keep_last: 10 }, { expected_revision: 1 }));
    assert.equal(r.ok, true); assert.equal(r.moved.length, 40);
    assert.deepEqual(r.moved, Array.from({ length: 40 }, (_, i) => short(i + 1)), 'done-time order: the oldest 40');
    const t = b.state.tasks['CAP-1'];
    assert.equal(t.step_ids.length, 11, '10 recent done steps + lich-su');
    assert.equal(t.step_ids[0], 'lich-su');
    assert.deepEqual(t.step_ids.slice(1), Array.from({ length: 10 }, (_, i) => short(41 + i)), 'the last 10 done steps stay live');
    assert.equal(b.state.archive['CAP-1'].order.length, 40);
    assert.equal(b.state.steps['CAP-1/s01'], undefined, 'moved records leave the live step map');
    assert.deepEqual(clone(measuredTimes(b.state, 'CAP-1', T0 + 200 * H)), clone(measuredBefore), 'measured work/wait is identical');
    assert.equal(JSON.stringify(b.state.times), timesBefore, 'timing history is untouched');
    const hist = b.state.steps['CAP-1/lich-su'];
    assert.equal(hist.label, 'Lịch sử (gộp)'); assert.equal(hist.state, 'done'); assert.equal(hist.zone, 'build');
    const lines = hist.detail.split('\n');
    assert.match(lines[0], /^\d\d\/\d\d · Bước 40 · kết quả 40$/);
    assert.match(lines.at(-1), /Bước 1 · kết quả 1$/, 'newest first');

    // Archived steps never count toward the cap: one new step goes in.
    const added = b.write(coord, req('step.create', 'CAP-1/extra', { label: 'New', zone: 'build', state: 'todo' }));
    assert.equal(added.ok, true);
    assert.equal(b.state.tasks['CAP-1'].step_ids.length, 12);
  } finally { b.close(); }
});

test('re-running compact with nothing eligible is a no-op; new eligible steps merge into the same lich-su', () => {
  const { b, coord } = seeded(12);
  try {
    const first = b.write(coord, req('steps.compact', 'CAP-1', { keep_last: 10 }, { expected_revision: 1 }));
    assert.deepEqual(first.moved, ['s01', 's02']);
    const snap = { steps: clone(b.state.steps), ids: [...b.state.tasks['CAP-1'].step_ids], archive: clone(b.state.archive), times: clone(b.state.times) };
    const seq = b.state.seq, rev = b.state.tasks['CAP-1'].rev;
    const second = b.write(coord, req('steps.compact', 'CAP-1', { keep_last: 10 }, { expected_revision: rev }));
    assert.equal(second.ok, true, 'a second run is not an error');
    assert.equal(b.state.seq, seq + 1, 'the accepted no-op write is journaled');
    assert.deepEqual(clone(b.state.steps), snap.steps, 'no step changed');
    assert.deepEqual([...b.state.tasks['CAP-1'].step_ids], snap.ids);
    assert.deepEqual(clone(b.state.archive), snap.archive);
    assert.deepEqual(clone(b.state.times), snap.times);

    // A new done step makes one older live step eligible; it appends to the SAME history step.
    b.write(coord, req('step.create', 'CAP-1/s13', { label: 'Bước 13', zone: 'build', state: 'done' }));
    const third = b.write(coord, req('steps.compact', 'CAP-1', { keep_last: 10 }, { expected_revision: b.state.tasks['CAP-1'].rev }));
    assert.deepEqual(third.moved, ['s03']);
    assert.equal(b.state.tasks['CAP-1'].step_ids.filter(id => id === 'lich-su').length, 1, 'ONE history step');
    assert.equal(b.state.archive['CAP-1'].order.length, 3);
    assert.match(b.state.steps['CAP-1/lich-su'].detail.split('\n')[0], /Bước 3 · kết quả 3$/);
  } finally { b.close(); }
});

test('task.delete drops the step archive, so a re-created id starts clean', () => {
  const { b, coord } = seeded(12);
  try {
    b.write(coord, req('steps.compact', 'CAP-1', { keep_last: 10 }, { expected_revision: 1 }));
    const retired = b.state.archive['CAP-1'].order[0];
    assert.equal(retired, 's01');
    b.write(coord, req('task.delete', 'CAP-1', {}, { expected_revision: b.state.tasks['CAP-1'].rev }));
    assert.equal(b.state.archive['CAP-1'], undefined, 'a deleted task leaves no step archive behind');
    // The board explicitly supports re-creating a task id (AGENTS.md): the old archived ids must not block it or
    // leak into the new task's history list.
    b.write(coord, req('task.create', 'CAP-1', { title: 'CAP-1 again', steps: [{ id: 'a1', label: 'A', zone: 'build', state: 'todo' }] }));
    const back = b.write(coord, req('step.create', 'CAP-1/s01', { label: 'Reused id', zone: 'build', state: 'todo' }));
    assert.equal(back.ok, true, 'a reused task id has no retired step ids');
  } finally { b.close(); }
});

test('open-ask, inbox, loop-end, active and waiting steps never move (a plain done owner-zone step does: see below)', () => {
  const steps = [
    { id: 'a1', label: 'old build', zone: 'build', state: 'done', detail: 'r1' },
    { id: 'a2', label: 'owner done', zone: 'owner', state: 'done', detail: 'r2' },
    { id: 'a3', label: 'asked', zone: 'build', state: 'done', detail: 'r3' },
    { id: 'a4', label: 'inbox', zone: 'build', state: 'done', detail: 'r4' },
    { id: 'a5', label: 'loop end', zone: 'build', state: 'done', detail: 'r5' },
    { id: 'z9', label: 'recent', zone: 'build', state: 'done', detail: 'r9' },
    { id: 'act', label: 'active', zone: 'build', state: 'active' },
    { id: 'wait', label: 'waiting', zone: 'build', state: 'waiting' }
  ];
  const { b, coord } = seeded(0, { steps, complete: false });
  try {
    b.write(coord, req('ask.raise', 'CAP-1', { step_id: 'a3', text: 'Answer first?' }));
    b.write(coord, req('inbox.submit', 'CAP-1', { kind: 'ask', step_id: 'a4', text: 'Proposal on a4' }));
    b.write(coord, req('task.update', 'CAP-1', { loops: [{ from: 'a5', to: 'z9' }] }, { expected_revision: 1 }));
    const r = b.write(coord, req('steps.compact', 'CAP-1', { keep_last: 1 }, { expected_revision: b.state.tasks['CAP-1'].rev }));
    assert.deepEqual(r.moved, ['a1', 'a2'], 'the plain old done steps move, the answered owner one included');
    for (const id of ['a3', 'a4', 'a5', 'z9', 'act', 'wait', 'lich-su']) assert.ok(b.state.tasks['CAP-1'].step_ids.includes(id), id + ' stays live');
    assert.equal(b.state.steps['CAP-1/a1'], undefined);
    assert.equal(b.state.archive['CAP-1'].order[0], 'a1');
  } finally { b.close(); }
});

/** An owner-zone step is a question for anh; once it is done and nothing is open on it, the question is answered and it folds like any other. */
function ownerSeed() {
  const steps = [
    { id: 'o1', label: 'owner answered', zone: 'owner', state: 'done', detail: 'ro1' },
    { id: 'o2', label: 'owner open ask', zone: 'owner', state: 'done', detail: 'ro2' },
    { id: 'o3', label: 'owner open feedback', zone: 'owner', state: 'done', detail: 'ro3' },
    { id: 'o4', label: 'owner open inbox', zone: 'owner', state: 'done', detail: 'ro4' },
    { id: 'o5', label: 'owner active', zone: 'owner', state: 'active' },
    { id: 'o7', label: 'owner todo', zone: 'owner', state: 'todo' },
    { id: 'o8', label: 'owner answered, loop end', zone: 'owner', state: 'done', detail: 'ro8' },
    { id: 'o9', label: 'owner step, only a coordinator receipt/note open on it', zone: 'owner', state: 'done', detail: 'ro9' },
    { id: 'z9', label: 'recent', zone: 'build', state: 'done', detail: 'r9' },
    { id: 'o6', label: 'owner waiting', zone: 'owner', state: 'waiting' }
  ];
  const seed = seeded(0, { steps, complete: false });
  const { b, coord } = seed;
  const answered = b.write(coord, req('ask.raise', 'CAP-1', { step_id: 'o1', text: 'Which one?', options: [{ key: 'A', label: 'First' }] }));
  b.write(OWNER, req('ask.answer', answered.id, { choice: 'A' }, { expected_revision: 1 }));
  for (const f of Object.values(b.state.feedback)) b.write(coord, req('feedback.resolve', f.id, {}, { expected_revision: f.rev })); // the coordinator handled the answer
  b.write(coord, req('ask.raise', 'CAP-1', { step_id: 'o2', text: 'Still open?' }));
  b.write(OWNER, req('feedback.add', 'CAP-1', { kind: 'note', step_id: 'o3', text: 'Look at this step' }));
  // o9: the owner wrote, the coordinator answered with a receipt (resolves the owner note) and a status note: both coordinator-authored, open by design, waiting on no one.
  const ownerNote = b.write(OWNER, req('feedback.add', 'CAP-1', { kind: 'note', step_id: 'o9', text: 'Thanks' }));
  b.write(coord, req('feedback.add', 'CAP-1', { kind: 'receipt', step_id: 'o9', reply_to: ownerNote.id, text: 'Đổi: x\nLịch: y\nBước tiếp: z' }));
  b.write(coord, req('feedback.add', 'CAP-1', { kind: 'note', step_id: 'o9', text: 'Status note by the coordinator' }));
  b.write(coord, req('inbox.submit', 'CAP-1', { kind: 'ask', step_id: 'o4', text: 'Proposal on o4' }));
  b.write(coord, req('task.update', 'CAP-1', { loops: [{ from: 'o8', to: 'z9' }] }, { expected_revision: b.state.tasks['CAP-1'].rev }));
  return seed;
}

test('a done owner-zone step whose ask was answered is eligible; open ask / unanswered owner feedback / open inbox / not-done / loop-end owner steps are not', () => {
  const { b, coord } = ownerSeed();
  try {
    const plan = compactPlan(b.state, 'CAP-1', 1);
    assert.deepEqual(plan.moved, ['o1', 'o9'], 'the answered owner step and the one with only a coordinator note open fold');
    const r = b.write(coord, req('steps.compact', 'CAP-1', { keep_last: 1 }, { expected_revision: b.state.tasks['CAP-1'].rev }));
    assert.deepEqual(r.moved, ['o1', 'o9']);
    assert.equal(b.state.steps['CAP-1/o1'], undefined);
    assert.equal(b.state.archive['CAP-1'].steps.o1.zone, 'owner', 'the archive keeps the whole record');
    assert.equal(b.state.archive['CAP-1'].steps.o1.label, 'owner answered');
    assert.ok(b.state.steps['CAP-1/lich-su'].detail.includes('owner answered'), 'the history text names the folded step');
    for (const id of ['o2', 'o3', 'o4', 'o5', 'o6', 'o7', 'o8', 'z9']) assert.ok(b.state.tasks['CAP-1'].step_ids.includes(id), id + ' stays live');
    assert.equal(Object.values(b.state.asks).filter(a => a.status === 'open').length, 1, 'the open ask is untouched');
  } finally { b.close(); }
});

test('a stale row push with archived ids does not resurrect them; its order still applies; 409 archived on re-create', async () => {
  const s = await s21Board();
  try {
    const steps = todoSteps(12);
    s.w('task.create', 'CMP-2', { title: 'CMP-2', steps });
    for (let i = 1; i <= 12; i += 1) s.w('step.update', `CMP-2/${short(i)}`, { state: 'done' }, { expected_revision: 1 });
    s.w('steps.compact', 'CMP-2', { keep_last: 1 }, { expected_revision: 1 });
    assert.deepEqual(s.steps('CMP-2'), ['lich-su', 's12']);
    s.w('step.create', 'CMP-2/s13', { label: 'Bước 13', zone: 'build', state: 'todo' });

    const archivedId = s.board.state.archive['CMP-2'].order[0];
    const live = s.board.state.tasks['CMP-2'].step_ids.map(id => {
      const rec = s.board.state.steps[`CMP-2/${id}`];
      return { id, label: rec.label, sub: rec.sub ?? '', state: rec.state, zone: rec.zone === 'owner' ? 'anh' : rec.zone, ...(rec.detail !== undefined ? { detail: rec.detail } : {}) };
    });
    const row = { code: 'CMP-2', title: 'CMP-2', lane: '', health: 'yellow', order: 1 };
    row.steps = [{ id: archivedId, label: 'Bước 1', sub: '', state: 'done', zone: 'build', detail: 'kết quả 1' },
      live.find(x => x.id === 's13'), live.find(x => x.id === 'lich-su'), live.find(x => x.id === 's12')];
    const res = await s.push([row]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok((res.body.ignored || []).some(x => x.task === 'CMP-2' && (x.archived || []).includes(archivedId)), 'the archived id is reported, never a refusal');
    assert.equal(s.board.state.steps[`CMP-2/${archivedId}`], undefined, 'not re-created');
    assert.ok(s.board.state.archive['CMP-2'].steps[archivedId], 'still in the archive');
    assert.deepEqual(s.steps('CMP-2'), ['lich-su', 's13', 's12'], 'the row order of the live steps still applies');

    let err; try { s.w('step.create', `CMP-2/${archivedId}`, { label: 'Back', zone: 'build', state: 'todo' }); } catch (e) { err = e; }
    assert.equal(err?.status, 409); assert.equal(err?.code, 'archived');

    // Readers: default output carries no archived_steps; ?archived=1 adds the metadata; the timing history is still there.
    const plain = await s.state(2), withArch = (await s.call('GET', '/api/state?v=2&archived=1', undefined, { 'X-Forwarded-For': 't31' })).body;
    const pt = plain.tasks.find(t => t.code === 'CMP-2'), at = withArch.tasks.find(t => t.code === 'CMP-2');
    assert.equal('archived_steps' in pt, false, 'default output unchanged');
    assert.equal(at.archived_steps.length, 11);
    assert.deepEqual([at.archived_steps[0].id, at.archived_steps[0].state], [archivedId, 'done']);
    assert.equal((await s.call('GET', '/api/times')).body.tasks['CMP-2'].steps[archivedId].lastState, 'done');
  } finally { await s.close(); }
});

test("a non-owner lane's row may name lich-su without owning it, and still writes its own step", async () => {
  const s = await s21Board();
  try {
    s.w('task.create', 'V-1', { title: 'Workerb task', lane: 'Workerb', steps: [{ id: 'v1', label: 'V', zone: 'build', state: 'active' }] });
    s.w('task.create', 'SH-1', { title: 'Shared', lane: 'Workera', steps: todoSteps(12) });
    for (let i = 1; i <= 12; i += 1) s.w('step.update', `SH-1/${short(i)}`, { state: 'done' }, { expected_revision: 1 });
    s.w('step.create', 'SH-1/vd', { label: 'Workerb step', zone: 'build', state: 'todo', lane: 'Workerb' });
    s.w('steps.compact', 'SH-1', { keep_last: 1 }, { expected_revision: 1 });
    const histBefore = { ...s.board.state.steps['SH-1/lich-su'] };
    assert.ok(histBefore.detail, 'the compact wrote a history detail');
    // The row names `lich-su` with no detail, a wrong label/zone and an active state: none of it may land.
    const res = await s.push([{ code: 'SH-1', steps: [{ id: 'lich-su', label: 'Row wins', state: 'active', zone: 'owner' }, { id: 'vd', label: 'Workerb step', state: 'active', zone: 'build' }] }], { lane: 'Workerb' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(s.steps('SH-1').includes('lich-su'), 'the history step survives a non-owner lane replace');
    assert.equal(s.board.state.steps['SH-1/vd'].state, 'active', "the lane's own step is written");
    assert.deepEqual(s.board.state.steps['SH-1/lich-su'], histBefore, 'a row never writes, renames, moves or blanks the history step');
  } finally { await s.close(); }
});

test('dry run is a read route: it writes nothing and shares the eligibility of the op', async () => {
  const s = await startServer();
  try {
    const coord = (await s.write(OWNER, 'token.issue', 'coordinator', { role: 'coordinator' })).body.token;
    await s.write(coord, 'task.create', 'DRY-1', { title: 'Dry', steps: todoSteps(5) });
    for (let i = 1; i <= 5; i += 1) await s.write(coord, 'step.update', `DRY-1/${short(i)}`, { state: 'done' }, { expected_revision: 1 });
    const journal = fs.readFileSync(path.join(s.dataDir, 'events.ndjson'), 'utf8'), seq = s.board.state.seq;
    const r = await s.call(coord, 'GET', '/api/v1/compact/preview?task=DRY-1&keep_last=1');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.moved, ['s01', 's02', 's03', 's04']);
    assert.equal(r.body.revision, 1); assert.equal(r.body.history.id, 'lich-su');
    assert.match(r.body.history.detail.split('\n')[0], /Bước 4 · kết quả 4$/);
    assert.equal(s.board.state.seq, seq, 'no event');
    assert.equal(fs.readFileSync(path.join(s.dataDir, 'events.ndjson'), 'utf8'), journal, 'journal unchanged');
    assert.equal((await s.call(coord, 'GET', '/api/v1/compact/preview?task=DRY-1&keep_last=0')).status, 400);
    const rep = (await s.write(OWNER, 'token.issue', 'rep', { role: 'reporter', scope_tasks: ['*'] })).body.token;
    assert.equal((await s.call(rep, 'GET', '/api/v1/compact/preview?task=DRY-1')).status, 403, 'owner/coordinator only');
  } finally { await s.close(); }
});

test('history result drops the heading marker of the step detail', () => {
  const line = compactLine('## Kế hoạch: có chuyển Zumi sang Tauri không (16-10, Astra)', 'Kế hoạch Tauri');
  assert.equal(line, '01/10 · Kế hoạch Tauri · Kế hoạch: có chuyển Zumi sang Tauri không (16-10, Astra)');
});

test('history result strips leading quote/list markers, bold and code', () => {
  assert.equal(compactLine('> - **Đã xong** phần `api`', 'Việc A'), '01/10 · Việc A · Đã xong phần api');
  assert.equal(compactLine('3. bước thứ ba', 'Việc B'), '01/10 · Việc B · bước thứ ba');
});

test('history result turns a markdown link into its text', () => {
  assert.equal(compactLine('Xem [tài liệu](https://example.com/a) ngay', 'Việc A'), '01/10 · Việc A · Xem tài liệu ngay');
  assert.equal(compactLine('Xem [A](https://vi.wikipedia.org/wiki/A_(b)) ngay', 'Việc B'), '01/10 · Việc B · Xem A ngay', 'a URL with balanced parens');
});

test('history result is capped at 80 characters with an ellipsis', () => {
  const atCap = compactLine('a'.repeat(80), 'Việc A').split(' · ').at(-1);
  assert.equal(atCap, 'a'.repeat(80), 'exactly 80 chars is not truncated');
  const over = compactLine('a'.repeat(120), 'Việc B').split(' · ').at(-1);
  assert.equal(Array.from(over).length, 80);
  assert.equal(over, 'a'.repeat(79) + '…');
});

test('a step with no result, or one that repeats its label, keeps the label only', () => {
  assert.equal(compactLine('', 'Việc A'), '01/10 · Việc A');
  assert.equal(compactLine('   \n\t ', 'Việc B'), '01/10 · Việc B');
  assert.equal(compactLine('**Việc C**', 'Việc C'), '01/10 · Việc C', 'equal after stripping, case/space-insensitive');
  assert.equal(compactLine('việc   c', 'Việc C'), '01/10 · Việc C');
});

test('journal replay from an empty projection reproduces the compacted state exactly', () => {
  const dir = tmpDir();
  let clock = T0;
  const b = createBoard({ dataDir: dir, ownerToken: OWNER, now: () => clock });
  try {
    const coord = b.write(OWNER, req('token.issue', 'coordinator', { role: 'coordinator' })).token;
    b.write(coord, req('task.create', 'RPL-1', { title: 'Replay', steps: todoSteps(6) }));
    for (let i = 1; i <= 6; i += 1) { clock += H; b.write(coord, req('step.update', `RPL-1/${short(i)}`, { state: 'done' }, { expected_revision: 1 })); }
    b.write(coord, req('steps.compact', 'RPL-1', { keep_last: 2 }, { expected_revision: 1 }));
    const final = clone(b.state);
    b.close();
    fs.rmSync(path.join(dir, 'state.json'));
    const b2 = createBoard({ dataDir: dir, ownerToken: OWNER });
    try {
      assert.ok(b2.replayed > 0);
      assert.deepEqual(clone(b2.state), final, 'the reducer is deterministic: same journal, same state');
    } finally { b2.close(); }
  } finally { try { b.close(); } catch { /* already closed */ } }
});
