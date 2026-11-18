// J-05 machines-scrub: every file the server hands out statically (public/ at /, schema/v1/ at /schema/v1/) is readable
// by anyone who reaches the board, so none may name a machine or an internal location. The scan itself lives in
// scripts/scan-served-assets.mjs (the deploy smoke runs the same patterns against the live server); a new hit fails here
// with file:line and the token, so it is fixed or listed in ALLOWED on purpose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { scanDir, scanServed, ALLOWED, PATTERNS } from '../scripts/scan-served-assets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('no served static file names a machine or an internal path', () => {
  assert.deepEqual(scanDir(ROOT).map(h => `${h.file}:${h.line} ${h.kind}: ${h.token}`), [], 'scrub these or list them in ALLOWED with a reason');
});

// Each probe line must be caught as its kind; the last lines must not be caught at all.
const CAUGHT = [
  ['windows hostname', "host: 'LAPTOP-ABCDE12'"], ['windows hostname', 'ping laptop-abcde12'], ['windows hostname', 'LAPTOP-Q1W2E3R'],
  ['windows hostname', 'WIN-ABCDEFGH123'], ['drive path', 'see D:/data/laneboard/tool/x.sh'], ['drive path', 'E:\\work\\a'],
  ['unc path', 'open \\\\fileserver\\share\\a.md'], ['user profile', 'C:\\Users\\pc\\a'], ['unix internal path', '/opt/laneboard-1/app'],
  ['unix internal path', 'cd /root/x'], ['unix internal path', 'tail /home/u/log'], ['unix internal path', 'ls /mnt/disk/a'],
  ['unix internal path', 'mktemp /tmp/x'], ['home path', 'cat ~/.ssh/config'], ['ssh target', 'ssh root@vps-alias'],
  ['email', 'mail someone.else@example.org'], ['ip address', 'lan 10.1.2.3'], ['ip address', 'lan 172.16.0.9'], ['ip address', 'lan 172.31.255.1'],
  ['ip address', 'lan 192.168.1.5'], ['ip address', 'cgnat 100.64.3.4'], ['ip address', 'vps 203.0.113.7'], ['lane folder', 'mail ' + 'cos-' + 'lane']
];
const CLEAN = ['ok: https://example.com/a and data:image/png', 'class="desktop-sidebar-wide"', 'version 1.2.3 and 10.5px', 'import x from "react@18.3.1"', 'a/tmp-file and ../home.js', '@media (max-width: 600px)'];

test('the scan catches each kind and leaves ordinary code alone (so a green run means clean, not blind)', () => {
  const tmp = fs.mkdtempSync(path.join(ROOT, '.scrub-probe-'));
  try {
    fs.mkdirSync(path.join(tmp, 'public'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'schema', 'v1'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'public', 'x.js'), CAUGHT.map(c => c[1]).join('\n'));
    fs.writeFileSync(path.join(tmp, 'schema', 'v1', 'y.json'), CLEAN.join('\n'));
    const hits = scanDir(tmp);
    CAUGHT.forEach(([kind, line], i) => assert.ok(hits.some(h => h.file === 'public/x.js' && h.line === i + 1 && h.kind === kind), `probe missed ${kind}: ${line}`));
    assert.deepEqual(hits.filter(h => h.file === 'schema/v1/y.json').map(h => `${h.kind}: ${h.token}`), [], 'ordinary code is not a leak');
    assert.ok(new Set(CAUGHT.map(c => c[0])).size === PATTERNS.length, 'every pattern has a probe');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('every ALLOWED entry still matches something (no stale allowances)', () => {
  for (const a of ALLOWED) assert.ok(fs.readFileSync(path.join(ROOT, a.file), 'utf8').includes(a.token), `${a.file} no longer has ${a.token}; drop the entry`);
});

test('the smoke mode fetches each served file of a listing and scans what the server sends', async () => {
  const body = { '/machines.js': "reach: 'mail lane'", '/leak.js': 'x LAPTOP-ABCDE12', '/schema/v1/a.json': '{}' };
  const srv = http.createServer((req, res) => { const b = body[req.url]; res.writeHead(b ? 200 : 404); res.end(b || ''); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${srv.address().port}`;
    const listing = ['public/', 'public/machines.js', 'public/leak.js', 'public/gone.js', 'schema/v1/a.json', 'src/server.mjs', 'package.json'];
    const { fetched, problems } = await scanServed(base, listing);
    assert.equal(fetched, 4, 'only files under public/ and schema/v1/ are fetched');
    assert.deepEqual(problems, ['public/leak.js:1 windows hostname: LAPTOP-ABCDE12', 'public/gone.js: HTTP 404']);
  } finally { srv.close(); }
});
