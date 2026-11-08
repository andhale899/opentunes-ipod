/**
 * The last backup, found and checked for you when an iPod is opened.
 *
 * The page remembers where it kept the last backup of an iPod folder (by the folder's name, as a
 * folder handle in IndexedDB, see handles.ts). When that iPod is opened again, this looks at it:
 *
 *  - Chrome's permission for the backup folder is already there: the backup is checked at once, with
 *    no click (complete, every file's SHA-256, and the iPod's library and device files compared with it).
 *  - Not yet: the page shows one button, "Check my last backup", and asks for permission from that click.
 *
 * The result is one of the `LastBackup` values below. Only a backup that matches is counted on its own.
 * When the iPod changed since an otherwise good backup, the person is offered both a new backup and
 * that older one, and the older one counts only after a confirm. Everything else (missing, damaged,
 * incomplete, another iPod's) is refused with the reason. See backupReuse.ts for the checks themselves.
 */
import { describeBackup, type BackupReport, type DirectoryEntry, type OffloadReport, type WritableDirectory } from '@opentunes/engine';
import { ageText, checkEarlierBackup, openFolderPath, type IpodComparison } from './backupReuse';
import { describeError } from './describeError';
import { saveBackupRecord, type SavedBackup } from './handles';
import type { PermissionMode } from './ipodAccess';
import { logError } from './log';

/** What this iPod's last backup turned out to be. */
export type LastBackup =
  /** Nothing is remembered for this iPod, or this is not a real iPod folder. */
  | { status: 'none' }
  | { status: 'checking'; record: SavedBackup }
  /** Chrome has not (yet) given this page access to the folder. A click is needed. */
  | { status: 'needs-permission'; record: SavedBackup; /** Set when the person was asked and Chrome did not give access. */ refused?: string }
  /** Complete, undamaged and the iPod is exactly as it was. */
  | { status: 'matches'; record: SavedBackup; report: BackupReport }
  /** A good backup, but the iPod changed since. `changes` says what, in words. The person chooses. */
  | { status: 'differs'; record: SavedBackup; report: BackupReport; changes: string; message: string }
  /** Cannot be used, and cannot be chosen: `reason` says why in one word, `message` in a sentence. */
  | { status: 'problem'; record: SavedBackup; reason: 'missing' | 'damaged' | 'incomplete' | 'other-ipod' | 'unreadable'; message: string };

export type FolderPermission = 'granted' | 'prompt' | 'denied';

interface PermissionHandle {
  queryPermission?: (descriptor: { mode: PermissionMode }) => Promise<FolderPermission>;
}

/**
 * What Chrome says about a kept folder right now, without asking. A handle with no way to ask (the
 * browser's private storage, a test double) counts as granted: there is no prompt to wait for.
 */
export async function permissionNow(handle: unknown, mode: PermissionMode = 'read'): Promise<FolderPermission> {
  const target = handle as PermissionHandle;
  if (typeof target?.queryPermission !== 'function') return 'granted';
  try {
    return await target.queryPermission({ mode });
  } catch {
    return 'prompt';
  }
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

/** "A day and time" the way the page says it, in the person's own locale. */
export function dateText(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** What differs on the iPod, in words a person uses: the library, the device files, the artwork. */
export function describeChanges(comparison: IpodComparison): string {
  const all = [...comparison.changed, ...comparison.missing, ...comparison.added];
  const area = (path: string): 'library' | 'device' | 'artwork' | 'other' =>
    path.startsWith('iPod_Control/iTunes/') ? 'library' : path.startsWith('iPod_Control/Device/') ? 'device' : path.startsWith('iPod_Control/Artwork/') ? 'artwork' : 'other';
  const counts = { library: 0, device: 0, artwork: 0, other: 0 };
  for (const path of all) counts[area(path)] += 1;
  const parts = [
    counts.library ? `the library (${plural(counts.library, 'file')})` : '',
    counts.device ? `the device files (${plural(counts.device, 'file')})` : '',
    counts.artwork ? `the album art (${plural(counts.artwork, 'file')})` : '',
    counts.other ? `other files (${counts.other})` : '',
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : 'nothing that could be named';
}

const looksMissing = (error: unknown): boolean => error instanceof Error && (error.name === 'NotFoundError' || /not found|could not be found/i.test(error.message));

/**
 * Checks a remembered backup against the iPod as it is now. `permission` is what Chrome said about
 * the backup folder, so the unprompted case (granted: go on) and the click case (not granted: ask)
 * are one decision. Reads only; never writes to the iPod or the backup. Never throws.
 */
export async function checkLastBackup(
  record: SavedBackup,
  ipodRoot: DirectoryEntry,
  options: { now: number; permission: FolderPermission; onProgress?: (message: string) => void },
): Promise<LastBackup> {
  if (options.permission !== 'granted') return { status: 'needs-permission', record };
  try {
    const result = await checkEarlierBackup(record, ipodRoot, options.now, { onProgress: options.onProgress });
    const { decision } = result;
    if (decision.allowed && result.report) return { status: 'matches', record, report: result.report };
    if (decision.reason === 'ipod-changed' && result.olderReport) {
      const changes = describeChanges(result.comparison);
      return {
        status: 'differs',
        record,
        report: result.olderReport,
        changes,
        message: `The iPod has changed since that backup was made (${ageText(record.madeAt, options.now)}, ${dateText(record.madeAt)}): ${changes} are different.`,
      };
    }
    if (decision.reason === 'different-ipod' || decision.reason === 'different-backup') return { status: 'problem', record, reason: 'other-ipod', message: decision.message };
    if (decision.reason === 'incomplete') return { status: 'problem', record, reason: 'incomplete', message: decision.message };
    return { status: 'problem', record, reason: 'damaged', message: decision.message };
  } catch (error) {
    if (looksMissing(error)) {
      return {
        status: 'problem',
        record,
        reason: 'missing',
        message: `The last backup is not there any more: the folder "${record.folder}" in "${record.destinationName}" was not found. It may have been moved, renamed or deleted, or its drive is not connected.`,
      };
    }
    const message = describeError(error);
    // The folder is there but is not a readable backup any more (its backup-info.json is gone or broken).
    if (/no backup-info\.json|backup-info\.json.*cannot be read|is not an iPod database backup/.test(message)) {
      return { status: 'problem', record, reason: 'damaged', message: `The last backup is damaged: ${message}` };
    }
    logError('backup', `The last backup could not be checked: ${message}`);
    return { status: 'problem', record, reason: 'unreadable', message: `The last backup could not be read: ${message}` };
  }
}

/**
 * Remembers where a backup was made, for the next time this iPod is opened. `report.folder` is a
 * name inside `destination`, or a path (for a full copy: its `database/` folder). Reads the backup's
 * own creation time so that a different folder put in its place is noticed later. Called after every
 * successful backup and full copy.
 */
export async function rememberBackup(report: BackupReport, destination: WritableDirectory, ipodName: string): Promise<void> {
  try {
    const folder = await openFolderPath(destination as never, report.folder);
    const summary = await describeBackup(folder);
    await saveBackupRecord({ destination, destinationName: destination.name, folder: report.folder, ipod: ipodName, madeAt: Date.now(), manifestCreatedAt: summary.createdAt });
  } catch (error) {
    logError('backup', `The backup folder could not be remembered: ${describeError(error)}`);
  }
}

/**
 * A finished copy's `database/` folder is a complete backup in exactly the format a backup has, so
 * it can stand in for one. Returns null when the copy was stopped or its library files were not
 * saved and checked (then there is no backup in it).
 */
export function backupReportFromOffload(report: OffloadReport): BackupReport | null {
  const database = report.database;
  if (report.stopped || report.databaseError || !database || !database.complete) return null;
  return {
    folder: `${report.folder}/${database.folder}`,
    files: database.files,
    bytes: database.bytes,
    verified: database.files,
    failures: [],
    left: [],
    complete: true,
    stopped: false,
  };
}

/** What the header chip and the Backup tab say about the backup this session counts. */
export type BackupInfo = { kind: 'made' | 'verified' | 'older'; madeAt: number };

export function chipText(info: BackupInfo | null): string {
  if (!info || info.kind === 'made') return 'Backup made';
  return info.kind === 'verified' ? `Backup from ${dateText(info.madeAt)} still matches this iPod` : `Older backup from ${dateText(info.madeAt)} in use`;
}
