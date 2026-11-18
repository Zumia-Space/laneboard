// J-05: the design tokens live once, in public/tokens.css, loaded before styles.css; styles.css only consumes them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const CSS = fs.readFileSync(path.join(PUB, 'styles.css'), 'utf8');
const TOK = fs.readFileSync(path.join(PUB, 'tokens.css'), 'utf8');
const HTML = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');

test('tokens live once, in tokens.css; styles.css only consumes them', () => {
  assert.ok(fs.existsSync(path.join(PUB, 'tokens.css')), 'public/tokens.css exists');
  assert.match(TOK, /Single source of design tokens for Laneboard and the Zumi desktop app \(vendored\)\. Do not hardcode colours elsewhere\./);
  assert.match(TOK, /--background:/, 'light values moved');
  assert.match(TOK, /--foreground:/, 'light values moved');
  assert.match(TOK, /^\.dark \{/m, 'the dark block moved');
  assert.match(TOK, /html\[data-accent="blue"\]/, 'accent tokens moved');
  assert.match(TOK, /html\[data-accent\]:not\(\[data-accent="neutral"\]\) \{ --ring:/, 'the --ring rule moved');
  // No definition is left behind — a definition ends with a colon; a var(--x) use never does.
  assert.doesNotMatch(CSS, /--background\s*:/);
  assert.doesNotMatch(CSS, /--foreground\s*:/);
});

test('index.html loads tokens.css before styles.css', () => {
  const ti = HTML.indexOf('tokens.css'), si = HTML.indexOf('styles.css');
  assert.ok(ti > 0 && si > 0, 'both stylesheets are linked');
  assert.ok(ti < si, 'tokens.css comes first, so styles.css can use its vars');
  assert.match(HTML, /<link rel="stylesheet" href="tokens\.css">\s*<link rel="stylesheet" href="styles\.css">/);
});
