'use strict';
// ChartDesk local server: serves the app and proxies free market data (Yahoo Finance
// public chart endpoints) so the browser does not hit CORS limits. No dependencies.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 5178;
const PUB = path.join(__dirname, 'public');
const YH = 'https://query1.finance.yahoo.com';
const HEADERS = { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' };
const INTERVALS = new Set(['1m', '5m', '15m', '60m', '1d', '1wk', '1mo']);
const RANGES = new Set(['1d', '5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'max']);
const SYMBOL_RE = /^[A-Za-z0-9.\-=^]{1,20}$/;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

// ---- tiny promise cache -------------------------------------------------
const cache = new Map();
function cached(key, ttlMs, fn) {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.exp > now) return hit.p;
  if (cache.size > 800) for (const [k, v] of cache) if (v.exp <= now) cache.delete(k);
  const p = fn();
  cache.set(key, { exp: now + ttlMs, p });
  p.catch(() => cache.delete(key));
  return p;
}

async function yahoo(pathname) {
  const r = await fetch(YH + pathname, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => null);
  if (!j) throw new Error(`Data source returned ${r.status}`);
  const err = j.chart && j.chart.error;
  if (err) throw new Error(err.description || 'Data source error');
  if (!r.ok) throw new Error(`Data source returned ${r.status}`);
  return j;
}

// ---- candles ------------------------------------------------------------
// ext = include pre-market and after-hours bars (intraday only); those bars get x: 1
function candles(symbol, interval, range, ext = false) {
  const intraday = interval.endsWith('m');
  ext = ext && intraday;
  return cached(`c|${symbol}|${interval}|${range}|${ext ? 1 : 0}`, intraday ? 15000 : 60000, async () => {
    const j = await yahoo(`/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}${ext ? '&includePrePost=true' : ''}`);
    const res = j.chart && j.chart.result && j.chart.result[0];
    if (!res) throw new Error('No data for ' + symbol);
    const m = res.meta || {};
    const ts = res.timestamp || [];
    const q = (res.indicators && res.indicators.quote && res.indicators.quote[0]) || {};
    const off = m.gmtoffset || 0; // shift so the chart shows exchange-local time
    // regular session as seconds-of-day in exchange time, used to flag extended-hours bars
    const reg = m.currentTradingPeriod && m.currentTradingPeriod.regular;
    const hasSessions = ext && reg && (m.instrumentType === 'EQUITY' || m.instrumentType === 'ETF');
    const tod = (s) => (((s + off) % 86400) + 86400) % 86400;
    const regStart = hasSessions ? tod(reg.start) : 0, regEnd = hasSessions ? tod(reg.end) : 0;
    const byTime = new Map();
    for (let i = 0; i < ts.length; i++) {
      const o = q.open && q.open[i], h = q.high && q.high[i], l = q.low && q.low[i], c = q.close && q.close[i];
      if (o == null || h == null || l == null || c == null) continue;
      let t = ts[i] + off;
      if (!intraday) t = Math.floor(t / 86400) * 86400;
      const bar = { time: t, open: o, high: h, low: l, close: c, volume: (q.volume && q.volume[i]) || 0 };
      if (hasSessions) { const s = t % 86400; if (s < regStart || s >= regEnd) bar.x = 1; }
      byTime.set(t, bar);
    }
    const bars = [...byTime.values()].sort((a, b) => a.time - b.time);
    return {
      symbol,
      name: m.shortName || m.longName || symbol,
      currency: m.currency || '',
      exchange: m.fullExchangeName || m.exchangeName || '',
      type: m.instrumentType || '',
      price: m.regularMarketPrice != null ? m.regularMarketPrice : (bars.length ? bars[bars.length - 1].close : null),
      bars,
    };
  });
}

// ---- screener metrics ---------------------------------------------------
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
function lastSma(c, p) { return c.length >= p ? mean(c.slice(-p)) : null; }
function lastRsi(c, p = 14) {
  if (c.length <= p) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const d = c[i] - c[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= p; l /= p;
  for (let i = p + 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    g = (g * (p - 1) + Math.max(d, 0)) / p;
    l = (l * (p - 1) + Math.max(-d, 0)) / p;
  }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
const pct = (a, b) => (a != null && b ? (a / b - 1) * 100 : null);

// latest pre-market / after-hours price, if the most recent 5-minute bar is outside the regular session
async function extQuote(symbol, last) {
  try {
    const e = await candles(symbol, '5m', '1d', true);
    const b = e.bars[e.bars.length - 1];
    return b && b.x ? { extPrice: b.close, extChg: pct(b.close, last) } : {};
  } catch { return {}; }
}

async function metrics(symbol, ext) {
  const d = await candles(symbol, '1d', '1y');
  const b = d.bars;
  if (b.length < 2) throw new Error('Not enough history');
  const c = b.map((x) => x.close);
  const n = c.length;
  const last = c[n - 1];
  const back = (k) => (n > k ? c[n - 1 - k] : null);
  const vols = b.slice(-21, -1).map((x) => x.volume);
  const avgVol = vols.length ? mean(vols) : 0;
  const sma50 = lastSma(c, 50), sma200 = lastSma(c, 200);
  const hi = Math.max(...b.map((x) => x.high)), lo = Math.min(...b.map((x) => x.low));
  return {
    symbol, name: d.name, type: d.type, currency: d.currency,
    last, chg: pct(last, c[n - 2]), chgAbs: last - c[n - 2],
    volume: b[n - 1].volume, relVol: avgVol ? b[n - 1].volume / avgVol : null,
    rsi: lastRsi(c), sma50, sma200,
    vs50: pct(last, sma50), vs200: pct(last, sma200),
    fromHigh: pct(last, hi), fromLow: pct(last, lo),
    w1: pct(last, back(5)), m1: pct(last, back(21)), m3: pct(last, back(63)),
    spark: c.slice(-30),
    ...(ext && (d.type === 'EQUITY' || d.type === 'ETF') ? await extQuote(symbol, last) : {}),
  };
}

async function screen(symbols, ext) {
  const rows = [], errors = [];
  let next = 0;
  const worker = async () => {
    while (next < symbols.length) {
      const s = symbols[next++];
      try { rows.push(await metrics(s, ext)); } catch (e) { errors.push({ symbol: s, error: e.message }); }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  const order = new Map(symbols.map((s, i) => [s, i]));
  rows.sort((a, b) => order.get(a.symbol) - order.get(b.symbol));
  return { rows, errors };
}

function search(q) {
  return cached('s|' + q.toLowerCase(), 300000, async () => {
    const j = await yahoo(`/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0`);
    return (j.quotes || []).filter((x) => x.symbol).map((x) => ({
      symbol: x.symbol, name: x.shortname || x.longname || '', type: x.typeDisp || '', exchange: x.exchDisp || '',
    }));
  });
}

// ---- http ---------------------------------------------------------------
function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}
const cleanSymbol = (s) => { s = String(s || '').trim().toUpperCase(); return SYMBOL_RE.test(s) ? s : null; };

async function handleApi(url, res) {
  const p = url.searchParams;
  if (url.pathname === '/api/candles') {
    const symbol = cleanSymbol(p.get('symbol'));
    const interval = p.get('interval'), range = p.get('range');
    if (!symbol || !INTERVALS.has(interval) || !RANGES.has(range)) return send(res, 400, { error: 'Invalid symbol, interval or range' });
    return send(res, 200, await candles(symbol, interval, range, p.get('ext') === '1'));
  }
  if (url.pathname === '/api/screen') {
    const symbols = [...new Set((p.get('symbols') || '').split(',').map(cleanSymbol).filter(Boolean))].slice(0, 120);
    if (!symbols.length) return send(res, 200, { rows: [], errors: [] });
    return send(res, 200, await screen(symbols, p.get('ext') === '1'));
  }
  if (url.pathname === '/api/search') {
    const q = (p.get('q') || '').trim().slice(0, 40);
    return send(res, 200, q ? await search(q) : []);
  }
  send(res, 404, { error: 'Not found' });
}

let sea = null; // set when running as a packaged single-file executable
try { const s = require('node:sea'); if (s.isSea()) sea = s; } catch { /* plain node */ }

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await handleApi(url, res);
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.resolve(PUB, rel);
    if (file !== PUB && !file.startsWith(PUB + path.sep)) return send(res, 403, 'Forbidden', 'text/plain');
    const done = (err, buf) => {
      if (err) return send(res, 404, 'Not found', 'text/plain');
      send(res, 200, buf, MIME[path.extname(file)] || 'application/octet-stream');
    };
    if (!sea) return fs.readFile(file, done);
    // packaged exe: the page files are embedded in the executable
    try { done(null, Buffer.from(sea.getAsset('public/' + path.relative(PUB, file).split(path.sep).join('/')))); } catch (e) { done(e); }
  } catch (e) {
    send(res, 502, { error: e.message || 'Server error' });
  }
});

const URL_LOCAL = `http://localhost:${PORT}`;
function openBrowser() {
  if (!sea || process.env.NO_OPEN) return; // only the packaged exe opens a browser by itself
  const cmd = process.platform === 'win32' ? `start "" ${URL_LOCAL}` : process.platform === 'darwin' ? `open ${URL_LOCAL}` : `xdg-open ${URL_LOCAL}`;
  require('child_process').exec(cmd, () => {});
}
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log(`Port ${PORT} is already in use - ChartDesk is probably already running. Opening ${URL_LOCAL}`);
    openBrowser();
    return setTimeout(() => process.exit(0), 1500);
  }
  console.error(e.message); process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`ChartDesk running at ${URL_LOCAL}`);
  if (sea) console.log('Keep this window open while you use the app. Close it to stop.');
  openBrowser();
});
