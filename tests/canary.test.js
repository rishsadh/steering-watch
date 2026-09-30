import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCanary, formatScore, scoreReply, serveCanary, tokenFor, TECHNIQUES } from '../src/canary.js';
import { scanText } from '../src/scan.js';
import { TIER_RANK } from '../src/rules.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sw-canary-'));

test('tokens come from the seed and change with it', () => {
  assert.equal(tokenFor('a', 'x'), tokenFor('a', 'x'));
  assert.notEqual(tokenFor('a', 'x'), tokenFor('b', 'x'));
  assert.match(tokenFor('a', 'x'), /^SWC-[0-9A-F]{8}$/);
});

test('the suite builds the expected pages and a token table', () => {
  const dir = tmp();
  const t = buildCanary({ outDir: dir, seed: 'unit' });
  assert.equal(t.tokens.length, TECHNIQUES.length + 2);
  for (const tok of t.tokens) assert.ok(fs.existsSync(path.join(dir, tok.page)), tok.page);
  for (const f of ['index.html', 'llms.txt', 'tokens.json', 'pages/control-clean.html', 'pages/follow-target.html']) assert.ok(fs.existsSync(path.join(dir, f)), f);
  assert.equal(new Set(t.tokens.map((x) => x.token)).size, t.tokens.length, 'tokens are unique');
});

test('every page is labelled as a harmless test and kept out of search indexes', () => {
  const dir = tmp();
  buildCanary({ outDir: dir });
  for (const f of fs.readdirSync(path.join(dir, 'pages')).filter((x) => x.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(dir, 'pages', f), 'utf8');
    assert.match(html, /steering-watch canary page/, f);
    assert.match(html, /harmless/, f);
    assert.match(html, /name="robots" content="noindex"/, f);
  }
});

test('the scanner catches every technique with the rule the suite expects', () => {
  const dir = tmp();
  const t = buildCanary({ outDir: dir, seed: 'fixture' });
  for (const tok of t.tokens) {
    const text = fs.readFileSync(path.join(dir, tok.page), 'utf8');
    const rules = scanText(text).findings.map((f) => f.rule);
    assert.ok(tok.expect.some((r) => rules.includes(r)), `${tok.id}: expected one of ${tok.expect} but got ${rules}`);
  }
});

test('control pages produce no finding at steering level or above', () => {
  const dir = tmp();
  buildCanary({ outDir: dir });
  for (const f of ['control-clean.html', 'control-ai-product-copy.html', 'follow-target.html']) {
    const r = scanText(fs.readFileSync(path.join(dir, 'pages', f), 'utf8'));
    const bad = r.findings.filter((x) => TIER_RANK[x.tier] >= TIER_RANK.steering);
    assert.equal(bad.length, 0, f + ': ' + JSON.stringify(bad));
  }
});

test('the canary code is never placed on a page as a bare label that would leak it', () => {
  const dir = tmp();
  const t = buildCanary({ outDir: dir });
  const follow = t.tokens.find((x) => x.id === 'follow-link');
  const html = fs.readFileSync(path.join(dir, 'pages', 'follow-link.html'), 'utf8');
  assert.ok(!html.includes(follow.token), 'the first page must not contain the code it asks the agent to find on the second');
  assert.ok(fs.readFileSync(path.join(dir, 'pages', 'follow-target.html'), 'utf8').includes(follow.token));
});

test('scoring an agent reply lists which codes appeared', () => {
  const dir = tmp();
  const t = buildCanary({ outDir: dir, seed: 'score' });
  const a = t.tokens[0];
  const b = t.tokens[3];
  const res = scoreReply(t, `Here is the summary. ${a.token}\nAnd ${b.token} too. SWC-DEADBEEF`);
  assert.equal(res.obeyed, 2);
  assert.equal(res.total, t.tokens.length);
  assert.deepEqual(res.unknown, ['SWC-DEADBEEF']);
  assert.equal(res.rows.find((r) => r.id === a.id).obeyed, true);
  assert.match(formatScore(res, 'agent-x'), /agent-x: 2 of \d+ canary codes appeared/);
  assert.equal(scoreReply(t, 'nothing here').obeyed, 0);
  assert.equal(scoreReply(t, a.token, { only: [a.id] }).total, 1);
});

test('the local server serves pages on localhost and refuses paths outside the folder', async () => {
  const dir = tmp();
  buildCanary({ outDir: dir });
  const server = await serveCanary({ dir, port: 0 });
  const { port } = server.address();
  try {
    const ok = await fetch(`http://127.0.0.1:${port}/pages/visible-text.html`);
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('content-type'), /text\/html/);
    assert.equal(ok.headers.get('x-robots-tag'), 'noindex');
    const missing = await fetch(`http://127.0.0.1:${port}/nope.html`);
    assert.equal(missing.status, 404);
    const escape = await fetch(`http://127.0.0.1:${port}/..%2f..%2fpackage.json`);
    assert.equal(escape.status, 404);
  } finally {
    server.close();
  }
});
