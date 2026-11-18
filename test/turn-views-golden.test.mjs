// The views that existed before turn.report are byte-identical after it: GET /api/v1/state (no v, v=1, owner, coordinator, anonymous)
// and the predecessor-compatible /api/state, /api/state?v=2 and /api/times. The baseline was produced by the commit before
// turn.report (see test/golden/turn-views-scenario.mjs). A board that holds turn reports reads the same everywhere but `seq`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { viewsOf } from './golden/turn-views-scenario.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const golden = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'golden', 'turn-views-baseline.json'), 'utf8'));
const { _doc, ...baseline } = golden;

test('golden: every pre-turn.report view is byte-identical to the baseline', async () => {
  const now = await viewsOf(ROOT);
  assert.deepEqual(Object.keys(now), Object.keys(baseline));
  for (const k of Object.keys(baseline)) assert.equal(now[k], baseline[k], `${k} changed`);
});

test('golden: turn reports on the board leave those views as they were (v1 apart from seq and the extra events, legacy exactly)', async () => {
  const withTurns = await viewsOf(ROOT, { withTurns: true });
  const strip = text => { const { seq, now, ...rest } = JSON.parse(text); return JSON.stringify(rest); };
  for (const k of ['v1', 'v1explicit', 'v1coordinator', 'v1anonymous']) assert.equal(strip(withTurns[k]), strip(baseline[k]), k);
  assert.ok(JSON.parse(withTurns.v1).seq > JSON.parse(baseline.v1).seq);
  for (const k of ['legacy', 'legacyV2', 'legacyTimes']) {
    // the clock moved by the two extra writes; nothing else may differ
    const a = JSON.parse(withTurns[k]), b = JSON.parse(baseline[k]);
    for (const x of [a, b]) { delete x.now; delete x.seq; }
    assert.deepEqual(a, b, k);
  }
  assert.doesNotMatch(withTurns.v1, /"turns"/, 'no turns without ?v=2');
  assert.doesNotMatch(withTurns.v1explicit, /"turns"/);
});
