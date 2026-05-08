#!/usr/bin/env node
// KEEPWHATSYOURS.AI — picks.json validator
// Run locally:    node scripts/validate-picks.mjs
// Run in CI:      see .github/workflows/validate.yml
//
// Exits non-zero on any error. Warnings don't fail the build but are printed.

import { readFileSync } from 'node:fs';

const path = process.argv[2] || 'picks.json';

let raw;
try {
  raw = readFileSync(path, 'utf8');
} catch (err) {
  console.error(`✖ cannot read ${path}: ${err.message}`);
  process.exit(1);
}

let data;
try {
  data = JSON.parse(raw);
} catch (err) {
  console.error(`✖ ${path} is not valid JSON: ${err.message}`);
  process.exit(1);
}

const errors = [];
const warnings = [];

if (typeof data !== 'object' || data === null) {
  console.error('✖ root must be an object');
  process.exit(1);
}
if (!Array.isArray(data.picks)) {
  console.error('✖ root.picks must be an array');
  process.exit(1);
}
if (typeof data.starting_capital_usd !== 'number' || !(data.starting_capital_usd > 0)) {
  warnings.push('starting_capital_usd should be a positive number (UI defaults to 10000)');
}

const REQUIRED = ['date', 'symbol', 'name', 'coingecko_id', 'entry_price', 'status'];
const STATUSES = new Set(['open', 'closed']);
const seen = new Map();

data.picks.forEach((p, i) => {
  const at = `picks[${i}]`;

  for (const k of REQUIRED) {
    if (p[k] === undefined || p[k] === null || p[k] === '') {
      errors.push(`${at}: missing ${k}`);
    }
  }

  if (p.date && !/^\d{4}-\d{2}-\d{2}$/.test(p.date)) {
    errors.push(`${at}.date "${p.date}" — must be YYYY-MM-DD`);
  }
  if (p.exit_date && !/^\d{4}-\d{2}-\d{2}$/.test(p.exit_date)) {
    errors.push(`${at}.exit_date "${p.exit_date}" — must be YYYY-MM-DD`);
  }

  if (p.entry_price !== undefined && (typeof p.entry_price !== 'number' || p.entry_price <= 0)) {
    errors.push(`${at}.entry_price must be a positive number, got ${JSON.stringify(p.entry_price)}`);
  }
  if (p.size_usd !== undefined && (typeof p.size_usd !== 'number' || p.size_usd <= 0)) {
    errors.push(`${at}.size_usd must be a positive number when set`);
  }

  if (p.coingecko_id && !/^[a-z0-9-]+$/.test(p.coingecko_id)) {
    warnings.push(`${at}.coingecko_id "${p.coingecko_id}" looks unusual — ids are typically lowercase-with-dashes (e.g. "dogwifcoin")`);
  }

  if (!STATUSES.has(p.status)) {
    errors.push(`${at}.status must be "open" or "closed", got ${JSON.stringify(p.status)}`);
  }

  if (p.status === 'closed') {
    if (typeof p.exit_price !== 'number' || p.exit_price <= 0) {
      errors.push(`${at}: closed picks need a positive exit_price`);
    }
    if (!p.exit_date) {
      errors.push(`${at}: closed picks need an exit_date`);
    }
    if (p.exit_date && p.date && p.exit_date < p.date) {
      errors.push(`${at}: exit_date (${p.exit_date}) is before date (${p.date})`);
    }
  } else if (p.status === 'open') {
    if (p.exit_price !== undefined) {
      warnings.push(`${at}: open pick has exit_price set — flip status to "closed" or remove it`);
    }
    if (p.exit_date !== undefined) {
      warnings.push(`${at}: open pick has exit_date set — flip status to "closed" or remove it`);
    }
  }

  // duplicate guard: same symbol on same day usually means a copy-paste bug
  if (p.symbol && p.date) {
    const key = `${p.date}::${String(p.symbol).toUpperCase()}`;
    if (seen.has(key)) {
      warnings.push(`${at}: duplicate of ${seen.get(key)} (${p.symbol} on ${p.date})`);
    } else {
      seen.set(key, at);
    }
  }
});

// summary
const closed = data.picks.filter((p) => p.status === 'closed');
const open = data.picks.filter((p) => p.status === 'open');
const wins = closed.filter((p) => p.exit_price > p.entry_price).length;
const realized = closed.reduce(
  (s, p) => s + ((p.exit_price - p.entry_price) / p.entry_price) * (p.size_usd ?? 1000),
  0
);

console.log('--- picks.json ---');
console.log(`total picks ......... ${data.picks.length}`);
console.log(`closed .............. ${closed.length} (${wins}W / ${closed.length - wins}L)`);
console.log(`open ................ ${open.length}`);
if (closed.length) {
  console.log(`win rate ............ ${((wins / closed.length) * 100).toFixed(1)}%`);
  console.log(`realized P&L ........ $${realized.toFixed(2)}`);
}
console.log('------------------');

if (warnings.length) {
  console.log(`\n${warnings.length} warning(s):`);
  for (const w of warnings) console.log('  ⚠ ' + w);
}
if (errors.length) {
  console.error(`\n${errors.length} error(s):`);
  for (const e of errors) console.error('  ✖ ' + e);
  process.exit(1);
}
console.log('\n✓ picks.json is valid');
