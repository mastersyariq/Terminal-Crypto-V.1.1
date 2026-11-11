'use strict';
/**
 * chartCore.js — inti terminal chart (state, kamera, render canvas, drawing tools,
 * interaksi, volume profile, HVN, bubble, CVD, heavy absorption).
 *
 * File ini DIBANGUN OTOMATIS dari public/index.html versi asli (backup browser)
 * sehingga logika render & perilakunya identik. Yang diganti hanya "lem" platformnya:
 *   - <canvas> 2D            → Canvas2D shim di atas QPainter  (nodegui/canvas2d.js)
 *   - fetch('/api/...')      → env.api.*   (engine in-process, tanpa HTTP)
 *   - EventSource (SSE)      → env.events (EventEmitter dari engine)
 *   - localStorage           → env.localStorage (file JSON)
 *   - overlay DOM (OHLCV, buffer indicator, loading) → digambar langsung di canvas
 *   - modal/dropdown/kalender → widget Qt (folder nodegui/ui)
 *
 * JANGAN edit manual bagian logika di sini kalau ingin tetap sinkron dengan versi asli.
 */
module.exports = function createChartCore(env) {
  const { cv, ctx, document, localStorage, api, events, ui } = env;
  const requestAnimationFrame = env.requestAnimationFrame;
  const cancelAnimationFrame = env.cancelAnimationFrame;
  const window = env.window || {};

