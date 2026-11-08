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
import { startActivity, type Progress } from './activity';
import { checkEarlierBackup } from './backupReuse';
import { describeError } from './describeError';
import { plainFailure } from './friendlyError';
import { beginWriteNote, endWriteNote, type WriteOutcome } from './journal';
import { logError } from './log';
import { isStopped } from './stopped';
import { beginRead, beginWrite, takeTabLock, type LocksLike } from './writeLock';

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;

const messageOf = (progress: unknown): string => {
  if (typeof progress === 'string') return progress;
  if (typeof progress === 'object' && progress !== null && typeof (progress as { message?: unknown }).message === 'string') return (progress as { message: string }).message;
  return '';
};

const numberOf = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** Where the sync is, weighted by how long each phase usually takes, so the bar moves forward the whole way. */
const SYNC_PHASES: Record<string, number> = { checking: 0.02, artwork: 0.9, database: 0.9, verifying: 0.95, deleting: 0.98, done: 1 };

/** Reads how far along an engine report says things are, from the shapes the engine uses. Exported for tests. */
export function progressOf(progress: unknown): Progress | undefined {
  if (typeof progress !== 'object' || progress === null) return undefined;
  const report = progress as Record<string, unknown>;
  const bytesDone = numberOf(report.bytesDone);
  const bytesTotal = numberOf(report.bytesTotal);
  const speed = numberOf(report.bytesPerSecond);
  const phase = typeof report.phase === 'string' ? report.phase : '';
  if (bytesDone === null || bytesTotal === null) return undefined;
  if (phase === 'rolling-back') return undefined; // undoing has no way to say how long it will take

  // An offload reports files as well as bytes: copied so far over everything to copy.
  const filesDone = numberOf(report.filesDone);
  const filesTotal = numberOf(report.filesTotal);
  if (filesTotal !== null) {
    const fraction = bytesTotal > 0 ? bytesDone / bytesTotal : filesTotal > 0 ? (filesDone ?? 0) / filesTotal : undefined;
    if (fraction === undefined) return undefined;
    const left = speed !== null && speed > 0 && bytesTotal > bytesDone ? (bytesTotal - bytesDone) / speed : undefined;
    return { fraction, etaSeconds: left };
  }

  // A sync: copying is most of the time, then the database is written and read back.
  if (phase === 'copying') {
    const fraction = bytesTotal > 0 ? 0.04 + 0.86 * (bytesDone / bytesTotal) : 0.9;
    const left = speed !== null && speed > 0 && bytesTotal > bytesDone ? (bytesTotal - bytesDone) / speed + 15 : undefined;
    return { fraction, etaSeconds: left };
  }
  return phase in SYNC_PHASES ? { fraction: SYNC_PHASES[phase] } : undefined;
};

/**
 * What a finished job says about the iPod: fine, stopped cleanly, failed and fully undone, or in a
 * state to check. One reading serves both the bar (done, stopped, did not finish) and the note
 * kept in the browser for an interrupted write.
 */
export interface WriteVerdict {
  /** For the interrupted-write note: nothing to worry about, fully undone, or needs a look. */
  outcome: WriteOutcome;
  /** True when the job worked, or was stopped and left nothing half done. */
  ok: boolean;
  /** True when the person stopped it and what it had done was undone or left consistent. A stop is not a failure. */
  stopped: boolean;
  /** One plain line for the bar when it did not work, or what a stop left behind. */
  detail?: string;
  /** The same, for the note kept in the browser. */
  note?: string;
}

interface ReportLike {
  verified?: unknown;
  complete?: unknown;
  aborted?: unknown;
  stopped?: unknown;
  rolledBack?: unknown;
  rollbackFailures?: unknown;
  restoreNeeded?: unknown;
  failures?: unknown;
  summary?: unknown;
  /** A restore of an offload copy carries the report of its library restore here. */
  database?: unknown;
}

const reportIn = (result: unknown): ReportLike | null => {
  if (typeof result !== 'object' || result === null) return null;
  const shaped = (value: ReportLike): boolean => typeof value.verified === 'boolean' || typeof value.complete === 'boolean';
  const direct = result as ReportLike & { report?: unknown };
  if (shaped(direct)) return direct;
  const inner = direct.report as ReportLike | undefined;
  return inner && typeof inner === 'object' && shaped(inner) ? inner : null;
};

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((line): line is string => typeof line === 'string') : []);

/**
 * Reads the report an engine function returns. The engine reports a write that did not work (and
 * was rolled back) or a stop instead of throwing, so without this the bar would say "Done" for it.
 */
export function judgeWrite(result: unknown): WriteVerdict {
  const report = reportIn(result);
  if (!report) return { outcome: 'clean', ok: true, stopped: false };
  const failures = strings(report.failures);
  const rollbackFailures = strings(report.rollbackFailures);
  // A backup report has `verified` too, but as a count of files, so only a true or false means "read back".
  const verified = typeof report.verified === 'boolean' ? report.verified : undefined;
  const wasStopped = report.aborted === true || report.stopped === true;
  const undone = report.rolledBack === true && rollbackFailures.length === 0 && report.restoreNeeded !== true;
  // A stop that left the iPod as it was, or consistent, is not a failure, even though the run did not verify.
  if (wasStopped && rollbackFailures.length === 0 && report.restoreNeeded !== true) {
    return {
      outcome: report.rolledBack === true ? 'undone' : 'clean',
      ok: true,
      stopped: true,
      detail: report.rolledBack === true ? 'Everything it had done was undone.' : (failures[0] ?? 'What was done so far is kept.'),
    };
  }
  if (verified === true) {
    return failures.length || report.rolledBack === true ? { outcome: 'clean', ok: false, stopped: false, detail: failures[0] } : { outcome: 'clean', ok: true, stopped: false };
  }
  if (verified === undefined) {
    // Something that completes or does not, such as a backup, or putting an offload copy back (which carries its library restore).
    if (report.complete !== false) return { outcome: 'clean', ok: true, stopped: false };
    const detail = failures[0] ?? (typeof report.summary === 'string' ? report.summary : undefined);
    const library = typeof report.database === 'object' && report.database !== null ? judgeWrite(report.database) : null;
    // Files copied back are extra files nothing refers to until the library is restored, so only a failed library restore needs a look.
    return { outcome: library && !library.ok ? library.outcome : 'clean', ok: false, stopped: false, detail: library?.detail ?? detail, note: library?.note };
  }
  const first = failures[0] ?? 'The iPod could not be read back as expected.';
  if (undone) return { outcome: 'undone', ok: false, stopped: false, detail: first };
  return {
    outcome: 'problem',
    ok: false,
    stopped: false,
    detail: first,
    note: report.rolledBack === true ? 'Some files could not be put back.' : 'It stopped part way.',
  };
}

/** Puts Chrome's raw wording in the failure lists of a write's report into plain words, in place. */
function softenReport(result: unknown): void {
  const report = reportIn(result);
  if (!report) return;
  for (const name of ['failures', 'rollbackFailures'] as const) {
    const lines = report[name];
    if (Array.isArray(lines)) lines.forEach((line, index) => typeof line === 'string' && (lines[index] = plainFailure(line)));
  }
}

const tabLocks = (): LocksLike | undefined => (typeof navigator === 'undefined' ? undefined : (navigator as unknown as { locks?: LocksLike }).locks);

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

export function track<A extends unknown[], R>(label: string, writes: boolean, run: (...args: A) => Promise<R>, spec: TrackSpec = {}): (...args: A) => Promise<R> {
  let flying: { key: unknown; promise: Promise<R> } | null = null;
  const start = async (...args: A): Promise<R> => {
    // Taken at once, before anything is awaited, so two clicks in the same moment cannot both get in.
    let releaseLock: () => void;
    try {
      releaseLock = writes ? beginWrite(label) : beginRead(label);
    } catch (error) {
      logError('activity', `${label} was not started: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
    const stop = spec.stop;
    const controller = stop && !stop.unsupported ? new AbortController() : null;
    const at = stop?.at ?? args.length - 1;
    const given = args[at];
    const base: Record<string, unknown> = isPlainObject(given) ? given : {};
    const gate = spec.pause ? (base.pause instanceof PauseGate ? base.pause : new PauseGate()) : undefined;
    let blocked: string | null = stop?.unsupported ?? null;
    let releaseTab: (() => void) | null = null;
    let progressed = false;
    let noted = false;

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
          progressed = true;
          handle.update(messageOf(progress), progressOf(progress));
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
      if (writes) {
        releaseTab = await takeTabLock(tabLocks());
        noted = true;
        await beginWriteNote(label);
      }
      const result = await run(...(patched as A));
      softenReport(result);
      const verdict = judgeWrite(result);
      handle.end(verdict.ok, verdict.detail, verdict.stopped);
      if (writes) await endWriteNote(verdict.outcome, verdict.note);
      return result;
    } catch (error) {
      if (isStopped(error)) {
        // The engine throws a stop only before it has written anything.
        handle.end(true, undefined, true);
        if (noted) await endWriteNote('undone');
      } else {
        const message = describeError(error, { writing: writes });
        handle.end(false, message);
        // Nothing reported means nothing was written, so a refusal before the first step leaves no note.
        if (noted) await endWriteNote(progressed ? 'problem' : 'undone', progressed ? `It stopped with an error: ${message}` : undefined);
      }
      throw error;
    } finally {
      releaseTab?.();
      releaseLock();
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

/** Putting an offload copy back: Stop works while files are copied, and is off once the library files are being put back. */
export const restoreOffloadStop: StopSpec = {
  label: 'Stop (the library is not changed yet)',
  confirm: 'Stop? The files copied back so far stay on the iPod, but its library is not changed, so it stays as it was. You can run this again to finish.',
  stopping: 'Stopping after the pieces being copied. The iPod library is not changed.',
  at: 2,
  // The library files are written in one go at the end, and stopping halfway would leave a mix of old and restored files.
  blocked: (progress) =>
    typeof progress === 'object' && progress !== null && (progress as { phase?: string }).phase === 'restoring'
      ? 'This part cannot be stopped safely: the library files are being put back, and stopping halfway would leave a mix of old and restored files. It takes a few seconds.'
      : null,
};
export const restoreOffload = track('Putting everything back on the iPod', true, engine.restoreOffload, { pause: true, stop: restoreOffloadStop });
export const checkEarlierBackupTracked = track('Checking the earlier backup', false, checkEarlierBackup);
