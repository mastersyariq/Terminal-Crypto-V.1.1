'use strict';
/**
 * Canvas2D-compatible rendering context on top of NodeGUI's QPainter.
 *
 * Tujuan: menjalankan kode render canvas asli (public/index.html versi browser)
 * secara hampir verbatim di dalam widget Qt, tanpa browser dan tanpa port.
 *
 * Catatan teknis (NodeGUI 0.74 / Qt 6):
 *  - QPainter di binding NodeGUI tidak punya clip, QPen tidak punya dash-pattern
 *    dan lebar pen hanya integer. Jadi clip (rect), dash, dan polyline di-handle
 *    secara manual di sini (clip = intersect geometri, dash = dipecah jadi segmen).
 *  - Semua clip di kode asli berbentuk rect sumbu-sejajar, jadi cukup clip rect.
 */

const {
  QColor, QPen, QBrush, QFont, QFontMetrics, QPainterPath,
  PenStyle, PenCapStyle, PenJoinStyle, BrushStyle,
  QPixmap, AspectRatioMode, TransformationMode
} = require('@nodegui/nodegui');

// ───────────────────────── color parsing / caches ─────────────────────────
const NAMED = {
  white: [255, 255, 255, 1], black: [0, 0, 0, 1], transparent: [0, 0, 0, 0],
  red: [255, 0, 0, 1], green: [0, 128, 0, 1], blue: [0, 0, 255, 1], gold: [255, 215, 0, 1]
};
const parsedCache = new Map();

function parseColor(s) {
  let v = parsedCache.get(s);
  if (v) return v;
  v = [0, 0, 0, 1];
  const str = String(s).trim().toLowerCase();
  let m;
  if (str[0] === '#') {
    let h = str.slice(1);
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    if (h.length === 4) h = h.split('').map(c => c + c).join('');
    if (h.length === 6 || h.length === 8) {
      v = [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16),
        h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1];
    }
  } else if ((m = str.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/))) {
    v = [Math.round(+m[1]), Math.round(+m[2]), Math.round(+m[3]), m[4] === undefined ? 1 : Math.max(0, Math.min(1, +m[4]))];
  } else if (NAMED[str]) {
    v = NAMED[str];
  }
  if (parsedCache.size > 5000) parsedCache.clear();
  parsedCache.set(s, v);
  return v;
}

const qcolorCache = new Map();
function qcolorKey(r, g, b, a255) { return ((r << 24) ^ (g << 16) ^ (b << 8) ^ a255) + ':' + r + ':' + g + ':' + b + ':' + a255; }
function getQColor(css, alphaMul) {
  const p = parseColor(css);
  const a255 = Math.max(0, Math.min(255, Math.round(p[3] * alphaMul * 255)));
  const key = qcolorKey(p[0], p[1], p[2], a255);
  let q = qcolorCache.get(key);
  if (!q) {
    if (qcolorCache.size > 3000) qcolorCache.clear();
    q = { color: new QColor(p[0], p[1], p[2], a255), key, a255 };
    qcolorCache.set(key, q);
  }
  return q;
}

const penCache = new Map();
function getPen(qc, width) {
  const key = qc.key + '|' + width;
  let p = penCache.get(key);
  if (!p) {
    if (penCache.size > 2000) penCache.clear();
    const pen = new QPen();
    pen.setColor(qc.color);
    pen.setStyle(PenStyle.SolidLine);
    pen.setCapStyle(PenCapStyle.FlatCap);
    pen.setWidth(width);
    p = { pen, key: 'P' + key };
    penCache.set(key, p);
  }
  return p;
}

const brushCache = new Map();
function getBrush(qc) {
  let b = brushCache.get(qc.key);
  if (!b) {
    if (brushCache.size > 2000) brushCache.clear();
    b = new QBrush(qc.color, BrushStyle.SolidPattern);
    brushCache.set(qc.key, b);
  }
  return b;
}

// ───────────────────────── fonts ─────────────────────────
const fontCache = new Map();
function getFont(str) {
  let f = fontCache.get(str);
  if (f) return f;
  let size = 10, bold = false, italic = false, family = 'Consolas';
  const m = String(str).match(/^\s*((?:(?:bold|bolder|italic|normal|oblique|[1-9]00)\s+)*)([\d.]+)px\s*(.*)$/i);
  if (m) {
    bold = /bold|[6-9]00/i.test(m[1]);
    italic = /italic|oblique/i.test(m[1]);
    size = parseFloat(m[2]) || 10;
    const fam = (m[3] || '').split(',')[0].replace(/['"]/g, '').trim();
    if (fam && !/^monospace$/i.test(fam)) family = fam;
  }
  const qf = new QFont();
  qf.setFamily(family);
  qf.setPixelSize(Math.max(1, Math.round(size)));
  qf.setBold(bold);
  if (italic) qf.setItalic(true);
  const fm = new QFontMetrics(qf);
  f = { qf, fm, key: str, ascent: fm.ascent(), descent: fm.descent(), widths: new Map() };
  if (fontCache.size > 200) fontCache.clear();
  fontCache.set(str, f);
  return f;
}

// ───────────────────────── geometry helpers ─────────────────────────
/** Liang–Barsky: clip segment to rect. Returns [x1,y1,x2,y2] or null. */
function clipSegment(x1, y1, x2, y2, c) {
  let t0 = 0, t1 = 1;
  const dx = x2 - x1, dy = y2 - y1;
  const p = [-dx, dx, -dy, dy];
  const q = [x1 - c.x0, c.x1 - x1, y1 - c.y0, c.y1 - y1];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return null;
    } else {
      const r = q[i] / p[i];
      if (p[i] < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
      else { if (r < t0) return null; if (r < t1) t1 = r; }
    }
  }
  return [x1 + t0 * dx, y1 + t0 * dy, x1 + t1 * dx, y1 + t1 * dy];
}

/** Sutherland–Hodgman polygon clip against an axis-aligned rect. pts = [x,y,x,y,...] */
function clipPolygon(pts, c) {
  let out = pts;
  const edges = [
    (x, y) => x >= c.x0, (x, y) => x <= c.x1, (x, y) => y >= c.y0, (x, y) => y <= c.y1
  ];
  const inter = [
    (ax, ay, bx, by) => { const t = (c.x0 - ax) / (bx - ax); return [c.x0, ay + t * (by - ay)]; },
    (ax, ay, bx, by) => { const t = (c.x1 - ax) / (bx - ax); return [c.x1, ay + t * (by - ay)]; },
    (ax, ay, bx, by) => { const t = (c.y0 - ay) / (by - ay); return [ax + t * (bx - ax), c.y0]; },
    (ax, ay, bx, by) => { const t = (c.y1 - ay) / (by - ay); return [ax + t * (bx - ax), c.y1]; }
  ];
  for (let e = 0; e < 4; e++) {
    const inp = out; out = [];
    const n = inp.length / 2;
    if (!n) return out;
    let px = inp[(n - 1) * 2], py = inp[(n - 1) * 2 + 1];
    let pin = edges[e](px, py);
    for (let i = 0; i < n; i++) {
      const cx = inp[i * 2], cy = inp[i * 2 + 1];
      const cin = edges[e](cx, cy);
      if (cin) {
        if (!pin) { const ip = inter[e](px, py, cx, cy); out.push(ip[0], ip[1]); }
        out.push(cx, cy);
      } else if (pin) {
        const ip = inter[e](px, py, cx, cy); out.push(ip[0], ip[1]);
      }
      px = cx; py = cy; pin = cin;
    }
  }
  return out;
}

// ───────────────────────── context ─────────────────────────
class Canvas2D {
  constructor() {
    this.painter = null;
    this.width = 0;
    this.height = 0;

    this.fillStyle = '#000000';
    this.strokeStyle = '#000000';
    this.lineWidth = 1;
    this.font = '10px Consolas';
    this.textAlign = 'left';
    this.textBaseline = 'alphabetic';
    this.globalAlpha = 1;
    this._dash = [];
    this._clip = null;      // {x0,y0,x1,y1}
    this._stack = [];
    this._subs = [];
    this._cur = null;
    this._penKey = null;
    this._brushKey = null;
    this._scratch = null;
    this.canvas = { width: 0, height: 0 };
  }

  // ── frame lifecycle ──
  begin(painter, w, h) {
    this.painter = painter;
    this.width = w; this.height = h;
    this.canvas.width = w; this.canvas.height = h;
    this._stack.length = 0;
    this._clip = { x0: 0, y0: 0, x1: w, y1: h };
    this._penKey = null; this._brushKey = null;
    this.fillStyle = '#000000'; this.strokeStyle = '#000000';
    this.lineWidth = 1; this.globalAlpha = 1; this._dash = [];
    this.font = '10px Consolas'; this.textAlign = 'left'; this.textBaseline = 'alphabetic';
    this._subs = []; this._cur = null;
    if (!this._scratch) this._scratch = new QPainterPath();
  }
  end() { this.painter = null; }

  // ── state ──
  save() {
    this._stack.push({
      fillStyle: this.fillStyle, strokeStyle: this.strokeStyle, lineWidth: this.lineWidth,
      font: this.font, textAlign: this.textAlign, textBaseline: this.textBaseline,
      globalAlpha: this.globalAlpha, dash: this._dash, clip: this._clip
    });
  }
  restore() {
    const s = this._stack.pop();
    if (!s) return;
    this.fillStyle = s.fillStyle; this.strokeStyle = s.strokeStyle; this.lineWidth = s.lineWidth;
    this.font = s.font; this.textAlign = s.textAlign; this.textBaseline = s.textBaseline;
    this.globalAlpha = s.globalAlpha; this._dash = s.dash; this._clip = s.clip;
  }
  resetTransform() {}
  scale() {}
  setLineDash(arr) { this._dash = (arr && arr.length) ? arr.map(Number).filter(n => n >= 0) : []; if (this._dash.reduce((a, b) => a + b, 0) <= 0) this._dash = []; }
  getLineDash() { return this._dash.slice(); }

  // ── internal drawing state ──
  _applyPen(qc, width) {
    const p = getPen(qc, width);
    if (this._penKey !== p.key) { this.painter.setPen(p.pen); this._penKey = p.key; }
    return p;
  }
  _penWidth() {
    const w = this.lineWidth;
    return w < 1.5 ? 1 : Math.round(w);
  }
  _clipRect() { return this._clip || { x0: 0, y0: 0, x1: this.width, y1: this.height }; }

  // ── rects ──
  fillRect(x, y, w, h) {
    if (!this.painter) return;
    if (w < 0) { x += w; w = -w; }
    if (h < 0) { y += h; h = -h; }
    const c = this._clipRect();
    const x0 = Math.max(x, c.x0), y0 = Math.max(y, c.y0);
    const x1 = Math.min(x + w, c.x1), y1 = Math.min(y + h, c.y1);
    if (!(x1 > x0 && y1 > y0)) return;
    const qc = getQColor(this.fillStyle, this.globalAlpha);
    if (qc.a255 === 0) return;
    this.painter.fillRectF(x0, y0, x1 - x0, y1 - y0, qc.color);
  }
  clearRect(x, y, w, h) { /* not used */ }
  strokeRect(x, y, w, h) {
    if (!this.painter) return;
    this._strokePoly([x, y, x + w, y, x + w, y + h, x, y + h, x, y], false);
  }
  rect(x, y, w, h) {
    this._subs.push({ p: [x, y, x + w, y, x + w, y + h, x, y + h], closed: true, rect: true });
    this._cur = { p: [x, y], closed: false, empty: true };
    this._cur = this._subs[this._subs.length - 1];
  }

  // ── paths ──
  beginPath() { this._subs = []; this._cur = null; }
  moveTo(x, y) { this._cur = { p: [x, y], closed: false }; this._subs.push(this._cur); }
  lineTo(x, y) {
    if (!this._cur) { this.moveTo(x, y); return; }
    this._cur.p.push(x, y);
  }
  closePath() { if (this._cur) this._cur.closed = true; }
  arc(cx, cy, r, a0, a1, ccw) {
    if (r < 0) return;
    let sweep = a1 - a0;
    const TWO_PI = Math.PI * 2;
    if (!ccw) { if (sweep >= TWO_PI) sweep = TWO_PI; else if (sweep < 0) sweep = ((sweep % TWO_PI) + TWO_PI) % TWO_PI; }
    else { if (sweep <= -TWO_PI) sweep = -TWO_PI; else if (sweep > 0) sweep = -(((-sweep) % TWO_PI) + TWO_PI) % TWO_PI; }
    const full = Math.abs(sweep) >= TWO_PI - 1e-9;
    const n = Math.max(10, Math.min(72, Math.ceil(Math.abs(sweep) / TWO_PI * (10 + r * 2.5))));
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const a = a0 + sweep * (i / n);
      pts.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
    if (this._cur && !this._cur.rect && this._cur.p.length) {
      for (let i = 0; i < pts.length; i++) this._cur.p.push(pts[i]);
    } else {
      this._cur = { p: pts, closed: false };
      this._subs.push(this._cur);
      if (full) { this._cur.circle = { cx, cy, r }; this._cur.closed = true; }
    }
  }
  roundRect(x, y, w, h, r) {
    r = Math.max(0, Math.min(Array.isArray(r) ? r[0] : r, w / 2, h / 2));
    const pts = [];
    const corner = (cx, cy, a0) => {
      for (let i = 0; i <= 4; i++) { const a = a0 + (Math.PI / 2) * (i / 4); pts.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r); }
    };
    corner(x + w - r, y + r, -Math.PI / 2);
    corner(x + w - r, y + h - r, 0);
    corner(x + r, y + h - r, Math.PI / 2);
    corner(x + r, y + r, Math.PI);
    this._cur = { p: pts, closed: true };
    this._subs.push(this._cur);
  }
  clip() {
    // semua pemakaian di kode asli: beginPath(); rect(...); clip()
    const sub = this._subs[this._subs.length - 1];
    if (!sub) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < sub.p.length; i += 2) {
      if (sub.p[i] < x0) x0 = sub.p[i]; if (sub.p[i] > x1) x1 = sub.p[i];
      if (sub.p[i + 1] < y0) y0 = sub.p[i + 1]; if (sub.p[i + 1] > y1) y1 = sub.p[i + 1];
    }
    const c = this._clipRect();
    this._clip = { x0: Math.max(c.x0, x0), y0: Math.max(c.y0, y0), x1: Math.min(c.x1, x1), y1: Math.min(c.y1, y1) };
  }

  // ── stroke ──
  stroke() {
    if (!this.painter) return;
    for (const s of this._subs) {
      if (s.circle) { this._strokeCircle(s.circle); continue; }
      const p = s.closed ? s.p.concat([s.p[0], s.p[1]]) : s.p;
      this._strokePoly(p, s.closed);
    }
  }

  _insideClip(pts) {
    const c = this._clipRect();
    for (let i = 0; i < pts.length; i += 2) {
      if (pts[i] < c.x0 || pts[i] > c.x1 || pts[i + 1] < c.y0 || pts[i + 1] > c.y1) return false;
    }
    return true;
  }

  _strokeCircle(ci) {
    const qc = getQColor(this.strokeStyle, this.globalAlpha);
    if (qc.a255 === 0) return;
    const c = this._clipRect();
    const pw = this._penWidth();
    const inside = ci.cx - ci.r >= c.x0 && ci.cx + ci.r <= c.x1 && ci.cy - ci.r >= c.y0 && ci.cy + ci.r <= c.y1;
    if (inside && !this._dash.length) {
      const path = this._scratch; path.clear();
      path.addEllipse(ci.cx - ci.r, ci.cy - ci.r, ci.r * 2, ci.r * 2);
      this.painter.strokePath(path, getPen(qc, pw).pen);
      return;
    }
    const n = 48, pts = [];
    for (let i = 0; i <= n; i++) { const a = (i / n) * Math.PI * 2; pts.push(ci.cx + Math.cos(a) * ci.r, ci.cy + Math.sin(a) * ci.r); }
    this._strokePoly(pts, true);
  }

  _strokePoly(p, closed) {
    const qc = getQColor(this.strokeStyle, this.globalAlpha);
    if (qc.a255 === 0 || p.length < 4) return;
    const pw = this._penWidth();
    const c = this._clipRect();
    const painter = this.painter;

    // 1) garis putus-putus → pecah manual jadi segmen
    if (this._dash.length) {
      this._applyPen(qc, pw);
      const dash = this._dash.length % 2 ? this._dash.concat(this._dash) : this._dash;
      let di = 0, remain = dash[0], on = true;
      for (let i = 0; i + 3 < p.length; i += 2) {
        let ax = p[i], ay = p[i + 1];
        const bx = p[i + 2], by = p[i + 3];
        let segLen = Math.hypot(bx - ax, by - ay);
        if (segLen === 0) continue;
        const ux = (bx - ax) / segLen, uy = (by - ay) / segLen;
        let guard = 0;
        while (segLen > 1e-6 && guard++ < 5000) {
          const step = Math.min(remain, segLen);
          const ex = ax + ux * step, ey = ay + uy * step;
          if (on) {
            const cs = clipSegment(ax, ay, ex, ey, c);
            if (cs) painter.drawLineF(cs[0], cs[1], cs[2], cs[3]);
          }
          ax = ex; ay = ey; segLen -= step; remain -= step;
          if (remain <= 1e-9) { di = (di + 1) % dash.length; remain = dash[di] || 1; on = !on; }
        }
      }
      return;
    }

    // 2) polyline utuh di dalam clip → strokePath (join halus)
    if (p.length > 4 && this._insideClip(p)) {
      const path = this._scratch; path.clear();
      path.moveTo(p[0], p[1]);
      for (let i = 2; i < p.length; i += 2) path.lineTo(p[i], p[i + 1]);
      if (closed) path.closeSubpath();
      painter.strokePath(path, getPen(qc, pw).pen);
      return;
    }

    // 3) segmen demi segmen
    this._applyPen(qc, pw);
    for (let i = 0; i + 3 < p.length; i += 2) {
      const cs = clipSegment(p[i], p[i + 1], p[i + 2], p[i + 3], c);
      if (cs) painter.drawLineF(cs[0], cs[1], cs[2], cs[3]);
    }
  }

  // ── fill ──
  fill() {
    if (!this.painter) return;
    const qc = getQColor(this.fillStyle, this.globalAlpha);
    if (qc.a255 === 0) return;
    const brush = getBrush(qc);
    const c = this._clipRect();
    for (const s of this._subs) {
      if (s.circle) {
        const ci = s.circle;
        const inside = ci.cx - ci.r >= c.x0 && ci.cx + ci.r <= c.x1 && ci.cy - ci.r >= c.y0 && ci.cy + ci.r <= c.y1;
        if (inside) {
          const path = this._scratch; path.clear();
          path.addEllipse(ci.cx - ci.r, ci.cy - ci.r, ci.r * 2, ci.r * 2);
          this.painter.fillPath(path, brush);
          continue;
        }
      }
      if (s.p.length < 6) continue;
      let pts = s.p;
      if (!this._insideClip(pts)) pts = clipPolygon(pts, c);
      if (pts.length < 6) continue;
      const path = this._scratch; path.clear();
      path.moveTo(pts[0], pts[1]);
      for (let i = 2; i < pts.length; i += 2) path.lineTo(pts[i], pts[i + 1]);
      path.closeSubpath();
      this.painter.fillPath(path, brush);
    }
  }

  // ── tekstur (bitmap) ──
  /**
   * Gambar tekstur PNG (mis. heatmap) diskalakan ke (dw × dh) tanpa smoothing (tiap sel tetap tegas),
   * dipotong sesuai clip rect aktif. tex = { png: Buffer }.
   */
  drawTexture(tex, x, y, dw, dh) {
    if (!this.painter || !tex || !tex.png) return;
    dw = Math.max(1, Math.round(dw)); dh = Math.max(1, Math.round(dh));
    x = Math.round(x); y = Math.round(y);
    let pm = tex._pm;
    if (!pm) { pm = new QPixmap(); pm.loadFromData(tex.png, 'PNG'); tex._pm = pm; }
    const key = dw + 'x' + dh;
    if (tex._key !== key) {
      tex._scaled = (pm.width() === dw && pm.height() === dh) ? pm
        : pm.scaled(dw, dh, AspectRatioMode.IgnoreAspectRatio, TransformationMode.FastTransformation);
      tex._key = key;
    }
    const c = this._clipRect();
    const ix0 = Math.max(x, Math.ceil(c.x0)), iy0 = Math.max(y, Math.ceil(c.y0));
    const ix1 = Math.min(x + dw, Math.floor(c.x1)), iy1 = Math.min(y + dh, Math.floor(c.y1));
    if (ix1 <= ix0 || iy1 <= iy0) return;
    this.painter.drawPixmap(ix0, iy0, tex._scaled, ix0 - x, iy0 - y, ix1 - ix0, iy1 - iy0);
  }

  // ── text ──
  measureText(text) {
    const f = getFont(this.font);
    text = String(text);
    let w = f.widths.get(text);
    if (w === undefined) {
      w = f.fm.horizontalAdvance(text);
      if (f.widths.size > 800) f.widths.clear();
      f.widths.set(text, w);
    }
    return { width: w };
  }
  fillText(text, x, y) {
    if (!this.painter) return;
    text = String(text);
    if (!text) return;
    const qc = getQColor(this.fillStyle, this.globalAlpha);
    if (qc.a255 === 0) return;
    const f = getFont(this.font);
    let w = 0;
    if (this.textAlign !== 'left' && this.textAlign !== 'start') w = this.measureText(text).width;
    if (this.textAlign === 'center') x -= w / 2; else if (this.textAlign === 'right' || this.textAlign === 'end') x -= w;
    if (this.textBaseline === 'middle') y += (f.ascent - f.descent) / 2;
    else if (this.textBaseline === 'top' || this.textBaseline === 'hanging') y += f.ascent;
    else if (this.textBaseline === 'bottom') y -= f.descent;
    if (this._curFont !== f.key) { this.painter.setFont(f.qf); this._curFont = f.key; }
    const tk = 'T' + qc.key;
    if (this._penKey !== tk) { this.painter.setPen(qc.color); this._penKey = tk; }
    this.painter.drawTextF(x, y, text);
  }
}

// font state is per painter; reset on each frame
const _origBegin = Canvas2D.prototype.begin;
Canvas2D.prototype.begin = function (painter, w, h) { this._curFont = null; return _origBegin.call(this, painter, w, h); };

module.exports = { Canvas2D, parseColor, getQColor, getFont };
