// public/splitters.js: the pure pane rules behind the adjustable liveboard layout (clamp, defaults, storage, migration).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../public/splitters.js';

const S = globalThis.LaneSplit, { PANES, DETAIL_MIN, STRIP } = S;

test('clamp: a drag stops at the pane minimum and maximum', () => {
  assert.equal(S.clampWidth('tasks', 10, 1600, 340), PANES.tasks.min, 'Tasks never under 150');
  assert.equal(S.clampWidth('tasks', 5000, 3000, 340), PANES.tasks.max, 'Tasks never over 760');
  assert.equal(S.clampWidth('inspector', 20, 1600, 256), PANES.inspector.min, 'Inspector never under 180');
  assert.equal(S.clampWidth('inspector', 5000, 3000, 256), PANES.inspector.max, 'Inspector never over 520');
});

test('clamp: a side pane grows only until Detail would fall under 320px', () => {
  const total = 1280, other = 340;
  const w = S.clampWidth('tasks', 900, total, other);
  assert.equal(total - w - other, DETAIL_MIN);
  const L = S.layout({ tasksW: 760, inspectorW: 520 }, 900);
  assert.ok(L.detail >= DETAIL_MIN || L.tasks === PANES.tasks.min, `detail ${L.detail}`);
  const narrow = S.layout({ tasksW: 760, inspectorW: 520 }, 900);
  assert.ok(narrow.tasks >= PANES.tasks.min && narrow.inspector >= PANES.inspector.min);
});

test('layout: a collapsed pane is a 36px strip, and Detail takes the room', () => {
  const L = S.layout({ tasksW: 300, tasksC: true, inspectorW: 300, inspectorC: true }, 1280);
  assert.equal(L.tasks, STRIP); assert.equal(L.inspector, STRIP);
  assert.equal(L.detail, 1280 - 2 * STRIP);
});

test('layout: without a right pane the Inspector takes no room', () => {
  const L = S.layout({}, 1280, false);
  assert.equal(L.inspector, 0); assert.equal(L.tasks, PANES.tasks.def);
});

test('reset: defaults are Tasks 256 and Inspector 340, both open', () => {
  assert.deepEqual(S.sanitize(null), { tasksW: 256, tasksC: false, inspectorW: 340, inspectorC: false });
});

test('storage: corrupt or hostile values fall back field by field, never throw', () => {
  for (const bad of ['{not json', '[]', '"x"', '123', 'null', '', undefined, { tasksW: 'wide' }]) {
    assert.doesNotThrow(() => S.sanitize(bad));
    const s = S.sanitize(bad);
    assert.equal(typeof s.tasksW, 'number'); assert.equal(typeof s.inspectorW, 'number');
    assert.equal(s.tasksC, false); assert.equal(s.inspectorC, false);
  }
  const mixed = S.sanitize('{"tasksW":99999,"tasksC":"yes","inspectorW":-5,"inspectorC":true}');
  assert.deepEqual(mixed, { tasksW: PANES.tasks.max, tasksC: false, inspectorW: PANES.inspector.min, inspectorC: true });
  assert.deepEqual(S.sanitize({ tasksW: NaN, inspectorW: Infinity }), S.DEFAULTS);
});

test('reader presets: Medium folds nothing, Wide folds the Inspector, Full pane folds both', () => {
  assert.deepEqual(S.presetFolds('m'), { tasks: false, inspector: false });
  assert.deepEqual(S.presetFolds('w'), { tasks: false, inspector: true });
  assert.deepEqual(S.presetFolds('f'), { tasks: true, inspector: true });
  assert.deepEqual(S.presetFolds(''), { tasks: false, inspector: false });
  assert.equal(S.KEY, 'lbp2:B2');
});
