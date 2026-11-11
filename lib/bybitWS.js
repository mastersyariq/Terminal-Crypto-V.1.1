'use strict';

const WebSocket = require('ws');

// Bybit public linear WebSocket endpoints.
// stream.bytick.com is PRIMARY — more resilient against regional
// ISP-level blocking/interception than stream.bybit.com.
const BYBIT_WS_URLS = [
  'wss://stream.bytick.com/v5/public/linear',
  'wss://stream.bybit.com/v5/public/linear'
];

// Exactly M1, M5, M15, M30, H1, H4, D1, W1
const TF_BYBIT = { '1':'1','5':'5','15':'15','30':'30','60':'60','240':'240','D':'D','W':'W' };

class BybitWS {
  constructor() {
    this.ws          = null;
    this.symbol      = null;
    this.tf          = null;
    this.onTick      = null;
    this.onTrade     = null;   // callback for publicTrade data
    this._pingTimer  = null;
    this._closed     = true;
    this._urlIdx     = 0;
    // Generation counter eliminates the race where a stale 'close' handler
    // from a superseded socket schedules a duplicate reconnect.
    this._gen        = 0;
  }

  connect(symbol, tf, onTick, onTrade) {
    this.symbol  = symbol;
    this.tf      = tf;
    this.onTick  = onTick;
    this.onTrade = onTrade || null;
    this._closed = false;

    const gen = ++this._gen;
    clearInterval(this._pingTimer);
    this._pingTimer = null;

    const interval   = TF_BYBIT[tf] || '60';
    const klineTopic = `kline.${interval}.${symbol}`;
    const tradeTopic = `publicTrade.${symbol}`;
    const url        = BYBIT_WS_URLS[this._urlIdx];

    console.log(`[Bybit WS] (gen ${gen}) Connecting → ${url} (${klineTopic} + ${tradeTopic})`);
    const ws = new WebSocket(url);
    this.ws  = ws;

    const isCurrent = () => gen === this._gen;

    ws.on('open', () => {
      if (!isCurrent()) { try { ws.close(); } catch {} return; }
      console.log(`[Bybit WS] (gen ${gen}) Connected`);
      // Subscribe to both kline (candle updates) and publicTrade (individual fills)
      ws.send(JSON.stringify({ op: 'subscribe', args: [klineTopic, tradeTopic] }));
      this._pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ op: 'ping' }));
      }, 15000);
    });

    ws.on('message', raw => {
      if (!isCurrent()) return;
      try {
        const msg = JSON.parse(raw.toString());

        // ── Kline tick ──
        if (msg.topic?.startsWith('kline') && msg.data?.length) {
          const k = msg.data[0];
          const tick = {
            time:    Math.floor(parseInt(k.start) / 1000),
            open:    parseFloat(k.open),
            high:    parseFloat(k.high),
            low:     parseFloat(k.low),
            close:   parseFloat(k.close),
            volume:  parseFloat(k.volume),
            confirm: Boolean(k.confirm)
          };
          if (this.onTick) this.onTick(tick);
        }

        // ── Public trade ──
        if (msg.topic?.startsWith('publicTrade') && msg.data?.length && this.onTrade) {
          for (const t of msg.data) {
            this.onTrade({
              time:   Math.floor(parseInt(t.T) / 1000),   // Unix seconds
              timeMs: parseInt(t.T),                        // Unix milliseconds (for precision)
              price:  parseFloat(t.p),
              volume: parseFloat(t.v),
              side:   t.S,  // 'Buy' or 'Sell'
              symbol: t.s || String(msg.topic).split('.')[1] || this.symbol   // simbol asal trade (dipakai footprint agar tidak tercampur saat ganti pair)
            });
          }
        }
      } catch {}
    });

    ws.on('close', (code, reason) => {
      if (!isCurrent()) return;
      clearInterval(this._pingTimer);
      this._pingTimer = null;
      console.log(`[Bybit WS] (gen ${gen}) Closed — code=${code} reason="${reason?.toString() || ''}"`);
      if (!this._closed) {
        console.log(`[Bybit WS] (gen ${gen}) Reconnecting in 4s…`);
        setTimeout(() => {
          if (isCurrent() && !this._closed) this.connect(this.symbol, this.tf, this.onTick, this.onTrade);
        }, 4000);
      }
    });

    ws.on('error', e => {
      if (!isCurrent()) return;
      console.error(`[Bybit WS] (gen ${gen}) Error:`, e.message);
    });
  }

  disconnect() {
    this._closed = true;
    this._gen++;
    clearInterval(this._pingTimer);
    this._pingTimer = null;
    if (this.ws) { try { this.ws.close(); } catch {} this.ws = null; }
    console.log('[Bybit WS] Disconnected (intentional)');
  }
}

module.exports = new BybitWS();
