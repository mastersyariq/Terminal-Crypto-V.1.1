'use strict';
/**
 * chartCore.js — inti terminal chart (state, kamera, render canvas, drawing tools,
 * interaksi, volume profile, HVN, bubble, CVD, heavy absorption).
 *
 * File ini DIBANGUN OTOMATIS dari public/index.html versi asli (backup browser)
 * sehingga logika render & perilakunya identik. Yang diganti hanya "lem" platformnya:
 *   - <canvas> 2D            → Canvas2D shim di atas QPainter  (nodegui/canvas2d.js)
 *   - fetch('/api/...')      → env.api.*   (engine in-process, tanpa HTTP)
 *   - EventSource (SSE)      → env.events (EventEmitter dari engine)
 *   - localStorage           → env.localStorage (file JSON)
 *   - overlay DOM (OHLCV, buffer indicator, loading) → digambar langsung di canvas
 *   - modal/dropdown/kalender → widget Qt (folder nodegui/ui)
 *
 * JANGAN edit manual bagian logika di sini kalau ingin tetap sinkron dengan versi asli.
 */
module.exports = function createChartCore(env) {
  const { cv, ctx, document, localStorage, api, events, ui } = env;
  const requestAnimationFrame = env.requestAnimationFrame;
  const cancelAnimationFrame = env.cancelAnimationFrame;
  const window = env.window || {};

// LAYOUT CONSTANTS
// ════════════════════════════════════════════════
const PA_W   = 82;   // price-axis strip width (right)
const TA_H   = 26;   // time-axis strip height (bottom)
const VOL_R  = 0.14;
const PAD_T  = 12;
const PAD_B  = 6;
const MIN_BW = 1;
const MAX_BW = 100;
const EDGE_BARS = 5; // trigger buffer-more when the oldest bar is within 5 bars of the left edge
const WIB_OFFSET_S = 7 * 3600; // UTC+7 — WIB (Waktu Indonesia Barat)

// Volume Profile per-candle settings
const VP_MIN_BW   = 8;   // minimum barW (px) to render VP overlay
const VP_BINS     = 22;  // number of price buckets per candle
const VP_MAX_FRAC = 0.82; // VP bar extends up to this fraction of barW

// ════════════════════════════════════════════════
// STATE
// ════════════════════════════════════════════════
let bars      = [];
let sym       = 'BTCUSDT';
let tf        = '60';
let tfSec     = 3600;
let nextClose = 0;
let loading   = true;
let indicators = { volume: true, vp: true, bubble: false, cvd: false, ha: false, hvn: false, gamma: false, liq: false };
let tradeAgg  = {};
let bubbleConfig = {
  multiplier: parseFloat(localStorage.getItem('hf_bubble_multiplier') || '1'),
  minToken: parseFloat(localStorage.getItem('hf_bubble_minToken') || '1')
};
let cvdData = [];
const ALL_CVD_EXCHANGES = ['bybit', 'binance', 'okx', 'mexc', 'bingx', 'bitstamp', 'bitunix', 'coinbase'];
let cvdConfig = {
  exchanges: JSON.parse(localStorage.getItem('hf_cvd_exchanges') || JSON.stringify(ALL_CVD_EXCHANGES))
};
let cvdExchangeStatus = []; // Holds latest API connection statuses

// ── Heavy Absorption state ──
let haData = [];  // Array of { barTime, price, volume, side }

// ── HVN Profile state ──
let hvnZones = [];     // Array of { top, bottom, poc, startIdx, touched, isPOC, volume, pct }
let hvnPeriods = [];   // Cached volume profile histograms per anchor period
let hvnConfig = {
  anchor: localStorage.getItem('hf_hvn_anchor') || 'D',       // D, 240, 60, 30, 15, W
  rowTicks: parseInt(localStorage.getItem('hf_hvn_rowTicks') || '20'),
  threshold: parseInt(localStorage.getItem('hf_hvn_threshold') || '70'),
  gapTol: parseInt(localStorage.getItem('hf_hvn_gapTol') || '1'),
  minCluster: parseInt(localStorage.getItem('hf_hvn_minCluster') || '1'),
  graceBars: parseInt(localStorage.getItem('hf_hvn_graceBars') || '2'),
  maxZones: parseInt(localStorage.getItem('hf_hvn_maxZones') || '15'),
  showPOC: localStorage.getItem('hf_hvn_showPOC') !== 'false',
  showProfile: localStorage.getItem('hf_hvn_showProfile') !== 'false',
  showLabels: localStorage.getItem('hf_hvn_showLabels') !== 'false'
};
let hvnDirty = true; // Flag to recompute HVN zones
let volMultiplier = 1.0;
let cvdMultiplier = 1.0;
let volPaneHeight = null;
let cvdPaneHeight = null;

// ── Camera ──
// bx(i) = (i - leftBar + 0.5) * barW  — same continuous-index model as before.
// Panning (leftBar -= dx/barW) is already pixel-exact.
// Zooming now anchors at the PHANTOM "next bar" position (i = bars.length),
// a fixed screen reference point independent of cursor — this matches the
// reference terminal (order-flow-heatmap/Footprint.tsx), which zooms the
// same way: multiplying candle width while the right-edge reference point
// stays put, rather than trying to keep whatever's under the cursor fixed.
let leftBar = 0, barW = 10;

// ── Price scale ──
// psCtr  : locked price center (null = auto-compute from visible bars)
// psHalf : locked half-range in price units (null = auto-compute from visible bars * psf)
// psf    : scale multiplier applied when psHalf is null (auto mode)
// Both psCtr and psHalf are set together when the user starts panning,
// so NEITHER the center nor the span drifts as new bars come into view.
let psf = 1.0, psCtr = null, psHalf = null;

// ── Mouse / drag state ──
let mx = -1, my = -1;
let dragMode = null;      // null | 'pan' | 'zoomX' | 'zoomY'
let lastMX = 0, lastMY = 0;

// On-demand history buffering (TradingView-style lazy load)
// bufGen is incremented on every pair/TF switch; triggerBufferMore captures
// it at call-time and discards the response if the generation has changed.
const bufState = { busy: false, reachedStart: false, target: 5000, gen: 0 };

// ── Volume Profile sub-bar cache ──
// Key: `${symbol}:${subInterval}` → sorted array of {time, high, low, volume}
// A separate covered-range Map tracks what time windows have been fetched.
const vpCache     = new Map(); // cacheKey → bar[]
const vpCovered   = new Map(); // cacheKey → { min, max } (seconds)
let   vpFetching  = false;
let   vpFetchTimer = null;

// Map: main TF → Bybit sub-interval for VP source data
const VP_SUB_IV = { '5':'1','15':'1','30':'1','60':'1','240':'5','D':'60','W':'240' };
function vpSubIv(mainTf) { return VP_SUB_IV[String(mainTf)] || null; }

// Momentum / inertia panning (horizontal only — bonus on top of the
// reference model, not present there, but doesn't conflict with it)
let velX = 0, lastMoveT = 0, lastMoveX = 0, momentumRAF = null;

// Logical canvas dimensions (unscaled/CSS pixels)
let wWidth = 0, wHeight = 0;

const CW   = () => wWidth - PA_W;
const CH   = () => wHeight - TA_H;

function getPaneLayout() {
  const ch = CH();
  let mainH = ch;
  let volH = 0;
  let cvdH = 0;
  
  const showVol = indicators.volume;
  const showCvd = indicators.cvd;
  
  // Dynamic height configuration with fallback defaults (12% of container)
  const defaultH = Math.floor(ch * 0.12);
  const targetVolH = volPaneHeight !== null ? volPaneHeight : defaultH;
  const targetCvdH = cvdPaneHeight !== null ? cvdPaneHeight : defaultH;
  
  if (showVol && showCvd) {
    volH = targetVolH;
    cvdH = targetCvdH;
    mainH = ch - volH - cvdH;
  } else if (showVol) {
    volH = volPaneHeight !== null ? volPaneHeight : Math.floor(ch * 0.14);
    mainH = ch - volH;
  } else if (showCvd) {
    cvdH = cvdPaneHeight !== null ? cvdPaneHeight : Math.floor(ch * 0.14);
    mainH = ch - cvdH;
  }
  
  // Safety guard: ensure the main candlestick chart area has at least 100px height
  if (mainH < 100) {
    const excess = 100 - mainH;
    if (showVol && showCvd) {
      volH = Math.max(30, volH - Math.ceil(excess / 2));
      cvdH = Math.max(30, cvdH - Math.floor(excess / 2));
      mainH = ch - volH - cvdH;
    } else if (showVol) {
      volH = Math.max(30, volH - excess);
      mainH = ch - volH;
    } else if (showCvd) {
      cvdH = Math.max(30, cvdH - excess);
      mainH = ch - cvdH;
    }
  }
  
  const volT = mainH;
  const cvdT = mainH + volH;
  
  return { mainH, volH, cvdH, volT, cvdT };
}

const MH   = () => getPaneLayout().mainH;
const VH   = () => getPaneLayout().volH;
const VT   = () => getPaneLayout().volT;
const CVDH = () => getPaneLayout().cvdH;
const CVDT = () => getPaneLayout().cvdT;

const bx   = i => (i - leftBar + 0.5) * barW;
const ib   = x => x / barW + leftBar - 0.5;
const inPA = x => x >= CW();   // over the right price-axis strip
const inTA = y => y >= CH();   // over the bottom time-axis strip

function canvasXY(e) {
  const rect = cv.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function timeToBarIdx(t) {
  if (!bars.length) return 0;
  const lastB = bars[bars.length - 1];
  if (t >= lastB.time) {
    return (bars.length - 1) + (t - lastB.time) / tfSec;
  }
  const firstB = bars[0];
  if (t <= firstB.time) {
    return (t - firstB.time) / tfSec;
  }
  let lo = 0, hi = bars.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].time < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo === 0) return 0;
  const b0 = bars[lo - 1], b1 = bars[lo];
  const span = b1.time - b0.time;
  const frac = span > 0 ? (t - b0.time) / span : 0;
  return lo - 1 + frac;
}

function tp2xy(pt) {
  const pr = calcPR();
  const idx = timeToBarIdx(pt.time);
  return { x: bx(idx), y: p2y(pt.price, pr.lo, pr.hi) };
}

function xy2tp(x, y) {
  const pr = calcPR();
  const i = ib(x);
  let time = 0;
  if (bars.length) {
    if (i >= bars.length - 1) {
      const lastB = bars[bars.length - 1];
      time = Math.round(lastB.time + (i - (bars.length - 1)) * tfSec);
    } else if (i <= 0) {
      const firstB = bars[0];
      time = Math.round(firstB.time + i * tfSec);
    } else {
      const floorIdx = Math.floor(i);
      const ceilIdx = Math.min(bars.length - 1, floorIdx + 1);
      const frac = i - floorIdx;
      time = Math.round(bars[floorIdx].time + frac * (bars[ceilIdx].time - bars[floorIdx].time));
    }
  }
  const price = y2p(y, pr.lo, pr.hi);
  return { time, price };
}

// ════════════════════════════════════════════════
// RESIZE + PAINT SCHEDULING (Qt)
// ════════════════════════════════════════════════
function resize(w, h) {
  wWidth = w; wHeight = h;
  render();
}
/** Di versi browser render() menggambar langsung; di Qt gambar terjadi di paintEvent. */
function render() { env.requestPaint(); }

// ════════════════════════════════════════════════
// OVERLAYS — di versi browser berupa elemen DOM (#ohlcv-ov, #buf-ind, #ld-ov);
// di versi NodeGUI digambar langsung di atas canvas.
// ════════════════════════════════════════════════
let ohlcvBar = null;
let bufIndOn = false;
let loadMsgText = 'Connecting…';
let animTimer = null;

function ensureAnim() {
  if ((loading || bufIndOn) && !animTimer) {
    animTimer = setInterval(() => {
      if (!(loading || bufIndOn)) { clearInterval(animTimer); animTimer = null; }
      env.requestPaint();
    }, 50);
  }
}

function drawSpaced(text, cx, y, font, color, ls) {
  ctx.font = font; ctx.fillStyle = color; ctx.textAlign = 'left';
  let total = 0; const ws = [];
  for (const ch of text) { const w = ctx.measureText(ch).width; ws.push(w); total += w + ls; }
  total -= ls;
  let x = cx - total / 2, i = 0;
  for (const ch of text) { ctx.fillText(ch, x, y); x += ws[i++] + ls; }
}

function drawOhlcvOverlay() {
  const b = ohlcvBar;
  if (!b) return;
  const c = b.close >= b.open ? C.bull : C.bear;
  let x = 10; const y = 22;
  ctx.save();
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  const seg = (txt, font, color) => { ctx.font = font; ctx.fillStyle = color; ctx.fillText(txt, x, y); x += ctx.measureText(txt).width; };
  const gap = () => { ctx.font = '12px Consolas, monospace'; x += ctx.measureText('  ').width; };
  const L = s => seg(s, '10px Consolas, monospace', '#94a3b8');
  const V = s => seg(' ' + s, 'bold 12px Consolas, monospace', c);
  L('O'); V(fmtP(b.open)); gap();
  L('H'); V(fmtP(b.high)); gap();
  L('L'); V(fmtP(b.low)); gap();
  L('C'); V(fmtP(b.close));
  if (b.volume) { gap(); L('V'); seg(' ' + fmtV(b.volume), '12px Consolas, monospace', '#cbd5e1'); }
  if (chartType === 'footprint') {                       // Footprint: buy / sell / delta candle
    const ft = fpCandleTotals(b.time);
    if (ft) {
      const fc = fpColors();
      gap(); L('B'); seg(' ' + fmtFpNum(ft.buy), '12px Consolas, monospace', '#cbd5e1');
      gap(); L('S'); seg(' ' + fmtFpNum(ft.sell), '12px Consolas, monospace', '#cbd5e1');
      gap(); L('\u0394'); seg(' ' + fmtFpNum(ft.delta, true), 'bold 12px Consolas, monospace', ft.delta >= 0 ? fc.upTxt : fc.dnTxt);
    }
  }
  ctx.restore();
}

function drawBufIndicator() {
  const txt = 'Loading history…';
  ctx.save();
  ctx.font = '10.5px Consolas, monospace';
  const tw = ctx.measureText(txt).width;
  const w = 14 + 6 + 7 + tw + 14, h = 24;
  const x0 = Math.round(wWidth / 2 - w / 2), y0 = 10;
  ctx.fillStyle = '#1f1406'; ctx.fillRect(x0, y0, w, h);
  ctx.strokeStyle = '#633307'; ctx.lineWidth = 1; ctx.strokeRect(x0 + 0.5, y0 + 0.5, w - 1, h - 1);
  const a = 0.6 + 0.4 * Math.cos(((Date.now() % 1000) / 1000) * Math.PI * 2);
  ctx.globalAlpha = a; ctx.fillStyle = '#ff8c37';
  ctx.beginPath(); ctx.arc(x0 + 14 + 3, y0 + h / 2, 3, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#f97316'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText(txt, x0 + 14 + 6 + 7, y0 + h / 2 + 0.5);
  ctx.restore();
}

function drawLoadingOverlay() {
  ctx.save();
  ctx.fillStyle = 'rgba(16,19,26,0.96)'; ctx.fillRect(0, 0, wWidth, wHeight);
  const cx = wWidth / 2, cy = wHeight / 2;
  ctx.textBaseline = 'middle';
  drawSpaced('HEDGE FUND TERMINAL', cx, cy - 40, '9px Consolas, monospace', '#64748b', 4);
  drawSpaced('HF', cx, cy - 16, 'bold 15px Consolas, monospace', '#ff8c37', 4);
  const bw = 200, bx0 = Math.round(cx - bw / 2), by0 = Math.round(cy + 8);
  ctx.fillStyle = '#252b3d'; ctx.fillRect(bx0, by0, bw, 2);
  const t = (Date.now() % 1400) / 1400;
  const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  const fw = bw * 0.35, px = bx0 + fw * (-1 + 3.9 * e), N = 14, sw = fw / N;
  ctx.save(); ctx.beginPath(); ctx.rect(bx0, by0, bw, 2); ctx.clip();
  ctx.fillStyle = '#ff8c37';
  for (let k = 0; k < N; k++) { ctx.globalAlpha = Math.sin(Math.PI * (k + 0.5) / N); ctx.fillRect(px + k * sw, by0, sw + 0.5, 2); }
  ctx.restore();
  drawSpaced(loadMsgText, cx, cy + 30, '10px Consolas, monospace', '#94a3b8', 1.5);
  ctx.restore();
}

function drawToast() {
  if (!toastMsg) return;
  if (Date.now() > toastMsg.until) { toastMsg = null; return; }
  ctx.save();
  ctx.font = 'bold 11px Consolas, monospace';
  const tw2 = ctx.measureText(toastMsg.text).width;
  const w = tw2 + 28, h = 26;
  const x0 = Math.round(wWidth / 2 - w / 2), y0 = 44;
  ctx.fillStyle = '#2a1a08'; ctx.fillRect(x0, y0, w, h);
  ctx.strokeStyle = '#8c450a'; ctx.lineWidth = 1; ctx.strokeRect(x0 + 0.5, y0 + 0.5, w - 1, h - 1);
  ctx.fillStyle = '#ff8c37'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText(toastMsg.text, x0 + 14, y0 + h / 2 + 0.5);
  ctx.restore();
}

function drawOverlays() {
  drawOhlcvOverlay();
  drawChartTypeChip();
  if (bufIndOn) drawBufIndicator();
  drawToast();
  if (loading) drawLoadingOverlay();
}

let toastMsg = null;
function showToast(text, ms) {
  const dur = ms || 6000;
  toastMsg = { text, until: Date.now() + dur };
  render();
  setTimeout(() => render(), dur + 80);
}

function showOHLCV(b) { ohlcvBar = b || null; }
function showBufInd(on) { bufIndOn = !!on; ensureAnim(); render(); }


// ════════════════════════════════════════════════
// CAMERA — free movement, fixed-anchor zoom
// (ported from order-flow-heatmap/components/Footprint.tsx)
// ════════════════════════════════════════════════

/**
 * Horizontal zoom. factor>1 = zoom in (bigger bars).
 * Anchors at the phantom "next bar" position (bars.length), a fixed
 * reference point — NOT the mouse cursor. This is the exact behavior of
 * the reference terminal's CANDLE_WIDTH zoom (right-edge-relative,
 * position-independent — the same math runs whether triggered by wheel
 * anywhere on the chart or by dragging the time axis).
 */
function zoomH(f) {
  // Freeze Y scale to current visible range to prevent Y auto-fit shifts during horizontal zoom
  if (psHalf === null && bars.length) {
    const pr = calcPR();
    psHalf = (pr.hi - pr.lo) / 2;
    if (psCtr === null) psCtr = (pr.lo + pr.hi) / 2;
  }
  const nw = Math.max(MIN_BW, Math.min(MAX_BW, barW * f));
  const N  = bars.length;
  leftBar = N + 0.5 - (N - leftBar + 0.5) * barW / nw;
  barW = nw;
}

/**
 * Horizontal zoom anchored at canvas X pixel px — cursor-relative.
 * The bar under the cursor stays visually fixed as you zoom in/out,
 * matching TradingView's scroll-wheel zoom behavior.
 */
function zoomHAtX(px, f) {
  // Freeze Y scale to current visible range to prevent Y auto-fit shifts during horizontal zoom
  if (psHalf === null && bars.length) {
    const pr = calcPR();
    psHalf = (pr.hi - pr.lo) / 2;
    if (psCtr === null) psCtr = (pr.lo + pr.hi) / 2;
  }
  const nw = Math.max(MIN_BW, Math.min(MAX_BW, barW * f));
  if (nw === barW) return;
  const barAtPx = px / barW + leftBar - 0.5;
  leftBar = barAtPx - px / nw + 0.5;
  barW = nw;
}

/** Horizontal pan by dx canvas pixels — already pixel-exact. */
function panH(dx) { leftBar -= dx / barW; }

/**
 * Vertical zoom. factor>1 = zoom in (taller price scale / less range shown).
 * Anchors at the FIXED pane center (matches reference's centerY-anchored
 * priceToY) — the price center (auto-fit or manually set) never shifts
 * just because you zoomed.
 */
/**
 * Vertical zoom. factor < 1 = zoom in (less price range visible).
 * If called from auto mode (psHalf null), first freeze the current range
 * so subsequent panning doesn't disturb the manually set Y scale.
 */
function zoomV(f) {
  if (psHalf === null && bars.length) {
    const pr = calcPR();
    psHalf = (pr.hi - pr.lo) / 2;
    if (psCtr === null) psCtr = (pr.lo + pr.hi) / 2;
  }
  psHalf = Math.max(1e-8, (psHalf ?? 1) * f);
}

/** Vertical pan — shifts the price center by dy canvas pixels worth of price. */
function panV(dy) {
  const pr = calcPR();
  psCtr = (psCtr ?? (pr.lo + pr.hi) / 2) + dy * (pr.hi - pr.lo) / MH();
}

function gotoLatest() { leftBar = bars.length - CW() / barW + 5; resetPS(); }
function resetPS()    { psf = 1.0; psCtr = null; psHalf = null; }
function initCamera() { barW = defaultBarW(); gotoLatest(); }
function shiftCam(prevLen) { const a = bars.length - prevLen; if (a > 0) leftBar += a; }

// ════════════════════════════════════════════════
// PRICE RANGE
// ════════════════════════════════════════════════
function visRange() {
  const L = Math.floor(leftBar), R = Math.ceil(leftBar + CW() / barW);
  return { L: Math.max(0, Math.min(bars.length - 1, L)), R: Math.max(0, Math.min(bars.length - 1, R)) };
}
function calcPR() {
  const { L, R } = visRange(); let lo = Infinity, hi = -Infinity;
  for (let i = L; i <= R; i++) {
    const x = bx(i); if (!bars[i] || x + barW / 2 < 0 || x - barW / 2 > CW()) continue;
    if (bars[i].low < lo) lo = bars[i].low; if (bars[i].high > hi) hi = bars[i].high;
  }
  if (lo === Infinity) { const l = bars[bars.length - 1]; if (!l) return { lo: 0, hi: 1 }; lo = l.low * .999; hi = l.high * 1.001; }
  const pad    = (hi - lo) * .06;
  const center = psCtr  ?? ((lo + hi) / 2);
  // psHalf: explicit lock from user pan/zoom. null = auto-compute from visible bars.
  const half   = psHalf ?? ((hi - lo + pad * 2) / 2 * psf);
  return { lo: center - half, hi: center + half };
}
function calcMV() { const { L, R } = visRange(); let m = 0; for (let i = L; i <= R; i++) if (bars[i]?.volume > m) m = bars[i].volume; return m || 1; }
function p2y(p, lo, hi) { return PAD_T + (1 - (p - lo) / (hi - lo)) * (MH() - PAD_T - PAD_B); }
function y2p(y, lo, hi) { return lo + (1 - (y - PAD_T) / (MH() - PAD_T - PAD_B)) * (hi - lo); }
function v2y(v, mV)     { return VT() + (VH() - 2) * (1 - v / (mV * volMultiplier)); }

// ════════════════════════════════════════════════
// COLORS
// ════════════════════════════════════════════════
const C = {
  bg: '#10131a',
  grid: '#1c2230',
  axisArea: '#141722',
  axisBorder: '#232736',
  axisText: '#94a3b8',
  bull: '#26a69a',
  bear: '#ef5350',
  neutral: '#8892a0',
  volBull: 'rgba(38,166,154,.35)',
  volBear: 'rgba(239,83,80,.35)',
  cpLine: 'rgba(255,140,55,.85)',
  cpBg: '#2a1a08',
  cpText: '#ff8c37',
  cpBorder: '#8c450a',
  cdText: '#ff8c37',
  cross: 'rgba(255,255,255,.45)',
  dash: [2, 2],
  xLbl: '#2a1a08',
  xLblT: '#ff8c37',
  startMark: '#3e475c'
};

// ════════════════════════════════════════════════
// RENDER
// ════════════════════════════════════════════════
function renderNow() {
  if (!wWidth || !wHeight) return;
  const W = CW(), H = CH(), MHv = MH();
  ctx.fillStyle = C.bg; ctx.fillRect(0, 0, wWidth, wHeight);
  if (!bars.length) { ctx.font = '12px Consolas,monospace'; ctx.fillStyle = '#94a3b8'; ctx.textAlign = 'center'; ctx.fillText('Waiting for data…', W / 2, H / 2); drawOverlays(); return; }

  const pr = calcPR(), mV = calcMV(), { L, R } = visRange();
  drawGrid(pr, W, MHv);

  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, W, MHv); ctx.clip();
  // Draw VP profiles FIRST (behind candles) for M5+ TF when zoomed in enough
  if (indicators.vp) {
    const subIv = vpSubIv(tf);
    if (subIv && barW >= VP_MIN_BW) {
      const vpBars = vpCache.get(`${sym}:${subIv}`) || [];
      if (vpBars.length) {
        for (let i = L; i <= R; i++) {
          const x = bx(i); if (x + barW / 2 < 0 || x - barW / 2 > W) continue;
          drawCandleVP(bars[i], x, pr, vpBars);
        }
      }
    }
  }
  if (indicators.hvn) {
    try {
      if (hvnDirty) computeHVN(); else hvnRefresh();
      drawHVN(L, R, pr);
    } catch (e) { console.warn('[HVN render error]', e); }
  }
  if (indicators.liq) {
    try { drawLiquidity(L, R, pr); } catch (e) { console.warn('[Liquidity render error]', e); }
  }
  if (indicators.gamma) {
    try { drawGamma(L, R, pr); } catch (e) { console.warn('[Gamma render error]', e); }
  }
  for (let i = L; i <= R; i++) {
    const x = bx(i); if (x + barW / 2 < 0 || x - barW / 2 > W) continue;
    drawBarByType(bars[i], x, barW, pr); 
  }
  if (indicators.bubble) {
    drawBubbles(L, R, pr);
  }
  if (indicators.ha) {
    try { drawHeavyAbsorption(L, R, pr); }
    catch (e) { console.warn('[HA render error]', e); }
  }
  // Draw technical analysis drawing objects (Line, Rect, Fibo, Path, Long/Short)
  try {
    drawAllObjects(pr, W, MHv);
  } catch (e) { console.warn('[Draw render error]', e); }
  if (bufState.reachedStart) {
    const x0 = bx(0);
    if (x0 >= -50 && x0 <= W + 50) {
      ctx.strokeStyle = C.startMark; ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(x0, PAD_T); ctx.lineTo(x0, MHv - PAD_B); ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  ctx.restore();

  // Draw solid panel backgrounds to cover any wicks and draw borders
  ctx.strokeStyle = '#232736'; ctx.lineWidth = 2;
  if (indicators.volume) {
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, VT(), W, VH());
    ctx.beginPath(); ctx.moveTo(0, VT()); ctx.lineTo(W, VT()); ctx.stroke();
    
    // Clip volume drawing to inner volume panel area
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, VT() + 1, W, VH() - 2);
    ctx.clip();
    for (let i = L; i <= R; i++) {
      const x = bx(i); if (x + barW / 2 < 0 || x - barW / 2 > W) continue;
      drawVol(bars[i], x, barW, mV);
    }
    ctx.restore();
  }
  if (indicators.cvd) {
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, CVDT(), W, CVDH());
    ctx.beginPath(); ctx.moveTo(0, CVDT()); ctx.lineTo(W, CVDT()); ctx.stroke();
    
    // Clip CVD drawing to inner CVD panel area
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, CVDT() + 1, W, CVDH() - 2);
    ctx.clip();
    drawCVD(L, R, W);
    ctx.restore();
  }

  // Draw indicators name watermarks & status check in the top-left corner of each active pane
  ctx.save();
  ctx.font = 'bold 9px Consolas, monospace';
  ctx.textAlign = 'left';

  if (indicators.volume) {
    ctx.fillStyle = '#94a3b8';
    ctx.fillText('VOLUME', 10, VT() + 14);
  }

  if (indicators.cvd) {
    const EX_ABBR = {
      bybit: 'BY', binance: 'BN', okx: 'OK', mexc: 'MX',
      bingx: 'BX', bitstamp: 'BS', bitunix: 'BU', coinbase: 'CB'
    };

    let curX = 10;
    
    // 1. Draw Main Title label
    ctx.fillStyle = '#94a3b8';
    ctx.fillText('AGG. CVD SPOT', curX, CVDT() + 14);
    curX += ctx.measureText('AGG. CVD SPOT').width + 8;
    
    // 2. Draw exchange statuses from left to right
    if (cvdExchangeStatus && cvdExchangeStatus.length) {
      // Draw vertical separator divider
      ctx.fillStyle = '#3e465e';
      ctx.fillText('|', curX, CVDT() + 14);
      curX += ctx.measureText('|').width + 8;
      
      for (const ex of cvdExchangeStatus) {
        const dotColor = ex.ok ? '#26a69a' : '#ef5350';
        const label = (EX_ABBR[ex.id] || ex.id.substring(0,2).toUpperCase()) + ':';
        
        // Draw Exchange Abbreviation Code
        ctx.fillStyle = '#cbd5e1';
        ctx.fillText(label, curX, CVDT() + 14);
        curX += ctx.measureText(label).width + 3;
        
        // Draw Status Dot
        ctx.fillStyle = dotColor;
        ctx.fillText('●', curX, CVDT() + 14);
        curX += ctx.measureText('●').width + 8;
      }
    }
  }
  ctx.restore();
  
  drawPAxis(pr, W, MHv); drawTAxis(L, R, W, H);
  drawCurPrice(livePrice(), pr, W);

  if (mx >= 0 && mx < W && my >= 0 && my < H) drawCross(pr, W, H, MHv);
  else showOHLCV(bars[bars.length - 1]);

  drawOverlays();
  maybeBufferMore();
  scheduleVpFetch(); // request VP sub-bar data for visible range if needed
}
function drawGrid(pr, W, MHv) { const s = niceStep(pr.hi - pr.lo, 8); let p = Math.ceil(pr.lo / s) * s; ctx.strokeStyle = C.grid; ctx.lineWidth = 1; while (p <= pr.hi) { const y = p2y(p, pr.lo, pr.hi); if (y >= PAD_T && y <= MHv - PAD_B) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); } p += s; } }
function drawCandle(b, x, bw, pr) {
  const oy = p2y(b.open, pr.lo, pr.hi), cy = p2y(b.close, pr.lo, pr.hi),
        hy = p2y(b.high, pr.lo, pr.hi), ly = p2y(b.low,  pr.lo, pr.hi);
  const col = b.close > b.open ? C.bull : b.close < b.open ? C.bear : C.neutral;
  // Body width: 48% of slot — leaves right half for VP profile
  const bW = Math.max(1, bw * 0.48);
  const bT = Math.min(oy, cy), bH = Math.max(1, Math.abs(cy - oy));
  ctx.strokeStyle = col;
  ctx.lineWidth = Math.max(1, bw < 5 ? 0.8 : 1);
  ctx.beginPath(); ctx.moveTo(x, hy); ctx.lineTo(x, ly); ctx.stroke();
  ctx.fillStyle = col;
  bH < 1.5 ? ctx.fillRect(x - bW / 2, bT - 0.75, bW, 1.5)
            : ctx.fillRect(x - bW / 2, bT, bW, bH);
}
function drawVol(b, x, bw, mV) {
  if (!b?.volume) return;
  const top = v2y(b.volume, mV), bot = VT() + VH() - 2;
  const w = Math.max(1, bw * 0.48);
  ctx.fillStyle = b.close >= b.open ? C.volBull : C.volBear;
  ctx.fillRect(x - w / 2, top, w, Math.max(1, bot - top));
}

function drawCVD(L, R, W) {
  if (!cvdData || !cvdData.length) return;

  const cvdMap = new Map();
  cvdData.forEach(item => cvdMap.set(item.time, item));

  // Compute live CVD delta for the current incomplete bar in real-time
  const lastB = bars[bars.length - 1];
  if (lastB) {
    const prevB = bars[bars.length - 2];
    const prevCvdObj = prevB ? cvdMap.get(prevB.time) : null;
    const baseCvd = prevCvdObj ? prevCvdObj.cvd : 0;
    
    const h = lastB.high, l = lastB.low, c = lastB.close, v = lastB.volume;
    let liveDelta = 0;
    if (h > l && v > 0) {
      liveDelta = v * (((c - l) - (h - c)) / (h - l));
    }
    cvdMap.set(lastB.time, {
      time: lastB.time,
      delta: liveDelta,
      cvd: baseCvd + liveDelta
    });
  }

  // Determine local min/max of estimated CVD OHLC in visible window for precise Y-axis scaling
  let minVal = Infinity;
  let maxVal = -Infinity;
  
  for (let i = L; i <= R; i++) {
    if (bars[i]) {
      const cur = cvdMap.get(bars[i].time);
      if (cur) {
        const prev = i > 0 ? cvdMap.get(bars[i - 1].time) : cur;
        const prevCvd = prev ? prev.cvd : cur.cvd;
        const curCvd = cur.cvd;
        const delta = curCvd - prevCvd;
        const absDelta = Math.abs(delta);
        
        // Estimate wicks based on price candle wicks ratio
        const rp = bars[i].high - bars[i].low;
        let wUpper = 0, wLower = 0;
        if (rp > 0) {
          wUpper = (bars[i].high - Math.max(bars[i].open, bars[i].close)) / rp;
          wLower = (Math.min(bars[i].open, bars[i].close) - bars[i].low) / rp;
        }
        
        const cvdOpen = prevCvd;
        const cvdClose = curCvd;
        const cvdHigh = Math.max(cvdOpen, cvdClose) + wUpper * absDelta;
        const cvdLow = Math.min(cvdOpen, cvdClose) - wLower * absDelta;
        
        if (cvdLow < minVal) minVal = cvdLow;
        if (cvdHigh > maxVal) maxVal = cvdHigh;
      }
    }
  }

  if (minVal === Infinity || maxVal === -Infinity) return;

  const top = CVDT() + 4;
  const bot = CVDT() + CVDH() - 4;

  const getCvdY = (val) => {
    if (maxVal === minVal) return (top + bot) / 2;
    const center = (minVal + maxVal) / 2;
    const halfSpan = ((maxVal - minVal) / 2) * cvdMultiplier;
    const lo = center - halfSpan;
    const hi = center + halfSpan;
    if (hi === lo) return (top + bot) / 2;
    return bot - ((val - lo) / (hi - lo)) * (bot - top);
  };

  // Render CVD candles
  for (let i = L; i <= R; i++) {
    if (bars[i]) {
      const x = bx(i);
      const cur = cvdMap.get(bars[i].time);
      if (cur) {
        const prev = i > 0 ? cvdMap.get(bars[i - 1].time) : cur;
        const prevCvd = prev ? prev.cvd : cur.cvd;
        const curCvd = cur.cvd;
        const delta = curCvd - prevCvd;
        const absDelta = Math.abs(delta);
        
        const rp = bars[i].high - bars[i].low;
        let wUpper = 0, wLower = 0;
        if (rp > 0) {
          wUpper = (bars[i].high - Math.max(bars[i].open, bars[i].close)) / rp;
          wLower = (Math.min(bars[i].open, bars[i].close) - bars[i].low) / rp;
        }
        
        const cvdOpen = prevCvd;
        const cvdClose = curCvd;
        const cvdHigh = Math.max(cvdOpen, cvdClose) + wUpper * absDelta;
        const cvdLow = Math.min(cvdOpen, cvdClose) - wLower * absDelta;
        
        const yOpen = getCvdY(cvdOpen);
        const yClose = getCvdY(cvdClose);
        const yHigh = getCvdY(cvdHigh);
        const yLow = getCvdY(cvdLow);
        
        const isBullish = cvdClose >= cvdOpen;
        const col = isBullish ? '#26a69a' : '#ef5350';
        
        // Detect Divergence (opposing directions of price candle vs CVD candle)
        const isPriceBull = bars[i].close > bars[i].open;
        const isPriceBear = bars[i].close < bars[i].open;
        const isCvdBull = cvdClose > cvdOpen;
        const isCvdBear = cvdClose < cvdOpen;
        const isDivergent = (isPriceBull && isCvdBear) || (isPriceBear && isCvdBull);
        
        // Draw wick
        ctx.strokeStyle = col;
        ctx.lineWidth = Math.max(1, barW < 5 ? 0.8 : 1);
        ctx.beginPath();
        ctx.moveTo(x, yHigh);
        ctx.lineTo(x, yLow);
        ctx.stroke();
        
        // Draw body
        const bW = Math.max(1, barW * 0.48);
        const bT = Math.min(yOpen, yClose);
        const bH = Math.max(1, Math.abs(yClose - yOpen));
        
        ctx.fillStyle = col;
        if (bH < 1.5) {
          ctx.fillRect(x - bW / 2, bT - 0.75, bW, 1.5);
        } else {
          ctx.fillRect(x - bW / 2, bT, bW, bH);
        }
        
        // Draw yellow outline around body if divergence is active
        if (isDivergent) {
          ctx.strokeStyle = '#ffd700'; // gold yellow
          ctx.lineWidth = 1.5;
          if (bH < 1.5) {
            ctx.strokeRect(x - bW / 2, bT - 0.75, bW, 1.5);
          } else {
            ctx.strokeRect(x - bW / 2, bT, bW, bH);
          }
        }
      }
    }
  }
}

function getBucketSize(price) {
  if (price >= 10000)   return 10;
  if (price >= 1000)    return 1;
  if (price >= 100)     return 0.1;
  if (price >= 10)      return 0.01;
  if (price >= 1)       return 0.001;
  if (price >= 0.01)    return 0.00001;
  if (price >= 0.0001)  return 0.0000001;
  return 0.000000001;
}

// Format token amount for bubble labels: 1-999 as number, 1000+ as 1K, 1M, etc.
function fmtTokenShort(v) {
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  if (v < 10) return v.toFixed(1);
  return Math.round(v).toString();
}

function drawBubbles(L, R, pr) {
  const minTok = bubbleConfig.minToken;
  const mult = bubbleConfig.multiplier;

  // X-axis zoom: barW relative to reference
  const REF_BW = 10;
  const zoomX = barW / REF_BW;

  // Y-axis zoom: compare natural price range of visible bars to actual displayed range
  let natLo = Infinity, natHi = -Infinity;
  for (let i = L; i <= R; i++) {
    if (!bars[i]) continue;
    if (bars[i].low < natLo) natLo = bars[i].low;
    if (bars[i].high > natHi) natHi = bars[i].high;
  }
  const natRange = natHi > natLo ? (natHi - natLo) : 1;
  const dispRange = pr.hi - pr.lo || 1;
  const zoomY = natRange / dispRange;  // >1 when Y zoomed in, <1 when zoomed out

  // Combine X and Y zoom using geometric mean for uniform circle scaling
  const zoomScale = Math.sqrt(Math.sqrt(zoomX) * Math.sqrt(zoomY));

  const BASE_MIN_R = 4;   // base minimum radius (px)
  const BASE_MAX_R = BASE_MIN_R * 5;  // base max = 5x min = 20px
  const minR = BASE_MIN_R * mult * zoomScale;
  const maxR = BASE_MAX_R * mult * zoomScale;
  
  let maxV = 0;
  const candleBubbles = new Map();

  // Scan visible window: find the single largest level per candle that passes the token threshold
  for (let i = L; i <= R; i++) {
    const b = bars[i];
    if (!b) continue;
    const levels = tradeAgg[b.time];
    if (!levels) continue;
    
    let bestLevel = null;
    let maxLevelVol = 0;
    
    for (const pStr in levels) {
      const price = parseFloat(pStr);
      const lv = levels[pStr];
      const buyVal = parseFloat(lv.buy || 0);
      const sellVal = parseFloat(lv.sell || 0);
      const tot = buyVal + sellVal;
      
      // Filter by minimum token/coin amount
      if (minTok > 0 && tot < minTok) continue;
      
      if (tot > maxLevelVol) {
        maxLevelVol = tot;
        bestLevel = { price, tot, buy: buyVal, sell: sellVal };
      }
    }
    
    if (bestLevel) {
      candleBubbles.set(b.time, bestLevel);
      if (bestLevel.tot > maxV) maxV = bestLevel.tot;
    }
  }
  
  if (maxV <= 0) return;

  // Draw the single bubble per candle
  for (let i = L; i <= R; i++) {
    const b = bars[i];
    if (!b) continue;
    const x = bx(i);
    
    const bubble = candleBubbles.get(b.time);
    if (!bubble) continue;

    const y = p2y(bubble.price, pr.lo, pr.hi);
    if (y < PAD_T || y > MH() - PAD_B) continue;

    // Size based on absolute token amount relative to min threshold
    const capTok = minTok > 0 ? minTok * 5 : maxV;  // cap at 5× minimum
    let t;
    if (minTok > 0) {
      // Absolute scaling: 0 at minTok, 1 at 5×minTok
      t = Math.min(1, (bubble.tot - minTok) / (capTok - minTok));
    } else {
      // No minimum set: relative sqrt scaling within visible window
      t = Math.sqrt(bubble.tot / maxV);
    }
    let radius = minR + t * (maxR - minR);
    const isCapped = minTok > 0 ? bubble.tot > capTok : radius >= maxR;
    radius = Math.min(radius, maxR);

    const buyVol = bubble.buy;
    const sellVol = bubble.sell;
    const isNetBuy = buyVol > sellVol;

    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = isNetBuy ? 'rgba(38, 166, 154, 0.55)' : 'rgba(239, 83, 80, 0.55)';
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = isNetBuy ? 'rgba(38, 166, 154, 0.8)' : 'rgba(239, 83, 80, 0.8)';
    ctx.stroke();

    // Draw value label only when order size reaches 5× minimum
    if (isCapped && radius >= 8) {
      ctx.save();
      const fontSize = Math.max(7, Math.min(10, radius * 0.55));
      ctx.font = `bold ${fontSize}px Consolas, monospace`;
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.globalAlpha = 0.95;
      ctx.fillText(fmtTokenShort(bubble.tot), x, y);
      ctx.restore();
    }
  }
}

// ════════════════════════════════════════════════
// HEAVY ABSORPTION — fetch & draw (Image 1)
// ════════════════════════════════════════════════
async function fetchHA() {
  try {
    const j = await api.heavyAbsorption();
    if (j.ok && j.symbol === sym) haData = j.data || [];
  } catch (e) { console.warn('[HA] fetch error:', e); }
}

// Collects all Heavy Absorption points (combines real-time WS prints + statistical historical prints)
function getHeavyAbsorptionDetections(L, R) {
  const detections = [];
  if (!bars || bars.length < 15) return detections;

  const HA_LOOKBACK = haConfig.lookback;
  const HA_STDEV_MULT = haConfig.stdevTenth / 10;
  const HA_WICK = haConfig.wickPct / 100;

  // 1. Map real-time WS detections from server
  const serverTimes = new Set();
  if (haData && haData.length) {
    for (const d of haData) {
      serverTimes.add(d.barTime);
      detections.push(d);
    }
  }

  // 2. Statistical candle-level absorption across chart history (matching Image 1)
  const vols = bars.map(b => b.volume);
  const start = Math.max(0, L - 10);
  const end = Math.min(bars.length - 1, R + 10);

  for (let i = Math.max(15, start); i <= end; i++) {
    const b = bars[i];
    if (serverTimes.has(b.time)) continue; // avoid duplicates with server data

    const wStart = Math.max(0, i - HA_LOOKBACK);
    const win = vols.slice(wStart, i);
    if (win.length < 10) continue;

    const mean = win.reduce((s, v) => s + v, 0) / win.length;
    const variance = win.reduce((s, v) => s + (v - mean) ** 2, 0) / win.length;
    const stdev = Math.sqrt(variance);
    const threshold = mean + HA_STDEV_MULT * stdev;

    if (b.volume >= threshold && b.volume > 0) {
      const span = (b.high - b.low) || 1e-12;
      const upperWick = b.high - Math.max(b.open, b.close);
      const lowerWick = Math.min(b.open, b.close) - b.low;

      // Bull / Buy absorption at high wick (Green circle placed at candle high, like Image 1)
      if (upperWick / span >= HA_WICK || (b.close < b.open && upperWick >= lowerWick)) {
        detections.push({
          barTime: b.time,
          price: b.high,
          volume: b.volume,
          side: 'Buy'
        });
      }
      // Bear / Sell absorption at low wick (Red circle placed at candle low, like Image 1)
      else if (lowerWick / span >= HA_WICK || (b.close > b.open && lowerWick >= upperWick)) {
        detections.push({
          barTime: b.time,
          price: b.low,
          volume: b.volume,
          side: 'Sell'
        });
      }
    }
  }

  return detections;
}

function drawHeavyAbsorption(L, R, pr) {
  if (!bars.length) return;

  const allDetections = getHeavyAbsorptionDetections(L, R);
  if (!allDetections.length) return;

  // Zoom scaling (geometric mean of X and Y zoom)
  const REF_BW = 10;
  const zoomX = barW / REF_BW;
  let natLo = Infinity, natHi = -Infinity;
  for (let i = L; i <= R; i++) {
    if (!bars[i]) continue;
    if (bars[i].low < natLo) natLo = bars[i].low;
    if (bars[i].high > natHi) natHi = bars[i].high;
  }
  const natRange = natHi > natLo ? (natHi - natLo) : 1;
  const dispRange = pr.hi - pr.lo || 1;
  const zoomY = natRange / dispRange;
  const zoomScale = Math.sqrt(Math.sqrt(zoomX) * Math.sqrt(zoomY));

  const MIN_R = 10 * zoomScale;
  const MAX_R = 24 * zoomScale;

  // Build time to index lookup
  const timeToIdx = new Map();
  for (let i = L; i <= R; i++) {
    if (bars[i]) timeToIdx.set(bars[i].time, i);
  }

  const visible = [];
  let maxVol = 0;
  for (const d of allDetections) {
    const idx = timeToIdx.get(d.barTime);
    if (idx === undefined) continue;
    visible.push({ ...d, idx });
    if (d.volume > maxVol) maxVol = d.volume;
  }
  if (!visible.length || maxVol <= 0) return;

  for (const d of visible) {
    const x = bx(d.idx);
    const y = p2y(d.price, pr.lo, pr.hi);
    if (y < PAD_T - 20 || y > MH() - PAD_B + 20) continue;

    const ratio = Math.min(1.0, Math.sqrt(d.volume / maxVol));
    const radius = Math.max(8, MIN_R + ratio * (MAX_R - MIN_R));
    const isBuy = d.side === 'Buy';

    // Circle background fill (Image 1: translucent green or red)
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = isBuy ? 'rgba(38, 166, 154, 0.45)' : 'rgba(239, 83, 80, 0.45)';
    ctx.fill();

    // Circle stroke border (Image 1: solid 1.5px border)
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = isBuy ? '#26a69a' : '#ef5350';
    ctx.stroke();

    // Exact volume label inside circle (Image 1: white text like 405, 550, 760)
    if (radius >= 7) {
      ctx.save();
      const fontSize = Math.max(7, Math.min(11, radius * 0.55));
      ctx.font = `bold ${fontSize}px Consolas, monospace`;
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(fmtTokenShort(d.volume), x, y);
      ctx.restore();
    }
  }
}

// ════════════════════════════════════════════════
// HVN PROFILE — compute & draw
// ════════════════════════════════════════════════
// ════════════════════════════════════════════════
// HVN PROFILE — compute & draw
//
// Mengikuti deskripsi indikator "HVN Profile":
//  1. Riwayat chart dibagi per periode waktu (1m … Weekly); tiap periode dibuatkan volume profile.
//  2. Profile diperhalus (smoothing passes) untuk deteksi plateau → bin yang volumenya ≥ threshold%
//     dari puncak = High Volume Node.
//  3. Node berdekatan digabung jadi cluster (gap tolerance, minimum cluster size).
//     POC = harga dengan volume tertinggi di dalam tiap cluster.
//  4. Tiap zona diperpanjang ke depan sebagai level support/resistance sampai harga menyentuhnya
//     (setelah touch-grace bars) → zona otomatis ditutup + alert.
//  5. Profile periode yang sedang berjalan digambar live (transparansi bisa diatur).
//  6. Max bars back membatasi jumlah bar yang diproses.
// ════════════════════════════════════════════════
const HVN_ANCHOR_SEC = { '1': 60, '5': 300, '15': 900, '30': 1800, '60': 3600, '240': 14400, 'D': 86400, 'W': 604800 };
const HVN_WEEK_OFFSET = 4 * 86400; // epoch = Kamis; minggu Bybit/TradingView dimulai Senin 00:00 UTC

// parameter tambahan sesuai deskripsi (persisten lewat localStorage, prefix hf_hvn_)
(function hvnInitExtraConfig() {
  const geti = (k, d, lo, hi) => { const v = parseInt(localStorage.getItem('hf_hvn_' + k)); return isNaN(v) ? d : Math.max(lo, Math.min(hi, v)); };
  const getb = (k, d) => { const v = localStorage.getItem('hf_hvn_' + k); return v === null ? d : v !== 'false'; };
  hvnConfig.smooth       = geti('smooth', 1, 0, 10);        // smoothing passes
  hvnConfig.maxBarsBack  = geti('maxBarsBack', 5000, 50, 20000);
  hvnConfig.histWidth    = geti('histWidth', 40, 10, 400);  // lebar histogram profile (px)
  hvnConfig.liveProfile  = getb('liveProfile', true);
  hvnConfig.liveTransp   = geti('liveTransp', 60, 0, 100);  // % transparansi profile live
  hvnConfig.alertOn      = getb('alertOn', false);
  if (!HVN_ANCHOR_SEC[hvnConfig.anchor]) hvnConfig.anchor = '60';
  hvnConfig.gapTol     = (Number.isFinite(hvnConfig.gapTol)) ? hvnConfig.gapTol : 1;
  hvnConfig.minCluster = (Number.isFinite(hvnConfig.minCluster)) ? hvnConfig.minCluster : 1;
  hvnConfig.graceBars  = (Number.isFinite(hvnConfig.graceBars)) ? hvnConfig.graceBars : 2;
})();

let hvnTick = 0, hvnTickSym = null; // tickSize resmi (syminfo.mintick) dari Bybit
let hvnLive = null;                 // profile periode berjalan
let hvnCurPeriod = null;            // awal periode terakhir saat compute penuh
let hvnLiveTs = 0;

/** Awal periode untuk timestamp t. Weekly dihitung dari Senin 00:00 UTC (bukan Kamis seperti epoch). */
function hvnAnchorStart(t, anchorSec) {
  if (anchorSec === 604800) return Math.floor((t - HVN_WEEK_OFFSET) / 604800) * 604800 + HVN_WEEK_OFFSET;
  return Math.floor(t / anchorSec) * anchorSec;
}

function hvnDecimals(v) {
  const s = String(v);
  const m = /^-?([\d.]+)e-(\d+)$/.exec(s);
  if (m) return Math.min(12, (m[1].split('.')[1] || '').length + parseInt(m[2]));
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : Math.min(12, s.length - dot - 1);
}

/** syminfo.mintick: pakai tickSize dari Bybit; fallback ke presisi desimal data bar. */
function hvnMintick() {
  if (hvnTick > 0 && hvnTickSym === sym) return hvnTick;
  let maxDec = 0;
  for (let i = Math.max(0, bars.length - 300); i < bars.length; i++) {
    const b = bars[i];
    maxDec = Math.max(maxDec, hvnDecimals(b.open), hvnDecimals(b.high), hvnDecimals(b.low), hvnDecimals(b.close));
  }
  return maxDec > 0 ? Math.pow(10, -maxDec) : 0.1;
}

function hvnLoadTick(s) {
  if (hvnTickSym === s && hvnTick > 0) return;
  Promise.resolve()
    .then(() => (api.tickSize ? api.tickSize(s) : null))
    .then(t => { if (t > 0 && s === sym) { hvnTick = t; hvnTickSym = s; hvnDirty = true; render(); } })
    .catch(() => {});
}

/** Volume profile satu periode: volume tiap bar disebar rata di seluruh bin antara low–high. */
function hvnBuildProfile(idxs, rowHeight) {
  const volMap = new Map();    // bin → volume
  const buyVolMap = new Map(); // bin → volume beli (estimasi)
  let maxBinVol = 0;
  for (const bi of idxs) {
    const b = bars[bi];
    const topBin = Math.floor(b.high / rowHeight);
    const botBin = Math.floor(b.low / rowHeight);
    const nBins = topBin - botBin + 1;
    const bSpan = (b.high - b.low) || 1e-12;
    const isUp = b.close >= b.open;
    const buyFrac = isUp ? Math.min(0.9, Math.max(0.3, (b.close - b.low) / bSpan))
                         : Math.min(0.7, Math.max(0.1, (b.close - b.low) / bSpan));
    if (nBins > 200) {
      const singleBin = Math.floor(b.close / rowHeight);
      const nv = (volMap.get(singleBin) || 0) + b.volume;
      volMap.set(singleBin, nv);
      buyVolMap.set(singleBin, (buyVolMap.get(singleBin) || 0) + b.volume * buyFrac);
      if (nv > maxBinVol) maxBinVol = nv;
    } else {
      const volPerBin = b.volume / nBins;
      const buyPerBin = (b.volume * buyFrac) / nBins;
      for (let bin = botBin; bin <= topBin; bin++) {
        const nv = (volMap.get(bin) || 0) + volPerBin;
        volMap.set(bin, nv);
        buyVolMap.set(bin, (buyVolMap.get(bin) || 0) + buyPerBin);
        if (nv > maxBinVol) maxBinVol = nv;
      }
    }
  }
  return { volMap, buyVolMap, maxBinVol };
}

/** Smoothing passes: kernel [1,2,1]/4 diulang N kali (volume di luar rentang harga dianggap 0; hasil dipotong ke rentang yang diperdagangkan). */
function hvnSmooth(volMap, passes) {
  if (!passes || volMap.size < 2) return volMap;
  let lo = Infinity, hi = -Infinity;
  for (const k of volMap.keys()) { if (k < lo) lo = k; if (k > hi) hi = k; }
  const span = hi - lo + 1;
  if (span > 200000) return volMap;
  const pad = passes;                 // ruang agar volume bisa "merembes" ke tetangga di tepi rentang
  const n = span + 2 * pad;
  let a = new Float64Array(n), b = new Float64Array(n);
  for (const [k, v] of volMap) a[k - lo + pad] = v;
  for (let p = 0; p < passes; p++) {
    for (let i = 0; i < n; i++) {
      const l = i > 0 ? a[i - 1] : 0, r = i < n - 1 ? a[i + 1] : 0;
      b[i] = (l + 2 * a[i] + r) / 4;
    }
    const t = a; a = b; b = t;
  }
  const out = new Map();
  for (let i = pad; i < pad + span; i++) if (a[i] > 0) out.set(lo + i - pad, a[i]); // hanya bin di rentang low–high periode
  return out;
}

function computeHVN() {
  hvnZones = [];
  hvnPeriods = [];
  hvnLive = null;
  hvnDirty = false;
  if (!bars || !bars.length) return;

  const anchorSec = HVN_ANCHOR_SEC[hvnConfig.anchor] || 86400;
  const rowHeight = (hvnConfig.rowTicks || 20) * hvnMintick();
  if (!(rowHeight > 0)) return;

  // Max bars back (performa)
  const firstIdx = Math.max(0, bars.length - (hvnConfig.maxBarsBack || 5000));

  // Kelompokkan bar ke periode
  const periods = new Map(); // awal periode → [indeks bar]
  for (let i = firstIdx; i < bars.length; i++) {
    const aTime = hvnAnchorStart(bars[i].time, anchorSec);
    let arr = periods.get(aTime);
    if (!arr) { arr = []; periods.set(aTime, arr); }
    arr.push(i);
  }

  const curPeriod = hvnAnchorStart(bars[bars.length - 1].time, anchorSec); // periode berjalan → belum final
  hvnCurPeriod = curPeriod;

  // Periode pertama yang datanya terpotong (histori belum lengkap) tidak dipakai: profilenya tidak akurat
  const firstKey = hvnAnchorStart(bars[firstIdx].time, anchorSec);
  const firstPartial = bars[firstIdx].time > firstKey + tfSec && !(firstIdx === 0 && bufState.reachedStart);

  const grace = hvnConfig.graceBars ?? 2;
  const thrFrac = (hvnConfig.threshold || 70) / 100;
  const gapTol = hvnConfig.gapTol ?? 1;
  const minCluster = hvnConfig.minCluster ?? 1;

  for (const [pTime, barIdxs] of periods) {
    if (pTime === curPeriod) continue;
    if (pTime === firstKey && firstPartial) continue;

    const pf = hvnBuildProfile(barIdxs, rowHeight);
    if (pf.maxBinVol <= 0) continue;
    const { volMap, buyVolMap, maxBinVol } = pf;
    const startIdx = barIdxs[barIdxs.length - 1]; // bar terakhir periode

    // Cache histogram untuk render profile vertikal (data asli, tanpa smoothing)
    hvnPeriods.push({ startIdx, barIdxs, volMap, maxBinVol, rowHeight });

    // HVN = bin dengan volume (setelah smoothing) ≥ threshold% dari puncak
    const sm = hvnSmooth(volMap, hvnConfig.smooth);
    let maxS = 0;
    for (const v of sm.values()) if (v > maxS) maxS = v;
    const thrVol = thrFrac * maxS;
    const qualBins = [];
    for (const [bin, v] of sm) if (v >= thrVol) qualBins.push(bin);
    if (!qualBins.length) continue;
    qualBins.sort((a, b) => a - b);

    // Cluster: bin berdekatan digabung (gap tolerance), buang cluster < minimum size
    const clusters = [];
    let gs = qualBins[0], ge = qualBins[0], gc = 1;
    for (let i = 1; i < qualBins.length; i++) {
      const k = qualBins[i];
      if (k - ge <= gapTol + 1) { ge = k; gc++; }
      else { if (gc >= minCluster) clusters.push({ bot: gs, top: ge }); gs = k; ge = k; gc = 1; }
    }
    if (gc >= minCluster) clusters.push({ bot: gs, top: ge });
    if (!clusters.length) continue;

    // POC tiap cluster = bin volume tertinggi (volume asli) di dalam cluster
    let bestVol = -1, bestIdx = 0;
    clusters.forEach((c, ci) => {
      let pb = c.bot, pv = -1;
      for (let bin = c.bot; bin <= c.top; bin++) {
        const v = volMap.get(bin) || 0;
        if (v > pv) { pv = v; pb = bin; }
      }
      c.poc = pb; c.pocVol = pv;
      if (pv > bestVol) { bestVol = pv; bestIdx = ci; }
    });

    clusters.forEach((c, ci) => {
      let cTotVol = 0, cBuyVol = 0;
      for (let bin = c.bot; bin <= c.top; bin++) {
        cTotVol += volMap.get(bin) || 0;
        cBuyVol += buyVolMap.get(bin) || 0;
      }
      hvnZones.push({
        top: (c.top + 1) * rowHeight,
        bottom: c.bot * rowHeight,
        poc: (c.poc + 0.5) * rowHeight,
        startIdx,
        scanFrom: startIdx + 1 + grace, // bar pertama yang boleh "menyentuh" (setelah grace bars)
        scanned: 0,
        endIdx: null,
        touched: false,
        isPOC: ci === bestIdx,           // cluster berisi POC periode → amber, lainnya biru
        volume: cTotVol,
        pct: cTotVol > 0 ? Math.round((cBuyVol / cTotVol) * 100) : 50
      });
    });
  }

  // Batasi jumlah zona (simpan yang terbaru)
  const maxZ = hvnConfig.maxZones || 15;
  while (hvnZones.length > maxZ) hvnZones.shift();

  hvnUpdateTouches(true);
  hvnRefreshLive(true);
}

/** Zona ditutup begitu candle menyentuhnya (setelah grace). silent=true → tanpa alert (hitung ulang histori). */
function hvnUpdateTouches(silent) {
  const n = bars.length;
  for (const z of hvnZones) {
    if (z.touched) continue;
    let j = Math.max(z.scanFrom, z.scanned);
    for (; j < n; j++) {
      const b = bars[j];
      if (b.low <= z.top && b.high >= z.bottom) {
        z.touched = true;
        z.endIdx = j;
        if (!silent && hvnConfig.alertOn) hvnAlert(z);
        break;
      }
    }
    if (!z.touched) z.scanned = Math.max(z.scanFrom, n - 1); // bar berjalan dicek ulang tiap update
  }
}

function hvnAlert(z) {
  const msg = `HVN zone touched \u00b7 ${sym}  ${fmtP(z.bottom)} \u2013 ${fmtP(z.top)}`;
  console.log('[HVN Alert]', msg);
  showToast(msg, 8000);
  if (ui && typeof ui.notify === 'function') { try { ui.notify(msg); } catch (e) {} }
}

/** Profile periode berjalan (live). */
function hvnRefreshLive(force) {
  if (!hvnConfig.liveProfile || !bars.length) { hvnLive = null; return; }
  const now = Date.now();
  if (!force && now - hvnLiveTs < 250) return;
  hvnLiveTs = now;
  const anchorSec = HVN_ANCHOR_SEC[hvnConfig.anchor] || 86400;
  const rowHeight = (hvnConfig.rowTicks || 20) * hvnMintick();
  if (!(rowHeight > 0)) { hvnLive = null; return; }
  const curKey = hvnAnchorStart(bars[bars.length - 1].time, anchorSec);
  const idxs = [];
  for (let i = bars.length - 1; i >= 0; i--) {
    if (hvnAnchorStart(bars[i].time, anchorSec) !== curKey) break;
    idxs.push(i);
  }
  idxs.reverse();
  const pf = hvnBuildProfile(idxs, rowHeight);
  hvnLive = pf.maxBinVol > 0
    ? { startIdx: bars.length - 1, barIdxs: idxs, volMap: pf.volMap, maxBinVol: pf.maxBinVol, rowHeight, live: true }
    : null;
}

/** Dipanggil tiap render saat tidak dirty: update touch + profile live; periode baru → hitung ulang penuh. */
function hvnRefresh() {
  if (!bars.length) return;
  const anchorSec = HVN_ANCHOR_SEC[hvnConfig.anchor] || 86400;
  if (hvnAnchorStart(bars[bars.length - 1].time, anchorSec) !== hvnCurPeriod) { computeHVN(); return; }
  hvnUpdateTouches(false);
  hvnRefreshLive(false);
}

function drawHVN(L, R, pr) {
  if (!bars || !bars.length) return;
  const W = CW();

  // ── Draw profile histogram silhouettes (vertical bars) if enabled ──
  if (hvnConfig.showProfile) {
    const profW = hvnConfig.histWidth || 40; // pixel width for the profile silhouette
    const list = hvnLive ? hvnPeriods.concat([hvnLive]) : hvnPeriods;
    const liveScale = (1 - (hvnConfig.liveTransp ?? 60) / 100) / 0.4;
    for (const pd of list) {
      if (pd.startIdx > R) continue;
      const x0 = bx(pd.startIdx);
      if (x0 + profW < 0) continue;
      const aScale = pd.live ? liveScale : 1;

      for (const [bin, vol] of pd.volMap) {
        const binTop = (bin + 1) * pd.rowHeight;
        const binBot = bin * pd.rowHeight;
        const y1 = p2y(binTop, pr.lo, pr.hi);
        const y2 = p2y(binBot, pr.lo, pr.hi);
        const yt = Math.max(PAD_T, Math.min(y1, y2));
        const yb = Math.min(MH() - PAD_B, Math.max(y1, y2));
        const bh = yb - yt;
        if (bh < 0.5) continue;

        const ratio = vol / pd.maxBinVol;
        const barW = ratio * profW;
        ctx.fillStyle = `rgba(100, 180, 255, ${Math.min(0.9, (0.08 + ratio * 0.15) * aScale)})`;
        ctx.fillRect(x0, yt, barW, bh);
      }
    }
  }

  // ── Draw HVN zone boxes ──
  if (!hvnZones.length) return;

  for (const z of hvnZones) {
    if (z.startIdx > R) continue;

    const y1 = p2y(z.top, pr.lo, pr.hi);
    const y2 = p2y(z.bottom, pr.lo, pr.hi);
    if (y1 > MH() - PAD_B && y2 > MH() - PAD_B) continue;
    if (y1 < PAD_T && y2 < PAD_T) continue;

    const x1 = Math.max(0, bx(z.startIdx));
    // Zona belum tersentuh → selalu sampai 5 bar setelah candle terakhir (ikut bergeser saat bar baru);
    // zona tersentuh → berhenti di bar sentuhan.
    const endIdx = z.touched ? z.endIdx : bars.length - 1 + 5;
    const x2 = Math.min(W, bx(endIdx));
    const yt = Math.max(PAD_T, Math.min(y1, y2));
    const yb = Math.min(MH() - PAD_B, Math.max(y1, y2));
    const h = yb - yt;
    if (h < 1 || x2 <= x1) continue;

    // Color: isPOC → amber/orange, secondary → blue
    // Touched zones become grey
    if (z.touched) {
      ctx.fillStyle = 'rgba(128, 128, 128, 0.12)';
      ctx.strokeStyle = 'rgba(128, 128, 128, 0.25)';
    } else if (z.isPOC) {
      ctx.fillStyle = 'rgba(230, 150, 20, 0.22)';
      ctx.strokeStyle = 'rgba(230, 150, 20, 0.55)';
    } else {
      ctx.fillStyle = 'rgba(66, 133, 244, 0.18)';
      ctx.strokeStyle = 'rgba(66, 133, 244, 0.45)';
    }
    ctx.fillRect(x1, yt, x2 - x1, h);
    ctx.lineWidth = 1;
    ctx.strokeRect(x1, yt, x2 - x1, h);

    // POC line (dashed orange)
    if (hvnConfig.showPOC) {
      const yPoc = p2y(z.poc, pr.lo, pr.hi);
      if (yPoc >= PAD_T && yPoc <= MH() - PAD_B) {
        ctx.save();
        ctx.beginPath();
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = z.touched ? 'rgba(255, 165, 0, 0.30)' : 'rgba(255, 165, 0, 0.75)';
        ctx.lineWidth = 1;
        ctx.moveTo(x1, yPoc);
        ctx.lineTo(x2, yPoc);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }
    }

    // Label 2 Angka di Paling Kanan Box ([Volume] | [Percent]%)
    // Labels always sit at the right edge of the box (x2 - 5px)
    if (hvnConfig.showLabels !== false && h >= 7) {
      const rx = Math.min(x2, W);
      const boxW = rx - x1;
      if (boxW >= 28) {
        ctx.save();
        const midY = (yt + yb) / 2;
        const fontSize = Math.max(7.5, Math.min(10, h * 0.7));
        ctx.font = `bold ${fontSize}px Consolas, monospace`;
        ctx.textBaseline = 'middle';

        const volStr = fmtTokenShort(z.volume);
        const hasPct = (z.pct != null) && boxW >= 65;

        if (hasPct) {
          const pctStr = `${z.pct}%`;
          const sepStr = ' | ';
          const pctW = ctx.measureText(pctStr).width;
          const sepW = ctx.measureText(sepStr).width;
          const volW = ctx.measureText(volStr).width;
          const totW = volW + sepW + pctW;

          if (boxW >= totW + 8) {
            let curRx = rx - 5;
            ctx.textAlign = 'right';
            ctx.fillStyle = z.pct >= 50 ? '#26a69a' : '#ef5350';
            ctx.fillText(pctStr, curRx, midY);
            curRx -= pctW;

            ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
            ctx.fillText(sepStr, curRx, midY);
            curRx -= sepW;

            ctx.fillStyle = '#ffffff';
            ctx.fillText(volStr, curRx, midY);
          } else {
            ctx.textAlign = 'right';
            ctx.fillStyle = '#ffffff';
            ctx.fillText(volStr, rx - 5, midY);
          }
        } else {
          ctx.textAlign = 'right';
          ctx.fillStyle = '#ffffff';
          ctx.fillText(volStr, rx - 5, midY);
        }
        ctx.restore();
      }
    }
  }
}

/**
 * Per-candle Volume Profile.
 * Draws horizontal bars to the RIGHT of the candle body, using the gap
 * between the candle body (48% of barW) and the right edge of the slot.
 * Extends up to VP_MAX_FRAC * barW from the candle CENTER so profiles
 * of adjacent candles stay visually separate.
 * POC (Point of Control = highest-volume bin) is drawn in gold.
 */
function drawCandleVP(bar, x, pr, subBars) {
  const openSec  = bar.time;
  const closeSec = bar.time + tfSec;
  const range    = bar.high - bar.low;
  if (range <= 0) return;

  // Binary-search: find first sub-bar at or after openSec
  let lo = 0, hi = subBars.length - 1, startIdx = subBars.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (subBars[mid].time < openSec) lo = mid + 1;
    else { startIdx = mid; hi = mid - 1; }
  }
  if (startIdx >= subBars.length) return;

  // Accumulate volume into price buckets
  const binSz = range / VP_BINS;
  const vols  = new Float64Array(VP_BINS);
  for (let k = startIdx; k < subBars.length; k++) {
    const sb = subBars[k];
    if (sb.time >= closeSec) break;
    const sbSpan = (sb.high - sb.low) || 1e-12;
    for (let bi = 0; bi < VP_BINS; bi++) {
      const binLo = bar.low + bi * binSz;
      const binHi = binLo + binSz;
      const ov = Math.max(0, Math.min(sb.high, binHi) - Math.max(sb.low, binLo));
      if (ov > 0) vols[bi] += sb.volume * (ov / sbSpan);
    }
  }

  const maxVol = Math.max(...vols);
  if (maxVol === 0) return;

  const pocBin  = vols.indexOf(maxVol);
  const isBull  = bar.close >= bar.open;

  // VP starts at the RIGHT edge of the candle body (body = 48% of barW)
  // and extends to the right, capped at VP_MAX_FRAC * barW from bar center.
  const bodyHalfW = barW * 0.24 + 1;  // half of 48% body + 1px gap
  const vpStart   = x + bodyHalfW;    // left edge of VP area
  const vpMaxW    = barW * VP_MAX_FRAC - bodyHalfW; // available width for VP
  if (vpMaxW < 2) return;

  ctx.save();
  for (let bi = 0; bi < VP_BINS; bi++) {
    if (vols[bi] === 0) continue;
    const pLo = bar.low + bi * binSz;
    const pHi = pLo + binSz;
    const y1  = p2y(pHi, pr.lo, pr.hi);
    const y2  = p2y(pLo, pr.lo, pr.hi);
    const bh  = Math.max(1, y2 - y1 - 0.5);
    const bw  = (vols[bi] / maxVol) * vpMaxW;
    if (bi === pocBin) {
      ctx.fillStyle = 'rgba(255,200,50,0.85)'; // POC: gold
    } else {
      ctx.fillStyle = isBull
        ? 'rgba(38,166,154,0.40)'
        : 'rgba(239,83,80,0.40)';
    }
    ctx.fillRect(vpStart, y1, bw, bh);
  }
  ctx.restore();
}

function drawPAxis(pr, W, MHv) {
  ctx.fillStyle = C.axisArea;
  ctx.fillRect(W, 0, PA_W, wHeight);
  ctx.strokeStyle = C.axisBorder;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(W, 0);
  ctx.lineTo(W, wHeight);
  ctx.stroke();

  ctx.font = '10px Consolas,monospace';
  ctx.textAlign = 'left';

  // 1. Main Price Axis
  const s = niceStep(pr.hi - pr.lo, 8);
  let p = Math.ceil(pr.lo / s) * s;
  while (p <= pr.hi) {
    const y = p2y(p, pr.lo, pr.hi);
    if (y >= PAD_T && y <= MHv - PAD_B) {
      ctx.strokeStyle = C.axisBorder;
      ctx.beginPath();
      ctx.moveTo(W, y);
      ctx.lineTo(W + 3, y);
      ctx.stroke();
      ctx.fillStyle = C.axisText;
      ctx.fillText(fmtP(p), W + 6, y + 3.5);
    }
    p += s;
  }

  // 2. Volume Axis Scale
  if (indicators.volume) {
    const mV = calcMV();
    const yTop = VT() + 4;
    const yBot = VT() + VH() - 4;
    ctx.strokeStyle = C.axisBorder;
    ctx.beginPath();
    ctx.moveTo(W, yTop); ctx.lineTo(W + 3, yTop);
    ctx.moveTo(W, yBot); ctx.lineTo(W + 3, yBot);
    ctx.stroke();
    ctx.fillStyle = C.axisText;
    ctx.fillText(fmtV(mV), W + 6, yTop + 3.5);
    ctx.fillText('0', W + 6, yBot + 3.5);
  }

  // 3. CVD Axis Scale
  if (indicators.cvd && cvdData && cvdData.length) {
    const { L, R } = visRange();
    const cvdMap = new Map();
    cvdData.forEach(item => cvdMap.set(item.time, item));
    let minVal = Infinity, maxVal = -Infinity;
    
    for (let i = L; i <= R; i++) {
      if (bars[i]) {
        const cur = cvdMap.get(bars[i].time);
        if (cur) {
          const prev = i > 0 ? cvdMap.get(bars[i - 1].time) : cur;
          const prevCvd = prev ? prev.cvd : cur.cvd;
          const curCvd = cur.cvd;
          const delta = curCvd - prevCvd;
          const absDelta = Math.abs(delta);
          
          const rp = bars[i].high - bars[i].low;
          let wUpper = 0, wLower = 0;
          if (rp > 0) {
            wUpper = (bars[i].high - Math.max(bars[i].open, bars[i].close)) / rp;
            wLower = (Math.min(bars[i].open, bars[i].close) - bars[i].low) / rp;
          }
          const cvdHigh = Math.max(prevCvd, curCvd) + wUpper * absDelta;
          const cvdLow = Math.min(prevCvd, curCvd) - wLower * absDelta;
          
          if (cvdLow < minVal) minVal = cvdLow;
          if (cvdHigh > maxVal) maxVal = cvdHigh;
        }
      }
    }
    
    if (minVal !== Infinity && maxVal !== -Infinity) {
      const yTop = CVDT() + 4;
      const yBot = CVDT() + CVDH() - 4;
      ctx.strokeStyle = C.axisBorder;
      ctx.beginPath();
      ctx.moveTo(W, yTop); ctx.lineTo(W + 3, yTop);
      ctx.moveTo(W, yBot); ctx.lineTo(W + 3, yBot);
      ctx.stroke();
      ctx.fillStyle = C.axisText;
      ctx.fillText(fmtV(maxVal), W + 6, yTop + 3.5);
      ctx.fillText(fmtV(minVal), W + 6, yBot + 3.5);
    }
  }
}

function drawTAxis(L, R, W, H) {
  ctx.fillStyle = C.axisArea; ctx.fillRect(0, H, wWidth, TA_H);
  ctx.strokeStyle = C.axisBorder; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, H); ctx.lineTo(wWidth, H); ctx.stroke();
  ctx.font = '10px Consolas,monospace'; ctx.fillStyle = C.axisText; ctx.textAlign = 'center';
  // Adaptive spacing: iterate with a rough step, then skip labels whose
  // rendered text would overlap the previous one. This handles all zoom levels
  // correctly without needing separate logic per timeframe.
  const step = Math.max(1, Math.ceil(50 / barW));
  let lastEndX = -9999;
  for (let i = L; i <= R; i += step) {
    if (!bars[i]) continue;
    const x = bx(i);
    if (x < 0 || x > W) continue;
    const lbl = fmtT(bars[i].time, tf);
    const tw = ctx.measureText(lbl).width;
    if (x - tw / 2 <= lastEndX + 8) continue; // skip overlapping labels
    ctx.fillText(lbl, x, H + 17);
    lastEndX = x + tw / 2;
  }
}

function drawCurPrice(price, pr, W) {
  if (price == null || price < pr.lo || price > pr.hi) return;
  const y = p2y(price, pr.lo, pr.hi);
  ctx.save(); ctx.setLineDash(C.dash); ctx.strokeStyle = C.cpLine; ctx.lineWidth = 1; ctx.globalAlpha = .5;
  ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); ctx.restore();
  const lbl = fmtP(price), BH = 18, BW = PA_W - 3, BX = W + 1;
  ctx.fillStyle = C.cpBg; ctx.fillRect(BX, y - BH / 2, BW, BH);
  ctx.strokeStyle = C.cpBorder; ctx.lineWidth = 1; ctx.strokeRect(BX, y - BH / 2, BW, BH);
  ctx.fillStyle = C.cpText; ctx.font = 'bold 10px Consolas,monospace'; ctx.textAlign = 'center';
  ctx.fillText(lbl, BX + BW / 2, y + 3.5);
  // Countdown — prefer nextClose set by Bybit WS; fall back to estimating from
  // the last bar's open time + tfSec so it shows even before the first WS tick.
  const lastB = timeBars[timeBars.length - 1];
  const effClose = nextClose > 0 ? nextClose : (lastB ? lastB.time + tfSec : 0);
  const rem = effClose - Date.now() / 1000;
  if (chartType !== 'renko' && rem > 0 && rem < tfSec * 1.5) {
    const cdY = Math.min(y + BH / 2 + 10, MH() - 8); // clamp: stay inside chart area
    const cdH = 13;
    const cdW = BW - 6;
    const cdX = BX + 3;
    
    // Draw background box for the countdown to block overlapping items
    ctx.fillStyle = '#1c1005'; // warm amber dark background
    ctx.fillRect(cdX, cdY - cdH / 2, cdW, cdH);
    ctx.strokeStyle = '#8c450a'; // warm amber border
    ctx.lineWidth = 1;
    ctx.strokeRect(cdX, cdY - cdH / 2, cdW, cdH);
    
    ctx.font = 'bold 9px Consolas,monospace';
    ctx.fillStyle = C.cdText;
    ctx.fillText(fmtCd(rem), BX + BW / 2, cdY + 3);
  }
}

function drawCross(pr, W, H, MHv) {
  ctx.save();
  ctx.strokeStyle = C.cross;
  ctx.lineWidth = 1.25; // slightly wider pixel line for better visibility
  ctx.setLineDash(C.dash);
  
  // Draw full vertical crosshair
  ctx.beginPath(); ctx.moveTo(mx, PAD_T); ctx.lineTo(mx, H); ctx.stroke();
  
  // Draw full horizontal crosshair (regardless of panel borders)
  ctx.beginPath(); ctx.moveTo(0, my); ctx.lineTo(W, my); ctx.stroke();
  ctx.setLineDash([]); ctx.restore();

  // Determine which sub-panel cursor is on and draw Y-axis label accordingly
  let yLabelText = '';
  
  if (my < MHv) {
    const p = y2p(my, pr.lo, pr.hi);
    if (p > 0) yLabelText = fmtP(p);
  } else if (indicators.volume && my >= VT() && my < VT() + VH()) {
    const mV = calcMV();
    const v = mV * (1 - (my - VT()) / (VH() - 2));
    if (v >= 0) yLabelText = fmtV(v);
  } else if (indicators.cvd && my >= CVDT() && my < CVDT() + CVDH() && cvdData && cvdData.length) {
    const { L, R } = visRange();
    const cvdMap = new Map();
    cvdData.forEach(item => cvdMap.set(item.time, item));
    let minVal = Infinity, maxVal = -Infinity;
    for (let i = L; i <= R; i++) {
      if (bars[i]) {
        const cur = cvdMap.get(bars[i].time);
        if (cur) {
          const prev = i > 0 ? cvdMap.get(bars[i - 1].time) : cur;
          const prevCvd = prev ? prev.cvd : cur.cvd;
          const curCvd = cur.cvd;
          const delta = curCvd - prevCvd;
          const absDelta = Math.abs(delta);
          const rp = bars[i].high - bars[i].low;
          let wUpper = 0, wLower = 0;
          if (rp > 0) {
            wUpper = (bars[i].high - Math.max(bars[i].open, bars[i].close)) / rp;
            wLower = (Math.min(bars[i].open, bars[i].close) - bars[i].low) / rp;
          }
          const cvdHigh = Math.max(prevCvd, curCvd) + wUpper * absDelta;
          const cvdLow = Math.min(prevCvd, curCvd) - wLower * absDelta;
          if (cvdLow < minVal) minVal = cvdLow;
          if (cvdHigh > maxVal) maxVal = cvdHigh;
        }
      }
    }
    if (minVal !== Infinity && maxVal !== -Infinity) {
      const top = CVDT() + 4;
      const bot = CVDT() + CVDH() - 4;
      const cvdVal = maxVal - ((my - top) / (bot - top)) * (maxVal - minVal);
      yLabelText = fmtV(cvdVal);
    }
  }

  if (yLabelText) {
    ctx.fillStyle = C.xLbl;
    ctx.fillRect(W + 1, my - 8, PA_W - 3, 16);
    ctx.fillStyle = C.xLblT;
    ctx.font = '10px Consolas,monospace';
    ctx.textAlign = 'left';
    ctx.fillText(yLabelText, W + 5, my + 3.5);
  }

  const idx = Math.round(ib(mx));
  if (idx >= 0 && idx < bars.length) {
    const b = bars[idx], lbl = fmtTD(b.time, tf);
    ctx.font = '10px Consolas,monospace'; ctx.textAlign = 'center';
    const tw = ctx.measureText(lbl).width + 14, lx = Math.min(Math.max(mx, tw / 2 + 2), W - tw / 2 - 2);
    ctx.fillStyle = C.xLbl; ctx.fillRect(lx - tw / 2, H, tw, TA_H);
    ctx.fillStyle = C.xLblT; ctx.fillText(lbl, lx, H + 17);
    showOHLCV(b);
  }
}
// ════════════════════════════════════════════════
// ON-DEMAND BUFFERING
// Triggered when the user scrolls left far enough to see empty canvas
// (i.e. bar index 0 is no longer at/past the left screen edge).
// ════════════════════════════════════════════════
function maybeBufferMore() {
  if (bufState.busy || bufState.reachedStart || !bars.length) return;
  // Pixel X of the LEFT edge of bar index 0 (oldest candle)
  const bar0LeftPx = bx(0) - barW / 2;
  // Trigger when bar 0 is within EDGE_BARS bar-widths of the left canvas edge,
  // i.e. the user is starting to see (or already seeing) empty space.
  if (bar0LeftPx < EDGE_BARS * barW) triggerBufferMore();
}

async function triggerBufferMore() {
  if (bufState.busy || bufState.reachedStart) return;
  bufState.busy = true;
  const myGen = bufState.gen; // capture: if pair switches, gen increments and we abort
  showBufInd(true);
  try {
    const oldestKnownSec = timeBars.length ? timeBars[0].time : null;
    const d = await api.bufferMore(oldestKnownSec);

    // Discard response if a pair/TF switch happened while we were waiting.
    // This prevents prepending BTC bars onto a PEPE chart after a switch.
    if (myGen !== bufState.gen) {
      bufState.busy = false;
      showBufInd(false);
      return;
    }

    if (d.busy) { bufState.busy = false; showBufInd(false); return; }

    if (d.ok && d.newBars && d.newBars.length) {
      // Extra guard: only prepend bars that are genuinely older than current bars[0]
      const currentOldest = timeBars.length ? timeBars[0].time : Infinity;
      const safeNew = d.newBars.filter(b => b.time < currentOldest);
      if (safeNew.length) {
        timeBars = [...safeNew, ...timeBars];
        ctAfterPrepend(safeNew.length);
        hvnDirty = true; // HVN needs recomputation with expanded history
        document.getElementById('sb-bars').textContent = `Bars: ${bars.length}`;
      }
    }
    bufState.reachedStart = !!d.reachedStart;
    bufState.target       = d.target ?? bufState.target;
  } catch (e) {
    console.error('buffer-more failed:', e.message);
  } finally {
    bufState.busy = false;
    showBufInd(false);
    render();
  }
}


// ════════════════════════════════════════════════
// DRAWING SYSTEM
// Tools: line, rect, fibo, path, longshort
// Storage: localStorage + server /api/drawings (Shared per Symbol)
// ════════════════════════════════════════════════
const DEFAULT_CONFIGS = {
  line: { color: '#e87722', lineWidth: 1.5, lineDash: 'solid' },
  rect: {
    borderColor: '#3b82f6',
    borderWidth: 2,
    borderDash: 'solid',
    fillColor: '#3b82f6',
    fillOpacity: 0.15,
    hasBorder: true,
    hasFill: true,
  },
  fibo: {
    color: '#ffffff',
    lineWidth: 1,
    lineDash: 'solid',
    levels: [0, 0.5, 0.618, 1, 1.618],
    levelColors: {
      '0': '#00bcd4',
      '0.5': '#ffd600',
      '0.618': '#ffffff',
      '1': '#ffffff',
      '1.618': '#ffd600'
    }
  },
  path: { color: '#4fc3f7', lineWidth: 2, lineDash: 'solid' },
  longshort: {
    direction: 'long',
    targetColor: '#26a69a',
    targetOpacity: 0.22,
    stopColor: '#ef5350',
    stopOpacity: 0.32,
    lineWidth: 1,
    showText: true
  }
};

function getToolConfig(type) {
  try {
    const raw = localStorage.getItem('hf_default_draw_configs');
    if (raw) {
      const saved = JSON.parse(raw);
      if (saved && saved[type]) return JSON.parse(JSON.stringify(saved[type]));
    }
  } catch {}
  return JSON.parse(JSON.stringify(DEFAULT_CONFIGS[type] || DEFAULT_CONFIGS.line));
}

function saveToolConfig(type, cfg) {
  try {
    let all = {};
    const raw = localStorage.getItem('hf_default_draw_configs');
    if (raw) all = JSON.parse(raw) || {};
    all[type] = JSON.parse(JSON.stringify(cfg));
    localStorage.setItem('hf_default_draw_configs', JSON.stringify(all));
  } catch {}
}

let DM = {
  drawings: [],
  activeTool: null,
  drawing: null,
  selected: null,
  hoveredId: null,
  dragState: null,
};

let drawInProgress = false;
let isDraggingDraw = false;

function genId() { return 'd_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function getDash(style) {
  if (style === 'dashed') return [6, 4];
  if (style === 'dotted') return [2, 4];
  return [];
}

function drawAllObjects(pr, W, MHv) {
  for (const d of DM.drawings) {
    const isSelected = DM.selected === d.id;
    const isHovered  = DM.hoveredId === d.id;
    drawSingleObject(d, pr, W, MHv, isSelected || isHovered, false);
  }
  if (DM.drawing) {
    drawSingleObject(DM.drawing, pr, W, MHv, false, true);
  }
}

function drawSingleObject(obj, pr, W, MHv, highlighted, inProgress) {
  if (!obj.points || !obj.points.length) return;
  const pts = obj.points.map(p => tp2xy(p));
  const cfg = obj.config || getToolConfig(obj.type);

  ctx.save();
  ctx.strokeStyle = cfg.color || cfg.borderColor || '#e87722';
  ctx.lineWidth   = cfg.lineWidth ?? cfg.borderWidth ?? 1.5;
  ctx.setLineDash(getDash(cfg.lineDash || cfg.borderDash));

  switch(obj.type) {
    case 'line':      drawObjLine(pts, cfg, W, MHv); break;
    case 'rect':      drawObjRect(pts, cfg); break;
    case 'fibo':      drawObjFibo(pts, obj.points, cfg, pr, W); break;
    case 'path':      drawObjPath(pts, cfg, inProgress); break;
    case 'longshort': drawObjLongShort(pts, obj.points, cfg, pr, W); break;
  }

  ctx.setLineDash([]);
  ctx.restore();

  if (highlighted && !inProgress) {
    drawObjectHandles(obj);
  }
}

function drawObjLine(pts, cfg, W, MHv) {
  if (pts.length < 2) return;
  const [p1, p2] = pts;
  ctx.beginPath();
  ctx.moveTo(p1.x, p1.y);
  ctx.lineTo(p2.x, p2.y);
  ctx.stroke();
}

function drawObjRect(pts, cfg) {
  if (pts.length < 2) return;
  const x1 = Math.min(pts[0].x, pts[1].x);
  const y1 = Math.min(pts[0].y, pts[1].y);
  const w  = Math.abs(pts[1].x - pts[0].x);
  const h  = Math.abs(pts[1].y - pts[0].y);

  if (cfg.hasFill !== false && (cfg.fillOpacity ?? 0.15) > 0) {
    ctx.save();
    ctx.fillStyle = cfg.fillColor || cfg.borderColor || '#3b82f6';
    ctx.globalAlpha = cfg.fillOpacity ?? 0.15;
    ctx.fillRect(x1, y1, w, h);
    ctx.restore();
  }
  const bw = cfg.borderWidth ?? cfg.lineWidth ?? 2;
  if (cfg.hasBorder !== false && bw > 0) {
    ctx.save();
    ctx.strokeStyle = cfg.borderColor || cfg.color || '#3b82f6';
    ctx.lineWidth = bw;
    ctx.setLineDash(getDash(cfg.borderDash || cfg.lineDash));
    ctx.strokeRect(x1, y1, w, h);
    ctx.restore();
  }
}

function drawObjFibo(pts, tpts, cfg, pr, W) {
  if (pts.length < 2) return;
  const p1 = tpts[0].price;
  const p2 = tpts[1].price;
  const x1 = pts[0].x, x2 = pts[1].x;
  const levels = cfg.levels || [0, 0.5, 0.618, 1, 1.618];
  const levelColors = cfg.levelColors || {
    '0': '#00bcd4',
    '0.5': '#ffd600',
    '0.618': '#ffffff',
    '1': '#ffffff',
    '1.618': '#ffd600'
  };

  const minX = Math.min(x1, x2);
  const maxX = Math.max(x1, x2);

  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(x1, pts[0].y);
  ctx.lineTo(x2, pts[1].y);
  ctx.stroke();
  ctx.restore();

  const lw = cfg.lineWidth ?? 1;

  for (const lvl of levels) {
    const price = p2 + (p1 - p2) * lvl;
    const y = p2y(price, pr.lo, pr.hi);
    const col = levelColors[String(lvl)] || cfg.color || '#ffffff';

    if (lw > 0) {
      ctx.save();
      ctx.strokeStyle = col;
      ctx.lineWidth   = lw;
      ctx.setLineDash(getDash(cfg.lineDash));
      ctx.beginPath();
      ctx.moveTo(minX, y);
      ctx.lineTo(maxX, y);
      ctx.stroke();
      ctx.restore();
    }

    ctx.fillStyle = col;
    ctx.font = '10px Consolas,monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`${lvl} (${fmtP(price)})`, maxX + 6, y + 3.5);
  }
}

function drawObjPath(pts, cfg, inProgress) {
  if (!pts.length) return;
  const lw = cfg.lineWidth ?? 2;
  if (lw > 0) {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) {
      ctx.lineTo(pts[i].x, pts[i].y);
    }
    ctx.stroke();
  }

  if (pts.length >= 2) {
    const last = pts[pts.length - 1];
    const prev = pts[pts.length - 2];
    drawArrowHead(prev, last, cfg.color || '#4fc3f7', Math.max(1, lw));
  }

  ctx.fillStyle = cfg.color || '#4fc3f7';
  for (const p of pts) {
    ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI * 2); ctx.fill();
  }
}

function drawArrowHead(from, to, color, lw) {
  const dx = to.x - from.x, dy = to.y - from.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 2) return;
  const angle = Math.atan2(dy, dx);
  const size  = 9 + lw * 1.5;
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - size * Math.cos(angle - 0.45), to.y - size * Math.sin(angle - 0.45));
  ctx.lineTo(to.x - (size * 0.7) * Math.cos(angle), to.y - (size * 0.7) * Math.sin(angle));
  ctx.lineTo(to.x - size * Math.cos(angle + 0.45), to.y - size * Math.sin(angle + 0.45));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawObjLongShort(pts, tpts, cfg, pr, W) {
  if (pts.length < 2) return;
  const isLong = (cfg.direction || 'long') === 'long';
  const entryP  = tpts[0].price;
  const targetP = tpts[1].price;
  const stopP   = tpts.length >= 3 ? tpts[2].price : (entryP - (targetP - entryP) * 0.5);

  const entryY  = pts[0].y;
  const targetY = pts[1].y;
  const stopY   = p2y(stopP, pr.lo, pr.hi);

  const leftX  = Math.min(pts[0].x, pts[1].x);
  const rightX = Math.max(pts[0].x, pts[1].x);
  const w = rightX - leftX;

  ctx.save();

  // Target Box (Top)
  ctx.fillStyle = cfg.targetColor || '#26a69a';
  ctx.globalAlpha = cfg.targetOpacity ?? 0.22;
  ctx.fillRect(leftX, Math.min(entryY, targetY), w, Math.abs(targetY - entryY));

  // Stop Box (Bottom)
  ctx.fillStyle = cfg.stopColor || '#ef5350';
  ctx.globalAlpha = cfg.stopOpacity ?? 0.32;
  ctx.fillRect(leftX, Math.min(entryY, stopY), w, Math.abs(stopY - entryY));

  ctx.globalAlpha = 1;

  const lw = cfg.lineWidth ?? 1;
  if (lw > 0) {
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth = lw;
    ctx.strokeRect(leftX, Math.min(targetY, stopY), w, Math.abs(targetY - stopY));

    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(leftX, entryY); ctx.lineTo(rightX, entryY); ctx.stroke();
  }

  if (cfg.showText) {
    const targetDiff = Math.abs(targetP - entryP);
    const targetPct  = ((targetDiff / Math.max(1e-8, entryP)) * 100).toFixed(3);
    const stopDiff   = Math.max(1e-8, Math.abs(entryP - stopP));
    const stopPct    = ((stopDiff / Math.max(1e-8, entryP)) * 100).toFixed(3);
    const rr = (targetDiff / stopDiff).toFixed(2);
    const midX = (leftX + rightX) / 2;

    drawRoundedBadge(
      midX, Math.min(targetY, entryY) - 10,
      `Target: ${fmtP(targetP)} (${targetPct}%)`,
      'rgba(38,166,154,0.9)', '#ffffff', '#80cbc4'
    );

    drawRoundedBadge(
      midX, entryY,
      `Risk/reward ratio: ${rr}`,
      (isLong ? 'rgba(38,166,154,0.9)' : 'rgba(239,83,80,0.9)'),
      '#ffffff', 'rgba(255,255,255,0.4)'
    );

    drawRoundedBadge(
      midX, Math.max(stopY, entryY) + 10,
      `Stop: ${fmtP(stopP)} (${stopPct}%)`,
      'rgba(239,83,80,0.9)', '#ffffff', '#ff8a80'
    );
  }

  ctx.restore();
}

function drawRoundedBadge(cx, cy, text, bgCol, textCol, borderCol) {
  ctx.save();
  ctx.font = 'bold 9.5px Consolas,monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const padH = 8;
  const tw = ctx.measureText(text).width;
  const w = tw + padH * 2;
  const h = 18;
  const x = cx - w / 2;
  const y = cy - h / 2;

  ctx.fillStyle = bgCol;
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(x, y, w, h, 3) : ctx.rect(x, y, w, h);
  ctx.fill();

  if (borderCol) {
    ctx.strokeStyle = borderCol;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  ctx.fillStyle = textCol;
  ctx.fillText(text, cx, cy);
  ctx.restore();
}

// ════════════════════════════════════════════════
// HANDLES & RESIZING LOGIC
// ════════════════════════════════════════════════
function getHandles(obj) {
  if (!obj || !obj.points || !obj.points.length) return [];
  const pts = obj.points.map(p => tp2xy(p));

  switch(obj.type) {
    case 'rect': {
      if (pts.length < 2) return [];
      const minX = Math.min(pts[0].x, pts[1].x), maxX = Math.max(pts[0].x, pts[1].x);
      const minY = Math.min(pts[0].y, pts[1].y), maxY = Math.max(pts[0].y, pts[1].y);
      const midX = (minX + maxX) / 2, midY = (minY + maxY) / 2;
      return [
        { idx: 0, type: 'nw', x: minX, y: minY, cursor: 'nwse-resize' },
        { idx: 1, type: 'n',  x: midX, y: minY, cursor: 'ns-resize' },
        { idx: 2, type: 'ne', x: maxX, y: minY, cursor: 'nesw-resize' },
        { idx: 3, type: 'e',  x: maxX, y: midY, cursor: 'ew-resize' },
        { idx: 4, type: 'se', x: maxX, y: maxY, cursor: 'nwse-resize' },
        { idx: 5, type: 's',  x: midX, y: maxY, cursor: 'ns-resize' },
        { idx: 6, type: 'sw', x: minX, y: maxY, cursor: 'nesw-resize' },
        { idx: 7, type: 'w',  x: minX, y: midY, cursor: 'ew-resize' },
      ];
    }
    case 'longshort': {
      if (pts.length < 2) return [];
      const pr = calcPR();
      const pEntry  = pts[0];
      const pTarget = pts[1];
      const stopP   = obj.points[2]?.price ?? (obj.points[0].price - (obj.points[1].price - obj.points[0].price) * 0.5);
      const stopY   = p2y(stopP, pr.lo, pr.hi);
      const leftX   = Math.min(pEntry.x, pTarget.x);
      const rightX  = Math.max(pEntry.x, pTarget.x);
      return [
        { idx: 0, type: 'entry',  x: leftX,  y: pEntry.y,  cursor: 'crosshair' },
        { idx: 1, type: 'target', x: leftX,  y: pTarget.y, cursor: 'ns-resize' },
        { idx: 2, type: 'stop',   x: leftX,  y: stopY,     cursor: 'ns-resize' },
        { idx: 3, type: 'width',  x: rightX, y: pEntry.y,  cursor: 'ew-resize' },
      ];
    }
    default: {
      return pts.map((p, i) => ({ idx: i, type: 'point', x: p.x, y: p.y, cursor: 'crosshair' }));
    }
  }
}

function drawObjectHandles(obj) {
  const handles = getHandles(obj);
  for (const h of handles) {
    ctx.save();
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#ff8c37';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(h.x, h.y, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}

function hitTestHandles(obj, x, y) {
  const handles = getHandles(obj);
  for (let i = 0; i < handles.length; i++) {
    if (dist(x, y, handles[i].x, handles[i].y) < 9) return handles[i];
  }
  return null;
}

function dist(ax, ay, bx2, by) { return Math.sqrt((ax - bx2) ** 2 + (ay - by) ** 2); }

function distToSegment(px, py, ax, ay, bx2, by) {
  const dx = bx2 - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-6) return dist(px, py, ax, ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return dist(px, py, ax + t * dx, ay + t * dy);
}

function hitTestObjects(x, y) {
  const pr = calcPR();
  for (let i = DM.drawings.length - 1; i >= 0; i--) {
    const d = DM.drawings[i];
    if (hitTestSingleObject(d, x, y, pr)) return d.id;
  }
  return null;
}

function hitTestSingleObject(obj, x, y, pr) {
  if (!obj.points || !obj.points.length) return false;
  const pts = obj.points.map(p => tp2xy(p));
  const HIT = 8;

  switch(obj.type) {
    case 'line': {
      if (pts.length < 2) return false;
      return distToSegment(x, y, pts[0].x, pts[0].y, pts[1].x, pts[1].y) < HIT;
    }
    case 'rect': {
      if (pts.length < 2) return false;
      const x1 = Math.min(pts[0].x, pts[1].x) - HIT;
      const y1 = Math.min(pts[0].y, pts[1].y) - HIT;
      const x2 = Math.max(pts[0].x, pts[1].x) + HIT;
      const y2 = Math.max(pts[0].y, pts[1].y) + HIT;
      return x >= x1 && x <= x2 && y >= y1 && y <= y2;
    }
    case 'fibo': {
      if (pts.length < 2) return false;
      const minX = Math.min(pts[0].x, pts[1].x) - HIT;
      const maxX = Math.max(pts[0].x, pts[1].x) + HIT;
      if (x < minX || x > maxX) return false;
      const p1 = obj.points[0].price, p2 = obj.points[1].price;
      const levels = obj.config?.levels || [0, 0.5, 0.618, 1, 1.618];
      for (const lvl of levels) {
        const py = p2y(p2 + (p1 - p2) * lvl, pr.lo, pr.hi);
        if (Math.abs(y - py) < HIT) return true;
      }
      return distToSegment(x, y, pts[0].x, pts[0].y, pts[1].x, pts[1].y) < HIT;
    }
    case 'path': {
      for (let i = 0; i < pts.length - 1; i++) {
        if (distToSegment(x, y, pts[i].x, pts[i].y, pts[i+1].x, pts[i+1].y) < HIT) return true;
      }
      for (const p of pts) if (dist(x, y, p.x, p.y) < HIT) return true;
      return false;
    }
    case 'longshort': {
      if (pts.length < 2) return false;
      const leftX  = Math.min(pts[0].x, pts[1].x) - HIT;
      const rightX = Math.max(pts[0].x, pts[1].x) + HIT;
      const stopP  = obj.points[2]?.price ?? (obj.points[0].price - (obj.points[1].price - obj.points[0].price) * 0.5);
      const stopY  = p2y(stopP, pr.lo, pr.hi);
      const minY   = Math.min(pts[0].y, pts[1].y, stopY) - HIT;
      const maxY   = Math.max(pts[0].y, pts[1].y, stopY) + HIT;
      return x >= leftX && x <= rightX && y >= minY && y <= maxY;
    }
  }
  return false;
}

// ════════════════════════════════════════════════
// MOUSE & DRAWING ACTIONS
// ════════════════════════════════════════════════
function drawMouseDown(e) {
  if (!DM.activeTool || e.button !== 0) return false;
  const { x, y } = canvasXY(e);
  if (x > CW()) return false;
  const tp = xy2tp(x, y);

  if (!DM.drawing) {
    const cfg = getToolConfig(DM.activeTool);
    let pts = [tp, tp];
    if (DM.activeTool === 'longshort') {
      const isLong = (cfg.direction || 'long') === 'long';
      const targetP = isLong ? tp.price * 1.008 : tp.price * 0.992;
      const stopP   = isLong ? tp.price * 0.996 : tp.price * 1.004;
      pts = [
        tp,
        { time: tp.time + tfSec * 15, price: targetP },
        { time: tp.time + tfSec * 15, price: stopP }
      ];
    }
    DM.drawing = {
      id:     '_new',
      type:   DM.activeTool,
      symbol: sym,
      points: pts,
      config: cfg,
    };
    drawInProgress = true;
    render();
    return true;
  } else if (DM.activeTool === 'path') {
    DM.drawing.points.push(tp);
    render();
    return true;
  } else {
    DM.drawing.points[1] = tp;
    finalizeDrawing();
    return true;
  }
}

function drawMouseMove(e) {
  if (!DM.drawing || !drawInProgress) return false;
  const { x, y } = canvasXY(e);
  const tp = xy2tp(x, y);
  const obj = DM.drawing;

  if (obj.type === 'path') {
    obj.points[obj.points.length - 1] = tp;
  } else if (obj.type === 'longshort') {
    obj.points[1] = { time: tp.time, price: tp.price };
    const stopP = obj.points[0].price - (tp.price - obj.points[0].price) * 0.5;
    obj.points[2] = { time: tp.time, price: stopP };
  } else {
    obj.points[1] = tp;
  }
  render();
  return true;
}

function drawMouseUp(e) {
  if (!DM.drawing || !drawInProgress || e.button !== 0) return false;
  const { x, y } = canvasXY(e);
  const p0 = tp2xy(DM.drawing.points[0]);
  const dragDist = dist(p0.x, p0.y, x, y);

  if (DM.drawing.type !== 'path' && dragDist > 8) {
    if (DM.drawing.type === 'longshort') {
      const tp = xy2tp(x, y);
      DM.drawing.points[1] = { time: tp.time, price: tp.price };
      const stopP = DM.drawing.points[0].price - (tp.price - DM.drawing.points[0].price) * 0.5;
      DM.drawing.points[2] = { time: tp.time, price: stopP };
    } else {
      DM.drawing.points[1] = xy2tp(x, y);
    }
    finalizeDrawing();
    return true;
  }
  return false;
}

function finalizeDrawing() {
  const obj = DM.drawing;
  if (!obj) return;
  obj.id = genId();
  DM.drawings.push(obj);
  DM.drawing = null;
  drawInProgress = false;
  DM.selected = obj.id;
  DM.activeTool = null;
  setActiveTool(null);
  drawPersist();
  render();
}

function selectMouseDown(e) {
  if (DM.activeTool || e.button !== 0) return false;
  const { x, y } = canvasXY(e);
  if (x > CW()) return false;

  const selObj = DM.selected ? DM.drawings.find(d => d.id === DM.selected) : null;

  if (selObj) {
    const handle = hitTestHandles(selObj, x, y);
    if (handle) {
      isDraggingDraw = true;
      DM.dragState = {
        type: 'handle',
        handle: handle,
        origPoints: selObj.points.map(p => ({ ...p })),
        startTP: xy2tp(x, y)
      };
      return true;
    }
  }

  const hitId = hitTestObjects(x, y);
  if (hitId) {
    DM.selected = hitId;
    const obj = DM.drawings.find(d => d.id === hitId);
    isDraggingDraw = true;
    DM.dragState = {
      type: 'move',
      origPoints: obj.points.map(p => ({ ...p })),
      startTP: xy2tp(x, y)
    };
    render();
    return true;
  }

  if (DM.selected) {
    DM.selected = null;
    render();
  }
  return false;
}

function selectMouseMove(e) {
  if (!isDraggingDraw || !DM.dragState) return false;
  const { x, y } = canvasXY(e);
  const selObj = DM.drawings.find(d => d.id === DM.selected);
  if (!selObj) return false;

  const currentTP = xy2tp(x, y);

  if (DM.dragState.type === 'handle') {
    const h = DM.dragState.handle;

    if (selObj.type === 'rect') {
      const orig0 = DM.dragState.origPoints[0];
      const orig1 = DM.dragState.origPoints[1];
      const minT = Math.min(orig0.time, orig1.time), maxT = Math.max(orig0.time, orig1.time);
      const minP = Math.min(orig0.price, orig1.price), maxP = Math.max(orig0.price, orig1.price);

      let newMinT = minT, newMaxT = maxT, newMinP = minP, newMaxP = maxP;

      switch(h.type) {
        case 'nw': newMinT = currentTP.time; newMaxP = currentTP.price; break;
        case 'n':  newMaxP = currentTP.price; break;
        case 'ne': newMaxT = currentTP.time; newMaxP = currentTP.price; break;
        case 'e':  newMaxT = currentTP.time; break;
        case 'se': newMaxT = currentTP.time; newMinP = currentTP.price; break;
        case 's':  newMinP = currentTP.price; break;
        case 'sw': newMinT = currentTP.time; newMinP = currentTP.price; break;
        case 'w':  newMinT = currentTP.time; break;
      }
      selObj.points[0] = { time: newMinT, price: newMaxP };
      selObj.points[1] = { time: newMaxT, price: newMinP };
    } else if (selObj.type === 'longshort') {
      switch(h.type) {
        case 'entry': {
          selObj.points[0].price = currentTP.price;
          selObj.points[0].time  = currentTP.time;
          break;
        }
        case 'target': {
          selObj.points[1].price = currentTP.price;
          break;
        }
        case 'stop': {
          if (!selObj.points[2]) selObj.points[2] = { time: selObj.points[1].time, price: currentTP.price };
          selObj.points[2].price = currentTP.price;
          break;
        }
        case 'width': {
          selObj.points[1].time = currentTP.time;
          if (selObj.points[2]) selObj.points[2].time = currentTP.time;
          break;
        }
      }
    } else {
      selObj.points[h.idx] = currentTP;
    }
  } else if (DM.dragState.type === 'move') {
    const dt = currentTP.time - DM.dragState.startTP.time;
    const dp = currentTP.price - DM.dragState.startTP.price;
    for (let i = 0; i < selObj.points.length; i++) {
      const orig = DM.dragState.origPoints[i];
      selObj.points[i] = {
        time:  orig.time + dt,
        price: orig.price + dp
      };
    }
  }
  render();
  return true;
}

function selectMouseUp() {
  if (!isDraggingDraw) return false;
  isDraggingDraw = false;
  DM.dragState   = null;
  drawPersist();
  render();
  return true;
}

function updateHover(e) {
  if (DM.activeTool || isDraggingDraw) return;
  const { x, y } = canvasXY(e);
  if (x > CW()) {
    if (DM.hoveredId) { DM.hoveredId = null; render(); }
    return;
  }

  // Check handle hover
  if (DM.selected) {
    const selObj = DM.drawings.find(d => d.id === DM.selected);
    if (selObj) {
      const h = hitTestHandles(selObj, x, y);
      if (h) {
        cv.style.cursor = h.cursor || 'pointer';
        return;
      }
    }
  }

  const hitId = hitTestObjects(x, y);
  if (hitId !== DM.hoveredId) {
    DM.hoveredId = hitId;
    cv.style.cursor = hitId ? 'pointer' : '';
    render();
  }
}

function deleteSelected() {
  if (!DM.selected) return;
  DM.drawings = DM.drawings.filter(d => d.id !== DM.selected);
  DM.selected = null;
  drawPersist();
  render();
}

// ════════════════════════════════════════════════
// PERSISTENCE (Shared Per Symbol)
// ════════════════════════════════════════════════
const DRAW_STORAGE_KEY = () => `hf_draw_${sym}`;

function drawPersist() {
  try { localStorage.setItem(DRAW_STORAGE_KEY(), JSON.stringify(DM.drawings)); } catch(e) {}
  try { api.saveDrawings(sym, DM.drawings); } catch (e) {}
}

async function drawLoad(newSym) {
  DM.drawings  = [];
  DM.selected  = null;
  DM.drawing   = null;
  DM.hoveredId = null;
  DM.activeTool = null;
  setActiveTool(null);

  const key = `hf_draw_${newSym}`;
  try {
    const local = localStorage.getItem(key);
    if (local) { DM.drawings = JSON.parse(local); render(); }
  } catch(e) {}

  try {
    const d = await api.getDrawings(newSym);
    if (d.ok && d.drawings && d.drawings.length) {
      DM.drawings = d.drawings;
      localStorage.setItem(key, JSON.stringify(DM.drawings));
      render();
    }
  } catch(e) {}
}

function setActiveTool(tool) {
  DM.activeTool = tool;
  ui.setActiveDrawTool(tool);
  cv.style.cursor = tool ? 'crosshair' : '';
  if (tool) {
    DM.selected = null;
    DM.drawing = null;
    drawInProgress = false;
  }
}
// ════════════════════════════════════════════════
// DOUBLE CLICK CONFIG MODAL
// ════════════════════════════════════════════════
function handleDrawDblClick(e) {
  const { x, y } = canvasXY(e);
  const hitId = hitTestObjects(x, y);
  if (!hitId) return false;
  const obj = DM.drawings.find(d => d.id === hitId);
  if (!obj) return false;
  openEditModal(obj);
  return true;
}

// ════════════════════════════════════════════════
// INTERACTION — ported from Footprint.tsx's camera model:
//   • Drag/wheel over the PRICE AXIS (right strip)  → vertical ZOOM
//   • Drag/wheel over the TIME AXIS (bottom strip)   → horizontal ZOOM (drag)
//     — wheel over the time axis or main area both zoom horizontal
//   • Drag over the MAIN CHART AREA                  → free 2D PAN (x AND y)
// Zone priority matches the reference exactly: price-axis check first,
// then time-axis, then main area.
// ════════════════════════════════════════════════

let dragStartZone = 'main'; // 'main', 'volume', or 'cvd'

function updateCursor() {
  if (DM.activeTool) { cv.style.cursor = 'crosshair'; return; }
  if (isDraggingDraw && DM.dragState?.handle) { cv.style.cursor = DM.dragState.handle.cursor || 'pointer'; return; }
  if (isDraggingDraw) { cv.style.cursor = 'grabbing'; return; }
  if (DM.hoveredId) { cv.style.cursor = 'pointer'; return; }

  if (dragMode === 'zoomY' || dragMode === 'resizeVol' || dragMode === 'resizeCvd') { cv.style.cursor = 'ns-resize'; return; }
  if (dragMode === 'zoomX') { cv.style.cursor = 'ew-resize'; return; }
  if (dragMode === 'pan')   { cv.style.cursor = 'grabbing';  return; }
  
  // Check if mouse is hovering near horizontal pane separators for resizing
  const W = CW();
  if (mx >= 0 && mx < W) {
    if (indicators.volume && Math.abs(my - VT()) <= 4) { cv.style.cursor = 'ns-resize'; return; }
    if (indicators.cvd && Math.abs(my - CVDT()) <= 4) { cv.style.cursor = 'ns-resize'; return; }
  }
  
  if (inPA(mx))      cv.style.cursor = 'ns-resize';
  else if (inTA(my)) cv.style.cursor = 'ew-resize';
  else               cv.style.cursor = 'crosshair';
}

function stopMomentum() { if (momentumRAF) { cancelAnimationFrame(momentumRAF); momentumRAF = null; } }

cv.addEventListener('wheel', e => {
  e.preventDefault();
  stopMomentum();
  if (inPA(mx)) {
    const factor = e.deltaY > 0 ? 1.1 : 0.9;
    if (my < MH()) {
      zoomV(factor);
    } else if (indicators.volume && my >= VT() && my < VT() + VH()) {
      volMultiplier = Math.max(0.05, Math.min(20, volMultiplier * factor));
    } else if (indicators.cvd && my >= CVDT() && my < CVDT() + CVDH()) {
      cvdMultiplier = Math.max(0.05, Math.min(20, cvdMultiplier * factor));
    }
  } else {
    const factor = e.deltaY > 0 ? 0.9 : 1.1;
    zoomHAtX(mx, factor);
  }
  render();
}, { passive: false });

cv.addEventListener('mousedown', e => {
  if (e.button !== 0) return;
  
  const W = CW();
  if (mx >= 0 && mx < W) {
    // Priority 1: resizable separators check
    if (indicators.volume && Math.abs(my - VT()) <= 4) {
      dragMode = 'resizeVol';
      lastMX = e.clientX; lastMY = e.clientY;
      updateCursor();
      return;
    }
    if (indicators.cvd && Math.abs(my - CVDT()) <= 4) {
      dragMode = 'resizeCvd';
      lastMX = e.clientX; lastMY = e.clientY;
      updateCursor();
      return;
    }
  }

  // Priority 2: Technical analysis drawing creation or selection
  if (DM.activeTool) {
    if (drawMouseDown(e)) return;
  }
  if (selectMouseDown(e)) return;

  stopMomentum();
  
  if (inPA(mx)) {
    dragMode = 'zoomY';
    if (my < MH()) {
      dragStartZone = 'main';
    } else if (indicators.volume && my >= VT() && my < VT() + VH()) {
      dragStartZone = 'volume';
    } else if (indicators.cvd && my >= CVDT() && my < CVDT() + CVDH()) {
      dragStartZone = 'cvd';
    }
  } else if (inTA(my)) {
    dragMode = 'zoomX';
  } else {
    dragMode = 'pan';
  }
  
  lastMX = e.clientX; lastMY = e.clientY;
  lastMoveT = performance.now(); lastMoveX = e.clientX; velX = 0;
  
  if (dragMode === 'pan' && bars.length) {
    const pr = calcPR();
    if (psCtr  === null) psCtr  = (pr.lo + pr.hi) / 2;
    if (psHalf === null) psHalf = (pr.hi - pr.lo) / 2;
  }
  updateCursor();
});

cv.addEventListener('contextmenu', e => {
  if (DM.activeTool === 'path' && DM.drawing) {
    e.preventDefault();
    if (DM.drawing.points.length > 2) {
      DM.drawing.points.pop();
      finalizeDrawing();
    } else {
      DM.drawing = null;
      drawInProgress = false;
      setActiveTool(null);
      render();
    }
    return;
  }
  if (DM.drawing) {
    e.preventDefault();
    DM.drawing = null;
    drawInProgress = false;
    setActiveTool(null);
    render();
  }
});

document.addEventListener('mousemove', e => {
  const r = cv.getBoundingClientRect();
  mx = e.clientX - r.left; my = e.clientY - r.top;

  if (DM.drawing) {
    drawMouseMove(e);
    return;
  }
  if (isDraggingDraw) {
    selectMouseMove(e);
    return;
  }
  updateHover(e);

  if (dragMode) {
    const dx = e.clientX - lastMX, dy = e.clientY - lastMY;
    lastMX = e.clientX; lastMY = e.clientY;

    if (dragMode === 'resizeVol') {
      const ch = CH();
      const limitBottom = indicators.cvd ? CVDT() : ch;
      const newH = limitBottom - my;
      volPaneHeight = Math.max(30, Math.min(ch * 0.45, newH));
    } else if (dragMode === 'resizeCvd') {
      const ch = CH();
      const newH = ch - my;
      cvdPaneHeight = Math.max(30, Math.min(ch * 0.45, newH));
    } else if (dragMode === 'zoomY') {
      const zoomFactor = 1 + dy * 0.01;
      if (dragStartZone === 'main') {
        zoomV(zoomFactor);
      } else if (dragStartZone === 'volume') {
        volMultiplier = Math.max(0.05, Math.min(20, volMultiplier * zoomFactor));
      } else if (dragStartZone === 'cvd') {
        cvdMultiplier = Math.max(0.05, Math.min(20, cvdMultiplier * zoomFactor));
      }
    } else if (dragMode === 'zoomX') {
      zoomH(1 + dx * 0.01);
    } else { // 'pan'
      panH(dx);
      panV(dy);
      const now = performance.now(), dt = now - lastMoveT;
      if (dt > 0) velX = 0.7 * velX + 0.3 * ((e.clientX - lastMoveX) / dt);
      lastMoveT = now; lastMoveX = e.clientX;
    }
  }
  render();
  updateCursor();
});

document.addEventListener('mouseup', e => {
  if (DM.drawing && drawInProgress) {
    if (drawMouseUp(e)) return;
  }
  if (isDraggingDraw) {
    selectMouseUp();
    return;
  }

  if (e.button !== 0) return;
  const wasPan = dragMode === 'pan';
  dragMode = null;
  updateCursor();
  velX = 0; // tanpa inertia: pan horizontal langsung berhenti saat klik-tahan dilepas (sama seperti scroll Y)
});

cv.addEventListener('mouseleave', () => {
  if (!dragMode && !DM.drawing && !isDraggingDraw) { mx = -1; my = -1; showOHLCV(null); render(); }
  updateCursor();
});
cv.addEventListener('dblclick', e => {
  if (handleDrawDblClick(e)) return;
  // Double-click price axis OR main chart area → reset Y to auto-fit
  if (inPA(mx) || (!inTA(my))) { resetPS(); render(); }
});
/** Kinetic deceleration after a pan-drag release — bonus on top of the reference. */
function startMomentum() {
  let v = velX, lastT = performance.now();
  function step(t) {
    const dt = t - lastT; lastT = t;
    if (Math.abs(v) < 0.006) { momentumRAF = null; return; }
    panH(v * dt);
    v *= Math.pow(0.93, dt / 16.67);
    render();
    momentumRAF = requestAnimationFrame(step);
  }
  momentumRAF = requestAnimationFrame(step);
}

/** Keyboard navigation — arrows pan, +/- zoom, drawing hotkeys. */
document.addEventListener('keydown', e => {
  if (['INPUT','TEXTAREA'].includes(document.activeElement?.tagName)) return;
  if (e.key === 'Delete' || e.key === 'Backspace') {
    deleteSelected();
    return;
  }
  if (e.key === 'Escape') {
    if (DM.drawing) {
      DM.drawing = null;
      drawInProgress = false;
      render();
    } else if (DM.selected) {
      DM.selected = null;
      render();
    }
    setActiveTool(null);
    return;
  }
  if (e.key === 'l' || e.key === 'L') {
    setActiveTool(DM.activeTool === 'line' ? null : 'line');
    return;
  }
  if (e.key === 'r' || e.key === 'R') {
    setActiveTool(DM.activeTool === 'rect' ? null : 'rect');
    return;
  }
  if (e.key === 'f' || e.key === 'F') {
    setActiveTool(DM.activeTool === 'fibo' ? null : 'fibo');
    return;
  }
  if (e.key === 'p' || e.key === 'P') {
    setActiveTool(DM.activeTool === 'path' ? null : 'path');
    return;
  }
  if (e.key === 's' || e.key === 'S') {
    setActiveTool(DM.activeTool === 'longshort' ? null : 'longshort');
    return;
  }

  if (!bars.length) return;
  switch (e.key) {
    case 'ArrowLeft':  stopMomentum(); panH(50);  render(); break;
    case 'ArrowRight': stopMomentum(); panH(-50); render(); break;
    case '+': case '=': stopMomentum(); zoomH(1.15);   render(); break;
    case '-': case '_': stopMomentum(); zoomH(1/1.15); render(); break;
  }
});

// ════════════════════════════════════════════════
// DATA LOADING — in-process (menggantikan fetch('/api/...') & EventSource)
// Alur & logikanya sama persis dengan versi browser: polling /candles tiap 400ms
// sampai server selesai sync, tick/trade live via event dari engine.
// ════════════════════════════════════════════════
let pollTimer = null;

function setLoading(on, msg = '') {
  loading = on;
  if (msg) loadMsgText = msg;
  ensureAnim();
  render();
}

async function fetchCandles() { return api.candles(); }

async function fetchCVD() {
  if (!indicators.cvd) return;
  try {
    const d = await api.cvd(sym, tf);
    if (d && d.data) {
      cvdData = d.data;
      cvdExchangeStatus = d.exchanges || [];
    }
  } catch (e) {
    console.error('[CVD fetch error]', e);
  }
}

function activateTF(t) { ui.setActiveTf(t); }

function applyData(d, isChange) {
  const prevLen = bars.length;
  timeBars  = d.bars;
  sym       = d.symbol;
  tf        = d.timeframe;
  tfSec     = d.tfSec ?? 3600;
  nextClose = d.nextClose;
  ctRkReset();      // ukuran brick Renko dihitung ulang untuk data baru (pair/TF/config)
  rebuildBars();    // bars = timeBars (Standard/Footprint) atau brick Renko

  bufState.reachedStart = !!d.reachedStart;
  bufState.target       = d.bufferTarget ?? 5000;

  if (isChange || prevLen === 0) initCamera(); else shiftCam(prevLen);

  document.getElementById('sym-lbl').textContent = sym + '.P';
  activateTF(tf);
  document.getElementById('sb-bars').textContent = `Bars: ${bars.length}`;
  document.getElementById('sb-r').textContent    = 'Updated ' + new Date().toLocaleTimeString();

  const last = timeBars[timeBars.length - 1];
  if (last) {
    const col = last.close >= last.open ? '#26a69a' : '#ef5350';
    document.getElementById('sb-last').innerHTML = `Last: <span style="color:${col}">${fmtP(last.close)}</span>`;
    const { L, R } = visRange(); const sl = bars.slice(L, R + 1);
    let lo = Infinity, hi = -Infinity;
    sl.forEach(b => { if (b.low < lo) lo = b.low; if (b.high > hi) hi = b.high; });
    if (lo < Infinity) document.getElementById('sb-range').textContent = `Range: ${fmtP(lo)} \u2013 ${fmtP(hi)}`;
  }

  ui.setTvDot(true);
  ctAfterApply();   // Footprint: ambil agregat trade dari engine
  hvnDirty = true; // Mark HVN for recomputation with new bars
  hvnLoadTick(sym); // syminfo.mintick resmi dari Bybit (HVN row height)
  gammaOnSymbolChange(); // Gamma Level: aktif hanya untuk BTC/ETH

  if (isChange || prevLen === 0 || !DM._loadedSym || DM._loadedSym !== sym) {
    DM._loadedSym = sym;
    drawLoad(sym);
  }

  Promise.resolve()
    .then(() => api.tradeAgg())
    .then(res => {
      if (res.ok && res.symbol === sym && res.timeframe === tf) {
        tradeAgg = res.data || {};
      }
      // Fetch HA detections alongside trade data
      if (indicators.ha) fetchHA();
      if (indicators.cvd) {
        fetchCVD().then(() => render());
      } else {
        render();
      }
    })
    .catch(() => {
      if (indicators.ha) fetchHA();
      if (indicators.cvd) {
        fetchCVD().then(() => render());
      } else {
        render();
      }
    });
}

async function pollUntilReady(isChange = false, gen = loadGen) {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    // If a newer load has started, stop this poll immediately
    if (gen !== loadGen) { clearInterval(pollTimer); return; }
    try {
      const d = await fetchCandles();
      if (!d.ok) return;
      if (d.loading) { setLoading(true, d.loadMsg || 'Syncing\u2026'); return; }
      // Only apply if this is still the current generation
      if (gen !== loadGen) { clearInterval(pollTimer); return; }
      clearInterval(pollTimer);
      setLoading(false);
      applyData(d, isChange);
    } catch {}
  }, 400);
}

// ════════════════════════════════════════════════
// LIVE TICK — Bybit WebSocket (event dari engine, per-tick tanpa delay)
// ════════════════════════════════════════════════
let tickHandler = null;

function startSSE() {
  if (tickHandler) events.removeListener('tick', tickHandler);

  tickHandler = tick => {
    if (!bars.length || !tick) return;

    // Ignore ticks from a previous pair/TF subscription (engine tags every
    // broadcast with symbol+timeframe).
    if (tick.symbol !== sym || tick.timeframe !== tf) return;

    ui.setWsDot(true);

    const last = timeBars[timeBars.length - 1];
    const renko = chartType === 'renko';
    const edge = renko && bx(bars.length - 1) <= CW() + barW * 2;
    if (tick.time === last.time) {
      last.close = tick.close;
      if (tick.high > last.high) last.high = tick.high;
      if (tick.low  < last.low)  last.low  = tick.low;
      last.volume = tick.volume;
      nextClose = tick.time + tfSec;
      if (renko) ctRenkoSync(edge);
    } else if (tick.time > last.time) {
      const wasAtEdge = bx(bars.length - 1) <= CW() + barW * 2;
      timeBars.push({ time: tick.time, open: tick.open, high: tick.high, low: tick.low, close: tick.close, volume: tick.volume });
      nextClose = tick.time + tfSec;
      if (renko) ctRenkoSync(edge); else if (wasAtEdge) leftBar += 1;     // Standard/Footprint: bars === timeBars

      // Auto refresh CVD history on bar close to capture multi-exchange final alignment
      if (indicators.cvd) {
        fetchCVD();
      }
    }

    const col = tick.close >= tick.open ? '#26a69a' : '#ef5350';
    document.getElementById('sb-last').innerHTML = `Last: <span style="color:${col}">${fmtP(tick.close)}</span>`;
    render();
  };

  events.on('tick', tickHandler);
}

let tradeHandler = null;

function startTradeSSE() {
  if (tradeHandler) events.removeListener('trade', tradeHandler);

  tradeHandler = trade => {
    if (!bars.length || !trade) return;
    if (trade.symbol !== sym || trade.timeframe !== tf) return;

    fpOnTrade(trade);   // Footprint Delta: tambah ke level harga + candle

    const candleTime = Math.floor(trade.time / tfSec) * tfSec;
    if (!tradeAgg[candleTime]) {
      tradeAgg[candleTime] = {};
    }

    const bucketSize = getBucketSize(trade.price);
    const bucket = Math.floor(trade.price / bucketSize) * bucketSize;

    if (!tradeAgg[candleTime][bucket]) {
      tradeAgg[candleTime][bucket] = { buy: 0, sell: 0 };
    }
    const lv = tradeAgg[candleTime][bucket];
    if (trade.side === 'Buy') {
      lv.buy += trade.volume;
    } else {
      lv.sell += trade.volume;
    }
    // Trade datang sangat sering; render dibatasi oleh coalescing update() Qt.
    render();
  };

  events.on('trade', tradeHandler);
}

setInterval(() => { if (bars.length) render(); }, 1000);

// ════════════════════════════════════════════════
// RESYNC — engine menambal candle yang terlewat (cache lama / WS putus / sleep) lalu memberi tahu UI
// ════════════════════════════════════════════════
let resyncHandler = null, reloadHandler = null, resyncBusy = false;

function startResyncEvents() {
  if (resyncHandler) events.removeListener('resync', resyncHandler);
  if (reloadHandler) events.removeListener('reload', reloadHandler);

  // Ambil ulang seluruh candle dari engine (sudah kontigu) tanpa mengubah posisi kamera.
  resyncHandler = async d => {
    if (!d || d.symbol !== sym || d.timeframe !== tf || resyncBusy || !bars.length || loading) return;
    resyncBusy = true;
    try {
      const r = await fetchCandles();
      if (!r || !r.ok || r.loading || r.symbol !== sym || r.timeframe !== tf || !r.bars.length) return;
      const oldLen = bars.length;
      const wasAtEdge = bx(oldLen - 1) <= CW() + barW * 2;
      timeBars = r.bars;
      rebuildBars();          // Standard/Footprint: bars = timeBars; Renko: brick dibangun ulang
      nextClose = r.nextClose;
      bufState.reachedStart = !!r.reachedStart;
      bufState.target = r.bufferTarget ?? bufState.target;
      if (wasAtEdge) leftBar += bars.length - oldLen; // tetap menempel di candle terbaru
      hvnDirty = true;
      if (chartType === 'footprint') fpFetch();
      if (indicators.cvd) fetchCVD().then(() => render());
      render();
    } catch (e) {
      console.warn('[resync]', e.message);
    } finally {
      resyncBusy = false;
    }
  };

  // Gap terlalu besar untuk ditambal → muat ulang penuh (seperti ganti TF)
  reloadHandler = d => { if (d && d.symbol === sym && d.timeframe === tf) loadData(sym, tf); };

  events.on('resync', resyncHandler);
  events.on('reload', reloadHandler);
}

setInterval(() => { if (bars.length) render(); }, 1000);

// ════════════════════════════════════════════════
// LOAD trigger — symbol/TF switch (sync only, fast)
// ════════════════════════════════════════════════
const TF_LBL = {'1':'1m','5':'5m','15':'15m','30':'30m','60':'1H','240':'4H','D':'1D','W':'1W'};

// Track which load request is "current" — incremented on each switch.
let loadGen = 0;

async function loadData(symbol, timeframe) {
  stopMomentum();
  clearVpCache(); // discard old sub-bar data before switching symbol/TF

  if (sym !== symbol) {
    tradeAgg = {};
    haData = [];
    hvnZones = [];
    hvnPeriods = [];
    hvnLive = null;
    hvnTick = 0; hvnTickSym = null;
    gammaData = null;
  }

  // Immediately clear stale data so old-pair bars never show
  timeBars = [];
  bars  = [];
  ctRkReset();
  fpReset();           // footprint: data pair/TF lama dibuang; diambil ulang dari engine setelah candle termuat
  nextClose = 0;
  bufState.busy         = false;
  bufState.reachedStart = false;
  bufState.target       = 5000;
  bufState.gen++;          // invalidate any in-flight buffer-more for the old pair
  resetPS();               // reset Y camera

  const gen = ++loadGen;

  setLoading(true, `Syncing ${symbol}.P \u00b7 ${TF_LBL[timeframe] || timeframe}\u2026`);
  await api.load(symbol, timeframe);
  pollUntilReady(true, gen);
}

// ════════════════════════════════════════════════
// UI GLUE — dipanggil oleh widget Qt (pengganti handler DOM versi browser)
// ════════════════════════════════════════════════
/** Klik item di dropdown Indicator (logika sama dengan handler .ind-item asli). */
async function toggleIndicator(ind) {
  if (ctIsBlocked(ind)) return false;   // tidak tersedia pada tipe chart aktif (Renko / Footprint)
  indicators[ind] = !indicators[ind];

  if (ind === 'cvd' && indicators.cvd) {
    setLoading(true, 'Fetching CVD Spot data...');
    await fetchCVD();
    setLoading(false);
  }
  if (ind === 'ha' && indicators.ha) {
    await fetchHA();
  }
  if (ind === 'hvn' && indicators.hvn) {
    hvnDirty = true;
  }
  if (ind === 'gamma') {
    if (indicators.gamma) {
      if (!gammaSupported(sym)) { indicators.gamma = false; render(); return false; } // hanya BTC & ETH
      gammaStart();
    } else {
      gammaStop();
    }
  }
  render();
  return indicators[ind];
}

function setBubbleMinToken(v) {
  bubbleConfig.minToken = Math.max(0, parseFloat(v) || 0);
  localStorage.setItem('hf_bubble_minToken', bubbleConfig.minToken);
  render();
}
function setBubbleMultiplier(v) {
  bubbleConfig.multiplier = parseFloat(v);
  localStorage.setItem('hf_bubble_multiplier', bubbleConfig.multiplier);
  render();
}

const HVN_SPEC = {
  // [tipe, min, max, defaultVal, perluHitungUlang]
  anchor:      ['s', 0, 0, '60', true],
  threshold:   ['i', 1, 100, 70, true],
  rowTicks:    ['i', 1, 500, 20, true],
  maxZones:    ['i', 1, 150, 15, true],
  gapTol:      ['i', 0, 20, 1, true],
  minCluster:  ['i', 1, 20, 1, true],
  graceBars:   ['i', 0, 50, 2, true],
  smooth:      ['i', 0, 10, 1, true],
  maxBarsBack: ['i', 50, 20000, 5000, true],
  histWidth:   ['i', 10, 400, 40, false],
  liveTransp:  ['i', 0, 100, 60, false],
  showProfile: ['b', 0, 0, true, false],
  showPOC:     ['b', 0, 0, true, false],
  showLabels:  ['b', 0, 0, true, false],
  liveProfile: ['b', 0, 0, true, false],
  alertOn:     ['b', 0, 0, false, false]
};

function setHvn(key, value) {
  const sp = HVN_SPEC[key];
  if (!sp) return;
  let v;
  if (sp[0] === 's') v = HVN_ANCHOR_SEC[String(value)] ? String(value) : sp[3];
  else if (sp[0] === 'b') v = !!value;
  else { v = parseInt(value); if (isNaN(v)) v = sp[3]; v = Math.max(sp[1], Math.min(sp[2], v)); }
  hvnConfig[key] = v;
  localStorage.setItem('hf_hvn_' + key, v);
  if (sp[4]) hvnDirty = true;
  if (key === 'alertOn' && v) hvnUpdateTouches(true); // alert hanya untuk sentuhan baru setelah diaktifkan
  render();
}

async function setCvdExchanges(list) {
  cvdConfig.exchanges = [...list];
  localStorage.setItem('hf_cvd_exchanges', JSON.stringify(cvdConfig.exchanges));
  try {
    await api.cvdConfig(cvdConfig.exchanges);
    await fetchCVD();
    render();
  } catch (e) {
    console.error('[CVD Auto-save failed]', e);
  }
}

function toggleTool(tool) { setActiveTool(DM.activeTool === tool ? null : tool); render(); }
function gotoLatestBtn() { stopMomentum(); if (bars.length) { gotoLatest(); render(); } }

/** Editor properti objek gambar (pengganti modal #draw-edit-modal). */
function openEditModal(obj) {
  const cfg = JSON.parse(JSON.stringify(obj.config || getToolConfig(obj.type)));
  ui.openDrawEditor(obj, cfg, {
    apply: newCfg => {
      obj.config = newCfg;
      saveToolConfig(obj.type, newCfg);
      drawPersist();
      render();
    },
    remove: () => { DM.selected = obj.id; deleteSelected(); }
  });
}

function start() {
  setLoading(true, 'Connecting to TradingView\u2026');
  pollUntilReady(false);
  startSSE();
  startTradeSSE();
  startGammaEvents();
  startResyncEvents();
  startLiquidityEvents();
  startHaConfig();
  ctInit();
}

// VOLUME PROFILE — sub-bar fetch engine
// ════════════════════════════════════════════════

/**
 * Debounced entry point — called from render() to keep VP data fresh.
 * Waits 250 ms after the last render before firing the actual fetch,
 * which avoids hammering the server during fast pan/zoom gestures.
 */
function scheduleVpFetch() {
  if (vpFetchTimer) clearTimeout(vpFetchTimer);
  vpFetchTimer = setTimeout(doVpFetch, 250);
}

async function doVpFetch() {
  const subIv = vpSubIv(tf);
  if (chartType !== 'standard' || !subIv || barW < VP_MIN_BW || !bars.length || vpFetching) return;

  const { L, R } = visRange();
  if (L > R) return;

  const startSec = bars[L].time;
  const endSec   = bars[R].time + tfSec;
  const cacheKey = `${sym}:${subIv}`;
  const covered  = vpCovered.get(cacheKey) || { min: Infinity, max: -Infinity };

  // Skip if visible range is already fully covered
  if (startSec >= covered.min && endSec <= covered.max + 60) return;

  vpFetching = true;
  try {
    // Fetch in segments if needed (covered range may have gaps)
    const fetchStart = Math.min(startSec, covered.min === Infinity ? startSec : covered.min);
    const fetchEnd   = Math.max(endSec,   covered.max === -Infinity ? endSec : covered.max);

    const j   = await api.subBars(sym, subIv, startSec, endSec);
    if (!j.ok || !j.bars.length) return;

    // Merge into cache (dedup by time)
    const existing = vpCache.get(cacheKey) || [];
    const seen     = new Set(existing.map(b => b.time));
    const fresh    = j.bars.filter(b => !seen.has(b.time));
    if (fresh.length) {
      const merged = [...existing, ...fresh].sort((a, b) => a.time - b.time);
      vpCache.set(cacheKey, merged);
    }

    // Expand covered range
    vpCovered.set(cacheKey, {
      min: Math.min(covered.min, startSec),
      max: Math.max(covered.max, endSec)
    });

    render();
  } catch (e) {
    console.warn('[VP]', e.message);
  } finally {
    vpFetching = false;
  }
}

/**
 * Clear VP cache when switching symbol or timeframe.
 * Called automatically whenever a new load is applied.
 */
function clearVpCache() {
  vpCache.clear();
  vpCovered.clear();
  if (vpFetchTimer) { clearTimeout(vpFetchTimer); vpFetchTimer = null; }
  vpFetching = false;
}
// ════════════════════════════════════════════════
// FORMAT HELPERS
// ════════════════════════════════════════════════
function niceStep(r, t) { const raw = r / t, mag = Math.pow(10, Math.floor(Math.log10(raw))), n = raw / mag; return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag; }
function fmtP(p) {
  if (p == null || isNaN(p)) return '—';
  if (p >= 100000) return p.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (p >= 10000)  return p.toLocaleString('en-US', { maximumFractionDigits: 1 });
  if (p >= 1000)   return p.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (p >= 1)      return p.toFixed(4);
  if (p >= 0.001)  return p.toFixed(6);
  if (p >= 0.0001) return p.toFixed(7);
  return p.toFixed(8); // e.g. 1000PEPE ~0.0000128
}
function fmtV(v) { if (!v) return '0'; if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B'; if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M'; if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K'; return v.toFixed(2); }
function fmtCd(rem) { const h = Math.floor(rem / 3600), m = Math.floor((rem % 3600) / 60), s = Math.floor(rem % 60); return h > 0 ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`; }
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function fmtT(ts, tf2) {
  // All labels shown in WIB (UTC+7) — add offset before using UTC accessors.
  const d = new Date((ts + WIB_OFFSET_S) * 1000);
  const H = d.getUTCHours(), M = d.getUTCMinutes();
  const HS = H.toString().padStart(2,'0'), MS = M.toString().padStart(2,'0');
  const day = d.getUTCDate(), mon = MON[d.getUTCMonth()], yr = d.getUTCFullYear();
  if (tf2 === 'W' || tf2 === 'D') return `${day} ${mon} ${yr}`;
  // For intraday: show date label at WIB-midnight (day boundary), month label
  // at the 1st of the month; otherwise show HH:MM.
  if (H === 0 && M === 0) return day === 1 ? `${mon} ${yr}` : `${day} ${mon}`;
  return `${HS}:${MS}`;
}
function fmtTD(ts, tf2) {
  const d = new Date((ts + WIB_OFFSET_S) * 1000);
  const dd = d.getUTCDate().toString().padStart(2,'0');
  const H  = d.getUTCHours().toString().padStart(2,'0');
  const M  = d.getUTCMinutes().toString().padStart(2,'0');
  const yr = d.getUTCFullYear();
  if (tf2 === 'D' || tf2 === 'W') return `${dd} ${MON[d.getUTCMonth()]} ${yr}`;
  return `${dd} ${MON[d.getUTCMonth()]} ${yr}  ${H}:${M} WIB`;
}
// ════════════════════════════════════════════════
// GAMMA LEVEL — GEX per strike dari opsi Deribit (WebSocket) + garis level kunci
//   • data & perhitungan: lib/deribitGamma.js (di-stream lewat engine, event 'gamma')
//   • garis horizontal: Gamma Flip (zero gamma), Call Wall, Put Wall, Max Gamma (+ Top-N strike)
//   • "volume": bar GEX per strike (teal = positif, pink = negatif) + label nilai ($ per 1% gerak spot)
//   • hanya BTC & ETH (data Deribit); pair lain: indikator abu-abu & tidak bisa dipilih
// ════════════════════════════════════════════════
const GAMMA_SYMBOLS = { BTCUSDT: 'BTC', ETHUSDT: 'ETH' };
const GAMMA_POS = '31, 195, 179';   // teal  (rgb)
const GAMMA_NEG = '240, 40, 140';    // pink  (rgb)
function gammaBaseOf(s) { return GAMMA_SYMBOLS[String(s || '').toUpperCase()] || null; }
function gammaSupported(s) { return !!gammaBaseOf(s); }

const gammaConfig = (function () {
  const geti = (k, d, lo, hi) => { const v = parseInt(localStorage.getItem('hf_gamma_' + k)); return isNaN(v) ? d : Math.max(lo, Math.min(hi, v)); };
  const getb = (k, d) => { const v = localStorage.getItem('hf_gamma_' + k); return v === null ? d : v !== 'false'; };
  return {
    showBars: getb('showBars', true),        // bar GEX (volume) per strike
    showLabels: getb('showLabels', true),    // label nilai di tiap bar
    showSummary: getb('showSummary', true),  // ringkasan Net GEX / Flip di pojok kanan atas
    barWidth: geti('barWidth', 240, 80, 600),
    showFlip: getb('showFlip', true),
    showCallWall: getb('showCallWall', true),
    showPutWall: getb('showPutWall', true),
    showMax: getb('showMax', true),
    topN: geti('topN', 0, 0, 10),            // garis tambahan untuk N strike dengan |GEX| terbesar
    maxDays: geti('maxDays', 0, 0, 365)      // 0 = semua expiry
  };
})();

let gammaData = null;       // snapshot terbaru dari engine
let gammaStatus = 'idle';   // idle | loading | ok | error
let gammaMsg = '';
let gammaCurBase = null;    // base (BTC/ETH) yang sedang di-stream
let gammaWasOn = false;     // indikator otomatis mati di pair tak didukung → nyala lagi saat kembali ke BTC/ETH

function gammaOpts() { return { maxDays: gammaConfig.maxDays }; }

/** Lebar (px) dari tepi kanan chart yang dipakai Gamma Level (bar GEX + label level) — dipakai indikator lain agar tidak bertabrakan. */
function gammaRightReserve() {
  if (!indicators.gamma || !gammaSupported(sym) || !gammaData) return 0;
  return gammaConfig.showBars ? gammaConfig.barWidth + 12 + 140 : 140 + 10;
}

async function gammaStart() {
  const base = gammaBaseOf(sym);
  if (!base) return;
  gammaCurBase = base; gammaStatus = 'loading'; gammaMsg = ''; gammaData = null; render();
  try {
    const r = await api.gammaStart(sym, gammaOpts());
    if (!indicators.gamma || gammaBaseOf(sym) !== base) return; // dimatikan / pindah pair saat menunggu
    if (!r || !r.ok) { gammaStatus = 'error'; gammaMsg = (r && r.err) || 'gagal'; }
    else if (r.data) { gammaData = r.data; gammaStatus = 'ok'; }
    else gammaStatus = 'loading';
  } catch (e) { gammaStatus = 'error'; gammaMsg = e.message; }
  render();
}

function gammaStop() {
  try { api.gammaStop(); } catch (e) {}
  gammaData = null; gammaStatus = 'idle'; gammaMsg = ''; gammaCurBase = null;
}

/** Dipanggil tiap data pair/TF diterapkan: pair tak didukung → matikan; kembali ke BTC/ETH → nyalakan lagi. */
function gammaOnSymbolChange() {
  const base = gammaBaseOf(sym);
  if (!base) {
    if (indicators.gamma) { indicators.gamma = false; gammaWasOn = true; gammaStop(); }
    return;
  }
  if (gammaWasOn && !indicators.gamma) { indicators.gamma = true; gammaWasOn = false; gammaStart(); return; }
  if (indicators.gamma && gammaCurBase !== base) gammaStart();
}

let gammaHandler = null, gammaStatusHandler = null;
function startGammaEvents() {
  if (gammaHandler) events.removeListener('gamma', gammaHandler);
  if (gammaStatusHandler) events.removeListener('gamma-status', gammaStatusHandler);
  gammaHandler = d => {
    if (!indicators.gamma || !d || d.base !== gammaBaseOf(sym)) return;
    gammaData = d; gammaStatus = 'ok'; gammaMsg = '';
    render();
  };
  gammaStatusHandler = s => {
    if (!indicators.gamma || !s) return;
    if ((s.state === 'error' || s.state === 'reconnecting') && !gammaData) { gammaStatus = 'error'; gammaMsg = s.msg || ''; render(); }
  };
  events.on('gamma', gammaHandler);
  events.on('gamma-status', gammaStatusHandler);
}

const GAMMA_SPEC = {
  // [tipe, min, max, default]
  barWidth: ['i', 80, 600, 240], topN: ['i', 0, 10, 0], maxDays: ['i', 0, 365, 0],
  showBars: ['b'], showLabels: ['b'], showSummary: ['b'],
  showFlip: ['b'], showCallWall: ['b'], showPutWall: ['b'], showMax: ['b']
};
function setGamma(key, value) {
  const sp = GAMMA_SPEC[key];
  if (!sp) return;
  let v;
  if (sp[0] === 'b') v = !!value;
  else { v = parseInt(value); if (isNaN(v)) v = sp[3]; v = Math.max(sp[1], Math.min(sp[2], v)); }
  gammaConfig[key] = v;
  localStorage.setItem('hf_gamma_' + key, v);
  if (key === 'maxDays') { try { api.gammaConfig(gammaOpts()); } catch (e) {} }
  render();
}

/** 3.7b / -200.9m / 69.6m / 12.3k */
function fmtGex(v) {
  const a = Math.abs(v), s = v < 0 ? '-' : '';
  if (a >= 1e9) return s + (a / 1e9).toFixed(1) + 'b';
  if (a >= 1e6) return s + (a / 1e6).toFixed(1) + 'm';
  if (a >= 1e3) return s + (a / 1e3).toFixed(1) + 'k';
  return s + a.toFixed(0);
}

function drawGammaStatus(W) {
  const txt = gammaStatus === 'error'
    ? 'GEX \u00b7 Deribit: ' + (gammaMsg || 'error')
    : 'GEX \u00b7 connecting to Deribit\u2026';
  ctx.save();
  ctx.font = '10px Consolas, monospace'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  ctx.fillStyle = gammaStatus === 'error' ? '#ef5350' : '#94a3b8';
  ctx.fillText(txt, W - 12, 16);
  ctx.restore();
}

function drawGamma(L, R, pr) {
  if (!gammaSupported(sym)) return;
  const W = CW(), top = PAD_T, bot = MH() - PAD_B;
  const g = gammaData;
  if (!g || !g.strikes || !g.strikes.length) { drawGammaStatus(W); return; }
  const Lv = g.levels || {};
  const strikes = g.strikes;
  const half = Math.max(40, gammaConfig.barWidth / 2);
  const xr = W - 12, base = xr - half;

  // ── bar GEX per strike ("volume") ──
  if (gammaConfig.showBars) {
    let maxAbs = 0;
    for (const s of strikes) if (s.strike >= pr.lo && s.strike <= pr.hi) maxAbs = Math.max(maxAbs, Math.abs(s.net));
    if (maxAbs > 0) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.10)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(Math.round(base) + 0.5, top); ctx.lineTo(Math.round(base) + 0.5, bot); ctx.stroke();
      ctx.font = 'bold 9px Consolas, monospace'; ctx.textBaseline = 'middle';
      for (let i = 0; i < strikes.length; i++) {
        const s = strikes[i];
        if (s.strike < pr.lo || s.strike > pr.hi) continue;
        const prev = i > 0 ? s.strike - strikes[i - 1].strike : Infinity;
        const next = i < strikes.length - 1 ? strikes[i + 1].strike - s.strike : Infinity;
        let sp = Math.min(prev, next);
        if (!isFinite(sp)) sp = isFinite(prev) ? prev : (isFinite(next) ? next : 1);
        const yc = p2y(s.strike, pr.lo, pr.hi);
        const hpx = Math.abs(p2y(s.strike + sp / 2, pr.lo, pr.hi) - p2y(s.strike - sp / 2, pr.lo, pr.hi));
        const h = Math.max(2, Math.min(40, hpx * 0.84));
        const len = Math.max(1, (Math.abs(s.net) / maxAbs) * half);
        const pos = s.net >= 0;
        ctx.fillStyle = `rgba(${pos ? GAMMA_POS : GAMMA_NEG}, 0.88)`;
        ctx.fillRect(pos ? base : base - len, yc - h / 2, len, h);
        if (gammaConfig.showLabels && h >= 8) {
          ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
          ctx.textAlign = pos ? 'left' : 'right';
          ctx.fillText(fmtGex(s.net), pos ? base + 4 : base - 4, yc + 0.5);
        }
      }
    }
  }

  // ── garis level ──
  const lines = [];
  if (gammaConfig.showFlip && Lv.flip) lines.push({ price: Lv.flip, rgb: '250, 204, 21', dash: [6, 4], label: 'Gamma Flip' });
  if (gammaConfig.showCallWall && Lv.callWall) lines.push({ price: Lv.callWall.strike, rgb: GAMMA_POS, dash: null, label: 'Call Wall' });
  if (gammaConfig.showPutWall && Lv.putWall) lines.push({ price: Lv.putWall.strike, rgb: GAMMA_NEG, dash: null, label: 'Put Wall' });
  if (gammaConfig.showMax && Lv.maxGamma) lines.push({ price: Lv.maxGamma.strike, rgb: '255, 140, 55', dash: [2, 3], label: 'Max Gamma' });

  // garis tambahan: Top-N strike dengan |GEX| terbesar (di luar level di atas)
  if (gammaConfig.topN > 0) {
    const used = new Set(lines.map(l => l.price));
    strikes.slice().sort((a, b) => Math.abs(b.net) - Math.abs(a.net))
      .filter(s => !used.has(s.strike)).slice(0, gammaConfig.topN)
      .forEach(s => lines.push({ price: s.strike, rgb: s.net >= 0 ? GAMMA_POS : GAMMA_NEG, dash: [1, 3], label: null, thin: true }));
  }

  const labelX = gammaConfig.showBars ? base - half - 8 : W - 10;
  let lastLabelY = -99;
  lines.sort((a, b) => b.price - a.price).forEach(ln => {
    const y = p2y(ln.price, pr.lo, pr.hi);
    if (y < top || y > bot) return;
    ctx.save();
    ctx.strokeStyle = `rgba(${ln.rgb}, ${ln.thin ? 0.38 : 0.85})`; ctx.lineWidth = 1;
    if (ln.dash) ctx.setLineDash(ln.dash);
    ctx.beginPath(); ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(W, Math.round(y) + 0.5); ctx.stroke();
    ctx.restore();
    if (ln.label) {
      let ly = y;
      if (Math.abs(ly - lastLabelY) < 13) ly = lastLabelY + 13;
      lastLabelY = ly;
      const t = `${ln.label}  ${fmtP(ln.price)}`;
      ctx.save();
      ctx.font = 'bold 9.5px Consolas, monospace'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      const tw2 = ctx.measureText(t).width;
      ctx.fillStyle = 'rgba(16, 19, 26, 0.82)';
      ctx.fillRect(labelX - tw2 - 6, ly - 7, tw2 + 10, 14);
      ctx.fillStyle = `rgb(${ln.rgb})`;
      ctx.fillText(t, labelX, ly + 0.5);
      ctx.restore();
    }
  });

  // ── ringkasan (Net GEX / Flip) ──
  if (gammaConfig.showSummary) {
    const net = Lv.total || 0;
    const parts = [
      ['GEX ' + g.base + (g.maxDays > 0 ? ' \u2264' + g.maxDays + 'd' : ''), '#ff8c37'],
      ['Net ' + (net >= 0 ? '+' : '') + fmtGex(net), net >= 0 ? `rgb(${GAMMA_POS})` : `rgb(${GAMMA_NEG})`],
      ['Flip ' + (Lv.flip ? fmtP(Lv.flip) : '\u2014'), '#facc15']
    ];
    ctx.save();
    ctx.font = 'bold 10px Consolas, monospace'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    const gap = 14;
    const ws = parts.map(p => ctx.measureText(p[0]).width);
    const total = ws.reduce((a, b) => a + b, 0) + gap * (parts.length - 1);
    let x = W - 12 - total;
    ctx.fillStyle = 'rgba(16, 19, 26, 0.82)';
    ctx.fillRect(x - 8, 6, total + 16, 20);
    parts.forEach((p, i) => { ctx.fillStyle = p[1]; ctx.fillText(p[0], x, 16.5); x += ws[i] + gap; });
    ctx.restore();
  }
}

// ════════════════════════════════════════════════
// LIQUIDITY HEATMAP — order book Binance (Spot diutamakan; fallback perpetual bila spot tidak ada) (ala Bookmap, tapi PER CANDLE)
//   • engine merekam order book tiap detik → rangkuman per menit (lib/liquidityBook.js)
//   • tiap candle di TF aktif = agregasi menit-menit di dalamnya:
//        PEAK  = liquidity tertinggi selama candle (likuiditas yang sempat muncul, termasuk spoofing)
//        AVG   = rata-rata antar menit,   CLOSE = kondisi menit terakhir candle
//     TF kecil → sel lebih sempit → order yang hanya muncul sebentar tidak lagi "menempel" lama.
//   • heatmap digambar sebagai tekstur (1 piksel = 1 sel candle × baris harga) → cepat
//   • panel volume vertikal (heat bar + jumlah) untuk candle yang di-hover / candle terbaru;
//     bisa dimatikan; otomatis bergeser ke kiri bila Gamma Level sedang menampilkan volumenya
// ════════════════════════════════════════════════
const LIQ_MODES = ['PEAK', 'AVG', 'CLOSE'];

const liqConfig = (function () {
  const geti = (k, d, lo, hi) => { const v = parseInt(localStorage.getItem('hf_liq_' + k)); return isNaN(v) ? d : Math.max(lo, Math.min(hi, v)); };
  const getb = (k, d) => { const v = localStorage.getItem('hf_liq_' + k); return v === null ? d : v !== 'false'; };
  return {
    mode: geti('mode', 0, 0, 2),             // 0 peak, 1 avg, 2 close
    // sumber data: Binance saja (spot -> fallback futures), dipilih otomatis oleh engine; tidak ada toggle exchange
    contrast: geti('contrast', 100, 20, 400),
    opacity: geti('opacity', 90, 20, 100),
    threshold: geti('threshold', 3, 0, 60),   // sel di bawah x% dari skala disembunyikan
    rowPx: geti('rowPx', 4, 2, 14),           // tinggi baris minimum (px)
    showVolume: getb('showVolume', true),     // panel volume vertikal
    showLabels: getb('showLabels', true),
    volWidth: geti('volWidth', 170, 60, 500),
    rangeTenth: geti('rangeTenth', 15, 5, 50) // rentang rekam ±% (×0.1)
  };
})();

const LIQ_STOPS = [
  [0.00, 12, 30, 100, 0.00],
  [0.12, 24, 58, 160, 0.40],
  [0.32, 30, 128, 222, 0.68],
  [0.52, 38, 205, 190, 0.80],
  [0.70, 150, 228, 72, 0.88],
  [0.85, 250, 198, 40, 0.94],
  [1.00, 255, 82, 52, 1.00]
];
const LIQ_LUT = (function () {
  const lut = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let s = 0;
    while (s < LIQ_STOPS.length - 2 && t > LIQ_STOPS[s + 1][0]) s++;
    const a = LIQ_STOPS[s], b = LIQ_STOPS[s + 1];
    const f = Math.max(0, Math.min(1, (t - a[0]) / (b[0] - a[0])));
    for (let c = 1; c <= 4; c++) lut[i * 4 + c - 1] = Math.round((a[c] + (b[c] - a[c]) * f) * (c === 4 ? 255 : 1));
  }
  return lut;
})();

let liqTex = null, liqTexKey = '';
let liqCand = null;          // hasil agregasi terakhir (untuk panel)
let liqMinCache = { st: null, ver: -1, arr: [] };

function liqMinutes(st) {
  if (liqMinCache.st === st && liqMinCache.ver === st.version) return liqMinCache.arr;
  const arr = st.cur ? st.minutes.concat([st.cur]) : st.minutes;
  liqMinCache = { st, ver: st.version, arr };
  return arr;
}

function liqFirst(minutes, t) {
  let lo = 0, hi = minutes.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (minutes[m].t < t) lo = m + 1; else hi = m; }
  return lo;
}

/** Nilai per-bin (USD) untuk SATU candle [t0, t1): agregasi menit-menit di dalamnya. Mengisi out[0..nBins). */
function liqCandleBins(minutes, t0, t1, binLo, nBins, mode, out) {
  out.fill(0);
  const binHi = binLo + nBins - 1;
  let first = liqFirst(minutes, t0), last = liqFirst(minutes, t1) - 1;
  if (last < first) return 0;
  if (mode === 2) first = last;          // CLOSE: hanya menit terakhir yang punya data di candle ini
  let nm = 0;
  for (let i = first; i <= last; i++) {
    const m = minutes[i];
    nm++;
    const k0 = Math.max(m.lo, binLo), k1 = Math.min(m.lo + m.n - 1, binHi);
    if (k1 < k0) continue;
    const A = mode === 0 ? m.max : mode === 1 ? m.sum : m.last;
    const cnt = mode === 1 ? (m.cnt || 1) : 1;
    for (let k = k0; k <= k1; k++) {
      const v = A[k - m.lo] / cnt;
      if (v <= 0) continue;
      const o = k - binLo;
      if (mode === 0) { if (v > out[o]) out[o] = v; }
      else if (mode === 1) out[o] += v;
      else out[o] = v;
    }
  }
  if (mode === 1 && nm > 1) for (let o = 0; o < nBins; o++) out[o] /= nm;
  return nm;
}

/** Persentil (p 0..1) dari nilai positif (disampling) — untuk skala warna yang tahan outlier. */
function liqPercentile(vals, p) {
  const step = Math.max(1, Math.floor(vals.length / 30000));
  const s = [];
  for (let i = 0; i < vals.length; i += step) if (vals[i] > 0) s.push(vals[i]);
  if (!s.length) return 0;
  s.sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

function liqHeatT(v, cap) {
  const x = v / cap;
  return Math.max(0, Math.min(1, Math.sqrt(x * (liqConfig.contrast / 100))));
}

function liqStatusText(st) {
  if (!st || st.symbol !== sym) return 'LIQ \u00b7 connecting\u2026';
  const s = st.status || {};
  const ic = v => (v === 'ok' ? '\u2713' : v === 'unavailable' ? '\u2717' : '\u2026');
  const mins = (st.minutes ? st.minutes.length : 0) + (st.cur ? 1 : 0);
  if (s.binance === 'unavailable') return 'LIQ \u00b7 no Binance data for ' + sym;
  return `LIQ \u00b7 recording ${mins} min \u00b7 ${st.source || 'BIN'} ${ic(s.binance)}`;
}

function liqHeaderY() {
  return (indicators.gamma && gammaSupported(sym) && gammaData && gammaConfig.showSummary) ? 40 : 17;
}

function drawLiqStatus(st, W, right) {
  ctx.save();
  ctx.font = '10px Consolas, monospace'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  const s = st && st.status ? st.status : {};
  const bad = s.binance === 'unavailable' || s.binance === 'error';
  ctx.fillStyle = bad ? '#ef5350' : '#94a3b8';
  ctx.fillText(liqStatusText(st), right, liqHeaderY());
  ctx.restore();
}

function drawLiquidity(L, R, pr) {
  const W = CW(), top = PAD_T, bot = MH() - PAD_B;
  const right = W - 12 - gammaRightReserve();
  const st = api.liquidityStore ? api.liquidityStore() : null;
  if (!st || st.symbol !== sym || !st.bin) { drawLiqStatus(st, W, right); return; }
  const minutes = liqMinutes(st);
  if (!minutes.length) { drawLiqStatus(st, W, right); return; }
  if (!bars.length || R < L) return;

  const bin = st.bin;
  const span = pr.hi - pr.lo;
  if (!(span > 0) || bot <= top) return;
  const paneH = bot - top;
  const binsPerRow = Math.max(1, Math.ceil(liqConfig.rowPx / ((bin / span) * paneH)));
  const rowP = binsPerRow * bin;
  const rowLo = Math.floor(pr.lo / rowP) - 1, rowHi = Math.floor(pr.hi / rowP) + 1;
  const nRows = rowHi - rowLo + 1;
  if (nRows < 1 || nRows > 900) return;
  const N = R - L + 1;

  // ── tekstur heatmap (dibangun ulang hanya saat data / kamera / config berubah) ──
  const key = [st.version, L, R, rowLo, nRows, binsPerRow, liqConfig.mode,
    liqConfig.contrast, liqConfig.opacity, liqConfig.threshold, tfSec, bars[R].time].join('|');
  if (key !== liqTexKey || !liqTex) {
    const nBins = nRows * binsPerRow, binLo = rowLo * binsPerRow;
    const scratch = new Float64Array(nBins);
    const vals = new Float64Array(N * nRows);
    for (let ci = 0; ci < N; ci++) {
      const t0 = bars[L + ci].time;
      liqCandleBins(minutes, t0, t0 + tfSec, binLo, nBins, liqConfig.mode, scratch);
      for (let r = 0; r < nRows; r++) {
        let s = 0;
        for (let b = r * binsPerRow, e = b + binsPerRow; b < e; b++) s += scratch[b];
        vals[ci * nRows + r] = s;
      }
    }
    let cap = liqPercentile(vals, 0.97);
    if (!(cap > 0)) cap = 1;
    const rgba = new Uint8Array(N * nRows * 4);
    const thr = (liqConfig.threshold / 100) * cap;
    const aMul = liqConfig.opacity / 100;
    for (let ci = 0; ci < N; ci++) {
      for (let r = 0; r < nRows; r++) {
        const v = vals[ci * nRows + r];
        if (v <= 0 || v < thr) continue;
        const li = Math.round(liqHeatT(v, cap) * 255) * 4;
        const o = ((nRows - 1 - r) * N + ci) * 4;   // baris gambar paling atas = harga tertinggi
        rgba[o] = LIQ_LUT[li]; rgba[o + 1] = LIQ_LUT[li + 1]; rgba[o + 2] = LIQ_LUT[li + 2];
        rgba[o + 3] = Math.round(LIQ_LUT[li + 3] * aMul);
      }
    }
    liqTex = env.createTexture ? env.createTexture(rgba, N, nRows) : { rgba, w: N, h: nRows };
    liqTexKey = key;
    liqCand = { vals, N, nRows, cap, L, rowLo, rowP, binsPerRow, bin, binLo: rowLo * binsPerRow };
  }

  const x0 = bx(L) - barW / 2;
  const y0 = p2y((rowLo + nRows) * rowP, pr.lo, pr.hi), y1 = p2y(rowLo * rowP, pr.lo, pr.hi);
  ctx.drawTexture(liqTex, x0, y0, N * barW, y1 - y0);

  if (liqConfig.showVolume) drawLiqPanel(L, R, pr, right);
  else drawLiqHeader(null, right, minutes);
}

function liqTargetCandle(L, R) {
  const W = CW();
  if (mx >= 0 && mx < W && my >= 0 && my < MH()) {
    const i = Math.round(leftBar + mx / barW - 0.5);
    if (i >= L && i <= R && bars[i]) return i;
  }
  return R;
}

function drawLiqHeader(ci, right, minutes) {
  const st = api.liquidityStore();
  const y = liqHeaderY();
  const s = st.status || {};
  const ic = v => (v === 'ok' ? '\u2713' : v === 'unavailable' ? '\u2717' : '\u2026');
  ctx.save();
  ctx.font = 'bold 10px Consolas, monospace'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ff8c37';
  let head = 'LIQ ' + LIQ_MODES[liqConfig.mode];
  if (ci != null && bars[ci]) {
    const d = new Date(bars[ci].time * 1000);
    head += ' @ ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    head += ' \u00b7 ' + liqUnit();
  }
  ctx.fillText(head, right, y);
  ctx.font = '9px Consolas, monospace'; ctx.fillStyle = '#64748b';
  const mins = minutes ? minutes.length : 0;
  ctx.fillText(`${mins} min \u00b7 ${st.source || 'BIN'} ${ic(s.binance)}`, right, y + 12);
  ctx.restore();
}

/** Jumlah koin (bukan USD): 1.2k / 35.2 / 3.45 / 0.052 */
function fmtCoin(v) {
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(1) + 'b';
  if (a >= 1e6) return (v / 1e6).toFixed(1) + 'm';
  if (a >= 1e3) return (v / 1e3).toFixed(1) + 'k';
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  if (a >= 0.01) return v.toFixed(3);
  return v.toFixed(4);
}

/** Koin dasar pair chart untuk label (BTCUSDT → BTC, 1000PEPEUSDT → 1000PEPE). */
function liqUnit() { return String(sym || '').replace(/USDT$/, ''); }

/** Jumlah KOIN per baris harga untuk satu candle (nilai USD per bin dibagi harga bin). */
function liqCoinRows(ci, c) {
  const minutes = liqMinutes(api.liquidityStore());
  const nBins = c.nRows * c.binsPerRow;
  const scratch = new Float64Array(nBins);
  const t0 = bars[ci].time;
  liqCandleBins(minutes, t0, t0 + tfSec, c.binLo, nBins, liqConfig.mode, scratch);
  const coin = new Float64Array(c.nRows);
  for (let b = 0; b < nBins; b++) {
    const v = scratch[b];
    if (v > 0) coin[(b / c.binsPerRow) | 0] += v / ((c.binLo + b + 0.5) * c.bin);
  }
  return coin;
}

/** Panel volume vertikal: heat bar + JUMLAH KOIN per level harga untuk candle yang di-hover / terbaru. */
function drawLiqPanel(L, R, pr, right) {
  if (!liqCand) return;
  const { vals, nRows, cap, rowLo, rowP } = liqCand;
  const ci = liqTargetCandle(L, R);
  const rowsOff = (ci - L) * nRows;
  const coin = liqCoinRows(ci, liqCand);
  const top = PAD_T, bot = MH() - PAD_B;
  let rmax = 0;
  for (let r = 0; r < nRows; r++) {
    const pHi = (rowLo + r + 1) * rowP, pLo = (rowLo + r) * rowP;
    if (pHi < pr.lo || pLo > pr.hi) continue;
    if (coin[r] > rmax) rmax = coin[r];
  }
  drawLiqHeader(ci, right, liqMinutes(api.liquidityStore()));
  if (!(rmax > 0)) return;

  const wMax = liqConfig.volWidth;
  const ref = bars[ci].close;
  let bidSum = 0, askSum = 0;
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(Math.round(right) + 0.5, top); ctx.lineTo(Math.round(right) + 0.5, bot); ctx.stroke();
  ctx.font = 'bold 9px Consolas, monospace'; ctx.textBaseline = 'middle'; ctx.textAlign = 'right';
  for (let r = 0; r < nRows; r++) {
    const pLo = (rowLo + r) * rowP, pHi = pLo + rowP;
    const q = coin[r];
    if (q > 0) { if (pHi <= ref) bidSum += q; else if (pLo >= ref) askSum += q; else { bidSum += q / 2; askSum += q / 2; } }
    if (pHi < pr.lo || pLo > pr.hi || q <= 0) continue;
    const ya = p2y(pHi, pr.lo, pr.hi), yb = p2y(pLo, pr.lo, pr.hi);
    const h = yb - ya;
    if (h < 1) continue;
    const len = Math.max(2, (q / rmax) * wMax);
    const li = Math.round(liqHeatT(vals[rowsOff + r], cap) * 255) * 4;   // warna tetap mengikuti skala heatmap (USD)
    ctx.fillStyle = `rgba(${LIQ_LUT[li]}, ${LIQ_LUT[li + 1]}, ${LIQ_LUT[li + 2]}, 0.92)`;
    ctx.fillRect(right - len, ya + 0.5, len, Math.max(1, h - 1));
    if (liqConfig.showLabels && h >= 9) {
      ctx.fillStyle = 'rgba(226, 232, 240, 0.95)';
      ctx.fillText(fmtCoin(q), right - len - 4, (ya + yb) / 2 + 0.5);
    }
  }
  ctx.restore();

  // total bid / ask dalam koin (relatif terhadap close candle terpilih)
  const y = liqHeaderY() + 24;
  ctx.save();
  ctx.font = 'bold 9px Consolas, monospace'; ctx.textBaseline = 'middle'; ctx.textAlign = 'right';
  const a = 'Ask ' + fmtCoin(askSum), b = 'Bid ' + fmtCoin(bidSum);
  const wa = ctx.measureText(a).width;
  ctx.fillStyle = '#f59e0b'; ctx.fillText(a, right, y);
  ctx.fillStyle = '#60a5fa'; ctx.fillText(b, right - wa - 12, y);
  ctx.restore();
}

const LIQ_SPEC = {
  mode: ['i', 0, 2, 0], contrast: ['i', 20, 400, 100], opacity: ['i', 20, 100, 90], threshold: ['i', 0, 60, 3],
  rowPx: ['i', 2, 14, 4], volWidth: ['i', 60, 500, 170], rangeTenth: ['i', 5, 50, 15],
  showVolume: ['b'], showLabels: ['b']
};
function setLiq(key, value) {
  const sp = LIQ_SPEC[key];
  if (!sp) return;
  let v;
  if (sp[0] === 'b') v = !!value;
  else { v = parseInt(value); if (isNaN(v)) v = sp[3]; v = Math.max(sp[1], Math.min(sp[2], v)); }
  liqConfig[key] = v;
  localStorage.setItem('hf_liq_' + key, v);
  if (key === 'rangeTenth') { try { api.liquidityConfig({ rangePct: v / 10 }); } catch (e) {} }
  liqTexKey = '';
  render();
}
function liqClear() { try { api.liquidityClear(); } catch (e) {} liqTexKey = ''; liqTex = null; render(); }

let liqHandler = null;
function startLiquidityEvents() {
  if (liqHandler) events.removeListener('liquidity', liqHandler);
  liqHandler = () => { if (indicators.liq) render(); };
  events.on('liquidity', liqHandler);
  try { if (api.liquidityConfig) api.liquidityConfig({ rangePct: liqConfig.rangeTenth / 10 }); } catch (e) {}
}

// ════════════════════════════════════════════════
// HEAVY ABSORPTION — konfigurasi threshold
//
// Sinyal muncul bila volume melewati threshold adaptif:
//     threshold = mean + (multiplier × stdev)   dari `lookback` bar sebelumnya
// Dipakai di DUA tempat (parameter yang sama):
//   1) deteksi berbasis trade live (print terbesar per bar) → dihitung di lib/store.js; config dikirim ke engine (api.haConfig)
//   2) deteksi berbasis candle (volume bar, history)       → getHeavyAbsorptionDetections() di chart (lihat patch di tools/build_core.js)
// `wickPct` hanya untuk (2): ambang minimal sumbu candle (% dari range) untuk menentukan arah Buy/Sell.
// DEFAULT = perilaku lama: multiplier 2.0× · lookback 100 bar · wick 22%.
// ════════════════════════════════════════════════
const HA_DEFAULTS = { stdevTenth: 20, lookback: 100, wickPct: 22 };       // stdevTenth = multiplier × 10 (20 → 2.0×)
const HA_SPEC = { stdevTenth: [5, 60], lookback: [20, 500], wickPct: [5, 50] };

const haConfig = (function () {
  const out = {};
  for (const k of Object.keys(HA_DEFAULTS)) {
    const sp = HA_SPEC[k];
    const v = parseInt(localStorage.getItem('hf_ha_' + k));
    out[k] = isNaN(v) ? HA_DEFAULTS[k] : Math.max(sp[0], Math.min(sp[1], v));
  }
  return out;
})();

let haPushTimer = null;
/** Kirim lookback + multiplier ke engine (deteksi berbasis trade). Didebounce supaya drag slider tidak memproses ulang berkali-kali. */
function haPush(refetch) {
  clearTimeout(haPushTimer);
  haPushTimer = setTimeout(async () => {
    haPushTimer = null;
    try { if (api.haConfig) await api.haConfig({ lookback: haConfig.lookback, stdevMult: haConfig.stdevTenth / 10 }); }
    catch (e) { console.warn('[HA] gagal mengirim config ke engine:', e && e.message ? e.message : e); }
    if (refetch && indicators.ha) { await fetchHA(); render(); }
  }, 200);
}

function setHa(key, value) {
  const sp = HA_SPEC[key];
  if (!sp) return;
  let v = parseInt(value);
  if (isNaN(v)) v = HA_DEFAULTS[key];
  v = Math.max(sp[0], Math.min(sp[1], v));
  haConfig[key] = v;
  localStorage.setItem('hf_ha_' + key, v);
  if (key !== 'wickPct') haPush(true);      // multiplier & lookback juga dipakai deteksi berbasis trade di engine
  render();
}

/** Dipanggil saat start: samakan engine dengan config tersimpan (engine selalu mulai dari default). */
function startHaConfig() { haPush(false); }


// ════════════════════════════════════════════════
// CHART TYPE — Standard / Renko / Footprint Delta
//
//  • Standard  : candle OHLC biasa (perilaku lama, tidak berubah).
//  • Renko     : brick berbasis harga (bukan waktu). `bars` diganti array brick turunan dari `timeBars`; semua kode kamera/
//               crosshair/gambar tetap memakai `bars`. Data live (tick) selalu masuk ke `timeBars`, lalu brick dibangun ulang.
//               Indikator berbasis waktu (VP, Bubble, CVD, HA, HVN, Liquidity) tidak relevan → dimatikan otomatis & dinyalakan
//               lagi saat kembali ke tipe lain (CT_BLOCKED).
//  • Footprint : candle ramping di kiri slot + tabel delta (buy − sell) per baris harga di kanan (gaya ATAS/Bookmap).
//               Data: trade Bybit WS yang diagregasi engine per menit per level (lib/footprint.js) → api.footprint().
//               Slot candle < FP_MIN_BW px → tampil candle biasa (zoom in untuk melihat tabel).
// ════════════════════════════════════════════════
const CT_IDS = ['standard', 'renko', 'footprint'];
const CT_LABEL = { standard: 'Standard', renko: 'Renko', footprint: 'Footprint Delta' };
const CT_SHORT = { standard: 'Standard', renko: 'Renko', footprint: 'Footprint \u0394' };
const CT_BLOCKED = { standard: [], renko: ['vp', 'bubble', 'cvd', 'ha', 'hvn', 'liq'], footprint: ['vp'] };

let chartType = (function () { const v = localStorage.getItem('hf_chartType'); return CT_IDS.indexOf(v) >= 0 ? v : 'standard'; })();
let timeBars = [];          // candle berbasis waktu (sumber data). `bars` === timeBars kecuali Renko
let ctSuppressed = {};      // indikator yang dimatikan otomatis oleh tipe chart (id → true)
const ctCam = {};           // barW terakhir per tipe chart

const FP_MIN_BW = 52;       // lebar slot minimum (px) untuk menampilkan tabel delta
const FP_DEFAULT_BW = 76;
const FP_ROW_LADDER = (function () { const a = []; for (let e = 1; e <= 100000; e *= 10) for (const k of [1, 2, 3, 4, 5, 6, 8]) a.push(k * e); return a; })();   // kelipatan level dasar: 1,2,3,4,5,6,8,10,20,…

// ── konfigurasi (persisten) ──
const RK_DEFAULTS = { mode: 'atr', atrPeriod: 14, atrMultTenth: 10, fixed: 0, source: 'close' };
const RK_SPEC = { atrPeriod: [5, 100], atrMultTenth: [5, 50] };
const renkoConfig = (function () {
  const o = {}, rd = k => localStorage.getItem('hf_rk_' + k);
  const mode = rd('mode'); o.mode = (mode === 'fixed' || mode === 'atr') ? mode : RK_DEFAULTS.mode;
  const src = rd('source'); o.source = (src === 'hl' || src === 'close') ? src : RK_DEFAULTS.source;
  for (const k of ['atrPeriod', 'atrMultTenth']) {
    const v = parseInt(rd(k));
    o[k] = isNaN(v) ? RK_DEFAULTS[k] : Math.max(RK_SPEC[k][0], Math.min(RK_SPEC[k][1], v));
  }
  const fx = parseFloat(rd('fixed')); o.fixed = fx > 0 ? fx : 0;
  return o;
})();

const FP_DEFAULTS = { minRowPx: 13, scheme: 'bluered', showTotal: true, showPoc: true };
const FP_SPEC = { minRowPx: [9, 28] };
const fpConfig = (function () {
  const o = {}, rd = k => localStorage.getItem('hf_fp_' + k);
  const v = parseInt(rd('minRowPx'));
  o.minRowPx = isNaN(v) ? FP_DEFAULTS.minRowPx : Math.max(FP_SPEC.minRowPx[0], Math.min(FP_SPEC.minRowPx[1], v));
  const sc = rd('scheme'); o.scheme = (sc === 'teal' || sc === 'bluered') ? sc : FP_DEFAULTS.scheme;
  for (const k of ['showTotal', 'showPoc']) { const b = rd(k); o[k] = b == null ? FP_DEFAULTS[k] : (b === 'true' || b === '1'); }
  return o;
})();

function defaultBarW(type) {
  type = type || chartType;
  if (type === 'footprint') return Math.min(MAX_BW, FP_DEFAULT_BW);
  if (type === 'renko') return Math.min(20, Math.max(6, CW() / 90));
  return Math.min(12, Math.max(2, CW() / 150));      // Standard: rumus lama
}

/** Harga terakhir (live) — selalu dari candle waktu, bukan brick Renko. */
function livePrice() { const b = timeBars[timeBars.length - 1]; return b ? b.close : undefined; }

// ── indikator yang tidak kompatibel dengan tipe chart ──
function ctIsBlocked(id) { return CT_BLOCKED[chartType].indexOf(id) >= 0; }
function ctBlockedTag(id) { return ctIsBlocked(id) ? (chartType === 'renko' ? 'Renko' : 'Footprint') : ''; }

async function applyChartTypeIndicators() {
  const blocked = CT_BLOCKED[chartType];
  // 1) nyalakan lagi indikator yang tadinya dimatikan otomatis dan sekarang tidak diblok
  for (const id of Object.keys(ctSuppressed)) {
    if (blocked.indexOf(id) >= 0) continue;
    delete ctSuppressed[id];
    try { await toggleIndicator(id); } catch (e) { console.warn('[ChartType] restore', id, e && e.message); }
  }
  // 2) matikan indikator yang diblok oleh tipe ini
  for (const id of blocked) if (indicators[id]) { indicators[id] = false; ctSuppressed[id] = true; }
}

// ── pipeline bars ──
function rebuildBars() { bars = chartType === 'renko' ? renkoBuild() : timeBars; }

/** Renko: bangun ulang brick setelah tick/resync; tetap menempel di brick terbaru bila sebelumnya di tepi kanan. */
function ctRenkoSync(wasAtEdge) {
  const oldLen = bars.length;
  rebuildBars();
  if (wasAtEdge) leftBar += bars.length - oldLen;
}

/** Dipanggil setelah candle lama di-prepend ke timeBars (buffer history ke kiri). */
function ctAfterPrepend(n) {
  if (chartType !== 'renko') { bars = timeBars; leftBar += n; return; }
  const oldIdx = Math.max(0, Math.min(bars.length - 1, Math.floor(leftBar)));
  const anchor = bars[oldIdx];
  rebuildBars();
  if (!anchor) return;
  let j = -1;
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].time === anchor.time && bars[i].open === anchor.open && bars[i].close === anchor.close) { j = i; break; }
  }
  if (j < 0) for (let i = 0; i < bars.length; i++) if (bars[i].time >= anchor.time) { j = i; break; }
  if (j >= 0) leftBar += j - oldIdx;
}

// ── Renko ──
const rkSize = { key: '', size: 0 };
function ctRkReset() { rkSize.key = ''; }

/** ATR (Wilder) dari candle yang sudah tutup (candle berjalan diabaikan). */
function renkoAtr(period) {
  const n = timeBars.length - 1;
  if (n < 2) return 0;
  let atr = 0, cnt = 0, pc = timeBars[0].close;
  for (let i = 1; i < n; i++) {
    const b = timeBars[i];
    const tr = Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
    pc = b.close;
    if (cnt < period) { atr += tr; cnt++; if (cnt === period) atr /= period; }
    else atr = (atr * (period - 1) + tr) / period;
  }
  if (cnt > 0 && cnt < period) atr /= cnt;      // data kurang dari periode → rata-rata sederhana
  return atr;
}

/** Ukuran brick: tetap selama pair/TF/config sama (tidak ikut berubah tiap candle tutup → brick lama tidak bergeser). */
function renkoSize() {
  const rc = renkoConfig;
  const key = [sym, tf, rc.mode, rc.atrPeriod, rc.atrMultTenth, rc.fixed].join('|');
  if (rkSize.key === key && rkSize.size > 0) return rkSize.size;
  let size = (rc.mode === 'fixed' && rc.fixed > 0) ? rc.fixed : renkoAtr(rc.atrPeriod) * (rc.atrMultTenth / 10);
  const ref = timeBars.length ? timeBars[timeBars.length - 1].close : 0;
  if (!(size > 0) && ref > 0) size = ref * 0.001;                 // data belum cukup → 0.1% harga
  const tick = (hvnTickSym === sym && hvnTick > 0) ? hvnTick : 0;
  if (size > 0) size = tick > 0 ? Math.max(tick, Math.round(size / tick) * tick) : Number(size.toPrecision(3));
  size = Number(size.toPrecision(12));
  rkSize.key = key; rkSize.size = size;
  return size;
}

/**
 * Brick Renko tradisional dari timeBars. Level harga menempel pada kelipatan `size` (grid absolut) → brick stabil saat history
 * ditambah. Brick baru: naik bila harga ≥ atas brick terakhir + size, turun bila ≤ bawah brick terakhir − size (reversal = 2 brick).
 * source 'close' = hanya close tiap candle; 'hl' = jalur low/high/close (bullish: L→H→C, bearish: H→L→C).
 * Volume candle dibagi rata ke brick yang terbentuk; candle tanpa brick menitipkan volumenya ke brick berikutnya.
 */
function renkoBuild() {
  const src = timeBars;
  if (!src.length) return [];
  const size = renkoSize();
  if (!(size > 0)) return [];
  const hl = renkoConfig.source === 'hl';
  const out = [];
  const EPS = 1e-9;
  let loK = Math.round(src[0].open / size), hiK = loK, pend = 0;
  const px = k => Number((k * size).toPrecision(12));
  for (let i = 0; i < src.length; i++) {
    const b = src[i];
    pend += b.volume || 0;
    const pts = hl ? (b.close >= b.open ? [b.low, b.high, b.close] : [b.high, b.low, b.close]) : [b.close];
    const start = out.length;
    for (let q = 0; q < pts.length; q++) {
      const u = pts[q] / size;
      while (u >= hiK + 1 - EPS) {
        const o = px(hiK), c = px(hiK + 1);
        out.push({ time: b.time, open: o, high: c, low: o, close: c, volume: 0 });
        loK = hiK; hiK += 1;
      }
      while (u <= loK - 1 + EPS) {
        const o = px(loK), c = px(loK - 1);
        out.push({ time: b.time, open: o, high: o, low: c, close: c, volume: 0 });
        hiK = loK; loK -= 1;
      }
    }
    const made = out.length - start;
    if (made > 0) { const share = pend / made; for (let k = start; k < out.length; k++) out[k].volume = share; pend = 0; }
  }
  return out;
}

function drawRenkoBrick(b, x, bw, pr) {
  const oy = p2y(b.open, pr.lo, pr.hi), cy = p2y(b.close, pr.lo, pr.hi);
  const w = bw > 4 ? bw - 2 : Math.max(1, bw - 0.5);
  ctx.fillStyle = b.close >= b.open ? C.bull : C.bear;
  ctx.fillRect(x - w / 2, Math.min(oy, cy), w, Math.max(1, Math.abs(cy - oy)));
}

// ── Footprint Delta ──
let fpData = new Map();      // candleTime → Map<levelIdx, [buy, sell]>
let fpBase = 0;              // lebar level dasar (harga = idx × base), dari engine
let fpReady = false, fpRetry = 0, fpHoverInfo = null;
let fpInfoMemo = { k: '', v: null };

function fpReset() { fpData = new Map(); fpBase = 0; fpReady = false; fpRetry = 0; fpInfoMemo = { k: '', v: null }; }

function fpCandleTime(t) {
  if (tf === 'W') return Math.floor((t - 4 * 86400) / tfSec) * tfSec + 4 * 86400;    // candle mingguan Bybit mulai Senin
  return Math.floor(t / tfSec) * tfSec;
}

/** Ambil agregat footprint untuk simbol + TF aktif dari engine (history + data yang sudah terkumpul). */
async function fpFetch() {
  if (chartType !== 'footprint' || !api.footprint) return;
  const gen = loadGen;
  try {
    const j = await api.footprint();
    if (!j || !j.ok || j.symbol !== sym || j.timeframe !== tf || gen !== loadGen || chartType !== 'footprint') return;
    const m = new Map();
    for (const [ct, flat] of j.data) {
      const rows = new Map();
      for (let k = 0; k + 2 < flat.length; k += 3) rows.set(flat[k], [flat[k + 1], flat[k + 2]]);
      m.set(ct, rows);
    }
    fpData = m; fpBase = j.base || 0; fpReady = fpBase > 0; fpInfoMemo = { k: '', v: null };
    if (!fpReady && fpRetry++ < 20) setTimeout(() => fpFetch(), 1500);      // base terbentuk setelah trade pertama / tickSize tiba
    render();
  } catch (e) { console.warn('[Footprint] fetch error:', e && e.message ? e.message : e); }
}

/** Trade live (event dari engine): tambahkan ke level + candle yang sesuai. */
function fpOnTrade(trade) {
  if (chartType !== 'footprint' || !fpReady || !(trade.price > 0) || !(trade.volume > 0)) return;
  const ct = fpCandleTime(trade.time);
  let rows = fpData.get(ct);
  if (!rows) { rows = new Map(); fpData.set(ct, rows); }
  const idx = Math.floor(trade.price / fpBase + 1e-6);
  let a = rows.get(idx);
  if (!a) { a = [0, 0]; rows.set(idx, a); }
  if (trade.side === 'Buy') a[0] += trade.volume; else a[1] += trade.volume;
}

function fpColors() {
  if (fpConfig.scheme === 'teal') return { up: C.bull, down: C.bear, upRGB: '38,166,154', dnRGB: '239,83,80', upTxt: '#26a69a', dnTxt: '#ef5350' };
  return { up: '#3b82f6', down: '#ef5350', upRGB: '41,121,255', dnRGB: '239,83,80', upTxt: '#4da3ff', dnTxt: '#ff6b6b' };
}

/** 1.2K / +849 / -0.35 — ringkas supaya muat di sel tabel. */
function fmtFpNum(v, signed) {
  const a = Math.abs(v);
  let s;
  if (a >= 1e9) s = (a / 1e9).toFixed(2) + 'B';
  else if (a >= 1e6) s = (a / 1e6).toFixed(a >= 1e7 ? 1 : 2) + 'M';
  else if (a >= 1e4) s = (a / 1e3).toFixed(1) + 'K';
  else if (a >= 1e3) s = (a / 1e3).toFixed(2) + 'K';
  else if (a >= 100) s = a.toFixed(0);
  else if (a >= 10) s = a.toFixed(1);
  else if (a >= 1) s = a.toFixed(2);
  else if (a >= 0.01) s = a.toFixed(3);
  else { s = a.toFixed(4); if (/^0\.0+$/.test(s)) s = '0'; }
  if (s === '0') return '0';
  return (signed ? (v > 0 ? '+' : '-') : '') + s;
}

/** Gabungkan level dasar menjadi baris tampilan (kelipatan m level). */
function fpAggRows(rows, m) {
  if (m === 1) return rows;
  const out = new Map();
  for (const [idx, a] of rows) {
    const r = Math.floor(idx / m), x = out.get(r);
    if (x) { x[0] += a[0]; x[1] += a[1]; } else out.set(r, [a[0], a[1]]);
  }
  return out;
}

/** Tinggi baris tampilan: kelipatan terkecil dari level dasar yang memberi tinggi ≥ minRowPx pada zoom vertikal saat ini. */
function fpRowInfo(pr) {
  if (!(fpBase > 0)) return null;
  const mh = MH() - PAD_T - PAD_B;
  const k = pr.lo + '|' + pr.hi + '|' + mh + '|' + fpBase + '|' + fpConfig.minRowPx;
  if (fpInfoMemo.k === k) return fpInfoMemo.v;
  const pxPerPrice = mh / (pr.hi - pr.lo);
  let m = FP_ROW_LADDER[FP_ROW_LADDER.length - 1];
  for (const c of FP_ROW_LADDER) if (fpBase * c * pxPerPrice >= fpConfig.minRowPx) { m = c; break; }
  const v = { m, rowPrice: fpBase * m, rowPx: fpBase * m * pxPerPrice };
  fpInfoMemo = { k, v };
  return v;
}

/** Total buy / sell / delta satu candle (semua level). */
function fpCandleTotals(time) {
  const rows = fpData.get(time);
  if (!rows || !rows.size) return null;
  let buy = 0, sell = 0;
  for (const a of rows.values()) { buy += a[0]; sell += a[1]; }
  return { buy, sell, delta: buy - sell };
}

function drawFootprintBar(b, x, bw, pr) {
  const col = fpColors();
  const up = b.close >= b.open;
  const left = x - bw / 2;
  const cw = Math.max(3, Math.min(9, Math.round(bw * 0.085)));   // lebar badan candle (dikurangi supaya tabel muat)
  const cx = Math.round(left + 4 + cw / 2) + 0.5;
  const cellX = cx + cw / 2 + 3;
  const cellW = left + bw - 3 - cellX;
  const hy = p2y(b.high, pr.lo, pr.hi), ly = p2y(b.low, pr.lo, pr.hi);
  const oy = p2y(b.open, pr.lo, pr.hi), cy = p2y(b.close, pr.lo, pr.hi);

  // candle ramping di kiri
  const cc = up ? col.up : col.down;
  ctx.strokeStyle = cc; ctx.fillStyle = cc; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(cx, hy); ctx.lineTo(cx, ly); ctx.stroke();
  ctx.fillRect(cx - cw / 2, Math.min(oy, cy), cw, Math.max(1, Math.abs(cy - oy)));

  const rows = fpReady ? fpData.get(b.time) : null;
  if (!rows || !rows.size) return;
  const info = fpRowInfo(pr);
  if (!info) return;

  const agg = fpAggRows(rows, info.m);
  let maxAbs = 0, maxVol = 0, pocKey = null, tb = 0, ts = 0;
  for (const [r, a] of agg) {
    const ad = Math.abs(a[0] - a[1]); if (ad > maxAbs) maxAbs = ad;
    const v = a[0] + a[1]; if (v > maxVol) { maxVol = v; pocKey = r; }
    tb += a[0]; ts += a[1];
  }

  const rowH = info.rowPx, mhv = MH();
  let fs = rowH >= 15 ? 10 : (rowH >= 12 ? 9 : 8);
  if (bw < 64) fs = Math.min(fs, 9);
  const baseFont = fs + 'px Consolas, monospace';
  ctx.font = baseFont; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const hoverIn = mx >= left && mx < left + bw && my >= 0 && my < mhv;

  for (const [r, a] of agg) {
    const yTop = p2y((r + 1) * info.rowPrice, pr.lo, pr.hi), yBot = p2y(r * info.rowPrice, pr.lo, pr.hi);
    if (yBot < 0 || yTop > mhv) continue;
    const h = Math.max(1, yBot - yTop - 1);
    const d = a[0] - a[1];
    const t = maxAbs > 0 ? Math.sqrt(Math.abs(d) / maxAbs) : 0;
    ctx.fillStyle = d > 0 ? `rgba(${col.upRGB},${(0.2 + 0.45 * t).toFixed(3)})`
                  : d < 0 ? `rgba(${col.dnRGB},${(0.2 + 0.45 * t).toFixed(3)})`
                  : 'rgba(120,130,150,0.18)';
    ctx.fillRect(cellX, yTop + 0.5, cellW, h);
    if (rowH >= 10 && cellW >= 22) {
      const txt = fmtFpNum(d, true);
      let f = fs;
      const need = txt.length * fs * 0.62;
      if (need > cellW - 2) { f = Math.max(7, Math.floor((cellW - 2) / (txt.length * 0.62))); ctx.font = f + 'px Consolas, monospace'; }
      ctx.fillStyle = 'rgba(241,245,249,0.96)';
      ctx.fillText(txt, cellX + cellW / 2, yTop + 0.5 + h / 2 + 0.5);
      if (f !== fs) ctx.font = baseFont;
    }
    if (fpConfig.showPoc && r === pocKey) {                      // POC: level dengan volume terbesar
      ctx.strokeStyle = '#ff8c37'; ctx.lineWidth = 1;
      ctx.strokeRect(cellX + 0.5, yTop + 1, cellW - 1, Math.max(1, h - 1));
    }
    if (hoverIn && my >= yTop && my < yBot) {                    // sel di bawah kursor
      ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 1;
      ctx.strokeRect(cellX + 0.5, yTop + 1, cellW - 1, Math.max(1, h - 1));
      fpHoverInfo = { lo: r * info.rowPrice, hi: (r + 1) * info.rowPrice, buy: a[0], sell: a[1] };
    }
  }

  if (fpConfig.showTotal) {                                       // total delta candle di bawah candle
    const tot = tb - ts;
    ctx.font = 'bold ' + (bw >= 64 ? 10 : 9) + 'px Consolas, monospace';
    ctx.fillStyle = tot >= 0 ? col.upTxt : col.dnTxt;
    ctx.fillText(fmtFpNum(tot, true), left + bw / 2, Math.min(ly + 11, mhv - PAD_B - 3));
  }
}

/** Dipanggil renderNow untuk setiap bar yang terlihat. */
function drawBarByType(b, x, bw, pr) {
  if (chartType === 'renko') drawRenkoBrick(b, x, bw, pr);
  else if (chartType === 'footprint' && bw >= FP_MIN_BW) drawFootprintBar(b, x, bw, pr);
  else drawCandle(b, x, bw, pr);
}

/** Angka ringkas tanpa nol di belakang: 340.0000 → 340, 0.00010000 → 0.0001. */
function trimNum(v) { return String(+(Math.abs(v) >= 1 ? v.toFixed(4) : v.toFixed(8))); }

/** Label kecil di bawah baris OHLCV: tipe chart aktif + parameter + info sel yang disorot. */
function drawChartTypeChip() {
  if (chartType === 'standard' || !bars.length) return;
  let text = '', warn = false;
  if (chartType === 'renko') {
    const sz = renkoSize();
    const rc = renkoConfig;
    text = 'RENKO \u00b7 ' + (rc.mode === 'fixed' && rc.fixed > 0 ? 'fixed ' : 'ATR(' + rc.atrPeriod + ')\u00d7' + (rc.atrMultTenth / 10).toFixed(1) + ' = ') + trimNum(sz)
         + ' \u00b7 ' + (rc.source === 'hl' ? 'high/low' : 'close') + ' \u00b7 ' + bars.length + ' bricks';
  } else {
    const info = fpReady ? fpRowInfo(calcPR()) : null;
    if (barW < FP_MIN_BW) { text = 'FOOTPRINT \u0394 \u00b7 zoom in (slot \u2265 ' + FP_MIN_BW + 'px) untuk melihat tabel delta'; warn = true; }
    else if (!fpReady) { text = 'FOOTPRINT \u0394 \u00b7 menunggu trade Bybit\u2026 (data terkumpul sejak aplikasi dibuka)'; warn = true; }
    else text = 'FOOTPRINT \u0394 \u00b7 baris ' + trimNum(info ? info.rowPrice : fpBase) + (fpHoverInfo
      ? '  |  ' + fmtP(fpHoverInfo.lo) + ' \u2013 ' + fmtP(fpHoverInfo.hi) + '   Buy ' + fmtFpNum(fpHoverInfo.buy) + '  Sell ' + fmtFpNum(fpHoverInfo.sell) + '  \u0394 ' + fmtFpNum(fpHoverInfo.buy - fpHoverInfo.sell, true)
      : '');
  }
  fpHoverInfo = null;
  ctx.save();
  ctx.font = '10px Consolas, monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillStyle = warn ? '#f59e0b' : '#7c8aa5';
  ctx.fillText(text, 10, 40);
  ctx.restore();
}

// ── setter konfigurasi (dipanggil dialog) ──
function setRenko(key, value) {
  if (key === 'mode') renkoConfig.mode = value === 'fixed' ? 'fixed' : 'atr';
  else if (key === 'source') renkoConfig.source = value === 'hl' ? 'hl' : 'close';
  else if (key === 'fixed') { const f = parseFloat(value); renkoConfig.fixed = f > 0 ? f : 0; }
  else if (RK_SPEC[key]) {
    let v = parseInt(value); if (isNaN(v)) v = RK_DEFAULTS[key];
    renkoConfig[key] = Math.max(RK_SPEC[key][0], Math.min(RK_SPEC[key][1], v));
  } else return;
  localStorage.setItem('hf_rk_' + key, renkoConfig[key]);
  if (chartType === 'renko' && timeBars.length) { ctRkReset(); rebuildBars(); gotoLatest(); }
  render();
}

function setFp(key, value) {
  if (key === 'minRowPx') {
    let v = parseInt(value); if (isNaN(v)) v = FP_DEFAULTS.minRowPx;
    fpConfig.minRowPx = Math.max(FP_SPEC.minRowPx[0], Math.min(FP_SPEC.minRowPx[1], v));
  } else if (key === 'scheme') fpConfig.scheme = value === 'teal' ? 'teal' : 'bluered';
  else if (key === 'showTotal' || key === 'showPoc') fpConfig[key] = !!value;
  else return;
  localStorage.setItem('hf_fp_' + key, fpConfig[key]);
  fpInfoMemo = { k: '', v: null };
  render();
}

/** Ganti tipe chart (dipanggil dropdown Chart Type). */
async function setChartType(id) {
  if (CT_IDS.indexOf(id) < 0 || id === chartType) return chartType;
  stopMomentum();
  ctCam[chartType] = { barW };
  chartType = id;
  localStorage.setItem('hf_chartType', id);
  await applyChartTypeIndicators();
  ctRkReset();
  rebuildBars();
  const cam = ctCam[id];
  barW = (cam && cam.barW) ? cam.barW : defaultBarW(id);
  if (bars.length) gotoLatest();
  if (id === 'footprint') fpFetch();
  render();
  return chartType;
}

/** Setelah candle dimuat (applyData): footprint ambil data dari engine. */
function ctAfterApply() { if (chartType === 'footprint') fpFetch(); }

/** start(): samakan indikator dengan tipe chart tersimpan (mis. Renko → matikan VP). */
function ctInit() { applyChartTypeIndicators().catch(() => {}); }

  // ════════════════════════════════════════════════
  // PUBLIC API — dipakai oleh widget Qt
  // ════════════════════════════════════════════════
  return {
    start, resize, renderNow, render, loadData,
    toggleIndicator, toggleTool, deleteSelected, gotoLatestBtn,
    setBubbleMinToken, setBubbleMultiplier, setHvn, setCvdExchanges, setGamma, gammaSupported, setLiq, liqClear, setHa,
    setChartType, setRenko, setFp, isIndicatorBlocked: ctIsBlocked, indicatorBlockedTag: ctBlockedTag,
    stopMomentum, fmtP,
    TF_LBL, ALL_CVD_EXCHANGES,
    get indicators() { return indicators; },
    get bubbleConfig() { return bubbleConfig; },
    get hvnConfig() { return hvnConfig; },
    get gammaConfig() { return gammaConfig; },
    get liqConfig() { return liqConfig; },
    get haConfig() { return haConfig; },
    get haDefaults() { return HA_DEFAULTS; },
    get chartType() { return chartType; },
    get chartTypeLabel() { return CT_LABEL[chartType]; },
    get chartTypeShort() { return CT_SHORT[chartType]; },
    get chartTypes() { return CT_IDS.map(id => ({ id, label: CT_LABEL[id], short: CT_SHORT[id] })); },
    get renkoConfig() { return renkoConfig; },
    get renkoDefaults() { return RK_DEFAULTS; },
    get renkoBrickSize() { return chartType === 'renko' ? renkoSize() : 0; },
    get fpConfig() { return fpConfig; },
    get fpDefaults() { return FP_DEFAULTS; },
    get fp() { return { ready: fpReady, base: fpBase, candles: fpData.size }; },
    get liq() { return { tex: liqTex, cand: liqCand }; },
    get gamma() { return { data: gammaData, status: gammaStatus, msg: gammaMsg, base: gammaCurBase }; },
    get cvdConfig() { return cvdConfig; },
    get sym() { return sym; },
    get tf() { return tf; },
    get loading() { return loading; },
    get hasBars() { return bars.length > 0; },
    get activeTool() { return DM.activeTool; },
    get cam() { return { leftBar, barW, nBars: bars.length, drawings: DM.drawings.length }; },
    get hvn() { return { zones: hvnZones, periods: hvnPeriods, live: hvnLive, tick: hvnTick, dirty: hvnDirty }; },
    get bars() { return bars; },
    hvnAnchorStart, HVN_ANCHOR_SEC
  };
};
