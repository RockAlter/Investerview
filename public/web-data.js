// Data layer for the web version (GitHub Pages), where there is no local server.
// A web page may only call services that allow it, which among free price sources means the
// crypto exchanges: Binance first, then Coinbase. It answers the same /api/... paths the local
// server does, so app.js works unchanged. Stocks, indices, FX and futures need the desktop app.
(() => {
'use strict';
const VERSION = '1.5.0'; // keep in step with server.js and package.json
const DOWNLOAD = 'https://github.com/RockAlter/Investerview/releases/latest';
const NAMES = {
  BTC: 'Bitcoin', ETH: 'Ethereum', SOL: 'Solana', BNB: 'BNB', XRP: 'XRP', ADA: 'Cardano', DOGE: 'Dogecoin', AVAX: 'Avalanche', LINK: 'Chainlink', DOT: 'Polkadot',
  LTC: 'Litecoin', BCH: 'Bitcoin Cash', TRX: 'TRON', ATOM: 'Cosmos', UNI: 'Uniswap', NEAR: 'NEAR Protocol', APT: 'Aptos', ARB: 'Arbitrum', OP: 'Optimism', SUI: 'Sui',
  FIL: 'Filecoin', ETC: 'Ethereum Classic', XLM: 'Stellar', HBAR: 'Hedera', ICP: 'Internet Computer', AAVE: 'Aave', INJ: 'Injective', SHIB: 'Shiba Inu', PEPE: 'Pepe', TON: 'Toncoin',
  ALGO: 'Algorand', VET: 'VeChain', SAND: 'The Sandbox', MANA: 'Decentraland', GRT: 'The Graph', MKR: 'Maker', CRV: 'Curve', XTZ: 'Tezos', EOS: 'EOS', ZEC: 'Zcash',
};
const CRYPTO_RE = /^([A-Z0-9]{2,10})-USD$/;
const STEP = { '1m': 60, '5m': 300, '15m': 900, '60m': 3600 };
const LONG = { '1d': 86400, '1wk': 604800, '1mo': 2592000 };
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
async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
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
async function binance(base, interval, days) {
  const need = days ? Math.ceil(days * 86400 / (STEP[interval] || LONG[interval])) : 3000, rows = [];
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
function candles(symbol, interval, range) {
  const m = CRYPTO_RE.exec(symbol);
  if (!m) return Promise.reject(new Error('WEB_ONLY'));
  const days = RANGE_DAYS[range] || 0;
  return cached(`c|${symbol}|${interval}|${range}`, STEP[interval] ? 15000 : 60000, async () => {
    let bars = [], source = '';
    for (const [name, fn] of [['Binance', binance], ['Coinbase', coinbase]]) {
      try { bars = await fn(m[1], interval, days); } catch { bars = []; }
      if (bars.length) { source = name; break; }
    }
    if (!bars.length) throw new Error('No data for ' + symbol);
    if (days) { const cutoff = Date.now() / 1000 - (days + 1) * 86400; const cut = bars.filter((b) => b.time >= cutoff); if (cut.length) bars = cut; }
    return { symbol, name: NAMES[m[1]] ? NAMES[m[1]] + ' USD' : symbol, currency: 'USD', exchange: source, type: 'CRYPTOCURRENCY', price: bars[bars.length - 1].close, bars, source };
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
  return {
    symbol, name: d.name === symbol ? '' : d.name, type: d.type, currency: d.currency,
    last, chg: pct(last, c[n - 2]), chgAbs: last - c[n - 2],
    volume: b[n - 1].volume, relVol: avgVol ? b[n - 1].volume / avgVol : null,
    rsi: lastRsi(c), sma50, sma200, vs50: pct(last, sma50), vs200: pct(last, sma200),
    fromHigh: pct(last, Math.max(...b.map((x) => x.high))), fromLow: pct(last, Math.min(...b.map((x) => x.low))),
    w1: pct(last, back(7)), m1: pct(last, back(30)), m3: pct(last, back(91)), // crypto trades every day
    spark: c.slice(-30),
  };
}
async function screen(symbols) {
  const rows = [], errors = [];
  let next = 0;
  const worker = async () => {
    while (next < symbols.length) {
      const s = symbols[next++];
      try { rows.push(await metrics(s)); } catch (e) { errors.push({ symbol: s, error: e.message === 'WEB_ONLY' ? 'Needs the desktop app' : e.message }); }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  const order = new Map(symbols.map((s, i) => [s, i]));
  rows.sort((a, b) => order.get(a.symbol) - order.get(b.symbol));
  return { rows, errors };
}
function search(q) {
  q = q.trim().toUpperCase();
  const hits = Object.entries(NAMES).filter(([sym, name]) => sym.startsWith(q) || name.toUpperCase().includes(q))
    .sort((a, b) => (b[0] === q) - (a[0] === q) || b[0].startsWith(q) - a[0].startsWith(q)).slice(0, 8)
    .map(([sym, name]) => ({ symbol: sym + '-USD', name, type: 'Crypto', exchange: '' }));
  return hits; // a coin not in the list still works when typed in full, e.g. WIF-USD
}

async function api(path) {
  const u = new URL(path, 'http://x'), p = u.searchParams;
  const list = () => [...new Set((p.get('symbols') || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean))].slice(0, 120);
  switch (u.pathname) {
    case '/api/version': return { version: VERSION };
    case '/api/candles': return candles((p.get('symbol') || '').toUpperCase(), p.get('interval'), p.get('range'));
    case '/api/screen': return screen(list());
    case '/api/search': return search(p.get('q') || '');
    case '/api/state': return {}; // the web version keeps the watchlist and drawings in this browser only
    case '/api/ibkr': return { state: 'off' };
    default: throw new Error('Not available in the web version');
  }
}
window.WebData = { api, DOWNLOAD, isCrypto: (s) => CRYPTO_RE.test(s) };
})();
