'use strict';
/**
 * Order-book liquidity recorder (BINANCE saja) untuk Liquidity Heatmap.
 *
 *  • Sumber  : Binance SPOT WAJIB diutamakan; perpetual (USD-M Futures) hanya fallback bila spot tidak ada / gagal 3x (mis. XAUUSDT, XAGUSDT, saham/TradFi) → Binance USDⓈ-M FUTURES.
 *               Pemilihan market + faktor skala harga ada di lib/binanceSymbols.js.
 *  • Book    : WebSocket diff depth (100ms) + snapshot REST → local order book
 *               (spot: snapshot 5000 level; futures: snapshot 1000 level — batas API Binance; level lebih dalam terisi lewat diff)
 *  • Tiap 1 dtk book di-sample, dijumlah per "bin harga" (notional USD), lalu dirangkum per MENIT: max / sum(→ avg) / last per bin.
 *    Rangkuman per menit ini diagregasi di chart per candle TF aktif (Peak = max dalam candle, Average, Close):
 *    liquidity yang hanya muncul sebentar (spoofing) terlihat di TF besar tetapi "hilang" saat TF dikecilkan.
 *  • History disimpan ke data/liquidity/<SYMBOL>.bin.gz supaya tidak hilang saat aplikasi ditutup.
 *
 * Catatan: tidak ada history order book publik → heatmap terbentuk dari saat perekaman dimulai.
 */
const WebSocket = require('ws');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { getJson, resolveCandidates, fetchBybitLast } = require('./binanceSymbols');

const SAMPLE_MS = 1000;
const MAX_MINUTES = 2880;          // 2 hari
const PAD_BINS = 24;
const PRICE_TOL = 0.08;           // sanity check: harga book Binance (× skala) harus dalam ±8% dari harga Bybit
const MAX_FAILS = 3;               // 3x permintaan/koneksi gagal berturut-turut (sebelum pernah sinkron) = kandidat dianggap tidak punya data
const REPROBE_SPOT_MS = 10 * 60 * 1000;   // sedang di fallback perpetual karena spot gagal → cek spot lagi tiap 10 menit (spot diutamakan)
const RETRY_NODATA_MS = 5 * 60 * 1000;    // semua kandidat gagal 3x = "tidak ada data" → coba ulang penuh tiap 5 menit
const FILE_MAGIC = 'LQH2';         // LQH2 = satu sumber (Binance); LQH1 (format lama Binance+OKX) diabaikan
const DATA_DIR = path.join(__dirname, '..', 'data', 'liquidity');

const SPOT_WS = 'wss://stream.binance.com:9443/stream';
// Futures: endpoint baru /public/ dulu, endpoint lama /stream sebagai cadangan (dirotasi bila koneksi gagal dibuka)
const FUT_WS = ['wss://fstream.binance.com/public/stream', 'wss://fstream.binance.com/stream'];
const SNAPSHOT_URL = {
  spot: sym => `https://api.binance.com/api/v3/depth?symbol=${sym}&limit=5000`,
  fut: sym => `https://fapi.binance.com/fapi/v1/depth?symbol=${sym}&limit=1000`   // futures: limit maksimum 1000 (5000 → HTTP 400 -1130)
};

function niceStep(x) {
  const e = Math.pow(10, Math.floor(Math.log10(x)));
  const m = x / e;
  const f = m >= 5 ? 5 : m >= 2.5 ? 2.5 : m >= 2 ? 2 : 1;
  return f * e;
}

// ── Binance local order book (SPOT atau USDⓈ-M FUTURES; WebSocket diff depth + snapshot REST) ──
class BinanceBook {
  constructor() {
    this.ws = null; this._gen = 0; this._sess = 0; this._timers = {};
    this.bids = new Map(); this.asks = new Map();
    this.status = 'idle'; this.symbol = null;
    this.market = null; this.sym = null; this.scale = 1;
    this.cands = []; this.ci = 0; this.refPrice = 0; this.lastError = null; this._wsIdx = 0;
    this._fails = 0; this._everSynced = false; this._spotSkipped = false; this._refAt = 0;
    this.reprobeMs = REPROBE_SPOT_MS; this.retryMs = RETRY_NODATA_MS;
  }
  get ready() { return this.status === 'ok' && this.bids.size > 0 && this.asks.size > 0; }
  /** Label sumber untuk UI: "SPOT BTCUSDT" / "FUT XAUUSDT" (kosong bila belum/tidak ada). */
  get source() { return this.sym ? (this.market === 'fut' ? 'FUT ' : 'SPOT ') + this.sym : ''; }

  start(symbol) {
    this._close();
    const sess = ++this._sess;
    this.symbol = symbol; this.status = 'connecting';
    this.cands = []; this.ci = 0; this.market = null; this.sym = null; this.scale = 1; this.refPrice = 0; this.lastError = null; this._spotSkipped = false;
    // harga acuan Bybit (sanity-check kandidat) — paralel dengan resolusi kandidat
    this._refAt = Date.now();
    this._refP = fetchBybitLast(symbol).then(p => { if (sess === this._sess) this.refPrice = p || 0; }, () => {});
    resolveCandidates(symbol).then(c => {
      if (sess !== this._sess) return;
      this.cands = c;
      if (!c.length) {
        this.status = 'unavailable'; this.lastError = 'tidak ada market Binance untuk ' + symbol;
        console.log(`[Liquidity] ${symbol}: tidak ada market Binance (spot/futures)`);
        return;
      }
      console.log(`[Liquidity] ${symbol} \u2192 kandidat Binance: ` + c.map(x => `${x.market} ${x.sym} (x${x.scale})`).join(', '));
      this._begin();
    }).catch(e => { if (sess === this._sess) { this.status = 'error'; this.lastError = e.message; } });
  }
  stop() { this._close(); this._sess++; this.status = 'idle'; }

  /** Tutup koneksi + timer + isi book (generasi dinaikkan → callback lama diabaikan). */
  _close() {
    this._gen++;
    for (const k of Object.keys(this._timers)) { clearInterval(this._timers[k]); clearTimeout(this._timers[k]); }
    this._timers = {};
    const ws = this.ws; this.ws = null;
    if (ws) { try { ws.removeAllListeners(); ws.on('error', () => {}); ws.close(); } catch (e) {} }
    this.bids.clear(); this.asks.clear(); this.synced = false; this.started = false; this.pending = [];
  }
  _begin() {
    const c = this.cands[this.ci];
    this.market = c.market; this.sym = c.sym; this.scale = c.scale;
    this.status = 'connecting'; this._validated = false; this._backoff = 0; this._snapAt = 0; this._fails = 0; this._everSynced = false;
    this._timers.prune = setInterval(() => this._prune(), 60000);
    // sedang di fallback perpetual karena spot gagal → coba spot lagi berkala (spot wajib diutamakan)
    if (c.market === 'fut' && this._spotSkipped) this._timers.reprobe = setInterval(() => this._probeSpot(), this.reprobeMs);
    // harga acuan Bybit dipakai ulang bila masih segar (< 60 dtk), selain itu ambil lagi
    if (Date.now() - this._refAt > 60000) {
      const sess = this._sess; this._refAt = Date.now();
      this._refP = fetchBybitLast(this.symbol).then(p => { if (sess === this._sess && p > 0) this.refPrice = p; }, () => {});
    }
    this._open(++this._gen);
  }
  _nextCandidate(why) {
    console.log(`[Liquidity] ${this.symbol}: kandidat ${this.market} ${this.sym} dilewati${why ? ' (' + why + ')' : ''}`);
    this._close();
    if (this.ci + 1 < this.cands.length) { this.ci++; this._begin(); }
    else {
      this.status = 'unavailable'; this.lastError = why || 'tidak ada market Binance yang cocok'; this.market = null; this.sym = null;
      // semua kandidat gagal 3x = tidak ada data saat ini; coba ulang penuh berkala (mis. gangguan jaringan saat start)
      const sess = this._sess, symbol = this.symbol;
      console.log(`[Liquidity] ${symbol}: tidak ada data Binance (spot & perpetual gagal ${MAX_FAILS}x) - coba lagi ${Math.round(this.retryMs / 60000)} menit`);
      this._timers.restart = setTimeout(() => { if (sess === this._sess) this.start(symbol); }, this.retryMs);
    }
  }
  /**
   * Satu permintaan/koneksi gagal untuk kandidat aktif. Sebelum kandidat pernah sinkron, 3x gagal berturut-turut = kandidat itu
   * dianggap tidak punya data → kandidat berikutnya (spot → perpetual → "tidak ada data"). Setelah pernah sinkron, gangguan dianggap
   * sementara (retry terus, tidak pindah sumber). Return true bila kandidat sudah dilewati.
   */
  _failed(why) {
    if (this._everSynced) return false;
    this._fails++;
    console.log(`[Liquidity] ${this.symbol}: ${this.market} ${this.sym} gagal ${this._fails}/${MAX_FAILS} (${why})`);
    if (this._fails < MAX_FAILS) return false;
    if (this.market === 'spot') this._spotSkipped = true;   // spot dilewati karena gagal (bukan karena tidak terdaftar) → nanti dicoba lagi
    this._nextCandidate(`${why}; gagal ${MAX_FAILS}x`);
    return true;
  }
  _retrySnapshot(gen, wait) {
    clearTimeout(this._timers.retry);
    this._timers.retry = setTimeout(() => { if (gen === this._gen) this._snapshot(gen); }, wait);
  }
  /** Sedang di fallback perpetual karena spot gagal → cek spot lagi; bila sudah normal & harga cocok, pindah kembali ke spot. */
  async _probeSpot() {
    const gen = this._gen;
    const c = this.cands.find(x => x.market === 'spot');
    if (!c || this.market === 'spot') return;
    try {
      const s = await getJson(SNAPSHOT_URL.spot(c.sym), 20000);
      if (gen !== this._gen || !s || !Array.isArray(s.bids) || !Array.isArray(s.asks) || !s.bids.length || !s.asks.length) return;
      const ref = (await fetchBybitLast(this.symbol)) || this.refPrice;
      if (gen !== this._gen) return;
      const mid = ((+s.bids[0][0] + +s.asks[0][0]) / 2) * c.scale;
      if (ref > 0 && Math.abs(mid / ref - 1) > PRICE_TOL) return;
      console.log(`[Liquidity] ${this.symbol}: spot ${c.sym} pulih \u2192 kembali dari ${this.market} ${this.sym} ke spot`);
      this.ci = this.cands.indexOf(c); this._spotSkipped = false; this.refPrice = ref || this.refPrice;
      this._close(); this._begin();
    } catch (e) { /* spot belum pulih: tetap di perpetual, coba lagi di siklus berikutnya */ }
  }
  _wsUrl() {
    const q = `?streams=${this.sym.toLowerCase()}@depth@100ms`;
    return (this.market === 'fut' ? FUT_WS[this._wsIdx % FUT_WS.length] : SPOT_WS) + q;
  }
  _open(gen) {
    this.synced = false; this.started = false; this.pending = [];
    let opened = false;
    const ws = new WebSocket(this._wsUrl());
    this.ws = ws;
    ws.on('open', () => { if (gen !== this._gen) return; opened = true; this._snapshot(gen); });
    ws.on('message', raw => {
      if (gen !== this._gen) return;
      let e; try { e = JSON.parse(raw).data; } catch (_) { return; }
      if (!e || e.e !== 'depthUpdate') return;
      if (!this.synced) { this.pending.push(e); if (this.pending.length > 4000) this.pending.shift(); return; }
      this._handle(e);
    });
    ws.on('close', () => {
      if (gen !== this._gen) return;
      if (!opened) {
        if (this._failed('WebSocket gagal dibuka')) return;
        if (this.market === 'fut') this._wsIdx++;
      }       // endpoint futures gagal dibuka → coba endpoint lain
      this.status = 'reconnecting'; this._reopenLater(gen);
    });
    ws.on('error', () => {});
  }
  _reopenLater(gen) {
    clearTimeout(this._timers.reopen);
    this._timers.reopen = setTimeout(() => {
      if (gen !== this._gen) return;
      const old = this.ws; this.ws = null; if (old) { try { old.removeAllListeners(); old.on('error', () => {}); old.terminate(); } catch (e) {} }
      this._open(gen);
    }, 3000);
  }
  async _snapshot(gen) {
    try {
      const wait0 = Date.now() - (this._snapAt || 0);
      if (wait0 < 3000) await new Promise(r => setTimeout(r, 3000 - wait0));   // jangan menembak REST beruntun (resync berulang)
      if (gen !== this._gen) return;
      this._snapAt = Date.now();
      const s = await getJson(SNAPSHOT_URL[this.market](this.sym), 20000);
      if (gen !== this._gen) return;
      if (!s || !Array.isArray(s.bids) || !Array.isArray(s.asks) || !s.bids.length || !s.asks.length) { if (this._failed('order book kosong')) return; this._retrySnapshot(gen, 3000); return; }
      this.bids.clear(); this.asks.clear();
      for (const [p, q] of s.bids) this.bids.set(+p, +q);
      for (const [p, q] of s.asks) this.asks.set(+p, +q);

      // sanity-check (sekali per kandidat): harga book × skala harus mendekati harga Bybit — mencegah ticker kembar / skala salah
      if (!this._validated) {
        await Promise.race([this._refP, new Promise(r => setTimeout(r, 4000))]);
        if (gen !== this._gen) return;
        const ref = this.refPrice, mid = this.mid();
        if (ref > 0 && mid > 0 && Math.abs(mid / ref - 1) > PRICE_TOL) { if (this._failed(`harga ${mid.toPrecision(6)} vs Bybit ${ref} tidak cocok`)) return; this._retrySnapshot(gen, 3000); return; }
        this._validated = true;
        console.log(`[Liquidity] ${this.symbol} \u2190 Binance ${this.market === 'fut' ? 'USD\u24c8-M Futures' : 'Spot'} ${this.sym} (skala x${this.scale}) mid=${mid.toPrecision(7)}${ref > 0 ? ' / Bybit ' + ref : ''}`);
      }

      this.lastId = s.lastUpdateId; this.started = false; this.synced = true;
      this._backoff = 0; this.lastError = null; this._fails = 0; this._everSynced = true;
      const pend = this.pending; this.pending = [];
      for (const e of pend) this._handle(e);
      this.status = 'ok';
    } catch (e) {
      if (gen !== this._gen) return;
      const msg = String((e && e.message) || e);
      const limited = /HTTP (418|429)/.test(msg);                          // rate limit / ban IP bukan bukti "tidak ada data" → tidak dihitung gagal
      const definitive = /HTTP (404|451)|-1121|Invalid symbol/i.test(msg);  // simbol tidak ada / diblokir wilayah → ulang cepat (3 dtk)
      if (!limited && this._failed(msg.slice(0, 100))) return;           // 3x gagal berturut-turut sebelum pernah sinkron → kandidat berikutnya
      this.status = 'error';
      this.lastError = msg;
      // backoff eksponensial; hormati ban IP Binance (HTTP 418 "banned until <ms>") dan rate limit 429
      let wait = this._backoff = Math.min(120000, (this._backoff || 2500) * 2);
      const m = /banned until (\d+)/.exec(e.message);
      if (m) wait = Math.min(15 * 60 * 1000, Math.max(wait, +m[1] - Date.now() + 1500));
      if (/HTTP (418|429)/.test(e.message)) console.warn(`[Liquidity] Binance rate-limited \u2014 coba lagi ${Math.round(wait / 1000)} dtk`);
      if (definitive) wait = 3000;
      this._retrySnapshot(gen, wait);
    }
  }
  _apply(e) {
    for (const [p, q] of e.b) { const pp = +p, qq = +q; if (qq === 0) this.bids.delete(pp); else this.bids.set(pp, qq); }
    for (const [p, q] of e.a) { const pp = +p, qq = +q; if (qq === 0) this.asks.delete(pp); else this.asks.set(pp, qq); }
  }
  /**
   * Aturan sinkronisasi diff depth (dokumentasi Binance):
   *  SPOT   : event pertama U <= lastUpdateId+1 <= u; berikutnya U harus = u sebelumnya + 1.
   *  FUTURES: event pertama U <= lastUpdateId <= u; berikutnya pu (previous final update id) harus = u sebelumnya.
   * Menyimpang → snapshot ulang.
   */
  _handle(e) {
    if (this.market === 'fut') {
      if (!this.started) {
        if (e.u < this.lastId) return;
        if (e.U <= this.lastId && e.u >= this.lastId) this.started = true;
        else if (e.U > this.lastId) { this._resync(); return; }
        else return;
      } else if (e.pu !== this.lastU) { this._resync(); return; }
    } else {
      if (!this.started) {
        if (e.u <= this.lastId) return;
        if (e.U <= this.lastId + 1 && e.u >= this.lastId + 1) this.started = true;
        else if (e.U > this.lastId + 1) { this._resync(); return; }
        else return;
      } else if (e.U !== this.lastU + 1) { this._resync(); return; }
    }
    this._apply(e);
    this.lastU = e.u;
  }
  _resync() {
    this.synced = false; this.started = false; this.pending = [];
    this._snapshot(this._gen);
  }
  _prune() {
    let bb = 0, aa = Infinity;
    for (const p of this.bids.keys()) if (p > bb) bb = p;
    for (const p of this.asks.keys()) if (p < aa) aa = p;
    if (!(bb > 0 && aa < Infinity)) return;
    const m = (bb + aa) / 2, lo = m * 0.9, hi = m * 1.1;
    for (const p of this.bids.keys()) if (p < lo) this.bids.delete(p);
    for (const p of this.asks.keys()) if (p > hi) this.asks.delete(p);
  }
  mid() {
    let bb = 0, aa = Infinity;
    for (const p of this.bids.keys()) if (p > bb) bb = p;
    for (const p of this.asks.keys()) if (p < aa) aa = p;
    return bb > 0 && aa < Infinity ? ((bb + aa) / 2) * this.scale : 0;
  }
  /** fn(harga dalam skala chart, jumlah koin dalam skala chart) — notional USD tidak berubah oleh skala. */
  forEach(fn) { const k = this.scale; for (const [p, q] of this.bids) fn(p * k, q / k); for (const [p, q] of this.asks) fn(p * k, q / k); }
  tickGuess() {
    const ps = [...this.bids.keys()].sort((a, b) => b - a).slice(0, 60);
    let d = Infinity; for (let i = 1; i < ps.length; i++) { const g = ps[i - 1] - ps[i]; if (g > 1e-12 && g < d) d = g; }
    return isFinite(d) ? d * this.scale : 0;
  }
}

// ── minute record (satu sumber: Binance) ──
function newRec(t, lo, hi) {
  const n = hi - lo + 1;
  return { t, lo, n, cnt: 0, max: new Float32Array(n), sum: new Float32Array(n), last: new Float32Array(n) };
}
function ensureRange(rec, lo, hi) {
  if (lo >= rec.lo && hi < rec.lo + rec.n) return;
  const newLo = Math.min(rec.lo, lo - PAD_BINS), newHi = Math.max(rec.lo + rec.n - 1, hi + PAD_BINS);
  const n = newHi - newLo + 1, off = rec.lo - newLo;
  for (const k of ['max', 'sum', 'last']) { const a = new Float32Array(n); a.set(rec[k], off); rec[k] = a; }
  rec.lo = newLo; rec.n = n;
}

class LiquidityRecorder extends EventEmitter {
  constructor() {
    super();
    this.opts = { rangePct: 1.5 };
    this.stores = new Map();
    this.store = null;
    this.symbol = null;
    this.binance = new BinanceBook();
    this._timer = null;
    this._lastEmit = 0;
    this._saveTimer = null;
  }

  _newStore(symbol) {
    return { symbol, bin: 0, minutes: [], cur: null, version: 0, startedAt: Date.now(), rangePct: this.opts.rangePct, status: { binance: 'idle' }, source: '', mid: 0 };
  }

  /** Ikuti pair chart: mulai/ganti perekaman. Mengembalikan store (referensi live). */
  follow(symbol) {
    if (this.symbol === symbol && this.store) return this.store;
    this._save(this.store);
    this.symbol = symbol;
    let st = this.stores.get(symbol);
    if (!st) { st = this._load(symbol) || this._newStore(symbol); this.stores.set(symbol, st); }
    // simpan maksimal 3 pair di memori
    if (this.stores.size > 3) { for (const k of this.stores.keys()) { if (k !== symbol) { this.stores.delete(k); break; } } }
    this.store = st;
    this.binance.start(symbol);
    clearInterval(this._timer);
    this._timer = setInterval(() => this._sample(), SAMPLE_MS);
    clearInterval(this._saveTimer);
    this._saveTimer = setInterval(() => this._save(this.store), 5 * 60 * 1000);
    if (this._saveTimer.unref) this._saveTimer.unref();
    this._syncStatus();
    return st;
  }

  stop() {
    clearInterval(this._timer); this._timer = null;
    clearInterval(this._saveTimer); this._saveTimer = null;
    this._save(this.store, true);
    this.binance.stop();
    this.symbol = null; this.store = null;
  }

  setOptions(o) { Object.assign(this.opts, o || {}); }

  clear() {
    if (!this.store) return;
    const s = this.store;
    s.minutes = []; s.cur = null; s.version++; s.startedAt = Date.now();
    try { fs.unlinkSync(path.join(DATA_DIR, s.symbol + '.bin.gz')); } catch (e) {}
    this.emit('update', s);
  }

  _syncStatus() {
    if (!this.store) return;
    this.store.status.binance = this.binance.status;
    this.store.source = this.binance.source;
  }

  _mid() { return this.binance.ready ? this.binance.mid() : 0; }

  _sample() {
    const st = this.store;
    if (!st) return;
    this._syncStatus();
    const mid = this._mid();
    if (!(mid > 0)) { this._maybeEmit(false); return; }
    st.mid = mid;
    if (!st.bin) {
      const tick = Math.max(this.binance.tickGuess(), 0);
      let bin = niceStep(mid * 0.0001);
      if (tick > 0 && bin < tick) bin = tick * Math.ceil(bin / tick);
      st.bin = bin;
    }
    const bin = st.bin, R = (this.opts.rangePct || 1.5) / 100;
    const loAbs = Math.floor((mid * (1 - R)) / bin), hiAbs = Math.floor((mid * (1 + R)) / bin);
    const n = hiAbs - loAbs + 1;
    if (n <= 0 || n > 6000) return;

    const a = new Float64Array(n);
    this.binance.forEach((price, units) => {
      const i = Math.floor(price / bin) - loAbs;
      if (i >= 0 && i < n) a[i] += price * units;
    });

    const tMin = Math.floor(Date.now() / 60000) * 60;
    if (!st.cur || st.cur.t !== tMin) {
      if (st.cur) { st.minutes.push(st.cur); if (st.minutes.length > MAX_MINUTES) st.minutes.splice(0, st.minutes.length - MAX_MINUTES); }
      const lastRec = st.minutes[st.minutes.length - 1];
      if (!st.cur && lastRec && lastRec.t === tMin) st.cur = st.minutes.pop();   // lanjutkan menit yang dimuat dari disk
      else st.cur = newRec(tMin, loAbs - PAD_BINS, hiAbs + PAD_BINS);
    }
    const rec = st.cur;
    ensureRange(rec, loAbs, hiAbs);
    rec.cnt++;
    const mx = rec.max, sm = rec.sum, ls = rec.last;
    ls.fill(0);
    const off = loAbs - rec.lo;
    for (let i = 0; i < n; i++) {
      const v = a[i];
      if (v > 0) { const k = off + i; if (v > mx[k]) mx[k] = v; sm[k] += v; ls[k] = v; }
    }
    st.version++;
    this._maybeEmit(true);
  }

  _maybeEmit() {
    const now = Date.now();
    if (now - this._lastEmit < 900) return;
    this._lastEmit = now;
    this.emit('update', this.store);
  }

  // ── persistensi ──
  _file(symbol) { return path.join(DATA_DIR, symbol + '.bin.gz'); }

  _save(st, sync) {
    if (!st || (!st.minutes.length && !st.cur)) return;
    try {
      const mins = st.cur ? st.minutes.concat([st.cur]) : st.minutes;
      const head = Buffer.from(JSON.stringify({ symbol: st.symbol, src: 'binance', bin: st.bin, rangePct: st.rangePct, count: mins.length, startedAt: st.startedAt }), 'utf8');
      let size = 8 + head.length;
      for (const r of mins) size += 8 + 4 + 4 + 4 + 3 * r.n * 4;
      const buf = Buffer.alloc(size);
      let o = 0;
      buf.write(FILE_MAGIC, o); o += 4; buf.writeUInt32LE(head.length, o); o += 4; head.copy(buf, o); o += head.length;
      for (const r of mins) {
        buf.writeDoubleLE(r.t, o); o += 8; buf.writeInt32LE(r.lo, o); o += 4; buf.writeInt32LE(r.n, o); o += 4;
        buf.writeUInt16LE(r.cnt, o); o += 2; buf.writeUInt16LE(0, o); o += 2;
        for (const k of ['max', 'sum', 'last']) {
          const a = r[k];
          Buffer.from(a.buffer, a.byteOffset, r.n * 4).copy(buf, o); o += r.n * 4;
        }
      }
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const file = this._file(st.symbol);
      if (sync) fs.writeFileSync(file, zlib.gzipSync(buf, { level: 1 }));
      else zlib.gzip(buf, { level: 1 }, (err, out) => { if (!err) fs.writeFile(file, out, () => {}); });
    } catch (e) { console.warn('[Liquidity] save error:', e.message); }
  }

  _load(symbol) {
    try {
      const file = this._file(symbol);
      if (!fs.existsSync(file)) return null;
      const buf = zlib.gunzipSync(fs.readFileSync(file));
      if (buf.toString('utf8', 0, 4) !== FILE_MAGIC) { console.log(`[Liquidity] ${symbol}: history format lama (Binance+OKX) diabaikan`); return null; }
      let o = 4; const hl = buf.readUInt32LE(o); o += 4;
      const head = JSON.parse(buf.toString('utf8', o, o + hl)); o += hl;
      const st = this._newStore(symbol);
      st.bin = head.bin || 0; st.startedAt = head.startedAt || Date.now();
      const cutoff = Math.floor(Date.now() / 1000) - MAX_MINUTES * 60;
      for (let m = 0; m < head.count; m++) {
        const t = buf.readDoubleLE(o); o += 8; const lo = buf.readInt32LE(o); o += 4; const n = buf.readInt32LE(o); o += 4;
        const cnt = buf.readUInt16LE(o); o += 4;   // cnt (u16) + cadangan (u16)
        const rec = { t, lo, n, cnt };
        for (const k of ['max', 'sum', 'last']) {
          const a = new Float32Array(n);
          Buffer.from(a.buffer).set(buf.subarray(o, o + n * 4)); o += n * 4;
          rec[k] = a;
        }
        if (t >= cutoff) st.minutes.push(rec);
      }
      console.log(`[Liquidity] ${symbol}: ${st.minutes.length} menit history dimuat dari disk`);
      return st;
    } catch (e) { console.warn('[Liquidity] load error:', e.message); return null; }
  }
}

module.exports = { LiquidityRecorder, BinanceBook, niceStep, MAX_MINUTES };
