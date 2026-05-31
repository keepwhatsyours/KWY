(function () {
  const cfg = window.KWY_HISTORY_CONFIG || { tier: "big", label: "BIG CAP", range: "$1M - $10M MC" };
  const FEED_URL = "https://kwy.onrender.com/feed";
  const BASELINE_URL = FEED_URL.replace(/\/feed$/, "/baselines");
  const DEX_CHAIN = "solana";
  const OUTLIER_RATIO = 25;

  let rows = [];
  let filteredRows = [];
  let serverBaselines = {};

  const $ = (id) => document.getElementById(id);
  const escapeHTML = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
  const fetchWithTimeout = (url, opts = {}, ms = 9000) => {
    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(id));
  };
  const cleanFieldName = (s) => String(s || "").replace(/^[\s\W_]+/u, "").trim();

  function parseNumber(v) {
    if (v == null) return null;
    const s = String(v).replace(/[`*]/g, "").trim();
    const ratio = s.match(/^([\d.,]+)\s*\/\s*\d+$/);
    if (ratio) return parseFloat(ratio[1].replace(/,/g, ""));
    const m = s.match(/-?[\d,.]+/);
    if (!m) return null;
    let n = parseFloat(m[0].replace(/,/g, ""));
    if (/\bK\b|K\s*$/i.test(s)) n *= 1e3;
    else if (/\bM\b|M\s*$/i.test(s)) n *= 1e6;
    else if (/\bB\b|B\s*$/i.test(s)) n *= 1e9;
    return n;
  }

  function parseChange(v) {
    const out = {};
    if (!v) return out;
    for (const m of String(v).matchAll(/(1m|5m|1h):\s*`?([+-]?[\d.]+)%/g)) out[m[1]] = parseFloat(m[2]);
    return out;
  }

  function parseBubbaPost(msg) {
    if (msg.embeds && msg.embeds.length >= 2) {
      const header = msg.embeds[0];
      const tierMatch = (header.title || "").match(/(Big|Mid|Low)\s+Cap/i);
      if (tierMatch) {
        const tier = tierMatch[1].toLowerCase();
        const coins = msg.embeds.slice(1).map(e => {
          const title = (e.title || "").trim();
          const titleMatch = title.match(/^(.+?)\s+[—\-–]\s+(.+)$/);
          const fields = {};
          for (const f of e.fields || []) fields[cleanFieldName(f.name)] = (f.value || "").replace(/`/g, "");
          const allText = [e.description, ...Object.values(fields)].filter(Boolean).join(" ");
          const links = {};
          for (const m of allText.matchAll(/https?:\/\/[^\s)\]'"]+/g)) {
            const u = m[0].replace(/[.,)\]]+$/, "");
            if (!links.chart && /(?:dexscreener|gmgn|birdeye|photon-sol|solscan|pump\.fun)/i.test(u)) links.chart = u;
            else if (!links.twitter && /(?:^|\/)(twitter\.com|x\.com)\//i.test(u)) links.twitter = u;
            else if (!links.telegram && /(?:^|\/)t\.me\//i.test(u)) links.telegram = u;
          }
          return {
            symbol: titleMatch ? titleMatch[1].trim() : title,
            name: titleMatch ? titleMatch[2].trim() : "",
            contract: fields.Contract || null,
            price: parseNumber(fields.Price),
            mcap: parseNumber(fields["Market Cap"]),
            liquidity: parseNumber(fields.Liquidity),
            volume24h: parseNumber(fields["Volume (24h)"]),
            holders: parseNumber(fields.Holders),
            score: parseNumber(fields.Score),
            degens: parseNumber(fields["Smart Degens"]),
            kols: parseNumber(fields.KOLs),
            swaps: fields.Swaps || null,
            change: parseChange(fields["Price Change"]),
            links,
          };
        });
        return { id: msg.id, ts: msg.timestamp, tier, coins };
      }
    }
    return null;
  }

  const fmtCompact = (n) => {
    if (n == null || isNaN(n)) return "-";
    const abs = Math.abs(n);
    const sign = n < 0 ? "-" : "";
    if (abs >= 1e9) return sign + "$" + (abs / 1e9).toFixed(2) + "B";
    if (abs >= 1e6) return sign + "$" + (abs / 1e6).toFixed(2) + "M";
    if (abs >= 1e3) return sign + "$" + (abs / 1e3).toFixed(1) + "K";
    if (abs >= 1) return sign + "$" + abs.toFixed(2);
    if (abs === 0) return "$0";
    return sign + "$" + abs.toPrecision(4).replace(/\.?0+$/, "");
  };
  const fmtPrice = (n) => {
    if (n == null || isNaN(n)) return "-";
    if (n >= 1) return "$" + n.toFixed(4);
    if (n >= .01) return "$" + n.toFixed(6);
    return "$" + n.toFixed(8);
  };
  const fmtCount = (n) => n == null || isNaN(n) ? "-" : Math.round(n).toLocaleString();
  const fmtTime = (iso) => {
    const d = new Date(iso);
    const pad = n => String(n).padStart(2, "0");
    if (Number.isNaN(d.getTime())) return "-";
    return `${pad(d.getUTCMonth()+1)}/${pad(d.getUTCDate())}/${d.getUTCFullYear()} @ ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  };
  const abbrevAddress = (addr) => addr ? `${addr.slice(0, 6)}...${addr.slice(-6)}` : "-";

  function mcapRatio(a, b) {
    if (a == null || b == null || a <= 0 || b <= 0) return null;
    return Math.max(a, b) / Math.min(a, b);
  }

  function normalizeMcap(snapshot, live) {
    const raw = Number(snapshot?.mcap);
    const rawMcap = Number.isFinite(raw) && raw > 0 ? raw : null;
    const price = Number(snapshot?.price);
    const liveMcap = Number(live?.mcap);
    const livePrice = Number(live?.price);
    const supply = Number.isFinite(liveMcap) && Number.isFinite(livePrice) && liveMcap > 0 && livePrice > 0 ? liveMcap / livePrice : null;
    const priceMcap = Number.isFinite(price) && price > 0 && supply ? price * supply : null;
    const ratio = rawMcap && priceMcap ? mcapRatio(rawMcap, priceMcap) : null;
    return ratio && ratio >= OUTLIER_RATIO ? priceMcap : (rawMcap ?? priceMcap ?? null);
  }

  async function fetchBaselines() {
    try {
      const r = await fetchWithTimeout(BASELINE_URL, { cache: "no-store" }, 6000);
      if (!r.ok) throw new Error("HTTP " + r.status);
      const data = await r.json();
      serverBaselines = data.baselines || {};
    } catch {
      serverBaselines = {};
    }
  }

  async function fetchFeed() {
    try {
      const r = await fetchWithTimeout(FEED_URL, { cache: "no-store" }, 9000);
      if (!r.ok) throw new Error("HTTP " + r.status);
      const data = await r.json();
      return Array.isArray(data) ? data : data.messages || [];
    } catch (err) {
      const r = await fetchWithTimeout("feed-snapshot.json", { cache: "no-store" }, 3000);
      if (!r.ok) throw err;
      const data = await r.json();
      return Array.isArray(data) ? data : data.messages || [];
    }
  }

  async function fetchDexscreener(addresses) {
    const result = new Map();
    for (let i = 0; i < addresses.length; i += 30) {
      const chunk = addresses.slice(i, i + 30);
      try {
        const r = await fetchWithTimeout(`https://api.dexscreener.com/tokens/v1/${DEX_CHAIN}/${chunk.join(",")}`, { cache: "no-store" }, 9000);
        if (!r.ok) continue;
        const pairs = await r.json();
        for (const pair of pairs) {
          const addr = pair?.baseToken?.address;
          if (!addr) continue;
          const prev = result.get(addr);
          const liq = pair.liquidity?.usd ?? 0;
          if (!prev || liq > (prev.liquidity?.usd ?? 0)) result.set(addr, pair);
        }
      } catch {}
    }
    return result;
  }

  function dexToLive(pair) {
    if (!pair) return null;
    return {
      source: "dexscreener",
      price: pair.priceUsd != null ? parseFloat(pair.priceUsd) : null,
      mcap: pair.marketCap ?? pair.fdv ?? null,
      liquidity: pair.liquidity?.usd ?? null,
      volume24h: pair.volume?.h24 ?? null,
      change: {
        "5m": pair.priceChange?.m5 ?? null,
        "1h": pair.priceChange?.h1 ?? null,
        "24h": pair.priceChange?.h24 ?? null,
      },
      pairCreatedAt: pair.pairCreatedAt ?? null,
      url: pair.url ?? null,
    };
  }

  function buildRows(messages, liveByContract) {
    const posts = messages.map(parseBubbaPost).filter(Boolean).filter(p => p.tier === cfg.tier);
    const flat = [];
    for (const post of posts) {
      for (const coin of post.coins) {
        coin.ts = post.ts;
        coin.tier = post.tier;
        coin.live = coin.contract ? liveByContract.get(coin.contract) : null;
        coin.normalizedMcap = normalizeMcap(coin, coin.live);
        flat.push(coin);
      }
    }

    const byKey = new Map();
    for (const coin of flat) {
      const key = coin.contract || coin.symbol;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(coin);
    }

    for (const group of byKey.values()) {
      group.sort((a, b) => (a.ts || "").localeCompare(b.ts || ""));
      const first = group.find(c => c.normalizedMcap > 0) || group[0];
      let calledMcap = first?.normalizedMcap ?? first?.mcap ?? null;
      let calledTs = first?.ts ?? null;
      const stored = first?.contract ? serverBaselines[first.contract] : null;
      if (stored?.mcap && stored?.ts) {
        const storedMatch = group.find(c => c.ts === stored.ts);
        const normalizedStored = normalizeMcap({ ...storedMatch, mcap: stored.mcap, price: storedMatch?.price }, first?.live);
        const drift = calledMcap ? mcapRatio(normalizedStored, calledMcap) : null;
        if (normalizedStored && (!drift || drift < OUTLIER_RATIO || storedMatch)) {
          calledMcap = normalizedStored;
          calledTs = stored.ts;
        }
      }
      const latest = group[group.length - 1];
      const currentMcap = latest?.live?.mcap ?? latest?.normalizedMcap ?? null;
      const upDown = currentMcap != null && calledMcap > 0 ? ((currentMcap - calledMcap) / calledMcap) * 100 : null;
      for (const coin of group) {
        coin.calledMcap = calledMcap;
        coin.calledTs = calledTs;
        coin.currentMcap = currentMcap;
        coin.upDown = upDown;
        coin.flagCount = group.length;
      }
    }

    return flat.sort((a, b) => (b.ts || "").localeCompare(a.ts || ""));
  }

  function applyFilters() {
    const q = $("search").value.trim().toLowerCase();
    const sort = $("sort").value;
    filteredRows = rows.filter(r => {
      if (!q) return true;
      return [r.symbol, r.name, r.contract].some(v => String(v || "").toLowerCase().includes(q));
    });
    if (sort === "oldest") filteredRows.sort((a, b) => (a.ts || "").localeCompare(b.ts || ""));
    else if (sort === "up") filteredRows.sort((a, b) => (b.upDown ?? -Infinity) - (a.upDown ?? -Infinity));
    else if (sort === "down") filteredRows.sort((a, b) => (a.upDown ?? Infinity) - (b.upDown ?? Infinity));
    else if (sort === "liq") filteredRows.sort((a, b) => ((b.live?.liquidity ?? b.liquidity ?? 0) - (a.live?.liquidity ?? a.liquidity ?? 0)));
    else filteredRows.sort((a, b) => (b.ts || "").localeCompare(a.ts || ""));
  }

  function renderStats() {
    const unique = new Set(rows.map(r => r.contract || r.symbol));
    const live = rows.filter(r => r.live?.source === "dexscreener").length;
    const valid = rows.map(r => r.upDown).filter(Number.isFinite);
    const avg = valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null;
    const best = [...rows].filter(r => Number.isFinite(r.upDown)).sort((a, b) => b.upDown - a.upDown)[0];
    $("stats").innerHTML = `
      <div class="stat"><div class="k">Scans</div><div class="v">${rows.length}</div></div>
      <div class="stat"><div class="k">Unique Coins</div><div class="v">${unique.size}</div></div>
      <div class="stat"><div class="k">Dex Live Rows</div><div class="v">${live}</div></div>
      <div class="stat"><div class="k">Avg Up/Down</div><div class="v ${avg != null && avg < 0 ? "red" : ""}">${avg == null ? "-" : (avg >= 0 ? "+" : "") + avg.toFixed(1) + "%"}</div></div>
      <div class="stat"><div class="k">Top Runner</div><div class="v ${best?.upDown < 0 ? "red" : "amb"}">${best ? "$" + escapeHTML(best.symbol) + " " + (best.upDown >= 0 ? "+" : "") + best.upDown.toFixed(1) + "%" : "-"}</div></div>
    `;
  }

  function renderRows() {
    if (!filteredRows.length) {
      $("rows").innerHTML = `<tr><td colspan="14"><div class="empty">No scan rows match this filter.</div></td></tr>`;
      $("result-count").textContent = "0 rows";
      return;
    }
    $("result-count").textContent = `${filteredRows.length} rows`;
    $("rows").innerHTML = filteredRows.map(row => {
      const live = row.live;
      const current = live?.mcap ?? row.normalizedMcap;
      const chart = live?.url || row.links?.chart || (row.contract ? `https://dexscreener.com/solana/${row.contract}` : "#");
      const deltaCls = row.upDown == null ? "dim" : row.upDown >= 0 ? "pos" : "neg";
      const deltaText = row.upDown == null ? "-" : `${row.upDown >= 0 ? "+" : ""}${row.upDown.toFixed(1)}%`;
      const contract = row.contract || "";
      const caButton = contract
        ? `<button class="ca-copy" type="button" data-ca="${escapeHTML(contract)}" title="Copy full coin address"><span class="ca">${escapeHTML(abbrevAddress(contract))}</span><span class="copy-label">copy</span></button>`
        : `<span class="ca">-</span>`;
      return `
        <tr>
          <td><span class="dim">${fmtTime(row.ts)}</span></td>
          <td><a href="${escapeHTML(chart)}" target="_blank" rel="noopener"><span class="sym">$${escapeHTML(row.symbol)}</span></a><div class="name">${escapeHTML(row.name)}</div></td>
          <td class="num ${deltaCls}">${deltaText}</td>
          <td class="num">${fmtCompact(row.calledMcap)}</td>
          <td class="num">${fmtCompact(current)}</td>
          <td class="num">${fmtCompact(row.normalizedMcap)}</td>
          <td class="num">${fmtPrice(live?.price ?? row.price)}</td>
          <td class="num">${fmtCompact(live?.liquidity ?? row.liquidity)}</td>
          <td class="num">${fmtCompact(live?.volume24h ?? row.volume24h)}</td>
          <td class="num">${fmtCount(row.holders)}</td>
          <td class="num">${fmtCount(row.kols)}</td>
          <td class="num">${fmtCount(row.degens)}</td>
          <td class="num">${row.score == null ? "-" : Math.round(row.score)}</td>
          <td><span class="pill ${live ? "live" : "warn"}">${live ? "live" : "snapshot"}</span>${caButton}</td>
        </tr>
      `;
    }).join("");
  }

  async function copyAddress(button) {
    const ca = button.dataset.ca;
    if (!ca) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(ca);
      } else {
        const area = document.createElement("textarea");
        area.value = ca;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        document.execCommand("copy");
        area.remove();
      }
      button.classList.add("copied");
      const label = button.querySelector(".copy-label");
      if (label) label.textContent = "copied";
      setTimeout(() => {
        button.classList.remove("copied");
        if (label) label.textContent = "copy";
      }, 1200);
    } catch {
      button.classList.add("copy-failed");
      const label = button.querySelector(".copy-label");
      if (label) label.textContent = "failed";
      setTimeout(() => {
        button.classList.remove("copy-failed");
        if (label) label.textContent = "copy";
      }, 1200);
    }
  }

  function render() {
    applyFilters();
    renderStats();
    renderRows();
  }

  async function init() {
    $("tier-label").textContent = cfg.label;
    $("tier-range").textContent = cfg.range;
    document.title = `${cfg.label} History // KEEPWHATSYOURS.AI`;
    document.querySelectorAll("[data-tier-link]").forEach(a => {
      if (a.dataset.tierLink === cfg.tier) a.classList.add("active");
    });
    $("status").innerHTML = `// loading ${escapeHTML(cfg.label)} feed...`;
    try {
      await fetchBaselines();
      const messages = await fetchFeed();
      const posts = messages.map(parseBubbaPost).filter(Boolean).filter(p => p.tier === cfg.tier);
      const addresses = [...new Set(posts.flatMap(p => p.coins.map(c => c.contract).filter(Boolean)))];
      $("status").innerHTML = `// feed rows: <b>${posts.length}</b> scans · contracts: <b>${addresses.length}</b> · loading Dexscreener...`;
      const dexPairs = await fetchDexscreener(addresses);
      const liveByContract = new Map([...dexPairs.entries()].map(([addr, pair]) => [addr, dexToLive(pair)]));
      rows = buildRows(messages, liveByContract);
      $("status").innerHTML = `// source: <b>Dexscreener</b> + scan feed · updated: <b>${new Date().toISOString().slice(11,19)} UTC</b>`;
      render();
    } catch (err) {
      $("status").innerHTML = `<span class="neg">// history feed failed: ${escapeHTML(err.message || err)}</span>`;
      $("rows").innerHTML = `<tr><td colspan="14"><div class="empty">Unable to load scan history.</div></td></tr>`;
    }
  }

  $("search").addEventListener("input", render);
  $("sort").addEventListener("change", render);
  $("rows").addEventListener("click", (event) => {
    const button = event.target.closest(".ca-copy");
    if (button) copyAddress(button);
  });
  init();
})();
