import { createContext } from 'preact';
import { useContext, useState } from 'preact/hooks';
import type { BackupReport, DirectoryEntry } from '@opentunes/engine';
import { useOnce } from './controls';
import { describeError, isStopped } from './describeError';
import type { LastBackupControls } from './LastBackupLine';
import { dateText, type BackupInfo } from './lastBackup';
import { pickBackupFolder, runQuickBackup } from './quickBackup';
import { readBlockText, useLockState } from './writeLock';

/**
 * What the notice that stands where a change is off needs in order to make the backup right there:
 * the open iPod, whether it is the practice one (backup kept in memory), what to tell the page when a
 * backup counts, and the page's automatic check of the last backup. The Backup tab provides it.
 */
export interface BackupActions {
  source: DirectoryEntry;
  inMemory: boolean;
  /** A backup that counts for changes to the iPod was made. */
  onDone: (report: BackupReport) => void;
  /** An earlier backup found by the automatic check counts. */
  accept: (report: BackupReport, info: BackupInfo) => void;
  last: LastBackupControls;
}

export const BackupActionsContext = createContext<BackupActions | null>(null);

/** The line that says why the buttons that change the iPod are off while a read job (a backup, a copy, a read of the iPod) runs. */
export function WriteWait({ wait }: { wait: string | null }) {
  return wait ? (
    <p class="note write-wait" role="status">
      {wait}
    </p>
  ) : null;
}

type State = { phase: 'idle' } | { phase: 'working'; message: string } | { phase: 'error'; message: string };

/**
 * Stands where a change is off for lack of a backup, and makes the backup right there: "Back up now"
 * opens the folder picker and runs the quick library backup, then the header and the buttons come
 * on with no page change. When an earlier backup still matches this iPod the page has already counted
 * it and this shows nothing at all. While a read job runs it says that the buttons are off for that.
 */
export function BackupGate({ backup, onGo }: { backup: BackupReport | null; onGo?: () => void }) {
  const actions = useContext(BackupActionsContext);
  const wait = readBlockText(useLockState());
  const [state, setState] = useState<State>({ phase: 'idle' });
  const once = useOnce();

  if (backup !== null && backup.complete) return <WriteWait wait={wait} />;

  const last = actions?.last.state;
  if (last?.status === 'checking') {
    return (
      <p class="note write-wait" role="status">
        Checking your last backup before asking for a new one...
      </p>
    );
  }

  async function backUpNow() {
    if (!actions) return;
    await once(async () => {
      // The automatic check found a backup that matches: say so and count it, instead of making another.
      if (actions.last.state.status === 'matches') {
        const found = actions.last.state;
        actions.accept(found.report, { kind: 'verified', madeAt: found.record.madeAt });
        return;
      }
      let destination;
      try {
        // First thing in the click, so Chrome still shows its folder picker.
        destination = await pickBackupFolder(actions.inMemory);
      } catch (error) {
        setState({ phase: 'error', message: describeError(error) });
        return;
      }
      if (!destination) return;
      setState({ phase: 'working', message: 'Starting the backup...' });
      try {
        const report = await runQuickBackup(actions.source, destination, { inMemory: actions.inMemory, onProgress: (message) => setState({ phase: 'working', message }), onDone: actions.onDone });
        setState(
          report.complete
            ? { phase: 'idle' }
            : { phase: 'error', message: report.stopped ? 'The backup was stopped, so it does not count. The iPod was not changed.' : 'The backup did not complete, so it does not count. Try again, or open the Backup tab to see why.' },
        );
      } catch (error) {
        setState({ phase: 'error', message: isStopped(error) ? 'Stopped. The iPod was not changed.' : describeError(error) });
      }
    });
  }

  const working = state.phase === 'working';
  return (
    <div class="callout warn backup-gate" role="note">
      <p>
        <strong>Make a backup first.</strong> Changes to the iPod stay off until a complete backup exists from this session. The backup is what lets you undo a bad write.
      </p>
      {last?.status === 'needs-permission' ? (
        <p>This browser made a backup of this iPod on {dateText(last.record.madeAt)}. Check it with one click and, if the iPod has not changed since, no new backup is needed.</p>
      ) : null}
      {last?.status === 'differs' ? <p>Your last backup is out of date: {last.message} The Backup tab lets you use it anyway, after a warning.</p> : null}
      {actions ? (
        <div class="actions">
          <button type="button" onClick={() => void backUpNow()} disabled={working || wait !== null}>
            Back up now
          </button>
          {last?.status === 'needs-permission' ? (
            <button type="button" class="secondary" onClick={actions.last.checkNow} disabled={working}>
              Check my last backup
            </button>
          ) : null}
          {onGo ? (
            <button type="button" class="ghost small" onClick={onGo}>
              Backup options
            </button>
          ) : null}
        </div>
      ) : onGo ? (
        <div class="actions">
          <button type="button" class="secondary small" onClick={onGo}>
            Go to Backup
          </button>
        </div>
      ) : null}
      {working ? (
        <p class="note" role="status">
          {state.message}
        </p>
      ) : null}
      {state.phase === 'error' ? (
        <div class="result no" role="alert">
          <p>{state.message}</p>
        </div>
      ) : null}
      <WriteWait wait={wait} />
    </div>
  );
}
