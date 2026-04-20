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
const sbChg   = document.getElementById('sb-chg');
const sbExch  = document.getElementById('sb-exch');

tickerInput.value = 'AAPL';

// default date = today as YYYYMMDD
dateInput.value = new Date().toISOString().slice(0, 10).replace(/-/g, '');

// ── Chart setup ────────────────────────────────────────────────
function fmtET(ts, opts) {
  return new Date(ts * 1000).toLocaleString('en-US', { timeZone: 'America/New_York', ...opts });
}

const chart = LightweightCharts.createChart(chartEl, {
  autoSize: true,
  localization: {
    // crosshair time tooltip
    timeFormatter: ts => fmtET(ts, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
  },
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
    // axis tick labels — TickMarkType: 0=Year 1=Month 2=Day 3=Time 4=TimeWithSecs
    tickMarkFormatter: (ts, type) => {
      if (type >= 3) return fmtET(ts, { hour: '2-digit', minute: '2-digit', hour12: false });
      if (type === 2) return fmtET(ts, { month: 'short', day: 'numeric' });
      if (type === 1) return fmtET(ts, { month: 'short', year: 'numeric' });
      return fmtET(ts, { year: 'numeric' });
    }
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

// own maps — avoids relying on param.seriesData which is unreliable across lw-charts v4 builds
const candleMap = new Map();
const volMap    = new Map();

// crosshair tooltip in status bar
chart.subscribeCrosshairMove(param => {
  if (!param.time) return;
  const c = candleMap.get(param.time);
  if (!c) return;
  const v      = volMap.get(param.time);
  const volStr = v != null ? `  V ${fmtVol(v)}` : '';
  sbPrice.textContent = `O ${fmt(c.open)}  H ${fmt(c.high)}  L ${fmt(c.low)}  C ${fmt(c.close)}${volStr}`;
});

// ── Load action ────────────────────────────────────────────────
async function load() {
  const ticker = tickerInput.value.trim();
  const date   = dateInput.value.trim().replace(/-/g, '');  // YYYYMMDD

  if (!ticker) { showError('Enter a ticker symbol.'); return; }
  if (date.length !== 8 || isNaN(Number(date))) { showError('Invalid date.'); return; }

  showError('');
  showHint('');
  infoStrip.classList.add('hidden');
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

  // show listing/delisting info regardless of chart success
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
  }

  if (result.error) {
    candleSeries.setData([]);
    volumeSeries.setData([]);
    candleMap.clear();
    volMap.clear();
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

  // render candles + volume
  candleMap.clear();
  volMap.clear();
  result.candles.forEach(c => { candleMap.set(c.time, c); volMap.set(c.time, c.volume); });
  candleSeries.setData(result.candles);
  volumeSeries.setData(result.candles.map(c => ({
    time:  c.time,
    value: c.volume,
    color: c.close >= c.open ? '#26a69a55' : '#ef535055'
  })));
  chart.timeScale().fitContent();

  // status bar
  const last  = result.candles.at(-1).close;
  const first = result.candles[0].open;
  const prev  = result.prevClose ?? first;
  const diff  = last - prev;
  const pct   = ((diff / prev) * 100).toFixed(2);
  const sign  = diff >= 0 ? '+' : '';

  sbSym.textContent   = result.symbol;
  sbPrice.textContent = fmt(last);
  sbChg.textContent   = `${sign}${fmt(diff)} (${sign}${pct}%)`;
  sbChg.className     = `chg ${diff >= 0 ? 'up' : 'down'}`;
  sbExch.textContent  = result.exchangeName + ' · ' + result.currency;

  [sbSym, sbPrice, sbChg, sbExch].forEach(el => el.classList.remove('hidden'));
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

loadBtn.addEventListener('click', load);
tickerInput.addEventListener('keydown', e => { if (e.key === 'Enter') load(); });
dateInput.addEventListener('keydown',   e => { if (e.key === 'Enter') load(); });

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

// Tab anywhere → jump to ticker input
document.addEventListener('keydown', e => {
  if (e.key === 'Tab') {
    e.preventDefault();
    tickerInput.focus();
    tickerInput.select();
  }
});
