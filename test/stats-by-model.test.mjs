// J-05 stats item 3: the Board Stats row shows one chip per model (not only the dominant one); a document from before
// by_model still renders its single chip; the schema accepts by_model and refuses a malformed one.
// The page functions are lifted out of public/app.js and run in a vm with the real locale files, as route-override-ui does.
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
function page(lang) {
  const sandbox = { S: { dict: LOC[lang], en: LOC.en, data: {} }, document: { documentElement: { lang } } };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(['esc', 't', 'modelClass', 'modelName', 'fmtMil', 'fmtPct', 'statsModelChips', 'statsTopRow'].map(lift).join('\n'), ctx);
  return ctx;
}
const BASE = { code: 'ACME-02', title: 'Agent', tokens: 10000000, share_pct: 40, trend: 'up', trend_pct: 5, model: 'deepseek-v4.1-flash' };
const THREE = { ...BASE, by_model: [
  { model: 'deepseek-v4.1-flash', tokens: 6000000, share: 60 },
  { model: 'claude-opus-5-5', tokens: 3000000, share: 30 },
  { model: 'claude-sonnet-5-5', tokens: 1000000, share: 10 }
] };
const chips = html => [...html.matchAll(/<span class="st-mchip ([a-z]+)"[^>]*>/g)].map(m => m[1]);
const render = (lang, row) => vm.runInContext(`statsTopRow(${JSON.stringify(row)})`, page(lang));

test('a row with three models renders three chips, each in its own model colour with its share', () => {
  for (const lang of ['en', 'vi', 'zh']) {
    const html = render(lang, THREE);
    assert.deepEqual(chips(html), ['deepseek', 'opus', 'sonnet'], `${lang}: ${html}`);
    assert.match(html, /60%/); assert.match(html, /30%/); assert.match(html, /10%/);
    assert.match(html, /data-model="deepseek"/, 'the row keeps its dominant-model attribute');
  }
});

test('a document without by_model renders the single dominant-model chip as before', () => {
  const html = render('en', BASE);
  assert.deepEqual(chips(html), ['deepseek']);
  assert.match(html, /data-model="deepseek"/);
  assert.equal(chips(render('en', { ...BASE, model: undefined })).length, 0, 'no model at all: no chip, no crash');
  assert.deepEqual(chips(render('en', { ...BASE, by_model: [] })), ['deepseek'], 'an empty split falls back to the single chip');
});

test('models under 1% fold into one "other" chip with the localised label', () => {
  const row = { ...BASE, by_model: [
    { model: 'deepseek-v4.1-flash', tokens: 9900000, share: 99 },
    { model: 'claude-haiku-5', tokens: 60000, share: 0.6 },
    { model: 'claude-opus-4-8', tokens: 40000, share: 0.4 }
  ] };
  for (const lang of ['en', 'vi', 'zh']) {
    const html = render(lang, row);
    assert.deepEqual(chips(html), ['deepseek', 'other'], `${lang}: ${html}`);
    assert.ok(html.includes(LOC[lang]['stats.modelOther']), `${lang}: the other label comes from the locale`);
    assert.ok(!html.includes('haiku') && !html.includes('opus-4-8'), 'folded models are not listed on their own');
  }
});

test('the schema accepts by_model on a top row and refuses a malformed one; an old row is still valid', async () => {
  const s = await s21Board();
  try {
    const doc = top => ({ schema: 1, generated_at: '2026-10-16T05:00:00.000Z', attributed_pct: 70, window_days: 14, tasks: {}, top: { w7: [top], today: [] } });
    const put = top => s.call('PUT', '/api/admin/stats', { doc: doc(top) });
    assert.equal((await put(THREE)).status, 200);
    assert.equal((await put(BASE)).status, 200, 'a row from before by_model');
    assert.equal((await put({ ...BASE, by_model: [{ model: 'x', tokens: 1 }] })).body.error, 'invalid_data', 'share is required');
    assert.equal((await put({ ...BASE, by_model: [{ model: 'x', tokens: 1, share: 150 }] })).body.error, 'invalid_data');
    assert.equal((await put({ ...BASE, by_model: [{ model: 'x', tokens: 1, share: 1, extra: 1 }] })).body.error, 'invalid_data');
  } finally { await s.close?.(); }
});
