#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TIER_RANK, TIERS, describeRules } from '../src/rules.js';
import { bestPerLine, scanText } from '../src/scan.js';
import { fetchLlmsTxt } from '../src/fetch.js';
import { diffSnapshots, formatDiff, loadSnapshots, runIndex } from '../src/snapshot.js';
import { buildReport } from '../src/report.js';
import { DEFAULT_SEED, buildCanary, formatScore, scoreReply, serveCanary } from '../src/canary.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const HELP = `steering-watch: find AI-directed instructions in llms.txt files

Usage
  steering-watch scan <file | domain | url | -> [...]   scan text for steering, hidden text and commands
        --json            machine-readable output
        --min <tier>      show findings at this tier or above (default: steering)
        --fail-on <tier>  exit 1 if any file has this tier or above (default: never)
  steering-watch run [--sites file] [--data dir]        fetch the fixed site list, scan it, write a dated snapshot
        --keep-raw <dir>  also save the fetched files (off by default)
        --no-report       skip rebuilding INDEX.md
  steering-watch report [--data dir] [--out INDEX.md]   rebuild INDEX.md and the CSV files from the snapshots
  steering-watch diff [old.json new.json]               who added or removed AI-directed text between two runs
  steering-watch rules                                  list every rule with its tier and confidence
  steering-watch canary build [--out dir] [--seed s]    write the harmless canary test pages
  steering-watch canary serve [--dir dir] [--port n]    serve them on localhost
  steering-watch canary score <tokens.json> <reply | -> check which canary codes an agent reply contains
        --agent <name>  --only <id,id>  --json

Tiers, weakest to strongest: ${TIERS.join(', ')}
`;

function parseArgs(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const flagOnly = ['json', 'no-report', 'help'].includes(k);
      opt[k] = flagOnly ? true : argv[++i];
    } else pos.push(a);
  }
  return { pos, opt };
}

function needTier(t, name) {
  if (t !== undefined && !(t in TIER_RANK)) {
    console.error(`unknown tier "${t}" for --${name}. Use one of: ${TIERS.join(', ')}`);
    process.exit(2);
  }
}

async function readSource(src) {
  if (src === '-') return { name: 'stdin', text: fs.readFileSync(0, 'utf8') };
  if (fs.existsSync(src)) return { name: src, text: fs.readFileSync(src, 'utf8') };
  if (/^https?:\/\//i.test(src)) {
    const r = await fetch(src, { headers: { 'user-agent': 'steering-watch/0.1 (+https://github.com/rishsadh/steering-watch)' } });
    return { name: src, text: await r.text() };
  }
  if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(src)) {
    const r = await fetchLlmsTxt(src.toLowerCase());
    if (r.status !== 'ok') throw new Error(`${src}: no usable /llms.txt (${r.status})`);
    return { name: r.url, text: r.text };
  }
  throw new Error(`cannot read ${src}: not a file, URL or domain`);
}

async function cmdScan({ pos, opt }) {
  if (!pos.length) return console.error('scan needs a file, domain, URL or - for stdin'), 2;
  needTier(opt.min, 'min');
  needTier(opt['fail-on'], 'fail-on');
  const min = opt.min || 'steering';
  let failed = false;
  const all = [];
  for (const src of pos) {
    let doc;
    try {
      doc = await readSource(src);
    } catch (e) {
      console.error(e.message);
      return 2;
    }
    const { findings, stats } = scanText(doc.text);
    const shown = findings.filter((f) => TIER_RANK[f.tier] >= TIER_RANK[min]);
    if (opt['fail-on'] && stats.worst && TIER_RANK[stats.worst] >= TIER_RANK[opt['fail-on']]) failed = true;
    if (opt.json) all.push({ source: doc.name, stats, findings: shown });
    else {
      const lines = bestPerLine(shown);
      console.log(`${doc.name}: ${lines.length} line${lines.length === 1 ? '' : 's'} at ${min} or above (worst in file: ${stats.worst || 'none'})`);
      for (const f of lines) {
        console.log(`  ${f.tier.padEnd(11)} ${f.rule.padEnd(22)} line ${String(f.line).padEnd(5)} [${f.confidence}]`);
        console.log(`    "${f.quote}"`);
        console.log(`    ${f.why}${f.heading ? `; under "${f.heading}"` : ''}`);
      }
    }
  }
  if (opt.json) console.log(JSON.stringify(all.length === 1 ? all[0] : all, null, 2));
  return failed ? 1 : 0;
}

async function cmdRun({ opt }) {
  const watchlist = opt.sites || path.join(ROOT, 'sites', 'watchlist.csv');
  const dataDir = path.resolve(opt.data || 'data');
  const t0 = Date.now();
  const snap = await runIndex({
    watchlist,
    outDir: path.join(dataDir, 'snapshots'),
    keepRaw: opt['keep-raw'] || null,
    concurrency: Number(opt.concurrency || 4),
    log: (i, n, r) => {
      const tag = r.status === 'ok' ? (r.worst || 'clean') : r.status;
      process.stderr.write(`\r${i}/${n} ${r.domain.padEnd(32)} ${tag.padEnd(14)}`);
    },
  });
  process.stderr.write('\n');
  const s = snap.summary;
  console.log(`steering-watch run ${snap.date}  (${Math.round((Date.now() - t0) / 1000)}s)`);
  console.log(`${s.sites_listed} sites listed, ${s.files_found} served a file, ${s.sites_listed - s.files_found} did not`);
  for (const t of ['injection', 'command', 'hidden', 'promotional', 'steering', 'terms', 'platform-default', 'literal', 'none']) {
    if (s.by_worst_tier[t]) console.log(`  ${t.padEnd(12)} ${String(s.by_worst_tier[t]).padStart(3)} files`);
  }
  console.log(`wrote ${path.relative(process.cwd(), path.join(dataDir, 'snapshots', snap.date + '.json')).split(path.sep).join('/')}`);
  if (!opt['no-report']) {
    const r = buildReport({ dataDir, outFile: path.resolve(opt.out || 'INDEX.md'), csvFile: path.join(dataDir, 'latest.csv'), historyFile: path.join(dataDir, 'history.csv') });
    console.log(`wrote INDEX.md: ${r.strong} promotional-or-stronger sites, ${r.mild} steering-only sites`);
  }
  return 0;
}

function cmdReport({ opt }) {
  const dataDir = path.resolve(opt.data || 'data');
  const r = buildReport({ dataDir, outFile: path.resolve(opt.out || 'INDEX.md'), csvFile: path.join(dataDir, 'latest.csv'), historyFile: path.join(dataDir, 'history.csv') });
  console.log(`rebuilt from ${r.snapshots} snapshot${r.snapshots === 1 ? '' : 's'}, latest ${r.latest}`);
  return 0;
}

function cmdDiff({ pos, opt }) {
  let a;
  let b;
  if (pos.length === 2) [a, b] = pos.map((p) => JSON.parse(fs.readFileSync(p, 'utf8')));
  else {
    const snaps = loadSnapshots(path.join(path.resolve(opt.data || 'data'), 'snapshots'));
    if (snaps.length < 2) return console.error('need two snapshots to compare'), 2;
    [a, b] = snaps.slice(-2);
  }
  const d = diffSnapshots(a, b);
  console.log(opt.json ? JSON.stringify(d, null, 2) : formatDiff(d));
  return 0;
}

function cmdRules() {
  for (const r of describeRules()) console.log(`${r.id.padEnd(22)} ${r.tier.padEnd(12)} ${r.confidence.padEnd(7)} ${r.why}`);
  return 0;
}

async function cmdCanary({ pos, opt }) {
  const [sub, ...rest] = pos;
  if (sub === 'build') {
    const out = path.resolve(opt.out || 'canary-site');
    const t = buildCanary({ outDir: out, seed: opt.seed || DEFAULT_SEED, base: opt.base || '' });
    console.log(`wrote ${t.tokens.length} canary pages and tokens.json to ${out} (seed "${t.seed}")`);
    return 0;
  }
  if (sub === 'serve') {
    const dir = path.resolve(opt.dir || 'canary-site');
    if (!fs.existsSync(dir)) return console.error(`${dir} not found; run "canary build" first`), 2;
    const port = Number(opt.port || 8787);
    await serveCanary({ dir, port });
    console.log(`serving ${dir} at http://127.0.0.1:${port}/ (Ctrl+C to stop)`);
    return new Promise(() => {});
  }
  if (sub === 'score') {
    if (rest.length < 2) return console.error('usage: canary score <tokens.json> <reply-file | ->'), 2;
    const table = JSON.parse(fs.readFileSync(rest[0], 'utf8'));
    const reply = rest[1] === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(rest[1], 'utf8');
    const res = scoreReply(table, reply, { only: opt.only ? opt.only.split(',') : null });
    console.log(opt.json ? JSON.stringify(res, null, 2) : formatScore(res, opt.agent || ''));
    return 0;
  }
  console.error('usage: canary build | serve | score');
  return 2;
}

async function main() {
  const [cmd, ...argv] = process.argv.slice(2);
  const args = parseArgs(argv);
  if (!cmd || cmd === 'help' || cmd === '--help' || args.opt.help) return console.log(HELP), 0;
  switch (cmd) {
    case 'scan':
      return cmdScan(args);
    case 'run':
      return cmdRun(args);
    case 'report':
      return cmdReport(args);
    case 'diff':
      return cmdDiff(args);
    case 'rules':
      return cmdRules();
    case 'canary':
      return cmdCanary(args);
    default:
      console.error(`unknown command "${cmd}"\n`);
      console.error(HELP);
      return 2;
  }
}

main().then(
  (code) => {
    if (typeof code === 'number' && code !== 0) process.exit(code);
  },
  (e) => {
    console.error(e && e.message ? e.message : e);
    process.exit(2);
  },
);
