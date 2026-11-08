import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { formatBytes } from '@opentunes/core';
import { PauseGate, ScratchFolder, type BackupReport, type DirectoryEntry, type OffloadProgress, type OffloadReport, type TrackInfo, type WritableDirectory } from '@opentunes/engine';
import { offloadIpod } from './tracked';
import { runQuickBackup } from './quickBackup';
import { MEDIA_GROUPS, groupTotals, planFor, selectedWithFiles, type BackupPlan, type MediaGroup } from './backupChoice';
import { ConfirmBox, Notice, useOnce, usePauseState } from './controls';
import { describeError, isStopped } from './describeError';
import { newEngine } from './engineLoader';
import { backupReportFromOffload, rememberBackup } from './lastBackup';
import { logOk } from './log';
import { OffloadResult } from './OffloadResult';
import { useLibrarySelection } from './selection';
import { timeLeftText } from './timeLeft';

type State =
  | { phase: 'idle' }
  | { phase: 'working'; message: string }
  | { phase: 'done'; report: BackupReport; into: string }
  | { phase: 'copying'; progress: OffloadProgress | null }
  | { phase: 'copied'; report: OffloadReport; into: string; counts: boolean }
  | { phase: 'error'; message: string };

type Picker = (options?: { mode?: 'read' | 'readwrite' }) => Promise<unknown>;

/** The id the last-backup line points at, to bring the person to the start button. */
export const BACKUP_PANEL_ID = 'backup-panel';
export const BACKUP_START_ID = 'backup-choose';

/**
 * One panel for protecting the iPod: the library is always saved and checked, and the music and
 * videos can be copied too (by kind, or only the tracks selected in the Library tab). With nothing
 * ticked it is the quick backup (`backupIpod`). With something ticked it is the full copy engine
 * (`offloadIpod`) limited to what was ticked, and its `database/` folder is a complete backup, so
 * a finished copy counts as the backup for changes. Only the iPod is read; a stopped copy can be
 * finished by copying again into the same folder.
 */
export function BackupPanel({
  source,
  tracks,
  onDone,
  inMemory = false,
}: {
  source: DirectoryEntry;
  /** The library the page already holds, for the counts and sizes shown. */
  tracks: TrackInfo[];
  /** A backup that counts for changes to the iPod was made. */
  onDone?: (report: BackupReport) => void;
  /** Keep the backup in memory, for the practice iPod. */
  inMemory?: boolean;
}) {
  const [state, setState] = useState<State>({ phase: 'idle' });
  const [asking, setAsking] = useState(false);
  const [groups, setGroups] = useState<ReadonlySet<MediaGroup>>(new Set());
  const [selectedOnly, setSelectedOnly] = useState(false);
  const abort = useRef<AbortController | null>(null);
  /** Lets the person pause between files. A new one for each copy. */
  const [gate, setGate] = useState<PauseGate | null>(null);
  const pause = usePauseState(gate);
  const once = useOnce();
  /** The destination and choice of the last copy, kept so the rest can be copied into the same folder. */
  const last = useRef<{ destination: WritableDirectory; plan: Extract<BackupPlan, { mode: 'media' }> } | null>(null);
  const selection = useLibrarySelection();

  const totals = useMemo(() => groupTotals(tracks), [tracks]);
  const plan = useMemo(() => planFor({ groups, selectedOnly }, tracks, selection), [groups, selectedOnly, tracks, selection]);
  const selectedFiles = useMemo(() => selectedWithFiles(tracks, selection), [tracks, selection]);

  // Nothing selected any more (or the library was read again): the box goes, and does not come back ticked.
  useEffect(() => {
    if (selection.size === 0) setSelectedOnly(false);
  }, [selection]);

  function toggle(id: MediaGroup, on: boolean) {
    setGroups((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function runBackup(destination: WritableDirectory) {
    const controller = new AbortController();
    abort.current = controller;
    setState({ phase: 'working', message: 'Starting the backup...' });
    try {
      const report = await runQuickBackup(source, destination, { inMemory, signal: controller.signal, onProgress: (message) => setState({ phase: 'working', message }), onDone });
      setState({ phase: 'done', report, into: destination.name });
    } catch (error) {
      setState({ phase: 'error', message: isStopped(error) ? 'Stopped. The iPod was not changed.' : describeError(error) });
    } finally {
      abort.current = null;
      setAsking(false);
    }
  }

  async function runCopy(destination: WritableDirectory, media: Extract<BackupPlan, { mode: 'media' }>, resumeInto?: string) {
    const controller = new AbortController();
    const pauseGate = new PauseGate();
    abort.current = controller;
    last.current = { destination, plan: media };
    setGate(pauseGate);
    setState({ phase: 'copying', progress: null });
    try {
      const report = await offloadIpod(source, destination, newEngine, {
        folder: resumeInto,
        include: media.include,
        signal: controller.signal,
        pause: pauseGate,
        onProgress: (progress) => setState({ phase: 'copying', progress }),
      });
      // A finished copy's database/ folder is a complete backup, so it is the one this session counts.
      const asBackup = backupReportFromOffload(report);
      setState({ phase: 'copied', report, into: destination.name, counts: asBackup !== null });
      if (asBackup) {
        logOk('backup', `The library folder in the copy "${report.folder}" is a complete backup and counts as the backup.`);
        onDone?.(asBackup);
        if (!inMemory) await rememberBackup(asBackup, destination, source.name);
      }
    } catch (error) {
      setState({ phase: 'error', message: isStopped(error) ? 'Stopped before the first file was copied. Nothing was written to your computer.' : describeError(error) });
    } finally {
      abort.current = null;
      setGate(null);
    }
  }

  async function choose() {
    const picker = (window as unknown as { showDirectoryPicker?: Picker }).showDirectoryPicker;
    // The quick backup of the practice iPod is kept in memory and asks for no folder.
    const memoryBackup = inMemory && plan.mode === 'library';
    if (!picker && !memoryBackup) {
      setState({ phase: 'error', message: 'This browser has no folder picker. Use Chrome or Edge on a computer.' });
      return;
    }
    // Chrome shows its folder picker for a moment before it answers, long enough to click twice.
    await once(async () => {
      let destination: unknown;
      try {
        destination = memoryBackup ? new ScratchFolder('memory backup') : await (picker as Picker).call(window, { mode: 'readwrite' });
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) setState({ phase: 'error', message: describeError(error) });
        return;
      }
      if (plan.mode === 'media') await runCopy(destination as WritableDirectory, plan);
      else await runBackup(destination as WritableDirectory);
    });
  }

  const working = state.phase === 'working' || state.phase === 'copying';
  const progress = state.phase === 'copying' ? state.progress : null;
  const left = progress && progress.phase === 'copying' ? timeLeftText(progress.bytesTotal - progress.bytesDone, progress.bytesPerSecond) : null;
  const nothingToCopy = plan.mode === 'media' && plan.files === 0;

  return (
    <section class="card" id={BACKUP_PANEL_ID} tabIndex={-1}>
      <h3>Back up the iPod</h3>
      <p class="card-lead">
        Saves the iPod's library to a folder on your computer and checks every copy. You can copy the music and videos too. The iPod is only read, and you can stop a copy and finish it later.
        {inMemory ? ' This is a practice iPod, so a library-only backup is kept in memory and no folder is asked for.' : ''}
      </p>

      <fieldset class="include" disabled={working}>
        <legend>What to include</legend>
        <p class="include-library">
          <strong>The library</strong> is always saved. It is the part that puts the iPod back.
        </p>
        <p class="include-title">Also copy the music and videos (optional):</p>
        <ul class="include-list">
          {MEDIA_GROUPS.map((group) => {
            const total = totals.find((entry) => entry.id === group.id);
            const files = total?.files ?? 0;
            return (
              <li key={group.id}>
                <label>
                  <input type="checkbox" checked={groups.has(group.id)} disabled={files === 0} onChange={(event) => toggle(group.id, (event.currentTarget as HTMLInputElement).checked)} />
                  <span>
                    {group.label}
                    <span class="muted">
                      {' '}
                      — {files === 0 ? 'none on the iPod' : `${files} file${files === 1 ? '' : 's'}, ${formatBytes(total?.bytes ?? 0)}`}
                    </span>
                  </span>
                </label>
              </li>
            );
          })}
          {selection.size > 0 ? (
            <li class="include-selected">
              <label>
                <input type="checkbox" checked={selectedOnly} onChange={(event) => setSelectedOnly((event.currentTarget as HTMLInputElement).checked)} />
                <span>
                  Only the tracks I selected in the Library tab ({selection.size} selected)
                  {selectedFiles !== selection.size ? <span class="muted"> — {selectedFiles} of them have a file on the iPod</span> : null}
                </span>
              </label>
            </li>
          ) : null}
        </ul>
        <p class="note include-summary" role="status">
          {plan.mode === 'library'
            ? 'Nothing ticked: only the library is saved. It is small and quick.'
            : plan.files === 0
              ? 'Nothing to copy with this choice: none of the ticked kinds are in the selection.'
              : plan.full
                ? `The library and everything on the iPod: ${plan.files} file${plan.files === 1 ? '' : 's'}, ${formatBytes(plan.bytes)}.`
                : `The library, and a partial copy of the media: ${plan.files} file${plan.files === 1 ? '' : 's'}, ${formatBytes(plan.bytes)}. The other tracks are listed in library.csv as not included.`}
        </p>
      </fieldset>

      <p class="note">If Chrome refuses a folder such as Desktop or Documents, make a new folder inside it, for example "iPod backups".</p>
      <details class="howto-details">
        <summary>What a copy with music and videos gives you, and how to use it</summary>
        <div class="howto" role="note">
          <ul>
            <li>
              <strong>The folder holds the library and what you ticked.</strong> The media files in F00, F01 and so on, library.csv and playlists.csv, a database folder with the iPod's library and device files (the same files a backup holds, each checked), opentunes-offload.json, and a README.txt that explains it all. If you ticked only some, the README, the marker and library.csv say so, and the tracks left out have no file in the folder.
            </li>
            <li>
              <strong>It counts as your backup.</strong> The database folder in it is a complete backup, so the app will change the iPod after a finished copy without asking for another backup.
            </li>
            <li>
              <strong>To browse it,</strong> open library.csv in Excel, Numbers or Google Sheets. It lists each song with its title, artist, album and the file to open.
            </li>
            <li>
              <strong>To use the audio and video elsewhere,</strong> copy the files out. They are plain MP3, AAC, M4A and video files with their tags still in them, and any player can open them. Files bought with copy protection (.m4p) will not play outside iTunes.
            </li>
            <li>
              <strong>To put everything back,</strong> use step 2, "Restore everything from a full copy", and choose this folder. A single folder is enough: it copies back the files the iPod lacks, then restores the library. It needs a backup of the iPod as it is first. For a partial copy it says how many tracks the folder holds files for.
            </li>
            <li>
              <strong>Keep it private.</strong> The database folder holds the iPod's identity files (its serial number and FireWire ID), so do not share or upload the folder.
            </li>
          </ul>
        </div>
        <p class="note">
          Each file is copied in pieces of 4 MB, three at a time, then read back and checked. A file already in the folder with the same size is skipped, so a stopped copy can be finished by copying again into the same folder. The iPod's library files are saved again each time. To add music from files you already have, see "How to arrange your files" in the Add music tab.
        </p>
      </details>

      <div class="actions">
        <button type="button" id={BACKUP_START_ID} onClick={() => void choose()} disabled={working || nothingToCopy}>
          {plan.mode === 'library' ? 'Choose where to keep the backup' : plan.full ? 'Choose where to copy everything' : 'Choose where to copy'}
        </button>
        {inMemory && plan.mode === 'media' ? (
          <button type="button" class="secondary" onClick={() => void once(() => runCopy(new ScratchFolder('memory copy') as unknown as WritableDirectory, plan))} disabled={working || nothingToCopy}>
            Copy into memory instead
          </button>
        ) : null}
        {state.phase === 'working' && !asking ? (
          <button type="button" class="secondary" onClick={() => setAsking(true)}>
            Stop the backup
          </button>
        ) : null}
        {state.phase === 'copying' ? (
          <button type="button" class="secondary" onClick={() => gate?.[pause === 'running' ? 'request' : 'resume']()}>
            {pause === 'running' ? 'Pause after this file' : pause === 'pausing' ? 'Cancel the pause' : 'Resume'}
          </button>
        ) : null}
        {state.phase === 'copying' ? (
          <button type="button" class="secondary" onClick={() => abort.current?.abort()}>
            Stop (you can resume later)
          </button>
        ) : null}
      </div>
      {asking && state.phase === 'working' ? (
        <ConfirmBox title="Stop the backup?" confirmLabel="Yes, stop the backup" cancelLabel="Keep going" onConfirm={() => { setAsking(false); abort.current?.abort(); }} onCancel={() => setAsking(false)}>
          <p>The backup folder will be left incomplete and cannot be used, and the iPod is not changed. Changes to the iPod stay off until a backup is complete.</p>
        </ConfirmBox>
      ) : null}

      {state.phase === 'working' ? (
        <p class="note" role="status">
          {state.message}
        </p>
      ) : null}

      {state.phase === 'copying' ? (
        <div class="callout info" role="status">
          <p>
            {pause === 'paused'
              ? 'Paused after the last file. Nothing more is copied until you press Resume.'
              : pause === 'pausing'
                ? 'Pausing after the files being copied now...'
                : (progress?.message ?? 'Starting...')}
          </p>
          {progress && progress.filesTotal > 0 ? (
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
        </div>
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

      {state.phase === 'copied' ? (
        <OffloadResult
          report={state.report}
          into={state.into}
          countsAsBackup={state.counts}
          onResume={last.current ? () => void runCopy(last.current!.destination, last.current!.plan, state.report.folder) : undefined}
        />
      ) : null}
    </section>
  );
}
