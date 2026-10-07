'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const actions = ['getState', 'saveProfile', 'deleteProfile', 'duplicateProfile', 'launchProfile', 'stopProfile', 'importSubscription', 'refreshSubscription', 'deleteSubscription', 'importFile', 'revealData'];
const api = Object.fromEntries(actions.map(action => [action, arg => ipcRenderer.invoke(`manager:${action}`, arg)]));
api.onState = callback => {
  const listener = (_event, state) => callback(state);
  ipcRenderer.on('manager:state', listener);
  return () => ipcRenderer.removeListener('manager:state', listener);
};
contextBridge.exposeInMainWorld('hangjing', api);
