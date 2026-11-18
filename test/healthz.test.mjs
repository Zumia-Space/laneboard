// /healthz names the deployed commit (the RELEASE file the release swap writes into the code dir), so a client — the
// desktop app — can check it runs against the same build as live.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createBoard } from '../src/board.mjs';
import { createServer, readRelease } from '../src/server.mjs';
import { tmpDir, OWNER } from './helpers.mjs';

test('readRelease: the first word of RELEASE in the code dir, else unknown', () => {
  const dir = tmpDir();
  assert.equal(readRelease(dir), 'unknown');
  fs.writeFileSync(path.join(dir, 'RELEASE'), 'd723490\n');
  assert.equal(readRelease(dir), 'd723490');
  fs.writeFileSync(path.join(dir, 'RELEASE'), '  \n');
  assert.equal(readRelease(dir), 'unknown');
});

test('GET /healthz returns ok, seq and the release', async () => {
  const board = createBoard({ dataDir: tmpDir(), ownerToken: OWNER });
  const dir = tmpDir(); fs.writeFileSync(path.join(dir, 'RELEASE'), 'abc1234');
  const servers = [createServer(board, { release: readRelease(dir) }), createServer(board)];
  try {
    const out = [];
    for (const s of servers) {
      await new Promise(r => s.listen(0, '127.0.0.1', r));
      out.push(await (await fetch(`http://127.0.0.1:${s.address().port}/healthz`)).json());
    }
    assert.deepEqual(out[0], { ok: true, seq: board.state.seq, release: 'abc1234' });
    assert.equal(out[1].release, readRelease(), 'by default the code dir of the running server (unknown in a git checkout)');
  } finally { for (const s of servers) { s.closeAllConnections(); await new Promise(r => s.close(r)); } board.close(); }
});
