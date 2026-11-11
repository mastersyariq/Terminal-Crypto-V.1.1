'use strict';
const { QLineEdit, WidgetEventTypes, QKeyEvent } = require('@nodegui/nodegui');
const { CanvasWidget } = require('./canvasWidget');
const { T, F, box, txt, tw, hit, icon } = require('./kit');

const ROW_H = 26;
const LIST_MAX = 300;

const IND_ITEMS = [
  { id: 'volume', label: 'Volume', cfg: false },
  { id: 'vp', label: 'Volume Profile', cfg: false },
  { id: 'bubble', label: 'Bubble Size', cfg: true },
  { id: 'cvd', label: 'Agg. CVD Spot', cfg: true },
  { id: 'ha', label: 'Heavy Absorption', cfg: true },
  { id: 'hvn', label: 'HVN Profile', cfg: true },
  { id: 'liq', label: 'Liquidity Heatmap', cfg: true },
  { id: 'gamma', label: 'Gamma Level', cfg: true, only: 'BTC/ETH' }
];

const CT_ITEMS = [
  { id: 'standard', label: 'Standard', cfg: false },
  { id: 'renko', label: 'Renko', cfg: true },
  { id: 'footprint', label: 'Footprint Delta', cfg: true }
];

/**
 * Dropdown pair (search + list), dropdown Indicator dan dropdown Chart Type.
 * Semuanya child-overlay dari root window (bukan window terpisah), ditutup lewat closeAll().
 */
function createPopups({ root, getSymbol, onSelectPair, getIndicators, onToggleIndicator, onOpenConfig, onStateChange, isDisabled, disabledInfo, getChartType, onSelectChartType, onOpenChartTypeConfig }) {
  const disabledOf = id => !!(isDisabled && isDisabled(id));
  // ────────────────── PAIR ──────────────────
  const PW = 245;
  const pair = { open: false, all: [], filtered: [], scroll: 0, hover: -1, q: '' };
  const pcw = new CanvasWidget({ name: 'pairPopup', parent: root });
  const pw = pcw.widget;
  pw.hide();

  const input = new QLineEdit(pw);
  input.setObjectName('pairSearch');
  input.setPlaceholderText('Search pair\u2026');
  input.setGeometry(8, 8, PW - 16, 26);
  input.setStyleSheet(
    'QLineEdit{background:#10131a;border:1px solid #2d3345;color:#f1f5f9;padding:2px 8px;border-radius:3px;font-size:11px;font-family:Consolas;}' +
    'QLineEdit:focus{border:1px solid #ff8c37;}'
  );

  const listH = () => Math.min(LIST_MAX, Math.max(ROW_H, pair.filtered.length * ROW_H));
  const LIST_Y = 8 + 26 + 4 + 14;
  const popupH = () => LIST_Y + listH() + 2;

  function applyFilter() {
    const q = pair.q.trim().toLowerCase();
    pair.filtered = q ? pair.all.filter(p => p.symbol.toLowerCase().includes(q) || (p.base || '').toLowerCase().includes(q)) : pair.all.slice();
    pair.scroll = 0; pair.hover = -1;
    pw.resize(PW, popupH());
    pcw.update();
  }
  input.addEventListener('textChanged', t => { pair.q = t; applyFilter(); });
  input.addEventListener('returnPressed', () => { if (pair.filtered[0]) choose(pair.filtered[0]); });
  input.addEventListener(WidgetEventTypes.KeyPress, n => {
    const e = new QKeyEvent(n);
    if (e.key() === 0x01000000) closePair();
  });

  function choose(p) { closeAll(); onSelectPair(p.symbol); }

  pcw.on('draw', (ctx, W, H) => {
    box(ctx, 0, 0, W, H, T.pop, '#2d3345', 4);
    txt(ctx, `${pair.filtered.length} pairs`, W - 10, 8 + 26 + 4 + 7, F(9), T.dim, 'right');
    const cur = (getSymbol() || '').toUpperCase();
    ctx.save();
    ctx.beginPath(); ctx.rect(1, LIST_Y, W - 2, listH()); ctx.clip();
    const first = Math.max(0, Math.floor(pair.scroll / ROW_H));
    const last = Math.min(pair.filtered.length - 1, Math.ceil((pair.scroll + listH()) / ROW_H));
    for (let i = first; i <= last; i++) {
      const p = pair.filtered[i];
      const y = LIST_Y + i * ROW_H - pair.scroll;
      const on = p.symbol === cur;
      if (on) { ctx.fillStyle = '#2a1a08'; ctx.fillRect(1, y, W - 2, ROW_H); ctx.fillStyle = T.accent; ctx.fillRect(1, y, 2, ROW_H); }
      else if (pair.hover === i) { ctx.fillStyle = T.popHover; ctx.fillRect(1, y, W - 2, ROW_H); }
      ctx.fillStyle = T.row; ctx.fillRect(1, y + ROW_H - 1, W - 2, 1);
      const base = p.base || p.symbol.replace(/USDT$/, '');
      let x = 11;
      txt(ctx, base, x, y + ROW_H / 2, F(12, true), on ? T.accent : T.text2); x += tw(ctx, base, F(12, true)) + 5;
      txt(ctx, '/USDT', x, y + ROW_H / 2 + 1, F(9), T.dim);
      txt(ctx, '.P', W - 11, y + ROW_H / 2 + 1, F(9), T.dim2, 'right');
    }
    ctx.restore();
    // scrollbar tipis
    const total = pair.filtered.length * ROW_H;
    if (total > listH()) {
      const th = Math.max(20, listH() * listH() / total);
      const ty = LIST_Y + (pair.scroll / (total - listH())) * (listH() - th);
      box(ctx, W - 5, ty, 3, th, '#2a3042', null, 2);
    }
  });
  pcw.on('move', (x, y) => {
    let i = -1;
    if (y >= LIST_Y && y < LIST_Y + listH()) i = Math.floor((y - LIST_Y + pair.scroll) / ROW_H);
    if (i >= pair.filtered.length) i = -1;
    if (i !== pair.hover) { pair.hover = i; pcw.setCursorName(i >= 0 ? 'pointer' : ''); pcw.update(); }
  });
  pcw.on('leave', () => { pair.hover = -1; pcw.update(); });
  pcw.on('press', ({ x, y }) => {
    if (y >= LIST_Y && y < LIST_Y + listH()) {
      const i = Math.floor((y - LIST_Y + pair.scroll) / ROW_H);
      if (pair.filtered[i]) choose(pair.filtered[i]);
    }
  });
  pcw.on('wheel', ({ dy }) => {
    const total = pair.filtered.length * ROW_H;
    const max = Math.max(0, total - listH());
    pair.scroll = Math.max(0, Math.min(max, pair.scroll - (dy / 120) * ROW_H * 3));
    pcw.update();
  });

  function openPair(btnRect, origin) {
    closeInd(); closeCt();
    pair.open = true;
    pair.q = ''; input.setText('');
    applyFilter();
    pw.move(Math.round(origin.x + btnRect.x), Math.round(origin.y + btnRect.y + btnRect.h + 3));
    pw.resize(PW, popupH());
    pw.show(); pw.raise();
    input.setFocus();
    // scroll ke pair aktif
    const cur = (getSymbol() || '').toUpperCase();
    const idx = pair.filtered.findIndex(p => p.symbol === cur);
    if (idx >= 0) pair.scroll = Math.max(0, idx * ROW_H - listH() / 2);
    pcw.update();
    onStateChange();
  }
  function closePair() {
    if (!pair.open) return;
    pair.open = false; pw.hide(); onStateChange();
  }

  // ────────────────── INDICATOR ──────────────────
  const IW = 190, IROW = 29;
  const ind = { open: false, hover: -1, hoverCfg: false };
  const icw = new CanvasWidget({ name: 'indPopup', parent: root });
  const iw = icw.widget;
  iw.hide();
  const indH = () => 4 + IND_ITEMS.length * IROW - 1 + 4 + 2;

  const cfgRect = i => ({ x: IW - 10 - 20, y: 1 + 4 + i * IROW + 4, w: 20, h: 20 });

  icw.on('draw', (ctx, W, H) => {
    box(ctx, 0, 0, W, H, T.pop, '#2d3345', 4);
    const st = getIndicators();
    IND_ITEMS.forEach((it, i) => {
      const y = 1 + 4 + i * IROW;
      const dis = disabledOf(it.id);
      const hv = ind.hover === i && !dis;
      if (hv) { ctx.fillStyle = T.popHover; ctx.fillRect(1, y, W - 2, IROW - 1); }
      if (i < IND_ITEMS.length - 1) { ctx.fillStyle = T.row; ctx.fillRect(1, y + IROW - 1, W - 2, 1); }
      const on = !!st[it.id] && !dis;
      if (dis) box(ctx, 11, y + 7, 14, 14, '#12151d', '#2a3042', 3);
      else box(ctx, 11, y + 7, 14, 14, on ? T.accentBg : '#12151d', on ? T.accent : '#3e465e', 3);
      if (on) { ctx.fillStyle = T.accent; ctx.fillRect(15, y + 11, 6, 6); }
      txt(ctx, it.label, 33, y + 14, F(11), dis ? '#4b5368' : hv ? '#ffffff' : T.text2);
      if (dis) {
        const di = disabledInfo ? disabledInfo(it.id) : null;
        txt(ctx, (di && di.tag) || it.only || '', W - 11, y + 14.5, F(9), '#3d4457', 'right');   // tidak tersedia (pair / tipe chart) → abu-abu
      } else if (it.cfg) {
        const r = cfgRect(i);
        const hc = hv && ind.hoverCfg;
        if (hc) box(ctx, r.x, r.y, r.w, r.h, '#252b3d', null, 3);
        icon(ctx, 'dots', r.x + r.w / 2, r.y + r.h / 2, hc ? T.accent : T.dim);
      }
    });
  });
  icw.on('move', (x, y) => {
    const i = Math.floor((y - 5) / IROW);
    const valid = i >= 0 && i < IND_ITEMS.length && y >= 5;
    const dis = valid && disabledOf(IND_ITEMS[i].id);
    const hc = valid && !dis && IND_ITEMS[i].cfg && hit(cfgRect(i), x, y);
    const ni = valid ? i : -1;
    if (ni !== ind.hover || hc !== ind.hoverCfg) {
      ind.hover = ni; ind.hoverCfg = hc;
      icw.setCursorName(ni >= 0 && !dis ? 'pointer' : '');
      const di = dis && disabledInfo ? disabledInfo(IND_ITEMS[i].id) : null;
      icw.widget.setToolTip(dis ? ((di && di.tip) || 'Gamma Level hanya tersedia untuk BTC dan ETH (data opsi Deribit)') : '');
      icw.update();
    }
  });
  icw.on('leave', () => { ind.hover = -1; ind.hoverCfg = false; icw.update(); });
  icw.on('press', async ({ x, y, button }) => {
    if (button !== 0) return;
    const i = Math.floor((y - 5) / IROW);
    if (i < 0 || i >= IND_ITEMS.length) return;
    const it = IND_ITEMS[i];
    if (disabledOf(it.id)) return;   // tidak bisa diklik
    if (it.cfg && hit(cfgRect(i), x, y)) { closeAll(); onOpenConfig(it.id); return; }
    await onToggleIndicator(it.id);
    icw.update();
  });

  function openInd(btnRect, origin) {
    closePair(); closeCt();
    ind.open = true;
    iw.move(Math.round(origin.x + btnRect.x), Math.round(origin.y + btnRect.y + btnRect.h + 3));
    iw.resize(IW, indH());
    iw.show(); iw.raise(); icw.update();
    onStateChange();
  }
  function closeInd() {
    if (!ind.open) return;
    ind.open = false; iw.hide(); onStateChange();
  }

  // ────────────────── CHART TYPE ──────────────────
  const CW_ = 190, CROW = 29;
  const ct = { open: false, hover: -1, hoverCfg: false };
  const ccw = new CanvasWidget({ name: 'ctypePopup', parent: root });
  const cw_ = ccw.widget;
  cw_.hide();
  const ctH = () => 4 + CT_ITEMS.length * CROW - 1 + 4 + 2;
  const ctCfgRect = i => ({ x: CW_ - 10 - 20, y: 1 + 4 + i * CROW + 4, w: 20, h: 20 });

  ccw.on('draw', (ctx, W, H) => {
    box(ctx, 0, 0, W, H, T.pop, '#2d3345', 4);
    const cur = getChartType ? getChartType() : 'standard';
    CT_ITEMS.forEach((it, i) => {
      const y = 1 + 4 + i * CROW;
      const hv = ct.hover === i;
      if (hv) { ctx.fillStyle = T.popHover; ctx.fillRect(1, y, W - 2, CROW - 1); }
      if (i < CT_ITEMS.length - 1) { ctx.fillStyle = T.row; ctx.fillRect(1, y + CROW - 1, W - 2, 1); }
      const on = it.id === cur;
      box(ctx, 11, y + 7, 14, 14, on ? T.accentBg : '#12151d', on ? T.accent : '#3e465e', 7);     // radio
      if (on) box(ctx, 15, y + 11, 6, 6, T.accent, null, 3);
      txt(ctx, it.label, 33, y + 14, F(11, on), on ? T.accent : hv ? '#ffffff' : T.text2);
      if (it.cfg) {
        const r = ctCfgRect(i);
        const hc = hv && ct.hoverCfg;
        if (hc) box(ctx, r.x, r.y, r.w, r.h, '#252b3d', null, 3);
        icon(ctx, 'dots', r.x + r.w / 2, r.y + r.h / 2, hc ? T.accent : T.dim);
      }
    });
  });
  ccw.on('move', (x, y) => {
    const i = Math.floor((y - 5) / CROW);
    const valid = i >= 0 && i < CT_ITEMS.length && y >= 5;
    const hc = valid && CT_ITEMS[i].cfg && hit(ctCfgRect(i), x, y);
    const ni = valid ? i : -1;
    if (ni !== ct.hover || hc !== ct.hoverCfg) {
      ct.hover = ni; ct.hoverCfg = hc;
      ccw.setCursorName(ni >= 0 ? 'pointer' : '');
      ccw.update();
    }
  });
  ccw.on('leave', () => { ct.hover = -1; ct.hoverCfg = false; ccw.update(); });
  ccw.on('press', async ({ x, y, button }) => {
    if (button !== 0) return;
    const i = Math.floor((y - 5) / CROW);
    if (i < 0 || i >= CT_ITEMS.length) return;
    const it = CT_ITEMS[i];
    if (it.cfg && hit(ctCfgRect(i), x, y)) { closeAll(); onOpenChartTypeConfig && onOpenChartTypeConfig(it.id); return; }
    closeAll();
    if (onSelectChartType) await onSelectChartType(it.id);
  });

  function openCt(btnRect, origin) {
    closePair(); closeInd();
    ct.open = true;
    cw_.move(Math.round(origin.x + btnRect.x), Math.round(origin.y + btnRect.y + btnRect.h + 3));
    cw_.resize(CW_, ctH());
    cw_.show(); cw_.raise(); ccw.update();
    onStateChange();
  }
  function closeCt() {
    if (!ct.open) return;
    ct.open = false; cw_.hide(); onStateChange();
  }

  function closeAll() { closePair(); closeInd(); closeCt(); }

  return {
    togglePair(btnRect, origin) { pair.open ? closePair() : openPair(btnRect, origin); },
    toggleInd(btnRect, origin) { ind.open ? closeInd() : openInd(btnRect, origin); },
    toggleCt(btnRect, origin) { ct.open ? closeCt() : openCt(btnRect, origin); },
    closeAll,
    isPairOpen: () => pair.open,
    isIndOpen: () => ind.open,
    isCtOpen: () => ct.open,
    setPairs(list) { pair.all = list || []; if (pair.open) applyFilter(); else pair.filtered = pair.all.slice(); },
    refresh() { icw.update(); pcw.update(); ccw.update(); }
  };
}

module.exports = { createPopups };
