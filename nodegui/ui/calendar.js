'use strict';
const { QWidget, QBoxLayout, Direction } = require('@nodegui/nodegui');
const { CanvasWidget } = require('./canvasWidget');
const { T, F, box, txt, tw, spaced, hit, icon } = require('./kit');

const WIB_OFF = 7 * 3600000; // UTC+7
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const CHIPS = [['all', 'All'], ['3', 'High'], ['2', 'Med'], ['1', 'Low']];

const HDR_H = 40, FIL_H = 28, DAY_H = 23, LINE_H = 15;

/** Economic Calendar sidebar kanan (port renderCalendar() versi browser, digambar di canvas). */
function createCalendar({ engine, onClosed, onOpened }) {
  const container = new QWidget();
  container.setObjectName('calendar');
  const layout = new QBoxLayout(Direction.LeftToRight);
  layout.setContentsMargins(0, 0, 0, 0);
  layout.setSpacing(0);
  container.setLayout(layout);

  const st = {
    open: false, width: 320, events: [], filter: 'all', status: '', scroll: 0,
    expanded: new Set(), hoverRow: -1, hoverBtn: null, rows: [], contentH: 0, dragging: false, dragX0: 0
  };

  const handle = new CanvasWidget({ name: 'calDrag' });
  handle.widget.setFixedWidth(6);
  const panel = new CanvasWidget({ name: 'calPanel' });
  layout.addWidget(handle.widget);
  layout.addWidget(panel.widget, 1);
  container.setFixedWidth(0);
  container.hide();

  // ── util ──
  const evKey = (ev, i) => (ev.timestamp || 'x') + '|' + (ev.event || i);

  function wrap(ctx, text, maxW, font) {
    ctx.font = font;
    const words = String(text || '').split(/\s+/).filter(Boolean);
    const lines = []; let cur = '';
    for (const w of words) {
      const t = cur ? cur + ' ' + w : w;
      if (ctx.measureText(t).width <= maxW || !cur) cur = t; else { lines.push(cur); cur = w; }
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [''];
  }

  function usdSignal(ev) {
    const n = (ev.event || '').toLowerCase();
    const isCpiNfp = n.includes('cpi') || n.includes('consumer price index') || n.includes('nonfarm payroll') ||
      n.includes('non-farm payroll') || n.includes('nonfarm employment') || n.includes('non-farm employment');
    if (!(isCpiNfp && ev.actual && ev.forecast)) return null;
    const a = parseFloat(ev.actual.replace(/[^\d.\-]/g, ''));
    const f = parseFloat(ev.forecast.replace(/[^\d.\-]/g, ''));
    if (isNaN(a) || isNaN(f)) return null;
    if (a > f) return { cls: 'bullish', text: '\u25b2 USD BULLISH' };
    if (a < f) return { cls: 'bearish', text: '\u25bc USD BEARISH' };
    return { cls: 'neutral', text: '\u25cf NEUTRAL' };
  }

  // ── layout rows (dihitung ulang saat data/filter/expand/width berubah) ──
  function buildRows(ctx, W) {
    const now = Date.now();
    const todayStr = new Date(now + WIB_OFF).toISOString().slice(0, 10);
    let list = st.events;
    if (st.filter !== 'all') { const lvl = parseInt(st.filter); list = list.filter(ev => ev.impact === lvl); }
    const rows = [];
    let y = 0;
    if (!list.length) { st.rows = []; st.contentH = 0; st.empty = true; return; }
    st.empty = false;

    const groups = new Map();
    list.forEach((ev, i) => {
      const key = ev.timestamp ? new Date(ev.timestamp + WIB_OFF).toISOString().slice(0, 10) : 'unknown';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ ev, i });
    });

    const bodyX = 12 + 38 + 6 + 20 + 6;
    const bodyW = Math.max(40, W - bodyX - 12);
    for (const [dateKey, items] of groups) {
      const isToday = dateKey === todayStr;
      let label;
      if (dateKey === 'unknown') label = 'Unknown Date';
      else {
        const d = new Date(dateKey + 'T00:00:00Z');
        label = `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONS[d.getUTCMonth()]}`;
        if (isToday) label += ' \u2022 TODAY';
      }
      rows.push({ type: 'day', label, today: isToday, y, h: DAY_H }); y += DAY_H;

      for (const { ev, i } of items) {
        let urg = '';
        if (ev.timestamp) {
          const diffMin = (ev.timestamp - now) / 60000;
          if (diffMin > 0 && diffMin <= 60) urg = 'soon';
          else if (diffMin > 0 && diffMin <= 300) urg = 'upcoming';
        }
        let timeStr = ev.timeText || '-';
        if (ev.timestamp && /^\d{1,2}:\d{2}$/.test((ev.timeText || '').trim())) {
          const d = new Date(ev.timestamp + WIB_OFF);
          timeStr = String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
        }
        const key = evKey(ev, i);
        const expanded = st.expanded.has(key);
        const lines = wrap(ctx, ev.event, bodyW, F(10));
        const sig = expanded ? usdSignal(ev) : null;
        const boxH = expanded ? (2 + 6 + 30 + 6 + (sig ? 6 + 17 : 0)) : 0;
        const h = 5 + lines.length * LINE_H + (expanded ? 5 + boxH : 0) + 5 + 1;
        rows.push({ type: 'ev', ev, key, urg, timeStr, lines, expanded, sig, boxH, bodyX, bodyW, y, h });
        y += h;
      }
    }
    st.rows = rows; st.contentH = y + 4;
  }

  const listTop = () => HDR_H + FIL_H;

  // ── gambar panel ──
  panel.on('draw', (ctx, W, H) => {
    ctx.fillStyle = T.panel; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = T.border; ctx.fillRect(0, 0, 1, H);

    // header
    spaced(ctx, 'ECONOMIC CALENDAR', 12, HDR_H / 2, F(10, true), T.accent, 1.5);
    ctx.fillStyle = T.border; ctx.fillRect(0, HDR_H - 1, W, 1);
    const close = { x: W - 12 - 16, y: HDR_H / 2 - 9, w: 16, h: 18 };
    const refresh = { x: close.x - 8 - 26, y: HDR_H / 2 - 10, w: 26, h: 20 };
    st.btns = { close, refresh };
    icon(ctx, 'close', close.x + close.w / 2, close.y + close.h / 2, st.hoverBtn === 'close' ? T.red : T.dim, 1.3);
    box(ctx, refresh.x, refresh.y, refresh.w, refresh.h, st.hoverBtn === 'refresh' ? '#232838' : T.btn, st.hoverBtn === 'refresh' ? T.accentBorder : '#2d3345', 3);
    icon(ctx, 'refresh', refresh.x + refresh.w / 2, refresh.y + refresh.h / 2, st.hoverBtn === 'refresh' ? T.accent : T.dim, 1.3);
    if (st.status) txt(ctx, st.status, refresh.x - 8, HDR_H / 2 + 0.5, F(8), T.dim, 'right');

    // filter chips
    let cx = 8; const cy = HDR_H + (FIL_H - 17) / 2;
    st.chips = [];
    for (const [id, lbl] of CHIPS) {
      const w = Math.ceil(tw(ctx, lbl, F(9))) + 14 + 2;
      const on = st.filter === id, hv = st.hoverBtn === 'chip:' + id;
      box(ctx, cx, cy, w, 17, on ? T.accentBg : hv ? T.btnHover : T.btn, on ? T.accent : '#2d3345', 2);
      txt(ctx, lbl, cx + w / 2, cy + 8.5 + 0.5, F(9), on ? T.accent : hv ? '#f8fafc' : T.dim, 'center');
      st.chips.push({ id, x: cx, y: cy, w, h: 17 });
      cx += w + 4;
    }
    ctx.fillStyle = T.border; ctx.fillRect(0, HDR_H + FIL_H - 1, W, 1);

    // list
    const top = listTop(), LH = H - top;
    buildRows(ctx, W);
    const maxScroll = Math.max(0, st.contentH - LH);
    if (st.scroll > maxScroll) st.scroll = maxScroll;
    ctx.save(); ctx.beginPath(); ctx.rect(0, top, W, LH); ctx.clip();

    if (st.empty) {
      txt(ctx, 'No events', W / 2, top + 30 + 7, F(10), T.dim2, 'center');
    } else {
      let pinned = null;
      st.rows.forEach((r, idx) => {
        const ry = top + r.y - st.scroll;
        if (r.type === 'day' && r.y <= st.scroll) pinned = { r, idx };
        if (ry + r.h < top || ry > top + LH) return;
        if (r.type === 'day') { drawDay(ctx, r, ry, W); return; }
        drawEv(ctx, r, ry, W, idx);
      });
      // sticky day header
      if (pinned) {
        let py = top;
        const next = st.rows.slice(pinned.idx + 1).find(r => r.type === 'day');
        if (next) { const ny = top + next.y - st.scroll; if (ny < top + DAY_H) py = ny - DAY_H; }
        if (py < top + 0.5 && pinned.r.y < st.scroll) drawDay(ctx, pinned.r, py, W);
      }
    }
    ctx.restore();

    // scrollbar
    if (st.contentH > LH) {
      const th = Math.max(20, LH * LH / st.contentH);
      const ty = top + (st.scroll / (st.contentH - LH)) * (LH - th);
      box(ctx, W - 4, ty, 3, th, '#2a3042', null, 2);
    }
  });

  function drawDay(ctx, r, y, W) {
    ctx.fillStyle = T.panel; ctx.fillRect(1, y, W - 1, DAY_H);
    ctx.fillStyle = T.border; ctx.fillRect(1, y + DAY_H - 1, W - 1, 1);
    spaced(ctx, r.label, 12, y + DAY_H / 2, F(9, true), r.today ? T.accent : T.text2, 1);
  }

  function drawEv(ctx, r, y, W, idx) {
    const bg = r.expanded ? '#181b24' : st.hoverRow === idx ? '#1a1e2a' : null;
    if (bg) { ctx.fillStyle = bg; ctx.fillRect(1, y, W - 1, r.h - 1); }
    ctx.fillStyle = r.expanded ? T.border : T.row; ctx.fillRect(1, y + r.h - 1, W - 1, 1);
    if (r.urg) { ctx.fillStyle = r.urg === 'soon' ? '#4caf50' : '#f5a623'; ctx.fillRect(1, y, 2, r.h - 1); }
    txt(ctx, r.timeStr, 12, y + 5 + LINE_H / 2, F(10), T.dim);
    // impact bars
    const ic = r.ev.impact || 0;
    const col = i => ic === 3 ? '#f0485a' : ic === 2 && i < 2 ? '#f5a623' : ic === 1 && i < 1 ? '#7b8dbf' : '#2d3345';
    for (let i = 0; i < 3; i++) { ctx.fillStyle = col(i); ctx.fillRect(56 + i * 4, y + 5 + 1 + 1, 3, 6); }
    // nama
    r.lines.forEach((ln, i) => txt(ctx, ln, r.bodyX, y + 5 + i * LINE_H + LINE_H / 2, F(10), T.text));
    if (r.expanded) {
      const bx = r.bodyX, bw = r.bodyW, by = y + 5 + r.lines.length * LINE_H + 5;
      box(ctx, bx, by, bw, r.boxH, T.bg, T.border, 3);
      const cw3 = (bw - 16 - 8) / 3;
      const ev = r.ev;
      const cells = [['PREV', ev.previous || '\u2014', T.text], ['FORECAST', ev.forecast || '\u2014', T.text],
        ['ACTUAL', ev.actual || '\u2014', ev.signal === 'good' ? '#4caf50' : ev.signal === 'bad' ? '#ef5350' : T.text]];
      cells.forEach((c, i) => {
        const ccx = bx + 8 + i * (cw3 + 4) + cw3 / 2;
        txt(ctx, c[0], ccx, by + 1 + 6 + 6, F(8), T.dim, 'center');
        txt(ctx, c[1], ccx, by + 1 + 6 + 12 + 2 + 8, F(11, true), c[2], 'center');
      });
      if (r.sig) {
        const sy = by + 1 + 6 + 30 + 6, sh = 17;
        const pal = r.sig.cls === 'bullish' ? ['#0e2a14', '#4caf50', '#1a5226'] : r.sig.cls === 'bearish' ? ['#2a0e0e', '#ef5350', '#521a1a'] : [T.pop, T.dim, '#2d3345'];
        box(ctx, bx + 8, sy, bw - 16, sh, pal[0], pal[2], 2);
        spaced(ctx, r.sig.text, bx + bw / 2, sy + sh / 2 + 0.5, F(9, true), pal[1], 1, 'center');
      }
    }
  }

  function rowAt(x, y) {
    const top = listTop();
    if (y < top) return -1;
    const ly = y - top + st.scroll;
    return st.rows.findIndex(r => ly >= r.y && ly < r.y + r.h);
  }

  panel.on('move', (x, y) => {
    let btn = null;
    if (st.btns) {
      if (hit(st.btns.close, x, y)) btn = 'close';
      else if (hit(st.btns.refresh, x, y)) btn = 'refresh';
      else for (const c of (st.chips || [])) if (hit(c, x, y)) { btn = 'chip:' + c.id; break; }
    }
    let row = -1;
    if (!btn) { const i = rowAt(x, y); if (i >= 0 && st.rows[i].type === 'ev') row = i; }
    if (btn !== st.hoverBtn || row !== st.hoverRow) {
      st.hoverBtn = btn; st.hoverRow = row;
      panel.setCursorName(btn || row >= 0 ? 'pointer' : '');
      panel.widget.setToolTip(btn === 'refresh' ? 'Refresh' : btn === 'close' ? 'Close' : '');
      panel.update();
    }
  });
  panel.on('leave', () => { st.hoverBtn = null; st.hoverRow = -1; panel.update(); });
  panel.on('press', async ({ x, y, button }) => {
    if (button !== 0) return;
    if (st.btns && hit(st.btns.close, x, y)) { setOpen(false); return; }
    if (st.btns && hit(st.btns.refresh, x, y)) { refreshNow(); return; }
    for (const c of (st.chips || [])) if (hit(c, x, y)) { st.filter = c.id; st.scroll = 0; panel.update(); return; }
    const i = rowAt(x, y);
    if (i >= 0 && st.rows[i].type === 'ev') {
      const k = st.rows[i].key;
      if (st.expanded.has(k)) st.expanded.delete(k); else st.expanded.add(k);
      panel.update();
    }
  });
  panel.on('wheel', ({ dy }) => {
    const LH = panel.widget.height() - listTop();
    const max = Math.max(0, st.contentH - LH);
    st.scroll = Math.max(0, Math.min(max, st.scroll - (dy / 120) * 45));
    panel.update();
  });

  // ── drag resize ──
  handle.on('draw', (ctx, W, H) => {
    const act = st.dragging || st.handleHover;
    ctx.fillStyle = T.panel; ctx.fillRect(0, 0, W, H);
    if (act) { ctx.fillStyle = 'rgba(255,140,55,.15)'; ctx.fillRect(0, 0, W, H); }
    ctx.fillStyle = act ? T.accent : '#2d3345';
    ctx.beginPath(); ctx.roundRect(W / 2 - 1, H / 2 - 16, 2, 32, 1); ctx.fill();
  });
  handle.on('move', x => {
    handle.setCursorName('col-resize');
    if (!st.handleHover) { st.handleHover = true; handle.update(); }
    if (!st.dragging) return;
    const nw = Math.max(0, Math.min(500, st.width - (x - st.dragX0)));
    if (nw < 80) { st.dragging = false; setOpen(false); return; }
    st.width = nw; container.setFixedWidth(nw);
  });
  handle.on('leave', () => { st.handleHover = false; handle.update(); });
  handle.on('press', ({ x, button }) => { if (button === 0) { st.dragging = true; st.dragX0 = x; handle.update(); } });
  handle.on('release', () => { st.dragging = false; handle.update(); });

  // ── data ──
  function applyCal(d) {
    st.events = d.events || [];
    if (d.error) st.status = 'error';
    else if (d.fetchedAt) {
      const ago = Math.round((Date.now() - d.fetchedAt) / 60000);
      st.status = ago < 1 ? 'just now' : ago + 'm ago';
    }
    panel.update();
  }
  async function fetchCalendar() {
    st.status = 'updating...'; panel.update();
    try { applyCal(engine.getCalendar()); } catch (e) { st.status = 'offline'; panel.update(); }
  }
  async function refreshNow() {
    st.status = 'refreshing...'; panel.update();
    try { const d = await engine.refreshCalendar(); applyCal(d); st.status = d.error ? 'error' : 'just now'; }
    catch (e) { st.status = 'error'; }
    panel.update();
  }
  engine.on('calendar', d => { if (st.open) applyCal(d); });
  setInterval(() => { if (st.open) panel.update(); }, 30000); // urgensi (soon/upcoming) berubah seiring waktu

  function setOpen(on) {
    st.open = !!on;
    if (st.open) {
      if (st.width < 200) st.width = 320;
      container.setFixedWidth(st.width);
      container.show();
      fetchCalendar();
      onOpened && onOpened();
    } else {
      container.setFixedWidth(0);
      container.hide();
      onClosed && onClosed();
    }
  }

  return { widget: container, toggle: () => setOpen(!st.open), setOpen, isOpen: () => st.open };
}

module.exports = { createCalendar };
