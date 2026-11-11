// Membangun nodegui/chart/chartCore.js dari public/index.html (versi browser ASLI).
// Dipakai untuk menyamakan kembali logika chart dengan versi asli bila index.html asli berubah.
// Usage: node tools/build_core.js [path/ke/index.html]   (default: public/index.html)
const fs = require('fs'), path = require('path');
const ASLI = process.argv[2] || path.join(__dirname, '..', 'public', 'index.html');
const DEV = path.join(__dirname, 'core_parts');
const OUT = path.join(__dirname, '..', 'nodegui', 'chart', 'chartCore.js');

const src = fs.readFileSync(ASLI, 'utf8').replace(/\r\n/g, '\n').split('\n');
const seg = (a, b) => src.slice(a - 1, b).join('\n') + '\n';
const read = f => fs.readFileSync(path.join(DEV, f), 'utf8');

function patch(text, label, old, rep) {
  const i = text.indexOf(old);
  if (i < 0) throw new Error('PATCH NOT FOUND: ' + label);
  if (text.indexOf(old, i + old.length) >= 0) throw new Error('PATCH AMBIGUOUS: ' + label);
  return text.slice(0, i) + rep + text.slice(i + old.length);
}

let out = read('core_head.js');

// 1) konstanta + state (627–733)
let s1 = seg(627, 733);
s1 = patch(s1, 'indicators gamma flag', 'ha: false, hvn: false };', 'ha: false, hvn: false, gamma: false, liq: false };');
out += s1;

// 2) dimensi kanvas, layout pane, koordinat (741–860)  + resize/overlay (Qt)
out += seg(741, 860);
out += read('core_overlay.js');

// 3) kamera, price range, warna (878–1011)
let s3 = seg(878, 1011);
// Chart type: lebar slot awal bergantung tipe chart (Standard = rumus lama). core_charttype.js
s3 = patch(s3, 'initCamera', 'function initCamera() { barW = Math.min(12, Math.max(2, CW() / 150)); gotoLatest(); }',
  'function initCamera() { barW = defaultBarW(); gotoLatest(); }');
out += s3;

// 4) render() → renderNow()
let s5 = seg(1012, 1154);
s5 = patch(s5, 'render fn', 'function render() {', 'function renderNow() {');
s5 = patch(s5, 'waiting overlay', "ctx.fillText('Waiting for data\u2026', W / 2, H / 2); return; }", "ctx.fillText('Waiting for data\u2026', W / 2, H / 2); drawOverlays(); return; }");
s5 = patch(s5, 'render tail', "  maybeBufferMore();\n  scheduleVpFetch();", "  drawOverlays();\n  maybeBufferMore();\n  scheduleVpFetch();");
s5 = patch(s5, 'hvn refresh hook', 'if (hvnDirty) computeHVN();', 'if (hvnDirty) computeHVN(); else hvnRefresh();');
s5 = patch(s5, 'gamma draw hook',
  "    } catch (e) { console.warn('[HVN render error]', e); }\n  }\n",
  "    } catch (e) { console.warn('[HVN render error]', e); }\n  }\n  if (indicators.liq) {\n    try { drawLiquidity(L, R, pr); } catch (e) { console.warn('[Liquidity render error]', e); }\n  }\n  if (indicators.gamma) {\n    try { drawGamma(L, R, pr); } catch (e) { console.warn('[Gamma render error]', e); }\n  }\n");
// Chart type: gambar bar sesuai tipe (Standard / Renko / Footprint) + harga live dari candle waktu (bukan brick). core_charttype.js
s5 = patch(s5, 'draw bar by chart type', 'drawCandle(bars[i], x, barW, pr);', 'drawBarByType(bars[i], x, barW, pr);');
s5 = patch(s5, 'live price', 'drawCurPrice(bars[bars.length - 1]?.close, pr, W);', 'drawCurPrice(livePrice(), pr, W);');
out += s5;

// 5) fungsi gambar (1156–2233): candle, VP, HVN, bubble, CVD, HA, axis, crosshair
let s6 = seg(1156, 2233);
s6 = patch(s6, 'fetchHA',
  "    const r = await fetch('/api/heavy-absorption');\n    const j = await r.json();",
  "    const j = await api.heavyAbsorption();");
// Heavy Absorption: threshold bisa diatur (multiplier stdev, lookback, rasio wick). Default = nilai lama (2.0 / 100 / 0.22). Config: core_ha.js
s6 = patch(s6, 'HA consts', '  const HA_LOOKBACK = 100;\n  const HA_STDEV_MULT = 2.0;\n',
  '  const HA_LOOKBACK = haConfig.lookback;\n  const HA_STDEV_MULT = haConfig.stdevTenth / 10;\n  const HA_WICK = haConfig.wickPct / 100;\n');
s6 = patch(s6, 'HA wick upper', 'upperWick / span >= 0.22', 'upperWick / span >= HA_WICK');
s6 = patch(s6, 'HA wick lower', 'lowerWick / span >= 0.22', 'lowerWick / span >= HA_WICK');
// Chart type: countdown candle waktu tidak bermakna pada Renko; acuan waktu tutup dari candle waktu (timeBars)
s6 = patch(s6, 'curprice lastB', '  const lastB = bars[bars.length - 1];\n  const effClose = nextClose > 0', '  const lastB = timeBars[timeBars.length - 1];\n  const effClose = nextClose > 0');
s6 = patch(s6, 'curprice countdown', 'if (rem > 0 && rem < tfSec * 1.5) {', "if (chartType !== 'renko' && rem > 0 && rem < tfSec * 1.5) {");
out += s6;

// 6) on-demand buffering (2250–2310)
let s7 = seg(2250, 2310);
s7 = patch(s7, 'buffer-more',
  "    const res = await fetch('/api/buffer-more', {\n      method: 'POST',\n      headers: { 'Content-Type': 'application/json' },\n      body: JSON.stringify({ oldestKnownSec })\n    });\n    const d = await res.json();",
  "    const d = await api.bufferMore(oldestKnownSec);");
// Chart type: buffer history bekerja pada candle waktu (timeBars); Renko dibangun ulang setelah prepend
s7 = patch(s7, 'buffer oldest known', 'const oldestKnownSec = bars.length ? bars[0].time : null;', 'const oldestKnownSec = timeBars.length ? timeBars[0].time : null;');
s7 = patch(s7, 'buffer current oldest', 'const currentOldest = bars.length ? bars[0].time : Infinity;', 'const currentOldest = timeBars.length ? timeBars[0].time : Infinity;');
s7 = patch(s7, 'buffer prepend', 'bars = [...safeNew, ...bars];\n        leftBar += safeNew.length;', 'timeBars = [...safeNew, ...timeBars];\n        ctAfterPrepend(safeNew.length);');
out += s7;

// 7) drawing system (2313–3054)
out += seg(2313, 3054);

// 8) persistence + setActiveTool (3055–3105)
let s9 = seg(3055, 3105);
s9 = patch(s9, 'drawPersist',
  "  fetch('/api/drawings', {\n    method: 'POST',\n    headers: { 'Content-Type': 'application/json' },\n    body: JSON.stringify({ symbol: sym, drawings: DM.drawings })\n  }).catch(() => {});",
  "  try { api.saveDrawings(sym, DM.drawings); } catch (e) {}");
s9 = patch(s9, 'drawLoad',
  "    const r = await fetch(`/api/drawings?symbol=${newSym}`);\n    const d = await r.json();",
  "    const d = await api.getDrawings(newSym);");
s9 = patch(s9, 'setActiveTool',
  "  document.querySelectorAll('.draw-btn').forEach(b => {\n    b.classList.toggle('active', b.dataset.tool === tool);\n  });",
  "  ui.setActiveDrawTool(tool);");
out += s9;

// 9) double-click → edit objek (3122–3133)
out += seg(3122, 3133);

// 10) interaksi mouse/keyboard (3338–3545, 3548–3609)
let s11 = seg(3338, 3545) + seg(3548, 3609);
s11 = patch(s11, 'mouseleave', "document.getElementById('ohlcv-ov').innerHTML = '';", 'showOHLCV(null);');
s11 = patch(s11, 'no momentum',
  '  if (wasPan && Math.abs(velX) > 0.04) startMomentum();',
  '  velX = 0; // tanpa inertia: pan horizontal langsung berhenti saat klik-tahan dilepas (sama seperti scroll Y)');
out += s11;

// 11) data loading in-process + glue UI
out += read('core_data.js');

// 12) VP sub-bar engine (4128–4198) + format helpers (4200–4237)
let s13 = seg(4128, 4198);
s13 = patch(s13, 'sub-bars',
  "    const url = `/api/sub-bars?symbol=${encodeURIComponent(sym)}&interval=${subIv}&start=${startSec}&end=${endSec}`;\n    const j   = await fetch(url).then(r => r.json());",
  "    const j   = await api.subBars(sym, subIv, startSec, endSec);");
// Chart type: sub-bar VP hanya relevan pada chart Standard (VP dimatikan di Renko/Footprint)
s13 = patch(s13, 'vp fetch gate', 'if (!subIv || barW < VP_MIN_BW || !bars.length || vpFetching) return;', "if (chartType !== 'standard' || !subIv || barW < VP_MIN_BW || !bars.length || vpFetching) return;");
out += s13;
out += seg(4200, 4237);

// HVN Profile: ganti seluruh blok compute+draw bawaan dengan versi yang mengikuti deskripsi indikator
{
  const a = out.indexOf('const HVN_ANCHOR_SEC');
  const dh = out.indexOf('function drawHVN(');
  if (a < 0 || dh < 0) throw new Error('HVN block not found');
  const e = out.indexOf('\n}\n', dh) + 3;
  // mundur ke awal banner komentar "HVN PROFILE" bila ada
  out = out.slice(0, a) + read('core_hvn.js') + out.slice(e);
}

out += read('core_gamma.js');
out += read('core_liquidity.js');
out += read('core_ha.js');
out += read('core_charttype.js');
out += read('core_tail.js');

// perbaikan karakter rusak (mojibake) di file sumber
out = out.replace(/\u00e2\u2014\u008f?/g, '\u25cf');
out = out.replace(/^(\s*\/\/ )[\u00e2\u2022\u0080-\u009f]{3,}$/gm, '$1' + '\u2550'.repeat(48));
out = out.replace(/\u00e2\u2020\u0090/g, '\u2190');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, out, 'utf8');
console.log('written', OUT, out.split('\n').length + ' lines', Buffer.byteLength(out) + ' bytes');
