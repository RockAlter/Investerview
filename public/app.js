(() => {
'use strict';

const LW = window.LightweightCharts;
const I18N = window.I18N || { t: (s) => s, locale: 'en-US' };
const t = I18N.t; // translate interface text (see i18n.js)
const $ = (s, r = document) => r.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  Object.assign(e, props);
  for (const k of kids) if (k != null) e.append(k);
  return e;
};
// Multi-chart layout: each extra chart is this same page in a frame, opened with ?pane=1..3 (EMBED). It keeps its own
// symbol, timeframe, chart type and indicators, shares the drawings, and leaves saving to disk to the main window.
const PANE = Math.min(3, Math.max(0, Math.round(+new URLSearchParams(location.search).get('pane') || 0)));
const EMBED = PANE > 0 && window.parent !== window;
if (EMBED) document.documentElement.classList.add('embed');
const OWN = new Set(['symbol', 'tf', 'type', 'scale', 'compare', 'indicators']);
const skey = (k) => 'cd.' + (EMBED && OWN.has(k) ? 'p' + PANE + '.' : '') + k;
const store = {
  get(k, d) { try { const v = localStorage.getItem(skey(k)); return v == null ? d : JSON.parse(v); } catch { return d; } },
  shared(k, d) { try { const v = localStorage.getItem('cd.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(skey(k), JSON.stringify(v)); } catch { /* storage unavailable */ } if (SYNCED.has(k)) pushState(); },
};
// The watchlist, drawings and indicators are also mirrored to a file on disk through the local
// server, so they survive a cleared browser and the MCP server can read them. The file wins on start-up.
const SYNCED = new Set(['watch', 'drawings', 'collapsed', 'indicators', 'paper', 'alerts']);
let syncReady = false, pushTimer = 0;
// Web version (opened from a website such as GitHub Pages, not from the desktop app): there is no
// local server, so web-data.js fetches prices in the browser, through the data proxy (worker/) and
// the other sources it switches between. IBKR positions and the saved data file need the desktop app.
const TOUCH = window.matchMedia('(hover: none) and (pointer: coarse)').matches; // phone or tablet: press and hold instead of right-click
const WEB = !!window.WebData && (!/^(localhost|127\.0\.0\.1)$/.test(location.hostname) || new URLSearchParams(location.search).has('web'));
function pushState() {
  if (!syncReady || WEB || EMBED) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    fetch('/api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ watch: state.watch, drawings: state.drawings, collapsed: [...collapsed], indicators: state.indicators, paper: state.paper, alerts: state.alerts }) }).catch(() => {});
  }, 400);
}
async function pullState() {
  try {
    const s = await api('/api/state');
    if (s && Array.isArray(s.watch)) {
      state.watch = s.watch; state.drawings = s.drawings || {};
      if (Array.isArray(s.indicators)) state.indicators = s.indicators;
      collapsed.clear(); for (const c of s.collapsed || []) collapsed.add(c);
      if (s.paper && typeof s.paper.cash === 'number') { state.paper = s.paper; store.set('paper', state.paper); }
      if (Array.isArray(s.alerts)) { state.alerts = s.alerts; store.set('alerts', state.alerts); }
      store.set('watch', state.watch); store.set('drawings', state.drawings); store.set('indicators', state.indicators); store.set('collapsed', [...collapsed]);
      syncReady = true;
    } else { syncReady = true; pushState(); } // no file yet: create it from this browser's data
  } catch { syncReady = true; }
}
async function api(path) {
  if (WEB) return window.WebData.api(path);
  const r = await fetch(path);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Request failed');
  return j;
}

// Chart and canvas colours come from the stylesheet's variables, so they follow the light/dark theme.
const C = {};
function readTheme() {
  const cs = getComputedStyle(document.documentElement), v = (n) => cs.getPropertyValue(n).trim();
  Object.assign(C, { bg: v('--bg'), grid: v('--grid'), border: v('--border'), border2: v('--border2'), text: v('--axis'), up: v('--up'), down: v('--down'),
    accent: v('--accent'), label: v('--overlay'), handle: v('--handle'), cost: v('--cost') });
}
readTheme();
const rgba = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };
const PALETTE = ['#f5a524', '#b47cff', '#35c2d6', '#ff7ab6', '#9bd24a', '#ff8a4c'];
const TF = { '1m': ['1m', '5d'], '5m': ['5m', '1mo'], '15m': ['15m', '1mo'], '1h': ['60m', '6mo'], '1D': ['1d', '5y'], '1W': ['1wk', '10y'], '1M': ['1mo', 'max'] };
const IND = {
  SMA: { name: 'Moving Average (SMA)', period: 20 },
  EMA: { name: 'Exponential MA (EMA)', period: 20 },
  BB: { name: 'Bollinger Bands', period: 20 },
  VOL: { name: 'Volume' },
  RSI: { name: 'RSI', period: 14 },
  MACD: { name: 'MACD (12, 26, 9)' },
  // The rest are drawn by one generic routine (see makeIndicator): calc returns one array per line.
  // lines: w = width, dash, dots, c = 'up' / 'down' colour, gap = break the line where there is no value. levels = guide lines.
  WMA: { name: 'Weighted MA (WMA)', period: 20, calc: (d, c, p) => [wma(c, p)] },
  LSMA: { name: 'Linear regression line (LSMA)', period: 25, calc: (d, c, p) => [lsma(c, p)] },
  VWAP: { name: 'VWAP', calc: (d) => [vwap(d)] },
  VPVR: { name: 'Volume profile (visible range)', vp: 1 }, // drawn by drawProfile, not a chart series
  DONCH: { name: 'Donchian Channel', period: 20, calc: (d, c, p) => donchian(d, p), lines: [{ w: 1 }, { w: 1, dash: 1 }, { w: 1 }] },
  KELT: { name: 'Keltner Channel', period: 20, calc: (d, c, p) => keltner(d, c, p), lines: [{ w: 1 }, { w: 1, dash: 1 }, { w: 1 }] },
  SUPERT: { name: 'Supertrend (10, 3)', calc: (d) => supertrend(d, 10, 3), lines: [{ c: 'up', gap: 1 }, { c: 'down', gap: 1 }] },
  PSAR: { name: 'Parabolic SAR', calc: (d) => [psar(d)], lines: [{ dots: 1 }] },
  STOCH: { name: 'Stochastic (14, 3, 3)', pane: 1, period: 14, calc: (d, c, p) => stoch(d, p), lines: [{}, { w: 1, c: 'alt' }], levels: [80, 20] },
  CCI: { name: 'Commodity Channel Index (CCI)', pane: 1, period: 20, calc: (d, c, p) => [cci(d, p)], levels: [100, -100] },
  WILLR: { name: 'Williams %R', pane: 1, period: 14, calc: (d, c, p) => [willr(d, p)], levels: [-20, -80] },
  MFI: { name: 'Money Flow Index (MFI)', pane: 1, period: 14, calc: (d, c, p) => [mfi(d, p)], levels: [80, 20] },
  ADX: { name: 'ADX / DMI', pane: 1, period: 14, calc: (d, c, p) => adx(d, p), lines: [{}, { w: 1, c: 'up' }, { w: 1, c: 'down' }], levels: [25] },
  ATR: { name: 'Average True Range (ATR)', pane: 1, period: 14, calc: (d, c, p) => [atr(d, p)] },
  STDEV: { name: 'Standard deviation', pane: 1, period: 20, calc: (d, c, p) => [stdev(c, p)] },
  ROC: { name: 'Rate of change (ROC)', pane: 1, period: 12, calc: (d, c, p) => [c.map((v, i) => (i >= p && c[i - p] ? (v / c[i - p] - 1) * 100 : null))], levels: [0] },
  MOM: { name: 'Momentum', pane: 1, period: 10, calc: (d, c, p) => [c.map((v, i) => (i >= p ? v - c[i - p] : null))], levels: [0] },
  OBV: { name: 'On-balance volume (OBV)', pane: 1, big: 1, calc: (d) => [obv(d)] },
};
const DEFAULT_WATCH = ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN', 'GOOGL', 'META', 'SPY', 'QQQ', 'BTC-USD', 'ETH-USD', 'EURUSD=X', 'GC=F'];

const state = {
  symbol: store.get('symbol', EMBED ? ['MSFT', 'NVDA', 'TSLA'][PANE - 1] : 'AAPL'),
  tf: store.get('tf', '1D'),
  type: store.get('type', 'candles'),
  scale: store.get('scale', store.get('log', false) ? 1 : 0), // price scale: 0 regular, 1 log, 2 percent, 3 indexed to 100
  compare: store.get('compare', []), // other symbols drawn as lines on the chart
  raw: [], // bars as loaded; state.data is what the chart shows (Renko bricks in the Renko chart)
  ext: !WEB, // pre-market and after-hours prices are always shown in the desktop app
  extRuns: [],
  indicators: store.get('indicators', store.shared('indicators', [{ id: 1, type: 'SMA', period: 50 }, { id: 2, type: 'SMA', period: 200 }, { id: 3, type: 'VOL' }])),
  alerts: store.get('alerts', []), // { id, sym, kind, op: 'above' | 'below', price | value | period | line, time, hit, hitPrice }; see checkAlerts
  watch: store.get('watch', DEFAULT_WATCH),
  drawings: store.get('drawings', {}),
  paper: store.get('paper', null) || { start: 100000, cash: 100000, realized: 0, pos: {}, orders: [], trades: [] }, // practice account
  view: 'chart',
  tool: 'cursor',
  data: [], meta: {}, step: 86400,
};
if (!TF[state.tf]) state.tf = '1D';

// ---------------------------------------------------------------- math
function sma(v, p) {
  const o = new Array(v.length).fill(null); let s = 0;
  for (let i = 0; i < v.length; i++) { s += v[i]; if (i >= p) s -= v[i - p]; if (i >= p - 1) o[i] = s / p; }
  return o;
}
function ema(v, p) {
  const o = new Array(v.length).fill(null);
  if (v.length < p) return o;
  const k = 2 / (p + 1); let e = 0;
  for (let i = 0; i < p; i++) e += v[i];
  e /= p; o[p - 1] = e;
  for (let i = p; i < v.length; i++) { e = v[i] * k + e * (1 - k); o[i] = e; }
  return o;
}
function bollinger(v, p, mult = 2) {
  const mid = sma(v, p), up = mid.slice(), lo = mid.slice();
  for (let i = p - 1; i < v.length; i++) {
    let s = 0; for (let j = i - p + 1; j <= i; j++) s += (v[j] - mid[i]) ** 2;
    const sd = Math.sqrt(s / p); up[i] = mid[i] + mult * sd; lo[i] = mid[i] - mult * sd;
  }
  return { mid, up, lo };
}
function rsi(v, p) {
  const o = new Array(v.length).fill(null);
  if (v.length <= p) return o;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const d = v[i] - v[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= p; l /= p;
  o[p] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = p + 1; i < v.length; i++) {
    const d = v[i] - v[i - 1];
    g = (g * (p - 1) + Math.max(d, 0)) / p; l = (l * (p - 1) + Math.max(-d, 0)) / p;
    o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return o;
}
function macd(v) {
  const f = ema(v, 12), s = ema(v, 26), n = v.length;
  const line = new Array(n).fill(null), signal = new Array(n).fill(null), hist = new Array(n).fill(null);
  const start = 25; if (n <= start) return { line, signal, hist };
  for (let i = start; i < n; i++) line[i] = f[i] - s[i];
  const sig = ema(line.slice(start), 9);
  for (let i = start; i < n; i++) { signal[i] = sig[i - start]; if (signal[i] != null) hist[i] = line[i] - signal[i]; }
  return { line, signal, hist };
}
const blank = (n) => new Array(n).fill(null);
function wma(v, p) { // linearly weighted: the newest bar counts p times, the oldest once
  const o = blank(v.length), den = p * (p + 1) / 2;
  for (let i = p - 1; i < v.length; i++) { let s = 0; for (let j = 0; j < p; j++) s += v[i - j] * (p - j); o[i] = s / den; }
  return o;
}
// least-squares line through values lo..hi (x = 0, 1, 2…): slope, intercept, spread of the residuals, R²
function linreg(v, lo, hi) {
  const n = hi - lo + 1; let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { const y = v[lo + i]; sx += i; sy += y; sxy += i * y; sxx += i * i; }
  const den = n * sxx - sx * sx, slope = den ? (n * sxy - sx * sy) / den : 0, icpt = (sy - slope * sx) / n;
  let res = 0, tot = 0;
  for (let i = 0; i < n; i++) { const y = v[lo + i]; res += (y - (icpt + slope * i)) ** 2; tot += (y - sy / n) ** 2; }
  return { n, slope, icpt, sd: Math.sqrt(res / n), r2: tot ? 1 - res / tot : 0 };
}
function lsma(v, p) { // end point of the regression line over the last p bars
  const o = blank(v.length);
  for (let i = p - 1; i < v.length; i++) { const r = linreg(v, i - p + 1, i); o[i] = r.icpt + r.slope * (p - 1); }
  return o;
}
function stdev(v, p) {
  const m = sma(v, p), o = blank(v.length);
  for (let i = p - 1; i < v.length; i++) { let s = 0; for (let j = i - p + 1; j <= i; j++) s += (v[j] - m[i]) ** 2; o[i] = Math.sqrt(s / p); }
  return o;
}
function rollHL(d, p) { // highest high and lowest low of the last p bars
  const hi = blank(d.length), lo = blank(d.length);
  for (let i = p - 1; i < d.length; i++) { let h = -Infinity, l = Infinity; for (let j = i - p + 1; j <= i; j++) { if (d[j].high > h) h = d[j].high; if (d[j].low < l) l = d[j].low; } hi[i] = h; lo[i] = l; }
  return { hi, lo };
}
function donchian(d, p) { const { hi, lo } = rollHL(d, p); return [hi, hi.map((h, i) => (h == null ? null : (h + lo[i]) / 2)), lo]; }
const trueRange = (d, i) => (i ? Math.max(d[i].high - d[i].low, Math.abs(d[i].high - d[i - 1].close), Math.abs(d[i].low - d[i - 1].close)) : d[i].high - d[i].low);
function wilder(v, p, from = 0) { // Wilder's smoothing, started with a plain average of the first p values
  const o = blank(v.length); if (v.length < from + p) return o;
  let s = 0; for (let i = from; i < from + p; i++) s += v[i];
  o[from + p - 1] = s / p;
  for (let i = from + p; i < v.length; i++) o[i] = (o[i - 1] * (p - 1) + v[i]) / p;
  return o;
}
const atr = (d, p) => wilder(d.map((b, i) => trueRange(d, i)), p);
function keltner(d, c, p) { const m = ema(c, p), a = atr(d, p); return [m.map((v, i) => (v == null || a[i] == null ? null : v + 2 * a[i])), m, m.map((v, i) => (v == null || a[i] == null ? null : v - 2 * a[i]))]; }
function supertrend(d, p, mult) { // returns [line while the trend is up, line while it is down]
  const a = atr(d, p), up = blank(d.length), dn = blank(d.length);
  let fu = 0, fl = 0, dir = 1;
  for (let i = 0; i < d.length; i++) {
    if (a[i] == null) continue;
    const mid = (d[i].high + d[i].low) / 2, bu = mid + mult * a[i], bl = mid - mult * a[i], first = a[i - 1] == null;
    const nu = first || bu < fu || d[i - 1].close > fu ? bu : fu, nl = first || bl > fl || d[i - 1].close < fl ? bl : fl;
    if (!first) dir = d[i].close > fu ? 1 : d[i].close < fl ? -1 : dir;
    fu = nu; fl = nl;
    if (dir > 0) up[i] = fl; else dn[i] = fu;
  }
  return [up, dn];
}
function psar(d, step = 0.02, max = 0.2) {
  const n = d.length, o = blank(n); if (n < 2) return o;
  let up = d[1].close >= d[0].close, sar = up ? d[0].low : d[0].high, ep = up ? d[0].high : d[0].low, af = step;
  for (let i = 1; i < n; i++) {
    sar += af * (ep - sar);
    if (up) {
      sar = Math.min(sar, d[i - 1].low, i > 1 ? d[i - 2].low : d[i - 1].low);
      if (d[i].low < sar) { up = false; sar = ep; ep = d[i].low; af = step; } else if (d[i].high > ep) { ep = d[i].high; af = Math.min(max, af + step); }
    } else {
      sar = Math.max(sar, d[i - 1].high, i > 1 ? d[i - 2].high : d[i - 1].high);
      if (d[i].high > sar) { up = true; sar = ep; ep = d[i].high; af = step; } else if (d[i].low < ep) { ep = d[i].low; af = Math.min(max, af + step); }
    }
    o[i] = sar;
  }
  return o;
}
function vwap(d) { // volume-weighted average price, restarted each day (intraday), month (daily) or year (weekly, monthly)
  const key = state.step < 86400 ? (t) => Math.floor(t / 86400) : state.step < 5 * 86400 ? (t) => new Date(t * 1000).toISOString().slice(0, 7) : (t) => new Date(t * 1000).getUTCFullYear();
  const o = blank(d.length); let k = null, pv = 0, vol = 0;
  for (let i = 0; i < d.length; i++) {
    const kk = key(d[i].time); if (kk !== k) { k = kk; pv = 0; vol = 0; }
    pv += (d[i].high + d[i].low + d[i].close) / 3 * d[i].volume; vol += d[i].volume;
    o[i] = vol ? pv / vol : null;
  }
  return o;
}
function stoch(d, p) { // %K smoothed over 3 bars, and %D = its 3-bar average
  const { hi, lo } = rollHL(d, p), raw = d.map((b, i) => (hi[i] == null ? null : hi[i] === lo[i] ? 50 : (b.close - lo[i]) / (hi[i] - lo[i]) * 100));
  const avg3 = (a) => a.map((v, i) => (i >= 2 && a[i - 2] != null ? (a[i] + a[i - 1] + a[i - 2]) / 3 : null));
  const k = avg3(raw); return [k, avg3(k)];
}
function cci(d, p) {
  const tp = d.map((b) => (b.high + b.low + b.close) / 3), m = sma(tp, p), o = blank(d.length);
  for (let i = p - 1; i < d.length; i++) { let dev = 0; for (let j = i - p + 1; j <= i; j++) dev += Math.abs(tp[j] - m[i]); dev /= p; o[i] = dev ? (tp[i] - m[i]) / (0.015 * dev) : 0; }
  return o;
}
function willr(d, p) { const { hi, lo } = rollHL(d, p); return d.map((b, i) => (hi[i] == null ? null : hi[i] === lo[i] ? -50 : (hi[i] - b.close) / (hi[i] - lo[i]) * -100)); }
function mfi(d, p) {
  const tp = d.map((b) => (b.high + b.low + b.close) / 3), o = blank(d.length);
  for (let i = p; i < d.length; i++) {
    let pos = 0, neg = 0;
    for (let j = i - p + 1; j <= i; j++) { const f = tp[j] * d[j].volume; if (tp[j] > tp[j - 1]) pos += f; else if (tp[j] < tp[j - 1]) neg += f; }
    o[i] = pos + neg === 0 ? null : neg === 0 ? 100 : 100 - 100 / (1 + pos / neg);
  }
  return o;
}
function adx(d, p) { // returns [ADX, +DI, -DI]
  const n = d.length, pdm = [0], mdm = [0], tr = [0];
  for (let i = 1; i < n; i++) {
    const u = d[i].high - d[i - 1].high, dn = d[i - 1].low - d[i].low;
    pdm.push(u > dn && u > 0 ? u : 0); mdm.push(dn > u && dn > 0 ? dn : 0); tr.push(trueRange(d, i));
  }
  const sp = wilder(pdm, p, 1), sm = wilder(mdm, p, 1), st = wilder(tr, p, 1);
  const pdi = sp.map((v, i) => (v == null || !st[i] ? null : v / st[i] * 100)), mdi = sm.map((v, i) => (v == null || !st[i] ? null : v / st[i] * 100));
  const dx = pdi.map((v, i) => (v == null ? 0 : v + mdi[i] ? Math.abs(v - mdi[i]) / (v + mdi[i]) * 100 : 0));
  return [wilder(dx, p, p), pdi, mdi];
}
function obv(d) { const o = []; let s = 0; d.forEach((b, i) => { if (i) s += b.close > d[i - 1].close ? b.volume : b.close < d[i - 1].close ? -b.volume : 0; o.push(s); }); return o; }
function heikin(d) {
  const o = []; let po, pc;
  d.forEach((b, i) => {
    const c = (b.open + b.high + b.low + b.close) / 4;
    const op = i ? (po + pc) / 2 : (b.open + b.close) / 2;
    o.push({ time: b.time, open: op, high: Math.max(b.high, op, c), low: Math.min(b.low, op, c), close: c });
    po = op; pc = c;
  });
  return o;
}
// Renko: a new brick each time the close moves one brick size past the last brick; a turn needs two sizes.
// Brick size is the 14-bar ATR, rounded to two digits. Each brick carries the time of the bar that made it.
function renkoSize(d) {
  const a = atr(d, 14); let v = null;
  for (let i = a.length - 1; i >= 0 && v == null; i--) v = a[i];
  if (!(v > 0)) v = d[d.length - 1].close * 0.01;
  if (!(v > 0)) return 0;
  const mag = 10 ** (Math.floor(Math.log10(v)) - 1);
  return Math.round(v / mag) * mag;
}
function renko(d, size) {
  const o = []; if (!d.length || !(size > 0)) return o;
  let lo = Math.floor(d[0].close / size) * size, hi = lo, vol = 0, lastT = 0;
  const add = (open, close, src) => {
    lastT = Math.max(src.time, lastT + 1);
    o.push({ time: lastT, open, close, high: Math.max(open, close), low: Math.min(open, close), volume: vol });
    vol = 0;
  };
  for (const b of d) {
    vol += b.volume || 0;
    let guard = 0;
    while (b.close >= hi + size * 0.999999 && guard++ < 500) { add(hi, hi + size, b); lo = hi; hi += size; }
    while (b.close <= lo - size * 0.999999 && guard++ < 500) { add(lo, lo - size, b); hi = lo; lo -= size; }
  }
  return o;
}
// state.data from state.raw for the current chart type
function derive() {
  state.brick = 0;
  let d = state.raw;
  if (state.type === 'renko') { state.brick = renkoSize(d); const r = renko(d, state.brick); if (r.length > 1) d = r; else state.brick = 0; }
  state.data = d;
  state.extRuns = []; // [firstIndex, lastIndex] of each stretch of pre-market / after-hours bars
  d.forEach((b, i) => { if (b.x) { const r = state.extRuns[state.extRuns.length - 1]; if (r && r[1] === i - 1) r[1] = i; else state.extRuns.push([i, i]); } });
  timeIdx = new Map(d.map((b, i) => [b.time, i]));
}
const toLine = (d, a) => { const o = []; for (let i = 0; i < d.length; i++) if (a[i] != null) o.push({ time: d[i].time, value: a[i] }); return o; };

// ---------------------------------------------------------------- formatting
function precision() {
  const t = state.meta.type, p = state.meta.price || 1;
  if (t === 'CURRENCY') return p > 20 ? 3 : 5;
  if (p < 0.01) return 8;
  if (p < 1) return 5;
  if (p < 10 && t === 'CRYPTOCURRENCY') return 4;
  return 2;
}
const fmtP = (v, pr = precision()) => v == null ? '–' : v.toLocaleString('en-US', { minimumFractionDigits: pr, maximumFractionDigits: pr });
const fmtLast = (v) => v == null ? '–' : fmtP(v, v < 1 ? 5 : v < 10 ? 4 : 2);
const fmtVol = (v) => v == null ? '–' : v >= 1e9 ? (v / 1e9).toFixed(2) + 'B' : v >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(1) + 'K' : String(Math.round(v));
const fmtChg = (v, last) => v == null ? '–' : (v > 0 ? '+' : '') + fmtP(v, last < 1 ? 5 : last < 10 ? 4 : 2); // price change, same decimals as the price
const fmtPct = (v) => v == null ? '–' : (v > 0 ? '+' : '') + v.toFixed(2) + '%';
const cls = (v) => v == null || v === 0 ? '' : v > 0 ? 'up' : 'down';

// ---------------------------------------------------------------- chart
const stage = $('#stage'), chartEl = $('#chart');
let chart = null;
let S = { main: null, inds: [] };
let timeIdx = new Map();

function lineOpts(color, width = 2) {
  // lastValueVisible puts the indicator's current value on the right-hand price scale, in its own colour
  return { color, lineWidth: width, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false };
}

function makeIndicator(ind, color, nextPane) {
  const isMA = ind.type === 'SMA' || ind.type === 'EMA';
  if (isMA) {
    const s = chart.addSeries(LW.LineSeries, lineOpts(color));
    return { ind, color, vals: [], apply(d, c) { const a = (ind.type === 'SMA' ? sma : ema)(c, ind.period); s.setData(toLine(d, a)); this.vals = [a]; } };
  }
  if (ind.type === 'BB') {
    const up = chart.addSeries(LW.LineSeries, lineOpts(color, 1));
    const mid = chart.addSeries(LW.LineSeries, { ...lineOpts(color, 1), lineStyle: 2 });
    const lo = chart.addSeries(LW.LineSeries, lineOpts(color, 1));
    return { ind, color, vals: [], apply(d, c) { const b = bollinger(c, ind.period); up.setData(toLine(d, b.up)); mid.setData(toLine(d, b.mid)); lo.setData(toLine(d, b.lo)); this.vals = [b.up, b.mid, b.lo]; } };
  }
  if (IND[ind.type] && IND[ind.type].vp) return { ind, color, vals: [], vp: true, apply() {} };
  if (ind.type === 'VOL') {
    const s = chart.addSeries(LW.HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'vol', priceLineVisible: false, lastValueVisible: false });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    const volUp = rgba(C.up, 0.35), volDown = rgba(C.down, 0.35);
    return { ind, color, vals: [], isVol: true, apply(d) {
      s.setData(d.map((b) => ({ time: b.time, value: b.volume, color: b.close >= b.open ? volUp : volDown })));
      this.vals = [d.map((b) => b.volume)];
    } };
  }
  if (ind.type === 'RSI') {
    const pane = nextPane();
    const s = chart.addSeries(LW.LineSeries, { ...lineOpts(color), lastValueVisible: true, priceFormat: { type: 'price', precision: 1, minMove: 0.1 } }, pane);
    for (const lvl of [70, 30]) s.createPriceLine({ price: lvl, color: C.border2, lineWidth: 1, lineStyle: 2, axisLabelVisible: false });
    return { ind, color, pane, fixed: 1, vals: [], apply(d, c) { const a = rsi(c, ind.period); s.setData(toLine(d, a)); this.vals = [a]; } };
  }
  if (ind.type === 'MACD') {
    const pane = nextPane();
    const h = chart.addSeries(LW.HistogramSeries, { priceLineVisible: false, lastValueVisible: false }, pane);
    const l = chart.addSeries(LW.LineSeries, lineOpts(C.accent), pane);
    const sg = chart.addSeries(LW.LineSeries, lineOpts('#f5a524'), pane);
    return { ind, color: C.accent, pane, vals: [], apply(d, c) {
      const m = macd(c);
      h.setData(d.map((b, i) => m.hist[i] == null ? null : { time: b.time, value: m.hist[i], color: rgba(m.hist[i] >= 0 ? C.up : C.down, 0.6) }).filter(Boolean));
      l.setData(toLine(d, m.line)); sg.setData(toLine(d, m.signal));
      this.vals = [m.line, m.signal, m.hist];
    } };
  }
  const def = IND[ind.type];
  if (def && def.calc) { // every other indicator: one line series per array that calc returns
    const pane = def.pane ? nextPane() : 0, n = (def.lines || [{}]).length;
    const series = (def.lines || [{}]).map((ln) => {
      const col = ln.c === 'up' ? C.up : ln.c === 'down' ? C.down : ln.c === 'alt' ? '#f5a524' : color;
      const o = { ...lineOpts(col, ln.w || 2), lastValueVisible: n === 1 || !def.pane ? !ln.dash : true };
      if (ln.dash) o.lineStyle = 2;
      if (ln.dots) Object.assign(o, { lineVisible: false, pointMarkersVisible: true, pointMarkersRadius: 1.5 });
      if (def.pane) o.priceFormat = def.big ? { type: 'volume' } : { type: 'price', precision: 2, minMove: 0.01 };
      return chart.addSeries(LW.LineSeries, o, pane);
    });
    for (const lvl of def.levels || []) series[0].createPriceLine({ price: lvl, color: C.border2, lineWidth: 1, lineStyle: 2, axisLabelVisible: false });
    return { ind, color, pane: pane || undefined, big: !!def.big, vals: [], apply(d, c) {
      const out = def.calc(d, c, ind.period);
      series.forEach((s, i) => s.setData((def.lines || [{}])[i].gap ? d.map((b, k) => (out[i][k] == null ? { time: b.time } : { time: b.time, value: out[i][k] })) : toLine(d, out[i])));
      this.vals = out;
    } };
  }
  return null;
}

function buildChart(keepRange) {
  let range = null;
  if (chart) { if (keepRange) range = chart.timeScale().getVisibleLogicalRange(); chart.remove(); }
  const intraday = TF[state.tf][0].endsWith('m');
  chart = LW.createChart(chartEl, {
    autoSize: true,
    localization: { locale: I18N.locale },
    layout: { background: { color: C.bg }, textColor: C.text, fontFamily: 'system-ui, "Segoe UI", sans-serif', attributionLogo: false, panes: { separatorColor: C.border, separatorHoverColor: 'rgba(76,141,255,.25)', enableResize: true } },
    grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
    crosshair: { mode: 0 },
    rightPriceScale: { borderColor: C.border, mode: state.scale === 1 ? 1 : 0 },
    timeScale: { borderColor: C.border, timeVisible: intraday, secondsVisible: false, rightOffset: 6 },
  });

  const pr = precision();
  const pf = { priceFormat: { type: 'price', precision: pr, minMove: 1 / 10 ** pr } };
  const ud = { upColor: C.up, downColor: C.down };
  if (state.type === 'line' || state.type === 'markers' || state.type === 'step') S.main = chart.addSeries(LW.LineSeries, { color: C.accent, lineWidth: 2, pointMarkersVisible: state.type === 'markers', lineType: state.type === 'step' ? 1 : 0, ...pf });
  else if (state.type === 'baseline') S.main = chart.addSeries(LW.BaselineSeries, { baseValue: { type: 'price', price: 0 }, topLineColor: C.up, bottomLineColor: C.down, topFillColor1: rgba(C.up, 0.3), topFillColor2: rgba(C.up, 0.03), bottomFillColor1: rgba(C.down, 0.03), bottomFillColor2: rgba(C.down, 0.3), lineWidth: 2, ...pf });
  else if (state.type === 'columns') S.main = chart.addSeries(LW.HistogramSeries, { color: C.accent, ...pf });
  else if (state.type === 'hlc') S.main = chart.addSeries(LW.BarSeries, { ...ud, openVisible: false, ...pf });
  else if (state.type === 'hollow') S.main = chart.addSeries(LW.CandlestickSeries, { ...ud, borderVisible: true, ...pf });
  else if (state.type === 'area') S.main = chart.addSeries(LW.AreaSeries, { lineColor: C.accent, topColor: rgba(C.accent, 0.35), bottomColor: rgba(C.accent, 0), lineWidth: 2, ...pf });
  else if (state.type === 'bars') S.main = chart.addSeries(LW.BarSeries, { ...ud, ...pf });
  else S.main = chart.addSeries(LW.CandlestickSeries, { ...ud, borderVisible: false, wickUpColor: C.up, wickDownColor: C.down, ...pf });

  let pane = 0, colorI = 0;
  S.inds = [];
  for (const ind of state.indicators) {
    const it = makeIndicator(ind, PALETTE[colorI++ % PALETTE.length], () => ++pane);
    if (it) S.inds.push(it);
  }
  S.cmp = [];
  if (state.type !== 'renko') state.compare.forEach((sym, i) => {
    const color = CMP_COLORS[i % CMP_COLORS.length];
    S.cmp.push({ sym, color, vals: [], series: chart.addSeries(LW.LineSeries, { ...lineOpts(color), title: sym, lastValueVisible: state.scale >= 2, ...pf }) });
  });
  applyData();
  try { chart.panes().forEach((p, i) => { if (i > 0) p.setHeight(130); }); } catch { /* default pane sizes */ }

  const n = state.data.length;
  const view = range || { from: Math.max(0, n - 160), to: n + 6 }, built = chart;
  chart.timeScale().setVisibleLogicalRange(view);
  requestAnimationFrame(() => { if (chart === built) chart.timeScale().setVisibleLogicalRange(view); }); // again once the chart has its size
  chart.subscribeCrosshairMove((p) => updateLegend(p.time != null && timeIdx.has(p.time) ? timeIdx.get(p.time) : state.data.length - 1));
  chart.subscribeClick((p) => { if (p.point) selectAt(p.point.x, p.point.y); });
  if (state.scale >= 2) { // percent / indexed: every line on the price scale is labelled against the first bar on screen
    let on = [S.main, ...S.cmp.map((c) => c.series)];
    try { on = chart.panes()[0].getSeries().filter((s) => s.options().priceScaleId !== 'vol'); } catch { /* main and compare lines only */ }
    for (const s of on) s.applyOptions({ priceFormat: { type: 'custom', minMove: 1 / 10 ** pr, formatter: viewFmt } });
  }
  chart.timeScale().subscribeVisibleLogicalRangeChange(() => onView(false));
  onView(true, view.from);
  renderChips();
  updateLegend(n - 1);
  drawIbLines(); if (ib) renderIb(); renderPaper(); renderAlerts();
}

function applyData() {
  const d = state.data, closes = d.map((b) => b.close);
  const tone = (i) => (i && d[i].close < d[i - 1].close ? C.down : C.up); // by the change from the bar before
  if (LINE_TYPES.has(state.type)) S.main.setData(d.map((b) => ({ time: b.time, value: b.close })));
  else if (state.type === 'columns') S.main.setData(d.map((b, i) => ({ time: b.time, value: b.close, color: tone(i) })));
  else if (state.type === 'hilo') S.main.setData(d.map((b, i) => ({ time: b.time, open: b.low, high: b.high, low: b.low, close: b.high, color: tone(i), borderColor: tone(i), wickColor: tone(i) })));
  else if (state.type === 'hollow') S.main.setData(d.map((b, i) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, color: b.close >= b.open ? C.bg : tone(i), borderColor: tone(i), wickColor: tone(i) })));
  else S.main.setData((state.type === 'heikin' ? heikin(d) : d).map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));
  for (const it of S.inds) it.apply(d, closes);
  for (const c of S.cmp || []) c.vals = alignTo(d, cmpData.get(c.sym));
  onView(true);
}

// ---------------------------------------------------------------- compare
const LINE_TYPES = new Set(['line', 'markers', 'step', 'area', 'baseline']);
const CMP_COLORS = ['#f5a524', '#b072f5', '#2bc4c4', '#ef5da8'];
const cmpData = new Map(); // symbol -> bars for the current timeframe
// closes of another symbol on the charted symbol's bars: the latest close at or before each bar (same day on daily charts and above)
function alignTo(d, bars) {
  const out = new Array(d.length).fill(null); if (!bars || !bars.length) return out;
  const key = state.step >= 86400 ? (t) => Math.floor(t / 86400) : (t) => t;
  let j = -1;
  for (let i = 0; i < d.length; i++) {
    const k = key(d[i].time);
    while (j + 1 < bars.length && key(bars[j + 1].time) <= k) j++;
    if (j >= 0) out[i] = bars[j].close;
  }
  return out;
}
async function loadCompare(fresh) {
  const [interval, range] = TF[state.tf], tag = state.tf + '|' + state.ext;
  await Promise.all(state.compare.map(async (sym) => {
    try {
      const j = await api(`/api/candles?symbol=${encodeURIComponent(sym)}&interval=${interval}&range=${range}${state.ext ? '&ext=1' : ''}${fresh ? '&fresh=1' : ''}`);
      if (tag === state.tf + '|' + state.ext && j.bars.length) cmpData.set(sym, j.bars);
    } catch { /* keep what we have; the chip shows a dash */ }
  }));
}
function setScale(mode) {
  state.scale = mode; store.set('scale', mode); $('#scale').value = String(mode);
  if (chart && state.data.length) buildChart(true);
}
async function addCompare(raw) {
  const sym = String(raw || '').trim().toUpperCase();
  if (!sym || sym === state.symbol || state.compare.includes(sym)) return;
  if (state.compare.length >= CMP_COLORS.length) { alert(t('You can compare up to {0} symbols at a time.', CMP_COLORS.length)); return; }
  const [interval, range] = TF[state.tf];
  try {
    const j = await api(`/api/candles?symbol=${encodeURIComponent(sym)}&interval=${interval}&range=${range}${state.ext ? '&ext=1' : ''}`);
    if (!j.bars.length) throw new Error('empty');
    cmpData.set(sym, j.bars);
  } catch { alert(t('No data for {0} on this timeframe', sym)); return; }
  state.compare.push(sym); store.set('compare', state.compare);
  if (state.scale === 0) setScale(2); // different prices only compare as percentages
  if (state.data.length) buildChart(true);
}
// The first bar on screen is the reference: the Baseline chart, the percent and indexed scales and the
// compare lines are all measured from it. Compare lines are rescaled to start at the charted symbol's price there.
let viewI = -1, viewBase = 1;
const viewFmt = (p) => {
  const r = p / viewBase;
  return state.scale === 3 ? (r * 100).toFixed(2) : (r >= 1 ? '+' : '') + ((r - 1) * 100).toFixed(2) + '%';
};
function onView(force, from) {
  if (!chart || !S.main || !state.data.length) return;
  const d = state.data, r = chart.timeScale().getVisibleLogicalRange();
  const f = r ? r.from : from; if (f == null) return;
  const i = Math.max(0, Math.min(d.length - 1, Math.ceil(f)));
  if (i === viewI && !force) return;
  viewI = i; viewBase = d[i].close || 1;
  if (state.type === 'baseline') S.main.applyOptions({ baseValue: { type: 'price', price: viewBase } });
  for (const c of S.cmp || []) {
    let k = i; while (k < d.length && c.vals[k] == null) k++;
    const m = k < d.length && c.vals[k] ? d[k].close / c.vals[k] : null;
    c.series.setData(m == null ? [] : toLine(d, c.vals.map((v) => (v == null ? null : v * m))));
  }
  if (state.scale >= 2) S.main.applyOptions({ priceFormat: { type: 'custom', minMove: 1 / 10 ** precision(), formatter: (p) => viewFmt(p) } }); // redraws the labels
}

// ---------------------------------------------------------------- legend + indicator chips
function renderChips() {
  const box = $('#chips'); box.textContent = '';
  for (const sym of state.compare) {
    const c = (S.cmp || []).find((x) => x.sym === sym);
    const chip = el('span', { className: 'chip' }, el('span', { className: 'dot' }), el('span', { textContent: sym }));
    chip.firstChild.style.background = c ? c.color : C.text;
    const val = el('span', { className: 'muted', textContent: c ? '' : t('not shown in Renko') });
    if (c) c.valEl = val;
    const rm = el('button', { textContent: '✕', title: t('Remove') });
    rm.addEventListener('click', () => {
      state.compare = state.compare.filter((x) => x !== sym); store.set('compare', state.compare); cmpData.delete(sym);
      if (state.data.length) buildChart(true);
    });
    chip.append(val, rm); box.append(chip);
  }
  for (const it of S.inds) {
    const ind = it.ind;
    const chip = el('span', { className: 'chip' }, el('span', { className: 'dot' }), el('span', { textContent: ind.type === 'VOL' ? t('Vol') : ind.type }));
    chip.firstChild.style.background = it.isVol ? C.text : it.color;
    if (ind.period != null) {
      const inp = el('input', { type: 'number', min: 2, max: 500, value: ind.period, title: t('Period') });
      inp.addEventListener('change', () => {
        const v = Math.round(Number(inp.value));
        if (!(v >= 2 && v <= 500)) { inp.value = ind.period; return; }
        ind.period = v; store.set('indicators', state.indicators);
        applyData(); updateLegend(state.data.length - 1);
      });
      chip.append(inp);
    }
    it.valEl = el('span', { className: 'muted' });
    const rm = el('button', { textContent: '✕', title: t('Remove') });
    rm.addEventListener('click', () => {
      state.indicators = state.indicators.filter((x) => x !== ind);
      store.set('indicators', state.indicators); buildChart(true);
    });
    chip.append(it.valEl, rm);
    box.append(chip);
  }
}

function updateLegend(i) {
  const d = state.data, b = d[i];
  $('#lgSym').textContent = state.symbol;
  $('#lgName').textContent = [state.meta.name !== state.symbol && state.meta.name, state.meta.exchange || (WEB && state.meta.source), state.tf, state.brick ? t('Renko, brick {0}', fmtP(state.brick)) : null].filter(Boolean).join(' · ');
  const src = $('#lgSrc'), backup = state.meta.source && state.meta.source !== 'Yahoo Finance';
  src.hidden = !backup || WEB; // the web version names its source in the legend line instead
  if (backup) { src.textContent = t('Backup data: {0}', state.meta.source); src.title = t('Yahoo Finance is not available from this network, so prices come from a backup source. Extended hours and symbol search need Yahoo.'); }
  const box = $('#lgOhlc'); box.textContent = '';
  if (!b) return;
  const prev = d[i - 1], chg = prev ? (b.close / prev.close - 1) * 100 : null;
  const k = b.close >= b.open ? 'up' : 'down';
  for (const [lab, val] of [['O', b.open], ['H', b.high], ['L', b.low], ['C', b.close]]) {
    box.append(el('span', {}, el('i', { textContent: lab }), el('span', { className: k, textContent: fmtP(val) })));
  }
  if (chg != null) box.append(el('span', { className: cls(chg), textContent: fmtPct(chg) }));
  if (b.x) box.append(el('span', { className: 'tag', textContent: t(b.time % 86400 < 43200 ? 'Pre-market' : 'After-hours') }));
  for (const c of S.cmp || []) if (c.valEl) c.valEl.textContent = c.vals[i] == null ? '–' : fmtLast(c.vals[i]);
  for (const it of S.inds) {
    if (!it.valEl || it.vp) continue;
    const shown = it.vals.map((a) => a[i] == null ? null : it.isVol ? fmtVol(a[i]) : it.big ? (a[i] < 0 ? '-' : '') + fmtVol(Math.abs(a[i])) : it.pane ? a[i].toFixed(2) : fmtP(a[i])).filter((x) => x != null);
    it.valEl.textContent = shown.length ? shown.join('  ') : '–';
  }
}

// ---------------------------------------------------------------- loading
let loadSeq = 0;
function showMsg(text, withDiag) {
  const m = $('#msg'); m.hidden = !text; m.textContent = '';
  if (!text) return;
  const box = el('div', {}, el('p', { textContent: text }));
  if (withDiag === 'download') box.append(el('p', {}, el('a', { href: window.WebData.DOWNLOAD, target: '_blank', rel: 'noopener', textContent: t('Get the desktop app') })));
  else if (withDiag) box.append(el('p', {}, el('a', { href: '/api/diag', target: '_blank', rel: 'noopener', textContent: t('Show connection diagnostics') })));
  m.append(box);
}

// time of the last successful chart load, next to the refresh button
function markUpdated(err) {
  const u = $('#updated');
  u.classList.toggle('err', !!err);
  if (err) { u.textContent = '!'; u.title = t('Refresh failed: {0}', err); return; }
  const now = new Date().toLocaleTimeString();
  u.textContent = now; u.title = t('Prices updated at {0}', now);
}

// refresh: update the chart in place (no "Loading" message); fresh: ask the server to skip its short cache (refresh button)
async function load({ refresh = false, fresh = false } = {}) {
  const seq = ++loadSeq;
  const [interval, range] = TF[state.tf];
  if (!refresh) showMsg(t('Loading {0}…', state.symbol));
  try {
    const [j] = await Promise.all([api(`/api/candles?symbol=${encodeURIComponent(state.symbol)}&interval=${interval}&range=${range}${state.ext ? '&ext=1' : ''}${fresh ? '&fresh=1' : ''}`), loadCompare(fresh)]);
    if (seq !== loadSeq) return;
    markUpdated();
    if (!j.bars.length) throw new Error(t('No data for {0} on this timeframe', state.symbol));
    state.raw = j.bars; state.meta = j;
    const diffs = []; for (let i = Math.max(1, j.bars.length - 60); i < j.bars.length; i++) diffs.push(j.bars[i].time - j.bars[i - 1].time);
    diffs.sort((a, b) => a - b); state.step = diffs[diffs.length >> 1] || 86400;
    derive();
    showMsg(null);
    if (refresh && chart) { applyData(); updateLegend(state.data.length - 1); } else buildChart(false);
    document.title = `${state.symbol} ${fmtP(j.price)} · InvestorView`;
  } catch (e) {
    if (seq !== loadSeq) return;
    if (refresh) { markUpdated(e.message); return; } // keep the chart on screen
    const refused = /returned (401|403|429)/.exec(e.message), unreachable = /Could not reach/.test(e.message);
    if (refused) showMsg(t('Yahoo Finance refused the request from this network (HTTP {0}). Try switching your VPN or proxy on or off, or wait a few minutes and reload.', refused[1]), true);
    else if (unreachable) showMsg(t('Could not connect to Yahoo Finance. Check your internet connection, or whether a VPN or firewall is blocking it.'), true);
    else showMsg(e.message + t(' — try another symbol or timeframe.'));
  }
}

// main = always the main chart (its own search box, the Paper and Alerts tabs); otherwise the chart that was clicked last
function setSymbol(sym, main) {
  if (!EMBED && !main && activePane > 0 && frames[activePane - 1]) {
    frames[activePane - 1].contentWindow.postMessage({ cd: 'symbol', sym: sym.toUpperCase() }, location.origin);
    setView('chart'); return;
  }
  state.symbol = sym.toUpperCase(); store.set('symbol', state.symbol);
  selected = null; draft = null;
  $('#sym').value = '';
  setView('chart'); renderWatch(); load();
  if (PHONE && !main) setPhoneView('chart'); // a symbol tapped in a list: show its chart (searches inside a tab stay there)
}

// ---------------------------------------------------------------- top bar
const tfs = $('#tfs');
for (const k of Object.keys(TF)) {
  const b = el('button', { textContent: k, className: k === state.tf ? 'on' : '' });
  b.addEventListener('click', () => {
    state.tf = k; store.set('tf', k);
    for (const x of tfs.children) x.classList.toggle('on', x === b);
    load();
  });
  tfs.append(b);
}
$('#type').value = state.type;
$('#type').addEventListener('change', (e) => {
  const wasRenko = state.type === 'renko';
  state.type = e.target.value; store.set('type', state.type);
  if (!state.raw.length) return;
  const renkoNow = state.type === 'renko';
  if (wasRenko || renkoNow) derive(); // the bars themselves change, so the old scroll position means nothing
  buildChart(!(wasRenko || renkoNow));
});
$('#scale').value = String(state.scale);
$('#scale').addEventListener('change', (e) => setScale(Number(e.target.value)));
const cmpBox = $('#cmpBox'); // Compare: a search box under the button
cmpBox.append(symbolSearch((sym) => { cmpBox.hidden = true; addCompare(sym); }));
$('#cmpBtn').addEventListener('click', (e) => { e.stopPropagation(); indMenu.hidden = true; cmpBox.hidden = !cmpBox.hidden; if (!cmpBox.hidden) cmpBox.querySelector('input').focus(); });
cmpBox.addEventListener('click', (e) => e.stopPropagation());
cmpBox.addEventListener('keydown', (e) => { if (e.key === 'Escape') cmpBox.hidden = true; });
document.addEventListener('click', () => { cmpBox.hidden = true; });
// light / dark theme: follows the system setting until the user picks one with the button
let theme = store.get('theme', null);
const sysLight = window.matchMedia('(prefers-color-scheme: light)');
function applyTheme(redraw) {
  const th = theme === 'light' || theme === 'dark' ? theme : sysLight.matches ? 'light' : 'dark';
  document.documentElement.dataset.theme = th;
  readTheme();
  $('#theme').textContent = th === 'dark' ? '☀' : '☾';
  if (redraw) { if (chart && state.data.length) buildChart(true); renderGrid(); }
}
$('#theme').addEventListener('click', () => {
  theme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'; store.set('theme', theme); applyTheme(true);
  for (const f of frames) { try { f.contentWindow.location.reload(); } catch { /* frame not ready */ } } // the other charts pick the theme up on load
});
sysLight.addEventListener('change', () => { if (!theme) applyTheme(true); });
applyTheme(false);
$('#refresh').addEventListener('click', async (e) => {
  const b = e.currentTarget;
  if (b.classList.contains('busy')) return;
  b.classList.add('busy');
  try { await Promise.all([state.view === 'chart' ? load({ refresh: true, fresh: true }) : null, refreshWatch(true)]); } finally { b.classList.remove('busy'); }
});

const indMenu = $('#indMenu');
const isBelow = (type) => !!IND[type].pane || type === 'RSI' || type === 'MACD';
for (const [type, def] of Object.entries(IND).sort((a, b) => isBelow(a[0]) - isBelow(b[0]))) { // overlays first, then the ones with their own panel
  const firstOf = !indMenu.dataset.below === isBelow(type) || !indMenu.children.length;
  if (firstOf) { indMenu.append(el('li', { className: 'head', textContent: t(isBelow(type) ? 'Below the chart' : 'On the price chart') })); if (isBelow(type)) indMenu.dataset.below = '1'; }
  const li = el('li', { textContent: t(def.name) });
  li.addEventListener('click', () => {
    indMenu.hidden = true;
    if (def.period == null && state.indicators.some((x) => x.type === type)) return; // one is enough
    const ind = { id: Date.now(), type }; if (def.period != null) ind.period = def.period;
    state.indicators.push(ind); store.set('indicators', state.indicators);
    if (state.data.length) buildChart(true);
  });
  indMenu.append(li);
}
$('#indBtn').addEventListener('click', (e) => { e.stopPropagation(); indMenu.hidden = !indMenu.hidden; });

// symbol search
const symInput = $('#sym'), results = $('#results');
let searchTimer = 0, searchSeq = 0, hits = [], hitI = -1;
function renderHits() {
  results.textContent = '';
  hits.forEach((h, i) => {
    const li = el('li', { className: i === hitI ? 'on' : '' }, el('b', { textContent: h.symbol }), el('span', { className: 'n', textContent: h.name }), el('span', { className: 'x', textContent: [h.type, h.exchange].filter(Boolean).join(' · ') }));
    li.addEventListener('mousedown', (e) => { e.preventDefault(); pick(h.symbol); });
    results.append(li);
  });
  results.hidden = !hits.length;
}
function pick(sym) { hits = []; renderHits(); symInput.blur(); setSymbol(sym, true); }
symInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = symInput.value.trim(); hitI = -1;
  if (!q) { hits = []; renderHits(); return; }
  searchTimer = setTimeout(async () => {
    const seq = ++searchSeq;
    try { const r = await api('/api/search?q=' + encodeURIComponent(q)); if (seq === searchSeq) { hits = r; renderHits(); } } catch { /* keep previous results */ }
  }, 180);
});
symInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!hits.length) return;
    e.preventDefault(); hitI = (hitI + (e.key === 'ArrowDown' ? 1 : -1) + hits.length) % hits.length; renderHits();
  } else if (e.key === 'Enter') {
    const q = symInput.value.trim().toUpperCase(); if (!q) return;
    const exact = hits.find((h) => h.symbol.toUpperCase() === q);
    pick(hitI >= 0 ? hits[hitI].symbol : exact ? exact.symbol : /^[A-Z0-9.\-=^]{1,20}$/.test(q) && !hits.length ? q : hits[0] ? hits[0].symbol : q);
  } else if (e.key === 'Escape') { hits = []; renderHits(); symInput.blur(); }
});
symInput.addEventListener('blur', () => { results.hidden = true; });
// the same search for a box inside a side tab (Paper, Alerts)
function symbolSearch(onPick) {
  const input = el('input', { placeholder: t('Search symbol or company…'), autocomplete: 'off', spellcheck: false }), listEl = el('ul', { className: 'hits', hidden: true });
  let timer = 0, seq = 0, found = [], at = -1;
  const draw = () => {
    listEl.textContent = '';
    found.forEach((h, i) => {
      const li = el('li', { className: i === at ? 'on' : '' }, el('b', { textContent: h.symbol }), el('span', { className: 'n', textContent: h.name }));
      li.addEventListener('mousedown', (e) => { e.preventDefault(); choose(h.symbol); });
      listEl.append(li);
    });
    listEl.hidden = !found.length;
  };
  const choose = (sym) => { found = []; at = -1; draw(); input.value = ''; input.blur(); onPick(sym); };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim(); at = -1;
    if (!q) { found = []; draw(); return; }
    timer = setTimeout(async () => {
      const mine = ++seq;
      try { const r = await api('/api/search?q=' + encodeURIComponent(q)); if (mine === seq) { found = r; draw(); } } catch { /* keep previous results */ }
    }, 180);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!found.length) return;
      e.preventDefault(); at = (at + (e.key === 'ArrowDown' ? 1 : -1) + found.length) % found.length; draw();
    } else if (e.key === 'Enter') {
      const q = input.value.trim().toUpperCase(); if (!q) return;
      const exact = found.find((h) => h.symbol.toUpperCase() === q);
      choose(at >= 0 ? found[at].symbol : exact ? exact.symbol : /^[A-Z0-9.\-=^]{1,20}$/.test(q) && !found.length ? q : found[0] ? found[0].symbol : q);
    } else if (e.key === 'Escape') { found = []; draw(); input.blur(); }
  });
  input.addEventListener('blur', () => { listEl.hidden = true; });
  input.addEventListener('focus', () => { listEl.hidden = !found.length; });
  return el('div', { className: 'psearch' }, input, listEl);
}
symInput.addEventListener('focus', () => { results.hidden = !hits.length; });
document.addEventListener('click', () => { indMenu.hidden = true; });

// ---------------------------------------------------------------- drawing tools
// One toolbar button per group; a group with several tools opens a list. Each tool: [id, name, icon, clicks needed, hint].
const P2 = 'Click two points', P1 = 'Click to place it';
const TOOL_GROUPS = [
  [['cursor', 'Select / pan (Esc)', '<path d="M5 3l12 7-5 1.5L9.5 17z"/>', 0]],
  [
    ['trend', 'Trend line', '<path d="M4 16L16 4"/><circle cx="4" cy="16" r="1.6"/><circle cx="16" cy="4" r="1.6"/>', 2, 'Click two points to draw a trend line'],
    ['ray', 'Ray', '<path d="M4 16L17 3"/><circle cx="4" cy="16" r="1.6"/><circle cx="10" cy="10" r="1.6"/>', 2, P2],
    ['extline', 'Extended line', '<path d="M2 18L18 2"/><circle cx="7" cy="13" r="1.6"/><circle cx="13" cy="7" r="1.6"/>', 2, P2],
    ['arrow', 'Arrow', '<path d="M4 16L16 4M10 4h6v6"/>', 2, P2],
    ['hline', 'Horizontal line', '<path d="M2 10h16"/><circle cx="10" cy="10" r="1.6"/>', 1, 'Click to place a horizontal line'],
    ['hray', 'Horizontal ray', '<path d="M5 10h13"/><circle cx="5" cy="10" r="1.6"/>', 1, P1],
    ['vline', 'Vertical line', '<path d="M10 2v16"/><circle cx="10" cy="10" r="1.6"/>', 1, 'Click to place a vertical line'],
    ['cross', 'Cross line', '<path d="M2 10h16M10 2v16"/>', 1, P1],
  ],
  [
    ['channel', 'Parallel channel', '<path d="M3 13L14 3M6 17L17 7"/>', 3, 'Click two points of the trend, then a point for the width'],
    ['regress', 'Regression channel (±2σ)', '<path d="M3 15L17 6"/><path d="M3 11L17 2M3 19L17 10" stroke-dasharray="2 2"/>', 2, 'Click the first and the last bar of the range'],
    ['pitchfork', 'Andrews pitchfork', '<path d="M3 11h4M7 5v12M7 5h10M7 11h10M7 17h10"/>', 3, 'Click the pivot, then the two swing points'],
  ],
  [
    ['fib', 'Fibonacci retracement', '<path d="M3 4h14M3 8h14M3 11h14M3 16h14"/>', 2, 'Click the swing start, then the swing end'],
    ['fibext', 'Fibonacci extension', '<path d="M3 16l4-8 3 4"/><path d="M10 12h7M10 8h7M10 4h7"/>', 3, 'Click the swing start, the swing end, then the pullback'],
    ['fibfan', 'Fibonacci fan', '<path d="M3 17L17 4M3 17L17 9M3 17L17 14"/>', 2, 'Click the swing start, then the swing end'],
    ['fibtime', 'Fibonacci time zones', '<path d="M3 3v14M5.5 3v14M9 3v14M14 3v14"/>', 2, 'Click the start, then the end of the first interval'],
    ['gannfan', 'Gann fan', '<path d="M3 17L8 3M3 17L17 3M3 17L17 12M3 17h14M3 17V3"/>', 2, 'Click the origin, then a point on the 1/1 line'],
  ],
  [
    ['rect', 'Rectangle', '<rect x="3.5" y="5.5" width="13" height="9" rx="1"/>', 2, 'Click two corners'],
    ['ellipse', 'Ellipse', '<ellipse cx="10" cy="10" rx="7" ry="4.5"/>', 2, 'Click two corners'],
    ['triangle', 'Triangle', '<path d="M10 4l7 12H3z"/>', 3, 'Click three corners'],
  ],
  [
    ['measure', 'Measure price / % / bars', '<path d="M4 16L16 4M7 16H4v-3M13 4h3v3"/>', 2, 'Click two points to measure'],
    ['prange', 'Price range', '<path d="M4 4h12M4 16h12M10 5v10M7.5 7.5L10 5l2.5 2.5M7.5 12.5L10 15l2.5-2.5"/>', 2, P2],
    ['drange', 'Date range', '<path d="M4 4v12M16 4v12M5 10h10M7.5 7.5L5 10l2.5 2.5M12.5 7.5L15 10l-2.5 2.5"/>', 2, P2],
    ['position', 'Long / short position (risk : reward)', '<rect x="3.5" y="3.5" width="13" height="7"/><rect x="3.5" y="10.5" width="13" height="6" stroke-dasharray="2 2"/>', 3, 'Click the entry, then the target, then the stop'],
    ['avwap', 'Anchored VWAP', '<path d="M3 15c3-1 4-7 7-7s4 3 7 1"/><circle cx="3" cy="15" r="1.6"/>', 1, 'Click the bar to start from'],
  ],
  [['text', 'Text', '<path d="M5 5h10M10 5v11M8 16h4"/>', 1, 'Click where the text goes']],
];
const NPTS = {}, HINTS = {};
for (const grp of TOOL_GROUPS) for (const tl of grp) { NPTS[tl[0]] = tl[3]; HINTS[tl[0]] = tl[4]; }
const FIBS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
const FIBX = [0, 0.618, 1, 1.272, 1.618, 2, 2.618];
const FIBT = [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89];
const GANN = [[8, '8/1'], [4, '4/1'], [3, '3/1'], [2, '2/1'], [1, '1/1'], [1 / 2, '1/2'], [1 / 3, '1/3'], [1 / 4, '1/4'], [1 / 8, '1/8']]; // price units per time unit
const cv = $('#draw'), ctx = cv.getContext('2d');
let draft = null, placed = 0, selected = null, downAt = null;

const toolsEl = $('#tools');
const svg = (inner) => `<svg viewBox="0 0 20 20">${inner}</svg>`;
const fly = el('ul', { id: 'fly', hidden: true });
for (const grp of TOOL_GROUPS) {
  const b = el('button');
  const show = (tl) => { b.dataset.tool = tl[0]; b.title = t(tl[1]); b.innerHTML = svg(tl[2]) + (grp.length > 1 ? '<i></i>' : ''); };
  show(grp[0]);
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    const again = !fly.hidden && fly.owner === b;
    fly.hidden = true; setTool(b.dataset.tool);
    if (grp.length < 2 || again) return;
    fly.textContent = ''; fly.owner = b; fly.style.top = b.offsetTop + 'px';
    for (const tl of grp) {
      const li = el('li', { className: tl[0] === b.dataset.tool ? 'on' : '', innerHTML: svg(tl[2]) }, el('span', { textContent: t(tl[1]) }));
      li.addEventListener('click', () => { show(tl); setTool(tl[0]); });
      fly.append(li);
    }
    fly.hidden = false;
  });
  toolsEl.append(b);
}
toolsEl.append(fly);
document.addEventListener('click', () => { fly.hidden = true; });
toolsEl.append(el('hr'));
const delBtn = el('button', { title: t('Delete selected drawing, or all drawings on this symbol if none is selected (Del)'), innerHTML: svg('<path d="M4 6h12M8 6V4h4v2M6 6l1 10h6l1-10"/>') });
delBtn.addEventListener('click', () => removeDrawings());
toolsEl.append(delBtn);
// version of the running app, always visible at the bottom of the toolbar; links to that version's GitHub release
const RELEASES = 'https://github.com/RockAlter/Investerview/releases';
const verEl = el('a', { id: 'ver', href: RELEASES, target: '_blank', rel: 'noopener' }); toolsEl.append(verEl);
api('/api/version').then((v) => {
  verEl.textContent = 'v' + v.version; verEl.href = RELEASES + '/tag/v' + v.version;
  verEl.title = 'InvestorView ' + v.version + (WEB ? ' (web)' : '') + ' – ' + t('release notes on GitHub');
  if (WEB || EMBED) return; // the web version is always the latest one
  checkUpdate(v.version); setInterval(() => checkUpdate(v.version), 3600000); // the window may stay open for days
}).catch(() => {});
// Desktop app: asks GitHub for the latest release number at most once a day and, if it is newer, turns the version
// label into a link to that release. Nothing is downloaded or installed, and a failed check changes nothing.
const RELEASE_API = 'https://api.github.com/repos/RockAlter/Investerview/releases/latest';
function isNewer(a, b) { // a, b: "1.2.3"
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}
async function checkUpdate(current) {
  let c = store.get('updateCheck', null);
  if (!c || typeof c.latest !== 'string' || !(Date.now() - c.at < 86400000)) {
    try {
      const r = await fetch(RELEASE_API, { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(10000) });
      const m = r.ok ? /^v?(\d+\.\d+\.\d+)$/.exec((await r.json()).tag_name || '') : null;
      if (m) { c = { at: Date.now(), latest: m[1] }; store.set('updateCheck', c); }
    } catch { /* offline or GitHub unavailable: keep what is known */ }
  }
  if (!c || !/^\d+\.\d+\.\d+$/.test(String(c.latest)) || !isNewer(c.latest, current)) return;
  verEl.textContent = '↑ v' + c.latest; verEl.classList.add('new'); verEl.href = RELEASES + '/tag/v' + c.latest;
  verEl.title = t('Version {0} is available (you have {1}). Click to open the download page.', c.latest, current);
}
if (WEB) { // no local server: hide what needs one, and say so
  $('#sideTabs [data-side=pos]').hidden = true; $('#impWatch').hidden = true;
  const note = $('#webNote'); note.hidden = false; note.href = window.WebData.DOWNLOAD;
  note.textContent = t('Web version'); note.title = t('Prices can be delayed, and intraday, FX and futures charts depend on the data proxy being reachable. IBKR positions and the saved data file need the desktop app: click to download it. Your watchlist here is kept in this browser only.');
}

function setTool(id) {
  state.tool = id; draft = null; placed = 0;
  for (const b of toolsEl.querySelectorAll('[data-tool]')) b.classList.toggle('on', b.dataset.tool === id);
  cv.classList.toggle('active', id !== 'cursor');
  const h = $('#hint'); h.hidden = id === 'cursor'; h.textContent = HINTS[id] ? t(HINTS[id]) : '';
}
const list = () => (state.drawings[state.symbol] ||= []);
function saveDrawings() {
  const all = store.get('drawings', {}), mine = state.drawings[state.symbol];
  if (mine && mine.length) all[state.symbol] = mine; else delete all[state.symbol];
  state.drawings = all; store.set('drawings', all);
}
// Another window of the app (a second app window, another browser tab, or another chart of the layout) changed
// something: take it over, so this window's next save to the data file does not undo that change.
window.addEventListener('storage', (e) => {
  if (e.key === 'cd.drawings') { state.drawings = store.get('drawings', {}); selected = null; if (!EMBED) pushState(); }
  else if (e.key === 'cd.paper' || e.key === 'cd.alerts') {
    state.paper = store.get('paper', state.paper); state.alerts = store.get('alerts', state.alerts); drawIbLines();
    if (!EMBED && side === 'paper') renderPaper();
    if (!EMBED && side === 'alerts') renderAlerts();
  } else if (EMBED) return; // the rest is the main window's
  else if (e.key === 'cd.watch') { state.watch = store.get('watch', state.watch); renderWatch(); refreshWatch(); }
  else if (e.key === 'cd.collapsed') { collapsed.clear(); for (const c of store.get('collapsed', [])) collapsed.add(c); renderWatch(); }
  else if (e.key === 'cd.indicators') { state.indicators = store.get('indicators', state.indicators); if (chart && state.data.length) buildChart(true); }
});
function removeDrawings() {
  if (selected) { state.drawings[state.symbol] = list().filter((d) => d !== selected); selected = null; }
  else if (list().length && confirm(t('Remove all {0} drawings on {1}?', list().length, state.symbol))) state.drawings[state.symbol] = [];
  saveDrawings();
}

// time <-> logical bar position, so drawings survive timeframe changes
function timeToLogical(t) {
  const d = state.data, n = d.length; if (!n) return 0;
  if (t <= d[0].time) return (t - d[0].time) / state.step;
  if (t >= d[n - 1].time) return n - 1 + (t - d[n - 1].time) / state.step;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (d[m].time <= t) lo = m; else hi = m; }
  return lo + (t - d[lo].time) / (d[hi].time - d[lo].time);
}
function logicalToTime(l) {
  const d = state.data, n = d.length;
  if (l <= 0) return d[0].time + l * state.step;
  if (l >= n - 1) return d[n - 1].time + (l - (n - 1)) * state.step;
  const i = Math.floor(l); return d[i].time + (l - i) * (d[i + 1].time - d[i].time);
}
function geom() {
  if (!chart || !state.data.length) return null;
  const ts = chart.timeScale();
  const x0 = ts.logicalToCoordinate(0), x1 = ts.logicalToCoordinate(1);
  if (x0 == null || x1 == null) return null;
  let pw = 0, h;
  try { pw = chart.priceScale('right').width(); } catch { /* keep 0 */ }
  try { h = chart.panes()[0].getHeight(); } catch { h = stage.clientHeight - ts.height(); }
  return { x0, sp: x1 - x0, w: stage.clientWidth - pw, h };
}
function toXY(p, g) {
  const y = S.main.priceToCoordinate(p.price);
  return y == null ? null : { x: g.x0 + timeToLogical(p.time) * g.sp, y };
}
function fromXY(x, y, g) {
  const price = S.main.coordinateToPrice(y);
  return price == null ? null : { time: logicalToTime(Math.round((x - g.x0) / g.sp)), price };
}
function evPoint(e) {
  const r = cv.getBoundingClientRect(), g = geom();
  return g ? fromXY(e.clientX - r.left, e.clientY - r.top, g) : null;
}

const KEYS = ['a', 'b', 'c'];
cv.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const p = evPoint(e); if (!p) return;
  const n = NPTS[state.tool] || 2;
  if (!draft) {
    draft = { type: state.tool, a: p, b: p }; placed = 0;
    if (n === 3) draft.c = p;
    if (state.tool === 'text') {
      const text = (prompt(t('Text to show on the chart')) || '').trim().slice(0, 200);
      if (!text) { draft = null; return setTool('cursor'); }
      draft.text = text;
    }
  }
  for (let i = placed; i < n; i++) draft[KEYS[i]] = p; // the points not placed yet follow the pointer
  if (++placed >= n) return finish();
  downAt = n === 2 ? { x: e.clientX, y: e.clientY } : null;
});
cv.addEventListener('pointermove', (e) => {
  if (!draft) return;
  const p = evPoint(e); if (!p) return;
  for (let i = placed; i < (NPTS[draft.type] || 2); i++) draft[KEYS[i]] = p;
});
cv.addEventListener('pointerup', (e) => {
  if (draft && downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 6) finish(); // drag to draw
  downAt = null;
});
function finish() {
  list().push(draft); selected = draft; draft = null; downAt = null; placed = 0;
  saveDrawings(); setTool('cursor');
}

// Each frame every drawing records the lines and boxes it painted, so a click can be matched against them.
const hitMap = new WeakMap(), vwapCache = new WeakMap();
let selHandles = [], dragH = null;
function distSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1, len = dx * dx + dy * dy;
  const k = len ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len)) : 0;
  return Math.hypot(px - x1 - k * dx, py - y1 - k * dy);
}
const hitsDrawing = (d, x, y) => (hitMap.get(d) || []).some((s) => (s.length ? distSeg(x, y, s[0], s[1], s[2], s[3]) < 6 : x >= s.x1 - 4 && x <= s.x2 + 4 && y >= s.y1 - 4 && y <= s.y2 + 4));
function selectAt(x, y) {
  if (dragH || dragA) return;
  selected = null;
  for (const d of [...list()].reverse()) if (hitsDrawing(d, x, y)) { selected = d; break; }
}
// drag a handle of the selected drawing to move that point
stage.addEventListener('pointerdown', (e) => {
  if (state.tool !== 'cursor' || !selected || e.button !== 0) return;
  const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  const h = selHandles.find((q) => Math.hypot(q.x - x, q.y - y) < 8);
  if (h) dragH = { d: selected, k: h.k };
  else if (hitsDrawing(selected, x, y)) { // grabbed by its body: move the whole drawing
    const g = geom(); if (!g) return;
    const from = {}; for (const k of KEYS) if (selected[k]) { const q = toXY(selected[k], g); if (!q) return; from[k] = q; }
    dragH = { d: selected, from, x, y };
  } else return;
  e.stopPropagation(); e.preventDefault(); stage.classList.add('grab');
}, true);
// drag an alert's line up or down to change its price (main chart only)
let dragA = null;
stage.addEventListener('pointerdown', (e) => {
  if (EMBED || dragH || state.tool !== 'cursor' || e.button !== 0 || !S.main) return;
  const r = cv.getBoundingClientRect(), y = e.clientY - r.top, g = geom();
  if (!g || e.clientX - r.left > g.w || y > g.h) return;
  const a = state.alerts.find((q) => { if (q.hit || q.sym !== state.symbol || kindOf(q) !== 'price') return false; const ly = S.main.priceToCoordinate(q.price); return ly != null && Math.abs(ly - y) < 5; });
  if (!a) return;
  e.stopPropagation(); e.preventDefault(); dragA = a; stage.classList.add('grab');
}, true);
stage.addEventListener('mousedown', (e) => { if (dragH || dragA) e.stopPropagation(); }, true); // keep the chart from panning meanwhile
window.addEventListener('pointermove', (e) => {
  if (dragA) {
    const price = S.main.coordinateToPrice(e.clientY - cv.getBoundingClientRect().top);
    if (price > 0) { dragA.price = +price.toFixed(precision()); drawIbLines(); }
    return;
  }
  if (!dragH) return;
  if (dragH.from) { // whole drawing: every point shifts by the same distance on screen
    const r = cv.getBoundingClientRect(), g = geom(); if (!g) return;
    const dx = e.clientX - r.left - dragH.x, dy = e.clientY - r.top - dragH.y, next = {};
    for (const k of Object.keys(dragH.from)) { const p = fromXY(dragH.from[k].x + dx, dragH.from[k].y + dy, g); if (!p) return; next[k] = p; }
    Object.assign(dragH.d, next);
    return;
  }
  const p = evPoint(e); if (!p) return;
  dragH.d[dragH.k] = p; if (NPTS[dragH.d.type] === 1) dragH.d.b = p;
});
window.addEventListener('pointerup', () => {
  stage.classList.remove('grab');
  if (dragH) { saveDrawings(); setTimeout(() => { dragH = null; }, 0); }
  if (dragA) {
    const px = paperPrice(dragA.sym);
    if (px != null && dragA.price !== px) dragA.op = dragA.price > px ? 'above' : 'below'; // the side it now waits on
    saveAlerts(); drawIbLines(); renderAlerts();
    setTimeout(() => { dragA = null; }, 0);
  }
});

function label(text, x, y, color, align = 'left') {
  ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = align; ctx.textBaseline = 'middle';
  const w = ctx.measureText(text).width + 8, bx = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
  ctx.fillStyle = C.label; ctx.fillRect(bx, y - 8, w, 16);
  ctx.fillStyle = color; ctx.fillText(text, align === 'right' ? x - 4 : align === 'center' ? x : x + 4, y);
}
function span(sec) { // length of time in words short enough for a label
  sec = Math.abs(sec);
  return sec >= 86400 ? Math.round(sec / 86400) + 'd' : sec >= 3600 ? +(sec / 3600).toFixed(1) + 'h' : Math.round(sec / 60) + 'm';
}
function anchoredVwap(d, i0) { // volume-weighted average price from bar i0 on (plain average where there is no volume)
  const D = state.data, key = i0 + '|' + D.length + '|' + D[D.length - 1].close;
  let c = vwapCache.get(d);
  if (!c || c.D !== D || c.key !== key) {
    const hasVol = D.some((b, i) => i >= i0 && b.volume > 0), vals = []; let pv = 0, vol = 0;
    for (let i = i0; i < D.length; i++) { const w = hasVol ? D[i].volume || 0 : 1; pv += (D[i].high + D[i].low + D[i].close) / 3 * w; vol += w; vals.push(vol ? pv / vol : null); }
    vwapCache.set(d, c = { D, key, vals });
  }
  return c.vals;
}
function drawOne(d, g, isDraft) {
  const a = toXY(d.a, g), b = toXY(d.b, g), c = d.c ? toXY(d.c, g) : null; if (!a || !b || (d.c && !c)) return;
  const sel = d === selected, col = isDraft ? '#8fb6ff' : C.accent, soft = 'rgba(76,141,255,.12)', H = [];
  ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = sel ? 2.5 : 1.5; ctx.setLineDash([]);
  const P = (x, y) => ({ x, y });
  const yOf = (price) => S.main.priceToCoordinate(price);
  const seg = (p, q, color) => { ctx.strokeStyle = color || col; ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke(); H.push([p.x, p.y, q.x, q.y]); };
  const dashed = (p, q, color) => { ctx.setLineDash([4, 4]); seg(p, q, color); ctx.setLineDash([]); };
  const far = (p, q) => { const dx = q.x - p.x, dy = q.y - p.y, l = Math.hypot(dx, dy); return l ? P(q.x + dx / l * 1e5, q.y + dy / l * 1e5) : q; }; // p -> q, carried on past the edge
  const poly = (pts, fill) => { ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath(); ctx.fillStyle = fill; ctx.fill(); };
  const box = (p, q, fill, stroke) => {
    ctx.fillStyle = fill; ctx.fillRect(p.x, p.y, q.x - p.x, q.y - p.y);
    if (stroke) { ctx.strokeStyle = stroke; ctx.strokeRect(p.x, p.y, q.x - p.x, q.y - p.y); }
    H.push({ x1: Math.min(p.x, q.x), y1: Math.min(p.y, q.y), x2: Math.max(p.x, q.x), y2: Math.max(p.y, q.y) });
  };
  const head = (p, q, color) => { // arrow head at q, pointing away from p
    const ang = Math.atan2(q.y - p.y, q.x - p.x), r = 9;
    poly([q, P(q.x - r * Math.cos(ang - 0.45), q.y - r * Math.sin(ang - 0.45)), P(q.x - r * Math.cos(ang + 0.45), q.y - r * Math.sin(ang + 0.45))], color || col);
  };
  const levels = (x1, list, priceAt) => list.forEach((f, i) => { // price levels running to the right edge
    const price = priceAt(f), y = yOf(price); if (y == null) return;
    const cc = PALETTE[i % PALETTE.length]; seg(P(x1, y), P(g.w, y), cc); label(`${+(f * 100).toFixed(1)}%  ${fmtP(price)}`, x1 + 2, y - 9, cc);
  });
  const up = d.b.price >= d.a.price, tone = up ? C.up : C.down, tint = up ? 'rgba(47,191,113,.13)' : 'rgba(240,82,79,.13)';
  const dp = d.b.price - d.a.price, la = timeToLogical(d.a.time), lb = timeToLogical(d.b.time), bars = Math.round(lb - la), xm = (a.x + b.x) / 2;
  let handles = [['a', a], ['b', b]]; if (c) handles.push(['c', c]);
  if (NPTS[d.type] === 1) handles = [['a', a]];

  switch (d.type) {
    case 'trend': seg(a, b); break;
    case 'ray': seg(a, far(a, b)); break;
    case 'extline': seg(far(b, a), far(a, b)); break;
    case 'arrow': seg(a, b); head(a, b); break;
    case 'hline': seg(P(0, a.y), P(g.w, a.y)); label(fmtP(d.a.price), g.w - 2, a.y, col, 'right'); break;
    case 'hray': seg(a, P(g.w, a.y)); label(fmtP(d.a.price), g.w - 2, a.y, col, 'right'); break;
    case 'vline': seg(P(a.x, 0), P(a.x, g.h)); break;
    case 'cross': seg(P(0, a.y), P(g.w, a.y)); seg(P(a.x, 0), P(a.x, g.h)); label(fmtP(d.a.price), g.w - 2, a.y, col, 'right'); break;
    case 'channel': {
      if (!c) break;
      const off = c.y - (a.x === b.x ? a.y : a.y + (b.y - a.y) * (c.x - a.x) / (b.x - a.x)); // how far the third point sits from the first line
      const a2 = P(a.x, a.y + off), b2 = P(b.x, b.y + off);
      poly([a, b, b2, a2], soft); seg(a, b); seg(a2, b2); dashed(P(a.x, a.y + off / 2), P(b.x, b.y + off / 2));
      break;
    }
    case 'regress': {
      const D = state.data; let i0 = Math.round(Math.min(la, lb)), i1 = Math.round(Math.max(la, lb));
      i0 = Math.max(0, i0); i1 = Math.min(D.length - 1, i1);
      if (i1 - i0 < 1) { dashed(a, b); break; }
      const v = []; for (let i = i0; i <= i1; i++) v.push(D[i].close);
      const r = linreg(v, 0, v.length - 1), x1 = g.x0 + i0 * g.sp, x2 = g.x0 + i1 * g.sp;
      const ln = [-2, 0, 2].map((k) => [yOf(r.icpt + k * r.sd), yOf(r.icpt + r.slope * (r.n - 1) + k * r.sd)]);
      if (ln.some((q) => q[0] == null || q[1] == null)) break;
      const pt = ln.map((q) => [P(x1, q[0]), P(x2, q[1])]);
      poly([pt[0][0], pt[0][1], pt[2][1], pt[2][0]], soft); seg(...pt[0]); seg(...pt[2]); dashed(...pt[1]);
      label(`R² ${r.r2.toFixed(2)}  ·  ±2σ ${fmtP(2 * r.sd)}  ·  ${r.n} ${t('bars')}`, x1 + 2, Math.min(pt[2][0].y, pt[2][1].y) - 10, col);
      break;
    }
    case 'pitchfork': {
      if (!c) break;
      const m = P((b.x + c.x) / 2, (b.y + c.y) / 2), dx = m.x - a.x, dy = m.y - a.y;
      seg(a, far(a, m)); seg(b, c);
      seg(b, far(b, P(b.x + dx, b.y + dy))); seg(c, far(c, P(c.x + dx, c.y + dy)));
      break;
    }
    case 'fib': dashed(a, b); levels(Math.min(a.x, b.x), FIBS, (f) => d.b.price + (d.a.price - d.b.price) * f); break; // 0% at the swing end
    case 'fibext': if (!c) break; dashed(a, b); dashed(b, c); levels(c.x, FIBX, (f) => d.c.price + (d.b.price - d.a.price) * f); break;
    case 'fibfan':
      dashed(a, b);
      [0.236, 0.382, 0.5, 0.618, 0.786].forEach((f, i) => {
        const q = P(b.x, b.y + (a.y - b.y) * f), cc = PALETTE[i % PALETTE.length];
        seg(a, far(a, q), cc); label(`${+(f * 100).toFixed(1)}%`, q.x + 2, q.y, cc);
      });
      seg(a, far(a, b)); break;
    case 'fibtime':
      FIBT.forEach((k, i) => {
        const x = g.x0 + (la + (lb - la) * k) * g.sp; if (x < -5 || x > g.w + 5) return;
        const cc = PALETTE[i % PALETTE.length]; seg(P(x, 0), P(x, g.h), cc); label(String(k), x + 2, 10, cc);
      });
      break;
    case 'gannfan':
      GANN.forEach(([r, name], i) => {
        const q = P(b.x, a.y + (b.y - a.y) * r), cc = r === 1 ? col : PALETTE[i % PALETTE.length];
        seg(a, far(a, q), cc);
        const at = r > 1 ? P(a.x + (b.x - a.x) / r, b.y) : q; label(name, at.x + 2, at.y, cc); // labels sit on the edge of the box a-b
      });
      break;
    case 'rect': box(a, b, soft, col); break;
    case 'ellipse':
      ctx.beginPath(); ctx.ellipse(xm, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, 7);
      ctx.fillStyle = soft; ctx.fill(); ctx.stroke(); box(a, b, 'transparent'); break;
    case 'triangle': if (!c) break; poly([a, b, c], soft); seg(a, b); seg(b, c); seg(c, a); break;
    case 'measure':
      box(a, b, tint, tone);
      label(`${dp >= 0 ? '+' : ''}${fmtP(dp)}  (${fmtPct(dp / d.a.price * 100)})  ·  ${bars} ${t('bars')}`, xm, Math.min(a.y, b.y) - 12, tone, 'center');
      break;
    case 'prange':
      box(a, b, tint); seg(P(a.x, a.y), P(b.x, a.y), tone); seg(P(a.x, b.y), P(b.x, b.y), tone); seg(P(xm, a.y), P(xm, b.y), tone); head(P(xm, a.y), P(xm, b.y), tone);
      label(`${dp >= 0 ? '+' : ''}${fmtP(dp)}  (${fmtPct(dp / d.a.price * 100)})`, xm, b.y + (up ? -12 : 12), tone, 'center');
      break;
    case 'drange':
      box(P(a.x, 0), P(b.x, g.h), soft); seg(P(a.x, 0), P(a.x, g.h)); seg(P(b.x, 0), P(b.x, g.h)); seg(a, P(b.x, a.y)); head(a, P(b.x, a.y));
      label(`${bars} ${t('bars')}  ·  ${span(d.b.time - d.a.time)}`, xm, a.y - 12, col, 'center');
      break;
    case 'position': {
      if (!c) break;
      const l = P(Math.min(a.x, b.x), a.y), r = P(Math.max(a.x, b.x), a.y);
      const gain = Math.abs(d.b.price - d.a.price), risk = Math.abs(d.c.price - d.a.price);
      box(l, P(r.x, b.y), 'rgba(47,191,113,.16)', C.up); box(l, P(r.x, c.y), 'rgba(240,82,79,.16)', C.down); seg(l, r);
      label(`${t('Target')} ${fmtP(d.b.price)}  (+${(gain / d.a.price * 100).toFixed(2)}%)`, xm, b.y + (b.y < a.y ? -10 : 10), C.up, 'center');
      label(`${t('Stop')} ${fmtP(d.c.price)}  (-${(risk / d.a.price * 100).toFixed(2)}%)`, xm, c.y + (c.y < a.y ? -10 : 10), C.down, 'center');
      label(`${t(up ? 'Long' : 'Short')} ${fmtP(d.a.price)}  ·  ${t('Risk : reward')} 1 : ${risk ? (gain / risk).toFixed(2) : '–'}`, xm, a.y, col, 'center');
      break;
    }
    case 'avwap': {
      const D = state.data, i0 = Math.max(0, Math.min(D.length - 1, Math.round(la))), vals = anchoredVwap(d, i0);
      let prev = null;
      for (let k = 0; k < vals.length; k++) {
        const x = g.x0 + (i0 + k) * g.sp, y = vals[k] == null ? null : yOf(vals[k]);
        const q = y == null ? null : P(x, y);
        if (q && prev && x > -g.sp && prev.x < g.w + g.sp) seg(prev, q);
        prev = q;
      }
      seg(P(a.x, a.y - 6), P(a.x, a.y + 6));
      if (prev) label(`VWAP ${fmtP(vals[vals.length - 1])}`, Math.min(prev.x + 4, g.w - 2), prev.y - 10, col, prev.x + 90 > g.w ? 'right' : 'left');
      break;
    }
    case 'text': {
      ctx.font = '13px system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      const w = ctx.measureText(d.text || '').width + 12;
      box(P(a.x, a.y - 11), P(a.x + w, a.y + 11), C.label, sel ? col : null);
      ctx.fillStyle = col; ctx.fillText(d.text || '', a.x + 6, a.y);
      break;
    }
  }
  if (!isDraft) hitMap.set(d, H);
  if (sel) {
    selHandles = handles.map(([k, p]) => ({ k, x: p.x, y: p.y }));
    ctx.fillStyle = C.handle; ctx.strokeStyle = col; ctx.lineWidth = 1.5;
    for (const [, h] of handles) { ctx.beginPath(); ctx.arc(h.x, h.y, 4, 0, 7); ctx.fill(); ctx.stroke(); }
  }
}
function frame() {
  requestAnimationFrame(frame);
  if (state.view !== 'chart') return;
  const w = stage.clientWidth, h = stage.clientHeight, dpr = window.devicePixelRatio || 1;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
  const g = geom(); if (!g) return;
  const items = list(); selHandles = [];
  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, g.w, g.h); ctx.clip();
  ctx.fillStyle = 'rgba(120,150,255,.09)'; // shade pre-market / after-hours stretches
  for (const [a, b] of state.extRuns) {
    const x1 = g.x0 + (a - 0.5) * g.sp, x2 = g.x0 + (b + 0.5) * g.sp;
    if (x2 > 0 && x1 < g.w) ctx.fillRect(x1, 0, x2 - x1, g.h);
  }
  const vp = S.inds.find((it) => it.vp); if (vp) drawProfile(g, vp);
  for (const d of items) drawOne(d, g, false);
  if (draft) drawOne(draft, g, true);
  ctx.restore();
}
// Volume profile: how much volume traded at each price among the bars on screen, as bars growing from the right edge
// (green = volume of rising bars, red = falling). Each bar's volume is spread evenly over its low-high range.
// POC (point of control) is the price level with the most volume.
let vpCache = { key: '' };
function drawProfile(g, it) {
  const r = chart.timeScale().getVisibleLogicalRange(); if (!r) return;
  const D = state.data, i0 = Math.max(0, Math.ceil(r.from)), i1 = Math.min(D.length - 1, Math.floor(r.to));
  if (i1 <= i0) return;
  const key = [i0, i1, D.length, D[0].time, D[D.length - 1].close, D[D.length - 1].volume].join('|');
  if (vpCache.key !== key) {
    const N = 48, up = new Array(N).fill(0), dn = new Array(N).fill(0);
    let lo = Infinity, hi = -Infinity;
    for (let i = i0; i <= i1; i++) { if (D[i].low < lo) lo = D[i].low; if (D[i].high > hi) hi = D[i].high; }
    const step = (hi - lo) / N, bin = (p) => Math.max(0, Math.min(N - 1, Math.floor((p - lo) / step)));
    let max = 0, poc = 0;
    if (step > 0) {
      for (let i = i0; i <= i1; i++) {
        const b = D[i], v = b.volume || 0; if (!v) continue;
        const a = bin(b.low), z = bin(b.high), share = v / (z - a + 1), into = b.close >= b.open ? up : dn;
        for (let k = a; k <= z; k++) into[k] += share;
      }
      for (let k = 0; k < N; k++) if (up[k] + dn[k] > max) { max = up[k] + dn[k]; poc = k; }
    }
    vpCache = { key, N, lo, step, up, dn, max, poc };
  }
  const c = vpCache;
  if (!c.max) { if (it.valEl) it.valEl.textContent = t('no volume data'); return; }
  const W = Math.min(280, g.w * 0.3), upC = rgba(C.up, 0.3), dnC = rgba(C.down, 0.3);
  for (let k = 0; k < c.N; k++) {
    const y1 = S.main.priceToCoordinate(c.lo + k * c.step), y2 = S.main.priceToCoordinate(c.lo + (k + 1) * c.step);
    if (y1 == null || y2 == null) continue;
    const top = Math.min(y1, y2), hgt = Math.max(1, Math.abs(y1 - y2) - 1), wu = c.up[k] / c.max * W, wd = c.dn[k] / c.max * W;
    ctx.fillStyle = upC; ctx.fillRect(g.w - wu - wd, top, wu, hgt);
    ctx.fillStyle = dnC; ctx.fillRect(g.w - wd, top, wd, hgt);
  }
  const pocPrice = c.lo + (c.poc + 0.5) * c.step, y = S.main.priceToCoordinate(pocPrice);
  if (y != null) {
    ctx.save(); ctx.strokeStyle = it.color; ctx.lineWidth = 1; ctx.setLineDash([5, 4]); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(g.w, y); ctx.stroke(); ctx.restore();
    label('POC ' + fmtP(pocPrice), g.w - W - 8, y, it.color, 'right');
  }
  if (it.valEl) it.valEl.textContent = 'POC ' + fmtP(pocPrice);
}

document.addEventListener('keydown', (e) => {
  if (/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
  if (e.key === 'Escape') { selected = null; fly.hidden = true; setTool('cursor'); }
  else if ((e.key === 'Delete' || e.key === 'Backspace') && selected) removeDrawings();
  else if (e.key === '/') { e.preventDefault(); symInput.focus(); }
});

// ---------------------------------------------------------------- watchlist
// state.watch is one ordered list; entries starting with "#" are section headings.
let watchData = new Map(), dragI = -1, renameI = -1;
const isSec = (s) => s[0] === '#';
const watchSymbols = () => state.watch.filter((s) => !isSec(s));
const collapsed = new Set(store.get('collapsed', []));
const saveWatch = () => store.set('watch', state.watch);
function renderWatch() {
  const ul = $('#wlist'); ul.textContent = '';
  let hide = false;
  state.watch.forEach((s, i) => {
    let li;
    const rm = el('button', { className: 'rm', textContent: '✕', title: t(isSec(s) ? 'Remove this heading (its symbols stay)' : 'Remove') });
    rm.addEventListener('click', (e) => { e.stopPropagation(); state.watch.splice(i, 1); saveWatch(); renderWatch(); });
    if (isSec(s)) {
      const name = s.slice(1); hide = collapsed.has(name);
      if (i === renameI) {
        const inp = el('input', { value: name, maxLength: 30 });
        const done = () => {
          if (renameI !== i) return;
          renameI = -1; const v = inp.value.trim().replace(/^#+/, '');
          if (v) state.watch[i] = '#' + v;
          saveWatch(); renderWatch();
        };
        inp.addEventListener('blur', done);
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); else if (e.key === 'Escape') { inp.value = name; inp.blur(); } });
        li = el('li', { className: 'sec' }, inp);
        setTimeout(() => { inp.focus(); inp.select(); });
      } else {
        const ed = el('button', { className: 'rm', textContent: '✎', title: t('Rename') });
        ed.addEventListener('click', (e) => { e.stopPropagation(); renameI = i; renderWatch(); });
        const add = el('button', { className: 'rm add', textContent: '+', title: t('Add {0} to this section', state.symbol) });
        add.addEventListener('click', (e) => { e.stopPropagation(); addWatch(state.symbol, name); });
        li = el('li', { className: 'sec', title: t('Click to collapse or expand · drag to move') }, el('span', { className: 'sn', textContent: (hide ? '▸ ' : '▾ ') + name }), add, ed, rm);
        li.addEventListener('click', () => { if (collapsed.has(name)) collapsed.delete(name); else collapsed.add(name); store.set('collapsed', [...collapsed]); renderWatch(); });
      }
    } else {
      if (hide) return;
      const r = watchData.get(s);
      li = el('li', { className: s === state.symbol ? 'on' : '' },
        el('span', { className: 's', textContent: s }, el('span', { className: 'nm', textContent: r ? r.name : '' })),
        el('span', { className: 'p', textContent: r ? fmtLast(r.last) : '…' }),
        el('span', { className: 'c ' + (r ? cls(r.chg) : ''), textContent: r ? fmtChg(r.chgAbs, r.last) : '' }),
        el('span', { className: 'c ' + (r ? cls(r.chg) : ''), textContent: r ? fmtPct(r.chg) : '' }), rm);
      if (state.ext && r && r.extPrice != null) { // second line: latest pre-market / after-hours price, change vs the regular close
        li.children[1].append(el('span', { className: 'x', textContent: t('ext ') + fmtLast(r.extPrice), title: t('Latest extended-hours price') }));
        li.children[2].append(el('span', { className: 'x ' + cls(r.extChg), textContent: fmtChg(r.extPrice - r.last, r.last), title: t('Change from the regular-session close') }));
        li.children[3].append(el('span', { className: 'x ' + cls(r.extChg), textContent: fmtPct(r.extChg), title: t('Change from the regular-session close') }));
      }
      li.addEventListener('click', () => setSymbol(s));
      li.addEventListener('contextmenu', (e) => { e.preventDefault(); openWatchMenu(s, e); });
      if (s === flashSym) { li.classList.add('flash'); requestAnimationFrame(() => li.scrollIntoView({ block: 'nearest' })); }
    }
    // drag to reorder, or to move a symbol under another heading
    li.draggable = i !== renameI;
    const below = (e) => e.clientY - li.getBoundingClientRect().top > li.offsetHeight / 2;
    li.addEventListener('dragstart', (e) => { dragI = i; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', s); });
    li.addEventListener('dragover', (e) => {
      if (dragI < 0 || dragI === i) return;
      e.preventDefault(); const b = below(e);
      li.classList.toggle('dropA', b); li.classList.toggle('dropB', !b);
    });
    li.addEventListener('dragleave', () => li.classList.remove('dropA', 'dropB'));
    li.addEventListener('drop', (e) => {
      e.preventDefault(); if (dragI < 0 || dragI === i) return;
      const after = below(e), [moved] = state.watch.splice(dragI, 1);
      state.watch.splice((dragI < i ? i - 1 : i) + (after ? 1 : 0), 0, moved);
      dragI = -1; saveWatch(); renderWatch();
    });
    li.addEventListener('dragend', () => { dragI = -1; });
    ul.append(li);
  });
}
async function refreshWatch(fresh = false) {
  const syms = watchSymbols();
  if (syms.length) {
    try { const j = await api('/api/screen?symbols=' + syms.map(encodeURIComponent).join(',') + (state.ext ? '&ext=1' : '') + (fresh === true ? '&fresh=1' : '')); if (!state.ext) watchData.clear(); for (const r of j.rows) watchData.set(r.symbol, r); } catch { /* keep stale values */ }
  }
  renderWatch();
}
// Sections are named by their heading; '' is the part of the list above the first heading.
let flashSym = null, flashTimer = 0; // the symbol just added or moved: highlighted briefly and scrolled into view
const watchSections = () => [...new Set(state.watch.filter(isSec).map((s) => s.slice(1)))];
const sectionLabel = (sec) => sec || t('Top of the list (no section)');
function sectionOf(sym) { // null when the symbol is not in the list
  let sec = '';
  for (const s of state.watch) { if (isSec(s)) sec = s.slice(1); else if (s === sym) return sec; }
  return null;
}
function defaultSection() { // the section last picked in the Add box; before that, the end of the list as it used to be
  const secs = watchSections(), want = store.get('addTo', null);
  if (want === '' || secs.includes(want)) return want;
  return secs.length ? secs[secs.length - 1] : '';
}
// Puts sym at the end of section sec, taking it out of wherever it was. Returns 'added', 'moved' or 'there'.
function addWatch(sym, sec = defaultSection()) {
  sym = String(sym).toUpperCase();
  if (sec && !state.watch.includes('#' + sec)) sec = '';
  const was = sectionOf(sym);
  if (was !== sec) {
    if (was !== null) state.watch.splice(state.watch.indexOf(sym), 1);
    const h = sec ? state.watch.indexOf('#' + sec) : -1;
    let at = state.watch.findIndex((s, i) => i > h && isSec(s));
    if (at < 0) at = state.watch.length;
    state.watch.splice(at, 0, sym);
    saveWatch();
  }
  if (sec && collapsed.has(sec)) { collapsed.delete(sec); store.set('collapsed', [...collapsed]); }
  flashSym = sym; clearTimeout(flashTimer); flashTimer = setTimeout(() => { flashSym = null; }, 1600);
  renderWatch(); if (was === null) refreshWatch();
  return was === null ? 'added' : was === sec ? 'there' : 'moved';
}
// right-click a symbol in the list: move it to another section, or remove it
function openWatchMenu(sym, e) {
  const cur = sectionOf(sym), items = [el('li', { className: 'head', textContent: t('Move {0} to', sym) })];
  for (const sec of ['', ...watchSections()]) {
    if (sec === cur) continue;
    const li = el('li', { textContent: '→ ' + sectionLabel(sec) });
    li.addEventListener('click', () => addWatch(sym, sec));
    items.push(li);
  }
  if (items.length === 1) items[0].textContent = t('Add a section to move symbols into it');
  const rm = el('li', { className: 'danger', textContent: '✕ ' + t('Remove from watchlist') });
  rm.addEventListener('click', () => { state.watch.splice(state.watch.indexOf(sym), 1); saveWatch(); renderWatch(); });
  items.push(rm);
  ctxMenu.textContent = ''; ctxMenu.append(...items); ctxMenu.hidden = false;
  const r = ctxMenu.getBoundingClientRect();
  ctxMenu.style.left = Math.max(4, Math.min(e.clientX, innerWidth - r.width - 8)) + 'px';
  ctxMenu.style.top = Math.max(4, Math.min(e.clientY, innerHeight - r.height - 8)) + 'px';
}
// "+ Add": a box under the header to search any symbol (or take the charted one) and choose its section
const wAddSel = el('select'), wAddChart = el('button'), wAddNote = el('p', { className: 'wnote' });
const wAdd = el('div', { id: 'wAdd', hidden: true },
  symbolSearch((sym) => wAddDo(sym)),
  el('label', { className: 'wrow' }, el('span', { textContent: t('Section') }), wAddSel),
  wAddChart, wAddNote);
$('#sideWatch .whead').after(wAdd);
function wAddDo(sym) {
  const sec = wAddSel.value; store.set('addTo', sec);
  const r = addWatch(sym, sec);
  wAddNote.textContent = t(r === 'added' ? '{0} added to {1}' : r === 'moved' ? '{0} moved to {1}' : '{0} is already in {1}', sym.toUpperCase(), sectionLabel(sec));
  wAddChart.textContent = '+ ' + t('Add {0} (on the chart)', state.symbol);
  wAdd.querySelector('input').focus();
}
function openWatchAdd() {
  const secs = watchSections(), def = defaultSection();
  wAddSel.textContent = '';
  for (const sec of ['', ...secs]) wAddSel.append(el('option', { value: sec, textContent: sectionLabel(sec), selected: sec === def }));
  wAddSel.disabled = !secs.length;
  wAddChart.textContent = '+ ' + t('Add {0} (on the chart)', state.symbol);
  wAddNote.textContent = TOUCH ? t('Tip: press and hold a symbol in the list to move it to another section.') : t('Tip: right-click a symbol in the list to move it to another section.');
  wAdd.hidden = false; wAdd.querySelector('input').focus();
}
wAddChart.addEventListener('click', () => wAddDo(state.symbol));
wAddSel.addEventListener('change', () => store.set('addTo', wAddSel.value));
wAdd.addEventListener('click', (e) => e.stopPropagation());
wAdd.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !e.defaultPrevented) wAdd.hidden = true; });
document.addEventListener('click', () => { wAdd.hidden = true; });
$('#addWatch').addEventListener('click', (e) => { e.stopPropagation(); if (wAdd.hidden) openWatchAdd(); else wAdd.hidden = true; });
$('#addSec').addEventListener('click', () => { state.watch.push('#' + t('New section')); renameI = state.watch.length - 1; saveWatch(); renderWatch(); $('#wlist').scrollTop = 1e6; });

// ---- import a watchlist exported as EXCHANGE:SYMBOL text and map it to this app's symbols
const EX_SUFFIX = { TSX: '.TO', TSXV: '.V', NEO: '.NE', LSE: '.L', HKEX: '.HK', TSE: '.T', SSE: '.SS', SZSE: '.SZ', XETR: '.DE', FWB: '.F', ASX: '.AX', NSE: '.NS', BSE: '.BO', TWSE: '.TW', KRX: '.KS', SGX: '.SI', SIX: '.SW', MIL: '.MI', BME: '.MC', OMXSTO: '.ST', BMFBOVESPA: '.SA' };
const INDEX_MAP = { SPX: '^GSPC', SPX500: '^GSPC', DJI: '^DJI', NDX: '^NDX', NDQ: '^NDX', IXIC: '^IXIC', RUT: '^RUT', VIX: '^VIX', HSI: '^HSI', NI225: '^N225', DAX: '^GDAXI', UKX: '^FTSE', DXY: 'DX-Y.NYB', GOLD: 'GC=F', SILVER: 'SI=F', USOIL: 'CL=F', UKOIL: 'BZ=F', XAUUSD: 'GC=F', XAGUSD: 'SI=F' };
const CRYPTO_EX = /^(BINANCE|BINANCEUS|COINBASE|BITSTAMP|KRAKEN|BYBIT|OKX|KUCOIN|BITFINEX|GEMINI|CRYPTO|CRYPTOCAP|MEXC|GATEIO|HTX|BITGET)$/;
const FX_EX = /^(FX|FX_IDC|OANDA|FOREXCOM|SAXO|PEPPERSTONE|ICMARKETS|CAPITALCOM|EIGHTCAP)$/;
const CCY = 'USD EUR JPY GBP AUD CAD CHF NZD CNH CNY HKD SGD SEK NOK MXN ZAR TRY INR KRW'.split(' ');
function mapSymbol(raw) {
  let s = raw.trim().toUpperCase();
  if (!s || s.startsWith('#')) return null; // "###Section" headers
  let ex = '';
  if (s.includes(':')) [ex, s] = s.split(':', 2);
  if (!s) return null;
  s = s.replace(/\.P$/, '').replace(/\.$/, ''); // perpetual-contract marker; trailing dot as in LSE "RR."
  if (!s) return null;
  if (INDEX_MAP[s]) return INDEX_MAP[s];
  const fut = s.match(/^([A-Z0-9]{1,4})[12]!$/); // continuous futures, e.g. ES1!
  if (fut) return fut[1] + '=F';
  const fxPair = s.length === 6 && CCY.includes(s.slice(0, 3)) && CCY.includes(s.slice(3));
  if (FX_EX.test(ex) || (!ex && fxPair)) return fxPair ? s + '=X' : INDEX_MAP[s] || s;
  if (CRYPTO_EX.test(ex) || (!ex && /^[A-Z0-9]{2,6}USDT$/.test(s))) {
    const m = s.match(/^([A-Z0-9]+?)(USDT|USDC|USD|PERP)$/);
    return m ? m[1] + '-USD' : s;
  }
  if (EX_SUFFIX[ex]) {
    if (ex === 'HKEX' && /^\d+$/.test(s)) s = s.padStart(4, '0');
    return s.replace(/[./]/g, '-') + EX_SUFFIX[ex];
  }
  s = s.replace(/[./]/g, '-'); // BRK.B -> BRK-B
  return /^[A-Z0-9.\-=^]{1,20}$/.test(s) ? s : null;
}
const impDlg = $('#impDlg'), impText = $('#impText'), impInfo = $('#impInfo');
$('#impWatch').addEventListener('click', () => { impText.value = ''; $('#impFile').value = ''; impInfo.textContent = ''; impDlg.showModal(); });
$('#impCancel').addEventListener('click', () => impDlg.close());
$('#impFile').addEventListener('change', async (e) => { const f = e.target.files[0]; if (f) impText.value = await f.text(); });
$('#impGo').addEventListener('click', () => {
  const out = $('#impReplace').checked ? [] : state.watch.slice();
  const seen = new Set(out);
  let added = 0;
  for (const part of impText.value.split(/[,;\n]+/)) {
    const p = part.trim();
    if (p.startsWith('###')) { // section heading, kept as-is (may contain spaces)
      const h = '#' + p.slice(3).trim().slice(0, 30);
      if (h.length > 1 && !seen.has(h)) { out.push(h); seen.add(h); }
      continue;
    }
    for (const sym of p.split(/\s+/).map(mapSymbol)) if (sym && !seen.has(sym)) { out.push(sym); seen.add(sym); added++; }
  }
  if (!added) { impInfo.textContent = t('No new symbols found — choose a file or paste a list first.'); return; }
  state.watch = out.slice(0, 150);
  saveWatch();
  impDlg.close(); refreshWatch();
});

// ---------------------------------------------------------------- IBKR positions (read-only)
// Data comes from the local server, which reads IBKR's Client Portal Gateway. Nothing here can trade.
let ib = null, ibTimer = 0, ibLines = [], side = 'watch';
const money = (v, ccy) => v == null ? '–' : fmtP(v, 2) + (ccy ? ' ' + ccy : '');
const signed = (v) => v == null ? '–' : (v > 0 ? '+' : '') + fmtP(v, 2);
async function refreshIb() {
  clearTimeout(ibTimer);
  try { ib = await api('/api/ibkr'); } catch { ib = { state: 'unreachable' }; }
  renderIb(); drawIbLines();
  // connected: poll every 15 s (this also keeps the gateway session alive). Otherwise only re-check while the tab is open.
  const delay = ib.state === 'ok' ? 15000 : side === 'pos' ? 60000 : 0;
  if (delay) ibTimer = setTimeout(refreshIb, delay);
}
function renderIb() {
  const box = $('#sidePos'); box.textContent = '';
  $('#ibDot').hidden = !(ib && ib.state === 'ok');
  if (!ib) { box.append(el('p', { textContent: t('Checking…') })); return; }
  if (ib.state !== 'ok') {
    const retry = el('button', { className: 'primary', textContent: t('Retry') });
    retry.addEventListener('click', () => { ib = null; renderIb(); refreshIb(); });
    if (ib.state === 'login') {
      box.append(el('p', { textContent: t('The IBKR gateway is running, but you are not logged in.') }),
        el('p', {}, el('a', { href: 'https://localhost:5000', target: '_blank', rel: 'noopener', textContent: t('Open the gateway login page') })), retry);
    } else {
      const steps = el('ol');
      for (const s of ['Download the Client Portal Gateway from IBKR and unzip it. It needs Java.', 'Start it from its folder: bin\\run.bat root\\conf.yaml', 'Log in at https://localhost:5000 in your browser. A certificate warning there is expected.', 'Come back here and press Retry.']) steps.append(el('li', { textContent: t(s) }));
      box.append(el('p', { textContent: t('Not connected to Interactive Brokers.') }), steps, retry);
    }
    box.append(el('p', { textContent: t('Read-only: this app shows your positions and orders. It cannot place, change or cancel orders.') }));
    box.lastChild.style.marginTop = '12px';
    return;
  }
  const a = ib.account, s = ib.summary || {};
  box.append(el('div', { className: 'ibhead' }, el('span', { textContent: a.alias || a.id }),
    el('span', { className: 'badge ' + (a.paper ? 'paper' : 'live'), textContent: t(a.paper ? 'PAPER' : 'LIVE') }), el('span', { className: 'badge ro', textContent: t('Read-only') })));
  const sum = el('div', { className: 'ibsum' });
  const row = (label, val, colour) => { if (val == null) return; sum.append(el('span', { textContent: t(label) }), el('span', { className: colour ? cls(val) : '', textContent: colour ? signed(val) : money(val, a.currency) })); };
  row('Net liquidation', s.netLiq); row('Day P&L', s.dayPnl, true); row('Unrealized P&L', s.unrealizedPnl, true); row('Cash', s.cash); row('Buying power', s.buyingPower);
  box.append(sum, el('h4', { textContent: t('Positions') }));
  if (!ib.positions.length) box.append(el('p', { textContent: t('No open positions.') }));
  for (const p of ib.positions) {
    const r = el('div', { className: 'ibrow' + (p.chart ? ' link' : '') + (p.chart && p.chart === state.symbol ? ' on' : '') },
      el('div', {}, el('b', { textContent: (p.assetClass === 'STK' ? p.symbol : p.desc) || p.symbol }), el('small', { textContent: `${p.qty} @ ${p.avgPrice == null ? '–' : fmtP(p.avgPrice, 2)}` })),
      el('div', { className: 'r' }, el('span', { textContent: money(p.mktValue, p.currency) }), el('small', { className: cls(p.unrealizedPnl), textContent: signed(p.unrealizedPnl) })));
    if (p.chart) r.addEventListener('click', () => setSymbol(p.chart));
    box.append(r);
  }
  box.append(el('h4', { textContent: t('Open orders') }));
  if (!ib.brokerage) box.append(el('p', { textContent: t('Open orders and day P&L appear only while a trading session is active in the gateway. This app never starts one, so a TWS or mobile login is not interrupted.') }));
  else if (!ib.orders.length) box.append(el('p', { textContent: t('No open orders.') }));
  for (const o of ib.orders) {
    const r = el('div', { className: 'ibrow' + (o.chart ? ' link' : '') },
      el('div', {}, el('b', { className: o.side === 'BUY' ? 'up' : 'down', textContent: `${o.side} ${o.symbol}` }), el('small', { textContent: o.desc || o.type })),
      el('div', { className: 'r' }, el('span', { textContent: o.price == null ? o.type : fmtP(o.price, 2) }), el('small', { textContent: o.status || '' })));
    if (o.chart) r.addEventListener('click', () => setSymbol(o.chart));
    box.append(r);
  }
}
// dashed lines on the chart: average cost of a held position, and the price of each working order
function drawIbLines() {
  for (const l of ibLines) if (l.series === S.main) { try { l.series.removePriceLine(l.line); } catch { /* already gone */ } } // lines on a rebuilt chart went with it
  ibLines = [];
  if (!S.main) return;
  const add = (price, color, title) => { if (price > 0) ibLines.push({ series: S.main, line: S.main.createPriceLine({ price, color, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title }) }); };
  if (ib && ib.state === 'ok') {
    for (const p of ib.positions) if (p.chart === state.symbol) add(p.avgPrice, C.cost, `${t('Avg cost')} · ${p.qty}`);
    for (const o of ib.orders) if (o.chart === state.symbol) add(o.price, o.side === 'BUY' ? C.up : C.down, `${o.side} ${o.remaining == null ? '' : o.remaining} ${o.type}`.replace(/\s+/g, ' '));
  }
  const pp = state.paper.pos[state.symbol]; // the practice account's lines
  if (pp) add(pp.avg, C.cost, `${t('Paper')} · ${t('Avg cost')} · ${fmtQty(pp.qty)}`);
  for (const o of state.paper.orders) if (o.sym === state.symbol) add(o.price, o.side === 'BUY' ? C.up : C.down, `${t('Paper')} · ${t(o.side === 'BUY' ? 'Buy' : 'Sell')} ${fmtQty(o.qty)} ${t(ORDER_TYPES[o.type])}`);
  for (const a of state.alerts) if (!a.hit && a.sym === state.symbol && kindOf(a) === 'price') add(a.price, ALERT_COLOR, '🔔 ' + t('Alert'));
}
for (const b of $('#sideTabs').children) {
  b.addEventListener('click', () => {
    side = b.dataset.side;
    for (const x of $('#sideTabs').children) x.classList.toggle('on', x === b);
    $('#sideWatch').hidden = side !== 'watch'; $('#sidePos').hidden = side !== 'pos'; $('#sidePaper').hidden = side !== 'paper'; $('#sideAlerts').hidden = side !== 'alerts';
    if (side === 'alerts') { renderAlerts(); paperTick(); }
    if (side === 'pos' && (!ib || ib.state !== 'ok')) { renderIb(); refreshIb(); }
    if (side === 'paper') { renderPaper(); paperTick(); }
  });
}

// ---------------------------------------------------------------- paper trading (practice account)
// Virtual money only: orders are filled here in the page at the latest price the app has. Nothing is sent to a broker.
const ORDER_TYPES = { MKT: 'Market', LMT: 'Limit', STP: 'Stop' };
const paperQ = new Map(); // latest price of symbols that are held or have an order but are not on the chart
const fmtQty = (q) => String(+q.toFixed(4));
const savePaper = () => store.set('paper', state.paper);
function paperPrice(sym) {
  if (sym === state.symbol && state.raw.length) return state.raw[state.raw.length - 1].close;
  const r = watchData.get(sym);
  return paperQ.get(sym) ?? (r && r.last != null ? r.last : null);
}
function paperTotals() {
  let equity = state.paper.cash, unreal = 0, gross = 0;
  for (const [s, p] of Object.entries(state.paper.pos)) { const px = paperPrice(s) ?? p.avg; equity += p.qty * px; unreal += (px - p.avg) * p.qty; gross += Math.abs(p.qty * px); }
  return { equity, unreal, gross };
}
// No borrowing: after the order, the value of everything held (long or short) may not exceed the account's equity.
function paperBlock(sym, sideName, qty, price) {
  const cur = (state.paper.pos[sym] || { qty: 0 }).qty, next = cur + (sideName === 'BUY' ? qty : -qty);
  if (Math.abs(next) <= Math.abs(cur)) return null; // only reduces a position
  const { equity, gross } = paperTotals(), after = gross - Math.abs(cur * price) + Math.abs(next * price);
  return after > equity + 1e-6 ? t('Not enough buying power: positions would be worth {0}, the account {1}.', fmtP(after, 2), fmtP(equity, 2)) : null;
}
function paperFill(sym, sideName, qty, price, type) {
  const P = state.paper, q = sideName === 'BUY' ? qty : -qty, cur = P.pos[sym] || { qty: 0, avg: 0 };
  let pnl = null;
  if (cur.qty && Math.sign(cur.qty) !== Math.sign(q)) { // closes all or part of the position; anything beyond that opens the other way
    const closed = Math.min(Math.abs(q), Math.abs(cur.qty)), left = cur.qty + q;
    pnl = (price - cur.avg) * closed * Math.sign(cur.qty); P.realized += pnl;
    if (Math.sign(left) !== Math.sign(cur.qty)) cur.avg = price;
    cur.qty = left;
  } else { cur.avg = (cur.avg * cur.qty + price * q) / (cur.qty + q); cur.qty += q; }
  P.cash -= q * price;
  if (Math.abs(cur.qty) < 1e-9) delete P.pos[sym]; else P.pos[sym] = cur;
  P.trades.push({ time: Math.floor(Date.now() / 1000), sym, side: sideName, qty, price, type, pnl });
  if (P.trades.length > 300) P.trades.splice(0, P.trades.length - 300);
}
let paperBusy = false, paperNote = '';
// With several app windows open, only one of them fills working orders and fires alerts, so nothing happens twice.
// The browser hands the lock to another window when that one closes. Without the Locks API every window does it.
let paperLeader = !(navigator.locks && navigator.locks.request);
if (!paperLeader && !EMBED) {
  navigator.locks.request('investorview-paper', () => { paperLeader = true; return new Promise(() => {}); }).catch(() => { paperLeader = true; });
}
// Account value over time: one point an hour while the app is open, and one at every fill. The curve adds the value right now.
function paperSnap(force) {
  const P = state.paper, now = Math.floor(Date.now() / 1000);
  if (!Array.isArray(P.eq) || !P.eq.length) P.eq = [[P.trades.length ? P.trades[0].time - 1 : now, P.start]];
  if (!force && now - P.eq[P.eq.length - 1][0] < 3600) return false;
  P.eq.push([now, +paperTotals().equity.toFixed(2)]);
  if (P.eq.length > 2000) P.eq.splice(1, P.eq.length - 2000); // the starting point stays
  return true;
}
function paperStats() {
  const P = state.paper, closed = P.trades.filter((x) => x.pnl != null), wins = closed.filter((x) => x.pnl > 0), losses = closed.filter((x) => x.pnl < 0);
  const sum = (a) => a.reduce((s, x) => s + x.pnl, 0), sw = sum(wins), sl = sum(losses);
  const pts = [...(P.eq || []), [Math.floor(Date.now() / 1000), paperTotals().equity]];
  let peak = -Infinity, dd = 0;
  for (const [, v] of pts) { if (v > peak) peak = v; if (peak > 0 && (peak - v) / peak > dd) dd = (peak - v) / peak; }
  const by = new Map(); for (const x of closed) by.set(x.sym, (by.get(x.sym) || 0) + x.pnl);
  return { pts, n: closed.length, winRate: closed.length ? wins.length / closed.length * 100 : null, avgWin: wins.length ? sw / wins.length : null, avgLoss: losses.length ? sl / losses.length : null,
    factor: sl < 0 ? sw / -sl : null, best: closed.length ? Math.max(...closed.map((x) => x.pnl)) : null, worst: closed.length ? Math.min(...closed.map((x) => x.pnl)) : null,
    dd: dd * 100, by: [...by.entries()].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 6) };
}
function equitySvg(pts, start) {
  const NS = 'http://www.w3.org/2000/svg', W = 300, H = 84, pad = 6;
  const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('preserveAspectRatio', 'none'); svg.setAttribute('class', 'eqcurve');
  const t0 = pts[0][0], t1 = pts[pts.length - 1][0], vs = pts.map((p) => p[1]).concat(start), lo = Math.min(...vs), hi = Math.max(...vs);
  const X = (tm) => (t1 > t0 ? pad + (tm - t0) / (t1 - t0) * (W - 2 * pad) : W / 2), Y = (v) => (hi > lo ? H - pad - (v - lo) / (hi - lo) * (H - 2 * pad) : H / 2);
  const add = (tag, attrs) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); svg.append(n); };
  add('line', { x1: 0, x2: W, y1: Y(start), y2: Y(start), stroke: C.border2, 'stroke-dasharray': '4 4', 'vector-effect': 'non-scaling-stroke' }); // the starting cash
  add('polyline', { points: pts.map((p) => X(p[0]).toFixed(1) + ',' + Y(p[1]).toFixed(1)).join(' '), fill: 'none', stroke: pts[pts.length - 1][1] >= start ? C.up : C.down, 'stroke-width': 1.6, 'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke' });
  return svg;
}
async function paperTick(own) { // refresh prices, then fill limit and stop orders whose price was reached
  if (paperBusy) return; paperBusy = true;
  const lead = paperLeader || own === true; // own: right after an order placed in this window
  try {
    const P = state.paper, waiting = state.alerts.filter((a) => !a.hit);
    const syms = [...new Set([...Object.keys(P.pos), ...P.orders.map((o) => o.sym), ...waiting.map((a) => a.sym)])]
      .filter((s) => s !== state.symbol || waiting.some((a) => a.sym === s && DAILY_KINDS.has(kindOf(a)))); // the charted symbol's price comes from the chart
    if (syms.length) {
      try { const j = await api('/api/screen?symbols=' + syms.map(encodeURIComponent).join(',')); for (const r of j.rows) { if (r.last != null) paperQ.set(r.symbol, r.last); paperRows.set(r.symbol, r); } } catch { /* keep the last known prices */ }
    }
    if (paperLeader) await loadLineBars(waiting);
    let changed = false;
    if (lead) for (const o of [...P.orders]) {
      const px = paperPrice(o.sym); if (px == null) continue;
      const below = (o.type === 'LMT') === (o.side === 'BUY'); // buy limit and sell stop wait for a lower price
      if (below ? px > o.price : px < o.price) continue;
      P.orders = P.orders.filter((x) => x !== o); changed = true;
      const err = paperBlock(o.sym, o.side, o.qty, px);
      if (err) paperNote = t('Order for {0} cancelled.', o.sym) + ' ' + err;
      else { paperFill(o.sym, o.side, o.qty, px, o.type); paperNote = t('Filled: {0} {1} {2} at {3}', t(o.side === 'BUY' ? 'Buy' : 'Sell'), fmtQty(o.qty), o.sym, fmtLast(px)); }
    }
    if (lead) {
      if (paperSnap(changed) || changed) { savePaper(); drawIbLines(); }
      if (paperLeader) checkAlerts();
    }
    if (side === 'paper') renderPaper();
    if (side === 'alerts') renderAlerts();
  } finally { paperBusy = false; }
}
function paperOrder(sym, sideName, qty, type, limit) {
  const px = paperPrice(sym);
  if (!(qty > 0)) return t('Enter a quantity above zero.');
  if (type === 'MKT') {
    if (px == null) return t('No price for {0} yet.', sym);
    const err = paperBlock(sym, sideName, qty, px); if (err) return err;
    paperFill(sym, sideName, qty, px, 'MKT');
    paperNote = t('Filled: {0} {1} {2} at {3}', t(sideName === 'BUY' ? 'Buy' : 'Sell'), fmtQty(qty), sym, fmtLast(px));
  } else {
    if (!(limit > 0)) return t('Enter the order price.');
    if (state.paper.orders.length >= 100) return t('Too many working orders.');
    state.paper.orders.push({ id: Date.now(), sym, side: sideName, qty, type, price: limit, time: Math.floor(Date.now() / 1000) });
    paperNote = t('Order placed: {0} {1} {2}, {3} at {4}', t(sideName === 'BUY' ? 'Buy' : 'Sell'), fmtQty(qty), sym, t(ORDER_TYPES[type]), fmtLast(limit));
  }
  if (type === 'MKT') paperSnap(true);
  savePaper(); drawIbLines(); renderPaper();
  if (type !== 'MKT') paperTick(true); // fills at once if the price is already there
  return null;
}
let paperUI = null;
function buildPaper() { // the fixed part of the tab: summary, order ticket and the three lists; renderPaper fills in the numbers
  const box = $('#sidePaper');
  const reset = el('button', { textContent: t('Reset'), title: t('Start over with a fresh practice account') });
  reset.addEventListener('click', () => {
    const v = prompt(t('Starting cash for the new practice account:'), String(state.paper.start)); if (v == null) return;
    const start = Math.min(1e12, Math.max(100, +String(v).replace(/[, ]/g, '') || 100000));
    state.paper = { start, cash: start, realized: 0, pos: {}, orders: [], trades: [], eq: [[Math.floor(Date.now() / 1000), start]] }; paperNote = '';
    savePaper(); drawIbLines(); renderPaper();
  });
  const ui = { sum: el('div', { className: 'ibsum' }), sym: el('b'), last: el('span'), qty: el('input', { type: 'number', min: '0', step: 'any', value: String(store.get('paperQty', 10)) }),
    type: el('select'), price: el('input', { type: 'number', min: '0', step: 'any', placeholder: t('Price'), hidden: true }),
    buy: el('button', { className: 'buy', textContent: t('Buy') }), sell: el('button', { className: 'sell', textContent: t('Sell') }), note: el('p', { className: 'pnote' }),
    pos: el('div'), orders: el('div'), trades: el('div'), perf: el('div') };
  for (const [k, name] of Object.entries(ORDER_TYPES)) ui.type.append(el('option', { value: k, textContent: t(name) }));
  ui.type.addEventListener('change', () => { ui.price.hidden = ui.type.value === 'MKT'; if (!ui.price.hidden && !ui.price.value) { const px = paperPrice(state.symbol); if (px != null) ui.price.value = String(+px.toFixed(px < 10 ? 4 : 2)); } });
  ui.qty.addEventListener('change', () => store.set('paperQty', +ui.qty.value || 10));
  const go = (sideName) => { const err = paperOrder(state.symbol, sideName, +ui.qty.value, ui.type.value, +ui.price.value); if (err) { paperNote = err; renderPaper(); } };
  ui.buy.addEventListener('click', () => go('BUY')); ui.sell.addEventListener('click', () => go('SELL'));
  box.append(
    el('div', { className: 'ibhead' }, el('span', { textContent: t('Practice account') }), el('span', { className: 'badge paper', textContent: t('PAPER') }), el('span', { className: 'grow' }), reset),
    ui.sum,
    el('h4', { textContent: t('Order') }),
    el('div', { className: 'ticket' }, symbolSearch((sym) => { paperNote = ''; setSymbol(sym, true); renderPaper(); }),
      el('div', { className: 'trow head' }, ui.sym, ui.last),
      el('div', { className: 'trow' }, el('label', {}, el('span', { textContent: t('Quantity') }), ui.qty)),
      el('div', { className: 'trow' }, ui.type, ui.price),
      el('div', { className: 'trow' }, ui.buy, ui.sell), ui.note),
    el('h4', { textContent: t('Positions') }), ui.pos, el('h4', { textContent: t('Working orders') }), ui.orders, el('h4', { textContent: t('Performance') }), ui.perf, el('h4', { textContent: t('History') }), ui.trades,
    el('p', { className: 'pfoot', textContent: t('Virtual money only: nothing is sent to a broker. Orders fill at the latest price this app has, also when the market is closed. Limit and stop orders are checked about every 20 seconds while the app is open. Prices are not converted between currencies.') }));
  return ui;
}
function renderPaper() {
  if (side !== 'paper') return;
  const ui = (paperUI ||= buildPaper()), P = state.paper, { equity, unreal } = paperTotals();
  ui.sum.textContent = '';
  const row = (label, text, tone) => ui.sum.append(el('span', { textContent: t(label) }), el('span', { className: tone == null ? '' : cls(tone), textContent: text }));
  row('Account value', fmtP(equity, 2)); row('Cash', fmtP(P.cash, 2)); row('Unrealized P&L', signed(unreal), unreal); row('Realized P&L', signed(P.realized), P.realized);
  row('Return', fmtPct((equity / P.start - 1) * 100), equity - P.start);
  const px = paperPrice(state.symbol);
  ui.sym.textContent = state.symbol; ui.last.textContent = px == null ? '–' : fmtLast(px);
  ui.note.textContent = paperNote; ui.note.hidden = !paperNote;
  const empty = (box, text) => box.append(el('p', { textContent: t(text) }));
  ui.pos.textContent = '';
  if (!Object.keys(P.pos).length) empty(ui.pos, 'No open positions.');
  for (const [sym, p] of Object.entries(P.pos)) {
    const last = paperPrice(sym), pnl = last == null ? null : (last - p.avg) * p.qty;
    const close = el('button', { className: 'mini', textContent: t('Close'), title: t('Close this position at the latest price') });
    close.addEventListener('click', (e) => { e.stopPropagation(); const err = paperOrder(sym, p.qty > 0 ? 'SELL' : 'BUY', Math.abs(p.qty), 'MKT'); if (err) { paperNote = err; renderPaper(); } });
    const r = el('div', { className: 'ibrow link' + (sym === state.symbol ? ' on' : '') },
      el('div', {}, el('b', { textContent: sym }), el('small', { textContent: `${fmtQty(p.qty)} @ ${fmtLast(p.avg)}` })),
      el('div', { className: 'r' }, el('span', { textContent: last == null ? '–' : fmtP(p.qty * last, 2) }),
        el('small', { className: cls(pnl), textContent: pnl == null ? '–' : `${signed(pnl)}  (${fmtPct(pnl / Math.abs(p.avg * p.qty) * 100)})` }), close));
    r.addEventListener('click', () => setSymbol(sym));
    ui.pos.append(r);
  }
  ui.orders.textContent = '';
  if (!P.orders.length) empty(ui.orders, 'No open orders.');
  for (const o of P.orders) {
    const cancel = el('button', { className: 'mini', textContent: t('Cancel') });
    cancel.addEventListener('click', (e) => { e.stopPropagation(); P.orders = P.orders.filter((x) => x !== o); savePaper(); drawIbLines(); renderPaper(); });
    const r = el('div', { className: 'ibrow link' },
      el('div', {}, el('b', { className: o.side === 'BUY' ? 'up' : 'down', textContent: `${t(o.side === 'BUY' ? 'Buy' : 'Sell')} ${o.sym}` }), el('small', { textContent: `${fmtQty(o.qty)} · ${t(ORDER_TYPES[o.type])}` })),
      el('div', { className: 'r' }, el('span', { textContent: fmtLast(o.price) }), cancel));
    r.addEventListener('click', () => setSymbol(o.sym));
    ui.orders.append(r);
  }
  const st = paperStats(); ui.perf.textContent = '';
  if (st.pts.length > 2 || st.pts[st.pts.length - 1][1] !== P.start) ui.perf.append(equitySvg(st.pts, P.start)); else empty(ui.perf, 'The account value curve appears here once the account has been used.');
  const grid = el('div', { className: 'ibsum' }), stat = (label, text, tone) => grid.append(el('span', { textContent: t(label) }), el('span', { className: tone == null ? '' : cls(tone), textContent: text }));
  stat('Max drawdown', st.dd ? '-' + st.dd.toFixed(2) + '%' : '0.00%', st.dd ? -1 : null);
  stat('Closed trades', String(st.n));
  if (st.n) {
    stat('Win rate', st.winRate.toFixed(0) + '%');
    stat('Average win', st.avgWin == null ? '–' : signed(st.avgWin), st.avgWin); stat('Average loss', st.avgLoss == null ? '–' : signed(st.avgLoss), st.avgLoss);
    stat('Profit factor', st.factor == null ? '–' : st.factor.toFixed(2));
    stat('Best trade', signed(st.best), st.best); stat('Worst trade', signed(st.worst), st.worst);
  }
  ui.perf.append(grid);
  if (st.by.length) {
    const by = el('div', { className: 'bysym' });
    for (const [sym, pnl] of st.by) by.append(el('span', { className: 'muted', textContent: t('Realized P&L') + ' · ' + sym }), el('span', { className: cls(pnl), textContent: signed(pnl) }));
    ui.perf.append(by);
  }
  ui.trades.textContent = '';
  if (!P.trades.length) empty(ui.trades, 'No trades yet.');
  for (const tr of P.trades.slice(-30).reverse()) {
    const when = new Date(tr.time * 1000);
    ui.trades.append(el('div', { className: 'ibrow' },
      el('div', {}, el('b', { className: tr.side === 'BUY' ? 'up' : 'down', textContent: `${t(tr.side === 'BUY' ? 'Buy' : 'Sell')} ${tr.sym}` }), el('small', { textContent: `${when.toLocaleDateString()} ${when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` })),
      el('div', { className: 'r' }, el('span', { textContent: `${fmtQty(tr.qty)} @ ${fmtLast(tr.price)}` }), el('small', { className: cls(tr.pnl), textContent: tr.pnl == null ? '' : signed(tr.pnl) }))));
  }
}

// ---------------------------------------------------------------- screener
const UNIVERSES = {
  'US large caps': 'AAPL MSFT NVDA GOOGL AMZN META TSLA AVGO BRK-B LLY JPM V UNH XOM MA COST HD PG JNJ WMT NFLX ABBV BAC CRM ORCL KO CVX MRK AMD PEP ADBE TMO LIN CSCO ACN MCD ABT WFC IBM GE QCOM DIS INTC CAT VZ TXN PFE UBER BA',
  'ETFs & sectors': 'SPY QQQ IWM DIA VTI EFA EEM XLK XLF XLE XLV XLY XLP XLI XLU XLB XLRE XLC GLD SLV TLT HYG ARKK SMH',
  'Crypto': 'BTC-USD ETH-USD SOL-USD BNB-USD XRP-USD ADA-USD DOGE-USD AVAX-USD LINK-USD DOT-USD LTC-USD BCH-USD TRX-USD ATOM-USD',
  'FX & commodities': 'EURUSD=X GBPUSD=X USDJPY=X AUDUSD=X USDCAD=X USDCHF=X NZDUSD=X GC=F SI=F CL=F NG=F HG=F',
  'Japan large caps (Tokyo)': '7203.T 6758.T 9984.T 8306.T 6861.T 9983.T 8035.T 6501.T 7974.T 9432.T 6098.T 4063.T 8058.T 7267.T 6367.T 4502.T 8316.T 6902.T 8001.T 9433.T 7741.T 6954.T 4568.T 8031.T 6273.T',
  'My watchlist': null,
  'Custom list…': null,
};
const PRESETS = {
  'None': {},
  'Oversold (RSI < 30)': { rsiMax: 30 },
  'Overbought (RSI > 70)': { rsiMin: 70 },
  'Uptrend (above SMA 50 & 200)': { above50: true, above200: true },
  'Volume spike (≥ 1.5× average)': { relVolMin: 1.5 },
  'Near 52-week high (within 3%)': { nearHigh: 3 },
  'Top gainers (≥ +2%)': { chgMin: 2 },
  'Top losers (≤ −2%)': { chgMax: -2 },
};
const COLS = [
  ['symbol', 'Symbol', 'l'], ['name', 'Name', 'l'], ['last', 'Last'], ['chgAbs', 'Chg'], ['chg', 'Chg %'], ['volume', 'Volume'], ['relVol', 'Rel vol'],
  ['rsi', 'RSI 14'], ['vs50', 'vs SMA 50'], ['vs200', 'vs SMA 200'], ['fromHigh', 'From 52w high'], ['w1', '1W'], ['m1', '1M'], ['m3', '3M'], ['spark', '30 days'], ['act', ''],
];
let rows = [], scanErrors = [], sort = { key: 'chg', dir: -1 }, scanSeq = 0;
const uniSel = $('#uni'), presetSel = $('#preset'), customInp = $('#uniCustom');
for (const k of Object.keys(UNIVERSES)) uniSel.append(el('option', { textContent: t(k), value: k }));
for (const k of Object.keys(PRESETS)) presetSel.append(el('option', { textContent: t(k), value: k }));
uniSel.value = store.get('universe', 'US large caps'); if (!uniSel.value) uniSel.selectedIndex = 0;
customInp.value = store.get('custom', '');
const fInputs = [...document.querySelectorAll('#filters [data-f]')];

function universeSymbols() {
  const k = uniSel.value;
  if (k === 'My watchlist') return watchSymbols();
  if (k === 'Custom list…') return customInp.value.split(/[\s,;]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
  return UNIVERSES[k].split(' ');
}
function filters() {
  const f = {};
  for (const i of fInputs) f[i.dataset.f] = i.type === 'checkbox' ? i.checked : i.value === '' ? null : Number(i.value);
  return f;
}
function passes(r, f) {
  const ge = (v, min) => min == null || (v != null && v >= min), le = (v, max) => max == null || (v != null && v <= max);
  return ge(r.last, f.priceMin) && le(r.last, f.priceMax) && ge(r.chg, f.chgMin) && le(r.chg, f.chgMax)
    && ge(r.rsi, f.rsiMin) && le(r.rsi, f.rsiMax) && ge(r.relVol, f.relVolMin)
    && (f.nearHigh == null || (r.fromHigh != null && r.fromHigh >= -f.nearHigh))
    && (!f.above50 || (r.vs50 != null && r.vs50 > 0)) && (!f.above200 || (r.vs200 != null && r.vs200 > 0));
}
function sparkline(vals) {
  const NS = 'http://www.w3.org/2000/svg', W = 90, H = 22;
  const s = document.createElementNS(NS, 'svg'); s.setAttribute('width', W); s.setAttribute('height', H);
  if (vals.length < 2) return s;
  const mn = Math.min(...vals), mx = Math.max(...vals), span = mx - mn || 1;
  const p = document.createElementNS(NS, 'polyline');
  p.setAttribute('points', vals.map((v, i) => `${(i / (vals.length - 1) * W).toFixed(1)},${(H - 2 - (v - mn) / span * (H - 4)).toFixed(1)}`).join(' '));
  p.setAttribute('fill', 'none'); p.setAttribute('stroke-width', '1.4');
  p.setAttribute('stroke', vals[vals.length - 1] >= vals[0] ? C.up : C.down);
  s.append(p); return s;
}
function renderGrid() {
  const head = $('#grid thead'), body = $('#grid tbody');
  head.textContent = ''; body.textContent = '';
  const tr = el('tr');
  for (const [key, title, c] of COLS) {
    const sortable = key !== 'spark' && key !== 'act';
    const th = el('th', { className: c || '', textContent: t(title) + (sort.key === key ? (sort.dir > 0 ? ' ▲' : ' ▼') : '') });
    if (sortable) th.addEventListener('click', () => { sort = { key, dir: sort.key === key ? -sort.dir : (c === 'l' ? 1 : -1) }; renderGrid(); });
    tr.append(th);
  }
  head.append(tr);
  const f = filters();
  const shown = rows.filter((r) => passes(r, f)).sort((a, b) => {
    const x = a[sort.key], y = b[sort.key];
    if (x == null) return 1; if (y == null) return -1;
    return (typeof x === 'string' ? x.localeCompare(y) : x - y) * sort.dir;
  });
  for (const r of shown) {
    const pc = (v) => el('td', { className: cls(v), textContent: fmtPct(v) });
    const add = el('button', { textContent: state.watch.includes(r.symbol) ? '✓' : t('+ Watch'), title: t('Add to watchlist') });
    add.addEventListener('click', (e) => { e.stopPropagation(); addWatch(r.symbol); add.textContent = '✓'; });
    const row = el('tr', {},
      el('td', { className: 'l' }, el('b', { textContent: r.symbol })), el('td', { className: 'l nm', textContent: r.name }),
      el('td', { textContent: fmtLast(r.last) }), el('td', { className: cls(r.chgAbs), textContent: fmtChg(r.chgAbs, r.last) }), pc(r.chg), el('td', { textContent: fmtVol(r.volume) }),
      el('td', { className: r.relVol >= 1.5 ? 'up' : '', textContent: r.relVol == null ? '–' : r.relVol.toFixed(2) + '×' }),
      el('td', { className: r.rsi == null ? '' : r.rsi >= 70 ? 'down' : r.rsi <= 30 ? 'up' : '', textContent: r.rsi == null ? '–' : r.rsi.toFixed(1) }),
      pc(r.vs50), pc(r.vs200), pc(r.fromHigh), pc(r.w1), pc(r.m1), pc(r.m3),
      el('td', {}, sparkline(r.spark)), el('td', {}, add));
    row.addEventListener('click', () => setSymbol(r.symbol));
    body.append(row);
  }
  const empty = $('#gridEmpty');
  empty.hidden = shown.length > 0;
  empty.textContent = t(rows.length ? 'No symbols match these filters.' : 'Press Scan to load this universe.');
  if (rows.length) $('#scanInfo').textContent = t('{0} of {1} match · click a row to chart it', shown.length, rows.length) + (scanErrors.length ? t(' · no data for {0}', scanErrors.join(', ')) : '');
}
async function scan() {
  const symbols = universeSymbols(), seq = ++scanSeq;
  if (!symbols.length) { rows = []; $('#scanInfo').textContent = t('This list is empty.'); return renderGrid(); }
  $('#scanInfo').textContent = t('Scanning {0} symbols…', symbols.length);
  try {
    const j = await api('/api/screen?symbols=' + symbols.map(encodeURIComponent).join(','));
    if (seq !== scanSeq) return;
    rows = j.rows; scanErrors = j.errors.map((e) => e.symbol); renderGrid();
  } catch (e) { if (seq === scanSeq) $('#scanInfo').textContent = t('Scan failed: ') + e.message; }
}
$('#scan').addEventListener('click', scan);
uniSel.addEventListener('change', () => { store.set('universe', uniSel.value); customInp.hidden = uniSel.value !== 'Custom list…'; scan(); });
customInp.addEventListener('change', () => { store.set('custom', customInp.value); scan(); });
customInp.hidden = uniSel.value !== 'Custom list…';
presetSel.addEventListener('change', () => {
  const p = PRESETS[presetSel.value];
  for (const i of fInputs) { const v = p[i.dataset.f]; if (i.type === 'checkbox') i.checked = !!v; else i.value = v == null ? '' : v; }
  renderGrid();
});
for (const i of fInputs) i.addEventListener('input', renderGrid);
$('#resetF').addEventListener('click', () => { presetSel.selectedIndex = 0; presetSel.dispatchEvent(new Event('change')); });

// ---------------------------------------------------------------- price alerts
// Checked in the page by the 20-second tick (paperTick), so only while the app is open.
const ALERT_COLOR = '#f5a524';
const saveAlerts = () => store.set('alerts', state.alerts);
const nowSec = () => Math.floor(Date.now() / 1000);
function toast(title, body, onClick) {
  let box = $('#toasts'); if (!box) { box = el('div', { id: 'toasts' }); document.body.append(box); }
  const n = el('div', { className: 'toast' }, el('b', { textContent: title }), el('span', { textContent: body }));
  n.addEventListener('click', () => { n.remove(); if (onClick) onClick(); });
  box.append(n); setTimeout(() => n.remove(), onClick ? 120000 : 5000);
}
function beep() {
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    for (const at of [0, 0.25]) { const o = ac.createOscillator(), g = ac.createGain(); o.frequency.value = 880; g.gain.value = 0.15; o.connect(g); g.connect(ac.destination); o.start(ac.currentTime + at); o.stop(ac.currentTime + at + 0.15); }
    setTimeout(() => ac.close().catch(() => {}), 1500);
  } catch { /* no sound */ }
}
const canNotify = () => 'Notification' in window;
// Kinds of alert (a.kind; older alerts have none and are 'price'). Each fires once, when its value reaches its level:
//   price: the price reaches a.price               line: the price crosses a line drawn on the chart (a.lt, a.a, a.b, a.tf)
//   pct:   today's change reaches a.value (%)      rsi:  the daily RSI(14) reaches a.value
//   ma:    the price crosses its a.period-day average
// a.op is 'above' (fires when the value rises to the level) or 'below'.
const kindOf = (a) => a.kind || 'price';
const DAILY_KINDS = new Set(['pct', 'rsi', 'ma']); // need the day's figures from /api/screen
const LINE_ALERT_TYPES = new Set(['trend', 'ray', 'extline', 'arrow', 'hline', 'hray']);
const paperRows = new Map(), lineBars = new Map(); // latest daily figures per symbol; bars for line alerts not on the chart
const quoteRow = (sym) => paperRows.get(sym) || watchData.get(sym) || null;
function logicalIn(d, t) { // like timeToLogical, for any list of bars
  const n = d.length, step = n > 1 ? (d[n - 1].time - d[Math.max(0, n - 21)].time) / Math.min(20, n - 1) : 86400;
  if (t <= d[0].time) return (t - d[0].time) / step;
  if (t >= d[n - 1].time) return n - 1 + (t - d[n - 1].time) / step;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (d[m].time <= t) lo = m; else hi = m; }
  return lo + (t - d[lo].time) / (d[hi].time - d[lo].time);
}
// Where a drawn line is at the latest bar, measured in bars of the timeframe it was drawn on (as the chart shows it),
// and extended to the right.
function lineLevel(a) {
  if (a.lt === 'hline' || a.lt === 'hray') return a.a.price;
  const d = a.sym === state.symbol && a.tf === state.tf && state.raw.length ? state.raw : lineBars.get(a.sym + '|' + a.tf);
  if (!d || d.length < 2) return null;
  const la = logicalIn(d, a.a.time), lb = logicalIn(d, a.b.time);
  if (Math.abs(lb - la) < 1e-9) return null;
  return a.a.price + (a.b.price - a.a.price) * (d.length - 1 - la) / (lb - la);
}
async function loadLineBars(waiting) {
  const need = new Set();
  for (const a of waiting) if (kindOf(a) === 'line' && a.lt !== 'hline' && a.lt !== 'hray' && TF[a.tf] && !(a.sym === state.symbol && a.tf === state.tf)) need.add(a.sym + '|' + a.tf);
  for (const key of need) {
    const [sym, tf] = key.split('|'), [interval, range] = TF[tf];
    try { const j = await api(`/api/candles?symbol=${encodeURIComponent(sym)}&interval=${interval}&range=${range}${state.ext ? '&ext=1' : ''}`); if (j.bars.length) lineBars.set(key, j.bars); } catch { /* try again next time */ }
  }
}
function alertState(a) { // now = the watched value, level = where the alert fires, px = the price
  const k = kindOf(a), px = paperPrice(a.sym), row = quoteRow(a.sym);
  if (k === 'price') return { now: px, level: a.price, px };
  if (k === 'line') return { now: px, level: lineLevel(a), px };
  if (!row) return { now: null, level: null, px };
  if (k === 'pct') return { now: row.chg, level: a.value, px };
  if (k === 'rsi') return { now: row.rsi, level: a.value, px };
  return { now: px ?? row.last, level: row['sma' + a.period], px: px ?? row.last }; // ma
}
const reached = (a, s) => s.now != null && s.level != null && (a.op === 'above' ? s.now >= s.level : s.now <= s.level);
// spec: { kind, price } | { kind: 'pct' | 'rsi', op, value } | { kind: 'ma', period } | { kind: 'line', line: a drawing }.
// Returns an error text, or null when the alert was added.
async function addAlert(sym, spec) {
  if (state.alerts.filter((a) => !a.hit).length >= 100) return t('Too many alerts.');
  const k = spec.kind || 'price', a = { id: Date.now(), sym, kind: k, time: nowSec(), hit: 0, hitPrice: 0 };
  if (k === 'price') { if (!(spec.price > 0)) return t('Enter the alert price.'); a.price = spec.price; }
  else if (k === 'pct') { if (!(spec.value > 0 && spec.value <= 1000)) return t('Enter a percentage above zero.'); a.op = spec.op; a.value = spec.op === 'above' ? spec.value : -spec.value; }
  else if (k === 'rsi') { if (!(spec.value > 0 && spec.value < 100)) return t('Enter an RSI level between 0 and 100.'); a.op = spec.op; a.value = spec.value; }
  else if (k === 'ma') a.period = spec.period === 200 ? 200 : 50;
  else if (k === 'line') {
    if (state.type === 'renko') return t('Line alerts are not available on the Renko chart.');
    const d = spec.line; a.lt = d.type; a.tf = state.tf; a.a = { time: d.a.time, price: d.a.price }; a.b = { time: d.b.time, price: d.b.price };
  }
  if (DAILY_KINDS.has(k) && !quoteRow(sym)) {
    try { const j = await api('/api/screen?symbols=' + encodeURIComponent(sym)); for (const r of j.rows) paperRows.set(r.symbol, r); } catch { /* reported below */ }
  }
  const s = alertState(a);
  if (s.px == null) return t('No price for {0} yet.', sym);
  if (s.now == null || s.level == null) return t('Not enough data for this alert on {0}.', sym);
  if (!a.op) { if (s.now === s.level) return t('The price is already there.'); a.op = s.level > s.now ? 'above' : 'below'; }
  else if (reached(a, s)) return t('That is already the case now.');
  state.alerts.push(a);
  saveAlerts(); drawIbLines(); renderAlerts();
  if (canNotify() && Notification.permission === 'default') { try { Notification.requestPermission().then(renderAlerts, () => {}); } catch { /* older browsers */ } }
  return null;
}
// [what it waits for, its level] for the lists; level = the level now (waiting) or when it fired
function alertLabel(a, level) {
  const up = a.op === 'above', k = kindOf(a), p = (v) => (v == null ? '–' : fmtLast(v));
  if (k === 'line') return [t(up ? '▲ crosses above the line' : '▼ crosses below the line'), p(level)];
  if (k === 'pct') return [t(up ? '▲ up today by' : '▼ down today by'), Math.abs(a.value).toFixed(2) + '%'];
  if (k === 'rsi') return [t(up ? 'RSI rises above' : 'RSI falls below'), String(a.value)];
  if (k === 'ma') return [t(up ? '▲ crosses above the {0}-day average' : '▼ crosses below the {0}-day average', a.period), p(level)];
  return [t(up ? '▲ rises to' : '▼ falls to'), p(a.price)];
}
function alertMessage(a, s) {
  const up = a.op === 'above', k = kindOf(a);
  if (k === 'line') return t(up ? '{0} crossed above the line at {1}' : '{0} crossed below the line at {1}', a.sym, fmtLast(s.level));
  if (k === 'pct') return t(up ? '{0} is up {1} today' : '{0} is down {1} today', a.sym, Math.abs(s.now).toFixed(2) + '%');
  if (k === 'rsi') return t(up ? '{0}: RSI rose to {1}' : '{0}: RSI fell to {1}', a.sym, s.now.toFixed(1));
  if (k === 'ma') return t(up ? '{0} crossed above its {1}-day average ({2})' : '{0} crossed below its {1}-day average ({2})', a.sym, a.period, fmtLast(s.level));
  return t(up ? '{0} rose to {1} (alert at {2})' : '{0} fell to {1} (alert at {2})', a.sym, fmtLast(s.px), fmtLast(a.price));
}
function checkAlerts() {
  let changed = false;
  for (const a of state.alerts) {
    if (a.hit) continue;
    const s = alertState(a);
    if (!reached(a, s)) continue;
    a.hit = nowSec(); a.hitPrice = s.px ?? 0; a.hitValue = s.now; a.hitLevel = s.level; changed = true;
    const title = kindOf(a) === 'price' ? t('Price alert') : t('Alert'), body = alertMessage(a, s);
    toast(title, body, () => setSymbol(a.sym, true)); beep();
    try { if (canNotify() && Notification.permission === 'granted') new Notification('InvestorView – ' + title, { body, icon: 'icon.png' }); } catch { /* the in-app message is enough */ }
  }
  if (!changed) return;
  const done = state.alerts.filter((a) => a.hit);
  if (done.length > 50) { const drop = new Set(done.slice(0, done.length - 50)); state.alerts = state.alerts.filter((a) => !drop.has(a)); }
  saveAlerts(); drawIbLines();
}
let alertUI = null, alertNote = '';
function buildAlerts() {
  const box = $('#sideAlerts');
  const ui = { sym: el('b'), last: el('span'), type: el('select'), price: el('input', { type: 'number', min: '0', step: 'any', placeholder: t('Alert price') }), add: el('button', { className: 'primary', textContent: t('Add alert') }),
    note: el('p', { className: 'pnote' }), perm: el('button', { textContent: t('Turn on notifications'), title: t('Also show a Windows notification when an alert triggers') }),
    wait: el('div'), done: el('div'), clear: el('button', { className: 'mini', textContent: t('Clear') }) };
  // [value, label, input placeholder (none = no input), default value]
  const TYPES = [['price', 'Price reaches', 'Alert price'], ['pctUp', 'Up today by (%)', '%', '3'], ['pctDown', 'Down today by (%)', '%', '3'],
    ['rsiAbove', 'RSI (14, daily) rises above', 'RSI', '70'], ['rsiBelow', 'RSI (14, daily) falls below', 'RSI', '30'],
    ['ma50', 'Price crosses the 50-day average'], ['ma200', 'Price crosses the 200-day average']];
  for (const [v, label] of TYPES) ui.type.append(el('option', { value: v, textContent: t(label) }));
  ui.type.addEventListener('change', () => {
    const ty = TYPES.find((x) => x[0] === ui.type.value);
    ui.price.hidden = !ty[2]; ui.price.placeholder = ty[2] ? t(ty[2]) : ''; ui.price.value = ty[3] || ''; alertNote = ''; renderAlerts();
  });
  const go = async () => {
    const v = +ui.price.value, ty = ui.type.value;
    const spec = ty === 'price' ? { kind: 'price', price: v } : ty === 'pctUp' ? { kind: 'pct', op: 'above', value: v } : ty === 'pctDown' ? { kind: 'pct', op: 'below', value: v }
      : ty === 'rsiAbove' ? { kind: 'rsi', op: 'above', value: v } : ty === 'rsiBelow' ? { kind: 'rsi', op: 'below', value: v } : { kind: 'ma', period: ty === 'ma200' ? 200 : 50 };
    ui.add.disabled = true;
    try { const err = await addAlert(state.symbol, spec); alertNote = err || ''; if (!err && ty === 'price') ui.price.value = ''; } finally { ui.add.disabled = false; }
    renderAlerts();
  };
  ui.add.addEventListener('click', go);
  ui.price.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  ui.perm.addEventListener('click', () => { try { Notification.requestPermission().then(renderAlerts, () => {}); } catch { /* older browsers */ } });
  ui.clear.addEventListener('click', () => { state.alerts = state.alerts.filter((a) => !a.hit); saveAlerts(); renderAlerts(); });
  box.append(
    el('div', { className: 'ibhead' }, el('span', { textContent: t('Alerts') }), el('span', { className: 'grow' }), ui.perm),
    el('h4', { textContent: t('New alert') }),
    el('div', { className: 'ticket' }, symbolSearch((sym) => { alertNote = ''; setSymbol(sym, true); renderAlerts(); }),
      el('div', { className: 'trow head' }, ui.sym, ui.last), el('div', { className: 'trow' }, ui.type), el('div', { className: 'trow' }, ui.price, ui.add), ui.note),
    el('h4', { textContent: t('Waiting') }), ui.wait, el('h4', {}, t('Triggered'), ui.clear), ui.done,
    el('p', { className: 'pfoot', textContent: t('Alerts are checked about every 20 seconds, and only while this app is open. When one triggers you get a message here, a sound and, if turned on, a Windows notification. Right-click the chart to add an alert at that price, or right-click a trend line or horizontal line you drew to be alerted when the price crosses it. Change % and RSI use daily figures.') }),
    TOUCH ? el('p', { className: 'pfoot', textContent: t('On a touch screen, press and hold where you would right-click. On a phone, alerts are only checked while this page is open in front.') }) : null);
  return ui;
}
function renderAlerts() {
  if (side !== 'alerts') return;
  const ui = (alertUI ||= buildAlerts()), px = paperPrice(state.symbol);
  ui.sym.textContent = state.symbol; ui.last.textContent = px == null ? '–' : fmtLast(px);
  ui.note.textContent = alertNote; ui.note.hidden = !alertNote;
  ui.perm.hidden = !(canNotify() && Notification.permission === 'default');
  const drop = (a) => { const b = el('button', { className: 'mini', textContent: '✕', title: t('Remove') }); b.addEventListener('click', (e) => { e.stopPropagation(); state.alerts = state.alerts.filter((x) => x !== a); saveAlerts(); drawIbLines(); renderAlerts(); }); return b; };
  const wait = state.alerts.filter((a) => !a.hit), done = state.alerts.filter((a) => a.hit).reverse();
  ui.wait.textContent = '';
  if (!wait.length) ui.wait.append(el('p', { textContent: t('No alerts waiting.') }));
  for (const a of wait) {
    const s = alertState(a), k = kindOf(a), [what, level] = alertLabel(a, s.level);
    const hint = k === 'pct' ? (s.now == null ? '' : t('now {0}', fmtPct(s.now))) : k === 'rsi' ? (s.now == null ? '' : t('now {0}', s.now.toFixed(1)))
      : s.px == null || s.level == null ? '' : t('{0} away', fmtPct((s.level / s.px - 1) * 100));
    const r = el('div', { className: 'ibrow link' + (a.sym === state.symbol ? ' on' : '') },
      el('div', {}, el('b', { textContent: a.sym }), el('small', { textContent: what })),
      el('div', { className: 'r' }, el('span', { textContent: level }), drop(a), el('small', { textContent: hint })));
    r.addEventListener('click', () => setSymbol(a.sym, true));
    ui.wait.append(r);
  }
  ui.done.textContent = ''; ui.clear.hidden = !done.length;
  if (!done.length) ui.done.append(el('p', { textContent: t('Nothing triggered yet.') }));
  for (const a of done) {
    const when = new Date(a.hit * 1000), k = kindOf(a), [what, level] = alertLabel(a, a.hitLevel);
    const at = k === 'pct' && a.hitValue != null ? fmtPct(a.hitValue) : k === 'rsi' && a.hitValue != null ? a.hitValue.toFixed(1) : fmtLast(a.hitPrice);
    const r = el('div', { className: 'ibrow link' },
      el('div', {}, el('b', { textContent: a.sym }), el('small', { textContent: `${when.toLocaleDateString()} ${when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` })),
      el('div', { className: 'r' }, el('span', { className: a.op === 'above' ? 'up' : 'down', title: what, textContent: (k === 'price' ? (a.op === 'above' ? '▲ ' : '▼ ') : what.replace(/^[▲▼] /, '') + ' ') + level }), drop(a), el('small', { textContent: t('at {0}', at) })));
    r.addEventListener('click', () => setSymbol(a.sym, true));
    ui.done.append(r);
  }
}
// right-click the chart: add an alert at that price
const ctxMenu = el('ul', { id: 'ctx', hidden: true }); document.body.append(ctxMenu);
if (!EMBED) stage.addEventListener('contextmenu', (e) => {
  if (!S.main || state.tool !== 'cursor') return;
  const price = S.main.coordinateToPrice(e.clientY - chartEl.getBoundingClientRect().top);
  if (!(price > 0)) return;
  e.preventDefault();
  const p = +price.toFixed(precision()), sym = state.symbol;
  const li = el('li', { textContent: '🔔 ' + t('Add alert at {0}', fmtP(p)) });
  li.addEventListener('click', async () => { const err = await addAlert(sym, { kind: 'price', price: p }); toast(t('Price alert'), err || t('Alert added: {0} at {1}', sym, fmtP(p))); });
  ctxMenu.textContent = ''; ctxMenu.append(li);
  // a trend line or horizontal line under the pointer: alert when the price crosses it
  const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  const line = [...list()].reverse().find((d) => LINE_ALERT_TYPES.has(d.type) && hitsDrawing(d, x, y));
  if (line) {
    const ll = el('li', { textContent: '🔔 ' + t('Alert when the price crosses this line') });
    ll.addEventListener('click', async () => { const err = await addAlert(sym, { kind: 'line', line }); toast(t('Alert'), err || t('Alert added: {0} crosses the line', sym)); });
    ctxMenu.prepend(ll);
  }
  ctxMenu.hidden = false;
  const m = ctxMenu.getBoundingClientRect();
  ctxMenu.style.left = Math.max(4, Math.min(e.clientX, innerWidth - m.width - 8)) + 'px'; ctxMenu.style.top = Math.max(4, Math.min(e.clientY, innerHeight - m.height - 8)) + 'px';
});
document.addEventListener('click', () => { ctxMenu.hidden = true; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') ctxMenu.hidden = true; });

// ---------------------------------------------------------------- multi-chart layout
const multi = $('#multi'), LAYOUTS = { 1: 1, '2h': 2, '2v': 2, 4: 4 }, frames = [];
let layout = String(store.get('layout', '1')), activePane = 0; // activePane: 0 = the main chart, 1-3 = a frame; watchlist clicks go there
function setActive(i) { activePane = i; [...multi.children].forEach((c, k) => c.classList.toggle('active', k === i)); }
function applyLayout() {
  if (!LAYOUTS[layout] || EMBED) layout = '1';
  const shown = PHONE ? '1' : layout, n = LAYOUTS[shown]; // a phone shows one chart; the saved layout returns on a wider screen
  multi.dataset.layout = shown; $('#layout').value = layout;
  while (frames.length > n - 1) frames.pop().parentNode.remove();
  while (frames.length < n - 1) {
    const f = el('iframe', { src: location.pathname + '?pane=' + (frames.length + 1) + (new URLSearchParams(location.search).has('web') ? '&web' : ''), title: t('Chart') + ' ' + (frames.length + 2) });
    frames.push(f); multi.append(el('div', { className: 'pane' }, f));
  }
  setActive(activePane > n - 1 ? 0 : activePane);
}
$('#layout').addEventListener('change', (e) => { layout = e.target.value; store.set('layout', layout); applyLayout(); });
stage.addEventListener('pointerdown', () => setActive(0), true);
$('#top').addEventListener('pointerdown', () => setActive(0), true);
window.addEventListener('blur', () => setTimeout(() => { const i = frames.indexOf(document.activeElement); if (i >= 0) setActive(i + 1); }, 0)); // focus moved into a frame
if (EMBED) window.addEventListener('message', (e) => { // the main window sends the symbol picked in its watchlist
  if (e.origin === location.origin && e.source === window.parent && e.data && e.data.cd === 'symbol' && typeof e.data.sym === 'string') setSymbol(e.data.sym);
});

// ---------------------------------------------------------------- views + boot
function setView(v) {
  if (state.view === v) return;
  state.view = v;
  $('#chartView').hidden = v !== 'chart'; $('#screenView').hidden = v !== 'screener';
  for (const b of $('#views').children) b.classList.toggle('on', b.dataset.view === v);
  if (v === 'screener' && !rows.length) scan();
  if (PHONE) markPhoneNav();
}
for (const b of $('#views').children) b.addEventListener('click', () => setView(b.dataset.view));

// ---------------------------------------------------------------- phones
// On a phone-sized screen (html.phone, see style.css) the page shows one thing at a time: the chart, one side tab or the
// screener, picked in a tab bar at the bottom. The top bar keeps search, refresh and timeframes; the rest is behind "⋯".
const phoneMQ = window.matchMedia('(max-width: 700px), (max-height: 500px) and (pointer: coarse)');
let PHONE = false, pv = 'chart'; // pv: chart | watch | pos | paper | alerts | screener
const NAV_ICONS = {
  chart: '<path d="M4 15l4-5 3 3 5-7"/><path d="M3 17h14"/>',
  watch: '<path d="M4 5h12M4 10h12M4 15h12"/>',
  pos: '<rect x="3.5" y="5.5" width="13" height="10" rx="1.5"/><path d="M3.5 9h13"/>',
  paper: '<path d="M10 3v14M13.5 6.5c-.6-1.2-1.9-2-3.5-2-2 0-3.5 1.1-3.5 2.6 0 3.6 7 1.9 7 5.6 0 1.5-1.5 2.6-3.5 2.6-1.7 0-3-.8-3.6-2"/>',
  alerts: '<path d="M6 13V9a4 4 0 018 0v4l1.5 2h-11zM8.5 17h3"/>',
  screener: '<path d="M3 5h14l-5.5 6.5V16l-3 1.5v-6z"/>',
};
const NAV = [['chart', 'Chart'], ['watch', 'Watchlist'], ...(WEB ? [] : [['pos', 'IBKR']]), ['alerts', 'Alerts'], ['paper', 'Paper'], ['screener', 'Screener']];
const phoneNav = $('#phoneNav');
for (const [v, label] of NAV) {
  const b = el('button', { innerHTML: `<svg viewBox="0 0 20 20">${NAV_ICONS[v]}</svg>` }, el('span', { textContent: t(label) }));
  b.dataset.pv = v;
  b.addEventListener('click', () => setPhoneView(v));
  phoneNav.append(b);
}
function markPhoneNav() {
  if (state.view === 'screener') pv = 'screener'; else if (pv === 'screener') pv = 'chart';
  document.documentElement.dataset.pv = pv;
  for (const b of phoneNav.children) b.classList.toggle('on', b.dataset.pv === pv);
}
function setPhoneView(v) {
  pv = v; $('#top').classList.remove('more');
  if (v === 'screener') setView('screener');
  else {
    setView('chart');
    const tab = v !== 'chart' && $(`#sideTabs [data-side="${v}"]`);
    if (tab && side !== v) tab.click();
  }
  markPhoneNav();
}
function applyPhone() {
  const was = PHONE;
  PHONE = phoneMQ.matches && !EMBED;
  document.documentElement.classList.toggle('phone', PHONE);
  phoneNav.hidden = !PHONE; $('#more').hidden = !PHONE;
  if (PHONE) setPhoneView(state.view === 'screener' ? 'screener' : pv);
  else { delete document.documentElement.dataset.pv; $('#top').classList.remove('more'); }
  if (was !== PHONE && state.ready) applyLayout(); // back to the saved multi-chart layout on a wider screen
}
$('#more').addEventListener('click', (e) => { e.stopPropagation(); $('#top').classList.toggle('more'); });
document.addEventListener('click', (e) => { if (!$('#top').contains(e.target) && !e.target.closest('#indMenu, #cmpBox')) $('#top').classList.remove('more'); });
$('#fToggle').addEventListener('click', () => $('#screenView').classList.toggle('showF')); // phone: the screener's filters fold away
phoneMQ.addEventListener('change', applyPhone);
applyPhone();
// Touch screens have no right-click: holding a finger still for half a second opens the same menu
// (chart: alert at that price or on a drawn line; watchlist: move to a section).
function longPress(area) {
  let timer = 0, x = 0, y = 0, fired = false;
  area.addEventListener('touchstart', (e) => {
    fired = false; clearTimeout(timer);
    if (e.touches.length !== 1) return;
    const p = e.touches[0], target = e.target; x = p.clientX; y = p.clientY;
    timer = setTimeout(() => {
      fired = true;
      target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
    }, 550);
  }, { passive: true });
  area.addEventListener('touchmove', (e) => { const p = e.touches[0]; if (p && Math.hypot(p.clientX - x, p.clientY - y) > 10) clearTimeout(timer); }, { passive: true });
  area.addEventListener('touchend', (e) => { clearTimeout(timer); if (fired) e.preventDefault(); }, { passive: false }); // no click after a long press: it would close the menu
  area.addEventListener('touchcancel', () => clearTimeout(timer));
}
longPress(stage); longPress($('#wlist'));

if (!LW) showMsg(t('Could not load the charting library (needs an internet connection). Reload to retry.'));
else (EMBED ? Promise.resolve() : pullState()).then(() => {
  setTool('cursor'); renderWatch(); renderGrid();
  load(); requestAnimationFrame(frame);
  setInterval(() => { if (!document.hidden && state.view === 'chart') load({ refresh: true }); }, 30000);
  if (EMBED) return; // an extra chart of the layout: the main window does the rest
  if (WEB && window.WebData.PROXY && !/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) { // once per browser tab; nothing that identifies the visitor is sent
    try {
      if (!sessionStorage.getItem('cd.hit')) {
        sessionStorage.setItem('cd.hit', '1');
        const today = new Date().toISOString().slice(0, 10), seen = store.shared('seen', null);
        localStorage.setItem('cd.seen', JSON.stringify(today));
        fetch(`${window.WebData.PROXY}/hit?day=${seen === today ? 0 : 1}&new=${seen ? 0 : 1}`).catch(() => {});
      }
    } catch { /* storage blocked: not counted */ }
  }
  state.ready = true; applyLayout(); refreshWatch(); refreshIb();
  setInterval(() => { if (!document.hidden) refreshWatch(); }, 60000);
  // working orders and waiting alerts are checked even in a background tab
  paperTick(); setInterval(() => { if ((paperLeader && (state.paper.orders.length || state.alerts.some((a) => !a.hit))) || ((side === 'paper' || side === 'alerts') && !document.hidden)) paperTick(); }, 20000);
});
})();
