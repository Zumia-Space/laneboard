// Images pasted or dropped into the composer: uploaded with purpose=message (png/jpeg/webp/gif, magic bytes checked,
// at most 5 MiB, stored by content hash, served only behind the board's auth), then linked to the message with
// feedback.add attachments; the message, the compat state and cos-board `open` carry their URLs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startSeeded, OWNER } from './helpers.mjs';
import { demoPng } from '../scripts/seed.mjs';

const upload = (s, token, { name = 'shot.png', mime = 'image/png', purpose = 'message', task = 'WEB-3', id = 'paste-' + Math.random().toString(36).slice(2, 10) } = {}, body = demoPng(8, 8)) =>
  fetch(`${s.url}/api/v1/upload?request_id=${id}&task_id=${task}&name=${name}&mime=${encodeURIComponent(mime)}${purpose ? '&purpose=' + purpose : ''}`,
    { method: 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': mime }, body });

test('message image upload: an image is accepted; a wrong type, wrong bytes, an oversize file or no token are refused', async () => {
  const s = await startSeeded();
  try {
    const ok = await upload(s, OWNER);
    assert.equal(ok.status, 200);
    const att = s.board.state.attachments[(await ok.json()).id];
    assert.deepEqual([att.mime, att.task_id, /^[0-9a-f]{64}$/.test(att.sha256)], ['image/png', 'WEB-3', true]);
    assert.ok(fs.existsSync(path.join(s.dataDir, 'media', att.sha256)), 'stored under the data dir by content hash');
    const status = async r => [r.status, (await r.json()).error];
    assert.deepEqual(await status(await upload(s, OWNER, { name: 'a.txt', mime: 'text/plain' }, 'hello')), [400, 'image_type_not_allowed']);
    assert.deepEqual(await status(await upload(s, OWNER, { mime: 'image/jpeg' })), [400, 'content_does_not_match_mime']);
    const big = Buffer.concat([demoPng(8, 8), Buffer.alloc(5 * 1024 * 1024)]);
    assert.deepEqual(await status(await upload(s, OWNER, {}, big)), [413, 'image_too_large']);
    assert.deepEqual(await status(await upload(s, '')), [401, 'unauthorized']);
    assert.deepEqual(await status(await upload(s, s.alpha)), [403, 'forbidden_for_role']);
    // the same file served behind auth only: owner and coordinator yes, nobody without a token
    assert.equal((await fetch(`${s.url}/api/v1/media/${att.id}`, { headers: { Authorization: `Bearer ${s.coord}` } })).status, 200);
    assert.notEqual((await fetch(`${s.url}/api/v1/media/${att.id}`)).status, 200);
  } finally { await s.close(); }
});

test('the images are linked to the message: messages[].attachments, the compat feedback row, other tasks and non-images refused', async () => {
  const s = await startSeeded();
  try {
    const a1 = (await (await upload(s, OWNER)).json()).id, a2 = (await (await upload(s, OWNER, { name: 'b.png' })).json()).id;
    const other = (await (await upload(s, OWNER, { task: 'API-2' })).json()).id;
    const pdf = (await (await fetch(`${s.url}/api/v1/upload?request_id=pdf-${Date.now()}&task_id=WEB-3&name=x.pdf&mime=application/pdf`, { method: 'POST', headers: { Authorization: `Bearer ${OWNER}` }, body: '%PDF-1.4 x' })).json()).id;
    const r = await s.write(OWNER, 'feedback.add', 'WEB-3', { kind: 'note', text: 'see the screenshot', attachments: [a1, a2] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const st = await s.state(OWNER);
    const m = st.messages.find(x => x.id === r.body.id);
    assert.deepEqual(m.attachments.map(x => [x.id, x.mime, x.url]), [[a1, 'image/png', `api/v1/media/${a1}`], [a2, 'image/png', `api/v1/media/${a2}`]]);
    assert.equal((await s.write(OWNER, 'feedback.add', 'WEB-3', { kind: 'note', text: 'x', attachments: [other] })).body.error, 'attachment_not_found');
    assert.equal((await s.write(OWNER, 'feedback.add', 'WEB-3', { kind: 'note', text: 'x', attachments: [pdf] })).body.error, 'attachment_not_image');
  } finally { await s.close(); }
});
