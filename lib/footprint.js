'use strict';
/**
 * Footprint book — agregasi trade Bybit (publicTrade WebSocket) per MENIT per level harga: { buy, sell }.
 *
 * Kenapa per menit (bukan per candle TF)?
 *   Semua timeframe terminal ≥ 1 menit, jadi agregat per-menit bisa dijumlahkan menjadi candle TF mana pun (1m … 1W)
 *   tanpa kehilangan data saat ganti timeframe. (tradeAgg lama dihitung ulang dari 100k trade terakhir saja → history hilang
 *   begitu TF diganti.)
 *
 * Level harga = kelipatan `base`, dipilih relatif terhadap harga (≈ 1 bp) dan selalu kelipatan tickSize Bybit:
 *   BTC ~65000 (tick 0.1) → base 10   |  ETH ~3500 (tick 0.01) → 0.5  |  XRP ~0.5 (tick 0.0001) → 0.0001
 * Chart menggabungkan level menjadi baris yang lebih tebal (kelipatan base) sesuai zoom vertikal.
 *
 * Catatan data: Bybit tidak menyediakan history trade lewat WebSocket → footprint terisi sejak trade pertama diterima aplikasi.
 * Supaya tidak hilang saat aplikasi ditutup, tiap simbol disimpan ke data/footprint/<SYMBOL>.json.gz (tiap 5 menit + saat keluar).
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DATA_DIR = path.join(__dirname, '..', 'data', 'footprint');
const MAX_MINUTES = 2880;               // history per simbol: 2 hari
const MAX_SYMBOLS = 6;                  // jumlah simbol yang disimpan di memori (LRU)
const REL_BUCKET = 0.0001;              // lebar level dasar ≈ 1 bp harga
const PENDING_MAX = 20000;              // trade yang ditahan sambil menunggu tickSize
const TICK_WAIT_MS = 15000;             // tickSize tak kunjung ada → sementara pakai tebakan dari magnitudo harga (di-rebase begitu tickSize asli tiba)
const SAVE_EVERY_MS = 5 * 60 * 1000;
const WEEK_OFFSET = 4 * 86400;          // candle mingguan Bybit mulai Senin 00:00 UTC (epoch = Kamis)
const WEEK_SEC = 604800;
const FILE_VERSION = 1;

/** Bilangan terkecil dari {1,2,5}×10^k yang ≥ x (minimal 1). */
function niceUp(x) {
  if (!(x > 1)) return 1;
  const e = Math.pow(10, Math.floor(Math.log10(x)));
  const f = x / e;
  const n = f <= 1 + 1e-9 ? 1 : f <= 2 + 1e-9 ? 2 : f <= 5 + 1e-9 ? 5 : 10;
  return n * e;
}
function fallbackTick(price) { return Math.pow(10, Math.floor(Math.log10(price)) - 4); }

/** Lebar level dasar untuk harga & tickSize tertentu (selalu kelipatan tick). */
function baseBucket(price, tick) {
  const t = tick > 0 ? tick : fallbackTick(price);
  const steps = niceUp((price * REL_BUCKET) / t);
  return Number((t * steps).toPrecision(12));
}

/** Waktu buka candle TF (detik) yang memuat waktu `sec`. */
function candleTime(sec, tfSec) {
  if (tfSec === WEEK_SEC) return Math.floor((sec - WEEK_OFFSET) / tfSec) * tfSec + WEEK_OFFSET;
  return Math.floor(sec / tfSec) * tfSec;
}

/** Indeks level untuk sebuah harga (epsilon menahan noise floating point: 0.3/0.1 = 2.9999999999999996). */
function levelIndex(price, base) { return Math.floor(price / base + 1e-6); }

class SymbolBook {
  constructor(symbol) {
    this.symbol = symbol;
    this.base = 0;
    this.tick = 0;
    this.tickReady = false;
    this.tickReal = false;      // true bila tickSize berasal dari Bybit (bukan tebakan)
    this.lastPrice = 0;
    this.minutes = new Map();   // minuteSec → Map<levelIdx, [buy, sell]>
    this.pending = [];
    this.dirty = false;
    this.trades = 0;
    this.lastTime = 0;
    this._tickTimer = null;
  }
}

class FootprintBook {
  constructor(opts) {
    opts = opts || {};
    this.dir = opts.dir || DATA_DIR;
    this.persist = opts.persist !== false;
    this.tickWaitMs = opts.tickWaitMs > 0 ? opts.tickWaitMs : TICK_WAIT_MS;
    this.books = new Map();     // urutan sisip = urutan LRU
    this._saveTimer = null;
  }

  /** Mulai/ikuti simbol: siapkan book (muat dari disk bila ada). Idempotent. */
  follow(symbol) {
    let r = this.books.get(symbol);
    if (r) { this.books.delete(symbol); this.books.set(symbol, r); }
    else {
      r = (this.persist && this._load(symbol)) || new SymbolBook(symbol);
      this.books.set(symbol, r);
      while (this.books.size > MAX_SYMBOLS) {
        const oldest = this.books.keys().next().value;
        if (oldest === symbol) break;
        this._dispose(oldest);
      }
    }
    if (!r.tickReady && !r._tickTimer) {
      r._tickTimer = setTimeout(() => this.setTick(symbol, 0), this.tickWaitMs);
      if (r._tickTimer.unref) r._tickTimer.unref();
    }
    this._ensureSaveTimer();
    return r;
  }

  /**
   * tickSize Bybit untuk simbol (0/null = tidak diketahui → tebakan sementara).
   * Bila sebelumnya memakai tebakan lalu tickSize asli tiba, level dasar yang bukan kelipatan tick di-rebase (data lama dipetakan ke level baru).
   */
  setTick(symbol, tick) {
    const r = this.books.get(symbol);
    if (!r) return;
    clearTimeout(r._tickTimer); r._tickTimer = null;
    const real = tick > 0;
    if (r.tickReady && (r.tickReal || !real)) return;      // sudah punya tickSize asli / tidak ada informasi baru
    r.tick = real ? tick : 0;
    r.tickReady = true;
    r.tickReal = real;
    // base (hasil muat dari disk / tebakan) harus kelipatan tick asli; bila tidak → petakan ulang ke base baru
    if (r.base > 0 && real) {
      const q = r.base / r.tick;
      if (q < 0.999999 || Math.abs(q - Math.round(q)) > 1e-6) this._rebase(r);
    }
    this._flush(r);
  }

  /** Perkiraan harga acuan simbol (trade terakhir, atau rata-rata level menit terakhir bila belum ada trade). */
  _refPrice(r) {
    if (r.lastPrice > 0) return r.lastPrice;
    let last = null;
    for (const lv of r.minutes.values()) last = lv;
    if (!last || !last.size) return 0;
    let s = 0; for (const idx of last.keys()) s += (idx + 0.5) * r.base;
    return s / last.size;
  }

  /** Hitung ulang level dasar dari tick saat ini lalu petakan seluruh data lama (volume terjaga; level lama → level baru yang memuat titik tengahnya). */
  _rebase(r) {
    const price = this._refPrice(r);
    if (!(price > 0)) { r.base = 0; r.minutes.clear(); r.dirty = true; return; }
    const nb = baseBucket(price, r.tick), ob = r.base;
    if (Math.abs(nb - ob) < ob * 1e-9) return;
    for (const [min, lv] of r.minutes) {
      const out = new Map();
      for (const [idx, a] of lv) {
        const ni = levelIndex((idx + 0.5) * ob, nb), x = out.get(ni);
        if (x) { x[0] += a[0]; x[1] += a[1]; } else out.set(ni, [a[0], a[1]]);
      }
      r.minutes.set(min, out);
    }
    console.log(`[Footprint] ${r.symbol}: level dasar ${ob} → ${nb} (tickSize ${r.tick})`);
    r.base = nb; r.dirty = true;
  }

  /** trade = { time (detik), price, volume, side: 'Buy'|'Sell' } */
  addTrade(symbol, t) {
    const r = this.books.get(symbol);
    if (!r || !t || !(t.price > 0) || !(t.volume > 0)) return;
    if (!r.tickReady) { if (r.pending.length < PENDING_MAX) r.pending.push(t); return; }
    if (!r.base) r.base = baseBucket(t.price, r.tick);
    if (r.pending.length) this._flush(r);
    this._add(r, t);
  }

  _flush(r) {
    if (!r.tickReady || !r.pending.length) return;
    const p = r.pending; r.pending = [];
    if (!r.base) r.base = baseBucket(p[0].price, r.tick);
    for (const t of p) this._add(r, t);
  }

  _add(r, t) {
    const m = Math.floor(t.time / 60) * 60;
    let lv = r.minutes.get(m);
    if (!lv) { lv = new Map(); r.minutes.set(m, lv); }
    const idx = levelIndex(t.price, r.base);
    let a = lv.get(idx);
    if (!a) { a = [0, 0]; lv.set(idx, a); }
    if (t.side === 'Buy') a[0] += t.volume; else a[1] += t.volume;
    if (t.time > r.lastTime) r.lastTime = t.time;
    r.lastPrice = t.price;
    r.dirty = true;
    if ((++r.trades & 1023) === 0) this._trim(r);
  }

  _trim(r) {
    const cutoff = Math.floor(r.lastTime / 60) * 60 - MAX_MINUTES * 60;
    for (const k of r.minutes.keys()) if (k < cutoff) r.minutes.delete(k);
  }

  /**
   * Agregat per candle untuk timeframe tertentu.
   * @returns {{base:number, tick:number, data:Array<[number, number[]]>}}  data = [[candleTime, [idx, buy, sell, idx, buy, sell, ...]], ...] naik menurut waktu
   */
  query(symbol, tfSec, maxCandles) {
    const r = this.books.get(symbol);
    if (!r || !r.base || !(tfSec > 0)) return { base: r ? r.base : 0, tick: r ? r.tick : 0, data: [] };
    const acc = new Map();
    for (const [min, lv] of r.minutes) {
      const ct = candleTime(min, tfSec);
      let m = acc.get(ct);
      if (!m) { m = new Map(); acc.set(ct, m); }
      for (const [idx, a] of lv) {
        const x = m.get(idx);
        if (x) { x[0] += a[0]; x[1] += a[1]; } else m.set(idx, [a[0], a[1]]);
      }
    }
    let times = [...acc.keys()].sort((a, b) => a - b);
    if (maxCandles > 0 && times.length > maxCandles) times = times.slice(times.length - maxCandles);
    const data = times.map(ct => {
      const flat = [];
      for (const [idx, a] of acc.get(ct)) flat.push(idx, a[0], a[1]);
      return [ct, flat];
    });
    return { base: r.base, tick: r.tick, data };
  }

  stats(symbol) {
    const r = this.books.get(symbol);
    if (!r) return null;
    let levels = 0; for (const lv of r.minutes.values()) levels += lv.size;
    return { base: r.base, tick: r.tick, tickReady: r.tickReady, minutes: r.minutes.size, levels, trades: r.trades, pending: r.pending.length };
  }

  // ── persistensi ──
  _file(symbol) { return path.join(this.dir, String(symbol).replace(/[^A-Za-z0-9_.-]/g, '_') + '.json.gz'); }

  _serialize(r) {
    const minutes = [];
    for (const [min, lv] of r.minutes) {
      const flat = [];
      for (const [idx, a] of lv) flat.push(idx, a[0], a[1]);
      minutes.push([min, flat]);
    }
    return Buffer.from(JSON.stringify({ v: FILE_VERSION, symbol: r.symbol, base: r.base, tick: r.tick, minutes }), 'utf8');
  }

  save(symbol, sync) {
    const r = this.books.get(symbol);
    if (!this.persist || !r || !r.dirty || !r.base || !r.minutes.size) return;
    try {
      const raw = this._serialize(r);
      r.dirty = false;
      fs.mkdirSync(this.dir, { recursive: true });
      const file = this._file(symbol);
      if (sync) fs.writeFileSync(file, zlib.gzipSync(raw, { level: 1 }));
      else zlib.gzip(raw, { level: 1 }, (err, out) => { if (!err) fs.writeFile(file, out, () => {}); });
    } catch (e) { console.warn('[Footprint] save error:', e.message); }
  }

  saveAll(sync) { for (const s of this.books.keys()) this.save(s, sync); }

  _load(symbol) {
    try {
      const file = this._file(symbol);
      if (!fs.existsSync(file)) return null;
      const j = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
      if (!j || j.v !== FILE_VERSION || !(j.base > 0) || !Array.isArray(j.minutes)) return null;
      const r = new SymbolBook(symbol);
      r.base = j.base; r.tick = j.tick > 0 ? j.tick : 0;
      for (const [min, flat] of j.minutes) {
        const lv = new Map();
        for (let k = 0; k + 2 < flat.length; k += 3) lv.set(flat[k], [flat[k + 1], flat[k + 2]]);
        r.minutes.set(min, lv);
        if (min > r.lastTime) r.lastTime = min;
      }
      this._trim(r);
      console.log(`[Footprint] ${symbol}: ${r.minutes.size} menit history dimuat dari disk (base ${r.base})`);
      return r;
    } catch (e) { console.warn('[Footprint] load error:', e.message); return null; }
  }

  _ensureSaveTimer() {
    if (!this.persist || this._saveTimer) return;
    this._saveTimer = setInterval(() => this.saveAll(false), SAVE_EVERY_MS);
    if (this._saveTimer.unref) this._saveTimer.unref();
  }

  _dispose(symbol) {
    const r = this.books.get(symbol);
    if (!r) return;
    this.save(symbol, true);
    clearTimeout(r._tickTimer);
    this.books.delete(symbol);
  }

  /** Simpan semua (sinkron) dan hentikan timer — dipanggil saat aplikasi ditutup. */
  stop() {
    clearInterval(this._saveTimer); this._saveTimer = null;
    for (const r of this.books.values()) { clearTimeout(r._tickTimer); r._tickTimer = null; }
    this.saveAll(true);
  }
}

module.exports = { FootprintBook, baseBucket, candleTime, levelIndex, niceUp, MAX_MINUTES };
