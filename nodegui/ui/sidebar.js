'use strict';
const { CanvasWidget } = require('./canvasWidget');
const { T, F, box, txt, spaced, hit, icon } = require('./kit');

/** Sidebar kiri 48px: brand HF, Terminal Chart, Economic Calendar, Settings. */
function createSidebar({ onToggleCalendar }) {
  const cw = new CanvasWidget({ name: 'sidebar' });
  cw.widget.setFixedWidth(48);
  const st = { calOpen: false, hover: -1 };

  const items = h => ([
    { id: 'chart', x: 6, y: 50, w: 36, h: 36, icon: 'chart', tip: 'Terminal Chart', active: true },
    { id: 'cal', x: 6, y: 90, w: 36, h: 36, icon: 'calendar', tip: st.calOpen ? 'Economic Calendar (click to close)' : 'Economic Calendar', active: st.calOpen },
    { id: 'set', x: 6, y: h - 8 - 36, w: 36, h: 36, icon: 'gear', tip: 'Settings (coming soon)', active: false }
  ]);

  cw.on('draw', (ctx, W, H) => {
    ctx.fillStyle = T.panel; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = T.border; ctx.fillRect(W - 1, 0, 1, H);
    // brand
    spaced(ctx, 'HF', W / 2, 20, F(11, true), T.accent, 2, 'center');
    ctx.fillStyle = T.border; ctx.fillRect(0, 39, W, 1);
    // separator atas item bawah
    ctx.fillStyle = T.border; ctx.fillRect(0, H - 8 - 36 - 8, W - 1, 1);
    items(H).forEach((it, i) => {
      const hv = st.hover === i;
      if (it.active) box(ctx, it.x, it.y, it.w, it.h, T.accentBg, null, 4);
      else if (hv) box(ctx, it.x, it.y, it.w, it.h, T.hover, null, 4);
      if (it.active) {
        ctx.fillStyle = T.accent; ctx.fillRect(it.x, it.y + it.h / 2 - 9, 2, 18);
      }
      icon(ctx, it.icon, it.x + it.w / 2, it.y + it.h / 2, it.active ? T.accent : hv ? '#f8fafc' : T.dim, 1.4);
    });
  });

  const idxAt = (x, y) => items(cw.widget.height()).findIndex(it => hit(it, x, y));
  cw.on('move', (x, y) => {
    const i = idxAt(x, y);
    if (i !== st.hover) {
      st.hover = i; cw.setCursorName(i >= 0 ? 'pointer' : '');
      cw.widget.setToolTip(i >= 0 ? items(cw.widget.height())[i].tip : '');
      cw.update();
    }
  });
  cw.on('leave', () => { st.hover = -1; cw.update(); });
  cw.on('press', ({ x, y, button }) => {
    if (button !== 0) return;
    const i = idxAt(x, y);
    if (i === 1) onToggleCalendar();
  });

  return { widget: cw.widget, setCalendarOpen(on) { st.calOpen = !!on; cw.update(); } };
}

module.exports = { createSidebar };
