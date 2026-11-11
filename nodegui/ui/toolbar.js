'use strict';
const { CanvasWidget } = require('./canvasWidget');
const { T, F, box, txt, tw, hit, icon } = require('./kit');

const TFS = [['1', '1m'], ['5', '5m'], ['15', '15m'], ['30', '30m'], ['60', '1H'], ['240', '4H'], ['D', '1D'], ['W', '1W']];
const TOOLS = [
  ['line', 'Trend Line (L)'], ['rect', 'Rectangle (R)'], ['fibo', 'Fibonacci Retracement (F)'],
  ['path', 'Path with Arrow (P)'], ['longshort', 'Long/Short Position (S)']
];

/** Toolbar atas 40px: pair, timeframe, drawing tools, indicator, jump-to-latest, status dot. */
function createToolbar(cb) {
  const cw = new CanvasWidget({ name: 'toolbar' });
  cw.widget.setFixedHeight(40);
  const st = {
    sym: '\u2014\u2014', tf: '60', tool: null, pairOpen: false, indOpen: false,
    ctOpen: false, ctLabel: 'Standard', ctAlt: false,
    tv: 'default', ws: false, hover: null, layout: null
  };

  function computeLayout(ctx, W) {
    const L = { tf: [], tools: [] };
    let x = 12;
    L.pair = { x, y: 8, w: 155, h: 25 }; x += 155 + 10;
    L.sep1 = x + 8; x += 17;
    for (const [id, lbl] of TFS) {
      const w = Math.ceil(tw(ctx, lbl, F(11, st.tf === id))) + 16 + 2;
      L.tf.push({ id, lbl, x, y: 9, w, h: 22 }); x += w + 1;
    }
    x -= 1;
    L.sep2 = x + 8; x += 17;
    x += 2 + 4;
    for (const [id, tip] of TOOLS) { L.tools.push({ id, tip, x, y: 8, w: 28, h: 25 }); x += 28 + 3; }
    L.del = { x, y: 8, w: 28, h: 25, tip: 'Delete selected (Del / Backspace)' }; x += 28;
    x += 4 + 2;
    L.sep3 = x + 8; x += 17;
    x += 8;
    L.ind = { x, y: 8, w: 115, h: 25 };
    x += 115 + 8;
    L.ctype = { x, y: 8, w: 124, h: 25 };      // dropdown tipe candle (Standard / Renko / Footprint Delta)
    // kanan
    let rx = W - 12;
    const dotFont = F(9);
    const wsT = st.ws ? 'WS \u25cf' : 'WS \u25cb', tvT = 'TV \u25cf';
    const wsW = Math.ceil(tw(ctx, wsT, dotFont)) + 18, tvW = Math.ceil(tw(ctx, tvT, dotFont)) + 18;
    L.ws = { x: rx - wsW, y: 11, w: wsW, h: 17, text: wsT }; rx -= wsW + 8;
    L.tv = { x: rx - tvW, y: 11, w: tvW, h: 17, text: tvT }; rx -= tvW + 8;
    L.go = { x: rx - 28, y: 10, w: 28, h: 21 };
    return L;
  }

  cw.on('draw', (ctx, W, H) => {
    ctx.fillStyle = T.panel; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = T.border; ctx.fillRect(0, H - 1, W, 1);
    const L = st.layout = computeLayout(ctx, W);
    const hv = st.hover;

    // pair button
    {
      const r = L.pair, h = hv === 'pair' || st.pairOpen;
      box(ctx, r.x, r.y, r.w, r.h, T.btn, h ? T.accent : '#2d3345', 3);
      txt(ctx, st.sym + '.P', r.x + 11, r.y + r.h / 2 + 0.5, F(12, true), h ? T.accent : T.text);
      icon(ctx, 'chev', r.x + r.w - 15, r.y + r.h / 2, T.dim);
    }
    for (const k of ['sep1', 'sep2', 'sep3']) { ctx.fillStyle = '#282d3c'; ctx.fillRect(L[k], 10, 1, 20); }

    // timeframes
    for (const b of L.tf) {
      const on = st.tf === b.id, h = hv === 'tf:' + b.id;
      if (on) box(ctx, b.x, b.y, b.w, b.h, T.accentBg, T.accentBorder, 3);
      else if (h) box(ctx, b.x, b.y, b.w, b.h, T.hover, null, 3);
      txt(ctx, b.lbl, b.x + b.w / 2, b.y + b.h / 2 + 0.5, F(11, on), on ? T.accent : h ? '#f8fafc' : T.dim, 'center');
    }

    // drawing tools
    for (const b of L.tools) {
      const on = st.tool === b.id, h = hv === 'tool:' + b.id;
      if (on) { box(ctx, b.x - 1, b.y - 1, b.w + 2, b.h + 2, 'rgba(255,140,55,.12)', null, 4); box(ctx, b.x, b.y, b.w, b.h, T.accentAct, T.accent, 3); }
      else box(ctx, b.x, b.y, b.w, b.h, h ? T.btnHover : T.btn, h ? '#3e465e' : '#2d3345', 3);
      icon(ctx, b.id, b.x + b.w / 2, b.y + b.h / 2, on ? T.accent : h ? '#fff' : T.text2);
    }
    {
      const b = L.del, h = hv === 'del';
      box(ctx, b.x, b.y, b.w, b.h, h ? T.redBg : T.btn, h ? T.redBorder : '#2d3345', 3);
      icon(ctx, 'trash', b.x + b.w / 2, b.y + b.h / 2, h ? T.red : T.dim, 1.2);
    }

    // indicator button
    {
      const r = L.ind, h = hv === 'ind' || st.indOpen;
      box(ctx, r.x, r.y, r.w, r.h, T.btn, h ? T.accent : '#2d3345', 3);
      txt(ctx, 'Indicator', r.x + 11, r.y + r.h / 2 + 0.5, F(11, true), h ? T.accent : T.text);
      icon(ctx, 'chev', r.x + r.w - 15, r.y + r.h / 2, T.dim);
    }

    // chart type button (di sebelah Indicator)
    {
      const r = L.ctype, h = hv === 'ctype' || st.ctOpen;
      box(ctx, r.x, r.y, r.w, r.h, T.btn, h ? T.accent : (st.ctAlt ? T.accentBorder : '#2d3345'), 3);
      txt(ctx, st.ctLabel, r.x + 11, r.y + r.h / 2 + 0.5, F(11, true), h || st.ctAlt ? T.accent : T.text);
      icon(ctx, 'chev', r.x + r.w - 15, r.y + r.h / 2, T.dim);
    }

    // kanan: go, TV, WS
    {
      const b = L.go, h = hv === 'go';
      box(ctx, b.x, b.y, b.w, b.h, h ? '#232838' : T.btn, h ? T.accentBorder : '#2d3345', 3);
      icon(ctx, 'ff', b.x + b.w / 2, b.y + b.h / 2, h ? T.accent : T.dim);
    }
    {
      const b = L.tv;
      const c = st.tv === 'loaded' ? ['#0e1e0e', '#287a28', '#183818'] : st.tv === 'err' ? ['#260e0e', '#f87171', '#5c1d1d'] : ['#0f2416', '#34d399', '#1c5230'];
      box(ctx, b.x, b.y, b.w, b.h, c[0], c[2], 2);
      txt(ctx, b.text, b.x + b.w / 2, b.y + b.h / 2 + 0.5, F(9), c[1], 'center');
    }
    {
      const b = L.ws;
      const c = st.ws ? ['#120800', '#e87722', '#5a2e06'] : [T.btn, T.dim, '#2d3345'];
      box(ctx, b.x, b.y, b.w, b.h, c[0], c[2], 2);
      txt(ctx, b.text, b.x + b.w / 2, b.y + b.h / 2 + 0.5, F(9), c[1], 'center');
    }
  });

  function target(x, y) {
    const L = st.layout; if (!L) return null;
    if (hit(L.pair, x, y)) return { key: 'pair' };
    for (const b of L.tf) if (hit(b, x, y)) return { key: 'tf:' + b.id, id: b.id };
    for (const b of L.tools) if (hit(b, x, y)) return { key: 'tool:' + b.id, id: b.id, tip: b.tip };
    if (hit(L.del, x, y)) return { key: 'del', tip: L.del.tip };
    if (hit(L.ind, x, y)) return { key: 'ind' };
    if (hit(L.ctype, x, y)) return { key: 'ctype', tip: 'Chart type' };
    if (hit(L.go, x, y)) return { key: 'go', tip: 'Jump to latest' };
    return null;
  }

  cw.on('move', (x, y) => {
    const t = target(x, y);
    const key = t ? t.key : null;
    if (key !== st.hover) {
      st.hover = key; cw.setCursorName(t ? 'pointer' : '');
      cw.widget.setToolTip(t && t.tip ? t.tip : '');
      cw.update();
    }
  });
  cw.on('leave', () => { st.hover = null; cw.update(); });
  cw.on('press', ({ x, y, button }) => {
    if (button !== 0) return;
    const t = target(x, y);
    if (!t) { cb.onBackground && cb.onBackground(); return; }
    const L = st.layout;
    if (t.key === 'pair') cb.onPair(L.pair);
    else if (t.key === 'ind') cb.onInd(L.ind);
    else if (t.key === 'ctype') cb.onCtype(L.ctype);
    else {
      cb.onBackground && cb.onBackground();
      if (t.key.startsWith('tf:')) cb.onTf(t.id);
      else if (t.key.startsWith('tool:')) cb.onTool(t.id);
      else if (t.key === 'del') cb.onDelete();
      else if (t.key === 'go') cb.onGo();
    }
  });

  return {
    widget: cw.widget,
    getLayout: () => st.layout,
    setSymbol(s) { st.sym = s; cw.update(); },
    setActiveTf(tf) { st.tf = tf; cw.update(); },
    setActiveTool(t) { st.tool = t || null; cw.update(); },
    setTv(state) { st.tv = state; cw.update(); },
    setWs(on) { if (st.ws !== !!on) { st.ws = !!on; cw.update(); } },
    setPairOpen(on) { st.pairOpen = !!on; cw.update(); },
    setIndOpen(on) { st.indOpen = !!on; cw.update(); },
    setCtypeOpen(on) { st.ctOpen = !!on; cw.update(); },
    /** label tombol Chart Type; alt = true bila bukan Standard (tombol diberi aksen) */
    setChartType(label, alt) { st.ctLabel = label || 'Standard'; st.ctAlt = !!alt; cw.update(); }
  };
}

module.exports = { createToolbar };
