// J-05 stats: the Stats page ALWAYS shows overall usage per model (today / 7 days / all time) with the task, unattributed and
// lane-overhead buckets, with NO 60% gate; the gate stays on the per-task breakdown only. Numbers come from doc.models (the
// collector's model_daily through stats-build); the page never recomputes them.
// The page functions are lifted out of public/app.js and run in a vm with the real locale files, as stats-by-model does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { s21Board } from './s21-helpers.mjs';

const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const APP = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');
const load = l => JSON.parse(fs.readFileSync(path.join(PUB, 'locales', `${l}.json`), 'utf8'));
const LOC = { en: load('en'), vi: load('vi'), zh: load('zh') };

function lift(name) {
  const line = APP.match(new RegExp(`^const ${name} = .*;( //.*)?$`, 'm'));
  if (line) return line[0];
  const start = APP.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `app.js has no ${name}`);
  return APP.slice(start, APP.indexOf('\n}\n', start) + 2);
}
const FNS = ['esc', 't', 'modelClass', 'modelName', 'fmtMil', 'fmtPct', 'stackBar', 'statsReady', 'statsGated', 'STATS_GATE_PCT', 'STATS_MODELS', 'modelLegend', 'statsGateHtml', 'statsTopRow', 'statsModelChips', 'statsModelsCard', 'statsCard'];
function page(lang, stats, extra = {}) {
  const sandbox = { S: { dict: LOC[lang], en: LOC.en, data: { me: { id: 'anh' } }, stats, statWin: 'w7', ...extra }, document: { documentElement: { lang } } };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(FNS.map(lift).join('\n'), ctx);
  return ctx;
}
const M = 1e6;
const MODELS = {
  today: [{ model: 'claude-sonnet-5-5', tokens: 3 * M, tasks: 1 * M, unattributed: 1.5 * M, lane_overhead: 0.5 * M }],
  w7: [
    { model: 'deepseek-v4.1-flash', tokens: 40 * M, tasks: 40 * M, unattributed: 0, lane_overhead: 0 },
    { model: 'claude-opus-5-5', tokens: 20 * M, tasks: 5 * M, unattributed: 12 * M, lane_overhead: 3 * M },
    { model: 'claude-sonnet-5', tokens: 10 * M, tasks: 2 * M, unattributed: 6 * M, lane_overhead: 2 * M },
  ],
  all: [
    { model: 'deepseek-v4.1-flash', tokens: 61.3 * M, tasks: 61.3 * M, unattributed: 0, lane_overhead: 0 },
    { model: 'claude-opus-5-5', tokens: 19.9 * M, tasks: 8 * M, unattributed: 9.9 * M, lane_overhead: 2 * M },
  ],
};
const DOC = { schema: 1, attributed_pct: 38.9, window_days: 14, tasks: {}, top: { w7: [], today: [] }, models: MODELS };
const render = (lang, doc, extra) => vm.runInContext('statsModelsCard()', page(lang, doc, extra));
const rows = html => [...html.matchAll(/<div class="st-mrow" data-model="([a-z]+)"/g)].map(m => m[1]);

test('per-model totals render while attributed is under 60% (38.9): one row per model of the 7-day window, buckets per model, no gate', () => {
  for (const lang of ['en', 'vi', 'zh']) {
    const html = render(lang, DOC);
    assert.deepEqual(rows(html), ['deepseek', 'opus', 'sonnet'], `${lang}: ${html}`);
    assert.ok(!html.includes('st-gate'), 'no gate on the model card');
    assert.match(html, /claude-opus-5-5/);
    assert.match(html, /st-b task">[^<]*<b>5[.,]0<\/b>/, 'opus task bucket 5.0 M');
    assert.match(html, /st-b unattr">[^<]*<b>12[.,]0<\/b>/, 'opus unattributed bucket 12.0 M');
    assert.match(html, /st-b lane">[^<]*<b>3[.,]0<\/b>/, 'opus lane-overhead bucket 3.0 M');
    assert.equal((html.match(/data-bar-grow=/g) || []).length, 7, 'bucket bars: deepseek 1 + opus 3 + sonnet 3 non-zero parts');
  }
});

test('the 60% gate stays on the per-task card: with the same under-60% document it still shows the "measuring" gate and no task rows', () => {
  const html = vm.runInContext('statsCard()', page('en', DOC));
  assert.ok(html.includes('st-gate'));
  assert.ok(!html.includes('st-row'));
});

test('the window switch: today, 7 days, all time each show their own models and totals', () => {
  assert.deepEqual(rows(render('en', DOC, { statMWin: 'today' })), ['sonnet']);
  assert.deepEqual(rows(render('en', DOC, { statMWin: 'all' })), ['deepseek', 'opus']);
  assert.deepEqual(rows(render('en', DOC, { statMWin: 'bogus' })), ['deepseek', 'opus', 'sonnet'], 'unknown value falls back to 7 days');
  const html = render('en', DOC);
  assert.equal((html.match(/data-action="stats-mwin"/g) || []).length, 3);
  assert.match(html, /aria-checked="true" data-action="stats-mwin" data-win="w7"/);
});

test('a window with no usage says so; a document without models (older producer) or a signed-out reader gets no model card', () => {
  assert.match(render('en', { ...DOC, models: { ...MODELS, today: [] } }, { statMWin: 'today' }), /st-empty|class="empty"/);
  const { models, ...old } = DOC;
  assert.equal(render('en', old), '');
  assert.equal(vm.runInContext('statsModelsCard()', page('en', DOC, { data: { me: null } })), '');
  assert.equal(render('en', undefined), '');
});

test('the schema accepts doc.models (even under 60%) and refuses a malformed model row or an unknown window', async () => {
  const s = await s21Board();
  try {
    const put = doc => s.call('PUT', '/api/admin/stats', { doc: { generated_at: '2026-10-26T05:00:00.000Z', ...doc } });
    assert.equal((await put(DOC)).status, 200);
    assert.equal((await put({ ...DOC, models: { w7: [{ model: 'x', tokens: 1, tasks: 1, unattributed: 0 }] } })).body.error, 'invalid_data', 'lane_overhead is required');
    assert.equal((await put({ ...DOC, models: { w7: [{ model: 'x', tokens: -1, tasks: 1, unattributed: 0, lane_overhead: 0 }] } })).body.error, 'invalid_data');
    assert.equal((await put({ ...DOC, models: { month: [] } })).body.error, 'invalid_data');
  } finally { await s.close(); }
});
