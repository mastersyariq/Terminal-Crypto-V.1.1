
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

