// Review of d371377, item 3: a single-ask row behaves as on ce850a7. The golden file was recorded by running this very scenario
// on a `git archive ce850a7` tree (S21_GOLDEN_WRITE=1 S21_GOLDEN_FILE=<path>); the unversioned /api/state projection and the
// v2 asks[] (no ids or times) after every push must match it exactly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { s21Board, step } from './s21-helpers.mjs';

const GOLDEN = process.env.S21_GOLDEN_FILE || path.join(path.dirname(fileURLToPath(import.meta.url)), 'golden', 's21-single-ask.json');
const rowV = (steps, needsAnh, askStep) => ({ code: 'V-9', title: 'Single', lane: 'Workerb', health: 'yellow', order: 9, now: 'n', next: 'x', needsAnh, ...(askStep ? { askStep } : {}), steps });
const OPTS = { options: [{ key: 'A', label: 'Photo' }] };
const z = step('z', 'todo');

async function transcript() {
  const s = await s21Board();
  const out = [];
  const snap = async (label, rows) => {
    const r = await s.push(rows);
    if (r.status !== 200) { out.push({ label, status: r.status, error: r.body.error }); return; }
    const t = await s.code('V-9'), t2 = await s.code('V-9', 2);
    out.push({ label, writes: r.body.writes, needsAnh: t.needsAnh, steps: t.steps.map(x => [x.id, x.state]), asks: (t2.asks || []).map(a => [a.lane, a.step_id || '', a.text]), open: s.openAsks('V-9').length });
  };
  try {
    s.w('task.create', 'V-0', { title: 'other', lane: 'Workerb', order: 1, steps: [step('o1', 'active')] });
    await snap('create, no ask', [rowV([step('a', 'todo', 'anh'), step('b', 'todo', 'anh'), z], '')]);
    await snap('ask Q1 on a', [rowV([step('a', 'waiting', 'anh'), step('b', 'todo', 'anh'), z], 'Q1', 'a')]);
    await snap('same row again', [rowV([step('a', 'waiting', 'anh'), step('b', 'todo', 'anh'), z], 'Q1', 'a')]);
    await snap('reworded on a', [rowV([step('a', 'waiting', 'anh'), step('b', 'todo', 'anh'), z], 'Q1 reworded', 'a')]);
    await snap('moved to b, a done', [rowV([step('a', 'done', 'anh'), step('b', 'waiting', 'anh'), z], 'Q2', 'b')]);
    await snap('blank, step still waiting', [rowV([step('a', 'done', 'anh'), step('b', 'waiting', 'anh'), z], '', 'b')]);
    await snap('ask Q3 on b again', [rowV([step('a', 'done', 'anh'), step('b', 'waiting', 'anh'), z], 'Q3', 'b')]);
    await snap('blank, step done (the client clear)', [rowV([step('a', 'done', 'anh'), step('b', 'done', 'anh'), z], '')]);
    await snap('ask on an options step', [rowV([step('a', 'done', 'anh'), step('b', 'waiting', 'anh', OPTS), z], 'Q4', 'b')]);
    await snap('blank, options step waiting, askStep kept', [rowV([step('a', 'done', 'anh'), step('b', 'waiting', 'anh', OPTS), z], '', 'b')]);
    await snap('finished', [rowV([step('a', 'done', 'anh'), step('b', 'done', 'anh', OPTS), z], '')]);
    await snap('finished again', [rowV([step('a', 'done', 'anh'), step('b', 'done', 'anh', OPTS), z], '')]);
    return out;
  } finally { await s.close(); }
}

test('single-ask rows: the legacy and v2 projections after every push equal the ce850a7 golden', async () => {
  const got = await transcript();
  if (process.env.S21_GOLDEN_WRITE) { fs.mkdirSync(path.dirname(GOLDEN), { recursive: true }); fs.writeFileSync(GOLDEN, JSON.stringify(got, null, 1) + '\n'); return; }
  assert.deepEqual(got, JSON.parse(fs.readFileSync(GOLDEN, 'utf8')));
});
