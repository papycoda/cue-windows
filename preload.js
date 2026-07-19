const { contextBridge, ipcRenderer } = require('electron');

const platform = process.platform;

contextBridge.exposeInMainWorld('cue', Object.freeze({
  platform,
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSet: (patch) => ipcRenderer.invoke('settings:set', patch),
  openSettingsDestination: (destination) => ipcRenderer.invoke('settings:open', destination),
  ask: (payload) => ipcRenderer.send('ask', payload),
  captureSet: (active) => ipcRenderer.invoke('capture:set', !!active),
  captureState: () => ipcRenderer.invoke('capture:state'),
  micPcm: (arrayBuffer) => ipcRenderer.send('mic:pcm', arrayBuffer),
  systemPcm: (arrayBuffer) => ipcRenderer.send('system:pcm', arrayBuffer),
  setIgnoreMouse: (value) => ipcRenderer.send('mouse:ignore', value),
  log: (message) => ipcRenderer.send('log', message),
  on: (channel, callback) => {
    const allowed = ['capture:state', 'llm:start', 'llm:token', 'llm:done', 'llm:error', 'status', 'transcript'];
    if (!allowed.includes(channel)) return;
    ipcRenderer.on(channel, (_event, data) => callback(data));
  }
}));
