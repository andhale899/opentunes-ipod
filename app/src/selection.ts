/**
 * The tracks selected in the Library tab, kept in one small shared place so another tab can read
 * them (the backup panel offers "only the tracks I selected"). The Library tab writes to it; nothing
 * else does. Keys are the same track keys the Library uses (`trackKey`). When the library is read
 * again the Library tab prunes it, so a key of a track that is gone never lingers.
 */
import { useEffect, useState } from 'preact/hooks';
import { pruneSelection } from './staleness';

let current: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

const same = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => a.size === b.size && [...a].every((key) => b.has(key));

function replace(next: ReadonlySet<string>): void {
  if (same(current, next)) return;
  current = next;
  listeners.forEach((listener) => listener());
}

/** The Library tab's selection, as it is now. */
export const getLibrarySelection = (): ReadonlySet<string> => current;

/** The Library tab says what is selected. */
export const setLibrarySelection = (keys: Iterable<string>): void => replace(new Set(keys));

/** The library was read again: keep only keys that still name a track. */
export function pruneLibrarySelection(keys: Iterable<string>): void {
  replace(pruneSelection(new Set(current), keys));
}

export const clearLibrarySelection = (): void => replace(new Set());

export function subscribeLibrarySelection(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** For a panel: the selection, redrawn when it changes. */
export function useLibrarySelection(): ReadonlySet<string> {
  const [value, setValue] = useState<ReadonlySet<string>>(current);
  useEffect(() => {
    setValue(current);
    return subscribeLibrarySelection(() => setValue(current));
  }, []);
  return value;
}
