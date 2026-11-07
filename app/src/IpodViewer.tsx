import { useEffect, useState } from 'preact/hooks';
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
import { BackupPanel } from './BackupPanel';
import { describeError } from './describeError';
import { newEngine } from './engineLoader';
import { ManagePanel } from './ManagePanel';
import { PanelBoundary } from './PanelBoundary';
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
  const master = playlists.find((playlist) => playlist.master);
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
      <h3>
        {master?.name ?? 'iPod'} {snapshot.source === 'demo' ? <span class="pill optional">Demo</span> : snapshot.source === 'practice' ? <span class="pill optional">Practice</span> : null}
      </h3>
      <dl class="facts">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {device && !device.device_recognized ? (
        <p class="muted">
          libgpod does not recognise this model number. That is expected for a nano 6th or 7th generation with the libgpod version in use. The signing scheme, artwork, photo and podcast support come from the iPod's own description file instead. Video is left out of the list because libgpod only judges it from the model number, so for a model it does not know it always says no.
        </p>
      ) : null}
    </section>
  );
}

function Library({ tracks }: { tracks: TrackInfo[] }) {
  if (tracks.length === 0) {
    return <p class="muted">The library is empty.</p>;
  }
  return (
    <div class="table-wrap">
      <table class="library">
        <thead>
          <tr>
            <th>Title</th>
            <th>Artist</th>
            <th>Album</th>
            <th>Kind</th>
            <th>Length</th>
            <th>Size</th>
          </tr>
        </thead>
        <tbody>
          {tracks.slice(0, MAX_ROWS).map((track) => (
            <tr key={track.handle} title={track.ipod_path ?? ''}>
              <td>{track.title ?? '(no title)'}</td>
              <td>{track.artist ?? ''}</td>
              <td>{track.album ?? ''}</td>
              <td>{kindLabel(track.kind)}</td>
              <td>{formatDuration(track.tracklen)}</td>
              <td>{formatBytes(track.size)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {tracks.length > MAX_ROWS ? <p class="muted">Showing the first {MAX_ROWS} of {tracks.length} tracks.</p> : null}
    </div>
  );
}

export function IpodViewer({ canPickFolder }: { canPickFolder: boolean }) {
  const [view, setView] = useState<View>({ phase: 'idle' });
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  /** The backup made on this page, which the write-back needs before it will start. */
  const [backup, setBackup] = useState<BackupReport | null>(null);

  async function chooseFolder() {
    const picker = (window as unknown as { showDirectoryPicker?: Picker }).showDirectoryPicker;
    if (!picker) {
      setView({ phase: 'error', message: 'This browser has no folder picker. See the browser features above.' });
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

    await readIpod(handle as DirectoryEntry, 'folder');
  }

  /** The one path every iPod takes, real or demo: copy its database files in, open, read. */
  async function readIpod(directory: DirectoryEntry, source: Snapshot['source'], refresh = false) {
    // A refresh after a change made here keeps the panels on screen, so their results stay readable,
    // and keeps the backup, which is still the restore point.
    const progress = (message: string) => {
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
      });
      if (!load.hasDatabaseFolder) {
        throw new IpodFolderError(`"${directory.name}" has an iPod_Control folder but no iTunes folder inside it, so this iPod has no database yet. There is nothing to read.`);
      }
      engine.open(load.mount);
      const signatures = await checkSignatures(engine, load.mount);
      setView({ phase: 'ready', snapshot: snapshotOf(engine, source, directory, load, signatures) });
      engine.close();
    } catch (error) {
      const message = describeError(error);
      // When the database would not open, the signatures can still say whether the files are intact.
      const signatures = engine && load?.hasDatabaseFolder ? await checkSignatures(engine, load.mount) : null;
      setView({ phase: 'error', message, diagnostics: load ? { folderName: directory.name, load, error: message, signatures } : undefined });
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

  return (
    <section>
      <h2>Read your iPod</h2>
      <p class="muted">
        Opens an iPod's database with the engine and shows what it finds: the model, how the database is signed, whether its signatures check out, and your library. It is read only. Nothing is written to the iPod. Track titles stay on this page and are left out of the report. Below the result are a backup of the database files and a rewrite check, both read only on the iPod.
      </p>
      <div class="actions">
        <button type="button" onClick={() => void chooseFolder()} disabled={working || !canPickFolder}>
          Choose iPod folder
        </button>
        <button type="button" class="secondary" onClick={() => void showDemo('full')} disabled={working}>
          Try a demo iPod
        </button>
        <button type="button" class="secondary" onClick={() => void showDemo('signed')} disabled={working}>
          Try a nano 7G-style demo
        </button>
        <button type="button" class="secondary" onClick={() => void showDemo('practice')} disabled={working}>
          Try a practice iPod you can change
        </button>
        <button type="button" class="secondary" onClick={() => void showDemo('unsynced')} disabled={working}>
          Try an iPod that was never synced
        </button>
      </div>
      {!canPickFolder ? <p class="muted">This browser has no folder picker, so only the demo is available.</p> : null}

      {view.phase === 'working' ? (
        <p class="note" role="status">
          {view.message}
        </p>
      ) : null}
      {view.phase === 'error' ? (
        <>
          <div class="result no" role="alert">
            <p>{view.message}</p>
          </div>
          {view.diagnostics ? (
            <>
              <FileList load={view.diagnostics.load} />
              <button type="button" onClick={() => void copyReport(diagnosticsOf(view.diagnostics as Diagnostics))}>
                Copy diagnostic report
              </button>
              {copied === 'copied' ? <span class="note"> Copied.</span> : null}
              {copied === 'failed' ? <span class="note"> Copy failed.</span> : null}
            </>
          ) : null}
        </>
      ) : null}
      {view.phase === 'ready' ? (
        <>
          <Facts snapshot={view.snapshot} />
          {view.snapshot.load ? <FileList load={view.snapshot.load} /> : null}
          {view.snapshot.source !== 'demo' ? (
            <PanelBoundary name="Backup">
              <BackupPanel source={view.snapshot.root} onDone={setBackup} inMemory={view.snapshot.source === 'practice'} />
            </PanelBoundary>
          ) : null}
          <PanelBoundary name="Rewrite check">
            <RewritePanel source={view.snapshot.root} autoStart={new URLSearchParams(window.location.search).get('rewrite') === '1'} />
          </PanelBoundary>
          {view.snapshot.source !== 'demo' ? (
            <PanelBoundary name="Write back">
              <WriteBackPanel root={view.snapshot.root} backup={backup} />
            </PanelBoundary>
          ) : null}
          {view.snapshot.source === 'folder' ? (
            <PanelBoundary name="Restore">
              <RestorePanel root={view.snapshot.root} />
            </PanelBoundary>
          ) : null}
          {view.snapshot.source !== 'demo' ? (
            <>
              <PanelBoundary name="Add to the iPod">
                <AddPanel root={view.snapshot.root} device={view.snapshot.device} backup={backup} onChanged={() => void readIpod(view.snapshot.root, view.snapshot.source, true)} />
              </PanelBoundary>
              <PanelBoundary name="Library">
                <ManagePanel root={view.snapshot.root} tracks={view.snapshot.tracks} backup={backup} onChanged={() => void readIpod(view.snapshot.root, view.snapshot.source, true)} />
              </PanelBoundary>
            </>
          ) : (
            <>
              <h3>Library</h3>
              <Library tracks={view.snapshot.tracks} />
            </>
          )}
          <h3>Playlists</h3>
          <ul class="playlists">
            {view.snapshot.playlists.map((playlist) => (
              <li key={playlist.handle}>
                {playlist.name ?? '(no name)'} <span class="muted">{plural(playlist.tracks.length, 'track')}{playlist.master ? ', holds everything' : ''}{playlist.podcasts ? ', podcasts' : ''}{playlist.smart ? ', smart' : ''}</span>
              </li>
            ))}
          </ul>
          <button type="button" onClick={() => void copyReport(reportOf(view.snapshot))}>
            Copy iPod report
          </button>
          {copied === 'copied' ? <span class="note"> Copied.</span> : null}
          {copied === 'failed' ? <span class="note"> Copy failed.</span> : null}
        </>
      ) : null}
    </section>
  );
}
