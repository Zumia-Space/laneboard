// "Open the original" in the image lightbox (owner report 14-10, ACME-02 ask images). The board's media sit behind the login
// (the site's basic auth in a browser, a bearer token elsewhere), so a bare <a target=_blank> cannot carry the credential:
// the page fetches the original with its own credentials and shows the blob. The Zumi desktop app's Board tab is an Electron
// <webview> whose window-open handler denies every popup, so window.open() gives null there; the old code then did
// `location.href = blobUrl`, which that webview blocks (blob: is not the board origin) and which in a browser would
// replace the whole board. Now: popup if the host allows one, else the original is shown in the lightbox itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const APP = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'app.js'), 'utf8');
const lift = name => {
  const m = new RegExp(`(?:async )?function ${name}\\(`).exec(APP);
  assert.ok(m, `app.js has no ${name}`);
  return APP.slice(m.index, APP.indexOf('\n}\n', m.index) + 2);
};

function harness({ popup, status = 200, token = 'tok' } = {}) {
  const log = { fetched: [], toasts: [], navigated: [], closed: 0, inPage: [], objectUrls: 0, revoked: [] };
  const win = popup ? { location: '', closed: false, close() { log.closed++; } } : null;
  const img = { attrs: { 'data-att': 'att-2372' }, src: '', removeAttribute(k) { delete this.attrs[k]; } };
  const lightbox = { classes: new Set(), classList: { add: c => lightbox.classes.add(c) } };
  const ctx = vm.createContext({
    window: { open: () => win },
    location: { set href(v) { log.navigated.push(v); } },
    document: { querySelector: sel => (sel === '#lightbox .lb-body img' ? img : null), getElementById: id => (id === 'lightbox' ? lightbox : null) },
    fetch: async (url, opts) => { log.fetched.push({ url, headers: opts?.headers }); return { ok: status === 200, status, blob: async () => ({ size: 1 }) }; },
    URL: { createObjectURL: () => `blob:orig-${++log.objectUrls}`, revokeObjectURL: u => log.revoked.push(u) },
    S: { origUrl: '' },
    authHeaders: () => (token ? { Authorization: `Bearer ${token}` } : {}),
    toast: m => log.toasts.push(m),
    t: (k, v) => `${k}:${v?.msg ?? ''}`,
    renderLightbox: undefined
  });
  vm.runInContext([lift('showOriginalInPage'), lift('revokeOriginal'), lift('openOriginal')].join('\n'), ctx);
  return { run: id => vm.runInContext(`openOriginal(${JSON.stringify(id)})`, ctx), revoke: () => vm.runInContext('revokeOriginal()', ctx), log, win, img, lightbox };
}

test('a host that allows popups: the authenticated original opens in the new window', async () => {
  const h = harness({ popup: true });
  await h.run('att-2372');
  assert.deepEqual(h.log.fetched, [{ url: 'api/v1/media/att-2372', headers: { Authorization: 'Bearer tok' } }], 'the original (no ?w copy) is fetched with the page credentials');
  assert.equal(h.win.location, 'blob:orig-1');
  assert.deepEqual(h.log.navigated, []);
});

test('the Zumi Board tab (popups denied, window.open gives null): the original is shown in the lightbox, the page is never navigated', async () => {
  const h = harness({ popup: false });
  await h.run('att-2372');
  assert.deepEqual(h.log.navigated, [], 'location.href = blob: would be blocked by the webview and would replace the board in a browser');
  assert.equal(h.img.src, 'blob:orig-1', 'the lightbox picture is now the full original');
  assert.equal(h.img.attrs['data-att'], undefined, 'loadImages must not swap the reduced copy back in');
  assert.ok(h.lightbox.classes.has('full'));
});

test('a refused fetch closes the blank window and says so', async () => {
  const h = harness({ popup: true, status: 401 });
  await h.run('att-2372');
  assert.equal(h.log.closed, 1);
  assert.deepEqual(h.log.toasts, ['common.error:401']);
});

test('an image without an attachment (predecessor media folder) is fetched with the credentials too, not opened as a bare link', async () => {
  const h = harness({ popup: true });
  await h.run('media/a5c8d65c29e20f02.png');
  assert.deepEqual(h.log.fetched, [{ url: 'media/a5c8d65c29e20f02.png', headers: { Authorization: 'Bearer tok' } }]);
  assert.equal(h.win.location, 'blob:orig-1');
});

test('the lightbox link carries the id for both kinds of image, so the click handler (not the browser) opens it', () => {
  const m = /<a class="lb-orig"[^>]*>/.exec(APP);
  assert.ok(m, 'lightbox original link found');
  assert.match(m[0], /data-orig=/);
  assert.doesNotMatch(m[0], /href="\$\{/, 'no bare href to media/… for legacy images');
  assert.doesNotMatch(m[0], /target="_blank"/, 'no browser navigation: the click handler opens it');
});

test('the original blob is revoked when the lightbox closes or shows another picture, and when a second original replaces it', async () => {
  const h = harness({ popup: false });
  await h.run('att-2372');
  assert.deepEqual(h.log.revoked, [], 'still on screen: kept');
  await h.run('att-2373');
  assert.deepEqual(h.log.revoked, ['blob:orig-1'], 'a second original replaces the first, which is released');
  h.revoke(); h.revoke(); // renderLightbox() calls this on close, next/prev and reopen
  assert.deepEqual(h.log.revoked, ['blob:orig-1', 'blob:orig-2'], 'released once, a second call is a no-op');
});

test('renderLightbox releases the original before it rebuilds the lightbox (close, next, previous)', () => {
  const body = lift('renderLightbox');
  assert.ok(body.startsWith('function renderLightbox() {\n  revokeOriginal();'));
});

test('a refused original keeps nothing', async () => {
  const h = harness({ popup: false, status: 401 });
  await h.run('att-2372');
  assert.equal(h.log.objectUrls, 0);
  assert.deepEqual(h.log.revoked, []);
});
