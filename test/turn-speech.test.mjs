// quick.speech is built by whitelist (only whole words made of letters), so no id, code, number, path or link reaches the voice.
// And a duplicate report is answered from memory, not by parsing the journal inside the write.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startSeeded, OWNER } from './helpers.mjs';

const NASTY = [
  ['Deploy 4f66d1d lên prod và Duyệt PR 1234 cho J05', 'Deploy lên prod và Duyệt cho'],
  ['Xem file D:/data/laneboard/x/report.md, Gate s21 và OK? và', 'Xem file Gate'],
  ['ACME-02 ask-2402 https://x.test/a?b=1 deadbeef cafebabe', ''],
  ['Chọn ghế (A) hay [B] **ngay**', 'Chọn ghế hay ngay'],
  ['Khóa worker cho J05, T31, s21, v2.1.3 và 12:30', 'Khóa worker cho'],
  ['选择座位 and 1 2 3', '选择座位 and'],
  ['một hai ba bốn năm sáu bảy tám chín mười', 'một hai ba bốn năm sáu']
];
const words = s => s.split(/\s+/).filter(Boolean);

test('speech: labels and counts only; nasty step labels and lane names never reach the voice', async () => {
  const s = await startSeeded();
  try {
    for (const [i, [label, spoken]] of NASTY.entries()) {
      const lane = `Lane${'x'.repeat(i)}`; // letters only, one lane per case
      assert.equal((await s.write(s.coord, 'task.create', `N-${i}`, { title: 't', lane, steps: [{ id: 's1', label, zone: 'owner', state: 'waiting' }] })).status, 200);
      assert.equal((await s.write(s.coord, 'ask.raise', `N-${i}`, { text: 'raw ask text 4f66d1d J05', step_id: 's1' })).status, 200);
      const sp = (await s.write(OWNER, 'turn.report', lane, { turn_id: `n-${i}`, detail: 'x' })).body.quick.speech;
      assert.equal(sp, spoken ? `${lane} vừa xong một lượt. Có 1 việc chờ anh: ${spoken}.` : `${lane} vừa xong một lượt. Có 1 việc chờ anh.`, label);
      assert.ok(words(sp).length <= 25, sp);
      assert.doesNotMatch(sp, /raw ask text/, 'the raw ask text is never spoken');
      assert.doesNotMatch(sp.replace(/Có 1 việc chờ anh:?/, ''), /\d|[/\\:@#]|\bask\b|\bhttps?\b/, sp);
    }
    // a lane named like a code is not spoken letter by letter
    for (const [lane, spoken] of [['ACME-02', 'Agent'], ['J05', 'Agent'], ['PR', 'Agent'], ['Workera CoS', 'Workera CoS'], ['Workerb 2', 'Workerb']]) {
      await s.write(s.coord, 'task.create', `L-${lane.length}${lane.charCodeAt(0)}`, { title: 't', lane });
      const r = await s.write(OWNER, 'turn.report', lane, { turn_id: 'lane-1', detail: 'x' });
      assert.equal(r.body.quick.speech, `${spoken} vừa xong một lượt.`, lane);
      assert.match(r.body.quick.line, new RegExp(`^${lane.replace(/[-]/g, '[-]')} xong 1 lượt`), 'the written line keeps the real lane name');
    }
  } finally { await s.close(); }
});

test('speech: more than two asks and a long lane stay within 25 words, counts written by the server', async () => {
  const s = await startSeeded();
  try {
    const lane = 'Một hai ba bốn năm sáu bảy tám chín mười';
    for (let i = 1; i <= 5; i++) {
      await s.write(s.coord, 'task.create', `M-${i}`, { title: 't', lane, steps: [{ id: 's1', label: `việc số ${'dài '.repeat(10)}${i}`, zone: 'owner', state: 'waiting' }] });
      await s.write(s.coord, 'ask.raise', `M-${i}`, { text: 'x', step_id: 's1' });
    }
    const sp = (await s.write(OWNER, 'turn.report', lane, { turn_id: 'm-1', detail: 'x' })).body.quick.speech;
    assert.ok(words(sp).length <= 25, sp);
    assert.match(sp, /^Một hai ba bốn vừa xong một lượt\. Có 5 việc chờ anh: /);
    assert.match(sp, /và 4 việc nữa\.$/, 'a label is dropped to fit 25 words, never the count');
  } finally { await s.close(); }
});

test('duplicate: answered from the in-memory history; the journal is read only once the original is past the last 50', async () => {
  const s = await startSeeded();
  const real = fs.readFileSync;
  let journalReads = 0;
  fs.readFileSync = function (f, ...rest) { if (String(f).endsWith('events.ndjson')) journalReads++; return real.call(this, f, ...rest); };
  try {
    const first = await s.write(OWNER, 'turn.report', 'lane-alpha', { turn_id: 'recent', detail: 'x' });
    const dup = await s.write(OWNER, 'turn.report', 'lane-alpha', { turn_id: 'recent', detail: 'x' });
    assert.equal(dup.status, 409);
    assert.deepEqual(dup.body.quick, first.body.quick);
    assert.equal(journalReads, 0, 'a recent duplicate does not touch the journal');
    for (let i = 0; i < 50; i++) await s.write(OWNER, 'turn.report', 'lane-alpha', { turn_id: `f-${i}`, detail: 'x' });
    journalReads = 0;
    const old = await s.write(OWNER, 'turn.report', 'lane-alpha', { turn_id: 'recent', detail: 'x' });
    assert.equal(old.status, 409);
    assert.deepEqual(old.body.quick, first.body.quick);
    assert.equal(journalReads, 1, 'past the 50 kept: one journal read, the rare case');
  } finally { fs.readFileSync = real; await s.close(); }
});
