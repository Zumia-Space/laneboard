// Every locale has exactly the English key set, keeps every {placeholder}, and every key the UI uses exists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const load = l => JSON.parse(fs.readFileSync(path.join(PUB, 'locales', `${l}.json`), 'utf8'));
const en = load('en');
const keys = o => Object.keys(o).filter(k => k !== '_meta').sort();
const vars = s => (s.match(/\{\w+\}/g) || []).sort().join(',');

for (const lang of ['zh', 'vi']) {
  test(`${lang} locale matches en keys and placeholders, and is flagged for review`, () => {
    const loc = load(lang);
    assert.deepEqual(keys(loc), keys(en));
    for (const k of keys(en)) assert.equal(vars(loc[k]), vars(en[k]), `${lang}:${k}`);
    assert.equal(loc._meta.status, 'needs-review');
  });
}

test('every static t() key used by the UI exists in en.json', () => {
  const src = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');
  const used = [...src.matchAll(/\bt\('([a-z]+\.[A-Za-z.]+)'/g)].map(m => m[1]).filter(k => !k.endsWith('.')); // "x." + variable is a dynamic prefix
  assert.ok(used.length > 40);
  for (const k of used) assert.ok(k in en, `missing key ${k}`);
});

test('the diagram and the Home map read Vietnamese, and the done-step count has a singular', () => {
  const vi = load('vi');
  // every word these two views print comes from the dictionary; a value still equal to English means the owner reads
  // an English label in the middle of a Vietnamese board (J-05)
  for (const k of [...keys(en).filter(k => /^(diagram|zone|state|health)\./.test(k)), 'ctx.tab.diagram']) {
    assert.notEqual(vi[k], en[k], `vi:${k} is still the English string`);
  }
  assert.equal(vi['diagram.view.map'], 'Sơ đồ việc');
  // "1 steps" was on screen twice (the header and each one-step lane): both counts have a singular key
  assert.equal(en['head.steps.one'], '{n} step done');
  assert.equal(en['head.steps.other'], '{n} steps done');
  assert.equal(en['diagram.laneSteps.one'], '{n} step');
  assert.equal(en['diagram.laneSteps.other'], '{n} steps');
  assert.equal(en['diagram.historyCount.one'], '{n} old step');
  for (const l of ['en', 'vi', 'zh']) {
    const loc = load(l);
    for (const pair of ['head.steps', 'diagram.laneSteps', 'diagram.historyCount']) {
      assert.ok(loc[`${pair}.one`] && loc[`${pair}.other`], `${l}: the ${pair} .one / .other pair`);
      assert.ok(!(pair in loc), `${l}: the plural-less ${pair} key is gone`);
    }
  }
});

test('public/app.js parses (a broken script would only show up in a browser)', () => {
  assert.doesNotThrow(() => new vm.Script(fs.readFileSync(path.join(PUB, 'app.js'), 'utf8'), { filename: 'app.js' }));
});
