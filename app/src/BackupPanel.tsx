import { useState } from 'preact/hooks';
import { formatBytes } from '@opentunes/core';
import { backupIpod, type BackupReport, type DirectoryEntry, type WritableDirectory } from '@opentunes/engine';
import { describeError } from './describeError';

type State =
  | { phase: 'idle' }
  | { phase: 'working'; message: string }
  | { phase: 'done'; report: BackupReport; into: string }
  | { phase: 'error'; message: string };

type Picker = (options?: { mode?: 'read' | 'readwrite' }) => Promise<unknown>;

/**
 * Copies the iPod's database files to a folder on the computer, and checks the copy. This is
 * the safety net before anything is written to the iPod. It only reads the iPod.
 */
export function BackupPanel({ source }: { source: DirectoryEntry }) {
  const [state, setState] = useState<State>({ phase: 'idle' });

  async function run() {
    const picker = (window as unknown as { showDirectoryPicker?: Picker }).showDirectoryPicker;
    if (!picker) {
      setState({ phase: 'error', message: 'This browser has no folder picker.' });
      return;
    }
    let destination: unknown;
    try {
      destination = await picker.call(window, { mode: 'readwrite' });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) setState({ phase: 'error', message: describeError(error) });
      return;
    }

    setState({ phase: 'working', message: 'Starting the backup...' });
    try {
      const folder = destination as WritableDirectory;
      const report = await backupIpod(source, folder, { onProgress: (message) => setState({ phase: 'working', message }) });
      setState({ phase: 'done', report, into: folder.name });
    } catch (error) {
      setState({ phase: 'error', message: describeError(error) });
    }
  }

  const working = state.phase === 'working';

  return (
    <section class="card">
      <h3>Back up the database files</h3>
      <p class="muted">
        Copies the iPod's library, device and artwork files to a folder on your computer, then reads every copy back to check it. No music is copied. The iPod is only read. Chrome may refuse Desktop, Documents or Downloads themselves. If it does, make a folder inside one, for example "iPod backups".
      </p>
      <button type="button" onClick={() => void run()} disabled={working}>
        Choose where to keep the backup
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
      {state.phase === 'done' ? (
        <>
          <div class={`result ${state.report.complete ? 'ok' : 'no'}`} role={state.report.complete ? 'status' : 'alert'}>
            <p>
              {state.report.complete
                ? `Backed up ${state.report.files} files (${formatBytes(state.report.bytes)}) into "${state.into}" in the folder "${state.report.folder}". Every file was read back and matched.`
                : `The backup in "${state.into}" in the folder "${state.report.folder}" is not complete. Do not rely on it.`}
            </p>
          </div>
          {state.report.failures.length ? (
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
            Keep the folder until a sync has been tested on the iPod. It holds a README.txt with how to put the files back, and backup-info.json with a checksum for each file. Files libgpod never opens, such as the radio buffer, are not copied.
          </p>
        </>
      ) : null}
    </section>
  );
}
