import { useEffect, useState } from 'preact/hooks';
import type { PauseGate, PauseState } from '@opentunes/engine';
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
/** The Stop button of an activity, and what it says will happen. */
export interface StopControl {
  /** Button text. It says what stopping does, such as "Stop and undo what was copied". */
  label: string;
  /** Asked before stopping. Null means stop at once. */
  confirm: string | null;
  /** Shown once Stop has been pressed, while the job winds down. */
  stopping: string;
  /** Null while stopping is allowed. Otherwise why it is not, in plain words. */
  blocked: string | null;
  /** True once Stop was pressed. */
  requested: boolean;
}

export interface Activity {
  id: number;
  label: string;
  /** The current step, as the engine reports it. Empty until it reports one. */
  message: string;
  /** True while this changes the iPod. */
  writes: boolean;
  startedAt: number;
  /** How far along it is, 0 to 1, when the step can tell. Null when it cannot. */
  fraction: number | null;
  /** A time left that the step itself worked out (for example from a copy speed), in seconds. */
  etaSeconds: number | null;
  /** When the first real progress arrived, and how far along it was then, for working out a pace. */
  progressSince: number | null;
  progressFrom: number;
  /** Null when this job cannot be stopped from the bar. */
  stop: StopControl | null;
  /** Null when this job cannot be paused. */
  pause: PauseState | null;
}

/** What a step can report besides its message. */
export interface Progress {
  fraction?: number;
  etaSeconds?: number;
}

export interface Finished {
  label: string;
  ok: boolean;
  writes: boolean;
  at: number;
  detail?: string;
  /** True when the person stopped it. A stop is not a failure. */
  stopped?: boolean;
  /** Where to see the result of a job that finished while the person may be on another tab. */
  note?: string;
}

/** What to offer for stopping a job. `run` is called when Stop is pressed and confirmed. */
export interface StopOptions {
  label: string;
  confirm?: string | null;
  stopping?: string;
  /** Set when there is a Stop button that cannot be used, and why. */
  blocked?: string | null;
  run: () => void;
}

let nextId = 1;
let active: Activity[] = [];
let finished: Finished | null = null;
let wakeStatus: WakeStatus = 'off';
const listeners = new Set<() => void>();
/** What each running activity does when told to stop, or to pause. Kept apart from the shown state. */
const stoppers = new Map<number, () => void>();
const gates = new Map<number, PauseGate>();
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

/** Work the page holds that a reload would lose, such as converted files not yet on the iPod. */
let heldWork = 0;

function syncLeaveWarning(): void {
  if (typeof window === 'undefined') return;
  if (active.length || heldWork > 0) window.addEventListener('beforeunload', warnBeforeLeaving);
  else window.removeEventListener('beforeunload', warnBeforeLeaving);
}

/**
 * Says the page is holding work that would be lost on a reload, so closing or reloading the tab
 * asks first. Returns the function that says it is gone. Safe to call more than once.
 */
export function holdWork(): () => void {
  let released = false;
  heldWork += 1;
  syncLeaveWarning();
  return () => {
    if (released) return;
    released = true;
    heldWork = Math.max(0, heldWork - 1);
    syncLeaveWarning();
  };
}

/** True while something is held that a reload would lose. For tests. */
export const isHoldingWork = (): boolean => heldWork > 0;

/** Turns the page-wide helpers on when the first job starts and off when the last one ends. */
function syncJobHelpers(before: number): void {
  if (typeof window === 'undefined') return;
  syncLeaveWarning();

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
  readonly id: number;
  update(message: string, progress?: Progress): void;
  /** Turns Stop off with a reason, or back on with null. */
  setBlocked(reason: string | null): void;
  /** Ends the activity. `stopped` marks a job the person stopped, which is not a failure. */
  end(ok?: boolean, detail?: string, stopped?: boolean): void;
}

export interface StartOptions {
  writes?: boolean;
  message?: string;
  stop?: StopOptions;
  /** Lets the person pause and resume through this gate. */
  pause?: PauseGate;
  /** Leaves a banner when the job ends, saying where its result is. For reads whose result sits in a tab. */
  doneNote?: string;
}

const took = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, '0')} s`;
};

const change = (id: number, patch: (item: Activity) => Activity): void => {
  active = active.map((entry) => (entry.id === id ? patch(entry) : entry));
  emit();
};

/** Starts showing an activity. Call `end` in a `finally` so the bar never gets stuck. */
export function startActivity(label: string, options: StartOptions = {}): ActivityHandle {
  const stop = options.stop;
  const item: Activity = {
    id: nextId++,
    label,
    message: options.message ?? '',
    writes: options.writes ?? false,
    startedAt: Date.now(),
    fraction: null,
    etaSeconds: null,
    progressSince: null,
    progressFrom: 0,
    stop: stop ? { label: stop.label, confirm: stop.confirm ?? null, stopping: stop.stopping ?? 'Stopping...', blocked: stop.blocked ?? null, requested: false } : null,
    pause: options.pause ? options.pause.state : null,
  };
  const before = active.length;
  if (stop) stoppers.set(item.id, stop.run);
  let unsubscribe: (() => void) | null = null;
  if (options.pause) {
    const gate = options.pause;
    gates.set(item.id, gate);
    unsubscribe = gate.subscribe(() => change(item.id, (entry) => ({ ...entry, pause: gate.state })));
  }
  active = [...active, item];
  // The refresh after a write is a read, and must not wipe the 'safe to eject' notice.
  if (item.writes) finished = null;
  syncJobHelpers(before);
  logStep('activity', `Started: ${label}${item.writes ? ' (changes the iPod)' : ''}.`);
  emit();
  let ended = false;
  return {
    id: item.id,
    update(message: string, progress?: Progress): void {
      if (ended) return;
      if (message === '' && !progress) return;
      active = active.map((entry) => {
        if (entry.id !== item.id) return entry;
        const next: Activity = { ...entry, message: message === '' ? entry.message : message };
        if (progress?.fraction !== undefined && Number.isFinite(progress.fraction)) {
          // Never go backwards: a bar that slides back looks broken.
          const fraction = Math.min(1, Math.max(entry.fraction ?? 0, progress.fraction));
          next.fraction = fraction;
          if (next.progressSince === null && fraction > 0) {
            next.progressSince = Date.now();
            next.progressFrom = fraction;
          }
        }
        next.etaSeconds = progress?.etaSeconds !== undefined && Number.isFinite(progress.etaSeconds) ? Math.max(0, progress.etaSeconds) : entry.etaSeconds;
        return next;
      });
      if (message !== '') log().step(item.id, 'activity', `${label}: ${message}`);
      emit();
    },
    setBlocked(reason: string | null): void {
      if (ended) return;
      change(item.id, (entry) => (entry.stop && entry.stop.blocked !== reason ? { ...entry, stop: { ...entry.stop, blocked: reason } } : entry));
    },
    end(ok = true, detail?: string, stopped = false): void {
      if (ended) return;
      ended = true;
      const count = active.length;
      unsubscribe?.();
      stoppers.delete(item.id);
      gates.delete(item.id);
      active = active.filter((entry) => entry.id !== item.id);
      log().endJob(item.id);
      const duration = took(Date.now() - item.startedAt);
      if (stopped) logOk('activity', `Stopped: ${label} (after ${duration}).${detail ? ` ${detail}` : ''}`);
      else if (ok) logOk('activity', `Finished: ${label} (took ${duration}).`);
      else logError('activity', `Did not finish: ${label} (after ${duration}).${detail ? ` ${detail}` : ''}`);
      // A finished read is not worth a banner. A finished write, a stop and any failure are.
      finished = item.writes || !ok || stopped || options.doneNote ? { label, ok, writes: item.writes, at: Date.now(), detail, stopped, note: options.doneNote } : finished;
      syncJobHelpers(count);
      emit();
    },
  };
}

/**
 * Presses Stop on an activity. Returns false when it cannot be stopped now (no Stop, a part that
 * cannot be stopped safely, or Stop was already pressed), so a caller never stops what it should not.
 */
export function requestStop(id: number): boolean {
  const entry = active.find((one) => one.id === id);
  const run = stoppers.get(id);
  if (!entry?.stop || !run || entry.stop.blocked !== null || entry.stop.requested) return false;
  change(id, (one) => (one.stop ? { ...one, stop: { ...one.stop, requested: true } } : one));
  run();
  return true;
}

/** Pauses after the files being worked on, or resumes. Does nothing for a job that cannot pause. */
export function togglePause(id: number): void {
  const gate = gates.get(id);
  if (!gate) return;
  if (gate.state === 'running') gate.request();
  else gate.resume();
}

export function dismissFinished(): void {
  finished = null;
  emit();
}

/** For tests. */
export function resetActivity(): void {
  const before = active.length;
  active = [];
  stoppers.clear();
  gates.clear();
  finished = null;
  heldWork = 0;
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

// ---------------------------------------------------------------- time left

/** How many seconds are probably left, or null while it is too early to tell. */
export function estimateRemaining(activity: Activity, now: number): number | null {
  if (activity.etaSeconds !== null) return activity.etaSeconds;
  if (activity.fraction === null || activity.progressSince === null) return null;
  const elapsed = (now - activity.progressSince) / 1000;
  const gained = activity.fraction - activity.progressFrom;
  // Under a few seconds, or a sliver of progress, any guess would swing wildly.
  if (elapsed < 4 || gained < 0.02) return null;
  return (elapsed * (1 - activity.fraction)) / gained;
}

/** 'about 2 min left', rounded the way a person would say it. */
export function formatRemaining(seconds: number): string {
  if (seconds < 8) return 'a few seconds left';
  if (seconds < 55) return `about ${Math.max(10, Math.round(seconds / 5) * 5)} seconds left`;
  const minutes = seconds / 60;
  if (minutes < 10) return `about ${Math.max(1, Math.round(minutes))} min left`;
  if (minutes < 60) return `about ${Math.round(minutes / 5) * 5} min left`;
  const hours = Math.floor(minutes / 60);
  const rest = Math.round((minutes - hours * 60) / 5) * 5;
  return rest === 60 ? `about ${hours + 1} h left` : `about ${hours} h${rest ? ` ${rest} min` : ''} left`;
}
