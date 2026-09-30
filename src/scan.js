// The scanner engine: read text (llms.txt, Markdown, HTML) and report each AI-directed
// instruction, hidden-text pattern or command pattern with an exact quote and a line number.
import { createHash } from 'node:crypto';
import { AI_WORD, LINE_RULES, RULES_VERSION, TIER_RANK, contextAllows, headingAddressesAI } from './rules.js';
import { clip, scanHidden, stripTags } from './hidden.js';

const CONF_RANK = { low: 0, medium: 1, high: 2 };

function stripEmphasis(s) {
  return s.replace(/\*\*|__/g, '');
}

// Replace inline code spans with filler so prose rules do not fire inside them.
function maskInlineCode(s) {
  return s.replace(/`[^`]*`/g, (m) => ' '.repeat(m.length));
}

// Group raw lines into logical units: a list item or paragraph that wraps over several lines
// is one unit, so a sentence split across lines is still matched as a sentence.
function logicalUnits(lines) {
  const units = [];
  let inFence = false;
  let cur = null;
  const flush = () => {
    if (cur) units.push(cur);
    cur = null;
  };
  lines.forEach((raw, i) => {
    const n = i + 1;
    if (/^\s*(```|~~~)/.test(raw)) {
      flush();
      inFence = !inFence;
      units.push({ line: n, text: raw, fence: true, marker: true });
      return;
    }
    if (inFence) {
      flush();
      units.push({ line: n, text: raw, fence: true });
      return;
    }
    if (!raw.trim()) return flush();
    const heading = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (heading) {
      flush();
      units.push({ line: n, text: raw, heading: { level: heading[1].length, text: heading[2].trim() } });
      return;
    }
    const isItem = /^\s*(?:[-*+]|\d+[.)])\s+/.test(raw) || /^\s*>/.test(raw);
    if (cur && !isItem && !cur.quote) {
      cur.text += ' ' + raw.trim();
      return;
    }
    flush();
    cur = { line: n, text: raw.trim(), quote: /^\s*>/.test(raw) };
  });
  flush();
  return units;
}

export function findingId(f) {
  return createHash('sha1').update(`${f.rule}\n${f.quote}`).digest('hex').slice(0, 10);
}

// Scan text. Returns { findings, stats }.
export function scanText(text) {
  const body = text.replace(/\r\n?/g, '\n');
  const isHtml = /^\s*<!doctype html|<html[\s>]/i.test(body.slice(0, 2000));
  let visible = body;
  if (isHtml) {
    // For the visible-text pass: drop style, script and comment blocks (the hidden-text pass reads
    // those from the raw text), keep line numbers, and treat each line on its own.
    visible = body.replace(/<(style|script|title)\b[\s\S]*?<\/\1>|<!--[\s\S]*?-->/gi, (m) => m.replace(/[^\n]/g, ' '));
  }
  const lines = visible.split('\n');
  const findings = [];
  const headings = [];

  const units = isHtml
    ? lines.map((raw, i) => ({ line: i + 1, text: stripTags(raw).replace(/\s+/g, ' ').trim() })).filter((u) => u.text)
    : logicalUnits(lines);
  for (const u of units) {
    if (u.marker) continue;
    if (u.heading) {
      while (headings.length && headings[headings.length - 1].level >= u.heading.level) headings.pop();
      headings.push(u.heading);
      continue;
    }
    const plain = stripEmphasis(u.text);
    // A link-list entry ("- [Title](url): description") is a catalogue line. Its title and URL are
    // not instructions, and its description only counts under a heading that addresses an AI reader.
    const linkEntry = /^\s*[-*+]\s+\[[^\]]*\]\([^)]*\)/.test(u.text);
    let prose = maskInlineCode(plain).replace(/\]\([^)]*\)/g, ']');
    if (linkEntry) prose = prose.replace(/\[[^\]]*\]/g, ' ');
    const headingText = headings.length ? headings[headings.length - 1].text : '';
    const headingAI = headings.some((h) => headingAddressesAI(h.text));
    const lineAI = !linkEntry && AI_WORD.test(prose);
    for (const r of LINE_RULES) {
      if (u.fence) {
        if (!r.literalWhenCode) continue;
        if (!r.re.test(plain)) continue;
        findings.push(make(r, 'literal', u, headingText, 'in a code fence: shown as a sample, not an instruction'));
        continue;
      }
      const hitProse = r.re.test(prose);
      if (hitProse) {
        if (!contextAllows(r, { headingAI, lineAI })) continue;
        const demote = r.demoteIf && r.demoteIf.test(prose);
        findings.push(make(r, demote ? 'terms' : r.tier, u, headingText, demote ? 'a usage term addressed to AI readers' : r.why));
      } else if (r.literalWhenCode && r.re.test(plain)) {
        findings.push(make(r, 'literal', u, headingText, 'in inline code: shown as a sample, not an instruction'));
      }
    }
  }

  for (const h of scanHidden(body)) {
    findings.push({ ...h, heading: '', why: h.note });
  }

  // one finding per (rule, line)
  const seen = new Set();
  const unique = [];
  for (const f of findings) {
    const k = `${f.rule}:${f.line}`;
    if (seen.has(k)) continue;
    seen.add(k);
    f.id = findingId(f);
    unique.push(f);
  }
  unique.sort((a, b) => a.line - b.line || TIER_RANK[b.tier] - TIER_RANK[a.tier]);
  return { findings: unique, stats: summarize(unique, body, lines.length) };
}

function make(rule, tier, unit, heading, why) {
  return {
    rule: rule.id,
    tier,
    confidence: rule.confidence,
    line: unit.line,
    heading,
    quote: clip(unit.text.replace(/\*\*|__/g, '')),
    why,
  };
}

// The worst finding on each line, so a line that trips three rules is counted once.
export function bestPerLine(findings) {
  const best = new Map();
  for (const f of findings) {
    const cur = best.get(f.line);
    if (!cur || TIER_RANK[f.tier] > TIER_RANK[cur.tier] || (TIER_RANK[f.tier] === TIER_RANK[cur.tier] && CONF_RANK[f.confidence] > CONF_RANK[cur.confidence])) {
      best.set(f.line, f);
    }
  }
  return [...best.values()].sort((a, b) => a.line - b.line);
}

export function worstTier(findings) {
  let worst = null;
  for (const f of findings) if (worst === null || TIER_RANK[f.tier] > TIER_RANK[worst]) worst = f.tier;
  return worst;
}

function summarize(findings, body, lineCount) {
  const tiers = {};
  for (const f of bestPerLine(findings)) tiers[f.tier] = (tiers[f.tier] || 0) + 1;
  return {
    rules_version: RULES_VERSION,
    bytes: Buffer.byteLength(body),
    lines: lineCount,
    sha256: createHash('sha256').update(body).digest('hex'),
    tier_counts: tiers,
    worst: worstTier(findings),
  };
}
