// Owner signals reach the coordinator: a server-sent event stream, the `board watch` CLI on top of it
// (with reconnect), and an optional HMAC-signed webhook whose secret never enters the journal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSeeded, OWNER } from './helpers.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'board.mjs');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (cond, ms = 8000) => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error('timed out'); await sleep(25); } };

/** Opens the SSE stream and collects parsed messages until closed. */
function openStream(s, token, query = '', headers = {}) {
  const ctl = new AbortController(), messages = [];
  const ready = fetch(`${s.url}/api/v1/events${query}`, { signal: ctl.signal, headers: { Accept: 'text/event-stream', Authorization: `Bearer ${token}`, ...headers } }).then(res => {
    if (res.status !== 200) return res;
    (async () => {
      let buf = '';
      try {
        for await (const chunk of res.body) {
          buf += Buffer.from(chunk).toString('utf8');
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i); buf = buf.slice(i + 2);
            const msg = Object.fromEntries(block.split('\n').map(l => /^(id|event|data): (.*)$/.exec(l)).filter(Boolean).map(m => [m[1], m[2]]));
            if (msg.data) msg.data = JSON.parse(msg.data);
            messages.push(msg);
          }
        }
      } catch { /* aborted by close() */ }
    })();
    return res;
  });
  return { ready, messages, signals: () => messages.filter(m => m.data), close: () => ctl.abort() };
}

test('SSE stream: owner feedback, answers and asks arrive live with evt ids; replay from since; reporters refused', async () => {
  const s = await startSeeded();
  try {
    assert.equal((await openStream(s, s.alpha).ready).status, 403);
    const st = openStream(s, s.coord);
    assert.equal((await st.ready).status, 200);
    await until(() => st.messages.some(m => m.id && !m.data)); // resume cursor sent on connect
    const fb = (await s.write(OWNER, 'feedback.add', 'WEB-3', { kind: 'note', text: 'make the hero bigger' })).body;
    await s.write(s.coord, 'feedback.add', 'WEB-3', { kind: 'reply', text: 'on it', reply_to: fb.id }); // the coordinator's own reply is not a signal
    const ask = (await s.write(s.coord, 'ask.raise', 'WEB-3', { text: 'A or B?', options: [{ key: 'A', label: 'a' }] })).body;
    await s.write(OWNER, 'ask.answer', ask.id, { choice: 'A', text: 'photo' }, { expected_revision: 1 });
    await until(() => st.signals().length === 3);
    const [f, a, ans] = st.signals();
    assert.equal(f.event, 'feedback'); assert.equal(f.id, `evt-${fb.seq}`); assert.equal(f.data.text, 'make the hero bigger'); assert.equal(f.data.by, 'owner');
    assert.equal(a.event, 'ask'); assert.equal(ans.event, 'answer');
    assert.equal(ans.data.choice, 'A'); assert.equal(ans.data.question, 'A or B?'); assert.equal(ans.data.task_id, 'WEB-3');
    st.close();

    const replay = openStream(s, s.coord, `?since=evt-${fb.seq - 1}&types=feedback,answer`);
    await replay.ready;
    await until(() => replay.signals().length === 2);
    assert.deepEqual(replay.signals().map(m => m.event), ['feedback', 'answer'], 'types filter drops asks');
    replay.close();
    const resumed = openStream(s, s.coord, '', { 'Last-Event-ID': `evt-${fb.seq}` });
    await resumed.ready;
    await until(() => resumed.signals().length === 2);
    assert.deepEqual(resumed.signals().map(m => m.event), ['ask', 'answer'], 'Last-Event-ID resumes after that event');
    resumed.close();
    assert.equal((await openStream(s, s.coord, '?since=yesterday').ready).status, 400);
    const plain = await s.call(s.coord, 'GET', '/api/v1/events?after=0');
    assert.ok(Array.isArray(plain.body), 'without Accept: text/event-stream the JSON audit log is unchanged');
  } finally { await s.close(); }
});

test('SSE stream stops delivering once the token is revoked', async () => {
  const s = await startSeeded();
  try {
    const st = openStream(s, s.coord);
    await st.ready;
    await s.write(OWNER, 'token.revoke', s.board.authenticate(s.coord).token_id, {});
    await s.write(OWNER, 'feedback.add', 'WEB-3', { kind: 'note', text: 'after revoke' });
    await sleep(200);
    assert.equal(st.signals().length, 0);
    st.close();
  } finally { await s.close(); }
});

test('webhook: owner-only config, secret revealed once and kept out of the journal, deliveries HMAC-signed', async () => {
  const received = [];
  const hook = http.createServer((req, res) => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { received.push({ headers: req.headers, body: b }); res.end('ok'); }); });
  await new Promise(r => hook.listen(0, '127.0.0.1', r));
  const hookUrl = `http://127.0.0.1:${hook.address().port}/laneboard`;
  const s = await startSeeded({ webhookRetryMs: [50] });
  try {
    assert.equal((await s.write(s.coord, 'notify.set', 'board', { delivery: 'webhook', webhook_url: hookUrl })).status, 403);
    const r = await s.write(OWNER, 'notify.set', 'board', { coordinator_feedback: true, delivery: 'webhook', webhook_url: hookUrl });
    assert.equal(r.status, 200);
    const secret = r.body.webhook_secret;
    assert.match(secret, /^whsec_/);
    assert.equal((await s.write(OWNER, 'notify.set', 'board', { delivery: 'webhook' })).body.webhook_secret, undefined, 'shown once, not on every save');
    assert.equal((await s.write(OWNER, 'notify.set', 'board', { webhook_url: 'ftp://x' })).status, 400);
    assert.equal((await s.write(OWNER, 'notify.set', 'board', { webhook_url: 'https://hooks.example.invalid/a b' })).status, 400, 'no whitespace');
    assert.equal((await s.write(OWNER, 'notify.set', 'board', { webhook_url: 'https://hooks.example.invalid/laneboard?x=s' })).status, 200, 'ordinary https URLs pass');
    assert.equal((await s.write(OWNER, 'notify.set', 'board', { webhook_url: hookUrl })).status, 200);

    await s.write(OWNER, 'feedback.add', 'WEB-3', { kind: 'note', text: 'ship it' });
    await s.write(s.coord, 'feedback.add', 'WEB-3', { kind: 'reply', text: 'coordinator reply is not sent' });
    await until(() => received.length === 1);
    await sleep(100);
    assert.equal(received.length, 1);
    const { headers, body } = received[0];
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(`${headers['x-laneboard-timestamp']}.${body}`).digest('hex');
    assert.equal(headers['x-laneboard-signature'], expected);
    assert.equal(headers['x-laneboard-event'], 'feedback');
    assert.equal(JSON.parse(body).signal.text, 'ship it');

    const owner = await s.state(OWNER);
    assert.equal(owner.notify.webhook_url, hookUrl); assert.equal(owner.notify.last_delivery.ok, true);
    assert.deepEqual((await s.state(s.coord)).notify, { coordinator_feedback: true, delivery: 'webhook' }, 'coordinator sees the mode, not the URL');

    const rotated = (await s.write(OWNER, 'notify.set', 'board', { rotate_secret: true })).body.webhook_secret;
    assert.ok(rotated && rotated !== secret);
    const journal = fs.readFileSync(path.join(s.dataDir, 'events.ndjson'), 'utf8');
    assert.ok(!journal.includes(secret) && !journal.includes(rotated), 'signing secrets never enter the journal');

    await s.write(OWNER, 'notify.set', 'board', { coordinator_feedback: false });
    await s.write(OWNER, 'feedback.add', 'WEB-3', { kind: 'note', text: 'muted' });
    await sleep(200);
    assert.equal(received.length, 1, 'switched off: nothing sent');
  } finally { await s.close(); await new Promise(r => hook.close(r)); }
});

test('board watch prints one line per owner feedback and resumes without gaps after the connection drops', async () => {
  const s = await startSeeded();
  const child = spawn(process.execPath, [CLI, 'watch'], { env: { ...process.env, BOARD_URL: s.url, BOARD_TOKEN: s.coord } });
  let out = '', err = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { err += d; });
  try {
    await until(() => /watching/.test(err));
    await s.write(OWNER, 'feedback.add', 'WEB-3', { kind: 'note', text: 'first\nnote' });
    await until(() => out.includes('first note'));
    assert.match(out, /^\[feedback\] WEB-3 fb-\d+ note from owner: first note$/m, 'one line, newlines collapsed');

    s.server.closeAllConnections(); // a network blip (also drops this test's pooled keep-alive socket)
    await sleep(200);
    await s.write(OWNER, 'feedback.add', 'WEB-3', { kind: 'approve', text: 'written while disconnected' });
    await until(() => out.includes('written while disconnected'), 10000);
    assert.match(err, /reconnecting/);
    assert.equal(out.trim().split('\n').length, 2, 'no duplicates after reconnect');
  } finally { child.kill(); await s.close(); }
});
