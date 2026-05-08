# KEEPWHATSYOURS.AI

Daily AI-generated meme coin picks, with a live track record and a Discord-fed
intel ticker. Hackerish green-on-black CRT vibe, single-file frontend, free
hosting friendly.

**Author:** keepwhatsyours@pm.me

```
   Open Claw  ──►  picks.json  ──►  index.html  ◄──  CoinGecko (live prices)
                                        ▲
                                        │
                          bot/  ──►  /feed (Discord channel)
```

## What's in the box

| Path                | What it is |
|---------------------|------------|
| `index.html`        | The site. Single static HTML file. Fetches `picks.json` + CoinGecko + the bot's `/feed`. |
| `picks.json`        | Daily picks data — the only thing you edit day-to-day. Schema documented inside. |
| `bot/`              | Discord-feed bot (discord.js + Express). Mirrors a channel into a JSON HTTP endpoint. |
| `bot/README.md`     | Step-by-step bot setup + deployment walkthrough. |
| `bot/Dockerfile`    | Used by Fly.io / any Docker host to build the bot image. |
| `bot/fly.toml`      | Fly.io app config — rename `app` to your unique name before deploying. |
| `scripts/validate-picks.mjs` | Local + CI validator for `picks.json`. Run: `node scripts/validate-picks.mjs`. |
| `.github/workflows/` | CI: validates `picks.json` + bot syntax on every push, auto-deploys bot to Fly on changes. |

## Quick start

### 1. View the site locally

Just open `index.html` in a browser. The embedded sample picks render
immediately. The Intel Feed will say "FEED OFFLINE" until you point it at a
deployed bot — that's expected.

For a closer-to-production preview (so `picks.json` is fetched fresh from
disk instead of using the embedded fallback):

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

### 2. Update today's picks

Edit `picks.json`. The schema is documented at the top of the file. New picks
go in with `"status": "open"`. When you take profit or stop out, set
`"status": "closed"` and add `exit_price` + `exit_date`. Reload the page —
P&L, win rate, and the chart all update automatically.

### 3. Wire up the Discord feed

See `bot/README.md` for the full walkthrough. TL;DR:

1. Create a Discord application + bot, enable **MESSAGE CONTENT INTENT**.
2. Invite it to your server with `View Channels` + `Read Message History`.
3. Deploy `bot/` to Railway / Fly.io / Render with `DISCORD_TOKEN` and
   `CHANNEL_ID` set as env vars.
4. Paste the deployed `/feed` URL into `FEED_URL` near the top of
   `index.html`'s script block.

### 4. Deploy the site

It's a static site — host it anywhere:

- **Netlify / Vercel / Cloudflare Pages**: connect this repo, no build step,
  publish directory = repo root.
- **GitHub Pages**: Settings → Pages → Source: `main` branch, `/` root.
- **Plain S3 / nginx**: just serve `index.html` and `picks.json`.

After deploying, lock down the bot's `ALLOWED_ORIGIN` env var to your real
site origin (e.g. `https://keepwhatsyours.ai`) instead of `*`.

## CI / deployment

Two GitHub Actions workflows ship with the repo:

### `validate.yml` — runs on every push and PR

No secrets needed. Runs:

- `scripts/validate-picks.mjs` — schema check on `picks.json` (required fields,
  date format, status/exit_price consistency, duplicate detection). Prints a
  track-record summary even on success.
- `node --check bot/bot.js` — syntax check the bot.
- `node --check` against the inline scripts pulled from `index.html`.
- Confirms the embedded picks-fallback in `index.html` parses as JSON.

You'll see green checkmarks on PRs once you've pushed.

### `deploy-bot.yml` — auto-deploys the bot on push to `main`

Runs only when files under `bot/` change. To enable, do this once:

1. Install flyctl locally: `brew install flyctl` (or the [other installers](https://fly.io/docs/hands-on/install-flyctl/)).
2. `fly auth login`.
3. From `bot/`, run `fly launch --copy-config --no-deploy` once. Edit the
   generated `fly.toml` to set your unique `app` name, then `fly deploy`
   manually one time so the app exists on Fly.
4. Set your bot env vars on Fly:

   ```sh
   cd bot
   fly secrets set DISCORD_TOKEN=... CHANNEL_ID=... ALLOWED_ORIGIN=https://yoursite
   ```

5. Create a GitHub deploy token: `fly tokens create deploy -x 999999h`
   (copy the output).
6. In your GitHub repo: **Settings → Secrets and variables → Actions →
   New repository secret**. Name it `FLY_API_TOKEN`, paste the token.

After that, every push to `main` that touches `bot/**` redeploys
automatically. You can also trigger it manually from the Actions tab
(Run workflow → main).

## Stack

- Frontend: vanilla HTML + CSS + JS, [Chart.js](https://www.chartjs.org/) via CDN
- Prices: [CoinGecko](https://www.coingecko.com/en/api) free tier (no key)
- Bot: [discord.js v14](https://discord.js.org/) + [Express](https://expressjs.com/)

## Disclaimer

This is not financial advice. Meme coins are extremely volatile and you can
lose 100% of your capital. The picks are AI-generated experiments. Do your
own research.
