'use strict';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Timeframe maps — exactly M1, M5, M15, M30, H1, H4, D1, W1 ──
const TF_SEC = { '1':60,'5':300,'15':900,'30':1800,'60':3600,'240':14400,'D':86400,'W':604800 };
const TF_TV  = { '1':'1','5':'5','15':'15','30':'30','60':'60','240':'240','D':'1D','W':'1W' };
const TF_DOM = { '1':'1m','5':'5m','15':'15m','30':'30m','60':'1h','240':'4h','D':'1d','W':'1w' };

// aria-label regexes for the DOM-click reinforcement in setTimeframe().
// TradingView's toolbar buttons carry stable, semantic aria-labels like
// "15 minutes" / "1 hour" / "4 hours" / "1 day" — far more resilient
// across app updates than hashed CSS module class names.
const TF_ARIA = {
  '1':   /^1 minute\b/i,
  '5':   /^5 minutes?\b/i,
  '15':  /^15 minutes?\b/i,
  '30':  /^30 minutes?\b/i,
  '60':  /^1 hour\b/i,
  '240': /^4 hours?\b/i,
  'D':   /^1 day\b/i,
  'W':   /^1 week\b/i
};

// ── JS snippets (run inside TradingView Desktop via CDP) ──

const BARS_JS = `
(() => {
  try {
    const mb = window._exposed_chartWidgetCollection?.activeChartWidget?._value
      ?._paneWidgets?._value?.[0]?._state?.m_mainDataSource?._seriesSource?._data?.m_bars;
    if (!mb || typeof mb.size !== 'function' || mb.size() === 0) return null;
    const now = Date.now() / 1000;
    const R   = n => (n == null || isNaN(n)) ? 0 : parseFloat(n.toPrecision(8));
    const out = [];
    const fi  = mb.firstIndex(), li = mb.lastIndex();
    for (let i = fi; i <= li; i++) {
      const v = mb.valueAt(i);
      if (!v || !v[0] || isNaN(v[4]) || v[0] > now + 86400) continue;
      out.push({ time:v[0], open:R(v[1]), high:R(v[2]), low:R(v[3]), close:R(v[4]), volume:R(v[5]||0) });
    }
    out.sort((a, b) => a.time - b.time);
    return JSON.stringify({ bars: out, sz: mb.size() });
  } catch(e) { return JSON.stringify({ err: e.message }); }
})()`;

const STATE_JS = `
(() => {
  try {
    const mb = window._exposed_chartWidgetCollection?.activeChartWidget?._value
      ?._paneWidgets?._value?.[0]?._state?.m_mainDataSource?._seriesSource?._data?.m_bars;
    if (!mb || typeof mb.size !== 'function' || mb.size() === 0) return JSON.stringify({ size:0, oldest:null });
    const fi = mb.firstIndex();
    const v0 = mb.valueAt(fi);
    return JSON.stringify({ size: mb.size(), oldest: v0?.[0] ?? null });
  } catch { return JSON.stringify({ size:0, oldest:null }); }
})()`;

const MBAR_IV_JS = `
(() => {
  try {
    const mb = window._exposed_chartWidgetCollection?.activeChartWidget?._value
      ?._paneWidgets?._value?.[0]?._state?.m_mainDataSource?._seriesSource?._data?.m_bars;
    if (!mb || typeof mb.size !== 'function' || mb.size() < 2) return null;
    const fi = mb.firstIndex();
    const v0 = mb.valueAt(fi), v1 = mb.valueAt(fi + 1);
    return (v0 && v1) ? Math.round(v1[0] - v0[0]) : null;
  } catch { return null; }
})()`;

const CANVAS_RECT_JS = `
(() => {
  try {
    const cs = [...document.querySelectorAll('canvas')].filter(c => {
      const r = c.getBoundingClientRect();
      return r.width > 200 && r.height > 200;
    });
    const r = cs[0]?.getBoundingClientRect();
    if (!r) return null;
    return JSON.stringify({ x:r.x, y:r.y, w:r.width, h:r.height });
  } catch { return null; }
})()`;

// ─────────────────────────────────────────────────────────
class TVSync {
  constructor(cdp) {
    this.cdp = cdp;
  }

  // ── Set symbol (always perpetual .P!) ─────────────────
  async setSymbol(symbol) {
    const tvSym = `BYBIT:${symbol}.P`;
    console.log(`[TV] Setting symbol → ${tvSym}`);

    const r = await this.cdp.eval(`
      (() => {
        const tvSym = '${tvSym}';
        const w = window._exposed_chartWidgetCollection?.activeChartWidget?._value;
        if (!w) return 'no_widget';
        let proto = Object.getPrototypeOf(w);
        while (proto && proto !== Object.prototype) {
          if (Object.getOwnPropertyNames(proto).includes('setSymbol')) {
            proto.setSymbol.call(w, tvSym, null, () => {});
            return 'ok';
          }
          proto = Object.getPrototypeOf(proto);
        }
        return 'no_method';
      })()`);

    if (r !== 'ok') {
      const clicked = await this.cdp.eval(`
        (() => {
          const sels = ['[class*="symbol-info"] button','[class*="tv-symbol-header"] [class*="title"]','[class*="symbolLabel"]'];
          for (const s of sels) { const el = document.querySelector(s); if (el) { el.click(); return 'ok'; } }
          return 'no';
        })()`);
      if (clicked === 'no') await this.cdp.key('/');
      await sleep(700);
      await this.cdp.key('a', true); await sleep(100);
      await this.cdp.type(tvSym);
      await sleep(500);
      await this.cdp.key('Return');
    }

    await this._waitForBars(tvSym, 12000);
    console.log(`[TV] Symbol ${tvSym} ready`);
  }

  // ── Set timeframe ──────────────────────────────────────
  /**
   * IMPORTANT — do not call `model.setInterval(...)` directly!
   * That name is misleading: on the CHART MODEL object, `setInterval` is
   * just the model's wrapped copy of the global window.setInterval TIMER
   * function (`setInterval(e,t){ const i=setInterval(e,t); this._modelIntervals.push(i); return i }`),
   * completely unrelated to the candle timeframe. Calling it with a
   * resolution string like '15' and no delay silently creates a runaway
   * leaked timer re-evaluating that string as code — it never changes
   * anything on the chart. This was discovered via direct prototype
   * inspection after TradingView Desktop's UI/CSS classes changed and
   * timeframe switching stopped working entirely.
   *
   * The REAL setter lives one level down, on the main series object:
   *   model._mainSeries.setInterval(e) { this.setSymbolParams({interval:e}) }
   * — confirmed via direct testing to correctly update model.interval()
   * and repopulate m_bars with the new resolution's data.
   */
  async setTimeframe(tf) {
    console.log(`[TV] Setting timeframe → ${tf}`);
    const tvTF   = TF_TV[tf]  || tf;
    const expSec = TF_SEC[tf];

    await this.cdp.eval(`
      (() => {
        const model = window._exposed_chartWidgetCollection?.activeChartWidget?._value
          ?._paneWidgets?._value?.[0]?._state?.m_mainDataSource?._model;
        if (typeof model?._mainSeries?.setInterval === 'function') {
          model._mainSeries.setInterval('${tvTF}');
        }
      })()`);

    // Best-effort DOM reinforcement — matched by aria-label (stable, semantic)
    // rather than hashed CSS module class names (which change between
    // TradingView Desktop builds and silently break class-based selectors).
    // Purely additive: if the button isn't currently visible (e.g. 1m/30m
    // can be tucked into an overflow menu depending on window width), this
    // just no-ops and the JS API call above still does the real work.
    await this.cdp.eval(`
      (() => {
        const re = ${TF_ARIA[tf] ? TF_ARIA[tf].toString() : 'null'};
        if (!re) return;
        const btn = [...document.querySelectorAll('button[aria-label]')]
          .find(b => re.test(b.getAttribute('aria-label') || ''));
        if (btn) btn.click();
      })()`);

    if (!expSec) { await sleep(3000); return; }

    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      await sleep(450);
      const iv = await this.cdp.eval(MBAR_IV_JS);
      if (!iv) continue;
      const ok = expSec >= 86400 ? iv >= 14400 : Math.abs(iv - expSec) <= 60;
      if (ok) { console.log(`[TV] TF ${tf} confirmed (iv=${iv}s)`); break; }
    }
    await sleep(300);
  }

  // ── Get the currently active symbol in TradingView ─────
  async getCurrentSymbol() {
    const raw = await this.cdp.eval(`
      (() => {
        try {
          const w = window._exposed_chartWidgetCollection?.activeChartWidget?._value;
          if (!w) return null;
          const src = w._paneWidgets?._value?.[0]?._state?.m_mainDataSource?._seriesSource;
          if (!src) return null;
          const symInfo = src._symbolInfo?._value || src._symbolInfo;
          if (symInfo && symInfo.name) return symInfo.name;
          if (typeof src.symbol === 'function') return src.symbol();
          if (src._symbol) return src._symbol;
          return null;
        } catch { return null; }
      })()`, true);
    return raw || null;
  }

  // ── Set symbol with single retry on failure ────────────
  async verifyAndSetSymbol(symbol) {
    // Attempt 1 — setSymbol already verifies via _waitForBars internally
    const ok1 = await this.setSymbol(symbol);
    if (ok1) return true;

    // _waitForBars timed out — retry once
    console.warn(`[TV] Symbol set failed, retrying once...`);
    await sleep(500);
    const ok2 = await this.setSymbol(symbol);
    if (!ok2) console.error(`[TV] Symbol set failed after retry`);
    return ok2;
  }

  // ── Initial bars — FAST, no scrolling ──────────────────
  async getInitialBars() {
    const raw = await this.cdp.eval(BARS_JS, true);
    if (!raw) return [];
    try {
      const data = JSON.parse(raw);
      return data.bars ? data.bars.sort((a, b) => a.time - b.time) : [];
    } catch { return []; }
  }

  computeTarget(tf, launchMs, maxTarget = 5000) {
    if (!launchMs) return maxTarget;
    const tfSec  = TF_SEC[tf] ?? 3600;
    const ageSec = Date.now() / 1000 - launchMs / 1000;
    return Math.max(0, Math.min(maxTarget, Math.floor(ageSec / tfSec)));
  }

  // ── Enable TV "Auto (fits data to screen)" mode ────────
  async enableAutoFit() {
    await this.cdp.eval(`
      (() => {
        try {
          const w = window._exposed_chartWidgetCollection?.activeChartWidget?._value;
          if (w?.executeActionById) { w.executeActionById('chartAutofit'); return; }
        } catch(e) {}
        try {
          const canvas = document.querySelector('canvas');
          if (canvas) {
            canvas.focus();
            canvas.dispatchEvent(new KeyboardEvent('keydown', { key:'a', keyCode:65, bubbles:true }));
          }
        } catch(e) {}
      })()`);
    await sleep(500);
  }

  // ── Scroll TV to a specific Unix timestamp (seconds) ───
  /**
   * Replicates what the MCP tool `chart_scroll_to_date` does:
   * centers TradingView's chart viewport on the target date so that
   * bars around that date are loaded from TV's data server.
   *
   * Tries multiple internal TV APIs in priority order — the time-scale
   * scroll APIs are the same ones TV's own "Go to date" feature uses.
   */
  async scrollToDate(targetSec, tfSec) {
    const barsBack = 80; // show 80 bars to the left of target

    const r = await this.cdp.eval(`
      (() => {
        try {
          const w = window._exposed_chartWidgetCollection?.activeChartWidget?._value;
          if (!w) return 'no_widget';

          // ── Strategy 1: timeScale().scrollToPosition() ─────────────────
          // This is what TV's own date-navigation uses internally.
          const model = w._paneWidgets?._value?.[0]?._state
            ?.m_mainDataSource?._model;
          const ts = typeof model?.timeScale === 'function'
            ? model.timeScale()
            : model?._timeScale;
          if (ts) {
            // scrollToPosition(bars, animated) — negative = scroll left
            if (typeof ts.scrollToPosition === 'function') {
              ts.scrollToPosition(-${barsBack}, false);
            }
            // setVisibleRange as a complement (wider window than drag gives)
            if (typeof ts.setVisibleRange === 'function') {
              const from = ${targetSec} - ${tfSec} * 160;
              const to   = ${targetSec} + ${tfSec} * 20;
              ts.setVisibleRange({ from, to });
            }
            return 'ts_ok';
          }

          // ── Strategy 2: widget-level setVisibleRange ────────────────────
          if (typeof w.setVisibleRange === 'function') {
            w.setVisibleRange({
              from: ${targetSec} - ${tfSec} * 160,
              to:   ${targetSec} + ${tfSec} * 20
            });
            return 'widget_ok';
          }

          return 'no_method';
        } catch(e) { return 'err:' + e.message; }
      })()`, true);

    console.log(`[TV scroll] scrollToDate(${new Date(targetSec * 1000).toISOString().slice(0,10)}) → ${r}`);
    await sleep(1500); // wait for TV to request and receive historical data
  }

  // ── On-demand buffer: jump to oldest known bar, extract new bars ──
  /**
   * @param tf           – current timeframe string ('1','5','60','D'…)
   * @param launchTimeSec – pair launch timestamp (seconds), or null
   * @param oldestKnownSec – frontend's oldest loaded bar time (seconds);
   *                         we jump TV directly to this date instead of
   *                         hunting from the current viewport position
   * @param maxIterations  – max scroll+extract cycles
   */
  async bufferChunk(tf, launchTimeSec, oldestKnownSec = null, maxIterations = 4) {
    const POLL_STEP  = 600;
    const POLL_MAX   = 12;
    const DRAG_STEPS = 24;
    const tfSec      = TF_SEC[tf] ?? 3600;

    const rectRaw = await this.cdp.eval(CANVAS_RECT_JS, true);
    const rect    = rectRaw ? JSON.parse(rectRaw) : null;
    const xLeft   = rect ? rect.x + 30          : 150;
    const xRight  = rect ? rect.x + rect.w - 30 : 800;
    const yMid    = rect ? rect.y + rect.h / 2  : 380;

    const barsMap = new Map();
    await this._addExtracted(barsMap);

    // Step 1: enable auto-fit so TV loads bars across a wide range
    await this.enableAutoFit();

    // Step 2: if frontend told us the oldest loaded bar, jump TV directly there.
    // This mirrors what `chart_scroll_to_date` MCP does — navigate to the
    // left boundary of known data so TV fetches the page before it.
    const jumpTarget = oldestKnownSec ?? (await this._getState()).oldest;
    if (jumpTarget) {
      await this.scrollToDate(jumpTarget, tfSec);
    }

    let reachedLaunch = false, reachedNoMoreData = false, fails = 0;

    for (let iter = 0; iter < maxIterations; iter++) {
      const before = await this._getState();
      if (!before.oldest) {
        fails++; if (fails >= 2) { reachedNoMoreData = true; break; }
        await sleep(500); continue;
      }

      if (launchTimeSec && before.oldest <= launchTimeSec) {
        reachedLaunch = true;
        console.log(`[Buffer] Reached pair launch date`);
        break;
      }

      // Jump to current oldest to trigger loading the page before it
      await this.scrollToDate(before.oldest, tfSec);

      let progressed = false;
      for (let p = 0; p < POLL_MAX; p++) {
        await sleep(POLL_STEP);
        const s = await this._getState();
        if (s.oldest && s.oldest < before.oldest) { progressed = true; break; }
      }

      // Fallback: physical mouse drag if the date-jump didn't trigger a data load
      if (!progressed) {
        console.log(`[Buffer] iter ${iter + 1}: scroll-to-date no progress → trying drag`);
        await this.cdp.dragPan(xLeft, xRight, yMid, DRAG_STEPS);
        for (let p = 0; p < POLL_MAX; p++) {
          await sleep(POLL_STEP);
          const s = await this._getState();
          if (s.oldest && s.oldest < before.oldest) { progressed = true; break; }
        }
      }

      await this._addExtracted(barsMap);

      if (progressed) {
        fails = 0;
        await this.enableAutoFit(); // re-fit after each successful page load
        const after = await this._getState();
        console.log(`[Buffer] iter ${iter + 1}/${maxIterations} | +bars → oldest: ${new Date(after.oldest * 1000).toISOString().slice(0, 10)}`);
      } else {
        fails++;
        console.log(`[Buffer] iter ${iter + 1}/${maxIterations} | no progress (${fails}/2)`);
        if (fails >= 2) { reachedNoMoreData = true; break; }
      }
    }

    // Final sweep — capture any bars loaded in the last iteration
    await this._addExtracted(barsMap);

    const sorted = Array.from(barsMap.values()).sort((a, b) => a.time - b.time);
    return { bars: sorted, reachedLaunch, reachedNoMoreData };
  }


  // ── Pair list from TradingView symbol search ──────────

  async fetchPairs() {
    if (!this.cdp.connected) await this.cdp.connect();
    let raw;
    try {
      raw = await this.cdp.eval(`
        new Promise(resolve => {
          fetch('https://symbol-search.tradingview.com/symbol_search/v3/?text=&exchange=BYBIT&lang=en&domain=production&limit=5000')
            .then(r => r.json())
            .then(d => resolve(JSON.stringify(d)))
            .catch(e => resolve(JSON.stringify({ _err: e.message })));
        })`, true);
    } catch { raw = '{}'; }

    let parsed; try { parsed = JSON.parse(raw); } catch { parsed = {}; }
    if (parsed._err || !Array.isArray(parsed?.symbols)) return this._bybitFallback();

    const result = parsed.symbols
      .filter(s => (s.symbol || '').endsWith('.P') && (s.symbol || '').includes('USDT'))
      .map(s => {
        const sym  = (s.symbol || '').replace('.P', '');
        const base = s.base_currency_code || sym.replace('USDT', '');
        return { symbol: sym, base, tvSym: sym + '.P', desc: s.description || '' };
      })
      .filter((s, i, a) => a.findIndex(x => x.symbol === s.symbol) === i)
      .sort((a, b) => a.symbol.localeCompare(b.symbol));

    console.log(`[TV] ${result.length} perpetual pairs from TradingView`);
    return result.length ? result : this._bybitFallback();
  }

  // ── Internal helpers ───────────────────────────────────
  async _getState() {
    const raw = await this.cdp.eval(STATE_JS, true);
    try { return JSON.parse(raw); } catch { return { size: 0, oldest: null }; }
  }

  async _addExtracted(barsMap) {
    const raw = await this.cdp.eval(BARS_JS, true);
    if (!raw) return 0;
    try {
      const data = JSON.parse(raw);
      if (data.bars) { data.bars.forEach(b => barsMap.set(b.time, b)); return data.bars.length; }
    } catch {}
    return 0;
  }

  async _waitForBars(targetSymbol, timeoutMs = 12000) {
    const cleanSym = targetSymbol.replace(/^(BYBIT:)?/i, '').replace(/\.P$/i, '').toUpperCase();
    const deadline = Date.now() + timeoutMs;
    let checks = 0;
    while (Date.now() < deadline) {
      await sleep(400);
      checks++;
      const curSymRaw = await this.cdp.eval(`
        (() => {
          try {
            const w = window._exposed_chartWidgetCollection?.activeChartWidget?._value;
            if (!w) return null;
            const src = w._paneWidgets?._value?.[0]?._state?.m_mainDataSource?._seriesSource;
            if (!src) return null;
            const symInfo = src._symbolInfo?._value || src._symbolInfo;
            if (symInfo && symInfo.name) return symInfo.name;
            if (typeof src.symbol === 'function') return src.symbol();
            if (src._symbol) return src._symbol;
            return null;
          } catch { return null; }
        })()`, true);

      if (!curSymRaw) continue;
      const curClean = curSymRaw.replace(/^(BYBIT:)?/i, '').replace(/\.P$/i, '').toUpperCase();
      if (curClean === cleanSym) {
        const s = await this._getState();
        if (s.size > 0) {
          return true;
        } else {
          // Symbol name is correct but data is not loaded yet (size is 0).
          // Try to wake up TradingView by triggering chartAutofit or canvas focus.
          if (checks % 3 === 0) {
            console.log(`[TV] Symbol matched cleanSym (${curClean}) but size is 0, triggering autofit to wake up loader`);
            await this.enableAutoFit();
          }
        }
      }
    }
    return false;
  }

  _bybitFallback() {
    return ['BTC','ETH','SOL','XRP','BNB','DOGE','ADA','AVAX','LINK','DOT',
            'MATIC','LTC','UNI','ATOM','NEAR','OP','ARB','APT','SUI','TON',
            'INJ','WIF','PEPE','TRX','JUP','BONK','STRK','SEI','PYTH','W']
      .map(b => ({ symbol: b + 'USDT', base: b, tvSym: b + 'USDT.P', desc: '' }));
  }
}

module.exports = { TVSync, TF_SEC, TF_TV, TF_DOM };
