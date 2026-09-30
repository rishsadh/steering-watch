// A polite fetcher for one file per site: /llms.txt. It names itself, honours robots.txt for that
// path, caps the body size, and never follows links inside the file.
export const USER_AGENT = 'steering-watch/0.1 (+https://github.com/rishsadh/steering-watch)';
const MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = 15000;

// Minimal robots.txt check: does a rule group for our name, or for *, disallow this path?
export function robotsAllows(robotsText, path, agent = 'steering-watch') {
  const groups = [];
  let cur = null;
  for (const raw of robotsText.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (key === 'user-agent') {
      if (!cur || cur.rules.length) {
        cur = { agents: [], rules: [] };
        groups.push(cur);
      }
      cur.agents.push(m[2].toLowerCase());
    } else if ((key === 'allow' || key === 'disallow') && cur) {
      cur.rules.push({ allow: key === 'allow', path: m[2] });
    }
  }
  const named = groups.filter((g) => g.agents.some((a) => a !== '*' && agent.toLowerCase().includes(a)));
  const use = named.length ? named : groups.filter((g) => g.agents.includes('*'));
  let best = null;
  for (const g of use) {
    for (const r of g.rules) {
      if (!r.path) continue;
      const pat = r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$');
      if (new RegExp('^' + pat).test(path) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) best = r;
    }
  }
  return best ? best.allow : true;
}

async function get(url, accept) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: 'follow', headers: { 'user-agent': USER_AGENT, accept } });
    const chunks = [];
    let size = 0;
    let truncated = false;
    if (res.body) {
      for await (const c of res.body) {
        size += c.length;
        if (size > MAX_BYTES) {
          truncated = true;
          chunks.push(c.slice(0, c.length - (size - MAX_BYTES)));
          ctl.abort();
          break;
        }
        chunks.push(c);
      }
    }
    return { status: res.status, url: res.url, type: res.headers.get('content-type') || '', text: Buffer.concat(chunks).toString('utf8'), truncated };
  } finally {
    clearTimeout(timer);
  }
}

// A valid llms.txt: 200, not HTML, a text-like type, more than 20 bytes. Same test Installmap used.
export function looksLikeLlmsTxt({ status, type, text }) {
  if (status !== 200) return false;
  if (text.length <= 20) return false;
  if (/^\s*(<!doctype html|<html|<head|<body)/i.test(text)) return false;
  return /^(text\/|application\/octet-stream|$)/i.test(type.trim()) || /markdown/i.test(type);
}

const robotsCache = new Map();
async function allowedByRobots(origin) {
  if (robotsCache.has(origin)) return robotsCache.get(origin);
  let ok = true;
  try {
    const r = await get(origin + '/robots.txt', 'text/plain');
    if (r.status === 200 && !/^\s*<(!doctype|html)/i.test(r.text)) ok = robotsAllows(r.text, '/llms.txt');
  } catch {
    ok = true; // no robots.txt reachable: nothing forbids the request
  }
  robotsCache.set(origin, ok);
  return ok;
}

// Fetch /llms.txt for a domain, trying the bare domain then www. Returns a plain record.
export async function fetchLlmsTxt(domain) {
  const hosts = domain.startsWith('www.') ? [domain] : [domain, 'www.' + domain];
  let last = { status: 'error', detail: 'no attempt' };
  for (const host of hosts) {
    const origin = 'https://' + host;
    try {
      if (!(await allowedByRobots(origin))) {
        last = { status: 'blocked-by-robots', url: origin + '/llms.txt' };
        continue;
      }
      const r = await get(origin + '/llms.txt', 'text/plain, text/markdown;q=0.9, */*;q=0.1');
      if (looksLikeLlmsTxt(r)) return { status: 'ok', http: r.status, url: r.url, type: r.type, text: r.text, truncated: r.truncated };
      last = { status: r.status === 200 ? 'not-llms-txt' : r.status === 404 || r.status === 410 ? 'not-found' : 'http-' + r.status, http: r.status, url: r.url };
    } catch (e) {
      last = { status: 'error', detail: String((e && e.cause && e.cause.code) || (e && e.name) || e).slice(0, 60), url: origin + '/llms.txt' };
    }
  }
  return last;
}
