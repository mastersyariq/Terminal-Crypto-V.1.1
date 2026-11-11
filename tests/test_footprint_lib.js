// Test: lib/footprint.js (agregasi per menit per level harga, query per TF, persistensi) + wiring Engine
const fs = require('fs'), os = require('os'), path = require('path');
const { FootprintBook, baseBucket, candleTime, levelIndex, niceUp } = require('../lib/footprint');
let fails = 0;
const ok = (n, c, x) => { console.log((c ? 'PASS' : 'FAIL') + '  ' + n + (x !== undefined ? '  ' + x : '')); if (!c) fails++; };
const near = (a, b, e) => Math.abs(a - b) <= (e || 1e-9);

// ── base bucket relatif harga, kelipatan tick ──
ok('niceUp', niceUp(0.3) === 1 && niceUp(1.0000000001) === 1 && niceUp(1.5) === 2 && niceUp(3) === 5 && niceUp(6.5) === 10 && niceUp(65) === 100 && niceUp(35) === 50);
const cases = [['BTC 65000 tick .1', 65000, 0.1, 10], ['ETH 3500 tick .01', 3500, 0.01, 0.5], ['XRP 0.5 tick .0001', 0.5, 0.0001, 0.0001], ['SOL 150 tick .01', 150, 0.01, 0.02], ['XAU 4050 tick .01', 4050, 0.01, 0.5], ['BTC tick tak diketahui', 65000, 0, 10], ['harga kecil tick besar', 12, 5, 5]];
for (const [n, p, t, exp] of cases) { const b = baseBucket(p, t); ok('base ' + n + ' = ' + exp, near(b, exp, exp * 1e-9), b); }
for (const [n, p, t] of cases) { if (t > 0) { const b = baseBucket(p, t), q = b / t; ok('base ' + n + ' kelipatan tick', Math.abs(q - Math.round(q)) < 1e-6); } }
ok('levelIndex tahan noise float (0.3/0.1)', levelIndex(0.3, 0.1) === 3 && levelIndex(65430.1, 10) === 6543 && levelIndex(65439.9, 10) === 6543 && levelIndex(65440, 10) === 6544);

// ── candle time ──
const T0 = Date.UTC(2026, 10, 2, 0, 0, 0) / 1000;      // Senin 2026-11-02 00:00 UTC
ok('candleTime 1h/4h/1d', candleTime(T0 + 3600 * 5 + 99, 3600) === T0 + 3600 * 5 && candleTime(T0 + 3600 * 5, 14400) === T0 + 14400 && candleTime(T0 + 86400 * 2 + 5, 86400) === T0 + 86400 * 2);
ok('candleTime mingguan mulai Senin', candleTime(T0 + 86400 * 3 + 50, 604800) === T0 && candleTime(T0 + 86400 * 7 + 1, 604800) === T0 + 604800 && new Date(candleTime(T0 + 86400 * 5, 604800) * 1000).getUTCDay() === 1);

// ── agregasi ──
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-test-'));
let fp = new FootprintBook({ dir });
fp.follow('BTCUSDT');
// trade sebelum tick diketahui ditahan (pending) lalu diproses
fp.addTrade('BTCUSDT', { time: T0 + 10, price: 65431.2, volume: 0.5, side: 'Buy' });
fp.addTrade('BTCUSDT', { time: T0 + 20, price: 65438.0, volume: 0.25, side: 'Sell' });
ok('trade ditahan sebelum tick siap', fp.stats('BTCUSDT').pending === 2 && fp.stats('BTCUSDT').levels === 0);
fp.setTick('BTCUSDT', 0.1);
let st = fp.stats('BTCUSDT');
ok('setTick memproses pending, base=10', st.pending === 0 && near(st.base, 10) && st.levels === 1, JSON.stringify(st));
fp.addTrade('BTCUSDT', { time: T0 + 70, price: 65441.0, volume: 1, side: 'Buy' });      // menit berikutnya, level +1
fp.addTrade('BTCUSDT', { time: T0 + 75, price: 65431.2, volume: 0.1, side: 'Sell' });
fp.addTrade('BTCUSDT', { time: T0 + 3700, price: 65500, volume: 2, side: 'Sell' });      // jam berikutnya
fp.addTrade('BTCUSDT', { time: T0 + 5, price: 0, volume: 1, side: 'Buy' });               // invalid -> diabaikan
fp.addTrade('BTCUSDT', { time: T0 + 5, price: 65000, volume: 0, side: 'Buy' });           // invalid -> diabaikan
fp.addTrade('XYZUSDT', { time: T0 + 5, price: 1, volume: 1, side: 'Buy' });               // simbol tak diikuti -> diabaikan
const q1m = fp.query('BTCUSDT', 60), q1h = fp.query('BTCUSDT', 3600), q5m = fp.query('BTCUSDT', 300);
ok('query 1m: 3 candle', q1m.data.length === 3, q1m.data.map(d => d[0] - T0).join(','));
const toMap = flat => { const m = {}; for (let i = 0; i < flat.length; i += 3) m[flat[i]] = [flat[i + 1], flat[i + 2]]; return m; };
const h0 = toMap(q1h.data[0][1]);
ok('query 1h: candle pertama menggabungkan 2 menit', q1h.data.length === 2 && q1h.data[0][0] === T0, JSON.stringify(h0));
ok('level 6543 (65430-65440): buy 0.5, sell 0.25+0.1', near(h0[6543][0], 0.5) && near(h0[6543][1], 0.35));
ok('level 6544 (65440-65450): buy 1', near(h0[6544][0], 1) && near(h0[6544][1], 0));
ok('query 5m: 2 candle (T0 dan jam berikutnya)', q5m.data.length === 2 && q5m.data[0][0] === T0);
const totBuy = q1h.data.flatMap(d => { const m = toMap(d[1]); return Object.values(m).map(v => v[0]); }).reduce((a, b) => a + b, 0);
ok('konservasi volume antar TF (buy total = 1.5)', near(totBuy, 1.5));
ok('maxCandles membatasi hasil (ambil yang terbaru)', fp.query('BTCUSDT', 60, 2).data.length === 2 && fp.query('BTCUSDT', 60, 2).data[1][0] === candleTime(T0 + 3700, 60));
ok('simbol tak dikenal -> kosong', fp.query('NOPE', 60).data.length === 0 && fp.query('NOPE', 60).base === 0);

// ── persistensi ──
fp.stop();
ok('file tersimpan', fs.existsSync(path.join(dir, 'BTCUSDT.json.gz')));
const fp2 = new FootprintBook({ dir });
fp2.follow('BTCUSDT');
const s2 = fp2.stats('BTCUSDT');
ok('muat dari disk: base & menit sama', near(s2.base, 10) && s2.minutes === 3, JSON.stringify(s2));
fp2.setTick('BTCUSDT', 0.1);
const q2 = fp2.query('BTCUSDT', 3600);
ok('hasil query identik setelah muat ulang', JSON.stringify(q2.data) === JSON.stringify(q1h.data));
fp2.addTrade('BTCUSDT', { time: T0 + 11, price: 65432, volume: 1, side: 'Buy' });
ok('lanjut merekam setelah muat', near(toMap(fp2.query('BTCUSDT', 3600).data[0][1])[6543][0], 1.5));
fp2.stop();

// tickSize berubah / data lama dari tebakan -> base di-REBASE (volume terjaga), bukan dibuang
const totalVol = fpb => { let b = 0, s = 0; for (const [, flat] of fpb.query('BTCUSDT', 60).data) for (let i = 0; i < flat.length; i += 3) { b += flat[i + 1]; s += flat[i + 2]; } return [b, s]; };
const fp3 = new FootprintBook({ dir });
fp3.follow('BTCUSDT');
const volBefore = (() => { const t = new FootprintBook({ dir }); t.follow('BTCUSDT'); t.setTick('BTCUSDT', 0.1); return totalVol(t); })();
fp3.setTick('BTCUSDT', 4);        // 10 bukan kelipatan 4
const s3 = fp3.stats('BTCUSDT'), volAfter = totalVol(fp3);
ok('tickSize tidak cocok dengan base tersimpan -> rebase (data tetap ada)', s3.minutes === 3 && s3.base > 0 && s3.base % 4 === 0, JSON.stringify(s3));
ok('rebase menjaga total volume buy & sell', near(volAfter[0], volBefore[0], 1e-9) && near(volAfter[1], volBefore[1], 1e-9), JSON.stringify([volBefore, volAfter]));
fp3.addTrade('BTCUSDT', { time: T0, price: 65000, volume: 1, side: 'Buy' });
ok('merekam lanjut memakai base baru', fp3.stats('BTCUSDT').base === s3.base && fp3.stats('BTCUSDT').trades === 1);
fp3.stop();

// tickSize tak kunjung tiba -> fallback timer (tebakan) lalu di-rebase saat tickSize asli datang
const fp6 = new FootprintBook({ dir: path.join(dir, 'fb'), persist: false, tickWaitMs: 60 });
fp6.follow('XRPUSDT');
fp6.addTrade('XRPUSDT', { time: T0 + 5, price: 0.5012, volume: 100, side: 'Buy' });
fp6.addTrade('XRPUSDT', { time: T0 + 6, price: 0.5047, volume: 40, side: 'Sell' });
ok('sebelum tickSize: trade ditahan', fp6.stats('XRPUSDT').pending === 2 && fp6.stats('XRPUSDT').base === 0);
setTimeout(() => {
  const a = fp6.stats('XRPUSDT');
  ok('fallback timer: pending diproses dgn tebakan tick', a.pending === 0 && a.tickReady && a.base > 0 && a.minutes === 1, JSON.stringify(a));
  const guessBase = a.base;
  fp6.addTrade('XRPUSDT', { time: T0 + 7, price: 0.5030, volume: 10, side: 'Buy' });
  fp6.setTick('XRPUSDT', 0.0001);
  const b = fp6.stats('XRPUSDT');
  const q = b.base / 0.0001;
  ok('tickSize asli datang belakangan: base jadi kelipatan tick asli', Math.abs(q - Math.round(q)) < 1e-6 && b.base >= 0.0001 - 1e-12, `tebakan ${guessBase} -> ${b.base}`);
  const qd = fp6.query('XRPUSDT', 60); let bu = 0, se = 0; for (const [, flat] of qd.data) for (let i = 0; i < flat.length; i += 3) { bu += flat[i + 1]; se += flat[i + 2]; }
  ok('rebase saat tickSize asli datang menjaga volume (buy 110, sell 40)', near(bu, 110, 1e-9) && near(se, 40, 1e-9), `${bu}/${se}`);
  fp6.setTick('XRPUSDT', 0.5);
  ok('setTick berikutnya diabaikan (tickSize asli hanya sekali)', fp6.stats('XRPUSDT').tick === 0.0001);

  finish();
}, 150);

function finish() {

// fallback tick otomatis (timer) & LRU
const fp4 = new FootprintBook({ dir: path.join(dir, 'lru'), persist: false });
for (let i = 0; i < 8; i++) { fp4.follow('S' + i + 'USDT'); fp4.setTick('S' + i + 'USDT', 0.1); }
ok('LRU: maksimal 6 simbol di memori', fp4.books.size === 6 && !fp4.books.has('S0USDT') && fp4.books.has('S7USDT'));

// file korup tidak membuat crash
fs.writeFileSync(path.join(dir, 'BADUSDT.json.gz'), 'bukan gzip');
const fp5 = new FootprintBook({ dir });
let crashed = false; try { fp5.follow('BADUSDT'); } catch (e) { crashed = true; }
ok('file korup diabaikan tanpa crash', !crashed && fp5.stats('BADUSDT') && fp5.stats('BADUSDT').minutes === 0);
fp5.stop();

// ── Engine wiring ──
const { Engine } = require('../nodegui/engine.js');
const eng = new Engine();
ok('Engine punya footprint & getFootprint', !!eng.footprint && typeof eng.getFootprint === 'function');
eng.footprint = new FootprintBook({ dir: path.join(dir, 'eng'), persist: false });
eng.footprint.follow('BTCUSDT'); eng.footprint.setTick('BTCUSDT', 0.1);
const store = require('../lib/store');
store.symbol = 'BTCUSDT'; store.timeframe = '60';
eng.handleTrade({ time: T0 + 10, timeMs: (T0 + 10) * 1000, price: 65432, volume: 0.4, side: 'Buy', symbol: 'BTCUSDT' });
eng.handleTrade({ time: T0 + 11, timeMs: (T0 + 11) * 1000, price: 65433, volume: 0.1, side: 'Sell', symbol: 'ETHUSDT' });   // simbol lain -> tidak tercampur
const gf = eng.getFootprint();
ok('engine.getFootprint: simbol/tf/base benar', gf.ok && gf.symbol === 'BTCUSDT' && gf.timeframe === '60' && near(gf.base, 10), JSON.stringify({ s: gf.symbol, tf: gf.timeframe, b: gf.base }));
const gm = toMap(gf.data[0][1]);
ok('trade simbol lain tidak ikut tercatat', gf.data.length === 1 && near(gm[6543][0], 0.4) && near(gm[6543][1], 0), JSON.stringify(gm));
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(fails === 0 ? '\nSEMUA UJI LULUS' : `\n${fails} UJI GAGAL`);
  process.exit(fails === 0 ? 0 : 1);
}
