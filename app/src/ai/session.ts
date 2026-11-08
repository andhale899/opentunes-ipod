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
} = { initialised: false, settings: defaultSettings(), keys: {}, optIn: false, turns: [], nextId: 1 };

/** Loads saved settings once per page load. */
export function initSession(): typeof session {
  if (!session.initialised) {
    const loaded = loadSettings(browserStorage());
    session.settings = loaded.settings;
    session.keys = loaded.keys;
    session.initialised = true;
  }
  return session;
}
