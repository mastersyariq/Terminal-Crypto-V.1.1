/**
 * calendarScraper.js
 * Adapted from Calendar Watcher project — fetches US Economic Calendar
 * from investing.com using only built-in Node.js modules (no npm deps).
 */

'use strict';

const https = require('https');
const querystring = require('querystring');

// ── Config ───────────────────────────────────────────────────
const COUNTRY_ID_US = 5;
const TIMEZONE_GMT  = 56;
const FUTURE_DAYS   = 14;   // 2 weeks ahead
const PAST_DAYS     = 3;    // 3 days back
const MAX_PAGES     = 20;
const PAGE_DELAY_MS = 350;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const HOST = 'www.investing.com';
const CALENDAR_PATH = '/economic-calendar/';
const FILTER_PATH = '/economic-calendar/Service/getCalendarFilteredData';

// ── HTTP helper ──────────────────────────────────────────────
function httpRequest(options, postData) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('Request timeout')));
    if (postData) req.write(postData);
    req.end();
  });
}

function pickCookies(setCookieHeaders) {
  if (!setCookieHeaders) return '';
  return setCookieHeaders.map((c) => c.split(';')[0]).join('; ');
}

async function getSessionCookies() {
  try {
    const res = await httpRequest({
      hostname: HOST,
      path: CALENDAR_PATH,
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    return pickCookies(res.headers['set-cookie']);
  } catch (e) {
    return '';
  }
}

function fmtDate(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ── Fetch one page ───────────────────────────────────────────
async function fetchPage({ dateFrom, dateTo, limitFrom, cookie }) {
  const postData = querystring.stringify({
    'country[]': String(COUNTRY_ID_US),
    dateFrom,
    dateTo,
    timeZone: String(TIMEZONE_GMT),
    timeFilter: 'timeOnly',
    currentTab: 'custom',
    submitFilters: '1',
    limit_from: String(limitFrom),
  });

  const res = await httpRequest(
    {
      hostname: HOST,
      path: FILTER_PATH,
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'text/html',
        'Accept-Language': 'en-US,en;q=0.9',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Content-Length': Buffer.byteLength(postData),
        Referer: 'https://www.investing.com/economic-calendar/',
        Origin: 'https://www.investing.com',
        ...(cookie ? { Cookie: cookie } : {}),
      },
    },
    postData
  );

  if (res.statusCode !== 200) {
    throw new Error(`investing.com returned status ${res.statusCode}`);
  }

  let json;
  try {
    json = JSON.parse(res.body);
  } catch (e) {
    throw new Error('Response is not JSON — possibly blocked by Cloudflare');
  }
  return json.data || '';
}

// ── HTML parsing helpers ─────────────────────────────────────
function stripTags(html) {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;/g, "'")
    .replace(/&quot;/g, '"')
    .trim();
}

function findTdById(trInner, idValue) {
  const re = new RegExp('<td\\b([^>]*\\bid="' + idValue + '"[^>]*)>([\\s\\S]*?)<\\/td>', 'i');
  const m = re.exec(trInner);
  if (!m) return null;
  return { attrs: m[1], html: m[2], text: stripTags(m[2]) };
}

function findTdByClass(trInner, classFragment) {
  const re = new RegExp(
    '<td\\b([^>]*\\bclass="[^"]*' + classFragment + '[^"]*"[^>]*)>([\\s\\S]*?)<\\/td>',
    'i'
  );
  const m = re.exec(trInner);
  if (!m) return null;
  return { attrs: m[1], html: m[2], text: stripTags(m[2]) };
}

function classifySignal(attrs) {
  if (!attrs) return 'neutral';
  if (/redFont/i.test(attrs)) return 'bad';
  if (/greenFont/i.test(attrs)) return 'good';
  return 'neutral';
}

// ── Parse <tr> rows into event array ─────────────────────────
function parseRows(html, dateRef) {
  const events = [];
  const trRegex = /<tr\b([^>]*)>([\s\S]*?)<\/tr>/g;
  let m;

  while ((m = trRegex.exec(html)) !== null) {
    const trAttrs = m[1];
    const trInner = m[2];

    const idMatch = /\bid="([^"]+)"/.exec(trAttrs);
    const trId = idMatch ? idMatch[1] : null;

    if (!trId) {
      const dayMatch = /<td[^>]*\bid="theDay(\d+)"/.exec(trInner);
      if (dayMatch) dateRef.unix = parseInt(dayMatch[1], 10);
      continue;
    }
    if (trId.indexOf('eventRowId_') !== 0) continue;

    const eventId = trId.replace('eventRowId_', '');

    const timeCell = findTdByClass(trInner, 'first left');
    const timeText = timeCell ? timeCell.text : '';

    const flagCell = findTdByClass(trInner, 'flagCur');
    let country = '';
    let currency = '';
    if (flagCell) {
      const titleMatch = /title="([^"]+)"/.exec(flagCell.html);
      country = titleMatch ? titleMatch[1] : '';
      currency = flagCell.text;
    }

    const sentimentCell = findTdByClass(trInner, 'sentiment');
    let impact = 0;
    if (sentimentCell) {
      const keyMatch = /data-img_key="bull(\d)"/.exec(sentimentCell.attrs);
      if (keyMatch) impact = parseInt(keyMatch[1], 10);
    }

    const eventCell = findTdByClass(trInner, 'event');
    const eventName = eventCell ? eventCell.text : '(unnamed)';

    const actualCell = findTdById(trInner, `eventActual_${eventId}`);
    const forecastCell = findTdById(trInner, `eventForecast_${eventId}`);
    const previousCell = findTdById(trInner, `eventPrevious_${eventId}`);

    let timestamp = dateRef.unix ? dateRef.unix * 1000 : null;
    const hm = /^(\d{1,2}):(\d{2})$/.exec(timeText.trim());
    if (timestamp !== null && hm) {
      timestamp += (parseInt(hm[1], 10) * 60 + parseInt(hm[2], 10)) * 60000;
    }

    events.push({
      id: eventId,
      timestamp,
      timeText: timeText || 'All Day',
      country,
      currency,
      impact,
      event: eventName,
      actual: actualCell ? actualCell.text : '',
      forecast: forecastCell ? forecastCell.text : '',
      previous: previousCell ? previousCell.text : '',
      signal: classifySignal(actualCell ? actualCell.attrs : null),
    });
  }

  return events;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function computeRange() {
  const now = new Date();
  const from = new Date(now);
  from.setUTCDate(from.getUTCDate() - PAST_DAYS);
  const to = new Date(now);
  to.setUTCDate(to.getUTCDate() + FUTURE_DAYS);
  return { dateFrom: fmtDate(from), dateTo: fmtDate(to) };
}

// ── Main: fetch all US events ────────────────────────────────
async function fetchUSEconomicCalendar() {
  const { dateFrom, dateTo } = computeRange();
  try {
    const cookie = await getSessionCookies();

    const dateRef = { unix: null };
    const all = [];
    let lastId = null;

    for (let page = 0; page < MAX_PAGES; page++) {
      const html = await fetchPage({ dateFrom, dateTo, limitFrom: page, cookie });
      const rows = parseRows(html, dateRef);

      if (rows.length === 0) break;

      const newLastId = rows[rows.length - 1].id;
      all.push(...rows);

      if (newLastId === lastId) break;
      lastId = newLastId;

      await sleep(PAGE_DELAY_MS);
    }

    const seen = new Set();
    const deduped = all.filter((e) => {
      if (seen.has(e.id)) return false;
      seen.add(e.id);
      return true;
    });

    deduped.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

    try {
      const cachePath = require('path').join(__dirname, '..', 'data', 'cache.json');
      require('fs').writeFileSync(cachePath, JSON.stringify({ events: deduped, range: { dateFrom, dateTo }, fetchedAt: Date.now() }), 'utf8');
    } catch {}

    return { events: deduped, range: { dateFrom, dateTo }, fetchedAt: Date.now() };
  } catch (err) {
    try {
      const cachePath = require('path').join(__dirname, '..', 'data', 'cache.json');
      if (require('fs').existsSync(cachePath)) {
        const cached = JSON.parse(require('fs').readFileSync(cachePath, 'utf8'));
        if (cached && cached.events && cached.events.length) {
          console.log(`[Calendar] Loaded ${cached.events.length} events from local cache (network note: ${err.message})`);
          return { events: cached.events, range: cached.range || { dateFrom, dateTo }, fetchedAt: cached.fetchedAt || Date.now() };
        }
      }
    } catch (e2) {}
    throw err;
  }
}

module.exports = {
  fetchUSEconomicCalendar,
  PAST_DAYS,
};
