/**
 * The quick backup (the iPod's library files, read back and checked) and what follows it: telling the
 * page it counts, and remembering the folder for the next time this iPod is opened. Shared by the Backup
 * panel and by the "Back up now" button in the notice that stands where a change is off for lack of a
 * backup, so both do exactly the same thing.
 */
import { ScratchFolder, type BackupReport, type DirectoryEntry, type WritableDirectory } from '@opentunes/engine';
import { rememberBackup } from './lastBackup';
import { logError, logOk } from './log';
import { backupIpod } from './tracked';

type Picker = (options?: { mode?: 'read' | 'readwrite' }) => Promise<unknown>;

/** Asks for the folder to keep the backup in, or makes a memory folder for the practice iPod. Returns null when the person closes the picker. Throws when the browser has no picker. */
export async function pickBackupFolder(inMemory: boolean): Promise<WritableDirectory | null> {
  if (inMemory) return new ScratchFolder('memory backup') as unknown as WritableDirectory;
  const picker = (window as unknown as { showDirectoryPicker?: Picker }).showDirectoryPicker;
  if (!picker) throw new Error('This browser has no folder picker. Use Chrome or Edge on a computer.');
  try {
    return (await picker.call(window, { mode: 'readwrite' })) as WritableDirectory;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return null;
    throw error;
  }
}

/** Runs the quick backup into `destination`, logs it, and tells `onDone` when it counts. Throws what the engine throws (a stop included). */
export async function runQuickBackup(
  source: DirectoryEntry,
  destination: WritableDirectory,
  options: { inMemory: boolean; signal?: AbortSignal; onProgress?: (message: string) => void; onDone?: (report: BackupReport) => void },
): Promise<BackupReport> {
  const report = await backupIpod(source, destination, { signal: options.signal, onProgress: options.onProgress });
  if (report.stopped) logOk('backup', `The backup in "${report.folder}" was stopped and is marked incomplete.`);
  else if (report.complete) logOk('backup', `Backup complete: ${report.files} files in the folder "${report.folder}".`);
  else logError('backup', `The backup in "${report.folder}" is not complete.`);
  // A stopped backup is not a restore point. Any complete backup made earlier stays the one to use.
  if (!report.stopped) {
    options.onDone?.(report);
    if (!options.inMemory && report.complete) await rememberBackup(report, destination, source.name);
  }
  return report;
}
