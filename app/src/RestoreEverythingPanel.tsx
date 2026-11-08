import { useState } from 'preact/hooks';
import { formatBytes } from '@opentunes/core';
import { describeInclude, describeOffload, partialLine, type BackupReport, type DirectoryEntry, type IpodRoot, type OffloadProgress, type OffloadSource, type OffloadSummary, type RestoreOffloadReport } from '@opentunes/engine';
import { restoreOffload } from './tracked';
import { BackupGate } from './BackupGate';
import { useWriteReady } from './writeReady';
import { ConfirmBox, Notice, useOnce } from './controls';
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
 * iPod as it is now. It is a long write job, so Stop and Pause are in the activity bar (the page's
 * controls are off while it runs). Stop works until the library is put back, and not after.
 */
export function RestoreEverythingPanel({ root, backup, onNeedBackup, onChanged }: { root: DirectoryEntry; backup: BackupReport | null; onNeedBackup?: () => void; onChanged?: () => void }) {
  const [state, setState] = useState<State>({ phase: 'idle' });
  const once = useOnce();
  const { ready } = useWriteReady(backup);

  async function choose() {
    const picker = (window as unknown as { showDirectoryPicker?: Picker }).showDirectoryPicker;
    if (!picker) {
      setState({ phase: 'error', message: 'This browser has no folder picker. Use Chrome or Edge on a computer.' });
      return;
    }
    // Chrome shows its picker for a moment before it answers, long enough to click twice.
    await once(async () => {
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
    });
  }

  async function restore(folder: OffloadSource) {
    await once(async () => {
      try {
        // First thing in the click, so Chrome can still show its permission prompt.
        if (!(await allowWriting(root))) {
          setState({ phase: 'error', message: 'Chrome was not allowed to change the iPod, so nothing was put back.' });
          return;
        }
        setState({ phase: 'working', progress: null });
        // Stop and Pause come from the wrapper in tracked.ts, which makes the signal and the pause gate and shows both in the bar.
        const report = await restoreOffload(root as unknown as IpodRoot, folder, {
          newEngine,
          onProgress: (progress) => setState({ phase: 'working', progress }),
        });
        setState({ phase: 'done', report });
        onChanged?.();
      } catch (error) {
        setState({ phase: 'error', message: describeError(error, { writing: true }) });
      }
    });
  }

  const working = state.phase === 'working';
  const progress = state.phase === 'working' ? state.progress : null;
  const left = progress && progress.phase === 'copying' ? timeLeftText(progress.bytesTotal - progress.bytesDone, progress.bytesPerSecond) : null;

  return (
    <section class="card">
      <h3>Restore everything from a full copy</h3>
      <p class="card-lead">
        Choose a full-copy folder (the one named opentunes-offload-...). It copies back any music and video the iPod is missing, then puts the saved library back, so the library never lists a file that is not there. A backup folder cannot be used here: use "Restore from a backup" for that.
      </p>
      <button type="button" onClick={() => void choose()} disabled={working}>
        Choose a full-copy folder
      </button>

      {state.phase === 'reading' ? (
        <p class="note" role="status">
          Reading the offload folder...
        </p>
      ) : null}

      {state.phase === 'error' ? (
        <Notice tone="no">
          <p>{state.message}</p>
        </Notice>
      ) : null}

      {state.phase === 'chosen' ? <Chosen folder={state.folder} summary={state.summary} backup={backup} ready={ready} onNeedBackup={onNeedBackup} onRestore={() => void restore(state.folder)} /> : null}

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
          <p class="muted">
            Stop and Pause are in the bar at the top. Stopping leaves the iPod's library as it was, and cannot be done once the library is being put back. Run this again later to carry on: files already copied back are skipped.
          </p>
        </div>
      ) : null}

      {state.phase === 'done' ? <Done report={state.report} /> : null}
    </section>
  );
}

function Chosen({ folder, summary, backup, ready, onNeedBackup, onRestore }: { folder: OffloadSource; summary: OffloadSummary; backup: BackupReport | null; ready: boolean; onNeedBackup?: () => void; onRestore: () => void }) {
  const onIpod = summary.onIpod;
  const [asking, setAsking] = useState(false);
  return (
    <>
      <p>
        "{folder.name}" holds {summary.mediaFiles} media file{summary.mediaFiles === 1 ? '' : 's'} ({formatBytes(summary.mediaBytes)}) and a library of {summary.tracks} track{summary.tracks === 1 ? '' : 's'} and {summary.playlists} playlist{summary.playlists === 1 ? '' : 's'}, made {summary.createdAt ? new Date(summary.createdAt).toLocaleString() : 'at an unknown time'}.
        {onIpod ? ` ${onIpod.alreadyThere} of the media files ${onIpod.alreadyThere === 1 ? 'is' : 'are'} already on this iPod. ${onIpod.toCopy === 0 ? 'None need copying back.' : `${onIpod.toCopy} (${formatBytes(onIpod.bytesToCopy)}) will be copied back.`}` : ''}
      </p>
      {summary.partial ? (
        <div class="callout warn partial-copy" role="note">
          <p>
            <strong>This is a partial copy ({describeInclude(summary.partial)}).</strong> {partialLine(summary.partial, summary.tracks)}
          </p>
        </div>
      ) : null}
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
      <BackupGate backup={backup} onGo={onNeedBackup} />
      {asking ? (
        <ConfirmBox
          title="Put everything back on the iPod?"
          confirmLabel="Restore everything to the iPod"
          cancelLabel="Do not restore"
          danger
          confirmDisabled={!ready}
          onConfirm={() => {
            setAsking(false);
            onRestore();
          }}
          onCancel={() => setAsking(false)}
        >
          <p>
            {onIpod && onIpod.toCopy > 0 ? `${onIpod.toCopy} music and video files (${formatBytes(onIpod.bytesToCopy)}) are copied back first, then ` : ''}the iPod's library is replaced by the one saved in "{folder.name}". Anything added since, and any change to playlists, ratings or play counts, is lost from the library.
          </p>
          <p>
            {summary.partial ? `${partialLine(summary.partial, summary.tracks)} ` : ''}It can be undone with the backup you just made: restore it from "Restore from a backup" above. Files copied back stay on the iPod. You can pause between files, or stop until the library starts to be put back (the bar at the top has both).
          </p>
        </ConfirmBox>
      ) : (
        <button type="button" onClick={() => setAsking(true)} disabled={!ready || !summary.complete}>
          Restore everything to the iPod...
        </button>
      )}
    </>
  );
}

function Done({ report }: { report: RestoreOffloadReport }) {
  const seconds = Math.max(1, Math.round(report.elapsedMs / 1000));
  return (
    <>
      <Notice tone={report.complete ? 'ok' : report.stopped && !report.failures.length ? 'info' : 'no'}>
        <p>{report.summary}</p>
        {report.complete ? <p>The iPod can now be ejected. Eject it from your computer before you unplug it, then check it.</p> : null}
        {report.complete && report.bytes.copied > 0 ? (
          <p class="muted">
            Copied {formatBytes(report.bytes.copied)} in {seconds} s{report.bytesPerSecond > 0 ? ` (${formatBytes(report.bytesPerSecond)}/s)` : ''}.
          </p>
        ) : null}
      </Notice>
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
