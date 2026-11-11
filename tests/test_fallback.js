// Test 4: aturan fallback — spot diutamakan; perpetual hanya bila spot gagal 3x; perpetual gagal 3x = tidak ada data; spot pulih = kembali ke spot
const { BinanceBook } = require('../lib/liquidityBook');
const { fetchBybitLast } = require('../lib/binanceSymbols');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function mk(symbol, cands, ci) {
  const b = new BinanceBook();
  b.symbol = symbol; b._sess++; b.cands = cands; b.ci = ci || 0;
  b.refPrice = await fetchBybitLast(symbol); b._refAt = Date.now(); b._refP = Promise.resolve();
  return b;
}
async function watch(b, label, maxMs, stopWhen) {
  const t0 = Date.now(); let last = '';
  while (Date.now() - t0 < maxMs) {
    const cur = `${b.status} | ${b.source || '-'} | fails=${b._fails}`;
    if (cur !== last) { console.log(`  [${((Date.now() - t0) / 1000).toFixed(1)}s] ${label}: ${cur}`); last = cur; }
    if (stopWhen && stopWhen(b)) break;
    await sleep(250);
  }
  return Date.now() - t0;
}

(async () => {
  console.log('\nA) spot TIDAK valid (NOPEUSDT) -> harus gagal 3x lalu fallback ke perpetual XAUUSDT');
  let b = await mk('XAUUSDT', [{ market: 'spot', sym: 'NOPEUSDT', scale: 1 }, { market: 'fut', sym: 'XAUUSDT', scale: 1 }]);
  b._begin();
  let ms = await watch(b, 'A', 40000, x => x.status === 'ok');
  console.log(`  => hasil: status=${b.status} source=${b.source} spotSkipped=${b._spotSkipped} (${(ms / 1000).toFixed(1)}s)`);
  const okA = b.status === 'ok' && b.market === 'fut' && b._spotSkipped === true;
  b.stop();

  console.log('\nB) spot & perpetual sama-sama tidak valid -> 3x + 3x gagal = unavailable (+ restart terjadwal)');
  b = await mk('XAUUSDT', [{ market: 'spot', sym: 'NOPEUSDT', scale: 1 }, { market: 'fut', sym: 'NOPE2USDT', scale: 1 }]);
  b._begin();
  ms = await watch(b, 'B', 60000, x => x.status === 'unavailable');
  console.log(`  => hasil: status=${b.status} err=${b.lastError} restartTimer=${!!b._timers.restart} (${(ms / 1000).toFixed(1)}s)`);
  const okB = b.status === 'unavailable' && !!b._timers.restart;
  b.stop();

  console.log('\nC) spot valid (BTCUSDT) -> harus tetap SPOT, tanpa fallback');
  b = await mk('BTCUSDT', [{ market: 'spot', sym: 'BTCUSDT', scale: 1 }, { market: 'fut', sym: 'BTCUSDT', scale: 1 }]);
  b._begin();
  ms = await watch(b, 'C', 30000, x => x.status === 'ok');
  const okC = b.status === 'ok' && b.market === 'spot' && b._fails === 0 && b._spotSkipped === false;
  console.log(`  => hasil: status=${b.status} source=${b.source} (${(ms / 1000).toFixed(1)}s)`);

  console.log('\nD) gangguan setelah pernah sinkron TIDAK memindahkan sumber (spot tetap)');
  const before = b.sym; let sw = false;
  for (let i = 0; i < 6; i++) if (b._failed('simulasi gangguan')) sw = true;
  console.log(`  => 6x _failed setelah sinkron: pindah sumber=${sw} sumber=${b.source} (harus ${before} tetap)`);
  const okD = !sw && b.sym === before && b.market === 'spot';
  b.stop();

  console.log('\nE) di fallback perpetual karena spot sempat gagal -> spot dicek ulang & kembali ke spot saat pulih');
  b = await mk('BTCUSDT', [{ market: 'spot', sym: 'BTCUSDT', scale: 1 }, { market: 'fut', sym: 'BTCUSDT', scale: 1 }], 1);
  b._spotSkipped = true; b.reprobeMs = 5000;
  b._begin();
  ms = await watch(b, 'E', 40000, x => x.market === 'spot' && x.status === 'ok');
  const okE = b.market === 'spot' && b.status === 'ok' && b._spotSkipped === false;
  console.log(`  => hasil: status=${b.status} source=${b.source} (${(ms / 1000).toFixed(1)}s)`);
  b.stop();

  console.log('\nRINGKASAN:', JSON.stringify({ A_fallback_after_3_fails: okA, B_no_data_after_3_plus_3: okB, C_spot_priority: okC, D_no_switch_after_synced: okD, E_return_to_spot: okE }));
  process.exit(okA && okB && okC && okD && okE ? 0 : 1);
})().catch(e => { console.error('FAIL', e); process.exit(2); });
