
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
