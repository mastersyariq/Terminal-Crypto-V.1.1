// Test 3: logika chart (core_liquidity.js, dibaca apa adanya) di atas data recorder live — agregasi Peak/Avg/Close + teks status
const fs = require('fs'), path = require('path'), vm = require('vm');
const { LiquidityRecorder } = require('../lib/liquidityBook');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const code = fs.readFileSync(path.join(__dirname, '..', 'tools', 'core_parts', 'core_liquidity.js'), 'utf8');
const ctx = { localStorage: { getItem: () => null, setItem: () => {} }, sym: 'XAUUSDT', console, Math, Float64Array, Uint8Array, Float32Array, Number, Date, isNaN, parseInt, String, Array, Object, JSON };
vm.createContext(ctx);
vm.runInContext(code + '\n;this.__t = { liqCandleBins, liqMinutes, liqStatusText, liqConfig, setLiq: typeof setLiq };', ctx);
const T = ctx.__t;

(async () => {
  console.log('config keys:', Object.keys(T.liqConfig).join(','), '| okx/binance toggle ada?', 'okx' in T.liqConfig || 'binance' in T.liqConfig);
  // status text
  console.log('status null  :', T.liqStatusText(null));
  console.log('status unav. :', T.liqStatusText({ symbol: 'XAUUSDT', status: { binance: 'unavailable' }, minutes: [], cur: null, source: '' }));
  console.log('status ok fut:', T.liqStatusText({ symbol: 'XAUUSDT', status: { binance: 'ok' }, minutes: [1, 2], cur: {}, source: 'FUT XAUUSDT' }));

  // data live: >1 menit supaya ada record menit selesai + record berjalan
  const rec = new LiquidityRecorder();
  const origSave = rec._save.bind(rec); rec._save = () => {};      // jangan menulis file saat uji
  const st = rec.follow('XAUUSDT');
  const t0 = Date.now();
  await sleep(75000);
  const minutes = T.liqMinutes(st);
  console.log(`\nrecorded: ${minutes.length} record menit (${((Date.now() - t0) / 1000).toFixed(0)}s), source=${st.source}, status=${JSON.stringify(st.status)}, bin=${st.bin}`);
  const first = minutes[0].t, endT = minutes[minutes.length - 1].t + 60;
  const binLo = Math.floor((st.mid * 0.985) / st.bin), nBins = Math.ceil((st.mid * 0.03) / st.bin);
  const out = {};
  for (const mode of [0, 1, 2]) {
    const arr = new Float64Array(nBins);
    const nm = T.liqCandleBins(minutes, first, endT, binLo, nBins, mode, arr);
    let nz = 0, mx = 0, sum = 0; for (const v of arr) { if (v > 0) nz++; if (v > mx) mx = v; sum += v; }
    out[mode] = arr;
    console.log(`mode ${mode} (${['PEAK', 'AVG', 'CLOSE'][mode]}): minutes=${nm} nonzero=${nz}/${nBins} max=${mx.toFixed(0)} total=${sum.toFixed(0)}`);
  }
  let violations = 0; for (let i = 0; i < nBins; i++) if (out[1][i] > out[0][i] * 1.0001) violations++;
  console.log('invarian AVG <= PEAK di semua bin:', violations === 0 ? 'OK' : 'GAGAL (' + violations + ')');
  // CLOSE harus sama dengan array `last` menit terakhir
  const lastM = minutes[minutes.length - 1]; let diff = 0;
  for (let k = 0; k < nBins; k++) { const kk = binLo + k - lastM.lo; const v = (kk >= 0 && kk < lastM.n) ? lastM.last[kk] : 0; if (Math.abs(v - out[2][k]) > 1e-3 * Math.max(1, v)) diff++; }
  console.log('CLOSE == last menit terakhir:', diff === 0 ? 'OK' : 'GAGAL (' + diff + ' bin beda)');
  rec.binance.stop(); clearInterval(rec._timer); clearInterval(rec._saveTimer);
  process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
