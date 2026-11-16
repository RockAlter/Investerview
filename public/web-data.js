// Data layer for the web version (GitHub Pages), where there is no local server.
// It answers the same /api/... paths the local server does, so app.js works unchanged.
// A web page may only call services that allow it, so prices come from, in this order:
//   crypto:          Binance, then Coinbase (both allow web pages), then the sources below
//   everything else: 1. the Investerview data proxy (worker/worker.js, a Cloudflare Worker that
//                       asks Yahoo Finance, then Nasdaq, then Tencent on the page's behalf)
//                    2. Tencent Finance directly (daily, weekly and monthly bars; US, Hong Kong
//                       and China stocks and the main indices)
//                    3. Yahoo Finance through the public AllOrigins proxy (everything, but slow
//                       and not always up)
// A source that fails is skipped for two minutes, so the page switches over by itself.
(() => {
'use strict';
const VERSION = '1.9.0'; // keep in step with server.js and package.json
const DOWNLOAD = 'https://github.com/RockAlter/Investerview/releases/latest';
// Address of the deployed data proxy (see worker/README.md). Empty = not deployed yet: the page
// then uses Tencent and AllOrigins only. For testing, ?proxy=http://localhost:8787 overrides it.
const PROXY_URL = 'https://investerview-data.investerview-data.workers.dev';
const PROXY = (new URLSearchParams(location.search).get('proxy') || PROXY_URL).replace(/\/+$/, '');
const tr = (k, ...a) => (window.I18N ? window.I18N.t(k, ...a) : k);
const NAMES = {
  BTC: 'Bitcoin', ETH: 'Ethereum', SOL: 'Solana', BNB: 'BNB', XRP: 'XRP', ADA: 'Cardano', DOGE: 'Dogecoin', AVAX: 'Avalanche', LINK: 'Chainlink', DOT: 'Polkadot',
  LTC: 'Litecoin', BCH: 'Bitcoin Cash', TRX: 'TRON', ATOM: 'Cosmos', UNI: 'Uniswap', NEAR: 'NEAR Protocol', APT: 'Aptos', ARB: 'Arbitrum', OP: 'Optimism', SUI: 'Sui',
  FIL: 'Filecoin', ETC: 'Ethereum Classic', XLM: 'Stellar', HBAR: 'Hedera', ICP: 'Internet Computer', AAVE: 'Aave', INJ: 'Injective', SHIB: 'Shiba Inu', PEPE: 'Pepe', TON: 'Toncoin',
  ALGO: 'Algorand', VET: 'VeChain', SAND: 'The Sandbox', MANA: 'Decentraland', GRT: 'The Graph', MKR: 'Maker', CRV: 'Curve', XTZ: 'Tezos', EOS: 'EOS', ZEC: 'Zcash',
};
const CRYPTO_RE = /^([A-Z0-9]{2,10})-USD$/;
const SYMBOL_RE = /^[A-Z0-9.\-=^]{1,20}$/;
const US_RE = /^[A-Z]{1,5}(-[A-Z]{1,2})?$/;
const STEP = { '1m': 60, '5m': 300, '15m': 900, '60m': 3600 };
const BN_IV = { '1m': '1m', '5m': '5m', '15m': '15m', '60m': '1h', '1d': '1d', '1wk': '1w', '1mo': '1M' };
const RANGE_DAYS = { '1d': 1, '5d': 5, '1mo': 31, '3mo': 92, '6mo': 183, '1y': 366, '2y': 731, '5y': 1827, '10y': 3653 };

const cache = new Map();
function cached(key, ttl, fn) {
  const hit = cache.get(key), now = Date.now();
  if (hit && hit.exp > now) return hit.p;
  const p = fn();
  cache.set(key, { exp: now + ttl, p });
  p.catch(() => cache.delete(key));
  return p;
}
// "this source is unavailable" (try the next one), as opposed to "this source answered: no such symbol"
const down = (msg) => Object.assign(new Error(msg), { unavailable: true });
async function getJson(url, ms = 10000) {
  let r;
  try { r = await fetch(url, { signal: AbortSignal.timeout(ms) }); } catch (e) { throw down(e.name === 'TimeoutError' ? 'timed out' : 'unreachable'); }
  if (!r.ok) throw down('HTTP ' + r.status);
  try { return await r.json(); } catch { throw down('not JSON'); }
}
const weekStart = (t) => t - ((new Date(t * 1000).getUTCDay() + 6) % 7) * 86400;
const monthStart = (t) => { const d = new Date(t * 1000); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000; };
function regroup(bars, interval) { // daily bars -> weekly or monthly
  if (interval === '1d') return bars;
  const key = interval === '1wk' ? weekStart : monthStart, out = [];
  for (const b of bars) {
    const t = key(b.time), last = out[out.length - 1];
    if (last && last.time === t) { last.high = Math.max(last.high, b.high); last.low = Math.min(last.low, b.low); last.close = b.close; last.volume += b.volume; }
    else out.push({ ...b, time: t });
  }
  return out;
}
function trim(bars, range) {
  const days = RANGE_DAYS[range];
  if (!days) return bars;
  const cutoff = Date.now() / 1000 - (days + 1) * 86400, cut = bars.filter((b) => b.time >= cutoff);
  return cut.length ? cut : bars;
}

// ---- crypto: straight from the exchanges --------------------------------------
async function binance(base, interval, range) {
  const days = RANGE_DAYS[range] || 0;
  const need = days ? Math.ceil(days * 86400 / (STEP[interval] || { '1d': 86400, '1wk': 604800, '1mo': 2592000 }[interval])) : 3000, rows = [];
  let end = '';
  for (let page = 0; page < 3 && rows.length < need; page++) { // 1000 bars a page, newest first
    const j = await getJson(`https://data-api.binance.vision/api/v3/klines?symbol=${base}USDT&interval=${BN_IV[interval]}&limit=1000${end}`);
    if (!Array.isArray(j) || !j.length) break;
    rows.unshift(...j);
    if (j.length < 1000) break;
    end = '&endTime=' + (j[0][0] - 1);
  }
  return rows.map((k) => ({ time: k[0] / 1000, open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
}
async function coinbase(base, interval) {
  const j = await getJson(`https://api.exchange.coinbase.com/products/${base}-USD/candles?granularity=${STEP[interval] || 86400}`);
  if (!Array.isArray(j)) return [];
  const bars = j.map((k) => ({ time: k[0], open: k[3], high: k[2], low: k[1], close: k[4], volume: k[5] })).sort((a, b) => a.time - b.time);
  return STEP[interval] ? bars : regroup(bars, interval);
}
async function cryptoCandles(symbol, interval, range) {
  const base = CRYPTO_RE.exec(symbol)[1];
  for (const [source, fn] of [['Binance', binance], ['Coinbase', coinbase]]) {
    let bars = [];
    try { bars = await fn(base, interval, range); } catch { bars = []; }
    if (!bars.length) continue;
    bars = trim(bars, range);
    return { symbol, name: NAMES[base] ? NAMES[base] + ' USD' : symbol, currency: 'USD', exchange: source, type: 'CRYPTOCURRENCY', price: bars[bars.length - 1].close, bars, source };
  }
  return null; // let the general sources try (Yahoo has most coins too)
}

// ---- everything else -------------------------------------------------------------
// Each source returns the candles object, or null when it does not cover this symbol/timeframe.
// It throws down(...) when it cannot be reached, or a plain Error for a real "no such symbol" answer.
async function viaProxy(symbol, interval, range, ext) {
  let r;
  try { r = await fetch(`${PROXY}/candles?symbol=${encodeURIComponent(symbol)}&interval=${interval}&range=${range}${ext ? '&ext=1' : ''}`, { signal: AbortSignal.timeout(15000) }); }
  catch { throw down('data proxy unreachable'); }
  const j = await r.json().catch(() => ({}));
  if (r.ok && j.bars) return j;
  if (r.status === 404) throw new Error(j.error || 'No data for ' + symbol);
  if (r.status === 503) return null; // the proxy works, but none of its sources has this right now: try ours
  throw down('data proxy returned ' + r.status);
}

const TC_INDEX = { '^GSPC': 'us.INX', '^DJI': 'us.DJI', '^IXIC': 'us.IXIC', '^NDX': 'us.NDX', '^HSI': 'hkHSI' };
async function tencentCode(symbol) {
  if (TC_INDEX[symbol]) return TC_INDEX[symbol];
  let m;
  if ((m = /^(\d{1,5})\.HK$/.exec(symbol))) return 'hk' + m[1].padStart(5, '0');
  if ((m = /^(\d{6})\.(SS|SZ)$/.exec(symbol))) return (m[2] === 'SS' ? 'sh' : 'sz') + m[1];
  if (!US_RE.test(symbol)) return null;
  return cached('tc|' + symbol, 86400e3, async () => { // US codes need their exchange suffix (AAPL.OQ, IBM.N, SPY.AM)
    const sym = symbol.replace('-', '.');
    let r;
    try { r = await fetch('https://qt.gtimg.cn/q=us' + sym, { signal: AbortSignal.timeout(8000) }); } catch { throw down('Tencent unreachable'); }
    if (!r.ok) throw down('Tencent returned ' + r.status);
    const text = new TextDecoder().decode(await r.arrayBuffer()); // GBK, but the part we need is plain ASCII
    const esc = sym.replace(/\./g, '\\.'); // look for the code with its suffix first: the name field can equal the bare symbol (IBM)
    const hit = new RegExp('~(' + esc + '\\.[A-Z]{1,2})~').exec(text) || new RegExp('~(' + esc + ')~').exec(text);
    return hit ? 'us' + hit[1] : null;
  });
}
async function tencent(symbol, interval, range) {
  if (STEP[interval]) return null; // no intraday bars for these markets
  const code = await tencentCode(symbol);
  if (!code) return null;
  const days = RANGE_DAYS[range] || 0, period = { '1d': 'day', '1wk': 'week', '1mo': 'month' }[interval];
  const count = interval === '1d' ? Math.min(2000, days ? Math.ceil(days * 0.75) + 10 : 2000) : 640;
  const j = await getJson(`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${code},${period},,,${count},qfq`);
  const d = j && j.data && j.data[code], key = d && Object.keys(d).find((k) => k.endsWith(period));
  const rows = key ? d[key] : [];
  if (!Array.isArray(rows) || rows.length < 3) return null; // an unknown code comes back as one or two stray rows
  const stamp = interval === '1wk' ? weekStart : interval === '1mo' ? monthStart : (t) => t;
  const dayTime = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 1000;
  let bars = rows.map((k) => ({ time: stamp(dayTime(k[0])), open: +k[1], close: +k[2], high: +k[3], low: +k[4], volume: +k[5] || 0 }))
    .filter((b) => b.open > 0 && b.high > 0 && b.low > 0 && b.close > 0);
  bars = trim(bars, range);
  if (!bars.length) return null;
  const market = code.slice(0, 2);
  return {
    symbol, name: symbol, exchange: '', bars, price: bars[bars.length - 1].close, source: 'Tencent',
    type: code.startsWith('us.') || code === 'hkHSI' ? 'INDEX' : 'EQUITY',
    currency: market === 'hk' ? 'HKD' : market === 'sh' || market === 'sz' ? 'CNY' : 'USD',
  };
}

const ALLORIGINS = 'https://api.allorigins.win/raw?url=';
async function yahooViaAllOrigins(symbol, interval, range, ext) {
  ext = ext && !!STEP[interval];
  const yq = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}${ext ? '&includePrePost=true' : ''}`;
  let r;
  try { r = await fetch(ALLORIGINS + encodeURIComponent(yq), { signal: AbortSignal.timeout(15000) }); } catch { throw down('AllOrigins unreachable'); }
  const j = await r.json().catch(() => null);
  const err = j && j.chart && j.chart.error;
  if (err) throw new Error(err.description || 'No data for ' + symbol);
  if (!r.ok || !j) throw down('AllOrigins returned ' + r.status);
  return parseYahoo(j, symbol, interval, ext, 'Yahoo Finance');
}
function parseYahoo(j, symbol, interval, ext, source) { // the same shape server.js builds
  const res = j.chart && j.chart.result && j.chart.result[0];
  if (!res) throw new Error('No data for ' + symbol);
  const intraday = !!STEP[interval], m = res.meta || {}, ts = res.timestamp || [];
  const q = (res.indicators && res.indicators.quote && res.indicators.quote[0]) || {};
  const off = m.gmtoffset || 0, reg = m.currentTradingPeriod && m.currentTradingPeriod.regular;
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
    symbol, name: m.shortName || m.longName || symbol, currency: m.currency || '', exchange: m.fullExchangeName || m.exchangeName || '',
    type: m.instrumentType || '', price: m.regularMarketPrice != null ? m.regularMarketPrice : (bars.length ? bars[bars.length - 1].close : null), bars, source,
  };
}

const SOURCES = [
  { name: 'Data proxy', fn: viaProxy, on: () => !!PROXY },
  { name: 'Tencent', fn: tencent, on: () => true },
  { name: 'AllOrigins', fn: yahooViaAllOrigins, on: () => true },
];
for (const s of SOURCES) s.downUntil = 0;
async function generalCandles(symbol, interval, range, ext) {
  for (const src of SOURCES) {
    if (!src.on() || src.downUntil > Date.now()) continue;
    let d;
    try { d = await src.fn(symbol, interval, range, ext); } catch (e) {
      if (!e.unavailable) throw e; // a real answer: no such symbol
      src.downUntil = Date.now() + 120000; // skip it for a while, so a watchlist does not wait on it symbol after symbol
      continue;
    }
    if (d && d.bars && d.bars.length) return d;
  }
  throw new Error(STEP[interval]
    ? tr('Intraday data for {0} is not available right now. Daily, weekly and monthly charts may still work.', symbol)
    : tr('No data source is reachable right now for {0}. Check your connection and try again in a minute.', symbol));
}

function candles(symbol, interval, range, ext) {
  if (!SYMBOL_RE.test(symbol) || !BN_IV[interval]) return Promise.reject(new Error('Bad request'));
  return cached(`c|${symbol}|${interval}|${range}|${ext ? 1 : 0}`, STEP[interval] ? 30000 : 120000, async () => {
    if (CRYPTO_RE.test(symbol)) { const d = await cryptoCandles(symbol, interval, range); if (d) return d; }
    return generalCandles(symbol, interval, range, ext);
  });
}

// the same figures the local server works out for the watchlist and the screener
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const lastSma = (c, p) => (c.length >= p ? mean(c.slice(-p)) : null);
function lastRsi(c, p = 14) {
  if (c.length <= p) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const d = c[i] - c[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= p; l /= p;
  for (let i = p + 1; i < c.length; i++) { const d = c[i] - c[i - 1]; g = (g * (p - 1) + Math.max(d, 0)) / p; l = (l * (p - 1) + Math.max(-d, 0)) / p; }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
const pct = (a, b) => (a != null && b ? (a / b - 1) * 100 : null);
async function metrics(symbol) {
  const d = await candles(symbol, '1d', '1y'), b = d.bars;
  if (b.length < 2) throw new Error('Not enough history');
  const c = b.map((x) => x.close), n = c.length, last = c[n - 1], back = (k) => (n > k ? c[n - 1 - k] : null);
  const vols = b.slice(-21, -1).map((x) => x.volume), avgVol = vols.length ? mean(vols) : 0;
  const sma50 = lastSma(c, 50), sma200 = lastSma(c, 200);
  const [w, mo, q] = d.type === 'CRYPTOCURRENCY' ? [7, 30, 91] : [5, 21, 63]; // crypto trades every day
  return {
    symbol, name: d.name === symbol ? '' : d.name, type: d.type, currency: d.currency,
    last, chg: pct(last, c[n - 2]), chgAbs: last - c[n - 2],
    volume: b[n - 1].volume, relVol: avgVol ? b[n - 1].volume / avgVol : null,
    rsi: lastRsi(c), sma50, sma200, vs50: pct(last, sma50), vs200: pct(last, sma200),
    fromHigh: pct(last, Math.max(...b.map((x) => x.high))), fromLow: pct(last, Math.min(...b.map((x) => x.low))),
    w1: pct(last, back(w)), m1: pct(last, back(mo)), m3: pct(last, back(q)),
    spark: c.slice(-30),
  };
}
async function screen(symbols) {
  const rows = [], errors = [];
  let next = 0;
  const worker = async () => {
    while (next < symbols.length) {
      const s = symbols[next++];
      try { rows.push(await metrics(s)); } catch (e) { errors.push({ symbol: s, error: e.message }); }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  const order = new Map(symbols.map((s, i) => [s, i]));
  rows.sort((a, b) => order.get(a.symbol) - order.get(b.symbol));
  return { rows, errors };
}

function cryptoSearch(q) {
  q = q.trim().toUpperCase();
  return Object.entries(NAMES).filter(([sym, name]) => sym.startsWith(q) || name.toUpperCase().includes(q))
    .sort((a, b) => (b[0] === q) - (a[0] === q) || b[0].startsWith(q) - a[0].startsWith(q)).slice(0, 5)
    .map(([sym, name]) => ({ symbol: sym + '-USD', name, type: 'Crypto', exchange: '' }));
}
async function yahooSearch(q) {
  const tidy = (j) => (j.quotes || []).filter((x) => x.symbol).map((x) => ({ symbol: x.symbol, name: x.shortname || x.longname || '', type: x.typeDisp || '', exchange: x.exchDisp || '' }));
  if (PROXY && SOURCES[0].downUntil <= Date.now()) {
    try { const j = await getJson(`${PROXY}/search?q=${encodeURIComponent(q)}`, 8000); if (Array.isArray(j)) return j; } catch { /* try AllOrigins */ }
  }
  const yq = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0`;
  return tidy(await getJson(ALLORIGINS + encodeURIComponent(yq), 8000));
}
function search(q) {
  q = q.trim();
  return cached('s|' + q.toLowerCase(), 300000, async () => {
    const local = cryptoSearch(q);
    let remote = [];
    try { remote = await yahooSearch(q); } catch { /* the local crypto list still answers */ }
    const seen = new Set(remote.map((x) => x.symbol));
    return [...remote, ...local.filter((x) => !seen.has(x.symbol))].slice(0, 10); // any symbol still works when typed in full
  });
}

async function api(path) {
  const u = new URL(path, 'http://x'), p = u.searchParams;
  const list = () => [...new Set((p.get('symbols') || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean))].slice(0, 120);
  switch (u.pathname) {
    case '/api/version': return { version: VERSION };
    case '/api/candles': return candles((p.get('symbol') || '').toUpperCase(), p.get('interval'), p.get('range'), p.get('ext') === '1');
    case '/api/screen': return screen(list());
    case '/api/search': return search(p.get('q') || '');
    case '/api/state': return {}; // the web version keeps the watchlist and drawings in this browser only
    case '/api/ibkr': return { state: 'off' };
    default: throw new Error('Not available in the web version');
  }
}
// for checking from the browser console: WebData.sources()
const sources = () => SOURCES.map((s) => ({ source: s.name, enabled: s.on(), skippedForSeconds: Math.max(0, Math.round((s.downUntil - Date.now()) / 1000)) }));
window.WebData = { api, DOWNLOAD, PROXY, sources, isCrypto: (s) => CRYPTO_RE.test(s) };
})();
