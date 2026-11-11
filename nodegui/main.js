'use strict';
/**
 * Hedge Fund Terminal — NodeGUI (Qt) desktop app.
 * Tanpa server HTTP / tanpa port localhost: UI, engine, dan data stream berjalan satu proses.
 * (Satu-satunya koneksi lokal adalah CDP ke TradingView Desktop — sama seperti versi asli.)
 */
const fs = require('fs');
const path = require('path');

// ── log ke file (start.vbs menjalankan app tanpa console) ──
const LOG_FILE = path.join(__dirname, '..', 'nodegui.log');
try { if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 1024 * 1024) fs.writeFileSync(LOG_FILE, ''); } catch (_) {}
function fileLog(level, args) {
  try {
    const msg = args.map(a => (typeof a === 'string' ? a : (a && a.stack) || JSON.stringify(a))).join(' ');
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} [${level}] ${msg}\n`);
  } catch (_) {}
}
for (const lvl of ['log', 'warn', 'error']) {
  const orig = console[lvl].bind(console);
  console[lvl] = (...a) => { try { orig(...a); } catch (_) {} fileLog(lvl, a); };
}
process.on('uncaughtException', e => console.error('[uncaughtException]', e));
process.on('unhandledRejection', e => console.error('[unhandledRejection]', e));

const {
  QMainWindow, QWidget, QBoxLayout, QPoint, Direction, WidgetEventTypes
} = require('@nodegui/nodegui');

const Prefs = require('./prefs');
const { Engine } = require('./engine');
const { createChartView } = require('./chart/chartView');
const { createSidebar } = require('./ui/sidebar');
const { createToolbar } = require('./ui/toolbar');
const { createStatusBar } = require('./ui/statusbar');
const { createPopups } = require('./ui/popups');
const { createDialogs } = require('./ui/dialogs');
const { createCalendar } = require('./ui/calendar');

function main(opts) {
  opts = opts || {};
  const prefs = new Prefs();
  const engine = new Engine();

  const win = new QMainWindow();
  win.setWindowTitle('Hedge Fund Terminal');
  win.resize(1500, 900);
  win.setMinimumSize(900, 560);

  const root = new QWidget();
  root.setObjectName('root');
  root.setStyleSheet('QWidget#root{background:#10131a;}');
  win.setCentralWidget(root);

  const rootL = new QBoxLayout(Direction.LeftToRight);
  rootL.setContentsMargins(0, 0, 0, 0);
  rootL.setSpacing(0);
  root.setLayout(rootL);

  // ── referensi yang diisi belakangan (closure) ──
  let chart, toolbar, statusbar, popups, dialogs, calendar, sidebar;

  const ui = {
    setActiveTf: tf => toolbar && toolbar.setActiveTf(tf),
    setTvDot: ok => toolbar && toolbar.setTv(ok ? 'loaded' : 'err'),
    setWsDot: on => toolbar && toolbar.setWs(on),
    setActiveDrawTool: t => toolbar && toolbar.setActiveTool(t),
    openDrawEditor: (obj, cfg, h) => dialogs.openDrawEditor(obj, cfg, h),
    closePopups: () => popups && popups.closeAll(),
    setElement: (id, kind, v) => {
      if (id === 'sym-lbl') { toolbar && toolbar.setSymbol(String(v).replace(/\.P$/, '')); return; }
      statusbar && statusbar.setElement(id, kind, v);
    }
  };

  // ── widget ──
  sidebar = createSidebar({ onToggleCalendar: () => calendar.toggle() });
  chart = createChartView({ engine, prefs, ui });
  const core = chart.core;

  const origin = w => { const p = w.mapTo(root, new QPoint(0, 0)); return { x: p.x(), y: p.y() }; };
  // label tombol Chart Type mengikuti tipe chart aktif (Standard / Renko / Footprint \u0394)
  const syncChartType = () => toolbar && toolbar.setChartType(core.chartTypeShort, core.chartType !== 'standard');

  toolbar = createToolbar({
    onPair: rect => popups.togglePair(rect, origin(toolbar.widget)),
    onInd: rect => popups.toggleInd(rect, origin(toolbar.widget)),
    onCtype: rect => popups.toggleCt(rect, origin(toolbar.widget)),
    onBackground: () => popups.closeAll(),
    onTf: tf => { if (tf !== core.tf) core.loadData(core.sym || 'BTCUSDT', tf); chart.focus(); },
    onTool: tool => { core.toggleTool(tool); chart.focus(); },
    onDelete: () => { core.deleteSelected(); chart.focus(); },
    onGo: () => { core.gotoLatestBtn(); chart.focus(); }
  });
  statusbar = createStatusBar();

  dialogs = createDialogs({ root, core, onClosed: () => chart.focus() });

  popups = createPopups({
    root,
    getSymbol: () => core.sym || 'BTCUSDT',
    onSelectPair: symbol => { core.loadData(symbol, core.tf || '60'); chart.focus(); },
    getIndicators: () => core.indicators,
    onToggleIndicator: id => core.toggleIndicator(id),
    onOpenConfig: id => { if (id === 'bubble') dialogs.openBubble(); else if (id === 'hvn') dialogs.openHvn(); else if (id === 'cvd') dialogs.openCvd(); else if (id === 'gamma') dialogs.openGamma(); else if (id === 'liq') dialogs.openLiq(); else if (id === 'ha') dialogs.openHa(); },
    isDisabled: id => (id === 'gamma' && !core.gammaSupported(core.sym || 'BTCUSDT')) || core.isIndicatorBlocked(id),
    disabledInfo: id => core.isIndicatorBlocked(id) ? { tag: core.indicatorBlockedTag(id), tip: 'Tidak tersedia pada chart ' + core.chartTypeLabel + ' (indikator ini membutuhkan candle berbasis waktu)' } : null,
    getChartType: () => core.chartType,
    onSelectChartType: async id => { await core.setChartType(id); syncChartType(); popups.refresh(); chart.focus(); },
    onOpenChartTypeConfig: id => { if (id === 'renko') dialogs.openRenko(); else if (id === 'footprint') dialogs.openFootprint(); },
    onStateChange: () => { toolbar.setPairOpen(popups.isPairOpen()); toolbar.setIndOpen(popups.isIndOpen()); toolbar.setCtypeOpen(popups.isCtOpen()); if (!popups.isPairOpen()) chart.focus(); }
  });
  syncChartType();

  calendar = createCalendar({
    engine,
    onOpened: () => sidebar.setCalendarOpen(true),
    onClosed: () => sidebar.setCalendarOpen(false)
  });

  // ── layout: sidebar | (toolbar / chart / status) | calendar ──
  const mainCol = new QWidget();
  const mainL = new QBoxLayout(Direction.TopToBottom);
  mainL.setContentsMargins(0, 0, 0, 0);
  mainL.setSpacing(0);
  mainCol.setLayout(mainL);
  mainL.addWidget(toolbar.widget);
  mainL.addWidget(chart.widget, 1);
  mainL.addWidget(statusbar.widget);

  rootL.addWidget(sidebar.widget);
  rootL.addWidget(mainCol, 1);
  rootL.addWidget(calendar.widget);

  root.addEventListener(WidgetEventTypes.Resize, () => { popups.closeAll(); dialogs.relayout(); });

  win.addEventListener(WidgetEventTypes.Close, () => {
    try { prefs.flush(); } catch (_) {}
    try { engine.shutdown(); } catch (_) {}
    setTimeout(() => process.exit(0), 50);
  });

  // ── pair list ──
  const loadPairs = async () => {
    try { popups.setPairs(await engine.getPairs()); } catch (e) { console.warn('[pairs]', e.message); }
  };
  engine.on('tv', () => loadPairs());

  if (opts.show !== false) win.show();
  chart.focus();

  // ── start (urutan sama dengan IIFE init versi browser) ──
  loadPairs();
  core.start();
  if (!opts.skipEngine) engine.start().catch(e => console.error('[Engine.start]', e));

  global.__hf = { win, root, engine, core, chart, toolbar, popups, dialogs, calendar, sidebar, statusbar, prefs }; // cegah GC + debugging
  return global.__hf;
}

module.exports = { main };
if (require.main === module || /main\.js$/.test(process.argv[1] || '')) main();
