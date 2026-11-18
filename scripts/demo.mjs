#!/usr/bin/env node
// One-command local demo: fresh data dir, server on a free port (or $PORT), synthetic data seeded over HTTP.
//   node scripts/demo.mjs            -> .demo-data/ is recreated each run
//   node scripts/demo.mjs --keep     -> reuse .demo-data/ if it exists
import fs from 'node:fs';
import path from 'node:path';
import { createBoard } from '../src/board.mjs';
import { createServer } from '../src/server.mjs';
import { seed } from './seed.mjs';

const dataDir = path.resolve(process.env.BOARD_DATA || '.demo-data');
const keep = process.argv.includes('--keep') && fs.existsSync(path.join(dataDir, 'events.ndjson'));
if (!keep) fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });

const board = createBoard({ dataDir, stallMs: Number(process.env.BOARD_STALL_MS || 3 * 3600000) });
const server = createServer(board);
server.listen(Number(process.env.PORT || 0), '127.0.0.1', async () => {
  const url = `http://127.0.0.1:${server.address().port}`;
  if (!keep) {
    const ownerToken = fs.readFileSync(path.join(dataDir, 'owner.token'), 'utf8').trim();
    const tokens = await seed(url, ownerToken);
    fs.writeFileSync(path.join(dataDir, 'demo-tokens.json'), JSON.stringify(tokens, null, 2) + '\n', { mode: 0o600 });
  }
  console.log(`laneboard demo running at ${url}`);
  console.log(`session tokens (owner, coordinator, lane-alpha, lane-beta): ${path.join(dataDir, 'demo-tokens.json')}`);
  console.log('open the URL and paste the owner token to sign in; Ctrl+C to stop');
});
