'use strict';
/**
 * Engine in-process untuk versi NodeGUI.
 *
 * Ini adalah port 1:1 dari server.js versi asli (tanpa Express / tanpa port HTTP).
 * Semua endpoint REST/SSE di versi browser menjadi method langsung + EventEmitter:
 *
 *   GET  /api/candles          → engine.getCandles()
 *   POST /api/load             → engine.load(symbol, tf)
 *   POST /api/buffer-more      → engine.bufferMore(oldestKnownSec)
 *   GET  /api/sub-bars         → engine.subBars(symbol, interval, start, end)
 *   GET  /api/tick   (SSE)     → engine.on('tick', fn)
 *   GET  /api/trades (SSE)     → engine.on('trade', fn)
 *   GET  /api/trade-agg        → engine.getTradeAgg()
 *   GET  /api/heavy-absorption → engine.getHeavyAbsorption()
 *   GET  /api/cvd              → engine.getCvd(symbol, interval)
 *   POST /api/cvd/config       → engine.setCvdExchanges(list)
 *   GET  /api/calendar         → engine.getCalendar()
 *   POST /api/calendar/refresh → engine.refreshCalendar()
 *   GET/POST /api/drawings     → engine.getDrawings(sym) / engine.saveDrawings(sym, list)
 *   GET  /api/pairs            → engine.getPairs()
 */

const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const EventEmitter = require('events');

const ROOT = path.join(__dirname, '..');
const CDPClient = require(path.join(ROOT, 'lib', 'cdpClient'));
const { TVSync, TF_SEC } = require(path.join(ROOT, 'lib', 'tvSync'));
const bybitWS = require(path.join(ROOT, 'lib', 'bybitWS'));
const store = require(path.join(ROOT, 'lib', 'store'));
const { getLaunchTime, getInstrumentInfo } = require(path.join(ROOT, 'lib', 'bybitInstruments'));
const { fetchKlines, fetchKlinesFull } = require(path.join(ROOT, 'lib', 'bybitKlines'));
const { fetchUSEconomicCalendar, PAST_DAYS: CAL_PAST_DAYS } = require(path.join(ROOT, 'lib', 'calendarScraper'));
const { fetchAggregatedCVD } = require(path.join(ROOT, 'lib', 'multiExchangeKlines'));
const { DeribitGamma, baseOfSymbol: gammaBaseOf } = require(path.join(ROOT, 'lib', 'deribitGamma'));
const { LiquidityRecorder } = require(path.join(ROOT, 'lib', 'liquidityBook'));
const { FootprintBook } = require(path.join(ROOT, 'lib', 'footprint'));

const CDP_PORT = 9333; // port khusus TradingView Desktop (bukan UI; bukan 9222 supaya tidak bentrok)
const MAX_GAP_BARS = 900; // gap candle > ini tidak bisa ditambal 1x REST (limit 1000) → muat ulang penuh
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Dynamic TradingView Desktop discovery ──
const TV_APPS_DIR = 'C:\\Program Files\\WindowsApps';
const TV_PREFIX = 'TradingView.Desktop_';

function findTradingViewExe() {
  try {
    const entries = fs.readdirSync(TV_APPS_DIR).filter(n => n.startsWith(TV_PREFIX)).sort();
    if (!entries.length) return null;
    const exe = path.join(TV_APPS_DIR, entries[entries.length - 1], 'TradingView.exe');
    return fs.existsSync(exe) ? exe : null;
  } catch (e) {
    console.error('[Gateway] Cannot scan WindowsApps:', e.message);
    return null;
  }
}

class Engine extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);

    this.cdp = new CDPClient(CDP_PORT);
    this.tvSync = new TVSync(this.cdp);

    // In-memory candle cache — key "SYMBOL:TF"
    this.candleCache = new Map();
    this.engineRunning = false;
    this.nextTarget = null;

    // Boot state: UI menunggu (poll /candles) sampai load pertama selesai
    this.booting = true;
    this.bootMsg = 'Connecting to TradingView\u2026';
    this.tvOk = false;
    this.tvHasSynced = false; // true setelah TradingView benar-benar di-set ke symbol/TF (bukan REST fallback)

    this.enabledCvdExchanges = ['bybit', 'binance', 'okx', 'mexc', 'bingx', 'bitstamp', 'bitunix', 'coinbase'];

    // Calendar
    this.CAL_SYNC_BUFFER_MS = 60 * 1000;
    this.CAL_SYNC_MAX_LEAD_MS = 20 * 24 * 60 * 60 * 1000;
    this.calState = { events: [], range: null, fetchedAt: null, isFetching: false, lastError: null };
    this.calScheduledTimestamps = new Set();

    // Drawings
    this.drawingsStore = new Map();
    this.DRAWINGS_FILE = path.join(ROOT, 'drawings.json');
    this._loadDrawingsFromDisk();

    // Pair list cache
    this._pairs = null;

    // Gamma Level (Deribit options GEX) — hanya BTC & ETH
    this.gamma = new DeribitGamma();
    this.gamma.on('update', d => this.emit('gamma', d));
    this.gamma.on('status', s => this.emit('gamma-status', s));

    // Liquidity Heatmap (order book Binance: Spot, fallback USD-M Futures) — merekam terus untuk pair yang sedang dibuka
    this.liq = new LiquidityRecorder();
    this.footprint = new FootprintBook();   // agregat trade per menit per level harga (chart type Footprint Delta)
    this.liq.on('update', s => this.emit('liquidity', s));
  }

  // ══════════════ lifecycle ══════════════
  async start() {
    this.calRefresh(); // fire & forget
    const tvOk = await this.ensureTVRunning();
    this.tvOk = tvOk;
    this.emit('tv', tvOk);
    if (!tvOk) {
      console.error('[Engine] TradingView not available \u2014 fallback ke Bybit REST untuk data awal');
      this.bootMsg = 'TradingView tidak tersedia \u2014 memuat dari Bybit\u2026';
    }
    try {
      if (!this.userLoaded) await this.runEngine('BTCUSDT', '60');
    } finally {
      this.booting = false;
    }
  }

  async ensureTVRunning() {
    if (process.env.HF_NO_TV === '1') { console.log('[Gateway] HF_NO_TV=1 \u2014 melewati TradingView, pakai Bybit REST'); return false; }
    try {
      await this.cdp.connect();
      console.log('[Gateway] TradingView Desktop is running \u2713');
      return true;
    } catch {
      const tvExe = findTradingViewExe();
      if (!tvExe) {
        console.error('[Gateway] TradingView.exe not found in WindowsApps \u2014 please install or start manually');
        return false;
      }
      console.log(`[Gateway] TradingView not running \u2014 launching:\n  ${tvExe}`);
      this.bootMsg = 'Launching TradingView Desktop\u2026';
      execFile(tvExe, ['--remote-debugging-port=' + CDP_PORT], err => {
        if (err) console.error('[Gateway] launch error:', err.message);
      });
      for (let i = 0; i < 20; i++) {
        await sleep(3000);
        try { await this.cdp.connect(); console.log('[Gateway] TradingView started \u2713'); return true; } catch {}
      }
      console.error('[Gateway] Could not start TradingView Desktop (timeout)');
      return false;
    }
  }

  // ══════════════ cache ══════════════
  cacheSet(symbol, tf) {
    if (!store.bars.length) return;
    this.candleCache.set(`${symbol}:${tf}`, {
      bars: [...store.bars],
      bufferTarget: store.bufferTarget,
      reachedStart: store.reachedStart,
      launchTimeSec: store.launchTimeSec,
      cachedAt: Date.now()
    });
    console.log(`[Cache] ${symbol}:${tf} \u2192 ${store.bars.length} bars saved  (${this.candleCache.size} entries total)`);
  }

  // ══════════════ live streams (pengganti SSE) ══════════════
  broadcast(tick) {
    // Tag setiap tick dengan symbol+timeframe supaya UI bisa membuang tick basi setelah switch pair/TF.
    this.emit('tick', { ...tick, symbol: store.symbol, timeframe: store.timeframe });
  }

  broadcastTrade(trade) {
    this.emit('trade', { ...trade, symbol: store.symbol, timeframe: store.timeframe });
  }

  handleTrade(trade) {
    store.addTrade(trade);
    // Footprint: agregasi per menit per level harga (independen dari TF); dikunci ke simbol asal trade
    try { this.footprint.addTrade(trade.symbol || store.symbol, trade); } catch (e) { console.warn('[Footprint] addTrade error:', e.message); }
    this.broadcastTrade(trade);
  }

  _connectWS(symbol, tf) {
    bybitWS.disconnect();
    bybitWS.connect(symbol, tf, tick => this._onTick(tick), t => this.handleTrade(t));
  }

  /**
   * Tick live dari Bybit. Bila tick melompat lebih dari 1 bar dari candle terakhir yang kita punya
   * (cache lama, WS putus, laptop sleep, dst.) → tambal candle yang hilang lewat REST lalu kirim event 'resync'.
   */
  _onTick(tick) {
    const tfSec = TF_SEC[store.timeframe] ?? 3600;
    const lastT = store.currentBar ? store.currentBar.time : (store.bars.length ? store.bars[store.bars.length - 1].time : 0);
    const gap = lastT > 0 && tick.time - lastT > tfSec;
    store.updateTick(tick);
    this.broadcast(tick);
    if (gap) this._scheduleGapFill();
  }

  _scheduleGapFill() {
    if (this._gapBusy) return;
    const symbol = store.symbol, tf = store.timeframe;
    const tfSec = TF_SEC[tf] ?? 3600;
    const last = store.bars.length ? store.bars[store.bars.length - 1].time : 0;
    if (last && (Date.now() / 1000 - last) / tfSec > MAX_GAP_BARS) {
      console.log(`[Gap] ${symbol}:${tf} gap terlalu besar \u2192 muat ulang penuh`);
      this.candleCache.delete(`${symbol}:${tf}`);
      this.emit('reload', { symbol, timeframe: tf });
      return;
    }
    this._gapBusy = true;
    this._fillGap(symbol, tf)
      .then(n => { if (store.symbol === symbol && store.timeframe === tf) { this.cacheSet(symbol, tf); this.emit('resync', { symbol, timeframe: tf, added: n }); } })
      .catch(e => console.warn('[Gap] fill error:', e.message))
      .finally(() => { this._gapBusy = false; });
  }

  /** Cache terlalu tua untuk ditambal (gap > MAX_GAP_BARS bar). */
  _cacheTooStale(cached, tf) {
    const tfSec = TF_SEC[tf] ?? 3600;
    const last = cached.bars[cached.bars.length - 1].time;
    return (Date.now() / 1000 - last) / tfSec > MAX_GAP_BARS;
  }

  /**
   * Tambal candle yang hilang antara bar terakhir di store dan sekarang (Bybit REST, 1 panggilan ≤ 1000 bar).
   * Bar terakhir lama (mungkin belum final) ikut di-refresh. Bar yang sedang berjalan masuk ke currentBar
   * supaya tick live melanjutkannya tanpa celah. Return jumlah bar baru yang ditambahkan.
   */
  async _fillGap(symbol, tf) {
    if (store.symbol !== symbol || store.timeframe !== tf || !store.bars.length) return 0;
    const tfSec = TF_SEC[tf] ?? 3600;
    const startSec = store.bars[store.bars.length - 1].time;
    const nowMs = Date.now();
    let fetched;
    try { fetched = await fetchKlines(symbol, tf, startSec * 1000, nowMs); }
    catch (e) { console.warn('[Gap] REST fill failed:', e.message); return 0; }
    if (store.symbol !== symbol || store.timeframe !== tf || !fetched.length) return 0;

    const nowSec = Math.floor(nowMs / 1000);
    const byTime = new Map(store.bars.map(b => [b.time, b]));
    let added = 0;
    for (const b of fetched) {
      if (b.time + tfSec > nowSec) {            // bar yang sedang berjalan → currentBar (di-update tick)
        const c = store.currentBar;
        if (!c) { store.currentBar = { ...b }; store.nextClose = b.time + tfSec; }
        else if (c.time === b.time) {
          c.open = b.open; c.high = Math.max(c.high, b.high); c.low = Math.min(c.low, b.low); c.volume = Math.max(c.volume, b.volume);
        }
        continue;
      }
      const ex = byTime.get(b.time);
      if (ex) Object.assign(ex, b); else { byTime.set(b.time, { ...b }); added++; }
    }
    let merged = [...byTime.values()].sort((a, b) => a.time - b.time);
    if (store.currentBar) merged = merged.filter(b => b.time !== store.currentBar.time); // jangan dobel dengan currentBar
    store.bars = merged;
    if (added) console.log(`[Gap] ${symbol}:${tf} +${added} candle ditambal via REST`);
    return added;
  }

  // ══════════════ Data Engine (cache-first) ══════════════
  async runEngine(symbol, tf) {
    this.nextTarget = { symbol, tf };
    if (this.engineRunning) return;
    this.engineRunning = true;
    try {
      while (this.nextTarget) {
        const current = this.nextTarget;
        this.nextTarget = null;
        await this.doRunEngine(current.symbol, current.tf);
      }
    } catch (e) {
      if (e.message !== 'ABORTED') console.error('[Engine] Loop error:', e.message);
      else console.log('[Engine] Execution aborted/superseded by new target');
    } finally {
      this.engineRunning = false;
    }
  }

  /** Data awal via Bybit REST bila TradingView Desktop tidak tersedia. */
  async _restInitialBars(symbol, tf) {
    const tfSec = TF_SEC[tf] ?? 3600;
    const endMs = Date.now();
    const startMs = endMs - 1000 * tfSec * 1000;
    return fetchKlinesFull(symbol, tf, startMs, endMs);
  }

  async doRunEngine(symbol, tf) {
    const checkAbort = () => {
      if (this.nextTarget && (this.nextTarget.symbol !== symbol || this.nextTarget.tf !== tf)) throw new Error('ABORTED');
    };

    try {
      const symbolChanged = !store.hasSynced || symbol !== store.symbol;
      const tfChanged = !store.hasSynced || tf !== store.timeframe;

      this.liq.follow(symbol); // perekaman order book mengikuti pair chart
      this._fpFollow(symbol);  // footprint (trade Bybit WS) mengikuti pair chart

      // Simpan kondisi terbaru pair/TF yang akan ditinggalkan (termasuk candle yang sudah ditutup oleh tick live)
      if (store.hasSynced && store.bars.length && (store.symbol !== symbol || store.timeframe !== tf)) this.cacheSet(store.symbol, store.timeframe);

      // ─── 1. Cache hit — load cepat + tambal gap candle ───
      let cached = this.candleCache.get(`${symbol}:${tf}`);
      if (cached && cached.bars.length > 0 && this._cacheTooStale(cached, tf)) {
        console.log(`[Engine] Cache ${symbol}:${tf} terlalu lama (gap > ${MAX_GAP_BARS} bar) \u2192 muat ulang penuh`);
        this.candleCache.delete(`${symbol}:${tf}`);
        cached = null;
      }
      if (cached && cached.bars.length > 0) {
        const ageMs = Date.now() - cached.cachedAt;
        const ageS = Math.round(ageMs / 1000);
        console.log(`\n[Engine] Cache HIT: ${symbol}:${tf} \u2014 ${cached.bars.length} bars  (${ageS}s old)`);
        const needFill = ageMs > 20000; // cache > 20 dtk → ada kemungkinan candle terlewat

        store.symbol = symbol;
        store.timeframe = tf;
        store.bars = [...cached.bars];
        store.loading = needFill;
        store.loadMsg = needFill ? 'Updating candles\u2026' : '';
        store.currentBar = null;
        store.nextClose = 0;
        store.bufferBusy = false;
        store.bufferTarget = cached.bufferTarget;
        store.reachedStart = cached.reachedStart;
        store.launchTimeSec = cached.launchTimeSec;

        store.reaggregateAll();
        console.log(`[Engine] Re-aggregated ${store.rawTrades.length} trades for ${symbol}:${tf}`);
        store.hasSynced = true;

        if (needFill) {
          await this._fillGap(symbol, tf);   // pastikan candle kontigu sampai bar berjalan SEBELUM UI membaca data
          checkAbort();
          store.loading = false;
          store.loadMsg = '';
          this.cacheSet(symbol, tf);
        }

        this._connectWS(symbol, tf);
        console.log('[Engine] \u2713 Cache load \u2014 refreshing TV in background\n');

        checkAbort();

        (async () => {
          try {
            if (!this.cdp.connected) return;
            if (symbolChanged || !this.tvHasSynced) await this.tvSync.verifyAndSetSymbol(symbol);
            if (tfChanged || !this.tvHasSynced) await this.tvSync.setTimeframe(tf);
            this.tvHasSynced = true;
            store.hasSynced = true;
            const freshBars = await this.tvSync.getInitialBars();
            if (freshBars.length && store.symbol === symbol && store.timeframe === tf) {
              const seen = new Set(store.bars.map(b => b.time));
              const gap = freshBars.filter(b => !seen.has(b.time));
              if (gap.length) {
                store.bars = [...store.bars, ...gap].sort((a, b) => a.time - b.time);
                if (store.bars.length > store.bufferTarget) store.bars = store.bars.slice(store.bars.length - store.bufferTarget);
                this.cacheSet(symbol, tf);
                console.log(`[Cache] Background refresh: +${gap.length} new bars for ${symbol}:${tf}`);
              }
            }
          } catch (e) { console.warn('[Engine] Background TV sync failed:', e.message); }
        })();

        return;
      }

      // ─── 2. Full load (cache miss) ───
      store.loading = true;
      store.symbol = symbol;
      store.timeframe = tf;
      store.reachedStart = false;
      store.bufferBusy = false;
      store.launchTimeSec = null;
      store.loadMsg = 'Syncing TradingView\u2026';

      console.log(`\n[Engine] \u2500\u2500 Target BYBIT:${symbol}.P | ${tf}`);

      let initialBars = [];
      const useTV = this.cdp.connected || this.tvOk;

      if (useTV) {
        if (symbolChanged || !this.tvHasSynced) { checkAbort(); await this.tvSync.verifyAndSetSymbol(symbol); }
        if (tfChanged || !this.tvHasSynced) { checkAbort(); await this.tvSync.setTimeframe(tf); }
        this.tvHasSynced = true;
        store.hasSynced = true;
        if (symbolChanged || tfChanged) store.bars = [];

        checkAbort();
        store.loadMsg = 'Loading initial bars\u2026';
        initialBars = await this.tvSync.getInitialBars();
        console.log(`[Engine] Initial extract: ${initialBars.length} bars (instant render)`);
      } else {
        // Fallback: TradingView Desktop tidak jalan → ambil dari Bybit REST
        store.loadMsg = 'Loading bars from Bybit\u2026';
        store.hasSynced = true;
        store.bars = [];
        checkAbort();
        initialBars = await this._restInitialBars(symbol, tf);
        console.log(`[Engine] REST fallback: ${initialBars.length} bars`);
      }

      checkAbort();
      store.setHistorical(initialBars, symbol, tf);
      store.bufferTarget = 5000;
      store.reachedStart = initialBars.length === 0 || initialBars.length >= 5000;

      this.cacheSet(symbol, tf);

      if (symbolChanged || tfChanged || !bybitWS.ws) {
        console.log('[Engine] \u2500\u2500 Restarting Bybit WebSocket live tick');
        this._connectWS(symbol, tf);
      }

      console.log(`[Engine] \u2713 ${initialBars.length} bars rendered \u2014 resolving buffer target\u2026\n`);

      getLaunchTime(symbol)
        .then(launchMs => {
          if (!launchMs || store.symbol !== symbol || store.timeframe !== tf) return;
          store.launchTimeSec = launchMs / 1000;
          const target = this.tvSync.computeTarget(tf, launchMs, 5000);
          store.bufferTarget = target;
          if (store.bars.length > target) store.bars = store.bars.slice(store.bars.length - target);
          store.reachedStart =
            store.bars.length === 0 ||
            store.bars.length >= target ||
            !!(store.launchTimeSec && store.bars[0]?.time <= store.launchTimeSec);
          console.log(`[Engine] Pair launch: ${new Date(launchMs).toISOString()} \u2192 buffer target: ${target}`);
          this.cacheSet(symbol, tf);
        })
        .catch(e => console.warn('[Engine] Could not get launch time:', e.message));

    } catch (e) {
      if (e.message === 'ABORTED') throw e;
      console.error('[Engine] Error:', e.message);
      store.loading = false;
      store.loadMsg = 'Error: ' + e.message;
    }
  }

  // ══════════════ API (pengganti endpoint REST) ══════════════
  health() {
    return { cdp: this.cdp.connected, loading: store.loading, loadMsg: store.loadMsg, barCount: store.bars.length };
  }

  async getPairs() {
    if (this._pairs && this._pairs.length > 60) return this._pairs;
    // 1) TradingView symbol-search (sumber asli)
    if (this.cdp.connected) {
      try {
        const pairs = await this.tvSync.fetchPairs();
        if (pairs && pairs.length > 60) { this._pairs = pairs; return pairs; }
      } catch (e) {
        console.warn('[Engine] fetchPairs (TV) failed:', e.message);
      }
    }
    // 2) Fallback: daftar perpetual USDT langsung dari Bybit REST
    try {
      const pairs = await this._restPairs();
      if (pairs.length) return pairs;
    } catch (e) {
      console.warn('[Engine] fetchPairs (REST) failed:', e.message);
    }
    return this.tvSync._bybitFallback();
  }

  _restPairs() {
    const https = require('https');
    return new Promise((resolve, reject) => {
      const url = 'https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000';
      const req = https.get(url, { timeout: 12000 }, res => {
        let raw = '';
        res.on('data', d => raw += d);
        res.on('end', () => {
          try {
            const j = JSON.parse(raw);
            const list = (j.result?.list || [])
              .filter(s => s.quoteCoin === 'USDT' && s.contractType === 'LinearPerpetual' && s.status === 'Trading')
              .map(s => ({ symbol: s.symbol, base: s.baseCoin || s.symbol.replace('USDT', ''), tvSym: s.symbol + '.P', desc: '' }))
              .sort((a, b) => a.symbol.localeCompare(b.symbol));
            resolve(list);
          } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('pairs timeout')); });
    });
  }

  getCandles() {
    const meta = store.meta();
    const out = { ok: true, bars: store.getAllBars(), ...meta };
    if (this.booting && !out.bars.length) { out.loading = true; out.loadMsg = this.bootMsg; }
    return out;
  }

  load(symbol = 'BTCUSDT', timeframe = '60') {
    if (!/^[A-Z0-9]+$/.test(symbol)) return { ok: false, err: 'Invalid symbol' };
    this.userLoaded = true; // user sudah memilih pair/TF → jangan timpa dengan load awal BTCUSDT
    this.runEngine(symbol, timeframe);
    return { ok: true, msg: `Loading BYBIT:${symbol}.P | ${timeframe}` };
  }

  /**
   * buffer-more: ambil candle lebih lama dari Bybit REST saat user scroll ke kiri
   * melewati candle tertua (lazy-load ala TradingView). Logika identik dengan server.js asli.
   */
  async bufferMore(oldestKnownSecArg) {
    if (store.bufferBusy) {
      return { ok: true, busy: true, newBars: [], total: store.bars.length, reachedStart: store.reachedStart, target: store.bufferTarget };
    }
    if (store.reachedStart || store.bars.length >= store.bufferTarget) {
      store.reachedStart = true;
      return { ok: true, busy: false, newBars: [], total: store.bars.length, reachedStart: true, target: store.bufferTarget };
    }

    const oldestKnownSec = oldestKnownSecArg ?? store.bars[0]?.time;
    if (!oldestKnownSec) return { ok: false, err: 'No oldest bar known' };

    const canAdd = store.bufferTarget - store.bars.length;
    const CHUNK = Math.min(500, canAdd);
    const tfSec = TF_SEC[store.timeframe] ?? 3600;
    const launchMs = store.launchTimeSec ? store.launchTimeSec * 1000 : 0;

    if (launchMs && oldestKnownSec * 1000 <= launchMs + tfSec * 1000) {
      store.reachedStart = true;
      return { ok: true, busy: false, newBars: [], total: store.bars.length, reachedStart: true, target: store.bufferTarget };
    }

    const endMs = oldestKnownSec * 1000;
    const startMs = Math.max(endMs - CHUNK * tfSec * 1000, launchMs || 0);

    store.bufferBusy = true;
    try {
      const fetched = await fetchKlinesFull(store.symbol, store.timeframe, startMs, endMs - 1);
      const existingTimes = new Set(store.bars.map(b => b.time));
      const toAdd = fetched.filter(b => b.time < oldestKnownSec && !existingTimes.has(b.time));

      if (toAdd.length === 0) {
        store.reachedStart = true;
        console.log(`[Buffer] No new bars from Bybit REST for ${store.symbol}:${store.timeframe} \u2192 reached start`);
      } else {
        toAdd.sort((a, b) => a.time - b.time);
        store.bars = [...toAdd, ...store.bars];
        if (store.bars.length >= store.bufferTarget) {
          store.bars = store.bars.slice(store.bars.length - store.bufferTarget);
          store.reachedStart = true;
          console.log('[Buffer] Hit 5000-bar cap');
        }
        if (store.launchTimeSec && store.bars[0].time <= store.launchTimeSec) store.reachedStart = true;
        this.cacheSet(store.symbol, store.timeframe);
      }

      console.log(`[Buffer] Bybit REST +${toAdd.length} bars | total ${store.bars.length}/${store.bufferTarget}${store.reachedStart ? ' \u2014 reached start' : ''}`);
      return { ok: true, busy: false, newBars: toAdd, total: store.bars.length, reachedStart: store.reachedStart, target: store.bufferTarget };
    } catch (e) {
      console.error('[Buffer] Bybit REST error:', e.message);
      return { ok: false, err: e.message };
    } finally {
      store.bufferBusy = false;
    }
  }

  async subBars(symbol, interval, start, end) {
    if (!symbol || !interval || !start || !end) return { ok: false, err: 'Missing params: symbol, interval, start, end' };
    try {
      const bars = await fetchKlinesFull(symbol, interval, Number(start) * 1000, Number(end) * 1000);
      return { ok: true, bars };
    } catch (e) {
      console.error('[sub-bars]', e.message);
      return { ok: false, err: e.message };
    }
  }

  /** syminfo.mintick untuk HVN Profile (tickSize dari Bybit instruments-info). */
  async getTickSize(symbol) {
    try {
      const info = await getInstrumentInfo(symbol || store.symbol);
      return info && info.tickSize > 0 ? info.tickSize : null;
    } catch (e) { return null; }
  }

  getTradeAgg() {
    return { ok: true, symbol: store.symbol, timeframe: store.timeframe, data: store.getTradeAgg() };
  }

  /** Mulai merekam footprint untuk simbol (tickSize dari Bybit menentukan lebar level). */
  _fpFollow(symbol) {
    this.footprint.follow(symbol);
    this.getTickSize(symbol)
      .then(t => this.footprint.setTick(symbol, t || 0))
      .catch(() => this.footprint.setTick(symbol, 0));
  }

  /**
   * Footprint (buy/sell per level harga per candle) untuk simbol + TF aktif.
   * data = [[candleTime, [idx, buy, sell, ...]], ...]; harga level = idx * base.
   */
  getFootprint() {
    const tfSec = TF_SEC[store.timeframe];
    const q = this.footprint.query(store.symbol, tfSec, 1500);
    return { ok: true, symbol: store.symbol, timeframe: store.timeframe, base: q.base, tick: q.tick, data: q.data };
  }

  /** Parameter threshold Heavy Absorption (lookback, stdevMult) → store memproses ulang deteksi dari rawTrades. */
  setHaOptions(o) { return { ok: true, config: store.setHAConfig(o) }; }

  getHeavyAbsorption() {
    return { ok: true, symbol: store.symbol, timeframe: store.timeframe, data: store.getHADetections() };
  }

  async getCvd(symbolArg, intervalArg) {
    const sym = symbolArg || store.symbol || 'BTCUSDT';
    const tf = intervalArg || store.timeframe || '60';
    const tfSec = TF_SEC[tf] || 3600;
    const limitBars = 1000;
    const endMs = Date.now();
    const startMs = endMs - limitBars * tfSec * 1000;
    try {
      return await fetchAggregatedCVD(sym, tf, startMs, endMs, this.enabledCvdExchanges);
    } catch (e) {
      console.error('[CVD API Error]', e.message);
      return { error: e.message };
    }
  }

  setCvdExchanges(list) {
    if (!Array.isArray(list) || list.length === 0) return { error: 'Exchanges list must be a non-empty array' };
    this.enabledCvdExchanges = list;
    console.log('[CVD Config] Updated enabled exchanges:', this.enabledCvdExchanges);
    return { ok: true, exchanges: this.enabledCvdExchanges };
  }

  // ══════════════ Economic Calendar ══════════════
  calFreshEvents() {
    const cutoff = Date.now() - CAL_PAST_DAYS * 24 * 60 * 60 * 1000;
    return this.calState.events.filter(ev => !ev.timestamp || ev.timestamp >= cutoff);
  }

  scheduleCalSync() {
    const now = Date.now();
    for (const ts of this.calScheduledTimestamps) if (ts <= now) this.calScheduledTimestamps.delete(ts);

    const future = new Set();
    for (const ev of this.calState.events) if (ev.timestamp && ev.timestamp > now) future.add(ev.timestamp);

    let count = 0;
    for (const ts of future) {
      if (this.calScheduledTimestamps.has(ts)) continue;
      const delay = ts - now + this.CAL_SYNC_BUFFER_MS;
      if (delay > this.CAL_SYNC_MAX_LEAD_MS) continue;
      this.calScheduledTimestamps.add(ts);
      count++;
      const t = setTimeout(() => {
        console.log(`[Calendar] Auto-sync: event release time (${new Date(ts).toLocaleString()}) reached, refreshing...`);
        this.calRefresh();
      }, delay);
      if (t.unref) t.unref();
    }
    if (count > 0) console.log(`[Calendar] Scheduled ${count} precision refresh(es) based on event release times`);
  }

  async calRefresh() {
    if (this.calState.isFetching) return;
    this.calState.isFetching = true;
    console.log('[Calendar] Fetching economic calendar...');
    try {
      const result = await fetchUSEconomicCalendar();
      this.calState.events = result.events;
      this.calState.range = result.range;
      this.calState.fetchedAt = result.fetchedAt;
      this.calState.lastError = null;
      console.log(`[Calendar] \u2713 ${result.events.length} events loaded`);
    } catch (e) {
      this.calState.lastError = e.message;
      console.error('[Calendar] \u2717 Fetch failed:', e.message);
    }
    this.calState.isFetching = false;
    this.scheduleCalSync();
    this.emit('calendar', this.getCalendar());
  }

  getCalendar() {
    return {
      events: this.calFreshEvents(),
      range: this.calState.range,
      fetchedAt: this.calState.fetchedAt,
      isFetching: this.calState.isFetching,
      error: this.calState.lastError
    };
  }

  async refreshCalendar() {
    await this.calRefresh();
    return this.getCalendar();
  }

  // ══════════════ Drawings (per symbol, drawings.json) ══════════════
  _loadDrawingsFromDisk() {
    try {
      if (!fs.existsSync(this.DRAWINGS_FILE)) return;
      const obj = JSON.parse(fs.readFileSync(this.DRAWINGS_FILE, 'utf-8'));
      for (const [k, v] of Object.entries(obj)) {
        const symKey = k.includes(':') ? k.split(':')[0] : k;
        const existing = this.drawingsStore.get(symKey) || [];
        const idSet = new Set(existing.map(d => d.id));
        if (Array.isArray(v)) for (const item of v) if (!idSet.has(item.id)) existing.push(item);
        this.drawingsStore.set(symKey, existing);
      }
      console.log(`[Drawings] Loaded ${this.drawingsStore.size} symbols from disk`);
    } catch (e) {
      console.error('[Drawings] Load error:', e.message);
    }
  }

  _saveDrawingsToDisk() {
    const obj = {};
    this.drawingsStore.forEach((v, k) => { obj[k] = v; });
    try { fs.writeFileSync(this.DRAWINGS_FILE, JSON.stringify(obj, null, 2), 'utf-8'); }
    catch (e) { console.error('[Drawings] Save error:', e.message); }
  }

  getDrawings(symbol) {
    if (!symbol) return { ok: false, err: 'symbol required' };
    return { ok: true, drawings: this.drawingsStore.get(symbol) || [] };
  }

  saveDrawings(symbol, drawings) {
    if (!symbol || !Array.isArray(drawings)) return { ok: false, err: 'invalid body' };
    this.drawingsStore.set(symbol, drawings);
    this._saveDrawingsToDisk();
    return { ok: true };
  }

  // ══════════════ Liquidity Heatmap ══════════════
  getLiquidityStore() { return this.liq.store; }
  liquiditySetOptions(o) { this.liq.setOptions(o); return { ok: true }; }
  liquidityClear() { this.liq.clear(); return { ok: true }; }

  // ══════════════ Gamma Level (Deribit) ══════════════
  gammaSupported(symbol) { return !!gammaBaseOf(symbol); }
  async gammaStart(symbol) { return this.gamma.start(symbol); }
  gammaStop() { this.gamma.stop(); }
  gammaSetOptions(o) { this.gamma.setOptions(o); return { ok: true }; }
  getGamma() { return this.gamma.getSnapshot(); }

  shutdown() {
    try { this.liq.stop(); } catch {}
    try { this.footprint.stop(); } catch {}
    try { this.gamma.stop(); } catch {}
    try { bybitWS.disconnect(); } catch {}
    try { if (this.cdp.ws) this.cdp.ws.close(); } catch {}
  }
}

module.exports = { Engine, TF_SEC };
