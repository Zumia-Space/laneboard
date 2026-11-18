#!/usr/bin/env node
// lane-msg — send one message to another lane through the Laneboard mailbox.
// Independent of cos-board.mjs: only Node's fetch and a token from the environment.
//   BOARD_URL         default http://127.0.0.1:8787; may include the ext prefix (.../<proxy-prefix>/ext)
//   BOARD_TOKEN       the lane token, or BOARD_TOKEN_FILE=path
// The token is never printed. The server stamps `from`; the body cannot set it.
import fs from 'node:fs';
import { boardBaseUrl } from './board-url.mjs';

const HELP = `lane-msg — send one lane message

usage: lane-msg <to> "<text>" [--reply msg-N] [--link URL]...

  <to>        a lane the board knows, cos, or all
  --reply     the msg-N this answers
  --link      an https link (up to 5, each <= 2 KB, <= 8 KB together); repeat the flag

env: BOARD_URL (default http://127.0.0.1:8787; https, or http only to loopback), BOARD_TOKEN or BOARD_TOKEN_FILE
exit codes: 0 ok · 1 rejected or unreachable · 2 usage error`;

const DEFAULT_BASE = 'http://127.0.0.1:8787';
const TOKEN = process.env.BOARD_TOKEN || (process.env.BOARD_TOKEN_FILE ? fs.readFileSync(process.env.BOARD_TOKEN_FILE, 'utf8').trim() : '');

class Exit extends Error { constructor(code, message) { super(message); this.exitCode = code; } }
const usage = message => { throw new Exit(2, `${message}\n\nrun: lane-msg --help`); };
const die = message => { throw new Exit(1, message); };

function parse(argv) {
  const pos = [], flags = { reply: '', links: [] };
  let literal = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (literal) pos.push(a);
    else if (a === '--') literal = true;
    else if (a === '--help' || a === '-h') flags.help = true;
    else if (a === '--reply') { const v = argv[++i]; if (!v) usage('--reply needs a msg id'); flags.reply = v; }
    else if (a === '--link') { const v = argv[++i]; if (!v) usage('--link needs a URL'); flags.links.push(v); }
    else if (a.startsWith('--')) usage(`unknown flag ${a}`);
    else pos.push(a);
  }
  return { pos, flags };
}

async function main() {
  const { pos, flags } = parse(process.argv.slice(2));
  if (flags.help) { console.log(HELP); return; }
  let base;
  try { base = boardBaseUrl(process.env.BOARD_URL || DEFAULT_BASE); } catch (e) { usage(e.message); }
  if (pos.length < 2) usage('need <to> and "<text>"');
  if (pos.length > 2) usage('too many arguments; quote the text');
  if (!TOKEN) usage('no token: set BOARD_TOKEN or BOARD_TOKEN_FILE');
  const [to, text] = pos;
  const body = { to, body: text, ...(flags.reply ? { reply_to: flags.reply } : {}), ...(flags.links.length ? { links: flags.links } : {}) };

  let res;
  try {
    res = await fetch(`${base}/api/v1/msg`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(body)
    });
  } catch (e) { die(`board unreachable at ${base}: ${e.message}`); }
  const out = await res.json().catch(() => ({}));
  if (!res.ok) die(`${res.status} ${JSON.stringify(out)}`);
  console.log(`${out.id} ${out.from} -> ${out.to}`);
}

main().catch(e => {
  console.error(e instanceof Exit ? e.message : `lane-msg: ${e.message}`);
  process.exitCode = e instanceof Exit ? e.exitCode : 1;
});
