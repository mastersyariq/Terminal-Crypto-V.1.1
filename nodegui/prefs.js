'use strict';
/**
 * Pengganti window.localStorage — disimpan ke data/ui-prefs.json
 * (konfigurasi bubble/HVN/CVD, default style drawing, dst). API sama: getItem/setItem/removeItem.
 */
const fs = require('fs');
const path = require('path');

class Prefs {
  constructor(file) {
    this.file = file || path.join(__dirname, '..', 'data', 'ui-prefs.json');
    this.data = {};
    this._timer = null;
    try {
      if (fs.existsSync(this.file)) this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')) || {};
    } catch (e) {
      console.warn('[Prefs] load error:', e.message);
      this.data = {};
    }
  }
  getItem(k) { return Object.prototype.hasOwnProperty.call(this.data, k) ? this.data[k] : null; }
  setItem(k, v) { this.data[k] = String(v); this._schedule(); }
  removeItem(k) { delete this.data[k]; this._schedule(); }
  _schedule() {
    if (this._timer) return;
    this._timer = setTimeout(() => { this._timer = null; this.flush(); }, 400);
  }
  flush() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 1), 'utf8');
    } catch (e) { console.warn('[Prefs] save error:', e.message); }
  }
}

module.exports = Prefs;
