/**
 * The engine's iPod functions, each wrapped so the page shows what it is doing: a label, the
 * current step and the time taken, and for anything that writes, a warning not to unplug. The
 * names are the engine's own, so a panel only changes where it imports them from.
 */
import * as engine from '@opentunes/engine';
import { startActivity } from './activity';

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;

const messageOf = (progress: unknown): string => {
  if (typeof progress === 'string') return progress;
  if (typeof progress === 'object' && progress !== null && typeof (progress as { message?: unknown }).message === 'string') return (progress as { message: string }).message;
  return '';
};

export function track<A extends unknown[], R>(label: string, writes: boolean, run: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return async (...args: A): Promise<R> => {
    const handle = startActivity(label, { writes });
    // The options object is always the last argument. If it carries an onProgress, listen in.
    const last = args[args.length - 1];
    const patched: unknown[] = [...args];
    if (isPlainObject(last) && typeof last.onProgress === 'function') {
      const original = last.onProgress as (progress: unknown) => void;
      patched[patched.length - 1] = {
        ...last,
        onProgress: (progress: unknown) => {
          handle.update(messageOf(progress));
          original(progress);
        },
      };
    }
    try {
      const result = await run(...(patched as A));
      handle.end(true);
      return result;
    } catch (error) {
      handle.end(false, error instanceof Error ? error.message : String(error));
      throw error;
    }
  };
}

export const planSync = track('Checking the iPod', false, engine.planSync);
export const applySync = track('Copying to the iPod', true, engine.applySync);
export const planRemoval = track('Checking the iPod', false, engine.planRemoval);
export const applyRemoval = track('Removing from the iPod', true, engine.applyRemoval);
export const planEdits = track('Checking the iPod', false, engine.planEdits);
export const editTracks = track('Saving changes to the iPod', true, engine.editTracks);
export const planPlaylistChanges = track('Checking the iPod', false, engine.planPlaylistChanges);
export const changePlaylists = track('Changing playlists on the iPod', true, engine.changePlaylists);
export const planWriteBack = track('Checking the iPod', false, engine.planWriteBack);
export const applyWriteBack = track('Writing the library to the iPod', true, engine.applyWriteBack);
export const restoreBackup = track('Restoring the backup to the iPod', true, engine.restoreBackup);
export const findOrphans = track('Looking for leftover files', false, engine.findOrphans);
export const removeOrphans = track('Deleting leftover files from the iPod', true, engine.removeOrphans);
export const backupIpod = track('Backing up the iPod', false, engine.backupIpod);
export const offloadIpod = track('Copying files off the iPod', false, engine.offloadIpod);
