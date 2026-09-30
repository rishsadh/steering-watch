// Run the index: fetch /llms.txt for each site on the fixed list, scan it, and write a dated
// snapshot. Snapshots keep hashes and exact short quotes, not full copies of other people's files.
import fs from 'node:fs';
import path from 'node:path';
import { RULES_VERSION, TIER_RANK } from './rules.js';
import { bestPerLine, scanText } from './scan.js';
import { fetchLlmsTxt, USER_AGENT } from './fetch.js';
import { parseCsv } from './csv.js';

export function loadWatchlist(file) {
  const rows = parseCsv(fs.readFileSync(file, 'utf8'));
  const seen = new Set();
  return rows
    .filter((r) => r.domain && !seen.has(r.domain) && seen.add(r.domain))
    .map((r) => ({ domain: r.domain.trim().toLowerCase(), cohort: r.cohort || 'unlisted', tranco_rank: r.tranco_rank || '', source: r.source || '' }));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function scanSite(site, { keepRaw = null, fetcher = fetchLlmsTxt } = {}) {
  const got = await fetcher(site.domain);
  const rec = { domain: site.domain, cohort: site.cohort, status: got.status, url: got.url || null, http: got.http ?? null };
  if (got.detail) rec.detail = got.detail;
  if (got.status !== 'ok') return rec;
  const { findings, stats } = scanText(got.text);
  if (keepRaw) {
    fs.mkdirSync(keepRaw, { recursive: true });
    fs.writeFileSync(path.join(keepRaw, site.domain + '.llms.txt'), got.text);
  }
  rec.bytes = stats.bytes;
  rec.lines = stats.lines;
  rec.sha256 = stats.sha256;
  if (got.truncated) rec.truncated = true;
  rec.worst = stats.worst;
  rec.tier_counts = stats.tier_counts;
  rec.findings = findings.map((f) => ({ id: f.id, rule: f.rule, tier: f.tier, confidence: f.confidence, line: f.line, heading: f.heading, quote: f.quote }));
  return rec;
}

export function summarizeSnapshot(sites) {
  const s = { sites_listed: sites.length, files_found: 0, by_status: {}, by_worst_tier: {}, steering_or_above: 0, by_cohort: {} };
  for (const r of sites) {
    s.by_status[r.status] = (s.by_status[r.status] || 0) + 1;
    const c = (s.by_cohort[r.cohort] ||= { listed: 0, files: 0, steering_or_above: 0, promotional_or_above: 0 });
    c.listed++;
    if (r.status !== 'ok') continue;
    s.files_found++;
    c.files++;
    const w = r.worst || 'none';
    s.by_worst_tier[w] = (s.by_worst_tier[w] || 0) + 1;
    if (r.worst && TIER_RANK[r.worst] >= TIER_RANK.steering) {
      s.steering_or_above++;
      c.steering_or_above++;
    }
    if (r.worst && TIER_RANK[r.worst] >= TIER_RANK.promotional) c.promotional_or_above++;
  }
  return s;
}

export async function runIndex({ watchlist, outDir, date, concurrency = 4, delayMs = 400, keepRaw = null, log = () => {}, fetcher } = {}) {
  const list = loadWatchlist(watchlist);
  const results = new Array(list.length);
  let next = 0;
  const started = new Date().toISOString();
  async function worker() {
    while (next < list.length) {
      const i = next++;
      results[i] = await scanSite(list[i], { keepRaw, fetcher });
      log(i + 1, list.length, results[i]);
      await sleep(delayMs);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
  const snap = {
    tool: 'steering-watch',
    rules_version: RULES_VERSION,
    user_agent: USER_AGENT,
    date: date || started.slice(0, 10),
    started_at: started,
    finished_at: new Date().toISOString(),
    summary: summarizeSnapshot(results),
    sites: results,
  };
  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, snap.date + '.json'), JSON.stringify(snap, null, 1) + '\n');
  }
  return snap;
}

export function loadSnapshots(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

// Compare two snapshots: who added or removed AI-directed text, and whose file appeared or went.
export function diffSnapshots(a, b) {
  const byA = new Map(a.sites.map((s) => [s.domain, s]));
  const byB = new Map(b.sites.map((s) => [s.domain, s]));
  const domains = [...new Set([...byA.keys(), ...byB.keys()])];
  const out = [];
  const notes = [];
  if (a.rules_version !== b.rules_version) notes.push(`rules_version changed from ${a.rules_version} to ${b.rules_version}: finding differences may come from the rules, not the files`);
  const relevant = (f) => TIER_RANK[f.tier] >= TIER_RANK.steering;
  for (const d of domains) {
    const x = byA.get(d);
    const y = byB.get(d);
    const events = [];
    if (!x) events.push('site added to the list');
    else if (!y) events.push('site removed from the list');
    else {
      const xo = x.status === 'ok';
      const yo = y.status === 'ok';
      if (!xo && yo) events.push('file appeared');
      else if (xo && !yo) events.push(`file gone (${y.status})`);
      else if (xo && yo && x.sha256 !== y.sha256) events.push('file changed');
    }
    const fx = new Map(((x && x.findings) || []).filter(relevant).map((f) => [f.id, f]));
    const fy = new Map(((y && y.findings) || []).filter(relevant).map((f) => [f.id, f]));
    const added = [...fy.values()].filter((f) => !fx.has(f.id));
    const removed = [...fx.values()].filter((f) => !fy.has(f.id));
    if (events.length || added.length || removed.length) out.push({ domain: d, cohort: (y || x).cohort, events, added, removed });
  }
  const totals = {
    domains_with_changes: out.length,
    files_appeared: out.filter((o) => o.events.includes('file appeared')).length,
    files_gone: out.filter((o) => o.events.some((e) => e.startsWith('file gone'))).length,
    findings_added: out.reduce((n, o) => n + o.added.length, 0),
    findings_removed: out.reduce((n, o) => n + o.removed.length, 0),
  };
  return { from: a.date, to: b.date, notes, totals, changes: out };
}

export function formatDiff(d) {
  const L = [`steering-watch diff ${d.from} -> ${d.to}`];
  for (const n of d.notes) L.push(`note: ${n}`);
  if (!d.changes.length) L.push('no changes in files or in steering-level findings');
  for (const c of d.changes) {
    L.push(`${c.domain}  [${c.cohort}]  ${c.events.join(', ') || 'findings changed'}`);
    for (const f of c.added) L.push(`  + ${f.tier}/${f.rule} line ${f.line}: ${f.quote}`);
    for (const f of c.removed) L.push(`  - ${f.tier}/${f.rule} line ${f.line}: ${f.quote}`);
  }
  const t = d.totals;
  L.push(`${t.domains_with_changes} domains changed, ${t.files_appeared} files appeared, ${t.files_gone} gone, ${t.findings_added} findings added, ${t.findings_removed} removed`);
  return L.join('\n');
}

export { bestPerLine };
