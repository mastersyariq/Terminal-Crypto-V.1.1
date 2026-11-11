'use strict';
const https = require('https');

// Helper to make timeout-guarded HTTPS requests
function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      timeout: 8000
    };
    const req = https.get(url, options, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try {
          resolve(JSON.parse(raw));
        } catch (e) {
          reject(new Error(`Parse error: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request Timeout'));
    });
  });
}

// Convert common intervals ('1', '5', '15', '30', '60', '240', 'D', 'W')
// to exchange-specific interval strings
const INTERVAL_MAP = {
  bybit:    { '1':'1', '5':'5', '15':'15', '30':'30', '60':'60', '240':'240', 'D':'D', 'W':'W' },
  binance:  { '1':'1m', '5':'5m', '15':'15m', '30':'30m', '60':'1h', '240':'4h', 'D':'1d', 'W':'1w' },
  okx:      { '1':'1m', '5':'5m', '15':'15m', '30':'30m', '60':'1H', '240':'4H', 'D':'1D', 'W':'1W' },
  mexc:     { '1':'1m', '5':'5m', '15':'15m', '30':'30m', '60':'60m', '240':'4h', 'D':'1d', 'W':'1w' },
  bingx:    { '1':'1m', '5':'5m', '15':'15m', '30':'30m', '60':'1h', '240':'4h', 'D':'1d', 'W':'1w' },
  bitstamp: { '1':'60', '5':'300', '15':'900', '30':'1800', '60':'3600', '240':'14400', 'D':'86400', 'W':'604800' },
  bitunix:  { '1':'1', '5':'5', '15':'15', '30':'30', '60':'60', '240':'240', 'D':'D', 'W':'W' },
  coinbase: { '1':'60', '5':'300', '15':'900', '30':'1800', '60':'3600', '240':'14400', 'D':'86400', 'W':'86400' } // Fallback weekly to Daily since coinbase does not support 604800s granularities
};

// Map base symbol (e.g. 'BTCUSDT') to exchange-specific format
// Bitstamp & Coinbase use USD (spot), others use USDT
function getSymbolForExchange(symbol, exchangeId) {
  const base = symbol.replace('USDT', '').toUpperCase();
  switch (exchangeId) {
    case 'bybit':
      return symbol; // BTCUSDT
    case 'binance':
      return symbol; // BTCUSDT
    case 'okx':
      return `${base}-USDT`; // BTC-USDT
    case 'mexc':
      return symbol; // BTCUSDT
    case 'bingx':
      return `${base}-USDT`; // BTC-USDT
    case 'bitstamp':
      return `${base.toLowerCase()}usd`; // btcusd
    case 'bitunix':
      return symbol; // BTCUSDT
    case 'coinbase':
      return `${base}-USD`; // BTC-USD
    default:
      return symbol;
  }
}

// Exchange-specific Adapters
const EXCHANGES = {
  bybit: async (symbol, interval, startMs, endMs) => {
    const s = getSymbolForExchange(symbol, 'bybit');
    const iv = INTERVAL_MAP.bybit[interval];
    const url = `https://api.bybit.com/v5/market/kline?category=spot&symbol=${s}&interval=${iv}&start=${startMs}&end=${endMs}&limit=1000`;
    const res = await httpGetJson(url);
    if (res.retCode !== 0) throw new Error(res.retMsg);
    return (res.result?.list || []).map(r => ({
      time: Math.floor(Number(r[0]) / 1000),
      open: parseFloat(r[1]),
      high: parseFloat(r[2]),
      low: parseFloat(r[3]),
      close: parseFloat(r[4]),
      volume: parseFloat(r[5])
    })).reverse();
  },

  binance: async (symbol, interval, startMs, endMs) => {
    const s = getSymbolForExchange(symbol, 'binance');
    const iv = INTERVAL_MAP.binance[interval];
    const url = `https://api.binance.com/api/v3/klines?symbol=${s}&interval=${iv}&startTime=${startMs}&endTime=${endMs}&limit=1000`;
    const res = await httpGetJson(url);
    return res.map(r => ({
      time: Math.floor(Number(r[0]) / 1000),
      open: parseFloat(r[1]),
      high: parseFloat(r[2]),
      low: parseFloat(r[3]),
      close: parseFloat(r[4]),
      volume: parseFloat(r[5])
    }));
  },

  okx: async (symbol, interval, startMs, endMs) => {
    const s = getSymbolForExchange(symbol, 'okx');
    const iv = INTERVAL_MAP.okx[interval];
    const url = `https://www.okx.com/api/v5/market/candles?instId=${s}&bar=${iv}&after=${endMs}&before=${startMs}&limit=1000`;
    const res = await httpGetJson(url);
    if (res.code !== '0') throw new Error(res.msg);
    return (res.data || []).map(r => ({
      time: Math.floor(Number(r[0]) / 1000),
      open: parseFloat(r[1]),
      high: parseFloat(r[2]),
      low: parseFloat(r[3]),
      close: parseFloat(r[4]),
      volume: parseFloat(r[5])
    })).reverse();
  },

  mexc: async (symbol, interval, startMs, endMs) => {
    const s = getSymbolForExchange(symbol, 'mexc');
    const iv = INTERVAL_MAP.mexc[interval];
    const url = `https://api.mexc.com/api/v3/klines?symbol=${s}&interval=${iv}&startTime=${startMs}&endTime=${endMs}&limit=1000`;
    const res = await httpGetJson(url);
    return res.map(r => ({
      time: Math.floor(Number(r[0]) / 1000),
      open: parseFloat(r[1]),
      high: parseFloat(r[2]),
      low: parseFloat(r[3]),
      close: parseFloat(r[4]),
      volume: parseFloat(r[5])
    }));
  },

  bingx: async (symbol, interval, startMs, endMs) => {
    const s = getSymbolForExchange(symbol, 'bingx');
    const iv = INTERVAL_MAP.bingx[interval];
    const url = `https://open-api.bingx.com/openApi/spot/v2/market/kline?symbol=${s}&interval=${iv}&startTime=${startMs}&endTime=${endMs}&limit=1000`;
    const res = await httpGetJson(url);
    if (res.code !== 0) throw new Error(res.msg);
    return (res.data || []).map(r => ({
      time: Math.floor(Number(r.time) / 1000),
      open: parseFloat(r.open),
      high: parseFloat(r.high),
      low: parseFloat(r.low),
      close: parseFloat(r.close),
      volume: parseFloat(r.volume)
    })).reverse();
  },

  bitstamp: async (symbol, interval, startMs, endMs) => {
    const s = getSymbolForExchange(symbol, 'bitstamp');
    const iv = INTERVAL_MAP.bitstamp[interval];
    const startSec = Math.floor(startMs / 1000);
    const endSec = Math.floor(endMs / 1000);
    const url = `https://www.bitstamp.net/api/v2/ohlc/${s}/?step=${iv}&start=${startSec}&end=${endSec}&limit=1000`;
    const res = await httpGetJson(url);
    if (res.errors) throw new Error(JSON.stringify(res.errors));
    return (res.data?.ohlc || []).map(r => ({
      time: Number(r.timestamp),
      open: parseFloat(r.open),
      high: parseFloat(r.high),
      low: parseFloat(r.low),
      close: parseFloat(r.close),
      volume: parseFloat(r.volume)
    }));
  },

  bitunix: async (symbol, interval, startMs, endMs) => {
    const s = getSymbolForExchange(symbol, 'bitunix');
    const iv = INTERVAL_MAP.bitunix[interval];
    const endSec = Math.floor(endMs / 1000);
    const url = `https://openapi.bitunix.com/api/spot/v1/market/kline/history?symbol=${s}&interval=${iv}&endTime=${endSec}&limit=1000`;
    const res = await httpGetJson(url);
    if (res.code !== 0) throw new Error(res.msg);
    // Bitunix history returns oldest first or newest first? Usually history lists [ ... ]
    return (res.data || []).map(r => ({
      time: Number(r.time),
      open: parseFloat(r.open),
      high: parseFloat(r.high),
      low: parseFloat(r.low),
      close: parseFloat(r.close),
      volume: parseFloat(r.volume)
    }));
  },

  coinbase: async (symbol, interval, startMs, endMs) => {
    const s = getSymbolForExchange(symbol, 'coinbase');
    const iv = INTERVAL_MAP.coinbase[interval];
    const startIso = new Date(startMs).toISOString();
    const endIso = new Date(endMs).toISOString();
    const url = `https://api.exchange.coinbase.com/products/${s}/candles?granularity=${iv}&start=${startIso}&end=${endIso}`;
    const res = await httpGetJson(url);
    if (!Array.isArray(res)) throw new Error(JSON.stringify(res));
    return res.map(r => ({
      time: Number(r[0]),
      open: parseFloat(r[3]),
      high: parseFloat(r[2]),
      low: parseFloat(r[1]),
      close: parseFloat(r[4]),
      volume: parseFloat(r[5])
    })).reverse();
  }
};

/**
 * Fetch kline bars for active exchanges and align them into a single timeline.
 * Also computes individual & aggregated CVD.
 */
async function fetchAggregatedCVD(symbol, interval, startMs, endMs, enabledExchanges = []) {
  const activeExchanges = enabledExchanges.filter(id => EXCHANGES[id]);
  if (!activeExchanges.length) activeExchanges.push('bybit'); // Fallback

  const promises = activeExchanges.map(async id => {
    try {
      const bars = await EXCHANGES[id](symbol, interval, startMs, endMs);
      return { id, ok: true, bars };
    } catch (e) {
      console.error(`[CVD Backend] Failed to fetch ${id}:`, e.message);
      return { id, ok: false, error: e.message, bars: [] };
    }
  });

  const results = await Promise.all(promises);
  
  const timeline = new Map();

  for (const r of results) {
    if (!r.ok) continue;
    for (const bar of r.bars) {
      const t = bar.time;
      const h = bar.high, l = bar.low, c = bar.close, v = bar.volume;
      let delta = 0;
      if (h > l && v > 0) {
        delta = v * (((c - l) - (h - c)) / (h - l));
      }
      if (!timeline.has(t)) {
        timeline.set(t, new Map());
      }
      timeline.get(t).set(r.id, delta);
    }
  }

  const times = Array.from(timeline.keys()).sort((a, b) => a - b);
  
  let cumDelta = 0;
  const cvdBars = times.map(t => {
    const exchangeDeltas = timeline.get(t);
    let barDelta = 0;
    
    for (const exId of activeExchanges) {
      if (exchangeDeltas.has(exId)) {
        barDelta += exchangeDeltas.get(exId);
      }
    }

    cumDelta += barDelta;
    return {
      time: t,
      delta: barDelta,
      cvd: cumDelta
    };
  });

  return {
    symbol,
    interval,
    exchanges: results.map(r => ({ id: r.id, ok: r.ok, count: r.bars.length, error: r.error })),
    data: cvdBars
  };
}

module.exports = { fetchAggregatedCVD };
