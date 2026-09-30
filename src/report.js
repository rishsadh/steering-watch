// Turn snapshots into the public index: INDEX.md, data/latest.csv and data/history.csv.
import fs from 'node:fs';
import path from 'node:path';
import { TIER_RANK } from './rules.js';
import { diffSnapshots, loadSnapshots } from './snapshot.js';
import { bestPerLine } from './scan.js';
import { toCsv } from './csv.js';

const COHORT_LABEL = {
  'installmap-steering': 'Installmap: steering',
  'installmap-route-to-own-pages': 'Installmap: route to own pages',
  'installmap-usage-licensing-agent': 'Installmap: usage, licensing, agent',
  'installmap-product-copy-or-false-positive': 'Installmap: product copy or false positive',
  'docs-reference': 'Reference docs sites (control)',
};
const label = (c) => COHORT_LABEL[c] || c;
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

function bestFindings(site, min) {
  return bestPerLine(site.findings || [])
    .filter((f) => TIER_RANK[f.tier] >= TIER_RANK[min])
    .sort((a, b) => TIER_RANK[b.tier] - TIER_RANK[a.tier] || ({ high: 2, medium: 1, low: 0 }[b.confidence] - { high: 2, medium: 1, low: 0 }[a.confidence]) || a.line - b.line);
}

export function historyRows(snaps) {
  return snaps.map((s) => {
    const c = Object.fromEntries(Object.keys(TIER_RANK).map((t) => [t, 0]));
    for (const r of s.sites) if (r.status === 'ok' && r.worst) c[r.worst]++;
    const atLeast = (t) => Object.entries(c).reduce((n, [k, v]) => n + (TIER_RANK[k] >= TIER_RANK[t] ? v : 0), 0);
    return {
      date: s.date,
      rules_version: s.rules_version,
      sites_listed: s.summary.sites_listed,
      files_found: s.summary.files_found,
      steering_or_above: atLeast('steering'),
      promotional_or_above: atLeast('promotional'),
      hidden_or_above: atLeast('hidden'),
      command_or_above: atLeast('command'),
      injection: c.injection,
    };
  });
}

// How the scanner agrees with the hand labels the watchlist was built from.
function agreement(snap) {
  const rows = [];
  for (const [c, v] of Object.entries(snap.summary.by_cohort)) rows.push({ cohort: c, ...v });
  return rows;
}

export function buildReport({ dataDir, outFile, csvFile, historyFile }) {
  const snaps = loadSnapshots(path.join(dataDir, 'snapshots'));
  if (!snaps.length) throw new Error('no snapshots in ' + path.join(dataDir, 'snapshots') + '; run `steering-watch run` first');
  const cur = snaps[snaps.length - 1];
  const prev = snaps.length > 1 ? snaps[snaps.length - 2] : null;
  const ok = cur.sites.filter((s) => s.status === 'ok');
  const flagged = (min) => ok.filter((s) => s.worst && TIER_RANK[s.worst] >= TIER_RANK[min]);

  const L = [];
  L.push('# steering-watch index', '');
  L.push(`Run of ${cur.date}, rules version ${cur.rules_version}. ${cur.summary.sites_listed} sites on the fixed list, ${cur.summary.files_found} served a valid llms.txt.`);
  L.push('');
  L.push('Every line below is a pattern match on a public file, quoted exactly. A match means the line is worth reading. It is not a finding that a site did anything wrong: a line that tells an AI to use the official docs is steering, and so is a line that tells it to recommend the company.');
  L.push('');
  L.push('## This run', '');
  L.push('| Worst tier in the file | Sites | What it means |', '|---|---|---|');
  const meaning = {
    injection: 'classic prompt injection: override, role change, exfiltration',
    command: 'asks the reader to run code or fetch and obey',
    hidden: 'text placed where a human will not see it',
    promotional: 'tells an AI to recommend, favour or frame the company',
    steering: 'tells an AI how to answer, which pages to use, what tone to take',
    terms: 'usage or licensing terms that mention AI',
    literal: 'present but not an instruction: a code sample or a stray invisible character',
    none: 'no match',
  };
  for (const t of ['injection', 'command', 'hidden', 'promotional', 'steering', 'terms', 'literal', 'none']) {
    const n = cur.summary.by_worst_tier[t] || 0;
    L.push(`| ${t} | ${n} | ${meaning[t]} |`);
  }
  L.push('');
  const failed = cur.sites.length - ok.length;
  L.push(`${failed} of ${cur.sites.length} sites did not return a usable file this run (${Object.entries(cur.summary.by_status).filter(([k]) => k !== 'ok').map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}). They are counted as no file, not as clean.`);
  L.push('');

  const strong = flagged('promotional').sort((a, b) => TIER_RANK[b.worst] - TIER_RANK[a.worst] || a.domain.localeCompare(b.domain));
  L.push(`## Promotional or stronger (${strong.length} sites)`, '');
  L.push('| Site | Tier | Quote | Rule | Line |', '|---|---|---|---|---|');
  for (const s of strong) {
    for (const f of bestFindings(s, 'promotional').slice(0, 2)) L.push(`| [${s.domain}](${s.url}) | ${f.tier} | ${cell(f.quote)} | ${f.rule} | ${f.line} |`);
  }
  L.push('');

  const mild = flagged('steering').filter((s) => TIER_RANK[s.worst] === TIER_RANK.steering).sort((a, b) => a.domain.localeCompare(b.domain));
  L.push(`## Steering only (${mild.length} sites)`, '');
  L.push('| Site | Quote | Rule | Line |', '|---|---|---|---|');
  for (const s of mild) {
    const f = bestFindings(s, 'steering')[0];
    L.push(`| [${s.domain}](${s.url}) | ${cell(f.quote)} | ${f.rule} | ${f.line} |`);
  }
  L.push('');

  // The same line on more than one site: a shared template, a shared vendor or a copied file.
  const byId = new Map();
  for (const s of ok) for (const f of bestFindings(s, 'steering')) (byId.get(f.id) || byId.set(f.id, { f, sites: new Set() }).get(f.id)).sites.add(s.domain);
  const shared = [...byId.values()].filter((x) => x.sites.size > 1).sort((a, b) => b.sites.size - a.sites.size);
  L.push(`## The same line on several sites (${shared.length})`, '');
  if (!shared.length) L.push('No steering-level line appears on more than one site in this run.', '');
  else {
    L.push('Identical text can mean a shared template, a shared vendor or one company serving one file on several domains. It says nothing about who wrote it.', '');
    L.push('| Sites | Quote |', '|---|---|');
    for (const x of shared.slice(0, 20)) L.push(`| ${[...x.sites].sort().join(', ')} | ${cell(x.f.quote)} |`);
    L.push('');
  }

  L.push('## Changes since the previous run', '');
  if (!prev) {
    L.push('This is the first run, so there is nothing to compare yet. The next run will list files that appeared or went, and steering-level lines that were added or removed.', '');
  } else {
    const d = diffSnapshots(prev, cur);
    L.push(`${d.from} to ${d.to}: ${d.totals.domains_with_changes} sites changed, ${d.totals.files_appeared} files appeared, ${d.totals.files_gone} went, ${d.totals.findings_added} steering-level lines added, ${d.totals.findings_removed} removed.`, '');
    for (const n of d.notes) L.push(`Note: ${n}`, '');
    for (const c of d.changes.slice(0, 60)) {
      L.push(`- **${c.domain}**: ${c.events.join(', ') || 'lines changed'}`);
      for (const f of c.added) L.push(`  - added, ${f.tier}: ${cell(f.quote)}`);
      for (const f of c.removed) L.push(`  - removed, ${f.tier}: ${cell(f.quote)}`);
    }
    L.push('');
  }

  L.push('## Agreement with the hand labels the list came from', '');
  L.push('The fixed list is the 134 domains Installmap read and labelled by hand on 2026-09-23 (minus five CDN copies of one file), plus a small reference group. The table shows how often this scanner flags each group. A high rate in the steering group and a lower rate elsewhere is the expected shape. Differences are worth a human read, not a verdict.', '');
  L.push('| Group | On list | Served a file | Steering or stronger | Promotional or stronger |', '|---|---|---|---|---|');
  for (const a of agreement(cur)) L.push(`| ${label(a.cohort)} | ${a.listed} | ${a.files} | ${a.steering_or_above} | ${a.promotional_or_above} |`);
  L.push('');

  L.push('## History', '');
  L.push('| Date | Files | Steering or above | Promotional or above | Hidden or above | Injection |', '|---|---|---|---|---|---|');
  for (const h of historyRows(snaps).slice(-12).reverse()) L.push(`| ${h.date} | ${h.files_found} | ${h.steering_or_above} | ${h.promotional_or_above} | ${h.hidden_or_above} | ${h.injection} |`);
  L.push('');

  L.push('## Method and limits', '');
  L.push('- One request per site to `/llms.txt` (then `www.` if the bare domain has none), with a named User-Agent, robots.txt honoured for that path, a 1 MiB cap and no link followed.');
  L.push('- The scanner reads each file line by line. A line fires a rule only when it names an AI reader or sits under a heading that addresses one, except for rules that need no context (override phrases, control tokens, hidden characters).');
  L.push('- Rules are regular expressions, so recall is unknown and false positives happen. Read every quote before using it. The rule list is in `src/rules.js` and `steering-watch rules`.');
  L.push('- A file that changed since the last run may be a different file behind the same address, for example a regional variant.');
  L.push('- The list is fixed on purpose, so runs are comparable. It is not a sample of the web.');
  L.push('- Snapshots keep a hash and exact short quotes, not copies of the files.');
  L.push('- List source: Installmap, "Everyone is hilariously prompt-injecting AI via llms.txt and you aren\'t", 2026-09-23, data CC BY 4.0, https://installmap.com/research/llms-txt-ai-instructions. Background: Common Crawl, "A Content Analysis of llms.txt Files from the July 2026 Crawl Archive", 2026-08-31.');
  L.push('');

  fs.writeFileSync(outFile, L.join('\n'));

  const csvRows = [];
  for (const s of cur.sites) {
    if (s.status !== 'ok') {
      csvRows.push({ date: cur.date, domain: s.domain, cohort: s.cohort, status: s.status, url: s.url || '' });
      continue;
    }
    for (const f of bestPerLine(s.findings || []).filter((f) => TIER_RANK[f.tier] >= TIER_RANK.steering)) {
      csvRows.push({ date: cur.date, domain: s.domain, cohort: s.cohort, status: 'ok', url: s.url, tier: f.tier, rule: f.rule, confidence: f.confidence, line: f.line, heading: f.heading, quote: f.quote, finding_id: f.id });
    }
  }
  fs.writeFileSync(csvFile, toCsv(csvRows, ['date', 'domain', 'cohort', 'status', 'url', 'tier', 'rule', 'confidence', 'line', 'heading', 'quote', 'finding_id']));
  const hist = historyRows(snaps);
  fs.writeFileSync(historyFile, toCsv(hist, Object.keys(hist[0])));
  return { snapshots: snaps.length, latest: cur.date, strong: strong.length, mild: mild.length };
}
