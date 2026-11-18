// J-05: a refresh (the first load, or the 15 s poll) that lands after Sign out must not restore the board.
// app.js is a browser script, so its real api()/refresh() are lifted and run in a vm over a fetch the test holds
// open (the pattern embed.test.mjs / diagram-full.test.mjs use). On the base revision the late reply wrote S.data
// back, so Sign out silently undid itself and the signed-in board stayed on screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const APP = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'app.js'), 'utf8');

/** A top-level `const name = ...;` line or `function name(...) {...}` block of app.js, verbatim. */
function lift(name) {
  const line = APP.match(new RegExp(`^const ${name} = .*;$`, 'm'));
  if (line) return line[0];
  const at = APP.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `app.js has no ${name}`);
  const start = APP.startsWith('async ', at - 6) ? at - 6 : at; // keep `async` with its function
  return APP.slice(start, APP.indexOf('\n}\n', start) + 2);
}

/** The page's own api() and refresh() over one fetch whose reply the test releases when it wants it to land. */
function page(token) {
  let release;
  const reply = new Promise(r => { release = r; });
  const sandbox = {
    S: { token, data: { seq: 1 }, loadedAt: 1, offline: false, prefs: {}, prefsFrom: '', seenAsks: null },
    store: { get: () => token, set: () => {} },
    fetch: async () => { await reply; return { ok: true, status: 200, json: async () => ({ seq: 2, me: null }) }; },
    render: () => {},
    applyPrefs: () => {},
    adoptServerPrefs: async () => {},
    notifyNewAsks: () => {},
    withAskAges: d => d
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext([lift('authHeaders'), lift('api'), lift('refresh')].join('\n'), ctx);
  return { ctx, land: () => release() };
}

test('Sign out wins over a refresh that was already in flight', async () => {
  // The test's premise: the signout handler forgets the token and the board before it re-renders the sign-in form.
  assert.match(APP, /if \(action === 'signout'\) \{.*S\.token = ''; S\.data = null;.*return render\(\); \}/);
  const { ctx, land } = page('lb_signed_in');
  const inflight = ctx.refresh();
  // Exactly what the data-action="signout" handler does before it renders the sign-in form.
  ctx.S.token = ''; ctx.S.data = null;
  land();
  await inflight;
  assert.equal(ctx.S.data, null, 'the reply was fetched with the old token: Sign out holds');
  assert.equal(ctx.S.token, '', 'and the token stays cleared');
});

test('a fresh sign-in is not overwritten by an older poll', async () => {
  const { ctx, land } = page('lb_old');
  const inflight = ctx.refresh();
  ctx.S.token = 'lb_new'; ctx.S.data = null;
  land();
  await inflight;
  assert.equal(ctx.S.data, null, 'the old token\'s board never lands under the new identity');
});

test('an unchanged token still fills the board', async () => {
  const { ctx, land } = page('lb_signed_in');
  const inflight = ctx.refresh();
  land();
  await inflight;
  assert.equal(ctx.S.data.seq, 2, 'the normal poll keeps working');
  assert.equal(ctx.S.loadedAt > 1, true, 'and its load time is stamped');
});
