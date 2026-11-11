'use strict';
/**
 * CanvasWidget — QWidget yang digambar lewat Canvas2D shim (nodegui/canvas2d.js).
 * Dipakai untuk chart, toolbar, sidebar, status bar, kalender, dan popup list,
 * sehingga seluruh tampilan identik dengan versi browser.
 */
const {
  QWidget, QPainter, QMouseEvent, QWheelEvent, QKeyEvent,
  WidgetEventTypes, RenderHint, CursorShape, FocusPolicy
} = require('@nodegui/nodegui');
const { Canvas2D } = require('../canvas2d');

const CURSORS = {
  '': CursorShape.ArrowCursor,
  default: CursorShape.ArrowCursor,
  crosshair: CursorShape.CrossCursor,
  pointer: CursorShape.PointingHandCursor,
  grabbing: CursorShape.ClosedHandCursor,
  grab: CursorShape.OpenHandCursor,
  'ns-resize': CursorShape.SizeVerCursor,
  'ew-resize': CursorShape.SizeHorCursor,
  'col-resize': CursorShape.SizeHorCursor,
  'nwse-resize': CursorShape.SizeFDiagCursor,
  'nesw-resize': CursorShape.SizeBDiagCursor,
  move: CursorShape.SizeAllCursor,
  text: CursorShape.IBeamCursor
};

// Qt::Key → nama key ala DOM (hanya yang dipakai aplikasi)
const QT_KEYS = {
  0x01000000: 'Escape', 0x01000003: 'Backspace', 0x01000007: 'Delete',
  0x01000012: 'ArrowLeft', 0x01000013: 'ArrowUp', 0x01000014: 'ArrowRight', 0x01000015: 'ArrowDown',
  0x01000004: 'Enter', 0x01000005: 'Enter', 0x01000001: 'Tab'
};
function keyName(code, text) {
  if (QT_KEYS[code]) return QT_KEYS[code];
  if (text) return text;
  return '';
}

function evPos(native) {
  const e = new QMouseEvent(native);
  let x, y;
  try { const p = e.position(); x = p.x; y = p.y; } catch (_) {}
  if (typeof x !== 'number' || typeof y !== 'number' || isNaN(x) || isNaN(y)) { x = e.x(); y = e.y(); }
  return { x, y, button: e.button(), e };
}

// Qt::MouseButton → DOM button (0 kiri, 1 tengah, 2 kanan)
function domButton(b) { return b === 2 ? 2 : b === 4 ? 1 : 0; }

class CanvasWidget {
  constructor(opts = {}) {
    this.widget = opts.parent ? new QWidget(opts.parent) : new QWidget();
    if (opts.name) this.widget.setObjectName(opts.name);
    this.ctx = new Canvas2D();
    this.cb = {};
    this.mx = -1; this.my = -1;
    this._cursor = '';
    const w = this.widget;
    w.setMouseTracking(opts.tracking !== false);
    if (opts.focus) w.setFocusPolicy(FocusPolicy.ClickFocus);

    w.addEventListener(WidgetEventTypes.Paint, () => {
      const p = new QPainter(w);
      try {
        p.setRenderHint(RenderHint.Antialiasing, true);
        p.setRenderHint(RenderHint.TextAntialiasing, true);
        this.ctx.begin(p, w.width(), w.height());
        if (this.cb.draw) this.cb.draw(this.ctx, w.width(), w.height());
      } catch (e) {
        console.error('[paint:' + (opts.name || '?') + ']', e && e.stack || e);
      } finally {
        this.ctx.end();
        p.end();
      }
    });

    w.addEventListener(WidgetEventTypes.Resize, () => {
      if (this.cb.resize) this.cb.resize(w.width(), w.height());
    });

    w.addEventListener(WidgetEventTypes.MouseMove, (n) => {
      const { x, y } = evPos(n);
      this.mx = x; this.my = y;
      if (this.cb.move) this.cb.move(x, y);
    });
    w.addEventListener(WidgetEventTypes.MouseButtonPress, (n) => {
      const { x, y, button } = evPos(n);
      this.mx = x; this.my = y;
      // Fallback double-click: bila Qt tidak mengirim event DblClick (mis. input sintetis),
      // deteksi sendiri dari dua press berurutan. Bila Qt mengirim DblClick, press kedua tidak datang.
      const now = Date.now(), lp = this._lastPress;
      let dbl = false;
      if (lp && now - lp.t < 450 && Math.abs(x - lp.x) < 6 && Math.abs(y - lp.y) < 6 && lp.b === button) dbl = true;
      this._lastPress = dbl ? null : { t: now, x, y, b: button };
      if (this.cb.press) this.cb.press({ x, y, button: domButton(button) });
      if (dbl && this.cb.dblclick) this.cb.dblclick({ x, y, button: domButton(button) });
    });
    w.addEventListener(WidgetEventTypes.MouseButtonRelease, (n) => {
      const { x, y, button } = evPos(n);
      if (this.cb.release) this.cb.release({ x, y, button: domButton(button) });
    });
    w.addEventListener(WidgetEventTypes.MouseButtonDblClick, (n) => {
      const { x, y, button } = evPos(n);
      this._lastPress = null;
      if (this.cb.dblclick) this.cb.dblclick({ x, y, button: domButton(button) });
      else if (this.cb.press) this.cb.press({ x, y, button: domButton(button) }); // klik cepat tidak boleh hilang
    });
    w.addEventListener(WidgetEventTypes.Leave, () => {
      this.mx = -1; this.my = -1;
      if (this.cb.leave) this.cb.leave();
    });
    w.addEventListener(WidgetEventTypes.Wheel, (n) => {
      const e = new QWheelEvent(n);
      const d = e.angleDelta();
      let x = this.mx, y = this.my;
      try { const p = e.position(); if (p && typeof p.x === 'number') { x = p.x; y = p.y; } } catch (_) {}
      if (this.cb.wheel) this.cb.wheel({ x, y, dx: d.x, dy: d.y });
    });
    w.addEventListener(WidgetEventTypes.KeyPress, (n) => {
      const e = new QKeyEvent(n);
      if (this.cb.key) this.cb.key({ key: keyName(e.key(), e.text()), code: e.key(), text: e.text() });
    });
  }

  on(type, fn) { this.cb[type] = fn; return this; }
  update() { this.widget.update(); }

  setCursorName(name) {
    name = name || '';
    if (name === this._cursor) return;
    this._cursor = name;
    this.widget.setCursor(CURSORS[name] !== undefined ? CURSORS[name] : CursorShape.ArrowCursor);
  }
}

module.exports = { CanvasWidget, keyName };
