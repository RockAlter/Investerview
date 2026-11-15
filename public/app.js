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
function pushState() {
  if (!syncReady) return;
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
  $('#lgName').textContent = [state.meta.name, state.meta.exchange, state.tf].filter(Boolean).join(' · ');
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
    it.valEl.textContent = it.vals.map((a) => a[i] == null ? '–' : it.isVol ? fmtVol(a[i]) : it.pane ? a[i].toFixed(2) : fmtP(a[i])).join('  ');
  }
}

// ---------------------------------------------------------------- loading
let loadSeq = 0;
function showMsg(text, withDiag) {
  const m = $('#msg'); m.hidden = !text; m.textContent = '';
  if (!text) return;
  const box = el('div', {}, el('p', { textContent: text }));
  if (withDiag) box.append(el('p', {}, el('a', { href: '/api/diag', target: '_blank', rel: 'noopener', textContent: t('Show connection diagnostics') })));
  m.append(box);
}

async function load({ refresh = false } = {}) {
  const seq = ++loadSeq;
  const [interval, range] = TF[state.tf];
  if (!refresh) showMsg(t('Loading {0}…', state.symbol));
  try {
    const j = await api(`/api/candles?symbol=${encodeURIComponent(state.symbol)}&interval=${interval}&range=${range}${state.ext ? '&ext=1' : ''}`);
    if (seq !== loadSeq) return;
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
    if (refresh) return;
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
$('#log').addEventListener('change', (e) => { state.log = e.target.checked; store.set('log', state.log); if (chart) chart.priceScale('right').applyOptions({ mode: state.log ? 1 : 0 }); });

const indMenu = $('#indMenu');
for (const [type, def] of Object.entries(IND)) {
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
const TOOLS = [
  ['cursor', 'Select / pan (Esc)', '<path d="M5 3l12 7-5 1.5L9.5 17z"/>'],
  ['trend', 'Trend line', '<path d="M4 16L16 4"/><circle cx="4" cy="16" r="1.6"/><circle cx="16" cy="4" r="1.6"/>'],
  ['hline', 'Horizontal line', '<path d="M2 10h16"/><circle cx="10" cy="10" r="1.6"/>'],
  ['vline', 'Vertical line', '<path d="M10 2v16"/><circle cx="10" cy="10" r="1.6"/>'],
  ['rect', 'Rectangle', '<rect x="3.5" y="5.5" width="13" height="9" rx="1"/>'],
  ['fib', 'Fibonacci retracement', '<path d="M3 4h14M3 8h14M3 11h14M3 16h14"/>'],
  ['measure', 'Measure price / % / bars', '<path d="M4 16L16 4M7 16H4v-3M13 4h3v3"/>'],
];
const HINTS = { trend: 'Click two points to draw a trend line', hline: 'Click to place a horizontal line', vline: 'Click to place a vertical line', rect: 'Click two corners', fib: 'Click the swing start, then the swing end', measure: 'Click two points to measure' };
const FIBS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
const cv = $('#draw'), ctx = cv.getContext('2d');
let draft = null, selected = null, downAt = null;

const toolsEl = $('#tools');
const svg = (inner) => `<svg viewBox="0 0 20 20">${inner}</svg>`;
for (const [id, title, icon] of TOOLS) {
  const b = el('button', { title: t(title), innerHTML: svg(icon) }); b.dataset.tool = id;
  b.addEventListener('click', () => setTool(id));
  toolsEl.append(b);
}
toolsEl.append(el('hr'));
const delBtn = el('button', { title: t('Delete selected drawing, or all drawings on this symbol if none is selected (Del)'), innerHTML: svg('<path d="M4 6h12M8 6V4h4v2M6 6l1 10h6l1-10"/>') });
delBtn.addEventListener('click', () => removeDrawings());
toolsEl.append(delBtn);
// version of the running app, always visible at the bottom of the toolbar
const verEl = el('span', { id: 'ver' }); toolsEl.append(verEl);
api('/api/version').then((v) => { verEl.textContent = 'v' + v.version; verEl.title = 'Investerview ' + v.version; }).catch(() => {});

function setTool(id) {
  state.tool = id; draft = null;
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

cv.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const p = evPoint(e); if (!p) return;
  if (draft) { draft.b = p; return finish(); }
  draft = { type: state.tool, a: p, b: p };
  if (state.tool === 'hline' || state.tool === 'vline') return finish();
  downAt = { x: e.clientX, y: e.clientY };
});
cv.addEventListener('pointermove', (e) => { if (draft) { const p = evPoint(e); if (p) draft.b = p; } });
cv.addEventListener('pointerup', (e) => {
  if (draft && downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 6) finish(); // drag to draw
  downAt = null;
});
function finish() {
  list().push(draft); selected = draft; draft = null; downAt = null;
  saveDrawings(); setTool('cursor');
}

function distSeg(px, py, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / len)) : 0;
  return Math.hypot(px - a.x - t * dx, py - a.y - t * dy);
}
function selectAt(x, y) {
  const g = geom(); if (!g) return;
  selected = null;
  for (const d of [...list()].reverse()) {
    const a = toXY(d.a, g), b = toXY(d.b, g); if (!a || !b) continue;
    let hit;
    if (d.type === 'hline') hit = Math.abs(y - a.y) < 6;
    else if (d.type === 'vline') hit = Math.abs(x - a.x) < 6;
    else if (d.type === 'trend') hit = distSeg(x, y, a, b) < 6;
    else { // box-like shapes
      const x1 = Math.min(a.x, b.x), x2 = d.type === 'fib' ? g.w : Math.max(a.x, b.x);
      hit = x >= x1 - 4 && x <= x2 + 4 && y >= Math.min(a.y, b.y) - 4 && y <= Math.max(a.y, b.y) + 4;
    }
    if (hit) { selected = d; break; }
  }
}

function label(text, x, y, color, align = 'left') {
  ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = align; ctx.textBaseline = 'middle';
  const w = ctx.measureText(text).width + 8, bx = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
  ctx.fillStyle = C.label; ctx.fillRect(bx, y - 8, w, 16);
  ctx.fillStyle = color; ctx.fillText(text, align === 'right' ? x - 4 : align === 'center' ? x : x + 4, y);
}
function drawOne(d, g, isDraft) {
  const a = toXY(d.a, g), b = toXY(d.b, g); if (!a || !b) return;
  const sel = d === selected, col = isDraft ? '#8fb6ff' : C.accent;
  ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = sel ? 2.5 : 1.5; ctx.setLineDash([]);
  const line = (x1, y1, x2, y2) => { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); };
  const handles = [];
  if (d.type === 'trend') { line(a.x, a.y, b.x, b.y); handles.push(a, b); }
  else if (d.type === 'hline') { line(0, a.y, g.w, a.y); label(fmtP(d.a.price), g.w - 2, a.y, col, 'right'); }
  else if (d.type === 'vline') { line(a.x, 0, a.x, g.h); }
  else if (d.type === 'rect') {
    ctx.fillStyle = 'rgba(76,141,255,.12)'; ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y); handles.push(a, b);
  } else if (d.type === 'fib') {
    const x1 = Math.min(a.x, b.x);
    ctx.setLineDash([4, 4]); line(a.x, a.y, b.x, b.y); ctx.setLineDash([]);
    FIBS.forEach((f, i) => {
      const price = d.b.price + (d.a.price - d.b.price) * f; // 0% at the swing end
      const y = S.main.priceToCoordinate(price); if (y == null) return;
      const c = PALETTE[i % PALETTE.length]; ctx.strokeStyle = c; line(x1, y, g.w, y);
      label(`${(f * 100).toFixed(1)}%  ${fmtP(price)}`, x1 + 2, y - 9, c);
    });
    handles.push(a, b);
  } else if (d.type === 'measure') {
    const up = d.b.price >= d.a.price, c = up ? C.up : C.down;
    ctx.fillStyle = up ? 'rgba(47,191,113,.13)' : 'rgba(240,82,79,.13)'; ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.strokeStyle = c; ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    const dp = d.b.price - d.a.price, bars = Math.round(timeToLogical(d.b.time) - timeToLogical(d.a.time));
    label(`${dp >= 0 ? '+' : ''}${fmtP(dp)}  (${fmtPct(dp / d.a.price * 100)})  ·  ${bars} ${t('bars')}`, (a.x + b.x) / 2, Math.min(a.y, b.y) - 12, c, 'center');
  }
  if (sel) { ctx.fillStyle = C.handle; for (const h of handles) { ctx.beginPath(); ctx.arc(h.x, h.y, 3.5, 0, 7); ctx.fill(); } }
}
function frame() {
  requestAnimationFrame(frame);
  if (state.view !== 'chart') return;
  const w = stage.clientWidth, h = stage.clientHeight, dpr = window.devicePixelRatio || 1;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
  const g = geom(); if (!g) return;
  const items = list();
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
  if (e.key === 'Escape') { selected = null; setTool('cursor'); }
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
async function refreshWatch() {
  const syms = watchSymbols();
  if (syms.length) {
    try { const j = await api('/api/screen?symbols=' + syms.map(encodeURIComponent).join(',') + (state.ext ? '&ext=1' : '')); if (!state.ext) watchData.clear(); for (const r of j.rows) watchData.set(r.symbol, r); } catch { /* keep stale values */ }
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
