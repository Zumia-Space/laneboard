#!/usr/bin/env node
// `board` — a thin HTTP client for Laneboard. Every write is one POST /api/v1/write.
// Configure with environment variables:
//   BOARD_URL         default http://127.0.0.1:8787
//   BOARD_TOKEN       your session token (or BOARD_TOKEN_FILE=path)
//   BOARD_ORIGIN      optional: declared origin when you relay for another model (recorded, unverified)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const HELP = `board — talk to a Laneboard over HTTP

usage: board <command> [args]

  help                                  this text
  whoami                                your session name, role, lane and scope
  state [--json]                        tasks, steps and the owner-attention list
  ask <TASK> "<text>" [--step S] [--option KEY="label"]...
                                        coordinator/owner: open an ask for the owner
                                        reporter: propose the ask (shows to the owner at once as a proposal)
  clear <ASK_ID> ["note"]               coordinator/owner: withdraw an open ask
  answer <ASK_ID> [KEY] [--text "..."]  owner: answer an ask
  step <TASK>/<STEP> <todo|active|waiting|blocked|done> ["note"]
                                        coordinator/owner: change the step
                                        reporter: propose the change to the coordinator
  report <TASK> "<text>" [--step S]     file a progress report into the inbox
  mine [--json]                         what happened to the items you filed: pending, merged (and the
                                        owner's answer to a merged ask) or dismissed. Poll it to stay
                                        notified as a reporter (watch is coordinator/owner only)
  attach <TASK> <file> [--step S] [--caption "..."] [--public]
                                        attach a small file (png, jpg, webp, gif, pdf, txt, md)
  inbox                                 coordinator/owner: unresolved inbox items
  merge <INBOX_ID> accept|dismiss ["note"]
                                        coordinator/owner: resolve an inbox item
  watch [--since evt-N] [--all] [--json]
                                        coordinator/owner: one line per new owner feedback or answer
                                        (--all adds new asks). Runs until stopped; reconnects on drop
                                        and resumes where it left off. Status goes to stderr.

env: BOARD_URL (default http://127.0.0.1:8787), BOARD_TOKEN or BOARD_TOKEN_FILE, BOARD_ORIGIN
exit codes: 0 ok · 1 rejected or unreachable · 2 usage error
docs: AGENTS.md · schema: <BOARD_URL>/schema/v1/index.json`;

const URL_BASE = (process.env.BOARD_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const TOKEN = process.env.BOARD_TOKEN || (process.env.BOARD_TOKEN_FILE ? fs.readFileSync(process.env.BOARD_TOKEN_FILE, 'utf8').trim() : '');
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown' };

// Errors end the process through process.exitCode, never process.exit(): exiting while fetch sockets
// are still closing trips a libuv assertion on Windows.
class Exit extends Error { constructor(code, msg) { super(msg); this.exitCode = code; } }
const usage = msg => { throw new Exit(2, `${msg}\n\nrun: board help`); };
const die = msg => { throw new Exit(1, msg); };

function parse(argv) {
  const pos = [], flags = {}, options = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--option') { const [k, ...v] = String(argv[++i] || '').split('='); options.push({ key: k, label: v.join('=') }); }
    else if (a.startsWith('--')) { const k = a.slice(2); flags[k] = ['json', 'public', 'all'].includes(k) ? true : argv[++i]; }
    else pos.push(a);
  }
  return { pos, flags, options };
}

async function get(route) {
  const res = await fetch(URL_BASE + route, { headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {} });
  const body = await res.json();
  if (!res.ok) die(`${res.status} ${JSON.stringify(body)}`);
  return body;
}

/** One write with a fixed request_id; network failures are retried with the SAME id, so the server applies it once. */
async function write(op, target_id, data, expected_revision) {
  const body = { version: 1, request_id: `cli-${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`, op, target_id, data,
    ...(expected_revision != null ? { expected_revision } : {}), ...(process.env.BOARD_ORIGIN ? { origin: process.env.BOARD_ORIGIN } : {}) };
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${URL_BASE}/api/v1/write`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body) });
      const out = await res.json();
      if (!res.ok) die(`${op} rejected: ${res.status} ${JSON.stringify(out)}`);
      return out;
    } catch (e) { if (e instanceof Exit) throw e; lastErr = e; await new Promise(r => setTimeout(r, 300 * (attempt + 1))); }
  }
  die(`board unreachable at ${URL_BASE}: ${lastErr?.message}`);
}

const print = o => console.log(JSON.stringify(o, null, 1));

/** Parses a server-sent-events body into { id, event, data } messages (id-only messages included). */
async function* sseMessages(body) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true }).replace(/\r\n?/g, '\n');
    let end;
    while ((end = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, end); buf = buf.slice(end + 2);
      const msg = {};
      for (const line of block.split('\n')) {
        const m = /^(id|event|data): ?(.*)$/.exec(line);
        if (m) msg[m[1]] = m[1] === 'data' && msg.data != null ? msg.data + '\n' + m[2] : m[2];
      }
      if (msg.id || msg.data) yield msg;
    }
  }
}
const oneLine = s => String(s ?? '').replace(/\s+/g, ' ').trim();
function signalLine(s) {
  const where = `${s.task_id}${s.step_id ? '/' + s.step_id : ''}`;
  if (s.type === 'feedback') return `[feedback] ${where} ${s.id} ${s.kind} from ${s.by}: ${oneLine(s.text)}`;
  if (s.type === 'answer') return `[answer] ${where} ${s.id} from ${s.by}: ${[s.choice, oneLine(s.text)].filter(Boolean).join(' — ')} (asked: ${oneLine(s.question)})`;
  return `[ask${s.proposal ? ' proposal' : ''}] ${where} ${s.id} from ${s.by}: ${oneLine(s.text)}`;
}

/** Follows owner signals forever. Auth errors end it (exit 1); anything else reconnects with backoff, resuming by event id. */
async function watch(flags) {
  let last = flags.since || '';
  const types = flags.all ? 'feedback,answer,ask' : 'feedback,answer';
  let delay = 1000;
  for (;;) {
    try {
      const res = await fetch(`${URL_BASE}/api/v1/events?types=${types}`, { headers: { Accept: 'text/event-stream', Authorization: `Bearer ${TOKEN}`, ...(last ? { 'Last-Event-ID': last } : {}) } });
      if (res.status === 401 || res.status === 403 || res.status === 400) {
        const hint = res.status === 403 ? '\nwatch is for coordinator and owner tokens; a reporter polls "board mine" (AGENTS.md, "Stay notified")' : '';
        die(`watch rejected: ${res.status} ${await res.text()}${hint}`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      console.error(`watching ${URL_BASE}${last ? ` from ${last}` : ''}`);
      delay = 1000;
      for await (const msg of sseMessages(res.body)) {
        if (msg.id) last = msg.id;
        if (msg.data) console.log(flags.json ? msg.data : signalLine(JSON.parse(msg.data)));
      }
      throw new Error('stream closed');
    } catch (e) {
      if (e instanceof Exit) throw e;
      console.error(`watch: ${e.message}; reconnecting in ${delay / 1000}s`);
      await new Promise(r => setTimeout(r, delay));
      delay = Math.min(delay * 2, 30000);
    }
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, flags, options } = parse(rest);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') return console.log(HELP);
  if (!TOKEN) usage('BOARD_TOKEN is not set');
  if (cmd === 'watch') return watch(flags); // no whoami first: watch may start before the board is up
  const me = await get('/api/v1/whoami');
  const lead = me.role === 'owner' || me.role === 'coordinator';

  switch (cmd) {
    case 'whoami': return print(me);
    case 'state': {
      const s = await get('/api/v1/state');
      if (flags.json) return print(s);
      for (const t of s.tasks) console.log(`${t.id}  ${t.title}  [${t.status}/${t.health}]  ${t.steps.map(x => `${x.id.split('/')[1]}:${x.state}`).join(' ')}`);
      console.log(`\nwaiting on owner (${s.attention.waiting.length}):`);
      for (const w of s.attention.waiting) console.log(`  ${w.id}  ${w.task_id}${w.step_id ? '/' + w.step_id : ''}  ${w.kind}  from ${w.from.name}: ${w.text}`);
      return;
    }
    case 'ask': {
      const [task, text] = pos;
      if (!task || !text) usage('usage: board ask <TASK> "<text>" [--step S] [--option KEY="label"]');
      const data = { text, ...(flags.step ? { step_id: flags.step } : {}), ...(options.length ? { options } : {}) };
      if (lead) return print(await write('ask.raise', task, data));
      const filed = await write('inbox.submit', task, { kind: 'ask', ...data });
      print(filed);
      return console.error(`filed as a proposal (${filed.id}): the owner sees it now; the coordinator merges it into an ask the owner can answer. Follow it with: board mine`);
    }
    case 'clear': {
      const [id, note] = pos;
      if (!id) usage('usage: board clear <ASK_ID> ["note"]');
      const a = (await get('/api/v1/state')).asks.find(x => x.id === id) || die(`no ask ${id}`);
      return print(await write('ask.clear', id, note ? { note } : {}, a.rev));
    }
    case 'answer': {
      const [id, choice] = pos;
      if (!id || (!choice && !flags.text)) usage('usage: board answer <ASK_ID> [KEY] [--text "..."]');
      const a = (await get('/api/v1/state')).asks.find(x => x.id === id) || die(`no ask ${id}`);
      return print(await write('ask.answer', id, { ...(choice ? { choice } : {}), ...(flags.text ? { text: flags.text } : {}) }, a.rev));
    }
    case 'step': {
      const [key, state, note] = pos;
      if (!key || !key.includes('/') || !state) usage('usage: board step <TASK>/<STEP> <state> ["note"]');
      const [task, step] = key.split('/');
      if (!lead) return print(await write('inbox.submit', task, { kind: 'step', step_id: step, state, text: note || '' }));
      const s = (await get('/api/v1/state')).tasks.find(t => t.id === task)?.steps.find(x => x.id === key) || die(`no step ${key}`);
      return print(await write('step.update', key, { state, ...(note ? { detail: note } : {}) }, s.rev));
    }
    case 'report': {
      const [task, text] = pos;
      if (!task || !text) usage('usage: board report <TASK> "<text>" [--step S]');
      return print(await write('inbox.submit', task, { kind: 'report', text, ...(flags.step ? { step_id: flags.step } : {}) }));
    }
    case 'mine': {
      const s = await get('/api/v1/state');
      const items = s.inbox.filter(i => i.attribution.created_by.token_id === me.token_id).map(i => {
        const r = i.resolution, ask = r?.result_id && s.asks.find(a => a.id === r.result_id);
        const outcome = !r ? 'pending' : r.action === 'dismiss' ? 'dismissed' : ask ? `merged ${ask.id} ${ask.status}` : `merged${r.result_id ? ' ' + r.result_id : ''}`;
        return { id: i.id, task_id: i.task_id, step_id: i.step_id, kind: i.kind, text: i.text, outcome, ...(r?.note ? { note: r.note } : {}),
          ...(ask?.answer ? { answer: { choice: ask.answer.choice, text: ask.answer.text, at: ask.answer.at } } : {}) };
      });
      if (flags.json) return print(items);
      if (!items.length) return console.log('nothing filed with this token');
      for (const i of items) console.log(`${i.id}  ${i.task_id}${i.step_id ? '/' + i.step_id : ''}  ${i.kind}  ${i.outcome}${i.answer ? ': ' + [i.answer.choice, i.answer.text].filter(Boolean).join(' — ') : ''}${i.note ? ' (' + i.note + ')' : ''}  :: ${i.text}`);
      return;
    }
    case 'attach': {
      const [task, file] = pos;
      if (!task || !file) usage('usage: board attach <TASK> <file> [--step S] [--caption "..."] [--public]');
      const mime = MIME[path.extname(file).toLowerCase()] || usage(`unsupported file type: ${file}`);
      const name = path.basename(file).replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 120);
      return print(await write('attachment.add', task, { name, mime, data_base64: fs.readFileSync(file).toString('base64'),
        ...(flags.step ? { step_id: flags.step } : {}), ...(flags.caption ? { caption: flags.caption } : {}), ...(flags.public ? { visibility: 'public' } : {}) }));
    }
    case 'inbox': {
      const s = await get('/api/v1/state');
      const open = s.inbox.filter(i => !i.resolution);
      if (!open.length) return console.log('inbox empty');
      for (const i of open) console.log(`${i.id}  ${i.task_id}${i.step_id ? '/' + i.step_id : ''}  ${i.kind}${i.state ? '->' + i.state : ''}  from ${i.attribution.created_by.name}: ${i.text}`);
      return;
    }
    case 'merge': {
      const [id, action, note] = pos;
      if (!id || !['accept', 'dismiss'].includes(action)) usage('usage: board merge <INBOX_ID> accept|dismiss ["note"]');
      const i = (await get('/api/v1/state')).inbox.find(x => x.id === id) || die(`no inbox item ${id}`);
      return print(await write('inbox.merge', id, { action, ...(note ? { note } : {}) }, i.rev));
    }
    default: usage(`unknown command: ${cmd}`);
  }
}
main().catch(e => { console.error(e.message); process.exitCode = e.exitCode || 1; });
