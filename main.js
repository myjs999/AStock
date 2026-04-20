const { app, BrowserWindow, ipcMain, net } = require('electron');
const path = require('path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function netGet(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = net.request({ url, redirect: 'follow' });
    req.setHeader('User-Agent', UA);
    req.setHeader('Accept', 'application/json');
    for (const [k, v] of Object.entries(extraHeaders)) req.setHeader(k, v);
    req.on('response', (res) => {
      const chunks = [];
      res.on('data',  c => chunks.push(c));
      res.on('end',   () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

// Yahoo Finance free-tier interval limits (days back from today)
const INTERVAL_MAX_DAYS = { '1m': 7, '2m': 60, '5m': 60, '15m': 60, '30m': 60, '60m': 730, '1d': 36500 };
// Ordered finest → coarsest for auto-upgrade logic
const INTERVAL_ORDER = ['1m', '2m', '5m', '15m', '30m', '60m', '1d'];

function normalizeSymbol(ticker) {
  const exchangeCodes = new Set(['NYS', 'NYQ', 'NAS', 'ASE', 'PCX', 'PINK', 'OTC', 'NYSE', 'NASDAQ']);
  const dotIdx = ticker.lastIndexOf('.');
  if (dotIdx !== -1 && exchangeCodes.has(ticker.slice(dotIdx + 1).toUpperCase())) {
    return ticker.slice(0, dotIdx).toUpperCase();
  }
  return ticker.toUpperCase();
}

function dateToRange(dateStr) {
  const s = dateStr.replace(/-/g, '');
  const [y, m, d] = [s.slice(0, 4), s.slice(4, 6), s.slice(6, 8)];
  return {
    start: Math.floor(new Date(`${y}-${m}-${d}T00:00:00Z`).getTime() / 1000),
    end:   Math.floor(new Date(`${y}-${m}-${d}T23:59:59Z`).getTime() / 1000)
  };
}

function shiftDate(dateStr, daysBack) {
  const s = dateStr.replace(/-/g, '');
  const d = new Date(`${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - daysBack);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

function isNoData(result) {
  return !!result.error && (
    result.error.toLowerCase().includes('no trading data') ||
    result.error.toLowerCase().includes('no valid bars')
  );
}

function isNotFound(result) {
  return !!result.error && result.error.toLowerCase().includes('not found');
}

// Exchange suffixes to try when a bare symbol returns Not Found (e.g. delisted stocks)
const EXCHANGE_SUFFIXES = ['.NYSE', '.NAS', '.NASDAQ', '.AMEX', '.NYQ'];

// ── stooq.com fallback (free, keeps delisted US stock history) ─────────────
async function fetchFromStooq(symbol, date) {
  // Query a 14-day window ending on the target date so weekends/half-days
  // are covered; we'll pick the row at or nearest before the target.
  const d2  = date;
  const d1  = shiftDate(date, 14);
  const sym = encodeURIComponent(symbol.toLowerCase() + '.us');
  const url = `https://stooq.com/q/d/l/?s=${sym}&d1=${d1}&d2=${d2}&i=d`;
  try {
    const resp = await netGet(url, {
      Accept:  'text/csv,text/plain,*/*',
      Referer: 'https://stooq.com/'
    });
    if (resp.status !== 200) return { error: `No data available for ${symbol}` };
    const text = resp.body.trim();
    // stooq serves HTML when it blocks bots, or the literal "No data" for unknown syms
    if (!text || text.startsWith('<') || text.toLowerCase() === 'no data') {
      return { error: `No historical data found for ${symbol}` };
    }
    const lines = text.split('\n').filter(l => l.trim());
    // lines[0] = "Date,Open,High,Low,Close,Volume"
    if (lines.length < 2) return { error: `No historical data found for ${symbol}` };

    const rows = [];
    for (const line of lines.slice(1)) {
      const parts = line.split(',');
      if (parts.length < 5) continue;
      const [dateStr, open, high, low, close, volume] = parts;
      const c = {
        dateStr: dateStr.replace(/-/g, ''),
        // Pin to 9:30 AM ET (14:30 UTC) — NYSE open
        time:   Math.floor(new Date(`${dateStr}T14:30:00Z`).getTime() / 1000),
        open:   parseFloat(open),
        high:   parseFloat(high),
        low:    parseFloat(low),
        close:  parseFloat(close),
        volume: parseInt(volume) || 0
      };
      if (!isNaN(c.open) && !isNaN(c.close)) rows.push(c);
    }
    if (!rows.length) return { error: `No historical data found for ${symbol}` };

    // Sort descending, pick the row on or before the requested date
    rows.sort((a, b) => b.dateStr.localeCompare(a.dateStr));
    const row = rows.find(r => r.dateStr <= date) ?? rows[0];
    const { dateStr, ...candle } = row;  // strip internal field

    return {
      symbol,
      currency:     'USD',
      exchangeName: '',
      prevClose:    null,
      interval:     '1d',
      candles:      [candle],
      _fromStooq:   true,          // stripped before returning to renderer
      _stooqDate:   dateStr        // so caller can set adjustedDate if needed
    };
  } catch (e) {
    return { error: `stooq: ${e.message}` };
  }
}

// ── Barchart EOD proxy fallback ────────────────────────────────────────────
async function fetchFromBarchart(symbol, date) {
  const startDate = shiftDate(date, 14);
  const url = `https://www.barchart.com/proxies/timeseries/queryeod.ashx` +
    `?symbol=${encodeURIComponent(symbol)}&startDate=${startDate}&endDate=${date}&type=price&raw=1`;
  try {
    const resp = await netGet(url, {
      Accept:  'text/html,application/xhtml+xml,*/*',
      Referer: `https://www.barchart.com/stocks/quotes/${symbol}/historical-download`
    });
    if (resp.status !== 200) return { error: `barchart HTTP ${resp.status}` };
    const text = resp.body.trim();
    if (!text || text.startsWith('<') || !text.includes(',')) {
      return { error: `No historical data found for ${symbol}` };
    }
    const rows = [];
    for (const line of text.split('\n')) {
      // fields may be quoted: "20241129","57.12",... or unquoted: 20241129,57.12,...
      const parts = line.trim().split(',').map(p => p.replace(/"/g, '').trim());
      if (parts.length < 5) continue;
      const [dateStr, open, high, low, close, volume] = parts;
      if (!/^\d{8}$/.test(dateStr)) continue;
      const iso = `${dateStr.slice(0,4)}-${dateStr.slice(4,6)}-${dateStr.slice(6,8)}`;
      const c = {
        dateStr,
        time:   Math.floor(new Date(`${iso}T14:30:00Z`).getTime() / 1000),
        open:   parseFloat(open),
        high:   parseFloat(high),
        low:    parseFloat(low),
        close:  parseFloat(close),
        volume: parseInt(volume) || 0
      };
      if (!isNaN(c.open) && !isNaN(c.close)) rows.push(c);
    }
    if (!rows.length) return { error: `No historical data found for ${symbol}` };

    rows.sort((a, b) => b.dateStr.localeCompare(a.dateStr));
    const row = rows.find(r => r.dateStr <= date) ?? rows[0];
    const { dateStr, ...candle } = row;

    return {
      symbol,
      currency:     'USD',
      exchangeName: '',
      prevClose:    null,
      interval:     '1d',
      candles:      [candle],
      _fromStooq:   true,
      _stooqDate:   dateStr
    };
  } catch (e) {
    return { error: `barchart: ${e.message}` };
  }
}

function parseYahooResponse(body, symbol) {
  let json;
  try { json = JSON.parse(body); } catch { return { error: 'Invalid JSON from Yahoo Finance' }; }

  const result = json?.chart?.result?.[0];
  if (!result) {
    const err = json?.chart?.error;
    if (err?.code === 'Not Found') return { error: `Symbol not found or delisted: ${symbol}` };
    return { error: err?.description || 'No data returned' };
  }

  const timestamps = result.timestamp;
  const quote = result.indicators?.quote?.[0];

  if (!timestamps?.length || !quote) {
    return { error: 'No trading data for this date (market closed or holiday)' };
  }

  const candles = timestamps
    .map((ts, i) => ({
      time:   ts,
      open:   quote.open[i],
      high:   quote.high[i],
      low:    quote.low[i],
      close:  quote.close[i],
      volume: quote.volume[i] ?? 0
    }))
    .filter(c => c.open != null && c.high != null && c.low != null && c.close != null)
    .sort((a, b) => a.time - b.time);

  if (!candles.length) return { error: 'No valid bars — market was likely closed this day' };

  const meta = result.meta;
  return {
    symbol:       meta.symbol ?? symbol,
    currency:     meta.currency ?? 'USD',
    exchangeName: meta.exchangeName ?? '',
    prevClose:    meta.chartPreviousClose ?? meta.previousClose ?? null,
    interval:     meta.dataGranularity ?? '',
    candles
  };
}

ipcMain.handle('fetch-stock', async (_event, { ticker, date, interval }) => {
  try {
    const symbol = normalizeSymbol(ticker);
    const { start } = dateToRange(date);
    let iv = interval || '1m';

    // If selected interval doesn't cover this date, auto-upgrade to shortest that does
    const daysAgo = (Date.now() / 1000 - start) / 86400;
    let adjustedInterval = null;
    if (daysAgo > (INTERVAL_MAX_DAYS[iv] ?? 7) + 1) {
      const best = INTERVAL_ORDER.find(c => (INTERVAL_MAX_DAYS[c] ?? 7) >= daysAgo - 1);
      if (!best) return { error: 'Date is too far in the past for any supported interval.' };
      adjustedInterval = best;
      iv = best;
    }

    async function tryFetch(sym, d) {
      const { start: s, end: e } = dateToRange(d);
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}` +
        `?interval=${iv}&period1=${s}&period2=${e}&includePrePost=false`;
      const resp = await netGet(url);
      return parseYahooResponse(resp.body, sym);
    }

    async function tryDate(d) {
      let result = await tryFetch(symbol, d);
      // If bare symbol not found, try exchange suffixes (helps with delisted stocks)
      if (isNotFound(result)) {
        for (const suffix of EXCHANGE_SUFFIXES) {
          const r = await tryFetch(symbol + suffix, d);
          if (!r.error || !isNotFound(r)) {
            if (!r.error) r.symbol = symbol; // normalise symbol back to bare form
            return r;
          }
        }
        // Yahoo has no record — try stooq, then Barchart (daily data only)
        const stooq = await fetchFromStooq(symbol, d);
        if (!stooq.error) return stooq;
        return await fetchFromBarchart(symbol, d);
      }
      return result;
    }

    let result = await tryDate(date);

    // For Yahoo results: if no trading data, look back up to 7 days for nearest trading day
    if (isNoData(result)) {
      const originalDate = date;
      for (let i = 1; i <= 7; i++) {
        const candidate = shiftDate(date, i);
        const r = await tryDate(candidate);
        if (!r.error) {
          r.adjustedDate  = r._stooqDate ?? candidate;
          r.originalDate  = originalDate;
          // clean stooq internals
          delete r._fromStooq; delete r._stooqDate;
          if (!r.adjustedInterval) {
            if (r.interval === '1d' && iv !== '1d') r.adjustedInterval = '1d';
            else if (adjustedInterval) r.adjustedInterval = adjustedInterval;
          }
          return r;
        }
        if (!isNoData(r)) break; // hard error — stop early
      }
    }

    if (!result.error) {
      // stooq picked a different day than requested — surface as adjustedDate
      if (result._stooqDate && result._stooqDate !== date) {
        result.adjustedDate  = result._stooqDate;
        result.originalDate  = date;
      }
      // stooq only has daily data — report interval switch if user wanted finer
      if (result._fromStooq && iv !== '1d') {
        result.adjustedInterval = '1d';
      } else if (adjustedInterval) {
        result.adjustedInterval = adjustedInterval;
      }
      delete result._fromStooq;
      delete result._stooqDate;
    }
    return result;
  } catch (e) {
    return { error: e.message };
  }
});

async function fetchStockAnalysis(symbol) {
  for (const kind of ['stocks', 'etf']) {
    const req = net.request({ url: `https://stockanalysis.com/${kind}/${symbol.toLowerCase()}/`, redirect: 'follow' });
    req.setHeader('User-Agent', UA);
    req.setHeader('Accept', 'text/html,*/*');
    const resp = await new Promise((resolve, reject) => {
      req.on('response', res => {
        const c = []; res.on('data', d => c.push(d));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString() }));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });
    if (resp.status !== 200) continue;
    const html = resp.body;
    const text = t => t?.replace(/&amp;/g, '&').replace(/&#39;/g, "'").trim() ?? '';
    const h1      = html.match(/<h1[^>]*>([^<(]+)\s*\(/);
    const ogTitle = html.match(/og:title" content="([^"(]+)\s*\(/);
    const name    = text(h1?.[1] ?? ogTitle?.[1] ?? '');
    const exch    = (html.match(/NYSE|NASDAQ|NasdaqGS|NasdaqCM|AMEX/) ?? [])[0] ?? '';
    const ipoM    = html.match(/>IPO Date<\/span>[\s\S]{0,80}?<span>([^<]+)<\/span>/);
    const listedDate = text(ipoM?.[1]);
    const delistM    = html.match(/([A-Z][a-z]+ \d+, \d{4}) - \S+ was delisted[^(]*\(reason:\s*([^)]+)\)/);
    const delistDate   = text(delistM?.[1]);
    const delistReason = text(delistM?.[2]);
    return { symbol, name, exchange: exch, listedDate, delistDate, delistReason, isDelisted: !!delistDate };
  }
  return { error: `No info found for ${symbol}` };
}

ipcMain.handle('fetch-stock-info', async (_event, { ticker }) => {
  try {
    return await fetchStockAnalysis(normalizeSymbol(ticker));
  } catch (e) {
    return { error: e.message };
  }
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    backgroundColor: '#131722',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile('index.html');
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
