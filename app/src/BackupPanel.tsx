import { useRef, useState } from 'preact/hooks';
import { formatBytes } from '@opentunes/core';
import { ScratchFolder, type BackupReport, type DirectoryEntry, type WritableDirectory } from '@opentunes/engine';
import { backupIpod } from './tracked';
import { ConfirmBox, Notice, useOnce } from './controls';
import { describeError, isStopped } from './describeError';
import { logError, logOk } from './log';

type State =
  | { phase: 'idle' }
  | { phase: 'working'; message: string }
  | { phase: 'done'; report: BackupReport; into: string }
  | { phase: 'error'; message: string };

type Picker = (options?: { mode?: 'read' | 'readwrite' }) => Promise<unknown>;

/**
 * Copies the iPod's library files to a folder on the computer, and checks the copy. This is
 * the safety net before anything is written to the iPod. It only reads the iPod, so it can be
 * stopped at any point: the iPod is not changed, and the half-made backup folder is marked unusable.
 */
export function BackupPanel({ source, onDone, inMemory = false }: { source: DirectoryEntry; onDone?: (report: BackupReport, destination?: WritableDirectory) => void; /** Keep the backup in memory, for the practice iPod. */ inMemory?: boolean }) {
  const [state, setState] = useState<State>({ phase: 'idle' });
  const [asking, setAsking] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const once = useOnce();

  async function run() {
    const picker = (window as unknown as { showDirectoryPicker?: Picker }).showDirectoryPicker;
    if (!picker && !inMemory) {
      setState({ phase: 'error', message: 'This browser has no folder picker. Use Chrome or Edge on a computer.' });
      return;
    }
    // Chrome shows its folder picker for a moment before it answers, long enough to click twice.
    await once(async () => {
      let destination: unknown;
      try {
        destination = inMemory ? new ScratchFolder('memory backup') : await (picker as Picker).call(window, { mode: 'readwrite' });
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) setState({ phase: 'error', message: describeError(error) });
        return;
      }

      const controller = new AbortController();
      abort.current = controller;
      setState({ phase: 'working', message: 'Starting the backup...' });
      try {
        const folder = destination as WritableDirectory;
        const report = await backupIpod(source, folder, { signal: controller.signal, onProgress: (message) => setState({ phase: 'working', message }) });
        setState({ phase: 'done', report, into: folder.name });
        if (report.stopped) logOk('backup', `The backup in "${report.folder}" was stopped and is marked incomplete.`);
        else if (report.complete) logOk('backup', `Backup complete: ${report.files} files in the folder "${report.folder}".`);
        else logError('backup', `The backup in "${report.folder}" is not complete.`);
        // A stopped backup is not a restore point. Any complete backup made earlier stays the one to use.
        if (!report.stopped) onDone?.(report, inMemory ? undefined : folder);
      } catch (error) {
        setState({ phase: 'error', message: isStopped(error) ? 'Stopped. The iPod was not changed.' : describeError(error) });
      } finally {
        abort.current = null;
        setAsking(false);
      }
    });
  }

  const working = state.phase === 'working';

  return (
    <section class="card">
      <h3>Back up the database files</h3>
      <p class="card-lead">
        Copies the iPod's library, device and artwork files to a folder on your computer, then reads every copy back to check it. No music is copied. The iPod is only read. Chrome may refuse Desktop, Documents or Downloads themselves. If it does, make a folder inside one, for example "iPod backups".
        {inMemory ? ' This is a practice iPod, so the backup is kept in memory and no folder is asked for.' : ''}
      </p>
      <div class="actions">
        <button type="button" onClick={() => void run()} disabled={working}>
          Choose where to keep the backup
        </button>
        {working && !asking ? (
          <button type="button" class="secondary" onClick={() => setAsking(true)}>
            Stop the backup
          </button>
        ) : null}
      </div>
      {asking && working ? (
        <ConfirmBox title="Stop the backup?" confirmLabel="Yes, stop the backup" cancelLabel="Keep going" onConfirm={() => { setAsking(false); abort.current?.abort(); }} onCancel={() => setAsking(false)}>
          <p>The backup folder will be left incomplete and cannot be used, and the iPod is not changed. Changes to the iPod stay off until a backup is complete.</p>
        </ConfirmBox>
      ) : null}

      {state.phase === 'working' ? (
        <p class="note" role="status">
          {state.message}
        </p>
      ) : null}
      {state.phase === 'error' ? (
        <Notice tone="no">
          <p>{state.message}</p>
        </Notice>
      ) : null}
      {state.phase === 'done' ? (
        <>
          <Notice tone={state.report.complete ? 'ok' : 'no'}>
            <p>
              {state.report.complete
                ? `Backed up ${state.report.files} files (${formatBytes(state.report.bytes)}) into "${state.into}" in the folder "${state.report.folder}". Every file was read back and matched.`
                : state.report.stopped
                  ? `Stopped. The backup in "${state.into}" in the folder "${state.report.folder}" is incomplete, so it cannot be used. The iPod was not changed. Back up again before changing the iPod.`
                  : `The backup in "${state.into}" in the folder "${state.report.folder}" is not complete. Do not rely on it.`}
            </p>
          </Notice>
          {state.report.failures.length && !state.report.stopped ? (
            <ul class="files">
              {state.report.failures.map((failure) => (
                <li key={failure}>{failure}</li>
              ))}
            </ul>
          ) : null}
          {state.report.left.filter((file) => file.reason === 'too large').map((file) => (
            <p class="muted" key={file.path}>
              {file.path} ({formatBytes(file.size)}) is too large to copy and was left out.
            </p>
          ))}
          <p class="muted">
            Keep the folder until you have checked that the iPod works after your changes. It holds a README.txt with how to put the files back, and backup-info.json with a checksum for each file. A few files the iPod does not need back, such as the radio buffer, are not copied.
          </p>
        </>
      ) : null}
    </section>
  );
}
