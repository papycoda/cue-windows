/* cue renderer — UI state, mic capture, IPC, streaming render. */
(function () {
  const { icon } = window.ICONS;
  const cue = window.cue; // exposed by preload
  const $ = (s) => document.querySelector(s);
  const isMac = cue.platform === 'darwin';
  const isWindows = cue.platform === 'win32';
  const primaryKeyLabel = isMac ? 'Command' : 'Ctrl';
  const hasPrimaryModifier = (event) => isMac ? event.metaKey : event.ctrlKey;

  // ---- paint icons -------------------------------------------------------
  $('#logo-btn').innerHTML = icon('logo', { size: 18 });
  $('.tb-hide .chev').innerHTML = icon('chevron-down', { size: 14 });
  $('#stop-btn .listen-icon').innerHTML = icon('mic', { size: 15 });
  document.querySelector('.act[data-mode="assist"] .ic').innerHTML = icon('sparkles', { size: 16 });
  document.querySelector('.act[data-mode="say"] .ic').innerHTML = icon('wand-sparkles', { size: 16 });
  document.querySelector('.act[data-mode="followup"] .ic').innerHTML = icon('message-circle', { size: 16 });
  document.querySelector('.act[data-mode="recap"] .ic').innerHTML = icon('refresh-cw', { size: 16 });
  $('#smart-toggle .ic').innerHTML = icon('zap', { size: 14 });
  $('#more-btn').innerHTML = icon('more-horizontal', { size: 18 });
  $('#send-btn').innerHTML = icon('play', { size: 15 });
  $('#primary-key').textContent = primaryKeyLabel;

  // ---- state -------------------------------------------------------------
  let settings = null;
  let busy = false;
  let aiEl = null;       // current streaming <div class="ai-text">
  let caretEl = null;

  const messages = $('#messages');

  function esc(s) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  // minimal, safe markdown: fenced code, bullets, inline code, bold, paragraphs
  function renderMarkdown(text) {
    const lines = text.split('\n');
    let html = '', inCode = false, inList = false, buf = [];
    const flushP = () => { if (buf.length) { html += '<p>' + inline(buf.join(' ')) + '</p>'; buf = []; } };
    const inline = (s) => esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    for (const raw of lines) {
      const line = raw;
      if (/^```/.test(line.trim())) {
        if (!inCode) { flushP(); if (inList) { html += '</ul>'; inList = false; } html += '<pre><code>'; inCode = true; }
        else { html += '</code></pre>'; inCode = false; }
        continue;
      }
      if (inCode) { html += esc(line) + '\n'; continue; }
      if (/^\s*[-*]\s+/.test(line)) { flushP(); if (!inList) { html += '<ul>'; inList = true; } html += '<li>' + inline(line.replace(/^\s*[-*]\s+/, '')) + '</li>'; continue; }
      if (line.trim() === '') { flushP(); if (inList) { html += '</ul>'; inList = false; } continue; }
      buf.push(line.trim());
    }
    flushP(); if (inList) html += '</ul>'; if (inCode) html += '</code></pre>';
    return html;
  }

  function clearMessages() { messages.innerHTML = ''; aiEl = null; caretEl = null; }

  function addUserBubble(text) {
    const b = document.createElement('div');
    b.className = 'user-bubble';
    b.textContent = text;
    messages.appendChild(b);
  }

  function startAi(small) {
    aiEl = document.createElement('div');
    aiEl.className = 'ai-text' + (small ? ' small' : '');
    aiEl.dataset.raw = '';
    caretEl = document.createElement('span');
    caretEl.className = 'ai-caret';
    aiEl.appendChild(caretEl);
    messages.appendChild(aiEl);
  }

  function appendToken(t) {
    if (!aiEl) startAi(false);
    aiEl.dataset.raw += t;
    const span = document.createElement('span');
    span.className = 'w';
    span.textContent = t;
    aiEl.insertBefore(span, caretEl);
  }

  function finalizeAi() {
    if (!aiEl) return;
    const raw = aiEl.dataset.raw || '';
    aiEl.innerHTML = renderMarkdown(raw);
    aiEl = null; caretEl = null;
  }

  function setBusy(v) { busy = v; $('#send-btn').classList.toggle('busy', v); }

  // ---- actions -----------------------------------------------------------
  function runMode(mode, text) {
    if (busy) return;
    setBusy(true);
    cue.ask({ mode, text: text || '' });
  }

  document.querySelectorAll('.act').forEach((btn) => {
    btn.addEventListener('click', () => runMode(btn.dataset.mode, ''));
  });

  const input = $('#input');
  const placeholder = $('#placeholder');
  const composer = $('#composer');

  function syncPlaceholder() {
    placeholder.classList.toggle('hidden', input.value.length > 0 || document.activeElement === input);
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
  }
  input.addEventListener('input', syncPlaceholder);
  input.addEventListener('focus', () => { composer.classList.add('focused'); placeholder.classList.add('hidden'); });
  input.addEventListener('blur', () => { composer.classList.remove('focused'); syncPlaceholder(); });
  $('#input-area').addEventListener('click', () => input.focus());

  function send() {
    const text = input.value.trim();
    if (!text) { runMode('assist', ''); return; }
    input.value = ''; syncPlaceholder();
    runMode('ask', text);
  }
  $('#send-btn').addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    e.preventDefault();
    if (hasPrimaryModifier(e)) runMode('assist', '');
    else send();
  });

  // Smart toggle
  const smartBtn = $('#smart-toggle');
  smartBtn.addEventListener('click', async () => {
    settings.smart = !settings.smart;
    smartBtn.classList.toggle('on', settings.smart);
    await cue.settingsSet({ smart: settings.smart });
  });

  // Hide / collapse
  const hideBtn = $('#hide-btn');
  hideBtn.addEventListener('click', () => {
    const collapsed = $('#panel').classList.toggle('collapsed');
    hideBtn.classList.toggle('collapsed', collapsed);
    $('#hide-label').textContent = collapsed ? 'Unhide' : 'Hide';
    hideBtn.title = collapsed ? 'Unhide cue panel' : 'Hide cue panel';
    hideBtn.setAttribute('aria-expanded', String(!collapsed));
    $('#live-dot').style.display = collapsed ? 'none' : '';
  });

  // Stop = start/stop listening. Kick off system-audio capture straight from the click so
  // the user-gesture is fresh for getDisplayMedia (loopback capture needs it).
  let captureDesired = false;

  $('#stop-btn').addEventListener('click', async () => {
    const next = !captureDesired;
    captureDesired = next;
    if (next) {
      setCaptureVisual('starting');
      // Start directly in the click handler so getDisplayMedia retains its user gesture.
      const starts = settleCaptureStarts();
      await cue.captureSet(true);
      await starts;
    } else {
      stopCaptureSources();
      setCaptureVisual('stopping');
      await cue.captureSet(false);
    }
  });

  // ---- capture: mic (renderer side) --------------------------------------
  let audioCtx = null, micStream = null, micNode = null, micProc = null, micStartPromise = null;
  async function startMic() {
    if (micStream) return true;
    if (micStartPromise) return micStartPromise;
    micStartPromise = (async () => {
      let stream = null;
      let context = null;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
        if (!captureDesired) {
          stream.getTracks().forEach((track) => track.stop());
          return false;
        }
        context = new AudioContext({ sampleRate: 16000 });
        const node = context.createMediaStreamSource(stream);
        const processor = context.createScriptProcessor(4096, 1, 1);
        const sink = context.createGain();
        sink.gain.value = 0;
        node.connect(processor); processor.connect(sink); sink.connect(context.destination);
        processor.onaudioprocess = (event) => sendPcm(event, cue.micPcm);
        micStream = stream; audioCtx = context; micNode = node; micProc = processor;
        return true;
      } catch (err) {
        if (stream) stream.getTracks().forEach((track) => track.stop());
        if (context) void context.close();
        const denied = err && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError');
        showStatus(denied
          ? `Microphone access denied. Allow cue in ${isWindows ? 'Windows Privacy settings' : 'System Settings'}.`
          : `Microphone capture failed: ${(err && err.message) || String(err)}`);
        cue.log('mic error: ' + (err && err.message));
        return false;
      } finally {
        micStartPromise = null;
      }
    })();
    return micStartPromise;
  }
  function stopMic() {
    if (micProc) { micProc.disconnect(); micProc.onaudioprocess = null; micProc = null; }
    if (micNode) { micNode.disconnect(); micNode = null; }
    if (audioCtx) { void audioCtx.close(); audioCtx = null; }
    if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
  }

  // ---- capture: system/meeting audio (getDisplayMedia loopback, in cue's process) ----
  let sysStream = null, sysCtx = null, sysNode = null, sysProc = null, sysStartPromise = null;
  async function startSystemAudio() {
    if (sysStream) return true;
    if (sysStartPromise) return sysStartPromise;
    sysStartPromise = (async () => {
      let stream = null;
      let context = null;
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        stream.getVideoTracks().forEach((track) => track.stop());
        const tracks = stream.getAudioTracks();
        if (!tracks.length) {
          stream.getTracks().forEach((track) => track.stop());
          showStatus(isWindows
            ? 'Windows loopback returned no system-audio track. Microphone-only listening can continue.'
            : 'System-audio loopback is unavailable on this platform. Microphone-only listening can continue.');
          return false;
        }
        if (!captureDesired) {
          stream.getTracks().forEach((track) => track.stop());
          return false;
        }
        context = new AudioContext({ sampleRate: 16000 });
        const node = context.createMediaStreamSource(new MediaStream(tracks));
        const processor = context.createScriptProcessor(4096, 1, 1);
        const sink = context.createGain();
        sink.gain.value = 0;
        node.connect(processor); processor.connect(sink); sink.connect(context.destination);
        processor.onaudioprocess = (event) => sendPcm(event, cue.systemPcm);
        sysStream = stream; sysCtx = context; sysNode = node; sysProc = processor;
        cue.log('system audio: capturing Windows loopback');
        return true;
      } catch (err) {
        if (stream) stream.getTracks().forEach((track) => track.stop());
        if (context) void context.close();
        showStatus(`System-audio capture failed: ${(err && err.message) || String(err)}`);
        cue.log('system audio error: ' + (err && err.message));
        return false;
      } finally {
        sysStartPromise = null;
      }
    })();
    return sysStartPromise;
  }
  function stopSystemAudio() {
    if (sysProc) { sysProc.disconnect(); sysProc.onaudioprocess = null; sysProc = null; }
    if (sysNode) { sysNode.disconnect(); sysNode = null; }
    if (sysCtx) { void sysCtx.close(); sysCtx = null; }
    if (sysStream) { sysStream.getTracks().forEach((t) => t.stop()); sysStream = null; }
  }

  function sendPcm(event, destination) {
    if (!captureDesired) return;
    const inputSamples = event.inputBuffer.getChannelData(0);
    const output = new Int16Array(inputSamples.length);
    for (let i = 0; i < inputSamples.length; i++) {
      const sample = Math.max(-1, Math.min(1, inputSamples[i]));
      output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
    destination(output.buffer);
  }

  function stopCaptureSources() {
    captureDesired = false;
    stopMic();
    stopSystemAudio();
  }

  function setCaptureVisual(phase, available) {
    const active = phase === 'active' && available;
    const button = $('#stop-btn');
    const states = {
      inactive: { label: 'Listen', title: 'Start listening' },
      starting: { label: 'Starting…', title: 'Starting microphone and system audio' },
      active: { label: 'Stop', title: 'Stop listening' },
      stopping: { label: 'Finishing…', title: 'Finishing the last transcription' }
    };
    const state = states[phase] || states.inactive;
    $('#live-dot').classList.toggle('off', !active);
    button.classList.remove('starting', 'active', 'stopping');
    if (phase !== 'inactive') button.classList.add(phase);
    button.title = state.title;
    button.setAttribute('aria-pressed', String(phase === 'starting' || phase === 'active'));
    $('#listen-label').textContent = state.label;
  }

  async function settleCaptureStarts() {
    const [mic, system] = await Promise.all([startMic(), startSystemAudio()]);
    if (!captureDesired) return { mic: false, system: false };
    if (mic && system) showStatus(`Listening with microphone and ${isWindows ? 'Windows ' : ''}system audio.`);
    else if (mic) showStatus('Listening with microphone only; system audio is unavailable.');
    else if (system) showStatus('Listening to system audio only; microphone is unavailable.');
    else {
      showStatus('Listening could not start: microphone and system audio both failed.');
      stopCaptureSources();
      setCaptureVisual('inactive', false);
      await cue.captureSet(false);
      return { mic: false, system: false };
    }
    setCaptureVisual('active', true);
    return { mic, system };
  }

  // ---- events from main --------------------------------------------------
  cue.on('capture:state', ({ active, stopping, phase }) => {
    if (active) {
      // Ignore an older start notification if the user has already requested stop.
      if (!captureDesired) {
        void cue.captureSet(false);
        return;
      }
      setCaptureVisual('starting', false);
      void settleCaptureStarts();
    } else {
      stopCaptureSources();
      if (stopping || phase === 'stopping') {
        setCaptureVisual('stopping', false);
        showStatus('Finishing the last transcription...');
      } else {
        setCaptureVisual('inactive', false);
      }
    }
  });
  cue.on('llm:start', ({ userBubble, small }) => {
    clearMessages();
    if (userBubble) addUserBubble(userBubble);
    startAi(!!small);
    setBusy(true);
  });
  cue.on('llm:token', ({ text }) => appendToken(text));
  cue.on('llm:done', () => { finalizeAi(); setBusy(false); });
  cue.on('llm:error', ({ message }) => {
    if (!aiEl) startAi(true);
    aiEl.dataset.raw = message; finalizeAi(); setBusy(false);
  });
  let statusTimer = null;
  function showStatus(message) {
    let el = document.getElementById('cue-status');
    if (!el) {
      el = document.createElement('div');
      el.id = 'cue-status';
      const panel = document.getElementById('panel');
      panel.insertBefore(el, document.getElementById('action-row'));
    }
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => el.classList.remove('show'), 11000);
  }
  cue.on('status', ({ message }) => { cue.log('[status] ' + message); showStatus(message); });

  // ---- settings ----------------------------------------------------------
  const scrim = $('#settings-scrim');
  function openSettings() { fillSettings(); scrim.classList.remove('hidden'); }
  function closeSettings() { saveSettings(); scrim.classList.add('hidden'); }
  $('#more-btn').addEventListener('click', openSettings);
  $('#s-close').addEventListener('click', closeSettings);
  scrim.addEventListener('click', (e) => { if (e.target === scrim) closeSettings(); });

  function fillSettings() {
    document.querySelectorAll('#provider-seg button').forEach((b) => b.classList.toggle('on', b.dataset.provider === settings.provider));
    $('#key-openai').value = settings.apiKeys.openai || '';
    $('#key-anthropic').value = settings.apiKeys.anthropic || '';
    $('#key-gemini').value = settings.apiKeys.gemini || '';
    $('#key-zai').value = settings.apiKeys.zai || '';
    const m = settings.models[settings.provider] || { fast: '', smart: '' };
    $('#model-fast').value = m.fast; $('#model-smart').value = m.smart;
    const transcriptionModels = settings.transcriptionModels || {};
    $('#stt-openai').value = transcriptionModels.openai || settings.sttModel || 'gpt-4o-mini-transcribe';
    $('#stt-gemini').value = transcriptionModels.gemini || 'gemini-2.5-flash';
    $('#stt-zai').value = transcriptionModels.zai || 'glm-asr-2512';
    $('#s-status').textContent = statusText();
  }
  function statusText() {
    const k = settings.apiKeys;
    const has = [k.openai && 'OpenAI', k.anthropic && 'Anthropic', k.gemini && 'Gemini', k.zai && 'Z.AI'].filter(Boolean);
    const stt = k.openai ? 'OpenAI' : (k.gemini ? 'Gemini' : (k.zai ? 'Z.AI' : 'none'));
    return 'Active: ' + settings.provider + ' · keys: ' + (has.join(', ') || 'none set') + ' · transcription: ' + stt;
  }
  document.querySelectorAll('#provider-seg button').forEach((b) => b.addEventListener('click', () => {
    settings.provider = b.dataset.provider;
    document.querySelectorAll('#provider-seg button').forEach((x) => x.classList.toggle('on', x === b));
    const m = settings.models[settings.provider] || { fast: '', smart: '' };
    $('#model-fast').value = m.fast; $('#model-smart').value = m.smart;
    $('#s-status').textContent = statusText();
  }));
  async function saveSettings() {
    settings.apiKeys.openai = $('#key-openai').value.trim();
    settings.apiKeys.anthropic = $('#key-anthropic').value.trim();
    settings.apiKeys.gemini = $('#key-gemini').value.trim();
    settings.apiKeys.zai = $('#key-zai').value.trim();
    if (!settings.models[settings.provider]) settings.models[settings.provider] = {};
    settings.models[settings.provider].fast = $('#model-fast').value.trim();
    settings.models[settings.provider].smart = $('#model-smart').value.trim();
    settings.transcriptionModels = settings.transcriptionModels || {};
    settings.transcriptionModels.openai = $('#stt-openai').value.trim() || 'gpt-4o-mini-transcribe';
    settings.transcriptionModels.gemini = $('#stt-gemini').value.trim() || 'gemini-2.5-flash';
    settings.transcriptionModels.zai = $('#stt-zai').value.trim() || 'glm-asr-2512';
    await cue.settingsSet(settings);
  }

  // ---- example conversation (matches the reference screenshot) ------------
  function showExample() {
    clearMessages();
    addUserBubble('What should I say?');
    const ai = document.createElement('div');
    ai.className = 'ai-text';
    ai.textContent = '“A discounted cash flow model values a company by projecting future free cash flows and discounting them to present value using the weighted average cost of capital.”';
    messages.appendChild(ai);
  }

  // ---- global keys -------------------------------------------------------
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !scrim.classList.contains('hidden')) closeSettings();
    if (hasPrimaryModifier(e) && e.key === ',') { e.preventDefault(); openSettings(); }
  });

  // ---- click-through: only the UI blocks the mouse; empty gaps pass to your screen ----
  let ignoring = null;
  function setIgnore(v) { if (v !== ignoring) { ignoring = v; cue.setIgnoreMouse(v); } }
  document.addEventListener('mousemove', (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const overUI = !!(el && el.closest && el.closest('#toolbar, #panel-wrap, #settings-scrim, #onboard-scrim'));
    setIgnore(!overUI);
  });
  setIgnore(true); // start fully click-through; hovering the panel re-enables it

  // ---- onboarding / first-run tutorial -----------------------------------
  const obScrim = $('#onboard-scrim');
  const WINDOWS_ONBOARDING = [
    {
      icon: '👋',
      title: 'Welcome to cue for Windows',
      body: 'cue is a local personal overlay that can use your screen, microphone, and computer audio to help during meetings or coding. It has no account, server, telemetry, or cloud storage beyond requests sent to the AI provider you choose.'
    },
    {
      icon: '🎙️',
      title: 'Allow microphone access',
      body: 'Windows may ask for microphone access when listening starts. If access is blocked, allow microphone access for desktop apps in Windows Privacy settings. Screenshots use Electron display capture and do not require the macOS Screen Recording permission flow.',
      buttons: [{ label: 'Open Windows microphone settings', action: () => cue.openSettingsDestination('microphone') }]
    },
    {
      icon: '🔊',
      title: 'Separate meeting audio',
      body: 'cue captures your microphone as <strong>You</strong> and Windows system output through loopback as <strong>Them</strong>. The channels stay separate. The temporary display video track is stopped immediately, and cue does not play captured audio back through your speakers.'
    },
    {
      icon: '🔑',
      title: 'Connect an AI provider',
      body: 'Add your own OpenAI, Anthropic, Gemini, or Z.AI API key. OpenAI, Gemini, and Z.AI can transcribe listening audio; Anthropic can still power screen and coding responses.',
      buttons: [{ label: 'Open cue Settings', action: () => { finishOnboard(); openSettings(); } }]
    },
    {
      icon: '✨',
      title: 'You are all set',
      body: 'Use <span class="kbd">Ctrl</span> <span class="kbd">Enter</span> for Assist, <span class="kbd">Ctrl</span> <span class="kbd">H</span> to solve what is on screen, and <span class="kbd">Ctrl</span> <span class="kbd">,</span> for Settings. Press <span class="kbd">Enter</span> to send or <span class="kbd">Shift</span> <span class="kbd">Enter</span> for a newline. Quit with <span class="kbd">Ctrl</span><span class="kbd">Shift</span><span class="kbd">X</span>.<br><br>Click the cue logo to reopen this guide. Capture exclusion is best-effort and must be tested with each recording or meeting application.'
    }
  ];

  const MAC_ONBOARDING = [
    {
      icon: '👋',
      title: 'Welcome to cue',
      body: 'cue is a private AI copilot that floats over your screen and uses your own provider keys.'
    },
    {
      icon: '🔐',
      title: 'Allow cue to see and hear',
      body: 'Allow Microphone and Screen Recording access for cue in macOS System Settings.',
      buttons: [
        { label: 'Open Microphone settings', action: () => cue.openSettingsDestination('microphone') },
        { label: 'Open Screen Recording settings', action: () => cue.openSettingsDestination('screen') }
      ]
    },
    {
      icon: '🔑',
      title: 'Connect an AI provider',
      body: 'Add your own OpenAI, Anthropic, Gemini, or Z.AI key in cue Settings.',
      buttons: [{ label: 'Open cue Settings', action: () => { finishOnboard(); openSettings(); } }]
    },
    {
      icon: '✨',
      title: 'You are all set',
      body: 'Use <span class="kbd">Command</span> <span class="kbd">Enter</span> for Assist and <span class="kbd">Command</span> <span class="kbd">H</span> to solve what is on screen. Click the cue logo to reopen this guide. Capture exclusion remains best-effort.'
    }
  ];

  const OB_STEPS = isWindows ? WINDOWS_ONBOARDING : MAC_ONBOARDING;
  let obIndex = 0;
  function renderOnboard() {
    const step = OB_STEPS[obIndex];
    $('#ob-icon').textContent = step.icon;
    $('#ob-title').textContent = step.title;
    $('#ob-body').innerHTML = step.body;
    const btns = $('#ob-buttons'); btns.innerHTML = '';
    (step.buttons || []).forEach((b) => { const el = document.createElement('button'); el.textContent = b.label; el.addEventListener('click', b.action); btns.appendChild(el); });
    const dots = $('#ob-dots'); dots.innerHTML = '';
    OB_STEPS.forEach((_, i) => { const d = document.createElement('span'); if (i === obIndex) d.className = 'on'; dots.appendChild(d); });
    $('#ob-back').style.visibility = obIndex === 0 ? 'hidden' : 'visible';
    $('#ob-next').textContent = obIndex === OB_STEPS.length - 1 ? 'Done' : 'Next';
    $('#ob-skip').style.visibility = obIndex === OB_STEPS.length - 1 ? 'hidden' : 'visible';
  }
  function showOnboard() { obIndex = 0; renderOnboard(); obScrim.classList.remove('hidden'); setIgnore(false); }
  async function finishOnboard() {
    obScrim.classList.add('hidden');
    if (settings && !settings.onboarded) { settings.onboarded = true; await cue.settingsSet({ onboarded: true }); }
  }
  $('#ob-next').addEventListener('click', () => { if (obIndex === OB_STEPS.length - 1) finishOnboard(); else { obIndex++; renderOnboard(); } });
  $('#ob-back').addEventListener('click', () => { if (obIndex > 0) { obIndex--; renderOnboard(); } });
  $('#ob-skip').addEventListener('click', finishOnboard);
  $('#logo-btn').addEventListener('click', showOnboard);

  // ---- boot --------------------------------------------------------------
  (async function boot() {
    settings = await cue.settingsGet();
    smartBtn.classList.toggle('on', !!settings.smart);
    showExample();
    syncPlaceholder();
    const st = await cue.captureState();
    captureDesired = !!st.active;
    setCaptureVisual(st.active ? 'starting' : 'inactive', false);
    if (st.active) void settleCaptureStarts();
    if (!settings.onboarded) showOnboard();
  })();
})();
