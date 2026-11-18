// J-05: with ?embed=1 the page drops the chrome the Zumi desktop host already provides (brand logo + tagline,
// language switch, settings, sign in/out, identity line), and lang-boot.js takes the language from ?lang=.
// app.js and lang-boot.js are browser scripts, so the pieces under test are lifted out and run in a vm.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const APP = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');
const BOOT = fs.readFileSync(path.join(PUB, 'lang-boot.js'), 'utf8');

/** A top-level `const name = ...;` line or `function name(...) {...}` block of app.js, verbatim. */
function lift(name) {
  const line = APP.match(new RegExp(`^const ${name} = .*;$`, 'm'));
  if (line) return line[0];
  const start = APP.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `app.js has no ${name}`);
  return APP.slice(start, APP.indexOf('\n}\n', start) + 2);
}

test('without embed the chrome is rendered; with embed=1 the rail drops it', () => {
  const WHO = '<div class="who"><b>owner</b> · owner</div>';
  const ACCOUNT = '<button class="btn" data-action="signout">Sign out</button>';
  const page = embed => {
    const ctx = vm.createContext({
      S: { open: {}, lang: 'en' },
      t: k => k, esc: s => String(s), sweepButton: () => '<button data-action="sweep"></button>', route: () => ({ view: 'overview' }),
      document: { documentElement: { classList: { contains: c => embed && c === 'embed' } } },
      $: () => ({ classList: { toggle() {} }, setAttribute() {} })
    });
    vm.runInContext(['LANGS', 'LANG_SHORT', 'GEAR', 'isEmbed', 'railShell', 'railFoot'].map(lift).join('\n'), ctx);
    return vm.runInContext(`railShell('BODY', 0)`, ctx)
      + vm.runInContext(`railFoot(${JSON.stringify(WHO)}, ${JSON.stringify(ACCOUNT)})`, ctx);
  };
  const plain = page(false);
  assert.match(plain, /class="brand-mark"/);
  assert.match(plain, /class="brand-sub"/);
  assert.match(plain, /class="lang-switch"/);
  assert.match(plain, /class="who"/);
  assert.match(plain, /data-go="#\/settings"/);
  assert.match(plain, /data-action="signout"/);

  const emb = page(true);
  assert.doesNotMatch(emb, /brand-mark|brand-sub/, 'no logo, no tagline');
  assert.doesNotMatch(emb, /lang-switch/, 'no language switch');
  assert.doesNotMatch(emb, /class="who"/, 'no identity line');
  assert.doesNotMatch(emb, /data-go="#\/settings"/, 'no settings entry');
  assert.doesNotMatch(emb, /data-action="(?:signout|signin)"/, 'no sign in/out button');
  assert.match(emb, /<div class="brand"><button data-action="sweep">/, 'the Cập nhật button stays in the top row (J-05 sweep)');
});

test('lang-boot: ?embed=1 marks <html>, ?lang= picks the language and stores it', () => {
  const boot = (search, stored = {}) => {
    const cl = { _s: new Set(), add(c) { this._s.add(c); }, contains(c) { return this._s.has(c); } };
    const ls = { _s: { ...stored }, getItem(k) { return k in this._s ? this._s[k] : null; }, setItem(k, v) { this._s[k] = String(v); } };
    const ctx = vm.createContext({
      location: { search }, localStorage: ls, window: {},
      document: { documentElement: { lang: '', classList: cl } },
      fetch: () => Promise.resolve({ json: () => Promise.resolve({}) }), URLSearchParams
    });
    vm.runInContext(BOOT, ctx);
    return { lang: ctx.document.documentElement.lang, embed: cl.contains('embed'), stored: ls._s };
  };

  const vi = boot('?lang=vi&embed=1');
  assert.equal(vi.lang, 'vi');
  assert.equal(vi.embed, true);
  assert.equal(vi.stored['laneboard.uiLang'], 'vi', 'like the switcher, the pick is remembered');

  assert.equal(boot('?lang=zh').lang, 'zh-CN');
  assert.equal(boot('', { 'laneboard.uiLang': 'vi' }).lang, 'vi', 'no ?lang=: this browser\'s stored pick');
  assert.equal(boot('?embed=1').embed, true);

  const invalid = boot('?lang=de', { 'laneboard.uiLang': 'vi' });
  assert.equal(invalid.lang, 'vi', 'an unknown language is ignored');
  assert.equal(invalid.stored['laneboard.uiLang'], 'vi', 'and does not overwrite the stored pick');
});
