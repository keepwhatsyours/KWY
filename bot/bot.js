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

app.get('/', (_req, res) => {
  res.type('text/plain').send(
    `KEEPWHATSYOURS.AI feed bot\n\n` +
      `GET /feed    last ${MAX} messages from channel ${CHANNEL_ID}\n` +
      `GET /health  status\n`
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
