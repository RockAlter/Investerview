// Investerview data proxy - a Cloudflare Worker for the web version (GitHub Pages).
// A web page cannot call Yahoo Finance and most other stock-data services directly (they do not
// allow requests from other websites), so this small server-side helper does it, the same way the
// desktop app's server.js does. It tries several sources in turn and switches by itself:
//   1. Yahoo Finance - everything: stocks, ETFs, indices, FX, futures, crypto, intraday, search.
//      Four routes (two servers, each with and without a session cookie), as in server.js.
//   2. Nasdaq        - US stocks and ETFs, daily / weekly / monthly.
//   3. Tencent       - US stocks, ETFs and main indices, Hong Kong and China A-shares, daily / weekly / monthly.
// Routes (GET):  /candles?symbol=AAPL&interval=1d&range=1y[&ext=1]   /search?q=apple   /health
// Answers are cached at Cloudflare's edge for a short while, so many viewers cost few upstream calls.
// Which websites may use it: ALLOWED_ORIGINS in wrangler.toml (plus localhost, for testing).

const YH_HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'application/json,text/plain,*/*', 'Accept-Language': 'en-US,en;q=0.9',
};
const INTERVALS = new Set(['1m', '5m', '15m', '60m', '1d', '1wk', '1mo']);
const RANGES = new Set(['1d', '5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'max']);
const SYMBOL_RE = /^[A-Za-z0-9.\-=^]{1,20}$/;
const RANGE_DAYS = { '1d': 1, '5d': 5, '1mo': 31, '3mo': 92, '6mo': 183, '1y': 366, '2y': 731, '5y': 1827, '10y': 3653 };
const STEP = { '1m': 60, '5m': 300, '15m': 900, '60m': 3600 };
const US_RE = /^[A-Z]{1,5}(-[A-Z]{1,2})?$/;
const DEFAULT_ORIGINS = 'https://rockalter.github.io';

// state kept while this Worker instance stays warm
let yhStart = 0, yhBlockedUntil = 0, yhBlockedMsg = '', yhAuth = null;
const downUntil = { Nasdaq: 0, Tencent: 0 };

// "this source is unavailable" (try the next one), as opposed to "this source answered: no such symbol"
const down = (msg) => Object.assign(new Error(msg), { unavailable: true });
const timeout = (ms) => AbortSignal.timeout(ms);
async function getJson(url, ms = 10000) {
  const r = await fetch(url, { headers: HEADERS, signal: timeout(ms) });
  if (!r.ok) throw down('HTTP ' + r.status);
  return r.json();
}

// ---- Yahoo Finance ---------------------------------------------------------
async function yhSession() {
  if (yhAuth && yhAuth.exp > Date.now()) return yhAuth;
  const r = await fetch('https://fc.yahoo.com/', { headers: HEADERS, redirect: 'manual', signal: timeout(8000) });
  const cookie = (r.headers.getSetCookie ? r.headers.getSetCookie() : []).map((c) => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error('no session cookie');
  let crumb = '';
  for (const host of YH_HOSTS) {
    try {
      const c = await fetch(host + '/v1/test/getcrumb', { headers: { ...HEADERS, Cookie: cookie }, signal: timeout(8000) });
      const text = c.ok ? (await c.text()).trim() : '';
      if (text && text.length < 40 && !text.includes('<')) { crumb = text; break; }
    } catch { /* try the other host */ }
  }
  yhAuth = { cookie, crumb, exp: Date.now() + 3600e3 };
  return yhAuth;
}
const YH_STEPS = [[0, false], [1, false], [0, true], [1, true]]; // [host index, use cookie + crumb]
async function yahoo(pathname) {
  if (Date.now() < yhBlockedUntil) throw down(yhBlockedMsg);
  let lastStatus = 0, lastMsg = '', refusedAll = true, netFails = 0;
  for (let k = 0; k < YH_STEPS.length; k++) {
    const step = (yhStart + k) % YH_STEPS.length, [hostI, useAuth] = YH_STEPS[step];
    let r, json = null;
    try {
      let url = YH_HOSTS[hostI] + pathname, headers = HEADERS;
      if (useAuth) {
        const a = await yhSession();
        headers = { ...HEADERS, Cookie: a.cookie };
        if (a.crumb) url += (pathname.includes('?') ? '&' : '?') + 'crumb=' + encodeURIComponent(a.crumb);
      }
      r = await fetch(url, { headers, signal: timeout(10000) });
      try { json = JSON.parse(await r.text()); } catch { /* an error page, not data */ }
    } catch (e) {
      lastMsg = e.message || 'network error'; refusedAll = false;
      if (++netFails >= 2) break;
      continue;
    }
    const err = json && json.chart && json.chart.error;
    if (err) throw new Error(err.description || 'No data'); // a real answer, e.g. unknown symbol
    if (r.ok && json) { yhStart = step; return json; }
    lastStatus = r.status;
    if (![401, 403, 429].includes(r.status)) { refusedAll = false; if (r.status < 500) break; }
  }
  const msg = lastStatus ? `Yahoo returned ${lastStatus}` : `Yahoo unreachable (${lastMsg})`;
  if (lastStatus ? refusedAll : netFails >= 2) { yhBlockedUntil = Date.now() + 60000; yhBlockedMsg = msg; }
  throw down(msg);
}
async function yahooCandles(symbol, interval, range, ext) {
  const intraday = !!STEP[interval];
  ext = ext && intraday;
  const j = await yahoo(`/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}${ext ? '&includePrePost=true' : ''}`);
  const res = j.chart && j.chart.result && j.chart.result[0];
  if (!res) throw new Error('No data for ' + symbol);
  const m = res.meta || {}, ts = res.timestamp || [];
  const q = (res.indicators && res.indicators.quote && res.indicators.quote[0]) || {};
  const off = m.gmtoffset || 0; // shift so the chart shows exchange-local time
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
    symbol, name: m.shortName || m.longName || symbol, currency: m.currency || '',
    exchange: m.fullExchangeName || m.exchangeName || '', type: m.instrumentType || '',
    price: m.regularMarketPrice != null ? m.regularMarketPrice : (bars.length ? bars[bars.length - 1].close : null),
    bars, source: 'Yahoo Finance',
  };
}

// ---- backups (daily / weekly / monthly only) -------------------------------
// weekly bars are stamped with their Monday and monthly bars with the 1st, as Yahoo does, so drawings line up whichever source is in use
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
const dayTime = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 1000;

async function nasdaq(symbol, interval, days) {
  if (STEP[interval] || !US_RE.test(symbol)) return null;
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  const n = (s) => parseFloat(String(s).replace(/[$,]/g, ''));
  for (const cls of ['stocks', 'etf']) {
    const j = await getJson(`https://api.nasdaq.com/api/quote/${symbol.replace('-', '.')}/historical?assetclass=${cls}&fromdate=${iso(Date.now() - (days || 3653) * 86400e3)}&todate=${iso(Date.now() + 86400e3)}&limit=9999`);
    const rows = j && j.data && j.data.tradesTable && j.data.tradesTable.rows;
    if (!rows || !rows.length) continue;
    const bars = [];
    for (const r of rows) {
      const [mo, da, yr] = String(r.date).split('/').map(Number);
      const bar = { time: Date.UTC(yr, mo - 1, da) / 1000, open: n(r.open), high: n(r.high), low: n(r.low), close: n(r.close), volume: n(r.volume) || 0 };
      if (isFinite(bar.time) && bar.open > 0 && bar.high > 0 && bar.low > 0 && bar.close > 0) bars.push(bar);
    }
    bars.sort((a, b) => a.time - b.time);
    return { type: cls === 'etf' ? 'ETF' : 'EQUITY', currency: 'USD', exchange: '', bars: regroup(bars, interval) };
  }
  return null;
}

const TC_INDEX = { '^GSPC': 'us.INX', '^DJI': 'us.DJI', '^IXIC': 'us.IXIC', '^NDX': 'us.NDX', '^HSI': 'hkHSI' };
async function tencentCode(symbol) {
  if (TC_INDEX[symbol]) return TC_INDEX[symbol];
  let m;
  if ((m = /^(\d{1,5})\.HK$/.exec(symbol))) return 'hk' + m[1].padStart(5, '0');
  if ((m = /^(\d{6})\.(SS|SZ)$/.exec(symbol))) return (m[2] === 'SS' ? 'sh' : 'sz') + m[1];
  if (!US_RE.test(symbol)) return null;
  // US codes need their exchange suffix (AAPL.OQ, IBM.N, SPY.AM); the quote service tells it
  const sym = symbol.replace('-', '.');
  const r = await fetch('https://qt.gtimg.cn/q=us' + sym, { headers: HEADERS, signal: timeout(8000) });
  if (!r.ok) throw down('HTTP ' + r.status);
  const text = new TextDecoder().decode(await r.arrayBuffer()); // GBK, but the part we need is plain ASCII
  const esc = sym.replace(/\./g, '\\.'); // look for the code with its suffix first: the name field can equal the bare symbol (IBM)
  const hit = new RegExp('~(' + esc + '\\.[A-Z]{1,2})~').exec(text) || new RegExp('~(' + esc + ')~').exec(text);
  return hit ? 'us' + hit[1] : null;
}
async function tencent(symbol, interval, days) {
  if (STEP[interval]) return null;
  const code = await tencentCode(symbol);
  if (!code) return null;
  const period = { '1d': 'day', '1wk': 'week', '1mo': 'month' }[interval];
  const count = interval === '1d' ? Math.min(2000, days ? Math.ceil(days * 0.75) + 10 : 2000) : 640;
  const j = await getJson(`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${code},${period},,,${count},qfq`);
  const d = j && j.data && j.data[code];
  const key = d && Object.keys(d).find((k) => k.endsWith(period));
  const rows = key ? d[key] : [];
  if (!Array.isArray(rows) || rows.length < 3) return null; // an unknown code comes back as one or two stray rows
  const stamp = interval === '1wk' ? weekStart : interval === '1mo' ? monthStart : (t) => t;
  const bars = rows.map((k) => ({ time: stamp(dayTime(k[0])), open: +k[1], close: +k[2], high: +k[3], low: +k[4], volume: +k[5] || 0 }))
    .filter((b) => b.open > 0 && b.high > 0 && b.low > 0 && b.close > 0);
  const market = code.slice(0, 2);
  return {
    type: code.startsWith('us.') || code === 'hkHSI' ? 'INDEX' : 'EQUITY',
    currency: market === 'hk' ? 'HKD' : market === 'sh' || market === 'sz' ? 'CNY' : 'USD', exchange: '', bars,
  };
}

const BACKUPS = [['Nasdaq', nasdaq], ['Tencent', tencent]];
async function backupCandles(symbol, interval, range) {
  const days = RANGE_DAYS[range] || 0;
  for (const [source, fn] of BACKUPS) {
    if (downUntil[source] > Date.now()) continue;
    let r;
    try { r = await fn(symbol, interval, days); } catch (e) { if (e.unavailable || e.name === 'TimeoutError') downUntil[source] = Date.now() + 120000; continue; }
    if (!r || !r.bars.length) continue;
    let bars = r.bars;
    if (days) { const cutoff = Date.now() / 1000 - (days + 1) * 86400; bars = bars.filter((b) => b.time >= cutoff); }
    if (!bars.length) continue;
    return { symbol, name: symbol, currency: r.currency, exchange: r.exchange, type: r.type, price: bars[bars.length - 1].close, bars, source };
  }
  return null;
}

async function candles(symbol, interval, range, ext) {
  try { return await yahooCandles(symbol, interval, range, ext); } catch (e) {
    if (!e.unavailable) throw e;
    const b = await backupCandles(symbol, interval, range);
    if (b) return b;
    throw down(STEP[interval]
      ? 'Intraday data comes only from Yahoo Finance, which is not available right now. Daily charts may still work.'
      : 'No data source is available right now (' + e.message + ').');
  }
}

async function search(q) {
  const j = await yahoo(`/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0`);
  return (j.quotes || []).filter((x) => x.symbol).map((x) => ({
    symbol: x.symbol, name: x.shortname || x.longname || '', type: x.typeDisp || '', exchange: x.exchDisp || '',
  }));
}

async function health() {
  const test = async (name, fn) => {
    const t0 = Date.now();
    try { const r = await fn(); return { source: name, working: !!(r && r.bars && r.bars.length), ms: Date.now() - t0 }; }
    catch (e) { return { source: name, working: false, error: e.message, ms: Date.now() - t0 }; }
  };
  return {
    time: new Date().toISOString(),
    sources: await Promise.all([
      test('Yahoo Finance', () => { yhBlockedUntil = 0; return yahooCandles('AAPL', '1d', '5d'); }),
      test('Nasdaq', () => nasdaq('AAPL', '1d', 31)),
      test('Tencent', () => tencent('AAPL', '1d', 31)),
    ]),
  };
}

// ---- http ---------------------------------------------------------------
function allowedOrigin(origin, env) {
  if (!origin) return null;
  const list = String((env && env.ALLOWED_ORIGINS) || DEFAULT_ORIGINS).split(',').map((s) => s.trim()).filter(Boolean);
  if (list.includes('*') || list.includes(origin)) return origin;
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin; // for testing the page locally
  return null;
}
function reply(body, status, origin, maxAge = 0) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': maxAge ? `public, max-age=${maxAge}` : 'no-store', Vary: 'Origin' };
  if (origin) headers['Access-Control-Allow-Origin'] = origin;
  return new Response(JSON.stringify(body), { status, headers });
}

// ---- visit counter -------------------------------------------------------
// Anonymous daily totals for the web page, kept in a KV namespace bound as VISITS (see wrangler.toml).
// Stored per day: visits, visitors (first visit of the day from a browser), new visitors (first visit ever
// from a browser) and a count per country. No IP address, cookie or identifier is stored.
async function hit(request, env, url, origin) {
  const local = !origin || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin); // testing is not counted
  if (env && env.VISITS && !local) {
    try {
      const key = 'd:' + new Date().toISOString().slice(0, 10);
      const rec = (await env.VISITS.get(key, 'json')) || { visits: 0, visitors: 0, fresh: 0, countries: {} };
      rec.visits++;
      if (url.searchParams.get('day') === '1') rec.visitors++;
      if (url.searchParams.get('new') === '1') rec.fresh++;
      const cc = (request.cf && request.cf.country) || 'XX';
      if (/^[A-Z0-9]{2}$/.test(cc)) rec.countries[cc] = (rec.countries[cc] || 0) + 1;
      await env.VISITS.put(key, JSON.stringify(rec), { expirationTtl: 400 * 86400 });
    } catch { /* over the free quota or KV unavailable: this visit is not counted */ }
  }
  return reply({ ok: true }, 200, origin);
}
// The owner's view of the counter: /stats?key=<STATS_KEY secret>  (add &format=json for the raw numbers)
async function stats(env, url) {
  const key = url.searchParams.get('key') || '';
  const want = String((env && env.STATS_KEY) || '').replace(/[^\x21-\x7e]/g, ''); // a secret set from a shell pipe can carry a line break or byte-order mark
  if (!env || !env.VISITS || want.length < 16 || key !== want) return reply({ error: 'Not found' }, 404, null);
  const days = Math.min(400, Math.max(1, +url.searchParams.get('days') || 60));
  const names = (await env.VISITS.list({ prefix: 'd:' })).keys.map((k) => k.name).sort().slice(-days);
  const rows = (await Promise.all(names.map(async (n) => ({ day: n.slice(2), ...((await env.VISITS.get(n, 'json')) || {}) })))).reverse();
  const sum = (f) => rows.reduce((s, r) => s + (r[f] || 0), 0);
  const total = { visits: sum('visits'), visitors: sum('visitors'), fresh: sum('fresh') };
  if (url.searchParams.get('format') === 'json') return reply({ days: rows.length, total, rows }, 200, null);
  const top = (c) => Object.entries(c || {}).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => k + ' ' + v).join(', ');
  const tr = (r, tag = 'td') => '<tr>' + [r.day, r.visits || 0, r.visitors || 0, r.fresh || 0, r.c || ''].map((v) => '<' + tag + '>' + v + '</' + tag + '>').join('') + '</tr>';
  const html = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Investerview visits</title>'
    + '<style>body{font:14px system-ui,sans-serif;max-width:760px;margin:24px auto;padding:0 16px;color:#222}table{border-collapse:collapse;width:100%}td,th{padding:6px 10px;border-bottom:1px solid #ddd;text-align:right}td:first-child,th:first-child,td:last-child,th:last-child{text-align:left}p{color:#666}</style>'
    + '<h2>Investerview web version: visits</h2><p>Last ' + rows.length + ' days with visits. Days are in UTC. Visitors = browsers on their first visit that day; New = browsers on their first visit ever.</p><table>'
    + tr({ day: 'Day', visits: 'Visits', visitors: 'Visitors', fresh: 'New', c: 'Countries' }, 'th')
    + tr({ day: 'Total', ...total, c: '' }, 'th') + rows.map((r) => tr({ ...r, c: top(r.countries) })).join('') + '</table>';
  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

async function route(url) {
  const p = url.searchParams;
  if (url.pathname === '/candles') {
    const symbol = String(p.get('symbol') || '').trim().toUpperCase();
    const interval = p.get('interval') || '1d', range = p.get('range') || '1y';
    if (!SYMBOL_RE.test(symbol) || !INTERVALS.has(interval) || !RANGES.has(range)) return [{ error: 'Bad request' }, 400, 0];
    try {
      const d = await candles(symbol, interval, range, p.get('ext') === '1');
      return [d, 200, STEP[interval] ? 30 : d.source === 'Yahoo Finance' ? 120 : 300];
    } catch (e) { return [{ error: e.message, unavailable: !!e.unavailable }, e.unavailable ? 503 : 404, 0]; }
  }
  if (url.pathname === '/search') {
    const q = String(p.get('q') || '').trim().slice(0, 40);
    if (!q) return [[], 200, 0];
    try { return [await search(q), 200, 3600]; } catch (e) { return [{ error: e.message, unavailable: true }, 503, 0]; }
  }
  if (url.pathname === '/health') return [await health(), 200, 0];
  if (url.pathname === '/') return [{ app: 'Investerview data proxy', routes: ['/candles?symbol=AAPL&interval=1d&range=1y', '/search?q=apple', '/health'] }, 200, 0];
  return [{ error: 'Not found' }, 404, 0];
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url), originHdr = request.headers.get('Origin'), origin = allowedOrigin(originHdr, env);
    if (originHdr && !origin) return reply({ error: 'This website may not use this data proxy' }, 403, null);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': origin || '*', 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Max-Age': '86400' } });
    if (request.method !== 'GET') return reply({ error: 'GET only' }, 405, origin);
    if (url.pathname === '/hit') return hit(request, env, url, origin);
    if (url.pathname === '/stats') return stats(env, url);
    const edge = typeof caches !== 'undefined' && caches.default; // Cloudflare's edge cache (absent when testing in Node)
    const cacheKey = new Request(url.toString());
    if (edge && url.pathname !== '/health') {
      const hit = await edge.match(cacheKey);
      if (hit) { const r = new Response(hit.body, hit); if (origin) r.headers.set('Access-Control-Allow-Origin', origin); return r; }
    }
    const [body, status, maxAge] = await route(url);
    const res = reply(body, status, origin, maxAge);
    if (edge && maxAge && status === 200) {
      const store = reply(body, status, null, maxAge);
      const p = edge.put(cacheKey, store);
      if (ctx && ctx.waitUntil) ctx.waitUntil(p); else await p;
    }
    return res;
  },
};
