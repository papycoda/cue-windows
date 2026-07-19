const { app, BrowserWindow, ipcMain, globalShortcut, screen, session, desktopCapturer, shell } = require('electron');
const path = require('path');
const store = require('./src/store');
const { captureScreenshot } = require('./src/screen');
const { createSTT } = require('./src/stt');
const { createLLM } = require('./src/llm');
const { MODES } = require('./src/prompts');
const { rms16 } = require('./src/wav');

let win = null;

// -------- capture / transcript state --------
const state = { capturing: false, stopping: false, busy: false, transcribing: { you: false, them: false } };
let sttDisabled = false;
const buffers = { you: [], them: [] };
const transcriptionPromises = { you: null, them: null };
const transcript = [];
const FLUSH_MS = 3500;
const FINAL_FLUSH_TIMEOUT_MS = 10000;
const MIN_BYTES = Math.floor(16000 * 2 * 0.6);
const RMS_GATE = 240;
let flushTimer = null;
let captureTransition = Promise.resolve();

function send(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

function captureSnapshot(extra) {
  return { active: state.capturing, stopping: state.stopping, ...(extra || {}) };
}

async function withTimeout(promise, timeoutMs) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs); })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// -------- window --------
function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const W = 700;
  const H = 600;
  win = new BrowserWindow({
    width: W,
    height: H,
    x: Math.round(workArea.x + (workArea.width - W) / 2),
    y: workArea.y + 6,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  const protect = process.env.CUE_NO_PROTECT !== '1';
  win.setContentProtection(protect);
  if (process.platform === 'darwin') {
    win.setAlwaysOnTop(true, 'screen-saver', 1);
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.setHiddenInMissionControl(true);
  } else {
    win.setAlwaysOnTop(true);
  }

  const reported = typeof win.isContentProtected === 'function' ? win.isContentProtected() : 'unavailable';
  console.log(`[cue] content protection requested=${protect} reported=${reported} platform=${process.platform}`);

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.on('did-finish-load', () => win.showInactive());
  win.webContents.on('render-process-gone', (_e, details) => console.log('[cue] renderer gone', JSON.stringify(details)));
}

// -------- STT flushing --------
function flushChannel(channel) {
  if (transcriptionPromises[channel]) return transcriptionPromises[channel];

  const chunks = buffers[channel];
  if (!chunks.length) return Promise.resolve();
  const pcm = Buffer.concat(chunks);
  buffers[channel] = [];
  if (pcm.length < MIN_BYTES || rms16(pcm) < RMS_GATE) return Promise.resolve();

  state.transcribing[channel] = true;
  let pending = null;
  pending = (async () => {
    try {
      const settings = store.getSettings();
      const stt = createSTT(settings);
      if (!stt.available) {
        if (!sttDisabled) {
          sttDisabled = true;
          send('status', { message: 'No transcription key set. Add an OpenAI, Gemini, or Z.AI key in Settings to enable listening. Screen features work without it.' });
        }
        return;
      }
      const res = await stt.transcribe(pcm);
      if (res.error) {
        handleSttError(res.error);
        return;
      }
      if (res.text && res.text.trim()) {
        const turn = { channel, text: res.text.trim(), ts: Date.now() };
        transcript.push(turn);
        send('transcript', turn);
      }
    } catch (error) {
      console.log('[stt] error', error && error.message);
      send('status', { message: `Transcription error: ${(error && error.message) || String(error)}` });
    } finally {
      if (transcriptionPromises[channel] === pending) {
        state.transcribing[channel] = false;
        transcriptionPromises[channel] = null;
      }
    }
  })();
  transcriptionPromises[channel] = pending;
  return pending;
}

function handleSttError(err) {
  console.log('[stt] error', err.provider, err.status, err.code, err.message);
  if (sttDisabled) return;
  sttDisabled = true;
  const noAccess = err.status === 403 || err.status === 401 || err.code === 'model_not_found';
  if (noAccess) {
    send('status', { message: `Transcription off: the ${err.provider} key or transcription model is unavailable. Check the key and transcription model in Settings.` });
  } else {
    send('status', { message: `Transcription error (${err.provider}): ${err.message}` });
  }
}

function startFlushLoop() {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    void flushChannel('you');
    void flushChannel('them');
  }, FLUSH_MS);
}

function stopFlushLoop() {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
}

async function flushFinalAudio() {
  const settleAndFlush = async () => {
    await Promise.allSettled(Object.values(transcriptionPromises).filter(Boolean));
    await Promise.allSettled([flushChannel('you'), flushChannel('them')]);
  };
  const result = await withTimeout(settleAndFlush(), FINAL_FLUSH_TIMEOUT_MS);
  if (result && result.timedOut) {
    console.log(`[cue] final transcription wait exceeded ${FINAL_FLUSH_TIMEOUT_MS}ms`);
    send('status', { message: 'Stopped listening; a final transcription request is still finishing.' });
    for (const channel of ['you', 'them']) {
      transcriptionPromises[channel] = null;
      state.transcribing[channel] = false;
    }
  }
  buffers.you = [];
  buffers.them = [];
}

async function applyCaptureState(active) {
  if (active) {
    if (state.capturing && !state.stopping) return captureSnapshot();
    state.stopping = false;
    state.capturing = true;
    startFlushLoop();
    send('capture:state', captureSnapshot({ phase: 'starting' }));
    return captureSnapshot({ phase: 'starting' });
  }

  if (!state.capturing && !state.stopping) return captureSnapshot();
  state.capturing = false;
  state.stopping = true;
  stopFlushLoop();
  send('capture:state', captureSnapshot({ phase: 'stopping' }));
  await flushFinalAudio();
  state.stopping = false;
  send('capture:state', captureSnapshot({ phase: 'inactive' }));
  return captureSnapshot({ phase: 'inactive' });
}

function requestCaptureState(active) {
  const desired = !!active;
  captureTransition = captureTransition
    .catch(() => {})
    .then(() => applyCaptureState(desired));
  return captureTransition;
}

// -------- feature runner --------
async function runFeature(mode, userText) {
  if (state.busy) return;
  const def = MODES[mode];
  if (!def) return;
  state.busy = true;
  try {
    const settings = store.getSettings();
    const llm = createLLM(settings);
    const userBubble = def.userBubble !== null ? def.userBubble : (mode === 'ask' ? userText : null);
    send('llm:start', { userBubble, small: !!def.small });

    if (!llm.ready) {
      send('llm:error', { message: `Add your ${settings.provider} API key in Settings to start. Model: ${llm.model || 'unset'}.` });
      return;
    }

    let imageDataUrl = null;
    if (def.needsScreen) {
      try {
        imageDataUrl = await captureScreenshot();
        if (!imageDataUrl) send('status', { message: 'Screen capture failed: Electron returned no usable display image.' });
      } catch (error) {
        console.log('[cue] screen capture failed', error && error.message);
        const message = process.platform === 'darwin'
          ? 'Screen capture failed. Allow Screen Recording for cue in System Settings.'
          : `Screen capture failed on Windows: ${(error && error.message) || 'no display image was returned'}.`;
        send('status', { message });
      }
    }

    const built = def.build({ transcript, userText: userText || '' });
    await llm.stream({
      system: def.system,
      turns: [{ role: 'user', text: built }],
      imageDataUrl,
      onToken: (token) => send('llm:token', { text: token })
    });
    send('llm:done', {});
  } catch (error) {
    send('llm:error', { message: `Error: ${(error && error.message) || String(error)}` });
  } finally {
    state.busy = false;
  }
}

// -------- IPC --------
ipcMain.handle('settings:get', () => store.getSettings());
ipcMain.handle('settings:set', (_event, patch) => {
  sttDisabled = false;
  return store.setSettings(patch);
});
ipcMain.handle('settings:open', (_event, destination) => {
  const destinations = {
    win32: { microphone: 'ms-settings:privacy-microphone' },
    darwin: {
      microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
      screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
    }
  };
  const target = destinations[process.platform] && destinations[process.platform][destination];
  if (!target) return false;
  return shell.openExternal(target).then(() => true, () => false);
});
ipcMain.handle('capture:set', (_event, active) => requestCaptureState(active));
ipcMain.handle('capture:state', () => captureSnapshot());
ipcMain.on('ask', (_event, payload) => runFeature(payload.mode, payload.text));
ipcMain.on('mic:pcm', (_event, arrayBuffer) => {
  if (state.capturing) buffers.you.push(Buffer.from(arrayBuffer));
});
ipcMain.on('system:pcm', (_event, arrayBuffer) => {
  if (state.capturing) buffers.them.push(Buffer.from(arrayBuffer));
});
ipcMain.on('mouse:ignore', (_event, value) => {
  if (win) win.setIgnoreMouseEvents(!!value, { forward: true });
});
ipcMain.on('log', (_event, message) => console.log('[renderer]', message));

// -------- shortcuts --------
function registerShortcuts() {
  const shortcuts = [
    ['CommandOrControl+Return', () => runFeature('assist', '')],
    ['CommandOrControl+H', () => runFeature('leetcode', '')],
    ['CommandOrControl+Shift+X', () => app.quit()]
  ];
  const failures = [];
  for (const [accelerator, action] of shortcuts) {
    if (!globalShortcut.register(accelerator, action)) failures.push(accelerator);
  }
  if (failures.length) {
    console.log('[cue] global shortcut registration failed:', failures.join(', '));
    win.webContents.once('did-finish-load', () => {
      send('status', { message: `Global shortcut registration failed: ${failures.join(', ')}. Another application may already use it.` });
    });
  }
}

// -------- lifecycle --------
app.whenReady().then(() => {
  if (process.platform === 'darwin') app.dock.hide();

  const allowMedia = (permission) => ['media', 'microphone', 'audioCapture', 'display-capture'].includes(permission);
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => callback(allowMedia(permission)));
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => allowMedia(permission));

  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      if (!sources.length) {
        callback();
        return;
      }
      const streams = { video: sources[0] };
      if (process.platform === 'win32' && request.audioRequested) streams.audio = 'loopback';
      callback(streams);
    }).catch((error) => {
      console.log('[cue] display media source error', error && error.message);
      callback();
    });
  }, { useSystemPicker: false });

  createWindow();
  registerShortcuts();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => {
  stopFlushLoop();
  globalShortcut.unregisterAll();
});
app.on('window-all-closed', () => app.quit());
