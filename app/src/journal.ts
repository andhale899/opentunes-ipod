/**
 * The interrupted-write journal. A note kept in the browser (not on the iPod) when a change to
 * the iPod starts, and removed when it ends cleanly. If the page is reloaded, closed, crashes or
 * loses the connection in the middle, the note is still there on the next load, and the page says
 * so, calmly, and points at the Diagnostics tab and the backup.
 *
 * What it holds: which operation, when, the iPod's folder name and the backup's folder name. Never
 * a serial number or FireWire ID, and never a track title.
 */
import { useEffect, useState } from 'preact/hooks';
import { kv } from './kv';
import { logError, logOk, logStep } from './log';
import { maskSecrets } from './log';

export type JournalStatus = 'running' | 'failed';

export interface WriteJournal {
  version: 1;
  /** Plain label of the operation, such as "Saving changes to the iPod". */
  operation: string;
  /** Milliseconds since 1970. */
  startedAt: number;
  /** The iPod's folder name, as the person picked it. */
  ipod: string;
  /** The folder name of the backup made before the change, or null if there was none. */
  backup: string | null;
  /** 'running' was never closed. 'failed' ended with a problem the page could not fully undo. */
  status: JournalStatus;
  /** For a practice iPod, which lives in memory and is gone after a reload. Such a note is dropped silently. */
  practice: boolean;
  /** One plain sentence, for a failed write. */
  note?: string;
}

export interface JournalContext {
  /** The open iPod's folder name, or null when none is open. */
  ipod: string | null;
  backup: string | null;
  practice: boolean;
}

const KEY = 'write-journal';
const clean = (text: string): string => maskSecrets(text).slice(0, 200);

/** Builds a journal entry. Pure. Folder names are masked in case one is shaped like an ID. */
export function makeJournal(operation: string, startedAt: number, context: JournalContext): WriteJournal {
  return {
    version: 1,
    operation: clean(operation),
    startedAt,
    ipod: clean(context.ipod ?? 'the iPod'),
    backup: context.backup === null ? null : clean(context.backup),
    status: 'running',
    practice: context.practice,
  };
}

/** Reads a stored value back into an entry, keeping only the known fields. Null when it is not one. */
export function parseJournal(raw: unknown): WriteJournal | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (value.version !== 1 || typeof value.operation !== 'string' || typeof value.startedAt !== 'number' || typeof value.ipod !== 'string') return null;
  return {
    version: 1,
    operation: clean(value.operation),
    startedAt: value.startedAt,
    ipod: clean(value.ipod),
    backup: typeof value.backup === 'string' ? clean(value.backup) : null,
    status: value.status === 'failed' ? 'failed' : 'running',
    practice: value.practice === true,
    ...(typeof value.note === 'string' ? { note: clean(value.note) } : {}),
  };
}

const lowerFirst = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1);

/** "14:05" for today, otherwise the date as well. */
export function whenText(at: number, now: number, locale?: string): string {
  const date = new Date(at);
  const today = new Date(now);
  const sameDay = date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
  const time = date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  return sameDay ? time : `${date.toLocaleDateString(locale, { day: 'numeric', month: 'short' })} ${time}`;
}

/** The sentence the banner shows. */
export function bannerText(entry: WriteJournal, now: number, locale?: string): string {
  const what = lowerFirst(entry.operation);
  const when = whenText(entry.startedAt, now, locale);
  if (entry.status === 'failed') {
    return `The last change to the iPod did not finish cleanly (it was ${what} at ${when}). ${entry.note ?? 'It was undone where it could be.'} Check the iPod: open it here and look at the Diagnostics tab, and if it looks wrong restore your backup.`;
  }
  return `The last change to the iPod did not finish (it was ${what} at ${when}). Check the iPod: open it here and look at the Diagnostics tab, and if it looks wrong restore your backup.`;
}

// ------------------------------------------------------------------------- the live state

interface State {
  /** The note left on disk, whether from an earlier page load or from a change that ended badly. */
  entry: WriteJournal | null;
  /** True while a change started by this page is still running. The banner stays hidden then. */
  inFlight: boolean;
}

let state: State = { entry: null, inFlight: false };
let context: JournalContext = { ipod: null, backup: null, practice: false };
const listeners = new Set<() => void>();
const emit = (): void => listeners.forEach((listener) => listener());

export function setJournalContext(next: JournalContext): void {
  context = next;
}

export function journalState(): State {
  return state;
}

async function store(entry: WriteJournal | null): Promise<void> {
  try {
    const db = await kv();
    if (entry) await db.set(KEY, entry);
    else await db.delete(KEY);
  } catch (error) {
    logError('journal', `The interrupted-write note could not be saved in this browser: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Writes the note before a change starts. A browser that refuses must not stop the change, so this never throws. */
export async function beginWriteNote(operation: string, now = Date.now()): Promise<void> {
  const entry = makeJournal(operation, now, context);
  state = { entry, inFlight: true };
  emit();
  logStep('journal', `A change started and was noted in this browser: ${entry.operation}.`);
  await store(entry);
}

export type WriteOutcome = 'clean' | 'undone' | 'problem';

/**
 * Closes the note. A clean finish, or a failure that was fully undone, removes it. A problem the
 * page could not undo keeps it, marked failed, with one sentence about it.
 */
export async function endWriteNote(outcome: WriteOutcome, note?: string): Promise<void> {
  const current = state.entry;
  if (outcome === 'problem' && current) {
    const failed: WriteJournal = { ...current, status: 'failed', ...(note ? { note: clean(note) } : {}) };
    state = { entry: failed, inFlight: false };
    emit();
    logError('journal', `The change did not finish cleanly and the note was kept: ${failed.operation}.`);
    await store(failed);
    return;
  }
  state = { entry: null, inFlight: false };
  emit();
  logOk('journal', outcome === 'undone' ? 'The change failed and was undone. The note was cleared.' : 'The change finished. The note was cleared.');
  await store(null);
}

/** Looks for a note left by an earlier page load. Call once at the start. */
export async function loadLeftBehind(options: { writeInProgressElsewhere?: () => Promise<boolean> } = {}): Promise<WriteJournal | null> {
  let found: WriteJournal | null = null;
  try {
    const db = await kv();
    found = parseJournal(await db.get(KEY));
    if (found && found.practice) {
      await db.delete(KEY);
      found = null;
    }
    // A note that is 'running' because another tab is changing the iPod right now is not left behind.
    if (found && found.status === 'running' && (await options.writeInProgressElsewhere?.())) found = null;
  } catch {
    found = null;
  }
  if (found) {
    state = { entry: found, inFlight: false };
    emit();
    logError('journal', `A change to the iPod was found that never finished: ${found.operation}${found.status === 'failed' ? ' (it ended with a problem)' : ''}.`);
  }
  return found;
}

export async function dismissJournal(): Promise<void> {
  if (state.entry) logStep('journal', 'The note about the unfinished change was dismissed.');
  state = { entry: null, inFlight: false };
  emit();
  await store(null);
}

/** For tests. */
export function resetJournal(): void {
  state = { entry: null, inFlight: false };
  context = { ipod: null, backup: null, practice: false };
  emit();
}

export function useJournal(): State {
  const [, setTick] = useState(0);
  useEffect(() => {
    const listener = (): void => setTick((tick) => tick + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return state;
}
