// Every UI string the page can show exists in en, vi and zh: static t('key') calls, every dynamic family
// t('prefix.' + value) with the values it can take, and no visible text hard-coded in a template.
// Task content (titles, asks, messages) is data, not UI, and is never translated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OPS } from '../src/ops.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..'), PUB = path.join(ROOT, 'public');
const APP = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');
const LOC = Object.fromEntries(['en', 'vi', 'zh'].map(l => [l, JSON.parse(fs.readFileSync(path.join(PUB, 'locales', `${l}.json`), 'utf8'))]));
const schema = f => JSON.parse(fs.readFileSync(path.join(ROOT, 'schema', 'v1', f), 'utf8'));
const jsArray = src => JSON.parse(src.replace(/'/g, '"'));
const constArray = name => jsArray(APP.match(new RegExp(`const ${name} = (\\[[^\\]]*\\]);`))[1]);
const constKeys = name => [...APP.match(new RegExp(`const ${name} = \\{([^}]*)\\}`))[1].matchAll(/(\w+):/g)].map(m => m[1]);
const rulesSrc = fs.readFileSync(path.join(ROOT, 'src', 'rules.mjs'), 'utf8');
const CHOICES = Object.fromEntries([...APP.match(/const CHOICES = \{(.*)\};/)[1].matchAll(/(\w+): (\[[^\]]*\])/g)].map(m => [m[1], jsArray(m[2])]));

// The values each dynamic family can take. A new t('x.' + …) in app.js fails this test until it is listed here.
const FAMILIES = {
  'status.': constArray('TASK_STATUS'),
  'state.': constArray('STEP_STATES'),
  'health.': ['green', 'yellow', 'red', 'grey'],
  'zone.': schema('common.json').$defs.zone.enum,
  'reader.w.': ['m', 'w', 'f'],
  'role.': ['owner', 'coordinator', 'reporter', 'anonymous'],
  'op.': Object.keys(OPS),
  'rule.': [...new Set([...rulesSrc.matchAll(/error: '([a-z_]+)'/g)].map(m => m[1]))],
  'verdict.': ['on-track', 'adjust', 'pivot', 'drifting', 'wrong-goal', 'unavailable'],
  'verdict.chip.': ['on-track', 'adjust', 'pivot', 'unavailable'],
  'feedback.kind.': [...schema('ops/feedback.add.json').properties.kind.enum, 'report'],
  'compose.kind.': constArray('OWNER_KINDS'),
  'left.state.': constKeys('STATE_TONE'),
  'ctx.tab.': ['steps', 'diagram', 'goal', 'plans', 'files', 'worker', 'stats'],
  'diagram.view.': ['map', 'list'],
  'rebrief.mode.': ['strategy', 'qc', 'status'],
  'inbox.kind.': ['ask', 'report'],
  'inbox.action.': ['accept', 'dismiss'],
  'settings.section.': constArray('SECTIONS'),
  'settings.perm.': ['granted', 'denied', 'default', 'unsupported'],
  'settings.deliveryOpt.': ['watch', 'webhook'],
  'worker.by.': ['owner', 'coordinator', 'auto'],
  'worker.role.': ['plan', 'code', 'review', 'scout'],
  'goal.': ['goal', 'output', 'outcome'],
  'quota.status.': ['live', 'high', 'stale', 'passed', 'offline', 'never', 'unverified'],
  'pref.accent.': CHOICES.accent
};

function usedKeys() {
  const keys = new Set([...APP.matchAll(/\bt\('([a-zA-Z]+\.[A-Za-z0-9.-]+)'/g)].map(m => m[1]).filter(k => !k.endsWith('.')));
  const prefixes = new Set([...APP.matchAll(/\bt\('([a-zA-Z.]+\.)' *\+/g)].map(m => m[1]));
  for (const p of prefixes) {
    assert.ok(FAMILIES[p], `t('${p}' + …) is a dynamic key family the coverage test does not know: list its values in FAMILIES`);
    for (const v of FAMILIES[p]) keys.add(p + v);
  }
  // template-literal keys: t(`attention.kind.${w.kind}`) and t(`pref.${key}.${v}`)
  const templates = [...APP.matchAll(/\bt\(`([^`]*)`/g)].map(m => m[1]).filter(x => /^[a-z]+\./.test(x));
  assert.deepEqual(templates.sort(), ['attention.kind.${w.kind}', 'pref.${key}.${v}'], 'a new template key needs its values here');
  for (const v of ['ask', 'proposal', 'step', 'unreceived']) keys.add('attention.kind.' + v);
  for (const [k, vs] of Object.entries(CHOICES)) for (const v of vs) keys.add(`pref.${k}.${v}`);
  return [...keys];
}

test('every UI string key the page uses has an en, a vi and a zh entry', () => {
  const keys = usedKeys();
  assert.ok(keys.length > 300, `scanned ${keys.length} keys`);
  const missing = [];
  for (const k of keys) for (const [lang, loc] of Object.entries(LOC)) if (typeof loc[k] !== 'string' || !loc[k].trim()) missing.push(`${lang}:${k}`);
  assert.deepEqual(missing, []);
});

test('no visible text is hard-coded in the page templates (product names and code excepted)', () => {
  const ALLOWED = new Set(['Laneboard', 'schema/v1/index.json', 'Apache-2.0', 'board watch']);
  const text = [...APP.matchAll(/<\/?[a-z][a-z0-9]*(?:\s[^<>]*)?>([^<>`${}]*[A-Za-zÀ-ỹ一-龥]{2,}[^<>`${}]*)<\/?[a-z]/g)].map(m => m[1].trim()).filter(x => x && !ALLOWED.has(x));
  assert.deepEqual(text, []);
  const attrs = [...APP.matchAll(/\b(?:placeholder|title|aria-label|alt)="([^"$]*[A-Za-zÀ-ỹ]{2,}[^"]*)"/g)].map(m => m[1]).filter(x => !/^https?:/.test(x) && x !== 'Laneboard'); // the brand name stays as is
  assert.deepEqual(attrs, [], 'attributes people read go through t()');
  const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8').replace(/<title>[^<]*<\/title>/, '');
  assert.deepEqual([...html.matchAll(/>([^<>]*[A-Za-z]{2,}[^<>]*)</g)].map(m => m[1].trim()).filter(Boolean), [], 'index.html shows no text of its own (Loading… comes from the CSS by <html lang>)');
  assert.doesNotMatch(html, /aria-label="[A-Za-z]/);
});

test("the language is set before the first paint and is this browser's own pick", () => {
  const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  assert.ok(html.indexOf('<script src="lang-boot.js"></script>') > 0 && html.indexOf('<script src="lang-boot.js"></script>') < html.indexOf('</head>'), 'a blocking script in <head>');
  const boot = fs.readFileSync(path.join(PUB, 'lang-boot.js'), 'utf8');
  assert.match(boot, /try \{ pick = localStorage\.getItem\('laneboard\.uiLang'\)/);
  assert.match(boot, /document\.documentElement\.lang = /);
  assert.match(APP, /const chosen = store\.get\('uiLang'\);\n  return LANGS\[chosen\] \? chosen : 'en';/, 'no pick: English');
  assert.match(APP, /if \(key === 'lang'\) \{[^\n]*store\.set\('uiLang', value\)[^\n]*return render\(\); \}/, 'the switcher never writes to the server');
  assert.match(APP, /data-action="ui-lang"/);
});
