// A phone photo (always over 2 MB) is re-encoded in the browser before upload. Safari answers canvas.toBlob('image/webp')
// with a PNG; the page used to label it image/webp, the server refused it (content_does_not_match_mime) and the reply
// never went out (owner 27-10). The mime must be the blob's real type, with JPEG as the fallback encoder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../public/image-shrink.js';
const { shrink, SHRINK_OVER } = globalThis.LaneImage;

const photo = { size: 6 * 1024 * 1024, type: 'image/jpeg' };
const bmp = { width: 4000, height: 3000 };
// A fake encoder: `supports` = types it can really produce; any other request comes back as PNG (Safari); size per type.
const io = (supports, sizes = {}) => ({ calls: [], bitmap: async () => bmp, encode(b, w, h, type) { this.calls.push(type); const real = supports.includes(type) ? type : 'image/png'; return { type: real, size: sizes[real] ?? 1024 * 1024 }; } });

test('a photo under 2 MB goes up untouched', async () => {
  const f = { size: SHRINK_OVER, type: 'image/jpeg' };
  assert.deepEqual(await shrink(f, io(['image/webp'])), { blob: f, mime: 'image/jpeg' });
});
test('a browser that encodes WebP: WebP is uploaded as WebP', async () => {
  const e = io(['image/webp', 'image/jpeg']);
  const out = await shrink(photo, e);
  assert.equal(out.mime, 'image/webp'); assert.equal(out.blob.type, 'image/webp'); assert.deepEqual(e.calls, ['image/webp']);
});
test('Safari (no WebP encoder, hands back PNG): falls back to JPEG and labels it image/jpeg, never image/webp', async () => {
  const e = io(['image/jpeg'], { 'image/png': 9 * 1024 * 1024 });
  const out = await shrink(photo, e);
  assert.equal(out.mime, 'image/jpeg'); assert.equal(out.blob.type, 'image/jpeg');
});
test('nothing fits under 5 MiB: null, not a mislabelled blob', async () => {
  assert.equal(await shrink(photo, io(['image/webp', 'image/jpeg'], { 'image/webp': 9e6, 'image/jpeg': 9e6 })), null);
});
