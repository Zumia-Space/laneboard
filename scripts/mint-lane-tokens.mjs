#!/usr/bin/env node
// Mint ONE reporter token for ONE lane. The plaintext secret is written only to --out (mode 0600; an explicit
// user-only ACL on Windows) and is NEVER printed. The owner token is read from a file; the live board is only
// used when --board points at it, so the same script works against a local board in tests.
//   node scripts/mint-lane-tokens.mjs --board https://board.example --owner-token-file owner.token \
//        --lane lane-alpha --out lane-alpha.token [--scope ACME-01]... [--label "new laptop"] [--model claude] [--force]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { boardBaseUrl } from '../bin/board-url.mjs';

const HELP = `mint-lane-tokens — issue one reporter token for one lane

usage: mint-lane-tokens --board URL --owner-token-file PATH --lane NAME --out PATH
                        [--scope TASK]... [--label TEXT] [--model ID] [--force]

  --scope   a task id the lane may write; repeat it. Default: * (every task)
  --force   replace an existing --out file (otherwise the script refuses)
  --board   default BOARD_URL or http://127.0.0.1:8787 (https, or http only to loopback)
  --owner-token-file   default BOARD_OWNER_TOKEN_FILE

The secret is written only to --out and never printed. The owner token is never printed either.
exit codes: 0 issued · 1 rejected or unreachable · 2 usage error`;

const DEFAULT_BASE = 'http://127.0.0.1:8787';

class Exit extends Error { constructor(code, message) { super(message); this.exitCode = code; } }
const usage = message => { throw new Exit(2, `${message}\n\nrun: mint-lane-tokens --help`); };
const die = message => { throw new Exit(1, message); };

function parse(argv) {
  const flags = { scope: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') flags.help = true;
    else if (a === '--force') flags.force = true;
    else if (a === '--board') flags.board = argv[++i] ?? '';
    else if (a === '--owner-token-file') flags.ownerTokenFile = argv[++i] ?? '';
    else if (a === '--lane') flags.lane = argv[++i] ?? '';
    else if (a === '--out') flags.out = argv[++i] ?? '';
    else if (a === '--scope') flags.scope.push(argv[++i] ?? '');
    else if (a === '--label') flags.label = argv[++i] ?? '';
    else if (a === '--model') flags.model = argv[++i] ?? '';
    else usage(`unknown argument ${a}`);
  }
  return flags;
}

/** Writes the secret with the narrowest permissions the platform offers. Permissions go on the temporary file
 *  BEFORE it takes the final name, so the secret never sits under inherited permissions, and a failure leaves
 *  no copy behind. */
function writeSecret(target, secret) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${secret}\n`, { mode: 0o600 });
  if (process.platform === 'win32') {
    const user = process.env.USERNAME || process.env.USER;
    try {
      execFileSync('icacls', [tmp, '/inheritance:r', '/grant:r', `${user}:F`], { stdio: 'ignore' });
    } catch {
      fs.rmSync(tmp, { force: true });
      die(`could not set a user-only ACL on ${target}; nothing was written`);
    }
  }
  try {
    if (fs.existsSync(target)) fs.rmSync(target, { force: true }); // --force already checked
    fs.renameSync(tmp, target); // same directory: atomic
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

async function main() {
  const flags = parse(process.argv.slice(2));
  if (flags.help) { console.log(HELP); return; }
  let board;
  try { board = boardBaseUrl(flags.board || process.env.BOARD_URL || DEFAULT_BASE); } catch (e) { usage(e.message); }
  const lane = String(flags.lane || '').trim();
  const outPath = String(flags.out || '').trim();
  if (!lane) usage('need --lane NAME');
  if (!/^[a-z0-9][a-z0-9._-]{0,47}$/.test(lane)) usage('--lane must match ^[a-z0-9][a-z0-9._-]{0,47}$');
  if (!outPath) usage('need --out PATH');
  const ownerFile = flags.ownerTokenFile || process.env.BOARD_OWNER_TOKEN_FILE;
  if (!ownerFile) usage('need --owner-token-file (or BOARD_OWNER_TOKEN_FILE)');
  const target = path.resolve(outPath);
  if (fs.existsSync(target) && !flags.force) die(`${target} exists; pass --force to replace it`);

  let owner;
  try { owner = fs.readFileSync(ownerFile, 'utf8').trim(); } catch (e) { die(`cannot read the owner token file: ${e.message}`); }
  if (!owner) die('the owner token file is empty');

  const data = {
    role: 'reporter', lane,
    ...(flags.label ? { label: flags.label } : {}),
    ...(flags.model ? { model: flags.model } : {}),
    scope_tasks: flags.scope.length ? flags.scope : ['*']
  };
  const post = async payload => {
    try {
      const res = await fetch(`${board}/api/v1/write`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${owner}` },
        body: JSON.stringify(payload)
      });
      return { res, body: await res.json().catch(() => ({})) };
    } catch (e) { die(`board unreachable at ${board}: ${e.message}`); }
  };
  const issue = () => post({
    version: 1,
    request_id: `mint-${lane}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`,
    op: 'token.issue', target_id: lane, data
  });
  let { res, body } = await issue();
  // --force rotates: the board keeps one active token per name, so revoke the old one and issue again. That is
  // the only order the board allows (no atomic swap), so a failed second issue is reported as what it is: the
  // lane has no active token and the file on disk still holds the revoked one.
  if (res.status === 409 && body.error === 'name_taken' && flags.force) {
    const list = await fetch(`${board}/api/v1/tokens`, { headers: { Authorization: `Bearer ${owner}` } });
    if (!list.ok) die(`could not list tokens to rotate ${lane}: ${list.status}`);
    const old = (await list.json()).find(t => t.name === lane && !t.revoked_at);
    if (!old) die(`name_taken for ${lane}, but no active token has that name`);
    const revoked = await post({ version: 1, request_id: `mint-revoke-${lane}-${Date.now().toString(36)}`, op: 'token.revoke', target_id: old.id, data: {} });
    if (!revoked.res.ok) die(`could not revoke ${old.id}: ${revoked.res.status} ${JSON.stringify(revoked.body)}`);
    ({ res, body } = await issue());
    if (!res.ok) {
      const safe = { ...body }; delete safe.token;
      die(`${res.status} ${JSON.stringify(safe)} — the old ${lane} token is revoked and ${target} was left untouched; re-run the same command`);
    }
  }
  const { token, ...safeReply } = body; // an error reply must never carry (or print) a token
  if (!res.ok) die(`${res.status} ${JSON.stringify(safeReply)}`);
  if (typeof token !== 'string' || !token.startsWith('lb_')) die('the board returned no token');

  writeSecret(target, token);
  console.log(`issued ${lane} -> ${target} (${body.id})`);
}

main().catch(e => {
  console.error(e instanceof Exit ? e.message : `mint-lane-tokens: ${e.message}`);
  process.exitCode = e instanceof Exit ? e.exitCode : 1;
});
