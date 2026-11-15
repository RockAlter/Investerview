'use strict';
// ChartDesk local server: serves the app and proxies free market data (Yahoo Finance
// public chart endpoints) so the browser does not hit CORS limits. No dependencies.
const http = require('http');
const fs = require('fs');
const path = require('path');

// command-line options: --port=5178  --ibkr=https://localhost:5000  --mcp
const argVal = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };
const PORT = Number(argVal('port') || process.env.PORT) || 5178;
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

async function handleApi(url, req, res) {
  const p = url.searchParams;
  // Only this machine's own page may call the API: blocks other websites and DNS-rebinding tricks.
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/;
  const origin = req.headers.origin;
  if (!local.test(req.headers.host || '') || (origin && !local.test(origin.replace(/^https?:\/\//, '')))) return send(res, 403, { error: 'Forbidden' });
  if (url.pathname === '/api/state') {
    if (req.method === 'GET') return send(res, 200, readState() || {});
    if (req.method !== 'PUT') return send(res, 405, { error: 'Method not allowed' });
    if (!/^application\/json/i.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'JSON required' });
    let state;
    try { state = cleanState(JSON.parse(await readBody(req, 2e6))); } catch (e) { return send(res, 400, { error: e.message }); }
    writeState(state);
    return send(res, 200, { ok: true });
  }
  if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
  if (url.pathname === '/api/ibkr') {
    const want = p.get('account') || '';
    return send(res, 200, await ibkrSnapshot(/^[A-Za-z0-9]{1,20}$/.test(want) ? want : ''));
  }
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

// ---- user data file -------------------------------------------------------
// The page keeps the watchlist, drawings and indicators in browser storage and mirrors
// them here, so they survive a cleared browser and can be read by the MCP server.
const os = require('os');
const DATA_FILE = process.env.INVESTERVIEW_DATA
  || path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'Investerview', 'data.json');
function readState() { try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return null; } }
function writeState(s) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(s));
  fs.renameSync(DATA_FILE + '.tmp', DATA_FILE);
}
const isNum = (v) => typeof v === 'number' && isFinite(v);
const isPoint = (p) => p && isNum(p.time) && isNum(p.price);
function cleanState(s) {
  if (!s || typeof s !== 'object') throw new Error('Invalid data');
  const str = (a, max) => (Array.isArray(a) ? a : []).filter((x) => typeof x === 'string' && x.length <= 40).slice(0, max);
  const drawings = {};
  for (const [sym, list] of Object.entries(s.drawings && typeof s.drawings === 'object' ? s.drawings : {})) {
    if (!SYMBOL_RE.test(sym) || !Array.isArray(list)) continue;
    const ok = list.filter((d) => d && typeof d.type === 'string' && d.type.length <= 12 && isPoint(d.a) && isPoint(d.b)).slice(0, 200)
      .map((d) => ({ type: d.type, a: { time: d.a.time, price: d.a.price }, b: { time: d.b.time, price: d.b.price } }));
    if (ok.length) drawings[sym] = ok;
  }
  const indicators = (Array.isArray(s.indicators) ? s.indicators : []).filter((i) => i && typeof i.type === 'string' && i.type.length <= 8).slice(0, 20)
    .map((i) => (isNum(i.period) ? { id: i.id, type: i.type, period: i.period } : { id: i.id, type: i.type }));
  return { watch: str(s.watch, 200), collapsed: str(s.collapsed, 100), drawings, indicators, updated: Date.now() };
}
function readBody(req, max) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > max) { reject(new Error('Too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---- Interactive Brokers (read-only) ----------------------------------------
// Reads positions, balances and open orders from IBKR's Client Portal Gateway, which the
// user runs and logs into on this computer. Nothing here can place, change or cancel an
// order: ib() refuses every request that is not on the read-only list below.
let IB_URL = null;
try { IB_URL = new URL(argVal('ibkr') || process.env.IBKR_GATEWAY || 'https://localhost:5000'); } catch { /* invalid URL: stay off */ }
// The gateway uses a self-signed certificate, so it is only trusted on the loopback address.
const IB_LOCAL = !!IB_URL && /^(localhost|127\.0\.0\.1)$/.test(IB_URL.hostname);
const IB_READONLY = [
  ['POST', /^\/tickle$/],                                   // keep-alive ping, also reports session status
  ['GET', /^\/portfolio\/accounts$/],
  ['GET', /^\/portfolio\/[A-Za-z0-9]+\/positions\/\d+$/],
  ['GET', /^\/portfolio\/[A-Za-z0-9]+\/summary$/],
  ['GET', /^\/iserver\/account\/orders$/],
  ['GET', /^\/iserver\/account\/pnl\/partitioned$/],
];
function ib(method, p) {
  if (!IB_LOCAL) return Promise.reject(new Error('IBKR gateway must run on this computer'));
  if (!IB_READONLY.some(([m, re]) => m === method && re.test(p))) return Promise.reject(new Error('Blocked: not a read-only IBKR request'));
  return new Promise((resolve, reject) => {
    const secure = IB_URL.protocol === 'https:';
    const req = (secure ? require('https') : http).request({
      hostname: IB_URL.hostname, port: IB_URL.port || (secure ? 443 : 80), path: '/v1/api' + p, method, rejectUnauthorized: false, timeout: 8000,
      headers: { 'User-Agent': 'Investerview', Accept: 'application/json', ...(method === 'POST' ? { 'Content-Length': 0 } : {}) },
    }, (res) => {
      let body = ''; res.setEncoding('utf8');
      res.on('data', (c) => { if (body.length < 5e6) body += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(body); } catch { /* login page or empty */ } resolve({ status: res.statusCode, json }); });
    });
    req.on('timeout', () => req.destroy(new Error('IBKR gateway timed out')));
    req.on('error', reject);
    req.end();
  });
}
// IBKR listing exchange -> Yahoo suffix, so a position can be opened on the chart
const IB_EXCH = { SEHK: '.HK', TSEJ: '.T', LSE: '.L', LSEETF: '.L', IBIS: '.DE', IBIS2: '.DE', FWB: '.F', TSE: '.TO', VENTURE: '.V', ASX: '.AX', SGX: '.SI', SBF: '.PA', AEB: '.AS', BVME: '.MI', BM: '.MC', EBS: '.SW', SFB: '.ST', KSE: '.KS', NSE: '.NS', TWSE: '.TW', SEHKNTL: '.SS', SEHKSZSE: '.SZ' };
function ibChartSymbol(assetClass, ticker, exchange) {
  let s = String(ticker || '').trim().toUpperCase();
  if (!s) return null;
  if (assetClass === 'CRYPTO') return cleanSymbol(s.split(/[.\s]/)[0] + '-USD');
  if (assetClass === 'CASH') return cleanSymbol(s.replace(/[.\s/]/g, '') + '=X');
  if (assetClass !== 'STK') return null; // options, futures, bonds: no chart mapping
  const ex = String(exchange || '').split('.')[0].toUpperCase();
  s = s.replace(/\.$/, '').replace(/[.\s]/g, '-');
  if (IB_EXCH[ex]) { if (ex === 'SEHK' && /^\d+$/.test(s)) s = s.padStart(4, '0'); return cleanSymbol(s + IB_EXCH[ex]); }
  return cleanSymbol(s);
}
const amount = (summary, key) => { const v = summary && summary[key]; return v && isNum(v.amount) ? v.amount : null; };
const WORKING = /^(submitted|presubmitted|pendingsubmit|pendingcancel)$/i;
function ibkrSnapshot(wantAccount) {
  return cached('ibkr|' + wantAccount, 5000, async () => {
    if (!IB_LOCAL) return { state: 'off' };
    let accts;
    try { accts = await ib('GET', '/portfolio/accounts'); } catch { return { state: 'unreachable' }; }
    const list = Array.isArray(accts.json) ? accts.json.filter((a) => a && (a.accountId || a.id)) : [];
    if (!list.length) return { state: 'login' };
    const acct = list.find((a) => (a.accountId || a.id) === wantAccount) || list[0];
    const id = String(acct.accountId || acct.id);
    if (!/^[A-Za-z0-9]{1,20}$/.test(id)) return { state: 'login' };
    const out = {
      state: 'ok', brokerage: false, accounts: list.map((a) => String(a.accountId || a.id)),
      account: { id, alias: acct.accountAlias || null, currency: acct.currency || '', paper: acct.type === 'DEMO' || /^D/i.test(id) },
      summary: {}, positions: [], orders: [],
    };
    try { const tk = await ib('POST', '/tickle'); out.brokerage = !!(tk.json && tk.json.iserver && tk.json.iserver.authStatus && tk.json.iserver.authStatus.authenticated); } catch { /* keep false */ }
    for (let page = 0; page < 5; page++) { // 100 positions per page
      const r = await ib('GET', `/portfolio/${id}/positions/${page}`);
      const rows = Array.isArray(r.json) ? r.json : [];
      for (const p of rows) {
        if (!p || !isNum(p.position) || p.position === 0) continue;
        const ticker = p.ticker || String(p.contractDesc || '').split(' ')[0];
        out.positions.push({
          conid: p.conid, symbol: ticker, desc: p.contractDesc || ticker, name: p.name || '', assetClass: p.assetClass || '', currency: p.currency || '',
          qty: p.position, avgPrice: isNum(p.avgPrice) ? p.avgPrice : null, mktPrice: isNum(p.mktPrice) ? p.mktPrice : null,
          mktValue: isNum(p.mktValue) ? p.mktValue : null, unrealizedPnl: isNum(p.unrealizedPnl) ? p.unrealizedPnl : null,
          chart: ibChartSymbol(p.assetClass, ticker, p.listingExchange),
        });
      }
      if (rows.length < 100) break;
    }
    try {
      const s = (await ib('GET', `/portfolio/${id}/summary`)).json;
      out.summary = { netLiq: amount(s, 'netliquidation'), cash: amount(s, 'totalcashvalue'), buyingPower: amount(s, 'buyingpower'), unrealizedPnl: amount(s, 'unrealizedpnl'), dayPnl: null };
    } catch { /* summary is optional */ }
    if (out.brokerage) { // these two need an active trading session; this app never starts one
      try {
        const o = (await ib('GET', '/iserver/account/orders')).json;
        for (const x of (o && Array.isArray(o.orders) ? o.orders : [])) {
          if (!WORKING.test(String(x.status || ''))) continue;
          if (x.acct && x.acct !== id) continue;
          const price = Number(x.price);
          out.orders.push({ id: x.orderId, symbol: x.ticker || x.description1 || '', side: String(x.side || '').toUpperCase(), type: x.orderType || '', desc: x.orderDesc || '',
            status: x.status, remaining: x.remainingQuantity, filled: x.filledQuantity, price: isFinite(price) && price > 0 ? price : null, tif: x.timeInForce || '',
            chart: ibChartSymbol(x.secType || 'STK', x.ticker, x.listingExchange) });
        }
      } catch { /* optional */ }
      try {
        const u = (await ib('GET', '/iserver/account/pnl/partitioned')).json;
        const row = u && u.upnl && (u.upnl[id + '.Core'] || Object.values(u.upnl)[0]);
        if (row) { if (isNum(row.dpl)) out.summary.dayPnl = row.dpl; if (isNum(row.upl)) out.summary.unrealizedPnl = row.upl; if (out.summary.netLiq == null && isNum(row.nl)) out.summary.netLiq = row.nl; }
      } catch { /* optional */ }
    }
    return out;
  });
}

// ---- MCP server (run with --mcp) --------------------------------------------
// Speaks the Model Context Protocol over stdin/stdout so an AI app can read market
// data, run screens and read the saved watchlist and drawings. Read-only.
const VERSION = '1.3.0';
const TF = { '1m': ['1m', '5d'], '5m': ['5m', '1mo'], '15m': ['15m', '1mo'], '1h': ['60m', '6mo'], '1D': ['1d', '5y'], '1W': ['1wk', '10y'], '1M': ['1mo', 'max'] };
const UNIVERSES = {
  us_large_caps: 'AAPL MSFT NVDA GOOGL AMZN META TSLA AVGO BRK-B LLY JPM V UNH XOM MA COST HD PG JNJ WMT NFLX ABBV BAC CRM ORCL KO CVX MRK AMD PEP ADBE TMO LIN CSCO ACN MCD ABT WFC IBM GE QCOM DIS INTC CAT VZ TXN PFE UBER BA',
  etfs: 'SPY QQQ IWM DIA VTI EFA EEM XLK XLF XLE XLV XLY XLP XLI XLU XLB XLRE XLC GLD SLV TLT HYG ARKK SMH',
  crypto: 'BTC-USD ETH-USD SOL-USD BNB-USD XRP-USD ADA-USD DOGE-USD AVAX-USD LINK-USD DOT-USD LTC-USD BCH-USD TRX-USD ATOM-USD',
  fx_commodities: 'EURUSD=X GBPUSD=X USDJPY=X AUDUSD=X USDCAD=X USDCHF=X NZDUSD=X GC=F SI=F CL=F NG=F HG=F',
  japan_large_caps: '7203.T 6758.T 9984.T 8306.T 6861.T 9983.T 8035.T 6501.T 7974.T 9432.T 6098.T 4063.T 8058.T 7267.T 6367.T 4502.T 8316.T 6902.T 8001.T 9433.T 7741.T 6954.T 4568.T 8031.T 6273.T',
};
const num = (v) => (v == null || !isFinite(v) ? null : Math.abs(v) < 1 ? +v.toFixed(5) : +v.toFixed(2));
// bar times are exchange-local, stored as if UTC
const fmtTime = (t, intraday) => { const s = new Date(t * 1000).toISOString(); return intraday ? s.slice(0, 16).replace('T', ' ') : s.slice(0, 10); };
const needSymbol = (s) => { const c = cleanSymbol(s); if (!c) throw new Error(`Invalid symbol: ${s}`); return c; };
const needTf = (tf) => { if (!TF[tf]) throw new Error(`Invalid timeframe: ${tf}. Use one of ${Object.keys(TF).join(', ')}`); return TF[tf]; };
function emaSeries(v, p) {
  const o = new Array(v.length).fill(null);
  if (v.length < p) return o;
  const k = 2 / (p + 1); let e = mean(v.slice(0, p)); o[p - 1] = e;
  for (let i = p; i < v.length; i++) { e = v[i] * k + e * (1 - k); o[i] = e; }
  return o;
}
function quoteRow(m) {
  const q = {
    symbol: m.symbol, name: m.name, type: m.type, currency: m.currency,
    last: num(m.last), change: num(m.chgAbs), change_pct: num(m.chg),
    volume: m.volume, relative_volume: num(m.relVol), rsi14: num(m.rsi), sma50: num(m.sma50), sma200: num(m.sma200),
    vs_sma50_pct: num(m.vs50), vs_sma200_pct: num(m.vs200), from_52w_high_pct: num(m.fromHigh), from_52w_low_pct: num(m.fromLow),
    perf_1w_pct: num(m.w1), perf_1m_pct: num(m.m1), perf_3m_pct: num(m.m3),
  };
  if (m.extPrice != null) { q.extended_hours_price = num(m.extPrice); q.extended_hours_change_pct = num(m.extChg); }
  return q;
}
async function quotes(symbols) {
  const r = await screen(symbols, true);
  return { rows: r.rows.map(quoteRow), no_data: r.errors.map((e) => e.symbol) };
}
const DRAWING_NAMES = { trend: 'trend_line', hline: 'horizontal_line', vline: 'vertical_line', rect: 'rectangle', fib: 'fibonacci_retracement', measure: 'measurement' };
function describeDrawing(d) {
  const type = DRAWING_NAMES[d.type] || d.type;
  if (d.type === 'hline') return { type, price: num(d.a.price) };
  if (d.type === 'vline') return { type, time: fmtTime(d.a.time, true) };
  const o = { type, from: { time: fmtTime(d.a.time, true), price: num(d.a.price) }, to: { time: fmtTime(d.b.time, true), price: num(d.b.price) } };
  if (d.type === 'fib') o.levels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1].map((f) => ({ pct: +(f * 100).toFixed(1), price: num(d.b.price + (d.a.price - d.b.price) * f) }));
  return o;
}
const NO_STATE = 'No saved data yet. Open the Investerview app once (version 1.2.0 or later) so it can save the watchlist and drawings to disk.';
const symProp = { type: 'string', description: 'Ticker in Yahoo Finance format, e.g. AAPL, BRK-B, 7203.T, 0700.HK, ^GSPC, BTC-USD, EURUSD=X, ES=F' };
const tfProp = { type: 'string', enum: Object.keys(TF), description: 'Bar size. Default 1D.' };

const MCP_TOOLS = [
  {
    name: 'search_symbols',
    description: 'Find ticker symbols by company name or partial ticker.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    run: async (a) => search(String(a.query || '').trim().slice(0, 40)),
  },
  {
    name: 'get_quote',
    description: 'Latest price, daily change, volume, RSI, moving averages, 52-week position and recent performance for up to 25 symbols. Includes the extended-hours price for US stocks when one exists. Prices may be delayed.',
    inputSchema: { type: 'object', properties: { symbols: { type: 'array', items: symProp, minItems: 1, maxItems: 25 } }, required: ['symbols'] },
    run: async (a) => quotes([...new Set((Array.isArray(a.symbols) ? a.symbols : [a.symbols]).map(needSymbol))].slice(0, 25)),
  },
  {
    name: 'get_price_history',
    description: 'OHLCV bars for one symbol, oldest first. Times are in the exchange\'s local time.',
    inputSchema: { type: 'object', properties: { symbol: symProp, timeframe: tfProp, limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Most recent bars to return. Default 100.' }, extended_hours: { type: 'boolean', description: 'Include pre-market and after-hours bars (intraday timeframes, US stocks and ETFs).' } }, required: ['symbol'] },
    run: async (a) => {
      const tfName = a.timeframe || '1D', [interval, range] = needTf(tfName), intraday = interval.endsWith('m');
      const d = await candles(needSymbol(a.symbol), interval, range, !!a.extended_hours);
      const limit = Math.min(500, Math.max(1, Math.floor(a.limit) || 100));
      return {
        symbol: d.symbol, name: d.name, currency: d.currency, exchange: d.exchange, timeframe: tfName,
        bars: d.bars.slice(-limit).map((b) => ({ time: fmtTime(b.time, intraday), open: num(b.open), high: num(b.high), low: num(b.low), close: num(b.close), volume: b.volume, ...(b.x ? { session: 'extended' } : {}) })),
      };
    },
  },
  {
    name: 'get_technicals',
    description: 'Current indicator values for one symbol: SMA 20/50/200, EMA 20, RSI 14, MACD (12, 26, 9) and Bollinger Bands (20, 2).',
    inputSchema: { type: 'object', properties: { symbol: symProp, timeframe: tfProp }, required: ['symbol'] },
    run: async (a) => {
      const tfName = a.timeframe || '1D', [interval, range] = needTf(tfName);
      const d = await candles(needSymbol(a.symbol), interval, range);
      const c = d.bars.map((b) => b.close), n = c.length;
      if (n < 2) throw new Error('Not enough history');
      const e12 = emaSeries(c, 12), e26 = emaSeries(c, 26), line = [];
      for (let i = 25; i < n; i++) line.push(e12[i] - e26[i]);
      const macdLine = line.length ? line[line.length - 1] : null, sig = emaSeries(line, 9), signal = sig.length ? sig[sig.length - 1] : null;
      let bb = null;
      if (n >= 20) { const w = c.slice(-20), mid = mean(w), sd = Math.sqrt(mean(w.map((x) => (x - mid) ** 2))); bb = { upper: num(mid + 2 * sd), middle: num(mid), lower: num(mid - 2 * sd) }; }
      return {
        symbol: d.symbol, name: d.name, timeframe: tfName, as_of: fmtTime(d.bars[n - 1].time, interval.endsWith('m')), close: num(c[n - 1]),
        sma20: num(lastSma(c, 20)), sma50: num(lastSma(c, 50)), sma200: num(lastSma(c, 200)), ema20: num(emaSeries(c, 20)[n - 1]), rsi14: num(lastRsi(c)),
        macd: { line: num(macdLine), signal: num(signal), histogram: macdLine != null && signal != null ? num(macdLine - signal) : null }, bollinger: bb,
      };
    },
  },
  {
    name: 'run_screener',
    description: 'Scan a list of symbols on daily data and return those passing the filters. Give either a built-in universe or your own symbols.',
    inputSchema: {
      type: 'object',
      properties: {
        universe: { type: 'string', enum: [...Object.keys(UNIVERSES), 'watchlist'], description: 'Built-in list to scan. "watchlist" is the user\'s saved watchlist. Default us_large_caps.' },
        symbols: { type: 'array', items: symProp, maxItems: 120, description: 'Custom list to scan instead of a universe.' },
        price_min: { type: 'number' }, price_max: { type: 'number' },
        change_pct_min: { type: 'number' }, change_pct_max: { type: 'number' },
        rsi_min: { type: 'number' }, rsi_max: { type: 'number' },
        relative_volume_min: { type: 'number', description: 'Today\'s volume divided by the 20-day average.' },
        within_pct_of_52w_high: { type: 'number', description: 'E.g. 3 keeps symbols within 3% of their 52-week high.' },
        above_sma50: { type: 'boolean' }, above_sma200: { type: 'boolean' },
        sort_by: { type: 'string', enum: ['change_pct', 'rsi14', 'relative_volume', 'from_52w_high_pct', 'perf_1w_pct', 'perf_1m_pct', 'perf_3m_pct'], description: 'Default change_pct.' },
        descending: { type: 'boolean', description: 'Default true.' },
        limit: { type: 'integer', minimum: 1, maximum: 120, description: 'Default 25.' },
      },
    },
    run: async (a) => {
      let symbols;
      if (Array.isArray(a.symbols) && a.symbols.length) symbols = a.symbols.map(needSymbol);
      else if (a.universe === 'watchlist') { const s = readState(); if (!s || !s.watch) throw new Error(NO_STATE); symbols = s.watch.filter((x) => x[0] !== '#').map(cleanSymbol).filter(Boolean); }
      else { const u = UNIVERSES[a.universe || 'us_large_caps']; if (!u) throw new Error(`Unknown universe: ${a.universe}`); symbols = u.split(' '); }
      const r = await quotes([...new Set(symbols)].slice(0, 120));
      const ge = (v, min) => min == null || (v != null && v >= min), le = (v, max) => max == null || (v != null && v <= max);
      const key = a.sort_by || 'change_pct', dir = a.descending === false ? 1 : -1;
      const matches = r.rows.filter((q) => ge(q.last, a.price_min) && le(q.last, a.price_max) && ge(q.change_pct, a.change_pct_min) && le(q.change_pct, a.change_pct_max)
        && ge(q.rsi14, a.rsi_min) && le(q.rsi14, a.rsi_max) && ge(q.relative_volume, a.relative_volume_min)
        && (a.within_pct_of_52w_high == null || (q.from_52w_high_pct != null && q.from_52w_high_pct >= -a.within_pct_of_52w_high))
        && (!a.above_sma50 || q.vs_sma50_pct > 0) && (!a.above_sma200 || q.vs_sma200_pct > 0))
        .sort((x, y) => (x[key] == null ? 1 : y[key] == null ? -1 : (x[key] - y[key]) * dir));
      return { scanned: r.rows.length, matched: matches.length, no_data: r.no_data, results: matches.slice(0, Math.min(120, Math.max(1, Math.floor(a.limit) || 25))) };
    },
  },
  {
    name: 'get_watchlist',
    description: 'The user\'s saved watchlist from the Investerview app, grouped by their sections, with a current quote for each symbol.',
    inputSchema: { type: 'object', properties: { include_quotes: { type: 'boolean', description: 'Default true. Set false for just the symbols.' } } },
    run: async (a) => {
      const s = readState();
      if (!s || !Array.isArray(s.watch)) throw new Error(NO_STATE);
      const sections = [{ section: null, symbols: [] }];
      for (const x of s.watch) { if (x[0] === '#') sections.push({ section: x.slice(1), symbols: [] }); else sections[sections.length - 1].symbols.push(x); }
      const out = { saved_at: new Date(s.updated || 0).toISOString(), sections: sections.filter((g) => g.section !== null || g.symbols.length) };
      if (a.include_quotes === false) return out;
      const r = await quotes(s.watch.filter((x) => x[0] !== '#').map(cleanSymbol).filter(Boolean));
      const by = new Map(r.rows.map((q) => [q.symbol, q]));
      for (const g of out.sections) g.symbols = g.symbols.map((sym) => by.get(sym) || { symbol: sym, no_data: true });
      return out;
    },
  },
  {
    name: 'get_drawings',
    description: 'Chart drawings the user saved in the Investerview app: trend lines, horizontal price levels, rectangles and Fibonacci retracements (with their level prices). Omit symbol to list every symbol that has drawings.',
    inputSchema: { type: 'object', properties: { symbol: symProp } },
    run: async (a) => {
      const s = readState();
      if (!s) throw new Error(NO_STATE);
      const all = s.drawings || {};
      const pick = a.symbol ? { [needSymbol(a.symbol)]: all[needSymbol(a.symbol)] || [] } : all;
      return Object.entries(pick).map(([symbol, list]) => ({ symbol, drawings: list.map(describeDrawing) }));
    },
  },
];
const MCP_PROMPTS = [{
  name: 'watchlist_report',
  description: 'Write a market report on the saved Investerview watchlist.',
  text: 'Write a market report on my Investerview watchlist.\n\n1. Call get_watchlist for my sections and current quotes.\n2. For the three biggest movers (by absolute change_pct), call get_technicals.\n3. Call get_drawings and note any symbol trading within 2% of a level I saved.\n\nStructure the report as: a short overall summary; one paragraph per watchlist section; notable technical readings (RSI above 70 or below 30, price crossing its 50- or 200-day average, unusual relative volume); and levels to watch. Give figures with each claim. End by noting that prices may be delayed and that this is a summary of data, not investment advice.',
}];

function startMcp() {
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
  const handle = async (m) => {
    if (!m || typeof m !== 'object') return;
    const { id, method } = m, params = m.params || {};
    const reply = (result) => { if (id !== undefined) out({ jsonrpc: '2.0', id, result }); };
    const fail = (code, message) => { if (id !== undefined) out({ jsonrpc: '2.0', id, error: { code, message } }); };
    try {
      if (method === 'initialize') {
        return reply({ protocolVersion: PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOLS[0], capabilities: { tools: {}, prompts: {} },
          serverInfo: { name: 'investerview', version: VERSION }, instructions: 'Read-only market data, screening and the user\'s saved watchlist and chart drawings from the Investerview app. Data comes from Yahoo Finance and may be delayed. Nothing here places trades.' });
      }
      if (method === 'ping') return reply({});
      if (method === 'tools/list') return reply({ tools: MCP_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema, annotations: { readOnlyHint: true } })) });
      if (method === 'tools/call') {
        const tool = MCP_TOOLS.find((x) => x.name === params.name);
        if (!tool) return fail(-32602, `Unknown tool: ${params.name}`);
        try { return reply({ content: [{ type: 'text', text: JSON.stringify(await tool.run(params.arguments || {})) }] }); }
        catch (e) { return reply({ content: [{ type: 'text', text: 'Error: ' + (e.message || 'failed') }], isError: true }); }
      }
      if (method === 'prompts/list') return reply({ prompts: MCP_PROMPTS.map(({ name, description }) => ({ name, description })) });
      if (method === 'prompts/get') {
        const p = MCP_PROMPTS.find((x) => x.name === params.name);
        if (!p) return fail(-32602, `Unknown prompt: ${params.name}`);
        return reply({ description: p.description, messages: [{ role: 'user', content: { type: 'text', text: p.text } }] });
      }
      if (typeof method === 'string' && method.startsWith('notifications/')) return;
      fail(-32601, `Method not found: ${method}`);
    } catch (e) { fail(-32603, e.message || 'Internal error'); }
  };
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    for (let i; (i = buf.indexOf('\n')) >= 0;) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { out({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
      for (const one of Array.isArray(m) ? m : [m]) handle(one);
    }
  });
  process.stdin.on('end', () => process.exit(0));
  console.error(`Investerview MCP server ${VERSION} ready (data file: ${DATA_FILE})`);
}

let sea = null; // set when running as a packaged single-file executable
try { const s = require('node:sea'); if (s.isSea()) sea = s; } catch { /* plain node */ }

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await handleApi(url, req, res);
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
if (process.argv.includes('--mcp')) startMcp(); // AI-tool mode: no web server, talk MCP on stdin/stdout
else server.listen(PORT, '127.0.0.1', () => {
  console.log(`ChartDesk running at ${URL_LOCAL}`);
  if (sea) console.log('Keep this window open while you use the app. Close it to stop.');
  openBrowser();
});
