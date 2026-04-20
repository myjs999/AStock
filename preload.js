const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('stockAPI', {
  fetchStock:     (ticker, date, interval) => ipcRenderer.invoke('fetch-stock',      { ticker, date, interval }),
  fetchStockInfo: (ticker)               => ipcRenderer.invoke('fetch-stock-info', { ticker })
});

contextBridge.exposeInMainWorld('watchlistAPI', {
  load: ()     => ipcRenderer.invoke('watchlist-load'),
  save: (data) => ipcRenderer.invoke('watchlist-save', data)
});
