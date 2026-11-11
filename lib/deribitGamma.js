'use strict';
/**
 * Deribit options → Gamma Exposure (GEX) per strike + level kunci (gamma flip, call wall, put wall, max gamma).
 *
 * Sumber data: WebSocket JSON-RPC Deribit  wss://www.deribit.com/ws/api/v2
 *   - public/get_instruments               → strike, expiry, call/put tiap opsi
 *   - public/get_book_summary_by_currency  → open interest, mark IV, forward (underlying_price), index saat snapshot
 *   - channel deribit_price_index.<btc|eth>_usd → harga spot live (GEX dihitung ulang tiap ada pergerakan)
 *
 * Perhitungan (konvensi umum GEX, ala SqueezeMetrics/SpotGamma):
 *   gamma_BS  = φ(d1) / (F · σ · √T)          (Black-76, r = 0, σ = mark_iv)
 *   GEX$      = gamma_BS · OI · S² · 1%        (perubahan delta dalam $ untuk gerak spot 1%)
 *   call = +GEX, put = −GEX (asumsi dealer long call / short put)
 *   net(strike) = Σ call − Σ put,  dijumlahkan lintas expiry (bisa dibatasi maxDays)
 *
 * Hanya BTC dan ETH (opsi inverse Deribit).
 */
const WebSocket = require('ws');
const EventEmitter = require('events');

const WS_URL = 'wss://www.deribit.com/ws/api/v2';
const YEAR_MS = 365 * 24 * 3600 * 1000;
const T_MIN = 1 / (365 * 24); // clamp 1 jam: gamma ATM meledak mendekati expiry
const SUPPORTED = { BTC: 'btc_usd', ETH: 'eth_usd' };
const SYMBOL_BASE = { BTCUSDT: 'BTC', ETHUSDT: 'ETH' };
const SQRT_2PI = Math.sqrt(2 * Math.PI);

function baseOfSymbol(sym) { return SYMBOL_BASE[String(sym || '').toUpperCase()] || null; }

/** Gamma Black-76 (r=0): turunan kedua harga opsi terhadap forward F. */
function bsGamma(F, K, sigma, T) {
  if (!(F > 0 && K > 0 && sigma > 0 && T > 0)) return 0;
  const sq = sigma * Math.sqrt(T);
  const d1 = (Math.log(F / K) + 0.5 * sigma * sigma * T) / sq;
  return Math.exp(-0.5 * d1 * d1) / (SQRT_2PI * F * sq);
}

/** Titik spot di mana total net GEX berganti tanda (zero gamma), yang terdekat dengan spot. */
function findFlip(A, S) {
  const N = A.K.length;
  if (!N) return null;
  const STEPS = 100, LO = 0.6, HI = 1.4;
  const xs = new Float64Array(STEPS + 1), vs = new Float64Array(STEPS + 1);
  for (let g = 0; g <= STEPS; g++) {
    const m = LO + ((HI - LO) * g) / STEPS;
    let tot = 0;
    for (let i = 0; i < N; i++) tot += A.sign[i] * bsGamma(A.F[i] * m, A.K[i], A.sig[i], A.T[i]) * A.units[i];
    const Sx = S * m;
    xs[g] = Sx; vs[g] = tot * Sx * Sx * 0.01;
  }
  let best = null, bestD = Infinity;
  for (let g = 0; g < STEPS; g++) {
    const a = vs[g], b = vs[g + 1];
    if (a === 0 || (a < 0) !== (b < 0)) {
      const t = a === b ? 0 : a / (a - b);
      const x = xs[g] + (xs[g + 1] - xs[g]) * t;
      const d = Math.abs(x - S);
      if (d < bestD) { bestD = d; best = x; }
    }
  }
  return best;
}

/**
 * rows: [{ strike, expiry(ms), isCall, units(OI dalam koin), iv(σ pecahan), F(forward), idx(index saat snapshot) }]
 * S: spot sekarang.  opts: { maxDays (0 = semua), flip (hitung zero-gamma) }
 */
function computeGex(rows, S, now, opts) {
  opts = opts || {};
  const maxDays = opts.maxDays || 0;
  const A = { K: [], F: [], sig: [], T: [], units: [], sign: [] };
  const byStrike = new Map();
  for (const r of rows) {
    let T = (r.expiry - now) / YEAR_MS;
    if (!(T > 0)) continue;
    if (maxDays > 0 && T * 365 > maxDays) continue;
    if (T < T_MIN) T = T_MIN;
    const Fi = r.F * (S / r.idx); // forward ikut bergeser sejak snapshot
    const sign = r.isCall ? 1 : -1;
    A.K.push(r.strike); A.F.push(Fi); A.sig.push(r.iv); A.T.push(T); A.units.push(r.units); A.sign.push(sign);
    const gex = bsGamma(Fi, r.strike, r.iv, T) * r.units * S * S * 0.01;
    let s = byStrike.get(r.strike);
    if (!s) { s = { strike: r.strike, call: 0, put: 0, net: 0 }; byStrike.set(r.strike, s); }
    if (r.isCall) s.call += gex; else s.put -= gex;
  }
  const strikes = [...byStrike.values()].sort((a, b) => a.strike - b.strike);
  let callTotal = 0, putTotal = 0;
  for (const s of strikes) { s.net = s.call + s.put; callTotal += s.call; putTotal += s.put; }

  // Level kunci
  let callWall = null, putWall = null, maxGamma = null;
  const pickMax = (arr, f) => arr.reduce((best, s) => (best === null || f(s) > f(best) ? s : best), null);
  const above = strikes.filter(s => s.strike >= S), below = strikes.filter(s => s.strike <= S);
  const cw = pickMax(above.length ? above : strikes, s => s.call);
  const pw = pickMax(below.length ? below : strikes, s => -s.put);
  const mg = pickMax(strikes, s => Math.abs(s.net));
  if (cw && cw.call > 0) callWall = { strike: cw.strike, value: cw.call };
  if (pw && pw.put < 0) putWall = { strike: pw.strike, value: pw.put };
  if (mg) maxGamma = { strike: mg.strike, value: mg.net };

  return {
    strikes, n: A.K.length,
    levels: {
      total: callTotal + putTotal, callTotal, putTotal,
      callWall, putWall, maxGamma,
      flip: opts.flip ? findFlip(A, S) : null
    }
  };
}

class DeribitGamma extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this._connecting = null;
    this.nextId = 1;
    this.pending = new Map();
    this.opts = { maxDays: 0 };
    this.base = null;
    this.meta = new Map();
    this.metaBase = null; this.metaAt = 0;
    this.rows = [];
    this.spot = 0;
    this.summaryAt = 0;
    this.snapshot = null;
    this.flip = null; this.flipAt = 0;
    this._timers = {};
    this._gen = 0;
    this._retryDelay = 3000;
    this._recomputeTimer = null;
    this._lastRecompute = 0;
  }

  // ── koneksi ──
  _connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this._connecting) return this._connecting;
    this._connecting = new Promise((resolve, reject) => {
      const ws = new WebSocket(WS_URL, { handshakeTimeout: 15000 });
      this.ws = ws;
      ws.on('open', async () => {
        this._retryDelay = 3000;
        try { await this._rpc('public/set_heartbeat', { interval: 30 }); } catch (e) {}
        this._connecting = null;
        resolve();
      });
      ws.on('message', raw => this._onMessage(raw));
      ws.on('error', e => {
        this.emit('status', { state: 'error', msg: e.message });
        if (this._connecting) { this._connecting = null; reject(e); }
      });
      ws.on('close', () => this._onClose(ws));
    });
    return this._connecting;
  }

  _rpc(method, params) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return reject(new Error('Deribit WS not connected'));
      const id = this.nextId++;
      const t = setTimeout(() => { if (this.pending.delete(id)) reject(new Error('Deribit timeout: ' + method)); }, 20000);
      this.pending.set(id, { resolve: v => { clearTimeout(t); resolve(v); }, reject: e => { clearTimeout(t); reject(e); } });
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  _onMessage(raw) {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (m.id != null && this.pending.has(m.id)) {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message || JSON.stringify(m.error))); else p.resolve(m.result);
      return;
    }
    if (m.method === 'heartbeat') {
      if (m.params && m.params.type === 'test_request') this._rpc('public/test', {}).catch(() => {});
      return;
    }
    if (m.method === 'subscription' && m.params && /^deribit_price_index\./.test(m.params.channel || '')) {
      const p = m.params.data && m.params.data.price;
      if (p > 0) { this.spot = p; this._scheduleRecompute(); }
    }
  }

  _onClose(ws) {
    if (this.ws !== ws) return;
    this.ws = null;
    for (const [, p] of this.pending) p.reject(new Error('Deribit WS closed'));
    this.pending.clear();
    if (this.base) {
      this.emit('status', { state: 'reconnecting', msg: 'Deribit disconnected \u2014 reconnecting\u2026' });
      this._scheduleResume();
    }
  }

  _scheduleResume() {
    if (this._timers.resume) return;
    const d = this._retryDelay;
    this._retryDelay = Math.min(30000, Math.round(this._retryDelay * 1.7));
    this._timers.resume = setTimeout(() => {
      this._timers.resume = null;
      if (this.base) this._begin(this.base).catch(() => {});
    }, d);
  }

  // ── data ──
  async _loadMeta(base) {
    if (this.metaBase === base && Date.now() - this.metaAt < 10 * 60 * 1000 && this.meta.size) return;
    const list = await this._rpc('public/get_instruments', { currency: base, kind: 'option', expired: false });
    const meta = new Map();
    for (const i of list || []) {
      if (!i.strike || !i.expiration_timestamp) continue;
      meta.set(i.instrument_name, { strike: i.strike, expiry: i.expiration_timestamp, isCall: i.option_type === 'call' });
    }
    this.meta = meta; this.metaBase = base; this.metaAt = Date.now();
  }

  async _loadSummary(base) {
    const list = await this._rpc('public/get_book_summary_by_currency', { currency: base, kind: 'option' });
    const rows = [], idxs = [];
    for (const s of list || []) {
      const m = this.meta.get(s.instrument_name);
      if (!m) continue;
      const oi = Number(s.open_interest), iv = Number(s.mark_iv), F = Number(s.underlying_price), idx = Number(s.estimated_delivery_price);
      if (!(oi > 0 && iv > 0 && F > 0 && idx > 0)) continue;
      rows.push({ strike: m.strike, expiry: m.expiry, isCall: m.isCall, units: oi, iv: iv / 100, F, idx });
      idxs.push(idx);
    }
    if (!rows.length) throw new Error('Deribit: tidak ada data opsi untuk ' + base);
    this.rows = rows;
    this.summaryAt = Date.now();
    if (!(this.spot > 0)) { idxs.sort((a, b) => a - b); this.spot = idxs[Math.floor(idxs.length / 2)]; }
  }

  _scheduleRecompute() {
    if (this._recomputeTimer || !this.base || !this.rows.length) return;
    const wait = Math.max(0, 1000 - (Date.now() - this._lastRecompute));
    this._recomputeTimer = setTimeout(() => { this._recomputeTimer = null; this._recompute(false); }, wait);
  }

  _recompute(forceFlip) {
    if (!this.base || !(this.spot > 0) || !this.rows.length) return;
    const now = Date.now();
    this._lastRecompute = now;
    const needFlip = forceFlip || now - this.flipAt > 5000;
    const res = computeGex(this.rows, this.spot, now, { maxDays: this.opts.maxDays, flip: needFlip });
    if (needFlip) { this.flip = res.levels.flip; this.flipAt = now; } else res.levels.flip = this.flip;
    this.snapshot = {
      base: this.base, spot: this.spot, updatedAt: this.summaryAt, computedAt: now,
      nInstruments: res.n, maxDays: this.opts.maxDays, strikes: res.strikes, levels: res.levels
    };
    this.emit('update', this.snapshot);
  }

  _clearTimers() {
    for (const k of Object.keys(this._timers)) { clearInterval(this._timers[k]); clearTimeout(this._timers[k]); }
    this._timers = {};
    if (this._recomputeTimer) { clearTimeout(this._recomputeTimer); this._recomputeTimer = null; }
  }

  async _begin(base) {
    const gen = ++this._gen;
    this._clearTimers();
    const prev = this.base;
    if (prev && prev !== base && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this._rpc('public/unsubscribe', { channels: ['deribit_price_index.' + SUPPORTED[prev]] }).catch(() => {});
    }
    if (prev !== base) { this.snapshot = null; this.rows = []; this.spot = 0; this.flip = null; this.flipAt = 0; }
    this.base = base;
    try {
      await this._connect();
      await this._loadMeta(base);
      await this._loadSummary(base);
      if (gen !== this._gen) return;
      await this._rpc('public/subscribe', { channels: ['deribit_price_index.' + SUPPORTED[base]] });
      if (gen !== this._gen) return;
      this._recompute(true);
      this.emit('status', { state: 'ok' });
      // refresh open interest / IV tiap 60 detik
      this._timers.summary = setInterval(async () => {
        if (gen !== this._gen) return;
        try { await this._loadMeta(base); await this._loadSummary(base); this._recompute(true); }
        catch (e) { this.emit('status', { state: 'error', msg: e.message }); }
      }, 60000);
    } catch (e) {
      if (gen !== this._gen) return;
      this.emit('status', { state: 'error', msg: e.message });
      this._scheduleResume();
      throw e;
    }
  }

  // ── API publik ──
  /** Mulai (atau ganti) langganan untuk pair chart. Hanya BTCUSDT / ETHUSDT. */
  async start(symbol) {
    const base = baseOfSymbol(symbol);
    if (!base) return { ok: false, err: 'Gamma Level hanya tersedia untuk BTC dan ETH' };
    if (this.base === base && this.snapshot) return { ok: true, base, data: this.snapshot };
    try {
      await this._begin(base);
      return { ok: true, base, data: this.snapshot };
    } catch (e) {
      return { ok: false, err: e.message };
    }
  }

  stop() {
    this._gen++;
    this._clearTimers();
    this.base = null; this.snapshot = null; this.rows = []; this.spot = 0; this.flip = null; this.flipAt = 0;
    const ws = this.ws;
    this.ws = null; this._connecting = null;
    if (ws) { try { ws.removeAllListeners('close'); ws.close(); } catch (e) {} }
    for (const [, p] of this.pending) p.reject(new Error('stopped'));
    this.pending.clear();
  }

  setOptions(o) {
    Object.assign(this.opts, o || {});
    if (this.base && this.rows.length) this._recompute(true);
  }

  getSnapshot() { return this.snapshot; }
}

module.exports = { DeribitGamma, computeGex, bsGamma, findFlip, baseOfSymbol, SUPPORTED };
