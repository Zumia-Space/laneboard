// The Needs-you rail (public/measure.js needRows): one entry per task. Regression for 10-11, F-04, L-01 and ACME-01, each
// with two owner steps waiting, showed twice in the rail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import '../public/measure.js';

const { needRows, rowWaitSince } = globalThis.LaneMeasure;
const H = 3600000;
const NOW = Date.parse('2026-10-11T13:00:00.000Z');
const item = (task_id, id, age_h, kind = 'step') => ({ kind, id, task_id, text: id, age_ms: age_h * H, since: new Date(NOW - age_h * H).toISOString() });

test('a task with two waiting items is one rail entry: its oldest item, with the count', () => {
  const rows = needRows([item('F-04', 'F-04/copy', 3), item('L-01', 'L-01/abc', 48), item('F-04', 'F-04/pick', 47), item('ACME-01', 'ACME-01/price', 1), item('ACME-01', 'ACME-01/scope', 20)]);
  assert.deepEqual(rows.map(r => r.task_id), ['L-01', 'F-04', 'ACME-01'], 'one row per task, longest wait first');
  const f = rows.find(r => r.task_id === 'F-04');
  assert.equal(f.id, 'F-04/pick', 'the entry is the oldest ask (the link opens it)');
  assert.equal(f.age_ms, 47 * H, 'the age is the oldest open ask');
  assert.equal(f.count, 2);
  assert.deepEqual(f.items.map(i => i.id), ['F-04/pick', 'F-04/copy']);
  assert.equal(rows.find(r => r.task_id === 'L-01').count, 1);
  assert.equal(needRows([]).length, 0);
  assert.equal(needRows(undefined).length, 0);
});

test('the page builds its rail from needRows', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /LM\.needRows\(waiting\)/);
});

test('rowWaitSince: the oldest open ask or uncovered waiting step; an answered (unreceived) item is not a wait', () => {
  const rows = [item('F-04', 'a', 3, 'ask'), item('F-04', 'b', 47, 'step'), item('F-04', 'c', 90, 'unreceived')];
  assert.equal(rowWaitSince(rows), rows[1].since, 'the unreceived item does not age the row');
  assert.equal(rowWaitSince([rows[2]]), rows[2].since, 'nothing else waits: it is all there is');
  assert.equal(rowWaitSince([]), '');
  const entry = needRows(rows)[0];
  assert.equal(entry.id, 'b'); assert.equal(entry.count, 3); assert.equal(entry.since, rowWaitSince(rows), 'the rail entry is the row age');
});
