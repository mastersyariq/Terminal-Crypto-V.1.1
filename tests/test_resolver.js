// Test 1: resolver simbol Bybit -> market Binance (data live)
const { loadUniverse, candidates, parseSymbol, fetchBybitLast } = require('../lib/binanceSymbols');
const https = require('https');
function get(url) { return new Promise((res, rej) => { https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 25000 }, r => { const c = []; r.on('data', d => c.push(d)); r.on('end', () => { try { res(JSON.parse(Buffer.concat(c).toString())); } catch (e) { rej(e); } }); }).on('error', rej); }); }
(async () => {
  console.log('parse:', ['XAUUSDT', '1000PEPEUSDT', 'SHIB1000USDT', '10000SATSUSDT', '1000000BABYDOGEUSDT', '1MBABYDOGEUSDT', 'SKYAI1USDT', '1INCHUSDT', 'BTCUSDT-06NOV26', 'ETHUSDC'].map(s => { const p = parseSymbol(s); return s + '=>' + (p ? p.core + 'x' + p.mult : 'null'); }).join(' | '));
  const uni = await loadUniverse();
  console.log('universe:', uni && uni.nSpot, 'spot', uni && uni.nFut, 'futures');
  const show = s => console.log(s.padEnd(22), JSON.stringify(candidates(s, uni).map(c => `${c.market}:${c.sym}x${c.scale}`)));
  ['XAUUSDT', 'XAGUSDT', 'AAPLUSDT', 'TSLAUSDT', 'BTCUSDT', 'ETHUSDT', '1000PEPEUSDT', 'SHIB1000USDT', '10000SATSUSDT', '1000000BABYDOGEUSDT', '1000TURBOUSDT', 'PAXGUSDT', 'EURUSDUSDT', 'DOESNOTEXISTUSDT', 'BTCUSDT-06NOV26'].forEach(show);
  console.log('-- guess mode (tanpa universe):');
  ['XAUUSDT', '1000PEPEUSDT'].forEach(s => console.log(s.padEnd(22), JSON.stringify(candidates(s, null).map(c => `${c.market}:${c.sym}x${c.scale}`))));
  console.log('Bybit last XAUUSDT:', await fetchBybitLast('XAUUSDT'), '| BTCUSDT:', await fetchBybitLast('BTCUSDT'), '| nonexist:', await fetchBybitLast('ZZZZZUSDT'));

  // Cakupan: berapa perp Bybit USDT yang punya >=1 kandidat Binance (sebelum vs sesudah perbaikan)
  const by = await get('https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000');
  const list = (by.result.list || []).filter(x => x.quoteCoin === 'USDT' && x.status === 'Trading' && /USDT$/.test(x.symbol)).map(x => x.symbol);
  const spotOnly = uni.spot ? list.filter(s => candidates(s, { spot: uni.spot, fut: null, }).some(c => c.market === 'spot')).length : -1;
  // spot-only murni (tanpa tebakan futures): gunakan universe tanpa fut
  const onlySpot = list.filter(s => { const p = parseSymbol(s); return p && (uni.spot.get(p.core) || []).length > 0; }).length;
  const all = list.filter(s => candidates(s, uni).length > 0).length;
  const futN = list.filter(s => candidates(s, uni).some(c => c.market === 'fut')).length;
  const missing = list.filter(s => candidates(s, uni).length === 0);
  console.log(`Bybit USDT perp: ${list.length} | punya market SPOT Binance (cara lama, termasuk multiplier): ${onlySpot} | punya >=1 kandidat (spot atau futures): ${all} | kandidat futures: ${futN}`);
  console.log('tanpa market Binance (' + missing.length + '):', missing.slice(0, 60).join(' '), missing.length > 60 ? '...' : '');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
