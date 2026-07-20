// Speech-to-text factory. Decoupled from the LLM provider because Anthropic has
// no audio API — we transcribe with whatever audio-capable key is available, and
// fall back across providers. Returns { text, provider } or { text:'', error }.
const { pcmToWav } = require('./wav');
const STT_PROVIDER_TIMEOUT_MS = 20000;

function abortError() {
  const error = new Error('Transcription request aborted');
  error.name = 'AbortError';
  return error;
}

function waitWithSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function attemptScope(parentSignal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = () => controller.abort();
  if (parentSignal) {
    if (parentSignal.aborted) controller.abort();
    else parentSignal.addEventListener('abort', abortFromParent, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup() {
      clearTimeout(timer);
      if (parentSignal) parentSignal.removeEventListener('abort', abortFromParent);
    }
  };
}

async function transcribeOpenAICompatible(apiKey, wav, model, baseURL, signal, timeoutMs) {
  const OpenAI = require('openai');
  const toFile = OpenAI.toFile || require('openai/uploads').toFile;
  const client = new OpenAI({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
    maxRetries: 0,
    timeout: timeoutMs
  });
  const file = await toFile(wav, 'audio.wav', { type: 'audio/wav' });
  const res = await client.audio.transcriptions.create(
    { file, model: model || 'whisper-1' },
    { signal }
  );
  return (res.text || '').trim();
}

async function transcribeGemini(apiKey, wav, model, signal) {
  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey });
  const request = ai.models.generateContent({
    model: model || 'gemini-2.5-flash',
    contents: [{ role: 'user', parts: [
      { text: 'Transcribe this audio verbatim. Return only the spoken words with no commentary. If there is no clear speech, return an empty response.' },
      { inlineData: { mimeType: 'audio/wav', data: wav.toString('base64') } }
    ] }]
  });
  const res = await waitWithSignal(request, signal);
  return ((res && res.text) || '').trim();
}

function createSTT(settings, options = {}) {
  const keys = settings.apiKeys || {};
  const models = settings.transcriptionModels || {};
  const providerTimeoutMs = options.providerTimeoutMs || STT_PROVIDER_TIMEOUT_MS;
  const chain = [];
  if (keys.openai) chain.push({ p: 'openai', fn: (wav, signal) => transcribeOpenAICompatible(keys.openai, wav, models.openai || settings.sttModel || 'gpt-4o-mini-transcribe', null, signal, providerTimeoutMs) });
  if (keys.gemini) chain.push({ p: 'gemini', fn: (wav, signal) => transcribeGemini(keys.gemini, wav, models.gemini || 'gemini-2.5-flash', signal) });
  if (keys.zai) chain.push({ p: 'zai', fn: (wav, signal) => transcribeOpenAICompatible(keys.zai, wav, models.zai || 'glm-asr-2512', 'https://api.z.ai/api/paas/v4/', signal, providerTimeoutMs) });

  return {
    available: chain.length > 0,
    providers: chain.map((c) => c.p),
    async transcribe(pcm, requestOptions = {}) {
      if (!chain.length || !pcm || pcm.length < 3200) return { text: '' };
      const wav = pcmToWav(pcm, 16000, 1);
      let lastErr = null;
      for (const c of chain) {
        if (requestOptions.signal && requestOptions.signal.aborted) return { text: '', aborted: true };
        const scope = attemptScope(requestOptions.signal, providerTimeoutMs);
        try {
          const text = await c.fn(wav, scope.signal);
          return { text, provider: c.p };
        } catch (e) {
          if (requestOptions.signal && requestOptions.signal.aborted) return { text: '', aborted: true };
          lastErr = scope.timedOut()
            ? { code: 'stt_timeout', message: `Transcription timed out after ${providerTimeoutMs}ms`, provider: c.p }
            : { status: e && e.status, code: e && e.code, message: (e && e.message) || String(e), provider: c.p };
        } finally {
          scope.cleanup();
        }
      }
      return { text: '', error: lastErr };
    }
  };
}

module.exports = { createSTT, STT_PROVIDER_TIMEOUT_MS };
