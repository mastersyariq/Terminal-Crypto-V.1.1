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

