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
