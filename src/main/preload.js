const { contextBridge, ipcRenderer } = require('electron');

const ACTION_CHANNEL = 'codex-pulse:action';
const STATE_CHANNEL = 'codex-pulse:state';
const allowedActions = new Set([
  'ready',
  'refresh',
  'refreshRemote',
  'reloadSSHHosts',
  'setSource',
  'addRemoteHost',
  'removeRemoteHost',
  'remoteConnect',
  'setYolo',
  'setSessionTitleMode',
  'hide',
  'quit',
  'resume',
  'copy',
  'reveal',
  'acknowledgeCompletion',
  'remoteResume',
  'remoteCopy',
]);

contextBridge.exposeInMainWorld('codexPulse', Object.freeze({
  send(action, details = {}) {
    if (!allowedActions.has(action)) return;
    const safeDetails = details && typeof details === 'object' && !Array.isArray(details)
      ? details
      : {};
    ipcRenderer.send(ACTION_CHANNEL, { action, ...safeDetails });
  },
  onState(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(STATE_CHANNEL, listener);
    return () => ipcRenderer.removeListener(STATE_CHANNEL, listener);
  },
}));
