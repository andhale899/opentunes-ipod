import { useRef, useState } from 'preact/hooks';
import { formatBytes } from '@opentunes/core';
import { describeOffload, type BackupReport, type DirectoryEntry, type IpodRoot, type OffloadProgress, type OffloadSource, type OffloadSummary, type RestoreOffloadReport } from '@opentunes/engine';
import { restoreOffload } from './tracked';
import { BackupGate } from './BackupGate';
import { describeError } from './describeError';
import { newEngine } from './engineLoader';
import { timeLeftText } from './timeLeft';
import { allowWriting } from './WriteBackPanel';

type State =
  | { phase: 'idle' }
  | { phase: 'reading' }
  | { phase: 'chosen'; folder: OffloadSource; summary: OffloadSummary }
  | { phase: 'working'; progress: OffloadProgress | null }
  | { phase: 'done'; report: RestoreOffloadReport }
  | { phase: 'error'; message: string };

type Picker = (options?: { mode?: 'read' | 'readwrite' }) => Promise<unknown>;

const SHOWN = 100;

/**
 * Puts everything in an offload folder back on the iPod: the media files it lacks first, then the
 * saved library. The library on the iPod is replaced, so this needs a complete backup of the
 * iPod as it is now. Stop works at any point before the library is put back.
 */
export function RestoreEverythingPanel({ root, backup, onNeedBackup, onChanged }: { root: DirectoryEntry; backup: BackupReport | null; onNeedBackup?: () => void; onChanged?: () => void }) {
  const [state, setState] = useState<State>({ phase: 'idle' });
  const abort = useRef<AbortController | null>(null);
  const ready = backup !== null && backup.complete;

  async function choose() {
    const picker = (window as unknown as { showDirectoryPicker?: Picker }).showDirectoryPicker;
    if (!picker) {
      setState({ phase: 'error', message: 'This browser has no folder picker. Use Chrome or Edge on a computer.' });
      return;
    }
    let handle: unknown;
    try {
      handle = await picker.call(window, { mode: 'read' });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) setState({ phase: 'error', message: describeError(error) });
      return;
    }
    setState({ phase: 'reading' });
    try {
      const folder = handle as OffloadSource;
      setState({ phase: 'chosen', folder, summary: await describeOffload(folder, root as unknown as IpodRoot) });
    } catch (error) {
      const message = describeError(error);
      setState({ phase: 'error', message: /no opentunes-offload\.json/.test(message) ? `${message} If it is a backup folder (opentunes-backup-...), use "Restore from a backup" above instead.` : message });
    }
  }

  async function restore(folder: OffloadSource) {
    try {
      // First thing in the click, so Chrome can still show its permission prompt.
      if (!(await allowWriting(root))) {
        setState({ phase: 'error', message: 'Chrome was not allowed to change the iPod, so nothing was put back.' });
        return;
      }
      const controller = new AbortController();
      abort.current = controller;
      setState({ phase: 'working', progress: null });
      const report = await restoreOffload(root as unknown as IpodRoot, folder, {
        newEngine,
        signal: controller.signal,
        onProgress: (progress) => setState({ phase: 'working', progress }),
      });
      setState({ phase: 'done', report });
      onChanged?.();
    } catch (error) {
      setState({ phase: 'error', message: describeError(error) });
    } finally {
      abort.current = null;
    }
  }

  const working = state.phase === 'working';
  const progress = state.phase === 'working' ? state.progress : null;
  const left = progress && progress.phase === 'copying' ? timeLeftText(progress.bytesTotal - progress.bytesDone, progress.bytesPerSecond) : null;

  return (
    <section class="card">
      <h3>Restore everything from an offload folder</h3>
      <p class="card-lead">
        Choose a folder made by the Offload tab (the one named opentunes-offload-...). It copies back every music and video file the iPod is missing, then puts the saved library back, so the library never lists a file that is not there. An offload folder holds everything. A backup folder holds only the database files, so use "Restore from a backup" for those.
      </p>
      <button type="button" onClick={() => void choose()} disabled={working}>
        Choose an offload folder
      </button>

      {state.phase === 'reading' ? (
        <p class="note" role="status">
          Reading the offload folder...
        </p>
      ) : null}

      {state.phase === 'error' ? (
        <div class="result no" role="alert">
          <p>{state.message}</p>
        </div>
      ) : null}

      {state.phase === 'chosen' ? <Chosen folder={state.folder} summary={state.summary} ready={ready} onNeedBackup={onNeedBackup} onRestore={() => void restore(state.folder)} /> : null}

      {state.phase === 'working' ? (
        <div class="callout info" role="status">
          <p>{progress?.message ?? 'Starting...'}</p>
          {progress && progress.phase === 'copying' && progress.filesTotal > 0 ? (
            <>
              <progress max={progress.bytesTotal || 1} value={progress.bytesDone} style="width: 100%" />
              <p class="muted">
                {progress.filesDone} of {progress.filesTotal} files, {formatBytes(progress.bytesDone)} of {formatBytes(progress.bytesTotal)}
                {progress.bytesPerSecond > 0 ? `, ${formatBytes(progress.bytesPerSecond)}/s` : ''}
                {left ? `, ${left}` : ''}
                {progress.failures ? `, ${progress.failures} failed so far` : ''}
              </p>
            </>
          ) : null}
          <div class="actions">
            <button type="button" class="secondary" onClick={() => abort.current?.abort()} disabled={progress?.phase === 'restoring'}>
              Stop
            </button>
          </div>
          <p class="muted">Stopping leaves the iPod's library as it was. Run this again later to carry on: files already copied back are skipped.</p>
        </div>
      ) : null}

      {state.phase === 'done' ? <Done report={state.report} /> : null}
    </section>
  );
}

function Chosen({ folder, summary, ready, onNeedBackup, onRestore }: { folder: OffloadSource; summary: OffloadSummary; ready: boolean; onNeedBackup?: () => void; onRestore: () => void }) {
  const onIpod = summary.onIpod;
  return (
    <>
      <p>
        "{folder.name}" holds {summary.mediaFiles} media file{summary.mediaFiles === 1 ? '' : 's'} ({formatBytes(summary.mediaBytes)}) and a library of {summary.tracks} track{summary.tracks === 1 ? '' : 's'} and {summary.playlists} playlist{summary.playlists === 1 ? '' : 's'}, made {summary.createdAt ? new Date(summary.createdAt).toLocaleString() : 'at an unknown time'}.
        {onIpod ? ` ${onIpod.alreadyThere} of the media files ${onIpod.alreadyThere === 1 ? 'is' : 'are'} already on this iPod. ${onIpod.toCopy === 0 ? 'None need copying back.' : `${onIpod.toCopy} (${formatBytes(onIpod.bytesToCopy)}) will be copied back.`}` : ''}
      </p>
      {!summary.complete ? (
        <div class="callout no" role="alert">
          <p>This offload copy was not finished (it was stopped, a file failed, or the library files were not saved), so it cannot be used to put an iPod back. Run the offload again into this same folder to finish it.</p>
        </div>
      ) : (
        <div class="callout warn" role="note">
          <p>
            <strong>This replaces the iPod's library.</strong> The library on the iPod now is swapped for the one saved in this folder. Anything added to the iPod since, and any change to playlists, ratings or play counts, is lost from the library. Music files on the iPod are never deleted, and files already there are not touched. The iPod's own files in the saved folder are restored too, so only use a folder made from this iPod.
          </p>
          <p>A complete backup of the iPod as it is now is required first, so you can undo this. Make it in the Backup section above.</p>
        </div>
      )}
      <BackupGate ready={ready} onGo={onNeedBackup} />
      <button type="button" onClick={onRestore} disabled={!ready || !summary.complete}>
        Restore everything to the iPod
      </button>
    </>
  );
}

function Done({ report }: { report: RestoreOffloadReport }) {
  const seconds = Math.max(1, Math.round(report.elapsedMs / 1000));
  return (
    <>
      <div class={`result ${report.complete ? 'ok' : 'no'}`} role={report.complete ? 'status' : 'alert'}>
        <p>{report.summary}</p>
        {report.complete ? <p>The iPod can now be ejected. Eject it from your computer before you unplug it, then check it.</p> : null}
        {report.complete && report.bytes.copied > 0 ? (
          <p class="muted">
            Copied {formatBytes(report.bytes.copied)} in {seconds} s{report.bytesPerSecond > 0 ? ` (${formatBytes(report.bytesPerSecond)}/s)` : ''}.
          </p>
        ) : null}
      </div>
      {report.stopped ? <p class="muted">Run "Restore everything" again with the same folder to carry on.</p> : null}
      {report.failures.length ? (
        <>
          <p>
            <strong>{report.failures.length === 1 ? '1 file could not be copied back:' : `${report.failures.length} files could not be copied back:`}</strong> The iPod's library was not changed. Fix the cause and run it again: files already copied back are skipped.
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
      {report.database && report.database.failures.length ? (
        <ul class="files">
          {report.database.failures.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
    </>
  );
}
