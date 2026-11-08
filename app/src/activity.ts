import { useEffect, useState } from 'preact/hooks';
import type { PauseGate, PauseState } from '@opentunes/engine';

/**
 * What the page is busy with, so the person can always see that something is happening, how long
 * it has taken, and, while the iPod is being written to, that it must not be unplugged.
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
  /** Null when this job cannot be stopped from the bar. */
  stop: StopControl | null;
  /** Null when this job cannot be paused. */
  pause: PauseState | null;
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
const listeners = new Set<() => void>();
/** What each running activity does when told to stop, or to pause. Kept apart from the shown state. */
const stoppers = new Map<number, () => void>();
const gates = new Map<number, PauseGate>();
const emit = (): void => listeners.forEach((listener) => listener());

/** Closing the tab in the middle of a write is the one thing the page can warn about. */
function warnBeforeLeaving(event: BeforeUnloadEvent): void {
  event.preventDefault();
  event.returnValue = '';
}

function syncLeaveWarning(): void {
  if (typeof window === 'undefined') return;
  if (active.some((item) => item.writes)) window.addEventListener('beforeunload', warnBeforeLeaving);
  else window.removeEventListener('beforeunload', warnBeforeLeaving);
}

export interface ActivityHandle {
  readonly id: number;
  update(message: string): void;
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
    stop: stop ? { label: stop.label, confirm: stop.confirm ?? null, stopping: stop.stopping ?? 'Stopping...', blocked: stop.blocked ?? null, requested: false } : null,
    pause: options.pause ? options.pause.state : null,
  };
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
  syncLeaveWarning();
  emit();
  let ended = false;
  return {
    id: item.id,
    update(message: string): void {
      if (ended || message === '') return;
      change(item.id, (entry) => ({ ...entry, message }));
    },
    setBlocked(reason: string | null): void {
      if (ended) return;
      change(item.id, (entry) => (entry.stop && entry.stop.blocked !== reason ? { ...entry, stop: { ...entry.stop, blocked: reason } } : entry));
    },
    end(ok = true, detail?: string, stopped = false): void {
      if (ended) return;
      ended = true;
      unsubscribe?.();
      stoppers.delete(item.id);
      gates.delete(item.id);
      active = active.filter((entry) => entry.id !== item.id);
      // A finished read is not worth a banner. A finished write, a stop and any failure are.
      finished = item.writes || !ok || stopped || options.doneNote ? { label, ok, writes: item.writes, at: Date.now(), detail, stopped, note: options.doneNote } : finished;
      syncLeaveWarning();
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
  active = [];
  stoppers.clear();
  gates.clear();
  finished = null;
  syncLeaveWarning();
  emit();
}

export function currentActivity(): { active: Activity[]; finished: Finished | null } {
  return { active, finished };
}

export function useActivity(): { active: Activity[]; finished: Finished | null } {
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
