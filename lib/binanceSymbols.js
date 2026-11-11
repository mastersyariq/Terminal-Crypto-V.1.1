'use strict';
/**
 * Resolver simbol Bybit (perp USDT) → market Binance untuk Liquidity Heatmap.
 *
 * Masalah yang diselesaikan: heatmap dulu hanya mencari pasangan SPOT Binance (<BASE>USDT). Banyak instrumen Bybit tidak punya
 * pasangan spot di Binance — contoh XAUUSDT / XAGUSDT (emas & perak), saham (AAPLUSDT, TSLAUSDT, ...), FX — sehingga heatmap kosong.
 * Di Binance instrumen itu hanya ada sebagai kontrak USDⓈ-M Futures (jenis TRADIFI_PERPETUAL).
 *
 * Urutan kandidat per simbol (semuanya dari Binance):
 *   1. SPOT     (api.binance.com)  — spot WAJIB diutamakan (dicoba lebih dulu, selalu menjadi sumber utama bila ada)
 *   2. FUTURES  (fapi.binance.com) — fallback HANYA bila spot tidak terdaftar atau gagal 3x (aturan 3x ada di liquidityBook.js); mencakup kontrak TradFi + koin yang hanya listing di futures
 * Simbol ber-multiplier dicocokkan lewat "core" + faktor skala harga, mis.
 *   1000PEPEUSDT (Bybit)  ↔ PEPEUSDT (spot, skala ×1000) / 1000PEPEUSDT (futures, skala ×1)
 *   SHIB1000USDT          ↔ SHIBUSDT / 1000SHIBUSDT
 *   10000SATSUSDT         ↔ 1000SATSUSDT (skala ×10)
 *   1000000BABYDOGEUSDT   ↔ 1MBABYDOGEUSDT (skala ×1)
 * scale = harga_chart / harga_binance.
 */
const https = require('https');

const SPOT_TICKER = 'https://api.binance.com/api/v3/ticker/price';
const FUT_TICKER = 'https://fapi.binance.com/fapi/v1/ticker/price';
const UNIVERSE_TTL = 6 * 3600 * 1000;      // daftar simbol Binance di-cache 6 jam
const UNIVERSE_RETRY = 60 * 1000;          // bila salah satu endpoint gagal → coba lagi 1 menit kemudian
const MAX_CANDIDATES = 4;

function getJson(url, timeout) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: timeout || 15000 }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode + ' ' + body.slice(0, 120)));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
  });
}

// ── parsing nama simbol: pisahkan koin inti dan multiplier ──
const MULT_PREFIX = /^(1000000|100000|10000|1000|1M)([A-Z][A-Z0-9]*)$/;
const MULT_SUFFIX = /^([A-Z][A-Z0-9]*?)(1000000|100000|10000|1000)$/;

/** 'XAUUSDT' → {sym, core:'XAU', mult:1};  '1000PEPEUSDT' → {core:'PEPE', mult:1000};  'SHIB1000USDT' → {core:'SHIB', mult:1000}. */
function parseSymbol(symbol) {
  const s = String(symbol || '').toUpperCase();
  if (!/^[A-Z0-9]+USDT$/.test(s) || s.length <= 4) return null;
  const raw = s.slice(0, -4);
  let m = MULT_PREFIX.exec(raw);
  if (m) return { sym: s, core: m[2], mult: m[1] === '1M' ? 1e6 : +m[1] };
  m = MULT_SUFFIX.exec(raw);
  if (m) return { sym: s, core: m[1], mult: +m[2] };
  return { sym: s, core: raw, mult: 1 };
}

function buildIndex(symbols) {
  const idx = new Map();
  for (const s of symbols) {
    const p = parseSymbol(s);
    if (!p) continue;
    let a = idx.get(p.core);
    if (!a) idx.set(p.core, a = []);
    a.push({ sym: p.sym, mult: p.mult });
  }
  return idx;
}

// ── universe simbol Binance (spot + futures) ──
let _uni = null, _uniP = null;

async function loadUniverse(force) {
  if (!force && _uni && Date.now() < _uni.expires) return _uni;
  if (_uniP) return _uniP;
  _uniP = (async () => {
    const [sp, fu] = await Promise.allSettled([getJson(SPOT_TICKER, 20000), getJson(FUT_TICKER, 20000)]);
    const list = r => (r.status === 'fulfilled' && Array.isArray(r.value)) ? r.value.map(x => x && x.symbol).filter(Boolean) : null;
    const spot = list(sp), fut = list(fu);
    if (!spot && !fut) {
      console.warn('[Liquidity] daftar simbol Binance tidak bisa diambil:', (sp.reason && sp.reason.message) || (fu.reason && fu.reason.message));
      return _uni;   // bisa null → resolver memakai tebakan berdasarkan nama
    }
    _uni = {
      at: Date.now(),
      expires: Date.now() + ((spot && fut) ? UNIVERSE_TTL : UNIVERSE_RETRY),
      spot: spot ? buildIndex(spot) : null,
      fut: fut ? buildIndex(fut) : null,
      nSpot: spot ? spot.length : 0, nFut: fut ? fut.length : 0
    };
    console.log(`[Liquidity] daftar simbol Binance: ${_uni.nSpot} spot, ${_uni.nFut} futures`);
    return _uni;
  })().finally(() => { _uniP = null; });
  return _uniP;
}

/**
 * Kandidat market Binance untuk simbol Bybit: [{ market:'spot'|'fut', sym, scale }] (urut prioritas).
 * uni = null (daftar simbol tidak tersedia) → tebakan berdasarkan nama; kandidat yang salah gugur saat snapshot (HTTP 400 Invalid symbol).
 */
function candidates(symbol, uni) {
  const p = parseSymbol(symbol);
  if (!p) return [];
  const out = [];
  const add = (market, sym, mult) => {
    if (!out.some(c => c.market === market && c.sym === sym)) out.push({ market, sym, scale: p.mult / mult });
  };
  const dist = m => Math.abs(Math.log(p.mult / m));

  for (const market of ['spot', 'fut']) {
    const idx = uni && uni[market];
    if (idx) {
      const list = (idx.get(p.core) || []).slice();
      // nama yang sama persis dulu, lalu multiplier terdekat
      list.sort((a, b) => ((b.sym === p.sym) - (a.sym === p.sym)) || (dist(a.mult) - dist(b.mult)));
      for (const e of list) add(market, e.sym, e.mult);
    } else if (!uni || !uni[market]) {
      // tanpa daftar simbol: tebak
      if (market === 'spot') add('spot', p.core + 'USDT', 1);
      else { add('fut', p.sym, p.mult); add('fut', p.core + 'USDT', 1); add('fut', '1000' + p.core + 'USDT', 1000); }
    }
  }
  return out.slice(0, MAX_CANDIDATES);
}

async function resolveCandidates(symbol) {
  let uni = null;
  try { uni = await loadUniverse(); } catch (e) { uni = null; }
  let c = candidates(symbol, uni);
  // simbol baru listing setelah daftar di-cache? muat ulang sekali bila daftar sudah > 10 menit
  if (!c.length && uni && Date.now() - uni.at > 10 * 60 * 1000) {
    try { uni = await loadUniverse(true); c = candidates(symbol, uni); } catch (e) {}
  }
  return c;
}

/** Harga terakhir simbol di Bybit (acuan sanity-check kandidat Binance). 0 bila gagal. */
async function fetchBybitLast(symbol) {
  for (const host of ['api.bytick.com', 'api.bybit.com']) {
    try {
      const j = await getJson(`https://${host}/v5/market/tickers?category=linear&symbol=${encodeURIComponent(symbol)}`, 8000);
      const it = j && j.result && j.result.list && j.result.list[0];
      const p = it ? parseFloat(it.lastPrice || it.markPrice) : 0;
      if (p > 0) return p;
    } catch (e) {}
  }
  return 0;
}

module.exports = { getJson, parseSymbol, candidates, resolveCandidates, loadUniverse, fetchBybitLast };
