import { useRef, useState } from 'preact/hooks';
import { formatBytes } from '@opentunes/core';
import { ScratchFolder, offloadIpod, type DirectoryEntry, type OffloadProgress, type OffloadReport, type WritableDirectory } from '@opentunes/engine';
import { describeError } from './describeError';
import { newEngine } from './engineLoader';

type State =
  | { phase: 'idle' }
  | { phase: 'working'; progress: OffloadProgress | null }
  | { phase: 'done'; report: OffloadReport; into: string }
  | { phase: 'error'; message: string };

type Picker = (options?: { mode?: 'read' | 'readwrite' }) => Promise<unknown>;

const SHOWN = 200;

/**
 * Copies every music file off the iPod to a folder on the computer, as it is, with a spreadsheet
 * of what each file is. It only reads the iPod. A stopped or partly failed copy can be finished by
 * running it again into the same folder: files already there are skipped.
 */
export function OffloadPanel({ source, inMemory = false }: { source: DirectoryEntry; /** Offer to copy into memory, for the practice iPod. */ inMemory?: boolean }) {
  const [state, setState] = useState<State>({ phase: 'idle' });
  const abort = useRef<AbortController | null>(null);
  /** The destination of the last run, kept so the rest can be copied into the same folder. */
  const last = useRef<WritableDirectory | null>(null);

  async function start(destination: WritableDirectory, resumeInto?: string) {
    const controller = new AbortController();
    abort.current = controller;
    last.current = destination;
    setState({ phase: 'working', progress: null });
    try {
      const report = await offloadIpod(source, destination, newEngine, {
        folder: resumeInto,
        signal: controller.signal,
        onProgress: (progress) => setState({ phase: 'working', progress }),
      });
      setState({ phase: 'done', report, into: destination.name });
    } catch (error) {
      setState({ phase: 'error', message: describeError(error) });
    } finally {
      abort.current = null;
    }
  }

  async function choose() {
    const picker = (window as unknown as { showDirectoryPicker?: Picker }).showDirectoryPicker;
    if (!picker) {
      setState({ phase: 'error', message: 'This browser has no folder picker. Use Chrome or Edge on a computer.' });
      return;
    }
    let destination: unknown;
    try {
      destination = await picker.call(window, { mode: 'readwrite' });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) setState({ phase: 'error', message: describeError(error) });
      return;
    }
    await start(destination as WritableDirectory);
  }

  const working = state.phase === 'working';
  const progress = state.phase === 'working' ? state.progress : null;

  return (
    <section class="card">
      <h3>Copy everything off the iPod</h3>
      <p class="card-lead">
        Copies every music, podcast, audiobook and video file from the iPod to a folder on your computer, exactly as it is, and writes a library.csv with the real titles, artists and playlists, because the iPod gives its files random names. The iPod is only read: nothing is written to it and nothing is deleted from it. Chrome may refuse Desktop, Documents or Downloads themselves. If it does, make a folder inside one, for example "iPod copy".
      </p>
      <div class="actions">
        <button type="button" onClick={() => void choose()} disabled={working}>
          Choose where to copy everything
        </button>
        {inMemory ? (
          <button type="button" class="secondary" onClick={() => void start(new ScratchFolder('memory copy') as unknown as WritableDirectory)} disabled={working}>
            Copy into memory instead
          </button>
        ) : null}
        {working ? (
          <button type="button" class="secondary" onClick={() => abort.current?.abort()}>
            Stop
          </button>
        ) : null}
      </div>
      <p class="note">
        Each file is copied in pieces of 4 MB, three at a time, then read back and checked. A file already in the folder with the same size is skipped, so a stopped copy can be finished by copying again into the same folder. To put music back on an iPod later, see "How to arrange your files" in the Add music tab.
      </p>

      {state.phase === 'working' ? (
        <div class="callout info" role="status">
          <p>{progress?.message ?? 'Starting...'}</p>
          {progress && progress.filesTotal > 0 ? (
            <>
              <progress max={progress.bytesTotal || 1} value={progress.bytesDone} style="width: 100%" />
              <p class="muted">
                {progress.filesDone} of {progress.filesTotal} files, {formatBytes(progress.bytesDone)} of {formatBytes(progress.bytesTotal)}
                {progress.bytesPerSecond > 0 ? `, ${formatBytes(progress.bytesPerSecond)}/s` : ''}
                {progress.failures ? `, ${progress.failures} failed so far` : ''}
              </p>
            </>
          ) : null}
        </div>
      ) : null}

      {state.phase === 'error' ? (
        <div class="result no" role="alert">
          <p>{state.message}</p>
        </div>
      ) : null}

      {state.phase === 'done' ? (
        <Done
          report={state.report}
          into={state.into}
          onResume={last.current ? () => void start(last.current as WritableDirectory, state.report.folder) : undefined}
        />
      ) : null}
    </section>
  );
}

function Done({ report, into, onResume }: { report: OffloadReport; into: string; onResume?: () => void }) {
  const here = report.files.copied + report.files.skipped;
  const unfinished = report.stopped || report.failures.length > 0;
  const seconds = Math.max(1, Math.round(report.elapsedMs / 1000));
  return (
    <>
      <div class={`result ${report.complete ? 'ok' : 'no'}`} role={report.complete ? 'status' : 'alert'}>
        <p>
          {report.complete
            ? `Copied ${here} file${here === 1 ? '' : 's'} (${formatBytes(report.bytes.copied + report.bytes.skipped)}) into the folder "${report.folder}" in "${into}", and checked each by reading it back.`
            : report.stopped
              ? `Stopped. ${here} of ${report.files.total} files are in the folder "${report.folder}" in "${into}". Copy again into the same folder to finish.`
              : `The copy in "${report.folder}" in "${into}" is not complete: ${here} of ${report.files.total} files are there${report.failures.length ? `, ${report.failures.length} failed` : ''}.`}
        </p>
        <p class="muted">
          {report.files.skipped ? `${report.files.skipped} were already there and skipped. ` : ''}
          {report.bytes.copied > 0 ? `Copied ${formatBytes(report.bytes.copied)} in ${seconds} s${report.bytesPerSecond > 0 ? ` (${formatBytes(report.bytesPerSecond)}/s)` : ''}. ` : ''}
          {report.libraryError ? '' : `The library lists ${report.tracks} track${report.tracks === 1 ? '' : 's'} and ${report.playlists} playlist${report.playlists === 1 ? '' : 's'}.`}
        </p>
      </div>

      {onResume && unfinished ? (
        <div class="actions">
          <button type="button" onClick={onResume}>
            {report.stopped ? 'Copy the rest' : 'Try the failed files again'}
          </button>
        </div>
      ) : null}

      {report.libraryError ? (
        <div class="callout warn" role="note">
          <p>{report.libraryError}</p>
        </div>
      ) : null}
      {report.notesError ? (
        <div class="callout no" role="note">
          <p>{report.notesError}</p>
        </div>
      ) : null}

      {report.failures.length ? (
        <>
          <p>
            <strong>{report.failures.length === 1 ? '1 file could not be copied:' : `${report.failures.length} files could not be copied:`}</strong>
          </p>
          <ul class="files">
            {report.failures.slice(0, SHOWN).map((failure) => (
              <li key={failure.path}>
                {failure.path}: {failure.reason}
              </li>
            ))}
          </ul>
          {report.failures.length > SHOWN ? <p class="muted">Showing the first {SHOWN}.</p> : null}
        </>
      ) : null}

      {report.missing.length ? (
        <details open>
          <summary>
            {report.missing.length} track{report.missing.length === 1 ? ' is' : 's are'} in the library but {report.missing.length === 1 ? 'its' : 'their'} file is not on the iPod
          </summary>
          <ul class="files">
            {report.missing.slice(0, SHOWN).map((track) => (
              <li key={track.path}>
                {track.title ?? '(no title)'}
                {track.artist ? `, ${track.artist}` : ''} <span class="muted">{track.path}</span>
              </li>
            ))}
          </ul>
          {report.missing.length > SHOWN ? <p class="muted">Showing the first {SHOWN}. All are marked in library.csv.</p> : null}
        </details>
      ) : null}

      {report.unlisted.length ? (
        <p class="muted">
          {report.unlisted.length} file{report.unlisted.length === 1 ? '' : 's'} in the music folders {report.unlisted.length === 1 ? 'is' : 'are'} not in the library (left over from an interrupted sync, for example). {report.unlisted.length === 1 ? 'It was' : 'They were'} copied too, and {report.unlisted.length === 1 ? 'is' : 'are'} not in library.csv.
        </p>
      ) : null}
      <p class="muted">The folder holds the copied files in F00, F01 and so on, library.csv, playlists.csv and a README.txt that explains them.</p>
    </>
  );
}
