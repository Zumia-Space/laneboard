// Per-user display preferences: each token holder writes only its own, fields merge, and they come back
// as me.prefs on the state read (never in anyone else's view, never to anonymous readers).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startSeeded, OWNER } from './helpers.mjs';

test('prefs.set stores the caller\'s own prefs, merges fields, and returns them as me.prefs', async () => {
  const s = await startSeeded();
  try {
    const ownerId = s.board.authenticate(OWNER).token_id;
    assert.deepEqual((await s.state(OWNER)).me.prefs, {}, 'empty before first save');
    assert.equal((await s.write(OWNER, 'prefs.set', ownerId, { lang: 'vi', theme: 'dark', accent: 'violet' })).status, 200);
    assert.equal((await s.write(OWNER, 'prefs.set', ownerId, { font_size: 'larger', accent: 'green' })).status, 200);
    assert.deepEqual((await s.state(OWNER)).me.prefs, { lang: 'vi', theme: 'dark', accent: 'green', font_size: 'larger' });
    assert.deepEqual((await s.state(s.coord)).me.prefs, {}, 'another holder does not see the owner\'s prefs');
    assert.equal((await s.state(null)).me, null, 'anonymous readers get no prefs');
  } finally { await s.close(); }
});

test('prefs.set refuses someone else\'s token id, unknown values and empty bodies', async () => {
  const s = await startSeeded();
  try {
    const ownerId = s.board.authenticate(OWNER).token_id;
    const alphaId = s.board.authenticate(s.alpha).token_id;
    let r = await s.write(s.alpha, 'prefs.set', ownerId, { theme: 'light' });
    assert.equal(r.status, 403); assert.equal(r.body.error, 'own_prefs_only');
    r = await s.write(OWNER, 'prefs.set', alphaId, { theme: 'light' });
    assert.equal(r.status, 403, 'not even the owner writes another holder\'s prefs');
    r = await s.write(s.alpha, 'prefs.set', alphaId, { theme: 'neon' });
    assert.equal(r.status, 400); assert.equal(r.body.error, 'invalid_data');
    r = await s.write(s.alpha, 'prefs.set', alphaId, {});
    assert.equal(r.status, 400);
    r = await s.write(s.alpha, 'prefs.set', alphaId, { density: 'compact' });
    assert.equal(r.status, 200, 'reporters may save their own prefs, outside any task scope');
  } finally { await s.close(); }
});
