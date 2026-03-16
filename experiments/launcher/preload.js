const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('site89Launcher', {
  getMeta: () => ipcRenderer.invoke('launcher:get-meta'),
  install: () => ipcRenderer.invoke('launcher:install'),
  play: () => ipcRenderer.invoke('launcher:play'),
  openFolder: () => ipcRenderer.invoke('launcher:open-folder'),
  onProgress: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('launcher:progress', listener);
    return () => ipcRenderer.removeListener('launcher:progress', listener);
  },
  onStatus: (handler) => {
    const listener = (_event, message) => handler(message);
    ipcRenderer.on('launcher:status', listener);
    return () => ipcRenderer.removeListener('launcher:status', listener);
  }
});