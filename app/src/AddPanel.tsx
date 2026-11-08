import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { describeDecision, devices, formatBytes, kindLabel, type ContentKind, type DeviceModel } from '@opentunes/core';
import { PauseGate, trackKey, type BackupReport, type DeviceInfo, type DirectoryEntry, type IpodRoot, type SyncItem, type SyncPlan, type SyncProgress, type SyncReport, type TrackInfo } from '@opentunes/engine';
import { applySync, planSync } from './tracked';
import { inspectFile, isNotMedia, prepareItem, redecide, type Candidate } from './addFiles';
import { countsOf, missedDuplicates, precheck, summaryOf, type RowDuplicate } from './duplicatePrecheck';
import { ConfirmBox, Notice, useOnce, usePauseState } from './controls';
import { describeError, isStopped } from './describeError';
import { newEngine } from './engineLoader';
import { BackupGate, WriteWait } from './BackupGate';
import { useWriteReady } from './writeReady';
import { allowWriting } from './WriteBackPanel';
import { holdWork, startActivity, type ActivityHandle } from './activity';
import { FolderGuide } from './FolderGuide';
import { ArtFinder, type FinderFocus, type UsedCovers } from './ArtFinder';
import { albumKey, albumRefOf, coverSource, findFolderCover, folderCoverRank, songKey } from './albumArt';
import { decodePicture } from './artDecode';
import { itemKey } from './artLookup';
import { CoverRow } from './CoverRow';
import { applyChosenPicture, canTakeArt, coverSummary, coverWork, lookupFor, readChosenPicture, removeChosenPicture } from './coverRows';

type Stage =
  | { phase: 'idle' }
  | { phase: 'reading'; message: string }
  | { phase: 'converting'; message: string; fraction: number }
  | { phase: 'planned'; plan: SyncPlan; items: SyncItem[]; failed: string[]; precheck: PrecheckNotes }
  | { phase: 'syncing'; progress: SyncProgress | null }
  | { phase: 'done'; report: SyncReport }
  | { phase: 'error'; message: string };

/** What the check before converting and the check after it have to say, shown with the plan. */
interface PrecheckNotes {
  /** Files left out before converting, as duplicates. */
  skipped: number;
  /** Duplicates the plan found that the check before converting did not, in plain words. */
  missed: string[];
  /** Files left out as the same as one that then could not be converted. */
  sameAsFailed: string[];
}

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
 * button, and any failure puts the iPod back as it was. Reading the files and converting them can be
 * stopped, and converting can be paused after a file, from here or from the bar.
 */
export function AddPanel({
  root,
  device,
  backup,
  tracks = [],
  onChanged,
  onNeedBackup,
}: {
  root: DirectoryEntry;
  device: DeviceInfo | null;
  backup: BackupReport | null;
  /** The tracks on the iPod now, as the page last read them. Duplicates are checked against these, and again whenever they change. */
  tracks?: TrackInfo[];
  /** Called after files were put on the iPod, so the page reads it again. */
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
  /** The pause gate of the conversion that is running, so the panel can show Pause and Resume. */
  const [gate, setGate] = useState<PauseGate | null>(null);
  const pause = usePauseState(gate);
  const once = useOnce();
  /** A plain line about what just happened, such as a stopped read. */
  const [notice, setNotice] = useState('');
  /** True while "Clear the list" asks first. */
  const [clearing, setClearing] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const folderPicker = useRef<HTMLInputElement>(null);
  const [ignored, setIgnored] = useState(0);
  const [allowDuplicates, setAllowDuplicates] = useState(false);
  /** Files the person chose to add although they are duplicates, without ticking the box for all of them. */
  const [allowIds, setAllowIds] = useState<ReadonlySet<string>>(new Set());
  const [putArt, setPutArt] = useState(true);
  const coverPicker = useRef<HTMLInputElement>(null);
  /** The row the picture picker was opened for. */
  const coverTarget = useRef<string | null>(null);
  /** Why the last picture chosen for a row was refused, by row. */
  const [coverMessages, setCoverMessages] = useState<ReadonlyMap<string, string>>(new Map());
  /** Rows whose "Use this picture for all N files of this album" the person turned off. It is on unless listed. */
  const [sharedOff, setSharedOff] = useState<ReadonlySet<string>>(new Set());
  /** Rows whose guess from the file name the person accepted. */
  const [guesses, setGuesses] = useState<ReadonlySet<string>>(new Set());
  /** Set when a row's "Find a cover online" is pressed, so the finder opens and takes the cursor. */
  const [finderFocus, setFinderFocus] = useState<FinderFocus | null>(null);

  const { ready, backupOk, wait } = useWriteReady(backup);
  // Converted files are held in memory until they are copied. A reload would lose them, so say so before leaving.
  const holding = stage.phase === 'planned' || stage.phase === 'syncing';
  useEffect(() => {
    if (!holding) return undefined;
    return holdWork();
  }, [holding]);
  const busy = stage.phase === 'reading' || stage.phase === 'converting' || stage.phase === 'syncing';
  // Which files repeat one on the iPod or one above them, worked out again whenever the list, the iPod's
  // tracks or the choices change, and before anything is converted.
  const rows = useMemo(() => precheck(candidates, tracks, { allowAll: allowDuplicates, allowIds }), [candidates, tracks, allowDuplicates, allowIds]);
  const supported = candidates.filter((candidate) => candidate.decision.action !== 'unsupported');
  /** What will be converted or copied: supported files that are not skipped as duplicates. */
  const addable = supported.filter((candidate) => !rows.get(candidate.id)?.skipped);
  const counts = countsOf(candidates, rows);
  // Rows left out as duplicates never ask for a cover.
  const skippedIds = useMemo(() => new Set(candidates.filter((candidate) => rows.get(candidate.id)?.skipped).map((candidate) => candidate.id)), [candidates, rows]);
  const work = useMemo(() => coverWork(candidates, skippedIds, guesses), [candidates, skippedIds, guesses]);
  /** How many files of each album have no cover, so a row can offer one picture for all of them. */
  const albumFiles = useMemo(() => {
    const counted = new Map<string, number>();
    for (const candidate of candidates) {
      const ref = albumRefOf(candidate.info.tags);
      if (!ref || !canTakeArt(candidate, skippedIds.has(candidate.id)) || coverSource(candidate).from !== 'none') continue;
      counted.set(albumKey(ref), (counted.get(albumKey(ref)) ?? 0) + 1);
    }
    return counted;
  }, [candidates, skippedIds]);
  const convertBytes = sum(addable.filter((candidate) => candidate.decision.action === 'convert').map((candidate) => candidate.estimatedBytes));
  const capacityBytes = device && device.capacity_gb > 0 ? Math.round(device.capacity_gb * 1e9 * USABLE_SHARE) : undefined;

  /** Shows reading the files in the bar with a Stop. Nothing on the iPod is touched, so stopping is always safe. */
  function beginReading(label: string): { controller: AbortController; activity: ActivityHandle } {
    const controller = new AbortController();
    abort.current = controller;
    const activity = startActivity(label, {
      stop: { label: 'Stop reading (nothing is changed)', stopping: 'Stopping after the file being read...', run: () => controller.abort() },
    });
    return { controller, activity };
  }

  /** Reads each file, in order, and adds it to the list. `folder` is where it sat inside a chosen folder. */
  async function addToList(
    list: { file: File; folder: string; folders?: string[]; cover?: { name: string; file: File } | null }[],
    alreadyLeftOut = 0,
    reading: { controller: AbortController; activity: ActivityHandle } = beginReading('Reading the files'),
  ) {
    const { controller, activity } = reading;
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
      if (controller.signal.aborted) break;
      const message = `Reading ${index + 1} of ${media.length}: ${file.name}`;
      setStage({ phase: 'reading', message });
      activity.update(message, { fraction: index / media.length });
      try {
        added.push(await inspectFile(file, model, undefined, folder, folders, cover ?? undefined, controller.signal));
      } catch (error) {
        if (isStopped(error)) break;
        failed.push(`${file.name}: ${describeError(error)}`);
      }
    }
    setCandidates((previous) => [...previous, ...added]);
    setProblems(failed);
    if (controller.signal.aborted) {
      setNotice(
        added.length
          ? `Stopped. ${added.length} of ${media.length} files were read and are in the list. The rest were not added. Nothing on the iPod was changed.`
          : 'Stopped before any file was read. Nothing on the iPod was changed.',
      );
    }
    setStage({ phase: 'idle' });
  }

  /** Runs a read of the picked files from start to end, so the bar's entry always ends. */
  async function reading(label: string, job: (read: { controller: AbortController; activity: ActivityHandle }) => Promise<void>) {
    const read = beginReading(label);
    setNotice('');
    try {
      await job(read);
    } finally {
      read.activity.end(true, undefined, read.controller.signal.aborted);
      abort.current = null;
    }
  }

  async function choose(files: FileList | null) {
    if (!files?.length) return;
    setStage({ phase: 'reading', message: 'Reading the files...' });
    await reading('Reading the files', (read) => chooseNow(files, read));
  }

  async function chooseNow(files: FileList, read: { controller: AbortController; activity: ActivityHandle }) {
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
      0,
      read,
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
    await reading('Reading the folder', (read) => walkFolder(top, read));
  }

  async function walkFolder(top: FolderHandle, read: { controller: AbortController; activity: ActivityHandle }) {
    const { controller, activity } = read;
    try {
      const found: { file: File; folder: string; folders: string[]; dir: string[]; cover?: { name: string; file: File } | null }[] = [];
      let leftOut = 0;
      // Cover pictures (cover.jpg, folder.jpg ...) by folder. They are read only when a file uses one.
      const pictures = new Map<string, Map<string, FileHandleLike>>();
      const walk = async (directory: FolderHandle, parts: string[]): Promise<void> => {
        for await (const [name, entry] of directory.entries()) {
          controller.signal.throwIfAborted();
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
      activity.update(`Listing "${top.name}" and its subfolders...`);
      await walk(top, []);
      const opened = new Map<FileHandleLike, Promise<File>>();
      for (const item of found) {
        controller.signal.throwIfAborted();
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
      await addToList(found, leftOut, read);
    } catch (error) {
      if (isStopped(error)) {
        setNotice('Stopped while listing the folder. Nothing was added and nothing on the iPod was changed.');
      } else {
        setProblems([describeError(error)]);
      }
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
    setAllowIds((previous) => without(previous, id));
    setGuesses((previous) => without(previous, id));
    setSharedOff((previous) => without(previous, id));
    setStage({ phase: 'idle' });
  }

  /** The row's own picture picker: "Choose a picture...", "Replace the cover". */
  function openCoverPicker(id: string) {
    coverTarget.current = id;
    coverPicker.current?.click();
  }

  /** Reads, checks and decodes the picture chosen for a row (see readChosenPicture), then gives it to the row and, when ticked, its album. */
  async function chooseCover(files: FileList | null) {
    const id = coverTarget.current;
    const file = files?.[0];
    if (!id || !file) return;
    const result = await readChosenPicture(file);
    setCoverMessages((previous) => {
      const next = new Map(previous);
      if (result.ok) next.delete(id);
      else next.set(id, result.message);
      return next;
    });
    if (!result.ok) return;
    setCandidates((previous) => applyChosenPicture(previous, id, result.cover, { all: !sharedOff.has(id), skipped: skippedIds }));
    planChanged();
  }

  function removeCover(id: string) {
    setCandidates((previous) => removeChosenPicture(previous, id));
    planChanged();
  }

  function setGuess(id: string, accept: boolean) {
    setGuesses((previous) => (accept ? new Set(previous).add(id) : without(previous, id)));
  }

  function setShared(id: string, on: boolean) {
    setSharedOff((previous) => (on ? without(previous, id) : new Set(previous).add(id)));
  }

  /** "Find a cover online" on a row: open the finder, not collapsed, and point it at that row's album or song. */
  function findCoverFor(candidate: Candidate) {
    const how = lookupFor(candidate, guesses.has(candidate.id));
    if (how.kind !== 'album' && how.kind !== 'song') return;
    const key = itemKey(how.kind === 'album' ? { kind: 'album', ref: how.ref } : { kind: 'song', ref: how.ref });
    setFinderFocus((previous) => ({ key, nonce: (previous?.nonce ?? 0) + 1 }));
  }

  /** Puts what the person approved from the online finder on the rows: albums by their names, songs by title and artist. */
  function useOnlineCovers(covers: UsedCovers) {
    setCandidates((previous) =>
      previous.map((candidate) => {
        if (coverSource(candidate).from !== 'none') return candidate;
        const how = lookupFor(candidate, guesses.has(candidate.id));
        if (how.kind === 'album') {
          const cover = covers.albums.get(albumKey(how.ref));
          return cover ? { ...candidate, onlineCover: cover } : candidate;
        }
        if (how.kind !== 'song') return candidate;
        const hit = covers.songs.get(songKey(how.ref));
        if (!hit) return candidate;
        const withCover: Candidate = { ...candidate, onlineCover: hit.cover };
        return hit.albumName ? { ...withCover, albumFromMatch: hit.albumName, info: { ...candidate.info, tags: { ...candidate.info.tags, album: hit.albumName } } } : withCover;
      }),
    );
    setStage({ phase: 'idle' });
  }

  /** What was planned no longer matches the list, so it is dropped and the person is told. */
  function planChanged() {
    if (stage.phase !== 'planned') return;
    setNotice('You changed which files are added, so the earlier check no longer fits. Press Check and prepare again. The files converted before were thrown away, and nothing on the iPod changed.');
    setStage({ phase: 'idle' });
  }

  function chooseAllowAll(checked: boolean) {
    setAllowDuplicates(checked);
    planChanged();
  }

  /** Adds, or stops adding, one duplicate row without ticking the box for all of them. */
  function toggleAnyway(id: string) {
    setAllowIds((previous) => (previous.has(id) ? without(previous, id) : new Set(previous).add(id)));
    planChanged();
  }

  async function prepare() {
    await once(prepareNow);
  }

  async function prepareNow() {
    const controller = new AbortController();
    abort.current = controller;
    // Workers call checkpoint() between files. Here there is one: this loop.
    const pauseGate = new PauseGate();
    pauseGate.join();
    setGate(pauseGate);
    setNotice('');
    const items: SyncItem[] = [];
    const failed: string[] = [];
    const failedIds = new Set<string>();
    // Duplicates are decided before any file is converted. A skipped file is never read, converted or copied.
    const toPrepare = addable;
    const notes: PrecheckNotes = { skipped: counts.skipped, missed: [], sameAsFailed: [] };
    const activity = startActivity('Preparing files', {
      pause: pauseGate,
      stop: {
        label: 'Stop (nothing on the iPod changes)',
        confirm: 'Stop? The files converted so far are thrown away and would have to be converted again. Nothing on the iPod changes.',
        stopping: 'Stopping after the file being converted...',
        run: () => controller.abort(),
      },
    });
    try {
      for (const [index, candidate] of toPrepare.entries()) {
        // A pause waits between files, never in the middle of one.
        await pauseGate.checkpoint(controller.signal);
        controller.signal.throwIfAborted();
        const label = `${index + 1} of ${toPrepare.length}: ${candidate.file.name}`;
        activity.update(`Converting or reading ${label}`);
        setStage({ phase: 'converting', message: label, fraction: 0 });
        try {
          const item = await prepareItem(candidate, {
            playlist: playlist.trim() || undefined,
            signal: controller.signal,
            onProgress: (fraction) => {
              activity.update('', { fraction: (index + fraction) / toPrepare.length });
              setStage({ phase: 'converting', message: label, fraction });
            },
          });
          if (item) items.push(item);
          else failedIds.add(candidate.id);
        } catch (error) {
          if (controller.signal.aborted) throw error;
          // One file that cannot be converted must not stop the rest of a folder.
          failed.push(`${candidate.file.name}: ${describeError(error)}`);
          failedIds.add(candidate.id);
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
        allowDuplicateIds: [...allowIds],
        ...(putArt ? { artwork: { decode: decodePicture } } : {}),
        // Stop in the panel or the bar reaches the planner too.
        signal: controller.signal,
        onProgress: (message) => setStage({ phase: 'reading', message }),
      });
      // The plan is the safety net. It uses the same judge as the check made before converting, so it
      // should agree. If it found a duplicate the first check let through, say so.
      const nameOf = (id: string) => candidates.find((candidate) => candidate.id === id)?.file.name ?? id;
      for (const miss of missedDuplicates(rows, plan.duplicates)) {
        const on = miss.trackKey ? plan.tracksBefore.find((track) => trackKey(track) === miss.trackKey) : undefined;
        const what = miss.trackKey ? `already on the iPod${on ? ` as "${on.title}"` : ''}` : 'the same as another file in this list';
        notes.missed.push(`"${nameOf(miss.itemId)}" is ${what}. The check before converting did not catch this one, the last check did${miss.skipped ? ' and left it out' : ', and it is being added because duplicates are allowed'}.`);
      }
      // A file skipped as the same as an earlier one that then failed to convert would otherwise vanish.
      for (const candidate of candidates) {
        const row = rows.get(candidate.id);
        if (row?.skipped && row.state === 'in-list' && row.otherId && failedIds.has(row.otherId)) {
          notes.sameAsFailed.push(`"${candidate.file.name}" was skipped as the same as "${nameOf(row.otherId)}", which could not be converted, so neither is being added. Press Add this one anyway on "${candidate.file.name}" to use this copy instead.`);
        }
      }
      setStage({ phase: 'planned', plan, items, failed, precheck: notes });
    } catch (error) {
      if (controller.signal.aborted || isStopped(error)) {
        setNotice('Stopped. The files converted so far were thrown away, and nothing was written to the iPod.');
        setStage({ phase: 'idle' });
      } else {
        setStage({ phase: 'error', message: describeError(error) });
      }
    } finally {
      pauseGate.leave();
      setGate(null);
      const wasStopped = controller.signal.aborted;
      activity.end(wasStopped || items.length > 0, undefined, wasStopped);
      abort.current = null;
    }
  }

  /** Put on the iPod. A second click while the first is starting (Chrome's permission prompt takes a moment) does nothing. */
  async function sync(plan: SyncPlan) {
    await once(() => syncNow(plan));
  }

  async function syncNow(plan: SyncPlan) {
    try {
      // Chrome only shows its permission prompt straight from a click, so ask before anything else.
      if (!(await allowWriting(root))) {
        setStage({ phase: 'error', message: 'Chrome was not allowed to change the iPod, so nothing was written.' });
        return;
      }
      setStage({ phase: 'syncing', progress: null });
      // Stop and Pause come from the wrapper in tracked.ts and live in the bar at the top.
      const report = await applySync(plan, root as unknown as IpodRoot, newEngine, {
        backup,
        onProgress: (progress) => setStage({ phase: 'syncing', progress }),
      });
      setStage({ phase: 'done', report });
      if (report.verified && !report.rolledBack) {
        setCandidates([]);
        onChanged();
      }
    } catch (error) {
      setStage({ phase: 'error', message: describeError(error, { writing: true }) });
    }
  }

  return (
    <section class="card">
      <h3>Add music, podcasts, audiobooks and video</h3>
      <p class="card-lead">
        Pick files and see what happens to each one. Files the iPod cannot play are converted in this page, and nothing is uploaded. The iPod is not touched until the last button.
      </p>
      <FolderGuide />
      <BackupGate backup={backup} onGo={onNeedBackup} />

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
        <input
          ref={coverPicker}
          data-pick="cover"
          type="file"
          accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
          hidden
          onChange={(event) => {
            const input = event.target as HTMLInputElement;
            void chooseCover(input.files).then(() => {
              input.value = '';
            });
          }}
        />
        {candidates.length ? (
          <button type="button" class="secondary" disabled={busy || clearing} onClick={() => setClearing(true)}>
            Clear the list
          </button>
        ) : null}
      </div>

      {clearing && candidates.length ? (
        <ConfirmBox
          title={`Clear ${candidates.length} ${candidates.length === 1 ? 'file' : 'files'} from the list?`}
          confirmLabel="Yes, clear the list"
          cancelLabel="Keep the list"
          onConfirm={() => {
            setClearing(false);
            setCandidates([]);
            setAllowIds(new Set());
            setGuesses(new Set());
            setSharedOff(new Set());
            setCoverMessages(new Map());
            setProblems([]);
            setIgnored(0);
            setNotice('');
            setStage({ phase: 'idle' });
          }}
          onCancel={() => setClearing(false)}
        >
          <p>
            The list is emptied{stage.phase === 'planned' ? ' and the files converted so far are thrown away' : ''}. Your own files are not touched and nothing on the iPod changes. You can pick the files again.
          </p>
        </ConfirmBox>
      ) : null}

      {problems.length ? (
        <Notice tone="no">
          {problems.map((problem) => (
            <p key={problem}>{problem}</p>
          ))}
        </Notice>
      ) : null}
      {notice && stage.phase === 'idle' ? <Notice tone="info">{notice}</Notice> : null}

      {!candidates.length && stage.phase === 'idle' ? (
        <div class="empty">
          <strong>No files chosen yet</strong>
          Choose music, audiobooks, podcasts or video. MP3, AAC, M4A, FLAC, WAV, Ogg, Opus and most video formats work.
        </div>
      ) : null}

      {candidates.length ? (
        <p class="cover-summary" data-cover-summary aria-live="polite">
          {coverSummary(putArt, work)}
        </p>
      ) : null}

      {candidates.length ? (
        <div class="table-wrap stack-wrap">
          <table class="library stack add-stack">
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
                const dup = rows.get(candidate.id);
                const skipped = dup?.skipped === true;
                // The row's own button: add a skipped duplicate anyway, or take back that choice.
                const anyway = skipped ? 'add' : dup?.addedAnyway && !allowDuplicates && allowIds.has(candidate.id) ? 'undo' : null;
                return (
                  <tr key={candidate.id} class={skipped ? 'dup-skipped' : undefined} data-duplicate={dup && dup.state !== 'new' && dup.state !== 'not-added' ? dup.state : undefined}>
                    <td class="cell-title" data-label="File" title={candidate.file.name}>
                      {candidate.info.tags.title ?? candidate.file.name}
                      {candidate.folder ? <div class="path">{candidate.folder}</div> : null}
                      {candidate.filledFromFolders?.length ? <div class="path">{candidate.filledFromFolders.join(', ')} filled in from the folder and file names</div> : null}
                      {candidate.albumFromMatch ? <div class="path">album name filled in from the online match: {candidate.albumFromMatch}</div> : null}
                      {putArt ? (
                        <CoverRow
                          candidate={candidate}
                          skipped={skipped}
                          guessAccepted={guesses.has(candidate.id)}
                          albumFiles={(() => {
                            const ref = albumRefOf(candidate.info.tags);
                            return ref ? albumFiles.get(albumKey(ref)) ?? 0 : 0;
                          })()}
                          sharedOn={!sharedOff.has(candidate.id)}
                          message={coverMessages.get(candidate.id) ?? ''}
                          busy={busy}
                          onFind={findCoverFor}
                          onChoose={(row) => openCoverPicker(row.id)}
                          onRemove={(row) => removeCover(row.id)}
                          onGuess={(row, accept) => setGuess(row.id, accept)}
                          onShared={(row, on) => setShared(row.id, on)}
                        />
                      ) : null}
                      {dup?.label ? <DuplicateNote row={dup} /> : null}
                    </td>
                    <td data-label="Kind">
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
                    <td class={unsupported ? 'wrap no-text' : 'wrap'} data-label="What happens">
                      {skipped ? 'Nothing: not converted, not copied' : describeDecision(candidate.decision, candidate.info)}
                    </td>
                    <td class="num" data-label="On the iPod">{skipped ? 'Not added' : candidate.estimatedBytes === null ? '' : formatBytes(candidate.estimatedBytes)}</td>
                    <td class="cell-action">
                      {anyway ? (
                        <button type="button" class="secondary small" disabled={busy} onClick={() => toggleAnyway(candidate.id)} aria-label={`${anyway === 'add' ? 'Add this one anyway' : 'Skip this one again'}: ${candidate.file.name}`}>
                          {anyway === 'add' ? 'Add this one anyway' : 'Skip this one again'}
                        </button>
                      ) : null}
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
          <div class="dup-summary" aria-live="polite" aria-atomic="true">
            <p class="note">
              {addable.length} of {candidates.length} can be added, about {formatBytes(sum(addable.map((candidate) => candidate.estimatedBytes)))}.
              {counts.skipped ? ` ${counts.skipped} skipped as ${counts.skipped === 1 ? 'a duplicate' : 'duplicates'}.` : ''}
            </p>
            <p class="note" data-prepare-counts>
              <strong>{summaryOf(counts)}.</strong>
            </p>
          </div>
          {counts.skipped ? (
            <Notice tone="info" scroll={false}>
              <p>
                {counts.skipped} {counts.skipped === 1 ? 'file is' : 'files are'} already on the iPod or repeat{counts.skipped === 1 ? 's' : ''} another file in this list. {counts.skipped === 1 ? 'It is' : 'They are'} not converted or copied, so no time is spent on {counts.skipped === 1 ? 'it' : 'them'}. Use Add this one anyway on a row, or tick the box below to add all of them.
              </p>
            </Notice>
          ) : null}
          {candidates.some((candidate) => rows.get(candidate.id)?.state === 'cannot-tell') ? (
            <p class="note">Files marked "Could not tell" have no title to compare, so they are let through, as the final check does too.</p>
          ) : null}
          {supported.length && !addable.length ? (
            <p class="note">Every file in the list is a duplicate, so there is nothing to convert. Tick the box below or use Add this one anyway on a row to add some.</p>
          ) : null}
          {ignored ? <p class="note">{ignored} other file{ignored === 1 ? ' was' : 's were'} left out because they are not music, audiobooks, podcasts or video (cover pictures, playlists, system files).</p> : null}
          {convertBytes > LARGE_BATCH_BYTES ? (
            <div class="callout warn">
              <p>
                <strong>This is a large batch.</strong> Converted files are held in this tab's memory until they are copied, about {formatBytes(convertBytes)} here. If the tab runs out of memory, add the files in smaller groups.
              </p>
            </div>
          ) : null}
          <label class="check">
            <input type="checkbox" checked={allowDuplicates} disabled={busy} onChange={(event) => chooseAllowAll((event.target as HTMLInputElement).checked)} />
            Add files even if the same song, episode or title is already on the iPod
          </label>
          <label class="check">
            <input type="checkbox" checked={putArt} disabled={busy} onChange={(event) => setPutArt((event.target as HTMLInputElement).checked)} />
            Put cover pictures on the iPod (from inside the files, or cover.jpg and folder.jpg beside them). Writing cover art has not been tried on a real iPod yet.
          </label>
          {putArt ? <ArtFinder candidates={candidates} skipped={skippedIds} guesses={guesses} disabled={busy} focus={finderFocus} onUse={useOnlineCovers} /> : null}
          <label class="field">
            Put them in a playlist (optional)
            <input type="text" value={playlist} disabled={busy} onInput={(event) => setPlaylist((event.target as HTMLInputElement).value)} placeholder="Playlist name" />
          </label>
          <div class="actions">
            <button type="button" disabled={busy || !addable.length} onClick={() => void prepare()} title={addable.length ? summaryOf(counts) : undefined}>
              Check and prepare
            </button>
            {stage.phase === 'converting' && gate ? (
              <button type="button" class="secondary" onClick={() => (pause === 'running' ? gate.request() : gate.resume())}>
                {pause === 'running' ? 'Pause after this file' : pause === 'pausing' ? 'Cancel the pause' : 'Resume'}
              </button>
            ) : null}
            {busy && abort.current ? (
              <button type="button" class="secondary" onClick={() => abort.current?.abort()}>
                {stage.phase === 'reading' && !gate ? 'Stop (nothing is changed)' : 'Stop (nothing on the iPod changes)'}
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
            {pause === 'paused' ? 'Paused before the next file. ' : pause === 'pausing' ? 'Pausing after this file. ' : ''}Converting {stage.message} ({Math.round(stage.fraction * 100)}%)
          </p>
          <progress max={1} value={stage.fraction} />
        </div>
      ) : null}
      {stage.phase === 'error' ? (
        <Notice tone="no">
          <p style="white-space: pre-wrap">{stage.message}</p>
        </Notice>
      ) : null}

      {stage.phase === 'planned' ? <Planned plan={stage.plan} failed={stage.failed} notes={stage.precheck} ready={ready} backupOk={backupOk} wait={wait} onSync={() => void sync(stage.plan)} onNeedBackup={onNeedBackup} /> : null}

      {stage.phase === 'syncing' ? (
        <>
          <p class="callout info" role="status">
            {stage.progress?.message ?? 'Starting...'}
          </p>
          {stage.progress && stage.progress.bytesTotal > 0 ? (
            <progress max={stage.progress.bytesTotal} value={stage.progress.bytesDone} style="width: 100%" />
          ) : null}
          {stage.progress?.bytesPerSecond ? <p class="muted">{formatBytes(stage.progress.bytesPerSecond)}/s</p> : null}
          <p class="note">
            Stop and Pause are in the bar at the top, which stays in view on every tab. Stop undoes what was copied. It is off for the last few seconds, while the library is written, because stopping then could not be undone safely.
          </p>
        </>
      ) : null}

      {stage.phase === 'done' ? <Done report={stage.report} /> : null}
    </section>
  );
}

function Planned({ plan, failed, notes, ready, backupOk, wait, onSync, onNeedBackup }: { plan: SyncPlan; failed: string[]; notes: PrecheckNotes; ready: boolean; backupOk: boolean; wait: string | null; onSync: () => void; onNeedBackup?: () => void }) {
  const fits = plan.space.fits;
  return (
    <>
      <Notice tone={plan.files.length && fits !== false ? 'ok' : 'no'}>
        <p>
          {plan.files.length
            ? `Ready to copy ${plan.files.length} file${plan.files.length === 1 ? '' : 's'} (${formatBytes(plan.bytesToCopy)}).`
            : 'Nothing would be copied.'}
          {fits === false ? ' They do not fit on the iPod.' : ''}
        </p>
      </Notice>
      {notes.skipped ? (
        <p class="note">
          {notes.skipped} {notes.skipped === 1 ? 'file was' : 'files were'} skipped as {notes.skipped === 1 ? 'a duplicate' : 'duplicates'} before converting, so {notes.skipped === 1 ? 'it was' : 'they were'} never converted.
        </p>
      ) : null}
      {notes.missed.length ? (
        <Notice tone="warn">
          <p>
            <strong>{notes.missed.length === 1 ? 'The last check found a duplicate that the first check missed:' : `The last check found ${notes.missed.length} duplicates that the first check missed:`}</strong>
          </p>
          {notes.missed.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </Notice>
      ) : null}
      {notes.sameAsFailed.length ? (
        <Notice tone="warn">
          {notes.sameAsFailed.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </Notice>
      ) : null}
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
        {!backupOk ? (
          <span class="note">
            Off until you make a backup.{' '}
            {onNeedBackup ? (
              <button type="button" class="ghost small" onClick={onNeedBackup}>
                Go to Backup
              </button>
            ) : null}
          </span>
        ) : wait ? (
          <WriteWait wait={wait} />
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
  const stopped = !good && report.aborted && !report.rollbackFailures.length && !report.restoreNeeded;
  return (
    <>
      <Notice tone={good ? 'ok' : stopped ? 'info' : 'no'}>
        <p>
          {good
            ? `Copied ${report.copied.length} file${report.copied.length === 1 ? '' : 's'} and checked the iPod by reading it back. Eject it from the computer before you unplug it.`
            : report.aborted
              ? 'Stopped. What was done has been undone.'
              : 'Adding the music did not finish.'}
        </p>
      </Notice>
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
        <Notice tone="no">
          <p>The iPod could not be put back completely. Do not use it as it is: restore the backup below.</p>
          {report.rollbackFailures.map((failure) => (
            <p key={failure}>{failure}</p>
          ))}
        </Notice>
      ) : null}
    </>
  );
}

/** What the duplicate check says about a file, as words with a label, so it never relies on colour. */
function DuplicateNote({ row }: { row: RowDuplicate }) {
  const kind = row.skipped ? 'skip' : row.state === 'cannot-tell' ? 'unsure' : 'anyway';
  return (
    <div class={`dup-note ${kind}`} data-dup={row.state}>
      <strong class="dup-badge">{row.label}</strong>
      <span class="dup-text"> {row.text}</span>
    </div>
  );
}

function without(set: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(set);
  next.delete(id);
  return next;
}
