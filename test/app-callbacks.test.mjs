// Every named function the page passes as a callback (`.map(fn)`, `.filter(fn)`, …) is defined in app.js.
// A removed helper with a call left behind only fails at render time — on 01-10 Home showed "Loading…" forever
// once the owner's first answer gave `answered` a row (answeredRow had been deleted in the P1 shell rewrite).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'app.js'), 'utf8');

test('every named callback passed to an array method is defined in app.js', () => {
  const used = new Set([...APP.matchAll(/\.(?:map|filter|forEach|some|every|find|flatMap|sort)\(([A-Za-z_$][\w$]*)\)/g)].map(m => m[1]));
  const builtins = new Set(['Boolean', 'Number', 'String', 'esc']);
  const missing = [...used].filter(n => !builtins.has(n) && !new RegExp(`(?:function\\s+${n}\\b|(?:const|let|var)\\s+${n}\\s*=)`).test(APP));
  assert.deepEqual(missing, [], `callbacks used but never defined: ${missing.join(', ')}`);
});
