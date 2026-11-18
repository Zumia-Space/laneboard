// Shared by test/reporter-scope.test.mjs and the golden generator: one fixed board with two tasks (WEB-3, API-2)
// that both carry every kind of record a read view shows. Deterministic: a clock the caller advances, fixed ids.
export const OWNER = 'scope-owner-secret-0123456789';
export const MARK = 'ZZAPI2ZZ'; // appears only in API-2 records

export function makeClock(t = Date.parse('2026-10-14T00:00:00.000Z')) {
  const c = { t, now: () => c.t, tick: ms => { c.t += ms; } };
  return c;
}

/** Seeds `board`. Returns the tokens and the attachment ids. Owner and coordinator write; two reporters submit to their own task. */
export function seedScopeBoard(board, clock) {
  let n = 0;
  const w = (tok, op, target_id, data = {}, expected_revision) => {
    clock.tick(1000);
    return board.write(tok, { version: 1, request_id: `scope-req-${String(++n).padStart(3, '0')}`, op, target_id, data, ...(expected_revision !== undefined ? { expected_revision } : {}) });
  };
  const coord = w(OWNER, 'token.issue', 'coordinator', { role: 'coordinator', lane: 'coordination', model: 'opus' }).token;
  const alpha = w(OWNER, 'token.issue', 'lane-alpha', { role: 'reporter', lane: 'lane-alpha', scope_tasks: ['WEB-3'] }).token;
  const beta = w(OWNER, 'token.issue', 'lane-beta', { role: 'reporter', lane: 'lane-beta', scope_tasks: ['API-2'] }).token;
  const star = w(OWNER, 'token.issue', 'lane-star', { role: 'reporter', lane: 'lane-star', scope_tasks: ['*'] }).token;
  const both = w(OWNER, 'token.issue', 'lane-both', { role: 'reporter', lane: 'lane-both', scope_tasks: ['WEB-3', 'API-2'] }).token;
  w(coord, 'task.create', 'WEB-3', { title: 'Landing page', lane: 'lane-alpha', goal: 'Ship the page', steps: [{ id: 's1', label: 'Build', zone: 'build', state: 'active' }, { id: 's2', label: 'Owner picks hero', zone: 'owner', state: 'waiting' }] });
  w(coord, 'task.create', 'API-2', { title: `Rate limiter ${MARK}`, lane: 'lane-beta', goal: `goal ${MARK}`, steps: [{ id: 's1', label: `Implement ${MARK}`, zone: 'build', state: 'active' }, { id: 's2', label: `Owner decides ${MARK}`, zone: 'owner', state: 'waiting' }] });
  for (const [t, tag] of [['WEB-3', 'web'], ['API-2', MARK]]) {
    w(coord, 'ask.raise', t, { text: `ask ${tag}`, step_id: 's2' });
    w(OWNER, 'feedback.add', t, { kind: 'note', text: `feedback ${tag}` });
    w(coord, 'plan.add', t, { reviewer: 'fable', body: `plan ${tag}` });
    w(OWNER, 'goal.lock', t, { goal: `locked ${tag}`, output: 'o', outcome: 'c' });
    w(coord, 'ping.send', 'board', { task_id: t, note: `ping ${tag}` });
  }
  const attWeb = w(coord, 'attachment.add', 'WEB-3', { name: 'web.txt', mime: 'text/plain', data_base64: Buffer.from('web bytes').toString('base64') }).id;
  const attApi = w(coord, 'attachment.add', 'API-2', { name: `api-${MARK}.txt`, mime: 'text/plain', data_base64: Buffer.from(`api bytes ${MARK}`).toString('base64') }).id;
  w(alpha, 'inbox.submit', 'WEB-3', { kind: 'report', text: 'reporter note web' });
  w(beta, 'inbox.submit', 'API-2', { kind: 'report', text: `reporter note ${MARK}` });
  w(coord, 'summary.set', 'board', { items: [`board note ${MARK}`] }, 0);
  w(coord, 'registry.set', 'board', { entries: [{ id: 'reg-web', code: 'WEB-3', title: 'Landing page', status: 'open' }, { id: 'reg-api', code: 'API-2', title: `Rate limiter ${MARK}`, status: 'open' }] }, 0);
  w(OWNER, 'routing.set', 'API-2', { model: 'sonnet', effort: 'high' });
  clock.tick(1000);
  return { coord, alpha, beta, star, both, attWeb, attApi };
}
