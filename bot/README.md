# KWY Discord Feed Bot

Mirrors a single Discord channel into a JSON HTTP endpoint that the
KEEPWHATSYOURS.AI website polls. Live updates: when someone posts in the
channel, it shows up on the site within ~15 seconds.

```
   Discord channel  ──►  this bot  ──►  /feed (JSON)  ──►  index.html
```

---

## 1. Create the Discord application + bot

1. Go to <https://discord.com/developers/applications> → **New Application**.
   Name it `KWY-Feed`.
2. In the left sidebar, open **Bot**.
3. Scroll to **Privileged Gateway Intents** and enable:
   - ✅ **MESSAGE CONTENT INTENT** (required — without it `content` is empty)
4. Click **Reset Token** → **Copy**. Save it now; Discord only shows it once.
   This is your `DISCORD_TOKEN`.

## 2. Invite the bot to your server

1. Sidebar → **OAuth2** → **URL Generator**.
2. **Scopes**: check `bot`.
3. **Bot Permissions**: check **View Channels**, **Read Message History**.
4. Copy the generated URL, paste in your browser, pick your server, **Authorize**.

If your channel is private, also right-click the channel → **Edit Channel** →
**Permissions** → add the bot (or its role) and grant **View Channel** +
**Read Message History**.

## 3. Get the IDs

1. In Discord: **User Settings → Advanced → Developer Mode = ON**.
2. Right-click your **server name** → **Copy Server ID** → that's `GUILD_ID`.
3. Right-click the **channel** you want mirrored (e.g. `#announcements`) →
   **Copy Channel ID** → that's `CHANNEL_ID`.

## 4. Run locally

```sh
cd bot
cp .env.example .env
# open .env in your editor and paste DISCORD_TOKEN + CHANNEL_ID
npm install
npm start
```

You should see:

```
[ok]  bot online as KWY-Feed#1234
[ok]  watching channel 1234567890
[ok]  loaded 12 historical messages
[ok]  feed server listening on :3030
```

Open <http://localhost:3030/feed> in a browser — JSON of recent messages.

To test the site against your local bot, edit `index.html` and set:

```js
const FEED_URL = "http://localhost:3030/feed";
```

…then open `index.html` from a local server (Discord's CORS headers don't
matter; the bot's do, and `*` is set in `.env.example`).

## 5. Deploy 24/7

The bot has to stay online to receive new messages. Pick one:

### Railway (easiest)

1. Push this repo to GitHub.
2. <https://railway.app/new> → **Deploy from GitHub** → pick the repo.
3. Set **Root Directory** to `bot/`.
4. Add env vars: `DISCORD_TOKEN`, `CHANNEL_ID`, `ALLOWED_ORIGIN=https://yoursite`.
5. Railway gives you a public URL like `https://kwy-feed.up.railway.app`.
   Your feed lives at `/feed` on that URL.

### Fly.io

```sh
cd bot
fly launch          # answer yes to "Would you like to deploy now?"
fly secrets set DISCORD_TOKEN=... CHANNEL_ID=... ALLOWED_ORIGIN=https://yoursite
```

### Render / Heroku-likes

Use a **Web Service** (so the HTTP port is exposed). Set the build command to
`npm install`, start command to `npm start`, and the same env vars.

## 6. Connect the site

Open `../index.html`, find this line near the top of the script block:

```js
const FEED_URL = ""; // ← paste your bot's /feed URL here
```

Set it to your deployed bot's `/feed` URL. Reload the page; the
**INTEL FEED** panel will start showing messages from your channel.

---

## Endpoints

| Path      | Description                                |
|-----------|--------------------------------------------|
| `/feed`   | Newest-first JSON of last N messages       |
| `/health` | Liveness check + message count + uptime    |
| `/`       | Plain-text help                            |

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Bot connects but `content` is `""` | **MESSAGE CONTENT INTENT** not enabled in dev portal |
| `/feed` is `[]` after restart | Bot can't read history — grant **Read Message History** on that channel |
| Browser shows CORS error | Set `ALLOWED_ORIGIN` to your site origin (or `*` while testing) |
| Bot drops offline | Single instance only — don't run two copies pointed at the same token |
| 401 on login | Token expired/regenerated — paste the new one into env |
