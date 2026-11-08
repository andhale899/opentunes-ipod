import { useRef, useState } from 'preact/hooks';
import { formatBytes } from '@opentunes/core';
import { describeBackup, resolveBackupFolder, type BackupSource, type BackupSummary, type DirectoryEntry, type IpodRoot, type RestoreReport } from '@opentunes/engine';
import { restoreBackup } from './tracked';
import { WriteWait } from './BackupGate';
import { ConfirmBox, Notice, useOnce } from './controls';
import { describeError, isStopped } from './describeError';
import { newEngine } from './engineLoader';
import { allowWriting } from './WriteBackPanel';
import { useReadBlock } from './writeLock';
import { logError, logOk } from './log';

type State =
  | { phase: 'idle' }
  | { phase: 'working'; message: string; writing: boolean }
  | { phase: 'chosen'; folder: BackupSource; summary: BackupSummary; /** The full-copy folder the person chose, when the backup is in its database folder. */ via: string | null }
  | { phase: 'done'; report: RestoreReport }
  | { phase: 'error'; message: string };

type Picker = (options?: { mode?: 'read' | 'readwrite' }) => Promise<unknown>;

/**
 * Puts a backup's files back on the iPod, one by one. Every file is checked against its
 * checksum first, so a damaged backup changes nothing. Nothing on the iPod is deleted. It can be
 * stopped while the backup is being checked, but not once files are being written, because a stop
 * half way would leave a mix of old and restored files.
 */
export function RestorePanel({ root, onRestored }: { root: DirectoryEntry; /** Called after a restore, so the library on screen is read again. */ onRestored?: () => void }) {
  const [state, setState] = useState<State>({ phase: 'idle' });
  const abort = useRef<AbortController | null>(null);
  const once = useOnce();
  /** Why restoring is off while a read job runs, or null. */
  const wait = useReadBlock();

  async function choose() {
    const picker = (window as unknown as { showDirectoryPicker?: Picker }).showDirectoryPicker;
    if (!picker) {
      setState({ phase: 'error', message: 'This browser has no folder picker. Use Chrome or Edge on a computer.' });
      return;
    }
    await once(async () => {
      let handle: unknown;
      try {
        handle = await picker.call(window, { mode: 'read' });
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) setState({ phase: 'error', message: describeError(error) });
        return;
      }
      setState({ phase: 'working', message: 'Reading the backup...', writing: false });
      try {
        // A full-copy folder is accepted too: its database folder is the backup, so that is what is used.
        const { folder, via } = await resolveBackupFolder(handle as BackupSource);
        setState({ phase: 'chosen', folder, summary: await describeBackup(folder), via });
      } catch (error) {
        setState({ phase: 'error', message: describeError(error) });
      }
    });
  }

  async function restore(folder: BackupSource) {
    await once(async () => {
      try {
        // Chrome only shows its permission prompt straight from a click, so ask before anything else.
        if (!(await allowWriting(root))) {
          setState({ phase: 'error', message: 'Chrome was not allowed to change the iPod, so nothing was restored.' });
          return;
        }
        const controller = new AbortController();
        abort.current = controller;
        setState({ phase: 'working', message: 'Restoring...', writing: false });
        const report = await restoreBackup(root as unknown as IpodRoot, folder, {
          newEngine,
          signal: controller.signal,
          onProgress: (message, phase) => setState({ phase: 'working', message, writing: phase === 'writing' || phase === 'verifying' }),
        });
        setState({ phase: 'done', report });
        if (report.verified) logOk('restore', `Restored ${report.restored} files and the iPod reads back.`);
        else logError('restore', `The restore did not finish cleanly: ${report.failures[0] ?? 'see the list'}`);
        // The restore changed the iPod's library, so what the page shows must be read again.
        onRestored?.();
      } catch (error) {
        setState({ phase: 'error', message: isStopped(error) ? 'Stopped before anything was written. The iPod is exactly as it was.' : describeError(error, { writing: true }) });
      } finally {
        abort.current = null;
      }
    });
  }

  const working = state.phase === 'working';

  return (
    <section class="card">
      <h3>Restore from a backup</h3>
      <p class="card-lead">
        Choose a backup folder made by this page (the one named opentunes-backup-...). A full-copy folder (opentunes-offload-...) works too: its library folder is used. Files are checked against their checksums, then copied back over the same files on the iPod. Nothing is deleted, and your music is not touched.
      </p>
      <button type="button" onClick={() => void choose()} disabled={working}>
        Choose a backup folder
      </button>

      {state.phase === 'working' ? (
        <>
          <p class="note" role="status">
            {state.message}
          </p>
          {state.message !== 'Reading the backup...' ? (
            <div class="actions">
              <button type="button" class="secondary small" disabled={state.writing} onClick={() => abort.current?.abort()}>
                Stop (nothing is restored yet)
              </button>
              {state.writing ? <span class="note">This part cannot be stopped safely: stopping halfway would leave a mix of old and restored files. It takes a few seconds.</span> : null}
            </div>
          ) : null}
        </>
      ) : null}
      {state.phase === 'error' ? (
        <Notice tone="no">
          <p>{state.message}</p>
        </Notice>
      ) : null}
      {state.phase === 'chosen' ? (
        <ConfirmBox
          title="Put this backup back on the iPod?"
          confirmLabel="Restore these files to the iPod"
          cancelLabel="Do not restore"
          danger
          confirmDisabled={wait !== null}
          onConfirm={() => void restore(state.folder)}
          onCancel={() => setState({ phase: 'idle' })}
        >
          {state.via ? (
            <p>
              <strong>"{state.via}" is a full-copy folder.</strong> The backup of the library is in its folder "{state.folder.name}", so that is what is put back. This restores the library only: music and video files are not copied back. To copy those back too, use "Restore everything from a full copy" below.
            </p>
          ) : null}
          <p>
            "{state.folder.name}" holds {state.summary.files} files ({formatBytes(state.summary.bytes)}), made {state.summary.createdAt ? new Date(state.summary.createdAt).toLocaleString() : 'at an unknown time'}.
          </p>
          <p>
            This puts the iPod's library back to how it was at that time. Songs, playlists, ratings and play counts changed since then go back too. Songs added since then stay on the iPod but are no longer listed. Nothing is deleted and no music is touched.
          </p>
          <WriteWait wait={wait} />
          <p>
            It cannot be undone by itself. To keep a way back, make a backup of the iPod as it is now first (the button above), and restore that one if you change your mind. Once it starts writing it cannot be stopped, but it only takes a few seconds.
          </p>
        </ConfirmBox>
      ) : null}
      {state.phase === 'done' ? (
        <>
          <Notice tone={state.report.verified ? 'ok' : 'no'}>
            <p>
              {state.report.verified
                ? `Restored ${state.report.restored} files (${formatBytes(state.report.bytes)}). Each was read back and matched, and the iPod's library reads back. Eject it and check it.`
                : 'The restore did not finish cleanly. See below.'}
            </p>
          </Notice>
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
