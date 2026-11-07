/**
 * Finds out what a rewrite of an iPod's database would change, without touching the iPod.
 *
 * The engine works on its own in-memory copy of the iPod's database files. This writes the
 * database there, as a sync would, then compares the copy before and after:
 * - the library libgpod reads back (tracks field by field, playlists and their members),
 * - every file, by size and content,
 * - the SQLite files of a nano 6G or 7G, table by table and column by column, because libgpod
 *   rebuilds those from its own model and drops what the model does not carry,
 * - the signatures on the rewritten files.
 *
 * It leaves the engine's copy rewritten, so use a throwaway engine. Nothing is written to the
 * iPod. No titles or names of tracks go into the report, only counts and field names.
 */

import { NUMBER_FIELDS, TEXT_FIELDS, type Engine, type PlaylistInfo, type TrackInfo } from './engine.ts';
import { verifySignatures, type SignatureCheck } from './signature.ts';
import { compareProfiles, describeChanges, profileDatabase, type DatabaseProfile, type TableChange } from './sqlite.ts';

export interface FileChange {
  /** From the iPod's top folder. */
  path: string;
  kind: 'added' | 'removed' | 'changed';
  sizeBefore: number | null;
  sizeAfter: number | null;
}

export interface LibraryComparison {
  tracksBefore: number;
  tracksAfter: number;
  /** Tracks present on only one side, matched by their path on the iPod. */
  unmatched: number;
  /** For each track field that differs, on how many tracks. */
  changedFields: Record<string, number>;
  playlistsBefore: number;
  playlistsAfter: number;
  playlistChanges: string[];
}

export interface SqliteFileChange {
  file: string;
  tables: TableChange[];
}

export interface RewriteReport {
  /** Why libgpod could not write the database, or null. */
  writeError: string | null;
  writeMilliseconds: number;
  /** Why libgpod could not read back what it wrote, or null. */
  readBackError: string | null;
  library: LibraryComparison | null;
  files: FileChange[];
  sqlite: SqliteFileChange[];
  signatures: SignatureCheck[];
  /** One sentence for each way the rewrite loses something the iPod holds. Empty means none were found. */
  problems: string[];
  /** Tables and columns the iPod's files have that the rewritten files lack, where they held no data. */
  schemaDifferences: string[];
  /** What could not be compared, so the comparison is blind there. */
  notes: string[];
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Files libgpod removes or renames on every write, and why that is expected. They are noted
 * instead of reported as a loss, because every sync does this.
 */
const EXPECTED_REMOVALS: Record<string, string> = {
  'iPod_Control/iTunes/Play Counts': 'libgpod folds the Play Counts file into the library and keeps the old file as Play Counts.bak, as every sync does.',
  'iPod_Control/iTunes/OTGPlaylistInfo': 'libgpod turns the On-The-Go playlist into a normal playlist and removes the file, as every sync does.',
};

/** The track fields compared. The track id and handle are left out: both are renumbered on purpose. */
const COMPARED_FIELDS: string[] = [...TEXT_FIELDS, ...NUMBER_FIELDS, 'kind', 'mediatype', 'ipod_path', 'transferred', 'has_artwork', 'artwork_count'];

// ------------------------------------------------------------------ library

function keyTracks(tracks: TrackInfo[]): { byKey: Map<string, TrackInfo>; keyOfHandle: Map<number, string> } {
  const byKey = new Map<string, TrackInfo>();
  const keyOfHandle = new Map<number, string>();
  const seen = new Map<string, number>();
  for (const track of tracks) {
    const base = track.ipod_path ? track.ipod_path.toLowerCase() : `no path|${track.title}|${track.artist}|${track.album}|${track.tracklen}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    const key = count === 0 ? base : `${base}#${count}`;
    byKey.set(key, track);
    keyOfHandle.set(track.handle, key);
  }
  return { byKey, keyOfHandle };
}

interface KeyedPlaylist {
  label: string;
  name: string;
  members: string[];
}

function keyPlaylists(playlists: PlaylistInfo[], keyOfHandle: Map<number, string>): Map<string, KeyedPlaylist> {
  const keyed = new Map<string, KeyedPlaylist>();
  const seen = new Map<string, number>();
  for (const playlist of playlists) {
    const kind = `${playlist.master ? ' master' : ''}${playlist.smart ? ' smart' : ''}${playlist.podcasts ? ' podcasts' : ''}`;
    const base = `${playlist.name ?? ''}${kind}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    const label = count === 0 ? base : `${base}#${count}`;
    keyed.set(label, { label, name: playlist.name ?? '(no name)', members: playlist.tracks.map((handle) => keyOfHandle.get(handle) ?? `unknown ${handle}`) });
  }
  return keyed;
}

/** Compares the library as libgpod reads it before and after. Pure, so it can be tested directly. */
export function compareLibraries(
  tracksBefore: TrackInfo[],
  playlistsBefore: PlaylistInfo[],
  tracksAfter: TrackInfo[],
  playlistsAfter: PlaylistInfo[],
): LibraryComparison {
  const before = keyTracks(tracksBefore);
  const after = keyTracks(tracksAfter);

  let unmatched = 0;
  const changedFields: Record<string, number> = {};
  for (const [key, was] of before.byKey) {
    const now = after.byKey.get(key);
    if (!now) {
      unmatched += 1;
      continue;
    }
    for (const field of COMPARED_FIELDS) {
      if ((was as unknown as Record<string, unknown>)[field] !== (now as unknown as Record<string, unknown>)[field]) {
        changedFields[field] = (changedFields[field] ?? 0) + 1;
      }
    }
  }
  for (const key of after.byKey.keys()) if (!before.byKey.has(key)) unmatched += 1;

  const listsBefore = keyPlaylists(playlistsBefore, before.keyOfHandle);
  const listsAfter = keyPlaylists(playlistsAfter, after.keyOfHandle);
  const playlistChanges: string[] = [];
  for (const [label, was] of listsBefore) {
    const now = listsAfter.get(label);
    if (!now) {
      playlistChanges.push(`The playlist "${was.name}" is missing after the rewrite.`);
    } else if (now.members.length !== was.members.length) {
      playlistChanges.push(`The playlist "${was.name}" has ${was.members.length} tracks before the rewrite and ${now.members.length} after.`);
    } else if (now.members.some((member, index) => member !== was.members[index])) {
      playlistChanges.push(`The playlist "${was.name}" holds different tracks, or the same tracks in a different order, after the rewrite.`);
    }
  }
  for (const [label, now] of listsAfter) {
    if (!listsBefore.has(label)) playlistChanges.push(`A playlist "${now.name}" appears after the rewrite that was not there before.`);
  }

  return {
    tracksBefore: tracksBefore.length,
    tracksAfter: tracksAfter.length,
    unmatched,
    changedFields,
    playlistsBefore: playlistsBefore.length,
    playlistsAfter: playlistsAfter.length,
    playlistChanges,
  };
}

// -------------------------------------------------------------------- files

interface FileState {
  size: number;
  digest: string | null;
}

async function digestOf(bytes: Uint8Array): Promise<string | null> {
  if (!globalThis.crypto?.subtle) return null;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', bytes as BufferSource));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function snapshotFiles(engine: Engine, directory: string, root: string, into: Map<string, FileState>): Promise<void> {
  for (const name of engine.fs.readdir(directory)) {
    if (name === '.' || name === '..') continue;
    const path = `${directory}/${name}`;
    if (engine.fs.isDir(engine.fs.stat(path).mode)) {
      await snapshotFiles(engine, path, root, into);
    } else {
      const bytes = engine.fs.readFile(path);
      into.set(path.slice(root.length + 1), { size: bytes.length, digest: await digestOf(bytes) });
    }
  }
}

function diffFiles(before: Map<string, FileState>, after: Map<string, FileState>): FileChange[] {
  const changes: FileChange[] = [];
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const was = before.get(path);
    const now = after.get(path);
    if (!was && now) changes.push({ path, kind: 'added', sizeBefore: null, sizeAfter: now.size });
    else if (was && !now) changes.push({ path, kind: 'removed', sizeBefore: was.size, sizeAfter: null });
    else if (was && now && (was.size !== now.size || was.digest !== now.digest)) {
      changes.push({ path, kind: 'changed', sizeBefore: was.size, sizeAfter: now.size });
    }
  }
  return changes;
}

// ------------------------------------------------------------------- SQLite

const EMPTY_PROFILE: DatabaseProfile = { tables: {}, unreadable: {} };

function profileLibraryFiles(engine: Engine, mount: string): Map<string, DatabaseProfile> {
  const folder = `${mount}/iPod_Control/iTunes/iTunes Library.itlp`;
  const profiles = new Map<string, DatabaseProfile>();
  if (!engine.fs.analyzePath(folder).exists) return profiles;
  for (const name of engine.fs.readdir(folder).filter((entry) => entry.endsWith('.itdb')).sort()) {
    try {
      profiles.set(name, profileDatabase(engine, `${folder}/${name}`));
    } catch (error) {
      profiles.set(name, { tables: {}, unreadable: { '(whole file)': messageOf(error) } });
    }
  }
  return profiles;
}

// -------------------------------------------------------------------- check

/**
 * Writes the open database into the engine's copy of the iPod and reports what changed.
 * `fireWireId` is for checking the signatures on the rewritten files.
 */
export async function checkRewrite(engine: Engine, mount: string, fireWireId: string | null): Promise<RewriteReport> {
  const tracksBefore = engine.tracks();
  const playlistsBefore = engine.playlists();
  const filesBefore = new Map<string, FileState>();
  await snapshotFiles(engine, mount, mount, filesBefore);
  const profilesBefore = profileLibraryFiles(engine, mount);

  let writeError: string | null = null;
  const started = performance.now();
  try {
    engine.write();
  } catch (error) {
    writeError = messageOf(error);
  }
  const writeMilliseconds = Math.round(performance.now() - started);

  const filesAfter = new Map<string, FileState>();
  await snapshotFiles(engine, mount, mount, filesAfter);
  const profilesAfter = profileLibraryFiles(engine, mount);

  let readBackError: string | null = null;
  let library: LibraryComparison | null = null;
  if (!writeError) {
    try {
      engine.close();
      engine.open(mount);
      library = compareLibraries(tracksBefore, playlistsBefore, engine.tracks(), engine.playlists());
    } catch (error) {
      readBackError = messageOf(error);
    }
  }

  const sqlite: SqliteFileChange[] = [];
  const notes: string[] = [];
  const problems: string[] = [];
  const schemaDifferences: string[] = [];
  for (const file of [...new Set([...profilesBefore.keys(), ...profilesAfter.keys()])].sort()) {
    const before = profilesBefore.get(file) ?? EMPTY_PROFILE;
    const after = profilesAfter.get(file) ?? EMPTY_PROFILE;
    for (const [side, profile] of [['before', before], ['after', after]] as const) {
      for (const [table, reason] of Object.entries(profile.unreadable)) {
        notes.push(`${file}: the table ${table} could not be read ${side} the rewrite (${reason}), so it was not compared.`);
      }
    }
    const tables = compareProfiles(before, after);
    if (tables.length) sqlite.push({ file, tables });
    const described = describeChanges(file, tables);
    problems.push(...described.lost);
    schemaDifferences.push(...described.missing);
  }

  const signatures = writeError ? [] : await verifySignatures(engine, mount, fireWireId);

  const early: string[] = [];
  if (writeError) early.push(`libgpod could not write this library: ${writeError}`);
  if (readBackError) early.push(`libgpod could not read back the database it wrote: ${readBackError}`);
  if (library) {
    if (library.tracksBefore !== library.tracksAfter) early.push(`The library has ${library.tracksBefore} tracks before the rewrite and ${library.tracksAfter} after.`);
    else if (library.unmatched) early.push(`${library.unmatched} tracks could not be matched with themselves after the rewrite.`);
    for (const [field, count] of Object.entries(library.changedFields)) early.push(`The track field "${field}" is different on ${count} tracks after the rewrite.`);
    early.push(...library.playlistChanges);
  }
  for (const change of diffFiles(filesBefore, filesAfter)) {
    if (change.kind !== 'removed') continue;
    const expected = EXPECTED_REMOVALS[change.path];
    if (expected) notes.push(`${change.path}: ${expected}`);
    else early.push(`The file ${change.path} is gone after the rewrite.`);
  }
  for (const check of signatures) {
    if (check.status === 'differs' || check.status === 'unsupported') early.push(`The ${check.file} signature after the rewrite is not confirmed: ${check.detail}`);
  }

  return {
    writeError,
    writeMilliseconds,
    readBackError,
    library,
    files: diffFiles(filesBefore, filesAfter),
    sqlite,
    signatures,
    problems: [...early, ...problems],
    schemaDifferences,
    notes,
  };
}
