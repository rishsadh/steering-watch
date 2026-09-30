// Hidden-text detection: invisible characters, comments, visually hidden elements, attributes,
// structured-data blocks and base64 strings that speak to an AI reader.
import { addressesAI } from './rules.js';

const MAX_QUOTE = 240;

export function clip(s, n = MAX_QUOTE) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 3) + '...' : t;
}

export function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

export function lineOf(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

const HIDDEN_STYLE =
  /display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?![.\d])|opacity\s*:\s*0(?![.\d])|(?:left|top|text-indent|margin-left)\s*:\s*-\d{3,}(?:px|em|rem)?|color\s*:\s*(?:#fff(?:fff)?\b|white\b|transparent)|(?:^|[\s;])(?:width|height)\s*:\s*0(?:px)?\s*(?:;|$)|clip(?:-path)?\s*:\s*(?:rect\(0|inset\(50%)|position\s*:\s*absolute[^"']*overflow\s*:\s*hidden/i;
const HIDDEN_CLASS = /\b(?:sr-only|visually-hidden|screen-reader-text|hidden|d-none|invisible)\b/i;

export function stripTags(html) {
  return html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

const INVISIBLE = /[\u200B\u2060-\u2064\uFEFF]/g;
const BIDI = /[\u202A-\u202E\u2066-\u2069]/g;
const TAGCHARS = /[\u{E0000}-\u{E007F}]+/gu;

export function scanHidden(text) {
  const out = [];
  const starts = lineStarts(text);
  const push = (offset, rule, confidence, quote, note, tier = 'hidden') =>
    out.push({ rule, tier, confidence, line: lineOf(starts, offset), quote: clip(quote), note });

  // zero-width characters (a BOM at the very start is normal)
  {
    const perLine = new Map();
    for (const m of text.matchAll(INVISIBLE)) {
      if (m.index === 0 && m[0] === '\uFEFF') continue;
      const ln = lineOf(starts, m.index);
      const e = perLine.get(ln) || { count: 0, offset: m.index, maxRun: 0 };
      e.count++;
      perLine.set(ln, e);
    }
    for (const m of text.matchAll(/[\u200B\u2060-\u2064\uFEFF]{8,}/g)) {
      const ln = lineOf(starts, m.index);
      const e = perLine.get(ln);
      if (e) e.maxRun = Math.max(e.maxRun, m[0].length);
    }
    for (const [ln, e] of perLine) {
      const raw = text.slice(starts[ln - 1], (starts[ln] ?? text.length) - 1);
      const shown = raw.replace(INVISIBLE, (c) => `[U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}]`);
      const binary = e.maxRun >= 8;
      // One or two stray characters are usually formatting debris, so they are noted, not graded as hidden text.
      const hiddenText = binary || e.count >= 3;
      push(
        starts[ln - 1],
        'zero-width',
        binary ? 'high' : hiddenText ? 'medium' : 'low',
        shown,
        binary ? `${e.count} zero-width characters, a run of ${e.maxRun}: possible binary-coded message` : `${e.count} zero-width character${e.count > 1 ? 's' : ''}${hiddenText ? '' : ', probably formatting debris'}`,
        hiddenText ? 'hidden' : 'literal',
      );
    }
  }

  // Unicode tag characters decode to a hidden ASCII message
  for (const m of text.matchAll(TAGCHARS)) {
    const before = text.codePointAt(Math.max(0, m.index - 2)) || 0;
    const prevCp = [...text.slice(Math.max(0, m.index - 2), m.index)].pop();
    if (prevCp && prevCp.codePointAt(0) === 0x1f3f4) continue; // subdivision flag emoji
    void before;
    const decoded = [...m[0]]
      .map((c) => c.codePointAt(0))
      .filter((cp) => cp >= 0xe0020 && cp <= 0xe007e)
      .map((cp) => String.fromCharCode(cp - 0xe0000))
      .join('');
    if (!decoded) continue;
    push(m.index, 'tag-characters', 'high', decoded, `${[...m[0]].length} invisible tag characters decode to this text`);
  }

  // bidirectional controls
  {
    const seen = new Set();
    for (const m of text.matchAll(BIDI)) {
      const ln = lineOf(starts, m.index);
      if (seen.has(ln)) continue;
      seen.add(ln);
      const raw = text.slice(starts[ln - 1], (starts[ln] ?? text.length) - 1).replace(BIDI, (c) => `[U+${c.codePointAt(0).toString(16).toUpperCase()}]`);
      push(m.index, 'bidi-control', 'low', raw, 'bidirectional control character that can reorder text on screen', 'literal');
    }
  }

  // HTML comments and Markdown comments
  for (const m of text.matchAll(/<!--([\s\S]*?)-->/g)) {
    if (addressesAI(m[1])) push(m.index, 'html-comment', 'high', m[1], 'comment that speaks to an AI reader');
  }
  for (const m of text.matchAll(/^\[(?:\/\/|comment)\]:\s*(?:#|<>)\s*(?:"([^"]*)"|'([^']*)'|\(([^)]*)\))/gim)) {
    const body = m[1] ?? m[2] ?? m[3] ?? '';
    if (addressesAI(body)) push(m.index, 'html-comment', 'high', body, 'Markdown comment that speaks to an AI reader');
  }

  // visually hidden elements
  const VOID = new Set(['img', 'br', 'hr', 'meta', 'link', 'input', 'source', 'area', 'base', 'col', 'embed', 'wbr']);
  for (const m of text.matchAll(/<([a-z][a-z0-9]*)\b([^>]*)>/gi)) {
    const tag = m[1].toLowerCase();
    if (VOID.has(tag) || m[0].endsWith('/>')) continue;
    const attrs = m[2];
    const style = /style\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attrs);
    const cls = /class\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attrs);
    const hidden =
      (style && HIDDEN_STYLE.test(style[2] ?? style[3] ?? '')) ||
      /(?:^|\s)hidden(?:\s|=|$)/i.test(attrs) ||
      (cls && HIDDEN_CLASS.test(cls[2] ?? cls[3] ?? ''));
    if (!hidden) continue;
    // find the matching close tag, counting nested tags of the same name
    const start = m.index + m[0].length;
    const tagRe = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
    tagRe.lastIndex = start;
    let depth = 1;
    let end = text.length;
    for (let t = tagRe.exec(text); t; t = tagRe.exec(text)) {
      depth += t[1] ? -1 : t[0].endsWith('/>') ? 0 : 1;
      if (depth === 0) {
        end = t.index;
        break;
      }
    }
    const inner = stripTags(text.slice(start, end));
    if (addressesAI(inner)) push(m.index, 'css-hidden', 'high', inner, `text in a hidden <${tag}> element speaks to an AI reader`);
  }

  // alt, title, aria-label, meta content and Markdown link titles
  for (const m of text.matchAll(/\b(alt|title|aria-label|aria-description|content|placeholder|data-[\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    const v = m[2] ?? m[3] ?? '';
    if (v.length > 15 && addressesAI(v)) push(m.index, 'attribute-text', 'medium', v, `${m[1].toLowerCase()} attribute speaks to an AI reader`);
  }
  for (const m of text.matchAll(/\]\(\s*[^)\s]+\s+"([^"]{16,})"\s*\)/g)) {
    if (addressesAI(m[1])) push(m.index, 'attribute-text', 'medium', m[1], 'Markdown link title speaks to an AI reader');
  }

  // JSON-LD, noscript and template blocks
  for (const re of [
    /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
    /<noscript[^>]*>([\s\S]*?)<\/noscript>/gi,
    /<template[^>]*>([\s\S]*?)<\/template>/gi,
  ]) {
    for (const m of text.matchAll(re)) {
      const inner = stripTags(m[1]);
      if (addressesAI(inner)) push(m.index, 'structured-data-text', 'medium', inner, 'structured-data, noscript or template block speaks to an AI reader');
    }
  }

  // base64 strings that decode to an instruction
  for (const m of text.matchAll(/[A-Za-z0-9+/]{40,}={0,2}/g)) {
    let decoded = '';
    try {
      decoded = Buffer.from(m[0], 'base64').toString('utf8');
    } catch {
      continue;
    }
    if (decoded.length < 20) continue;
    const printable = [...decoded].filter((c) => c >= ' ' && c <= '~').length / decoded.length;
    if (printable >= 0.95 && addressesAI(decoded)) push(m.index, 'base64-text', 'medium', decoded, 'base64 string decodes to text that speaks to an AI reader');
  }

  return out;
}
