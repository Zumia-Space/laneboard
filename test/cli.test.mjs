// The documented CLI flow against a live in-process server: a reporter proposes, the coordinator merges.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSeeded, OWNER, tmpDir } from './helpers.mjs';
import { demoPng } from '../scripts/seed.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'board.mjs');
const board = (url, token, ...args) => new Promise(resolve => {
  execFile(process.execPath, [CLI, ...args], { env: { ...process.env, BOARD_URL: url, BOARD_TOKEN: token } }, (err, stdout, stderr) =>
    resolve({ code: err ? err.code : 0, stdout, stderr }));
});

test('board CLI: help, whoami, ask/step/report/attach as reporter, inbox/merge/clear as coordinator', async () => {
  const s = await startSeeded();
  try {
    const help = await board(s.url, '', 'help');
    assert.equal(help.code, 0); assert.match(help.stdout, /ask <TASK> "<text>"/);
    assert.equal((await board(s.url, '', 'whoami')).code, 2, 'missing token is a usage error');

    const me = JSON.parse((await board(s.url, s.alpha, 'whoami')).stdout);
    assert.equal(me.role, 'reporter'); assert.equal(me.name, 'lane-alpha');

    const ask = await board(s.url, s.alpha, 'ask', 'WEB-3', 'Photo or drawing?', '--step', 's3', '--option', 'A=Photo', '--option', 'B=Drawing');
    assert.equal(ask.code, 0, ask.stderr); assert.match(JSON.parse(ask.stdout).id, /^inb-/);
    assert.equal((await board(s.url, s.alpha, 'step', 'WEB-3/s2', 'done', 'layout finished')).code, 0);
    assert.equal((await board(s.url, s.alpha, 'report', 'WEB-3', 'screenshots attached', '--step', 's2')).code, 0);
    const file = path.join(tmpDir(), 'shot.png'); fs.writeFileSync(file, demoPng(20, 10));
    assert.equal((await board(s.url, s.alpha, 'attach', 'WEB-3', file, '--step', 's3', '--caption', 'variants')).code, 0);
    const denied = await board(s.url, s.alpha, 'ask', 'API-2', 'out of scope');
    assert.equal(denied.code, 1); assert.match(denied.stderr, /out_of_scope/);

    const view = await s.state(OWNER);
    assert.ok(view.attention.waiting.some(w => w.kind === 'proposal' && w.text === 'Photo or drawing?'), 'lane ask visible to the owner immediately');
    assert.equal(view.tasks.find(t => t.id === 'WEB-3').steps[1].state, 'active', 'reporter step change is only a proposal');

    const inbox = await board(s.url, s.coord, 'inbox');
    const stepItem = inbox.stdout.split('\n').find(l => l.includes('step->done')).split(' ')[0];
    assert.equal((await board(s.url, s.coord, 'merge', stepItem, 'accept')).code, 0);
    assert.equal((await board(s.url, s.coord, 'step', 'WEB-3/s3', 'active')).code, 0);
    const raised = JSON.parse((await board(s.url, s.coord, 'ask', 'WEB-3', 'Ready to ship?')).stdout);
    assert.match(raised.id, /^ask-/);
    assert.equal((await board(s.url, s.coord, 'clear', raised.id, 'answered in chat')).code, 0);
    assert.equal((await board(s.url, s.coord, 'answer', raised.id, 'A')).code, 1, 'coordinator cannot answer');

    const after = await s.state(OWNER);
    const steps = after.tasks.find(t => t.id === 'WEB-3').steps;
    assert.equal(steps[1].state, 'done'); assert.equal(steps[2].state, 'active');
    assert.equal(after.attachments.length, 1);
    assert.equal(after.inbox.find(i => i.kind === 'report' && i.text === 'screenshots attached').step_id, 's2', 'report --step reaches step_id');

    // a reporter follows its own items with `board mine`; watch is refused with a pointer to it
    const askItem = after.inbox.find(i => i.kind === 'ask' && i.text === 'Photo or drawing?');
    const merged = JSON.parse((await board(s.url, s.coord, 'merge', askItem.id, 'accept')).stdout);
    assert.equal((await board(s.url, OWNER, 'answer', merged.result_id, 'A')).code, 0);
    const mine = JSON.parse((await board(s.url, s.alpha, 'mine', '--json')).stdout);
    const followed = mine.find(i => i.id === askItem.id);
    assert.equal(followed.outcome, `merged ${merged.result_id} answered`); assert.equal(followed.answer.choice, 'A');
    assert.ok(mine.every(i => i.id.startsWith('inb-')) && mine.some(i => i.outcome === 'pending'), 'only own items; unmerged ones pending');
    const w = await board(s.url, s.alpha, 'watch');
    assert.equal(w.code, 1); assert.match(w.stderr, /board mine/);
  } finally { await s.close(); }
});
