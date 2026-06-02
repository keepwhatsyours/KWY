#!/usr/bin/env node
// Smoke-test the market scan parser against representative Bubba Bot embeds.

const cleanFieldName = s => String(s || '').replace(/^[\s\W_]+/u, '').trim();
const cleanCoinSymbol = s => String(s || '')
  .replace(/[`*$]/g, '')
  .trim()
  .replace(/^#?\d+\s*[.)\]-]?\s+(?=\S)/, '')
  .trim();

function parseNumber(v) {
  if (v == null) return null;
  const s = String(v).replace(/[`*]/g, '').trim();
  const ratio = s.match(/^([\d.,]+)\s*\/\s*\d+$/);
  if (ratio) return parseFloat(ratio[1].replace(/,/g, ''));
  const m = s.match(/-?[\d,.]+/);
  if (!m) return null;
  let n = parseFloat(m[0].replace(/,/g, ''));
  if (/\bK\b|K\s*$/i.test(s)) n *= 1e3;
  else if (/\bM\b|M\s*$/i.test(s)) n *= 1e6;
  else if (/\bB\b|B\s*$/i.test(s)) n *= 1e9;
  return n;
}

function parseChange(v) {
  if (!v) return {};
  const out = {};
  for (const m of String(v).matchAll(/(1m|5m|1h):\s*`?([+-]?[\d.]+)%/g)) {
    out[m[1]] = parseFloat(m[2]);
  }
  return out;
}

function parseSwaps(v) {
  if (!v) return { count: null, bsRatio: null };
  const s = String(v).trim();
  const ratioM = s.match(/(?:Buy\/Sell|B\/S):\s*([+-]?[\d.]+x)/i);
  return {
    count: s.split('(')[0].trim().replace(/\s+/g, ' ') || null,
    bsRatio: ratioM ? ratioM[1] : null,
  };
}

function parseBaselineMcap(v) {
  if (!v) return null;
  const s = String(v).trim().replace(/[`$,\s]/g, '');
  const match = s.match(/^(-?[\d.]+)([KMB])?/i);
  if (!match) return null;
  const n = parseFloat(match[1]);
  if (Number.isNaN(n)) return null;
  const suffix = (match[2] || '').toUpperCase();
  if (suffix === 'K') return n * 1e3;
  if (suffix === 'M') return n * 1e6;
  if (suffix === 'B') return n * 1e9;
  return n;
}

const MCAP_PRICE_CORRECTION_RATIO = 25;
function mcapRatio(a, b) {
  if (a == null || b == null || a <= 0 || b <= 0) return null;
  return Math.max(a, b) / Math.min(a, b);
}
function normalizeSnapshotMcap(snapshot, live) {
  const raw = Number(snapshot?.mcap);
  const rawMcap = Number.isFinite(raw) && raw > 0 ? raw : null;
  const price = Number(snapshot?.price);
  const liveMcap = Number(live?.mcap);
  const livePrice = Number(live?.price);
  const supply = Number.isFinite(liveMcap) && Number.isFinite(livePrice) && liveMcap > 0 && livePrice > 0
    ? liveMcap / livePrice
    : null;
  const priceMcap = Number.isFinite(price) && price > 0 && supply ? price * supply : null;
  const ratio = rawMcap && priceMcap ? mcapRatio(rawMcap, priceMcap) : null;
  return ratio && ratio >= MCAP_PRICE_CORRECTION_RATIO
    ? { mcap: priceMcap, rawMcap, corrected: true }
    : { mcap: rawMcap ?? priceMcap ?? null, rawMcap, corrected: false };
}
function firstNormalizedFlagWithMcap(flags, live) {
  for (const flag of flags) {
    const normalized = normalizeSnapshotMcap(flag, live);
    if (normalized.mcap > 0) return { ...flag, normalizedMcap: normalized.mcap, mcapCorrection: normalized };
  }
  return null;
}
function resolveStoredBaseline(stored, sortedFlags, live) {
  const firstWithMcap = firstNormalizedFlagWithMcap(sortedFlags, live);
  const matchingStoredFlag = stored?.ts ? sortedFlags.find(f => f.ts === stored.ts) : null;
  const normalized = normalizeSnapshotMcap({ ...matchingStoredFlag, mcap: stored?.mcap, price: matchingStoredFlag?.price }, live);
  const baselineDrift = firstWithMcap?.normalizedMcap ? mcapRatio(normalized.mcap, firstWithMcap.normalizedMcap) : null;
  return !normalized.corrected && !matchingStoredFlag && baselineDrift >= MCAP_PRICE_CORRECTION_RATIO
    ? firstWithMcap.normalizedMcap
    : normalized.mcap;
}

function parseBubbaPost(msg) {
  if (msg.embeds && msg.embeds.length >= 2) {
    const header = msg.embeds[0];
    const tierMatch = (header.title || '').match(/(Big|Mid|Low)\s+Cap/i);
    if (tierMatch) {
      const tier = tierMatch[1].toLowerCase();
      const coins = msg.embeds.slice(1).map(e => {
        const t = (e.title || '').trim();
        const titleMatch = t.match(/^(.+?)\s+[—\-–]\s+(.+)$/);
        const fields = {};
        for (const f of (e.fields || [])) fields[cleanFieldName(f.name)] = (f.value || '').replace(/`/g, '');
        return {
          symbol: cleanCoinSymbol(titleMatch ? titleMatch[1] : t),
          name: titleMatch ? titleMatch[2].trim() : '',
          contract: fields.Contract || null,
          price: parseNumber(fields.Price),
          mcap: parseNumber(fields['Market Cap']),
          liquidity: parseNumber(fields.Liquidity),
          volume24h: parseNumber(fields['Volume (24h)']),
          holders: parseNumber(fields.Holders),
          score: parseNumber(fields.Score),
          swaps: fields.Swaps || null,
          change: parseChange(fields['Price Change']),
          health: fields['Wallet Health'] || null,
          risk: fields['Dev / Risk'] || fields['Dev/Risk'] || null,
        };
      });
      return { id: msg.id, ts: msg.timestamp, tier, coins };
    }
  }
  return null;
}

const sample = {
  id: 'sample-1',
  timestamp: '2026-05-31T02:30:31.801Z',
  embeds: [
    { title: '🚨 Big Cap 02:30 Scan 05/31/2026', fields: [] },
    {
      title: '#1 POKESTR  —  PokeSTR',
      fields: [
        { name: '📋 Contract', value: '33eum82LaAhtv5YkUq1BdwEviSErH5CnFxqVNLT5pump' },
        { name: '💰 Price', value: '$0.0048874' },
        { name: '📊 Market Cap', value: '$5.08M' },
        { name: '💧 Liquidity', value: '$539.2K' },
        { name: '📈 Price Change', value: '1m: `+0.0%`  |  5m: `-0.4%`  |  1h: `-1.8%`' },
        { name: '⭐ Score', value: '49/100' },
        { name: '🔥 Volume (24h)', value: '$925.5K' },
        { name: '👥 Holders', value: '18,861' },
        { name: '🔄 Swaps', value: '25,404  (B/S: 1.29x)' },
        { name: '🔐 Wallet Health', value: 'Top 10: `19.0%`  |  Bundler: `22.6%`  |  Fresh: `0.0%`' },
        { name: '🛡️ Dev / Risk', value: '✅ Dev Exited | CTO Active | Rug: 0.056 🔴' },
      ],
    },
  ],
};

const parsed = parseBubbaPost(sample);
const coin = parsed?.coins?.[0];
const parsedSwaps = parseSwaps(coin?.swaps);
const bullOutlier = normalizeSnapshotMcap(
  { mcap: 570260000, price: 0.0039233 },
  { mcap: 3463821, price: 0.003463821 },
);
const bullStoredBaseline = resolveStoredBaseline(
  { mcap: 570260000, ts: '2026-05-28T15:00:36.821Z' },
  [{ mcap: 570260000, price: 0.0040168, ts: '2026-05-28T19:00:34.396Z' }],
  { mcap: 3463821, price: 0.003463821 },
);
const near = (a, b) => Math.abs(a - b) < 0.001;
const checks = [
  ['tier', parsed?.tier === 'big'],
  ['rank prefix stripped from symbol', coin?.symbol === 'POKESTR'],
  ['coin name preserved', coin?.name === 'PokeSTR'],
  ['numeric-only symbol preserved', cleanCoinSymbol('5') === '5'],
  ['contract', coin?.contract === '33eum82LaAhtv5YkUq1BdwEviSErH5CnFxqVNLT5pump'],
  ['mcap', coin?.mcap === 5080000],
  ['liquidity', coin?.liquidity === 539200],
  ['score ratio', coin?.score === 49],
  ['swaps count parsed', parsedSwaps.count === '25,404'],
  ['B/S ratio parsed', parsedSwaps.bsRatio === '1.29x'],
  ['change 1h', coin?.change?.['1h'] === -1.8],
  ['health preserved', /Bundler/.test(coin?.health || '')],
  ['baseline mcap M suffix', near(parseBaselineMcap('$4.14M'), 4140000)],
  ['baseline mcap K suffix', near(parseBaselineMcap('$277.7K'), 277700)],
  ['outlier mcap corrected from price', bullOutlier.corrected && Math.abs(bullOutlier.mcap - 3923300) < 1],
  ['stale stored baseline falls back to corrected feed', Math.abs(bullStoredBaseline - 4016800) < 1],
];

const failed = checks.filter(([, ok]) => !ok);
if (failed.length) {
  console.error('market parser smoke test failed:');
  for (const [name] of failed) console.error(' - ' + name);
  process.exit(1);
}

console.log('market parser smoke test passed');
