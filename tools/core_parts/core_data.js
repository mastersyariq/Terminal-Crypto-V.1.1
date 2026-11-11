
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

