# Investerview data proxy

A small [Cloudflare Worker](https://developers.cloudflare.com/workers/) that gives the web version
(GitHub Pages) stock data. A web page cannot call Yahoo Finance or Nasdaq itself (they do not allow
requests from other websites), so this Worker does it on the page's behalf, the same way the desktop
app's `server.js` does, and switches sources by itself:

1. **Yahoo Finance**: stocks, ETFs, indices, FX, futures, crypto, intraday and symbol search. It tries
   four routes (two servers, each with and without a session cookie).
2. **Nasdaq**: US stocks and ETFs, daily / weekly / monthly.
3. **Tencent**: US stocks, ETFs and the main indices, plus Hong Kong and China A-shares, daily / weekly / monthly.

If the Worker itself is down, the page falls back to Tencent and AllOrigins directly (see `public/web-data.js`).

| Route | Example |
|---|---|
| `/candles` | `/candles?symbol=AAPL&interval=1d&range=1y` (add `&ext=1` for pre/after-market bars) |
| `/search` | `/search?q=apple` |
| `/health` | which upstream sources work from the Worker right now |
| `/hit` | called once by the web page per visit; adds one to the day's anonymous totals (needs the `VISITS` KV namespace in `wrangler.toml`) |
| `/stats?key=…` | the owner's page with the daily totals; the key is the `STATS_KEY` secret (`npx wrangler secret put STATS_KEY`) |

Answers are cached at Cloudflare's edge for 30 seconds (intraday) to 5 minutes, so many viewers cost few
upstream calls. Only the websites in `ALLOWED_ORIGINS` (`wrangler.toml`) and `localhost` may use it.
The free Workers plan allows 100,000 requests a day.

## Deploy (about 5 minutes)

You need a free Cloudflare account: <https://dash.cloudflare.com/sign-up>.

**Option A: from the command line** (needs Node.js)

```bash
cd worker
npx wrangler login
npx wrangler deploy
```

**Option B: in the browser**: Cloudflare dashboard → *Workers & Pages* → *Create* → *Create Worker* →
name it `investerview-data` → *Deploy* → *Edit code*, replace everything with the contents of `worker.js`,
then *Deploy*. Under *Settings → Variables*, add `ALLOWED_ORIGINS` = `https://rockalter.github.io`.

Either way, Cloudflare shows the Worker's address, for example
`https://investerview-data.<your-subdomain>.workers.dev`. Open `<that address>/health` to check it: each
source should say `"working": true`.

Then put the address into `PROXY_URL` at the top of `public/web-data.js` and publish the page again.

## Test it on your own computer

```bash
node worker/dev-server.mjs
```

This runs the Worker at `http://localhost:8787`. Start the app (`node server.js`) and open
`http://localhost:5178/?web&proxy=http://localhost:8787` to use the web version through it.
`BLOCK=yahoo,nasdaq node worker/dev-server.mjs` pretends those sources are blocked, to watch it switch.

Note: Yahoo sometimes refuses requests from cloud addresses, Cloudflare's included. The Worker then
moves on to Nasdaq and Tencent for daily charts. Intraday, FX and futures need Yahoo, so they may be
missing until Yahoo accepts the Worker again.
