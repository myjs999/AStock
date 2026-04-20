const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('stockAPI', {
  fetchStock:     (ticker, date, interval) => ipcRenderer.invoke('fetch-stock',      { ticker, date, interval }),
  fetchStockInfo: (ticker)               => ipcRenderer.invoke('fetch-stock-info', { ticker })
});
