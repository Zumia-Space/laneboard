// scripts/migrate-from-legacy.mjs on a small synthetic predecessor snapshot: every record type arrives through
// the board's own write path, the owner block matches the predecessor's "Chờ anh" lines, timing totals match,
// media lands on the right task (big files via the streamed upload), and the result replays from the journal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createBoard } from '../src/board.mjs';
import { migrate, legacyWaitingLines, legacyTaskTotals, legacyStalled, importStatus, loadLegacy, legacySchemaErrors } from '../scripts/migrate-from-legacy.mjs';
import { demoPng } from '../scripts/seed.mjs';
import { tmpDir } from './helpers.mjs';

const T0 = '2026-09-27T01:00:00.000Z', T1 = '2026-09-27T05:00:00.000Z', T2 = '2026-09-27T09:00:00.000Z';
const step = (id, state, zone = 'build', extra = {}) => ({ id, label: `Step ${id}`, state, zone, ...extra });
const trec = (lastState, extra = {}) => ({ firstSeenAt: T0, startedAt: null, doneAt: null, waitingSince: null, waitingTotalMs: 0, lastState, untracked: false, transitions: [], ...extra });

function snapshot() {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'data')); fs.mkdirSync(path.join(dir, 'media'));
  const put = (n, v) => fs.writeFileSync(path.join(dir, 'data', `${n}.json`), JSON.stringify(v));
  put('tasks', [
    { code: 'A-1', title: 'Alpha', lane: 'workera', health: 'yellow', needsAnh: 'Seed text, overridden by asks.json', order: 1,
      worker: { model: 'sonnet', effort: 'medium', reason: 'routine' },
      steps: [step('s1', 'done'), step('s2', 'waiting', 'anh', { detail: 'See ![Hero](media/hero.png)', options: [{ key: 'A', label: 'Photo' }, { key: 'B', label: 'Drawing' }] }), step('s3', 'todo'), step('s3', 'todo')] },
    { code: 'B-2', title: 'Beta', lane: 'workerb', health: 'green', order: 2, steps: [step('s1', 'waiting', 'anh'), step('s2', 'active')] },
    { code: 'C-3', title: 'Gamma', lane: 'workera', health: 'grey', order: 3, steps: [step('s1', 'waiting', 'anh')] }
  ]);
  put('asks', { 'A-1': { text: 'Pick the hero (lane ask)', by: 'Workerb', at: T1 } });
  put('feedback', [
    { id: 'f1', task: 'A-1', step: '', text: 'Make it bigger', kind: 'note', by: 'anh', status: 'done', at: T0, doneAt: T1 },
    { id: 'f2', task: 'A-1', step: '', text: 'Done, bigger now', kind: 'note', by: 'cos', status: 'open', replyTo: 'f1', at: T1 },
    { id: 'f3', task: 'B-2', step: 's1', text: 'Chọn A: Duyệt\nlooks fine', kind: 'choice', by: 'anh', status: 'done', at: T2, doneAt: T2 },
    { id: 'f4', task: 'NEW', step: '', text: 'Please open a task for X', kind: 'newtask', by: 'anh', status: 'done', at: T0, doneAt: T1 }
  ]);
  put('times', { tasks: {
    'A-1': { firstSeenAt: T0, startedAt: T0, doneAt: null, steps: { s1: trec('done', { untracked: true }), s2: trec('waiting', { waitingSince: T1, transitions: [{ t: T1, from: 'todo', to: 'waiting' }] }), s3: trec('todo', { transitions: [{ t: T1, from: 'done', to: 'todo' }] }) } },
    'B-2': { firstSeenAt: T0, startedAt: T0, doneAt: null, steps: { s1: trec('waiting', { waitingSince: T1, waitingTotalMs: 600000 }), s2: trec('active', { startedAt: T0 }) } },
    'GONE': { firstSeenAt: T0, startedAt: T0, doneAt: T1, steps: { s1: trec('done', { startedAt: T0, doneAt: T1 }) } }
  } });
  put('routing', { 'A-1': { model: 'opus', effort: 'high', by: 'anh', at: T1 } });
  put('meta', { summary: ['Alpha waits on the hero pick', 'Beta building'], updatedAt: T2 });
  put('registry', [
    { id: 'r1', file: 'A-1 — Alpha', code: 'A-1', title: 'Alpha', owner: '', note: 'active', updated: '2026-09-27', onBoard: true, status: 'open' },
    { id: 'r2', file: 'B-2 — Beta', code: 'B-2', title: 'Beta', owner: '', note: '', updated: '2026-09-27', onBoard: true, status: 'open' },
    { id: 'r3', file: 'Z9 — Old idea', code: 'Z9', title: 'Old idea', owner: '', note: 'stale', updated: '2026-07-01', onBoard: false, status: 'open' }
  ]);
  put('registry-status', { r1: { status: 'doing', statusBy: 'anh', statusAt: T1 }, r3: { status: 'paused', statusBy: 'cos', statusAt: T1 } });
  put('pings', [{ id: 'p1', note: 'sent', task: 'A-1', open: 1, at: T1, seenAt: '' }]);
  fs.writeFileSync(path.join(dir, 'media', 'hero.png'), demoPng(20, 10));
  const video = crypto.randomBytes(300 * 1024); video.writeUInt32BE(24, 0); video.write('ftypisom', 4, 'latin1');
  fs.writeFileSync(path.join(dir, 'media', 'b2-demo.mp4'), video);
  fs.writeFileSync(path.join(dir, 'media', 'misc.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
  return { dir, video };
}

test('migrate-from-legacy: every record type through the write path, owner block and timing equal to the predecessor', async () => {
  const { dir, video } = snapshot();
  const to = path.join(tmpDir(), 'board');
  const report = await migrate({ from: dir, to, remap: { NEW: 'A-1' } });
  assert.equal(report.imported.tasks, 3);
  assert.equal(report.imported.feedback_anh_note + report.imported.feedback_cos_reply + report.imported.feedback_anh_choice + report.imported.feedback_anh_newtask, 4);
  assert.equal(report.imported.feedback_resolved, 3);
  assert.equal(report.imported.times, 3);
  assert.equal(report.imported.media, 2);
  assert.ok(report.warnings.some(w => /misc\.jpg/.test(w)), 'unmapped media is reported, not guessed');
  assert.ok(report.warnings.some(w => /s3 imported as s3-2/.test(w)));
  assert.ok(fs.existsSync(path.join(to, 'legacy', 'pings.json')), 'pings archived verbatim');
  await assert.rejects(migrate({ from: dir, to }), /non-empty/);

  const b = createBoard({ dataDir: to });
  const owner = fs.readFileSync(path.join(to, 'owner.token'), 'utf8').trim();
  const v = b.view(owner), now = Date.parse(v.now);
  const task = id => v.tasks.find(t => t.id === id);
  assert.deepEqual(v.tasks.map(t => [t.id, t.status]), [['A-1', 'doing'], ['B-2', 'open'], ['C-3', 'doing']], 'liveness from the registry, as the predecessor did');
  assert.ok(report.warnings.some(w => /C-3: grey/.test(w)));
  assert.deepEqual(task('A-1').steps.map(s => s.id.split('/')[1]), ['s1', 's2', 's3', 's3-2']);
  assert.deepEqual(task('A-1').worker, { model: 'opus', effort: 'high', by: 'owner', at: task('A-1').worker.at, reason: 'routine' });

  // Owner block: the same lines the predecessor showed as waiting / answered.
  const legacy = legacyWaitingLines(loadLegacy(dir));
  assert.deepEqual(legacy.waiting.map(x => x.code), ['A-1', 'C-3']);
  assert.deepEqual(legacy.answered.map(x => x.code), ['B-2']);
  assert.deepEqual(v.attention.waiting.map(w => [w.kind, w.task_id, w.step_id, w.text]), [['ask', 'A-1', 's2', 'Pick the hero (lane ask)'], ['step', 'C-3', 's1', 'Step s1']]);
  assert.equal(v.attention.waiting[0].options.length, 2);
  assert.deepEqual(v.attention.answered.map(a => [a.task_id, a.choice, a.answer_text]), [['B-2', undefined, 'Chọn A: Duyệt\nlooks fine']]);

  // Feedback: kinds, reply link, resolution, original author/time as origin.
  const fb = v.feedback;
  const note = fb.find(f => f.text === 'Make it bigger'), reply = fb.find(f => f.kind === 'reply');
  assert.equal(note.status, 'resolved'); assert.equal(reply.reply_to, note.id);
  assert.equal(note.attribution.created_by.origin, `legacy anh ${T0}`);
  assert.equal(fb.find(f => f.kind === 'choice').step_id, 's1');
  assert.equal(fb.find(f => f.kind === 'newtask').task_id, 'A-1', 'remapped');

  // Timing: imported histories give the predecessor's totals; GONE is archived, not dropped.
  const data = loadLegacy(dir);
  for (const id of ['A-1', 'B-2']) {
    const m = task(id).measured;
    assert.deepEqual({ work_ms: m.work_ms, wait_ms: m.wait_ms }, legacyTaskTotals(data.times.tasks[id], now), id);
  }
  assert.equal(v.times['GONE/s1'].done_at, T1);

  // Board documents.
  assert.deepEqual(v.docs.summary.items, ['Alpha waits on the hero pick', 'Beta building']);
  assert.deepEqual(v.docs.registry.entries.map(e => [e.id, e.status, e.on_board]), [['r1', 'doing', true], ['r2', 'open', true], ['r3', 'paused', false]]);

  // Media: referenced image on its step with its caption; big video streamed in.
  const hero = v.attachments.find(a => a.name === 'hero.png'), clip = v.attachments.find(a => a.name === 'b2-demo.mp4');
  assert.deepEqual([hero.task_id, hero.step_id, hero.caption], ['A-1', 's2', 'Hero']);
  assert.deepEqual([clip.task_id, clip.mime, clip.size], ['B-2', 'video/mp4', video.length]);
  assert.ok(fs.readFileSync(path.join(to, 'media', clip.sha256)).equals(video));
  const seq = b.state.seq;
  b.close();

  // The import is an ordinary journal: rebuilding the projection from it gives the same state.
  const before = JSON.stringify(JSON.parse(fs.readFileSync(path.join(to, 'state.json'), 'utf8')));
  fs.rmSync(path.join(to, 'state.json'));
  const b2 = createBoard({ dataDir: to });
  assert.equal(b2.state.seq, seq);
  assert.equal(JSON.stringify(b2.state), before);
  b2.close();
});

test('migrate-from-legacy: ages do not restart at the import, and a grey "TẠM HOÃN" row is paused', async () => {
  const { dir } = snapshot();
  const edit = (n, fn) => { const p = path.join(dir, 'data', `${n}.json`); fs.writeFileSync(p, JSON.stringify(fn(JSON.parse(fs.readFileSync(p, 'utf8'))))); };
  edit('tasks', ts => ts.map(t => ({ ...t, updated: { 'A-1': T0, 'B-2': T2, 'C-3': T0 }[t.code], ...(t.code === 'C-3' ? { now: 'Tạm hoãn theo anh (26-09)' } : {}) })));
  edit('asks', a => ({ 'A-1': { ...a['A-1'], at: T2 } })); // asked again after the step started waiting: the line keeps the older wait
  edit('registry', r => [...r, { id: 'r4', file: 'C-3 — Gamma', code: 'C-3', title: 'Gamma', owner: '', note: '', updated: '', onBoard: true, status: 'doing' }]);
  const to = path.join(tmpDir(), 'board');
  const report = await migrate({ from: dir, to, remap: { NEW: 'A-1' } });
  assert.ok(report.warnings.some(w => /C-3: grey dot \+ "TẠM HOÃN" but registry status 'doing' — imported as paused/.test(w)));
  assert.equal(report.imported.ask_ages, 1);

  const b = createBoard({ dataDir: to });
  const owner = fs.readFileSync(path.join(to, 'owner.token'), 'utf8').trim();
  const v = b.view(owner), now = Date.parse(v.now), data = loadLegacy(dir);
  const statusOf = row => importStatus(data, row);
  assert.equal(v.tasks.find(t => t.id === 'C-3').status, 'paused');
  assert.equal(v.docs.registry.entries.find(e => e.id === 'r4').status, 'paused');

  // Chờ anh: same lines, same since as the predecessor (min(askAt, waitingSince)), not the import time.
  const lines = legacyWaitingLines(data, statusOf).waiting;
  assert.deepEqual(lines.map(l => [l.code, new Date(l.since).toISOString()]), [['A-1', T1]]);
  assert.deepEqual(v.attention.waiting.map(w => [w.task_id, w.since]), [['A-1', T1]]);
  // Đứng im: same tasks, same last movement = max(updated, step transitions).
  const legacyIdle = legacyStalled(data, now, statusOf).map(s => [s.code, new Date(s.last).toISOString()]);
  assert.deepEqual(legacyIdle, [['A-1', T1], ['B-2', T2]]);
  assert.deepEqual(v.stalled.map(s => [s.task_id, s.last_at]), legacyIdle);
  b.close();
});

test('migrate-from-legacy: legacy step state "doing" imports as active, in rows and timing history, clock untouched', async () => {
  const { dir } = snapshot();
  const edit = (n, fn) => { const p = path.join(dir, 'data', `${n}.json`); fs.writeFileSync(p, JSON.stringify(fn(JSON.parse(fs.readFileSync(p, 'utf8'))))); };
  // The live board's 30-09 shape: steps first seen as 'doing' (no start measured), then done or active (s4/s5 are
  // history only, like a step since removed from the row).
  edit('tasks', ts => ts.map(t => (t.code === 'B-2' ? { ...t, steps: [...t.steps, step('s3', 'doing')] } : t)));
  edit('times', tm => {
    Object.assign(tm.tasks['B-2'].steps, {
      s3: trec('doing'),
      s4: trec('done', { doneAt: T2, transitions: [{ t: T2, from: 'doing', to: 'done' }] }),
      s5: trec('active', { startedAt: T2, transitions: [{ t: T2, from: 'doing', to: 'active' }] })
    });
    return tm;
  });
  assert.deepEqual(legacySchemaErrors(loadLegacy(dir)), []);
  const to = path.join(tmpDir(), 'board');
  await migrate({ from: dir, to, remap: { NEW: 'A-1' } });
  const b = createBoard({ dataDir: to });
  const owner = fs.readFileSync(path.join(to, 'owner.token'), 'utf8').trim();
  const v = b.view(owner);
  assert.equal(b.state.steps['B-2/s3'].state, 'active');
  assert.deepEqual(v.times['B-2/s4'].transitions, [{ at: T2, from: 'active', to: 'done' }]);
  assert.deepEqual(v.times['B-2/s5'].transitions, [{ at: T2, from: 'active', to: 'active' }]);
  assert.equal(v.times['B-2/s4'].started_at, undefined, 'the predecessor never started its clock on doing: no start invented');
  assert.equal(v.times['B-2/s5'].started_at, T2);
  assert.equal(v.times['B-2/s3'].last_state, 'active');
  b.close();
});

test('migrate-from-legacy: a timing record in an unknown state refuses the whole snapshot before writing anything', async () => {
  const { dir } = snapshot();
  const p = path.join(dir, 'data', 'times.json');
  const tm = JSON.parse(fs.readFileSync(p, 'utf8'));
  tm.tasks['A-1'].steps.s3.transitions.push({ t: T2, from: 'frozen', to: 'todo' });
  fs.writeFileSync(p, JSON.stringify(tm));
  assert.deepEqual(legacySchemaErrors(loadLegacy(dir)).map(e => [e.op, e.target_id, e.path]), [['times.import', 'A-1', '$.steps.s3.transitions[1].from']]);
  const to = path.join(tmpDir(), 'board');
  await assert.rejects(migrate({ from: dir, to }), e => e.schemaErrors.length === 1 && /nothing imported/.test(e.message));
  assert.equal(fs.existsSync(to), false, 'target directory never created');
});
