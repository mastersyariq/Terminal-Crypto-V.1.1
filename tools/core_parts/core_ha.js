// ════════════════════════════════════════════════
// HEAVY ABSORPTION — konfigurasi threshold
//
// Sinyal muncul bila volume melewati threshold adaptif:
//     threshold = mean + (multiplier × stdev)   dari `lookback` bar sebelumnya
// Dipakai di DUA tempat (parameter yang sama):
//   1) deteksi berbasis trade live (print terbesar per bar) → dihitung di lib/store.js; config dikirim ke engine (api.haConfig)
//   2) deteksi berbasis candle (volume bar, history)       → getHeavyAbsorptionDetections() di chart (lihat patch di tools/build_core.js)
// `wickPct` hanya untuk (2): ambang minimal sumbu candle (% dari range) untuk menentukan arah Buy/Sell.
// DEFAULT = perilaku lama: multiplier 2.0× · lookback 100 bar · wick 22%.
// ════════════════════════════════════════════════
const HA_DEFAULTS = { stdevTenth: 20, lookback: 100, wickPct: 22 };       // stdevTenth = multiplier × 10 (20 → 2.0×)
const HA_SPEC = { stdevTenth: [5, 60], lookback: [20, 500], wickPct: [5, 50] };

const haConfig = (function () {
  const out = {};
  for (const k of Object.keys(HA_DEFAULTS)) {
    const sp = HA_SPEC[k];
    const v = parseInt(localStorage.getItem('hf_ha_' + k));
    out[k] = isNaN(v) ? HA_DEFAULTS[k] : Math.max(sp[0], Math.min(sp[1], v));
  }
  return out;
})();

let haPushTimer = null;
/** Kirim lookback + multiplier ke engine (deteksi berbasis trade). Didebounce supaya drag slider tidak memproses ulang berkali-kali. */
function haPush(refetch) {
  clearTimeout(haPushTimer);
  haPushTimer = setTimeout(async () => {
    haPushTimer = null;
    try { if (api.haConfig) await api.haConfig({ lookback: haConfig.lookback, stdevMult: haConfig.stdevTenth / 10 }); }
    catch (e) { console.warn('[HA] gagal mengirim config ke engine:', e && e.message ? e.message : e); }
    if (refetch && indicators.ha) { await fetchHA(); render(); }
  }, 200);
}

function setHa(key, value) {
  const sp = HA_SPEC[key];
  if (!sp) return;
  let v = parseInt(value);
  if (isNaN(v)) v = HA_DEFAULTS[key];
  v = Math.max(sp[0], Math.min(sp[1], v));
  haConfig[key] = v;
  localStorage.setItem('hf_ha_' + key, v);
  if (key !== 'wickPct') haPush(true);      // multiplier & lookback juga dipakai deteksi berbasis trade di engine
  render();
}

/** Dipanggil saat start: samakan engine dengan config tersimpan (engine selalu mulai dari default). */
function startHaConfig() { haPush(false); }

