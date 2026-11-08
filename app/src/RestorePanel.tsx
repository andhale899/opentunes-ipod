import { useState } from 'preact/hooks';
import { formatBytes } from '@opentunes/core';
import { describeBackup, type BackupSource, type BackupSummary, type DirectoryEntry, type IpodRoot, type RestoreReport } from '@opentunes/engine';
import { restoreBackup } from './tracked';
import { describeError } from './describeError';
import { newEngine } from './engineLoader';
import { allowWriting } from './WriteBackPanel';
import { logError, logOk } from './log';

type State =
  | { phase: 'idle' }
  | { phase: 'working'; message: string }
  | { phase: 'chosen'; folder: BackupSource; summary: BackupSummary }
  | { phase: 'done'; report: RestoreReport }
  | { phase: 'error'; message: string };

type Picker = (options?: { mode?: 'read' | 'readwrite' }) => Promise<unknown>;

/**
 * Puts a backup's files back on the iPod, one by one. Every file is checked against its
 * checksum first, so a damaged backup changes nothing. Nothing on the iPod is deleted.
 */
export function RestorePanel({ root, onRestored }: { root: DirectoryEntry; /** Called after a restore, so the library on screen is read again. */ onRestored?: () => void }) {
  const [state, setState] = useState<State>({ phase: 'idle' });

  async function choose() {
    const picker = (window as unknown as { showDirectoryPicker?: Picker }).showDirectoryPicker;
    if (!picker) {
      setState({ phase: 'error', message: 'This browser has no folder picker.' });
      return;
    }
    let handle: unknown;
    try {
      handle = await picker.call(window, { mode: 'read' });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) setState({ phase: 'error', message: describeError(error) });
      return;
    }
    setState({ phase: 'working', message: 'Reading the backup...' });
    try {
      const folder = handle as BackupSource;
      setState({ phase: 'chosen', folder, summary: await describeBackup(folder) });
    } catch (error) {
      setState({ phase: 'error', message: describeError(error) });
    }
  }

  async function restore(folder: BackupSource) {
    try {
      if (!(await allowWriting(root))) {
        setState({ phase: 'error', message: 'Chrome was not allowed to change the iPod, so nothing was restored.' });
        return;
      }
      setState({ phase: 'working', message: 'Restoring...' });
      const report = await restoreBackup(root as unknown as IpodRoot, folder, { newEngine, onProgress: (message) => setState({ phase: 'working', message }) });
      setState({ phase: 'done', report });
      if (report.verified) logOk('restore', `Restored ${report.restored} files and the iPod reads back.`);
      else logError('restore', `The restore did not finish cleanly: ${report.failures[0] ?? 'see the list'}`);
      // The restore changed the iPod's library, so what the page shows must be read again.
      onRestored?.();
    } catch (error) {
      setState({ phase: 'error', message: describeError(error, { writing: true }) });
    }
  }

  const working = state.phase === 'working';

  return (
    <section class="card">
      <h3>Restore from a backup</h3>
      <p class="card-lead">
        Choose a backup folder made by this page (the one named opentunes-backup-...). Its files are checked against their checksums, then copied back over the same files on the iPod. Nothing is deleted, and your music is not touched.
      </p>
      <button type="button" onClick={() => void choose()} disabled={working}>
        Choose a backup folder
      </button>

      {state.phase === 'working' ? (
        <p class="note" role="status">
          {state.message}
        </p>
      ) : null}
      {state.phase === 'error' ? (
        <div class="result no" role="alert">
          <p>{state.message}</p>
        </div>
      ) : null}
      {state.phase === 'chosen' ? (
        <>
          <p>
            "{state.folder.name}" holds {state.summary.files} files ({formatBytes(state.summary.bytes)}), made {state.summary.createdAt ? new Date(state.summary.createdAt).toLocaleString() : 'at an unknown time'}.
          </p>
          <button type="button" onClick={() => void restore(state.folder)} disabled={working}>
            Restore these files to the iPod
          </button>
        </>
      ) : null}
      {state.phase === 'done' ? (
        <>
          <div class={`result ${state.report.verified ? 'ok' : 'no'}`} role={state.report.verified ? 'status' : 'alert'}>
            <p>
              {state.report.verified
                ? `Restored ${state.report.restored} files (${formatBytes(state.report.bytes)}). Each was read back and matched, and the iPod's database reads back. Eject it and check it.`
                : 'The restore did not finish cleanly. See below.'}
            </p>
          </div>
          {state.report.failures.length ? (
            <ul class="files">
              {state.report.failures.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
