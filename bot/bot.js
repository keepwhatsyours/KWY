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
    const mult    = slice.match(/Δ\s*`?([\d.]+x)`?/i)?.[1] || null;
    const chain   = slice.match(/`?\[(\w+)\]`?/)?.[1] || null;
    const ath     = slice.match(/ATH:\s*`?([\d.]+[KMB]?)\s*((?:🥶|💀)?)`?/iu);

    if (!link) continue;
    tokens.push({
      rank: i + 1,
      symbol: link[1].trim(),
      botUrl: link[2].trim(),
      entryMcap: entry,
      currentMcap: current,
      multiplier: mult,
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
  const r = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; KWY-Bot/0.1; +https://keepwhatsyours.ai)',
      'Accept': 'text/html,application/xhtml+xml',
    },
  });
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
    const content = textMatch ? tgHtmlToText(textMatch[1]).trim() : '';

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
    });
  }

  // t.me/s/ shows oldest-first; reverse to newest-first like /feed.
  messages.reverse();
  return messages.slice(0, max);
}

// ---------- ALPHASTRIKE SOL ----------
const ALPHA_SLUG = 'AlphaStrikeSol';
const ALPHA_TTL_MS = 5 * 60 * 1000;
let alphaCache = null;
let alphaFetchedAt = 0;

async function getAlphaStrike() {
  const now = Date.now();
  if (alphaCache && now - alphaFetchedAt < ALPHA_TTL_MS) return alphaCache;
  try {
    const messages = await fetchTelegramChannel(ALPHA_SLUG, 30);
    alphaCache = {
      updated: new Date().toISOString(),
      source: `https://t.me/${ALPHA_SLUG}`,
      count: messages.length,
      messages,
    };
    alphaFetchedAt = now;
    console.log(`[ok]  alphastrike refreshed (${messages.length} messages)`);
  } catch (err) {
    console.warn('[warn] alphastrike fetch failed:', err.message);
  }
  return alphaCache;
}

getAlphaStrike();
setInterval(() => getAlphaStrike(), ALPHA_TTL_MS);

app.get('/alphastrike', async (_req, res) => {
  const data = await getAlphaStrike();
  if (!data) return res.status(503).json({ error: 'alphastrike unavailable' });
  res.set('Cache-Control', 'public, max-age=60');
  res.json(data);
});

app.get('/', (_req, res) => {
  res.type('text/plain').send(
    `KEEPWHATSYOURS.AI feed bot\n\n` +
      `GET /feed         last ${MAX} messages from channel ${CHANNEL_ID}\n` +
      `GET /alphastrike  latest posts from t.me/${ALPHA_SLUG}\n` +
      `GET /burpboard    latest "Best performing tokens | Last 24H" from t.me/burpboard\n` +
      `GET /health       status\n`
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
