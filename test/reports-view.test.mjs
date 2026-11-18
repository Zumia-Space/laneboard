// The "Báo cáo" view (public/app.js): one card per lane, the quick line and its ask chips, the detail rendered by the same
// sanitising markdown as every agent text. The page's own functions are lifted out of app.js and run on fake data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import '../public/markdown.js';
import '../public/reading.js';

const APP = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'app.js'), 'utf8');
const fn = name => {
  const m = new RegExp(`(?:async )?function ${name}\\(`).exec(APP);
  assert.ok(m, `app.js has no function ${name}`);
  return APP.slice(m.index, APP.indexOf('\n}\n', m.index) + 2);
};
const cnst = name => {
  const m = new RegExp(`^const ${name} = .*;$`, 'm').exec(APP);
  assert.ok(m, `app.js has no const ${name}`);
  return m[0];
};

const ASK = { id: 'ask-2402', task: 'ACME-02', step_id: 's2', text: 'Chọn ghế <img src=x onerror=alert(1)> nào?' };
const quick = (extra = {}) => ({ line: 'Workera CoS xong 1 lượt (18:42) · đổi: ACME-02\nChờ anh 1 việc: ACME-02 Chọn ghế (ask-2402)', asks: [ASK], changed: ['ACME-02'], ...extra });

function page({ me = { role: 'owner', name: 'owner' }, turns, hash = '', asks = [], fetched = {} } = {}) {
  const calls = [];
  const ctx = vm.createContext({
    window: { LaneMarkdown: globalThis.LaneMarkdown, LaneReading: globalThis.LaneReading }, location: { hash }, URLSearchParams, decodeURIComponent,
    S: { data: { me, turns, asks, attachments: [] }, open: {}, turnCache: {} },
    t: (k, v) => (v ? `${k}:${JSON.stringify(v)}` : k),
    fmtTime: iso => `@${iso}`, ago: iso => `ago(${iso})`,
    api: async route => { calls.push(route); return fetched[new URL(route, 'http://x/').searchParams.get('lane')] || { failed: 500 }; }
  });
  vm.runInContext([cnst('esc'), 'const MD = window.LaneMarkdown, LR = window.LaneReading;', cnst('mediaOf'), fn('docButton'), cnst('mdDocs'), cnst('mdHtml'), cnst('role'), cnst('isOwner'), cnst('isLead'), fn('mdBlock'),
    cnst('canReadTurns'), cnst('askChipHref'), fn('loadTurns'), fn('quickHtml'), fn('turnDetail'), fn('laneReport'), fn('renderReports'), fn('route')].join('\n'), ctx);
  return { run: code => vm.runInContext(code, ctx), calls, ctx };
}
const turn = (seq, text, extra = {}) => ({ seq, at: `2026-10-14T11:${String(seq % 60).padStart(2, '0')}:00.000Z`, turn_id: `t-${seq}`, quick: quick(), detail: text, ...extra });

test('ask chips link to #<ask id>: ask-2402 gives #ask-2402, never #ask-ask-2402', () => {
  const p = page();
  assert.equal(p.run("askChipHref('ask-2402')"), '#ask-2402');
  const html = p.run(`quickHtml(${JSON.stringify(quick())})`);
  assert.match(html, /href="#ask-2402"/);
  assert.doesNotMatch(html, /ask-ask-/);
  assert.match(html, /<br>/, 'the second line of the quick report is a line break');
  assert.doesNotMatch(html, /<img/, 'ask text from the board is escaped');
  assert.match(html, /&lt;img/);
});

test('route: #ask-2402 opens that ask on its task; an ask the page does not know falls back to Home; #/reports[/lane] is the reports view', () => {
  const p = page({ hash: '#ask-2402', asks: [{ id: 'ask-2402', task_id: 'ACME-02' }] });
  assert.deepEqual(JSON.parse(JSON.stringify(p.run('route()'))), { view: 'task', id: 'ACME-02', ask: 'ask-2402', msg: '' });
  p.ctx.location.hash = '#ask-9999';
  assert.equal(p.run('route()').view, 'home');
  p.ctx.location.hash = '#ACME-02';
  assert.deepEqual(JSON.parse(JSON.stringify(p.run('route()'))), { view: 'task', id: 'ACME-02', ask: '', msg: '' }, 'a task short link is unchanged');
  p.ctx.location.hash = '#/reports';
  assert.equal(p.run('route()').view, 'reports');
  p.ctx.location.hash = '#/reports/Workera%20CoS';
  assert.deepEqual(JSON.parse(JSON.stringify(p.run('route()'))), { view: 'reports', id: 'Workera CoS', ask: '', msg: '' });
});

test('who sees the view: owner and coordinator, and a reporter token that has a lane', () => {
  assert.equal(page({ me: { role: 'owner' } }).run('canReadTurns()'), true);
  assert.equal(page({ me: { role: 'coordinator' } }).run('canReadTurns()'), true);
  assert.equal(page({ me: { role: 'reporter', lane: 'Workera CoS' } }).run('canReadTurns()'), true);
  assert.equal(page({ me: { role: 'reporter' } }).run('canReadTurns()'), false);
  assert.equal(page({ me: null }).run('canReadTurns()'), false);
});

test('one card per lane, the lane that reported last first; the latest quick line, then the detail folded, then the earlier reports', async () => {
  const lane = (seq, ...more) => ({ lane: 'x', turns: [turn(seq, `# Báo cáo ${seq}\n<script>alert(1)</script> **đậm**`), ...more] });
  const p = page({
    turns: { 'Workera CoS': { seq: 30, at: 'a', quick: quick() }, Workerb: { seq: 40, at: 'b', quick: quick({ line: 'Workerb xong 1 lượt (19:00)', asks: [], changed: [] }) } },
    fetched: { 'Workera CoS': lane(30, turn(20, 'cũ hơn'), turn(10, 'cũ nữa')), Workerb: lane(40) }
  });
  const html = await p.run('renderReports()');
  assert.ok(html.indexOf('<h2>Workerb</h2>') > 0 && html.indexOf('<h2>Workerb</h2>') < html.indexOf('<h2>Workera CoS</h2>'), 'newest report first');
  assert.equal((html.match(/<section class="card report"/g) || []).length, 2);
  assert.match(html, /Workera CoS xong 1 lượt \(18:42\)/);
  assert.match(html, /reports\.detail/);
  assert.match(html, /<details class="report-detail" data-open="rep-30" >/, 'folded by default');
  assert.match(html, /reports\.older:\{&quot;n&quot;:2\}/, 'two earlier reports are counted');
  assert.doesNotMatch(html, /<script/, 'the detail goes through the sanitising renderer');
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<strong>đậm<\/strong>/);
  assert.deepEqual(p.calls.sort(), ['api/v1/turns?lane=Workera%20CoS&limit=20', 'api/v1/turns?lane=Workerb&limit=20']);
  // the same latest seq is not fetched again; a new report is
  await p.run('renderReports()');
  assert.equal(p.calls.length, 2);
  p.ctx.S.data.turns.Workerb.seq = 41;
  await p.run('renderReports()');
  assert.equal(p.calls.length, 3);
});

test('the focused lane (#/reports/<lane>) comes first with its detail open; a failed detail load says so instead of showing nothing', async () => {
  const p = page({
    turns: { 'Workera CoS': { seq: 30, at: 'a', quick: quick() }, Workerb: { seq: 40, at: 'b', quick: quick() } },
    fetched: { Workerb: { lane: 'Workerb', turns: [turn(40, 'v')] } } // Workera CoS: the read fails
  });
  const html = await p.run("renderReports('Workera CoS')");
  assert.ok(html.indexOf('<h2>Workera CoS</h2>') < html.indexOf('<h2>Workerb</h2>'));
  assert.match(html, /data-open="rep-30" open>/);
  assert.match(html, /reports\.loadFailed/, 'the quick report still shows, the detail says it could not load');
  assert.match(html, /Workera CoS xong 1 lượt/);
});

test('a board without turn reports says so; a board with none yet says that; neither fetches anything', async () => {
  const old = page({ turns: undefined });
  assert.match(await old.run('renderReports()'), /reports\.unsupported/);
  const none = page({ turns: {} });
  assert.match(await none.run('renderReports()'), /reports\.empty/);
  assert.deepEqual([...old.calls, ...none.calls], []);
});

test('the page asks for state v=2 (the turns field); the rail lists the view only to readers of turns', () => {
  assert.match(APP, /await api\('api\/v1\/state\?v=2'\)/);
  assert.match(APP, /if \(canReadTurns\(\)\) h \+= nav\('#\/reports'/);
  assert.match(APP, /else if \(r\.view === 'reports' && canReadTurns\(\)\) html = await renderReports\(r\.id\);/);
});
