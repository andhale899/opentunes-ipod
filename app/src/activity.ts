import { useEffect, useState } from 'preact/hooks';

/**
 * What the page is busy with, so the person can always see that something is happening, how long
 * it has taken, and, while the iPod is being written to, that it must not be unplugged.
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
const listeners = new Set<() => void>();
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
  update(message: string): void;
  end(ok?: boolean, detail?: string): void;
}

/** Starts showing an activity. Call `end` in a `finally` so the bar never gets stuck. */
export function startActivity(label: string, options: { writes?: boolean; message?: string } = {}): ActivityHandle {
  const item: Activity = { id: nextId++, label, message: options.message ?? '', writes: options.writes ?? false, startedAt: Date.now() };
  active = [...active, item];
  // The refresh after a write is a read, and must not wipe the 'safe to eject' notice.
  if (item.writes) finished = null;
  syncLeaveWarning();
  emit();
  let ended = false;
  return {
    update(message: string): void {
      if (ended || message === '') return;
      active = active.map((entry) => (entry.id === item.id ? { ...entry, message } : entry));
      emit();
    },
    end(ok = true, detail?: string): void {
      if (ended) return;
      ended = true;
      active = active.filter((entry) => entry.id !== item.id);
      // A finished read is not worth a banner. A finished write, and any failure, is.
      finished = item.writes || !ok ? { label, ok, writes: item.writes, at: Date.now(), detail } : finished;
      syncLeaveWarning();
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
  active = [];
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
