const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('stockAPI', {
  fetchStock:      (ticker, date, interval)         => ipcRenderer.invoke('fetch-stock',       { ticker, date, interval }),
  fetchStockInfo:  (ticker)                         => ipcRenderer.invoke('fetch-stock-info',  { ticker }),
  fetchStockRange: (ticker, startDate, endDate)     => ipcRenderer.invoke('fetch-stock-range', { ticker, startDate, endDate }),
});

contextBridge.exposeInMainWorld('watchlistAPI', {
  load: ()     => ipcRenderer.invoke('watchlist-load'),
  save: (data) => ipcRenderer.invoke('watchlist-save', data)
});

contextBridge.exposeInMainWorld('appAPI', {
  onShowHelp: (cb) => ipcRenderer.on('show-help', cb)
});

contextBridge.exposeInMainWorld('orderbookAPI', {
  fetch: (ticker) => ipcRenderer.invoke('fetch-orderbook', { ticker })
});

contextBridge.exposeInMainWorld('newsAPI', {
  fetch:   (ticker) => ipcRenderer.invoke('fetch-news', { ticker }),
  openUrl: (url)    => ipcRenderer.invoke('open-url', url)
});

contextBridge.exposeInMainWorld('companyAPI', {
  fetch: (ticker) => ipcRenderer.invoke('fetch-company', { ticker })
});
