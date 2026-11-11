// Test: core_ha.js (persistensi config, clamp, debounce push ke engine, refetch/render)
const fs = require('fs'), path = require('path'), vm = require('vm');
const code = fs.readFileSync(path.join(__dirname, '..', 'tools', 'core_parts', 'core_ha.js'), 'utf8');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const ok = (n, c, x) => { console.log((c ? 'PASS' : 'FAIL') + '  ' + n + (x ? '  ' + x : '')); if (!c) fails++; };

function mk(stored) {
  const store = Object.assign({}, stored || {});
  const st = { pushes: [], fetches: 0, renders: 0 };
  const ctx = {
    localStorage: { getItem: k => (k in store ? String(store[k]) : null), setItem: (k, v) => { store[k] = String(v); } },
    api: { haConfig: async o => { st.pushes.push(o); return { ok: true }; } },
    indicators: { ha: true },
    fetchHA: async () => { st.fetches++; },
    render: () => { st.renders++; },
    console, setTimeout, clearTimeout, parseInt, isNaN, Math, Object
  };
  vm.createContext(ctx);
  vm.runInContext(code + '\n;this.__h = { haConfig, HA_DEFAULTS, setHa, startHaConfig };', ctx);
  return { h: ctx.__h, store, st, ctx };
}

(async () => {
  let t = mk();
  ok('default (tanpa pref tersimpan) = 2.0x / 100 / 22%', t.h.haConfig.stdevTenth === 20 && t.h.haConfig.lookback === 100 && t.h.haConfig.wickPct === 22, JSON.stringify(t.h.haConfig));

  t = mk({ hf_ha_stdevTenth: 35, hf_ha_lookback: 250, hf_ha_wickPct: 30 });
  ok('config tersimpan dimuat saat start', t.h.haConfig.stdevTenth === 35 && t.h.haConfig.lookback === 250 && t.h.haConfig.wickPct === 30);

  t = mk({ hf_ha_stdevTenth: 'abc', hf_ha_lookback: 99999, hf_ha_wickPct: -5 });
  ok('nilai tersimpan rusak/di luar batas -> default / di-clamp', t.h.haConfig.stdevTenth === 20 && t.h.haConfig.lookback === 500 && t.h.haConfig.wickPct === 5, JSON.stringify(t.h.haConfig));

  t = mk();
  t.h.startHaConfig(); await sleep(350);
  ok('start: config dikirim ke engine (tanpa refetch)', t.st.pushes.length === 1 && t.st.pushes[0].lookback === 100 && t.st.pushes[0].stdevMult === 2 && t.st.fetches === 0, JSON.stringify(t.st.pushes));

  t = mk();
  for (let v = 21; v <= 40; v++) t.h.setHa('stdevTenth', v);       // simulasi drag slider (20 event)
  await sleep(450);
  ok('drag slider didebounce: 1x push ke engine', t.st.pushes.length === 1, 'pushes=' + t.st.pushes.length);
  ok('push membawa nilai terakhir (4.0x)', t.st.pushes[0] && t.st.pushes[0].stdevMult === 4 && t.st.pushes[0].lookback === 100, JSON.stringify(t.st.pushes[0]));
  ok('refetch HA + render setelah push', t.st.fetches === 1 && t.st.renders >= 20, `fetch=${t.st.fetches} render=${t.st.renders}`);
  ok('nilai disimpan ke prefs', t.store.hf_ha_stdevTenth === '40');

  t = mk();
  t.h.setHa('wickPct', 35); await sleep(350);
  ok('wick hanya re-render (tidak push ke engine)', t.st.pushes.length === 0 && t.st.renders === 1 && t.store.hf_ha_wickPct === '35');

  t = mk();
  t.h.setHa('lookback', 5); t.h.setHa('stdevTenth', 'xyz'); await sleep(350);
  ok('setHa clamp / nilai invalid', t.h.haConfig.lookback === 20 && t.h.haConfig.stdevTenth === 20, JSON.stringify(t.h.haConfig));
  t.h.setHa('tidakAda', 1);
  ok('key tidak dikenal diabaikan', !('tidakAda' in t.h.haConfig));

  t = mk(); t.ctx.indicators.ha = false;
  t.h.setHa('lookback', 200); await sleep(350);
  ok('indikator HA off: tetap push config, tanpa fetch', t.st.pushes.length === 1 && t.st.fetches === 0);

  console.log(fails === 0 ? '\nSEMUA UJI LULUS' : `\n${fails} UJI GAGAL`);
  process.exit(fails === 0 ? 0 : 1);
})();
