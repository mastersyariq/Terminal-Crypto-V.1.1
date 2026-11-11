'use strict';
/**
 * chartView — merangkai widget Qt (CanvasWidget) dengan chartCore hasil port dari versi browser.
 * Event Qt diterjemahkan menjadi event ala DOM (mousedown/mousemove/wheel/keydown/…)
 * yang dipakai kode interaksi asli.
 */
const { CanvasWidget } = require('../ui/canvasWidget');
const createChartCore = require('./chartCore');
const { encodePng } = require('../pngEncode');

const clone = x => (x == null ? x : JSON.parse(JSON.stringify(x)));

function createChartView({ engine, prefs, ui }) {
  const cw = new CanvasWidget({ name: 'chart', focus: true });
  cw.widget.setMinimumSize(300, 200);

  // ── shim <canvas> & document ──
  const cvHandlers = {};
  const docHandlers = {};
  const cv = {
    style: {
      set cursor(v) { cw.setCursorName(v); },
      get cursor() { return cw._cursor; }
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, right: cw.widget.width(), bottom: cw.widget.height() }),
    addEventListener: (t, f) => { cvHandlers[t] = f; }
  };

  const stubs = {};
  function stub(id) {
    if (stubs[id]) return stubs[id];
    const s = {
      get textContent() { return s._t || ''; },
      set textContent(v) { s._t = String(v); ui.setElement && ui.setElement(id, 'text', s._t); },
      get innerHTML() { return s._h || ''; },
      set innerHTML(v) { s._h = String(v); ui.setElement && ui.setElement(id, 'html', s._h); },
      className: '',
      style: {},
      dataset: {},
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      addEventListener() {}
    };
    stubs[id] = s;
    return s;
  }
  const document = {
    activeElement: { tagName: 'BODY' },
    getElementById: id => stub(id),
    querySelectorAll: () => [],
    addEventListener: (t, f) => { (docHandlers[t] = docHandlers[t] || []).push(f); }
  };

  const api = {
    candles: async () => clone(engine.getCandles()),
    load: async (s, t) => engine.load(s, t),
    bufferMore: async old => clone(await engine.bufferMore(old)),
    subBars: async (s, iv, a, b) => clone(await engine.subBars(s, iv, a, b)),
    tradeAgg: async () => clone(engine.getTradeAgg()),
    tickSize: async s => engine.getTickSize(s),
    gammaStart: async (s, o) => { if (o) engine.gammaSetOptions(o); return clone(await engine.gammaStart(s)); },
    gammaStop: () => engine.gammaStop(),
    gammaConfig: async o => engine.gammaSetOptions(o),
    // Liquidity Heatmap: store dikembalikan sebagai referensi live (typed array besar, tidak di-clone)
    liquidityStore: () => engine.getLiquidityStore(),
    liquidityConfig: o => engine.liquiditySetOptions(o),
    liquidityClear: () => engine.liquidityClear(),
    heavyAbsorption: async () => clone(engine.getHeavyAbsorption()),
    footprint: async () => clone(engine.getFootprint()),
    haConfig: async o => clone(engine.setHaOptions(o)),
    cvd: async (s, t) => clone(await engine.getCvd(s, t)),
    cvdConfig: async list => engine.setCvdExchanges(list),
    saveDrawings: (s, d) => engine.saveDrawings(s, clone(d)),
    getDrawings: async s => clone(engine.getDrawings(s))
  };

  const core = createChartCore({
    cv, ctx: cw.ctx, document, localStorage: prefs, api, events: engine, ui,
    requestPaint: () => cw.update(),
    createTexture: (rgba, w, h) => ({ w, h, png: encodePng(rgba, w, h) }),
    requestAnimationFrame: fn => setTimeout(() => fn(performance.now()), 16),
    cancelAnimationFrame: id => clearTimeout(id),
    window: {}
  });

  // ── dispatch event ala DOM ──
  const fire = (type, ev) => {
    const e = Object.assign({ preventDefault() {}, stopPropagation() {}, button: 0 }, ev);
    if (cvHandlers[type]) cvHandlers[type](e);
    const list = docHandlers[type];
    if (list) for (const f of list) f(e);
  };
  // listener khusus per target seperti di browser
  const fireCv = (type, ev) => { const e = Object.assign({ preventDefault() {}, stopPropagation() {} }, ev); if (cvHandlers[type]) cvHandlers[type](e); };
  const fireDoc = (type, ev) => { const e = Object.assign({ preventDefault() {}, stopPropagation() {}, button: 0 }, ev); (docHandlers[type] || []).forEach(f => f(e)); };

  cw.on('draw', () => core.renderNow());
  cw.on('resize', (w, h) => core.resize(w, h));

  cw.on('move', (x, y) => fireDoc('mousemove', { clientX: x, clientY: y }));
  cw.on('press', ({ x, y, button }) => {
    ui.closePopups && ui.closePopups();
    cw.widget.setFocus();
    fireDoc('mousemove', { clientX: x, clientY: y });
    if (button === 0) fireCv('mousedown', { clientX: x, clientY: y, button: 0 });
    else if (button === 2) fireCv('contextmenu', { clientX: x, clientY: y, button: 2 });
  });
  cw.on('release', ({ x, y, button }) => fireDoc('mouseup', { clientX: x, clientY: y, button }));
  cw.on('dblclick', ({ x, y }) => fireCv('dblclick', { clientX: x, clientY: y, button: 0 }));
  cw.on('leave', () => fireCv('mouseleave', {}));
  cw.on('wheel', ({ x, y, dy }) => {
    if (x >= 0) fireDoc('mousemove', { clientX: x, clientY: y });
    fireCv('wheel', { deltaY: -dy, clientX: x, clientY: y });
  });
  cw.on('key', ({ key }) => { if (key) fireDoc('keydown', { key }); });

  return { cw, core, widget: cw.widget, api, focus: () => cw.widget.setFocus() };
}

module.exports = { createChartView };
