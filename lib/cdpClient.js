'use strict';

const http      = require('http');
const WebSocket = require('ws');
const sleep     = ms => new Promise(r => setTimeout(r, ms));

class CDPClient {
  constructor(port = 9333) {
    this.port      = port;
    this.ws        = null;
    this.msgId     = 0;
    this.cbs       = new Map();
    this.connected = false;
  }

  async connect() {
    if (this.connected) return;
    const url = await this._wsUrl();
    if (!url) throw new Error(`TradingView Desktop not found on CDP port ${this.port}`);
    return new Promise((res, rej) => {
      this.ws = new WebSocket(url);
      this.ws.on('open',    () => { this.connected = true; console.log('[CDP] Connected to TradingView Desktop'); res(); });
      this.ws.on('error',   e  => { this.connected = false; rej(e); });
      this.ws.on('close',   () => {
        this.connected = false;
        this.cbs.forEach(({ reject: r }) => r(new Error('CDP disconnected')));
        this.cbs.clear();
      });
      this.ws.on('message', raw => {
        const m = JSON.parse(raw.toString());
        if (m.id && this.cbs.has(m.id)) {
          const { resolve, reject } = this.cbs.get(m.id);
          this.cbs.delete(m.id);
          m.error ? reject(new Error(m.error.message)) : resolve(m.result);
        }
      });
    });
  }

  _wsUrl() {
    return new Promise(resolve => {
      http.get(`http://localhost:${this.port}/json`, res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => {
          try {
            const ts = JSON.parse(d);
            const t  = ts.find(x => x.type === 'page' && x.url?.includes('tradingview'))
                    || ts.find(x => x.type === 'page') || ts[0];
            resolve(t?.webSocketDebuggerUrl || null);
          } catch { resolve(null); }
        });
      }).on('error', () => resolve(null));
    });
  }

  async send(method, params = {}) {
    if (!this.connected) await this.connect();
    const id = ++this.msgId;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.cbs.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 20000);
      this.cbs.set(id, {
        resolve: r => { clearTimeout(t); resolve(r); },
        reject:  e => { clearTimeout(t); reject(e); }
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expr, returnRaw = false) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr, returnByValue: !returnRaw, awaitPromise: true, timeout: 20000
    });
    if (r.exceptionDetails)
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return returnRaw ? r.result.value : r.result.value;
  }

  async key(key, ctrl = false, shift = false, alt = false) {
    const mod  = (ctrl ? 2 : 0) | (alt ? 1 : 0) | (shift ? 8 : 0);
    const vkMap = { Return: 13, '/': 191, Escape: 27, Backspace: 8 };
    const code = vkMap[key] ?? key.toUpperCase().charCodeAt(0);
    for (const type of ['keyDown', 'keyUp'])
      await this.send('Input.dispatchKeyEvent', { type, key, modifiers: mod, windowsVirtualKeyCode: code });
    await sleep(40);
  }

  async type(text) {
    for (const ch of text) {
      await this.send('Input.dispatchKeyEvent', { type: 'char', text: ch });
      await sleep(15);
    }
  }

  // ── Real mouse simulation via CDP Input domain ──────────
  // These dispatch genuine OS-level input events (not page-JS
  // synthetic events), exactly like a real user interacting with
  // the chart. This is the most reliable way to trigger TradingView's
  // historical-data backend fetch, since internal JS state methods
  // (scrollTimeTo, requestMoreData) do not reliably trigger new fetches.

  async mouseMove(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  }

  async mouseDown(x, y, button = 'left') {
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 });
  }

  async mouseUp(x, y, button = 'left') {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 });
  }

  /**
   * Simulate a real click-and-drag gesture (mousedown → move → mouseup).
   * Used to pan the TradingView chart exactly like a human dragging it.
   * @param {number} x1   start X
   * @param {number} x2   end X
   * @param {number} y    Y position (kept constant — horizontal drag)
   * @param {number} steps  number of intermediate move events (smoother = more reliable)
   */
  async dragPan(x1, x2, y, steps = 12) {
    await this.mouseMove(x1, y);
    await sleep(30);
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y, button: 'left', clickCount: 1 });
    await sleep(40);

    for (let i = 1; i <= steps; i++) {
      const x = x1 + (x2 - x1) * (i / steps);
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
      await sleep(25);
    }

    await sleep(40);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y, button: 'left', clickCount: 1 });
  }

  /** Scroll wheel at a given point — used for zoom, not pan, on TV charts. */
  async mouseWheel(x, y, deltaY) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY });
  }
}

module.exports = CDPClient;
