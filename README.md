# Investerview

A trading screening app: local charting and stock screening in the browser (the UI calls itself **ChartDesk**). It runs on your own machine, needs no account or API key, and has no dependencies beyond Node.js.

## Features

- **Charts** — candles, Heikin Ashi, bars, line or area; timeframes from 1 minute to 1 month; log scale.
- **Extended hours** — optional pre-market and after-hours bars (4:00 am–8:00 pm ET) for stocks and ETFs on the 1m–1h charts, shaded, plus the latest extended-hours price in the watchlist. The overnight session is not available from this data source.
- **Languages** — English, 简体中文, 繁體中文 and 日本語. The interface follows the browser/OS language automatically, with a selector in the top bar to override it. Translations live in `public/i18n.js`.
- **Indicators** — SMA, EMA, Bollinger Bands, volume, RSI, MACD, with editable periods.
- **Drawing tools** — trend line, horizontal/vertical line, rectangle, Fibonacci retracement, measure. Drawings are saved per symbol and survive timeframe changes.
- **Watchlist** — sections, drag-to-reorder, live last price and daily change.
- **Import** — reads a watchlist exported from TradingView (`EXCHANGE:SYMBOL` text, including `###Section` headings) and converts the symbols.
- **Screener** — scan US large caps, ETFs, crypto, FX/commodities, Japan large caps, your watchlist or a custom list; filter by price, change %, RSI, relative volume, distance from 52-week high and position against the 50/200-day averages.

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

This writes `dist/Investerview.exe` (about 80 MB — it contains the Node runtime). The build downloads one helper tool, [postject](https://github.com/nodejs/postject), through `npx`. Double-clicking the exe starts the app and opens it in the default browser; closing its console window stops it.

The exe is not code-signed, so Windows SmartScreen will warn the first time it runs ("More info" → "Run anyway").

## Use it from an AI app (MCP)

The same program is also a [Model Context Protocol](https://modelcontextprotocol.io) server, so an AI app such as Claude Desktop or Claude Code can read market data, run screens and read your saved watchlist and drawings, then write a report from them. It is read-only: no tool places trades or changes your data.

Start it with `--mcp` (it then talks over stdin/stdout and does not open the web app). Add this to your AI app's MCP settings, with the real path to the exe:

```json
{
  "mcpServers": {
    "investerview": {
      "command": "C:\\path\\to\\Investerview.exe",
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
| `get_drawings` | Your saved trend lines, price levels and Fibonacci retracements |

There is also a ready-made prompt, `watchlist_report`. Or just ask: "write a morning report on my Investerview watchlist".

The watchlist and drawings tools read the data file described below, so open the web app at least once first.

## Where your data is kept

The watchlist, drawings and indicator settings are stored in the browser and mirrored to a file: `%APPDATA%\Investerview\data.json` on Windows, `~/.config/Investerview/data.json` elsewhere (set `INVESTERVIEW_DATA` to change it). On start-up the file wins, so your data survives a cleared browser and is shared between browsers on the same PC. Copy the file to back it up or move it to another machine.

## Symbols

| Market | Example |
|---|---|
| US stocks / ETFs | `AAPL`, `BRK-B`, `SPY` |
| Tokyo | `7203.T` |
| Hong Kong | `0700.HK` |
| London / Xetra / Toronto | `RR.L`, `RHM.DE`, `RY.TO` |
| Indices | `^GSPC`, `^NDX`, `^N225`, `^VIX` |
| Crypto | `BTC-USD` |
| FX | `EURUSD=X` |
| Futures | `ES=F`, `GC=F` |

You can also type a company name in the search box.

## Data source and limits

- Prices come from Yahoo Finance's public web endpoints, proxied by `server.js`. They are unofficial and unsupported: they can change, rate-limit or stop working, and quotes may be delayed (15–20 minutes on some exchanges).
- Intraday history is limited: about 5 days of 1-minute bars, a month of 5/15-minute bars and 6 months of hourly bars.
- The chart library ([Lightweight Charts](https://github.com/tradingview/lightweight-charts), Apache-2.0) loads from a CDN, so the app needs an internet connection.
- Chart settings such as the last symbol, timeframe and language are stored only in the browser's local storage.
- This is a charting and screening tool only. It places no trades and nothing in it is investment advice.

## Layout

```
server.js          local web server + market-data proxy (no dependencies)
public/index.html  page markup
public/app.js      charts, indicators, drawings, watchlist, screener
public/style.css   styles
start.bat          Windows launcher
```
