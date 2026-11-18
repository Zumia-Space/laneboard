// J-05: the Diagram tab opens the same workflow diagram full-window (the owner: "thêm nút xem Full … full diagram
// workflow"). The dialog is in-page (no popup: it runs inside the Zumi webview), draws the tab's own SVG renderer from
// one layout, pans by drag, zooms by wheel/pinch and the +/- buttons, fits, and closes on Esc or its close button.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import '../public/diagram.js';

const DG = globalThis.LaneDiagram;
const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const APP = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');
const LOC = Object.fromEntries(['en', 'vi', 'zh'].map(l => [l, JSON.parse(fs.readFileSync(path.join(PUB, 'locales', `${l}.json`), 'utf8'))]));
const escHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** A top-level `const name = ...;` line or `function name(...) {...}` block of app.js, verbatim. */
function lift(name) {
  const line = APP.match(new RegExp(`^const ${name} = .*;$`, 'm'));
  if (line) return line[0];
  const start = APP.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `app.js has no ${name}`);
  return APP.slice(start, APP.indexOf('\n}\n', start) + 2);
}
const step = (id, zone, state) => ({ id: 'T-1/' + id, label: id.toUpperCase(), zone, state });
const TASK = { id: 'T-1', title: 'Zumi board', health: 'green', steps: [step('s1', 'plan', 'done'), step('s2', 'build', 'done'), step('s3', 'owner', 'waiting')], current_step: { id: 'T-1/s3', label: 'S3', state: 'waiting' } };

/** The page functions under test, lifted into a vm: the real locales, the real diagram module. */
function page(lang = 'en', extra = {}) {
  const S = { dict: LOC[lang], en: LOC.en, open: {}, diagramFull: { taskId: 'T-1', zoom: 1 }, ...extra };
  const ctx = vm.createContext({ S, DG, esc: escHtml, TASK, ...extra });
  vm.runInContext(['t', 'DIAGRAM_HISTORY_SHOWN', 'diagramLaneTags', 'diagramHistory', 'diagramSvg', 'architectureBlock', 'architectureFullButton', 'architectureSvg', 'planFlowBlock', 'diagramPanel', 'diagramFullHtml', 'closeDiagramFull'].map(lift).join('\n'), ctx);
  return ctx;
}

test('the Diagram tab has a Xem full button', () => {
  for (const [lang, word] of [['vi', 'Xem full'], ['en', 'Full view'], ['zh', '全屏查看']]) {
    const html = vm.runInContext('diagramPanel(TASK)', page(lang));
    assert.match(html, /<button type="button" class="btn diag-full-btn" data-action="diagram-full" data-task="T-1" aria-haspopup="dialog">/, `${lang}: the full-view button`);
    assert.ok(html.includes(`>${word}</button>`), `${lang}: the button reads ${word}`);
  }
  // No flow, no full view: an empty task keeps its "no steps yet" line and offers nothing to open.
  const empty = vm.runInContext(`diagramPanel({ id: 'E-1', title: 'Empty', steps: [] })`, page('vi'));
  assert.doesNotMatch(empty, /data-action="diagram-full"/);
  assert.match(empty, new RegExp(LOC.vi['diagram.empty'].replace('.', '\\.')));
  // The click handler opens the dialog; the dialog itself never opens a browser window (it must stay in the webview).
  assert.match(APP, /if \(action === 'diagram-full'\) return openDiagramFull\(b\);/);
  assert.doesNotMatch(lift('openDiagramFull'), /window\.open\(/);
});

test('the modal opens with the same diagram nodes and closes on Esc', () => {
  const ctx = page('vi');
  const tabSvg = vm.runInContext('diagramSvg(TASK, DG.layoutTask(TASK))', ctx);
  const modal = vm.runInContext('diagramFullHtml(TASK)', ctx);
  assert.ok(modal.includes(tabSvg), 'the full view embeds the tab renderer output verbatim (same data, same layout)');
  const nodes = [...modal.matchAll(/<a class="dnode[^"]*" href="[^"]*[?&]step=([^"&]+)"/g)].map(m => decodeURIComponent(m[1]));
  assert.deepEqual(nodes, DG.layoutTask(TASK).boxes.map(b => b.short), 'every step box of the flow, in order');
  assert.equal((modal.match(/<a class="dnode /g) || []).length, TASK.steps.length, 'no node is dropped or duplicated');
  // The tab's merged-history chip travels with the flow too; a task without one leaves the slot empty.
  assert.match(modal, /<div class="dfv-hist"><\/div>/);
  const withHist = { ...TASK, steps: [{ id: 'T-1/lich-su', label: 'History', zone: 'build', state: 'done', detail: '01/09 · old · done' }, ...TASK.steps] };
  const histModal = vm.runInContext(`diagramFullHtml(${JSON.stringify(withHist)})`, page('vi'));
  assert.match(histModal, /data-action="diag-hist" data-task="T-1"/, 'the merged history chip is the tab\'s own control');
  assert.match(histModal, /Lịch sử \(gộp\)/, 'and it reads the page language');
  assert.match(APP, /el\.setAttribute\('role', 'dialog'\); el\.setAttribute\('aria-modal', 'true'\); el\.setAttribute\('aria-labelledby', 'dfv-title'\);/, 'a modal dialog named by the task title');
  assert.match(modal, /data-action="dfv-close"/);
  // Esc closes the dialog before any other Esc handler, and only while it is open.
  assert.match(APP, /if \(e\.key === 'Escape' && S\.diagramFull\) \{ e\.preventDefault\(\); return closeDiagramFull\(\); \}/);
  // Behaviour: close removes the body-level node, clears the state and returns focus to the opening button.
  const focused = { n: 0, focus() { this.n++; } }, removed = [];
  const closeCtx = vm.createContext({
    S: { diagramFull: { opener: focused, sel: '' } },
    document: { getElementById: id => ({ remove: () => removed.push(id) }), documentElement: { classList: { remove: () => {} } }, contains: () => true }
  });
  vm.runInContext(lift('closeDiagramFull'), closeCtx);
  vm.runInContext('closeDiagramFull()', closeCtx);
  assert.equal(closeCtx.S.diagramFull, null, 'the dialog state is cleared');
  assert.deepEqual(removed, ['diagram-full'], 'the dialog node is removed');
  assert.equal(focused.n, 1, 'focus returns to the button that opened it');
});

test('zoom stays within [0.25, 4]', () => {
  assert.equal(DG.ZOOM_MIN, 0.25);
  assert.equal(DG.ZOOM_MAX, 4);
  const clamp = z => DG.clampZoom(z);
  for (const z of [0.25, 0.5, 1, 2, 4]) assert.equal(clamp(z), z);
  assert.equal(clamp(0.01), 0.25, 'a tiny factor stops at the floor');
  assert.equal(clamp(99), 4, 'a huge factor stops at the ceiling');
  assert.equal(clamp(0), 1, 'zero is not a zoom');
  assert.equal(clamp('nonsense'), 1);
  assert.equal(clamp(NaN), 1);
  // Zooming about a point keeps that point still; the clamp holds through the same function the buttons/wheel use.
  const about = (view, next, cx, cy) => DG.zoomAbout(view, next, cx, cy);
  const start = { zoom: 1, x: 0, y: 0 };
  assert.deepEqual(about(start, 99, 100, 100), { zoom: 4, x: -300, y: -300 });
  assert.deepEqual(about(start, 0.0001, 50, 50), { zoom: 0.25, x: 37.5, y: 37.5 });
  assert.equal(about({ zoom: 2, x: 10, y: 20 }, 99, 0, 0).zoom, 4, 'never past 400% from any starting zoom');
  // The page uses those helpers: wheel, buttons and fit all pass through the one clamp.
  assert.match(APP, /Object\.assign\(s, DG\.zoomAbout\(s, next, cx, cy\)\)/);
  assert.match(APP, /s\.zoom \* Math\.exp\(-dy \* 0\.0015\)/);
  assert.match(APP, /s\.zoom = DG\.clampZoom\(Math\.min\(1, fit\)\)/, 'the fit scale is clamped too, and never blows a short flow up');
  assert.match(APP, /if \(action === 'dfv-fit'\) return fitDiagramFull\(\);/);
  // The controls are real buttons (keyboard reachable) and Esc's close is a visible button too.
  const modal = vm.runInContext('diagramFullHtml(TASK)', page('vi'));
  for (const action of ['dfv-zoom', 'dfv-fit', 'dfv-close']) assert.match(modal, new RegExp(`<button type="button" class="btn" data-action="${action}"`));
  assert.match(modal, /aria-label="Phóng to"/);
  assert.match(modal, /aria-label="Thu nhỏ"/);
});
