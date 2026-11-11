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

