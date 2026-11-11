'use strict';

const TF_SEC = { '1':60,'5':300,'15':900,'30':1800,'60':3600,'240':14400,'D':86400,'W':604800 };

/**
 * In-memory data store.
 * Holds historical bars (TradingView, loaded lazily on-demand like TV itself)
 * and the live current candle (Bybit WS). The frontend merges both streams.
 */
const store = {
  symbol:        'BTCUSDT',
  timeframe:     '60',
  bars:          [],     // Historical bars, ascending by time
  currentBar:    null,   // Live CURRENT candle — updated every tick from Bybit WS
  nextClose:     0,      // Unix seconds when the current candle closes
  loading:       false,  // true only during initial symbol/TF sync (fast)
  loadMsg:       '',

  // True once the very first sync (server boot) has completed. Lets the
  // engine tell "genuinely unchanged" apart from "never synced yet" so it
  // doesn't skip setSymbol()/setTimeframe() on the first run.
  hasSynced:     false,

  // ── On-demand buffering state (TradingView-style lazy history) ──
  launchTimeSec: null,   // pair listing time, bounds how far back we can buffer
  bufferTarget:  5000,   // max bars obtainable for current symbol/TF (≤5000)
  bufferBusy:    false,  // true while a buffer-more request is in flight
  reachedStart:  false,  // true once no more history can be buffered

  // ── Trade aggregation for Bubble Size indicator ──
  // Key: candle open time (Unix seconds)
  // Value: Map<priceBucket, { buy: number, sell: number }>
  tradeAgg:      new Map(),
  rawTrades:     [],     // Keep raw trades so we can re-aggregate when timeframe changes
  _tradeCount:   0,      // total trades received (for stats)

  // ── Heavy Absorption detection ──
  haDetections:  [],     // Array of { barTime, price, volume, side } — qualifying big trades
  _haBarMaxes:   [],     // Rolling window of per-bar max trade sizes (for mean/stdev)
  _haLastBar:    0,      // Last processed candle time (to detect new bar)
  _haCurBuy:     null,   // { price, volume } best buy trade in current bar
  _haCurSell:    null,   // { price, volume } best sell trade in current bar
  // Threshold adaptif = mean + stdevMult × stdev dari `lookback` bar terakhir (default = perilaku lama; diubah lewat setHAConfig)
  haConfig:      { lookback: 100, stdevMult: 2.0, minBars: 20 },

  /** Finalize initial (fast) load — called once after symbol/TF sync. */
  setHistorical(bars, symbol, tf) {
    const symbolChanged = this.symbol !== symbol;
    this.symbol      = symbol;
    this.timeframe   = tf;
    this.bars        = bars;
    this.loading     = false;
    this.loadMsg     = '';
    this.currentBar  = null;   // ← must clear: old pair's live candle must not leak
    this.nextClose   = 0;      // ← reset countdown
    this.bufferBusy  = false;  // ← clear any stale buffer lock from old pair
    
    if (symbolChanged) {
      this.tradeAgg    = new Map();
      this.rawTrades   = [];
      this._tradeCount = 0;
      this.haDetections = [];
      this._haBarMaxes  = [];
      this._haLastBar   = 0;
      this._haCurBuy    = null;
      this._haCurSell   = null;
      console.log(`[Store] ${symbol} loaded. Trade buffer cleared.`);
    } else {
      // Timeframe changed for the same symbol — re-aggregate existing trades
      this.reaggregateAll();
      this._reprocessHA();
      console.log(`[Store] Timeframe changed to ${tf}. Re-aggregated ${this.rawTrades.length} trades.`);
    }
    console.log(`[Store] ${this.bars.length} initial bars set (${symbol} ${tf})`);
  },

  /**
   * Merge older bars fetched on-demand (buffer-more) into the FRONT
   * of the bars array. Deduplicates by timestamp.
   * @returns {Array} the bars that were ACTUALLY new (not already present)
   */
  prependBars(newBars) {
    if (!newBars || !newBars.length) return [];
    const existingTimes = new Set(this.bars.map(b => b.time));
    const toAdd = newBars.filter(b => !existingTimes.has(b.time));
    if (!toAdd.length) return [];
    this.bars = [...toAdd, ...this.bars].sort((a, b) => a.time - b.time);
    return toAdd.sort((a, b) => a.time - b.time);
  },

  /**
   * Update current candle from a Bybit WebSocket tick.
   */
  updateTick(tick) {
    const tfSec = TF_SEC[this.timeframe] ?? 3600;

    if (!this.currentBar) {
      this.currentBar = { ...tick };
      this.nextClose  = tick.time + tfSec;
      return;
    }

    if (tick.time > this.currentBar.time) {
      const closed = { ...this.currentBar };
      const lastHist = this.bars[this.bars.length - 1];
      if (!lastHist || lastHist.time !== closed.time) {
        this.bars.push(closed);
      } else {
        // Bar yang sama sudah ada di history (snapshot lama dari TV / cache saat bar masih berjalan):
        // ganti dengan versi final dari WS supaya OHLC candle yang ditutup akurat.
        this.bars[this.bars.length - 1] = closed;
      }
      this.currentBar = { ...tick };
      this.nextClose  = tick.time + tfSec;

    } else if (tick.time === this.currentBar.time) {
      this.currentBar.close = tick.close;
      if (tick.high > this.currentBar.high) this.currentBar.high = tick.high;
      if (tick.low  < this.currentBar.low)   this.currentBar.low  = tick.low;
      this.currentBar.volume = tick.volume;
    }
  },

  /**
   * Add a trade from Bybit publicTrade WS to the aggregation map.
   * Trades are bucketed into candle intervals and price levels.
   *
   * @param {Object} trade - { time, price, volume, side }
   */
  addTrade(trade) {
    this.rawTrades.push(trade);
    // Cap at 100,000 raw trades to prevent memory leaks while keeping plenty of history
    if (this.rawTrades.length > 100000) {
      this.rawTrades.shift();
    }
    
    this._aggregateSingle(trade);
    this._trackHA(trade);
    this._tradeCount++;

    // Garbage collect: remove aggregation for candles older than 200 candles back
    if (this._tradeCount % 1000 === 0) {
      const tfSec = TF_SEC[this.timeframe] ?? 3600;
      const cutoff = trade.time - tfSec * 200;
      for (const [t] of this.tradeAgg) {
        if (t < cutoff) this.tradeAgg.delete(t);
      }
    }
  },

  // ── Heavy Absorption: track per-trade max within each bar ──
  _trackHA(trade) {
    const tfSec = TF_SEC[this.timeframe] ?? 3600;
    const barTime = Math.floor(trade.time / tfSec) * tfSec;

    // New bar started — finalize previous bar's detection
    if (barTime !== this._haLastBar && this._haLastBar > 0) {
      this._processHABar(this._haLastBar);
      this._haCurBuy = null;
      this._haCurSell = null;
    }
    this._haLastBar = barTime;

    // Track best (largest) buy and sell trade in current bar
    if (trade.side === 'Buy') {
      if (!this._haCurBuy || trade.volume > this._haCurBuy.volume) {
        this._haCurBuy = { price: trade.price, volume: trade.volume };
      }
    } else {
      if (!this._haCurSell || trade.volume > this._haCurSell.volume) {
        this._haCurSell = { price: trade.price, volume: trade.volume };
      }
    }
  },

  /**
   * Process a completed bar for Heavy Absorption.
   * Adds the bar's max trade to the statistical pool and checks against threshold.
   * @param {number} barTime - candle open time (Unix seconds)
   */
  _processHABar(barTime) {
    const HA_LOOKBACK = this.haConfig.lookback;
    const HA_STDEV_MULT = this.haConfig.stdevMult;
    const HA_MIN_BARS = Math.min(this.haConfig.minBars, HA_LOOKBACK);

    // Collect max trade size from this bar (larger of buy or sell)
    const maxBuy = this._haCurBuy?.volume || 0;
    const maxSell = this._haCurSell?.volume || 0;
    const barMax = Math.max(maxBuy, maxSell);
    if (barMax <= 0) return;

    // Add to rolling statistical pool
    this._haBarMaxes.push(barMax);
    while (this._haBarMaxes.length > HA_LOOKBACK) this._haBarMaxes.shift();

    // Need minimum bars for meaningful statistics (default 20)
    if (this._haBarMaxes.length < HA_MIN_BARS) return;

    // Compute adaptive threshold: mean + stdevMult × stdev
    const n = this._haBarMaxes.length;
    const mean = this._haBarMaxes.reduce((s, v) => s + v, 0) / n;
    const variance = this._haBarMaxes.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
    const stdev = Math.sqrt(variance);
    const threshold = mean + HA_STDEV_MULT * stdev;

    // Check if buy or sell print qualifies
    if (maxBuy >= threshold && this._haCurBuy) {
      this.haDetections.push({
        barTime, price: this._haCurBuy.price,
        volume: this._haCurBuy.volume, side: 'Buy'
      });
    }
    if (maxSell >= threshold && this._haCurSell) {
      this.haDetections.push({
        barTime, price: this._haCurSell.price,
        volume: this._haCurSell.volume, side: 'Sell'
      });
    }

    // Cap detections at 300
    while (this.haDetections.length > 300) this.haDetections.shift();
  },

  /**
   * Re-process Heavy Absorption from rawTrades (on timeframe change).
   * Replays all raw trades through HA detection with the new timeframe.
   */
  _reprocessHA(finalizeLast = true) {
    this.haDetections = [];
    this._haBarMaxes = [];
    this._haLastBar = 0;
    this._haCurBuy = null;
    this._haCurSell = null;
    for (const t of this.rawTrades) {
      this._trackHA(t);
    }
    // Finalize the last bar (tidak dilakukan saat ganti config: bar terakhir masih berjalan, difinalisasi sekali saat bar berganti)
    if (finalizeLast && this._haLastBar > 0) {
      this._processHABar(this._haLastBar);
    }
  },

  /**
   * Ubah parameter threshold Heavy Absorption, lalu proses ulang seluruh rawTrades dengan parameter baru.
   * @param {{lookback?: number, stdevMult?: number}} cfg  lookback = jumlah bar untuk mean/stdev (20..1000), stdevMult = pengali stdev (0.1..20)
   * @returns {{lookback:number, stdevMult:number, minBars:number}} config aktif
   */
  setHAConfig(cfg) {
    const c = this.haConfig;
    let changed = false;
    if (cfg && cfg.lookback != null) {
      const v = Math.max(20, Math.min(1000, Math.round(+cfg.lookback) || 100));
      if (v !== c.lookback) { c.lookback = v; changed = true; }
    }
    if (cfg && cfg.stdevMult != null) {
      const n = +cfg.stdevMult;
      const v = Math.max(0.1, Math.min(20, isFinite(n) && n > 0 ? n : 2.0));
      if (v !== c.stdevMult) { c.stdevMult = v; changed = true; }
    }
    if (changed) {
      this._reprocessHA(false);
      console.log(`[Store] Heavy Absorption config: threshold = mean + ${c.stdevMult} x stdev, lookback ${c.lookback} bar → ${this.haDetections.length} deteksi`);
    }
    return { ...c };
  },

  getHADetections() {
    return this.haDetections;
  },

  _aggregateSingle(trade) {
    const tfSec = TF_SEC[this.timeframe] ?? 3600;
    // Determine which candle this trade belongs to
    const candleTime = Math.floor(trade.time / tfSec) * tfSec;

    if (!this.tradeAgg.has(candleTime)) {
      this.tradeAgg.set(candleTime, new Map());
    }
    const levels = this.tradeAgg.get(candleTime);

    // Determine price bucket size based on current price magnitude
    const bucketSize = this._getBucketSize(trade.price);
    const bucket = Math.floor(trade.price / bucketSize) * bucketSize;

    if (!levels.has(bucket)) {
      levels.set(bucket, { buy: 0, sell: 0 });
    }
    const lv = levels.get(bucket);
    if (trade.side === 'Buy') {
      lv.buy += trade.volume;
    } else {
      lv.sell += trade.volume;
    }
  },

  reaggregateAll() {
    this.tradeAgg = new Map();
    for (const t of this.rawTrades) {
      this._aggregateSingle(t);
    }
  },

  /**
   * Determine an appropriate price bucket size based on price magnitude.
   * Smaller coins get finer buckets, larger coins get coarser buckets.
   */
  _getBucketSize(price) {
    if (price >= 10000)   return 10;       // BTC: $10 buckets
    if (price >= 1000)    return 1;        // ETH: $1 buckets
    if (price >= 100)     return 0.1;
    if (price >= 10)      return 0.01;
    if (price >= 1)       return 0.001;
    if (price >= 0.01)    return 0.00001;
    if (price >= 0.0001)  return 0.0000001;
    return 0.000000001;                    // SHIB-level tiny coins
  },

  /**
   * Get trade aggregation data for the frontend.
   * Returns a serializable object: { [candleTime]: { [priceLevel]: { buy, sell } } }
   */
  getTradeAgg() {
    const result = {};
    for (const [candleTime, levels] of this.tradeAgg) {
      const obj = {};
      for (const [price, vol] of levels) {
        obj[price] = { buy: vol.buy, sell: vol.sell };
      }
      result[candleTime] = obj;
    }
    return result;
  },

  /** Return all bars for the frontend — historical + live current candle merged. */
  getAllBars() {
    if (!this.currentBar) return [...this.bars];
    const hist = [...this.bars];
    if (hist.length && hist[hist.length - 1].time === this.currentBar.time) {
      hist.pop();
    }
    return [...hist, { ...this.currentBar }];
  },

  meta() {
    const all = this.getAllBars();
    return {
      symbol:        this.symbol,
      timeframe:     this.timeframe,
      count:         all.length,
      loading:       this.loading,
      loadMsg:       this.loadMsg,
      lastPrice:     this.currentBar?.close ?? all[all.length - 1]?.close ?? 0,
      nextClose:     this.nextClose,
      tfSec:         TF_SEC[this.timeframe] ?? 3600,
      bufferTarget:  this.bufferTarget,
      bufferBusy:    this.bufferBusy,
      reachedStart:  this.reachedStart
    };
  }
};

module.exports = store;
