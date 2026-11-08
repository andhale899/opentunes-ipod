import { useEffect, useState } from 'preact/hooks';
import { logError, logOk, logStep, log } from './log';
import { watchBackground, type BackgroundWatch } from './visibility';
import { createWakeLock, type WakeHandle, type WakeStatus } from './wakeLock';

/**
 * What the page is busy with, so the person can always see that something is happening, how long
 * it has taken, and, while the iPod is being written to, that it must not be unplugged.
 *
 * Every job counts, not only writes: closing or reloading the tab while a conversion, an offload,
 * a backup, a restore or a wait for the AI is under way asks first. A job also keeps the screen on
 * where the browser allows it, and notes when the tab went to the background.
 */
export interface Activity {
  id: number;
  label: string;
  /** The current step, as the engine reports it. Empty until it reports one. */
  message: string;
  /** True while this changes the iPod. */
  writes: boolean;
  startedAt: number;
}

export interface Finished {
  label: string;
  ok: boolean;
  writes: boolean;
  at: number;
  detail?: string;
}

let nextId = 1;
let active: Activity[] = [];
let finished: Finished | null = null;
let wakeStatus: WakeStatus = 'off';
const listeners = new Set<() => void>();
const emit = (): void => listeners.forEach((listener) => listener());

const hasDocument = typeof document !== 'undefined';

let wake: WakeHandle | null = null;
const wakeLock = (): WakeHandle => (wake ??= createWakeLock(typeof navigator === 'undefined' ? undefined : (navigator as never), hasDocument ? document : undefined, (status) => {
  wakeStatus = status;
  if (status === 'held') logStep('activity', 'The screen is being kept on while this runs.');
  else if (status === 'refused') logStep('activity', 'The browser would not keep the screen on. Keep it on yourself.');
  else if (status === 'unsupported') logStep('activity', 'This browser cannot keep the screen on. Keep it on yourself.');
  emit();
}));

let watcher: BackgroundWatch | null = null;
let stopWatching: (() => void) | null = null;
let originalTitle: string | null = null;

/** Closing the tab in the middle of a job is the one thing the page can warn about. */
function warnBeforeLeaving(event: BeforeUnloadEvent): void {
  event.preventDefault();
  event.returnValue = '';
}

/** Turns the page-wide helpers on when the first job starts and off when the last one ends. */
function syncJobHelpers(before: number): void {
  if (typeof window === 'undefined') return;
  if (active.length) window.addEventListener('beforeunload', warnBeforeLeaving);
  else window.removeEventListener('beforeunload', warnBeforeLeaving);

  if (before === 0 && active.length > 0) {
    void wakeLock().acquire();
    watcher = watchBackground(hasDocument ? document : undefined, Date.now, () => {
      if (hasDocument && document.visibilityState === 'hidden' && active.length) logStep('activity', 'The tab went to the background while a job was running.');
      emit();
    });
    stopWatching = watcher.start();
    if (hasDocument) {
      originalTitle = document.title;
      document.title = `Working... ${originalTitle}`;
    }
  } else if (before > 0 && active.length === 0) {
    void wakeLock().release();
    stopWatching?.();
    stopWatching = null;
    if (hasDocument && originalTitle !== null) document.title = originalTitle;
    originalTitle = null;
  }
}

export interface ActivityHandle {
  update(message: string): void;
  end(ok?: boolean, detail?: string): void;
}

const took = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, '0')} s`;
};

/** Starts showing an activity. Call `end` in a `finally` so the bar never gets stuck. */
export function startActivity(label: string, options: { writes?: boolean; message?: string } = {}): ActivityHandle {
  const item: Activity = { id: nextId++, label, message: options.message ?? '', writes: options.writes ?? false, startedAt: Date.now() };
  const before = active.length;
  active = [...active, item];
  // The refresh after a write is a read, and must not wipe the 'safe to eject' notice.
  if (item.writes) finished = null;
  syncJobHelpers(before);
  logStep('activity', `Started: ${label}${item.writes ? ' (changes the iPod)' : ''}.`);
  emit();
  let ended = false;
  return {
    update(message: string): void {
      if (ended || message === '') return;
      active = active.map((entry) => (entry.id === item.id ? { ...entry, message } : entry));
      log().step(item.id, 'activity', `${label}: ${message}`);
      emit();
    },
    end(ok = true, detail?: string): void {
      if (ended) return;
      ended = true;
      const count = active.length;
      active = active.filter((entry) => entry.id !== item.id);
      log().endJob(item.id);
      const duration = took(Date.now() - item.startedAt);
      if (ok) logOk('activity', `Finished: ${label} (took ${duration}).`);
      else logError('activity', `Did not finish: ${label} (after ${duration}).${detail ? ` ${detail}` : ''}`);
      // A finished read is not worth a banner. A finished write, and any failure, is.
      finished = item.writes || !ok ? { label, ok, writes: item.writes, at: Date.now(), detail } : finished;
      syncJobHelpers(count);
      emit();
    },
  };
}

export function dismissFinished(): void {
  finished = null;
  emit();
}

/** For tests. */
export function resetActivity(): void {
  const before = active.length;
  active = [];
  finished = null;
  syncJobHelpers(before);
  emit();
}

export interface ActivityState {
  active: Activity[];
  finished: Finished | null;
  /** Whether the screen is being kept on for the running job. */
  wake: WakeStatus;
  /** True when the tab was in the background at some point during the running job. */
  wasHidden: boolean;
  hiddenMs: number;
}

export function currentActivity(): ActivityState {
  return { active, finished, wake: wakeStatus, wasHidden: watcher?.wasHidden() ?? false, hiddenMs: watcher?.hiddenMs() ?? 0 };
}

export function useActivity(): ActivityState {
  const [, setTick] = useState(0);
  useEffect(() => {
    const listener = (): void => setTick((tick) => tick + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return currentActivity();
}
