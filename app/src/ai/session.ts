import { useEffect, useState } from 'preact/hooks';
import type { AskResult } from './assistant';
import { browserStorage, defaultSettings, loadSettings, type KeyStore, type Settings } from './settings';

/**
 * What the assistant tab remembers while the page is open, so switching to another tab and back
 * does not lose the key, the opt-in or the conversation. It lives in this module's memory only:
 * a reload clears it (apart from what settings.ts saves, and only the key if asked).
 */

export interface Turn {
  id: number;
  request: string;
  /** Where the library went: the host the request was sent to. */
  host: string;
  scope: string;
  sentTracks: number;
  status: 'waiting' | 'done' | 'error';
  error?: string;
  result?: AskResult;
  /** "Title, Artist" for each track id the answer names, so the preview needs no library lookup. */
  labels: Record<number, string>;
  /** Ids of the edits and names of the playlists that are ticked. */
  selectedEdits: number[];
  selectedPlaylists: string[];
  /** The library the answer was made for. When the page reads a changed library, the turn is out of date. */
  libraryRef: unknown;
  applied?: { ok: boolean; message: string; lines: string[]; details: string[] };
}

export const session: {
  initialised: boolean;
  settings: Settings;
  keys: KeyStore;
  /** The opt-in to send the library. Off until ticked, and never saved. */
  optIn: boolean;
  turns: Turn[];
  nextId: number;
  /** The question typed but not sent. Kept while the page is open, and across a reload in this tab only. */
  draft: string;
  /** True when this tab used the assistant before the page was reloaded, so the clean start can be explained. */
  afterReload: boolean;
} = { initialised: false, settings: defaultSettings(), keys: {}, optIn: false, turns: [], nextId: 1, draft: '', afterReload: false };

const TOUCHED = 'opentunes.ai.touched';
const DRAFT = 'opentunes.ai.draft';

function tabStorage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** Notes, for this tab only, that the assistant was used, so a reload can say what it cleared. */
export function markTouched(): void {
  try {
    tabStorage()?.setItem(TOUCHED, '1');
  } catch {
    // nothing to do
  }
}

/** Keeps the unsent question for this tab (cleared when the tab closes). It is the person's own text, and goes nowhere. */
export function saveDraft(text: string): void {
  try {
    if (text) tabStorage()?.setItem(DRAFT, text);
    else tabStorage()?.removeItem(DRAFT);
  } catch {
    // nothing to do
  }
}

/** Loads saved settings once per page load. */
export function initSession(): typeof session {
  if (!session.initialised) {
    const loaded = loadSettings(browserStorage());
    session.settings = loaded.settings;
    session.keys = loaded.keys;
    try {
      session.afterReload = tabStorage()?.getItem(TOUCHED) === '1';
      session.draft = tabStorage()?.getItem(DRAFT) ?? '';
    } catch {
      session.afterReload = false;
    }
    session.initialised = true;
  }
  return session;
}

const watchers = new Set<() => void>();

/**
 * Tells every panel that reads the session that it changed (a key, the opt-in, a setting). Panels are
 * kept on screen when you look at another tab, so without this the Assistant and the duplicate finder
 * would each keep showing what the session held when they last drew.
 */
export function sessionChanged(): void {
  for (const watcher of [...watchers]) watcher();
}

/** Draws the calling panel again whenever the session changes anywhere. */
export function useSessionWatch(): void {
  const [, setVersion] = useState(0);
  useEffect(() => {
    const watcher = (): void => setVersion((version) => version + 1);
    watchers.add(watcher);
    return () => {
      watchers.delete(watcher);
    };
  }, []);
}
