// KEEPWHATSYOURS.AI — Discord feed bot
// Mirrors messages from a single channel into an HTTP /feed endpoint
// the website can poll.
//
// Required env: DISCORD_TOKEN, CHANNEL_ID
// Optional env: GUILD_ID (for logging), MAX_MESSAGES, PORT, ALLOWED_ORIGIN

import dotenv from 'dotenv';
// override=true: .env wins over any shell env vars (e.g. a global DISCORD_TOKEN
// exported from ~/.zshrc for a different bot). Project-local config is the
// source of truth.
dotenv.config({ override: true });

import express from 'express';
import cors from 'cors';
import { Client, GatewayIntentBits, Partials } from 'discord.js';

// ---------- config ----------
const {
  DISCORD_TOKEN,
  CHANNEL_ID,
  GUILD_ID = '',
  MAX_MESSAGES = '50',
  PORT = '3030',
  ALLOWED_ORIGIN = '*',
  GMGN_API_KEY,
} = process.env;

if (!DISCORD_TOKEN) {
  console.error('FATAL: DISCORD_TOKEN missing. Copy .env.example to .env and fill it in.');
  process.exit(1);
}
if (!CHANNEL_ID) {
  console.error('FATAL: CHANNEL_ID missing. Right-click your channel in Discord (with Developer Mode on) → Copy Channel ID.');
  process.exit(1);
}

const MAX = Math.max(1, Math.min(200, Number(MAX_MESSAGES) || 50));

// ---------- discord ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // requires "Message Content Intent" enabled in dev portal
  ],
  partials: [Partials.Message, Partials.Channel],
});

/** newest-first ring buffer of channel messages */
let feed = [];

function shape(msg) {
  return {
    id: msg.id,
    author: msg.author?.username ?? 'unknown',
    avatar: msg.author?.displayAvatarURL?.({ size: 64 }) ?? '',
    bot: !!msg.author?.bot,
    content: msg.content ?? '',
    timestamp: (msg.createdAt ?? new Date()).toISOString(),
    attachments: [...(msg.attachments?.values() ?? [])].map((a) => ({
      url: a.url,
      contentType: a.contentType ?? null,
      name: a.name ?? null,
      width: a.width ?? null,
      height: a.height ?? null,
    })),
    embeds: (msg.embeds ?? []).map((e) => ({
      title: e.title ?? null,
      description: e.description ?? null,
      url: e.url ?? null,
      color: e.color ?? null,
      thumbnail: e.thumbnail?.url ?? null,
      footer: e.footer?.text ?? null,
      author: e.author?.name ?? null,
      fields: (e.fields ?? []).map((f) => ({
        name: f.name,
        value: f.value,
        inline: !!f.inline,
      })),
    })),
  };
}

client.once('ready', async () => {
  console.log(`[ok]  bot online as ${client.user.tag}`);
  if (GUILD_ID) console.log(`[ok]  watching guild ${GUILD_ID}`);
  console.log(`[ok]  watching channel ${CHANNEL_ID}`);
  try {
    const channel = await client.channels.fetch(CHANNEL_ID);
    if (!channel?.messages) {
      console.warn('[warn] channel has no messages collection (bot lacks read history?)');
      return;
    }
    const messages = await channel.messages.fetch({ limit: MAX });
    // .fetch returns newest-first already in a Collection
    feed = [...messages.values()].map(shape);
    console.log(`[ok]  loaded ${feed.length} historical messages`);
  } catch (err) {
    console.error('[err] failed to load history:', err.message);
  }
});

client.on('messageCreate', (msg) => {
  if (msg.channelId !== CHANNEL_ID) return;
  feed.unshift(shape(msg));
  if (feed.length > MAX) feed.length = MAX;
});

client.on('messageUpdate', async (_old, msg) => {
  if (msg.channelId !== CHANNEL_ID) return;
  try {
    const fresh = msg.partial ? await msg.fetch() : msg;
    const idx = feed.findIndex((m) => m.id === fresh.id);
    if (idx >= 0) feed[idx] = shape(fresh);
  } catch (err) {
    console.warn('[warn] update failed:', err.message);
  }
});

client.on('messageDelete', (msg) => {
  if (msg.channelId !== CHANNEL_ID) return;
  feed = feed.filter((m) => m.id !== msg.id);
});

client.on('error', (err) => console.error('[err] discord client error:', err.message));

client.login(DISCORD_TOKEN).catch((err) => {
  console.error('[err] login failed:', err.message);
  process.exit(1);
});

// ---------- http ----------
const app = express();
app.use(
  cors({
    origin: ALLOWED_ORIGIN === '*' ? true : ALLOWED_ORIGIN.split(',').map((s) => s.trim()),
  })
);
app.disable('x-powered-by');

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    ready: !!client.user,
    bot: client.user?.tag ?? null,
    channel: CHANNEL_ID,
    messages: feed.length,
    uptime_s: Math.round(process.uptime()),
  });
});

app.get('/feed', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=10');
  res.json({
    updated: new Date().toISOString(),
    count: feed.length,
    messages: feed,
  });
});

// ---------- BURPBOARD scraper (Telegram t.me/s/burpboard) ----------
// Mirrors the latest "Best performing tokens | Last 24H" post into JSON.
// Cached 5 minutes — Burpboard updates much less frequently than that.
const BURP_URL = 'https://t.me/s/burpboard';
const BURP_TTL_MS = 5 * 60 * 1000;
let burpCache = null;
let burpFetchedAt = 0;

const RANK_EMOJI = ['🥇','🥈','🥉','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];

// Convert compact mcap string (e.g. "82.1K", "4.3M", "6K") to raw number.
function parseCompact(v) {
  if (!v) return null;
  const s = String(v).trim().replace(/,/g, '');
  const n = parseFloat(s);
  if (isNaN(n)) return null;
  if (/\bK\b/i.test(s)) return n * 1e3;
  if (/\bM\b/i.test(s)) return n * 1e6;
  if (/\bB\b/i.test(s)) return n * 1e9;
  return n;
}

function htmlToText(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2|$1]')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function parseBurpPost(html) {
  const text = htmlToText(html);
  if (!/Best performing tokens/i.test(text)) return null;

  // header summary
  const avg    = text.match(/Average gain:\s*`?([\d.]+x)`?/i)?.[1] || null;
  const top10  = text.match(/Top 10:\s*`?([\d.]+x)`?/i)?.[1] || null;
  const median = text.match(/Median:\s*`?([\d.]+%)`?/i)?.[1] || null;
  const tracked = text.match(/Tokens tracked over the last 24H:\s*`?(\d+)`?/i)?.[1];

  // split into per-rank slices
  const tokens = [];
  for (let i = 0; i < RANK_EMOJI.length; i++) {
    const here = text.indexOf(RANK_EMOJI[i]);
    if (here < 0) continue;
    let next = text.length;
    for (const e of RANK_EMOJI.slice(i + 1)) {
      const nx = text.indexOf(e, here + 1);
      if (nx > 0 && nx < next) next = nx;
    }
    const slice = text.slice(here, next);

    // [SYMBOL|url] — first link in the slice is the token
    const link = slice.match(/\[([^|\]]+)\|([^\]]+)\]/);
    const entry   = slice.match(/@\s*`?([\d.]+[KMB]?)`?/i)?.[1] || null;
    const current = slice.match(/➜\s*`?([\d.]+[KMB]?)`?/i)?.[1] || null;
    const mult    = slice.match(/Δ\s*`?([\d.]+x|—|-)`?/i)?.[1] || null;
    const chain   = slice.match(/`?\[(\w+)\]`?/)?.[1] || null;
    const ath     = slice.match(/ATH:\s*`?([\d.]+[KMB]?)\s*((?:🥶|💀)?)`?/iu);

    if (!link) continue;
    // Compute multiplier from entry→current if text shows "—" or missing
    let multiplier = mult;
    if (!mult || mult === '—' || mult === '-') {
      const e = parseCompact(entry);
      const c = parseCompact(current);
      if (e && c && e > 0) {
        const computed = c / e;
        multiplier = (computed >= 10 ? computed.toFixed(0) : computed.toFixed(1)) + 'x';
      }
    }
    tokens.push({
      rank: i + 1,
      symbol: link[1].trim(),
      botUrl: link[2].trim(),
      entryMcap: entry,
      currentMcap: current,
      multiplier,
      chain,
      ath: ath?.[1] || null,
      athStatus: ath?.[2] || '',
    });
  }

  return {
    summary: { avgGain: avg, top10, median, tracked: tracked ? Number(tracked) : null },
    tokens,
  };
}

// Resolve a Burpboard token's canonical Dexscreener chart URL by symbol+chain.
// Picks the highest-liquidity pair on the matching chain.
const DEX_CHAIN = { sol:'solana', eth:'ethereum', bsc:'bsc', base:'base',
                    arbitrum:'arbitrum', polygon:'polygon', avalanche:'avalanche', optimism:'optimism' };
async function resolveChartUrl(token) {
  if (!token.symbol) return null;
  try {
    const r = await fetch(
      `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(token.symbol)}`,
      { headers: { 'User-Agent': 'KWY-Bot/0.1' } }
    );
    if (!r.ok) return null;
    const data = await r.json();
    const pairs = Array.isArray(data.pairs) ? data.pairs : [];
    if (!pairs.length) return null;
    const want = DEX_CHAIN[String(token.chain || '').toLowerCase()];
    let candidates = want ? pairs.filter(p => p.chainId === want) : pairs;
    if (!candidates.length) candidates = pairs;
    // also try to match the symbol exactly to avoid e.g. "FOO" matching "FOOBAR"
    const exact = candidates.filter(p =>
      String(p.baseToken?.symbol || '').toUpperCase() === token.symbol.toUpperCase()
    );
    if (exact.length) candidates = exact;
    candidates.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    return candidates[0]?.url || null;
  } catch (err) {
    console.warn('[warn] resolveChartUrl', token.symbol, err.message);
    return null;
  }
}

async function fetchBurpboard() {
  const r = await fetch(BURP_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; KWY-Bot/0.1; +https://keepwhatsyours.ai)',
      'Accept': 'text/html,application/xhtml+xml',
    },
  });
  if (!r.ok) throw new Error('burpboard http ' + r.status);
  const html = await r.text();

  // Telegram's /s/ preview wraps each post in a div with class tgme_widget_message_text.
  // Posts appear oldest-first; iterate from end to find the most recent matching.
  const blocks = [...html.matchAll(/<div[^>]*class="[^"]*tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/g)]
    .map(m => m[1]);
  for (const b of [...blocks].reverse()) {
    const parsed = parseBurpPost(b);
    if (parsed?.tokens?.length) {
      // Resolve canonical Dexscreener chart URLs in parallel.
      await Promise.all(parsed.tokens.map(async (t) => {
        t.chartUrl = await resolveChartUrl(t);
      }));
      return { updated: new Date().toISOString(), source: BURP_URL, ...parsed };
    }
  }
  throw new Error('no "Best performing tokens" post found');
}

async function getBurpboard() {
  const now = Date.now();
  if (burpCache && now - burpFetchedAt < BURP_TTL_MS) return burpCache;
  try {
    burpCache = await fetchBurpboard();
    burpFetchedAt = now;
    console.log(`[ok]  burpboard refreshed (${burpCache.tokens.length} tokens)`);
  } catch (err) {
    console.warn('[warn] burpboard fetch failed:', err.message);
  }
  return burpCache;
}

// warm the cache at boot; refresh in background every TTL
getBurpboard();
setInterval(() => getBurpboard(), BURP_TTL_MS);

app.get('/burpboard', async (_req, res) => {
  const data = await getBurpboard();
  if (!data) return res.status(503).json({ error: 'burpboard unavailable' });
  res.set('Cache-Control', 'public, max-age=60');
  res.json(data);
});

// ---------- TELEGRAM CHANNEL SCRAPER (generic) ----------
// Scrapes t.me/s/<slug> and shapes posts into the same {id, author, content,
// timestamp, attachments, embeds} format the Discord /feed uses, so the site's
// existing INTEL FEED renderer works without modification.
// Replace "GMGN Chart" / "📊 GMGN Chart" mentions with a Dexscreener URL for
// the first Solana-looking contract in the post. The site's linkify will turn
// the URL into a clickable green link.
function linkifyGmgnChart(content) {
  if (!content || !/GMGN\s*Chart/i.test(content)) return content;
  // Solana base58 address: alphabet excludes 0, O, I, l. Typically 32–44 chars.
  // Pump.fun tokens end in "pump"; we don't require it.
  const caMatch = content.match(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/);
  if (!caMatch) return content;
  const dexUrl = `https://dexscreener.com/solana/${caMatch[0]}`;
  return content.replace(/(?:📊\s*)?GMGN\s*Chart/gi, `📊 ${dexUrl}`);
}

// Drop "🔸Join Automated trading🔸" / "🔹Strategy results🔹" style promo lines
// AlphaStrikeSol appends to every post.
function stripPromoLines(content) {
  if (!content) return content;
  return content
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      if (!t) return true; // keep blanks for paragraph spacing
      // Lines bracketed by the orange/blue diamond emojis (🔸 U+1F538, 🔹 U+1F539)
      if (/^[\u{1F538}\u{1F539}][\s\S]*[\u{1F538}\u{1F539}]\s*$/u.test(t)) return false;
      // Premium/promo spam lines
      if (/👑\s*PREMIUM\s+INSIDERS?/i.test(t)) return false;
      if (/⚡\s*\d+%\s*Off?/i.test(t)) return false;
      if (/\b[A-Z0-9]{5,}\b.*\(?Expiring\s+Soon\)?/i.test(t)) return false;
      if (/@[A-Za-z0-9_]*(?:Bot|Access|Premium|Insider)/i.test(t)) return false;
      return true;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Strip social link labels that survive as plain text after tgHtmlToText removes
// the <a> tags (e.g., "✅/Chart:", "💬/Twitter:", "🌐/Website:", "✈️/Telegram:").
// These are redundant because the same links are rendered as pill buttons.
function stripSocialLabels(content) {
  if (!content) return content;
  return content
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      if (!t) return true;
      // Remove lines that are just social link labels with empty content.
      // Matches: /Chart: ✅/Chart: 💬/Twitter: 🌐/Website: ✈️/Telegram:
      // And shorthand label rows like: 🍆 DEX ✈️ TG 🌐 WEB 🪙 X
      if (/^[📊🦅✅🍆💬𝕏🐣✈️🌐🔗🪙📈📱🐦\s]*(?:\/|\b)(?:Chart|Twitter|Telegram|Website|Dex|TG|WEB|X)\b[:：]?[\s📊🦅✅🍆💬𝕏🐣✈️🌐🔗🪙📈📱🐦]*$/i.test(t)) return false;
      return true;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Extract Chart / Twitter / Telegram / Website links from a message's raw HTML
// before tgHtmlToText nukes all URLs. Falls back to building a Dexscreener chart
// link from any Solana-style contract found in the cleaned text.
function extractMessageLinks(rawHtml, cleanedContent) {
  const links = {};
  const candidate = (label, url) => {
    if (!links[label]) links[label] = url;
  };
  if (rawHtml) {
    for (const m of rawHtml.matchAll(/<a[^>]*href="([^"]+)"[^>]*>/gi)) {
      const u = m[1].trim();
      if (!u || u.startsWith('mailto:')) continue;
      // Drop sponsored ad redirects that ride along inside legit posts.
      if (/insideads/i.test(u)) continue;
      if (/(?:^|\/\/)(?:www\.)?(?:twitter\.com|x\.com)\//i.test(u)) candidate('twitter', u);
      else if (/(?:^|\/\/)(?:www\.)?t\.me\//i.test(u)) {
        if (/InsideAds/i.test(u)) continue; // skip sponsored ad deeplinks
        candidate('telegram', u);
      }
      else if (/dexscreener|gmgn|birdeye|photon-sol|solscan|pump\.fun|dextools/i.test(u)) candidate('chart', u);
      else if (/^https?:\/\//i.test(u) &&
               !/cdn|telegram\.org|telegra\.ph|tdesktop\.com/i.test(u)) {
        candidate('website', u);
      }
    }
  }
  // Fallback: derive a Dexscreener chart from a Solana address in the body.
  if (!links.chart && cleanedContent) {
    const caMatch = cleanedContent.match(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/);
    if (caMatch) links.chart = `https://dexscreener.com/solana/${caMatch[0]}`;
  }
  return Object.keys(links).length ? links : null;
}

function tgHtmlToText(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    // <a> tags: keep visible text only, drop URLs entirely (no external links in INTEL FEED)
    .replace(/<a\s[^>]*>([\s\S]*?)<\/a>/gi, (_, text) =>
      text.replace(/<[^>]+>/g, '').trim()
    )
    // Telegram custom emojis: keep the unicode fallback character only
    .replace(/<tg-emoji[^>]*>([\s\S]*?)<\/tg-emoji>/gi, (_, inner) =>
      inner.replace(/<[^>]+>/g, '').trim()
    )
    // strip every other tag
    .replace(/<[^>]+>/g, '')
    // any bare URLs that survived
    .replace(/https?:\/\/\S+/g, '')
    // named entities
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    // numeric entities (e.g. &#33; -> !)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    // tidy whitespace left by removals
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function fetchTelegramChannel(slug, max = 30) {
  const url = `https://t.me/s/${slug}`;
  const headers = {
    'User-Agent': 'Mozilla/5.0 (compatible; KWY-Bot/0.1; +https://keepwhatsyours.ai)',
    'Accept': 'text/html,application/xhtml+xml',
  };
  // One-shot retry on transient network errors (Render's network occasionally
  // throws "fetch failed" for specific paths; usually resolves on retry).
  let r;
  try {
    r = await fetch(url, { headers });
  } catch (err) {
    await new Promise((res) => setTimeout(res, 750));
    r = await fetch(url, { headers });
  }
  if (!r.ok) throw new Error(`telegram ${slug} http ${r.status}`);
  const html = await r.text();

  const messages = [];
  // Each message: <div class="tgme_widget_message ..." data-post="slug/id">...</div>
  // until the next message wrap or end of section.
  const reMsg = /<div\s+class="[^"]*\btgme_widget_message\b[^"]*"\s+data-post="([^"]+)"[^>]*>([\s\S]*?)(?=<div\s+class="[^"]*\btgme_widget_message_wrap\b|<\/section>|<script)/g;
  let m;
  while ((m = reMsg.exec(html))) {
    const dataPost = m[1];
    const inner = m[2];

    const ownerMatch = inner.match(/<a[^>]*class="[^"]*tgme_widget_message_owner_name[^"]*"[^>]*>([\s\S]*?)<\/a>/);
    const owner = ownerMatch ? ownerMatch[1].replace(/<[^>]+>/g, '').trim() : slug;

    // Match the message text div (avoid greedy match into footer/reactions).
    const textMatch = inner.match(/<div\s+class="[^"]*\btgme_widget_message_text\b[^"]*"[^>]*>([\s\S]*?)<\/div>(?=\s*(?:<div\s+class="[^"]*tgme_widget_message_(?:footer|reactions|reply|service_message|metadata)|<\/div>\s*<\/div>))/);
    const rawHtml = textMatch ? textMatch[1] : '';
    const content = textMatch
      ? linkifyGmgnChart(stripSocialLabels(stripPromoLines(tgHtmlToText(rawHtml).trim())))
      : '';
    const links = extractMessageLinks(rawHtml, content);

    const timeMatch = inner.match(/<time[^>]*\bdatetime="([^"]+)"/);
    const timestamp = timeMatch ? timeMatch[1] : new Date().toISOString();

    // Only the actual message photo/video wrappers — NOT custom-emoji <i> tags
    // or sticker thumbnails which also use background-image:url.
    const photos = [...inner.matchAll(
      /class="[^"]*\btgme_widget_message_photo_wrap\b[^"]*"[^>]*style="[^"]*background-image:url\('([^']+)'\)/g
    )].map(p => ({ url: p[1], contentType: 'image/jpeg', name: null }));
    const videos = [...inner.matchAll(
      /<video\b[^>]*\bsrc="([^"]+)"/g
    )].map(v => ({ url: v[1], contentType: 'video/mp4', name: null }));

    if (!content && !photos.length && !videos.length) continue;

    messages.push({
      id: dataPost,
      author: owner,
      avatar: '',
      bot: false,
      content,
      timestamp,
      attachments: [...photos, ...videos],
      embeds: [],
      links,
    });
  }

  // t.me/s/ shows oldest-first; reverse to newest-first like /feed.
  messages.reverse();
  return messages.slice(0, max);
}

// ---------- INTEL FEED (multi-channel Telegram aggregator) ----------
const INTEL_SLUGS = [
  'SolanaAlphaAlert',
];
const INTEL_PER_CHANNEL = 20;   // pull more than we need, filter junk, then cap
const INTEL_TOTAL = 50;         // cap merged result
const INTEL_TTL_MS = 5 * 60 * 1000;

// Strip Telegram footer noise that survives parsing
function cleanTrailingNoise(content) {
  if (!content) return content;
  return content
    .replace(/\n*Please open Telegram to view this post[\s\S]*$/i, '')
    .replace(/\n*VIEW IN TELEGRAM\s*$/i, '')
    .replace(/\n*📎\s*file\s*$/i, '')
    .trim();
}

// Posts that are pure noise: pinned-video service messages, paid ads, channel
// promos, telegram-restricted-content placeholders. Drop them entirely.
function isJunkPost(content) {
  if (!content) return true;
  const t = content.trim();
  if (t.length < 10) return true;

  // Service messages
  if (/\bpinned (?:a |the )?(?:video|message|post|photo|file|audio)\b/i.test(t)) return true;
  if (/^[^\n]{0,80}joined (?:the )?(?:channel|group)\b/im.test(t)) return true;

  // Ad / promo markers
  if (/#ad\b/i.test(t)) return true;
  if (/\bInsideAd\b/i.test(t)) return true;
  if (/\bTickBit\b/i.test(t)) return true;
  if (/welcome bonus/i.test(t)) return true;
  if (/grab it while/i.test(t)) return true;
  if (/per[- ]second profit/i.test(t)) return true;
  if (/start and claim/i.test(t)) return true;
  if (/no conditions\.?\s*no deposit/i.test(t)) return true;

  // Telegram-restricted placeholder
  if (/^please open telegram/i.test(t)) return true;

  // Pure attachment marker
  if (/^📎\s*file\s*$/i.test(t)) return true;

  return false;
}
let intelCache = null;
let intelFetchedAt = 0;

async function fetchIntel() {
  const results = await Promise.allSettled(
    INTEL_SLUGS.map((slug) => fetchTelegramChannel(slug, INTEL_PER_CHANNEL))
  );
  const all = [];
  const sources = [];
  results.forEach((r, i) => {
    const slug = INTEL_SLUGS[i];
    if (r.status === 'fulfilled' && Array.isArray(r.value)) {
      // strip telegram footer noise, drop junk/ad/service posts entirely
      const cleaned = r.value
        .map((m) => ({ ...m, content: cleanTrailingNoise(m.content) }))
        .filter((m) => !isJunkPost(m.content));
      sources.push({ slug, raw: r.value.length, count: cleaned.length, ok: true });
      all.push(...cleaned);
    } else {
      sources.push({ slug, count: 0, ok: false, error: r.reason?.message || String(r.reason) });
    }
  });
  // Sort newest first by timestamp (ISO strings sort lexicographically).
  all.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
  // Dedupe by id in case any channel cross-posts.
  const seen = new Set();
  const messages = [];
  for (const m of all) {
    if (m.id && seen.has(m.id)) continue;
    if (m.id) seen.add(m.id);
    messages.push(m);
    if (messages.length >= INTEL_TOTAL) break;
  }
  return { messages, sources };
}

async function getIntel() {
  const now = Date.now();
  if (intelCache && now - intelFetchedAt < INTEL_TTL_MS) return intelCache;
  try {
    const { messages, sources } = await fetchIntel();
    intelCache = {
      updated: new Date().toISOString(),
      sources,
      count: messages.length,
      messages,
    };
    intelFetchedAt = now;
    const live = sources.filter((s) => s.ok).length;
    console.log(`[ok]  intel refreshed (${messages.length} messages from ${live}/${sources.length} channels)`);
  } catch (err) {
    console.warn('[warn] intel fetch failed:', err.message);
  }
  return intelCache;
}

getIntel();
setInterval(() => getIntel(), INTEL_TTL_MS);

app.get('/intel', async (_req, res) => {
  const data = await getIntel();
  if (!data) return res.status(503).json({ error: 'intel unavailable' });
  res.set('Cache-Control', 'public, max-age=60');
  res.json(data);
});

// ---------- GMGN PROXY (token info + security) ----------
// Proxies gmgn-cli calls so the frontend can fetch live on-chain data
// without exposing the API key. Results cached 2 minutes.
const GMGN_TTL_MS = 2 * 60 * 1000;
const gmgnCache = new Map(); // key: "chain:address" -> { data, fetchedAt }

async function execGMGN(args) {
  const { execFile } = await import('child_process');
  const env = { ...process.env };
  if (GMGN_API_KEY) env.GMGN_API_KEY = GMGN_API_KEY;
  return new Promise((resolve, reject) => {
    execFile('gmgn-cli', args, { timeout: 15000, env }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch (e) {
        reject(new Error('invalid JSON from gmgn-cli'));
      }
    });
  });
}

async function fetchGMGN(chain, address) {
  const key = `${chain}:${address}`;
  const now = Date.now();
  const cached = gmgnCache.get(key);
  if (cached && now - cached.fetchedAt < GMGN_TTL_MS) return cached.data;

  const [info, security] = await Promise.allSettled([
    execGMGN(['token', 'info', '--chain', chain, '--address', address, '--raw']),
    execGMGN(['token', 'security', '--chain', chain, '--address', address, '--raw']),
  ]);

  const data = {
    address,
    chain,
    info: info.status === 'fulfilled' ? info.value : null,
    security: security.status === 'fulfilled' ? security.value : null,
    errors: [
      info.status === 'rejected' ? info.reason.message : null,
      security.status === 'rejected' ? security.reason.message : null,
    ].filter(Boolean),
  };

  gmgnCache.set(key, { data, fetchedAt: now });
  return data;
}

app.get('/gmgn', async (req, res) => {
  const { address, chain = 'sol' } = req.query;
  if (!address) return res.status(400).json({ error: 'missing ?address=' });
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
    return res.status(400).json({ error: 'invalid address format' });
  }
  try {
    const data = await fetchGMGN(chain, address);
    res.set('Cache-Control', 'public, max-age=60');
    res.json(data);
  } catch (err) {
    console.warn('[warn] /gmgn failed:', err.message);
    res.status(502).json({ error: err.message });
  }
});

app.get('/', (_req, res) => {
  res.type('text/plain').send(
    `KEEPWHATSYOURS.AI feed bot\n\n` +
      `GET /feed       last ${MAX} messages from channel ${CHANNEL_ID}\n` +
      `GET /intel      merged feed from ${INTEL_SLUGS.length} Telegram channels\n` +
      `GET /burpboard  latest "Best performing tokens | Last 24H" from t.me/burpboard\n` +
      `GET /gmgn       live token info + security from GMGN (?address=\u003cCA\u003e\u0026chain=sol)\n` +
      `GET /health     status\n`
  );
});

const port = Number(PORT) || 3030;
app.listen(port, () => console.log(`[ok]  feed server listening on :${port}`));

// graceful shutdown
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n[bye] received ${sig}, shutting down`);
    client.destroy();
    process.exit(0);
  });
}
