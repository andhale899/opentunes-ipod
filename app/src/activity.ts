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
  /** How far along it is, 0 to 1, when the step can tell. Null when it cannot. */
  fraction: number | null;
  /** A time left that the step itself worked out (for example from a copy speed), in seconds. */
  etaSeconds: number | null;
  /** When the first real progress arrived, and how far along it was then, for working out a pace. */
  progressSince: number | null;
  progressFrom: number;
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
  update(message: string, progress?: Progress): void;
  end(ok?: boolean, detail?: string): void;
}

/** Starts showing an activity. Call `end` in a `finally` so the bar never gets stuck. */
export function startActivity(label: string, options: { writes?: boolean; message?: string } = {}): ActivityHandle {
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
  };
  active = [...active, item];
  // The refresh after a write is a read, and must not wipe the 'safe to eject' notice.
  if (item.writes) finished = null;
  syncLeaveWarning();
  emit();
  let ended = false;
  return {
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
