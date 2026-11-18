// public/diagram.js: the geometry behind the two diagrams. The flow rule is the predecessor board's `taskFlow`:
// walk the steps in board order and advance one column, unless the next step sits in a LOWER lane — then it stacks
// under the previous one. The merged `lich-su` step is never part of the flow: it is one box of its own lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import '../public/diagram.js';

const DG = globalThis.LaneDiagram;
const APP = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'app.js'), 'utf8');

const step = (id, zone, state, extra = {}) => ({ id: 'T-1/' + id, label: extra.label || id.toUpperCase(), zone, state, ...extra });
const task = (steps, extra = {}) => ({ id: 'T-1', health: 'green', steps, current_step: null, ...extra });
const byShort = L => Object.fromEntries(L.boxes.map(b => [b.short, b]));

test('flow: one lane per zone the live steps use, in phase order', () => {
  const L = DG.layoutTask(task([
    step('s1', 'plan', 'done'), step('s2', 'build', 'done'), step('s3', 'test', 'active'), step('s4', 'owner', 'waiting'), step('s5', 'ship', 'todo')]));
  assert.deepEqual(L.lanes.map(l => l.key), ['plan', 'build', 'test', 'owner', 'ship']);
  assert.deepEqual(L.lanes.map(l => l.count), [1, 1, 1, 1, 1]);
  // each step is a lane lower than the one before: one column, stacked downwards, one arrow per pair
  assert.equal(new Set(L.boxes.map(b => b.x)).size, 1, 'all in one column');
  assert.deepEqual(L.boxes.map(b => b.y), [...L.boxes.map(b => b.y)].sort((a, b) => a - b), 'y grows lane by lane');
  assert.deepEqual(L.edges.map(e => e.dir), ['down', 'down', 'down', 'down']);
  assert.equal(L.empty, false);
});

test('flow: a step in the same lane advances a column; going back up starts a new column with an elbow', () => {
  const L = byShort(DG.layoutTask(task([
    step('a', 'plan', 'done'), step('b', 'plan', 'done'), step('c', 'build', 'done'), step('d', 'plan', 'todo')])));
  assert.ok(L.b.x > L.a.x, 'same lane: next column');
  assert.equal(L.b.y, L.a.y);
  assert.equal(L.c.x, L.b.x, 'lower lane stacks under the previous step');
  assert.ok(L.c.y > L.b.y);
  assert.ok(L.d.x > L.c.x, 'back up to plan: a new column');
  const edge = DG.layoutTask(task([
    step('a', 'plan', 'done'), step('b', 'plan', 'done'), step('c', 'build', 'done'), step('d', 'plan', 'todo')])).edges;
  assert.deepEqual(edge.map(e => e.dir), ['right', 'down', 'elbow']);
});

test('flow: the canvas is wide enough for every column and high enough for every lane, and never zero', () => {
  const one = DG.layoutTask(task([step('s1', 'build', 'todo')]));
  assert.ok(one.width >= DG.BOX_W, 'one box wide (the lane labels are a fixed column beside the scroller, not a gutter)');
  assert.equal(one.boxes[0].x, 10, 'the first box starts at the padding, not after a dead gutter');
  assert.ok(one.height >= DG.LANE_H, 'one lane');
  const many = DG.layoutTask(task([step('s1', 'plan', 'todo'), step('s2', 'plan', 'todo'), step('s3', 'plan', 'todo')]));
  assert.ok(many.width > one.width, 'three columns are wider than one');
  for (const b of many.boxes) assert.ok(b.x + b.w <= many.width && b.y + b.h <= many.height, `${b.short} fits the canvas`);
  const none = DG.layoutTask(task([]));
  assert.equal(none.empty, true);
  assert.equal(none.history, null);
  assert.deepEqual(none.boxes, []);
  assert.ok(none.width > 0 && none.height > 0);
});

test('scroll: the current box comes into view whole, one column in, and the left edge slices no box when it fits', () => {
  const L = DG.layoutTask(task(Array.from({ length: 6 }, (_, i) => step('s' + i, 'build', 'todo'))));
  const at = (x, view) => DG.scrollLeftFor(x, L.width - view, view);
  assert.equal(at(L.boxes[0].x, 400), 0, 'the first column needs no scroll');
  for (const view of [400, 300]) {
    for (const b of L.boxes) {
      const s = at(b.x, view);
      assert.ok(s >= 0 && s <= L.width - view, `${b.short}@${view}: inside the scrollable range`);
      assert.ok(s + view >= b.x + b.w, `${b.short}@${view}: the wanted box is not sliced at the right`);
    }
    // every column but the last (which only fits at the end of the range) leaves its predecessor whole when the pane
    // is wide enough for the context column too; a narrow pane drops the context rather than slicing the wanted box
    for (const [i, b] of L.boxes.slice(1, -1).entries()) {
      const s = at(b.x, view), prev = L.boxes[i];
      assert.ok(!L.boxes.some(o => s > o.x + 0.5 && s < o.x + o.w - 0.5), `s${i + 1}@${view}: the edge ${s} cuts no box`);
      if (view === 400) assert.ok(prev.x >= s && s + view >= prev.x + prev.w, `s${i + 1}@${view}: the previous box is whole`);
    }
    const last = L.boxes.at(-1);
    assert.equal(at(last.x, view), L.width - view, `the last column scrolls to the end (${view})`);
  }
  assert.equal(DG.scrollLeftFor(10, 500, 400), 0, 'a first column never scrolls even when the range allows it');
});

test('current step: flagged by the server-derived current_step, and only that one', () => {
  const L = byShort(DG.layoutTask(task([
    step('s1', 'plan', 'done'), step('s2', 'build', 'active'), step('s3', 'test', 'todo')], { current_step: { id: 'T-1/s2', label: 's2', state: 'active' } })));
  assert.deepEqual(Object.values(L).filter(b => b.current).map(b => b.short), ['s2']);
  const nocur = DG.layoutTask(task([step('s1', 'build', 'todo')]));
  assert.deepEqual(nocur.boxes.filter(b => b.current), [], 'no current_step: nothing highlighted');
});

test('owner hand-off and done: the owner lane is marked, a waiting owner step too, done steps dim', () => {
  const L = byShort(DG.layoutTask(task([
    step('s1', 'build', 'done'), step('s2', 'owner', 'waiting'), step('s3', 'owner', 'todo')])));
  assert.equal(L.s2.owner, true);
  assert.equal(L.s2.waitingOwner, true, 'waiting on the owner: tagged');
  assert.equal(L.s3.owner, true);
  assert.equal(L.s3.waitingOwner, false, 'in the owner lane but not waiting yet: no tag');
  assert.equal(L.s1.owner, false);
  assert.equal(L.s1.done, true);
  assert.equal(L.s2.done, false);
});

test('lich-su: one collapsed box, never in the flow, and its lines open on request', () => {
  const steps = [
    step('lich-su', 'build', 'done', { label: 'Lịch sử', detail: '01/10 · a · x\n\n02/10 · b · y  \n' }),
    step('s1', 'build', 'active'), step('s2', 'test', 'todo')];
  const L = DG.layoutTask(task(steps));
  assert.deepEqual(L.boxes.map(b => b.short), ['s1', 's2'], 'the history step is not a flow box');
  assert.deepEqual(byShort(L).s1.index, 2, 'the Steps list numbers it 2 (the history step is row 1)');
  assert.equal(L.history.collapsed, true, 'collapsed by default');
  assert.equal(L.history.count, 2);
  assert.deepEqual(L.history.lines, ['01/10 · a · x', '02/10 · b · y'], 'blank lines dropped, edges trimmed');
  const open = DG.layoutTask(task(steps), { historyOpen: true });
  assert.equal(open.history.collapsed, false, 'opening keeps every line');
  assert.equal(open.history.lines.length, 2);
  assert.equal(DG.layoutTask(task([step('lich-su', 'build', 'done')])).empty, true, 'history only: no flow');
  assert.equal(DG.layoutTask(task([step('lich-su', 'build', 'done')])).history.count, 0);
});

test('lich-su: the page shows at most 50 lines and says how many are left', () => {
  assert.match(APP, /const DIAGRAM_HISTORY_SHOWN = 50;/);
  assert.match(APP, /h\.lines\.slice\(0, DIAGRAM_HISTORY_SHOWN\)/);
  assert.match(APP, /t\('diagram\.historyMore', \{ n: more \}\)/);
});

test('labels: two lines at most, a cut label ends with an ellipsis instead of hiding the rest', () => {
  assert.deepEqual(DG.wrapLabel('Plan the thing'), ['Plan the thing']);
  assert.deepEqual(DG.wrapLabel('Owner signs off on the whole deliverable now'), ['Owner signs off', 'on the…']);
  assert.deepEqual(DG.wrapLabel(''), ['']);
  assert.deepEqual(DG.wrapLabel('   '), ['']);
  const L = DG.layoutTask(task([step('s1', 'build', 'todo', { label: 'a'.repeat(10) + ' ' + 'b'.repeat(10) + ' ' + 'c'.repeat(10) + ' more words' })]));
  assert.equal(L.boxes[0].labelLines.length, 2);
  assert.match(L.boxes[0].labelLines[1], /…$/);
});

test('health colouring: the task health, grey for paused, closed, unknown or missing', () => {
  assert.equal(DG.healthClass({ health: 'green' }), 'green');
  assert.equal(DG.healthClass({ health: 'yellow' }), 'yellow');
  assert.equal(DG.healthClass({ health: 'red' }), 'red');
  assert.equal(DG.healthClass({ health: 'grey' }), 'grey');
  assert.equal(DG.healthClass({ health: 'red', status: 'paused' }), 'grey', 'paused is parked, not in trouble');
  assert.equal(DG.healthClass({ health: 'green', status: 'closed' }), 'grey', 'closed is history');
  assert.equal(DG.healthClass({ health: 'purple' }), 'grey', 'a health this build does not know stays neutral');
  assert.equal(DG.healthClass({}), 'grey');
  assert.equal(DG.healthClass(null), 'grey');
  assert.equal(DG.healthClass({ health: 'red', status: 'waiting' }), 'red', 'waiting is still its own health');
});

test('health counts: one per health, the total, and the owner-wait count is a plain non-negative integer', () => {
  const counts = DG.healthCounts([{ health: 'green' }, { health: 'red' }, { health: 'red', status: 'paused' }, { health: 'yellow' }], 2);
  assert.deepEqual(counts, { green: 1, yellow: 1, red: 1, grey: 1, waiting: 2, total: 4 });
  assert.equal(DG.healthCounts([]).total, 0);
  assert.equal(DG.healthCounts([], -3).waiting, 0, 'never a negative count');
  assert.equal(DG.healthCounts([], 'nonsense').waiting, 0);
  assert.equal(DG.healthCounts([], 2.7).waiting, 2);
});

test('map groups: one column per lane in the order the server sent the tasks', () => {
  const groups = DG.mapGroups([{ id: 'A', lane: 'web' }, { id: 'B', lane: 'api' }, { id: 'C', lane: 'web' }, { id: 'D' }]);
  assert.deepEqual(groups.map(g => [g.lane, g.tasks.map(t => t.id)]), [['web', ['A', 'C']], ['api', ['B']], ['', ['D']]]);
  assert.deepEqual(DG.mapGroups(null), []);
});

test('shortId: the step id without its task prefix, for names that already carry the prefix', () => {
  assert.equal(DG.shortId('T-1/s3'), 's3');
  assert.equal(DG.shortId('s3'), 's3');
  assert.equal(DG.shortId(undefined), '');
  assert.equal(DG.HISTORY_ID, 'lich-su');
});

// ---- the words the diagram prints: a one-step lane says "1 step", and the VI view has no English left ----
const LOC = Object.fromEntries(['en', 'vi', 'zh'].map(l => [l, JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'locales', `${l}.json`), 'utf8'))]));
const lift = name => {
  const line = APP.match(new RegExp(`^const ${name} = .*;$`, 'm'));
  if (line) return line[0];
  const start = APP.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `app.js has no ${name}`);
  return APP.slice(start, APP.indexOf('\n}\n', start) + 2);
};
function labels(lang) {
  const ctx = vm.createContext({ S: { dict: LOC[lang], en: LOC.en }, DG,
    esc: s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]) });
  vm.runInContext(['t', 'DIAGRAM_HISTORY_SHOWN', 'diagramLaneTags', 'diagramHistory', 'diagramSvg'].map(lift).join('\n'), ctx);
  return (fn, ...args) => vm.runInContext(`${fn}(${args.map(a => JSON.stringify(a)).join(', ')})`, ctx);
}

test('labels: a lane count has a singular, so a one-step lane reads "1 step" (the "1 steps" the shots caught)', () => {
  const L = DG.layoutTask(task([step('s1', 'plan', 'todo'), step('s2', 'build', 'todo'), step('s3', 'build', 'todo')]));
  const html = labels('en')('diagramLaneTags', L);
  assert.match(html, />Plan</);
  assert.match(html, />1 step</, 'one step, not "1 steps"');
  assert.match(html, />2 steps</);
  assert.doesNotMatch(html, /1 steps\b/);
  const vi = labels('vi')('diagramLaneTags', L);
  assert.match(vi, />Kế hoạch</);
  assert.match(vi, />1 bước</);
  assert.doesNotMatch(vi, /\b(step|steps|Plan|Build)\b/);
});

test('labels: the merged history count has a singular too, and reads in VI', () => {
  const one = { id: 'T-1/lich-su', short: 'lich-su', lines: ['01/09 · old'], count: 1, collapsed: true };
  const many = { ...one, lines: Array.from({ length: 60 }, (_, i) => `01/09 · old ${i}`), count: 60 };
  assert.match(labels('en')('diagramHistory', task([]), one), />1 old step</);
  assert.match(labels('en')('diagramHistory', task([]), many), />60 old steps</);
  assert.match(labels('vi')('diagramHistory', task([]), one), />1 bước cũ</, 'VI never needs the plural key, but must not fall back to English');
});

// A two-line clamp is only acceptable when the whole title is one hover away: the box shows "on the…" and the
// tooltip must say what "…" stands for (the owner hit this on "Owner signs off on the…").
test('hover: a clamped box carries the whole step title in its <title>, and so does the clamped Home map card', () => {
  const long = 'Owner signs off on the whole deliverable now';
  const t1 = task([step('s1', 'owner', 'waiting', { label: long })]);
  const L = DG.layoutTask(t1);
  assert.equal(L.boxes[0].label, long, 'the geometry keeps the full label beside the two clamped lines');
  assert.deepEqual(L.boxes[0].labelLines, ['Owner signs off', 'on the…'], 'the on-screen clamp is unchanged');
  const svg = labels('en')('diagramSvg', t1, L);
  assert.ok(svg.includes(`<title>${long} — Owner · Waiting · You</title>`), 'the tooltip is the full title plus zone/state');
  assert.match(svg, />on the…<\/text>/, 'the box still clamps, so the layout does not grow');
  assert.doesNotMatch(svg, /<title>[^<]*…/, 'the tooltip never carries the ellipsis');
  // the Home map: the task title and the clamped current-step line both keep their full text on hover
  assert.match(APP, /class="diag-task-title" title="\$\{esc\(task\.title\)\}"/, 'the map card title tooltip');
  assert.match(APP, /class="diag-task-now" title="\$\{esc\(cur\)\}"/, 'the map card current step tooltip');
  assert.match(APP, /class="diag-row-now muted" title="\$\{esc\(cur\)\}"/, 'the list row current step tooltip');
});
