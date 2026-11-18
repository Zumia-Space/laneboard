// s21 / Sol condition 5: rendered refs ("[label](url) · `D:/path`" as the last line of now/next/an ask) must not multiply
// on every push, and /api/state?v=2 returns the text and its refs apart, per field. Only syntax the renderer writes is touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { s21Board, seedShared, row, step } from './s21-helpers.mjs';

const IMG = '[shot.png](https://board.example/laneboard/media/0123456789abcdef.png)';
const WEB = '[facebook.com › 1001](https://web.facebook.com/groups/1/posts/1001)';
const PATH = '`D:/data/laneboard/acme-03/PLAN.md`';
const LINE = `${IMG} · ${WEB} · ${PATH}`;
const WORKERA = 'Workera CoS';

test('refs: a trailing block of renderer chip lines collapses to one deduped line, in first-seen order', async () => {
  const { normalizeRefs } = await import('../src/refs.mjs');
  assert.equal(normalizeRefs(`Prose here.\n${LINE}\n${LINE}\n${LINE}`), `Prose here.\n${LINE}`);
  assert.equal(normalizeRefs(`Prose\n${IMG}\n${PATH} · ${IMG}\n${WEB}`), `Prose\n${IMG} · ${PATH} · ${WEB}`, 'chips from several lines, duplicates by url/path dropped, first seen kept');
  assert.equal(normalizeRefs(`${LINE}\n${LINE}`), LINE, 'a text that is only refs');
  assert.equal(normalizeRefs(`Prose\n${LINE}\n${LINE}\n\n`), `Prose\n${LINE}`, 'trailing blank lines do not hide the block');
  assert.equal(normalizeRefs(`Prose\n${LINE}\n\n`), `Prose\n${LINE}\n\n`, 'a block that is already one clean line is left byte for byte');
  for (const t of [`Prose\n${LINE}`, 'Prose', '', 'a\n\nb  ', `${LINE} extra`]) assert.equal(normalizeRefs(normalizeRefs(t)), normalizeRefs(t), 'idempotent');
  // A label before the backtick path is part of the same chip.
  const labelled = '[a](https://x.test/a) · Kế hoạch `D:/data/laneboard/plan v2.md`';
  assert.equal(normalizeRefs(`P\n${labelled}\n${labelled}`), `P\n${labelled}`, 'a path with spaces and a label is one chip');
});

test('refs: nothing else is touched (no refs line, a relative or unknown backtick, a legitimate final code line, malformed chips, a chip inside prose)', async () => {
  const { normalizeRefs } = await import('../src/refs.mjs');
  const keep = [
    'run this:\n`npm test`', 'note\n`REVIEW-v6-3c32735.md`\n`REVIEW-v6-3c32735.md`', 'a\n`~/x/y.md`', 'a\n`C:rel\\x.md`', 'a\n`D:/x.md` extra words',
    '[x](ftp://host/f)\n[x](ftp://host/f)', '[broken](https://x.test\n[broken](https://x.test', 'see [a](https://x.test/a) now\nsee [a](https://x.test/a) now', 'plain  \n  with spaces  ',
    `Prose ${LINE}`, `${LINE}\nclosing prose`
  ];
  for (const t of keep) assert.equal(normalizeRefs(t), t, JSON.stringify(t));
});

test('refs: splitRefs gives the clean text and typed refs (media / link / path), deduped, from the same block', async () => {
  const { splitRefs } = await import('../src/refs.mjs');
  const r = splitRefs(`Prose.\nMore.\n${LINE}\n${PATH}`);
  assert.equal(r.text, 'Prose.\nMore.');
  assert.deepEqual(r.refs, [
    { kind: 'media', label: 'shot.png', url: 'https://board.example/laneboard/media/0123456789abcdef.png' },
    { kind: 'link', label: 'facebook.com › 1001', url: 'https://web.facebook.com/groups/1/posts/1001' },
    { kind: 'path', label: 'PLAN.md', url: 'D:/data/laneboard/acme-03/PLAN.md' }]);
  assert.deepEqual(splitRefs('no refs here'), { text: 'no refs here', refs: [], line: '' });
});

test('refs: push(state(x)) x3 on needsAnh, now and next adds no event; a pushed-back refs line is not added again', async () => {
  const s = await s21Board();
  try {
    seedShared(s);
    const f04 = (extra = {}) => row('F-04', WORKERA, [step('s1', 'done'), step('workera-step', 'waiting', 'anh')], { title: 'Trang chủ', order: 1, health: 'yellow', ...extra });
    // First push: the lane sends the text with its refs line once.
    const sent = { now: `Workera now\n${LINE}`, next: `Workera next\n${LINE}`, needsAnh: `Q?\n${LINE}` };
    assert.equal((await s.push([f04(sent)], { lane: WORKERA })).status, 200);
    assert.equal(s.board.state.tasks['F-04'].now, sent.now); assert.equal(s.openAsks('F-04')[0].text, sent.needsAnh);
    const seq = s.board.state.seq;
    // /api/state returns the rendered line; a client that pushes the state back appends nothing new, three times over.
    for (let i = 0; i < 3; i++) {
      const st = await s.code('F-04');
      const echoed = { now: `${st.now}\n${LINE}`, next: `${st.next}\n${LINE}`, needsAnh: `${st.needsAnh}\n${LINE}` };
      const r = await s.push([f04(echoed)], { lane: WORKERA });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }
    assert.equal(s.board.state.seq, seq, 'zero events: the stored text did not change');
    assert.equal(s.board.state.tasks['F-04'].now, sent.now); assert.equal(s.board.state.tasks['F-04'].next, sent.next);
    assert.equal((await s.code('F-04')).now.split(LINE).length, 2, 'the line is there once');
  } finally { await s.close(); }
});

test('refs: text already stored with 14 copies is cleaned by one push and stays clean (the F-04 next field)', async () => {
  const s = await s21Board();
  try {
    seedShared(s);
    const dup = `Workera next\n${Array(14).fill(`${IMG} · ${PATH}`).join('\n')}`;
    s.w('task.update', 'F-04', { next: dup }, { expected_revision: s.board.state.tasks['F-04'].rev });
    const f04 = row('F-04', WORKERA, [step('s1', 'done'), step('workera-step', 'waiting', 'anh')], { title: 'Trang chủ', order: 1, health: 'yellow', now: 'Workera now', next: dup });
    assert.equal((await s.push([f04], { lane: WORKERA })).status, 200);
    assert.equal(s.board.state.tasks['F-04'].next, `Workera next\n${IMG} · ${PATH}`);
    const seq = s.board.state.seq;
    assert.equal((await s.push([f04], { lane: WORKERA })).status, 200);
    assert.equal(s.board.state.seq, seq);
  } finally { await s.close(); }
});

test('refs: /api/state?v=2 returns now, next and every ask as clean text plus refs per field; the unversioned view is untouched', async () => {
  const s = await s21Board();
  try {
    seedShared(s);
    s.w('task.update', 'F-04', { now: `Workera now\n${LINE}`, next: `Workera next\n${PATH}` }, { expected_revision: s.board.state.tasks['F-04'].rev });
    s.w('ask.raise', 'F-04', { text: `Q?\n${IMG}`, step_id: 'workera-step' });
    s.w('ask.raise', 'F-04', { text: 'No refs here', step_id: 'video-ad', lane: 'Workerb' });
    const v2 = await s.code('F-04', 2), v1 = await s.code('F-04');
    assert.equal(v2.now, 'Workera now'); assert.equal(v2.next, 'Workera next');
    assert.deepEqual(v2.refs.now.map(r => r.kind), ['media', 'link', 'path']); assert.deepEqual(v2.refs.next.map(r => r.kind), ['path']);
    assert.deepEqual(v2.asks.map(a => [a.text, a.refs.length]), [['Q?', 1], ['No refs here', 0]]);
    assert.equal(v1.now, `Workera now\n${LINE}`, 'unversioned: as stored'); assert.equal(v1.next, `Workera next\n${PATH}`);
    assert.equal(v1.needsAnh, `Q?\n${IMG}\n\nNo refs here`);
    assert.ok(!('needsAnh' in v2), 'v2 has no joined needsAnh a client could push back');
  } finally { await s.close(); }
});
