import { DEFAULT_BASE_URL, DEFAULT_MODELS, type ProviderId } from './providers';

/**
 * What is kept in the browser between visits, and what is not.
 *
 * Kept (localStorage, only if it works): the provider, the model names and the address, which are
 * not secret. The key is kept only when the person ticks "Remember the key in this browser".
 * Never kept: the opt-in to send the library. It starts off every time the page loads.
 */

export interface Settings {
  provider: ProviderId;
  models: Record<ProviderId, string>;
  baseUrl: string;
  remember: boolean;
}

export type KeyStore = Partial<Record<ProviderId, string>>;

export interface StorageLike {
  getItem(name: string): string | null;
  setItem(name: string, value: string): void;
  removeItem(name: string): void;
}

const SETTINGS_NAME = 'opentunes.ai.settings';
const PROVIDERS: ProviderId[] = ['anthropic', 'openai'];
const keyName = (provider: ProviderId): string => `opentunes.ai.key.${provider}`;

export const defaultSettings = (): Settings => ({ provider: 'anthropic', models: { ...DEFAULT_MODELS }, baseUrl: DEFAULT_BASE_URL, remember: false });

/** The browser's storage, or null where it is blocked (a private window, cleared site data). */
export function browserStorage(): StorageLike | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadSettings(storage: StorageLike | null): { settings: Settings; keys: KeyStore } {
  const settings = defaultSettings();
  const keys: KeyStore = {};
  if (!storage) return { settings, keys };
  try {
    const saved = JSON.parse(storage.getItem(SETTINGS_NAME) ?? 'null') as Partial<Settings> | null;
    if (saved && typeof saved === 'object') {
      if (saved.provider === 'anthropic' || saved.provider === 'openai') settings.provider = saved.provider;
      for (const id of PROVIDERS) {
        const model = saved.models?.[id];
        if (typeof model === 'string') settings.models[id] = model;
      }
      if (typeof saved.baseUrl === 'string') settings.baseUrl = saved.baseUrl;
      settings.remember = saved.remember === true;
    }
    if (settings.remember) {
      for (const id of PROVIDERS) {
        const key = storage.getItem(keyName(id));
        if (key) keys[id] = key;
      }
    }
  } catch {
    // unreadable storage or damaged JSON: start from the defaults
  }
  return { settings, keys };
}

/** Saves the settings, and the keys only when `remember` is on. Returns false if storage refused. */
export function saveSettings(storage: StorageLike | null, settings: Settings, keys: KeyStore): boolean {
  if (!storage) return false;
  try {
    storage.setItem(SETTINGS_NAME, JSON.stringify(settings));
    for (const id of PROVIDERS) {
      const key = keys[id];
      if (settings.remember && key) storage.setItem(keyName(id), key);
      else storage.removeItem(keyName(id));
    }
    return true;
  } catch {
    return false;
  }
}

/** Removes every saved key. */
export function forgetKeys(storage: StorageLike | null): void {
  if (!storage) return;
  try {
    for (const id of PROVIDERS) storage.removeItem(keyName(id));
  } catch {
    // nothing to do
  }
}
