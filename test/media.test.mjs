// Gap G3 of the live-board migration: audio/video attachments, streamed uploads beyond the base64 cap,
// byte-range reads for playback, and expiring links so <video>/<audio> can stream without a bearer header.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { startSeeded, OWNER, rid } from './helpers.mjs';

const mp4 = n => { const b = crypto.randomBytes(n); b.writeUInt32BE(24, 0); b.write('ftypisom', 4, 'latin1'); return b; };
const mp3 = n => { const b = crypto.randomBytes(n); b.write('ID3', 0, 'latin1'); return b; };
const q = o => new URLSearchParams(o).toString();

async function upload(s, token, meta, body, { stream = false } = {}) {
  const headers = { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/octet-stream' };
  // stream: chunked body without Content-Length, so the cap is enforced while bytes arrive.
  const payload = stream ? new ReadableStream({ start(c) { for (let i = 0; i < body.length; i += 65536) c.enqueue(body.subarray(i, i + 65536)); c.close(); } }) : body;
  const res = await fetch(`${s.url}/api/v1/upload?${q({ request_id: rid(), ...meta })}`, { method: 'POST', headers, body: payload, ...(stream ? { duplex: 'half' } : {}) });
  return { status: res.status, body: await res.json() };
}
const tempFiles = dir => fs.readdirSync(path.join(dir, 'media')).filter(f => f.startsWith('.upload-'));

test('base64 attachment.add accepts small mp3/mp4 and still refuses anything over its cap', async () => {
  const s = await startSeeded();
  try {
    let r = await s.write(s.alpha, 'attachment.add', 'WEB-3', { name: 'clip.mp4', mime: 'video/mp4', data_base64: mp4(4096).toString('base64') });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await s.write(s.alpha, 'attachment.add', 'WEB-3', { name: 'take.mp3', mime: 'audio/mpeg', data_base64: mp3(4096).toString('base64') });
    assert.equal(r.status, 200);
    r = await s.write(s.alpha, 'attachment.add', 'WEB-3', { name: 'fake.mp4', mime: 'video/mp4', data_base64: Buffer.from('not a video at all').toString('base64') });
    assert.equal(r.body.error, 'content_does_not_match_mime');
    r = await s.write(s.coord, 'attachment.add', 'WEB-3', { name: 'big.mp4', mime: 'video/mp4', data_base64: mp4(300 * 1024).toString('base64') });
    assert.equal(r.status, 413, 'base64 path stays bounded at 256 KiB');
  } finally { await s.close(); }
});

test('streamed upload: owner/coordinator only, capped, type-checked, deduplicated, journaled without bytes', async () => {
  const s = await startSeeded({ maxUploadBytes: 1024 * 1024 });
  try {
    const video = mp4(700 * 1024);
    let r = await upload(s, s.alpha, { task_id: 'WEB-3', name: 'demo.mp4', mime: 'video/mp4' }, video);
    assert.equal(r.status, 403, 'reporters use the bounded base64 path');
    r = await upload(s, null, { task_id: 'WEB-3', name: 'demo.mp4', mime: 'video/mp4' }, video);
    assert.equal(r.status, 401);
    r = await upload(s, s.coord, { task_id: 'NOPE-1', name: 'demo.mp4', mime: 'video/mp4' }, video);
    assert.equal(r.status, 404);
    r = await upload(s, s.coord, { task_id: 'WEB-3', name: '../x.mp4', mime: 'video/mp4' }, video);
    assert.equal(r.status, 400); assert.equal(r.body.error, 'invalid_request');
    r = await upload(s, s.coord, { task_id: 'WEB-3', name: 'demo.mp4', mime: 'audio/mpeg' }, video);
    assert.equal(r.status, 400); assert.equal(r.body.error, 'content_does_not_match_mime');
    r = await upload(s, s.coord, { task_id: 'WEB-3', name: 'huge.mp4', mime: 'video/mp4' }, mp4(1536 * 1024));
    assert.equal(r.status, 413, 'Content-Length over the cap is refused up front');
    r = await upload(s, s.coord, { task_id: 'WEB-3', name: 'huge.mp4', mime: 'video/mp4' }, mp4(1536 * 1024), { stream: true });
    assert.equal(r.status, 413, 'chunked body over the cap is cut off while streaming');
    assert.deepEqual(tempFiles(s.dataDir), [], 'no partial upload left behind');

    const meta = { request_id: 'upload-retry-0001', task_id: 'WEB-3', name: 'demo.mp4', mime: 'video/mp4', step_id: 's2', caption: 'Build walkthrough' };
    const send = body => fetch(`${s.url}/api/v1/upload?${q(meta)}`, { method: 'POST', headers: { Authorization: `Bearer ${s.coord}` }, body }).then(async x => ({ status: x.status, body: await x.json() }));
    r = await send(video);
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.match(r.body.id, /^att-\d+$/);
    const again = await send(video);
    assert.equal(again.body.deduped, true); assert.equal(again.body.id, r.body.id);
    assert.equal((await send(mp4(1000))).status, 409, 'same request_id with other bytes');

    const st = await s.state(OWNER);
    const att = st.attachments.find(a => a.id === r.body.id);
    assert.equal(att.size, video.length); assert.equal(att.mime, 'video/mp4'); assert.equal(att.step_id, 's2');
    assert.equal(att.sha256, crypto.createHash('sha256').update(video).digest('hex'));
    assert.ok(fs.readFileSync(path.join(s.dataDir, 'media', att.sha256)).equals(video));
    const journal = fs.readFileSync(path.join(s.dataDir, 'events.ndjson'), 'utf8');
    assert.ok(!journal.includes(video.subarray(16, 64).toString('base64').slice(0, 40)), 'no bytes in the journal');
    assert.equal(JSON.parse(journal.trim().split('\n').at(-1)).op, 'attachment.add');
    assert.equal(st.config.max_upload_bytes, 1024 * 1024);
  } finally { await s.close(); }
});

test('media reads honour Range (206/416) with a token or an expiring link; links are scoped and expire', async () => {
  let clock = Date.parse('2026-09-28T06:00:00.000Z');
  const s = await startSeeded({ now: () => clock });
  try {
    const video = mp4(600 * 1024);
    const up = await upload(s, s.coord, { task_id: 'WEB-3', name: 'demo.mp4', mime: 'video/mp4' }, video);
    const id = up.body.id, auth = { Authorization: `Bearer ${s.alpha}` };

    let res = await fetch(`${s.url}/api/v1/media/${id}`, { headers: auth });
    assert.equal(res.status, 200); assert.equal(res.headers.get('accept-ranges'), 'bytes');
    assert.ok(Buffer.from(await res.arrayBuffer()).equals(video));
    res = await fetch(`${s.url}/api/v1/media/${id}`, { headers: { ...auth, Range: 'bytes=100-199' } });
    assert.equal(res.status, 206); assert.equal(res.headers.get('content-range'), `bytes 100-199/${video.length}`);
    assert.ok(Buffer.from(await res.arrayBuffer()).equals(video.subarray(100, 200)));
    res = await fetch(`${s.url}/api/v1/media/${id}`, { headers: { ...auth, Range: 'bytes=-64' } });
    assert.equal(res.status, 206); assert.ok(Buffer.from(await res.arrayBuffer()).equals(video.subarray(-64)));
    res = await fetch(`${s.url}/api/v1/media/${id}`, { headers: { ...auth, Range: 'bytes=600000-' } });
    assert.equal(res.status, 206); assert.equal(Number(res.headers.get('content-length')), video.length - 600000); await res.arrayBuffer();
    res = await fetch(`${s.url}/api/v1/media/${id}`, { headers: { ...auth, Range: `bytes=${video.length}-` } });
    assert.equal(res.status, 416); assert.equal(res.headers.get('content-range'), `bytes */${video.length}`); await res.arrayBuffer();

    assert.equal((await fetch(`${s.url}/api/v1/media/${id}`)).status, 404, 'no token, no link');
    assert.equal((await s.call(null, 'GET', `/api/v1/media/${id}/link`)).status, 404, 'anonymous readers get no link to internal media');
    const link = (await s.call(s.alpha, 'GET', `/api/v1/media/${id}/link`)).body;
    assert.match(link.url, /^api\/v1\/media\/att-\d+\?exp=\d+&sig=[a-f0-9]{64}$/);
    assert.ok(!link.url.includes(s.alpha), 'the bearer token never appears in a URL');
    res = await fetch(`${s.url}/${link.url}`, { headers: { Range: 'bytes=0-15' } });
    assert.equal(res.status, 206); assert.ok(Buffer.from(await res.arrayBuffer()).equals(video.subarray(0, 16)));
    const other = (await s.write(s.alpha, 'attachment.add', 'WEB-3', { name: 'b.mp4', mime: 'video/mp4', data_base64: mp4(2048).toString('base64') })).body.id;
    assert.equal((await fetch(`${s.url}/${link.url.replace(id, other)}`)).status, 404, 'a link names one attachment');
    assert.equal((await fetch(`${s.url}/${link.url.replace(/sig=(.)/, (m, c) => 'sig=' + (c === '0' ? '1' : '0'))}`)).status, 404, 'tampered link');
    clock += 2 * 3600000;
    assert.equal((await fetch(`${s.url}/${link.url}`)).status, 404, 'expired link');
  } finally { await s.close(); }
});
