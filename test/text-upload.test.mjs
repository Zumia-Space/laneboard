// Owner 02-11: "sao có lúc em để link đọc được anh bấm vào là đọc file trên zumi app được luôn, có lúc lại thành đính kèm path".
// A streamed .md upload was type-checked on its first 16 bytes only; a multi-byte Vietnamese character straddling byte 16
// failed the UTF-8 round trip (content_does_not_match_mime) and the file stayed a path chip. Text is now validated on the
// WHOLE stream with a fatal streaming UTF-8 decode, whatever the chunking; NUL bytes and invalid UTF-8 are still refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startSeeded, rid } from './helpers.mjs';

const q = o => new URLSearchParams(o).toString();
async function upload(s, meta, body, { chunk = 0 } = {}) {
  // chunk > 0: a chunked body (no Content-Length) cut into pieces of that many bytes, so a character can span two chunks.
  const payload = chunk ? new ReadableStream({ start(c) { for (let i = 0; i < body.length; i += chunk) c.enqueue(body.subarray(i, i + chunk)); c.close(); } }) : body;
  const res = await fetch(`${s.url}/api/v1/upload?${q({ request_id: rid(), task_id: 'WEB-3', name: 'doc.md', mime: 'text/markdown', ...meta })}`,
    { method: 'POST', headers: { Authorization: `Bearer ${s.coord}`, 'Content-Type': 'application/octet-stream' }, body: payload, ...(chunk ? { duplex: 'half' } : {}) });
  return { status: res.status, body: await res.json() };
}
const CHARS = ['ệ', 'Ặ', 'ư', '—', '😀']; // 3, 3, 2, 3 and 4 bytes
const doc = (offset, ch) => Buffer.from('a'.repeat(offset) + ch + ' tiếp theo của tài liệu\n', 'utf8');

test('markdown with a multi-byte character at every offset 0-32 is accepted (the 16-byte head used to refuse offsets 13-15)', async () => {
  const s = await startSeeded();
  try {
    const refused = [];
    for (const ch of CHARS) for (let off = 0; off <= 32; off++) {
      const r = await upload(s, {}, doc(off, ch));
      if (r.status !== 200) refused.push(`${ch}@${off}:${r.body.error}`);
    }
    assert.deepEqual(refused, [], 'every offset is a valid UTF-8 document');
  } finally { await s.close(); }
});

test('the same holds when the character is split across chunk boundaries (1-, 3- and 7-byte chunks), and for text/plain', async () => {
  const s = await startSeeded();
  try {
    for (const chunk of [1, 3, 7]) for (const off of [13, 14, 15, 16, 17]) {
      const r = await upload(s, {}, doc(off, 'ệ😀'), { chunk });
      assert.equal(r.status, 200, `chunk ${chunk} offset ${off}: ${JSON.stringify(r.body)}`);
    }
    const r = await upload(s, { name: 'doc.txt', mime: 'text/plain' }, doc(14, 'ệ'));
    assert.equal(r.status, 200, JSON.stringify(r.body));
  } finally { await s.close(); }
});

test('invalid UTF-8 and NUL bytes are still refused, wherever they sit and however the body is chunked', async () => {
  const s = await startSeeded();
  try {
    const bad = {
      'lone continuation byte at 0': Buffer.from([0x80, 0x61]),
      'lone lead byte in the head': Buffer.concat([Buffer.from('abc'), Buffer.from([0xe1]), Buffer.from('def')]),
      '0xFF far past byte 16': Buffer.concat([Buffer.from('a'.repeat(500)), Buffer.from([0xff]), Buffer.from('z')]),
      'truncated character at the very end': Buffer.concat([Buffer.from('a'.repeat(40)), Buffer.from([0xe1, 0xbb])]),
      'overlong encoding': Buffer.concat([Buffer.from('ab'), Buffer.from([0xc0, 0xaf])]),
      'encoded surrogate': Buffer.concat([Buffer.from('ab'), Buffer.from([0xed, 0xa0, 0x80])]),
      'NUL in the head': Buffer.from('ab\0cd'),
      'NUL far past byte 16': Buffer.concat([Buffer.from('a'.repeat(300)), Buffer.from([0]), Buffer.from('z')])
    };
    for (const [name, body] of Object.entries(bad)) for (const opts of [{}, { chunk: 1 }, { chunk: 5 }]) for (const meta of [{}, { name: 'x.txt', mime: 'text/plain' }]) {
      const r = await upload(s, meta, body, opts);
      assert.equal(r.status, 400, `${name} (${meta.mime || 'markdown'}, chunk ${opts.chunk || 'whole'}) must be refused`);
      assert.equal(r.body.error, 'content_does_not_match_mime', name);
    }
  } finally { await s.close(); }
});

test('other mimes keep their magic-number check: a PNG-less body is still refused as image/png, a UTF-8 text body as a PDF', async () => {
  const s = await startSeeded();
  try {
    let r = await upload(s, { name: 'a.png', mime: 'image/png' }, Buffer.from('plain text, not a PNG'));
    assert.equal(r.body.error, 'content_does_not_match_mime');
    r = await upload(s, { name: 'a.pdf', mime: 'application/pdf' }, Buffer.from('ệ không phải PDF'));
    assert.equal(r.body.error, 'content_does_not_match_mime');
    r = await upload(s, { name: 'a.pdf', mime: 'application/pdf' }, Buffer.from('%PDF-1.4\nbody'));
    assert.equal(r.status, 200, JSON.stringify(r.body));
  } finally { await s.close(); }
});

test('the base64 attachment.add path (whole buffer) agrees with the streamed one', async () => {
  const s = await startSeeded();
  try {
    for (const off of [13, 14, 15, 16]) {
      const r = await s.write(s.coord, 'attachment.add', 'WEB-3', { name: 'doc.md', mime: 'text/markdown', data_base64: doc(off, 'ệ').toString('base64') });
      assert.equal(r.status, 200, `offset ${off}: ${JSON.stringify(r.body)}`);
    }
    const r = await s.write(s.coord, 'attachment.add', 'WEB-3', { name: 'doc.md', mime: 'text/markdown', data_base64: Buffer.from([0x61, 0xe1, 0xbb]).toString('base64') });
    assert.equal(r.body.error, 'content_does_not_match_mime');
  } finally { await s.close(); }
});
