// J-05 open asks as one card each (owner 10-23: "bấm vào nội dung bên phải … nó cứ loạn hết lên nên anh ko có đủ
// thông tin để feedback"). Before this, the task panel drew every open ask's images and links in ONE merged row and the
// questions themselves only as clamped stream entries: with 8 asks on V-03 the owner saw 8 file chips, duplicate PLAN
// links, and never one question in full.
//
// The page functions are lifted out of public/app.js and run in a vm with the real locale files, as ui-labels and
// needs-group do. refsHtml is stubbed to record what each card hands it, so "only this ask's own files" is asserted at
// the seam, not by counting chips. The refs splitter is the real one (public/markdown.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import '../public/markdown.js';
import '../public/reading.js';
import '../public/measure.js';

const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const APP = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');
const LOC = Object.fromEntries(['en', 'vi', 'zh'].map(l => [l, JSON.parse(fs.readFileSync(path.join(PUB, 'locales', `${l}.json`), 'utf8'))]));
const MD = globalThis.LaneMarkdown, LR = globalThis.LaneReading, LM = globalThis.LaneMeasure;

const H = 3600000, NOW = Date.parse('2026-10-23T12:00:00.000Z');
const iso = ms => new Date(ms).toISOString();
const at = h => iso(NOW - h * H); // h hours ago

/** A top-level `const name = ...;` line or `function name(...) {...}` block of app.js, verbatim (async kept). */
function lift(name) {
  const line = APP.match(new RegExp(`^const ${name} = .*;$`, 'm'));
  if (line) return line[0];
  const start = APP.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `app.js has no ${name}`);
  const isAsync = APP.slice(Math.max(0, start - 6), start) === 'async ';
  return (isAsync ? 'async ' : '') + APP.slice(start, APP.indexOf('\n}\n', start) + 2);
}

const STEP_DETAIL = 'Đã dựng xong bản so sánh.\n\n## Tóm tắt\n- Giọng khớp 0,978 · SummaryMarker\n- Đo trên 3 clip\n\n## Chi tiết\nDetailMarker: phần dài không thuộc tóm tắt.';
const LINKS = '`D:/data/laneboard/acme-04/studio-mcp/PLAN.md` · `D:/data/laneboard/acme-04/compare/A.png`';

/** Two tasks: V-03 holds the asks under test, X-9 one of its own that must never leak into V-03's cards. */
const TASKS = [
  { id: 'V-03', title: 'Studio video', now: 'Đang chờ anh chốt.', steps: [
    { id: 'V-03/p1', label: 'P1: bản dựng cho nhân viên', state: 'waiting', zone: 'owner', detail: STEP_DETAIL },
    { id: 'V-03/fal', label: 'Fal parity tests', state: 'active', zone: 'build', detail: '' },
    { id: 'V-03/bare', label: 'Bước không có tóm tắt', state: 'done', zone: 'build', detail: '' }] },
  { id: 'X-9', title: 'Khác', steps: [{ id: 'X-9/s1', label: 'S1', state: 'open', zone: 'plan', detail: '' }] }
];
/** size on p1, quota on fal (with options), one on a step with no summary, one older than a week, closed ones, another task. */
const ASKS = [
  { id: 'ask-1', task_id: 'V-03', status: 'open', rev: 4, step_id: 'p1', attribution: { created_at: at(5) }, text: 'Bản dựng đã xong, anh xem giúp em hai bản so sánh.\nDòng hai của câu hỏi không được lộ ra khi thu gọn.\n' + LINKS },
  { id: 'ask-2', task_id: 'V-03', status: 'open', rev: 7, step_id: 'fal', attribution: { created_at: at(2) }, options: [{ key: 'A', label: 'Tắt trần' }, { key: 'B', label: 'Trần $20/ngày' }], text: 'Chọn mức trần tiền mỗi ngày cho Veo.' },
  { id: 'ask-3', task_id: 'V-03', status: 'open', rev: 1, step_id: 'bare', attribution: { created_at: at(30) }, text: 'Câu hỏi trên bước không có tóm tắt.' },
  { id: 'ask-4', task_id: 'V-03', status: 'open', rev: 2, attribution: { created_at: at(9 * 24) }, text: 'Câu hỏi cũ hơn bảy ngày.' },
  { id: 'ask-5', task_id: 'V-03', status: 'cleared', rev: 3, attribution: { created_at: at(6) }, cleared: { at: at(1) }, text: 'Đã rút lại.' },
  { id: 'ask-6', task_id: 'X-9', status: 'open', rev: 1, attribution: { created_at: at(1) }, text: 'Câu hỏi của task khác.' },
  { id: 'ask-7', task_id: 'V-03', status: 'answered', rev: 1, attribution: { created_at: at(8) }, answer: { at: at(1) }, text: 'Đã trả lời rồi.' }
];
const dataOf = (asks = ASKS, now = NOW) => ({ now: iso(now), me: { role: 'owner' }, tasks: TASKS, asks, messages: [], times: {}, attachments: [] });

const escHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** The page's functions in a vm; `refs` collects what each card handed to refsHtml, `md`/`read` what it rendered. */
function page({ askOpen = '', data = null, open = {} } = {}) {
  const refs = [], read = [], md = [];
  const S = {
    dict: LOC.en, en: LOC.en, askOpen, open, galleryNavs: {}, drafts: {}, compose: {}, composeFiles: {},
    data: data || dataOf(), loadedAt: Date.now()
  };
  const sandbox = {
    S, esc: escHtml, MD, LR, LM, isOwner: () => true, refs, read, md, store: { get: () => '', set: () => {} },
    refsHtml: (taskId, r, nav) => { refs.push({ taskId, nav, links: r.links.map(l => l.url), images: r.images.map(i => i.name) }); return `<div class="refs" data-nav="${nav}"></div>`; },
    mdHtml: (text, taskId) => { md.push({ text, taskId }); return `<div class="mdt">${escHtml(text)}</div>`; },
    mdRead: (text, key, taskId, cls, r) => { read.push({ text, key, taskId, cls, read: r }); return `<div class="mdr">${escHtml(text)}</div>`; }
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(['esc', 't', 'fmtDur', 'serverNow', 'asksOf', 'msgsOf', 'askSinceOf', 'refsOf', 'refsKey', 'uniqBy', 'waitTone', 'ASK_OLD_MS', 'askCard', 'askCardBody', 'askCards'].map(lift).join('\n'), ctx);
  return { ctx, S, refs, read, md, askCards: () => vm.runInContext('askCards(S.data.tasks.find(x => x.id === "V-03"))', ctx) };
}
const cardsOf = html => [...html.matchAll(/<article class="ask-card\b[^"]*" id="askcard-([^"]+)"/g)].map(m => m[1]);
/** The whole <article> of one card, from its opening tag. */
const cardHtml = (html, id) => {
  const at = html.indexOf(`id="askcard-${id}"`);
  assert.ok(at > 0, `no card ${id}`);
  return html.slice(html.lastIndexOf('<article', at), html.indexOf('</article>', at));
};
const isOpen = card => /<article class="ask-card open"/.test(card);

test('one card per open ask of the task, newest first: withdrawn, answered and other tasks are not cards', () => {
  const html = page().askCards();
  // ask-4 waits 9 days, so it is a card too — inside the "Older" fold (asserted on its own below).
  assert.deepEqual(cardsOf(html), ['ask-2', 'ask-1', 'ask-3', 'ask-4'], 'newest wait first; ask-5 cleared, ask-7 answered, ask-6 on X-9');
  assert.equal((html.match(/data-ask-card="/g) || []).length, 4, 'exactly one card element per open ask');
  assert.doesNotMatch(html, /ask-6|ask-5|ask-7/, 'another task’s ask and the closed ones never render here');
});

test('a closed card is one line: the question’s first line and its wait, no body at all', () => {
  const p = page(), html = p.askCards(), card = cardHtml(html, 'ask-1');
  assert.equal(isOpen(card), false);
  assert.match(card, /<span class="ac-title">Bản dựng đã xong, anh xem giúp em hai bản so sánh\.<\/span>/, 'the first line is the title');
  assert.doesNotMatch(card, /Dòng hai của câu hỏi/, 'the rest of the question stays out of the collapsed card');
  assert.match(card, /<span class="need-age ">5 h<\/span>/, 'the wait, by the board’s one age rule');
  assert.match(card, /aria-expanded="false"/);
  assert.doesNotMatch(card, /class="ask-card-body"/, 'a closed card renders no body (nothing to read, nothing to tab through)');
  assert.equal((html.match(/ask-card-body/g) || []).length, 0);
  assert.equal(p.read.length + p.md.length + p.refs.length, 0, 'and nothing is rendered for it: no markdown, no refs, no summary');
});

test('the open card carries the whole question, its own files once each, the step’s summary and the answer', () => {
  const p = page({ askOpen: 'ask-1' });
  const card = cardHtml(p.askCards(), 'ask-1');
  assert.equal(isOpen(card), true);
  assert.match(card, /aria-expanded="true"/);
  assert.match(card, /aria-controls="askcard-body-ask-1"/);
  assert.match(card, /id="askcard-body-ask-1"/, 'the head controls the body it names');
  // The full question: both the first and the last line of it, with the refs line split off into chips.
  assert.match(card, /Dòng hai của câu hỏi không được lộ ra khi thu gọn\./);
  assert.doesNotMatch(card, /PLAN\.md`/, 'the refs line is not repeated inside the text');
  assert.equal(p.md.length, 1, 'one text block: this card’s');
  assert.match(p.md[0].text, /Bản dựng đã xong[\s\S]*Dòng hai của câu hỏi/, 'the whole question, in one block, unclamped');
  // Only this ask’s own refs.
  assert.equal(p.refs.length, 1, 'only the open card renders refs (one card open at a time)');
  assert.equal(p.refs[0].nav, 'ac-ask-1', 'its own lightbox/player namespace');
  assert.deepEqual(p.refs[0].links, ['D:/data/laneboard/acme-04/studio-mcp/PLAN.md', 'D:/data/laneboard/acme-04/compare/A.png']);
  assert.deepEqual(p.refs[0].images, []);
  // The linked step’s Tóm tắt, not the long detail.
  assert.equal(p.read.length, 1);
  assert.match(p.read[0].text, /SummaryMarker/);
  assert.doesNotMatch(p.read[0].text, /DetailMarker/, 'the card shows the summary; the reader has the rest');
  assert.equal(p.read[0].read.kind, 'step');
  assert.equal(p.read[0].read.step, 'V-03/p1');
  assert.match(card, /Step 1: P1: bản dựng cho nhân viên/, 'the step it belongs to is named and linked');
  assert.match(card, /data-action="step-link" data-task="V-03" data-step="p1"/);
  // A question without options is approved or rejected here, and answered here.
  assert.match(card, /data-action="answer" data-kind="ask" data-id="ask-1" data-rev="4" data-task="V-03" data-verdict="approve"/);
  assert.match(card, /data-verdict="reject"/);
  assert.match(card, /data-action="reply-ask" data-task="V-03" data-ask="ask-1"/);
});

test('an ask that names one path twice shows it once; an ask with options answers by option', () => {
  const PLAN = 'D:/data/laneboard/acme-04/studio-mcp/PLAN.md';
  const twice = page({ askOpen: 'ask-8', data: dataOf([{ id: 'ask-8', task_id: 'V-03', status: 'open', rev: 1, step_id: 'p1', attribution: { created_at: at(3) },
    text: 'Kế hoạch: `' + PLAN + '`\n`' + PLAN + '` · `' + PLAN + '`' }]) });
  const html = twice.askCards();
  assert.equal(twice.refs.length, 1);
  assert.deepEqual(twice.refs[0].links, [PLAN], 'the same file, named three times, is one chip');
  assert.match(html, /Kế hoạch:/, 'and the sentence that names it is still the question’s text');
  // Options replace approve / not yet, and carry that ask’s own revision.
  const p2 = page({ askOpen: 'ask-2' });
  const card = cardHtml(p2.askCards(), 'ask-2');
  assert.match(card, /data-choice="A"/);
  assert.match(card, /data-choice="B"/);
  assert.doesNotMatch(card, /data-verdict=/);
  assert.match(card, /data-rev="7"/, 'the revision of that ask, so a stale answer is refused');
});

test('an ask on a step with no summary shows no summary block', () => {
  const p = page({ askOpen: 'ask-3' });
  const card = cardHtml(p.askCards(), 'ask-3');
  assert.equal(p.read.length, 0, 'the step carries no detail: no empty summary block');
  assert.doesNotMatch(card, /class="mdr"/, 'nothing pretends to be a summary');
  assert.match(card, /data-action="step-link"/, 'the step stays reachable');
});

test('one card open at a time, and the open one survives the 15 s poll repaint', () => {
  const p = page({ askOpen: 'ask-1' });
  assert.equal(cardsOf(p.askCards()).filter(id => isOpen(cardHtml(p.askCards(), id))).length, 1);
  // refresh() swaps S.data for a fresh object: the expanded card must not fold back.
  p.S.data = dataOf(structuredClone(ASKS), NOW + 15000);
  const after = p.askCards();
  assert.equal(isOpen(cardHtml(after, 'ask-1')), true, 'still open after the poll');
  assert.equal(isOpen(cardHtml(after, 'ask-2')), false);
  // Opening another one closes the first (the handler swaps the id).
  p.S.askOpen = 'ask-2';
  const next = p.askCards();
  assert.equal(isOpen(cardHtml(next, 'ask-1')), false);
  assert.equal(isOpen(cardHtml(next, 'ask-2')), true);
  assert.equal(next.match(/ask-card open/g).length, 1, 'never two open cards');
});

test('asks waiting over a week fold under "Older (N)", collapsed; the fresh ones stay on top', () => {
  const html = page().askCards();
  const olderAt = html.indexOf('<details class="ask-older"');
  assert.ok(olderAt > 0, 'the old asks have a fold of their own');
  assert.deepEqual(cardsOf(html.slice(0, olderAt)), ['ask-2', 'ask-1', 'ask-3'], 'a week is not old yet: 2 h, 5 h, 30 h');
  assert.deepEqual(cardsOf(html.slice(olderAt)), ['ask-4'], '9 days is');
  const tag = html.slice(olderAt, html.indexOf('>', olderAt) + 1);
  assert.match(tag, /data-open="ask-old-V-03"/, 'the fold remembers being opened');
  assert.doesNotMatch(tag, / open>/, 'closed by default');
  assert.match(html.slice(olderAt), /Older \(1\)/);
  // Opened before, still open after the poll (S.open, the same flag the withdrawn-ask fold uses).
  assert.match(page({ open: { 'ask-old-V-03': true } }).askCards(), /<details class="ask-older" data-open="ask-old-V-03" open>/);
  // The rule is "over a week": 6 d 23 h is fresh, 7 d 1 h is not.
  const edge = h => page({ data: dataOf([{ id: `ask-${h}`, task_id: 'V-03', status: 'open', rev: 1, attribution: { created_at: at(h) }, text: 'Câu hỏi.' }]) }).askCards();
  assert.doesNotMatch(edge(6 * 24 + 23), /ask-older/);
  assert.match(edge(7 * 24 + 1), /ask-older/);
});

test('a card’s answer button sends THAT card’s ask: the reply scopes the composer to its ask id', async () => {
  const p = page({ askOpen: 'ask-1' });
  const askId = /data-action="reply-ask" data-task="V-03" data-ask="([^"]+)"/.exec(cardHtml(p.askCards(), 'ask-1'))[1];
  assert.equal(askId, 'ask-1', 'the wiring comes from the card itself');
  const writes = [];
  const sandbox = {
    S: p.S, esc: escHtml, MD, LR, LM, isOwner: () => true, toast: () => {}, refresh: async () => {}, uploadImage: async () => 'att-synthetic',
    store: { get: () => '', set: () => {} },
    write: async (op, target, data) => { writes.push({ op, target, data }); return { ok: true }; }
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(['esc', 't', 'fmtDur', 'serverNow', 'asksOf', 'msgsOf', 'askSinceOf', 'refsOf', 'refsKey', 'uniqBy', 'waitTone', 'ASK_OLD_MS', 'OWNER_KINDS', 'askCard', 'askCardBody', 'askCards', 'compose', 'saveDraft', 'focusAsk', 'sendCompose'].map(lift).join('\n'), ctx);
  vm.runInContext(`focusAsk('V-03', ${JSON.stringify(askId)})`, ctx);
  assert.equal(sandbox.S.compose['V-03'].scope, 'ask:ask-1', 'the composer is scoped to this ask');
  sandbox.S.compose['V-03'].text = 'Đồng ý, chọn bản fal.';
  await vm.runInContext(`sendCompose('V-03')`, ctx);
  const message = writes.find(w => w.op === 'feedback.add');
  assert.ok(message, 'the answer is filed');
  assert.equal(message.target, 'V-03');
  assert.equal(message.data.ask_id, 'ask-1', 'the message answers the ask the card showed');
  assert.equal(message.data.step_id, 'p1', 'and carries its step');
});
