// public/quota.js: which state each account card is in, decided from one quota document and the clock (§4.4 of the
// quota-view plan), and the time / token formatting. The page never recomputes a number: an unknown % is never 0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../public/quota.js';
import { NOW, minutesBefore, premiumA, premiumB, acme, sampleDoc } from './quota-fixtures.mjs';

const { cardModel, docModel, windowState, segments, fmtTokens, clock, LIVE_MS } = globalThis.LaneQuota;
const acct = (over = {}) => ({ ...premiumA, ...over });

test('live: data under 15 minutes old, window not reset -> LIVE, green, not dimmed', () => {
  const c = cardModel(premiumA, NOW);
  assert.equal(c.status, 'live'); assert.equal(c.dot, 'green'); assert.equal(c.dim, false); assert.equal(c.noNewSince, null);
  assert.equal(c.five.state, 'live'); assert.equal(c.five.pct, 62); assert.equal(c.five.hot, false);
  assert.equal(c.week.state, 'live'); assert.deepEqual(c.week.seg, { on: 4, act: 4 });
  assert.equal(c.tokens.today, 18_400_000); assert.equal(c.tokens.idle, false);
});

test('high: 80% and over turns the badge and the ring amber, 79% does not', () => {
  assert.equal(cardModel(premiumB, NOW).status, 'high'); assert.equal(cardModel(premiumB, NOW).five.hot, true);
  const at = pct => cardModel(acct({ window5h: { ...premiumA.window5h, pct } }), NOW);
  assert.equal(at(79).status, 'live'); assert.equal(at(80).status, 'high'); assert.equal(at(100).five.hot, true);
});

test('stale: 15 minutes without a report dims the values and names the last report; just under is still live', () => {
  const w = ageMs => ({ ...premiumA.window5h, as_of: new Date(NOW - ageMs).toISOString() });
  assert.equal(cardModel(acct({ window5h: w(LIVE_MS - 1000) }), NOW).status, 'live');
  const old = w(LIVE_MS), c = cardModel(acct({ window5h: old, week: { ...premiumA.week, as_of: old.as_of }, tokens: { ...premiumA.tokens, as_of: old.as_of } }), NOW);
  assert.equal(c.status, 'stale'); assert.equal(c.dot, 'yellow'); assert.equal(c.blink, true); assert.equal(c.dim, true);
  assert.equal(c.five.state, 'stale'); assert.equal(c.five.pct, 62, 'the last value is still shown, dimmed');
  assert.equal(c.noNewSince, old.as_of, 'since the newest report of any kind');
  assert.equal(LIVE_MS, 900000);
});

test('window passed: after resets_at the % is UNKNOWN (never 0, never hot) and the card says reset-no-use-since', () => {
  const c = cardModel(acme, NOW);
  assert.equal(c.status, 'passed'); assert.equal(c.five.state, 'passed'); assert.equal(c.five.hot, false);
  assert.equal(c.five.pct, 34, 'kept only as "last value seen"'); assert.equal(c.five.resetsAt, acme.window5h.resets_at);
  assert.equal(c.week.state, 'passed', 'a weekly window that has reset is unknown too'); assert.deepEqual(c.week.seg, { on: 0, act: -1 });
  assert.equal(c.noNewSince, acme.window5h.as_of, 'the last rate_limits report, not the token scan time (the machine answered the scan at 23:40)');
  assert.equal(c.tokens.idle, true); assert.equal(c.tokens.lastActivity, acme.tokens.last_activity);
  // the boundary: exactly at resets_at the window is not passed yet, one millisecond later it is
  const reset = Date.parse(premiumA.window5h.resets_at);
  assert.notEqual(windowState(premiumA.window5h, reset), 'passed'); assert.equal(windowState(premiumA.window5h, reset + 1), 'passed');
  assert.equal(cardModel(acct({ window5h: { pct: 99, resets_at: minutesBefore(1), as_of: minutesBefore(30) } }), NOW).five.hot, false, 'a passed 99% is not HIGH');
});

test('missing window: a key the plan does not send is "not reported", never an empty or zero bar', () => {
  const c = cardModel(premiumB, NOW);
  assert.equal(c.week.state, 'missing'); assert.equal(c.week.pct, null); assert.deepEqual(c.week.seg, { on: 0, act: -1 });
  const noFive = cardModel(acct({ window5h: null }), NOW);
  assert.equal(noFive.five.state, 'missing'); assert.equal(noFive.status, 'live', 'with no 5-hour window, freshness follows the newest value');
  assert.equal(cardModel(acct({ window5h: undefined, week: undefined, tokens: { ...premiumA.tokens, as_of: minutesBefore(40) } }), NOW).status, 'stale');
});

test('machine unreachable: offline beats every other state, keeps the last values dimmed and says since when', () => {
  const since = minutesBefore(95), down = { status: 'offline', checked_at: minutesBefore(1), since, msg: 'ssh timeout' };
  const c = cardModel(acct({ reach: down }), NOW);
  assert.equal(c.status, 'offline'); assert.equal(c.dot, 'red'); assert.equal(c.dim, true);
  assert.equal(c.reach.since, since); assert.equal(c.reach.msg, 'ssh timeout'); assert.equal(c.five.pct, 62);
  assert.equal(cardModel(acct({ reach: { status: 'error', checked_at: since } }), NOW).reach.since, since, 'no "since": the check time is the honest fallback');
  assert.equal(cardModel(acct({ window5h: null, week: null, tokens: null, reach: down }), NOW).status, 'offline', 'unreachable and never seen is still offline');
});

test('never seen: no snapshot of any kind -> "no data", grey, never a 0% card', () => {
  const c = cardModel({ id: 'x', label: 'X', machine: 'M', reach: { status: 'ok', checked_at: minutesBefore(1) } }, NOW);
  assert.equal(c.status, 'never'); assert.equal(c.dot, 'grey'); assert.equal(c.five.state, 'missing'); assert.equal(c.tokens, null); assert.equal(c.lastSeen, null);
});

test('weekly bar: 10 cells, the partly-filled one is the active cell', () => {
  assert.deepEqual(segments(41), { on: 4, act: 4 }); assert.deepEqual(segments(40), { on: 4, act: -1 });
  assert.deepEqual(segments(0), { on: 0, act: -1 }); assert.deepEqual(segments(100), { on: 10, act: -1 });
  assert.deepEqual(segments(95), { on: 9, act: 9 }); assert.deepEqual(segments(250), { on: 10, act: -1 }); assert.deepEqual(segments(-3), { on: 0, act: -1 });
});

test('token counts: three significant figures, K / M / B, a dash for junk', () => {
  assert.equal(fmtTokens(18_400_000), '18.4 M'); assert.equal(fmtTokens(212_000_000), '212 M'); assert.equal(fmtTokens(96_100_000), '96.1 M');
  assert.equal(fmtTokens(99_960_000), '100 M'); assert.equal(fmtTokens(4200), '4.2 K'); assert.equal(fmtTokens(950), '950');
  assert.equal(fmtTokens(0), '0'); assert.equal(fmtTokens(1_500_000_000), '1.5 B');
  assert.equal(fmtTokens(NaN), '—'); assert.equal(fmtTokens(-1), '—'); assert.equal(fmtTokens(undefined), '—');
});

test('clock times are absolute local "HH:MM dd-mm", a dash when missing or bad', () => {
  assert.equal(clock(new Date(2026, 9, 24, 2, 30).toISOString()), '02:30 24-10');
  assert.equal(clock(new Date(2026, 9, 3, 18, 14).toISOString()), '18:14 03-10');
  assert.equal(clock(new Date(2026, 0, 5, 9, 5).toISOString()), '09:05 05-01');
  assert.equal(clock(undefined), '—'); assert.equal(clock('not a time'), '—'); assert.equal(clock(null), '—');
});

test('document: the concept scene resolves to live / high / passed, and the publisher going quiet is flagged', () => {
  const m = docModel(sampleDoc, NOW);
  assert.deepEqual(m.cards.map(c => [c.label, c.status]), [['Premium A', 'live'], ['Premium B', 'high'], ['Acme Tours', 'passed']]);
  assert.equal(m.empty, false); assert.equal(m.quiet, false);
  assert.equal(docModel(sampleDoc, NOW + 20 * 60000).quiet, true, 'generated 20 minutes ago');
  assert.equal(docModel({ schema: 1, generated_at: null, accounts: [], reason: 'no_quota_file' }, NOW).empty, true);
  assert.equal(docModel(null, NOW).empty, true);
});

test('M2: snap never_seen (collector not installed) is "no data" even when tokens were counted; it never shows green LIVE', () => {
  const noCollector = { id: 'b', label: 'B', machine: 'Spare PC', snap: 'never_seen', reach: { status: 'ok', checked_at: minutesBefore(1) }, window5h: null, week: null, tokens: { today: 268811, d7: 1_000_000, as_of: minutesBefore(1) } };
  const c = cardModel(noCollector, NOW);
  assert.equal(c.status, 'never'); assert.equal(c.dot, 'grey'); assert.equal(c.tokens.today, 268811, 'the counted tokens are still shown');
  assert.equal(cardModel({ ...noCollector, reach: { status: 'offline', checked_at: minutesBefore(1) } }, NOW).status, 'offline', 'unreachable still wins');
  assert.equal(cardModel({ ...noCollector, snap: 'ok' }, NOW).status, 'live', 'only the publisher saying never_seen (or nothing at all) means no data');
  assert.equal(cardModel({ ...noCollector, snap: 'never_seen', window5h: premiumA.window5h }, NOW).status, 'live', 'a window that exists beats a stale never_seen flag');
});

test('S3b: freshness follows seen_at (newest report in the window), not as_of (the date of the max value): a steady % stays LIVE, silence for 15 min is STALE', () => {
  const win = (asOfAgo, seenAgo) => ({ ...premiumA.window5h, as_of: minutesBefore(asOfAgo), ...(seenAgo != null ? { seen_at: minutesBefore(seenAgo) } : {}) });
  const steady = cardModel(acct({ window5h: win(90, 1), week: { ...premiumA.week, as_of: minutesBefore(90), seen_at: minutesBefore(1) }, tokens: null }), NOW);
  assert.equal(steady.status, 'live'); assert.equal(steady.five.state, 'live'); assert.equal(steady.five.asOf, minutesBefore(90), 'the value keeps its own date');
  assert.equal(steady.lastSeen, minutesBefore(1)); assert.equal(steady.noNewSince, null);
  const quiet = cardModel(acct({ window5h: win(90, 15), week: { ...premiumA.week, as_of: minutesBefore(90), seen_at: minutesBefore(15) }, tokens: null }), NOW);
  assert.equal(quiet.status, 'stale'); assert.equal(quiet.noNewSince, minutesBefore(15), 'no new report since seen_at, not since as_of');
  assert.equal(cardModel(acct({ window5h: win(1, null) }), NOW).five.state, 'live', 'no seen_at (older publisher) = as_of decides, as before');
  assert.equal(cardModel(acct({ window5h: win(40, null) }), NOW).five.state, 'stale');
});

test('S3: snap fallback (statusline-last.json, not verified) is never LIVE/HIGH: its own UNVERIFIED state, value kept, dimmed', () => {
  const fb = { ...premiumA, snap: 'fallback' };
  const c = cardModel(fb, NOW);
  assert.equal(c.status, 'unverified'); assert.equal(c.dot, 'yellow'); assert.equal(c.dim, true); assert.equal(c.blink, false);
  assert.equal(c.five.pct, premiumA.window5h.pct, 'the number is still shown');
  assert.equal(cardModel({ ...fb, window5h: { ...fb.window5h, pct: 90 } }, NOW).status, 'unverified', 'not HIGH either');
  assert.equal(cardModel({ ...fb, reach: { status: 'offline', checked_at: minutesBefore(1) } }, NOW).status, 'offline', 'unreachable still wins');
  assert.equal(cardModel({ ...fb, window5h: { ...fb.window5h, resets_at: minutesBefore(5) } }, NOW).status, 'passed', 'a reset window is still reset');
  assert.equal(cardModel({ ...fb, window5h: null, week: null, tokens: null }, NOW).status, 'never');
  assert.equal(cardModel({ ...premiumA, snap: 'ok' }, NOW).status, 'live');
});

test('M3: collector warnings reach the card model; a null token count is unknown, not zero', () => {
  const c = cardModel({ ...premiumA, tokens: null, warnings: ['transcripts folder not readable (ENOENT)', '', 7] }, NOW);
  assert.deepEqual(c.warnings, ['transcripts folder not readable (ENOENT)']); assert.equal(c.tokens, null);
  assert.deepEqual(cardModel(premiumA, NOW).warnings, []);
});

test('a document written by the REAL publisher (quota-pull, frozen sample) passes the board reader and reads honestly', async () => {
  const { readQuota } = await import('../src/quota.mjs');
  const { loadSchemas, validate } = await import('../src/validate.mjs');
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-sample-'));
  try {
    fs.copyFileSync(new URL('./quota-publisher-sample.json', import.meta.url), path.join(dir, 'quota.json'));
    const schemas = loadSchemas(new URL('../schema/v1', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
    const doc = readQuota(dir, d => validate(schemas, 'quota.json', d));
    const m = docModel(doc, Date.parse(doc.generated_at) + 60000);
    assert.deepEqual(m.cards.map(c => [c.id, c.status]), [['premium-a', 'live'], ['premium-b', 'never'], ['acme', 'never']]);
    assert.ok(m.cards[1].tokens.today > 0, 'tokens still shown on a no-collector machine');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
