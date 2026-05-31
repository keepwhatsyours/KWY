#!/usr/bin/env node
// Minimal UI smoke test for KEEPWHATSYOURS.AI.
// Run: npm install && npm run test:ui

import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('Playwright is not installed. Run: npm install');
  process.exit(1);
}

const port = 4173;
const feedFixture = {
  updated: new Date().toISOString(),
  count: 1,
  messages: [{
    id: 'smoke-feed-1',
    author: 'Bubba Bot',
    timestamp: new Date().toISOString(),
    content: '',
    attachments: [],
    embeds: [
      { title: '🚨 Big Cap 02:30 Scan 05/31/2026', fields: [] },
      {
        title: 'WORLDCUP  —  World Cup Coin',
        fields: [
          { name: '📋 Contract', value: '33eum82LaAhtv5YkUq1BdwEviSErH5CnFxqVNLT5pump' },
          { name: '💰 Price', value: '$0.0048874' },
          { name: '📊 Market Cap', value: '$5.08M' },
          { name: '💧 Liquidity', value: '$539.2K' },
          { name: '📈 Price Change', value: '1m: `+0.0%`  |  5m: `-0.4%`  |  1h: `-1.8%`' },
          { name: '⭐ Score', value: '49/100' },
          { name: '🔥 Volume (24h)', value: '$925.5K' },
          { name: '👥 Holders', value: '18,861' },
          { name: '🔄 Swaps', value: '8,910  (Buy/Sell: 1.19x)' },
          { name: '🔐 Wallet Health', value: 'Top 10: `19.0%`  |  Bundler: `22.6%`  |  Fresh: `0.0%`' },
          { name: '🛡️ Dev / Risk', value: '✅ Dev Exited | CTO Active | Rug: 0.056 🔴' },
        ],
      },
    ],
  }],
};

await writeFile('feed-snapshot.json', JSON.stringify(feedFixture));
const server = spawn('python3', ['-m', 'http.server', String(port)], {
  stdio: ['ignore', 'ignore', 'inherit'],
});

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

try {
  await wait(700);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForSelector('#market-scan .coin', { timeout: 35_000 });
  await page.waitForTimeout(8_000);

  const desktop = await page.evaluate(() => {
    const body = document.body.innerText;
    const banners = [...document.querySelectorAll('.mcap-banner')]
      .map(el => el.textContent.trim())
      .filter(Boolean)
      .map(text => Number(text.replace(/[^0-9.-]/g, '')))
      .filter(Number.isFinite);
    return {
      cards: document.querySelectorAll('#market-scan .coin').length,
      hasMarketSourceStrip: !!document.querySelector('#scan-data-strip'),
      hasDexText: /DEXSCREENER LIVE/.test(body),
      giantBanner: banners.some(v => Math.abs(v) > 10_000_000),
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 2,
    };
  });

  if (!desktop.cards) throw new Error('no market scan cards rendered');
  if (desktop.hasMarketSourceStrip) throw new Error('market scan source strip is back');
  if (desktop.hasDexText) throw new Error('card source text is visible');
  if (desktop.giantBanner) throw new Error('giant UP/DOWN percentage detected');
  if (desktop.horizontalOverflow) throw new Error('desktop horizontal overflow detected');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(800);
  const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
  if (mobileOverflow) throw new Error('mobile horizontal overflow detected');

  await mkdir('tmp', { recursive: true });
  await page.screenshot({ path: 'tmp/playwright-smoke.png', fullPage: true });
  await browser.close();
  console.log('playwright smoke test passed');
} finally {
  server.kill('SIGTERM');
  await rm('feed-snapshot.json', { force: true });
}
