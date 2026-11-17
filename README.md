# InvestorView

**English** | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md)

A trading screening app: local charting and stock screening in the browser. It runs on your own machine, needs no account or API key, and has no dependencies beyond Node.js.

- **Desktop app (everything):** download `InvestorView.exe` from the [latest release](https://github.com/RockAlter/Investerview/releases/latest), or run it from source as described below.
- **Web version:** <https://rockalter.github.io/Investerview/> — nothing to install; stocks, ETFs, indices and crypto, with a few limits. See [Web version and its limits](#web-version-and-its-limits).

## Features

- **Charts** — 13 chart types: candles, hollow candles, Heikin Ashi, bars, HLC bars, high-low, line, line with markers, step line, area, baseline, columns and Renko (brick size = 14-bar ATR); timeframes from 1 minute to 1 month; regular, log, percent and indexed-to-100 price scales.
- **Compare** — add up to 4 other symbols to the chart as lines (for example NVDA against SPY). Each line starts at the charted symbol's price at the left edge of the screen, so the lines show which one moved more since then.
- **Multi-chart layout** — show 1, 2 (side by side or stacked) or 4 charts at once. Each chart has its own symbol, timeframe, chart type and indicators; drawings are shared. Click a chart, then a watchlist symbol, to load it there.
- **Price alerts** — in the **Alerts** tab, or by right-clicking the chart, set a price for a symbol. When the price gets there the app shows a message, plays a sound and (if you allow it) a Windows notification, and the alert is drawn on the chart as a line. Alerts are checked about every 20 seconds and only while the app is open.
- **Volume profile** — in the Indicators list: a sideways histogram at the right edge of the chart showing how much volume traded at each price among the bars on screen (green = rising bars, red = falling), with the busiest price (POC) marked.
- **Paper account performance** — the Paper tab draws the account value over time and shows max drawdown, win rate, average win and loss, profit factor, best and worst trade, and realized P&L per symbol.
- **Visit counter (web version only)** — the web page reports each visit to the data proxy, which keeps anonymous daily totals: visits, visitors, new visitors and a count per country. No IP address, cookie or identifier is stored. The desktop app reports nothing.
- **Extended hours** — optional pre-market and after-hours bars (4:00 am–8:00 pm ET) for stocks and ETFs on the 1m–1h charts, shaded, plus the latest extended-hours price in the watchlist. The overnight session is not available from this data source.
- **Languages** — English, 简体中文, 繁體中文 and 日本語. The interface follows the browser/OS language automatically, with a selector in the top bar to override it. Translations live in `public/i18n.js`.
- **Light and dark themes** — follows your system setting; the ☀ / ☾ button in the top bar switches and remembers your choice.
- **Version label** — the running version is shown at the bottom of the left toolbar.
- **Indicators** — 25 in all. On the price chart: SMA, EMA, WMA, linear regression line, VWAP, Bollinger Bands, Donchian and Keltner channels, Supertrend, Parabolic SAR, volume. Below it: RSI, MACD, Stochastic, CCI, Williams %R, MFI, ADX/DMI, ATR, standard deviation, ROC, momentum, OBV. Periods are editable.
- **Drawing tools** — 25, grouped in the left toolbar: lines (trend, ray, extended, arrow, horizontal, horizontal ray, vertical, cross), channels (parallel, regression ±2σ, Andrews pitchfork), Fibonacci and Gann (retracement, extension, fan, time zones, Gann fan), shapes (rectangle, ellipse, triangle), measuring (measure, price range, date range, long/short position with risk : reward, anchored VWAP) and text. Select a drawing and drag its handles to adjust it. Drawings are saved per symbol and survive timeframe changes.
- **Paper trading** — a practice account with virtual cash (100,000 to start, resettable) in the **Paper** tab of the side panel. Buy, sell and short the charted symbol with market, limit and stop orders; see positions, average cost, realized and unrealized P&L and the trade history; average cost and working orders are drawn on the chart. Nothing is sent to a broker. Orders fill at the latest price the app has (also when the market is closed), limit and stop orders are checked about every 20 seconds while the app is open, there is no borrowing, no fees, and no currency conversion.
- **Watchlist** — sections, drag-to-reorder, live last price and daily change.
- **Import** — reads a watchlist exported from TradingView (`EXCHANGE:SYMBOL` text, including `###Section` headings) and converts the symbols.
- **Screener** — scan US large caps, ETFs, crypto, FX/commodities, Japan large caps, your watchlist or a custom list; filter by price, change %, RSI, relative volume, distance from 52-week high and position against the 50/200-day averages.

## Web version and its limits

<https://rockalter.github.io/Investerview/> is the same interface published on GitHub Pages. It opens in any browser with nothing to install.

**Where its prices come from.** Browsers do not let a web page read data from another website unless that website explicitly allows it (the CORS rule). Yahoo Finance, Nasdaq and most stock sources do not allow it, so the web version uses several sources and switches between them by itself. A source that fails is skipped for two minutes and the next one is tried:

| Order | Source | Covers |
|---|---|---|
| Crypto | Binance, then Coinbase (straight from the browser) | Crypto priced in USD, all timeframes |
| 1 | **InvestorView data proxy** — a small Cloudflare Worker ([`worker/`](worker/README.md)) that asks Yahoo Finance, then Nasdaq, then Tencent on the page's behalf | Everything the desktop app shows, including intraday, FX, futures and symbol search |
| 2 | Tencent Finance (straight from the browser) | US stocks and ETFs, S&P 500 / Dow / Nasdaq / Hang Seng, Hong Kong and China A-shares; daily, weekly, monthly |
| 3 | Yahoo Finance through the public AllOrigins proxy | Everything, but slow and often unavailable |

The source in use is shown in the legend line above the chart.

| | Web version | Desktop app |
|---|---|---|
| Stocks, ETFs, indices, crypto (daily, weekly, monthly) | Yes | Yes |
| Intraday charts (1m–1h), FX, futures, symbol search | Yes while the data proxy (or AllOrigins) is reachable; crypto intraday always | Yes |
| Extended-hours prices | No | Yes |
| Screener | All built-in lists | All built-in lists |
| Watchlist import | No | Yes |
| IBKR positions and orders | No | Yes |
| MCP server for AI apps | No | Yes |
| Where your watchlist and drawings are kept | In that browser only: not backed up, and not shared with other browsers, devices or the desktop app | In the browser and in a data file on disk |
| Chart types, indicators, drawing tools, languages, themes | Yes | Yes |

Other things to know about the web version:

- Prices from the backup sources can differ slightly from Yahoo's (crypto comes from one exchange; adjustments for dividends differ), and backup sources show the ticker instead of the company name.
- The web version is the `public/` folder published to the `gh-pages` branch; `public/web-data.js` is its data layer, and `PROXY_URL` at its top is the data proxy's address.

## Run it

Requires [Node.js](https://nodejs.org) 18 or newer.

```bash
node server.js
```

Then open <http://localhost:5178>. On Windows you can double-click `start.bat` instead. Set the `PORT` environment variable to use a different port.

## Build a standalone .exe

To give the app to someone who doesn't have Node.js, build a single-file executable:

```bash
npm run build
```

This writes `dist/InvestorView.exe` (about 80 MB — it contains the Node runtime). The build downloads one helper tool, [postject](https://github.com/nodejs/postject), through `npx`. The build also downloads [rcedit](https://github.com/electron/rcedit) through `npm` to give the exe its icon and name. Double-clicking the exe opens the app in a window of its own, with no console and no browser tab; closing the window stops the app. The window is Microsoft Edge (part of Windows) or Chrome in app mode, with its own browser profile. If neither is installed, or with `--browser`, the app opens in the default browser instead and stops by itself ten minutes after the page is closed.

The exe is not code-signed, so Windows SmartScreen will warn the first time it runs ("More info" → "Run anyway").

## Use it from an AI app (MCP)

The same program is also a [Model Context Protocol](https://modelcontextprotocol.io) server, so an AI app such as Claude Desktop or Claude Code can read market data, run screens and read your saved watchlist and drawings, then write a report from them. It is read-only: no tool places trades or changes your data.

Start it with `--mcp` (it then talks over stdin/stdout and does not open the web app). Add this to your AI app's MCP settings, with the real path to the exe:

```json
{
  "mcpServers": {
    "investerview": {
      "command": "C:\\path\\to\\InvestorView.exe",
      "args": ["--mcp"]
    }
  }
}
```

Running from source instead: `"command": "node", "args": ["C:\\path\\to\\server.js", "--mcp"]`.

| Tool | Returns |
|---|---|
| `search_symbols` | Tickers matching a company name |
| `get_quote` | Price, change, volume, RSI, moving averages, 52-week position, extended-hours price (up to 25 symbols) |
| `get_price_history` | OHLCV bars for any timeframe, optionally with extended hours |
| `get_technicals` | SMA 20/50/200, EMA 20, RSI 14, MACD, Bollinger Bands |
| `run_screener` | A built-in universe, your watchlist or a custom list, filtered and sorted |
| `get_watchlist` | Your watchlist by section, with quotes |
| `get_drawings` | Your saved drawings: lines, price levels, channels, positions, text notes and Fibonacci levels |
| `get_alerts` | Your price alerts: the ones still waiting and the ones that triggered |

There is also a ready-made prompt, `watchlist_report`. Or just ask: "write a morning report on my InvestorView watchlist".

The watchlist and drawings tools read the data file described below, so open the desktop app at least once first.

## Interactive Brokers positions (read-only)

The **Positions** tab in the side panel shows your IBKR account: balances, positions with unrealized P&L, and working orders. On the chart, a held symbol gets a dashed line at your average cost, and each working order a line at its price.

It is read-only. The app can only send a fixed list of read requests to IBKR (see `IB_READONLY` in `server.js`); it cannot place, change or cancel orders.

Setup, each trading day:

1. Download IBKR's **Client Portal Gateway** (see IBKR's [Web API documentation](https://www.interactivebrokers.com/docs/web-api)) and unzip it. It needs Java and an IBKR Pro account.
2. Start it from its folder: `bin\run.bat root\conf.yaml`
3. Log in at <https://localhost:5000>. A browser certificate warning there is expected. Use your paper-trading username to see the paper account.
4. Open the Positions tab and press Retry.

Notes:

- Your IBKR password is typed only into IBKR's own login page; this app never sees it.
- Positions and balances need only IBKR's read-only session, so a TWS or mobile login is not interrupted. Working orders and day P&L appear only if a trading session is already active in the gateway; the app never starts one.
- The gateway must run on the same computer. Use `--ibkr=https://localhost:5001` (or `IBKR_GATEWAY`) if you changed its port.
- IBKR logs the gateway out about once a day.
- The MCP server does not expose account data.

## Where your data is kept

In the desktop app, the watchlist, drawings and indicator settings are stored in the browser and mirrored to a file: `%APPDATA%\Investerview\data.json` on Windows, `~/.config/Investerview/data.json` elsewhere (set `INVESTERVIEW_DATA` to change it). On start-up the file wins, so your data survives a cleared browser and is shared between browsers on the same PC. Copy the file to back it up or move it to another machine.

The web version has no data file: everything stays in that browser's local storage.

## Symbols

| Market | Example |
|---|---|
| US stocks / ETFs | `AAPL`, `BRK-B`, `SPY` |
| Tokyo | `7203.T` |
| Hong Kong | `0700.HK` |
| London / Xetra / Paris / Toronto | `RR.L`, `RHM.DE`, `MC.PA`, `RY.TO` |
| Indices | `^GSPC`, `^NDX`, `^N225`, `^FTSE`, `^VIX` |
| Crypto | `BTC-USD` |
| FX | `EURUSD=X` |
| Futures | `ES=F`, `GC=F` |

You can also type a company name in the search box.

## Data source and limits

- Prices come from Yahoo Finance's public web endpoints, proxied by `server.js`, with backup sources when Yahoo is unavailable (see Troubleshooting). They are unofficial and unsupported: they can change, rate-limit or stop working, and quotes may be delayed (15–20 minutes on some exchanges).
- Intraday history is limited: about 5 days of 1-minute bars, a month of 5/15-minute bars and 6 months of hourly bars.
- The chart library ([Lightweight Charts](https://github.com/tradingview/lightweight-charts), Apache-2.0) loads from a CDN, so the app needs an internet connection.
- Chart settings such as the last symbol, timeframe and language are stored only in the browser's local storage.
- This is a charting and screening tool only. It places no trades and nothing in it is investment advice.

## Troubleshooting: no prices, "HTTP 403" or "refused"

Yahoo Finance turns away requests from some networks: certain VPN exit points, corporate or school proxies, cloud and datacenter addresses, and some regions. The app tries four routes before giving up (two Yahoo servers, each with and without a session cookie), so most cases recover on their own. If the chart still shows "Yahoo Finance refused the request":

- Switch your VPN or proxy on or off, or pick a different VPN location, then reload.
- Wait a few minutes: after many requests Yahoo may block an address temporarily.
- Open `http://localhost:5178/api/diag` (the "Show connection diagnostics" link) to see what each route returned. It contains no personal data and is safe to share when asking for help.

### Backup data sources

When Yahoo refuses or cannot be reached, the desktop app switches to other public sources by itself, and the chart shows a "Backup data" tag naming the one in use:

| Source | Covers | Timeframes |
|---|---|---|
| Binance, then Coinbase | Crypto priced in USD (`BTC-USD`) | All |
| Nasdaq | US stocks and ETFs | Daily, weekly, monthly (10 years) |

Limits while on backup data: US stocks have no intraday charts (1m–1h); there is no data at all for stocks outside the US, indices, FX or futures; and there are no extended-hours prices, no symbol search (type the ticker itself) and no company names. Prices can differ slightly from Yahoo's (crypto comes from one exchange; adjustments for dividends differ).

Version 1.5.0 also had an experimental Eastmoney source for indices, FX, futures and intraday bars. It was removed in 1.5.1: Eastmoney blocked an address for more than three hours after a short burst of requests, which makes it unusable as a backup.

The app connects to Yahoo directly. It does not use a proxy configured only in your browser or in Windows settings; a VPN in full-tunnel (TUN) mode does apply.

## Layout

```
server.js            local web server + market-data proxy + MCP server (no dependencies)
build-exe.js         builds dist/InvestorView.exe
public/index.html    page markup
public/app.js        charts, indicators, drawings, watchlist, screener
public/i18n.js       interface translations
public/web-data.js   data layer of the web version: picks and switches between price sources
public/style.css     styles
start.bat            Windows launcher
worker/              data proxy for the web version (Cloudflare Worker), see worker/README.md
```
