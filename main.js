const { app, BrowserWindow, ipcMain, net, Menu, shell } = require('electron');
const path = require('path');
const fs   = require('fs');

// Keep userData at the original path regardless of package name changes
app.setPath('userData', path.join(app.getPath('appData'), 'stocks-app'));

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

// US exchange suffixes to strip (Yahoo uses bare ticker for US stocks)
const US_EXCHANGE_CODES = new Set(['NYS', 'NYQ', 'NAS', 'ASE', 'PCX', 'PINK', 'OTC', 'NYSE', 'NASDAQ']);

// Chinese / other exchange suffix → Yahoo Finance suffix
const SUFFIX_MAP = {
  // Shenzhen
  'SZE': 'SZ', 'SZSE': 'SZ', 'SZ': 'SZ',
  // Shanghai
  'SSE': 'SS', 'SHA': 'SS', 'SH': 'SS', 'SS': 'SS',
  // Hong Kong
  'HKG': 'HK', 'HKEX': 'HK', 'HK': 'HK'
};

function normalizeSymbol(ticker) {
  // Auto-detect bare 6-digit Chinese codes: 0/3xxxxx → SZ,  6/9xxxxx → SS
  if (/^\d{6}$/.test(ticker)) {
    const c = ticker[0];
    if (c === '0' || c === '3') return ticker + '.SZ';
    if (c === '6' || c === '9') return ticker + '.SS';
  }

  const dotIdx = ticker.lastIndexOf('.');
  if (dotIdx === -1) return ticker.toUpperCase();

  const base   = ticker.slice(0, dotIdx).toUpperCase();
  const suffix = ticker.slice(dotIdx + 1).toUpperCase();

  if (US_EXCHANGE_CODES.has(suffix))  return base;               // strip US suffix
  if (SUFFIX_MAP[suffix])             return `${base}.${SUFFIX_MAP[suffix]}`;  // remap
  return `${base}.${suffix}`;                                    // pass through (.HK, .L, etc.)
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

// ── Eastmoney (东方财富) — real-time CN data source ────────────────────────
// Interval → Eastmoney klt code (2m not supported → promoted to 5m)
const KLT_MAP = { '1m': 1, '2m': 5, '5m': 5, '15m': 15, '30m': 30, '60m': 60, '1d': 101 };

function symbolToEM(symbol) {
  const up = symbol.toUpperCase();
  if (up.endsWith('.SS')) return { secid: `1.${symbol.slice(0, -3)}`, exchange: 'SHH', fullExchange: 'Shanghai' };
  if (up.endsWith('.SZ')) return { secid: `0.${symbol.slice(0, -3)}`, exchange: 'SHZ', fullExchange: 'Shenzhen' };
  return null;
}

async function fetchFromEastmoney(symbol, date, interval, endDate = null) {
  const em = symbolToEM(symbol);
  if (!em) return { error: 'Not a CN stock' };

  const klt  = KLT_MAP[interval] || 101;
  const beg  = date;
  const end  = endDate || date;
  const url  = `https://push2his.eastmoney.com/api/qt/stock/kline/get` +
    `?secid=${em.secid}` +
    `&fields1=f1,f2,f3,f4,f5,f6` +
    `&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61` +
    `&klt=${klt}&fqt=0&beg=${beg}&end=${end}&lmt=2000`;

  try {
    const resp = await netGet(url, { Referer: 'https://www.eastmoney.com/' });
    let json;
    try { json = JSON.parse(resp.body); } catch { return { error: 'Invalid response from Eastmoney' }; }

    const data = json?.data;
    if (!data || !data.klines || !data.klines.length) {
      return { error: 'No trading data for this date (market closed or holiday)' };
    }

    // kline format: "datetime,open,close,high,low,volume,amount,amplitude,chgPct,chg,turnover"
    // Intraday datetime: "2026-04-22 09:31"  → parse as CST (UTC+8)
    // Daily datetime:    "2026-04-22"         → parse as midnight UTC
    const candles = data.klines.map(line => {
      const p      = line.split(',');
      const dtStr  = p[0];
      const isoStr = dtStr.includes(' ')
        ? dtStr.replace(' ', 'T') + ':00+08:00'   // intraday: CST
        : dtStr + 'T00:00:00Z';                   // daily: midnight UTC
      const ts = Math.floor(new Date(isoStr).getTime() / 1000);
      return {
        time:   ts,
        open:   parseFloat(p[1]),
        close:  parseFloat(p[2]),
        high:   parseFloat(p[3]),
        low:    parseFloat(p[4]),
        volume: parseFloat(p[5]) || 0
      };
    }).filter(c => !isNaN(c.open) && !isNaN(c.close) && !isNaN(c.time)).sort((a, b) => a.time - b.time);

    if (!candles.length) return { error: 'No valid bars for this date' };

    // Derive prevClose: Eastmoney gives preKPrice on the first kline's parent day,
    // or we can compute from the first bar's open vs change field in the response.
    const prevClose = data.preKPrice ?? null;

    return {
      symbol,
      currency:         'CNY',
      exchangeName:     em.exchange,
      fullExchangeName: em.fullExchange,
      prevClose,
      interval,
      longName:         data.name ?? '',
      fiftyTwoWeekHigh: null,
      fiftyTwoWeekLow:  null,
      source:           'Eastmoney',
      candles
    };
  } catch (e) {
    return { error: `Eastmoney: ${e.message}` };
  }
}

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
      source:       'stooq',
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
      source:       'Barchart',
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

  const meta = result.meta;

  // Per-exchange lunch-break / off-hours filters (UTC seconds-of-day)
  // China A-shares: lunch 11:30–13:00 CST = 03:30–05:00 UTC (12600–18000)
  const BREAK_FILTERS = {
    SHZ: ts => { const s = ts % 86400; return s >= 12600 && s < 18000; },
    SHH: ts => { const s = ts % 86400; return s >= 12600 && s < 18000; },
  };
  const inBreak = BREAK_FILTERS[meta.exchangeName] ?? (() => false);

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
    .filter(c => !inBreak(c.time))
    .sort((a, b) => a.time - b.time);

  if (!candles.length) return { error: 'No valid bars — market was likely closed this day' };

  return {
    symbol:           meta.symbol ?? symbol,
    currency:         meta.currency ?? 'USD',
    exchangeName:     meta.exchangeName ?? '',
    fullExchangeName: meta.fullExchangeName ?? '',
    prevClose:        meta.chartPreviousClose ?? meta.previousClose ?? null,
    interval:         meta.dataGranularity ?? '',
    longName:         meta.longName ?? meta.shortName ?? '',
    fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh ?? null,
    fiftyTwoWeekLow:  meta.fiftyTwoWeekLow  ?? null,
    source:           'Yahoo Finance',
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

    // ── CN stocks: use Eastmoney (real-time, no delay) ──────────────────────
    if (/\.(SS|SZ)$/i.test(symbol)) {
      // Remap 2m → 5m since Eastmoney doesn't support 2-minute bars
      const emIv = iv === '2m' ? '5m' : iv;
      if (iv === '2m') adjustedInterval = '5m';

      async function tryEM(d) {
        return fetchFromEastmoney(symbol, d, emIv);
      }

      let result = await tryEM(date);

      if (isNoData(result)) {
        const originalDate = date;
        for (let i = 1; i <= 7; i++) {
          const candidate = shiftDate(date, i);
          const r = await tryEM(candidate);
          if (!r.error) {
            r.adjustedDate = candidate;
            r.originalDate = originalDate;
            if (adjustedInterval) r.adjustedInterval = adjustedInterval;
            return r;
          }
          if (!isNoData(r)) break;
        }
      }

      if (!result.error) {
        if (adjustedInterval) result.adjustedInterval = adjustedInterval;
        return result;
      }
      // If Eastmoney fails entirely, fall through to Yahoo as last resort
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

let mainWindow = null;

// ── Daily range fetch ───────────────────────────────────────
ipcMain.handle('fetch-stock-range', async (_event, { ticker, startDate, endDate }) => {
  try {
    const symbol = normalizeSymbol(ticker);

    // CN stocks: use Eastmoney for daily range data
    if (/\.(SS|SZ)$/i.test(symbol)) {
      const result = await fetchFromEastmoney(symbol, startDate, '1d', endDate);
      if (!result.error) {
        result.startDate = startDate;
        result.endDate   = endDate;
      }
      return result;
    }

    const fmt    = d => `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`;
    const start  = Math.floor(new Date(`${fmt(startDate)}T00:00:00Z`).getTime() / 1000);
    const end    = Math.floor(new Date(`${fmt(endDate)}T23:59:59Z`).getTime()   / 1000);

    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}` +
      `?interval=1d&period1=${start}&period2=${end}&includePrePost=false`;
    const resp = await netGet(url);
    const result = parseYahooResponse(resp.body, symbol);
    if (!result.error) {
      result.source    = 'Yahoo Finance';
      result.startDate = startDate;
      result.endDate   = endDate;
    }
    return result;
  } catch (e) {
    return { error: e.message };
  }
});

// ── Order book ──────────────────────────────────────────────
ipcMain.handle('fetch-orderbook', async (_event, { ticker }) => {
  try {
    const symbol = normalizeSymbol(ticker);

    // CN stocks: Tencent Finance — real-time, 5-level bid/ask
    if (/\.(SS|SZ)$/i.test(symbol)) {
      const code   = symbol.slice(0, -3).toLowerCase();
      const prefix = symbol.toUpperCase().endsWith('.SS') ? 'sh' : 'sz';
      const url    = `https://qt.gtimg.cn/q=${prefix}${code}`;
      const resp   = await netGet(url, { Referer: 'https://finance.qq.com/' });
      const match  = resp.body.match(/="([^"]+)"/);
      if (!match) return { error: 'No order book data' };
      const p = match[1].split('~');
      if (p.length < 30) return { error: 'Unexpected format' };

      const price = parseFloat(p[3]);
      const bids  = [], asks = [];
      for (let i = 0; i < 5; i++) {
        bids.push({ price: parseFloat(p[9  + i * 2]), vol: parseInt(p[10 + i * 2]) || 0 });
        asks.push({ price: parseFloat(p[19 + i * 2]), vol: parseInt(p[20 + i * 2]) || 0 });
      }
      return { symbol, price, bids, asks, levels: 5, source: 'Tencent' };
    }

    // US/HK stocks: Yahoo Finance v7 quote — best bid/ask only
    const url  = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}`;
    const resp = await netGet(url);
    let json;
    try { json = JSON.parse(resp.body); } catch { return { error: 'Invalid response' }; }
    const q = json?.quoteResponse?.result?.[0];
    if (!q) return { error: 'No quote data' };
    return {
      symbol,
      price:  q.regularMarketPrice ?? null,
      bids:   q.bid  != null ? [{ price: q.bid,  vol: q.bidSize  ?? 0 }] : [],
      asks:   q.ask  != null ? [{ price: q.ask,  vol: q.askSize  ?? 0 }] : [],
      levels: 1,
      source: 'Yahoo Finance'
    };
  } catch (e) {
    return { error: e.message };
  }
});

// ── News ────────────────────────────────────────────────────
ipcMain.handle('fetch-news', async (_event, { ticker }) => {
  try {
    const symbol = normalizeSymbol(ticker);
    // Yahoo Finance RSS — ticker-scoped, no auth needed
    const url  = `https://feeds.finance.yahoo.com/rss/2.0/headline` +
      `?s=${encodeURIComponent(symbol)}&region=US&lang=en-US`;
    const resp = await netGet(url, { Accept: 'application/rss+xml, text/xml, */*' });
    const xml  = resp.body;

    // Parse <item> blocks with regex (no xml lib needed)
    const items = [];
    const itemRx = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = itemRx.exec(xml)) !== null) {
      const block = m[1];
      const get   = tag => {
        const r = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'i');
        return (r.exec(block)?.[1] ?? '').trim();
      };
      const title = get('title');
      const link  = get('link') || get('guid');
      const pub   = get('pubDate');
      const src   = get('source') || get('dc:creator') || '';
      if (!title) continue;
      items.push({
        title,
        publisher: src,
        link,
        time: pub ? Math.floor(new Date(pub).getTime() / 1000) : 0
      });
    }
    return { items };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('open-url', (_event, url) => shell.openExternal(url));

// ── Company fundamentals ─────────────────────────────────────
ipcMain.handle('fetch-company', async (_event, { ticker }) => {
  const symbol = normalizeSymbol(ticker);
  let data = {};
  const fill = (key, val) => { if (data[key] == null && val != null) data[key] = val; };

  // ── CN stocks: Tencent (valuation) + Eastmoney DataCenter (profile) ──
  if (/\.(SS|SZ)$/i.test(symbol)) {
    const code    = symbol.slice(0, -3);
    const prefix  = symbol.toUpperCase().endsWith('.SS') ? 'sh' : 'sz';
    const emCode  = symbol.toUpperCase().endsWith('.SS') ? `SH${code}` : `SZ${code}`;

    // Tencent full quote — PE, PB, market cap, 52w H/L
    try {
      const resp  = await netGet(`https://qt.gtimg.cn/q=${prefix}${code}`, { Referer: 'https://finance.qq.com/' });
      const match = resp.body.match(/="([^"]+)"/);
      if (match) {
        const p = match[1].split('~');
        const f = (i, scale = 1) => { const v = parseFloat(p[i]); return isNaN(v) || v === 0 ? null : v * scale; };
        fill('marketCap',  f(43, 1e4));   // 万元 → yuan
        fill('trailingPE', f(37));
        fill('priceToBook', f(46));
        fill('week52High', f(39));
        fill('week52Low',  f(40));
        fill('country', 'China');
      }
    } catch {}

    // Eastmoney DataCenter — org profile
    try {
      const profUrl = `https://datacenter.eastmoney.com/securities/api/data/get` +
        `?type=RPT_F10_INFO_ORGPROFILE` +
        `&sty=ORG_NAME,ORG_SHORT_NAME,FOUND_DATE,REG_CAPITAL,STAFF_NUM,PROVINCE_NAME,CITY_NAME,ORG_PROFILE,ORG_WEB,INDUSTRY_EMC` +
        `&filter=(SECURITY_CODE%3D"${code}")&p=1&ps=1&source=HSF10&client=PC`;
      const resp = await netGet(profUrl, { Referer: 'https://emweb.securities.eastmoney.com/' });
      const json = JSON.parse(resp.body);
      const row  = json?.result?.data?.[0];
      if (row) {
        fill('industry',    row.INDUSTRY_EMC ?? '');
        fill('country',     'China');
        fill('employees',   row.STAFF_NUM    ? parseInt(row.STAFF_NUM)   : null);
        fill('website',     row.ORG_WEB      ?? '');
        fill('description', row.ORG_PROFILE  ?? '');
        fill('foundDate',   row.FOUND_DATE   ?? '');
        fill('regCapital',  row.REG_CAPITAL  ?? '');
        fill('province',    row.PROVINCE_NAME ?? '');
      }
    } catch {}

    // Eastmoney DataCenter — latest financial report (revenue, margins, ROE, EPS)
    try {
      const finUrl = `https://datacenter.eastmoney.com/securities/api/data/get` +
        `?type=RPT_LICO_FN_CPD` +
        `&sty=REPORT_DATE,TOTAL_OPERATE_INCOME,PARENT_NETPROFIT,BASIC_EPS,WEIGHED_ROE,GROSS_PROFIT_RATIO,OPERATE_INCOME_YOY,NETPROFIT_YOY` +
        `&filter=(SECURITY_CODE%3D"${code}")&p=1&ps=1&sr=-1&st=REPORT_DATE&source=HSF10&client=PC`;
      const resp = await netGet(finUrl, { Referer: 'https://emweb.securities.eastmoney.com/' });
      const json = JSON.parse(resp.body);
      const row  = json?.result?.data?.[0];
      if (row) {
        fill('revenue',       row.TOTAL_OPERATE_INCOME ? parseFloat(row.TOTAL_OPERATE_INCOME) : null);
        fill('revenueGrowth', row.OPERATE_INCOME_YOY   ? parseFloat(row.OPERATE_INCOME_YOY) / 100 : null);
        fill('grossMargin',   row.GROSS_PROFIT_RATIO   ? parseFloat(row.GROSS_PROFIT_RATIO) / 100  : null);
        fill('profitMargin',  (row.TOTAL_OPERATE_INCOME && row.PARENT_NETPROFIT)
          ? parseFloat(row.PARENT_NETPROFIT) / parseFloat(row.TOTAL_OPERATE_INCOME) : null);
        fill('roe',  row.WEIGHED_ROE ? parseFloat(row.WEIGHED_ROE) / 100 : null);
        fill('eps',  row.BASIC_EPS   ? parseFloat(row.BASIC_EPS)         : null);
      }
    } catch {}

    return Object.keys(data).length ? data : { error: 'No company data available' };
  }

  // ── US / other stocks: Yahoo quoteSummary + v7 quote fallback ──
  try {
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}` +
      `?modules=assetProfile,summaryDetail,defaultKeyStatistics,financialData`;
    const resp   = await netGet(url, {
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}/`
    });
    const json   = JSON.parse(resp.body);
    const result = json?.quoteSummary?.result?.[0];
    if (result) {
      const ap = result.assetProfile         ?? {};
      const sd = result.summaryDetail        ?? {};
      const ks = result.defaultKeyStatistics ?? {};
      const fd = result.financialData        ?? {};
      data = {
        sector:       ap.sector              ?? '',
        industry:     ap.industry            ?? '',
        country:      ap.country             ?? '',
        employees:    ap.fullTimeEmployees   ?? null,
        website:      ap.website             ?? '',
        description:  ap.longBusinessSummary ?? '',
        marketCap:    sd.marketCap?.raw      ?? null,
        trailingPE:   sd.trailingPE?.raw     ?? null,
        forwardPE:    sd.forwardPE?.raw      ?? null,
        dividendYield: sd.dividendYield?.raw ?? null,
        beta:         sd.beta?.raw           ?? null,
        avgVolume:    sd.averageVolume?.raw  ?? null,
        eps:          ks.trailingEps?.raw    ?? null,
        priceToBook:  ks.priceToBook?.raw    ?? null,
        sharesOut:    ks.sharesOutstanding?.raw ?? null,
        revenue:      fd.totalRevenue?.raw   ?? null,
        revenueGrowth: fd.revenueGrowth?.raw ?? null,
        grossMargin:  fd.grossMargins?.raw   ?? null,
        profitMargin: fd.profitMargins?.raw  ?? null,
        roe:          fd.returnOnEquity?.raw ?? null,
        debtToEquity: fd.debtToEquity?.raw  ?? null,
      };
    }
  } catch {}

  // v7 quote gap-fill
  try {
    const url  = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}`;
    const resp = await netGet(url);
    const q    = JSON.parse(resp.body)?.quoteResponse?.result?.[0];
    if (q) {
      fill('sector',        q.sector);
      fill('industry',      q.industry);
      fill('marketCap',     q.marketCap);
      fill('trailingPE',    q.trailingPE);
      fill('forwardPE',     q.forwardPE);
      fill('dividendYield', q.dividendYield);
      fill('beta',          q.beta);
      fill('eps',           q.epsTrailingTwelveMonths);
      fill('priceToBook',   q.priceToBook);
      fill('sharesOut',     q.sharesOutstanding);
      fill('avgVolume',     q.averageVolume);
    }
  } catch {}

  return Object.keys(data).length ? data : { error: 'No company data available' };
});

function createWindow() {
  mainWindow = new BrowserWindow({
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
  mainWindow.loadFile('index.html');
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── Application menu ────────────────────────────────────────
function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [{ role: 'quit' }]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Keyboard Shortcuts',
          accelerator: 'F1',
          click: () => mainWindow?.webContents.send('show-help')
        }
      ]
    }
  ];

  if (process.platform === 'darwin') {
    template.unshift({
      label: app.name,
      submenu: [
        { role: 'about' }, { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' }, { role: 'quit' }
      ]
    });
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── Watchlist persistence ───────────────────────────────────
function watchlistPath() {
  return path.join(app.getPath('userData'), 'watchlist.json');
}

ipcMain.handle('watchlist-load', () => {
  try {
    const p = watchlistPath();
    if (!fs.existsSync(p)) return { tickers: [], dates: [] };
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { return { tickers: [], dates: [] }; }
});

ipcMain.handle('watchlist-save', (_e, data) => {
  try {
    fs.writeFileSync(watchlistPath(), JSON.stringify(data), 'utf8');
    return true;
  } catch { return false; }
});

app.whenReady().then(() => { buildMenu(); createWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
