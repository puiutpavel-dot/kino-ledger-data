/**
 * Publishes a compact snapshot of recent Greek KINO (20/80) draws to draws.json.
 *
 * Runs on GitHub's hosted runners, which sit in a region OPAP's edge filter allows —
 * that is the entire point of this job. The Kino Ledger proxy falls back to this file
 * for callers whose own region is blocked.
 */

const UPSTREAM = 'https://api.opap.gr/draws/v3.0';
const GAME_ID = '1100';
const DRAWS_PER_ROUND = 20;

/** Enough to cover the app's statistics window plus headroom for the profit ledger. */
const COUNT = 220;
/**
 * Hard ceiling on both OPAP endpoints: `last/101` and `draw-id` with a wider span both
 * answer 400. Anything deeper has to be paged.
 */
const PAGE = 100;
/** Below this, treat the response as broken rather than publishing a thin snapshot. */
const MIN_ACCEPTABLE = 20;

const OUTPUT = 'draws.json';

const HEADERS = {
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9,el;q=0.8',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  'Referer': 'https://www.opap.gr/',
};

import { readFile, writeFile } from 'node:fs/promises';

const draws = await withRetry(() => fetchDraws(), 3);

if (draws.length < MIN_ACCEPTABLE) {
  throw new Error(`only ${draws.length} usable draws returned; refusing to publish`);
}

const previous = await readPrevious();
if (previous && sameDraws(previous, draws)) {
  console.log(`no change (${draws.length} draws, newest ${draws[0].id})`);
  process.exit(0);
}

await writeFile(OUTPUT, JSON.stringify({ updatedAt: Date.now(), draws }) + '\n');
console.log(`wrote ${draws.length} draws, newest ${draws[0].id}`);

// ----------------------------------------------------------------

async function fetchDraws() {
  // The "last" listing leads with the in-progress draw, which has no numbers yet.
  const newest = await fetchPage(`${UPSTREAM}/${GAME_ID}/last/${PAGE}`);
  if (!newest.length) throw new Error('no completed draws in the latest page');

  const byID = new Map(newest.map((d) => [d.id, d]));
  let oldest = Math.min(...byID.keys());

  // `last/` tops out at 100, so reach further back by draw id, a page at a time.
  while (byID.size < COUNT) {
    const to = oldest - 1;
    const from = Math.max(1, to - PAGE + 1);
    if (to < 1) break;
    const page = await fetchPage(`${UPSTREAM}/${GAME_ID}/draw-id/${from}/${to}?limit=${PAGE}`);
    if (!page.length) break;
    for (const draw of page) byID.set(draw.id, draw);
    const pageOldest = Math.min(...page.map((d) => d.id));
    if (pageOldest >= oldest) break;  // no progress; stop rather than loop forever
    oldest = pageOldest;
  }

  return [...byID.values()].sort((a, b) => b.id - a.id).slice(0, COUNT);
}

async function fetchPage(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`upstream returned ${res.status}`);
  const raw = await res.json();
  const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.content) ? raw.content : []);
  return list.map(compact).filter(Boolean);
}

/** Keeps only what the app needs, and only for genuinely completed draws. */
function compact(wire) {
  if (!wire || !Number.isInteger(wire.drawId)) return null;
  const numbers = wire.winningNumbers && wire.winningNumbers.list;
  if (!Array.isArray(numbers) || numbers.length !== DRAWS_PER_ROUND) return null;
  const clean = numbers.filter((n) => Number.isInteger(n) && n >= 1 && n <= 80);
  if (clean.length !== DRAWS_PER_ROUND) return null;
  if (new Set(clean).size !== DRAWS_PER_ROUND) return null;
  const t = Number(wire.drawTime);
  if (!Number.isFinite(t) || t <= 0) return null;
  return { id: wire.drawId, t, n: clean };
}

async function readPrevious() {
  try {
    const parsed = JSON.parse(await readFile(OUTPUT, 'utf8'));
    return Array.isArray(parsed.draws) ? parsed.draws : null;
  } catch {
    return null;
  }
}

/**
 * Compares the draws only, ignoring `updatedAt` — otherwise every run would produce a
 * commit even when nothing new has been drawn.
 */
function sameDraws(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].id !== b[i].id || a[i].t !== b[i].t) return false;
    if (a[i].n.join(',') !== b[i].n.join(',')) return false;
  }
  return true;
}

async function withRetry(fn, attempts) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      console.log(`attempt ${i + 1} failed: ${err.message}`);
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
  throw lastError;
}
