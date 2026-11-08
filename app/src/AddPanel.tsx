import { useRef, useState } from 'preact/hooks';
import { describeDecision, devices, formatBytes, kindLabel, type ContentKind, type DeviceModel } from '@opentunes/core';
import { type BackupReport, type DeviceInfo, type DirectoryEntry, type IpodRoot, type SyncItem, type SyncPlan, type SyncProgress, type SyncReport } from '@opentunes/engine';
import { applySync, planSync } from './tracked';
import { inspectFile, isNotMedia, prepareItem, redecide, type Candidate } from './addFiles';
import { describeError } from './describeError';
import { newEngine } from './engineLoader';
import { BackupGate } from './BackupGate';
import { allowWriting } from './WriteBackPanel';
import { startActivity } from './activity';
import { FolderGuide } from './FolderGuide';
import { ArtFinder } from './ArtFinder';
import { albumKey, albumRefOf, coverSource, findFolderCover, folderCoverRank, type OnlineCover } from './albumArt';
import { decodePicture } from './artDecode';

type Stage =
  | { phase: 'idle' }
  | { phase: 'reading'; message: string }
  | { phase: 'converting'; message: string; fraction: number }
  | { phase: 'planned'; plan: SyncPlan; items: SyncItem[]; failed: string[] }
  | { phase: 'syncing'; progress: SyncProgress | null }
  | { phase: 'done'; report: SyncReport }
  | { phase: 'error'; message: string };

const KINDS: ContentKind[] = ['music', 'audiobook', 'podcast', 'movie', 'tv-show', 'music-video', 'video-podcast'];

/** Models the planner has limits for. A model with none cannot be planned for. */
const PLANNABLE = devices.filter((device) => device.media !== null);

interface FileHandleLike {
  getFile(): Promise<File>;
}

interface FolderHandle {
  name: string;
  entries(): AsyncIterable<[string, { kind: 'file' | 'directory' }]>;
}

/** Above this much converted audio or video, a tab may run out of memory. */
const LARGE_BATCH_BYTES = 1.5 * 1024 ** 3;

/** Formatted space is a little under the marketing figure, so leave a margin. */
const USABLE_SHARE = 0.98;

function sum(values: (number | null)[]): number {
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

/**
 * Add songs, audiobooks, podcasts and video: pick files, see what will be done with each, convert
 * what the iPod cannot play, then copy with a backup in place. Nothing is written until the last
 * button, and any failure puts the iPod back as it was.
 */
export function AddPanel({
  root,
  device,
  backup,
  onChanged,
  onNeedBackup,
}: {
  root: DirectoryEntry;
  device: DeviceInfo | null;
  backup: BackupReport | null;
  /** Called after a sync that changed the iPod, so the page reads it again. */
  onChanged: () => void;
  /** Takes the person to the backup step. */
  onNeedBackup?: () => void;
}) {
  const [model, setModel] = useState<DeviceModel>(() => PLANNABLE.find((entry) => entry.id === 'nano-7g') ?? (PLANNABLE[0] as DeviceModel));
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [problems, setProblems] = useState<string[]>([]);
  const [playlist, setPlaylist] = useState('');
  const [stage, setStage] = useState<Stage>({ phase: 'idle' });
  const abort = useRef<AbortController | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const folderPicker = useRef<HTMLInputElement>(null);
  const [ignored, setIgnored] = useState(0);
  const [allowDuplicates, setAllowDuplicates] = useState(false);
  const [putArt, setPutArt] = useState(true);

  const ready = backup !== null && backup.complete;
  const busy = stage.phase === 'reading' || stage.phase === 'converting' || stage.phase === 'syncing';
  const addable = candidates.filter((candidate) => candidate.decision.action !== 'unsupported');
  const convertBytes = sum(addable.filter((candidate) => candidate.decision.action === 'convert').map((candidate) => candidate.estimatedBytes));
  const capacityBytes = device && device.capacity_gb > 0 ? Math.round(device.capacity_gb * 1e9 * USABLE_SHARE) : undefined;

  /** Reads each file, in order, and adds it to the list. `folder` is where it sat inside a chosen folder. */
  async function addToList(list: { file: File; folder: string; folders?: string[]; cover?: { name: string; file: File } | null }[], alreadyLeftOut = 0) {
    const media = list.filter(({ file }) => !isNotMedia(file.name));
    setIgnored((previous) => previous + alreadyLeftOut + (list.length - media.length));
    if (!media.length) {
      setProblems(['That selection holds no music, audiobook, podcast or video files.']);
      setStage({ phase: 'idle' });
      return;
    }
    const added: Candidate[] = [];
    const failed: string[] = [];
    for (const [index, { file, folder, folders, cover }] of media.entries()) {
      setStage({ phase: 'reading', message: `Reading ${index + 1} of ${media.length}: ${file.name}` });
      try {
        added.push(await inspectFile(file, model, undefined, folder, folders, cover ?? undefined));
      } catch (error) {
        failed.push(`${file.name}: ${describeError(error)}`);
      }
    }
    setCandidates((previous) => [...previous, ...added]);
    setProblems(failed);
    setStage({ phase: 'idle' });
  }

  async function choose(files: FileList | null) {
    if (!files?.length) return;
    setStage({ phase: 'reading', message: 'Reading the files...' });
    // The plain folder dialog gives each file's path from the chosen folder, such as "Audiobooks/Author/Book/01.mp3".
    const partsOf = (file: File): string[] => (file as File & { webkitRelativePath?: string }).webkitRelativePath?.split('/').slice(0, -1) ?? [];
    // Cover pictures sitting next to the music, by folder.
    const pictures = new Map<string, Map<string, File>>();
    for (const file of files) {
      if (folderCoverRank(file.name) === null) continue;
      const key = partsOf(file).join('/');
      pictures.set(key, (pictures.get(key) ?? new Map()).set(file.name, file));
    }
    await addToList(
      [...files].map((file) => {
        const parts = partsOf(file);
        const cover = parts.length ? findFolderCover(parts, pictures) : null;
        return { file, folder: parts.slice(1).join(' / '), folders: parts.length ? parts : undefined, cover: cover ? { name: cover.name, file: cover.file } : null };
      }),
    );
  }

  /** Chrome's own folder picker, then every file inside the folder and its subfolders, in album order. */
  async function chooseFolder() {
    const showPicker = (window as unknown as { showDirectoryPicker?: (options?: { mode?: 'read' }) => Promise<unknown> }).showDirectoryPicker;
    if (!showPicker) {
      folderPicker.current?.click(); // other browsers: the plain folder dialog
      return;
    }
    let top: FolderHandle;
    try {
      top = (await showPicker.call(window, { mode: 'read' })) as FolderHandle;
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) setProblems([describeError(error)]);
      return;
    }
    setStage({ phase: 'reading', message: `Listing "${top.name}" and its subfolders...` });
    try {
      const found: { file: File; folder: string; folders: string[]; dir: string[]; cover?: { name: string; file: File } | null }[] = [];
      let leftOut = 0;
      // Cover pictures (cover.jpg, folder.jpg ...) by folder. They are read only when a file uses one.
      const pictures = new Map<string, Map<string, FileHandleLike>>();
      const walk = async (directory: FolderHandle, parts: string[]): Promise<void> => {
        for await (const [name, entry] of directory.entries()) {
          if (entry.kind === 'directory') {
            if (!name.startsWith('.')) await walk(entry as unknown as FolderHandle, [...parts, name]);
          } else if (isNotMedia(name)) {
            leftOut += 1;
            if (folderCoverRank(name) !== null) {
              const key = parts.join('/');
              pictures.set(key, (pictures.get(key) ?? new Map()).set(name, entry as unknown as FileHandleLike));
            }
          } else {
            found.push({ file: await (entry as unknown as FileHandleLike).getFile(), folder: parts.join(' / '), folders: [top.name, ...parts], dir: parts });
          }
        }
      };
      await walk(top, []);
      const opened = new Map<FileHandleLike, Promise<File>>();
      for (const item of found) {
        const cover = findFolderCover(item.dir, pictures);
        if (!cover) continue;
        if (!opened.has(cover.file)) opened.set(cover.file, cover.file.getFile());
        try {
          item.cover = { name: cover.name, file: await (opened.get(cover.file) as Promise<File>) };
        } catch {
          item.cover = null; // a picture that cannot be opened is left out, the music still goes on
        }
      }
      found.sort((a, b) => a.folder.localeCompare(b.folder, undefined, { numeric: true }) || a.file.name.localeCompare(b.file.name, undefined, { numeric: true }));
      await addToList(found, leftOut);
    } catch (error) {
      setProblems([describeError(error)]);
      setStage({ phase: 'idle' });
    }
  }

  function chooseModel(id: string) {
    const next = PLANNABLE.find((entry) => entry.id === id);
    if (!next) return;
    setModel(next);
    setCandidates((previous) => previous.map((candidate) => redecide(candidate, next, candidate.userKind)));
    setStage({ phase: 'idle' });
  }

  function chooseKind(id: string, value: string) {
    const userKind = value === '' ? undefined : (value as ContentKind);
    setCandidates((previous) => previous.map((candidate) => (candidate.id === id ? redecide(candidate, model, userKind) : candidate)));
    setStage({ phase: 'idle' });
  }

  function remove(id: string) {
    setCandidates((previous) => previous.filter((candidate) => candidate.id !== id));
    setStage({ phase: 'idle' });
  }

  async function prepare() {
    const controller = new AbortController();
    abort.current = controller;
    const items: SyncItem[] = [];
    const failed: string[] = [];
    const activity = startActivity('Preparing files');
    try {
      for (const [index, candidate] of addable.entries()) {
        const label = `${index + 1} of ${addable.length}: ${candidate.file.name}`;
        activity.update(`Converting or reading ${label}`);
        setStage({ phase: 'converting', message: label, fraction: 0 });
        try {
          const item = await prepareItem(candidate, {
            playlist: playlist.trim() || undefined,
            signal: controller.signal,
            onProgress: (fraction) => setStage({ phase: 'converting', message: label, fraction }),
          });
          if (item) items.push(item);
        } catch (error) {
          if (controller.signal.aborted) throw error;
          // One file that cannot be converted must not stop the rest of a folder.
          failed.push(`${candidate.file.name}: ${describeError(error)}`);
        }
      }
      if (!items.length) {
        setStage({ phase: 'error', message: failed.length ? `Nothing could be prepared.\n${failed.join('\n')}` : 'Nothing could be prepared.' });
        return;
      }
      setStage({ phase: 'reading', message: 'Checking the iPod and planning...' });
      const plan = await planSync(root as unknown as IpodRoot, newEngine, items, {
        capacityBytes,
        duplicates: allowDuplicates ? 'allow' : 'skip',
        ...(putArt ? { artwork: { decode: decodePicture } } : {}),
        onProgress: (message) => setStage({ phase: 'reading', message }),
      });
      setStage({ phase: 'planned', plan, items, failed });
    } catch (error) {
      setStage({ phase: 'error', message: controller.signal.aborted ? 'Stopped. Nothing was written to the iPod.' : describeError(error) });
    } finally {
      activity.end(items.length > 0 && !controller.signal.aborted);
      abort.current = null;
    }
  }

  async function sync(plan: SyncPlan) {
    // Chrome only shows its permission prompt straight from a click, so ask before anything else.
    if (!(await allowWriting(root))) {
      setStage({ phase: 'error', message: 'Chrome was not allowed to change the iPod, so nothing was written.' });
      return;
    }
    const controller = new AbortController();
    abort.current = controller;
    setStage({ phase: 'syncing', progress: null });
    try {
      const report = await applySync(plan, root as unknown as IpodRoot, newEngine, {
        backup,
        signal: controller.signal,
        onProgress: (progress) => setStage({ phase: 'syncing', progress }),
      });
      setStage({ phase: 'done', report });
      if (report.verified && !report.rolledBack) {
        setCandidates([]);
        onChanged();
      }
    } catch (error) {
      setStage({ phase: 'error', message: describeError(error) });
    } finally {
      abort.current = null;
    }
  }

  return (
    <section class="card">
      <h3>Add music, podcasts, audiobooks and video</h3>
      <p class="card-lead">
        Pick files and see what happens to each one. Files the iPod cannot play are converted in this page, and nothing is uploaded. The iPod is not touched until the last button.
      </p>
      <FolderGuide />
      <BackupGate ready={ready} onGo={onNeedBackup} />

      <div class="toolbar">
        <label class="field">
          iPod model
          <select value={model.id} onChange={(event) => chooseModel((event.target as HTMLSelectElement).value)} disabled={busy}>
            {PLANNABLE.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
                {entry.verification === 'hardware-tested' ? ' (tested)' : ' (not tested)'}
              </option>
            ))}
          </select>
        </label>
        <div class="spacer" />
        <button type="button" disabled={busy} onClick={() => picker.current?.click()}>
          Choose files
        </button>
        <button type="button" class="secondary" disabled={busy} onClick={() => void chooseFolder()}>
          Choose a folder
        </button>
        <input
          ref={folderPicker}
          data-pick="folder"
          type="file"
          hidden
          {...{ webkitdirectory: '', directory: '' }}
          onChange={(event) => {
            const input = event.target as HTMLInputElement;
            void choose(input.files).then(() => {
              input.value = '';
            });
          }}
        />
        <input
          ref={picker}
          data-pick="files"
          type="file"
          multiple
          hidden
          onChange={(event) => {
            const input = event.target as HTMLInputElement;
            void choose(input.files).then(() => {
              input.value = '';
            });
          }}
        />
        {candidates.length ? (
          <button type="button" class="secondary" disabled={busy} onClick={() => { setCandidates([]); setProblems([]); setIgnored(0); setStage({ phase: 'idle' }); }}>
            Clear the list
          </button>
        ) : null}
      </div>

      {problems.length ? (
        <div class="result no" role="alert">
          {problems.map((problem) => (
            <p key={problem}>{problem}</p>
          ))}
        </div>
      ) : null}

      {!candidates.length && stage.phase === 'idle' ? (
        <div class="empty">
          <strong>No files chosen yet</strong>
          Choose music, audiobooks, podcasts or video. MP3, AAC, M4A, FLAC, WAV, Ogg, Opus and most video formats work.
        </div>
      ) : null}

      {candidates.length ? (
        <div class="table-wrap">
          <table class="library">
            <thead>
              <tr>
                <th>File</th>
                <th>Kind</th>
                <th>What happens</th>
                <th class="num">On the iPod</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {candidates.map((candidate) => {
                const unsupported = candidate.decision.action === 'unsupported';
                return (
                  <tr key={candidate.id}>
                    <td class="cell-title" title={candidate.file.name}>
                      {candidate.info.tags.title ?? candidate.file.name}
                      {candidate.folder ? <div class="path">{candidate.folder}</div> : null}
                      {candidate.filledFromFolders?.length ? <div class="path">{candidate.filledFromFolders.join(', ')} filled in from the folder and file names</div> : null}
                      {putArt && !unsupported ? <CoverNote candidate={candidate} /> : null}
                    </td>
                    <td>
                      <select
                        value={candidate.userKind ?? ''}
                        disabled={busy}
                        onChange={(event) => chooseKind(candidate.id, (event.target as HTMLSelectElement).value)}
                        aria-label={`Kind of ${candidate.file.name}`}
                      >
                        <option value="">{kindLabel(candidate.decision.kind)} (guessed)</option>
                        {KINDS.map((kind) => (
                          <option key={kind} value={kind}>
                            {kindLabel(kind)}
                          </option>
                        ))}
                      </select>
                      {candidate.kindFromFolder ? <div class="path">from the folder name</div> : null}
                    </td>
                    <td class={unsupported ? 'wrap no-text' : 'wrap'}>
                      {describeDecision(candidate.decision, candidate.info)}
                    </td>
                    <td class="num">{candidate.estimatedBytes === null ? '' : formatBytes(candidate.estimatedBytes)}</td>
                    <td>
                      <button type="button" class="ghost small" disabled={busy} onClick={() => remove(candidate.id)} aria-label={`Leave out ${candidate.file.name}`}>
                        Leave out
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {candidates.length ? (
        <>
          <p class="note">
            {addable.length} of {candidates.length} can be added, about {formatBytes(sum(addable.map((candidate) => candidate.estimatedBytes)))}.
          </p>
          {ignored ? <p class="note">{ignored} other file{ignored === 1 ? ' was' : 's were'} left out because they are not music, audiobooks, podcasts or video (cover pictures, playlists, system files).</p> : null}
          {convertBytes > LARGE_BATCH_BYTES ? (
            <div class="callout warn">
              <p>
                <strong>This is a large batch.</strong> Converted files are held in this tab's memory until they are copied, about {formatBytes(convertBytes)} here. If the tab runs out of memory, add the files in smaller groups.
              </p>
            </div>
          ) : null}
          <label class="check">
            <input type="checkbox" checked={allowDuplicates} disabled={busy} onChange={(event) => setAllowDuplicates((event.target as HTMLInputElement).checked)} />
            Add files even if the same song, episode or title is already on the iPod
          </label>
          <label class="check">
            <input type="checkbox" checked={putArt} disabled={busy} onChange={(event) => setPutArt((event.target as HTMLInputElement).checked)} />
            Put cover pictures on the iPod (from inside the files, or cover.jpg and folder.jpg beside them). Writing cover art has not been tried on a real iPod yet.
          </label>
          {putArt ? (
            <ArtFinder
              candidates={candidates}
              disabled={busy}
              onUse={(covers: Map<string, OnlineCover>) => {
                setCandidates((previous) =>
                  previous.map((candidate) => {
                    const ref = albumRefOf(candidate.info.tags);
                    const cover = ref ? covers.get(albumKey(ref)) : undefined;
                    return cover && coverSource(candidate).from === 'none' ? { ...candidate, onlineCover: cover } : candidate;
                  }),
                );
                setStage({ phase: 'idle' });
              }}
            />
          ) : null}
          <label class="field">
            Put them in a playlist (optional)
            <input type="text" value={playlist} disabled={busy} onInput={(event) => setPlaylist((event.target as HTMLInputElement).value)} placeholder="Playlist name" />
          </label>
          <div class="actions">
            <button type="button" disabled={busy || !addable.length} onClick={() => void prepare()}>
              Convert and check
            </button>
            {busy && abort.current ? (
              <button type="button" class="secondary" onClick={() => abort.current?.abort()}>
                Stop
              </button>
            ) : null}
          </div>
        </>
      ) : null}

      {stage.phase === 'reading' ? (
        <p class="callout info" role="status">
          {stage.message}
        </p>
      ) : null}
      {stage.phase === 'converting' ? (
        <div class="callout info" role="status">
          <p>
            Converting {stage.message} ({Math.round(stage.fraction * 100)}%)
          </p>
          <progress max={1} value={stage.fraction} />
        </div>
      ) : null}
      {stage.phase === 'error' ? (
        <div class="result no" role="alert">
          <p style="white-space: pre-wrap">{stage.message}</p>
        </div>
      ) : null}

      {stage.phase === 'planned' ? <Planned plan={stage.plan} failed={stage.failed} ready={ready} onSync={() => void sync(stage.plan)} onNeedBackup={onNeedBackup} /> : null}

      {stage.phase === 'syncing' ? (
        <>
          <p class="callout info" role="status">
            {stage.progress?.message ?? 'Starting...'}
          </p>
          {stage.progress && stage.progress.bytesTotal > 0 ? (
            <progress max={stage.progress.bytesTotal} value={stage.progress.bytesDone} style="width: 100%" />
          ) : null}
          {stage.progress?.bytesPerSecond ? <p class="muted">{formatBytes(stage.progress.bytesPerSecond)}/s</p> : null}
          <button type="button" class="secondary" onClick={() => abort.current?.abort()}>
            Stop and undo
          </button>
        </>
      ) : null}

      {stage.phase === 'done' ? <Done report={stage.report} /> : null}
    </section>
  );
}

function Planned({ plan, failed, ready, onSync, onNeedBackup }: { plan: SyncPlan; failed: string[]; ready: boolean; onSync: () => void; onNeedBackup?: () => void }) {
  const fits = plan.space.fits;
  return (
    <>
      <div class={`result ${plan.files.length && fits !== false ? 'ok' : 'no'}`} role="status">
        <p>
          {plan.files.length
            ? `Ready to copy ${plan.files.length} file${plan.files.length === 1 ? '' : 's'} (${formatBytes(plan.bytesToCopy)}).`
            : 'Nothing would be copied.'}
          {fits === false ? ' They do not fit on the iPod.' : ''}
        </p>
      </div>
      {failed.length ? (
        <div class="callout no" role="note">
          <p>
            <strong>{failed.length === 1 ? '1 file could not be converted and is left out:' : `${failed.length} files could not be converted and are left out:`}</strong>
          </p>
          {failed.map((line) => (
            <p key={line} style="white-space: pre-wrap">
              {line}
            </p>
          ))}
        </div>
      ) : null}
      {plan.skipped.length || plan.duplicates.length || plan.warnings.length ? (
        <ul class="files">
          {plan.skipped.map((skipped) => (
            <li key={`skip-${skipped.itemId}`}>Skipped: {skipped.reason}</li>
          ))}
          {plan.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
      <details>
        <summary>What will be written</summary>
        <ul class="files">
          {plan.summary.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </details>
      <div class="actions">
        <button type="button" disabled={!ready || !plan.files.length || fits === false} onClick={onSync}>
          Put on the iPod
        </button>
        {!ready ? (
          <span class="note">
            Off until you make a backup.{' '}
            {onNeedBackup ? (
              <button type="button" class="ghost small" onClick={onNeedBackup}>
                Go to Backup
              </button>
            ) : null}
          </span>
        ) : !plan.files.length ? (
          <span class="note">
            Off because nothing would be copied.{plan.duplicates.some((duplicate) => duplicate.skipped) ? ' Tick "Add files even if the same song is already on the iPod" above and check again to add them anyway.' : ''}
          </span>
        ) : fits === false ? (
          <span class="note">Off because the files do not fit on the iPod.</span>
        ) : null}
      </div>
    </>
  );
}

function Done({ report }: { report: SyncReport }) {
  const good = report.verified && !report.rolledBack && !report.failures.length;
  return (
    <>
      <div class={`result ${good ? 'ok' : 'no'}`} role={good ? 'status' : 'alert'}>
        <p>
          {good
            ? `Copied ${report.copied.length} file${report.copied.length === 1 ? '' : 's'} and checked the iPod by reading it back. Eject it from the computer before you unplug it.`
            : report.aborted
              ? 'Stopped. What was done has been undone.'
              : 'The sync did not finish.'}
        </p>
      </div>
      {good && report.artwork ? (
        <p class="note">
          Album art was written for {report.artwork.tracks} {report.artwork.tracks === 1 ? 'track' : 'tracks'} ({report.artwork.images} {report.artwork.images === 1 ? 'picture' : 'pictures'}) and read back. Whether the iPod shows it has not been checked: look at Now Playing and the album list on the iPod.
        </p>
      ) : null}
      {report.failures.length ? (
        <ul class="files">
          {report.failures.map((failure) => (
            <li key={failure}>{failure}</li>
          ))}
        </ul>
      ) : null}
      {report.rollbackFailures.length || report.restoreNeeded ? (
        <div class="result no" role="alert">
          <p>The iPod could not be put back completely. Do not use it as it is: restore the backup below.</p>
          {report.rollbackFailures.map((failure) => (
            <p key={failure}>{failure}</p>
          ))}
        </div>
      ) : null}
    </>
  );
}

/** Where a file's cover comes from, in the list: inside the file, a picture in its folder, one found online, or none. */
function CoverNote({ candidate }: { candidate: Candidate }) {
  const source = coverSource(candidate);
  const text =
    source.from === 'file' ? 'Cover: inside the file'
    : source.from === 'folder' ? `Cover: ${source.name} from its folder`
    : source.from === 'online' ? 'Cover: found online (you approved it)'
    : 'Cover: none';
  return <div class="path">{text}</div>;
}
