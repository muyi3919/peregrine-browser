'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('browserControls', {
  command: (action, value) => ipcRenderer.invoke('browser:command', { action, value }),
  onState: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('browser:state', listener);
    return () => ipcRenderer.removeListener('browser:state', listener);
  }
});
