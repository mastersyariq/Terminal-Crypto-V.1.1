'use strict';
const { CanvasWidget } = require('./canvasWidget');
const { T, F, tw, txt } = require('./kit');

/** Status bar bawah 22px: Bars / Last / Range / Updated. */
function createStatusBar() {
  const cw = new CanvasWidget({ name: 'statusbar', tracking: false });
  cw.widget.setFixedHeight(22);
  const st = { bars: 'Bars: \u2014', last: { color: null, value: '\u2014' }, range: 'Range: \u2014', r: '\u2014' };

  cw.on('draw', (ctx, W, H) => {
    ctx.fillStyle = T.panel; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = T.border; ctx.fillRect(0, 0, W, 1);
    const font = F(10);
    let x = 12; const y = H / 2 + 0.5;
    txt(ctx, st.bars, x, y, font, T.dim); x += tw(ctx, st.bars, font) + 18;
    txt(ctx, 'Last: ', x, y, font, T.dim); x += tw(ctx, 'Last: ', font);
    txt(ctx, st.last.value, x, y, font, st.last.color || T.dim); x += tw(ctx, st.last.value, font) + 18;
    txt(ctx, st.range, x, y, font, T.dim);
    txt(ctx, st.r, W - 12, y, font, T.dim2, 'right');
  });

  function setElement(id, kind, value) {
    if (id === 'sb-bars') st.bars = value;
    else if (id === 'sb-range') st.range = value;
    else if (id === 'sb-r') st.r = value;
    else if (id === 'sb-last') {
      const m = /color:\s*([#\w]+)[^>]*>([^<]*)</.exec(value);
      st.last = m ? { color: m[1], value: m[2] } : { color: null, value: value.replace(/<[^>]*>/g, '').replace(/^Last:\s*/, '') };
    } else return false;
    cw.update();
    return true;
  }

  return { widget: cw.widget, setElement };
}

module.exports = { createStatusBar };
