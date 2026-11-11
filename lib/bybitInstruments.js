'use strict';

/**
 * Bybit Instruments Info
 * Fetches pair metadata from Bybit REST API including launchTime.
 * Used to know when a pair was listed so the scroll loop knows when to stop.
 *
 * Uses api.bytick.com (Bybit's mirror domain) as primary endpoint —
 * more resilient against regional ISP-level blocking/SSL interception
 * of api.bybit.com. Falls back to api.bybit.com if the mirror fails.
 */

const https = require('https');

let _cache    = null;  // { [symbol]: { launchTime, baseCoin, status } }
let _cacheTs  = 0;
const CACHE_TTL = 3600_000; // 1 hour

/**
 * Fetch all linear perpetual instruments from Bybit.
 * Returns a Map: symbol (e.g. 'BTCUSDT') → { launchTime(ms), baseCoin, status }
 */
async function fetchInstruments() {
  if (_cache && Date.now() - _cacheTs < CACHE_TTL) return _cache;

  const pages = [];
  let cursor  = '';

  do {
    const url = `https://api.bytick.com/v5/market/instruments-info?category=linear&limit=1000${cursor ? '&cursor=' + cursor : ''}`;
    let page = await _get(url);
    if (!page?.result?.list?.length) {
      const url2 = `https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000${cursor ? '&cursor=' + cursor : ''}`;
      page = await _get(url2);
    }
    if (!page?.result?.list?.length) break;
    pages.push(...page.result.list);
    cursor = page.result.nextPageCursor || '';
  } while (cursor);

  const result = {};
  pages.forEach(item => {
    if (item.contractType !== 'LinearPerpetual') return;
    result[item.symbol] = {
      symbol:     item.symbol,
      baseCoin:   item.baseCoin,
      quoteCoin:  item.quoteCoin,
      launchTime: item.launchTime ? parseInt(item.launchTime) : null,
      tickSize:   item.priceFilter && item.priceFilter.tickSize ? parseFloat(item.priceFilter.tickSize) : null,
      status:     item.status
    };
  });

  _cache   = result;
  _cacheTs = Date.now();
  console.log(`[Instruments] Loaded ${Object.keys(result).length} Bybit linear pairs with launch times`);
  return result;
}

async function getLaunchTime(symbol) {
  const instruments = await fetchInstruments();
  return instruments[symbol]?.launchTime ?? null;
}

async function getInstrumentInfo(symbol) {
  const instruments = await fetchInstruments();
  return instruments[symbol] ?? null;
}

async function enrichPairsWithLaunchTime(pairs) {
  try {
    const instruments = await fetchInstruments();
    return pairs.map(p => ({
      ...p,
      launchTime: instruments[p.symbol]?.launchTime ?? null,
      status:     instruments[p.symbol]?.status ?? 'Trading'
    }));
  } catch (e) {
    console.error('[Instruments] Failed to enrich:', e.message);
    return pairs;
  }
}

function _get(url) {
  return new Promise(resolve => {
    const req = https.get(url, { headers: { 'User-Agent': 'HFTerminal/1.0' } }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(10000, () => { req.destroy(); resolve(null); });
  });
}

module.exports = { fetchInstruments, getLaunchTime, getInstrumentInfo, enrichPairsWithLaunchTime };
