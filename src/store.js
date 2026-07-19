// Simple JSON-file settings store (avoids native modules so `npm install` stays clean).
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const FILE = path.join(app.getPath('userData'), 'cue-data.json');

const DEFAULTS = {
  provider: 'openai',
  smart: false,
  apiKeys: { openai: '', anthropic: '', gemini: '', zai: '', deepgram: '' },
  models: {
    openai: { fast: 'gpt-4o-mini', smart: 'gpt-4o' },
    anthropic: { fast: 'claude-haiku-4-5', smart: 'claude-sonnet-4-6' },
    gemini: { fast: 'gemini-2.5-flash', smart: 'gemini-2.5-pro' },
    zai: { fast: 'glm-4.6v-flash', smart: 'glm-5v-turbo' }
  },
  transcriptionModels: {
    openai: 'gpt-4o-mini-transcribe',
    gemini: 'gemini-2.5-flash',
    zai: 'glm-asr-2512'
  }
};

const RETIRED_MODEL_MIGRATIONS = [
  [['models', 'anthropic', 'fast'], 'claude-3-5-haiku-latest', 'claude-haiku-4-5'],
  [['models', 'anthropic', 'smart'], 'claude-3-5-sonnet-latest', 'claude-sonnet-4-6'],
  [['models', 'gemini', 'fast'], 'gemini-1.5-flash', 'gemini-2.5-flash'],
  [['models', 'gemini', 'smart'], 'gemini-1.5-pro', 'gemini-2.5-pro']
];

let data = null;

function deepMerge(base, over) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const key of Object.keys(over || {})) {
    if (over[key] && typeof over[key] === 'object' && !Array.isArray(over[key]) && base[key] && typeof base[key] === 'object') {
      out[key] = deepMerge(base[key], over[key]);
    } else {
      out[key] = over[key];
    }
  }
  return out;
}

function valueAt(object, keys) {
  return keys.reduce((value, key) => value && value[key], object);
}

function setAt(object, keys, value) {
  let target = object;
  for (const key of keys.slice(0, -1)) {
    if (!target[key] || typeof target[key] !== 'object') target[key] = {};
    target = target[key];
  }
  target[keys[keys.length - 1]] = value;
}

function migrateStoredSettings(stored) {
  const migrated = deepMerge({}, stored || {});
  let changed = false;
  for (const [keys, retired, replacement] of RETIRED_MODEL_MIGRATIONS) {
    if (valueAt(migrated, keys) === retired) {
      setAt(migrated, keys, replacement);
      changed = true;
    }
  }
  if (migrated.sttModel && !(migrated.transcriptionModels && migrated.transcriptionModels.openai)) {
    setAt(migrated, ['transcriptionModels', 'openai'], migrated.sttModel);
    changed = true;
  }
  return { settings: migrated, changed };
}

function save() {
  try {
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    console.log('[cue] settings save failed', error && error.message);
  }
}

function load() {
  if (data) return data;
  try {
    const stored = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const migrated = migrateStoredSettings(stored);
    data = deepMerge(DEFAULTS, migrated.settings);
    if (migrated.changed) save();
  } catch {
    data = deepMerge(DEFAULTS, {});
  }
  return data;
}

module.exports = {
  getSettings() { return load(); },
  setSettings(patch) {
    load();
    data = deepMerge(data, patch || {});
    save();
    return data;
  },
  migrateStoredSettings
};
