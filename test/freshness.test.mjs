// Status freshness: the Now/Next text is stamped when it changes, a task whose steps moved after it (or whose text is
// old) is listed as stale, and the board asks the lane for an update by itself until the text changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startSeeded, OWNER } from './helpers.mjs';
import { loadSchemas, validate } from '../src/validate.mjs';
import { SCHEMA_DIR } from '../src/board.mjs';

const T0 = Date.parse('2026-10-10T10:00:00.000Z'), H = 3600000;

/** A seeded board whose clock the test moves. WEB-3 and API-2 are created at T0. */
async function setup() {
  const clock = { ms: T0 };
  const s = await startSeeded({ now: () => clock.ms });
  const rev = id => s.board.state.tasks[id].rev;
  const update = (id, data) => s.write(s.coord, 'task.update', id, data, { expected_revision: rev(id) });
  const stepDone = () => s.write(s.coord, 'step.update', 'WEB-3/s2', { state: 'done' }, { expected_revision: s.board.state.steps['WEB-3/s2'].rev });
  const stale = async () => (await s.state(OWNER)).stale_text;
  const open = () => Object.values(s.board.state.feedback).filter(f => f.kind === 'rebrief' && f.mode === 'status' && f.status === 'open');
  return { s, clock, update, stepDone, stale, open };
}

test('T1 a step changing state after the text makes the task stale (steps_newer); a step in the same push does not', async () => {
  const { s, clock, update, stepDone, stale } = await setup();
  try {
    await update('WEB-3', { now: 'round 4 done' });
    clock.ms = T0 + 10000; await stepDone();
    assert.deepEqual(await stale(), [], 'a step written seconds after the text is the same push');
    clock.ms = T0 + 23 * H; assert.equal((await s.write(s.coord, 'step.update', 'WEB-3/s2', { state: 'active' }, { expected_revision: 2 })).status, 200);
    const list = await stale();
    assert.deepEqual(list.map(x => [x.task_id, x.reason]), [['WEB-3', 'steps_newer']]);
    assert.equal(list[0].text_at, new Date(T0).toISOString());
    assert.equal(list[0].step_at, new Date(T0 + 23 * H).toISOString());
  } finally { await s.close(); }
});

test('T2 an empty task.update does not refresh the text; T3 a changed now does', async () => {
  const { s, clock, update, stale } = await setup();
  try {
    await update('WEB-3', { now: 'round 4 done' });
    clock.ms = T0 + 23 * H; await s.write(s.coord, 'step.update', 'WEB-3/s2', { state: 'done' }, { expected_revision: 1 });
    assert.equal((await stale()).length, 1);
    clock.ms += 1000; await update('WEB-3', {});
    assert.equal((await stale())[0].text_at, new Date(T0).toISOString(), 'text_at unchanged by the bump');
    clock.ms += 1000; await update('WEB-3', { now: 'round 4 done' });
    assert.equal((await stale()).length, 1, 'the same text pushed again is not a change');
    clock.ms += 1000; await update('WEB-3', { now: 'round 5 started' });
    assert.deepEqual(await stale(), []);
    assert.equal(s.board.state.tasks['WEB-3'].text_at, new Date(clock.ms).toISOString());
  } finally { await s.close(); }
});

test('T4 old text is stale by age; the owner setting turns the age rule off', async () => {
  const { s, clock, stale } = await setup();
  try {
    await s.write(s.coord, 'task.update', 'WEB-3', { now: 'steady' }, { expected_revision: 1 });
    clock.ms = T0 + 25 * H;
    const list = await stale();
    assert.deepEqual(list.map(x => [x.task_id, x.reason]), [['WEB-3', 'age'], ['API-2', 'age']]);
    assert.equal((await s.state(OWNER)).freshness.stale_h, 24, 'default');
    assert.equal((await s.write(OWNER, 'freshness.set', 'board', { stale_h: 48 })).status, 200);
    assert.deepEqual(await stale(), []);
    await s.write(OWNER, 'freshness.set', 'board', { stale_h: 0 });
    assert.deepEqual(await stale(), [], 'Off');
    assert.equal((await s.write(OWNER, 'freshness.set', 'board', { stale_h: 7 })).status, 400);
    assert.equal((await s.write(OWNER, 'freshness.set', 'board', {})).status, 400);
  } finally { await s.close(); }
});

/** WEB-3 stale by its steps, the rest quiet. s4 keeps a live lane-side step open, so J-05's "only waits on anh" skip
 *  does not apply: the quiet rules below are tested on a row the sweep would otherwise ask. */
async function staleWeb3(h) {
  await h.update('WEB-3', { now: 'round 4 done' });
  h.clock.ms = T0 + 2 * H; await h.stepDone();
  await h.s.write(h.s.coord, 'step.create', 'WEB-3/s4', { label: 'Round 4', zone: 'build', state: 'active' });
  h.clock.ms = T0 + 3 * H;
}

test('T5 the sweep files one status request and one ping per stale task, however often it runs', async () => {
  const h = await setup();
  try {
    await staleWeb3(h);
    const pingsBefore = h.s.board.state.pings.length;
    assert.equal(h.s.board.sweepFreshness(), 1);
    assert.equal(h.s.board.sweepFreshness(), 0);
    assert.equal(h.open().length, 1);
    assert.equal(h.open()[0].task_id, 'WEB-3');
    assert.equal(h.s.board.state.pings.length - pingsBefore, 1);
    assert.equal(h.s.board.state.pings.at(-1).kind, 'rebrief');
    const task = (await h.s.state(OWNER)).tasks.find(x => x.id === 'WEB-3');
    assert.equal(task.status_request.id, h.open()[0].id);
    assert.equal((await h.s.state(OWNER)).tasks.find(x => x.id === 'API-2').status_request, null);
  } finally { await h.s.close(); }
});

test("the sweep is the board's own request: flagged auto, it does not move the activity clock; the owner's button press does", async () => {
  const h = await setup();
  try {
    await staleWeb3(h);
    const activity = h.s.board.state.activity['WEB-3'], lastAt = id => h.s.state(OWNER).then(v => v.tasks.find(x => x.id === id).last_activity_at);
    h.clock.ms += 2 * H + 60000; // 22:01 ICT: the sweep stays quiet 23:00-07:00
    assert.equal(h.s.board.sweepFreshness(), 1);
    const f = h.open()[0];
    assert.equal(f.auto, true);
    assert.equal(h.s.board.state.activity['WEB-3'], activity, 'the sweep leaves the activity clock alone');
    assert.equal(await lastAt('WEB-3'), activity);
    assert.equal((await h.s.state(OWNER)).stalled.find(x => x.task_id === 'WEB-3')?.last_at, activity);
    assert.deepEqual(validate(loadSchemas(SCHEMA_DIR), 'feedback.json', f), [], 'the stored record is schema-valid');
    assert.equal(h.s.board.state.pings.at(-1).detail.auto, true);
    // A request body cannot claim to be the board's.
    assert.equal((await h.s.write(OWNER, 'rebrief.request', 'API-2', { mode: 'status', auto: true })).status, 400);
    // The owner's own press stays the owner's: no auto flag, and it counts as activity.
    h.clock.ms += 1000;
    await h.update('WEB-3', { now: 'fresh' });
    h.clock.ms += 1000;
    assert.equal((await h.s.write(OWNER, 'rebrief.request', 'WEB-3', { mode: 'status' })).status, 200);
    assert.equal(h.open()[0].auto, undefined);
    assert.equal(h.s.board.state.activity['WEB-3'], new Date(h.clock.ms).toISOString());
  } finally { await h.s.close(); }
});

test("the page shows the sweep's request as the board's, not as the owner's", () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /owner = m\.author\.role === 'owner' && !f\.auto/);
  assert.match(app, /f\.auto \? t\('stream\.board'\)/);
  assert.match(app, /t\(f\.auto \? 'rebrief\.sentAuto' : 'rebrief\.sentStatus'\)/);
});

test('T6 changing now/next closes the status request and the next sweep files nothing', async () => {
  const h = await setup();
  try {
    await staleWeb3(h);
    h.s.board.sweepFreshness();
    assert.equal(h.open().length, 1);
    await h.update('WEB-3', { now: 'x' });
    assert.equal(h.open().length, 0);
    const done = Object.values(h.s.board.state.feedback).find(f => f.mode === 'status');
    assert.equal(done.status, 'resolved');
    assert.equal(h.s.board.sweepFreshness(), 0);
  } finally { await h.s.close(); }
});

test('T7 with auto_request off the sweep writes nothing and the badge list still shows', async () => {
  const h = await setup();
  try {
    await staleWeb3(h);
    await h.s.write(OWNER, 'freshness.set', 'board', { auto_request: false });
    const seq = h.s.board.state.seq;
    assert.equal(h.s.board.sweepFreshness(), 0);
    assert.equal(h.s.board.state.seq, seq);
    assert.deepEqual((await h.stale()).map(x => x.task_id), ['WEB-3']);
    // The owner can still ask by hand; it is the same request and the sweep then leaves the task alone.
    await h.s.write(OWNER, 'freshness.set', 'board', { auto_request: true });
    assert.equal((await h.s.write(OWNER, 'rebrief.request', 'WEB-3', { mode: 'status' })).status, 200);
    assert.equal(h.s.board.sweepFreshness(), 0);
  } finally { await h.s.close(); }
});

test('T8 only the owner sets freshness', async () => {
  const { s } = await setup();
  try {
    for (const token of [s.coord, s.alpha]) {
      const r = await s.write(token, 'freshness.set', 'board', { stale_h: 12 });
      assert.equal(r.status, 403);
    }
    assert.equal((await s.write(s.coord, 'rebrief.request', 'WEB-3', { mode: 'status' })).status, 403, 'a status request is the owner\'s (or the sweep\'s) call');
  } finally { await s.close(); }
});

test('paused and finished tasks are never stale or asked', async () => {
  const h = await setup();
  try {
    await staleWeb3(h);
    await h.s.write(OWNER, 'task.update', 'WEB-3', { status: 'paused' }, { expected_revision: h.s.board.state.tasks['WEB-3'].rev });
    h.clock.ms = T0 + 100 * H;
    await h.s.write(OWNER, 'task.update', 'API-2', { status: 'closed' }, { expected_revision: h.s.board.state.tasks['API-2'].rev });
    assert.deepEqual(await h.stale(), []);
    assert.equal(h.s.board.sweepFreshness(), 0);
  } finally { await h.s.close(); }
});

// ---- the sweep's quiet rules (J-05): it asks only where a request helps, and never at night ----
const MIN = 60000;

test('quiet 1: a grey (parked) task gets no automatic status request, a green one does', async () => {
  const h = await setup();
  try {
    await staleWeb3(h); // WEB-3 stale by steps, last write T0+2h
    await h.s.write(h.s.coord, 'task.update', 'WEB-3', { health: 'grey' }, { expected_revision: h.s.board.state.tasks['WEB-3'].rev });
    h.clock.ms += 90 * MIN; // 21:30 ICT, the write above is 90 min old
    assert.deepEqual((await h.stale()).map(x => x.task_id), ['WEB-3'], 'still listed as stale: only the request is withheld');
    const seq = h.s.board.state.seq;
    assert.equal(h.s.board.sweepFreshness(), 0);
    assert.equal(h.s.board.state.seq, seq, 'nothing written');
    await h.s.write(h.s.coord, 'task.update', 'WEB-3', { health: 'green' }, { expected_revision: h.s.board.state.tasks['WEB-3'].rev });
    h.clock.ms += 61 * MIN; // 22:31 ICT
    assert.equal(h.s.board.sweepFreshness(), 1);
  } finally { await h.s.close(); }
});

test('quiet 2: paused and closed tasks get no request (status check in the sweep itself)', async () => {
  const h = await setup();
  try {
    await staleWeb3(h);
    for (const status of ['paused', 'closed']) {
      await h.s.write(OWNER, 'task.update', 'WEB-3', { status }, { expected_revision: h.s.board.state.tasks['WEB-3'].rev });
      h.clock.ms += 2 * H;
      assert.equal(h.s.board.sweepFreshness(), 0, status);
    }
  } finally { await h.s.close(); }
});

test('quiet 3: a task written to in the last 60 minutes is skipped, a task idle for 60 is asked', async () => {
  const h = await setup();
  try {
    await staleWeb3(h); // last write T0+2h, clock T0+3h
    for (const [label, write] of [
      ['coordinator', () => h.s.write(h.s.coord, 'step.update', 'WEB-3/s2', { state: 'active' }, { expected_revision: h.s.board.state.steps['WEB-3/s2'].rev })],
      ['lane', () => h.s.write(h.s.alpha, 'inbox.submit', 'WEB-3', { kind: 'report', text: 'layout done' })]
    ]) {
      h.clock.ms += 10 * MIN; assert.equal((await write()).status, 200, label); // neither write changes Now/Next, so the task stays stale
      h.clock.ms += 59 * MIN;
      assert.equal(h.s.board.sweepFreshness(), 0, `${label} wrote 59 min ago`);
      assert.equal(h.open().length, 0);
      h.clock.ms += MIN;
      assert.equal(h.s.board.sweepFreshness(), 1, `${label} wrote 60 min ago`);
      await h.update('WEB-3', { now: `done ${label}` }); // closes the request, text fresh again
      h.clock.ms += 10 * MIN; await h.stepDone().catch(() => {});
    }
  } finally { await h.s.close(); }
});

test('quiet 4: no request from 23:00 to 07:00 Asia/Ho_Chi_Minh, and a skipped one is not queued', async () => {
  const at = iso => Date.parse(iso);
  const cases = [ // [UTC instant, ICT clock, expected filed]
    ['2026-10-10T15:59:00Z', '22:59', 1], ['2026-10-10T16:00:00Z', '23:00', 0], ['2026-10-10T20:00:00Z', '03:00', 0],
    ['2026-10-10T23:59:00Z', '06:59', 0], ['2026-10-11T00:00:00Z', '07:00', 1]
  ];
  for (const [utc, ict, want] of cases) {
    const h = await setup();
    try {
      await staleWeb3(h);
      h.clock.ms = at(utc);
      const seq = h.s.board.state.seq;
      assert.equal(h.s.board.sweepFreshness(), want, `${ict} ICT`);
      assert.equal(h.open().length, want);
      if (!want) assert.equal(h.s.board.state.seq, seq, 'a skipped request writes nothing');
    } finally { await h.s.close(); }
  }
  // Skipped at night, asked by the first normal run: nothing was queued, the rule just applies again.
  const h = await setup();
  try {
    await staleWeb3(h);
    for (const utc of ['2026-10-10T17:00:00Z', '2026-10-10T23:00:00Z']) { h.clock.ms = at(utc); assert.equal(h.s.board.sweepFreshness(), 0); }
    assert.equal(h.s.board.state.feedback && h.open().length, 0);
    h.clock.ms = at('2026-10-11T00:00:00Z');
    assert.equal(h.s.board.sweepFreshness(), 1, 'one request, not one per skipped run');
  } finally { await h.s.close(); }
});

test('quiet 5: auto_request off still wins at any hour (the toggle is unchanged)', async () => {
  const h = await setup();
  try {
    await staleWeb3(h);
    await h.s.write(OWNER, 'freshness.set', 'board', { auto_request: false });
    h.clock.ms = Date.parse('2026-10-11T00:00:00Z');
    assert.equal(h.s.board.sweepFreshness(), 0);
  } finally { await h.s.close(); }
});

test('quiet 6: in the daytime an active, non-grey task idle for more than 60 min (only an old push) still gets its request', async () => {
  const h = await setup();
  try {
    await staleWeb3(h); // last write T0+2h; clock T0+3h = 20:00 ICT, health green, status doing
    const t = h.s.board.state.tasks['WEB-3'];
    assert.deepEqual([t.status, t.health], ['doing', 'green']);
    h.clock.ms = T0 + 2 * H + 61 * MIN; // 20:01 ICT, 61 min since the last write
    assert.equal(h.s.board.sweepFreshness(), 1);
    assert.equal(h.open()[0].task_id, 'WEB-3');
  } finally { await h.s.close(); }
});

// ---- J-05: the sweep also leaves a row alone when the only work left waits on the owner (anh) ----
/** Park the two seed tasks so only the row under test can reach the sweep. */
async function parkSeeds(h) {
  for (const id of ['WEB-3', 'API-2']) await h.s.write(OWNER, 'task.update', id, { status: 'paused' }, { expected_revision: h.s.board.state.tasks[id].rev });
}

test('J-05/1 a row whose every open step waits on anh, pushed 2 h ago, is skipped', async () => {
  const h = await setup();
  try {
    h.clock.ms = T0; await parkSeeds(h);
    await h.s.write(h.s.coord, 'task.create', 'OWN-1', { title: 'Waits on anh', steps: [
      { id: 'b1', label: 'Build', zone: 'build', state: 'active' },
      { id: 'o1', label: 'Owner picks hero', zone: 'owner', state: 'waiting' }
    ] });
    h.clock.ms = T0 + 2 * H; // the lane finishes its build step; only the owner wait is left
    await h.s.write(h.s.coord, 'step.update', 'OWN-1/b1', { state: 'done' }, { expected_revision: 1 });
    h.clock.ms = T0 + 3 * H; // 20:00 ICT, daytime; pushed 1 h ago (inside the 24 h window)
    assert.deepEqual((await h.stale()).map(x => x.task_id), ['OWN-1'], 'still stale: only the request is withheld');
    const seq = h.s.board.state.seq;
    assert.equal(h.s.board.sweepFreshness(), 0, 'no request: the row only waits on anh');
    assert.equal(h.s.board.state.seq, seq, 'nothing written');
    assert.equal(h.open().length, 0);
  } finally { await h.s.close(); }
});

test('J-05/2 the same row, pushed over a day ago, is asked again', async () => {
  const h = await setup();
  try {
    h.clock.ms = T0; await parkSeeds(h);
    await h.s.write(h.s.coord, 'task.create', 'OWN-2', { title: 'Waits on anh', steps: [
      { id: 'b1', label: 'Build', zone: 'build', state: 'active' },
      { id: 'o1', label: 'Owner picks hero', zone: 'owner', state: 'waiting' }
    ] });
    h.clock.ms = T0 + 2 * H;
    await h.s.write(h.s.coord, 'step.update', 'OWN-2/b1', { state: 'done' }, { expected_revision: 1 });
    h.clock.ms = T0 + 27 * H; // 20:00 ICT next day; 25 h since the push, so the owner-only skip has lapsed
    assert.equal(h.s.board.sweepFreshness(), 1, 'idle over a day: the row is asked');
    assert.deepEqual(h.open().map(f => f.task_id), ['OWN-2']);
  } finally { await h.s.close(); }
});

test('J-05/3 a row with a live build step plus an ask is still asked', async () => {
  const h = await setup();
  try {
    h.clock.ms = T0; await parkSeeds(h);
    await h.s.write(h.s.coord, 'task.create', 'BUILD-1', { title: 'Build + ask', steps: [
      { id: 'b1', label: 'Build', zone: 'build', state: 'active' },
      { id: 'o1', label: 'Owner picks hero', zone: 'owner', state: 'waiting' }
    ] });
    await h.s.write(h.s.coord, 'ask.raise', 'BUILD-1', { text: 'Photo or drawing?', step_id: 'o1', options: [{ key: 'A', label: 'Photo' }, { key: 'B', label: 'Drawing' }] });
    h.clock.ms = T0 + 2 * H;
    await h.s.write(h.s.coord, 'step.create', 'BUILD-1/b2', { label: 'Round 2', zone: 'build', state: 'active' });
    h.clock.ms = T0 + 3 * H; // pushed 1 h ago; the live build step keeps the row asked, ask or not
    assert.equal(h.s.board.sweepFreshness(), 1);
    assert.deepEqual(h.open().map(f => f.task_id), ['BUILD-1']);
  } finally { await h.s.close(); }
});

test("J-05/4 a row with no open step keeps today's behaviour", async () => {
  const h = await setup();
  try {
    h.clock.ms = T0; await parkSeeds(h);
    await h.s.write(h.s.coord, 'task.create', 'DONE-1', { title: 'All done', steps: [{ id: 's1', label: 'Build', zone: 'build', state: 'done' }] });
    await h.s.write(h.s.coord, 'task.create', 'EMPTY-1', { title: 'No steps' });
    h.clock.ms = T0 + 27 * H;
    // Today: an all-done row is not stale (staleText drops it), so the sweep never asks it; a row with no steps at all is
    // stale by age and is still asked — the J-05 skip needs at least one open step (onlyOwnerPending). Neither changes.
    assert.deepEqual((await h.stale()).map(x => x.task_id), ['EMPTY-1']);
    assert.equal(h.s.board.sweepFreshness(), 1);
    assert.deepEqual(h.open().map(f => f.task_id), ['EMPTY-1']);
  } finally { await h.s.close(); }
});

// The rule, in the coordinator's words: "every non-done step waits on the owner OR has an open owner ask". A build step
// that is still active but carries an open owner ask counts as waiting on the owner (onlyOwnerPending reads the ask, not
// the zone), so the row is skipped while its push is recent; once the push is over a day old the sweep asks anyway, to
// chase it. This case is uncovered above (J-05/1 and /2 use an owner-zone waiting step; J-05/3's live step carries no ask).
test('J-05/5 a row whose only open step is an active build step with an open owner ask, pushed 2 h ago, is skipped', async () => {
  const h = await setup();
  try {
    h.clock.ms = T0; await parkSeeds(h);
    await h.s.write(h.s.coord, 'task.create', 'ASK-1', { title: 'Build with an ask', now: 'round 1 started' });
    h.clock.ms = T0 + 2 * H; // the lane pushes its build step and asks the owner on it: the row's last push
    await h.s.write(h.s.coord, 'step.create', 'ASK-1/b1', { label: 'Build', zone: 'build', state: 'active' });
    await h.s.write(h.s.coord, 'ask.raise', 'ASK-1', { text: 'Which hero?', step_id: 'b1', options: [{ key: 'A', label: 'Photo' }, { key: 'B', label: 'Drawing' }] });
    h.clock.ms = T0 + 4 * H; // 21:00 ICT, daytime; pushed 2 h ago (inside the 24 h window)
    assert.deepEqual((await h.stale()).map(x => x.task_id), ['ASK-1'], 'still stale: only the request is withheld');
    const seq = h.s.board.state.seq;
    assert.equal(h.s.board.sweepFreshness(), 0, 'no request: the only open step waits on the owner through its open ask');
    assert.equal(h.s.board.state.seq, seq, 'nothing written');
    assert.equal(h.open().length, 0);
  } finally { await h.s.close(); }
});

test('J-05/6 the same row, pushed over a day ago, is asked again', async () => {
  const h = await setup();
  try {
    h.clock.ms = T0; await parkSeeds(h);
    await h.s.write(h.s.coord, 'task.create', 'ASK-2', { title: 'Build with an ask', now: 'round 1 started' });
    h.clock.ms = T0 + 2 * H;
    await h.s.write(h.s.coord, 'step.create', 'ASK-2/b1', { label: 'Build', zone: 'build', state: 'active' });
    await h.s.write(h.s.coord, 'ask.raise', 'ASK-2', { text: 'Which hero?', step_id: 'b1', options: [{ key: 'A', label: 'Photo' }, { key: 'B', label: 'Drawing' }] });
    h.clock.ms = T0 + 27 * H; // 20:00 ICT next day; 25 h since the push, so the owner-only skip has lapsed
    assert.equal(h.s.board.sweepFreshness(), 1, 'idle over a day: the row is asked');
    assert.deepEqual(h.open().map(f => f.task_id), ['ASK-2']);
  } finally { await h.s.close(); }
});
