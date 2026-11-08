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
 */

import type { Engine, PlaylistInfo, TrackInfo } from './engine.ts';
import { IpodFolderError, isClutter, loadIpodFolder, type DirectoryEntry } from './folder.ts';
import type { WritableDirectory } from './backup.ts';
import { mediaPathOf } from './sync.ts';

export class OffloadError extends Error {}

export const OFFLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
export const OFFLOAD_CONCURRENCY = 3;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

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

async function listMusic(source: DirectoryEntry): Promise<{ files: MusicFile[]; folders: string[] }> {
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

export type OffloadPhase = 'reading' | 'copying' | 'finishing';

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
  elapsedMs: number;
  bytesPerSecond: number;
}

type FileState = 'copied' | 'skipped' | 'failed' | 'stopped' | 'waiting';

const README = (when: string, report: OffloadReport): string => `This folder is a copy of everything on an iPod's music folders, made by OpenTunes on ${when}.

State of this copy: ${report.complete ? 'complete' : report.stopped ? 'stopped before the end. Run the copy again into this same folder to finish it' : 'not complete, see the notes in the app'}.
Files: ${report.files.copied + report.files.skipped} of ${report.files.total} are here${report.files.failed ? `, ${report.files.failed} failed` : ''}.

What is in it
  F00, F01 ... F49   The iPod's own music folders, copied byte for byte. An iPod gives every file a short
                     random name (for example F07/XKQT.mp3), so the names mean nothing. The real titles
                     are in library.csv. The files are the original MP3, AAC, M4A, M4B, M4V and so on, and
                     play in any player. Files bought with copy protection (.m4p) are copied as they are
                     and may not play outside iTunes.
  library.csv        One row per track: Path (the file in this folder), Title, Artist, Album, Album artist,
                     Genre, Kind, Year, Track number, Disc, Length (seconds), Size (bytes), Bitrate (kbps),
                     Rating (0-100, 20 per star), Play count, Date added (UTC), Playlists (names joined with
                     " | ") and File (what happened to the file: copied, already there, missing on the iPod,
                     failed or not copied).
  playlists.csv      One row per entry of each playlist: Playlist, Position and Path. The list that holds
                     everything is left out.
  README.txt         This file.

Opening the CSV files: they are UTF-8 with a byte order mark, so Excel, Numbers and Google Sheets show accents
and other scripts correctly. Fields with commas, quotes or line breaks are in quotes.

How it was checked: each file was copied in pieces, then read back from this folder and compared with what was
read from the iPod by size and by CRC-32. Nothing was written to the iPod and nothing was deleted from it.
Keep this folder until you have played a few files from it.
`;

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

  const { files, folders } = await listMusic(source);
  send({ ...emptyProgress, message: 'Reading the library...' });
  const library = await readLibrary(source, newEngine, mount);

  const folder = options.folder
    ? await destination.getDirectoryHandle(options.folder, { create: true })
    : await uniqueFolder(destination, now);

  // Every music folder is made first, so three files at once never race to make one.
  for (const name of folders) await folder.getDirectoryHandle(name, { create: true });

  const bytesTotal = files.reduce((sum, file) => sum + file.size, 0);
  const state = new Map<string, FileState>(files.map((file) => [file.path, 'waiting']));
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
    state.set(file.path, 'copied');
  }

  const queue = [...files];
  async function worker(): Promise<void> {
    for (;;) {
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
    elapsedMs: clock() - startedAt,
    bytesPerSecond: bytesCopied > 0 ? bytesCopied / Math.max(0.001, (clock() - startedAt) / 1000) : 0,
  };
  result.complete = !stopped && failures.length === 0 && library.error === null;

  send({ ...emptyProgress, phase: 'finishing', message: 'Writing library.csv, playlists.csv and README.txt...', filesDone, filesTotal: files.length, bytesDone, bytesTotal, failures: failures.length });
  try {
    if (!library.error) {
      await writeBytes(folder, 'library.csv', new TextEncoder().encode(libraryCsv(library.tracks, library.playlists, pathOf, statusOf)));
      await writeBytes(folder, 'playlists.csv', new TextEncoder().encode(playlistsCsv(library.tracks, library.playlists, pathOf)));
    }
    await writeBytes(folder, 'README.txt', new TextEncoder().encode(README(now.toISOString(), result)));
  } catch (error) {
    result.notesError = `The spreadsheets or README could not be written: ${messageOf(error)}`;
    result.complete = false;
  }
  return result;
}
