// J-05 24-10 (anh): the Diagram tab must show the PRODUCT's structure (features, user flow, MCP), not the plan steps.
// task.architecture = { format:'graph', groups, nodes, edges }. Covers: the validator (a hostile source is refused whole),
// the layout, the tab's two sections and empty state (vi/en/zh), the board write path (ops + the predecessor push) and the CSP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import '../public/diagram.js';
import { validateArchitecture, normalizeArchitecture, ARCH_LIMITS } from '../src/architecture.mjs';
import { s21Board, row, step } from './s21-helpers.mjs';

const DG = globalThis.LaneDiagram;
const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const APP = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');
const CSS = fs.readFileSync(path.join(PUB, 'styles.css'), 'utf8');
const LOC = Object.fromEntries(['en', 'vi', 'zh'].map(l => [l, JSON.parse(fs.readFileSync(path.join(PUB, 'locales', `${l}.json`), 'utf8'))]));
const escHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function lift(name) {
  const line = APP.match(new RegExp(`^const ${name} = .*;$`, 'm'));
  if (line) return line[0];
  const start = APP.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `app.js has no ${name}`);
  return APP.slice(start, APP.indexOf('\n}\n', start) + 2);
}

/** The V-03 shape anh asked for: the studio's functions, the user flow, the MCP side. */
const V03 = {
  format: 'graph',
  groups: [{ id: 'studio', label: 'Studio · chức năng' }, { id: 'flow', label: 'Luồng người dùng' }, { id: 'mcp', label: 'MCP' }],
  nodes: [
    { id: 'brief', label: 'Nhập brief', group: 'flow' }, { id: 'script', label: 'Soạn kịch bản', sub: 'AI viết, anh sửa', group: 'studio' },
    { id: 'voice', label: 'Giọng đọc', group: 'studio' }, { id: 'render', label: 'Dựng video', group: 'studio' }, { id: 'publish', label: 'Đăng', group: 'flow' },
    { id: 'tools', label: 'MCP tools', sub: 'trình duyệt, tệp', group: 'mcp' }
  ],
  edges: [{ from: 'brief', to: 'script' }, { from: 'script', to: 'voice' }, { from: 'voice', to: 'render' }, { from: 'render', to: 'publish', label: 'xong' },
    { from: 'script', to: 'tools', dashed: true }, { from: 'tools', to: 'script', label: 'trả kết quả' }]
};
const clone = o => JSON.parse(JSON.stringify(o));
const bad = (mut, re) => { const a = clone(V03); mut(a); const e = validateArchitecture(a); assert.ok(e.length, 'refused'); if (re) assert.match(e.join('\n'), re); };

test('the page scripts still parse (the lifted-function tests never compile the whole file)', () => {
  for (const f of ['app.js', 'diagram.js']) assert.doesNotThrow(() => new vm.Script(fs.readFileSync(path.join(PUB, f), 'utf8'), { filename: f }), f);
});

// ---------------- validator ----------------
test('validator: the V-03 sample is valid and normalises to the same shape', () => {
  assert.deepEqual(validateArchitecture(V03), []);
  const n = normalizeArchitecture({ ...V03, nodes: V03.nodes.map(x => ({ ...x, label: `  ${x.label}  ` })) });
  assert.equal(n.ok, true); assert.deepEqual(n.value, V03, 'labels trimmed, nothing else changed');
  assert.deepEqual(validateArchitecture({ format: 'graph', nodes: [{ id: 'a', label: 'Một mình' }] }), [], 'groups and edges are optional');
});

test('validator: a hostile or malformed source is refused whole (HTML, script, mermaid, control chars, caps, references)', () => {
  bad(a => { a.nodes[0].label = '<img src=x onerror=alert(1)>'; }, /plain text/);
  bad(a => { a.nodes[0].label = '<script>alert(1)</script>'; }, /plain text/);
  bad(a => { a.nodes[0].sub = 'ok </svg><script>x</script>'; }, /plain text/);
  bad(a => { a.groups[0].label = 'a>b'; }, /plain text/);
  bad(a => { a.edges[0].label = '<b>x</b>'; }, /plain text/);
  bad(a => { a.nodes[0].label = 'dòng một\ndòng hai'; }, /one line/);
  bad(a => { a.nodes[0].label = 'x\u2028y'; }, /one line/);
  bad(a => { a.nodes[0].label = 'x\u0000y'; }, /one line/);
  bad(a => { a.nodes[0].label = 'x'.repeat(ARCH_LIMITS.label + 1); }, /longer than/);
  bad(a => { a.nodes[0].label = '   '; }, /must not be empty/);
  bad(a => { a.format = 'mermaid'; a.source = 'graph TD; A-->B'; }, /mermaid/);
  bad(a => { delete a.format; }, /format/);
  bad(a => { a.onclick = 'x'; }, /unknown key "onclick"/);
  bad(a => { a.nodes[0].href = 'javascript:alert(1)'; }, /unknown key "href"/);
  bad(a => { a.nodes[0].id = '__proto__'; }, /id must match/);
  bad(a => { a.nodes[0].id = 'A B'; }, /id must match/);
  bad(a => { a.nodes[1].id = a.nodes[0].id; }, /used twice/);
  bad(a => { a.nodes[0].group = 'nope'; }, /not a declared group/);
  bad(a => { a.edges[0].to = 'ghost'; }, /not a node id/);
  bad(a => { a.edges[0].to = a.edges[0].from; }, /itself/);
  bad(a => { a.edges[0].dashed = 'yes'; }, /true or false/);
  bad(a => { a.nodes = []; }, /at least one node/);
  bad(a => { a.nodes = Array.from({ length: ARCH_LIMITS.nodes + 1 }, (_, i) => ({ id: 'n' + i, label: 'x' })); a.edges = []; a.groups = []; }, /more than 40/);
  bad(a => { a.edges = Array.from({ length: ARCH_LIMITS.edges + 1 }, () => ({ from: 'brief', to: 'script' })); }, /more than 80/);
  bad(a => { a.nodes = Array.from({ length: 40 }, (_, i) => ({ id: 'n' + i, label: 'Đ'.repeat(60), sub: 'Đ'.repeat(100) })); a.groups = []; a.edges = []; }, /larger than/);
  for (const v of [null, 'graph TD', 42, [], true]) assert.ok(validateArchitecture(v).length, `${JSON.stringify(v)} refused`);
  assert.ok(validateArchitecture({ format: 'graph', nodes: 'x' }).length);
  assert.ok(validateArchitecture({ format: 'graph', nodes: [null] }).length);
});

// ---------------- layout ----------------
test('layout: groups are lanes in declaration order, columns follow the flow, a cycle is a dashed back edge', () => {
  const L = DG.layoutArchitecture(V03);
  assert.deepEqual(L.lanes.map(l => l.label), ['Studio · chức năng', 'Luồng người dùng', 'MCP']);
  const at = Object.fromEntries(L.nodes.map(n => [n.id, n]));
  assert.ok(at.brief.x < at.script.x && at.script.x < at.voice.x && at.voice.x < at.render.x && at.render.x < at.publish.x, 'left to right along the flow');
  assert.ok(at.script.y < at.brief.y && at.brief.y < at.tools.y, 'a node sits in its own lane');
  const back = L.edges.find(e => e.from === 'tools' && e.to === 'script');
  assert.equal(back.back, true); assert.equal(back.dashed, true);
  assert.equal(L.edges.find(e => e.from === 'script' && e.to === 'tools').dashed, true, 'an authored dashed edge');
  assert.equal(L.edges.find(e => e.from === 'brief').dashed, false);
  for (const n of L.nodes) assert.ok(n.x >= 0 && n.y >= 0 && n.x + n.w <= L.width && n.y + n.h <= L.height, `${n.id} inside the canvas`);
  for (const e of L.edges) for (const num of e.d.match(/-?\d+(\.\d+)?/g).map(Number)) assert.ok(num >= 0, 'no path leaves the canvas at the top/left');
  assert.deepEqual(DG.layoutArchitecture(V03), L, 'same input, same geometry');
});

test('layout: nodes of the same lane and column stack; a node with no group goes to the last lane; odd input never throws', () => {
  const L = DG.layoutArchitecture({ groups: [{ id: 'g', label: 'G' }], nodes: [{ id: 'a', label: 'A', group: 'g' }, { id: 'b', label: 'B', group: 'g' }, { id: 'c', label: 'C' }, { id: 'd', label: 'D', group: 'gone' }], edges: [] });
  const at = Object.fromEntries(L.nodes.map(n => [n.id, n]));
  assert.equal(at.a.x, at.b.x); assert.ok(at.b.y > at.a.y, 'stacked');
  assert.deepEqual(L.lanes.map(l => l.id), ['g', '']);
  assert.equal(at.c.lane, ''); assert.equal(at.d.lane, '');
  for (const odd of [undefined, null, {}, { nodes: 'x' }, { nodes: [null, 1, { id: 5 }] }, { nodes: [{ id: 'a', label: 'A' }], edges: [{ from: 'a', to: 'zzz' }, null, { from: 'a', to: 'a' }] }]) {
    const r = DG.layoutArchitecture(odd);
    assert.equal(typeof r.empty, 'boolean');
  }
  assert.equal(DG.layoutArchitecture(null).empty, true);
  const one = DG.layoutArchitecture({ nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }] });
  assert.equal(one.edges.filter(e => e.back).length, 1, 'a two-node cycle has exactly one back edge');
});

// ---------------- the tab ----------------
function page(lang, task, kind) {
  const S = { dict: LOC[lang], en: LOC.en, open: {}, diagramFull: kind ? { taskId: task.id, kind, zoom: 1 } : null };
  const ctx = vm.createContext({ S, DG, esc: escHtml, TASK: task });
  vm.runInContext(['t', 'DIAGRAM_HISTORY_SHOWN', 'diagramLaneTags', 'diagramHistory', 'diagramSvg', 'architectureBlock', 'architectureFullButton', 'architectureSvg', 'planFlowBlock', 'diagramPanel', 'diagramFullHtml', 'diagramFullSig'].map(lift).join('\n'), ctx);
  return vm.runInContext(kind ? 'diagramFullHtml(TASK)' : 'diagramPanel(TASK)', ctx);
}
const T = extra => ({ id: 'V-03', title: 'Studio', health: 'green', steps: [{ id: 'V-03/s1', label: 'Bước một', zone: 'plan', state: 'done' }, { id: 'V-03/s2', label: 'Chờ anh duyệt', zone: 'owner', state: 'waiting' }], current_step: null, ...extra });

test('tab: the structure diagram is the FIRST section, the plan steps follow under "Các bước kế hoạch"', () => {
  const html = page('vi', T({ architecture: V03 }));
  const iArch = html.indexOf('Sơ đồ cấu trúc'), iSteps = html.indexOf('Các bước kế hoạch');
  assert.ok(iArch >= 0 && iSteps > iArch, 'structure heading first, plan heading after it');
  assert.match(html, /<svg class="arch-svg[ "]/);
  for (const w of ['Soạn kịch bản', 'Giọng đọc', 'MCP tools', 'Luồng người dùng', 'xong', 'trả kết quả']) assert.ok(html.includes(w), w);
  assert.ok(html.indexOf('arch-svg') < html.indexOf('Các bước kế hoạch') && html.indexOf('diag-svg') > html.indexOf('Các bước kế hoạch'), 'the step flow svg is under the plan heading');
  assert.ok(html.includes('Chờ anh duyệt'), 'the plan steps are still drawn');
  assert.doesNotMatch(html, /Chưa có sơ đồ cấu trúc/);
  assert.equal((html.match(/<h3>/g) || []).length, 2);
});

test('tab: no architecture shows "Chưa có sơ đồ cấu trúc" and still the plan steps; no steps and no architecture shows both empties', () => {
  const html = page('vi', T());
  assert.ok(html.includes('Chưa có sơ đồ cấu trúc'));
  assert.doesNotMatch(html, /arch-svg/);
  assert.ok(html.indexOf('Chưa có sơ đồ cấu trúc') < html.indexOf('Các bước kế hoạch'));
  assert.ok(html.includes('Chờ anh duyệt'));
  const none = page('vi', { id: 'E-1', title: 'E', steps: [] });
  assert.ok(none.includes('Chưa có sơ đồ cấu trúc') && none.includes(LOC.vi['diagram.empty']));
  for (const k of [null, {}, { format: 'graph', nodes: [] }]) assert.ok(page('vi', T({ architecture: k })).includes('Chưa có sơ đồ cấu trúc'), JSON.stringify(k));
});

test('tab: the section names exist in every locale and read as the owner asked', () => {
  assert.equal(LOC.vi['diagram.arch.title'], 'Sơ đồ cấu trúc');
  assert.equal(LOC.vi['diagram.arch.empty'], 'Chưa có sơ đồ cấu trúc');
  assert.equal(LOC.vi['diagram.steps.title'], 'Các bước kế hoạch');
  for (const l of ['en', 'zh']) for (const k of ['diagram.arch.title', 'diagram.arch.empty', 'diagram.arch.aria', 'diagram.arch.noGroup', 'diagram.steps.title']) assert.ok(LOC[l][k], `${l} ${k}`);
  assert.ok(page('en', T({ architecture: V03 })).includes('Structure diagram'));
  assert.ok(page('zh', T()).includes(LOC.zh['diagram.arch.empty']));
});

test('tab: author text is only ever escaped text; the markup carries no script, handler, style attribute or foreignObject (the CSP blocks inline style)', () => {
  // The server refuses these; the page must also be safe on a value that slipped in (an older row, a hand-edited state).
  const evil = { format: 'graph', groups: [{ id: 'g', label: '<b onmouseover=alert(1)>G</b>' }], nodes: [{ id: 'a', label: '<img src=x onerror=alert(1)>', sub: '"><script>alert(2)</script>', group: 'g' }, { id: 'b', label: "' onload='x" }], edges: [{ from: 'a', to: 'b', label: '</text><script>alert(3)</script>' }] };
  const html = page('vi', T({ architecture: evil }));
  assert.doesNotMatch(html, /<script|<img|<b /i);
  assert.doesNotMatch(html, /<[^>]*\son\w+=/i, 'no inline event handler attribute');
  assert.doesNotMatch(html, /foreignObject|javascript:/i);
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;') || html.includes('&lt;img'), 'shown as text');
  const arch = html.slice(html.indexOf('<svg class="arch-svg'), html.indexOf('</svg>') + 6);
  assert.doesNotMatch(arch, /\sstyle=/, 'geometry is attributes, colour is classes');
});

test('tab: the structure diagram has its own Xem full button (the column is narrow); the dialog draws the structure, the step flow keeps its own', () => {
  const html = page('vi', T({ architecture: V03 }));
  assert.match(html, /<button type="button" class="btn diag-full-btn" data-action="diagram-full" data-kind="arch" data-task="V-03" aria-haspopup="dialog">Xem full<\/button>/);
  assert.match(html, /data-action="diagram-full" data-task="V-03"/, 'the step flow keeps its own button, without a kind');
  assert.doesNotMatch(page('vi', T()), /data-kind="arch"/, 'no diagram, nothing to open');
  const arch = page('vi', T({ architecture: V03 }), 'arch'), steps = page('vi', T({ architecture: V03 }), 'steps');
  assert.match(arch, /arch-svg/); assert.doesNotMatch(arch, /diag-svg/);
  assert.match(steps, /diag-svg/); assert.doesNotMatch(steps, /arch-svg/);
  assert.ok(APP.includes("const kind = b.dataset.kind === 'arch' ? 'arch' : 'steps';"));
});

test('css: the structure diagram styles exist and use tokens, never a fixed colour or an inline style', () => {
  for (const sel of ['.arch-svg', '.alane', '.aedge', '.anode .abox', '.anode-t']) assert.ok(CSS.includes(sel), sel);
  const block = CSS.slice(CSS.indexOf('.arch-scroll'), CSS.indexOf('.anode-s'));
  assert.doesNotMatch(block, /#[0-9a-f]{3,8}\b|rgb\(/i, 'tokens only');
});

// ---------------- the board ----------------
test('board: task.create / task.update carry the diagram, refuse a bad one with 400 bad_architecture, and null clears it', async () => {
  const s = await s21Board();
  try {
    s.w('task.create', 'V-03', { title: 'Studio', lane: 'Workerb', steps: [step('s1', 'todo')], architecture: V03 });
    assert.deepEqual(s.board.state.tasks['V-03'].architecture, V03);
    assert.throws(() => s.w('task.create', 'V-04', { title: 'x', lane: 'Workerb', steps: [], architecture: { ...V03, nodes: [{ id: 'a', label: '<script>x</script>' }], edges: [], groups: [] } }), e => e.status === 400 && e.code === 'bad_architecture' && /plain text/.test(e.extra.message));
    assert.equal(s.board.state.tasks['V-04'], undefined, 'nothing written');
    const t = () => s.board.state.tasks['V-03'];
    s.w('task.update', 'V-03', { architecture: { format: 'graph', nodes: [{ id: 'z', label: 'Mới' }] } }, { expected_revision: t().rev });
    assert.equal(t().architecture.nodes[0].label, 'Mới');
    assert.throws(() => s.w('task.update', 'V-03', { architecture: { format: 'mermaid', source: 'graph TD;A-->B' } }, { expected_revision: t().rev }), e => ['invalid_data', 'bad_architecture'].includes(e.code), 'the schema (format enum) or the semantic check refuses it');
    assert.equal(t().architecture.nodes[0].label, 'Mới', 'a refused update changed nothing');
    s.w('task.update', 'V-03', { title: 'Studio 2' }, { expected_revision: t().rev });
    assert.ok(t().architecture, 'an update without the field keeps it');
    s.w('task.update', 'V-03', { architecture: null }, { expected_revision: t().rev });
    assert.equal('architecture' in t(), false, 'null removes the key');
    // the v1 projection is schema-valid with and without it (the contract test validates tasks against schema/v1/task.json)
    s.w('task.update', 'V-03', { architecture: V03 }, { expected_revision: t().rev });
    const st = await s.v1state(); const v1t = [].concat(Array.isArray(st.tasks) ? st.tasks : Object.values(st.tasks)).find(x => x.id === 'V-03'); assert.deepEqual(v1t.architecture, V03);
  } finally { await s.close(); }
});

test('board: the predecessor push sets, keeps and clears the diagram; a bad one refuses the whole push before any write', async () => {
  const s = await s21Board();
  try {
    const mk = extra => row('V-03', 'Workerb', [step('s1', 'active')], { title: 'Studio', now: 'đang làm', ...extra });
    let r = await s.push([mk({ architecture: V03 }), row('K-1', 'Workerb', [step('k1', 'active')], { order: 2 })]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(s.board.state.tasks['V-03'].architecture, V03);
    assert.deepEqual((await s.code('V-03', 2)).architecture, V03, 'the page reads it from /api/state?v=2');
    assert.equal((await s.code('K-1', 2)).architecture, undefined, 'a task without one has no key');
    // a row written before the field existed must not wipe it
    r = await s.push([mk({ now: 'vẫn làm' })]);
    assert.equal(r.status, 200); assert.deepEqual(s.board.state.tasks['V-03'].architecture, V03, 'absent = keep');
    // a hostile one: 400, nothing of the push lands (the other row's change included)
    const seq = s.board.state.seq;
    r = await s.push([row('K-1', 'Workerb', [step('k1', 'active')], { order: 2, now: 'đổi' }), mk({ architecture: { ...V03, nodes: [{ id: 'a', label: '<img src=x onerror=1>' }], groups: [], edges: [] } })]);
    assert.equal(r.status, 400, JSON.stringify(r.body)); assert.equal(r.body.error, 'bad_architecture'); assert.equal(r.body.task, 'V-03');
    assert.equal(s.board.state.seq, seq, 'nothing written'); assert.deepEqual(s.board.state.tasks['V-03'].architecture, V03);
    r = await s.push([mk({ architecture: { format: 'mermaid', source: 'graph TD; A-->B' } })]);
    assert.equal(r.status, 400); assert.equal(r.body.error, 'bad_architecture');
    // replace, then clear with null
    const v2 = { format: 'graph', nodes: [{ id: 'n', label: 'Khác' }] };
    r = await s.push([mk({ architecture: v2 })]); assert.equal(r.status, 200);
    assert.deepEqual(s.board.state.tasks['V-03'].architecture, v2);
    r = await s.push([mk({ architecture: null })]); assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal('architecture' in s.board.state.tasks['V-03'], false);
  } finally { await s.close(); }
});

// ---------------- the inline preview fits the narrow tab column (review S2) ----------------
test('compact layout: ALL nodes are inside a canvas about as wide as its lanes (not its columns); every edge is drawn; same input, same geometry', () => {
  const L = DG.layoutArchitecture(V03, { compact: true }), W = DG.layoutArchitecture(V03);
  assert.equal(L.compact, true); assert.equal(L.nodes.length, W.nodes.length); assert.equal(L.edges.length, W.edges.length);
  assert.ok(L.width < W.width / 1.5, `the top-down canvas is much narrower (${L.width} vs ${W.width})`);
  assert.ok(L.width <= 3 * 150 + 2 * 4 + 16 + 20, 'width = lanes x band, whatever the number of columns');
  for (const n of L.nodes) assert.ok(n.x >= 0 && n.y >= 0 && n.x + n.w <= L.width && n.y + n.h <= L.height, `${n.id} inside the canvas`);
  const at = Object.fromEntries(L.nodes.map(n => [n.id, n]));
  assert.ok(at.brief.y < at.script.y && at.script.y < at.voice.y && at.voice.y < at.render.y && at.render.y < at.publish.y, 'top to bottom along the flow');
  for (const lane of L.lanes) for (const n of L.nodes.filter(x => x.lane === lane.id)) assert.ok(n.x >= lane.x && n.x + n.w <= lane.x + lane.w, `${n.id} sits in its own band`);
  for (const e of L.edges) for (const num of e.d.match(/-?\d+(\.\d+)?/g).map(Number)) assert.ok(num >= 0 && num <= Math.max(L.width, L.height), 'no path leaves the canvas');
  assert.equal(L.edges.filter(e => e.back).length, W.edges.filter(e => e.back).length, 'the same cycle is a back edge');
  assert.deepEqual(DG.layoutArchitecture(V03, { compact: true }), L);
  assert.deepEqual(DG.layoutArchitecture(V03), W, 'the default (full view) layout is unchanged by the option');
  for (const odd of [null, {}, { nodes: [{ id: 'a', label: 'A' }], edges: [{ from: 'a', to: 'zzz' }] }]) assert.equal(typeof DG.layoutArchitecture(odd, { compact: true }).empty, 'boolean');
});

test('fitWidth: the column width, never wider than natural, never below the readable floor; no measurement = natural', () => {
  assert.equal(DG.fitWidth(468, 278), 278);
  assert.equal(DG.fitWidth(468, 339), 339);
  assert.equal(DG.fitWidth(468, 900), 468, 'no upscaling');
  assert.equal(DG.fitWidth(1000, 278), Math.round(1000 * DG.FIT_MIN_SCALE), 'many lanes: stop at the floor, the scroller takes the rest');
  assert.equal(DG.fitWidth(468, 0), 468); assert.equal(DG.fitWidth(468, NaN), 468); assert.equal(DG.fitWidth(0, 300), 0);
  // at the narrowest realistic column the preview's smallest scaled text stays readable
  const L = DG.layoutArchitecture(V03, { compact: true });
  const scale = DG.fitWidth(L.width, 278) / L.width;
  assert.ok(scale * 13.5 >= 7.5 && scale * 16 >= 8.8, `scale ${scale.toFixed(2)}: sub text ${(scale * 13.5).toFixed(1)} px, title ${(scale * 16).toFixed(1)} px`);
});

test('tab: the inline preview is the compact fit SVG (data-w/h for the fit), the full view keeps the natural left-to-right one', () => {
  const tab = page('vi', T({ architecture: V03 })), full = page('vi', T({ architecture: V03 }), 'arch');
  const svg = h => h.slice(h.indexOf('<svg class="arch-svg'), h.indexOf('</svg>') + 6);
  assert.match(svg(tab), /^<svg class="arch-svg compact fit" width="\d+" height="\d+" viewBox="0 0 (\d+) (\d+)" data-w="\1" data-h="\2"/);
  assert.match(svg(full), /^<svg class="arch-svg" width="\d+"/);
  assert.doesNotMatch(svg(full), /compact|data-w/);
  assert.ok(Number(/data-w="(\d+)"/.exec(svg(tab))[1]) < Number(/width="(\d+)"/.exec(svg(full))[1]), 'the preview canvas is narrower than the full one');
  for (const w of ['Soạn kịch bản', 'Giọng đọc', 'MCP tools']) assert.ok(svg(tab).includes(w) || svg(tab).includes(w.split(' ')[0]), w + ' is in the preview');
  assert.doesNotMatch(svg(tab), /\sstyle=/);
  assert.match(APP, /fitArchitecture\(\);\n\}/, 'the fit runs after every render');
  assert.match(CSS, /\.arch-svg\.compact \.anode-t \{ font-size: 16px/);
});

// ---------------- the compact preview never draws an edge under a box (delta review F1-F3) ----------------
// An edge is a polyline (e.pts) of axis-parallel segments; it must not enter the interior of ANY box (its own ends included),
// and no edge label may sit on a box. Parallel branches therefore read as parallel.
const segHitsBox = ([[x1, y1], [x2, y2]], n) => Math.max(Math.min(x1, x2), n.x + 0.5) < Math.min(Math.max(x1, x2), n.x + n.w - 0.5) && Math.max(Math.min(y1, y2), n.y + 0.5) < Math.min(Math.max(y1, y2), n.y + n.h - 0.5)
  || (x1 === x2 && x1 > n.x + 0.5 && x1 < n.x + n.w - 0.5 && Math.max(Math.min(y1, y2), n.y + 0.5) < Math.min(Math.max(y1, y2), n.y + n.h - 0.5))
  || (y1 === y2 && y1 > n.y + 0.5 && y1 < n.y + n.h - 0.5 && Math.max(Math.min(x1, x2), n.x + 0.5) < Math.min(Math.max(x1, x2), n.x + n.w - 0.5));
const labelBox = e => { const w = String(e.label).length * 6.9, x = e.anchor === 'start' ? e.lx : e.anchor === 'end' ? e.lx - w : e.lx - w / 2; return { x, y: e.ly - 10, w, h: 13 }; };
const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
function assertClean(arch, what) {
  const L = DG.layoutArchitecture(arch, { compact: true });
  for (const e of L.edges) {
    assert.ok(e.pts.length >= 2, `${what}: ${e.from}->${e.to} has a path`);
    for (let i = 1; i < e.pts.length; i++) {
      const seg = [e.pts[i - 1], e.pts[i]];
      assert.ok(seg[0][0] === seg[1][0] || seg[0][1] === seg[1][1], `${what}: ${e.from}->${e.to} segment ${i} is axis-parallel`);
      for (const n of L.nodes) assert.ok(!segHitsBox(seg, n), `${what}: edge ${e.from}->${e.to} passes under box ${n.id}`);
      for (const p of seg) assert.ok(p[0] >= 0 && p[0] <= L.width && p[1] >= 0 && p[1] <= L.height, `${what}: ${e.from}->${e.to} stays in the canvas`);
    }
    const last = e.pts[e.pts.length - 1], to = L.nodes.find(n => n.id === e.to);
    assert.ok(last[0] >= to.x && last[0] <= to.x + to.w && (last[1] === to.y || last[0] === to.x + to.w), `${what}: ${e.from}->${e.to} ends on its target`);
    if (e.label) { const lb = labelBox(e); for (const n of L.nodes) assert.ok(!overlap(lb, n), `${what}: label "${e.label}" sits on box ${n.id}`); assert.ok(lb.x >= 0 && lb.x + lb.w <= L.width, `${what}: label "${e.label}" inside the canvas`); }
  }
  return L;
}
test('compact layout: no edge passes under a box, no label sits on a box (the sample, a diamond in one lane, a wide fan-out, a cycle through stacked siblings)', () => {
  const L = assertClean(V03, 'V03');
  assert.equal(L.edges.length, V03.edges.length);
  const N = (id, group, label = id) => ({ id, label, group });
  assertClean({ groups: [{ id: 'g', label: 'G' }], nodes: ['s', 'a', 'b', 'c', 'd', 'j'].map(i => N(i, 'g')), edges: [['s', 'a'], ['s', 'b'], ['s', 'c'], ['s', 'd'], ['a', 'j'], ['b', 'j'], ['c', 'j'], ['d', 'j']].map(([from, to]) => ({ from, to, label: 'x' + from })) }, 'fan-out');
  assertClean({ groups: [{ id: 'p', label: 'P' }, { id: 'q', label: 'Q' }], nodes: [N('a', 'p'), N('b', 'q'), N('c', 'q'), N('d', 'p'), N('e', 'q'), N('f', 'p')], edges: [{ from: 'a', to: 'b' }, { from: 'a', to: 'c', label: 'song song' }, { from: 'b', to: 'd' }, { from: 'c', to: 'e' }, { from: 'd', to: 'f' }, { from: 'e', to: 'f', label: 'gộp' }, { from: 'f', to: 'a', label: 'chưa đạt' }, { from: 'e', to: 'b', label: 'lại' }] }, 'cross-lane + cycles');
  // the sample's two parallel branches (Giọng đọc, Hình và cảnh) each have their own visible path from Soạn kịch bản
  const dg = L.edges.find(e => e.from === 'script' && e.to === 'voice'), dv = L.edges.find(e => e.from === 'script' && e.to === 'visual');
  if (dg && dv) assert.notDeepEqual(dg.pts, dv.pts);
});

test('compact layout: a two-line title leaves room above its sub-label (no overlap in the rendered node)', () => {
  const arch = { format: 'graph', groups: [{ id: 'g', label: 'G' }], nodes: [{ id: 'a', label: 'MCP trình duyệt', sub: 'lấy tư liệu', group: 'g' }, { id: 'b', label: 'Hai', sub: 'sub', group: 'g' }, { id: 'c', label: 'Chỉ tiêu đề dài hơn nữa', group: 'g' }], edges: [{ from: 'a', to: 'b' }] };
  const html = page('vi', T({ architecture: arch }));
  for (const id of ['a', 'b']) {
    const g = html.slice(html.indexOf(`<g class="anode" data-id="${id}"`)); const node = g.slice(0, g.indexOf('</g>'));
    const ys = re => [...node.matchAll(re)].map(m => Number(m[1]));
    const titles = ys(/class="anode-t"[^>]* y="([\d.]+)"/g), sub = ys(/class="anode-s"[^>]* y="([\d.]+)"/g)[0], top = Number(/class="abox" x="[\d.]+" y="([\d.]+)"/.exec(node)[1]);
    assert.ok(titles.length >= 1 && Number.isFinite(sub), `${id}: title and sub rendered`);
    assert.ok(titles[titles.length - 1] + 5 <= sub - 10, `${id}: last title baseline ${titles[titles.length - 1] - top} + descent clears the sub-label cap line (${sub - top - 10})`);
    assert.ok(sub <= top + 62 - 4, `${id}: sub-label inside the box`);
  }
});
