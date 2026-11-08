/**
 * What the app has been doing, kept so the person can look when something seems stuck, and so that
 * after a reload in the middle of a change the last entries are still there.
 *
 * Privacy: nothing leaves the browser. Entries are masked before they are stored: a serial number
 * or FireWire ID (16 hex digits starting 000A27 or 000A95) and anything shaped like an API key
 * never reaches the log. File names can still appear, which is why the panel says so.
 */
import { scrub } from './ai/providers';

export type LogLevel = 'step' | 'ok' | 'error';

export interface LogEntry {
  id: number;
  /** Milliseconds since 1970. */
  at: number;
  level: LogLevel;
  /** Which part of the app wrote it: activity, error, journal, backup, restore, reconnect, page. */
  source: string;
  text: string;
  /** True for entries kept from before the page was last loaded. */
  before?: boolean;
}

export interface LogStorage {
  getItem(name: string): string | null;
  setItem(name: string, value: string): void;
  removeItem(name: string): void;
}

export interface LogOptions {
  storage?: LogStorage | null;
  now?: () => number;
  /** Entries kept in memory. */
  cap?: number;
  /** Entries kept across a reload. */
  keep?: number;
  /** A step message from one job is written at most this often. */
  throttleMs?: number;
  /** Wait this long after a step before saving, so progress does not write storage every time. */
  saveDelayMs?: number;
}

const STORAGE_NAME = 'opentunes.log';
const LONGEST_ENTRY = 600;

/** Hides serial numbers, FireWire IDs and API keys. Run on every text before it is stored or copied. */
export function maskSecrets(text: string, key = ''): string {
  return scrub(String(text), key)
    .replace(/\b(?:000A27|000A95)[0-9A-Fa-f]{10}\b/gi, '[ID hidden]')
    .replace(/\b(?:serial(?: number)?|firewire(?: ?id)?|guid)\s*[:=]\s*[0-9A-Za-z]{8,}/gi, (match) => `${match.split(/[:=]/)[0]}: [ID hidden]`);
}

export interface LogStore {
  add(level: LogLevel, source: string, text: string, options?: { flush?: boolean }): void;
  /** A progress message of a running job. Throttled per job, and a repeat is dropped. */
  step(jobKey: string | number, source: string, text: string): void;
  endJob(jobKey: string | number): void;
  entries(): LogEntry[];
  /** Errors written since the person last opened the log. */
  unseenErrors(): number;
  markSeen(): void;
  clear(): void;
  flush(): void;
  subscribe(listener: () => void): () => void;
}

interface Saved {
  version: 1;
  entries: { at: number; level: LogLevel; source: string; text: string }[];
}

const isLevel = (value: unknown): value is LogLevel => value === 'step' || value === 'ok' || value === 'error';

export function createLogStore(options: LogOptions = {}): LogStore {
  const now = options.now ?? Date.now;
  const cap = options.cap ?? 500;
  const keep = options.keep ?? 300;
  const throttleMs = options.throttleMs ?? 1500;
  const saveDelayMs = options.saveDelayMs ?? 400;
  const storage = options.storage ?? null;

  let list: LogEntry[] = [];
  let nextId = 1;
  let seenUpTo = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();
  const lastStep = new Map<string | number, { at: number; text: string }>();

  const emit = (): void => listeners.forEach((listener) => listener());

  function save(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (!storage) return;
    try {
      const entries = list.slice(-keep).map(({ at, level, source, text }) => ({ at, level, source, text }));
      const payload: Saved = { version: 1, entries };
      storage.setItem(STORAGE_NAME, JSON.stringify(payload));
    } catch {
      // Storage is full or blocked. The log still works for this visit.
    }
  }

  function scheduleSave(): void {
    if (!storage || timer !== null) return;
    timer = setTimeout(save, saveDelayMs);
  }

  // Entries from before this page load come first, marked, followed by a line saying the page loaded.
  if (storage) {
    try {
      const saved = JSON.parse(storage.getItem(STORAGE_NAME) ?? 'null') as Saved | null;
      if (saved && saved.version === 1 && Array.isArray(saved.entries)) {
        for (const entry of saved.entries.slice(-keep)) {
          if (typeof entry?.at !== 'number' || !isLevel(entry.level) || typeof entry.text !== 'string') continue;
          list.push({ id: nextId++, at: entry.at, level: entry.level, source: String(entry.source ?? ''), text: maskSecrets(entry.text), before: true });
        }
      }
    } catch {
      list = [];
    }
    seenUpTo = nextId - 1;
  }

  function push(level: LogLevel, source: string, text: string): void {
    const clean = maskSecrets(text).replace(/\s+/g, ' ').trim();
    list.push({ id: nextId++, at: now(), level, source, text: clean.length > LONGEST_ENTRY ? `${clean.slice(0, LONGEST_ENTRY)}...` : clean });
    if (list.length > cap) list = list.slice(list.length - cap);
  }

  return {
    add(level, source, text, opts = {}) {
      push(level, source, text);
      emit();
      if (opts.flush || level !== 'step') save();
      else scheduleSave();
    },
    step(jobKey, source, text) {
      const clean = text.trim();
      if (!clean) return;
      const last = lastStep.get(jobKey);
      const at = now();
      if (last && (last.text === clean || at - last.at < throttleMs)) return;
      lastStep.set(jobKey, { at, text: clean });
      push('step', source, clean);
      emit();
      scheduleSave();
    },
    endJob(jobKey) {
      lastStep.delete(jobKey);
    },
    entries: () => list,
    unseenErrors: () => list.filter((entry) => entry.level === 'error' && entry.id > seenUpTo).length,
    markSeen() {
      seenUpTo = nextId - 1;
      emit();
    },
    clear() {
      list = [];
      seenUpTo = nextId - 1;
      lastStep.clear();
      if (storage) {
        try {
          storage.removeItem(STORAGE_NAME);
        } catch {
          // nothing to do
        }
      }
      emit();
    },
    flush: save,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function browserStorage(): LogStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The page's own log. Created on first use, so tests that never touch it do not need a browser. */
let shared: LogStore | null = null;

export function log(): LogStore {
  if (!shared) {
    shared = createLogStore({ storage: typeof window === 'undefined' ? null : browserStorage() });
    shared.add('step', 'page', 'The page loaded.');
    if (typeof window !== 'undefined') {
      const flush = (): void => shared?.flush();
      window.addEventListener('pagehide', flush);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flush();
      });
    }
  }
  return shared;
}

/** For tests: swap the shared log. */
export function useLogStore(store: LogStore | null): void {
  shared = store;
}

export const logStep = (source: string, text: string): void => log().add('step', source, text);
export const logOk = (source: string, text: string): void => log().add('ok', source, text);
export const logError = (source: string, text: string): void => log().add('error', source, text);

export function formatLog(entries: LogEntry[]): string {
  const marks: Record<LogLevel, string> = { step: '...', ok: 'OK ', error: 'ERR' };
  return entries
    .map((entry) => `${new Date(entry.at).toISOString()} ${marks[entry.level]} [${entry.source}]${entry.before ? ' (before the reload)' : ''} ${entry.text}`)
    .join('\n');
}
