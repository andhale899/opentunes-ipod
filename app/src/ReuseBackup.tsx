import { useEffect, useState } from 'preact/hooks';
import { describeBackup, type BackupReport, type BackupSource, type DirectoryEntry, type WritableDirectory } from '@opentunes/engine';
import { ageText } from './backupReuse';
import { describeError } from './describeError';
import { loadBackupRecord, saveBackupRecord, type SavedBackup } from './handles';
import { regainAccess } from './ipodAccess';
import { logError, logOk } from './log';
import { checkEarlierBackupTracked } from './tracked';

/**
 * Remembers where a backup was made, so a reload does not lose it. Reads the backup's own
 * creation time so that a different folder put in its place is noticed later.
 */
export async function rememberBackup(report: BackupReport, destination: WritableDirectory, ipodName: string): Promise<void> {
  try {
    const folder = (await destination.getDirectoryHandle(report.folder)) as unknown as BackupSource;
    const summary = await describeBackup(folder);
    await saveBackupRecord({ destination, destinationName: destination.name, folder: report.folder, ipod: ipodName, madeAt: Date.now(), manifestCreatedAt: summary.createdAt });
  } catch (error) {
    logError('backup', `The backup folder could not be remembered: ${describeError(error)}`);
  }
}

type State = { phase: 'idle' } | { phase: 'working'; message: string } | { phase: 'refused'; message: string } | { phase: 'used'; message: string } | { phase: 'error'; message: string };

/**
 * "Use the backup I made earlier": after a reload, finds the backup this browser made, checks it
 * with the same checks a restore makes, compares it with the iPod as it is now, and counts it as
 * the backup for changes only if the iPod still matches it exactly. See backupReuse.ts for why.
 */
export function ReuseBackup({ ipodRoot, ipodName, backup, onUse }: { ipodRoot: DirectoryEntry; ipodName: string; backup: BackupReport | null; onUse: (report: BackupReport) => void }) {
  const [record, setRecord] = useState<SavedBackup | null>(null);
  const [state, setState] = useState<State>({ phase: 'idle' });

  useEffect(() => {
    void loadBackupRecord().then(setRecord);
  }, [backup]);

  if (!record || (backup?.complete && state.phase !== 'used')) return null;
  const known = record;

  async function use() {
    try {
      setState({ phase: 'working', message: 'Asking Chrome for access to the backup folder...' });
      if ((await regainAccess(known.destination, 'read')) !== 'granted') {
        setState({ phase: 'refused', message: `Chrome did not give access to the folder "${known.destinationName}". Try again and choose Allow, or make a new backup.` });
        logError('backup', 'Access to the earlier backup folder was not given.');
        return;
      }
      const result = await checkEarlierBackupTracked(known, ipodRoot, Date.now(), { onProgress: (message) => setState({ phase: 'working', message }) });
      if (result.decision.allowed && result.report) {
        logOk('backup', `The earlier backup "${known.folder}" passed the checks and counts as the backup.`);
        onUse(result.report);
        setState({ phase: 'used', message: result.decision.message });
      } else {
        logError('backup', `The earlier backup "${known.folder}" was not used: ${result.decision.reason}.`);
        setState({ phase: 'refused', message: result.decision.message });
      }
    } catch (error) {
      logError('backup', `The earlier backup could not be checked: ${describeError(error)}`);
      setState({ phase: 'error', message: `The earlier backup could not be checked: ${describeError(error)} Make a new backup.` });
    }
  }

  return (
    <section class="card reuse-backup">
      <h3>Use the backup I made earlier</h3>
      <p class="card-lead">
        This browser made a backup {ageText(known.madeAt, Date.now())} in the folder "{known.folder}" inside "{known.destinationName}". It can count as your backup again if it still passes every check and the iPod has not changed since. Otherwise make a new one below.
      </p>
      <button type="button" onClick={() => void use()} disabled={state.phase === 'working'}>
        Use the backup I made earlier
      </button>
      {state.phase === 'working' ? (
        <p class="note" role="status">
          {state.message}
        </p>
      ) : null}
      {state.phase === 'used' ? (
        <div class="result ok" role="status">
          <p>{state.message}</p>
        </div>
      ) : null}
      {state.phase === 'refused' || state.phase === 'error' ? (
        <div class="result no" role="alert">
          <p>{state.message}</p>
        </div>
      ) : null}
    </section>
  );
}
