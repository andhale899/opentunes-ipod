/**
 * The engine's iPod functions, each wrapped so the page shows what it is doing: a label, the
 * current step and the time taken, and for anything that writes, a warning not to unplug. The
 * names are the engine's own, so a panel only changes where it imports them from.
 */
import * as engine from '@opentunes/engine';
import { startActivity, type Progress } from './activity';
import { checkEarlierBackup } from './backupReuse';
import { describeError } from './describeError';
import { plainFailure } from './friendlyError';
import { beginWriteNote, endWriteNote, type WriteOutcome } from './journal';
import { logError } from './log';
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
const SYNC_PHASES: Record<string, number> = { checking: 0.02, database: 0.9, verifying: 0.95, deleting: 0.98, done: 1 };

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

/** What a finished write says about the iPod: fine, failed and fully undone, or in a state to check. */
export interface WriteVerdict {
  outcome: WriteOutcome;
  /** True when the change worked and was read back. */
  ok: boolean;
  /** One plain line for the bar when it did not work. */
  detail?: string;
  /** The same, for the note kept in the browser. */
  note?: string;
}

interface ReportLike {
  verified?: unknown;
  rolledBack?: unknown;
  rollbackFailures?: unknown;
  restoreNeeded?: unknown;
  failures?: unknown;
}

const reportIn = (result: unknown): ReportLike | null => {
  if (typeof result !== 'object' || result === null) return null;
  const direct = result as ReportLike & { report?: unknown };
  if (typeof direct.verified === 'boolean') return direct;
  const inner = direct.report as ReportLike | undefined;
  return inner && typeof inner === 'object' && typeof inner.verified === 'boolean' ? inner : null;
};

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((line): line is string => typeof line === 'string') : []);

/**
 * Reads the report an engine write returns. The engine reports a write that did not work (and was
 * rolled back) instead of throwing, so without this the bar would say "Done" for it.
 */
export function judgeWrite(result: unknown): WriteVerdict {
  const report = reportIn(result);
  if (!report) return { outcome: 'clean', ok: true };
  const failures = strings(report.failures);
  const rollbackFailures = strings(report.rollbackFailures);
  if (report.verified === true) {
    return failures.length || report.rolledBack === true ? { outcome: 'clean', ok: false, detail: failures[0] } : { outcome: 'clean', ok: true };
  }
  const first = failures[0] ?? 'The iPod could not be read back as expected.';
  const undone = report.rolledBack === true && rollbackFailures.length === 0 && report.restoreNeeded !== true;
  if (undone) return { outcome: 'undone', ok: false, detail: first };
  return {
    outcome: 'problem',
    ok: false,
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

export function track<A extends unknown[], R>(label: string, writes: boolean, run: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return async (...args: A): Promise<R> => {
    // Taken at once, before anything is awaited, so two clicks in the same moment cannot both get in.
    let releaseLock: () => void;
    try {
      releaseLock = writes ? beginWrite(label) : beginRead(label);
    } catch (error) {
      logError('activity', `${label} was not started: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
    const handle = startActivity(label, { writes });
    let releaseTab: (() => void) | null = null;
    let progressed = false;
    // The options object is always the last argument. If it carries an onProgress, listen in.
    const last = args[args.length - 1];
    const patched: unknown[] = [...args];
    if (isPlainObject(last) && typeof last.onProgress === 'function') {
      const original = last.onProgress as (progress: unknown) => void;
      patched[patched.length - 1] = {
        ...last,
        onProgress: (progress: unknown) => {
          progressed = true;
          handle.update(messageOf(progress), progressOf(progress));
          original(progress);
        },
      };
    }
    let noted = false;
    try {
      if (writes) {
        releaseTab = await takeTabLock(tabLocks());
        noted = true;
        await beginWriteNote(label);
      }
      const result = await run(...(patched as A));
      if (writes) {
        softenReport(result);
        const verdict = judgeWrite(result);
        handle.end(verdict.ok, verdict.detail);
        await endWriteNote(verdict.outcome, verdict.note);
      } else {
        handle.end(true);
      }
      return result;
    } catch (error) {
      const message = describeError(error, { writing: writes });
      handle.end(false, message);
      // Nothing reported means nothing was written, so a refusal before the first step leaves no note.
      if (noted) await endWriteNote(progressed ? 'problem' : 'undone', progressed ? `It stopped with an error: ${message}` : undefined);
      throw error;
    } finally {
      releaseTab?.();
      releaseLock();
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
export const restoreOffload = track('Putting everything back on the iPod', true, engine.restoreOffload);
export const checkEarlierBackupTracked = track('Checking the earlier backup', false, checkEarlierBackup);
