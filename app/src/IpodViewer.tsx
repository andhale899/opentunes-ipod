import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { formatBytes, formatDuration, isValidFireWireId, kindLabel } from '@opentunes/core';
import {
  IpodFolderError,
  buildDemoIpod,
  buildSignedDemoIpod,
  buildUnsyncedIpod,
  findFireWireId,
  loadIpodFolder,
  memoryDirectory,
  verifySignatures,
  type BackupReport,
  type DeviceInfo,
  type DirectoryEntry,
  type Engine,
  type LoadReport,
  type PlaylistInfo,
  type SignatureCheck,
  type SignatureStatus,
  type TrackInfo,
  type WritableDirectory,
} from '@opentunes/engine';
import { AddPanel } from './AddPanel';
import { AssistantPanel } from './AssistantPanel';
import { BackupPanel } from './BackupPanel';
import { describeError } from './describeError';
import { newEngine } from './engineLoader';
import { ManagePanel } from './ManagePanel';
import { OffloadPanel } from './OffloadPanel';
import { PanelBoundary } from './PanelBoundary';
import { currentActivity, startActivity } from './activity';
import { JournalBanner } from './Banners';
import { IpodAccessError, DISCONNECTED } from './friendlyError';
import { forgetIpodHandle, loadIpodHandle, saveBackupRecord, saveIpodHandle, type SavedIpod } from './handles';
import { checkFolderAlive, isFolderAlive, regainAccess } from './ipodAccess';
import { loadLeftBehind, setJournalContext } from './journal';
import { logError, logOk, logStep } from './log';
import { buildPracticeIpod, exposePracticeForTests } from './practice';
import { ReuseBackup, rememberBackup } from './ReuseBackup';
import { RestoreEverythingPanel } from './RestoreEverythingPanel';
import { fingerprintOf, reloadMessage } from './staleness';
import { WriteBusyError, beginRead, tabLockHeld, useLockState, type LocksLike } from './writeLock';
import { RestorePanel } from './RestorePanel';
import { RewritePanel } from './RewritePanel';
import { WriteBackPanel } from './WriteBackPanel';

const MAX_ROWS = 200;
const MOUNT = '/ipod';

interface Snapshot {
  source: 'folder' | 'demo' | 'practice';
  /** The iPod's top folder, kept so the backup and the rewrite check can read it again. */
  root: DirectoryEntry;
  folderName: string;
  device: DeviceInfo | null;
  tracks: TrackInfo[];
  playlists: PlaylistInfo[];
  load: LoadReport | null;
  /** Whether the signatures iTunes left on the iPod match what the engine computes. */
  signatures: SignatureCheck[] | null;
  /** When the iPod was read, in milliseconds since 1970. */
  readAt: number;
}

/** What the reader had found when something went wrong, so a failure can be diagnosed. */
interface Diagnostics {
  folderName: string;
  load: LoadReport;
  error: string;
  signatures: SignatureCheck[] | null;
}

type View =
  | { phase: 'idle' }
  | { phase: 'working'; message: string }
  | { phase: 'ready'; snapshot: Snapshot }
  | { phase: 'error'; message: string; diagnostics?: Diagnostics };

type Picker = (options?: { mode?: 'read' | 'readwrite' }) => Promise<unknown>;

/** Reads everything the page shows from an open engine, so the engine can be closed afterwards. */
function snapshotOf(engine: Engine, source: Snapshot['source'], root: DirectoryEntry, load: LoadReport | null, signatures: SignatureCheck[] | null): Snapshot {
  let device: DeviceInfo | null = null;
  try {
    device = engine.device();
  } catch {
    device = null;
  }
  return { source, root, folderName: root.name, device, tracks: engine.tracks(), playlists: engine.playlists(), load, signatures, readAt: Date.now() };
}

/**
 * Compares the signatures on the iPod's own database files with what the engine computes.
 * Uses the FireWire ID libgpod found when a database is open, and the device files otherwise.
 * This is an extra check, so a problem inside it is reported as a result, never thrown.
 */
async function checkSignatures(engine: Engine, mount: string): Promise<SignatureCheck[]> {
  let fireWireId: string | null = null;
  try {
    fireWireId = engine.device().firewire_id;
  } catch {
    fireWireId = null; // no database is open, so ask the device files directly
  }
  try {
    return await verifySignatures(engine, mount, fireWireId ?? findFireWireId(engine, mount));
  } catch (error) {
    return [{ file: 'iTunesCDB', status: 'unsupported', detail: `The check could not run: ${describeError(error)}` }];
  }
}

const SIGNATURE_STATUS: Record<SignatureStatus, string> = {
  matches: 'Matches what the engine computes',
  differs: 'Does not match',
  unsupported: 'Could not be checked',
  missing: 'Not on this iPod',
};

/** True when there is something to say about signatures, so a demo iPod does not show empty rows. */
const hasSignatureNews = (signatures: SignatureCheck[] | null): signatures is SignatureCheck[] =>
  signatures !== null && signatures.some((check) => check.status !== 'missing');

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

function countBy<T>(items: T[], key: (item: T) => string): [string, number][] {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

const SIGNING: Record<DeviceInfo['checksum'], string> = {
  none: 'None needed',
  hash58: 'Signed with hash58',
  hash72: 'Signed with hash72',
  hashAB: 'Signed with hashAB',
  unknown: 'Unknown scheme',
};

function reportOf(snapshot: Snapshot): string {
  return JSON.stringify(
    {
      app: 'opentunes',
      view: 'ipod-reader',
      generatedAt: new Date().toISOString(),
      source: snapshot.source,
      folderName: snapshot.folderName,
      device: snapshot.device,
      counts: {
        tracks: snapshot.tracks.length,
        playlists: snapshot.playlists.length,
        byKind: Object.fromEntries(countBy(snapshot.tracks, (track) => track.kind)),
      },
      playlists: snapshot.playlists.map(({ name, master, podcasts, smart, tracks }) => ({ name, master, podcasts, smart, tracks: tracks.length })),
      signatures: snapshot.signatures,
      load: snapshot.load && { ...snapshot.load, skipped: snapshot.load.skipped.length, musicFolders: snapshot.load.musicFolders.length },
    },
    null,
    2,
  );
}

function diagnosticsOf({ folderName, load, error, signatures }: Diagnostics): string {
  return JSON.stringify(
    {
      app: 'opentunes',
      view: 'ipod-reader-diagnostics',
      generatedAt: new Date().toISOString(),
      folderName,
      error,
      signatures,
      load: { ...load, skipped: load.skipped.length, musicFolders: load.musicFolders.length },
    },
    null,
    2,
  );
}

function FileList({ load }: { load: LoadReport }) {
  return (
    <details>
      <summary>Files read from the iPod ({load.listing.length})</summary>
      <ul class="files">
        {load.listing.map((file) => (
          <li key={file.path}>
            {file.path} <span class="muted">{formatBytes(file.size)}</span>
          </li>
        ))}
        {load.notNeeded.map((file) => (
          <li key={file.path}>
            {file.path} <span class="muted">{formatBytes(file.size)}, not read: libgpod never opens it</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function Facts({ snapshot }: { snapshot: Snapshot }) {
  const { device, tracks, playlists, load } = snapshot;
  const kinds = countBy(tracks, (track) => track.kind);
  // libgpod judges video from the model number alone, so for a model it does not know it always says no.
  const recognised = device?.device_recognized === true;
  const supports = device
    ? Object.entries(device.supports)
        .filter(([name, on]) => on && (recognised || name !== 'video'))
        .map(([name]) => name.replace('_', ' '))
    : [];
  const idValid = isValidFireWireId(device?.firewire_id);
  const needsId = device !== null && device.checksum !== 'none';

  const rows: [string, string][] = [
    ['Source', snapshot.source === 'demo' ? 'Demo data, not a real iPod' : snapshot.source === 'practice' ? 'Practice iPod held in memory. Changes stay in this page and are gone when it reloads' : `Folder "${snapshot.folderName}"`],
    ['Model number on the iPod', device?.model_num_str ?? 'not stated'],
    [
      'Model as libgpod knows it',
      device?.device_recognized ? [device.model_name, device.generation_name].filter(Boolean).join(', ') : 'Not recognised',
    ],
    ['Capacity', device && device.capacity_gb > 0 ? `${device.capacity_gb} GB` : 'unknown'],
    ['Database signing', device ? SIGNING[device.checksum] : 'unknown'],
    [
      'FireWire ID',
      device?.firewire_id
        ? `${device.firewire_id}${needsId ? (idValid ? ' (looks valid)' : ' (not a valid ID, writing would fail)') : ''}`
        : needsId
          ? 'not found, writing would fail'
          : 'not needed',
    ],
    ['Device description file', device?.has_sysinfo_extended ? 'SysInfoExtended found' : 'No SysInfoExtended'],
    [
      'Supports, according to libgpod',
      `${supports.length ? supports.join(', ') : 'nothing listed'}${device && !recognised ? '. Video is not judged for an unknown model' : ''}`,
    ],
    ['Library', `${plural(tracks.length, 'track')}, ${plural(playlists.length, 'playlist')}${kinds.length ? ` (${kinds.map(([kind, n]) => `${n} ${kindLabel(kind).toLowerCase()}`).join(', ')})` : ''}`],
  ];
  if (hasSignatureNews(snapshot.signatures)) {
    for (const check of snapshot.signatures) {
      rows.push([
        `Signature on ${check.file}`,
        check.status === 'matches' ? SIGNATURE_STATUS.matches : `${SIGNATURE_STATUS[check.status]}. ${check.detail}`,
      ]);
    }
  }
  if (load) {
    rows.push(['Read from the iPod', `${load.files} database files, ${formatBytes(load.bytes)}, ${load.musicFolders.length} music folders`]);
    const leftOut = [
      load.skipped.length ? `${plural(load.skipped.length, 'clutter file')}` : '',
      load.notNeeded.length ? `${plural(load.notNeeded.length, 'file')} libgpod never opens (${formatBytes(load.notNeeded.reduce((sum, file) => sum + file.size, 0))})` : '',
    ].filter(Boolean);
    if (leftOut.length) rows.push(['Left out', leftOut.join(', ')]);
  }

  return (
    <section class="card">
      <h3>Device details</h3>
      <dl class="facts">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {device && !device.device_recognized ? (
        <p class="note">
          libgpod does not recognise this model number. That is expected for a nano 6th or 7th generation with the libgpod version in use. The signing scheme, artwork, photo and podcast support come from the iPod's own description file instead. Video is left out of the list because libgpod only judges it from the model number, so for a model it does not know it always says no.
        </p>
      ) : null}
    </section>
  );
}

function Library({ tracks }: { tracks: TrackInfo[] }) {
  if (tracks.length === 0) {
    return (
      <div class="empty">
        <strong>The library is empty</strong>
        Nothing has been synced to this iPod yet.
      </div>
    );
  }
  return (
    <div class="table-wrap stack-wrap">
      <table class="library stack">
        <thead>
          <tr>
            <th>Title</th>
            <th>Artist</th>
            <th>Album</th>
            <th>Kind</th>
            <th class="num">Length</th>
            <th class="num">Size</th>
          </tr>
        </thead>
        <tbody>
          {tracks.slice(0, MAX_ROWS).map((track) => (
            <tr key={track.handle} title={track.ipod_path ?? ''}>
              <td class="cell-title">{track.title ?? '(no title)'}</td>
              <td class="cell-artist">{track.artist ?? ''}</td>
              <td class="cell-album">{track.album ?? ''}</td>
              <td class="cell-meta">{kindLabel(track.kind)}</td>
              <td class="num cell-meta">{formatDuration(track.tracklen)}</td>
              <td class="num cell-meta">{formatBytes(track.size)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {tracks.length > MAX_ROWS ? <p class="muted">Showing the first {MAX_ROWS} of {tracks.length} tracks.</p> : null}
    </div>
  );
}

type Tab = 'library' | 'add' | 'assistant' | 'backup' | 'offload' | 'diagnostics';

export function IpodViewer({
  canPickFolder,
  syncReady,
  blockers,
  environment,
}: {
  canPickFolder: boolean;
  syncReady: boolean;
  blockers: string[];
  environment: ComponentChildren;
}) {
  const [tab, setTab] = useState<Tab>(() => {
    const asked = new URLSearchParams(window.location.search).get('tab');
    return asked === 'add' || asked === 'backup' || asked === 'offload' || asked === 'diagnostics' ? asked : 'library';
  });
  const [view, setView] = useState<View>({ phase: 'idle' });
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  /** The backup made on this page, which the write-back needs before it will start. */
  const [backup, setBackup] = useState<BackupReport | null>(null);
  /** The iPod folder remembered from an earlier visit, offered as Reconnect. */
  const [saved, setSaved] = useState<SavedIpod | null>(null);
  /** Bumped to throw away every panel's own state, when the iPod changed behind the page's back. */
  const [epoch, setEpoch] = useState(0);
  /** Bumped whenever a read finds a different library, so panels that hold results about it start fresh. */
  const [dataVersion, setDataVersion] = useState(0);
  /** What the last Reload from the iPod found. */
  const [reloadNote, setReloadNote] = useState('');
  /** Set when a read after a change failed, so the screen keeps showing what was read before. */
  const [readProblem, setReadProblem] = useState('');
  /** True when the iPod's folder stopped answering. */
  const [disconnected, setDisconnected] = useState(false);
  const fingerprint = useRef<string | null>(null);
  const wantTab = useRef<Tab | null>(null);
  const lock = useLockState();
  const changing = lock.writing !== null;

  async function chooseFolder() {
    const picker = (window as unknown as { showDirectoryPicker?: Picker }).showDirectoryPicker;
    if (!picker) {
      setView({ phase: 'error', message: 'This browser has no folder picker. Use Chrome or Edge on a computer.' });
      return;
    }
    let handle: unknown;
    try {
      handle = await picker.call(window, { mode: 'read' });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        setView({ phase: 'error', message: describeError(error) });
      }
      return;
    }

    const directory = handle as DirectoryEntry;
    // Kept so that after a reload the landing page can offer Reconnect instead of starting over.
    void saveIpodHandle(directory.name, handle).then(() => loadIpodHandle().then(setSaved));
    await readIpod(directory, 'folder');
  }

  /** Reconnect: asks Chrome for access again, from the click, then reads the iPod. */
  async function reconnect(handle: unknown, name: string, refresh = false) {
    logStep('reconnect', `Reconnect was used for "${name}".`);
    let answer: 'granted' | 'denied';
    try {
      answer = await regainAccess(handle, 'read');
    } catch (error) {
      answer = 'denied';
      logError('reconnect', `Chrome could not be asked: ${describeError(error)}`);
    }
    if (answer !== 'granted') {
      logError('reconnect', `Access to "${name}" was not given.`);
      const message = `Chrome did not give access to "${name}". Use Reconnect again and choose Allow, or choose the folder again.`;
      if (refresh) setReadProblem(message);
      else setView({ phase: 'error', message });
      return;
    }
    logOk('reconnect', `Access to "${name}" was given.`);
    await readIpod(handle as DirectoryEntry, 'folder', refresh, { reload: refresh });
  }

  async function forgetSaved() {
    await forgetIpodHandle();
    setSaved(null);
  }

  /**
   * The one path every iPod takes, real or demo: copy its database files in, open, read.
   * `refresh` keeps the panels on screen after a change made here. `reload` is the person asking to
   * read the iPod again for a change made outside this page.
   */
  async function readIpod(directory: DirectoryEntry, source: Snapshot['source'], refresh = false, options: { reload?: boolean } = {}) {
    // A read is refused while a change is running, so a plan is never made from half a write.
    let endRead: () => void;
    try {
      endRead = beginRead(refresh ? 'Reading the iPod again' : 'Reading the iPod');
    } catch (error) {
      const message = error instanceof WriteBusyError ? error.message : describeError(error);
      if (refresh) setReadProblem(message);
      else setView({ phase: 'error', message });
      return;
    }
    // A refresh after a change made here keeps the panels on screen, so their results stay readable,
    // and keeps the backup, which is still the restore point.
    const activity = startActivity(refresh ? 'Reading the iPod again' : 'Reading the iPod', { message: 'Loading the engine...' });
    const progress = (message: string) => {
      activity.update(message);
      if (!refresh) setView({ phase: 'working', message });
    };
    progress('Loading the engine...');
    if (!refresh) {
      setBackup(null);
      setReadProblem('');
      setReloadNote('');
    }
    let engine: Engine | null = null;
    let load: LoadReport | null = null;
    try {
      // Without this a folder whose iPod was unplugged looks like "no iPod_Control folder".
      if (source === 'folder') await checkFolderAlive(directory);
      engine = await newEngine();
      load = await loadIpodFolder(directory, engine, {
        mount: MOUNT,
        onProgress: progress,
      });
      if (!load.hasDatabaseFolder) {
        throw new IpodFolderError(`"${directory.name}" has an iPod_Control folder but no iTunes folder inside it, so this iPod has no database yet. There is nothing to read.`);
      }
      engine.open(load.mount);
      const signatures = await checkSignatures(engine, load.mount);
      const next = snapshotOf(engine, source, directory, load, signatures);
      const print = fingerprintOf({ tracks: next.tracks, playlists: next.playlists, files: load.listing });
      const before = view.phase === 'ready' ? view.snapshot : null;
      const changed = refresh && fingerprint.current !== null && print !== fingerprint.current;
      fingerprint.current = print;
      setView({ phase: 'ready', snapshot: next });
      setReadProblem('');
      setDisconnected(false);
      if (!refresh) {
        setEpoch((value) => value + 1);
        if (wantTab.current) {
          setTab(wantTab.current);
          wantTab.current = null;
        }
      } else if (changed) {
        setDataVersion((value) => value + 1);
      }
      if (options.reload) {
        const readAtText = new Date(next.readAt).toLocaleTimeString();
        if (changed) {
          // Something else changed the iPod, so what the panels hold and the earlier backup are out of date.
          setEpoch((value) => value + 1);
          setBackup(null);
          logError('page', `The iPod changed outside this page (${before?.tracks.length ?? 0} tracks before, ${next.tracks.length} now). The screens were reset and the backup no longer counts.`);
        }
        setReloadNote(reloadMessage({ changed, before: before?.tracks.length ?? 0, after: next.tracks.length, readAtText }));
      }
      engine.close();
      activity.end(true);
    } catch (error) {
      const message = describeError(error);
      activity.end(false, message);
      if (error instanceof IpodAccessError && error.problem === 'disconnected') setDisconnected(true);
      if (refresh) {
        // Keep what was on screen: the person's results are still there, and nothing has been lost.
        setReadProblem(`The iPod could not be read again: ${message} The library shown is from the last time it was read.`);
        return;
      }
      // When the database would not open, the signatures can still say whether the files are intact.
      const signatures = engine && load?.hasDatabaseFolder ? await checkSignatures(engine, load.mount) : null;
      setView({ phase: 'error', message, diagnostics: load ? { folderName: directory.name, load, error: message, signatures } : undefined });
    } finally {
      endRead();
    }
  }

  async function showDemo(variant: 'full' | 'signed' | 'unsynced' | 'practice' = 'full') {
    setView({ phase: 'working', message: 'Building a demo iPod...' });
    try {
      const demo = await newEngine();
      if (variant === 'full') buildDemoIpod(demo, MOUNT);
      else if (variant === 'signed') buildSignedDemoIpod(demo, MOUNT);
      else if (variant === 'unsynced') buildUnsyncedIpod(demo, MOUNT);
      if (variant === 'practice') {
        const practice = await buildPracticeIpod(demo, MOUNT);
        exposePracticeForTests(practice);
        await readIpod(practice, 'practice');
        return;
      }
      await readIpod(memoryDirectory(demo, MOUNT, 'DEMO IPOD'), 'demo');
    } catch (error) {
      setView({ phase: 'error', message: describeError(error) });
    }
  }

  useEffect(() => {
    const demo = new URLSearchParams(window.location.search).get('demo');
    if (demo !== null) void showDemo(demo === 'unsynced' ? 'unsynced' : demo === 'signed' ? 'signed' : demo === 'practice' ? 'practice' : 'full');
    // After a reload: the folder remembered from last time, and a note about a change that never finished.
    void loadIpodHandle().then(setSaved);
    const locks = typeof navigator === 'undefined' ? undefined : (navigator as unknown as { locks?: LocksLike }).locks;
    void loadLeftBehind({ writeInProgressElsewhere: () => tabLockHeld(locks) });
  }, []);

  // What the interrupted-write note records about the open iPod: its folder name and its backup's folder name.
  useEffect(() => {
    const open = view.phase === 'ready' ? view.snapshot : null;
    setJournalContext({ ipod: open?.folderName ?? null, backup: backup?.folder ?? null, practice: open?.source === 'practice' });
  }, [view, backup]);

  // The iPod may be unplugged at any time and Chrome says nothing, so ask its folder every few
  // seconds while no job is running, and at once when the tab comes back or a USB device leaves.
  const openFolder = view.phase === 'ready' && view.snapshot.source === 'folder' ? view.snapshot.root : null;
  useEffect(() => {
    if (!openFolder) return;
    let stopped = false;
    const check = async () => {
      if (stopped || currentActivity().active.length) return;
      if (!(await isFolderAlive(openFolder)) && !stopped) {
        setDisconnected((already) => {
          if (!already) logError('page', 'The iPod folder stopped answering. The iPod was probably unplugged or ejected.');
          return true;
        });
      }
    };
    const timer = window.setInterval(() => void check(), 5000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void check();
    };
    document.addEventListener('visibilitychange', onVisible);
    const usb = (navigator as unknown as { usb?: EventTarget }).usb;
    const onUsb = () => void check();
    usb?.addEventListener('disconnect', onUsb);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      usb?.removeEventListener('disconnect', onUsb);
    };
  }, [openFolder]);

  async function copyReport(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied('copied');
    } catch {
      setCopied('failed');
    }
  }

  const working = view.phase === 'working';
  const ready = view.phase === 'ready' ? view.snapshot : null;
  const writable = ready !== null && ready.source !== 'demo';
  const tabs: [Tab, string][] = writable
    ? [['library', 'Library'], ['add', 'Add music'], ['assistant', 'Assistant'], ['backup', 'Backup'], ['offload', 'Offload'], ['diagnostics', 'Diagnostics']]
    : [['library', 'Library'], ['diagnostics', 'Diagnostics']];
  const current: Tab = tabs.some(([id]) => id === tab) ? tab : 'library';
  const refreshed = () => (ready ? readIpod(ready.root, ready.source, true) : undefined);
  const reloadFromIpod = () => (ready ? (ready.source === 'folder' ? reconnect(ready.root, ready.folderName, true) : readIpod(ready.root, ready.source, true, { reload: true })) : undefined);
  /** From the note about an unfinished change: the Backup tab if an iPod is open, otherwise once one is. */
  const goToBackup = () => {
    if (writable) setTab('backup');
    else wantTab.current = 'backup';
  };
  const onBackupDone = (report: BackupReport, destination?: WritableDirectory) => {
    setBackup(report);
    if (destination && ready && ready.source === 'folder') void rememberBackup(report, destination, ready.folderName);
  };

  const loadingNote =
    view.phase === 'working' ? (
      <p class="callout info" role="status">
        {view.message}
      </p>
    ) : null;

  if (!ready) {
    return (
      <>
        <JournalBanner onGoToBackup={goToBackup} />
        <section class="hero">
          <div>
            <h1>Put your music on an iPod, without iTunes.</h1>
            <p class="lead">
              OpenTunes reads your iPod, backs it up, then adds music, podcasts, audiobooks and video. It runs in this browser tab. Nothing is uploaded unless you turn the AI assistant on or use the optional online album art lookup (artist and album names only), and nothing is installed.
            </p>
            <p class="callout info tested-note">
              <strong>Tested on the iPod nano 7th generation only.</strong> Other iPods are supported from published specifications and have never been tried, so treat them as experimental. Always make the backup first.
            </p>
            <div class="actions">
              <button type="button" onClick={() => void chooseFolder()} disabled={working || !canPickFolder}>
                Choose iPod folder
              </button>
              <button type="button" class="secondary" onClick={() => void showDemo('practice')} disabled={working}>
                Try a practice iPod
              </button>
            </div>
            <p class="note">The practice iPod lives in memory, so you can try everything with no risk to a real one.</p>
            {saved && canPickFolder ? (
              <div class="callout info reconnect" role="note">
                <p>
                  Last time you used the folder "{saved.name}". Chrome forgets the permission when the page reloads, so it will ask again.
                </p>
                <div class="actions">
                  <button type="button" onClick={() => void reconnect(saved.handle, saved.name)} disabled={working}>
                    Reconnect {saved.name}
                  </button>
                  <button type="button" class="ghost small" onClick={() => void forgetSaved()} disabled={working}>
                    Forget this folder
                  </button>
                </div>
              </div>
            ) : null}
            {!canPickFolder ? <div class="callout no">This browser has no folder picker, so only the practice iPod is available. Use Chrome or Edge on a computer.</div> : null}
            {canPickFolder && !syncReady ? (
              <div class="callout warn">
                <p>
                  <strong>This browser is missing something an iPod needs.</strong>
                </p>
                {blockers.map((blocker) => (
                  <p key={blocker}>{blocker}</p>
                ))}
              </div>
            ) : null}
            {loadingNote}
            {view.phase === 'error' ? (
              <>
                <div class="callout no" role="alert">
                  <p>{view.message}</p>
                </div>
                {view.diagnostics ? (
                  <>
                    <FileList load={view.diagnostics.load} />
                    <button type="button" class="secondary" onClick={() => void copyReport(diagnosticsOf(view.diagnostics as Diagnostics))}>
                      Copy diagnostic report
                    </button>
                    {copied === 'copied' ? <span class="note"> Copied.</span> : null}
                    {copied === 'failed' ? <span class="note"> Copy failed.</span> : null}
                  </>
                ) : null}
              </>
            ) : null}
          </div>
          <div class="card">
            <h3>How it works</h3>
            <ol class="steps">
              <li>
                <div>
                  <strong>Connect the iPod</strong>
                  <span>Plug it in so it shows up as a drive, then pick its folder.</span>
                </div>
              </li>
              <li>
                <div>
                  <strong>Back it up</strong>
                  <span>The database files are copied to a folder you choose and checked. Nothing writes until this is done.</span>
                </div>
              </li>
              <li>
                <div>
                  <strong>Add music</strong>
                  <span>Files the iPod cannot play are converted here. Every write is read back, and undone if anything is off.</span>
                </div>
              </li>
              <li>
                <div>
                  <strong>Eject and play</strong>
                  <span>Eject it from your computer before unplugging.</span>
                </div>
              </li>
            </ol>
          </div>
        </section>

        <div class="more">
          <details>
            <summary>Read-only demos</summary>
            <div class="actions">
              <button type="button" class="secondary small" onClick={() => void showDemo('full')} disabled={working}>
                Demo iPod
              </button>
              <button type="button" class="secondary small" onClick={() => void showDemo('signed')} disabled={working}>
                Nano 7G-style demo
              </button>
              <button type="button" class="secondary small" onClick={() => void showDemo('unsynced')} disabled={working}>
                iPod that was never synced
              </button>
            </div>
          </details>
          <details>
            <summary>Browser and USB checks</summary>
            {environment}
          </details>
        </div>
      </>
    );
  }

  const snapshot = ready;
  const { device, tracks, playlists } = snapshot;
  const master = playlists.find((playlist) => playlist.master);
  const usedBytes = tracks.reduce((total, track) => total + track.size, 0);
  const capacityBytes = device && device.capacity_gb > 0 ? device.capacity_gb * 1e9 : 0;
  const signatureNews = hasSignatureNews(snapshot.signatures);
  const signaturesOk = signatureNews && (snapshot.signatures ?? []).filter((check) => check.status !== 'missing').every((check) => check.status === 'matches');
  const backedUp = backup !== null && backup.complete;
  const model = device?.device_recognized ? [device.model_name, device.generation_name].filter(Boolean).join(', ') : device?.model_num_str ? `Model ${device.model_num_str}` : 'iPod';

  const readAtText = new Date(snapshot.readAt).toLocaleTimeString();

  return (
    <>
      <JournalBanner onGoToBackup={goToBackup} />
      {disconnected ? (
        <div class="callout no" role="alert">
          <p>
            <strong>{DISCONNECTED}</strong> Anything that needs the iPod will fail until it is back. The library shown is from {readAtText}.
          </p>
          <div class="actions">
            <button type="button" class="secondary small" onClick={() => void reloadFromIpod()} disabled={changing}>
              Reconnect
            </button>
          </div>
        </div>
      ) : null}
      {readProblem ? (
        <div class="callout warn" role="alert">
          <p>{readProblem}</p>
        </div>
      ) : null}
      {changing ? (
        <div class="callout warn" role="status">
          <p>
            <strong>The iPod is being changed ({lock.writing}).</strong> Every control that touches it is off until this finishes, so two changes cannot collide. Keep this tab open and the screen on.
          </p>
        </div>
      ) : null}
      <section class="card">
        <div class="device">
          <div class="device-icon" aria-hidden="true">
            ♫
          </div>
          <div>
            <h2>{master?.name ?? snapshot.folderName}</h2>
            <div class="device-meta">
              <span>{model}</span>
              <span class="dot">·</span>
              <span>
                {plural(tracks.length, 'track')}, {plural(playlists.length, 'playlist')}
              </span>
              {device && device.capacity_gb > 0 ? (
                <>
                  <span class="dot">·</span>
                  <span>{device.capacity_gb} GB</span>
                </>
              ) : null}
            </div>
            <div class="device-meta">
              {snapshot.source === 'demo' ? <span class="pill info">Demo data</span> : null}
              {snapshot.source === 'practice' ? <span class="pill info">Practice iPod, held in memory</span> : null}
              {signatureNews ? <span class={`pill ${signaturesOk ? 'ok' : 'no'}`}>{signaturesOk ? 'Signatures verified' : 'Signature problem'}</span> : null}
              {writable ? <span class={`pill ${backedUp ? 'ok' : 'warn'}`}>{backedUp ? 'Backup made' : 'No backup yet'}</span> : null}
            </div>
          </div>
          <div class="actions">
            <button type="button" class="secondary small" onClick={() => void reloadFromIpod()} disabled={changing || working} title="Read the iPod again, for changes made outside this page, for example in iTunes or on another computer">
              Reload from the iPod
            </button>
            <button type="button" class="secondary small" onClick={() => setView({ phase: 'idle' })} disabled={changing}>
              Choose another iPod
            </button>
            <span class="last-read muted">Last read from the iPod: {readAtText}</span>
          </div>
          {reloadNote ? (
            <p class="note reload-note" role="status">
              {reloadNote}
            </p>
          ) : null}
          {capacityBytes > 0 ? (
            <div class="storage">
              <div class="storage-bar" role="img" aria-label={`${formatBytes(usedBytes)} of ${formatBytes(capacityBytes)} used`}>
                <span style={`width: ${Math.min(100, (usedBytes / capacityBytes) * 100).toFixed(1)}%`} />
              </div>
              <div class="storage-label">
                <span>{formatBytes(usedBytes)} used by the library</span>
                <span>{formatBytes(Math.max(0, capacityBytes - usedBytes))} free of {formatBytes(capacityBytes)}</span>
              </div>
            </div>
          ) : null}
        </div>
      </section>

      <div class="tabs" role="tablist">
        {tabs.map(([id, label]) => (
          <button key={id} type="button" role="tab" class="tab" aria-selected={current === id} disabled={changing} onClick={() => setTab(id)}>
            {label}
            {id === 'library' ? <span class="badge">{tracks.length}</span> : null}
          </button>
        ))}
      </div>

      <fieldset class="write-lock" disabled={changing}>
      {current === 'library' ? (
        writable ? (
          <PanelBoundary name="Library" key={`library-${epoch}`}>
            <ManagePanel root={snapshot.root} tracks={tracks} playlists={playlists} backup={backup} onChanged={() => void refreshed()} onNeedBackup={goToBackup} />
          </PanelBoundary>
        ) : (
          <section class="card">
            <h3>Library</h3>
            <Library tracks={tracks} />
          </section>
        )
      ) : null}
      {current === 'library' && !writable ? (
        <section class="card">
          <h3>Playlists</h3>
          <ul class="playlists">
            {playlists.map((playlist) => (
              <li key={playlist.handle}>
                <span>{playlist.name ?? '(no name)'}</span>
                <span class="muted">
                  {plural(playlist.tracks.length, 'track')}
                  {playlist.master ? ', holds everything' : ''}
                  {playlist.podcasts ? ', podcasts' : ''}
                  {playlist.smart ? ', smart' : ''}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {current === 'add' && writable ? (
        <PanelBoundary name="Add to the iPod" key={`add-${epoch}`}>
          <AddPanel root={snapshot.root} device={device} backup={backup} onChanged={() => void refreshed()} onNeedBackup={goToBackup} />
        </PanelBoundary>
      ) : null}

      {current === 'assistant' && writable ? (
        <PanelBoundary name="Assistant" key={`assistant-${epoch}`}>
          <AssistantPanel root={snapshot.root} tracks={tracks} playlists={playlists} backup={backup} onChanged={() => void refreshed()} onNeedBackup={goToBackup} />
        </PanelBoundary>
      ) : null}

      {current === 'backup' && writable ? (
        <>
          {snapshot.source === 'folder' ? (
            <PanelBoundary name="Earlier backup" key={`reuse-${epoch}`}>
              <ReuseBackup ipodRoot={snapshot.root} ipodName={snapshot.folderName} backup={backup} onUse={setBackup} />
            </PanelBoundary>
          ) : null}
          <PanelBoundary name="Backup" key={`backup-${epoch}`}>
            <BackupPanel source={snapshot.root} onDone={onBackupDone} inMemory={snapshot.source === 'practice'} />
          </PanelBoundary>
          {snapshot.source === 'folder' ? (
            <PanelBoundary name="Restore" key={`restore-${epoch}`}>
              <RestorePanel root={snapshot.root} onRestored={() => void refreshed()} />
            </PanelBoundary>
          ) : null}
          <PanelBoundary name="Restore everything">
            <RestoreEverythingPanel root={snapshot.root} backup={backup} onChanged={() => void refreshed()} />
          </PanelBoundary>
        </>
      ) : null}

      {current === 'offload' && writable ? (
        <PanelBoundary name="Offload" key={`offload-${epoch}`}>
          <OffloadPanel source={snapshot.root} inMemory={snapshot.source === 'practice'} />
        </PanelBoundary>
      ) : null}

      {current === 'diagnostics' ? (
        <>
          <Facts snapshot={snapshot} />
          {snapshot.load ? (
            <section class="card">
              <FileList load={snapshot.load} />
            </section>
          ) : null}
          <PanelBoundary name="Rewrite check" key={`rewrite-${epoch}-${dataVersion}`}>
            <RewritePanel source={snapshot.root} autoStart={new URLSearchParams(window.location.search).get('rewrite') === '1'} />
          </PanelBoundary>
          {writable ? (
            <PanelBoundary name="Write back" key={`writeback-${epoch}-${dataVersion}`}>
              <WriteBackPanel root={snapshot.root} backup={backup} />
            </PanelBoundary>
          ) : null}
          <section class="card">
            <h3>Report</h3>
            <p class="card-lead">A summary of this iPod without track titles, for sharing when something goes wrong.</p>
            <button type="button" class="secondary" onClick={() => void copyReport(reportOf(snapshot))}>
              Copy iPod report
            </button>
            {copied === 'copied' ? <span class="note"> Copied.</span> : null}
            {copied === 'failed' ? <span class="note"> Copy failed.</span> : null}
          </section>
          <details class="card">
            <summary>Browser and USB checks</summary>
            {environment}
          </details>
        </>
      ) : null}
      </fieldset>
    </>
  );
}
