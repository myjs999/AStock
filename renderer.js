/* global LightweightCharts, stockAPI */

const tickerInput    = document.getElementById('ticker-input');
const dateInput      = document.getElementById('date-input');
const intervalSelect = document.getElementById('interval-select');
const loadBtn        = document.getElementById('load-btn');
const errorMsg       = document.getElementById('error-msg');
const hintMsg        = document.getElementById('hint-msg');
const placeholder    = document.getElementById('placeholder');
const chartEl        = document.getElementById('chart');

const infoStrip    = document.getElementById('info-strip');
const infoText     = document.getElementById('info-text');
const infoDelisted = document.getElementById('info-delisted');

const sbSym   = document.getElementById('sb-sym');
const sbPrice = document.getElementById('sb-price');
const sbPct   = document.getElementById('sb-pct');
const sbExch  = document.getElementById('sb-exch');

tickerInput.value = 'AAPL';

// default date = today as YYYYMMDD
dateInput.value = new Date().toISOString().slice(0, 10).replace(/-/g, '');

// ── Chart setup ────────────────────────────────────────────────
// Timezone is updated dynamically when a stock loads
let chartTZ = 'America/New_York';

function fmtTZ(ts, opts) {
  return new Date(ts * 1000).toLocaleString('en-US', { timeZone: chartTZ, ...opts });
}

function tzTimeFormatters() {
  return {
    localization: {
      timeFormatter: ts => fmtTZ(ts, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
    },
    timeScale: {
      tickMarkFormatter: (ts, type) => {
        if (type >= 3) return fmtTZ(ts, { hour: '2-digit', minute: '2-digit', hour12: false });
        if (type === 2) return fmtTZ(ts, { month: 'short', day: 'numeric' });
        if (type === 1) return fmtTZ(ts, { month: 'short', year: 'numeric' });
        return fmtTZ(ts, { year: 'numeric' });
      }
    }
  };
}

function setChartTZ(tz, label) {
  chartTZ = tz;
  chart.applyOptions(tzTimeFormatters());
  document.querySelector('.utc-note').textContent = label;
}

// Market timezone detection from Yahoo's exchangeName / symbol suffix
const TZ_MAP = [
  { test: s => /\.(SS|SZ)$/i.test(s),  tz: 'Asia/Shanghai',    label: 'Times in CST (Beijing)'   },
  { test: s => /\.HK$/i.test(s),        tz: 'Asia/Hong_Kong',   label: 'Times in HKT (Hong Kong)'  },
  { test: s => /\.L$/i.test(s),         tz: 'Europe/London',    label: 'Times in GMT/BST (London)' },
  { test: s => /\.T$/i.test(s),         tz: 'Asia/Tokyo',       label: 'Times in JST (Tokyo)'      },
];

function applyMarketTZ(symbol) {
  for (const { test, tz, label } of TZ_MAP) {
    if (test(symbol)) { setChartTZ(tz, label); return; }
  }
  setChartTZ('America/New_York', 'Times in ET (New York)');
}

// ── Color scheme (single global scheme) ─────────────────────
const colors = { up: '#26a69a', down: '#ef5350' };

const chart = LightweightCharts.createChart(chartEl, {
  autoSize: true,
  ...tzTimeFormatters(),
  layout: {
    background: { type: 'solid', color: '#131722' },
    textColor: '#d1d4dc'
  },
  grid: {
    vertLines: { color: '#1e222d' },
    horzLines: { color: '#1e222d' }
  },
  crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
  rightPriceScale: { borderColor: '#2a2e39' },
  timeScale: {
    borderColor: '#2a2e39',
    timeVisible: true,
    secondsVisible: false,
    fixLeftEdge: true,
    fixRightEdge: true,
    ...tzTimeFormatters().timeScale
  },
  handleScroll: true,
  handleScale: true
});

const candleSeries = chart.addCandlestickSeries({
  upColor:       '#26a69a',
  downColor:     '#ef5350',
  borderVisible: false,
  wickUpColor:   '#26a69a',
  wickDownColor: '#ef5350'
});

// leave bottom 22% of the chart for volume
chart.priceScale('right').applyOptions({
  scaleMargins: { top: 0.08, bottom: 0.22 }
});

const volumeSeries = chart.addHistogramSeries({
  priceFormat:  { type: 'volume' },
  priceScaleId: 'vol'
});

chart.priceScale('vol').applyOptions({
  scaleMargins: { top: 0.82, bottom: 0 },
  visible: false
});

// Cumulative volume line — sits in the same bottom strip as the volume bars
const cumVolLine = chart.addLineSeries({
  priceScaleId: 'cum-vol',
  color: '#f0b429',
  lineWidth: 1,
  priceLineVisible: false,
  lastValueVisible: false,
  crosshairMarkerVisible: false,
});
chart.priceScale('cum-vol').applyOptions({
  scaleMargins: { top: 0.82, bottom: 0 },
  visible: false,
});

function buildCumVolData(candles) {
  cumVolMap.clear();
  cumValMap.clear();
  let cumVol = 0, cumVal = 0;
  return candles.map(c => {
    cumVol += c.volume;
    cumVal += c.close * c.volume;
    cumVolMap.set(c.time, cumVol);
    cumValMap.set(c.time, cumVal);
    return { time: c.time, value: cumVol };
  });
}

// own maps — avoids relying on param.seriesData which is unreliable across lw-charts v4 builds
const candleMap  = new Map();
const volMap     = new Map();
const cumVolMap  = new Map();
const cumValMap  = new Map();

// ── Price lines (open / CN limits) ───────────────────────────
let priceLines = [];   // active price line handles

function clearPriceLines() {
  priceLines.forEach(pl => { try { candleSeries.removePriceLine(pl); } catch {} });
  priceLines = [];
}

function addPriceLine(price, color, title, style = LightweightCharts.LineStyle.Dashed) {
  const pl = candleSeries.createPriceLine({ price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, axisLabelColor: '#131722', title });
  priceLines.push(pl);
}

// CN limit rules:
//   STAR Market (688xxx.SS) and ChiNext (300xxx / 301xxx.SZ) → ±20%
//   All other A-shares → ±10%
function cnLimitPct(symbol) {
  const up   = symbol.toUpperCase();
  const code = up.split('.')[0];
  if (up.endsWith('.SS') && code.startsWith('688')) return 0.20;  // STAR Market
  if (up.endsWith('.SZ') && (code.startsWith('300') || code.startsWith('301'))) return 0.20;  // ChiNext
  if (up.endsWith('.SS') || up.endsWith('.SZ')) return 0.10;      // regular A-share
  return null;  // not CN
}

function pctLabel(price, base) {
  if (!base) return '';
  const p = ((price - base) / base * 100);
  return (p >= 0 ? '+' : '') + p.toFixed(2) + '%';
}

function applyPriceLines(result) {
  clearPriceLines();
  if (currentMode === 'daily') return;  // no price lines on daily chart

  const prev = result.prevClose;
  const open = result.candles?.[0]?.open;
  if (!open) return;

  // Opening price line — show % vs prev close
  const openPct = prev ? pctLabel(open, prev) : '0%';
  addPriceLine(open, '#ffffff', `Open  ${openPct}`, LightweightCharts.LineStyle.Dashed);

  // CN limit-up / limit-down lines
  if (prev) {
    const limitPct = cnLimitPct(result.symbol);
    if (limitPct !== null) {
      const up   = parseFloat((prev * (1 + limitPct)).toFixed(2));
      const down = parseFloat((prev * (1 - limitPct)).toFixed(2));
      addPriceLine(up,   colors.up,   `+${limitPct * 100}%`, LightweightCharts.LineStyle.Solid);
      addPriceLine(down, colors.down, `-${limitPct * 100}%`, LightweightCharts.LineStyle.Solid);
    }
  }
}

// track last hovered candle time (used by double-click drill-down)
let lastHoveredTime = null;
let lastPrevClose   = null;   // set on each load; used for crosshair % calculation

// crosshair tooltip in status bar
chart.subscribeCrosshairMove(param => {
  if (!param.time) return;
  lastHoveredTime = param.time;
  const c = candleMap.get(param.time);
  if (!c) return;
  const v    = volMap.get(param.time);
  const cumV = cumVolMap.get(param.time);
  const cumA = cumValMap.get(param.time);
  const barVal = (v != null) ? c.close * v : null;
  const ohlc   = `O ${fmt(c.open)}  H ${fmt(c.high)}  L ${fmt(c.low)}  C ${fmt(c.close)}`;
  const barStr = v    != null ? `  │  V ${fmtVol(v)}  Val ${fmtVol(barVal)}` : '';
  const cumStr = cumV != null ? `  │  ΣV ${fmtVol(cumV)}  ΣVal ${fmtVol(cumA)}` : '';
  sbPrice.textContent = ohlc + barStr + cumStr;
  if (lastPrevClose) {
    const diff = c.close - lastPrevClose;
    const pct  = (diff / lastPrevClose * 100).toFixed(2);
    const sign = diff >= 0 ? '+' : '';
    sbPct.textContent = `${sign}${pct}%`;
    sbPct.style.color = diff >= 0 ? colors.up : colors.down;
    sbPct.classList.remove('hidden');
  }
});

// Pick the finest Yahoo-supported interval for a given date
function bestInterval(dateStr) {
  const date = new Date(`${dateStr.slice(0,4)}-${dateStr.slice(4,6)}-${dateStr.slice(6,8)}T12:00:00Z`);
  const days = (Date.now() - date.getTime()) / 86400000;
  if (days <=   7) return '1m';
  if (days <=  60) return '2m';
  if (days <= 730) return '60m';
  return '1d';
}

// Right-click on chart → toggle Intraday / Daily (same as Tab)
chartEl.addEventListener('contextmenu', e => {
  e.preventDefault();
  setMode(currentMode === 'intraday' ? 'daily' : 'intraday');
  load();
});

// Double-click on daily chart → drill into intraday for that date
chartEl.addEventListener('dblclick', () => {
  if (currentMode !== 'daily' || !lastHoveredTime) return;
  const d       = new Date(lastHoveredTime * 1000);
  const dateStr = d.toISOString().slice(0, 10).replace(/-/g, '');
  dateInput.value      = dateStr;
  intervalSelect.value = bestInterval(dateStr);
  setMode('intraday');
  load();
});

// ── Mode state ───────────────────────────────────────────────
let currentMode   = 'intraday';
let currentPeriod = '6M';

function setMode(mode) {
  currentMode = mode;
  document.getElementById('mode-intraday').classList.toggle('active', mode === 'intraday');
  document.getElementById('mode-daily').classList.toggle('active',    mode === 'daily');
  const isDaily = mode === 'daily';
  intervalSelect.classList.toggle('hidden',  isDaily);
  document.getElementById('period-btns').classList.toggle('hidden', !isDaily);
  document.getElementById('prev-date').classList.toggle('hidden',   isDaily);
  document.getElementById('next-date').classList.toggle('hidden',   isDaily);
  dateInput.classList.toggle('hidden', isDaily);
}

function computeStartDate(endDateStr, period) {
  const y = parseInt(endDateStr.slice(0, 4), 10);
  const m = parseInt(endDateStr.slice(4, 6), 10) - 1;
  const d = parseInt(endDateStr.slice(6, 8), 10);
  const dt = new Date(y, m, d);
  switch (period) {
    case '1W': dt.setDate(dt.getDate() - 7);          break;
    case '3M': dt.setMonth(dt.getMonth() - 3);        break;
    case '6M': dt.setMonth(dt.getMonth() - 6);        break;
    case '1Y': dt.setFullYear(dt.getFullYear() - 1);  break;
    case '3Y': dt.setFullYear(dt.getFullYear() - 3);  break;
    case '5Y': dt.setFullYear(dt.getFullYear() - 5);  break;
    default:   dt.setMonth(dt.getMonth() - 3);
  }
  return dt.toISOString().slice(0, 10).replace(/-/g, '');
}

async function loadDaily() {
  const ticker = tickerInput.value.trim();
  if (!ticker) { showError('Enter a ticker symbol.'); return; }

  showError('');
  showHint('');
  infoStrip.classList.add('hidden');
  stopChartRefresh();
  loadBtn.disabled = true;
  loadBtn.textContent = 'Loading…';
  placeholder.classList.add('hidden');

  const endDate   = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const startDate = computeStartDate(endDate, currentPeriod);

  const [result, info] = await Promise.all([
    stockAPI.fetchStockRange(ticker, startDate, endDate),
    stockAPI.fetchStockInfo(ticker)
  ]);

  loadBtn.disabled = false;
  loadBtn.textContent = 'Load';

  if (!info.error) {
    const parts = [info.name ? `${info.name} (${info.symbol})` : info.symbol];
    if (info.exchange) parts.push(info.exchange);
    if (info.isDelisted) {
      infoDelisted.textContent   = 'DELISTED';
      infoDelisted.style.display = '';
    } else {
      infoDelisted.style.display = 'none';
    }
    infoText.textContent = parts.join('  ·  ');
    infoStrip.classList.remove('hidden');
  } else if (!result.error && result.longName) {
    infoText.textContent       = `${result.longName}  ·  ${result.symbol}`;
    infoDelisted.style.display = 'none';
    infoStrip.classList.remove('hidden');
  }

  if (result.error) {
    candleSeries.setData([]);
    volumeSeries.setData([]);
    cumVolLine.setData([]);
    candleMap.clear();
    volMap.clear();
    sbPct.classList.add('hidden');
    stopObPoll();
    obActiveTicker = null;
    obPanel.classList.add('hidden');
    document.getElementById('si-wrap').classList.add('hidden');
    showError(result.error);
    placeholder.classList.remove('hidden');
    return;
  }

  applyMarketTZ(result.symbol);

  candleMap.clear();
  volMap.clear();
  result.candles.forEach(c => { candleMap.set(c.time, c); volMap.set(c.time, c.volume); });
  chart.timeScale().resetTimeScale();
  candleSeries.setData(result.candles);
  volumeSeries.setData(result.candles.map(c => ({
    time:  c.time,
    value: c.volume,
    color: c.close >= c.open ? colors.up + '88' : colors.down + '88'
  })));
  cumVolLine.setData(buildCumVolData(result.candles));
  chart.timeScale().fitContent();
  applyPriceLines(result);

  const last  = result.candles.at(-1).close;
  const first = result.candles[0].open;
  const prev  = result.prevClose ?? first;
  lastPrevClose = prev;
  const diff  = last - prev;
  const pct   = ((diff / prev) * 100).toFixed(2);
  const sign  = diff >= 0 ? '+' : '';

  sbSym.textContent   = result.symbol;
  sbPrice.textContent = fmt(last);
  sbPct.classList.add('hidden');   // reset; crosshair will show it on hover
  sbExch.textContent  = result.exchangeName + ' · ' + result.currency;
  [sbSym, sbPrice, sbExch].forEach(el => el.classList.remove('hidden'));

  updateStatsPanel(result, 'daily');
  updatePrediction(ticker);
  updateNews(ticker);
  updateCompany(ticker);
}

// Mode toggle buttons
document.getElementById('mode-intraday').addEventListener('click', () => setMode('intraday'));
document.getElementById('mode-daily').addEventListener('click',    () => setMode('daily'));

// Period buttons
document.querySelectorAll('.period-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    currentPeriod = btn.dataset.period;
    document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    if (currentMode === 'daily') loadDaily();
  });
});

// ── Load action ────────────────────────────────────────────────
async function load() {
  if (currentMode === 'daily') { loadDaily(); return; }
  const ticker = tickerInput.value.trim();
  const date   = dateInput.value.trim().replace(/-/g, '');  // YYYYMMDD

  if (!ticker) { showError('Enter a ticker symbol.'); return; }
  if (date.length !== 8 || isNaN(Number(date))) { showError('Invalid date.'); return; }

  showError('');
  showHint('');
  infoStrip.classList.add('hidden');
  stopChartRefresh();
  loadBtn.disabled = true;
  loadBtn.textContent = 'Loading…';
  placeholder.classList.add('hidden');

  const interval = intervalSelect.value;
  const [result, info] = await Promise.all([
    stockAPI.fetchStock(ticker, date, interval),
    stockAPI.fetchStockInfo(ticker)
  ]);

  loadBtn.disabled = false;
  loadBtn.textContent = 'Load';

  // show listing/delisting info
  // stockanalysis covers US stocks; for CN/others fall back to Yahoo's longName
  if (!info.error) {
    const parts = [info.name ? `${info.name} (${info.symbol})` : info.symbol];
    if (info.exchange)   parts.push(info.exchange);
    if (info.listedDate) parts.push(`Listed: ${info.listedDate}`);
    if (info.isDelisted) {
      const reason = info.delistReason ? ` — ${info.delistReason}` : '';
      parts.push(`Delisted: ${info.delistDate}${reason}`);
      infoDelisted.textContent   = 'DELISTED';
      infoDelisted.style.display = '';
    } else {
      infoDelisted.style.display = 'none';
    }
    infoText.textContent = parts.join('  ·  ');
    infoStrip.classList.remove('hidden');
  } else if (!result.error && result.longName) {
    // Yahoo chart meta has the name (works for CN, HK, etc.)
    infoText.textContent       = `${result.longName}  ·  ${result.symbol}`;
    infoDelisted.style.display = 'none';
    infoStrip.classList.remove('hidden');
  }

  if (result.error) {
    candleSeries.setData([]);
    volumeSeries.setData([]);
    cumVolLine.setData([]);
    candleMap.clear();
    volMap.clear();
    sbPct.classList.add('hidden');
    stopObPoll();
    obActiveTicker = null;
    obPanel.classList.add('hidden');
    document.getElementById('si-wrap').classList.add('hidden');
    showError(result.error);
    placeholder.classList.remove('hidden');
    return;
  }

  // show hints for any automatic adjustments
  const hints = [];
  const fmt8 = d => `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`;  // for hint display only
  if (result.adjustedDate) {
    dateInput.value = result.adjustedDate;  // keep as YYYYMMDD
    hints.push(`No trading data on ${fmt8(result.originalDate)} — showing nearest trading day (${fmt8(result.adjustedDate)})`);
  }
  if (result.adjustedInterval) {
    intervalSelect.value = result.adjustedInterval;
    const reason = result.adjustedInterval === '1d' && interval !== '1d'
      ? `intraday unavailable for delisted symbol — showing daily bar`
      : `"${interval}" unavailable for this date — switched to ${result.adjustedInterval}`;
    hints.push(reason);
  }
  showHint(hints.join('  ·  '));

  // update chart timezone to match the market
  applyMarketTZ(result.symbol);

  // render candles + volume
  candleMap.clear();
  volMap.clear();
  result.candles.forEach(c => { candleMap.set(c.time, c); volMap.set(c.time, c.volume); });
  chart.timeScale().resetTimeScale();
  candleSeries.setData(result.candles);
  volumeSeries.setData(result.candles.map(c => ({
    time:  c.time,
    value: c.volume,
    color: c.close >= c.open ? colors.up + '88' : colors.down + '88'
  })));
  cumVolLine.setData(buildCumVolData(result.candles));
  chart.timeScale().fitContent();
  applyPriceLines(result);

  // status bar + stats panel
  const last  = result.candles.at(-1).close;
  const first = result.candles[0].open;
  const prev  = result.prevClose ?? first;
  lastPrevClose = prev;
  const diff  = last - prev;
  const pct   = ((diff / prev) * 100).toFixed(2);
  const sign  = diff >= 0 ? '+' : '';

  sbSym.textContent   = result.symbol;
  sbPrice.textContent = fmt(last);
  sbPct.classList.add('hidden');   // reset; crosshair will show it on hover
  sbExch.textContent  = result.exchangeName + ' · ' + result.currency;

  [sbSym, sbPrice, sbExch].forEach(el => el.classList.remove('hidden'));

  updateStatsPanel(result, 'intraday');
  updatePrediction(ticker);
  updateNews(ticker);
  updateCompany(ticker);
  startChartRefresh(ticker);
}

function updateStatsPanel(result, mode) {
  // update section label: "DAY" for intraday, "LATEST" for daily
  const dayLabelEl = document.querySelector('#stats-panel .sp-section');
  if (dayLabelEl) dayLabelEl.textContent = mode === 'daily' ? 'LATEST' : 'DAY';

  const cs = result.candles;
  const dayO = cs[0].open;
  const dayH = Math.max(...cs.map(c => c.high));
  const dayL = Math.min(...cs.map(c => c.low));
  const dayC = cs[cs.length - 1].close;
  const dayV = cs.reduce((s, c) => s + c.volume, 0);
  const prev = result.prevClose ?? dayO;
  const diff = dayC - prev;
  const pct  = ((diff / prev) * 100).toFixed(2);
  const sign = diff >= 0 ? '+' : '';

  document.getElementById('sp-name').textContent  = result.longName || result.symbol;
  document.getElementById('sp-exch').textContent  = `${result.fullExchangeName || result.exchangeName}  ·  ${result.currency}`;
  document.getElementById('sp-open').textContent  = fmt(dayO);
  document.getElementById('sp-high').textContent  = fmt(dayH);
  document.getElementById('sp-low').textContent   = fmt(dayL);
  document.getElementById('sp-close').textContent = fmt(dayC);
  document.getElementById('sp-vol').textContent   = fmtVol(dayV);
  document.getElementById('sp-prev').textContent  = fmt(prev);

  const chgEl = document.getElementById('sp-chg');
  chgEl.textContent = `${sign}${fmt(diff)}  (${sign}${pct}%)`;
  chgEl.style.color = diff >= 0 ? colors.up : colors.down;

  const h52 = document.getElementById('sp-52h');
  const l52 = document.getElementById('sp-52l');
  h52.textContent = result.fiftyTwoWeekHigh != null ? fmt(result.fiftyTwoWeekHigh) : '—';
  l52.textContent = result.fiftyTwoWeekLow  != null ? fmt(result.fiftyTwoWeekLow)  : '—';

  document.getElementById('sp-source').textContent = result.source || '—';
  document.getElementById('si-wrap').classList.remove('hidden');
}

// ── Prediction helpers ────────────────────────────────────────
function linearRegression(values) {
  const n    = values.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX  += i;  sumY  += values[i];
    sumXY += i * values[i];  sumX2 += i * i;
  }
  const slope     = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept, predict: xi => intercept + slope * xi };
}

function computeRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period;  avgLoss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0))  / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
  }
  return avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
}

async function updatePrediction(ticker) {
  const priceEl = document.getElementById('sp-pred-price');
  const chgEl   = document.getElementById('sp-pred-chg');
  const trendEl = document.getElementById('sp-sig-trend');
  const rsiEl   = document.getElementById('sp-sig-rsi');
  const maEl    = document.getElementById('sp-sig-ma');
  const noteEl  = document.getElementById('sp-pred-note');

  priceEl.textContent = '…';
  chgEl.textContent   = '';
  trendEl.textContent = '…';  trendEl.style.color = '';
  rsiEl.textContent   = '…';  rsiEl.style.color   = '';
  maEl.textContent    = '…';  maEl.style.color    = '';
  noteEl.textContent  = '';

  const endDate   = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const startDate = computeStartDate(endDate, '6M');
  const result    = await stockAPI.fetchStockRange(ticker, startDate, endDate);

  if (result.error || !result.candles || result.candles.length < 15) {
    priceEl.textContent = '—';
    chgEl.textContent   = '';
    [trendEl, rsiEl, maEl].forEach(el => { el.textContent = '—'; el.style.color = ''; });
    return;
  }

  const closes = result.candles.map(c => c.close);
  const last   = closes[closes.length - 1];
  const n      = closes.length;

  // Linear regression on last 30 closes
  const window30 = closes.slice(-30);
  const lr       = linearRegression(window30);
  const pred     = lr.predict(window30.length);   // extrapolate one step forward
  const diff     = pred - last;
  const pct      = ((diff / last) * 100).toFixed(2);
  const sign     = diff >= 0 ? '+' : '';

  priceEl.textContent = fmt(pred);
  chgEl.textContent   = `${sign}${fmt(diff)} (${sign}${pct}%)`;
  chgEl.style.color   = diff >= 0 ? colors.up : colors.down;

  // Trend: slope normalised as %/day
  const slopePct = (lr.slope / last) * 100;
  if      (slopePct >  0.1) { trendEl.textContent = '↑ Bull';    trendEl.style.color = colors.up;   }
  else if (slopePct < -0.1) { trendEl.textContent = '↓ Bear';    trendEl.style.color = colors.down; }
  else                      { trendEl.textContent = '→ Neutral'; trendEl.style.color = '#787b86';   }

  // RSI(14)
  const rsi = computeRSI(closes);
  if (rsi !== null) {
    rsiEl.textContent = rsi.toFixed(1);
    rsiEl.style.color = rsi > 70 ? colors.down : rsi < 30 ? colors.up : '#787b86';
  } else {
    rsiEl.textContent = '—';
  }

  // MA20 vs last close
  const ma20 = closes.slice(-20).reduce((s, v) => s + v, 0) / Math.min(20, n);
  if (last > ma20) { maEl.textContent = '↑ Above'; maEl.style.color = colors.up;   }
  else             { maEl.textContent = '↓ Below'; maEl.style.color = colors.down; }

  noteEl.textContent = `Linear reg. · ${window30.length}d`;
}

// ── Silent chart refresh ─────────────────────────────────────
let chartRefreshTimer = null;

function stopChartRefresh() {
  if (chartRefreshTimer) { clearInterval(chartRefreshTimer); chartRefreshTimer = null; }
  stopObPoll();
}

function applyCandles(result, mode) {
  // Update chart data in place — no time scale reset, preserves user's zoom/scroll
  candleMap.clear();
  volMap.clear();
  result.candles.forEach(c => { candleMap.set(c.time, c); volMap.set(c.time, c.volume); });
  candleSeries.setData(result.candles);
  volumeSeries.setData(result.candles.map(c => ({
    time:  c.time,
    value: c.volume,
    color: c.close >= c.open ? colors.up + '88' : colors.down + '88'
  })));
  cumVolLine.setData(buildCumVolData(result.candles));
  applyPriceLines(result);
  const last = result.candles.at(-1).close;
  const prev = result.prevClose ?? result.candles[0].open;
  lastPrevClose = prev;
  sbSym.textContent   = result.symbol;
  sbPrice.textContent = fmt(last);
  sbExch.textContent  = result.exchangeName + ' · ' + result.currency;
  updateStatsPanel(result, mode);
}

async function silentRefreshIntraday() {
  const ticker   = tickerInput.value.trim();
  const date     = dateInput.value.trim().replace(/-/g, '');
  const interval = intervalSelect.value;
  if (!ticker || date.length !== 8) return;
  const result = await stockAPI.fetchStock(ticker, date, interval);
  if (result.error || !result.candles || result.candles.length === 0) return;
  applyCandles(result, 'intraday');
}

async function silentRefreshDaily() {
  const ticker = tickerInput.value.trim();
  if (!ticker) return;
  const endDate   = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const startDate = computeStartDate(endDate, currentPeriod);
  const result    = await stockAPI.fetchStockRange(ticker, startDate, endDate);
  if (result.error || !result.candles || result.candles.length === 0) return;
  applyCandles(result, 'daily');
}

function startChartRefresh(ticker) {
  stopChartRefresh();
  obActiveTicker = ticker;
  const refreshChart = currentMode === 'daily' ? silentRefreshDaily : silentRefreshIntraday;
  const tick = () => {
    refreshChart();
    if (ticker) {
      window.orderbookAPI.fetch(ticker).then(data => {
        if (obActiveTicker === ticker) renderOrderBook(data);
      });
    }
  };
  tick();
  chartRefreshTimer = setInterval(tick, 3000);
}

function fmt(n) { return n == null ? '—' : n.toFixed(2); }
function fmtVol(n) {
  if (n == null) return '—';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toString();
}
function showError(msg) { errorMsg.textContent = msg; }
function showHint(msg)  { hintMsg.textContent  = msg; }

// ── Stats / Info tab switching ───────────────────────────────
const siTabStats   = document.getElementById('tab-stats');
const siTabInfo    = document.getElementById('tab-info');
const statsPanel   = document.getElementById('stats-panel');
const companyPanel = document.getElementById('company-panel');

function activateSiTab(tab) {
  const isStats = tab === 'stats';
  siTabStats.classList.toggle('active', isStats);
  siTabInfo.classList.toggle('active', !isStats);
  statsPanel.classList.toggle('hidden', !isStats);
  companyPanel.classList.toggle('hidden', isStats);
}

siTabStats.addEventListener('click', () => activateSiTab('stats'));
siTabInfo.addEventListener('click',  () => activateSiTab('info'));

// ── Company panel ─────────────────────────────────────────────
function fmtBig(n) {
  if (n == null) return '—';
  if (n >= 1e12) return (n / 1e12).toFixed(2) + 'T';
  if (n >= 1e9)  return (n / 1e9).toFixed(2)  + 'B';
  if (n >= 1e6)  return (n / 1e6).toFixed(2)  + 'M';
  if (n >= 1e3)  return (n / 1e3).toFixed(1)  + 'K';
  return n.toFixed(0);
}
function fmtPct(n) { return n == null ? '—' : (n * 100).toFixed(1) + '%'; }
function fmtX(n)   { return n == null ? '—' : n.toFixed(1) + 'x'; }

async function updateCompany(ticker) {
  // Reset fields to loading state
  const ids = ['cp-sector','cp-industry','cp-country','cp-province','cp-employees','cp-founded','cp-website',
                'cp-mktcap','cp-pe','cp-fwdpe','cp-eps','cp-pb','cp-beta',
                'cp-revenue','cp-revgrowth','cp-grossm','cp-netm','cp-roe','cp-de','cp-divy'];
  ids.forEach(id => { const el = document.getElementById(id); if (el) el.textContent = '…'; });
  document.getElementById('cp-desc').textContent = '';

  const d = await window.companyAPI.fetch(ticker);
  if (d.error) {
    ids.forEach(id => { const el = document.getElementById(id); if (el) el.textContent = '—'; });
    return;
  }

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val ?? '—'; };

  set('cp-sector',    d.sector);
  set('cp-industry',  d.industry);
  set('cp-country',   d.country);
  set('cp-province',  d.province);
  set('cp-employees', d.employees != null ? d.employees.toLocaleString() : null);
  set('cp-founded',   d.foundDate ? d.foundDate.slice(0, 10) : null);
  set('cp-mktcap',    fmtBig(d.marketCap));
  set('cp-pe',        d.trailingPE != null ? d.trailingPE.toFixed(1) : null);
  set('cp-fwdpe',     d.forwardPE  != null ? d.forwardPE.toFixed(1)  : null);
  set('cp-eps',       d.eps        != null ? fmt(d.eps)               : null);
  set('cp-pb',        d.priceToBook != null ? d.priceToBook.toFixed(1) : null);
  set('cp-beta',      d.beta       != null ? d.beta.toFixed(2)        : null);
  set('cp-revenue',   fmtBig(d.revenue));
  set('cp-revgrowth', d.revenueGrowth != null ? fmtPct(d.revenueGrowth) : null);
  set('cp-grossm',    d.grossMargin   != null ? fmtPct(d.grossMargin)   : null);
  set('cp-netm',      d.profitMargin  != null ? fmtPct(d.profitMargin)  : null);
  set('cp-roe',       d.roe           != null ? fmtPct(d.roe)           : null);
  set('cp-de',        d.debtToEquity  != null ? d.debtToEquity.toFixed(1) : null);
  set('cp-divy',      d.dividendYield != null ? fmtPct(d.dividendYield) : null);

  // Website — clickable
  const webEl = document.getElementById('cp-website');
  if (d.website) {
    webEl.textContent = d.website.replace(/^https?:\/\//, '').replace(/\/$/, '');
    webEl.onclick = () => window.newsAPI.openUrl(d.website);
  } else {
    webEl.textContent = '—';
    webEl.onclick = null;
  }

  // Description — truncate to ~300 chars
  const descEl = document.getElementById('cp-desc');
  if (d.description) {
    descEl.textContent = d.description.length > 300
      ? d.description.slice(0, 300) + '…'
      : d.description;
    descEl.title = d.description;
  }
}

// ── News panel ───────────────────────────────────────────────
const newsPanel = document.getElementById('news-panel');
const newsList  = document.getElementById('news-list');
const newsAge   = document.getElementById('news-age');

function timeAgo(ts) {
  const s = Math.floor(Date.now() / 1000) - ts;
  if (s <    60) return `${s}s ago`;
  if (s <  3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

async function updateNews(ticker) {
  newsPanel.classList.remove('hidden');
  newsList.innerHTML = '';
  newsAge.textContent = 'loading…';

  const data = await window.newsAPI.fetch(ticker);
  if (data.error || !data.items?.length) {
    newsAge.textContent = 'no headlines';
    return;
  }

  const newest = data.items[0].time;
  newsAge.textContent = newest ? `· updated ${timeAgo(newest)}` : '';

  data.items.forEach(item => {
    const li    = document.createElement('li');
    li.className = 'news-item';
    li.title     = item.title;

    const timeEl = document.createElement('span');
    timeEl.className   = 'news-time';
    timeEl.textContent = item.time ? timeAgo(item.time) : '';

    const pubEl = document.createElement('span');
    pubEl.className   = 'news-pub';
    pubEl.textContent = item.publisher;

    const titleEl = document.createElement('span');
    titleEl.className   = 'news-title';
    titleEl.textContent = item.title;

    li.appendChild(timeEl);
    li.appendChild(pubEl);
    li.appendChild(titleEl);

    if (item.link) {
      li.addEventListener('click', () => window.newsAPI.openUrl(item.link));
    }

    newsList.appendChild(li);
  });
}

loadBtn.addEventListener('click', load);
tickerInput.addEventListener('keydown', e => { if (e.key === 'Enter') load(); });
dateInput.addEventListener('keydown',   e => { if (e.key === 'Enter') load(); });

// ── Order book ──────────────────────────────────────────
const obPanel  = document.getElementById('ob-panel');
const obAsks   = document.getElementById('ob-asks');
const obBids   = document.getElementById('ob-bids');
const obLast   = document.getElementById('ob-last');
const obSpread = document.getElementById('ob-spread');
const obTime   = document.getElementById('ob-time');
const obSrc    = document.getElementById('ob-src');

let obPollTimer   = null;
let obActiveTicker = null;

function fmtObVol(v) {
  return v.toLocaleString();
}

function buildObRows(container, rows, colorClass, labels) {
  container.innerHTML = '';
  const maxVol = Math.max(...rows.map(r => r.vol), 1);
  rows.forEach((r, i) => {
    const div   = document.createElement('div');
    div.className = 'ob-row';

    const bg = document.createElement('div');
    bg.className = 'ob-row-bg';
    const pct = (r.vol / maxVol * 100).toFixed(1);
    bg.style.width = pct + '%';
    bg.style.background = colorClass === 'ask'
      ? 'rgba(239,83,80,0.12)' : 'rgba(38,166,154,0.12)';

    const lbl   = document.createElement('span');
    lbl.className = 'ob-lbl';
    lbl.textContent = labels[i];

    const price = document.createElement('span');
    price.className = 'ob-price';
    price.textContent = r.price.toFixed(2);

    const vol = document.createElement('span');
    vol.className = 'ob-vol';
    vol.textContent = fmtObVol(r.vol);

    div.appendChild(bg);
    div.appendChild(lbl);
    div.appendChild(price);
    div.appendChild(vol);
    container.appendChild(div);
  });
}

function renderOrderBook(data) {
  if (data.error || (!data.bids.length && !data.asks.length)) return;

  // Asks: show highest first (sell5 → sell1)
  const asksSorted = [...data.asks].sort((a, b) => b.price - a.price);
  const askLabels  = asksSorted.map((_, i) => `S${asksSorted.length - i}`);
  buildObRows(obAsks, asksSorted, 'ask', askLabels);

  // Bids: show highest first (buy1 → buy5)
  const bidsSorted = [...data.bids].sort((a, b) => b.price - a.price);
  const bidLabels  = bidsSorted.map((_, i) => `B${i + 1}`);
  buildObRows(obBids, bidsSorted, 'bid', bidLabels);

  obLast.textContent = data.price != null ? data.price.toFixed(2) : '—';

  if (data.asks.length && data.bids.length) {
    const bestAsk = Math.min(...data.asks.map(a => a.price));
    const bestBid = Math.max(...data.bids.map(b => b.price));
    const spread  = (bestAsk - bestBid).toFixed(2);
    obSpread.textContent = `spd ${spread}`;
  } else {
    obSpread.textContent = '';
  }

  const now = new Date();
  obTime.textContent = now.toLocaleTimeString('en-US', { hour12: false });
  obSrc.textContent  = data.source || '';
  obPanel.classList.remove('hidden');
}

function stopObPoll() {
  if (obPollTimer) { clearInterval(obPollTimer); obPollTimer = null; }
}

function startObPoll(ticker) {
  stopObPoll();
  obActiveTicker = ticker;
  const poll = async () => {
    if (!obActiveTicker) return;
    const data = await window.orderbookAPI.fetch(obActiveTicker);
    if (obActiveTicker) renderOrderBook(data);   // guard against stale responses
  };
  poll();                              // immediate first fetch
  obPollTimer = setInterval(poll, 3000);
}

// ── Watchlist ───────────────────────────────────────────
const wlTickerList = document.getElementById('wl-ticker-list');
const wlDateList   = document.getElementById('wl-date-list');
const wlAddTicker  = document.getElementById('wl-add-ticker');
const wlAddDate    = document.getElementById('wl-add-date');

let watchlist = { tickers: [], dates: [] };

async function wlInit() {
  watchlist = await window.watchlistAPI.load();
  wlRender();
}

function wlSave() {
  window.watchlistAPI.save(watchlist);
}

function wlRender() {
  wlRenderList(wlTickerList, watchlist.tickers, 'ticker');
  wlRenderList(wlDateList,   watchlist.dates,   'date');
}

function wlRenderList(ul, items, type) {
  ul.innerHTML = '';
  items.forEach((val, i) => {
    const li     = document.createElement('li');
    li.className = 'wl-item';

    const label = document.createElement('span');
    label.className   = 'wl-label';
    label.textContent = val;
    label.title       = val;
    label.addEventListener('click', () => {
      if (type === 'ticker') tickerInput.value = val;
      else                   dateInput.value   = val;
      load();
    });

    const rm = document.createElement('button');
    rm.className   = 'wl-remove';
    rm.textContent = '×';
    rm.title       = 'Remove';
    rm.addEventListener('click', e => {
      e.stopPropagation();
      (type === 'ticker' ? watchlist.tickers : watchlist.dates).splice(i, 1);
      wlSave();
      wlRender();
    });

    li.appendChild(label);
    li.appendChild(rm);
    ul.appendChild(li);
  });
}

function wlAdd(type) {
  const raw = type === 'ticker'
    ? tickerInput.value.trim().toUpperCase()
    : dateInput.value.trim().replace(/-/g, '');
  if (!raw) return;
  const arr = type === 'ticker' ? watchlist.tickers : watchlist.dates;
  if (!arr.includes(raw)) { arr.push(raw); wlSave(); wlRender(); }
}

wlAddTicker.addEventListener('click', () => wlAdd('ticker'));
wlAddDate.addEventListener('click',   () => wlAdd('date'));

wlInit();

// ── Date navigation ─────────────────────────────────────
function shiftTradingDay(dateStr, dir) {
  const s = dateStr.replace(/-/g, '');
  if (s.length !== 8) return dateStr;
  let d = new Date(`${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}T12:00:00Z`);
  do { d.setUTCDate(d.getUTCDate() + dir); }
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6);  // skip weekends
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

function goToday() {
  dateInput.value = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  load();
}

function navDate(dir) {
  const newDate        = shiftTradingDay(dateInput.value, dir);
  dateInput.value      = newDate;
  intervalSelect.value = bestInterval(newDate);
  load();
}

document.getElementById('prev-date').addEventListener('click', () => navDate(-1));
document.getElementById('next-date').addEventListener('click', () => navDate(+1));

// ── Help modal ──────────────────────────────────────────
const helpModal = document.getElementById('help-modal');

function showHelp() { helpModal.classList.remove('hidden'); }
function hideHelp() { helpModal.classList.add('hidden'); }

document.getElementById('help-btn').addEventListener('click', showHelp);
document.getElementById('help-close').addEventListener('click', hideHelp);
helpModal.addEventListener('click', e => { if (e.target === helpModal) hideHelp(); });

// triggered from main process via Help menu
window.appAPI.onShowHelp(showHelp);

// ── Keyboard shortcuts ───────────────────────────────────
// Tab      → toggle Intraday / Daily mode
// F1       → focus ticker input
// F2       → focus date input  (intraday only)
// F3       → focus interval select  /  cycle period button (daily)
// ← / →    → prev / next trading day  (when not in input)
// T        → jump to today
// R        → reload current chart
// ?        → show help
// Esc      → close help

function cyclePeriod() {
  const periods  = ['1W', '3M', '6M', '1Y', '3Y', '5Y'];
  const idx      = periods.indexOf(currentPeriod);
  const next     = periods[(idx + 1) % periods.length];
  currentPeriod  = next;
  document.querySelectorAll('.period-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.period === next);
  });
  loadDaily();
}

document.addEventListener('keydown', e => {
  const active   = document.activeElement;
  const inInput  = ['INPUT', 'SELECT', 'TEXTAREA'].includes(active?.tagName);
  const helpOpen = !helpModal.classList.contains('hidden');

  // Esc closes help (always)
  if (e.key === 'Escape') { if (helpOpen) { e.preventDefault(); hideHelp(); } return; }

  // Tab toggles Intraday / Daily (always, even when focused in an input)
  if (e.key === 'Tab') {
    e.preventDefault();
    setMode(currentMode === 'intraday' ? 'daily' : 'intraday');
    load();
    return;
  }

  // F1 / F2 / F3 work regardless of focus (but not when help is open)
  if (!helpOpen) {
    if (e.key === 'F1') {
      e.preventDefault();
      tickerInput.focus();
      tickerInput.select();
      return;
    }
    if (e.key === 'F2') {
      e.preventDefault();
      if (currentMode === 'intraday') { dateInput.focus(); dateInput.select(); }
      return;
    }
    if (e.key === 'F3') {
      e.preventDefault();
      if (currentMode === 'intraday') intervalSelect.focus();
      else                            cyclePeriod();
      return;
    }
  }

  if (helpOpen || inInput) return;

  if      (e.key === 'ArrowLeft')          { e.preventDefault(); navDate(-1); }
  else if (e.key === 'ArrowRight')         { e.preventDefault(); navDate(+1); }
  else if (e.key === 't' || e.key === 'T') goToday();
  else if (e.key === 'r' || e.key === 'R') load();
  else if (e.key === '?')                  { e.preventDefault(); showHelp(); }
});
