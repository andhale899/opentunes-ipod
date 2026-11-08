/**
 * Copies everything off an iPod: every media file under iPod_Control/Music/Fxx as it is, plus
 * a spreadsheet of the library and its playlists, so the music is not locked inside the iPod.
 *
 * It only reads the iPod. It writes a new folder inside the destination the person chose and
 * deletes nothing anywhere. Files are copied raw (same bytes, same names, such as F07/XKQT.mp3),
 * in pieces of 4 MiB, three at a time. Each copy is checked by size and then read back and
 * compared by CRC-32, which is computed while the file is read, so the iPod is read once. A file
 * already in the folder with the same size is skipped, so a stopped run can be resumed by
 * running again into the same folder. One file failing does not stop the others.
 *
 * Also written into the folder: library.csv, playlists.csv (UTF-8 with a byte order mark so
 * spreadsheets read accents correctly) and README.txt.
 *
 * The folder is also everything needed to put the iPod back. `database/` holds the iPod's database
 * and device files in exactly the format `backupIpod` writes (it is that function, run into this
 * folder, so it has a backup-info.json with a SHA-256 per file), and opentunes-offload.json at the
 * top lists every media file with its size and CRC-32. `restoreOffload` reads those two things:
 * it checks the database files, copies back the media files the iPod lacks, and only then
 * restores the database, so the library never lists a file that is not there.
 */

import type { Engine, PlaylistInfo, TrackInfo } from './engine.ts';
import { IpodFolderError, isClutter, loadIpodFolder, type DirectoryEntry } from './folder.ts';
import { backupIpod, type WritableDirectory } from './backup.ts';
import { folderAt, messageOf as errorMessage, type IpodRoot } from './ipod-files.ts';
import { checkBackup, describeBackup, restoreBackup, type BackupSource, type RestoreReport } from './writeback.ts';
import { mediaPathOf } from './sync.ts';
import type { PauseGate } from './pause.ts';

export class OffloadError extends Error {}

export const OFFLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
export const OFFLOAD_CONCURRENCY = 3;

const messageOf = errorMessage;

/** The marker at the top of an offload folder, and the folder inside it that holds the database files. */
export const OFFLOAD_MARKER = 'opentunes-offload.json';
export const OFFLOAD_DATABASE_FOLDER = 'database';
export const OFFLOAD_FORMAT_VERSION = 1;

// ------------------------------------------------------------------------ small tools

/** A file or a piece of one, as far as this needs: its size and, in a browser, `slice`. */
interface ReadableFile {
  size: number;
  slice?(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** Reads a file in pieces. A file with no `slice` (a minimal stand-in) is read whole once and cut up. */
function pieceReader(file: ReadableFile): (start: number, end: number) => Promise<Uint8Array> {
  let whole: Uint8Array | null = null;
  return async (start, end) => {
    if (typeof file.slice === 'function') return new Uint8Array(await file.slice(start, end).arrayBuffer());
    whole ??= new Uint8Array(await file.arrayBuffer());
    return whole.subarray(start, end);
  };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** Continues a CRC-32 over `bytes`. Start with 0. */
export function crc32(bytes: Uint8Array, previous = 0): number {
  let c = (previous ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i += 1) c = (CRC_TABLE[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const two = (value: number): string => String(value).padStart(2, '0');

function stamp(now: Date): string {
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}`;
}

async function exists(parent: WritableDirectory, name: string): Promise<boolean> {
  try {
    await parent.getDirectoryHandle(name);
    return true;
  } catch {
    return false;
  }
}

async function uniqueFolder(destination: WritableDirectory, now: Date): Promise<WritableDirectory> {
  const base = `opentunes-offload-${stamp(now)}`;
  let name = base;
  for (let n = 2; await exists(destination, name); n += 1) name = `${base}-${n}`;
  return destination.getDirectoryHandle(name, { create: true });
}

async function writeBytes(folder: WritableDirectory, name: string, bytes: Uint8Array): Promise<void> {
  const writer = await (await folder.getFileHandle(name, { create: true })).createWritable();
  await writer.write(bytes);
  await writer.close();
}

// -------------------------------------------------------------------------------- CSV

/** One CSV field, quoted when it holds a comma, a quote or a line break. Quotes are doubled. */
export function csvField(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Rows as CSV text: CRLF line ends, UTF-8 byte order mark first so spreadsheets read accents right. */
export function toCsv(rows: (string | number | null | undefined)[][]): string {
  return `﻿${rows.map((row) => row.map(csvField).join(',')).join('\r\n')}\r\n`;
}

/** What happened to a track's file in this run. */
export type TrackStatus = 'copied' | 'already there' | 'missing on the iPod' | 'failed' | 'not copied' | 'no file in the music folders';

export const LIBRARY_HEADER = [
  'Path', 'Title', 'Artist', 'Album', 'Album artist', 'Genre', 'Kind', 'Year', 'Track number', 'Disc',
  'Length (seconds)', 'Size (bytes)', 'Bitrate (kbps)', 'Rating (0-100)', 'Play count', 'Date added', 'Playlists', 'File',
];

export const PLAYLISTS_HEADER = ['Playlist', 'Position', 'Path'];

const blankZero = (value: number): number | string => (value > 0 ? value : '');

function dateOf(unixSeconds: number): string {
  if (!(unixSeconds > 0)) return '';
  const date = new Date(unixSeconds * 1000);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Playlists a track is in, by track handle. The master list (everything) is left out. */
function membership(playlists: PlaylistInfo[]): Map<number, string[]> {
  const byTrack = new Map<number, string[]>();
  for (const playlist of playlists) {
    if (playlist.master) continue;
    for (const handle of playlist.tracks) {
      const names = byTrack.get(handle) ?? [];
      names.push(playlist.name ?? '(no name)');
      byTrack.set(handle, names);
    }
  }
  return byTrack;
}

/** library.csv: one row per track. `pathOf` and `statusOf` say where its copy is and what happened to it. */
export function libraryCsv(tracks: TrackInfo[], playlists: PlaylistInfo[], pathOf: (track: TrackInfo) => string, statusOf: (track: TrackInfo) => TrackStatus): string {
  const lists = membership(playlists);
  const rows: (string | number | null)[][] = [LIBRARY_HEADER];
  for (const track of tracks) {
    rows.push([
      pathOf(track), track.title, track.artist, track.album, track.albumartist, track.genre, track.kind,
      blankZero(track.year), blankZero(track.track_nr), blankZero(track.cd_nr),
      track.tracklen > 0 ? Math.round(track.tracklen / 1000) : '', track.size, blankZero(track.bitrate),
      track.rating, track.playcount, dateOf(track.time_added), (lists.get(track.handle) ?? []).join(' | '), statusOf(track),
    ]);
  }
  return toCsv(rows);
}

/** playlists.csv: one row per entry of each playlist except the master list, in playlist order. */
export function playlistsCsv(tracks: TrackInfo[], playlists: PlaylistInfo[], pathOf: (track: TrackInfo) => string): string {
  const byHandle = new Map(tracks.map((track) => [track.handle, track]));
  const rows: (string | number | null)[][] = [PLAYLISTS_HEADER];
  for (const playlist of playlists) {
    if (playlist.master) continue;
    playlist.tracks.forEach((handle, index) => {
      const track = byHandle.get(handle);
      rows.push([playlist.name ?? '(no name)', index + 1, track ? pathOf(track) : '']);
    });
  }
  return toCsv(rows);
}

// ------------------------------------------------------------------------ the iPod

interface MusicFile {
  /** From the music folders, such as "F07/XKQT.mp3", spelled as the iPod spells it. */
  path: string;
  folder: string;
  name: string;
  entry: { getFile(): Promise<ReadableFile> };
  size: number;
}

async function listMusic(source: DirectoryEntry, signal?: AbortSignal): Promise<{ files: MusicFile[]; folders: string[] }> {
  const control = await source.getDirectoryHandle('iPod_Control').catch(() => null);
  if (!control) {
    throw new IpodFolderError(`"${source.name}" has no iPod_Control folder. Choose the top folder of the iPod itself, the one that contains iPod_Control.`);
  }
  const music = await control.getDirectoryHandle('Music').catch(() => null);
  const files: MusicFile[] = [];
  const folders: string[] = [];
  if (!music) return { files, folders };
  for await (const [folderName, folder] of music.entries()) {
    if (folder.kind !== 'directory' || !/^F\d\d$/i.test(folderName)) continue;
    folders.push(folderName);
    for await (const [name, entry] of folder.entries()) {
      signal?.throwIfAborted();
      if (entry.kind !== 'file' || isClutter(name)) continue;
      const file = await entry.getFile();
      files.push({ path: `${folderName}/${name}`, folder: folderName, name, entry: entry as MusicFile['entry'], size: file.size });
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  folders.sort();
  return { files, folders };
}

/** The library as libgpod reads it, or why it could not be read. The iPod is only read. */
async function readLibrary(source: DirectoryEntry, newEngine: () => Promise<Engine>, mount: string): Promise<{ tracks: TrackInfo[]; playlists: PlaylistInfo[]; error: string | null }> {
  try {
    const engine = await newEngine();
    const load = await loadIpodFolder(source, engine, { mount });
    if (!load.hasDatabaseFolder) return { tracks: [], playlists: [], error: 'This iPod has no iTunes folder in iPod_Control, so there is no library to list. The files were still copied.' };
    engine.open(load.mount);
    return { tracks: engine.tracks(), playlists: engine.playlists(), error: null };
  } catch (error) {
    if (error instanceof IpodFolderError && /no iPod_Control/.test(error.message)) throw error;
    return { tracks: [], playlists: [], error: `The iPod's library could not be read, so there is no library.csv. The files were still copied. ${messageOf(error)}` };
  }
}

// ------------------------------------------------------------------------ the run

export type OffloadPhase = 'reading' | 'copying' | 'finishing' | 'checking' | 'restoring';

export interface OffloadProgress {
  phase: OffloadPhase;
  message: string;
  /** Files finished, whether copied, skipped or failed. */
  filesDone: number;
  filesTotal: number;
  /** Bytes copied or skipped so far. */
  bytesDone: number;
  bytesTotal: number;
  /** Copy speed so far, not counting skipped files. 0 until something has been copied. */
  bytesPerSecond: number;
  /** Files being copied right now. */
  current: string[];
  failures: number;
}

export interface OffloadOptions {
  /** Used for the folder name. Defaults to now. */
  now?: Date;
  /** Where the iPod appears inside the engine. */
  mount?: string;
  /** Resume: copy into this existing folder of the destination, instead of making a new one. Files already there with the same size are skipped. */
  folder?: string;
  signal?: AbortSignal;
  /** Lets the person pause between files. Files already being copied are finished first. */
  pause?: PauseGate;
  onProgress?: (progress: OffloadProgress) => void;
  /** Files at once. Defaults to 3. */
  concurrency?: number;
  /** Piece size. Defaults to 4 MiB. */
  chunkBytes?: number;
  /** For speed in the report. Defaults to Date.now. */
  clock?: () => number;
}

export interface OffloadFailure {
  /** Such as "F07/XKQT.mp3". */
  path: string;
  reason: string;
}

export interface MissingTrack {
  /** Where the library says the file is. */
  path: string;
  title: string | null;
  artist: string | null;
}

export interface OffloadReport {
  /** The folder made inside the destination. */
  folder: string;
  /** True when every file is in the folder, checked, nothing was stopped and the library was read. */
  complete: boolean;
  stopped: boolean;
  files: { total: number; copied: number; skipped: number; failed: number; notCopied: number };
  bytes: { total: number; copied: number; skipped: number };
  failures: OffloadFailure[];
  /** Tracks the library lists whose file is not on the iPod. */
  missing: MissingTrack[];
  /** Files in the music folders that no track in the library lists. They are copied too. */
  unlisted: string[];
  tracks: number;
  playlists: number;
  /** Set when the library could not be read, so there are no CSV files. */
  libraryError: string | null;
  /** Set when the spreadsheets or README could not be written. */
  notesError: string | null;
  /** The iPod's database and device files, saved in `database/` in the backup format. */
  database: { folder: string; files: number; bytes: number; complete: boolean; failures: string[] } | null;
  /** Set when the database files could not be saved. The folder then cannot put the iPod back. */
  databaseError: string | null;
  elapsedMs: number;
  bytesPerSecond: number;
}

type FileState = 'copied' | 'skipped' | 'failed' | 'stopped' | 'waiting';

const README = (when: string, report: OffloadReport): string => `This folder is a full copy of an iPod, made by OpenTunes on ${when}: every music, podcast, audiobook and video file, and the iPod's library, so a single folder can put everything back.

State of this copy: ${report.complete ? 'complete' : report.stopped ? 'stopped before the end. Run the copy again into this same folder to finish it' : 'not complete, see the notes in the app'}.
Media files: ${report.files.copied + report.files.skipped} of ${report.files.total} are here${report.files.failed ? `, ${report.files.failed} failed` : ''}.
Library files (database/): ${report.database?.complete ? `${report.database.files} files, each read back and checked` : `NOT saved completely${report.databaseError ? `: ${report.databaseError}` : report.database?.failures.length ? `: ${report.database.failures.join(' ')}` : ''}. This folder cannot put the iPod back until a run saves them`}.

What is in it
  library.csv        START HERE to browse. One row per track: Path (the file in this folder), Title, Artist,
                     Album, Album artist, Genre, Kind, Year, Track number, Disc, Length (seconds), Size (bytes),
                     Bitrate (kbps), Rating (0-100, 20 per star), Play count, Date added (UTC), Playlists
                     (names joined with " | ") and File (what happened to the file: copied, already there,
                     missing on the iPod, failed or not copied).
  playlists.csv      One row per entry of each playlist: Playlist, Position and Path. The list that holds
                     everything is left out.
  F00, F01 ... F49   The iPod's own music folders, copied byte for byte. An iPod gives every file a short
                     random name (for example F07/XKQT.mp3), so the names mean nothing. The real titles
                     are in library.csv. The files are the original MP3, AAC, M4A, M4B, M4V and so on.
  database/          The iPod's library and device files, saved the way OpenTunes saves a backup: the
                     iTunes, Device and Artwork folders of iPod_Control plus the files directly in it, with
                     a backup-info.json that lists every file with its SHA-256, and its own README.txt.
  opentunes-offload.json
                     The list OpenTunes reads to put everything back: the date, how many media files and
                     bytes, and each file's size and CRC-32. Do not edit or remove it.
  README.txt         This file.

Opening the CSV files: they are UTF-8 with a byte order mark, so Excel, Numbers and Google Sheets show accents
and other scripts correctly. Fields with commas, quotes or line breaks are in quotes. To find a song, open
library.csv, search for the title, and read its Path. Open that file from this folder.

Using the audio and video somewhere else: the files in F00, F01 and so on are ordinary audio and video files
with their tags still in them. Copy them anywhere and play them in any player, and rename them from library.csv
if you like. Files bought with copy protection (.m4p) are copied as they are and will not play outside iTunes.

Putting everything back on an iPod
  1. Open OpenTunes in Chrome on a computer, connect the iPod and choose its top folder.
  2. Make a backup of the iPod as it is now (Backup tab). OpenTunes will not put anything back without one.
  3. In the Backup tab, under "Restore everything from a full copy", choose this folder.
  4. OpenTunes copies back every media file the iPod is missing, checks each, and only then puts the saved
     library back, so the library never lists a file that is not on the iPod. The iPod's library is replaced
     by the one saved here. Nothing is deleted from the iPod, and a file that is already there is not touched.
  5. Eject the iPod normally when it says it is done.

This folder and a backup folder are not the same. A backup folder (opentunes-backup-...) holds only the database
files and no music. An offload folder holds everything: the music and video, the spreadsheets and the database
files, in database/.

Keep this folder private. The files in database/ are the device's own files and include its identity: its serial
number and FireWire ID. Anyone who has them can tell which iPod this was. Do not share it or put it online.

How it was checked: each media file was copied in pieces, then read back from this folder and compared with what
was read from the iPod by size and by CRC-32. Each database file was read back and compared with the original.
Nothing was written to the iPod and nothing was deleted from it. Keep this folder until you have played a few files
from it and tried putting it back.
`;

// ------------------------------------------------------------------ the marker

interface MediaEntry {
  /** Such as "F07/XKQT.mp3". */
  path: string;
  size: number;
  crc32: number;
}

/** What opentunes-offload.json holds. */
export interface OffloadMarker {
  app: 'opentunes';
  kind: 'ipod-offload';
  formatVersion: number;
  createdAt: string;
  /** True when every media file is here and checked and the database files were saved and checked. */
  complete: boolean;
  databaseFolder: string;
  mediaFiles: number;
  mediaBytes: number;
  tracks: number;
  playlists: number;
  media: MediaEntry[];
}

async function readText(folder: { getFileHandle(name: string): Promise<{ getFile(): Promise<{ arrayBuffer(): Promise<ArrayBuffer> }> }> }, name: string): Promise<string | null> {
  try {
    return new TextDecoder().decode(await (await (await folder.getFileHandle(name)).getFile()).arrayBuffer());
  } catch {
    return null;
  }
}

const isFolderName = (value: string): boolean => /^F\d\d$/i.test(value);

/** Reads and checks marker text. Throws an OffloadError that says what is wrong. */
function parseMarker(text: string | null, folderName: string): OffloadMarker {
  if (text === null) throw new OffloadError(`"${folderName}" has no ${OFFLOAD_MARKER}, so it is not an offload folder made by this app.`);
  let parsed: Partial<OffloadMarker> & { media?: unknown };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new OffloadError(`The ${OFFLOAD_MARKER} in "${folderName}" cannot be read.`);
  }
  if (parsed.kind !== 'ipod-offload' || !Array.isArray(parsed.media)) throw new OffloadError(`"${folderName}" is not an iPod offload folder.`);
  if (parsed.formatVersion !== OFFLOAD_FORMAT_VERSION) {
    throw new OffloadError(`"${folderName}" was made in a format (version ${String(parsed.formatVersion)}) that this version of OpenTunes does not know how to read.`);
  }
  const media = (parsed.media as MediaEntry[]).map((entry) => ({ path: String(entry.path), size: Number(entry.size), crc32: Number(entry.crc32) }));
  for (const entry of media) {
    const [folder, name, ...rest] = entry.path.split('/');
    if (!folder || !isFolderName(folder) || !name || name === '.' || name === '..' || rest.length || !Number.isFinite(entry.size) || entry.size < 0 || !Number.isInteger(entry.crc32)) {
      throw new OffloadError(`The ${OFFLOAD_MARKER} lists a file it should not: ${entry.path}`);
    }
  }
  const databaseFolder = String(parsed.databaseFolder ?? '');
  if (!databaseFolder || databaseFolder.includes('/') || databaseFolder === '.' || databaseFolder === '..') throw new OffloadError(`The ${OFFLOAD_MARKER} names a database folder it should not: ${databaseFolder}`);
  return {
    app: 'opentunes',
    kind: 'ipod-offload',
    formatVersion: OFFLOAD_FORMAT_VERSION,
    createdAt: String(parsed.createdAt ?? ''),
    complete: parsed.complete === true,
    databaseFolder,
    mediaFiles: media.length,
    mediaBytes: media.reduce((sum, entry) => sum + entry.size, 0),
    tracks: Number(parsed.tracks ?? 0),
    playlists: Number(parsed.playlists ?? 0),
    media,
  };
}

async function crcOfFile(file: ReadableFile, chunkBytes: number): Promise<number> {
  const read = pieceReader(file);
  let sum = 0;
  for (let start = 0; start < file.size; start += chunkBytes) sum = crc32(await read(start, Math.min(file.size, start + chunkBytes)), sum);
  return sum;
}

/**
 * Copies every media file off the iPod into a new folder inside `destination`. Throws when the
 * iPod has no iPod_Control folder or the destination looks like an iPod. Problems with single files
 * do not stop the rest: they are listed in the report. Stopping through `signal` ends the run
 * cleanly with `stopped` set.
 */
export async function offloadIpod(source: DirectoryEntry, destination: WritableDirectory, newEngine: () => Promise<Engine>, options: OffloadOptions = {}): Promise<OffloadReport> {
  const now = options.now ?? new Date();
  const mount = options.mount ?? '/ipod';
  const concurrency = Math.max(1, options.concurrency ?? OFFLOAD_CONCURRENCY);
  const chunkBytes = Math.max(1, options.chunkBytes ?? OFFLOAD_CHUNK_BYTES);
  const clock = options.clock ?? Date.now;
  const signal = options.signal;

  if (await exists(destination, 'iPod_Control')) {
    throw new OffloadError(`"${destination.name}" holds an iPod_Control folder, so it looks like an iPod. Choose a folder on your computer to copy into.`);
  }

  const send = (progress: OffloadProgress): void => options.onProgress?.(progress);
  const emptyProgress: OffloadProgress = { phase: 'reading', message: '', filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0, bytesPerSecond: 0, current: [], failures: 0 };
  send({ ...emptyProgress, message: 'Reading the iPod...' });

  // A stop before the first file is copied ends the run with an AbortError: nothing was made on the computer yet.
  const { files, folders } = await listMusic(source, signal);
  send({ ...emptyProgress, message: 'Reading the library...' });
  const library = await readLibrary(source, newEngine, mount);
  signal?.throwIfAborted();

  const folder = options.folder
    ? await destination.getDirectoryHandle(options.folder, { create: true })
    : await uniqueFolder(destination, now);

  // Resuming: what an earlier run recorded, so a skipped file keeps its checksum without being read again.
  // The marker is marked unfinished at once, so a stopped run never leaves an old "complete" behind.
  const earlier = new Map<string, MediaEntry>();
  if (options.folder) {
    const text = await readText(folder, OFFLOAD_MARKER);
    try {
      const old = parseMarker(text, folder.name);
      for (const entry of old.media) earlier.set(entry.path, entry);
      await writeBytes(folder, OFFLOAD_MARKER, new TextEncoder().encode(JSON.stringify({ ...old, complete: false }, null, 2)));
    } catch {
      // no usable marker yet, a new one is written at the end
    }
  }

  // The iPod's database and device files, in the backup format, into database/. This is the backup
  // code itself, so it reads the iPod and writes only here. A resumed run saves them again: they are
  // small, and the iPod may have changed since.
  send({ ...emptyProgress, message: 'Saving the iPod\'s library files...' });
  let database: OffloadReport['database'] = null;
  let databaseError: string | null = null;
  try {
    const saved = await backupIpod(source, folder, {
      now,
      folderName: OFFLOAD_DATABASE_FOLDER,
      onProgress: (message) => send({ ...emptyProgress, message: `Saving the iPod's library files. ${message}` }),
    });
    database = { folder: OFFLOAD_DATABASE_FOLDER, files: saved.files, bytes: saved.bytes, complete: saved.complete && saved.verified === saved.files, failures: saved.failures };
  } catch (error) {
    databaseError = `The iPod's library files could not be saved: ${messageOf(error)}`;
  }

  // Every music folder is made first, so three files at once never race to make one.
  for (const name of folders) await folder.getDirectoryHandle(name, { create: true });

  const bytesTotal = files.reduce((sum, file) => sum + file.size, 0);
  const state = new Map<string, FileState>(files.map((file) => [file.path, 'waiting']));
  const crcs = new Map<string, number>();
  const failures: OffloadFailure[] = [];
  const inFlight = new Set<string>();
  let bytesDone = 0;
  let bytesCopied = 0;
  let bytesSkipped = 0;
  let filesDone = 0;
  const startedAt = clock();

  const report = (message: string): void => {
    const seconds = Math.max(0.001, (clock() - startedAt) / 1000);
    send({
      phase: 'copying', message, filesDone, filesTotal: files.length, bytesDone, bytesTotal,
      bytesPerSecond: bytesCopied > 0 ? bytesCopied / seconds : 0, current: [...inFlight], failures: failures.length,
    });
  };

  async function copyOne(file: MusicFile): Promise<void> {
    const target = await folder.getDirectoryHandle(file.folder, { create: true });
    const original = await file.entry.getFile();
    // Resume: a file already here at the right size was copied and checked by an earlier run.
    try {
      const present = (await (await target.getFileHandle(file.name)).getFile()).size;
      if (present === original.size) {
        const kept = earlier.get(file.path);
        crcs.set(file.path, kept && kept.size === present ? kept.crc32 : await crcOfFile(await (await target.getFileHandle(file.name)).getFile() as unknown as ReadableFile, chunkBytes));
        state.set(file.path, 'skipped');
        bytesSkipped += original.size;
        bytesDone += original.size;
        return;
      }
    } catch {
      // not there yet
    }

    const read = pieceReader(original);
    const handle = await target.getFileHandle(file.name, { create: true });
    const writer = (await handle.createWritable()) as { write(data: Uint8Array): Promise<void>; close(): Promise<void>; abort?: () => Promise<void> };
    let sum = 0;
    let finished = false;
    try {
      for (let start = 0; start < original.size; start += chunkBytes) {
        if (signal?.aborted) {
          state.set(file.path, 'stopped');
          return;
        }
        const piece = await read(start, Math.min(original.size, start + chunkBytes));
        if (piece.length === 0) throw new Error(`The iPod gave no data at ${start} bytes, though the file is ${original.size} bytes.`);
        sum = crc32(piece, sum);
        await writer.write(piece);
        bytesCopied += piece.length;
        bytesDone += piece.length;
        report(`Copying ${file.path}`);
      }
      await writer.close();
      finished = true;
    } finally {
      if (!finished) await writer.abort?.().catch(() => undefined);
    }

    // Check the copy: its size, then every byte, read back from the destination.
    const copy = await handle.getFile();
    let problem: string | null = null;
    if (copy.size !== original.size) {
      problem = `The copy is ${copy.size} bytes and the file on the iPod is ${original.size} bytes.`;
    } else {
      const readBack = pieceReader(copy as unknown as ReadableFile);
      let back = 0;
      for (let start = 0; start < copy.size; start += chunkBytes) {
        back = crc32(await readBack(start, Math.min(copy.size, start + chunkBytes)), back);
      }
      if (back !== sum) problem = 'The copy did not match the file on the iPod when it was read back.';
    }
    if (problem) {
      // A bad copy must not be taken for a good one when the run is resumed, and nothing is deleted:
      // it is emptied, so its size no longer matches.
      await writeBytes(target, file.name, new Uint8Array(0)).catch(() => undefined);
      throw new Error(problem);
    }
    crcs.set(file.path, sum);
    state.set(file.path, 'copied');
  }

  const queue = [...files];
  async function worker(): Promise<void> {
    options.pause?.join();
    try {
      for (;;) {
        if (signal?.aborted) return;
        await options.pause?.checkpoint(signal);
        if (signal?.aborted) return;
        const file = queue.shift();
        if (!file) return;
        inFlight.add(file.path);
        report(`Copying ${file.path}`);
        try {
          await copyOne(file);
        } catch (error) {
          state.set(file.path, 'failed');
          failures.push({ path: file.path, reason: messageOf(error) });
        } finally {
          inFlight.delete(file.path);
          if (state.get(file.path) !== 'stopped') filesDone += 1;
          report(`Copying ${file.path}`);
        }
      }
    } finally {
      options.pause?.leave();
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, files.length)) }, () => worker()));

  const stopped = Boolean(signal?.aborted) && files.some((file) => state.get(file.path) === 'stopped' || state.get(file.path) === 'waiting');
  const count = (wanted: FileState[]): number => files.filter((file) => wanted.includes(state.get(file.path) as FileState)).length;

  // Which tracks have a file, and which do not.
  const byLowerPath = new Map(files.map((file) => [file.path.toLowerCase(), file]));
  const musicPathOf = (track: TrackInfo): string | null => {
    const full = mediaPathOf(track.ipod_path);
    return full ? full.slice('iPod_Control/Music/'.length) : null;
  };
  const fileOf = (track: TrackInfo): MusicFile | null => {
    const path = musicPathOf(track);
    return path ? (byLowerPath.get(path.toLowerCase()) ?? null) : null;
  };
  const pathOf = (track: TrackInfo): string => fileOf(track)?.path ?? musicPathOf(track) ?? '';
  const statusOf = (track: TrackInfo): TrackStatus => {
    if (!musicPathOf(track)) return 'no file in the music folders';
    const file = fileOf(track);
    if (!file) return 'missing on the iPod';
    const result = state.get(file.path);
    return result === 'copied' ? 'copied' : result === 'skipped' ? 'already there' : result === 'failed' ? 'failed' : 'not copied';
  };

  const missing: MissingTrack[] = library.tracks
    .filter((track) => track.ipod_path && (statusOf(track) === 'missing on the iPod' || statusOf(track) === 'no file in the music folders'))
    .map((track) => ({ path: track.ipod_path as string, title: track.title, artist: track.artist }));
  const listed = new Set(library.tracks.map((track) => fileOf(track)?.path).filter((path): path is string => Boolean(path)));
  const unlisted = library.error ? [] : files.filter((file) => !listed.has(file.path)).map((file) => file.path);

  const result: OffloadReport = {
    folder: folder.name,
    complete: false,
    stopped,
    files: { total: files.length, copied: count(['copied']), skipped: count(['skipped']), failed: count(['failed']), notCopied: count(['stopped', 'waiting']) },
    bytes: { total: bytesTotal, copied: bytesCopied, skipped: bytesSkipped },
    failures,
    missing,
    unlisted,
    tracks: library.tracks.length,
    playlists: library.playlists.length,
    libraryError: library.error,
    notesError: null,
    database,
    databaseError,
    elapsedMs: clock() - startedAt,
    bytesPerSecond: bytesCopied > 0 ? bytesCopied / Math.max(0.001, (clock() - startedAt) / 1000) : 0,
  };
  const mediaComplete = !stopped && failures.length === 0;
  result.complete = mediaComplete && library.error === null && database?.complete === true;

  send({ ...emptyProgress, phase: 'finishing', message: `Writing library.csv, playlists.csv, README.txt and ${OFFLOAD_MARKER}...`, filesDone, filesTotal: files.length, bytesDone, bytesTotal, failures: failures.length });
  try {
    if (!library.error) {
      await writeBytes(folder, 'library.csv', new TextEncoder().encode(libraryCsv(library.tracks, library.playlists, pathOf, statusOf)));
      await writeBytes(folder, 'playlists.csv', new TextEncoder().encode(playlistsCsv(library.tracks, library.playlists, pathOf)));
    }
    await writeBytes(folder, 'README.txt', new TextEncoder().encode(README(now.toISOString(), result)));
    const media: MediaEntry[] = files
      .filter((file) => (state.get(file.path) === 'copied' || state.get(file.path) === 'skipped') && crcs.has(file.path))
      .map((file) => ({ path: file.path, size: file.size, crc32: crcs.get(file.path) as number }));
    const marker: OffloadMarker = {
      app: 'opentunes', kind: 'ipod-offload', formatVersion: OFFLOAD_FORMAT_VERSION, createdAt: now.toISOString(),
      complete: mediaComplete && database?.complete === true, databaseFolder: OFFLOAD_DATABASE_FOLDER,
      mediaFiles: media.length, mediaBytes: media.reduce((sum, entry) => sum + entry.size, 0),
      tracks: library.tracks.length, playlists: library.playlists.length, media,
    };
    await writeBytes(folder, OFFLOAD_MARKER, new TextEncoder().encode(JSON.stringify(marker, null, 2)));
  } catch (error) {
    result.notesError = `The spreadsheets, README or marker could not be written: ${messageOf(error)}`;
    result.complete = false;
  }
  return result;
}

// -------------------------------------------------------------------- restoring everything

/** An offload folder, opened for reading. */
export type OffloadSource = BackupSource;

export interface OffloadSummary {
  createdAt: string;
  /** False when the copy was stopped or had failures, or its database files were not saved. It is then not used to restore. */
  complete: boolean;
  mediaFiles: number;
  mediaBytes: number;
  tracks: number;
  playlists: number;
  databaseFiles: number;
  databaseBytes: number;
  /** Set only when the iPod was passed: media files already on it at the right size, and what is left to copy back. */
  onIpod?: { alreadyThere: number; toCopy: number; bytesToCopy: number };
}

/** Plans which media files the iPod lacks, by looking at what is there. Nothing is read from the files themselves. */
async function planMissing(root: IpodRoot, media: MediaEntry[]): Promise<{ alreadyThere: MediaEntry[]; toCopy: MediaEntry[] }> {
  const alreadyThere: MediaEntry[] = [];
  const toCopy: MediaEntry[] = [];
  const folders = new Map<string, IpodRoot | null>();
  for (const entry of media) {
    const [folderName, name] = entry.path.split('/') as [string, string];
    if (!folders.has(folderName)) folders.set(folderName, await folderAt(root, ['iPod_Control', 'Music', folderName], false));
    let size = -1;
    try {
      size = (await (await (folders.get(folderName) as IpodRoot).getFileHandle(name)).getFile()).size;
    } catch {
      size = -1;
    }
    (size === entry.size ? alreadyThere : toCopy).push(entry);
  }
  return { alreadyThere, toCopy };
}

async function openDatabaseFolder(offload: OffloadSource, marker: OffloadMarker): Promise<BackupSource> {
  try {
    return await offload.getDirectoryHandle(marker.databaseFolder);
  } catch {
    throw new OffloadError(`"${offload.name}" has no ${marker.databaseFolder} folder with the iPod's library files, so it cannot put the iPod back.`);
  }
}

/**
 * What an offload folder holds, for showing before it is used. Throws if it is not a usable
 * offload folder. With `root` (the iPod) it also counts how many media files are already there.
 * Reads only the marker and the database manifest.
 */
export async function describeOffload(offload: OffloadSource, root?: IpodRoot): Promise<OffloadSummary> {
  const marker = parseMarker(await readText(offload, OFFLOAD_MARKER), offload.name);
  const database = await describeBackup(await openDatabaseFolder(offload, marker));
  const summary: OffloadSummary = {
    createdAt: marker.createdAt, complete: marker.complete, mediaFiles: marker.mediaFiles, mediaBytes: marker.mediaBytes,
    tracks: marker.tracks, playlists: marker.playlists, databaseFiles: database.files, databaseBytes: database.bytes,
  };
  if (root) {
    const { alreadyThere, toCopy } = await planMissing(root, marker.media);
    summary.onIpod = { alreadyThere: alreadyThere.length, toCopy: toCopy.length, bytesToCopy: toCopy.reduce((sum, entry) => sum + entry.size, 0) };
  }
  return summary;
}

export interface RestoreOffloadOptions {
  /** To read the iPod back after the database is restored, and check its signatures. */
  newEngine?: () => Promise<Engine>;
  mount?: string;
  signal?: AbortSignal;
  /** Lets the person pause between files. Files already being copied are finished first. The database restore is not paused. */
  pause?: PauseGate;
  /** Files and bytes are of the files that have to be copied back, so a time left can be worked out. */
  onProgress?: (progress: OffloadProgress) => void;
  /** Files at once. Defaults to 3. */
  concurrency?: number;
  /** Piece size. Defaults to 4 MiB. */
  chunkBytes?: number;
  clock?: () => number;
}

export interface RestoreOffloadReport {
  stopped: boolean;
  /** Counts of the media files the offload folder lists. `notCopied` were not reached because of a stop or a failure elsewhere. */
  files: { total: number; copied: number; alreadyThere: number; failed: number; notCopied: number };
  bytes: { copied: number; alreadyThere: number };
  failures: OffloadFailure[];
  /** The database restore, or null when it was not started (a stop, or a media file that could not be copied back). */
  database: RestoreReport | null;
  /** True when every media file is on the iPod and the database was restored, read back and verified. */
  complete: boolean;
  /** What happened, in plain words. */
  summary: string;
  elapsedMs: number;
  bytesPerSecond: number;
}

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

function sayWhatHappened(report: RestoreOffloadReport): string {
  const parts: string[] = [];
  const { copied, alreadyThere, failed, notCopied } = report.files;
  parts.push(`${plural(copied, 'file was', 'files were')} copied back to the iPod`);
  parts.push(`${plural(alreadyThere, 'file was', 'files were')} already there and left alone`);
  if (failed) parts.push(`${plural(failed, 'file', 'files')} could not be copied back`);
  if (report.stopped) parts.push(`it was stopped, with ${plural(notCopied, 'file', 'files')} not reached`);
  else if (notCopied) parts.push(`${plural(notCopied, 'file was', 'files were')} not reached`);
  let text = `${parts.join(', ')}.`;
  if (report.database === null) text += " The iPod's library was not changed.";
  else if (report.complete) text += ' The saved library was put back, read back and checked.';
  else text += ' The saved library was put back but did not check out cleanly.';
  return text;
}

/**
 * Puts everything in an offload folder back on the iPod: first every media file the iPod lacks or
 * has at a different size, then the database files.
 *
 * Nothing is written until the database files in the folder have been checked against their
 * checksums. A media file already on the iPod with the right size is not touched, and nothing is
 * deleted. Each file copied back is checked before it is written (the copy in the offload folder
 * against the CRC-32 kept when it was offloaded) and read back from the iPod afterwards. The
 * database is restored only when every media file is in place, so the library never lists a file
 * that is not there; one failure leaves the database as it was. Stopping through `signal` works
 * between and inside files, but not once the database restore has started.
 *
 * Throws, before writing anything, when the folder is not a complete offload folder or its database
 * files do not check out. The caller must have a complete backup of the iPod's current state.
 */
export async function restoreOffload(root: IpodRoot, offload: OffloadSource, options: RestoreOffloadOptions = {}): Promise<RestoreOffloadReport> {
  const concurrency = Math.max(1, options.concurrency ?? OFFLOAD_CONCURRENCY);
  const chunkBytes = Math.max(1, options.chunkBytes ?? OFFLOAD_CHUNK_BYTES);
  const clock = options.clock ?? Date.now;
  const signal = options.signal;
  const send = (progress: OffloadProgress): void => options.onProgress?.(progress);
  const empty: OffloadProgress = { phase: 'checking', message: '', filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0, bytesPerSecond: 0, current: [], failures: 0 };

  // (a) Everything that can be checked without writing, is checked first.
  send({ ...empty, message: 'Checking the offload folder...' });
  const marker = parseMarker(await readText(offload, OFFLOAD_MARKER), offload.name);
  if (!marker.complete) {
    throw new OffloadError(`The copy in "${offload.name}" was not complete (it was stopped, a file failed, or the library files were not saved), so it is not used to put an iPod back. Run the offload again into this same folder to finish it.`);
  }
  const database = await openDatabaseFolder(offload, marker);
  send({ ...empty, message: 'Checking the library files in the offload folder...' });
  await checkBackup(database);

  const { alreadyThere, toCopy } = await planMissing(root, marker.media);
  const bytesTotal = toCopy.reduce((sum, entry) => sum + entry.size, 0);
  const startedAt = clock();
  const failures: OffloadFailure[] = [];
  const done = new Set<string>();
  const inFlight = new Set<string>();
  let filesDone = 0;
  let bytesDone = 0;
  let bytesCopied = 0;

  const speed = (): number => (bytesCopied > 0 ? bytesCopied / Math.max(0.001, (clock() - startedAt) / 1000) : 0);
  const report = (message: string): void =>
    send({ phase: 'copying', message, filesDone, filesTotal: toCopy.length, bytesDone, bytesTotal, bytesPerSecond: speed(), current: [...inFlight], failures: failures.length });

  // (b) Media files, three at a time. Every Fxx folder is made first so files never race to make one.
  for (const folderName of new Set(toCopy.map((entry) => entry.path.split('/')[0] as string))) {
    if (!(await folderAt(root, ['iPod_Control', 'Music', folderName], true))) throw new OffloadError(`The folder iPod_Control/Music/${folderName} could not be made on the iPod, so nothing was written.`);
  }
  report(toCopy.length ? 'Copying files back to the iPod...' : 'Every media file is already on the iPod.');

  async function copyBack(entry: MediaEntry): Promise<'copied' | 'stopped'> {
    const [folderName, name] = entry.path.split('/') as [string, string];
    let source: ReadableFile;
    try {
      const folder = await offload.getDirectoryHandle(folderName);
      source = (await (await folder.getFileHandle(name)).getFile()) as unknown as ReadableFile;
    } catch {
      throw new Error('It is not in the offload folder.');
    }
    if (source.size !== entry.size) throw new Error(`It is ${source.size} bytes in the offload folder and should be ${entry.size}, so it was not copied.`);
    // The offload folder's copy must still be the one that was checked, before anything is written for it.
    if ((await crcOfFile(source, chunkBytes)) !== entry.crc32) throw new Error('The copy in the offload folder does not match its checksum, so it was not copied.');
    if (signal?.aborted) return 'stopped';

    const folder = await folderAt(root, ['iPod_Control', 'Music', folderName], true);
    if (!folder) throw new Error('The folder could not be made on the iPod.');
    const handle = await folder.getFileHandle(name, { create: true });
    const writer = (await handle.createWritable()) as { write(data: Uint8Array): Promise<void>; close(): Promise<void>; abort?: () => Promise<void> };
    const read = pieceReader(source);
    let finished = false;
    try {
      for (let start = 0; start < entry.size; start += chunkBytes) {
        if (signal?.aborted) return 'stopped';
        const piece = await read(start, Math.min(entry.size, start + chunkBytes));
        if (piece.length === 0) throw new Error(`The offload folder gave no data at ${start} bytes, though the file is ${entry.size} bytes.`);
        await writer.write(piece);
        bytesCopied += piece.length;
        bytesDone += piece.length;
        report(`Copying ${entry.path}`);
      }
      await writer.close();
      finished = true;
    } finally {
      if (!finished) await writer.abort?.().catch(() => undefined);
    }

    // Read it back from the iPod: its size, then every byte against the kept CRC-32.
    const copy = (await handle.getFile()) as unknown as ReadableFile;
    let problem: string | null = null;
    if (copy.size !== entry.size) problem = `On the iPod it is ${copy.size} bytes and should be ${entry.size}.`;
    else if ((await crcOfFile(copy, chunkBytes)) !== entry.crc32) problem = 'It did not match its checksum when it was read back from the iPod.';
    if (problem) {
      // A bad copy must not be taken for a good one by a second run: it is emptied, so its size no longer matches.
      await writeBytes(folder as unknown as WritableDirectory, name, new Uint8Array(0)).catch(() => undefined);
      throw new Error(problem);
    }
    return 'copied';
  }

  const queue = [...toCopy];
  async function worker(): Promise<void> {
    options.pause?.join();
    try {
      for (;;) {
        if (signal?.aborted) return;
        // A pause waits between files, never inside one.
        await options.pause?.checkpoint(signal);
        if (signal?.aborted) return;
        const entry = queue.shift();
        if (!entry) return;
        inFlight.add(entry.path);
        report(`Copying ${entry.path}`);
        let outcome: 'copied' | 'stopped' | 'failed' = 'failed';
        try {
          outcome = await copyBack(entry);
          if (outcome === 'copied') done.add(entry.path);
        } catch (error) {
          failures.push({ path: entry.path, reason: messageOf(error) });
        } finally {
          inFlight.delete(entry.path);
          if (outcome !== 'stopped') filesDone += 1;
          report(`Copying ${entry.path}`);
        }
      }
    } finally {
      options.pause?.leave();
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, toCopy.length)) }, () => worker()));

  const stopped = Boolean(signal?.aborted) && done.size + failures.length < toCopy.length;
  const result: RestoreOffloadReport = {
    stopped,
    files: { total: marker.mediaFiles, copied: done.size, alreadyThere: alreadyThere.length, failed: failures.length, notCopied: toCopy.length - done.size - failures.length },
    bytes: { copied: bytesCopied, alreadyThere: alreadyThere.reduce((sum, entry) => sum + entry.size, 0) },
    failures,
    database: null,
    complete: false,
    summary: '',
    elapsedMs: clock() - startedAt,
    bytesPerSecond: speed(),
  };

  // (c) The database only when every media file is in place, and not after a stop.
  if (!stopped && failures.length === 0) {
    send({ ...empty, phase: 'restoring', message: 'Putting the saved library back...', filesDone, filesTotal: toCopy.length, bytesDone, bytesTotal, bytesPerSecond: speed() });
    result.database = await restoreBackup(root, database, {
      newEngine: options.newEngine,
      mount: options.mount,
      onProgress: (message) => send({ ...empty, phase: 'restoring', message, filesDone, filesTotal: toCopy.length, bytesDone, bytesTotal, bytesPerSecond: speed() }),
    });
    result.complete = result.database.verified;
  }
  result.elapsedMs = clock() - startedAt;
  result.summary = sayWhatHappened(result);
  return result;
}

/** True when the folder holds an offload marker, so a page can tell an offload folder from a backup folder. */
export async function isOffloadFolder(folder: OffloadSource): Promise<boolean> {
  return (await readText(folder, OFFLOAD_MARKER)) !== null;
}
