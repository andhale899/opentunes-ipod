/**
 * The engine's iPod functions, each wrapped so the page shows what it is doing: a label, the
 * current step and the time taken, for anything that writes a warning not to unplug, and where
 * the engine allows it a Stop (and a Pause between files) in the bar at the top. The names are the
 * engine's own, so a panel only changes where it imports them from.
 *
 * Stop goes through the engine's AbortSignal. The wrapper makes the signal itself, so a job can
 * still be stopped after the panel that started it has left the screen, and it only lets a stop
 * through while the engine can undo it: a stop pressed during the database write of a sync, or
 * while a restore is writing files, is ignored with the reason shown.
 */
import * as engine from '@opentunes/engine';
import { PauseGate } from '@opentunes/engine';
import { startActivity } from './activity';
import { isStopped } from './stopped';

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;

const messageOf = (progress: unknown): string => {
  if (typeof progress === 'string') return progress;
  if (typeof progress === 'object' && progress !== null && typeof (progress as { message?: unknown }).message === 'string') return (progress as { message: string }).message;
  return '';
};

/** What a job's Stop does, and whether this engine function can be stopped at all. */
export interface StopSpec {
  /** Button text. Says what stopping does. */
  label: string;
  /** Asked before stopping. Omit to stop at once. */
  confirm?: string;
  /** Shown once Stop is pressed. */
  stopping?: string;
  /** Which argument holds the options object. Defaults to the last one. */
  at?: number;
  /** For a progress report, why stopping is not safe right now, or null when it is. */
  blocked?: (progress: unknown, ...rest: unknown[]) => string | null;
  /** Set when the engine function cannot be stopped at all: Stop is shown off, with this reason. */
  unsupported?: string;
}

export interface TrackSpec {
  stop?: StopSpec;
  /** The function accepts a `pause` gate. The caller may pass its own in the options, else one is made. */
  pause?: boolean;
  /**
   * A second call with the same first argument while the first is still running gets the first
   * call's result instead of starting another job. This is the guard against a double click on a
   * button that starts a write.
   */
  joinSame?: boolean;
  /** Leaves a banner when the job ends, saying where its result is. */
  doneNote?: string;
}

/** What a finished job amounts to, read from the report the engine hands back. */
export interface Outcome {
  ok: boolean;
  stopped: boolean;
  detail?: string;
}

/**
 * The engine reports a rolled-back sync or a failed check as a result, not as an error, so the bar
 * must read the result to know whether the job worked, was stopped cleanly, or failed.
 */
export function outcomeOf(result: unknown): Outcome {
  const picked = isPlainObject(result) && isPlainObject(result.report) ? result.report : result;
  if (!isPlainObject(picked)) return { ok: true, stopped: false };
  const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((line): line is string => typeof line === 'string') : []);
  const failures = strings(picked.failures);
  const rollbackFailures = strings(picked.rollbackFailures);
  const stopped = picked.aborted === true || picked.stopped === true;
  // A stop that was undone cleanly is not a failure, even though the run did not verify.
  if (stopped && !rollbackFailures.length && picked.restoreNeeded !== true) {
    return { ok: true, stopped: true, detail: picked.rolledBack === true ? 'Everything it had done was undone.' : (failures[0] ?? 'What was done so far is kept.') };
  }
  let ok = true;
  if (picked.verified === false) ok = false;
  if (picked.complete === false) ok = false;
  if (picked.rolledBack === true) ok = false;
  if (rollbackFailures.length || picked.restoreNeeded === true) ok = false;
  return { ok, stopped: false, detail: ok ? undefined : (failures[0] ?? undefined) };
}

export function track<A extends unknown[], R>(label: string, writes: boolean, run: (...args: A) => Promise<R>, spec: TrackSpec = {}): (...args: A) => Promise<R> {
  let flying: { key: unknown; promise: Promise<R> } | null = null;
  const start = async (...args: A): Promise<R> => {
    const stop = spec.stop;
    const controller = stop && !stop.unsupported ? new AbortController() : null;
    const at = stop?.at ?? args.length - 1;
    const given = args[at];
    const base: Record<string, unknown> = isPlainObject(given) ? given : {};
    const gate = spec.pause ? (base.pause instanceof PauseGate ? base.pause : new PauseGate()) : undefined;
    let blocked: string | null = stop?.unsupported ?? null;

    const handle = startActivity(label, {
      writes,
      pause: gate,
      doneNote: spec.doneNote,
      stop: stop
        ? {
            label: stop.label,
            confirm: stop.confirm ?? null,
            stopping: stop.stopping,
            blocked,
            run: () => controller?.abort(),
          }
        : undefined,
    });

    const patched: unknown[] = [...args];
    const original = typeof base.onProgress === 'function' ? (base.onProgress as (progress: unknown, ...rest: unknown[]) => void) : null;
    if (controller || gate || original || stop?.blocked) {
      const next: Record<string, unknown> = { ...base };
      if (controller) next.signal = controller.signal;
      if (gate) next.pause = gate;
      // A caller's own Stop reaches the engine only while stopping is safe.
      const callers = base.signal instanceof AbortSignal ? base.signal : null;
      if (controller && callers) {
        const forward = (): void => {
          if (blocked === null) controller.abort();
          else handle.update(`Stop was ignored. ${blocked}`);
        };
        if (callers.aborted) controller.abort();
        else callers.addEventListener('abort', forward, { once: true });
      }
      if (original || stop?.blocked) {
        next.onProgress = (progress: unknown, ...rest: unknown[]) => {
          handle.update(messageOf(progress));
          if (stop?.blocked) {
            blocked = stop.blocked(progress, ...rest);
            handle.setBlocked(blocked);
          }
          original?.(progress, ...rest);
        };
      }
      patched[at] = next;
    }

    try {
      const result = await run(...(patched as A));
      const outcome = outcomeOf(result);
      handle.end(outcome.ok, outcome.detail, outcome.stopped);
      return result;
    } catch (error) {
      if (isStopped(error)) handle.end(true, undefined, true);
      else handle.end(false, error instanceof Error ? error.message : String(error));
      throw error;
    }
  };
  return (...args: A): Promise<R> => {
    if (spec.joinSame && flying && flying.key === args[0]) return flying.promise;
    const promise = start(...args);
    if (spec.joinSame) {
      const mine = { key: args[0], promise };
      flying = mine;
      const clear = (): void => {
        if (flying === mine) flying = null;
      };
      promise.then(clear, clear);
    }
    return promise;
  };
}

const cannotStop = 'This part cannot be stopped safely. It takes a few seconds.';
const databasePhases = ['database', 'verifying', 'rolling-back'];
const inDatabasePhase = (progress: unknown): string | null =>
  typeof progress === 'object' && progress !== null && databasePhases.includes((progress as { phase?: string }).phase ?? '') ? cannotStop : null;

/** A check that only reads: stopping changes nothing on the iPod. */
const readStop = (at: number): TrackSpec => ({
  stop: { label: 'Stop (the iPod is not changed)', stopping: 'Stopping. Nothing was written to the iPod.', at },
});

/** A change to the library: Stop works until the library starts to be written. */
const libraryStop = (what: string): TrackSpec => ({
  stop: {
    label: 'Stop (nothing is saved yet)',
    confirm: `Stop? Nothing has been changed on the iPod yet, so it stays exactly as it is. ${what}`,
    stopping: 'Stopping. Nothing was changed on the iPod.',
    at: 3,
    blocked: inDatabasePhase,
  },
});

export const planSync = track('Checking the iPod', false, engine.planSync, readStop(3));
export const applySync = track('Copying to the iPod', true, engine.applySync, {
  pause: true,
  joinSame: true,
  stop: {
    label: 'Stop and undo what was copied',
    confirm: 'Stop and undo? The files copied so far are taken off the iPod again, and its library goes back to exactly how it was before.',
    stopping: 'Stopping. Taking what was copied off the iPod again...',
    at: 3,
    blocked: inDatabasePhase,
  },
});
export const planRemoval = track('Checking the iPod', false, engine.planRemoval, readStop(3));
export const applyRemoval = track('Removing from the iPod', true, engine.applyRemoval, {
  stop: {
    label: 'Stop removing',
    confirm:
      'Stop? Before the library is written nothing changes. After that the tracks are already gone, and the song files not yet deleted stay on the iPod as leftover files, which "Look for leftover files" can delete later.',
    stopping: 'Stopping after the file being deleted.',
    at: 3,
    blocked: inDatabasePhase,
  },
});
export const planEdits = track('Checking the iPod', false, engine.planEdits, readStop(3));
export const editTracks = track('Saving changes to the iPod', true, engine.editTracks, libraryStop('Your edits are not saved.'));
export const planPlaylistChanges = track('Checking the iPod', false, engine.planPlaylistChanges, readStop(3));
export const changePlaylists = track('Changing playlists on the iPod', true, engine.changePlaylists, libraryStop('The playlist change is not made.'));
export const planWriteBack = track('Checking the iPod', false, engine.planWriteBack, readStop(2));
export const applyWriteBack = track('Writing the library to the iPod', true, engine.applyWriteBack, {
  stop: { label: 'Stop', stopping: 'Stopping...', unsupported: cannotStop },
});
export const restoreBackup = track('Restoring the backup to the iPod', true, engine.restoreBackup, {
  stop: {
    label: 'Stop (nothing is restored yet)',
    confirm: 'Stop? Nothing has been written to the iPod yet, so it stays exactly as it is.',
    stopping: 'Stopping. Nothing was written to the iPod.',
    at: 2,
    blocked: (_progress, phase) =>
      phase === 'writing' || phase === 'verifying' ? 'This part cannot be stopped safely: stopping halfway would leave a mix of old and restored files. It takes a few seconds.' : null,
  },
});
export const findOrphans = track('Looking for leftover files', false, engine.findOrphans, readStop(2));
export const removeOrphans = track('Deleting leftover files from the iPod', true, engine.removeOrphans, {
  stop: {
    label: 'Stop deleting (files not yet deleted stay)',
    stopping: 'Stopping after the file being deleted.',
    at: 3,
  },
});
export const backupIpod = track('Backing up the iPod', false, engine.backupIpod, {
  doneNote: 'The result is in the Backup tab.',
  stop: {
    label: 'Stop the backup',
    confirm: 'Stop the backup? The backup folder will be incomplete and cannot be used, and the iPod is not changed. Changes to the iPod stay off until a backup is complete.',
    stopping: 'Stopping after the file being copied.',
    at: 2,
  },
});
export const offloadIpod = track('Copying files off the iPod', false, engine.offloadIpod, {
  pause: true,
  doneNote: 'The result is in the Offload tab.',
  stop: {
    label: 'Stop (you can resume later)',
    stopping: 'Stopping after the pieces being copied. Copy again into the same folder to finish.',
    at: 3,
  },
});
