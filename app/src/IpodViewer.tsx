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
} from '@opentunes/engine';
import { AddPanel } from './AddPanel';
import { AssistantPanel } from './AssistantPanel';
import { BackupPanel } from './BackupPanel';
import { describeError } from './describeError';
import { newEngine } from './engineLoader';
import { ManagePanel } from './ManagePanel';
import { OffloadPanel } from './OffloadPanel';
import { PanelBoundary } from './PanelBoundary';
import { startActivity, useActivity } from './activity';
import { ConfirmBox, Notice, reveal, useOnce } from './controls';
import { explainWrongFolder } from './wrongFolder';
import { isStopped } from './stopped';
import { watchOtherTabs, type TabWatcher } from './otherTab';
import { buildPracticeIpod } from './practice';
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
  return { source, root, folderName: root.name, device, tracks: engine.tracks(), playlists: engine.playlists(), load, signatures };
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
  /** Stops the read that is running, if there is one. */
  const reading = useRef<AbortController | null>(null);
  /** A plain line about what just happened on the start page, such as a stopped read. */
  const [notice, setNotice] = useState('');
  /** True while "Choose another iPod" is asking first. */
  const [leaving, setLeaving] = useState(false);
  /** True while another tab of OpenTunes has an iPod open. */
  const [otherTab, setOtherTab] = useState(false);
  const watcher = useRef<TabWatcher | null>(null);
  const once = useOnce();
  const { active: jobs } = useActivity();
  /** The tabs that have been opened, so each keeps its list, results and progress when you look at another one. */
  const opened = useRef<{ root: unknown; tabs: Set<Tab> }>({ root: null, tabs: new Set() });
  const panel = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const tabWatcher = watchOtherTabs(setOtherTab);
    watcher.current = tabWatcher;
    const leave = (): void => tabWatcher.close();
    window.addEventListener('pagehide', leave);
    return () => {
      window.removeEventListener('pagehide', leave);
      tabWatcher.close();
    };
  }, []);

  async function chooseFolder() {
    const picker = (window as unknown as { showDirectoryPicker?: Picker }).showDirectoryPicker;
    if (!picker) {
      setView({ phase: 'error', message: 'This browser has no folder picker. Use Chrome or Edge on a computer.' });
      return;
    }
    setNotice('');
    // Chrome shows its picker for a moment before it answers, long enough to click the button twice.
    await once(async () => {
      let handle: unknown;
      try {
        handle = await picker.call(window, { mode: 'read' });
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          setView({ phase: 'error', message: describeError(error) });
        }
        return;
      }
      const wrong = await explainWrongFolder(handle as DirectoryEntry);
      if (wrong) {
        setView({ phase: 'error', message: wrong });
        return;
      }
      await readIpod(handle as DirectoryEntry, 'folder');
    });
  }

  /** The one path every iPod takes, real or demo: copy its database files in, open, read. */
  async function readIpod(directory: DirectoryEntry, source: Snapshot['source'], refresh = false) {
    // A refresh after a change made here keeps the panels on screen, so their results stay readable,
    // and keeps the backup, which is still the restore point.
    // Reading changes nothing, so it can always be stopped. The read after a change is the exception: stopping it would leave the page showing the library from before the change.
    const controller = new AbortController();
    if (!refresh) reading.current = controller;
    const activity = startActivity(refresh ? 'Reading the iPod again' : 'Reading the iPod', {
      message: 'Loading the engine...',
      stop: refresh ? undefined : { label: 'Stop reading (nothing is changed)', stopping: 'Stopping...', run: () => controller.abort() },
    });
    const progress = (message: string) => {
      activity.update(message);
      if (!refresh) setView({ phase: 'working', message });
    };
    progress('Loading the engine...');
    if (!refresh) setBackup(null);
    let engine: Engine | null = null;
    let load: LoadReport | null = null;
    try {
      engine = await newEngine();
      load = await loadIpodFolder(directory, engine, {
        mount: MOUNT,
        onProgress: progress,
        signal: refresh ? undefined : controller.signal,
      });
      if (!load.hasDatabaseFolder) {
        throw new IpodFolderError(`"${directory.name}" has an iPod_Control folder but no iTunes folder inside it, so this iPod has no database yet. There is nothing to read.`);
      }
      engine.open(load.mount);
      const signatures = await checkSignatures(engine, load.mount);
      setView({ phase: 'ready', snapshot: snapshotOf(engine, source, directory, load, signatures) });
      engine.close();
      activity.end(true);
    } catch (error) {
      if (isStopped(error)) {
        activity.end(true, undefined, true);
        setView({ phase: 'idle' });
        setNotice('Stopped reading the iPod. Nothing on it was changed.');
        return;
      }
      activity.end(false, describeError(error));
      const message = describeError(error);
      // When the database would not open, the signatures can still say whether the files are intact.
      const signatures = engine && load?.hasDatabaseFolder ? await checkSignatures(engine, load.mount) : null;
      setView({ phase: 'error', message, diagnostics: load ? { folderName: directory.name, load, error: message, signatures } : undefined });
    } finally {
      if (reading.current === controller) reading.current = null;
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
        await readIpod(await buildPracticeIpod(demo, MOUNT), 'practice');
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
  }, []);

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
  /** Moves to a tab. A button that took you there has left the screen, so focus follows to the new tab. */
  const goTo = (next: Tab, moveFocus = false) => {
    setTab(next);
    setLeaving(false);
    if (moveFocus) window.setTimeout(() => reveal(document.getElementById(`pane-${next}`) as HTMLElement | null), 0);
  };
  const goToBackup = () => goTo('backup', true);
  const onTabKey = (event: KeyboardEvent) => {
    const keys = ['ArrowRight', 'ArrowLeft', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const at = tabs.findIndex(([id]) => id === current);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (at + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    const target = tabs[next]?.[0];
    if (!target) return;
    goTo(target);
    window.setTimeout(() => document.getElementById(`tab-${target}`)?.focus(), 0);
  };

  // Tell other tabs of OpenTunes whether this one has an iPod open, and hear whether they do.
  const hasIpod = ready !== null && ready.source !== 'demo' && ready.source !== 'practice';
  useEffect(() => {
    watcher.current?.announce(hasIpod);
    if (!hasIpod) setOtherTab(false);
  }, [hasIpod]);

  const loadingNote =
    view.phase === 'working' ? (
      <div class="callout info" role="status">
        <p>{view.message}</p>
        {reading.current ? (
          <div class="actions">
            <button type="button" class="secondary small" onClick={() => reading.current?.abort()}>
              Stop reading (nothing is changed)
            </button>
          </div>
        ) : null}
      </div>
    ) : null;

  if (!ready) {
    return (
      <>
        <section class="hero">
          <div>
            <h1>Put your music on an iPod, without iTunes.</h1>
            <p class="lead">
              OpenTunes reads your iPod, backs it up, then adds music, podcasts, audiobooks and video. It runs in this browser tab. Nothing is uploaded unless you turn the AI assistant on, and nothing is installed.
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
            {notice && view.phase === 'idle' ? <Notice tone="info">{notice}</Notice> : null}
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

  // Every tab keeps what it holds once it has been opened. Without this, a trip to the Backup tab
  // would throw away the files picked in Add music, and a running copy would lose its Stop button.
  if (opened.current.root !== snapshot.root) opened.current = { root: snapshot.root, tabs: new Set() };
  opened.current.tabs.add(current);
  const pane = (id: Tab, content: () => ComponentChildren) =>
    opened.current.tabs.has(id) ? (
      <div key={id} id={`pane-${id}`} role="tabpanel" aria-labelledby={`tab-${id}`} tabIndex={-1} class="pane" hidden={current !== id} ref={current === id ? panel : undefined}>
        {content()}
      </div>
    ) : null;

  return (
    <>
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
            <button
              type="button"
              class="secondary small"
              disabled={jobs.length > 0}
              aria-describedby={jobs.length > 0 ? 'leave-why' : undefined}
              onClick={() => (writable ? setLeaving(true) : setView({ phase: 'idle' }))}
            >
              Choose another iPod
            </button>
            {jobs.length > 0 ? (
              <span class="note" id="leave-why">
                Off while the job in the bar above is running. Wait for it, or stop it.
              </span>
            ) : null}
          </div>
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

      {leaving ? (
        <ConfirmBox title="Choose another iPod?" confirmLabel="Choose another iPod" cancelLabel="Stay with this iPod" onConfirm={() => { setLeaving(false); setView({ phase: 'idle' }); }} onCancel={() => setLeaving(false)}>
          <p>
            Nothing on this iPod changes. What is on screen for it goes away: the files you picked in Add music, the Assistant chat and the results of earlier steps.
            {backedUp ? ' The backup you made stays in its folder on your computer, but this page forgets it, so you need a new backup before changing an iPod again.' : ''}
            {snapshot.source === 'practice' ? ' The practice iPod lives only in memory, so what you did to it is gone for good.' : ''}
          </p>
        </ConfirmBox>
      ) : null}

      {otherTab && writable ? (
        <div class="callout warn" role="alert">
          <p>
            <strong>OpenTunes is open with an iPod in another tab or window.</strong> Two tabs changing an iPod at the same time can damage its library. Close the other tab before you change anything here.
          </p>
        </div>
      ) : null}

      <div class="tabs" role="tablist" aria-label="iPod sections" onKeyDown={onTabKey}>
        {tabs.map(([id, label]) => (
          <button
            key={id}
            id={`tab-${id}`}
            type="button"
            role="tab"
            class="tab"
            aria-selected={current === id}
            aria-controls={`pane-${id}`}
            tabIndex={current === id ? 0 : -1}
            onClick={() => goTo(id)}
          >
            {label}
            {id === 'library' ? <span class="badge">{tracks.length}</span> : null}
          </button>
        ))}
      </div>

      {pane('library', () => (
        <>
          {writable ? (
            <PanelBoundary name="Library">
              <ManagePanel root={snapshot.root} tracks={tracks} playlists={playlists} backup={backup} onChanged={() => void refreshed()} onNeedBackup={goToBackup} />
            </PanelBoundary>
          ) : (
            <section class="card">
              <h3>Library</h3>
              <Library tracks={tracks} />
            </section>
          )}
          {!writable ? (
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
        </>
      ))}

      {writable
        ? pane('add', () => (
            <PanelBoundary name="Add to the iPod">
              <AddPanel root={snapshot.root} device={device} backup={backup} onChanged={() => void refreshed()} onNeedBackup={goToBackup} />
            </PanelBoundary>
          ))
        : null}

      {writable
        ? pane('assistant', () => (
            <PanelBoundary name="Assistant">
              <AssistantPanel root={snapshot.root} tracks={tracks} playlists={playlists} backup={backup} onChanged={() => void refreshed()} onNeedBackup={goToBackup} />
            </PanelBoundary>
          ))
        : null}

      {writable
        ? pane('backup', () => (
            <>
              <PanelBoundary name="Backup">
                <BackupPanel source={snapshot.root} onDone={setBackup} inMemory={snapshot.source === 'practice'} />
              </PanelBoundary>
              {snapshot.source === 'folder' ? (
                <PanelBoundary name="Restore">
                  <RestorePanel root={snapshot.root} />
                </PanelBoundary>
              ) : null}
            </>
          ))
        : null}

      {writable
        ? pane('offload', () => (
            <PanelBoundary name="Offload">
              <OffloadPanel source={snapshot.root} inMemory={snapshot.source === 'practice'} />
            </PanelBoundary>
          ))
        : null}

      {pane('diagnostics', () => (
        <>
          <p class="callout info">These are technical checks, for finding out what is wrong when something does not work. You do not need them to add music.</p>
          <Facts snapshot={snapshot} />
          {snapshot.load ? (
            <section class="card">
              <FileList load={snapshot.load} />
            </section>
          ) : null}
          <PanelBoundary name="Library test">
            <RewritePanel source={snapshot.root} autoStart={new URLSearchParams(window.location.search).get('rewrite') === '1'} />
          </PanelBoundary>
          {writable ? (
            <PanelBoundary name="Write-back test">
              <WriteBackPanel root={snapshot.root} backup={backup} />
            </PanelBoundary>
          ) : null}
          <section class="card">
            <h3>Report</h3>
            <p class="card-lead">A summary of this iPod without track titles, for sharing when something goes wrong.</p>
            <button type="button" class="secondary" onClick={() => void copyReport(reportOf(snapshot))}>
              Copy iPod report
            </button>
            <span class="note" role="status" aria-live="polite">
              {copied === 'copied' ? ' Copied.' : copied === 'failed' ? ' Copy failed.' : ''}
            </span>
          </section>
          <details class="card">
            <summary>Browser and USB checks</summary>
            {environment}
          </details>
        </>
      ))}
    </>
  );
}
