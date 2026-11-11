# Hedge Fund Terminal — versi NodeGUI (tanpa port / tanpa browser)

UI memakai **NodeGUI (Qt)**. Tidak ada server HTTP, tidak ada `localhost:3000`, tidak ada SSE.
Engine data (TradingView CDP, Bybit REST/WS, cache, CVD, kalender, drawings) berjalan **satu proses** dengan UI.
(Satu-satunya koneksi lokal adalah CDP ke TradingView Desktop `:9333` — sama seperti versi asli.)

## Menjalankan

- Dobel-klik `start.vbs` (tanpa console), atau
- `npm start` / `npm run gui`
- Log: `nodegui.log`
- Versi browser lama masih ada: `npm run web` (`server.js` + `public/index.html`, identik dengan backup asli).

## Struktur

```
nodegui/
  main.js              window utama + wiring semua komponen
  engine.js            port 1:1 dari server.js asli (REST/SSE -> method + EventEmitter)
  canvas2d.js          Canvas2D API di atas QPainter (clip, dash, teks, alpha dikerjakan manual)
  prefs.js             pengganti localStorage -> data/ui-prefs.json
  chart/chartCore.js   LOGIKA CHART ASLI (hasil build otomatis dari public/index.html)
  chart/chartView.js   menghubungkan widget Qt <-> chartCore (event Qt -> event ala DOM)
  ui/                  sidebar, toolbar, status bar, popup pair/indicator, dialog config, kalender
tools/
  build_core.js        membangun ulang chart/chartCore.js dari public/index.html
  core_parts/          potongan "lem" (header, overlay, data loading, export)
lib/                   sama dengan versi asli (tvSync, bybitWS, bybitKlines, store, ...);
                       tambahan: bybitInstruments.js membaca `tickSize`; deribitGamma.js (baru) untuk Gamma Level
server.js              IDENTIK dengan versi asli (hanya dipakai `npm run web`)
```

## HVN Profile (cara kerja)

Implementasi di `tools/core_parts/core_hvn.js` (otomatis masuk ke `chartCore.js` saat `node tools/build_core.js`),
mengikuti deskripsi indikator "HVN Profile":

1. Riwayat dibagi per periode (1m, 5m, 15m, 30m, 1H, 4H, Daily, Weekly — Weekly mulai Senin 00:00 UTC);
   tiap periode selesai dibuatkan volume profile (volume bar disebar rata antara low–high; row height = ticks × tickSize Bybit).
2. Profile di-*smooth* (Smoothing Passes, kernel 1-2-1) → bin ≥ *HVN Threshold %* dari puncak = High Volume Node.
3. Node berdekatan digabung jadi cluster (*Gap Tolerance*, *Min Cluster Size*); POC = bin volume tertinggi (data asli) di tiap cluster.
4. Tiap zona diperpanjang ke depan sampai harga menyentuhnya (setelah *Touch Grace Bars*) → zona ditutup (abu-abu).
   Update berjalan live per tick: bar baru yang menyentuh zona langsung menutupnya; *Alert on HVN Zone Touch* memunculkan notifikasi di chart.
5. Profile periode berjalan digambar live (*Live Profile Transparency*); *Max Bars Back* membatasi bar yang diproses;
   periode pertama yang datanya terpotong tidak dipakai.

Semua parameter ada di Indicator → HVN Profile → ⋮.

## Gamma Level (GEX Deribit) — hanya BTC & ETH

Indicator > **Gamma Level** (abu-abu & tidak bisa diklik di pair selain BTCUSDT/ETHUSDT; otomatis mati saat pindah ke pair lain
dan menyala lagi saat kembali ke BTC/ETH). Data dari WebSocket `wss://www.deribit.com/ws/api/v2`
(`lib/deribitGamma.js`, diproses di engine → event `gamma`):

- `public/get_instruments` + `public/get_book_summary_by_currency` → strike, expiry, open interest, mark IV (refresh tiap 60 dtk)
- channel `deribit_price_index.<btc|eth>_usd` → spot live; GEX dihitung ulang tiap ~1 dtk
- `GEX$ = gamma(Black-76) × OI × spot² × 1%`, call = +, put = − (asumsi dealer long call / short put), dijumlahkan per strike
- Garis horizontal: **Gamma Flip** (spot di mana total GEX berganti tanda), **Call Wall**, **Put Wall**, **Max Gamma**, + Top-N strike
- "Volume": bar GEX per strike (teal +, pink −) dengan label nilai (m/b/k) — bisa dimatikan; juga ringkasan Net GEX / Flip

Config: Indicator → Gamma Level → ⋮ (expiry window, lebar bar, bar/label/ringkasan, tiap garis level, Top-N).

## Liquidity Heatmap (order book Binance, Spot diutamakan, per candle)

Indicator > **Liquidity Heatmap** — gaya Bookmap, tetapi **per candle** (bukan per tick). Perekaman (`lib/liquidityBook.js`,
berjalan terus untuk pair yang sedang dibuka):

- **Sumber: Binance saja** (OKX sudah dihapus). **Data SPOT wajib diutamakan.** Resolver `lib/binanceSymbols.js` memilih market per simbol Bybit:
  1. **Binance Spot** (`api.binance.com`) — selalu dicoba lebih dulu: WebSocket diff depth + snapshot REST (5000 level) -> local book.
  2. **Binance USD-M Futures / perpetual** (`fapi.binance.com`) — fallback HANYA bila spot tidak punya data: simbol tidak terdaftar di spot, atau
     permintaan ke spot gagal **3x berturut-turut** (WebSocket/snapshot error, order book kosong, harga tidak cocok). Snapshot futures **1000 level**
     (batas API; level lebih dalam terisi lewat diff). Ini yang membuat **XAUUSDT / XAGUSDT** (emas & perak), saham/FX TradFi (`AAPLUSDT`, `TSLAUSDT`, ...)
     punya heatmap — instrumen ini TIDAK ada di Binance Spot.
  3. Perpetual juga gagal 3x = **tidak ada data** (`LIQ · no Binance data for <SYMBOL>`); otomatis dicoba ulang penuh tiap 5 menit.
  Aturan 3x gagal hanya berlaku sebelum sumber pernah tersinkron. Setelah berjalan, gangguan sementara (internet putus, rate limit 418/429) di-retry terus tanpa pindah sumber.
  Bila sedang memakai fallback perpetual karena spot gagal, spot dicek lagi tiap 10 menit dan otomatis kembali ke spot begitu pulih.
  Simbol Bybit ber-multiplier (1000PEPEUSDT, SHIB1000USDT, 10000SATSUSDT, 1000000BABYDOGEUSDT, ...) dipetakan ke simbol Binance dengan faktor skala harga.
  Tiap kandidat divalidasi (harga book x skala harus dalam +-8% harga Bybit) agar ticker kembar / skala salah tidak terpakai.
  Sumber aktif (`SPOT <sym>` / `FUT <sym>`) tampil di pojok kanan atas chart.
- Tiap 1 dtk book di-sample ke bin harga (≈ 1 bp), lalu dirangkum **per menit**: max / rata-rata / terakhir per bin.
- Disimpan ke `data/liquidity/<SYMBOL>.bin.gz` (maks 2 hari, dimuat lagi saat aplikasi dibuka). Tidak ada history order book publik,
  jadi heatmap hanya terisi sejak perekaman dimulai.
- Tiap candle pada TF aktif = agregasi menit-menit di dalamnya: **Peak** (liquidity tertinggi selama candle), **Average**, atau **Close**.
  TF besar + Peak memperlihatkan order yang *sempat* ada; turunkan ke TF kecil untuk melihat apakah order itu bertahan (spoofing).
- Heatmap digambar sebagai tekstur (sel = candle × baris harga); warna biru → cyan → hijau → kuning → merah.
- **Panel volume vertikal** (heat bar + jumlah KOIN per level, total Bid/Ask dalam koin) untuk candle yang di-hover / terbaru; bisa dimatikan di config.
  Bila Gamma Level menampilkan volumenya, panel ini otomatis bergeser ke kiri dan tidak menimpa bar/label Gamma.

Config: Indicator → Liquidity Heatmap → ⋮ (agregasi, contrast/opacity/threshold, tinggi baris, panel volume, rentang rekam, clear history).

## Heavy Absorption (threshold bisa diatur)

Indicator > **Heavy Absorption** > ⋮ (tombol config). Sinyal muncul bila volume melewati threshold adaptif:
`threshold = mean + (multiplier x stdev)` dari `lookback` bar sebelumnya. Parameter:

| Setting | Default (= perilaku lama) | Rentang | Keterangan |
|---|---|---|---|
| Threshold (x Stdev) | 2.0x | 0.5x – 6.0x | makin kecil = sinyal makin banyak |
| Lookback (bars) | 100 | 20 – 500 | jumlah bar untuk mean/stdev |
| Min Wick Ratio | 22% | 5% – 50% | hanya deteksi berbasis candle: ambang sumbu candle untuk menentukan arah Buy/Sell |

Threshold & Lookback dipakai di dua tempat: deteksi berbasis trade live (print terbesar per bar, dihitung di `lib/store.js` —
`store.setHAConfig()` memproses ulang `rawTrades`) dan deteksi berbasis volume candle (di chart). Config disimpan di prefs
(`hf_ha_*`) dan dikirim ke engine tiap aplikasi dibuka. Tombol *Reset to Default* mengembalikan 2.0x / 100 / 22%.

## Chart Type (Standard / Renko / Footprint Delta)

Tombol **Chart Type** ada di toolbar, tepat di sebelah **Indicator** (label menunjukkan tipe aktif). Klik → dropdown: *Standard*, *Renko*, *Footprint Delta*
(titik tiga ⋮ pada Renko/Footprint membuka dialog config). Pilihan disimpan (`hf_chartType`). Drawing tools tetap bekerja di semua tipe (berbasis waktu+harga).

**Renko** — brick berbasis harga, dibangun dari candle TF aktif (`renkoBuild()` di `tools/core_parts/core_charttype.js`):
- Ukuran brick: **ATR** (Wilder, default period 14 × 1.0, dari candle yang sudah tutup, dibulatkan ke tick) atau **Fixed** (harga). Ukuran tetap selama pair/TF/config
  sama → brick lama tidak bergeser tiap candle tutup. Level brick menempel pada grid kelipatan ukuran.
- Brick baru: naik bila harga ≥ atas brick terakhir + ukuran, turun bila ≤ bawah brick terakhir − ukuran (reversal = 2 brick). Sumber harga: *Close* (default)
  atau *High/Low* (jalur L→H→C / H→L→C). Volume candle dibagi ke brick yang terbentuk. Brick berjalan ikut tick live.
- Indikator berbasis waktu (**VP, Bubble, CVD, Heavy Absorption, HVN, Liquidity**) tidak relevan → dimatikan otomatis (tampil abu-abu + tag "Renko" di dropdown) dan
  menyala lagi saat kembali ke tipe lain. Volume & Gamma tetap aktif.

**Footprint Delta** — candle ramping di kiri slot + tabel delta (buy − sell) per baris harga di kanan; total delta di bawah candle; POC (volume terbesar) diberi
outline oranye; sel biru = delta positif, merah = negatif (intensitas ∝ |delta| dalam candle). Hover sel → rentang harga + Buy/Sell/Δ di baris info kiri-atas.
- **Data: trade Bybit WebSocket** (`publicTrade`). `lib/footprint.js` mengagregasi per **menit** per level harga (independen dari TF → ganti timeframe tidak menghilangkan
  data; semua TF 1m–1W dijumlahkan dari menit). Level dasar ≈ 1 bp harga dan selalu kelipatan tickSize (BTC $10, ETH $0.5, XRP 0.0001); chart menggabungkan level jadi baris
  ≥ *Min Row Height* px sesuai zoom vertikal.
- Bybit tidak menyediakan history trade lewat WebSocket → footprint terisi **sejak aplikasi dibuka**. Supaya tidak hilang saat ditutup, tiap simbol disimpan ke
  `data/footprint/<SYMBOL>.json.gz` (tiap 5 menit + saat keluar, maks 2 hari, 6 simbol di memori). Candle tanpa data tampil sebagai candle ramping tanpa tabel.
- Tabel tampil bila lebar slot candle ≥ 52 px (zoom in; lebar awal 76 px). Zoom out → candle biasa + petunjuk. Indikator VP dimatikan (tumpang tindih).
- Config: Min Row Height (9–28 px, default 13), Color Scheme (Blue/Red mengikuti referensi, atau Teal/Red palet terminal), Show total delta, Highlight POC.

Berkas: `tools/core_parts/core_charttype.js` (logika + gambar), `lib/footprint.js` (agregasi + penyimpanan), `engine.getFootprint()` / `api.footprint()`,
`nodegui/ui/popups.js` (dropdown), `toolbar.js` (tombol), `dialogs.js` (`openRenko`, `openFootprint`).

## Kenapa sama persis dengan versi asli

`chartCore.js` bukan tulis ulang: isinya potongan kode `public/index.html` asli (kamera, render candle,
Volume Profile per-candle, HVN, Bubble, Agg. CVD, Heavy Absorption, drawing tools, hit-test, momentum pan,
buffer-more, dst.) yang dijalankan di atas `canvas2d.js`. Yang diganti hanya platformnya:

| Versi browser            | Versi NodeGUI                                  |
|--------------------------|------------------------------------------------|
| `<canvas>`               | `Canvas2D` shim di atas `QPainter`             |
| `fetch('/api/...')`      | `engine.*()` langsung (in-process)             |
| `EventSource` tick/trade | `engine.on('tick' / 'trade')`                  |
| `localStorage`           | `data/ui-prefs.json`                           |
| overlay DOM (OHLCV, loading, buffer) | digambar langsung di canvas        |
| modal / dropdown / kalender HTML | widget Qt + komponen canvas (`nodegui/ui`) |

Bila `public/index.html` asli diubah, jalankan `node tools/build_core.js` untuk menyamakan `chartCore.js`.

## Tambahan kecil dibanding versi asli (hanya saat TradingView tidak tersedia)

- Data awal & daftar pair jatuh ke Bybit REST bila TradingView Desktop tidak ada / gagal start
  (versi asli: layar kosong). Bila TradingView ada, alurnya identik dengan asli.
- Layar loading menampilkan status boot ("Launching TradingView Desktop…") selama TV dinyalakan.

> Dokumen ini adalah catatan teknis per fitur. Untuk instalasi dan konfigurasi, lihat [README utama](../README.md).

## Navigasi chart

Pan horizontal (klik-tahan lalu geser) berhenti seketika saat dilepas, tanpa inersia/"meluncur", sama seperti scroll vertikal.
(Efek meluncur bawaan versi asli dimatikan lewat patch `no momentum` di `tools/build_core.js`.)

## Anti-gap candle (kembali ke TF/pair lama)

Cache candle tiap pair/TF bisa tertinggal setelah Anda lama di TF lain. `nodegui/engine.js` kini menambal celah itu:

- Cache > 20 detik → candle yang terlewat diambil lewat Bybit REST **sebelum** UI membaca data (candle terakhir yang belum final ikut di-refresh).
- Cache tertinggal > 900 bar → tidak dipakai, muat ulang penuh.
- Tick live yang melompat > 1 bar (WS putus, laptop sleep) → candle yang hilang ditambal dan UI diberi event `resync`
  (kamera tetap menempel di candle terbaru); gap besar → event `reload`.
- `lib/store.js`: candle yang ditutup kini menggantikan snapshot lama di history (sebelumnya OHLC candle pertama bisa basi).
