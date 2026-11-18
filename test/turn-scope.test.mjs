// Turn reports next to the reporter scope (fix/j05-reporter-scope) and the outside edge: a scoped reporter must not see, or send,
// anyone's turn report, and a lane token that reads every task sees its own lane only. The quick report quotes asks and names
// tasks, so it is as private as the tasks themselves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startSeeded, OWNER } from './helpers.mjs';

const SECRET = 'ZZSECRETASKZZ';

async function board() {
  const s = await startSeeded();
  // lane-beta's task carries a marker in its ask; lane-alpha has its own task WEB-3 (seeded)
  await s.write(s.coord, 'task.create', 'API-9', { title: 'Beta job', lane: 'lane-beta', steps: [{ id: 's1', label: `Decide ${SECRET}`, zone: 'owner', state: 'waiting' }] });
  await s.write(s.coord, 'ask.raise', 'API-9', { text: `question ${SECRET}`, step_id: 's1' });
  s.star = (await s.write(OWNER, 'token.issue', 'lane-star', { role: 'reporter', lane: 'lane-star', scope_tasks: ['*'] })).body.token;
  s.betaStar = (await s.write(OWNER, 'token.issue', 'beta-star', { role: 'reporter', lane: 'lane-beta', scope_tasks: ['*'] })).body.token;
  await s.write(s.coord, 'task.create', 'STAR-1', { title: 'Star', lane: 'lane-star' });
  for (const [lane, id] of [['lane-beta', 'b-1'], ['lane-alpha', 'a-1'], ['lane-star', 's-1']]) assert.equal((await s.write(OWNER, 'turn.report', lane, { turn_id: id, detail: `detail of ${lane}` })).status, 200);
  return s;
}
const get = (s, token, route, headers = {}) => fetch(s.url + route, { headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers } }).then(async r => ({ status: r.status, text: await r.text() }));

test('a scoped reporter (scope_tasks not *) is refused every turn read and write, even for its own lane; state.turns is empty and holds no foreign quick', async () => {
  const s = await board();
  try {
    for (const [name, token, own] of [['lane-alpha', s.alpha, 'lane-alpha'], ['lane-beta', s.beta, 'lane-beta']]) {
      for (const lane of [own, 'lane-beta', 'lane-alpha', 'lane-star']) {
        const r = await get(s, token, `/api/v1/turns?lane=${lane}`);
        assert.equal(r.status, 403, `${name} reads ${lane}`);
        assert.ok(!r.text.includes(SECRET) && !r.text.includes('detail of'), 'no body leaks');
      }
      const w = await s.write(token, 'turn.report', own, { turn_id: `x-${name}`, detail: 'from a scoped reporter' });
      assert.equal(w.status, 403, `${name} reports`); assert.equal(w.body.error, 'forbidden_lane');
      const st = await get(s, token, '/api/v1/state?v=2');
      assert.equal(st.status, 200);
      assert.deepEqual(JSON.parse(st.text).turns, {}, `${name}: no turns in state`);
      assert.ok(!st.text.includes(SECRET), `${name}: nothing of another lane's quick or tasks in the state`);
    }
    assert.equal(s.board.state.turn_history['lane-alpha'].length, 1, 'nothing was written by the refused calls');
  } finally { await s.close(); }
});

test('a lane token that reads every task sees its own lane only, in /turns and in state.turns', async () => {
  const s = await board();
  try {
    assert.equal((await get(s, s.star, '/api/v1/turns?lane=lane-star')).status, 200);
    for (const lane of ['lane-beta', 'lane-alpha']) {
      const r = await get(s, s.star, `/api/v1/turns?lane=${lane}`);
      assert.equal(r.status, 403, lane); assert.ok(!r.text.includes(SECRET));
    }
    const st = JSON.parse((await get(s, s.star, '/api/v1/state?v=2')).text);
    assert.deepEqual(Object.keys(st.turns), ['lane-star']);
    assert.ok(!JSON.stringify(st.turns).includes(SECRET), "lane-beta's quick is not in lane-star's turns");
    // lane-beta's own token does see the ask it is waiting on in its quick report
    const own = JSON.parse((await get(s, s.betaStar, '/api/v1/state?v=2')).text);
    assert.deepEqual(Object.keys(own.turns), ['lane-beta']);
    assert.ok(JSON.stringify(own.turns).includes('API-9'));
    assert.equal((await s.write(s.star, 'turn.report', 'lane-beta', { turn_id: 'x', detail: 'x' })).status, 403, 'and reports only its own lane');
  } finally { await s.close(); }
});

test('the outside edge (X-Laneboard-Ext) has no turn route: reads are 404, the op is not allowed, state?v=2 is not served', async () => {
  const s = await board();
  try {
    const EXT = { 'X-Laneboard-Ext': '1' };
    for (const token of [s.alpha, s.star]) {
      assert.equal((await get(s, token, '/api/v1/turns?lane=lane-star', EXT)).status, 404);
      assert.equal((await get(s, token, '/api/v1/state?v=2', EXT)).status, 404);
      const w = await fetch(`${s.url}/api/v1/write`, { method: 'POST', headers: { ...EXT, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ version: 1, request_id: 'ext-turn-0001', op: 'turn.report', target_id: 'lane-star', data: { turn_id: 'e', detail: 'x' } }) });
      assert.equal(w.status, 403);
      assert.equal((await w.json()).error, 'op_not_allowed_on_ext');
    }
    assert.equal((await get(s, null, '/api/v1/turns?lane=lane-star', EXT)).status, 404, 'no bearer: still no route');
    assert.equal((await get(s, null, '/api/v1/turns?lane=lane-star')).status, 401);
    assert.equal(s.board.state.turn_history['lane-star'].length, 1);
  } finally { await s.close(); }
});
