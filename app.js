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
const store = {
  get(k, d) { try { const v = localStorage.getItem('cd.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('cd.' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } if (SYNCED.has(k)) pushState(); },
};
// The watchlist, drawings and indicators are also mirrored to a file on disk through the local
// server, so they survive a cleared browser and the MCP server can read them. The file wins on start-up.
const SYNCED = new Set(['watch', 'drawings', 'collapsed', 'indicators']);
let syncReady = false, pushTimer = 0;
// Web version (opened from a website such as GitHub Pages, not from the desktop app): there is no
// local server, so web-data.js fetches prices in the browser, through the data proxy (worker/) and
// the other sources it switches between. IBKR positions and the saved data file need the desktop app.
const WEB = !!window.WebData && (!/^(localhost|127\.0\.0\.1)$/.test(location.hostname) || new URLSearchParams(location.search).has('web'));
function pushState() {
  if (!syncReady || WEB) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    fetch('/api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ watch: state.watch, drawings: state.drawings, collapsed: [...collapsed], indicators: state.indicators }) }).catch(() => {});
  }, 400);
}
async function pullState() {
  try {
    const s = await api('/api/state');
    if (s && Array.isArray(s.watch)) {
      state.watch = s.watch; state.drawings = s.drawings || {};
      if (Array.isArray(s.indicators)) state.indicators = s.indicators;
      collapsed.clear(); for (const c of s.collapsed || []) collapsed.add(c);
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
  symbol: store.get('symbol', 'AAPL'),
  tf: store.get('tf', '1D'),
  type: store.get('type', 'candles'),
  log: store.get('log', false),
  ext: store.get('ext', false),
  extRuns: [],
  indicators: store.get('indicators', [{ id: 1, type: 'SMA', period: 50 }, { id: 2, type: 'SMA', period: 200 }, { id: 3, type: 'VOL' }]),
  watch: store.get('watch', DEFAULT_WATCH),
  drawings: store.get('drawings', {}),
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
    rightPriceScale: { borderColor: C.border, mode: state.log ? 1 : 0 },
    timeScale: { borderColor: C.border, timeVisible: intraday, secondsVisible: false, rightOffset: 6 },
  });

  const pr = precision();
  const pf = { priceFormat: { type: 'price', precision: pr, minMove: 1 / 10 ** pr } };
  const ud = { upColor: C.up, downColor: C.down };
  if (state.type === 'line') S.main = chart.addSeries(LW.LineSeries, { color: C.accent, lineWidth: 2, ...pf });
  else if (state.type === 'area') S.main = chart.addSeries(LW.AreaSeries, { lineColor: C.accent, topColor: rgba(C.accent, 0.35), bottomColor: rgba(C.accent, 0), lineWidth: 2, ...pf });
  else if (state.type === 'bars') S.main = chart.addSeries(LW.BarSeries, { ...ud, ...pf });
  else S.main = chart.addSeries(LW.CandlestickSeries, { ...ud, borderVisible: false, wickUpColor: C.up, wickDownColor: C.down, ...pf });

  let pane = 0, colorI = 0;
  S.inds = [];
  for (const ind of state.indicators) {
    const it = makeIndicator(ind, PALETTE[colorI++ % PALETTE.length], () => ++pane);
    if (it) S.inds.push(it);
  }
  applyData();
  try { chart.panes().forEach((p, i) => { if (i > 0) p.setHeight(130); }); } catch { /* default pane sizes */ }

  const n = state.data.length;
  const view = range || { from: Math.max(0, n - 160), to: n + 6 }, built = chart;
  chart.timeScale().setVisibleLogicalRange(view);
  requestAnimationFrame(() => { if (chart === built) chart.timeScale().setVisibleLogicalRange(view); }); // again once the chart has its size
  chart.subscribeCrosshairMove((p) => updateLegend(p.time != null && timeIdx.has(p.time) ? timeIdx.get(p.time) : state.data.length - 1));
  chart.subscribeClick((p) => { if (p.point) selectAt(p.point.x, p.point.y); });
  renderChips();
  updateLegend(n - 1);
  drawIbLines(); if (ib) renderIb();
}

function applyData() {
  const d = state.data, closes = d.map((b) => b.close);
  if (state.type === 'line' || state.type === 'area') S.main.setData(d.map((b) => ({ time: b.time, value: b.close })));
  else S.main.setData((state.type === 'heikin' ? heikin(d) : d).map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));
  for (const it of S.inds) it.apply(d, closes);
}

// ---------------------------------------------------------------- legend + indicator chips
function renderChips() {
  const box = $('#chips'); box.textContent = '';
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
  $('#lgName').textContent = [state.meta.name !== state.symbol && state.meta.name, state.meta.exchange || (WEB && state.meta.source), state.tf].filter(Boolean).join(' · ');
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
  for (const it of S.inds) {
    if (!it.valEl) continue;
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
    const j = await api(`/api/candles?symbol=${encodeURIComponent(state.symbol)}&interval=${interval}&range=${range}${state.ext ? '&ext=1' : ''}${fresh ? '&fresh=1' : ''}`);
    if (seq !== loadSeq) return;
    markUpdated();
    if (!j.bars.length) throw new Error(t('No data for {0} on this timeframe', state.symbol));
    state.data = j.bars; state.meta = j;
    state.extRuns = []; // [firstIndex, lastIndex] of each stretch of pre-market / after-hours bars
    j.bars.forEach((b, i) => { if (b.x) { const r = state.extRuns[state.extRuns.length - 1]; if (r && r[1] === i - 1) r[1] = i; else state.extRuns.push([i, i]); } });
    timeIdx = new Map(j.bars.map((b, i) => [b.time, i]));
    const diffs = []; for (let i = Math.max(1, j.bars.length - 60); i < j.bars.length; i++) diffs.push(j.bars[i].time - j.bars[i - 1].time);
    diffs.sort((a, b) => a - b); state.step = diffs[diffs.length >> 1] || 86400;
    showMsg(null);
    if (refresh && chart) { applyData(); updateLegend(j.bars.length - 1); } else buildChart(false);
    document.title = `${state.symbol} ${fmtP(j.price)} · ChartDesk`;
  } catch (e) {
    if (seq !== loadSeq) return;
    if (refresh) { markUpdated(e.message); return; } // keep the chart on screen
    const refused = /returned (401|403|429)/.exec(e.message), unreachable = /Could not reach/.test(e.message);
    if (refused) showMsg(t('Yahoo Finance refused the request from this network (HTTP {0}). Try switching your VPN or proxy on or off, or wait a few minutes and reload.', refused[1]), true);
    else if (unreachable) showMsg(t('Could not connect to Yahoo Finance. Check your internet connection, or whether a VPN or firewall is blocking it.'), true);
    else showMsg(e.message + t(' — try another symbol or timeframe.'));
  }
}

function setSymbol(sym) {
  state.symbol = sym.toUpperCase(); store.set('symbol', state.symbol);
  selected = null; draft = null;
  $('#sym').value = '';
  setView('chart'); renderWatch(); load();
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
$('#type').addEventListener('change', (e) => { state.type = e.target.value; store.set('type', state.type); if (state.data.length) buildChart(true); });
$('#log').checked = state.log;
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
$('#theme').addEventListener('click', () => { theme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'; store.set('theme', theme); applyTheme(true); });
sysLight.addEventListener('change', () => { if (!theme) applyTheme(true); });
applyTheme(false);
$('#ext').checked = state.ext;
$('#ext').addEventListener('change', (e) => { state.ext = e.target.checked; store.set('ext', state.ext); load(); refreshWatch(); });
$('#refresh').addEventListener('click', async (e) => {
  const b = e.currentTarget;
  if (b.classList.contains('busy')) return;
  b.classList.add('busy');
  try { await Promise.all([state.view === 'chart' ? load({ refresh: true, fresh: true }) : null, refreshWatch(true)]); } finally { b.classList.remove('busy'); }
});
$('#log').addEventListener('change', (e) => { state.log = e.target.checked; store.set('log', state.log); if (chart) chart.priceScale('right').applyOptions({ mode: state.log ? 1 : 0 }); });

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
function pick(sym) { hits = []; renderHits(); symInput.blur(); setSymbol(sym); }
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
  verEl.title = 'Investerview ' + v.version + (WEB ? ' (web)' : '') + ' – ' + t('release notes on GitHub');
}).catch(() => {});
if (WEB) { // no local server: hide what needs one, and say so
  $('#sideTabs').hidden = true; $('#ext').closest('label').hidden = true; $('#impWatch').hidden = true;
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
const saveDrawings = () => store.set('drawings', state.drawings);
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
function selectAt(x, y) {
  if (dragH) return;
  selected = null;
  for (const d of [...list()].reverse()) {
    const hit = (hitMap.get(d) || []).some((s) => (s.length ? distSeg(x, y, s[0], s[1], s[2], s[3]) < 6 : x >= s.x1 - 4 && x <= s.x2 + 4 && y >= s.y1 - 4 && y <= s.y2 + 4));
    if (hit) { selected = d; break; }
  }
}
// drag a handle of the selected drawing to move that point
stage.addEventListener('pointerdown', (e) => {
  if (state.tool !== 'cursor' || !selected || e.button !== 0) return;
  const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  const h = selHandles.find((q) => Math.hypot(q.x - x, q.y - y) < 8); if (!h) return;
  e.stopPropagation(); e.preventDefault(); dragH = { d: selected, k: h.k };
}, true);
stage.addEventListener('mousedown', (e) => { if (dragH) e.stopPropagation(); }, true); // keep the chart from panning meanwhile
window.addEventListener('pointermove', (e) => {
  if (!dragH) return;
  const p = evPoint(e); if (!p) return;
  dragH.d[dragH.k] = p; if (NPTS[dragH.d.type] === 1) dragH.d.b = p;
});
window.addEventListener('pointerup', () => { if (dragH) { saveDrawings(); setTimeout(() => { dragH = null; }, 0); } });

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
  for (const d of items) drawOne(d, g, false);
  if (draft) drawOne(draft, g, true);
  ctx.restore();
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
        li = el('li', { className: 'sec', title: t('Click to collapse or expand · drag to move') }, el('span', { className: 'sn', textContent: (hide ? '▸ ' : '▾ ') + name }), ed, rm);
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
function addWatch(sym) {
  if (state.watch.includes(sym)) return;
  state.watch.push(sym); saveWatch(); refreshWatch();
}
$('#addWatch').addEventListener('click', () => addWatch(state.symbol));
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
  if (!ib || ib.state !== 'ok' || !S.main) return;
  const add = (price, color, title) => { if (price > 0) ibLines.push({ series: S.main, line: S.main.createPriceLine({ price, color, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title }) }); };
  for (const p of ib.positions) if (p.chart === state.symbol) add(p.avgPrice, C.cost, `${t('Avg cost')} · ${p.qty}`);
  for (const o of ib.orders) if (o.chart === state.symbol) add(o.price, o.side === 'BUY' ? C.up : C.down, `${o.side} ${o.remaining == null ? '' : o.remaining} ${o.type}`.replace(/\s+/g, ' '));
}
for (const b of $('#sideTabs').children) {
  b.addEventListener('click', () => {
    side = b.dataset.side;
    for (const x of $('#sideTabs').children) x.classList.toggle('on', x === b);
    $('#sideWatch').hidden = side !== 'watch'; $('#sidePos').hidden = side !== 'pos';
    if (side === 'pos' && (!ib || ib.state !== 'ok')) { renderIb(); refreshIb(); }
  });
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

// ---------------------------------------------------------------- views + boot
function setView(v) {
  if (state.view === v) return;
  state.view = v;
  $('#chartView').hidden = v !== 'chart'; $('#screenView').hidden = v !== 'screener';
  for (const b of $('#views').children) b.classList.toggle('on', b.dataset.view === v);
  if (v === 'screener' && !rows.length) scan();
}
for (const b of $('#views').children) b.addEventListener('click', () => setView(b.dataset.view));

if (!LW) showMsg(t('Could not load the charting library (needs an internet connection). Reload to retry.'));
else pullState().then(() => {
  setTool('cursor'); renderWatch(); renderGrid();
  load(); refreshWatch(); refreshIb(); requestAnimationFrame(frame);
  setInterval(() => { if (!document.hidden && state.view === 'chart') load({ refresh: true }); }, 30000);
  setInterval(() => { if (!document.hidden) refreshWatch(); }, 60000);
});
})();
