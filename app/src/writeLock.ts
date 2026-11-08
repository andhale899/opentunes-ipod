/**
 * One change to the iPod at a time, across every panel, and no change while the iPod is being read
 * for a plan. Pure state with no browser calls, so it can be tested directly. `tracked.ts` takes
 * the lock around every engine function, and the page turns every control off while it is held.
 *
 * The lock is taken synchronously, before anything is awaited, so two clicks in the same moment
 * cannot both get in.
 */
import { useEffect, useState } from 'preact/hooks';

export class WriteBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WriteBusyError';
  }
}

interface Holder {
  id: number;
  label: string;
}

let nextId = 1;
let writer: Holder | null = null;
let readers: Holder[] = [];
const listeners = new Set<() => void>();
const emit = (): void => listeners.forEach((listener) => listener());

const lower = (label: string): string => label.charAt(0).toLowerCase() + label.slice(1);

/** Takes the write lock, or throws a plain message saying why not. Call the result to give it back. */
export function beginWrite(label: string): () => void {
  if (writer) {
    throw new WriteBusyError(`Another change to the iPod is already running (${lower(writer.label)}). Wait until it says it is done, then try again.`);
  }
  if (readers.length) {
    throw new WriteBusyError(`The iPod is still being read (${lower((readers[0] as Holder).label)}). Wait for that to finish, then try again, so the change is made from what the iPod holds now.`);
  }
  const holder: Holder = { id: nextId++, label };
  writer = holder;
  emit();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (writer?.id === holder.id) writer = null;
    emit();
  };
}

/** Notes that the iPod is being read. Refused while a change is running. Call the result when done. */
export function beginRead(label: string): () => void {
  if (writer) {
    throw new WriteBusyError(`The iPod is being changed right now (${lower(writer.label)}). Wait until it says it is done, then try again.`);
  }
  const holder: Holder = { id: nextId++, label };
  readers = [...readers, holder];
  emit();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    readers = readers.filter((entry) => entry.id !== holder.id);
    emit();
  };
}

export interface LockState {
  /** The change that is running, or null. */
  writing: string | null;
  reading: string[];
}

export function lockState(): LockState {
  return { writing: writer?.label ?? null, reading: readers.map((entry) => entry.label) };
}

export function isWriting(): boolean {
  return writer !== null;
}

/**
 * Why buttons that change the iPod are off while the iPod is being read (a backup, a copy, a read of
 * the iPod, a check), or null when nothing is. A change would be refused anyway, with a message only
 * after the click, so the page says it up front. `reading` holds the running jobs' labels, oldest first.
 */
export function readBlockText(state: Pick<LockState, 'reading'>): string | null {
  const job = state.reading[0];
  if (job === undefined) return null;
  return `Off while "${job}" is running. Wait for it or stop it from the bar above.`;
}

/** For tests. */
export function resetLock(): void {
  writer = null;
  readers = [];
  emit();
}

export function useLockState(): LockState {
  const [, setTick] = useState(0);
  useEffect(() => {
    const listener = (): void => setTick((tick) => tick + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return lockState();
}

/** For a panel: the reason its write buttons are off because a read job is running, redrawn as jobs start and end. Null when they can be used. */
export function useReadBlock(): string | null {
  return readBlockText(useLockState());
}

/**
 * The same rule across browser tabs, so two tabs cannot change one iPod at once. Uses the Web Locks
 * API where there is one. The lock is held until the returned function is called, and the browser
 * lets go of it by itself when the tab closes or reloads. Returns null when this browser has no
 * locks (the in-page rule still holds), and throws WriteBusyError when another tab holds it.
 */
export const TAB_LOCK_NAME = 'opentunes-ipod-write';

export interface LocksLike {
  request(name: string, options: { ifAvailable: true; mode: 'exclusive' }, callback: (lock: unknown) => Promise<void> | void): Promise<unknown>;
  query?(): Promise<{ held?: { name?: string }[] }>;
}

export async function takeTabLock(locks: LocksLike | undefined): Promise<(() => void) | null> {
  if (!locks) return null;
  let release: () => void = () => undefined;
  let granted!: (value: boolean) => void;
  const answer = new Promise<boolean>((resolve) => {
    granted = resolve;
  });
  void locks
    .request(TAB_LOCK_NAME, { ifAvailable: true, mode: 'exclusive' }, (lock) => {
      if (!lock) {
        granted(false);
        return;
      }
      granted(true);
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    })
    .catch(() => granted(true)); // a browser that refuses the call must not stop a change
  if (!(await answer)) {
    throw new WriteBusyError('Another OpenTunes tab is changing an iPod right now. Wait until it is done, or close that tab, then try again.');
  }
  return () => release();
}

/** True when some tab (this one included) holds the cross-tab lock now. */
export async function tabLockHeld(locks: LocksLike | undefined): Promise<boolean> {
  try {
    const state = await locks?.query?.();
    return Boolean(state?.held?.some((entry) => entry.name === TAB_LOCK_NAME));
  } catch {
    return false;
  }
}
