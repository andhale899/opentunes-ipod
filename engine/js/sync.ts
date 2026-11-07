/**
 * Sync: puts new files on an iPod and changes its library, in a way that can be undone.
 *
 * It builds on the write-back path (ipod-files.ts, proven on the owner's nano 7G with a rewrite
 * that added no songs). The rules:
 * - Planning changes nothing. It reads the iPod, makes every change in the engine's own memory,
 *   writes the database there, reads it back, and lists exactly which database files and which
 *   media files would change. Anything libgpod cannot do shows up here, before the iPod is touched.
 * - Applying needs a complete, verified backup from this session, like write-back.
 * - A sync copies the media files first (three at a time by default, the fastest the owner
 *   measured on this iPod), reads each back and compares it with the original, and only then
 *   writes the database, file by file with the write-back order and checks. Then it reads the
 *   whole iPod back with a fresh engine and checks the library and the signatures.
 * - Any failure, or a stop through the AbortSignal, puts the database files back exactly as
 *   they were (from the bytes read before) and deletes the media files this run copied. The
 *   rollback is checked, and anything it could not undo is reported, so the person knows to
 *   restore the backup.
 * - Removing tracks writes and checks the database first, then deletes the files. A file that
 *   cannot be deleted afterwards is reported as left over, not as a failure: the library is
 *   already right, and `findOrphans` finds such files later.
 *
 * Where it writes: database files only under iPod_Control/iTunes and iPod_Control/Device, media
 * only directly inside iPod_Control/Music/Fxx. It never overwrites a file it did not create in
 * this run, and the only files it deletes are ones it created in this run, files of tracks it
 * removed from the library, and left-over files the person chose after a fresh check.
 *
 * libgpod picks a new file's name at random in one of the Music/Fxx folders, and checks its own
 * in-memory copy of that folder for a clash. That copy starts empty, so planning lists the real
 * folders and gives the engine an empty stand-in for every file already there, then checks each
 * name it picks against the real listing again. Applying checks once more before creating the
 * file, and refuses to write over anything.
 *
 * Album art is not written: this engine build cannot write artwork yet.
 */

import { NUMBER_FIELDS, TEXT_FIELDS, type Engine, type Kind, type PlaylistInfo, type TrackFields, type TrackInfo } from './engine.ts';
import { isClutter, isNotNeeded, loadIpodFolder, type DirectoryEntry, type FileLike } from './folder.ts';
import type { BackupReport } from './backup.ts';
import { compareLibraries } from './rewrite.ts';
import { verifySignatures, type SignatureCheck } from './signature.ts';
import {
  DEFAULT_MOUNT,
  diffTrees,
  fileAt,
  fireWireIdOf,
  folderAt,
  messageOf,
  readBackIpod,
  readTree,
  removeFrom,
  requireBackup,
  rollBack,
  same,
  writeDatabaseChanges,
  type IpodRoot,
  type PlannedChange,
  type ReadBack,
  type Touched,
} from './ipod-files.ts';

export class SyncError extends Error {}

// ------------------------------------------------------------------ what goes in

/** A file read in pieces, so a 2 GB film is never held in memory whole. */
export interface SyncData {
  /** Bytes in the file. */
  size: number;
  /** Bytes from `start` up to but not including `end`. */
  read(start: number, end: number): Promise<Uint8Array>;
}

/** Bytes already in memory, such as a converted file. */
export function syncDataFromBytes(bytes: Uint8Array): SyncData {
  return { size: bytes.length, read: async (start, end) => bytes.slice(start, Math.min(end, bytes.length)) };
}

/** The part of a browser File or Blob this needs. */
export interface BlobLike {
  size: number;
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
}

/** A file picked in the browser, read a piece at a time. */
export function syncDataFromBlob(blob: BlobLike): SyncData {
  return { size: blob.size, read: async (start, end) => new Uint8Array(await blob.slice(start, Math.min(end, blob.size)).arrayBuffer()) };
}

/** What the probe found about the audio. core's AudioStream fits this. */
export interface SyncAudio {
  codec: string;
  sampleRateHz: number;
  channels: number;
  bitrateKbps: number | null;
}

/** What the probe found about the video. core's VideoStream fits this. */
export interface SyncVideo {
  codec: string;
  width: number;
  height: number;
  fps: number | null;
  bitrateKbps: number | null;
  profile?: string;
  level?: string;
}

/** The tags. Same names as core's MediaTags, so a probed file's tags fit as they are. */
export interface SyncTags {
  title?: string;
  artist?: string;
  album?: string;
  albumArtist?: string;
  genre?: string;
  composer?: string;
  comment?: string;
  grouping?: string;
  description?: string;
  year?: number;
  trackNumber?: number;
  trackTotal?: number;
  discNumber?: number;
  discTotal?: number;
  bpm?: number;
  compilation?: boolean;
  show?: string;
  season?: number;
  episode?: number;
  episodeId?: string;
  network?: string;
  podcastCategory?: string;
  podcastFeedUrl?: string;
  podcastEpisodeUrl?: string;
}

/** The probed facts sync uses. core's MediaInfo fits this. */
export interface SyncInfo {
  durationMs: number | null;
  container: string;
  audio: SyncAudio | null;
  video: SyncVideo | null;
  tags: SyncTags;
  chapters: { startMs: number; title: string }[];
  artwork: { mime: string; data: Uint8Array } | null;
  /** True for FairPlay files. They are written as "Protected AAC audio file". */
  protected?: boolean;
}

/** One file to put on the iPod, prepared by the probe, the planner and the converter. */
export interface SyncItem {
  /** Unique within one sync, so the report can say what happened to each item. */
  id: string;
  kind: Kind;
  data: SyncData;
  /** What the file is on the iPod, such as ".m4a" or "mp3". */
  extension: string;
  info: SyncInfo;
  /** The file's own name, for messages and as the title when the tags have none. */
  name?: string;
  /** Set last, over what the tags give. */
  fields?: Partial<TrackFields>;
  /** Names of playlists to put the track in. A missing one is created. */
  playlists?: string[];
}

// ------------------------------------------------------------------ small rules

const KINDS: readonly Kind[] = ['music', 'movie', 'music-video', 'tv-show', 'podcast', 'video-podcast', 'audiobook'];
const PODCAST_KINDS: readonly string[] = ['podcast', 'video-podcast'];

/**
 * The extensions the iPod plays as they are. Anything else must be converted first. Raw ADTS
 * ".aac" is left out on purpose: iTunes puts AAC on an iPod inside an MP4 file, so the converter
 * rewraps it as .m4a.
 */
const PLAYABLE_EXTENSIONS = ['mp3', 'm4a', 'm4b', 'm4p', 'wav', 'aif', 'aiff', 'm4v', 'mp4', 'mov'];

/** The largest file a FAT32 iPod holds, and the largest size a database entry records. */
const MAX_FILE_BYTES = 0xffffffff;

/** Kept free when checking space: room for the database files and the iPod's own files. */
export const SPACE_RESERVE_BYTES = 64 * 1024 * 1024;

const DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024;
const DEFAULT_CONCURRENCY = 3;
const MAX_CONCURRENCY = 8;

/** A media file's place on the iPod: directly inside a Music/Fxx folder, and not "." or "..". */
const MEDIA_PATH = /^iPod_Control\/Music\/F\d\d\/(?!\.\.?$)[^/\\:]+$/i;
const DATABASE_PATH = /^iPod_Control\/(iTunes|Device)\/[^\\:]+$/;
const LIBGPOD_NAME = /^libgpod\d{6}\.[a-z0-9]+$/i;

const MUSIC = 'iPod_Control/Music';
const STOPPED = 'The run was stopped before it finished.';

const extensionOf = (extension: string): string => extension.trim().replace(/^\./, '').toLowerCase();

const isMusicPath = (path: string): boolean => path === MUSIC || path.startsWith(`${MUSIC}/`);

/** A track's place on the iPod ("/iPod_Control/..." or ":iPod_Control:...") as a path from the top folder. */
export function mediaPathOf(ipodPath: string | null): string | null {
  if (!ipodPath) return null;
  const path = ipodPath.replaceAll(':', '/').replace(/^\/+/, '');
  return MEDIA_PATH.test(path) && !path.split('/').includes('..') ? path : null;
}

/** How tracks are named in removals and edits: the file on the iPod, or the tags when there is none. */
export function trackKey(track: Pick<TrackInfo, 'ipod_path' | 'title' | 'artist' | 'album' | 'tracklen'>): string {
  return track.ipod_path ? track.ipod_path.toLowerCase() : `no path|${track.title}|${track.artist}|${track.album}|${track.tracklen}`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(0, Math.round(bytes / 1024))} KB`;
}

const labelOf = (item: SyncItem): string => item.name ?? item.info.tags.title ?? item.id;

/** Lowercases, removes accents and punctuation, and collapses spaces. Like core's normalizeText, without the tag stripping. */
function normalise(text: string | null | undefined): string {
  return (text ?? '')
    .replace(/_/g, ' ')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// ------------------------------------------------------------- fields from tags

/** The file type text iTunes writes, from the codec, or the extension when the codec is not known. */
export function fileTypeFor(item: Pick<SyncItem, 'extension' | 'info'>): string | null {
  if (item.info.protected) return 'Protected AAC audio file';
  const extension = extensionOf(item.extension);
  if (item.info.video || ['m4v', 'mp4', 'mov'].includes(extension)) return 'MPEG-4 video file';
  const codec = item.info.audio?.codec;
  const container = item.info.container.toLowerCase();
  if (codec === 'mp3') return 'MPEG audio file';
  if (codec === 'aac' || codec === 'he-aac') return 'AAC audio file';
  if (codec === 'alac') return 'Apple Lossless audio file';
  if (codec === 'pcm' || !codec || codec === 'unknown') {
    if (container === 'wav' || extension === 'wav') return 'WAV audio file';
    if (container === 'aiff' || extension === 'aif' || extension === 'aiff') return 'AIFF audio file';
  }
  if (extension === 'mp3') return 'MPEG audio file';
  if (extension === 'm4p') return 'Protected AAC audio file';
  if (['m4a', 'm4b', 'aac'].includes(extension)) return 'AAC audio file';
  return null;
}

/** Every track field the probed facts give, then the item's own fields over them. */
export function trackFieldsFor(item: SyncItem): TrackFields {
  const { tags, audio, video } = item.info;
  const fields: TrackFields = {};
  const text = (field: keyof TrackFields, value: string | undefined): void => {
    const trimmed = value?.trim();
    if (trimmed) (fields as Record<string, unknown>)[field] = trimmed;
  };
  const number = (field: keyof TrackFields, value: number | null | undefined): void => {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) (fields as Record<string, unknown>)[field] = Math.round(value);
  };

  text('title', tags.title ?? item.name?.replace(/\.[^.]+$/, ''));
  text('artist', tags.artist);
  text('album', tags.album);
  text('albumartist', tags.albumArtist);
  text('genre', tags.genre);
  text('composer', tags.composer);
  text('comment', tags.comment);
  text('grouping', tags.grouping);
  text('description', tags.description);
  number('year', tags.year);
  number('track_nr', tags.trackNumber);
  number('tracks', tags.trackTotal);
  number('cd_nr', tags.discNumber);
  number('cds', tags.discTotal);
  number('BPM', tags.bpm);
  if (typeof tags.compilation === 'boolean') fields.compilation = tags.compilation ? 1 : 0;
  number('tracklen', item.info.durationMs);
  number('bitrate', audio?.bitrateKbps ?? video?.bitrateKbps ?? null);
  number('samplerate', audio?.sampleRateHz);
  number('size', item.data.size);
  const fileType = fileTypeFor(item);
  if (fileType) fields.filetype = fileType;

  if (item.kind === 'tv-show') {
    text('tvshow', tags.show);
    number('season_nr', tags.season);
    number('episode_nr', tags.episode);
    text('tvepisode', tags.episodeId);
    text('tvnetwork', tags.network);
  }
  if (PODCAST_KINDS.includes(item.kind)) {
    text('category', tags.podcastCategory);
    text('podcasturl', tags.podcastEpisodeUrl);
    text('podcastrss', tags.podcastFeedUrl);
  }
  return { ...fields, ...(item.fields ?? {}) };
}

// ----------------------------------------------------------------- duplicates

interface Identity {
  kind: string;
  text: string;
  tracklen: number;
}

function identityOf(kind: string, fields: Pick<TrackInfo, 'title' | 'artist' | 'album' | 'tvshow' | 'season_nr' | 'episode_nr' | 'tracklen'> | TrackFields): Identity | null {
  const title = normalise((fields.title as string | null | undefined) ?? '');
  if (!title) return null;
  const effectiveKind = kind === 'unspecified' ? 'music' : kind;
  const parts = [normalise(fields.artist as string | null | undefined), normalise(fields.album as string | null | undefined), title];
  if (effectiveKind === 'tv-show') parts.push(normalise(fields.tvshow as string | null | undefined), String(fields.season_nr ?? 0), String(fields.episode_nr ?? 0));
  return { kind: effectiveKind, text: parts.join('|'), tracklen: Number(fields.tracklen ?? 0) };
}

/** Same kind, same normalised artist, album and title, and durations within 2 seconds (or one unknown). */
function sameItem(a: Identity, b: Identity): boolean {
  if (a.kind !== b.kind || a.text !== b.text) return false;
  return !a.tracklen || !b.tracklen || Math.abs(a.tracklen - b.tracklen) <= 2000;
}

// --------------------------------------------------------------- iPod listing

interface MusicFile {
  /** From the iPod's top folder, with the names as the iPod spells them. */
  path: string;
  size: number | null;
}

async function findDirectory(parent: DirectoryEntry, name: string): Promise<DirectoryEntry | null> {
  try {
    return await parent.getDirectoryHandle(name);
  } catch {
    return null;
  }
}

/** Every file directly inside the iPod's Music/Fxx folders. Sizes only when asked, each costs a look at the file. */
async function listMusicFiles(root: DirectoryEntry, withSizes: boolean): Promise<{ folders: string[]; files: MusicFile[] }> {
  const folders: string[] = [];
  const files: MusicFile[] = [];
  const control = await findDirectory(root, 'iPod_Control');
  const music = control ? await findDirectory(control, 'Music') : null;
  if (!music) return { folders, files };
  for await (const [folderName, folder] of music.entries()) {
    if (folder.kind !== 'directory' || !/^F\d\d$/i.test(folderName)) continue;
    folders.push(folderName);
    for await (const [name, entry] of folder.entries()) {
      if (entry.kind !== 'file') continue;
      let size: number | null = null;
      if (withSizes) {
        try {
          size = (await entry.getFile()).size;
        } catch {
          size = null;
        }
      }
      files.push({ path: `${MUSIC}/${folderName}/${name}`, size });
    }
  }
  folders.sort();
  return { folders, files };
}

/** The database and device files on the iPod now, the same set the loader reads. */
async function readDatabaseFiles(root: DirectoryEntry): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  const control = await findDirectory(root, 'iPod_Control');
  if (!control) return files;
  const walk = async (directory: DirectoryEntry, prefix: string): Promise<void> => {
    for await (const [name, entry] of directory.entries()) {
      if (isClutter(name)) continue;
      const path = `${prefix}/${name}`;
      if (entry.kind === 'directory') await walk(entry, path);
      else if (!isNotNeeded(path.slice('iPod_Control/'.length))) files.set(path, new Uint8Array(await (await entry.getFile()).arrayBuffer()));
    }
  };
  for (const name of ['iTunes', 'Device']) {
    const folder = await findDirectory(control, name);
    if (folder) await walk(folder, `iPod_Control/${name}`);
  }
  return files;
}

/** Null when the database files on the iPod are exactly the ones the plan was made from. */
async function databaseChangedSince(root: IpodRoot, originals: Map<string, Uint8Array>): Promise<string | null> {
  const now = await readDatabaseFiles(root);
  for (const [path, bytes] of originals) {
    const current = now.get(path);
    if (!current) return `${path} is gone from the iPod since the plan was made, so nothing was written. Plan again.`;
    if (!same(current, bytes)) return `${path} on the iPod is not what it was when the plan was made, so nothing was written. Plan again.`;
  }
  for (const path of now.keys()) {
    if (!originals.has(path)) return `${path} appeared on the iPod after the plan was made, so nothing was written. Plan again.`;
  }
  return null;
}

/** The entry in `folder` with this name, ignoring case as the iPod's disk does, or null. */
async function entryNamed(folder: DirectoryEntry, name: string): Promise<string | null> {
  const wanted = name.toLowerCase();
  for await (const [entryName] of folder.entries()) if (entryName.toLowerCase() === wanted) return entryName;
  return null;
}

async function isEmptyFolder(folder: DirectoryEntry): Promise<boolean> {
  for await (const _ of folder.entries()) return false;
  return true;
}

// ------------------------------------------------------ the library in memory

interface Session {
  engine: Engine;
  mount: string;
  fireWireId: string | null;
  originals: Map<string, Uint8Array>;
  tracksBefore: TrackInfo[];
  playlistsBefore: PlaylistInfo[];
}

/** What every plan carries: the database files that change, and the library they should read back as. */
export interface LibraryPlan {
  mount: string;
  fireWireId: string | null;
  /** The database files that would change. */
  database: PlannedChange[];
  /** Files libgpod writes that are deliberately left off the iPod, and why. */
  databaseSkipped: { path: string; reason: string }[];
  /** One sentence for each change, for showing before applying. No titles of other tracks. */
  summary: string[];
  /** What the iPod holds now and what would be written. Kept so applying needs no second guess. */
  originals: Map<string, Uint8Array>;
  rewritten: Map<string, Uint8Array>;
  tracksBefore: TrackInfo[];
  playlistsBefore: PlaylistInfo[];
  /** The library as the engine read it back from the database it wrote in memory. */
  expectedTracks: TrackInfo[];
  expectedPlaylists: PlaylistInfo[];
}

export interface LibraryPlanOptions {
  mount?: string;
  onProgress?: (message: string) => void;
}

async function openSession(root: IpodRoot, newEngine: () => Promise<Engine>, options: LibraryPlanOptions): Promise<Session> {
  const mount = options.mount ?? DEFAULT_MOUNT;
  const engine = await newEngine();
  const load = await loadIpodFolder(root, engine, { mount, onProgress: options.onProgress });
  if (!load.hasDatabaseFolder) throw new SyncError(`"${root.name}" has no iTunes folder in iPod_Control, so there is no library to change.`);
  try {
    engine.open(load.mount);
  } catch (error) {
    throw new SyncError(`The iPod's library could not be read, so nothing was planned: ${messageOf(error)}`);
  }
  const originals = readTree(engine, mount, isMusicPath);
  return { engine, mount, fireWireId: fireWireIdOf(engine, mount), originals, tracksBefore: engine.tracks(), playlistsBefore: engine.playlists() };
}

/**
 * Writes the changed library in the engine's memory, reads it back, checks it, and works out
 * which database files change. Throws a SyncError for anything that would make applying fail.
 */
async function finishSession(session: Session, summary: string[], onProgress?: (message: string) => void): Promise<LibraryPlan> {
  const { engine, mount } = session;
  onProgress?.('Writing the library in memory...');
  try {
    engine.write();
  } catch (error) {
    throw new SyncError(`libgpod could not write the changed library, so nothing was planned: ${messageOf(error)}`);
  }
  const rewritten = readTree(engine, mount, isMusicPath);
  let expectedTracks: TrackInfo[];
  let expectedPlaylists: PlaylistInfo[];
  try {
    engine.close();
    engine.open(mount);
    expectedTracks = engine.tracks();
    expectedPlaylists = engine.playlists();
  } catch (error) {
    throw new SyncError(`libgpod could not read back the library it wrote, so nothing was planned: ${messageOf(error)}`);
  }
  const signatures = await verifySignatures(engine, mount, session.fireWireId);
  const bad = signatures.filter((check) => check.status === 'differs' || check.status === 'unsupported');
  if (bad.length) throw new SyncError(`The library written in memory would not carry valid signatures, so nothing was planned: ${bad.map((check) => `${check.file}: ${check.detail}`).join('; ')}`);

  const { changes, skipped } = diffTrees(session.originals, rewritten);
  for (const change of changes) {
    if (!DATABASE_PATH.test(change.path) || change.path.split('/').includes('..')) {
      throw new SyncError(`libgpod would change ${change.path}, which is outside the iPod's database folders, so nothing was planned.`);
    }
  }
  return {
    mount,
    fireWireId: session.fireWireId,
    database: changes,
    databaseSkipped: skipped,
    summary,
    originals: session.originals,
    rewritten,
    tracksBefore: session.tracksBefore,
    playlistsBefore: session.playlistsBefore,
    expectedTracks,
    expectedPlaylists,
  };
}

/** The one track a key names. Throws when there is none, or more than one. */
function trackFor(tracks: TrackInfo[], key: string): TrackInfo {
  const wanted = key.toLowerCase();
  const found = tracks.filter((track) => trackKey(track) === wanted);
  if (found.length === 0) throw new SyncError(`No track on the iPod matches "${key}". The library may have changed: read the iPod again and plan again.`);
  if (found.length > 1) throw new SyncError(`${found.length} tracks on the iPod match "${key}", so it is not clear which one is meant.`);
  return found[0] as TrackInfo;
}

/** Null when the library read back from the iPod is what the plan expects. */
function libraryDifference(plan: LibraryPlan, back: ReadBack): string | null {
  const library = compareLibraries(plan.expectedTracks, plan.expectedPlaylists, back.tracks, back.playlists);
  if (library.tracksBefore !== library.tracksAfter || library.unmatched) {
    return `The iPod's library reads back with ${library.tracksAfter} tracks, and it should have ${library.tracksBefore}.`;
  }
  if (Object.keys(library.changedFields).length || library.playlistChanges.length) {
    return `The iPod's library reads back differently from the plan: ${[...Object.keys(library.changedFields).map((field) => `track field "${field}"`), ...library.playlistChanges].join('; ')}`;
  }
  if (back.badSignatures.length) return `A signature on the iPod is not confirmed after the write: ${back.badSignatures.join('; ')}`;
  return null;
}

/** Null when every track the iPod had before reads back unchanged (except the ones removed or edited on purpose). */
function oldTracksDifference(before: TrackInfo[], after: TrackInfo[], leaveOut: Set<string> = new Set()): string | null {
  const kept = before.filter((track) => !leaveOut.has(trackKey(track)));
  const keys = new Set(kept.map(trackKey));
  const comparison = compareLibraries(kept, [], after.filter((track) => keys.has(trackKey(track))), []);
  if (comparison.unmatched || comparison.tracksAfter !== comparison.tracksBefore) {
    return `${comparison.tracksBefore - comparison.tracksAfter || comparison.unmatched} of the tracks the iPod had before are not in its library afterwards.`;
  }
  const fields = Object.keys(comparison.changedFields);
  if (fields.length) return `Tracks the iPod had before read back changed: ${fields.map((field) => `field "${field}"`).join(', ')}.`;
  return null;
}

// --------------------------------------------------------------------- progress

export interface SyncProgress {
  phase: 'checking' | 'copying' | 'database' | 'verifying' | 'deleting' | 'rolling-back' | 'done';
  message: string;
  /** Bytes of media written so far, and in all. */
  bytesDone: number;
  bytesTotal: number;
  /** The file being worked on, from the iPod's top folder, or null. */
  currentFile: string | null;
  /** Average media write rate since copying started, or null before there is one. */
  bytesPerSecond: number | null;
}

class Meter {
  bytesDone = 0;
  readonly bytesTotal: number;
  readonly #listener: ((progress: SyncProgress) => void) | undefined;
  #started: number | null = null;

  constructor(bytesTotal: number, listener: ((progress: SyncProgress) => void) | undefined) {
    this.bytesTotal = bytesTotal;
    this.#listener = listener;
  }

  emit(phase: SyncProgress['phase'], message: string, currentFile: string | null = null): void {
    if (!this.#listener) return;
    const seconds = this.#started === null ? 0 : (performance.now() - this.#started) / 1000;
    const bytesPerSecond = seconds > 0 && this.bytesDone > 0 ? Math.round(this.bytesDone / seconds) : null;
    try {
      this.#listener({ phase, message, bytesDone: this.bytesDone, bytesTotal: this.bytesTotal, currentFile, bytesPerSecond });
    } catch {
      // A progress display that fails must not stop a sync halfway.
    }
  }

  start(): void {
    this.#started ??= performance.now();
  }

  add(bytes: number, file: string): void {
    this.bytesDone += bytes;
    this.emit('copying', `Copying ${file}`, file);
  }
}

// -------------------------------------------------------------------- planning

export interface PlannedFile {
  itemId: string;
  /** From the iPod's top folder, for example iPod_Control/Music/F12/libgpod123456.mp3. */
  path: string;
  /** As the database records it, for example :iPod_Control:Music:F12:libgpod123456.mp3. */
  ipodPath: string;
  size: number;
  kind: Kind;
  title: string | null;
}

export interface SkippedItem {
  itemId: string;
  reason: string;
}

export interface DuplicateFound {
  itemId: string;
  /** The key of the track already on the iPod, or null when it matches another item in this sync. */
  trackKey: string | null;
  /** The other item in this sync it matches, or null. */
  otherItemId: string | null;
  /** True when the item was left out because of it. */
  skipped: boolean;
}

export interface SpaceCheck {
  /** As given, or null when it was not. */
  capacityBytes: number | null;
  /** The sizes of the tracks already on the iPod, added up. */
  usedBytes: number;
  /** The media this sync would copy. */
  newBytes: number;
  reserveBytes: number;
  /** Null when there was no capacity to check against. */
  fits: boolean | null;
}

export interface SyncPlan extends LibraryPlan {
  /** The media files to copy, in order. */
  files: PlannedFile[];
  skipped: SkippedItem[];
  duplicates: DuplicateFound[];
  /** Playlists the new tracks go into. */
  playlists: { name: string; created: boolean; itemIds: string[] }[];
  space: SpaceCheck;
  /** Plain sentences worth showing before applying. */
  warnings: string[];
  bytesToCopy: number;
  /** Where each file is read from, by item id. */
  sources: Map<string, SyncData>;
}

export interface SyncPlanOptions extends LibraryPlanOptions {
  /** The iPod's usable size in bytes. Without it, space cannot be checked. */
  capacityBytes?: number;
  /** What to do with an item that is already on the iPod. Skipped unless told otherwise. */
  duplicates?: 'skip' | 'allow';
}

/** How many times to ask libgpod for a name before giving up. A clash is rare, so this is plenty. */
const NAME_TRIES = 50;

/** A name in a Music/Fxx folder that is not on the iPod and not used by this plan. */
function chooseDestination(engine: Engine, mount: string, extension: string, taken: Set<string>): string {
  for (let attempt = 0; attempt < NAME_TRIES; attempt += 1) {
    const full = engine.destPath(`file.${extension}`);
    const relative = full.startsWith(`${mount}/`) ? full.slice(mount.length + 1) : '';
    if (!MEDIA_PATH.test(relative)) throw new SyncError(`libgpod chose ${full}, which is not inside a Music/Fxx folder, so nothing was planned.`);
    const key = relative.toLowerCase();
    if (taken.has(key)) continue;
    taken.add(key);
    // A stand-in so libgpod sees the name as used when it picks the next one.
    engine.fs.writeFile(full, new Uint8Array(0));
    return full;
  }
  throw new SyncError(`No free file name was found in the iPod's music folders after ${NAME_TRIES} tries, so nothing was planned.`);
}

/**
 * Plans putting `items` on the iPod. Reads the iPod and changes only the engine's memory.
 * Throws a SyncError when the files will not fit or libgpod cannot make the library.
 */
export async function planSync(root: IpodRoot, newEngine: () => Promise<Engine>, items: SyncItem[], options: SyncPlanOptions = {}): Promise<SyncPlan> {
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) throw new SyncError(`Two items share the id "${item.id}". Each item needs its own.`);
    ids.add(item.id);
  }

  const session = await openSession(root, newEngine, options);
  const { engine, mount } = session;

  // Give the engine a stand-in for every file already in the music folders, so libgpod's own
  // clash check sees them. The real listing is also kept and checked against every name picked.
  options.onProgress?.('Listing the files in the music folders...');
  const listing = await listMusicFiles(root, false);
  if (!listing.folders.length) {
    throw new SyncError(`"${root.name}" has no Music/Fxx folders in iPod_Control. An iPod set up by iTunes or Finder has them, so it may need restoring first.`);
  }
  const taken = new Set<string>();
  for (const file of listing.files) {
    taken.add(file.path.toLowerCase());
    const inEngine = `${mount}/${file.path}`;
    if (!engine.fs.analyzePath(inEngine).exists) engine.fs.writeFile(inEngine, new Uint8Array(0));
  }

  const skipped: SkippedItem[] = [];
  const duplicates: DuplicateFound[] = [];
  const warnings: string[] = [];
  const allowDuplicates = options.duplicates === 'allow';

  const existing = session.tracksBefore.map((track) => ({ track, identity: identityOf(track.kind, track) }));
  const accepted: { item: SyncItem; fields: TrackFields; identity: Identity | null }[] = [];

  for (const item of items) {
    const extension = extensionOf(item.extension);
    if (!KINDS.includes(item.kind)) {
      skipped.push({ itemId: item.id, reason: `"${item.kind}" is not a kind of track the iPod knows.` });
      continue;
    }
    if (extension === 'aa' || extension === 'aax') {
      skipped.push({ itemId: item.id, reason: 'Audible files are not put on the iPod by this app yet.' });
      continue;
    }
    if (!PLAYABLE_EXTENSIONS.includes(extension)) {
      skipped.push({ itemId: item.id, reason: `The iPod does not play .${extension || '(none)'} files as they are. Convert it first.` });
      continue;
    }
    if (!(item.data.size > 0)) {
      skipped.push({ itemId: item.id, reason: 'The file is empty.' });
      continue;
    }
    if (item.data.size > MAX_FILE_BYTES) {
      skipped.push({ itemId: item.id, reason: `The file is ${formatBytes(item.data.size)}, more than the 4 GB an iPod file can be.` });
      continue;
    }
    const fields = trackFieldsFor(item);
    const identity = identityOf(item.kind, fields);
    if (identity) {
      const onIpod = existing.find((other) => other.identity && sameItem(identity, other.identity));
      const inBatch = onIpod ? undefined : accepted.find((other) => other.identity && sameItem(identity, other.identity));
      if (onIpod || inBatch) {
        duplicates.push({ itemId: item.id, trackKey: onIpod ? trackKey(onIpod.track) : null, otherItemId: inBatch ? inBatch.item.id : null, skipped: !allowDuplicates });
        if (!allowDuplicates) {
          skipped.push({ itemId: item.id, reason: onIpod ? 'It is already on the iPod (same kind, artist, album, title and length).' : `It is the same as "${labelOf(inBatch!.item)}" in this sync.` });
          continue;
        }
      }
    }
    accepted.push({ item, fields, identity });
  }

  const usedBytes = session.tracksBefore.reduce((sum, track) => sum + (track.size || 0), 0);
  const newBytes = accepted.reduce((sum, entry) => sum + entry.item.data.size, 0);
  const capacityBytes = typeof options.capacityBytes === 'number' && options.capacityBytes > 0 ? options.capacityBytes : null;
  const space: SpaceCheck = { capacityBytes, usedBytes, newBytes, reserveBytes: SPACE_RESERVE_BYTES, fits: null };
  if (capacityBytes !== null) {
    space.fits = usedBytes + newBytes + SPACE_RESERVE_BYTES <= capacityBytes;
    if (!space.fits) {
      const free = Math.max(0, capacityBytes - usedBytes - SPACE_RESERVE_BYTES);
      throw new SyncError(
        `These files need ${formatBytes(newBytes)} and the iPod has about ${formatBytes(free)} free (${formatBytes(capacityBytes)} in all, ` +
          `${formatBytes(usedBytes)} used by its tracks, ${formatBytes(SPACE_RESERVE_BYTES)} kept free for the database). Nothing was written. Choose fewer files.`,
      );
    }
  } else if (accepted.length) {
    warnings.push("The iPod's free space was not checked, because its size was not given. If it fills up during the copy, everything this sync did is undone.");
  }
  const withArt = accepted.filter((entry) => entry.item.info.artwork).length;
  if (withArt) warnings.push(`${withArt} of the files carry album art, which is not put on the iPod yet: this engine build cannot write artwork.`);

  const summary: string[] = [];
  const files: PlannedFile[] = [];
  const sources = new Map<string, SyncData>();
  const playlistUse = new Map<string, { name: string; created: boolean; itemIds: string[] }>();

  if (accepted.length) {
    options.onProgress?.('Adding the new tracks in memory...');
    let lists = engine.playlists();
    const master = lists.find((list) => list.master);
    for (const { item, fields } of accepted) {
      let handle: number;
      let destination: string;
      try {
        handle = engine.addTrack(item.kind, fields);
        for (const chapter of item.info.chapters) engine.addChapter(handle, chapter.startMs, chapter.title);
        destination = chooseDestination(engine, mount, extensionOf(item.extension), taken);
        engine.commit(handle, destination, item.data.size);
      } catch (error) {
        if (error instanceof SyncError) throw error;
        throw new SyncError(`"${labelOf(item)}" could not be added to the library, so nothing was planned: ${messageOf(error)}`);
      }
      const relative = destination.slice(mount.length + 1);
      files.push({
        itemId: item.id,
        path: relative,
        ipodPath: `:${relative.replaceAll('/', ':')}`,
        size: item.data.size,
        kind: item.kind,
        title: (fields.title as string | undefined) ?? null,
      });
      sources.set(item.id, item.data);

      for (const raw of item.playlists ?? []) {
        const name = raw.trim();
        if (!name || (master && master.name === name)) continue;
        const find = (): PlaylistInfo | undefined => {
          const matches = lists.filter((list) => list.name === name && !list.master);
          return matches.find((list) => !list.smart) ?? matches[0];
        };
        let target = find();
        if (!target) {
          // A podcast added above may have made the podcast playlist, so look again before making one.
          lists = engine.playlists();
          target = find();
        }
        if (target?.smart) {
          warnings.push(`"${name}" is a smart playlist. The iPod fills it by its own rules, so "${labelOf(item)}" was not added to it.`);
          continue;
        }
        if (target?.podcasts && !PODCAST_KINDS.includes(item.kind)) {
          warnings.push(`"${name}" is the podcast playlist, which only holds podcasts, so "${labelOf(item)}" was not added to it.`);
          continue;
        }
        let created = false;
        try {
          if (!target) {
            target = { handle: engine.createPlaylist(name), name, master: false, podcasts: false, smart: false, tracks: [] };
            lists.push(target);
            created = true;
          }
          engine.addToPlaylist(target.handle, handle);
        } catch (error) {
          throw new SyncError(`"${labelOf(item)}" could not be put in the playlist "${name}", so nothing was planned: ${messageOf(error)}`);
        }
        const use = playlistUse.get(name) ?? { name, created, itemIds: [] };
        use.itemIds.push(item.id);
        playlistUse.set(name, use);
      }
    }
    summary.push(`Add ${files.length} ${files.length === 1 ? 'track' : 'tracks'}, ${formatBytes(newBytes)} of media.`);
    for (const use of playlistUse.values()) summary.push(`${use.created ? 'Create the playlist' : 'Add to the playlist'} "${use.name}" (${use.itemIds.length}).`);
  }

  let library: LibraryPlan;
  if (accepted.length) {
    library = await finishSession(session, summary, options.onProgress);
    // Check in memory what applying will check on the iPod, so a problem shows before anything is written.
    const byPath = new Map(library.expectedTracks.map((track) => [(track.ipod_path ?? '').toLowerCase(), track]));
    for (const file of files) {
      const track = byPath.get(file.ipodPath.toLowerCase());
      if (!track) throw new SyncError(`libgpod did not keep the new track for ${file.path} when it wrote the library in memory, so nothing was planned.`);
      if (track.kind !== file.kind) throw new SyncError(`The new track for ${file.path} reads back as ${track.kind} and should be ${file.kind}, so nothing was planned.`);
    }
    const old = oldTracksDifference(session.tracksBefore, library.expectedTracks);
    if (old) throw new SyncError(`${old} This was found in memory, so nothing was planned.`);
  } else {
    library = {
      mount, fireWireId: session.fireWireId, database: [], databaseSkipped: [], summary: ['Nothing to add.'],
      originals: session.originals, rewritten: session.originals, tracksBefore: session.tracksBefore, playlistsBefore: session.playlistsBefore,
      expectedTracks: session.tracksBefore, expectedPlaylists: session.playlistsBefore,
    };
  }

  return { ...library, files, skipped, duplicates, playlists: [...playlistUse.values()], space, warnings, bytesToCopy: newBytes, sources };
}

// --------------------------------------------------------------------- applying

export interface LibraryReport {
  database: { written: { path: string; size: number }[]; removed: string[] };
  /** True when the iPod reads back with the planned library and valid signatures. */
  verified: boolean;
  signatures: SignatureCheck[];
  /** True when the run was stopped through the AbortSignal. */
  aborted: boolean;
  /** True when something went wrong and what had been done was undone. */
  rolledBack: boolean;
  /** What the rollback put back or deleted, one line each. */
  undone: string[];
  /** What the rollback could not undo. If there is anything here, restore the backup. */
  rollbackFailures: string[];
  /** True when the iPod could not be put back fully and the backup must be restored before using it. */
  restoreNeeded: boolean;
  /** What went wrong, one sentence each. */
  failures: string[];
}

export interface SyncReport extends LibraryReport {
  copied: { itemId: string; path: string; size: number }[];
  skipped: SkippedItem[];
}

export interface ApplyLibraryOptions {
  /** The backup made in this session. It must be complete. */
  backup: BackupReport | null;
  onProgress?: (progress: SyncProgress) => void;
  signal?: AbortSignal;
}

export interface ApplySyncOptions extends ApplyLibraryOptions {
  /** Files copied at once. Three was fastest on the owner's nano 7G. */
  concurrency?: number;
  /** Bytes read and written at a time. */
  chunkBytes?: number;
}

/** What a run has done to the iPod so far, so it can be undone. */
interface RunState {
  touched: Touched[];
  /** Media files this run created, from the iPod's top folder. */
  createdFiles: string[];
  /** Folders this run created. */
  createdFolders: string[];
}

class Stopped extends Error {}

const RESTORE_ADVICE = 'Not everything could be put back. Do not use the iPod as it is: restore the backup made before this run, from the restore panel, then check it again.';

/** Database first, so the iPod never lists files that are about to go; then the media this run created. */
async function undoRun(root: IpodRoot, state: RunState): Promise<{ undone: string[]; failures: string[] }> {
  const undone: string[] = [];
  const failures = await rollBack(root, state.touched);
  for (const path of new Set(state.touched.map((item) => item.path))) {
    if (!failures.some((failure) => failure.startsWith(`${path} `))) undone.push(`Put back ${path}`);
  }
  for (const path of [...new Set(state.createdFiles)].reverse()) {
    try {
      if (await fileAt(root, path)) await removeFrom(root, path);
    } catch {
      // checked just below
    }
    if (await fileAt(root, path)) failures.push(`${path} was copied by this run and could not be deleted.`);
    else undone.push(`Deleted ${path}`);
  }
  for (const path of [...new Set(state.createdFolders)].sort().reverse()) {
    try {
      const folder = await folderAt(root, path.split('/'), false);
      if (folder && (await isEmptyFolder(folder))) {
        await removeFrom(root, path);
        undone.push(`Removed the empty folder ${path}`);
      }
    } catch {
      // An empty folder left behind holds nothing and changes nothing on the iPod.
    }
  }
  return { undone, failures };
}

function emptyReport(): LibraryReport {
  return { database: { written: [], removed: [] }, verified: false, signatures: [], aborted: false, rolledBack: false, undone: [], rollbackFailures: [], restoreNeeded: false, failures: [] };
}

/** Refuses a plan that would write or delete outside the places this module may touch. */
function checkPlanPaths(plan: LibraryPlan, mediaPaths: string[]): void {
  for (const change of plan.database) {
    if (!DATABASE_PATH.test(change.path) || change.path.split('/').includes('..')) throw new SyncError(`The plan would change ${change.path}, which is outside the iPod's database folders. Nothing was written.`);
  }
  for (const path of mediaPaths) {
    if (!MEDIA_PATH.test(path)) throw new SyncError(`The plan would touch ${path}, which is not directly inside a Music/Fxx folder. Nothing was written.`);
  }
}

async function ensureFolder(root: IpodRoot, parts: string[], state: RunState): Promise<IpodRoot> {
  let current = root;
  let path = '';
  for (const part of parts) {
    path = path ? `${path}/${part}` : part;
    let next: IpodRoot | null = null;
    try {
      next = await current.getDirectoryHandle(part);
    } catch {
      next = null;
    }
    if (!next) {
      if (!isMusicPath(path)) throw new Error(`${path} is missing from the iPod, and only music folders are ever made.`);
      next = await current.getDirectoryHandle(part, { create: true });
      state.createdFolders.push(path);
    }
    current = next;
  }
  return current;
}

interface CopyContext {
  root: IpodRoot;
  state: RunState;
  meter: Meter;
  chunkBytes: number;
  shouldStop: () => boolean;
}

type Sliceable = FileLike & { slice?: (start: number, end: number) => { arrayBuffer(): Promise<ArrayBuffer> } };

/** Copies one file in pieces, then reads it back from the iPod in pieces and compares it with the original. */
async function copyOne(file: PlannedFile, source: SyncData, context: CopyContext): Promise<void> {
  const { chunkBytes, shouldStop, meter } = context;
  if (source.size !== file.size) throw new Error(`the file is ${source.size} bytes now and was ${file.size} when the plan was made`);
  const parts = file.path.split('/');
  const name = parts[parts.length - 1] as string;
  const folder = await ensureFolder(context.root, parts.slice(0, -1), context.state);
  if (await entryNamed(folder, name)) throw new Error('a file with that name is already on the iPod, and it was not overwritten');

  const handle = await folder.getFileHandle(name, { create: true });
  context.state.createdFiles.push(file.path);
  const writer = await handle.createWritable();
  try {
    for (let start = 0; start < file.size; start += chunkBytes) {
      if (shouldStop()) throw new Stopped(STOPPED);
      const end = Math.min(file.size, start + chunkBytes);
      const bytes = await source.read(start, end);
      if (bytes.length !== end - start) throw new Error(`reading bytes ${start} to ${end} of the original gave ${bytes.length} bytes`);
      await writer.write(bytes);
      meter.add(bytes.length, file.path);
    }
    await writer.close();
  } catch (error) {
    try {
      await (writer as { abort?: () => Promise<void> }).abort?.();
    } catch {
      // The file is deleted in the rollback either way.
    }
    throw error;
  }

  meter.emit('copying', `Checking ${file.path}`, file.path);
  const written = (await handle.getFile()) as Sliceable;
  if (written.size !== file.size) throw new Error(`it is ${written.size} bytes on the iPod after the copy and should be ${file.size}`);
  let whole: Uint8Array | null = null;
  for (let start = 0; start < file.size; start += chunkBytes) {
    if (shouldStop()) throw new Stopped(STOPPED);
    const end = Math.min(file.size, start + chunkBytes);
    const expected = await source.read(start, end);
    let actual: Uint8Array;
    if (typeof written.slice === 'function') {
      actual = new Uint8Array(await written.slice(start, end).arrayBuffer());
    } else {
      whole ??= new Uint8Array(await written.arrayBuffer());
      actual = whole.subarray(start, end);
    }
    if (!same(expected, actual)) throw new Error(`it did not match the original when it was read back from the iPod (bytes ${start} to ${end})`);
  }
}

/** Copies every planned file, `concurrency` at a time. Returns the first problem, or null. */
async function copyAll(plan: SyncPlan, report: SyncReport, context: CopyContext, concurrency: number): Promise<{ message: string; aborted: boolean } | null> {
  const queue = [...plan.files];
  let failure: { message: string; aborted: boolean } | null = null;
  const stopNow = context.shouldStop;
  const shouldStop = (): boolean => failure !== null || stopNow();
  const inner: CopyContext = { ...context, shouldStop };

  const worker = async (): Promise<void> => {
    while (queue.length && !shouldStop()) {
      const file = queue.shift() as PlannedFile;
      const source = plan.sources.get(file.itemId);
      try {
        if (!source) throw new Error('the plan has no file to read it from');
        await copyOne(file, source, inner);
        report.copied.push({ itemId: file.itemId, path: file.path, size: file.size });
      } catch (error) {
        if (error instanceof Stopped) failure ??= { message: STOPPED, aborted: true };
        else failure ??= { message: `${file.path} could not be copied: ${messageOf(error)}`, aborted: false };
      }
    }
  };
  context.meter.start();
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, worker));
  if (!failure && stopNow()) failure = { message: STOPPED, aborted: true };
  return failure;
}

interface RunSteps<R extends LibraryReport> {
  report: R;
  meter: Meter;
  /** More checks before anything is written. A message stops the run with nothing written. */
  preCheck?: () => Promise<string | null>;
  /** Work done before the database is written, such as copying media. Returns the first problem, or null. */
  beforeDatabase?: (state: RunState) => Promise<{ message: string; aborted: boolean } | null>;
  /** More checks on the iPod read back after the write. A message rolls everything back. */
  check?: (back: ReadBack) => Promise<string | null>;
  done: () => string;
}

/**
 * The shared run: check the iPod is as planned, do the work before the database, write the
 * database with the write-back order and checks, read the iPod back with a fresh engine and
 * check it. Any failure or stop undoes everything and checks the undo.
 */
async function runPlan<R extends LibraryReport>(
  plan: LibraryPlan,
  root: IpodRoot,
  newEngine: () => Promise<Engine>,
  options: ApplyLibraryOptions,
  steps: RunSteps<R>,
): Promise<{ report: R; back: ReadBack | null }> {
  const { report, meter } = steps;
  const state: RunState = { touched: [], createdFiles: [], createdFolders: [] };
  const stopped = (): boolean => options.signal?.aborted === true;
  const nothingWritten = (message: string): { report: R; back: null } => {
    report.failures.push(message);
    meter.emit('done', message);
    return { report, back: null };
  };
  const fail = async (message: string, aborted = false): Promise<{ report: R; back: null }> => {
    report.failures.push(message);
    report.aborted ||= aborted;
    meter.emit('rolling-back', 'Something went wrong. Putting the iPod back as it was...');
    const undo = await undoRun(root, state);
    report.undone = undo.undone;
    report.rollbackFailures = undo.failures;
    report.rolledBack = true;
    if (undo.failures.length) {
      report.restoreNeeded = true;
      report.failures.push(RESTORE_ADVICE);
    }
    meter.emit('done', report.restoreNeeded ? RESTORE_ADVICE : 'Everything this run did was undone.');
    return { report, back: null };
  };

  if (stopped()) {
    report.aborted = true;
    return nothingWritten('The run was stopped before anything was written.');
  }

  // The iPod must be as it was when the plan was made.
  meter.emit('checking', 'Checking the iPod is as it was when the plan was made...');
  try {
    const changed = (await databaseChangedSince(root, plan.originals)) ?? (await steps.preCheck?.()) ?? null;
    if (changed) return nothingWritten(changed);
  } catch (error) {
    return nothingWritten(`The iPod could not be checked before writing, so nothing was written: ${messageOf(error)}`);
  }

  if (steps.beforeDatabase) {
    const problem = await steps.beforeDatabase(state);
    if (problem) return fail(problem.message, problem.aborted);
  }

  // The database, only now that everything before it is safely on the iPod.
  if (stopped()) return fail(STOPPED, true);
  const write = await writeDatabaseChanges(root, plan.database, plan.originals, plan.rewritten, state.touched, {
    onStep: (message) => meter.emit('database', message),
    stopReason: () => (stopped() ? STOPPED : null),
  });
  report.database = { written: write.written, removed: write.removed };
  if (write.failure) return fail(write.failure, write.failure === STOPPED);

  // Read the whole iPod back with a fresh engine.
  if (stopped()) return fail(STOPPED, true);
  meter.emit('verifying', 'Reading the iPod back to check it...');
  let back: ReadBack | null;
  try {
    back = await readBackIpod(root, newEngine, plan.mount, plan.fireWireId);
    if (!back) return fail('The iPod has no database folder after the write.');
    report.signatures = back.signatures;
    const difference = libraryDifference(plan, back) ?? (await steps.check?.(back)) ?? null;
    if (difference) return fail(difference);
  } catch (error) {
    return fail(`The iPod could not be read back after the write: ${messageOf(error)}`);
  }
  if (stopped()) return fail(STOPPED, true);

  report.verified = true;
  meter.emit('done', steps.done());
  return { report, back };
}

/**
 * Puts a planned sync on the iPod: media first, then the database, then a full read-back.
 * Needs a complete backup. On any failure, or a stop, undoes everything it did and checks it.
 * Never throws for a problem with the iPod: it reports it.
 */
export async function applySync(plan: SyncPlan, root: IpodRoot, newEngine: () => Promise<Engine>, options: ApplySyncOptions): Promise<SyncReport> {
  requireBackup(options.backup, (message) => new SyncError(message));
  checkPlanPaths(plan, plan.files.map((file) => file.path));
  const concurrency = Math.max(1, Math.min(MAX_CONCURRENCY, Math.floor(options.concurrency ?? DEFAULT_CONCURRENCY)));
  const chunkBytes = Math.max(1, Math.floor(options.chunkBytes ?? DEFAULT_CHUNK_BYTES));
  const report: SyncReport = { ...emptyReport(), copied: [], skipped: plan.skipped };
  const meter = new Meter(plan.bytesToCopy, options.onProgress);
  const stopped = (): boolean => options.signal?.aborted === true;

  if (!plan.files.length && !plan.database.length) {
    meter.emit('done', 'Nothing to put on the iPod.');
    return report;
  }

  const result = await runPlan(plan, root, newEngine, options, {
    report,
    meter,
    // No planned file may be on the iPod yet, whatever the case of its name.
    preCheck: async () => {
      const listing = await listMusicFiles(root, false);
      const onIpod = new Set(listing.files.map((file) => file.path.toLowerCase()));
      const clash = plan.files.find((file) => onIpod.has(file.path.toLowerCase()));
      return clash ? `${clash.path} is already on the iPod, so nothing was written and nothing was overwritten. Plan again.` : null;
    },
    // Media, a few at a time, each read back, before the database names any of it.
    beforeDatabase: (state) => copyAll(plan, report, { root, state, meter, chunkBytes, shouldStop: stopped }, concurrency),
    check: async (back) => {
      const byPath = new Map(back.tracks.map((track) => [(track.ipod_path ?? '').toLowerCase(), track]));
      for (const file of plan.files) {
        const track = byPath.get(file.ipodPath.toLowerCase());
        if (!track) return `${file.path} has no track in the iPod's library after the sync.`;
        if (track.kind !== file.kind) return `The track for ${file.path} reads back as ${track.kind} and should be ${file.kind}.`;
        const onIpod = await fileAt(root, file.path);
        if (!onIpod || onIpod.size !== file.size) return `${file.path} is not on the iPod with its full size after the sync.`;
      }
      return oldTracksDifference(plan.tracksBefore, back.tracks);
    },
    done: () => `Put ${report.copied.length} ${report.copied.length === 1 ? 'file' : 'files'} on the iPod and checked it.`,
  });
  return result.report;
}

/** Writes a database-only plan with the write-back order and checks, and reads it back. */
async function applyDatabasePlan(
  plan: LibraryPlan,
  root: IpodRoot,
  newEngine: () => Promise<Engine>,
  options: ApplyLibraryOptions,
  check?: (back: ReadBack) => string | null,
): Promise<{ report: LibraryReport; back: ReadBack | null }> {
  requireBackup(options.backup, (message) => new SyncError(message));
  checkPlanPaths(plan, []);
  return runPlan(plan, root, newEngine, options, {
    report: emptyReport(),
    meter: new Meter(0, options.onProgress),
    ...(check ? { check: async (back: ReadBack) => check(back) } : {}),
    done: () => 'The library was written and checked.',
  });
}

/** Writes a plan from `planEdits` or `planPlaylistChanges`. Needs a complete backup. Rolls back on any failure. */
export async function applyLibraryPlan(plan: LibraryPlan, root: IpodRoot, newEngine: () => Promise<Engine>, options: ApplyLibraryOptions): Promise<LibraryReport> {
  return (await applyDatabasePlan(plan, root, newEngine, options)).report;
}

// ---------------------------------------------------------------------- removal

export interface RemovalPlan extends LibraryPlan {
  tracks: { key: string; title: string | null; artist: string | null; kind: string; path: string | null; size: number }[];
  /** Media files deleted after the database is written and checked. */
  files: string[];
  /** Files of removed tracks that are left alone, and why. */
  kept: { path: string; reason: string }[];
}

export interface RemovalReport extends LibraryReport {
  /** Media files deleted after the database was written and checked. */
  deleted: string[];
  /** Files that should have been deleted and are still there, and why. The library is right; `findOrphans` lists them later. */
  orphans: { path: string; reason: string }[];
}

/** Plans removing the tracks `trackKeys` name (see `trackKey`), with their files. Changes only the engine's memory. */
export async function planRemoval(root: IpodRoot, newEngine: () => Promise<Engine>, trackKeys: string[], options: LibraryPlanOptions = {}): Promise<RemovalPlan> {
  if (!trackKeys.length) throw new SyncError('No tracks were chosen to remove.');
  const session = await openSession(root, newEngine, options);
  const { engine } = session;
  const tracks = engine.tracks();
  const chosen = [...new Set(trackKeys.map((key) => key.toLowerCase()))].map((key) => trackFor(tracks, key));
  const removedKeys = new Set(chosen.map(trackKey));

  for (const track of chosen) {
    try {
      engine.removeTrack(track.handle);
    } catch (error) {
      throw new SyncError(`A track could not be removed from the library, so nothing was planned: ${messageOf(error)}`);
    }
  }
  const plan = await finishSession(session, [`Remove ${chosen.length} ${chosen.length === 1 ? 'track' : 'tracks'} and their files.`], options.onProgress);

  const stillListed = new Set(plan.expectedTracks.map((track) => mediaPathOf(track.ipod_path)?.toLowerCase()).filter((path): path is string => Boolean(path)));
  const files: string[] = [];
  const kept: { path: string; reason: string }[] = [];
  for (const track of chosen) {
    const path = mediaPathOf(track.ipod_path);
    if (!path) {
      if (track.ipod_path) kept.push({ path: track.ipod_path, reason: 'It is not inside a Music/Fxx folder, so it is left alone.' });
      continue;
    }
    if (stillListed.has(path.toLowerCase())) kept.push({ path, reason: 'Another track in the library uses this file, so it is kept.' });
    else if (!files.some((other) => other.toLowerCase() === path.toLowerCase())) files.push(path);
  }
  const old = oldTracksDifference(session.tracksBefore, plan.expectedTracks, removedKeys);
  if (old) throw new SyncError(`${old} This was found in memory, so nothing was planned.`);

  return {
    ...plan,
    tracks: chosen.map((track) => ({ key: trackKey(track), title: track.title, artist: track.artist, kind: track.kind, path: mediaPathOf(track.ipod_path), size: track.size })),
    files,
    kept,
  };
}

/**
 * Removes the planned tracks: writes and checks the database first, then deletes their files.
 * A failure before the database is checked puts the database back and deletes nothing. A file
 * that cannot be deleted afterwards is reported as left over, not as a failure.
 */
export async function applyRemoval(plan: RemovalPlan, root: IpodRoot, newEngine: () => Promise<Engine>, options: ApplyLibraryOptions): Promise<RemovalReport> {
  checkPlanPaths(plan, plan.files);
  const { report, back } = await applyDatabasePlan(plan, root, newEngine, options, (readBack) => {
    const removed = new Set(plan.tracks.map((track) => track.key));
    const left = readBack.tracks.filter((track) => removed.has(trackKey(track))).length;
    return left ? `${left} of the removed tracks are still in the iPod's library after the write.` : null;
  });
  const result: RemovalReport = { ...report, deleted: [], orphans: [] };
  if (!report.verified || !back) return result;

  const meter = new Meter(0, options.onProgress);
  const listed = new Set(back.tracks.map((track) => mediaPathOf(track.ipod_path)?.toLowerCase()).filter((path): path is string => Boolean(path)));
  for (const path of plan.files) {
    if (options.signal?.aborted) {
      result.orphans.push({ path, reason: 'The run was stopped before this file was deleted.' });
      continue;
    }
    if (listed.has(path.toLowerCase())) {
      result.orphans.push({ path, reason: 'The library still lists this file, so it was not deleted.' });
      continue;
    }
    meter.emit('deleting', `Deleting ${path}`, path);
    try {
      const parts = path.split('/');
      const folder = await folderAt(root, parts.slice(0, -1), false);
      const name = folder ? await entryNamed(folder, parts[parts.length - 1] as string) : null;
      if (!folder || !name) {
        result.orphans.push({ path, reason: 'The file was not on the iPod, so there was nothing to delete.' });
        continue;
      }
      await folder.removeEntry(name);
      if (await entryNamed(folder, name)) result.orphans.push({ path, reason: 'The file is still there after it was deleted.' });
      else result.deleted.push(path);
    } catch (error) {
      result.orphans.push({ path, reason: `The file could not be deleted: ${messageOf(error)}` });
    }
  }
  meter.emit('done', `Removed ${plan.tracks.length} ${plan.tracks.length === 1 ? 'track' : 'tracks'} and deleted ${result.deleted.length} ${result.deleted.length === 1 ? 'file' : 'files'}.`);
  return result;
}

// ------------------------------------------------------------------------ edits

export interface TrackEdit {
  /** Which track, from `trackKey`. */
  key: string;
  /** Text and number fields to set. */
  fields?: TrackFields;
  /** A new kind, which also sets its flags and podcast playlist membership. */
  kind?: Kind;
}

/** Fields that describe the file on the iPod rather than the track, so an edit may not change them. */
const FILE_FIELDS = new Set(['size']);
const EDITABLE = new Set<string>([...TEXT_FIELDS, ...NUMBER_FIELDS]);

/** Plans changing text and number fields (and optionally the kind) of existing tracks. Changes only the engine's memory. */
export async function planEdits(root: IpodRoot, newEngine: () => Promise<Engine>, edits: TrackEdit[], options: LibraryPlanOptions = {}): Promise<LibraryPlan> {
  if (!edits.length) throw new SyncError('No changes were given.');
  const session = await openSession(root, newEngine, options);
  const { engine } = session;
  const tracks = engine.tracks();
  const edited = new Set<string>();
  for (const edit of edits) {
    const track = trackFor(tracks, edit.key);
    for (const field of Object.keys(edit.fields ?? {})) {
      if (FILE_FIELDS.has(field)) throw new SyncError(`"${field}" describes the file on the iPod, so it is not changed by an edit.`);
      if (!EDITABLE.has(field)) throw new SyncError(`"${field}" is not a track field that can be changed.`);
    }
    try {
      if (edit.kind) engine.setKind(track.handle, edit.kind);
      engine.set(track.handle, edit.fields ?? {});
    } catch (error) {
      throw new SyncError(`A change could not be made, so nothing was planned: ${messageOf(error)}`);
    }
    edited.add(trackKey(track));
  }
  const plan = await finishSession(session, [`Change ${edited.size} ${edited.size === 1 ? 'track' : 'tracks'}.`], options.onProgress);
  const old = oldTracksDifference(session.tracksBefore, plan.expectedTracks, edited);
  if (old) throw new SyncError(`${old} This was found in memory, so nothing was planned.`);
  return plan;
}

/** Plans and applies edits in one go. Needs a complete backup. */
export async function editTracks(root: IpodRoot, newEngine: () => Promise<Engine>, edits: TrackEdit[], options: ApplyLibraryOptions & LibraryPlanOptions): Promise<{ plan: LibraryPlan; report: LibraryReport }> {
  requireBackup(options.backup, (message) => new SyncError(message));
  const plan = await planEdits(root, newEngine, edits, { mount: options.mount });
  return { plan, report: await applyLibraryPlan(plan, root, newEngine, options) };
}

// -------------------------------------------------------------------- playlists

/** A change to a playlist. Playlists are named by their name, which must be unique among the iPod's playlists. */
export type PlaylistChange =
  | { action: 'create'; name: string; tracks?: string[] }
  | { action: 'rename'; playlist: string; name: string }
  | { action: 'delete'; playlist: string }
  | { action: 'add'; playlist: string; tracks: string[] }
  | { action: 'remove'; playlist: string; tracks: string[] };

function playlistNamed(engine: Engine, name: string): PlaylistInfo {
  const found = engine.playlists().filter((playlist) => playlist.name === name);
  if (!found.length) throw new SyncError(`There is no playlist called "${name}" on the iPod.`);
  if (found.length > 1) throw new SyncError(`There are ${found.length} playlists called "${name}", so it is not clear which one is meant.`);
  const playlist = found[0] as PlaylistInfo;
  if (playlist.smart) throw new SyncError(`"${name}" is a smart playlist. The iPod fills it by its own rules, so it is left as it is.`);
  return playlist;
}

function refuseTakenName(engine: Engine, name: string): void {
  if (!name.trim()) throw new SyncError('A playlist needs a name.');
  if (engine.playlists().some((playlist) => playlist.name === name)) throw new SyncError(`There is already a playlist called "${name}".`);
}

/** Plans playlist changes, in order. Smart playlists are never changed. Changes only the engine's memory. */
export async function planPlaylistChanges(root: IpodRoot, newEngine: () => Promise<Engine>, changes: PlaylistChange[], options: LibraryPlanOptions = {}): Promise<LibraryPlan> {
  if (!changes.length) throw new SyncError('No playlist changes were given.');
  const session = await openSession(root, newEngine, options);
  const { engine } = session;
  const tracks = engine.tracks();
  const summary: string[] = [];
  const addTracks = (playlist: PlaylistInfo, keys: string[]): void => {
    for (const key of keys) {
      const track = trackFor(tracks, key);
      if (playlist.podcasts && !PODCAST_KINDS.includes(track.kind)) {
        throw new SyncError(`"${playlist.name}" is the podcast playlist, which only holds podcasts. Change the track's kind to podcast instead.`);
      }
      engine.addToPlaylist(playlist.handle, track.handle);
    }
  };

  try {
    for (const change of changes) {
      switch (change.action) {
        case 'create': {
          refuseTakenName(engine, change.name);
          const handle = engine.createPlaylist(change.name);
          const playlist = engine.playlists().find((list) => list.handle === handle) as PlaylistInfo;
          addTracks(playlist, change.tracks ?? []);
          summary.push(`Create the playlist "${change.name}" with ${change.tracks?.length ?? 0} tracks.`);
          break;
        }
        case 'rename': {
          const playlist = playlistNamed(engine, change.playlist);
          refuseTakenName(engine, change.name);
          engine.renamePlaylist(playlist.handle, change.name);
          summary.push(playlist.master ? `Rename the iPod to "${change.name}".` : `Rename the playlist "${change.playlist}" to "${change.name}".`);
          break;
        }
        case 'delete': {
          const playlist = playlistNamed(engine, change.playlist);
          if (playlist.master) throw new SyncError('The master playlist holds every track and cannot be deleted.');
          if (playlist.podcasts) throw new SyncError('The podcast playlist follows the tracks\' kinds and cannot be deleted.');
          engine.deletePlaylist(playlist.handle);
          summary.push(`Delete the playlist "${change.playlist}". Its tracks stay on the iPod.`);
          break;
        }
        case 'add': {
          const playlist = playlistNamed(engine, change.playlist);
          if (playlist.master) throw new SyncError('Every track is already in the master playlist.');
          addTracks(playlist, change.tracks);
          summary.push(`Add ${change.tracks.length} tracks to "${change.playlist}".`);
          break;
        }
        case 'remove': {
          const playlist = playlistNamed(engine, change.playlist);
          if (playlist.master) throw new SyncError('Every track belongs to the master playlist. Remove the track itself instead.');
          if (playlist.podcasts) throw new SyncError('The podcast playlist follows the tracks\' kinds. Change a track\'s kind to take it out.');
          for (const key of change.tracks) engine.removeFromPlaylist(playlist.handle, trackFor(tracks, key).handle);
          summary.push(`Take ${change.tracks.length} tracks out of "${change.playlist}". They stay on the iPod.`);
          break;
        }
        default:
          throw new SyncError(`Unknown playlist change "${(change as { action: string }).action}".`);
      }
    }
  } catch (error) {
    if (error instanceof SyncError) throw error;
    throw new SyncError(`A playlist change could not be made, so nothing was planned: ${messageOf(error)}`);
  }

  const plan = await finishSession(session, summary, options.onProgress);
  const old = oldTracksDifference(session.tracksBefore, plan.expectedTracks);
  if (old) throw new SyncError(`${old} This was found in memory, so nothing was planned.`);
  const smartBefore = session.playlistsBefore.filter((playlist) => playlist.smart).length;
  const smartAfter = plan.expectedPlaylists.filter((playlist) => playlist.smart).length;
  if (smartBefore !== smartAfter) throw new SyncError('The smart playlists would not be kept as they are, so nothing was planned.');
  return plan;
}

/** Plans and applies playlist changes in one go. Needs a complete backup. */
export async function changePlaylists(root: IpodRoot, newEngine: () => Promise<Engine>, changes: PlaylistChange[], options: ApplyLibraryOptions & LibraryPlanOptions): Promise<{ plan: LibraryPlan; report: LibraryReport }> {
  requireBackup(options.backup, (message) => new SyncError(message));
  const plan = await planPlaylistChanges(root, newEngine, changes, { mount: options.mount });
  return { plan, report: await applyLibraryPlan(plan, root, newEngine, options) };
}

// ---------------------------------------------------------------------- orphans

export interface OrphanFile {
  /** From the iPod's top folder. */
  path: string;
  size: number | null;
  /** True when the name is the kind libgpod gives (libgpod123456.mp3), so it most likely came from an interrupted run of this app. */
  madeByLibgpod: boolean;
}

export interface OrphanReport {
  orphans: OrphanFile[];
  /** Files in the music folders that the library lists. */
  referenced: number;
  /** Tracks whose file is not on the iPod, by their path in the library. */
  missingFiles: string[];
}

async function referencedPaths(root: IpodRoot, newEngine: () => Promise<Engine>, mount: string): Promise<{ referenced: Set<string>; tracks: TrackInfo[] }> {
  const engine = await newEngine();
  const load = await loadIpodFolder(root, engine, { mount });
  if (!load.hasDatabaseFolder) throw new SyncError(`"${root.name}" has no iTunes folder in iPod_Control, so it cannot be told which files the library uses.`);
  try {
    engine.open(load.mount);
  } catch (error) {
    throw new SyncError(`The iPod's library could not be read, so no file is called left over: ${messageOf(error)}`);
  }
  const tracks = engine.tracks();
  const referenced = new Set(tracks.map((track) => (track.ipod_path ?? '').replaceAll(':', '/').replace(/^\/+/, '').toLowerCase()).filter(Boolean));
  return { referenced, tracks };
}

/** Lists files in iPod_Control/Music/Fxx that the library does not list. Reads only. */
export async function findOrphans(root: IpodRoot, newEngine: () => Promise<Engine>, options: { mount?: string } = {}): Promise<OrphanReport> {
  const { referenced, tracks } = await referencedPaths(root, newEngine, options.mount ?? DEFAULT_MOUNT);
  const listing = await listMusicFiles(root, true);
  const orphans: OrphanFile[] = [];
  let used = 0;
  const present = new Set<string>();
  for (const file of listing.files) {
    const name = file.path.split('/').pop() as string;
    present.add(file.path.toLowerCase());
    if (isClutter(name)) continue;
    if (referenced.has(file.path.toLowerCase())) used += 1;
    else orphans.push({ path: file.path, size: file.size, madeByLibgpod: LIBGPOD_NAME.test(name) });
  }
  const missingFiles = tracks
    .map((track) => track.ipod_path)
    .filter((path): path is string => Boolean(path))
    .filter((path) => {
      const relative = mediaPathOf(path);
      return relative !== null && !present.has(relative.toLowerCase());
    });
  return { orphans, referenced: used, missingFiles };
}

export interface OrphanRemoval {
  removed: string[];
  /** Files left alone after the fresh check, and why. */
  kept: { path: string; reason: string }[];
}

/**
 * Deletes left-over files found by `findOrphans`, after reading the library again. A file the
 * library lists, a file outside the music folders, or a file whose size changed since it was
 * found is never deleted.
 */
export async function removeOrphans(root: IpodRoot, newEngine: () => Promise<Engine>, orphans: OrphanFile[], options: { mount?: string; signal?: AbortSignal } = {}): Promise<OrphanRemoval> {
  const result: OrphanRemoval = { removed: [], kept: [] };
  const { referenced } = await referencedPaths(root, newEngine, options.mount ?? DEFAULT_MOUNT);
  for (const orphan of orphans) {
    const { path } = orphan;
    const name = path.split('/').pop() ?? '';
    if (options.signal?.aborted) {
      result.kept.push({ path, reason: 'The run was stopped before this file.' });
      continue;
    }
    if (!MEDIA_PATH.test(path) || path.split('/').includes('..') || isClutter(name)) {
      result.kept.push({ path, reason: 'It is not a media file directly inside a Music/Fxx folder, so it is left alone.' });
      continue;
    }
    if (referenced.has(path.toLowerCase())) {
      result.kept.push({ path, reason: 'The library lists this file, so it is kept.' });
      continue;
    }
    try {
      const parts = path.split('/');
      const folder = await folderAt(root, parts.slice(0, -1), false);
      const actual = folder ? await entryNamed(folder, name) : null;
      if (!folder || !actual) {
        result.kept.push({ path, reason: 'It is no longer on the iPod.' });
        continue;
      }
      const file = await (await folder.getFileHandle(actual)).getFile();
      if (orphan.size !== null && file.size !== orphan.size) {
        result.kept.push({ path, reason: `It is ${file.size} bytes now and was ${orphan.size} when it was found, so it is left alone. Look again.` });
        continue;
      }
      await folder.removeEntry(actual);
      if (await entryNamed(folder, actual)) result.kept.push({ path, reason: 'It is still there after it was deleted.' });
      else result.removed.push(path);
    } catch (error) {
      result.kept.push({ path, reason: `It could not be deleted: ${messageOf(error)}` });
    }
  }
  return result;
}
