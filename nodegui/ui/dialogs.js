'use strict';
/**
 * Dialog konfigurasi (Bubble, HVN, Agg. CVD) dan editor objek gambar.
 * Pengganti modal HTML versi browser — berupa overlay child dari window utama
 * dengan widget Qt standar (QSlider/QCheckBox/QComboBox/…) yang di-style lewat QSS.
 */
const {
  QWidget, QLabel, QPushButton, QLineEdit, QSlider, QCheckBox, QComboBox, QSpinBox,
  QBoxLayout, QGridLayout, QColorDialog, QColor, QPainter, Direction, Orientation,
  WidgetEventTypes, QMouseEvent, FocusPolicy
} = require('@nodegui/nodegui');

const QSS = `
  QWidget#ovl { background: transparent; }
  QWidget#mbox { background:#161924; border:1px solid #2d3345; border-radius:6px; }
  QWidget#mhdr { background:#1b1f2d; border:none; border-bottom:1px solid #232736; border-top-left-radius:5px; border-top-right-radius:5px; }
  QWidget#mbody { background:transparent; border:none; }
  QLabel { color:#94a3b8; font-size:11px; font-family:Consolas; background:transparent; border:none; }
  QLabel#mtitle { color:#ff8c37; font-size:11px; font-weight:bold; }
  QLabel#val { color:#ff8c37; font-weight:bold; }
  QLabel#hint { color:#94a3b8; font-size:9px; }
  QLabel#dtitle { color:#ff8c37; font-size:12px; font-weight:bold; }
  QLabel#cvdlbl { color:#cbd5e1; font-size:11px; font-weight:bold; }
  QLabel#cvdlbl_off { color:#64748b; font-size:11px; font-weight:bold; }
  QPushButton#mclose { background:transparent; border:none; color:#94a3b8; font-size:18px; }
  QPushButton#mclose:hover { color:#ef5350; }
  QLineEdit, QSpinBox, QComboBox { background:#10131a; border:1px solid #2d3345; color:#f1f5f9; font-size:11px; font-family:Consolas; padding:4px 8px; border-radius:3px; }
  QLineEdit:focus, QSpinBox:focus { border:1px solid #8c450a; color:#ff8c37; }
  QComboBox QAbstractItemView { background:#161924; color:#f1f5f9; selection-background-color:#2a1a08; selection-color:#ff8c37; border:1px solid #2d3345; }
  QSlider::groove:horizontal { height:4px; background:#252b3d; border-radius:2px; }
  QSlider::handle:horizontal { background:#00b2ff; width:14px; height:14px; margin:-5px 0px; border-radius:7px; }
  QSlider::handle:horizontal:hover { background:#33c2ff; }
  QCheckBox { color:#cbd5e1; font-size:11px; font-family:Consolas; spacing:8px; background:transparent; }
  QCheckBox::indicator { width:14px; height:14px; border:1px solid #3e465e; border-radius:2px; background:#10131a; }
  QCheckBox::indicator:checked { background:#ff8c37; border:1px solid #ff8c37; }
  QCheckBox::indicator:disabled { background:#1a1e28; border:1px solid #2d3345; }
  QPushButton#btnCancel { background:#1c202d; border:1px solid #2d3345; color:#cbd5e1; padding:5px 12px; border-radius:3px; font-family:Consolas; font-size:11px; }
  QPushButton#btnOk { background:#2a1a08; border:1px solid #8c450a; color:#ff8c37; padding:5px 14px; border-radius:3px; font-family:Consolas; font-size:11px; font-weight:bold; }
  QPushButton#btnDel { background:#331515; border:1px solid #6d2020; color:#ef5350; padding:5px 12px; border-radius:3px; font-family:Consolas; font-size:11px; }
  QPushButton#btnAdd { background:#2a1a08; border:1px solid #8c450a; color:#ff8c37; padding:3px 10px; border-radius:2px; font-family:Consolas; font-size:10px; }
  QPushButton#btnX { background:#331515; border:1px solid #6d2020; color:#ef5350; padding:2px 7px; border-radius:2px; font-size:10px; }
  QWidget#cvdItem { background:#141722; border:1px solid #2d3345; border-radius:4px; }
  QWidget#cvdItemOff { background:#10131a; border:1px solid #2d3345; border-radius:4px; }
`;

const hex2 = v => v.toString(16).padStart(2, '0');
function qcolorHex(c) { return '#' + hex2(c.red()) + hex2(c.green()) + hex2(c.blue()); }
function normHex(s, fallback) {
  if (typeof s === 'string' && /^#[0-9a-f]{6}$/i.test(s)) return s.toLowerCase();
  if (typeof s === 'string' && /^#[0-9a-f]{3}$/i.test(s)) return ('#' + s.slice(1).split('').map(c => c + c).join('')).toLowerCase();
  try { if (typeof s === 'string' && s) { const c = new QColor(s); return qcolorHex(c); } } catch (e) {}
  return fallback || '#ffffff';
}

function vbox(spacing) { const w = new QWidget(); const l = new QBoxLayout(Direction.TopToBottom); l.setContentsMargins(0, 0, 0, 0); l.setSpacing(spacing === undefined ? 8 : spacing); w.setLayout(l); return { w, l }; }
function hbox(spacing) { const w = new QWidget(); const l = new QBoxLayout(Direction.LeftToRight); l.setContentsMargins(0, 0, 0, 0); l.setSpacing(spacing === undefined ? 8 : spacing); w.setLayout(l); return { w, l }; }
function lbl(text, obj) { const l = new QLabel(); l.setText(text); if (obj) l.setObjectName(obj); return l; }

function createDialogs({ root, core, onClosed }) {
  const open = new Set();

  // ── Modal generik ──
  function makeModal({ title, width, outside, header = true, onClose }) {
    const overlay = new QWidget(root);
    overlay.setObjectName('ovl');
    overlay.setStyleSheet(QSS);
    overlay.setGeometry(0, 0, root.width(), root.height());

    const boxW = new QWidget(overlay);
    boxW.setObjectName('mbox');
    boxW.setFixedWidth(width);
    const bl = new QBoxLayout(Direction.TopToBottom);
    bl.setContentsMargins(0, 0, 0, 0); bl.setSpacing(0);
    boxW.setLayout(bl);

    let closeBtn = null;
    if (header) {
      const hdr = new QWidget(); hdr.setObjectName('mhdr');
      const hl = new QBoxLayout(Direction.LeftToRight);
      hl.setContentsMargins(16, 10, 12, 10); hl.setSpacing(8); hdr.setLayout(hl);
      const t = lbl(title.toUpperCase(), 'mtitle');
      hl.addWidget(t, 1);
      closeBtn = new QPushButton(); closeBtn.setObjectName('mclose'); closeBtn.setText('\u00d7'); closeBtn.setFixedSize(22, 22);
      closeBtn.setFocusPolicy(FocusPolicy.NoFocus);
      hl.addWidget(closeBtn);
      bl.addWidget(hdr);
    }
    const body = new QWidget(); body.setObjectName('mbody');
    const bodyL = new QBoxLayout(Direction.TopToBottom);
    bodyL.setContentsMargins(16, header ? 18 : 18, 16, 16); bodyL.setSpacing(16);
    body.setLayout(bodyL);
    bl.addWidget(body);

    const m = {
      overlay, box: boxW, body, bodyL, closeBtn,
      relayout() {
        overlay.setGeometry(0, 0, root.width(), root.height());
        boxW.adjustSize();
        const bw = boxW.width(), bh = boxW.height();
        boxW.move(Math.max(0, Math.round((root.width() - bw) / 2)), Math.max(0, Math.round((root.height() - bh) / 2)));
      },
      show() { open.add(m); overlay.show(); overlay.raise(); m.relayout(); setTimeout(() => m.relayout(), 0); },
      close() { if (!open.has(m)) return; open.delete(m); overlay.hide(); onClose && onClose(); onClosed && onClosed(); }
    };
    if (closeBtn) closeBtn.addEventListener('clicked', () => m.close());

    overlay.addEventListener(WidgetEventTypes.Paint, () => {
      const p = new QPainter(overlay);
      try { p.fillRectF(0, 0, overlay.width(), overlay.height(), new QColor(3, 3, 3, outside === 'draw' ? 191 : 204)); } finally { p.end(); }
    });
    overlay.addEventListener(WidgetEventTypes.MouseButtonPress, n => {
      if (outside !== true) return;
      const e = new QMouseEvent(n);
      const g = boxW.geometry();
      const x = e.x(), y = e.y();
      if (x < g.x() || x > g.x() + g.width() || y < g.y() || y > g.y() + g.height()) m.close();
    });
    return m;
  }

  // ── kontrol ──
  function slider(min, max, value, onChange) {
    const s = new QSlider();
    s.setOrientation(Orientation.Horizontal);
    s.setMinimum(min); s.setMaximum(max); s.setValue(value); s.setSingleStep(1);
    s.setFixedHeight(16);
    s.addEventListener('valueChanged', onChange);
    return s;
  }
  function checkbox(text, checked, onChange) {
    const c = new QCheckBox(); c.setText(text); c.setChecked(!!checked);
    c.addEventListener('toggled', on => onChange(on));
    return c;
  }
  function combo(items, index, onChange) {
    const c = new QComboBox();
    c.addItems(items);
    c.setCurrentIndex(Math.max(0, index));
    if (onChange) c.addEventListener('currentIndexChanged', i => onChange(i));
    return c;
  }
  function colorBtn(initial, w, h, onChange) {
    const b = new QPushButton();
    b.setFixedSize(w || 40, h || 22);
    b.setFocusPolicy(FocusPolicy.NoFocus);
    b._v = normHex(initial, '#ffffff');
    const paint = () => b.setStyleSheet(`QPushButton{background:${b._v};border:1px solid #3e465e;border-radius:2px;}QPushButton:hover{border:1px solid #ff8c37;}`);
    paint();
    b.addEventListener('clicked', () => {
      const dlg = new QColorDialog();
      b._dlg = dlg;
      dlg.setCurrentColor(new QColor(b._v));
      dlg.addEventListener('colorSelected', c => { b._v = qcolorHex(c); paint(); onChange && onChange(b._v); });
      dlg.open();
    });
    return b;
  }
  function field(labelText, valueLabel, control) {
    const r = vbox(8);
    const h = hbox(0);
    h.l.addWidget(lbl(labelText), 1);
    if (valueLabel) h.l.addWidget(valueLabel);
    r.l.addWidget(h.w);
    r.l.addWidget(control);
    return r.w;
  }
  function checkRow(text, checked, onChange) {
    const h = hbox(8);
    h.l.addWidget(lbl(text), 1);
    const c = new QCheckBox(); c.setChecked(!!checked);
    c.addEventListener('toggled', on => onChange(on));
    h.l.addWidget(c);
    return h.w;
  }

  // ── Bubble ──
  function openBubble() {
    const cfg = core.bubbleConfig;
    const m = makeModal({ title: 'Bubble Configuration', width: 320, outside: true });
    const minTok = new QLineEdit();
    minTok.setText(cfg.minToken ? String(cfg.minToken) : '');
    minTok.setPlaceholderText('e.g. 15');
    minTok.addEventListener('textChanged', t => core.setBubbleMinToken(parseFloat(t) || 0));
    m.bodyL.addWidget(field('Min Size (Token/Coin)', null, minTok));

    const val = lbl(parseFloat(cfg.multiplier).toFixed(1) + 'x', 'val');
    const sl = slider(10, 100, Math.round(parseFloat(cfg.multiplier) * 10), v => { val.setText((v / 10).toFixed(1) + 'x'); core.setBubbleMultiplier(v / 10); });
    m.bodyL.addWidget(field('Size Multiplier', val, sl));
    m.show();
  }

  // ── HVN ──
  function openHvn() {
    const c = core.hvnConfig;
    const m = makeModal({ title: 'HVN Profile Config', width: 600, outside: true });
    const ANCH = [['1', '1 Minute'], ['5', '5 Minutes'], ['15', '15 Minutes'], ['30', '30 Minutes'], ['60', '1 Hour'], ['240', '4 Hours'], ['D', 'Daily'], ['W', 'Weekly']];
    const spin = (min, max, val, step, key) => {
      const s = new QSpinBox(); s.setRange(min, max); s.setValue(val); if (step) s.setSingleStep(step);
      s.addEventListener('valueChanged', v => core.setHvn(key, v));
      return s;
    };
    const sliderVal = (min, max, val, unit, key) => {
      const h = hbox(8);
      const vl = lbl(val + unit, 'val'); vl.setFixedWidth(46);
      const s = slider(min, max, val, v => { vl.setText(v + unit); core.setHvn(key, v); });
      h.l.addWidget(s, 1); h.l.addWidget(vl);
      return h.w;
    };

    const gridW = new QWidget();
    const grid = new QGridLayout();
    grid.setContentsMargins(0, 0, 0, 0); grid.setHorizontalSpacing(24); grid.setVerticalSpacing(14);
    gridW.setLayout(grid);
    const put = (row, col, label, ctl) => grid.addWidget(field(label, null, ctl), row, col);

    const ai = Math.max(0, ANCH.findIndex(a => a[0] === String(c.anchor)));
    put(0, 0, 'Profile Timeframe', combo(ANCH.map(a => a[1]), ai, i => core.setHvn('anchor', ANCH[i][0])));
    put(0, 1, 'Row Height (ticks)', spin(1, 500, c.rowTicks, 1, 'rowTicks'));
    put(1, 0, 'HVN Threshold (%)', sliderVal(10, 95, Math.round(c.threshold / 5) * 5, '%', 'threshold'));
    put(1, 1, 'Smoothing Passes', spin(0, 10, c.smooth, 1, 'smooth'));
    put(2, 0, 'Cluster Gap Tolerance (bins)', spin(0, 20, c.gapTol, 1, 'gapTol'));
    put(2, 1, 'Min Cluster Size (bins)', spin(1, 20, c.minCluster, 1, 'minCluster'));
    put(3, 0, 'Touch Grace Bars', spin(0, 50, c.graceBars, 1, 'graceBars'));
    put(3, 1, 'Max Zones', spin(1, 150, c.maxZones, 1, 'maxZones'));
    put(4, 0, 'Max Bars Back', spin(50, 20000, c.maxBarsBack, 100, 'maxBarsBack'));
    put(4, 1, 'Profile Histogram Width (px)', sliderVal(10, 300, c.histWidth, 'px', 'histWidth'));
    put(5, 0, 'Live Profile Transparency (%)', sliderVal(0, 100, c.liveTransp, '%', 'liveTransp'));
    m.bodyL.addWidget(gridW);

    const chk = new QWidget();
    const cg = new QGridLayout();
    cg.setContentsMargins(0, 0, 0, 0); cg.setHorizontalSpacing(24); cg.setVerticalSpacing(10);
    chk.setLayout(cg);
    cg.addWidget(checkbox('Show Profile Histogram', c.showProfile !== false, on => core.setHvn('showProfile', on)), 0, 0);
    cg.addWidget(checkbox('Show Live Profile (current period)', c.liveProfile !== false, on => core.setHvn('liveProfile', on)), 0, 1);
    cg.addWidget(checkbox('Show POC Line', c.showPOC !== false, on => core.setHvn('showPOC', on)), 1, 0);
    cg.addWidget(checkbox('Alert on HVN Zone Touch', !!c.alertOn, on => core.setHvn('alertOn', on)), 1, 1);
    cg.addWidget(checkbox('Show Volume & Delta % Labels', c.showLabels !== false, on => core.setHvn('showLabels', on)), 2, 0);
    m.bodyL.addWidget(chk);
    m.show();
  }

  // ── Gamma Level ──
  function openGamma() {
    const c = core.gammaConfig;
    const m = makeModal({ title: 'Gamma Level Config', width: 540, outside: true });
    const hint = lbl('Data opsi Deribit (BTC & ETH) via WebSocket.  GEX = gamma \u00d7 OI \u00d7 spot\u00b2 \u00d7 1%  (call +, put \u2212), dijumlahkan per strike.', 'hint');
    hint.setWordWrap(true);
    m.bodyL.addWidget(hint);

    const gridW = new QWidget();
    const grid = new QGridLayout();
    grid.setContentsMargins(0, 0, 0, 0); grid.setHorizontalSpacing(24); grid.setVerticalSpacing(14);
    gridW.setLayout(grid);
    const EXP = [[0, 'All expiries'], [1, '\u2264 1 day (0DTE)'], [7, '\u2264 7 days'], [30, '\u2264 30 days'], [90, '\u2264 90 days']];
    const ei = Math.max(0, EXP.findIndex(e => e[0] === c.maxDays));
    grid.addWidget(field('Expiry Window', null, combo(EXP.map(e => e[1]), ei, i => core.setGamma('maxDays', EXP[i][0]))), 0, 0);
    const tn = new QSpinBox(); tn.setRange(0, 10); tn.setValue(c.topN);
    tn.addEventListener('valueChanged', v => core.setGamma('topN', v));
    grid.addWidget(field('Extra Strike Lines (Top N)', null, tn), 0, 1);
    const hb = hbox(8);
    const vl = lbl(c.barWidth + 'px', 'val'); vl.setFixedWidth(52);
    const sl = slider(80, 600, c.barWidth, v => { vl.setText(v + 'px'); core.setGamma('barWidth', v); });
    hb.l.addWidget(sl, 1); hb.l.addWidget(vl);
    grid.addWidget(field('GEX Bar Width', null, hb.w), 1, 0);
    m.bodyL.addWidget(gridW);

    const sec1 = lbl('VOLUME (GEX per strike)');
    m.bodyL.addWidget(sec1);
    const v = new QWidget(); const vg = new QGridLayout(); vg.setContentsMargins(0, 0, 0, 0); vg.setHorizontalSpacing(24); vg.setVerticalSpacing(10); v.setLayout(vg);
    vg.addWidget(checkbox('Show GEX Volume Bars', c.showBars !== false, on => core.setGamma('showBars', on)), 0, 0);
    vg.addWidget(checkbox('Show Value Labels', c.showLabels !== false, on => core.setGamma('showLabels', on)), 0, 1);
    vg.addWidget(checkbox('Show Summary (Net GEX / Flip)', c.showSummary !== false, on => core.setGamma('showSummary', on)), 1, 0);
    m.bodyL.addWidget(v);

    const sec2 = lbl('LEVEL LINES');
    m.bodyL.addWidget(sec2);
    const l = new QWidget(); const lg = new QGridLayout(); lg.setContentsMargins(0, 0, 0, 0); lg.setHorizontalSpacing(24); lg.setVerticalSpacing(10); l.setLayout(lg);
    lg.addWidget(checkbox('Gamma Flip (zero gamma)', c.showFlip !== false, on => core.setGamma('showFlip', on)), 0, 0);
    lg.addWidget(checkbox('Call Wall', c.showCallWall !== false, on => core.setGamma('showCallWall', on)), 0, 1);
    lg.addWidget(checkbox('Put Wall', c.showPutWall !== false, on => core.setGamma('showPutWall', on)), 1, 0);
    lg.addWidget(checkbox('Max Gamma', c.showMax !== false, on => core.setGamma('showMax', on)), 1, 1);
    m.bodyL.addWidget(l);
    m.show();
  }

  // ── Liquidity Heatmap ──
  function openLiq() {
    const c = core.liqConfig;
    const m = makeModal({ title: 'Liquidity Heatmap Config', width: 600, outside: true });
    const hint = lbl('Order book Binance (Spot diutamakan; fallback perpetual bila spot tidak ada) direkam tiap detik, dirangkum per menit, lalu diagregasi per candle pada TF aktif. Perekaman dimulai sejak aplikasi dibuka (history order book publik tidak tersedia).', 'hint');
    hint.setWordWrap(true);
    m.bodyL.addWidget(hint);

    const sliderVal = (min, max, val, fmt, key) => {
      const h = hbox(8);
      const vl = lbl(fmt(val), 'val'); vl.setFixedWidth(52);
      const s = slider(min, max, val, v => { vl.setText(fmt(v)); core.setLiq(key, v); });
      h.l.addWidget(s, 1); h.l.addWidget(vl);
      return h.w;
    };
    const gridW = new QWidget();
    const grid = new QGridLayout();
    grid.setContentsMargins(0, 0, 0, 0); grid.setHorizontalSpacing(24); grid.setVerticalSpacing(14);
    gridW.setLayout(grid);
    const MODES = ['Peak (max in candle)', 'Average', 'Close (last minute)'];
    grid.addWidget(field('Aggregation per Candle', null, combo(MODES, c.mode, i => core.setLiq('mode', i))), 0, 0);
    const rp = new QSpinBox(); rp.setRange(2, 14); rp.setValue(c.rowPx);
    rp.addEventListener('valueChanged', v => core.setLiq('rowPx', v));
    grid.addWidget(field('Min Row Height (px)', null, rp), 0, 1);
    grid.addWidget(field('Contrast', null, sliderVal(20, 400, c.contrast, v => v + '%', 'contrast')), 1, 0);
    grid.addWidget(field('Opacity', null, sliderVal(20, 100, c.opacity, v => v + '%', 'opacity')), 1, 1);
    grid.addWidget(field('Hide Cells Below (% of scale)', null, sliderVal(0, 60, c.threshold, v => v + '%', 'threshold')), 2, 0);
    grid.addWidget(field('Record Range (\u00b1% of price)', null, sliderVal(5, 50, c.rangeTenth, v => (v / 10).toFixed(1) + '%', 'rangeTenth')), 2, 1);
    m.bodyL.addWidget(gridW);

    m.bodyL.addWidget(lbl('SOURCE'));
    const srcHint = lbl('Binance saja. Data SPOT selalu diutamakan. Bila simbol tidak ada di spot (mis. XAUUSDT, XAGUSDT, saham/TradFi) atau spot gagal 3x permintaan, otomatis fallback ke Binance perpetual (USD-M Futures); bila itu juga gagal 3x = tidak ada data. Sumber aktif tampil di pojok kanan atas chart (SPOT / FUT).', 'hint');
    srcHint.setWordWrap(true);
    m.bodyL.addWidget(srcHint);

    m.bodyL.addWidget(lbl('VOLUME (vertical heat panel)'));
    const vw = new QWidget(); const vg = new QGridLayout(); vg.setContentsMargins(0, 0, 0, 0); vg.setHorizontalSpacing(24); vg.setVerticalSpacing(10); vw.setLayout(vg);
    vg.addWidget(checkbox('Show Volume Panel', c.showVolume !== false, on => core.setLiq('showVolume', on)), 0, 0);
    vg.addWidget(checkbox('Show Value Labels', c.showLabels !== false, on => core.setLiq('showLabels', on)), 0, 1);
    vg.addWidget(field('Panel Width', null, sliderVal(60, 500, c.volWidth, v => v + 'px', 'volWidth')), 1, 0);
    m.bodyL.addWidget(vw);

    const clr = new QPushButton(); clr.setObjectName('btnDel'); clr.setText('Clear Recorded History'); clr.setFocusPolicy(FocusPolicy.NoFocus);
    clr.addEventListener('clicked', () => core.liqClear());
    m.bodyL.addWidget(clr);
    m.show();
  }

  // ── Renko ──
  function openRenko() {
    const c = core.renkoConfig, d = core.renkoDefaults;
    const m = makeModal({ title: 'Renko Config', width: 500, outside: true });
    const hint = lbl('Chart berbasis harga: brick baru terbentuk saat harga bergerak sebesar ukuran brick (reversal butuh 2 brick). Indikator berbasis waktu (VP, Bubble, CVD, Heavy Absorption, HVN, Liquidity) dimatikan selama mode Renko dan menyala lagi saat kembali ke chart lain.', 'hint');
    hint.setWordWrap(true);
    m.bodyL.addWidget(hint);

    const MODES = ['atr', 'fixed'], SRCS = ['close', 'hl'];
    const info = lbl('', 'hint');
    const refreshInfo = () => {
      const s = core.renkoBrickSize;
      info.setText(s > 0 ? 'Ukuran brick saat ini: ' + String(Number(s.toPrecision(8))) : 'Ukuran brick dihitung saat chart Renko aktif.');
    };
    const sliderVal = (min, max, val, fmt, key) => {
      const h = hbox(8);
      const vl = lbl(fmt(val), 'val'); vl.setFixedWidth(52);
      const s = slider(min, max, val, v => { vl.setText(fmt(v)); core.setRenko(key, v); refreshInfo(); });
      h.l.addWidget(s, 1); h.l.addWidget(vl);
      return { w: h.w, s };
    };

    const atrBox = vbox(14);
    const per = sliderVal(5, 100, c.atrPeriod, v => String(v), 'atrPeriod');
    const mul = sliderVal(5, 50, c.atrMultTenth, v => (v / 10).toFixed(1) + '\u00d7', 'atrMultTenth');
    atrBox.l.addWidget(field('ATR Period', null, per.w));
    atrBox.l.addWidget(field('ATR Multiplier', null, mul.w));
    const fixedEdit = new QLineEdit();
    fixedEdit.setText(c.fixed > 0 ? String(c.fixed) : '');
    fixedEdit.setPlaceholderText('ukuran brick dalam harga, mis. 50');
    fixedEdit.addEventListener('textChanged', t => { core.setRenko('fixed', parseFloat(t) || 0); refreshInfo(); });
    const fixedBox = vbox(0);
    fixedBox.l.addWidget(field('Fixed Brick Size (harga)', null, fixedEdit));

    const applyMode = () => { const atr = MODES[modeCombo.currentIndex()] === 'atr'; atrBox.w.setEnabled(atr); fixedBox.w.setEnabled(!atr); };
    const modeCombo = combo(['ATR (otomatis, Wilder)', 'Fixed (ukuran tetap)'], MODES.indexOf(c.mode), i => { core.setRenko('mode', MODES[i]); applyMode(); refreshInfo(); });
    m.bodyL.addWidget(field('Brick Size', null, modeCombo));
    m.bodyL.addWidget(atrBox.w);
    m.bodyL.addWidget(fixedBox.w);
    const srcCombo = combo(['Close candle', 'High / Low (jalur L\u2192H\u2192C / H\u2192L\u2192C)'], SRCS.indexOf(c.source), i => { core.setRenko('source', SRCS[i]); refreshInfo(); });
    m.bodyL.addWidget(field('Sumber Harga', null, srcCombo));
    m.bodyL.addWidget(info);

    const rst = new QPushButton(); rst.setObjectName('btnCancel'); rst.setFocusPolicy(FocusPolicy.NoFocus);
    rst.setText('Reset to Default  (ATR ' + d.atrPeriod + ' \u00d7 ' + (d.atrMultTenth / 10).toFixed(1) + ' \u00b7 Close)');
    rst.addEventListener('clicked', () => {
      modeCombo.setCurrentIndex(0); srcCombo.setCurrentIndex(0);
      per.s.setValue(d.atrPeriod); mul.s.setValue(d.atrMultTenth);
      fixedEdit.setText('');
    });
    m.bodyL.addWidget(rst);
    applyMode(); refreshInfo();
    m.show();
  }

  // ── Footprint Delta ──
  function openFootprint() {
    const c = core.fpConfig, d = core.fpDefaults;
    const m = makeModal({ title: 'Footprint Delta Config', width: 500, outside: true });
    const hint = lbl('Tabel delta (buy \u2212 sell) per level harga di sisi kanan candle, data dari trade Bybit WebSocket yang direkam sejak aplikasi dibuka (disimpan di data/footprint, jadi tidak hilang saat aplikasi ditutup). Slot candle harus \u2265 52 px (zoom in) agar tabel tampil; baris digabung otomatis mengikuti zoom vertikal.', 'hint');
    hint.setWordWrap(true);
    m.bodyL.addWidget(hint);

    const SCHEMES = ['bluered', 'teal'];
    const vl = lbl(c.minRowPx + ' px', 'val'); vl.setFixedWidth(52);
    const rowSl = slider(9, 28, c.minRowPx, v => { vl.setText(v + ' px'); core.setFp('minRowPx', v); });
    const rh = hbox(8); rh.l.addWidget(rowSl, 1); rh.l.addWidget(vl);
    m.bodyL.addWidget(field('Min Row Height', null, rh.w));
    const schemeCombo = combo(['Blue / Red (referensi)', 'Teal / Red (palet terminal)'], SCHEMES.indexOf(c.scheme), i => core.setFp('scheme', SCHEMES[i]));
    m.bodyL.addWidget(field('Color Scheme', null, schemeCombo));
    const totalChk = checkbox('Show total delta di bawah candle', c.showTotal, on => core.setFp('showTotal', on));
    const pocChk = checkbox('Highlight POC (level dengan volume terbesar)', c.showPoc, on => core.setFp('showPoc', on));
    m.bodyL.addWidget(totalChk);
    m.bodyL.addWidget(pocChk);

    const rst = new QPushButton(); rst.setObjectName('btnCancel'); rst.setFocusPolicy(FocusPolicy.NoFocus);
    rst.setText('Reset to Default');
    rst.addEventListener('clicked', () => {
      rowSl.setValue(d.minRowPx); schemeCombo.setCurrentIndex(SCHEMES.indexOf(d.scheme));
      totalChk.setChecked(d.showTotal); pocChk.setChecked(d.showPoc);
    });
    m.bodyL.addWidget(rst);
    m.show();
  }

  // ── Heavy Absorption ──
  function openHa() {
    const c = core.haConfig, d = core.haDefaults;
    const m = makeModal({ title: 'Heavy Absorption Config', width: 520, outside: true });
    const hint = lbl('Sinyal muncul bila volume melewati threshold adaptif:  mean + (multiplier \u00d7 stdev)  dari N bar sebelumnya. Berlaku untuk print trade terbesar per bar (data live) dan volume candle (history). Multiplier lebih kecil = sinyal lebih banyak, lebih besar = lebih selektif.', 'hint');
    hint.setWordWrap(true);
    m.bodyL.addWidget(hint);

    const sliders = {};
    const sliderVal = (min, max, val, fmt, key) => {
      const h = hbox(8);
      const vl = lbl(fmt(val), 'val'); vl.setFixedWidth(64);
      const s = slider(min, max, val, v => { vl.setText(fmt(v)); core.setHa(key, v); });
      sliders[key] = s;
      h.l.addWidget(s, 1); h.l.addWidget(vl);
      return h.w;
    };
    m.bodyL.addWidget(field('Threshold (\u00d7 Stdev)', null, sliderVal(5, 60, c.stdevTenth, v => (v / 10).toFixed(1) + '\u00d7', 'stdevTenth')));
    m.bodyL.addWidget(field('Lookback (bars)', null, sliderVal(20, 500, c.lookback, v => v + ' bars', 'lookback')));
    m.bodyL.addWidget(field('Min Wick Ratio (% of candle range)', null, sliderVal(5, 50, c.wickPct, v => v + '%', 'wickPct')));
    const wickHint = lbl('Wick: ambang minimal sumbu candle (atas/bawah) untuk menentukan arah Buy/Sell pada deteksi berbasis volume candle. Threshold dan Lookback berlaku untuk deteksi berbasis trade maupun candle.', 'hint');
    wickHint.setWordWrap(true);
    m.bodyL.addWidget(wickHint);

    const rst = new QPushButton(); rst.setObjectName('btnCancel'); rst.setFocusPolicy(FocusPolicy.NoFocus);
    rst.setText('Reset to Default  (' + (d.stdevTenth / 10).toFixed(1) + '\u00d7 \u00b7 ' + d.lookback + ' bars \u00b7 ' + d.wickPct + '%)');
    rst.addEventListener('clicked', () => { for (const k of Object.keys(sliders)) sliders[k].setValue(d[k]); });
    m.bodyL.addWidget(rst);
    m.show();
  }

  // ── Agg. CVD ──
  function openCvd() {
    let temp = [...core.cvdConfig.exchanges];
    const m = makeModal({ title: 'Agg. CVD Exchanges', width: 320, outside: true });
    const hint = lbl('Select spot exchanges to aggregate. At least one exchange must be active.', 'hint');
    hint.setWordWrap(true);
    m.bodyL.addWidget(hint);
    const gridW = new QWidget();
    const grid = new QGridLayout();
    grid.setContentsMargins(0, 0, 0, 0); grid.setSpacing(10);
    gridW.setLayout(grid);
    m.bodyL.addWidget(gridW);

    function render() {
      // bersihkan grid dengan membangun ulang widget container
      const fresh = new QWidget();
      const g2 = new QGridLayout(); g2.setContentsMargins(0, 0, 0, 0); g2.setSpacing(10); fresh.setLayout(g2);
      const count = temp.length;
      core.ALL_CVD_EXCHANGES.forEach((ex, i) => {
        const checked = temp.includes(ex);
        const disabled = checked && count === 1;
        const item = new QWidget(); item.setObjectName(disabled ? 'cvdItemOff' : 'cvdItem');
        const il = new QBoxLayout(Direction.LeftToRight); il.setContentsMargins(12, 8, 12, 8); il.setSpacing(8); item.setLayout(il);
        const cb = new QCheckBox(); cb.setChecked(checked); cb.setEnabled(!disabled);
        il.addWidget(cb);
        il.addWidget(lbl(ex.toUpperCase(), disabled ? 'cvdlbl_off' : 'cvdlbl'), 1);
        cb.addEventListener('toggled', async on => {
          if (on) { if (!temp.includes(ex)) temp.push(ex); } else temp = temp.filter(x => x !== ex);
          await core.setCvdExchanges(temp);
          swap();
        });
        g2.addWidget(item, Math.floor(i / 2), i % 2);
      });
      return fresh;
    }
    let current = null;
    function swap() {
      if (current) { m.bodyL.removeWidget(current); current.hide(); }
      current = render();
      m.bodyL.addWidget(current);
      current.show();
      m.relayout();
    }
    m.bodyL.removeWidget(gridW); gridW.hide();
    swap();
    m.show();
  }

  // ── Editor objek gambar ──
  function openDrawEditor(obj, cfg0, handlers) {
    let cfg = JSON.parse(JSON.stringify(cfg0));
    let modal = null;
    let collect = () => {};

    const DASH = ['solid', 'dashed', 'dotted'];
    const dashIdx = v => Math.max(0, DASH.indexOf(v || 'solid'));

    function build() {
      if (modal) { modal.overlay.hide(); open.delete(modal); }
      modal = makeModal({ title: 'EDIT OBJECT', width: 380, outside: 'draw', header: false });
      modal.overlay.setStyleSheet(QSS);
      const L = modal.bodyL; L.setSpacing(0);
      const title = lbl('EDIT OBJECT', 'dtitle');
      L.addWidget(title);
      const rule = new QWidget(); rule.setFixedHeight(1); rule.setStyleSheet('background:#232736;');
      L.addSpacing(8); L.addWidget(rule); L.addSpacing(12);

      const getters = {};
      const addRow = (text, ctl, extra) => {
        const h = hbox(6); const l = lbl(text); l.setFixedWidth(105);
        h.l.addWidget(l); h.l.addWidget(ctl);
        if (extra) h.l.addWidget(extra);
        h.l.addStretch(1);
        h.w.setFixedHeight(28);
        L.addWidget(h.w);
      };
      const lwSlider = (key, v) => {
        const vl = lbl(v + 'px', 'val'); vl.setFixedWidth(40);
        const s = slider(0, 20, Math.round(v * 2), x => vl.setText((x / 2) + 'px')); s.setFixedWidth(110);
        getters[key] = () => s.value() / 2;
        return [s, vl];
      };
      const colorRow = (text, key, init, w) => { const b = colorBtn(init, w || 40, 22); getters[key] = () => b._v; addRow(text, b); };
      const dashRow = (text, key, v) => { const c = combo(['Solid', 'Dashed', 'Dotted'], dashIdx(v)); c.setFixedWidth(110); getters[key] = () => DASH[c.currentIndex()]; addRow(text, c); };

      if (obj.type === 'rect') {
        colorRow('Border Color', 'borderColor', cfg.borderColor || '#3b82f6');
        const bw = cfg.borderWidth ?? cfg.lineWidth ?? 2;
        { const [s, vl] = lwSlider('borderWidth', bw); addRow('Border Width', s, vl); }
        dashRow('Border Style', 'borderDash', cfg.borderDash);
        colorRow('Fill Color', 'fillColor', cfg.fillColor || cfg.borderColor || '#3b82f6');
        const fo = Math.round((cfg.fillOpacity ?? 0.15) * 100);
        const fl = lbl(fo + '%', 'val'); fl.setFixedWidth(40);
        const fs = slider(0, 100, fo, v => fl.setText(v + '%')); fs.setFixedWidth(110);
        getters.fillOpacity = () => fs.value() / 100;
        addRow('Fill Opacity', fs, fl);
        collect = () => {
          cfg.borderColor = getters.borderColor(); cfg.borderWidth = getters.borderWidth(); cfg.borderDash = getters.borderDash();
          cfg.fillColor = getters.fillColor() || cfg.borderColor; cfg.fillOpacity = getters.fillOpacity();
        };
      } else if (obj.type === 'longshort') {
        const dir = combo(['Long (Buy)', 'Short (Sell)'], (cfg.direction || 'long') === 'long' ? 0 : 1); dir.setFixedWidth(130);
        getters.direction = () => (dir.currentIndex() === 0 ? 'long' : 'short');
        addRow('Direction', dir);
        colorRow('Target Color', 'targetColor', cfg.targetColor || '#26a69a');
        colorRow('Stop Color', 'stopColor', cfg.stopColor || '#ef5350');
        { const [s, vl] = lwSlider('lineWidth', cfg.lineWidth ?? 1); addRow('Line Width', s, vl); }
        const st = checkbox('Show Target, R:R & Stop badges', !!cfg.showText, () => {});
        getters.showText = () => st.isChecked();
        addRow('Show Info Labels', st);
        collect = () => {
          cfg.direction = getters.direction(); cfg.targetColor = getters.targetColor(); cfg.stopColor = getters.stopColor();
          cfg.lineWidth = getters.lineWidth(); cfg.showText = getters.showText();
        };
      } else if (obj.type === 'fibo') {
        { const [s, vl] = lwSlider('lineWidth', cfg.lineWidth ?? 1); addRow('Line Width', s, vl); }
        dashRow('Line Style', 'lineDash', cfg.lineDash);
        const lvls = cfg.levels || [0, 0.5, 0.618, 1, 1.618];
        const cols = cfg.levelColors || { '0': '#00bcd4', '0.5': '#ffd600', '0.618': '#ffffff', '1': '#ffffff', '1.618': '#ffd600' };
        const lw = lbl('Levels'); lw.setFixedHeight(20);
        L.addWidget(lw);
        const edits = [];
        lvls.forEach((l, i) => {
          const h = hbox(5);
          const e = new QLineEdit(); e.setText(String(l)); e.setFixedWidth(80);
          const cb = colorBtn(cols[String(l)] || '#ffffff', 26, 20);
          const x = new QPushButton(); x.setObjectName('btnX'); x.setText('\u2715'); x.setFixedSize(26, 22); x.setFocusPolicy(FocusPolicy.NoFocus);
          x.addEventListener('clicked', () => {
            harvestFibo(); cfg.levels.splice(i, 1); build();
          });
          h.l.addWidget(e); h.l.addWidget(cb); h.l.addWidget(x); h.l.addStretch(1);
          h.w.setFixedHeight(28);
          L.addWidget(h.w);
          edits.push({ e, cb });
        });
        const add = new QPushButton(); add.setObjectName('btnAdd'); add.setText('+ Add Level'); add.setFocusPolicy(FocusPolicy.NoFocus);
        add.addEventListener('clicked', () => {
          harvestFibo(); cfg.levels.push(0.786);
          if (!cfg.levelColors) cfg.levelColors = {};
          cfg.levelColors['0.786'] = '#e040fb';
          build();
        });
        L.addSpacing(6); L.addWidget(add);
        function harvestFibo() {
          cfg.lineWidth = getters.lineWidth(); cfg.lineDash = getters.lineDash();
          const nl = [], nc = {};
          edits.forEach(({ e, cb }) => { const v = parseFloat(e.text()); if (!isNaN(v)) { nl.push(v); nc[String(v)] = cb._v; } });
          cfg.levels = nl; cfg.levelColors = nc;
        }
        collect = () => {
          harvestFibo();
          cfg.levels = cfg.levels.slice().sort((a, b) => a - b);
        };
      } else {
        colorRow('Color', 'color', cfg.color || '#e87722');
        { const [s, vl] = lwSlider('lineWidth', cfg.lineWidth ?? 1.5); addRow('Line Width', s, vl); }
        dashRow('Line Style', 'lineDash', cfg.lineDash);
        collect = () => { cfg.color = getters.color(); cfg.lineWidth = getters.lineWidth(); cfg.lineDash = getters.lineDash(); };
      }

      // tombol bawah
      const sepw = new QWidget(); sepw.setFixedHeight(1); sepw.setStyleSheet('background:#232736;');
      L.addSpacing(16); L.addWidget(sepw); L.addSpacing(12);
      const bar = hbox(8);
      const del = new QPushButton(); del.setObjectName('btnDel'); del.setText('Delete'); del.setFocusPolicy(FocusPolicy.NoFocus);
      const cancel = new QPushButton(); cancel.setObjectName('btnCancel'); cancel.setText('Cancel'); cancel.setFocusPolicy(FocusPolicy.NoFocus);
      const ok = new QPushButton(); ok.setObjectName('btnOk'); ok.setText('Apply'); ok.setFocusPolicy(FocusPolicy.NoFocus);
      bar.l.addWidget(del); bar.l.addStretch(1); bar.l.addWidget(cancel); bar.l.addWidget(ok);
      L.addWidget(bar.w);
      del.addEventListener('clicked', () => { modal.close(); handlers.remove(); });
      cancel.addEventListener('clicked', () => modal.close());
      ok.addEventListener('clicked', () => { collect(); const out = cfg; modal.close(); handlers.apply(out); });
      modal.show();
    }
    build();
  }

  return {
    openBubble, openHvn, openCvd, openGamma, openLiq, openHa, openRenko, openFootprint, openDrawEditor,
    relayout() { for (const m of open) m.relayout(); },
    closeAll() { for (const m of [...open]) m.close(); },
    isOpen: () => open.size > 0
  };
}

module.exports = { createDialogs };
