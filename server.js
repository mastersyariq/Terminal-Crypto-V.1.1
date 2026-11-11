'use strict';

const express    = require('express');
const path       = require('path');
const fs         = require('fs');
const { exec, execFile } = require('child_process');

const CDPClient  = require('./lib/cdpClient');
const { TVSync, TF_SEC } = require('./lib/tvSync');
const bybitWS    = require('./lib/bybitWS');
const store      = require('./lib/store');
const { getLaunchTime }  = require('./lib/bybitInstruments');
const { fetchKlinesFull } = require('./lib/bybitKlines');
const { fetchUSEconomicCalendar, PAST_DAYS: CAL_PAST_DAYS } = require('./lib/calendarScraper');
const { fetchAggregatedCVD } = require('./lib/multiExchangeKlines');

const app  = express();
const PORT = 3000;
const CDP_PORT = 9333; // Port khusus TradingView Desktop. SENGAJA bukan 9222 (default Chrome DevTools Protocol) supaya tidak bentrok dengan MCP chrome-devtools / tool CDP lain yang juga default ke 9222.

// ════════════════════════════════════════════════════════════
// Dynamic TradingView Desktop discovery
// Scans WindowsApps for the latest TradingView.Desktop_* folder
// so we never need to hardcode a version-specific path again.
// ════════════════════════════════════════════════════════════
const TV_APPS_DIR = 'C:\\Program Files\\WindowsApps';
const TV_PREFIX   = 'TradingView.Desktop_';

function findTradingViewExe() {
  try {
    const entries = fs.readdirSync(TV_APPS_DIR)
      .filter(name => name.startsWith(TV_PREFIX))
      .sort();                        // lexicographic → latest version last
    if (!entries.length) return null;
    const folder = entries[entries.length - 1]; // pick the latest
    const exe = path.join(TV_APPS_DIR, folder, 'TradingView.exe');
    if (fs.existsSync(exe)) return exe;
    return null;
  } catch (e) {
    console.error('[Gateway] Cannot scan WindowsApps:', e.message);
    return null;
  }
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ════════════════════════════════════════════════════════════
// In-memory candle cache  (cleared on server restart only)
//
// Key:   "SYMBOL:TF"  e.g. "BTCUSDT:60"
// Value: { bars, bufferTarget, reachedStart, launchTimeSec, cachedAt }
//
// Purpose: switching back to a previously loaded pair/TF is
// INSTANT — no TradingView sync required.  The cache is then
// silently refreshed in the background to fill any gap bars.
// ════════════════════════════════════════════════════════════
const candleCache = new Map();

function cacheSet(symbol, tf) {
  if (!store.bars.length) return;
  candleCache.set(`${symbol}:${tf}`, {
    bars:          [...store.bars],
    bufferTarget:  store.bufferTarget,
    reachedStart:  store.reachedStart,
    launchTimeSec: store.launchTimeSec,
    cachedAt:      Date.now()
  });
  console.log(`[Cache] ${symbol}:${tf} → ${store.bars.length} bars saved  (${candleCache.size} entries total)`);
}

// ════════════════════════════════════════════════════════════
// CDP + TVSync initialisation
// ════════════════════════════════════════════════════════════
const cdp    = new CDPClient(CDP_PORT);
const tvSync = new TVSync(cdp);

async function ensureTVRunning() {
  try {
    await cdp.connect();
    console.log('[Gateway] TradingView Desktop is running ✓');
    return true;
  } catch {
    const tvExe = findTradingViewExe();
    if (!tvExe) {
      console.error('[Gateway] TradingView.exe not found in WindowsApps — please install or start manually');
      return false;
    }
    console.log(`[Gateway] TradingView not running — launching:\n  ${tvExe}`);
    execFile(tvExe, ['--remote-debugging-port=9333'], err => {
      if (err) console.error('[Gateway] launch error:', err.message);
    });
    for (let i = 0; i < 20; i++) {
      await sleep(3000);
      try { await cdp.connect(); console.log('[Gateway] TradingView started ✓'); return true; } catch {}
    }
    console.error('[Gateway] Could not start TradingView Desktop (timeout)');
    return false;
  }
}

// ════════════════════════════════════════════════════════════
// SSE broadcast — sends live ticks to all connected browsers
// ════════════════════════════════════════════════════════════
const sseClients = new Set();

function broadcast(tick) {
  // Tag every tick with the current symbol + timeframe so the frontend
  // can discard ticks that arrived after a pair/TF switch.
  const tagged = { ...tick, symbol: store.symbol, timeframe: store.timeframe };
  const msg  = `data: ${JSON.stringify(tagged)}\n\n`;
  const dead = [];
  sseClients.forEach(res => {
    try { res.write(msg); } catch { dead.push(res); }
  });
  dead.forEach(r => sseClients.delete(r));
}

// ════════════════════════════════════════════════════════════
// SSE broadcast — sends live trades (publicTrade) to browsers
// ════════════════════════════════════════════════════════════
const sseTradeClients = new Set();

function broadcastTrade(trade) {
  const tagged = { ...trade, symbol: store.symbol, timeframe: store.timeframe };
  const msg = `data: ${JSON.stringify(tagged)}\n\n`;
  const dead = [];
  sseTradeClients.forEach(res => {
    try { res.write(msg); } catch { dead.push(res); }
  });
  dead.forEach(r => sseTradeClients.delete(r));
}

/** onTrade callback for bybitWS — stores + broadcasts each trade */
function handleTrade(trade) {
  store.addTrade(trade);
  broadcastTrade(trade);
}

// ════════════════════════════════════════════════════════════
// Data Engine
//
// Cache-first flow:
//   1. If pair+TF is in cache → instant load (no overlay, no TV sync).
//      TV is synced silently in the background to fill gap bars.
//   2. If not cached → full load: setSymbol→setTF→getInitialBars,
//      then store.setHistorical() immediately (removes overlay early),
//      then getLaunchTime() async to refine bufferTarget.
// ════════════════════════════════════════════════════════════
let engineRunning = false;
let nextTarget = null; // holds { symbol, tf } for queueing

async function runEngine(symbol, tf) {
  nextTarget = { symbol, tf };
  if (engineRunning) return;
  engineRunning = true;

  try {
    while (nextTarget) {
      const current = nextTarget;
      nextTarget = null;
      await doRunEngine(current.symbol, current.tf);
    }
  } catch (e) {
    if (e.message !== 'ABORTED') {
      console.error('[Engine] Loop error:', e.message);
    } else {
      console.log('[Engine] Execution aborted/superseded by new target');
    }
  } finally {
    engineRunning = false;
  }
}

async function doRunEngine(symbol, tf) {
  const checkAbort = () => {
    if (nextTarget && (nextTarget.symbol !== symbol || nextTarget.tf !== tf)) {
      throw new Error('ABORTED');
    }
  };

  try {
    const symbolChanged = !store.hasSynced || symbol !== store.symbol;
    const tfChanged     = !store.hasSynced || tf     !== store.timeframe;

    // ─── 1. Cache hit — instant load ──────────────────────────────────────
    const cached = candleCache.get(`${symbol}:${tf}`);
    if (cached && cached.bars.length > 0) {
      const ageS = Math.round((Date.now() - cached.cachedAt) / 1000);
      console.log(`\n[Engine] Cache HIT: ${symbol}:${tf} — ${cached.bars.length} bars  (${ageS}s old)`);

      store.symbol        = symbol;
      store.timeframe     = tf;
      store.bars          = [...cached.bars];
      store.loading       = false;
      store.loadMsg       = '';
      store.currentBar    = null;
      store.nextClose     = 0;
      store.bufferBusy    = false;
      store.bufferTarget  = cached.bufferTarget;
      store.reachedStart  = cached.reachedStart;
      store.launchTimeSec = cached.launchTimeSec;
      
      // Re-aggregate existing trade history for the target timeframe
      store.reaggregateAll();
      console.log(`[Engine] Re-aggregated ${store.rawTrades.length} trades for ${symbol}:${tf}`);
      
      store.hasSynced     = true;

      bybitWS.disconnect();
      bybitWS.connect(symbol, tf, tick => { store.updateTick(tick); broadcast(tick); }, handleTrade);
      console.log(`[Engine] ✓ Instant cache load — refreshing TV in background\n`);

      checkAbort();

      ;(async () => {
        try {
          if (symbolChanged) await tvSync.verifyAndSetSymbol(symbol);
          if (tfChanged)     await tvSync.setTimeframe(tf);
          store.hasSynced = true;
          const freshBars = await tvSync.getInitialBars();
          if (freshBars.length && store.symbol === symbol && store.timeframe === tf) {
            const seen = new Set(store.bars.map(b => b.time));
            const gap  = freshBars.filter(b => !seen.has(b.time));
            if (gap.length) {
              store.bars = [...store.bars, ...gap].sort((a, b) => a.time - b.time);
              if (store.bars.length > store.bufferTarget) {
                store.bars = store.bars.slice(store.bars.length - store.bufferTarget);
              }
              cacheSet(symbol, tf);
              console.log(`[Cache] Background refresh: +${gap.length} new bars for ${symbol}:${tf}`);
            }
          }
        } catch (e) { console.warn('[Engine] Background TV sync failed:', e.message); }
      })();

      return;
    }

    // ─── 2. Full load (cache miss) ─────────────────────────────────────────
    store.loading       = true;
    store.symbol        = symbol;
    store.timeframe     = tf;
    store.reachedStart  = false;
    store.bufferBusy    = false;
    store.launchTimeSec = null;
    store.loadMsg       = 'Syncing TradingView…';

    console.log(`\n[Engine] ── Target BYBIT:${symbol}.P | ${tf}`);

    if (symbolChanged) {
      checkAbort();
      await tvSync.verifyAndSetSymbol(symbol);
    }
    if (tfChanged) {
      checkAbort();
      await tvSync.setTimeframe(tf);
    }
    store.hasSynced = true;

    if (symbolChanged || tfChanged) store.bars = [];

    checkAbort();
    store.loadMsg = 'Loading initial bars…';
    const initialBars = await tvSync.getInitialBars();
    console.log(`[Engine] Initial extract: ${initialBars.length} bars (instant render)`);

    checkAbort();
    store.setHistorical(initialBars, symbol, tf);
    store.bufferTarget = 5000;
    store.reachedStart = initialBars.length === 0 || initialBars.length >= 5000;

    cacheSet(symbol, tf);

    if (symbolChanged || tfChanged) {
      console.log('[Engine] ── Restarting Bybit WebSocket live tick');
      bybitWS.disconnect();
      bybitWS.connect(symbol, tf, tick => {
        store.updateTick(tick);
        broadcast(tick);
      }, handleTrade);
    }

    console.log(`[Engine] ✓ ${initialBars.length} bars rendered — resolving buffer target…\n`);

    getLaunchTime(symbol)
      .then(launchMs => {
        if (!launchMs || store.symbol !== symbol || store.timeframe !== tf) return;
        store.launchTimeSec = launchMs / 1000;
        const target = tvSync.computeTarget(tf, launchMs, 5000);
        store.bufferTarget  = target;
        if (store.bars.length > target) {
          store.bars = store.bars.slice(store.bars.length - target);
        }
        store.reachedStart =
          store.bars.length === 0 ||
          store.bars.length >= target ||
          !!(store.launchTimeSec && store.bars[0]?.time <= store.launchTimeSec);
        console.log(`[Engine] Pair launch: ${new Date(launchMs).toISOString()} → buffer target: ${target}`);
        cacheSet(symbol, tf);
      })
      .catch(e => console.warn('[Engine] Could not get launch time:', e.message));

  } catch (e) {
    if (e.message === 'ABORTED') throw e;
    console.error('[Engine] Error:', e.message);
    store.loading = false;
    store.loadMsg = 'Error: ' + e.message;
  }
}

// ════════════════════════════════════════════════════════════
// API Routes
// ════════════════════════════════════════════════════════════

app.get('/api/health', (req, res) => {
  res.json({ cdp: cdp.connected, loading: store.loading, loadMsg: store.loadMsg, barCount: store.bars.length });
});

app.get('/api/pairs', async (req, res) => {
  try {
    const pairs = await tvSync.fetchPairs();
    res.json({ ok: true, pairs });
  } catch (e) {
    res.status(500).json({ ok: false, err: e.message });
  }
});

app.get('/api/candles', (req, res) => {
  const all = store.getAllBars();
  res.json({ ok: true, bars: all, ...store.meta() });
});

app.post('/api/load', async (req, res) => {
  const { symbol = 'BTCUSDT', timeframe = '60' } = req.body;
  if (!/^[A-Z0-9]+$/.test(symbol)) return res.status(400).json({ ok: false, err: 'Invalid symbol' });

  res.json({ ok: true, msg: `Loading BYBIT:${symbol}.P | ${timeframe}` });
  runEngine(symbol, timeframe);
});

/**
 * POST /api/buffer-more
 *
 * Fetches older historical bars from the Bybit REST API when the user
 * scrolls left past the oldest locally loaded candle.
 *
 * Cycle:
 *   1. Frontend tracks oldest candle (bars[0]) in the HF Terminal.
 *   2. When empty space appears on the left, frontend calls this endpoint
 *      with `oldestKnownSec` = bars[0].time.
 *   3. We fetch up to 500 bars BEFORE that timestamp from Bybit REST.
 *   4. New bars are prepended to the store; frontend shifts camera right.
 *   5. Repeat until bufferTarget (≤5000) is reached or pair launch date hit.
 *
 * Why Bybit REST instead of chart_scroll_to_date / TV CDP?
 *   chart_scroll_to_date (MCP) and CDP setVisibleRange both change TV's
 *   VIEWPORT but do NOT reliably trigger TV to request new data over its
 *   WebSocket — confirmed by the server logs ("no progress" on every iter).
 *   Bybit REST provides identical OHLCV data with no rate-limit issues and
 *   is already used for VP sub-bars. The 5000-bar TV free-user cap is still
 *   respected: bufferTarget is set from the pair launch date and capped at 5000.
 */
app.post('/api/buffer-more', async (req, res) => {
  // Guard: already busy
  if (store.bufferBusy) {
    return res.json({ ok: true, busy: true, newBars: [], total: store.bars.length,
      reachedStart: store.reachedStart, target: store.bufferTarget });
  }

  // Guard: already at or past the cap (TV free-user 5000-bar limit)
  if (store.reachedStart || store.bars.length >= store.bufferTarget) {
    store.reachedStart = true;
    return res.json({ ok: true, busy: false, newBars: [], total: store.bars.length,
      reachedStart: true, target: store.bufferTarget });
  }

  // The frontend sends the Unix timestamp (seconds) of its LEFTMOST loaded candle.
  // We fetch bars that come BEFORE this timestamp.
  const oldestKnownSec = req.body?.oldestKnownSec ?? store.bars[0]?.time;
  if (!oldestKnownSec) {
    return res.json({ ok: false, err: 'No oldest bar known' });
  }

  // Determine how many more bars we can still add before hitting the cap
  const canAdd     = store.bufferTarget - store.bars.length;
  const CHUNK      = Math.min(500, canAdd);          // max 500 per request
  const tfSec      = TF_SEC[store.timeframe] ?? 3600;
  const launchMs   = store.launchTimeSec ? store.launchTimeSec * 1000 : 0;

  // If oldest candle is already at or before pair launch date → nothing more to load
  if (launchMs && oldestKnownSec * 1000 <= launchMs + tfSec * 1000) {
    store.reachedStart = true;
    return res.json({ ok: true, busy: false, newBars: [], total: store.bars.length,
      reachedStart: true, target: store.bufferTarget });
  }

  // Time range for Bybit REST fetch (endMs is exclusive — the candle we already have)
  const endMs   = oldestKnownSec * 1000;
  const startMs = Math.max(endMs - CHUNK * tfSec * 1000, launchMs || 0);

  store.bufferBusy = true;
  try {
    // Fetch from Bybit REST API (same as VP sub-bars — proven reliable)
    const fetched = await fetchKlinesFull(store.symbol, store.timeframe, startMs, endMs - 1);

    // Keep only bars strictly older than our current oldest (deduplicate)
    const existingTimes = new Set(store.bars.map(b => b.time));
    const toAdd = fetched.filter(b => b.time < oldestKnownSec && !existingTimes.has(b.time));

    if (toAdd.length === 0) {
      // Bybit returned no new bars → we're at the beginning of available history
      store.reachedStart = true;
      console.log(`[Buffer] No new bars from Bybit REST for ${store.symbol}:${store.timeframe} → reached start`);
    } else {
      // Prepend older bars, sorted oldest→newest
      toAdd.sort((a, b) => a.time - b.time);
      store.bars = [...toAdd, ...store.bars];

      // Hard cap: never exceed bufferTarget (TV 5000-candle limit for free users)
      if (store.bars.length >= store.bufferTarget) {
        store.bars = store.bars.slice(store.bars.length - store.bufferTarget);
        store.reachedStart = true;
        console.log(`[Buffer] Hit 5000-bar cap`);
      }

      // Stop if oldest bar has reached the pair's launch date
      if (store.launchTimeSec && store.bars[0].time <= store.launchTimeSec) {
        store.reachedStart = true;
      }

      cacheSet(store.symbol, store.timeframe);
    }

    console.log(`[Buffer] Bybit REST +${toAdd.length} bars | total ${store.bars.length}/${store.bufferTarget}` +
      `${store.reachedStart ? ' — reached start' : ''}`);

    res.json({
      ok:           true,
      busy:         false,
      newBars:      toAdd,
      total:        store.bars.length,
      reachedStart: store.reachedStart,
      target:       store.bufferTarget
    });

  } catch (e) {
    console.error('[Buffer] Bybit REST error:', e.message);
    res.status(500).json({ ok: false, err: e.message });
  } finally {
    store.bufferBusy = false;
  }
});

/**
 * GET /api/sub-bars

 * Fetches sub-timeframe klines from Bybit REST for per-candle Volume Profile.
 * Query params:
 *   symbol   – e.g. BTCUSDT
 *   interval – Bybit interval: '1','5','15','60','240','D','W'
 *   start    – Unix seconds (inclusive)
 *   end      – Unix seconds (exclusive)
 */
app.get('/api/sub-bars', async (req, res) => {
  const { symbol, interval, start, end } = req.query;
  if (!symbol || !interval || !start || !end) {
    return res.status(400).json({ ok: false, err: 'Missing params: symbol, interval, start, end' });
  }
  try {
    const bars = await fetchKlinesFull(
      symbol,            // already has USDT suffix e.g. 'BTCUSDT'
      interval,
      Number(start) * 1000,
      Number(end)   * 1000
    );
    res.json({ ok: true, bars });
  } catch (e) {
    console.error('[sub-bars]', e.message);
    res.status(500).json({ ok: false, err: e.message });
  }
});

app.get('/api/tick', (req, res) => {
  res.setHeader('Content-Type',      'text/event-stream');
  res.setHeader('Cache-Control',     'no-cache');
  res.setHeader('Connection',        'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// SSE endpoint for live trades (Bubble Size indicator)
app.get('/api/trades', (req, res) => {
  res.setHeader('Content-Type',      'text/event-stream');
  res.setHeader('Cache-Control',     'no-cache');
  res.setHeader('Connection',        'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  sseTradeClients.add(res);
  req.on('close', () => sseTradeClients.delete(res));
});

// REST endpoint: get aggregated trade data for all candles
app.get('/api/trade-agg', (req, res) => {
  res.json({ ok: true, symbol: store.symbol, timeframe: store.timeframe, data: store.getTradeAgg() });
});

// REST endpoint: get Heavy Absorption detections
app.get('/api/heavy-absorption', (req, res) => {
  res.json({ ok: true, symbol: store.symbol, timeframe: store.timeframe, data: store.getHADetections() });
});

// ════════════════════════════════════════════════════════════
// Aggregated CVD Spot — Configuration & API Endpoints
// ════════════════════════════════════════════════════════════
let enabledCvdExchanges = ['bybit', 'binance', 'okx', 'mexc', 'bingx', 'bitstamp', 'bitunix', 'coinbase'];

app.get('/api/cvd', async (req, res) => {
  const sym = req.query.symbol || store.symbol || 'BTCUSDT';
  const tf  = req.query.interval || store.timeframe || '60';
  
  // Calculate window based on interval: fetch last 1000 bars
  const tfSec = TF_SEC[tf] || 3600;
  const limitBars = 1000;
  const endMs = Date.now();
  const startMs = endMs - (limitBars * tfSec * 1000);

  try {
    const result = await fetchAggregatedCVD(sym, tf, startMs, endMs, enabledCvdExchanges);
    res.json(result);
  } catch (e) {
    console.error('[CVD API Error]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/cvd/config', (req, res) => {
  const list = req.body.exchanges;
  if (!Array.isArray(list) || list.length === 0) {
    return res.status(400).json({ error: 'Exchanges list must be a non-empty array' });
  }
  // Enforce the rule of having at least one checked exchange
  enabledCvdExchanges = list;
  console.log('[CVD Config] Updated enabled exchanges:', enabledCvdExchanges);
  res.json({ ok: true, exchanges: enabledCvdExchanges });
});

// ════════════════════════════════════════════════════════════
// Economic Calendar — scrapes investing.com, caches in memory
//
// Refresh strategy (to avoid daily rate limits):
//   1. On startup — one initial fetch
//   2. Precise auto-sync — scheduleCalSync() inspects future event
//      timestamps and sets a setTimeout for each unique release time
//      + 60s buffer. When the timer fires, a refresh fetches the
//      newly-published "Actual" value. This means requests only
//      happen when there is genuinely new data to retrieve.
//   3. Manual refresh — user can click ↻ in the sidebar UI
// ════════════════════════════════════════════════════════════
const CAL_SYNC_BUFFER_MS   = 60 * 1000;              // wait 60s after release time before fetching
const CAL_SYNC_MAX_LEAD_MS = 20 * 24 * 60 * 60 * 1000; // don't schedule timers > 20 days ahead (setTimeout 32-bit limit ~24.8 days)

const calState = {
  events: [],
  range: null,
  fetchedAt: null,
  isFetching: false,
  lastError: null,
};

const calScheduledTimestamps = new Set(); // set of event release timestamps already scheduled

function calFreshEvents() {
  const cutoff = Date.now() - CAL_PAST_DAYS * 24 * 60 * 60 * 1000;
  return calState.events.filter(ev => !ev.timestamp || ev.timestamp >= cutoff);
}

// Schedule precision refreshes based on known future event release times
function scheduleCalSync() {
  const now = Date.now();

  // Housekeeping: remove past timestamps from the set
  for (const ts of calScheduledTimestamps) {
    if (ts <= now) calScheduledTimestamps.delete(ts);
  }

  // Collect unique future timestamps from events
  const futureTimestamps = new Set();
  for (const ev of calState.events) {
    if (ev.timestamp && ev.timestamp > now) futureTimestamps.add(ev.timestamp);
  }

  let count = 0;
  for (const ts of futureTimestamps) {
    if (calScheduledTimestamps.has(ts)) continue; // already scheduled
    const delay = ts - now + CAL_SYNC_BUFFER_MS;
    if (delay > CAL_SYNC_MAX_LEAD_MS) continue;   // too far ahead, will be scheduled on next refresh

    calScheduledTimestamps.add(ts);
    count++;
    setTimeout(() => {
      const d = new Date(ts);
      console.log(`[Calendar] Auto-sync: event release time (${d.toLocaleString()}) reached, refreshing...`);
      calRefresh();
    }, delay);
  }

  if (count > 0) {
    console.log(`[Calendar] Scheduled ${count} precision refresh(es) based on event release times`);
  }
}

async function calRefresh() {
  if (calState.isFetching) return;
  calState.isFetching = true;
  console.log('[Calendar] Fetching economic calendar...');
  try {
    const result = await fetchUSEconomicCalendar();
    calState.events = result.events;
    calState.range = result.range;
    calState.fetchedAt = result.fetchedAt;
    calState.lastError = null;
    console.log(`[Calendar] ✓ ${result.events.length} events loaded`);
  } catch (e) {
    calState.lastError = e.message;
    console.error('[Calendar] ✗ Fetch failed:', e.message);
  }
  calState.isFetching = false;
  scheduleCalSync(); // schedule next precision refreshes based on newly fetched event times
}

app.get('/api/calendar', (req, res) => {
  res.json({
    events: calFreshEvents(),
    range: calState.range,
    fetchedAt: calState.fetchedAt,
    isFetching: calState.isFetching,
    error: calState.lastError,
  });
});

app.post('/api/calendar/refresh', async (req, res) => {
  await calRefresh();
  res.json({
    events: calFreshEvents(),
    range: calState.range,
    fetchedAt: calState.fetchedAt,
    error: calState.lastError,
  });
});

// ════════════════════════════════════════════════════════════
// DRAWINGS API — persist drawing objects per symbol
// (Visible across all timeframes for the same symbol)
// ════════════════════════════════════════════════════════════
const drawingsStore = new Map(); // key: "SYMBOL", value: drawings[]
const DRAWINGS_FILE = path.join(__dirname, 'drawings.json');

// Load drawings from disk on startup
try {
  if (fs.existsSync(DRAWINGS_FILE)) {
    const raw = fs.readFileSync(DRAWINGS_FILE, 'utf-8');
    const obj = JSON.parse(raw);
    for (const [k, v] of Object.entries(obj)) {
      const symKey = k.includes(':') ? k.split(':')[0] : k;
      const existing = drawingsStore.get(symKey) || [];
      const idSet = new Set(existing.map(d => d.id));
      if (Array.isArray(v)) {
        for (const item of v) {
          if (!idSet.has(item.id)) existing.push(item);
        }
      }
      drawingsStore.set(symKey, existing);
    }
    console.log(`[Drawings] Loaded ${drawingsStore.size} symbols from disk`);
  }
} catch (e) {
  console.error('[Drawings] Load error:', e.message);
}

function saveDrawingsToDisk() {
  const obj = {};
  drawingsStore.forEach((v, k) => { obj[k] = v; });
  try {
    fs.writeFileSync(DRAWINGS_FILE, JSON.stringify(obj, null, 2), 'utf-8');
  } catch (e) {
    console.error('[Drawings] Save error:', e.message);
  }
}

app.get('/api/drawings', (req, res) => {
  const { symbol } = req.query;
  if (!symbol) return res.status(400).json({ ok: false, err: 'symbol required' });
  const list = drawingsStore.get(symbol) || [];
  res.json({ ok: true, drawings: list });
});

app.post('/api/drawings', (req, res) => {
  const { symbol, drawings } = req.body;
  if (!symbol || !Array.isArray(drawings)) return res.status(400).json({ ok: false, err: 'invalid body' });
  drawingsStore.set(symbol, drawings);
  saveDrawingsToDisk();
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════
// Start
// ════════════════════════════════════════════════════════════
app.listen(PORT, async () => {
  console.log('\n╔══════════════════════════════════════╗');
  console.log(`║  HF Terminal  →  http://localhost:${PORT}  ║`);
  console.log(`║  TradingView CDP  →  port ${CDP_PORT}         ║`);
  console.log('╚══════════════════════════════════════╝\n');

  // Fetch calendar once on startup, then auto-sync based on event release times
  calRefresh();

  const tvOk = await ensureTVRunning();
  if (tvOk) {
    runEngine('BTCUSDT', '60');
  } else {
    console.error('[Server] TradingView not available — please start it manually');
  }
});
