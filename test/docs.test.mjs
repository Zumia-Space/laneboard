// AGENTS.md must document every op the server enforces, with the same roles as the schema metadata.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'schema', 'v1', 'index.json'), 'utf8'));
const agents = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');

test('AGENTS.md permission table matches schema/v1/index.json', () => {
  for (const [op, rule] of Object.entries(index.ops)) {
    const line = agents.split('\n').find(l => l.startsWith(`| \`${op}\` |`));
    assert.ok(line, `AGENTS.md is missing ${op}`);
    const rolesCell = line.split('|')[2];
    for (const r of ['owner', 'coordinator', 'reporter']) assert.equal(new RegExp(`\\b${r}\\b`).test(rolesCell.replace(/\(.*\)/, '')), rule.roles.includes(r), `${op}: role ${r}`);
    assert.equal(line.includes('required'), rule.revision === 'required', `${op}: revision rule`);
  }
});

test('README and AGENTS.md only reference files that exist', () => {
  for (const doc of ['README.md', 'AGENTS.md']) {
    const text = fs.readFileSync(path.join(ROOT, doc), 'utf8');
    for (const [, target] of text.matchAll(/\]\(((?!https?:)[^)#]+)(#[^)]*)?\)/g)) {
      assert.ok(fs.existsSync(path.join(ROOT, target)), `${doc} links to missing ${target}`);
    }
  }
});
