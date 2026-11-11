'use strict';
/** Token warna + helper gambar untuk UI (sidebar, toolbar, popup, kalender) — mengikuti CSS versi browser. */

const T = {
  bg: '#10131a', panel: '#141722', border: '#232736',
  btn: '#1c202d', btnBorder: '#2d3345', btnHover: '#252b3d',
  text: '#f1f5f9', text2: '#cbd5e1', dim: '#94a3b8', dim2: '#64748b',
  accent: '#ff8c37', accentBg: '#2a1a08', accentBorder: '#8c450a', accentAct: '#2e1a06',
  hover: '#1e2333', pop: '#161924', popHover: '#232838', row: '#1c202d',
  red: '#ef5350', redBg: '#331515', redBorder: '#6d2020', green: '#26a69a', good: '#4caf50'
};
const FONT = 'Consolas, monospace';
const F = (px, bold) => (bold ? 'bold ' : '') + px + 'px ' + FONT;

function box(ctx, x, y, w, h, fill, stroke, r) {
  if (r === undefined) r = 3;
  if (fill) {
    ctx.fillStyle = fill;
    if (r) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.fill(); } else ctx.fillRect(x, y, w, h);
  }
  if (stroke) {
    ctx.strokeStyle = stroke; ctx.lineWidth = 1;
    ctx.beginPath();
    if (r) ctx.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, r); else ctx.rect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.stroke();
  }
}

function txt(ctx, s, x, y, font, color, align, base) {
  ctx.font = font; ctx.fillStyle = color;
  ctx.textAlign = align || 'left'; ctx.textBaseline = base || 'middle';
  ctx.fillText(s, x, y);
}

function tw(ctx, s, font) { ctx.font = font; return ctx.measureText(s).width; }

/** teks dengan letter-spacing manual */
function spaced(ctx, s, x, y, font, color, ls, align) {
  ctx.font = font; ctx.fillStyle = color; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  const ws = []; let total = 0;
  for (const ch of s) { const w = ctx.measureText(ch).width; ws.push(w); total += w + ls; }
  total -= ls;
  let cx = align === 'center' ? x - total / 2 : align === 'right' ? x - total : x, i = 0;
  for (const ch of s) { ctx.fillText(ch, cx, y); cx += ws[i++] + ls; }
  return total;
}

const hit = (r, x, y) => !!r && x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;

function line(ctx, pts, color, lw) {
  ctx.strokeStyle = color; ctx.lineWidth = lw || 1;
  ctx.beginPath();
  ctx.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
  ctx.stroke();
}

function poly(ctx, pts, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
  ctx.closePath(); ctx.fill();
}

/** Ikon vektor (tidak bergantung font emoji). (cx,cy) = pusat. */
function icon(ctx, name, cx, cy, color, lw) {
  lw = lw || 1.4;
  switch (name) {
    case 'line':
      line(ctx, [cx - 6, cy + 5, cx + 6, cy - 5], color, lw);
      ctx.fillStyle = color; ctx.beginPath(); ctx.arc(cx - 6, cy + 5, 1.6, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(cx + 6, cy - 5, 1.6, 0, Math.PI * 2); ctx.fill();
      break;
    case 'rect':
      ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.strokeRect(cx - 6.5, cy - 4.5, 13, 9);
      break;
    case 'fibo':
      line(ctx, [cx - 7, cy - 5, cx + 7, cy - 5], color, lw);
      line(ctx, [cx - 7, cy, cx + 7, cy], color, lw);
      line(ctx, [cx - 7, cy + 5, cx + 7, cy + 5], color, lw);
      line(ctx, [cx - 5, cy + 5, cx + 5, cy - 5], color, 1);
      break;
    case 'path':
      line(ctx, [cx - 7, cy + 4, cx - 2, cy - 2, cx + 2, cy + 2, cx + 6, cy - 3], color, lw);
      poly(ctx, [cx + 7.5, cy - 5, cx + 2.5, cy - 4.5, cx + 6.5, cy - 0.5], color);
      break;
    case 'longshort':
      ctx.globalAlpha = 0.9; ctx.fillStyle = '#26a69a'; ctx.fillRect(cx - 6, cy - 6, 12, 5);
      ctx.fillStyle = '#ef5350'; ctx.fillRect(cx - 6, cy + 1, 12, 5); ctx.globalAlpha = 1;
      line(ctx, [cx - 7, cy - 0.5, cx + 7, cy - 0.5], color, 1);
      break;
    case 'trash':
      line(ctx, [cx - 5.5, cy - 3.5, cx + 5.5, cy - 3.5], color, lw);
      line(ctx, [cx - 2, cy - 3.5, cx - 2, cy - 5.5, cx + 2, cy - 5.5, cx + 2, cy - 3.5], color, lw);
      line(ctx, [cx - 4, cy - 2, cx - 3.2, cy + 5.5, cx + 3.2, cy + 5.5, cx + 4, cy - 2], color, lw);
      line(ctx, [cx - 1, cy - 1, cx - 1, cy + 4], color, 1);
      line(ctx, [cx + 1, cy - 1, cx + 1, cy + 4], color, 1);
      break;
    case 'chart':
      ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.strokeRect(cx - 7, cy - 7, 14, 14);
      line(ctx, [cx, cy - 7, cx, cy + 7], color, 1); line(ctx, [cx - 7, cy, cx + 7, cy], color, 1);
      break;
    case 'calendar':
      ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.strokeRect(cx - 7, cy - 5.5, 14, 12.5);
      line(ctx, [cx - 7, cy - 1.5, cx + 7, cy - 1.5], color, 1);
      line(ctx, [cx - 3.5, cy - 8, cx - 3.5, cy - 4], color, lw);
      line(ctx, [cx + 3.5, cy - 8, cx + 3.5, cy - 4], color, lw);
      ctx.fillStyle = color; ctx.fillRect(cx - 4, cy + 1, 2, 2); ctx.fillRect(cx + 0, cy + 1, 2, 2); ctx.fillRect(cx - 4, cy + 4, 2, 2);
      break;
    case 'gear':
      ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.beginPath(); ctx.arc(cx, cy, 6.5, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = color; ctx.beginPath(); ctx.arc(cx, cy, 2, 0, Math.PI * 2); ctx.fill();
      break;
    case 'chev':
      poly(ctx, [cx - 3.5, cy - 1.5, cx + 3.5, cy - 1.5, cx, cy + 2.5], color);
      break;
    case 'dots':
      ctx.fillStyle = color;
      for (let i = -1; i <= 1; i++) { ctx.beginPath(); ctx.arc(cx, cy + i * 4, 1.3, 0, Math.PI * 2); ctx.fill(); }
      break;
    case 'close':
      line(ctx, [cx - 4, cy - 4, cx + 4, cy + 4], color, lw);
      line(ctx, [cx + 4, cy - 4, cx - 4, cy + 4], color, lw);
      break;
    case 'refresh':
      ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.beginPath(); ctx.arc(cx, cy, 4.5, -Math.PI * 0.3, Math.PI * 1.45); ctx.stroke();
      poly(ctx, [cx + 5.5, cy - 4.5, cx + 6.5, cy + 0.5, cx + 1.5, cy - 1.5], color);
      break;
    case 'ff':
      poly(ctx, [cx - 6, cy - 4, cx - 6, cy + 4, cx - 0.5, cy], color);
      poly(ctx, [cx + 0.5, cy - 4, cx + 0.5, cy + 4, cx + 6, cy], color);
      break;
  }
}

module.exports = { T, F, FONT, box, txt, tw, spaced, hit, line, poly, icon };
