'use strict';
const https = require('https');

/**
 * Fetch klines from Bybit public REST API (no auth needed).
 *
 * symbol   – full symbol e.g. 'BTCUSDT', '1000PEPEUSDT'
 * interval – Bybit interval: '1','3','5','15','30','60','120','240','D','W'
 * startMs  – start time in milliseconds (inclusive)
 * endMs    – end time in milliseconds (exclusive)
 *
 * Returns array of bars sorted oldest → newest.
 * Bybit limits 1000 bars per call; caller is responsible for pagination.
 */
function fetchKlines(symbol, interval, startMs, endMs) {
  const url =
    `https://api.bybit.com/v5/market/kline` +
    `?category=linear&symbol=${encodeURIComponent(symbol)}` +
    `&interval=${interval}&start=${Math.floor(startMs)}&end=${Math.floor(endMs)}&limit=1000`;

  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 12000 }, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try {
          const j = JSON.parse(raw);
          if (j.retCode !== 0) return reject(new Error(`Bybit kline: ${j.retMsg}`));
          // list format: [openTime, open, high, low, close, volume, turnover]
          // Bybit returns newest-first → reverse for oldest-first
          const bars = (j.result?.list || [])
            .map(r => ({
              time:   Math.floor(Number(r[0]) / 1000), // Unix seconds
              open:   parseFloat(r[1]),
              high:   parseFloat(r[2]),
              low:    parseFloat(r[3]),
              close:  parseFloat(r[4]),
              volume: parseFloat(r[5])
            }))
            .reverse();
          resolve(bars);
        } catch (e) { reject(e); }
      });
    });
    req.on('error',   reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('bybitKlines timeout')); });
  });
}

/**
 * Fetch klines in multiple pages to cover the full startMs–endMs range.
 * Returns merged array sorted oldest → newest (deduped by time).
 */
async function fetchKlinesFull(symbol, interval, startMs, endMs) {
  const allBars = [];
  const seen    = new Set();
  let cursor    = startMs;

  while (cursor < endMs) {
    const batch = await fetchKlines(symbol, interval, cursor, endMs);
    if (!batch.length) break;
    for (const b of batch) {
      if (!seen.has(b.time)) { seen.add(b.time); allBars.push(b); }
    }
    // advance cursor past the last returned bar
    const lastT = batch[batch.length - 1].time * 1000;
    if (lastT <= cursor) break; // safety: no progress
    cursor = lastT + 1;
    if (batch.length < 1000) break; // last page
  }

  return allBars.sort((a, b) => a.time - b.time);
}

module.exports = { fetchKlines, fetchKlinesFull };
