/**
 * Copies the database files of an iPod into the engine's in-memory folder.
 *
 * The engine works on its own copy of the iPod, not on the real device. For reading, what
 * it needs is small: the databases in iPod_Control/iTunes and the device files in
 * iPod_Control/Device. The music itself stays where it is. The Music/F00 to F49 folders
 * are recreated empty, because libgpod counts them when it picks a place for a new file.
 *
 * Nothing here writes to the iPod. The interfaces below are the small part of the browser's
 * File System Access API this needs, so tests can supply a stand-in.
 */

import type { Engine } from './engine.ts';

export class IpodFolderError extends Error {}

export interface FileLike {
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface FileEntry {
  kind: 'file';
  name: string;
  getFile(): Promise<FileLike>;
}

export interface DirectoryEntry {
  kind: 'directory';
  name: string;
  entries(): AsyncIterable<[string, DirectoryEntry | FileEntry]>;
  getDirectoryHandle(name: string): Promise<DirectoryEntry>;
}

export interface LoadOptions {
  /** Where the iPod appears inside the engine. */
  mount?: string;
  /** Stop if the database files add up to more than this. */
  maxBytes?: number;
  onProgress?: (message: string) => void;
}

/** A file that was read, with its path from the top of the iPod. */
export interface ListedFile {
  path: string;
  size: number;
}

export interface LoadReport {
  mount: string;
  files: number;
  bytes: number;
  /** Every database file read, so a failure can be diagnosed from what the iPod really holds. */
  listing: ListedFile[];
  /** Music/Fxx folders found on the iPod. */
  musicFolders: string[];
  /** Files left out because they are only clutter, such as macOS "._" files. */
  skipped: string[];
  /** False when iPod_Control exists but has no iTunes folder, so no database to read. */
  hasDatabaseFolder: boolean;
}

const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;

/** Files that appear on a FAT volume mounted by macOS or Windows and mean nothing to an iPod. */
const isClutter = (name: string): boolean => name.startsWith('._') || name === '.DS_Store' || name === 'Thumbs.db';

function makeDirectories(fs: Engine['fs'], path: string): void {
  let current = '';
  for (const part of path.split('/').filter(Boolean)) {
    current += `/${part}`;
    if (!fs.analyzePath(current).exists) {
      fs.mkdir(current);
    }
  }
}

async function findDirectory(parent: DirectoryEntry, name: string): Promise<DirectoryEntry | null> {
  try {
    return await parent.getDirectoryHandle(name);
  } catch {
    return null;
  }
}

interface Totals {
  files: number;
  bytes: number;
  skipped: string[];
  listing: ListedFile[];
}

async function copyDirectory(
  source: DirectoryEntry,
  fs: Engine['fs'],
  target: string,
  totals: Totals,
  options: Required<Pick<LoadOptions, 'maxBytes'>> & Pick<LoadOptions, 'onProgress'>,
): Promise<void> {
  makeDirectories(fs, target);
  for await (const [name, entry] of source.entries()) {
    const path = `${target}/${name}`;
    if (isClutter(name)) {
      totals.skipped.push(path);
    } else if (entry.kind === 'directory') {
      await copyDirectory(entry, fs, path, totals, options);
    } else {
      const file = await entry.getFile();
      totals.bytes += file.size;
      if (totals.bytes > options.maxBytes) {
        throw new IpodFolderError(
          `The database files add up to more than ${Math.round(options.maxBytes / 1024 / 1024)} MB, which is more than the engine will load.`,
        );
      }
      fs.writeFile(path, new Uint8Array(await file.arrayBuffer()));
      totals.files += 1;
      totals.listing.push({ path, size: file.size });
      options.onProgress?.(`Read ${name}`);
    }
  }
}

/** Reads an iPod's database files. `root` is the iPod's top folder, the one holding iPod_Control. */
export async function loadIpodFolder(root: DirectoryEntry, engine: Engine, options: LoadOptions = {}): Promise<LoadReport> {
  const mount = options.mount ?? '/ipod';
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const { fs } = engine;

  const control = await findDirectory(root, 'iPod_Control');
  if (!control) {
    throw new IpodFolderError(
      `"${root.name}" has no iPod_Control folder. Choose the top folder of the iPod itself, the one that contains iPod_Control.`,
    );
  }

  const totals: Totals = { files: 0, bytes: 0, skipped: [], listing: [] };
  const copyOptions = { maxBytes, onProgress: options.onProgress };
  makeDirectories(fs, `${mount}/iPod_Control`);

  const iTunes = await findDirectory(control, 'iTunes');
  if (iTunes) {
    await copyDirectory(iTunes, fs, `${mount}/iPod_Control/iTunes`, totals, copyOptions);
  }
  const device = await findDirectory(control, 'Device');
  if (device) {
    await copyDirectory(device, fs, `${mount}/iPod_Control/Device`, totals, copyOptions);
  }

  const musicFolders: string[] = [];
  const music = await findDirectory(control, 'Music');
  if (music) {
    for await (const [name, entry] of music.entries()) {
      if (entry.kind === 'directory' && /^F\d\d$/i.test(name)) {
        makeDirectories(fs, `${mount}/iPod_Control/Music/${name}`);
        musicFolders.push(name);
      }
    }
    musicFolders.sort();
  }

  return {
    mount,
    files: totals.files,
    bytes: totals.bytes,
    listing: totals.listing.map(({ path, size }) => ({ path: path.slice(mount.length + 1), size })),
    musicFolders,
    skipped: totals.skipped,
    hasDatabaseFolder: iTunes !== null,
  };
}

export interface LayoutEntry {
  /** Path from the folder it was listed in, for example "iTunes Library.itlp/Library.itdb". */
  path: string;
  kind: 'file' | 'directory';
  size?: number;
}

export interface IpodLayout {
  /** What is at the top of the volume. Names only. */
  root: LayoutEntry[];
  /** iPod_Control, or null if there is none. */
  control: LayoutEntry[] | null;
  /** iPod_Control/iTunes, two levels deep, or null if there is none. */
  iTunes: LayoutEntry[] | null;
  /** iPod_Control/Device, or null if there is none. */
  device: LayoutEntry[] | null;
  /** How many Music/Fxx folders there are, or null if there is no Music folder. */
  musicFolders: number | null;
}

async function listEntries(directory: DirectoryEntry, prefix: string, depth: number, limit: number, into: LayoutEntry[]): Promise<void> {
  for await (const [name, entry] of directory.entries()) {
    if (into.length >= limit) return;
    if (entry.kind === 'directory') {
      into.push({ path: `${prefix}${name}`, kind: 'directory' });
      if (depth > 0) await listEntries(entry, `${prefix}${name}/`, depth - 1, limit, into);
    } else {
      let size: number | undefined;
      try {
        size = (await entry.getFile()).size;
      } catch {
        size = undefined;
      }
      into.push({ path: `${prefix}${name}`, kind: 'file', size });
    }
  }
}

/**
 * What is where on an iPod, without reading any file's contents. For finding out why a
 * database will not open, and for learning what a model really stores.
 */
export async function describeIpodLayout(root: DirectoryEntry, limit = 80): Promise<IpodLayout> {
  const rootEntries: LayoutEntry[] = [];
  for await (const [name, entry] of root.entries()) {
    if (rootEntries.length >= limit) break;
    rootEntries.push({ path: name, kind: entry.kind });
  }

  const control = await findDirectory(root, 'iPod_Control');
  const section = async (name: string, depth: number): Promise<LayoutEntry[] | null> => {
    const directory = control ? await findDirectory(control, name) : null;
    if (!directory) return null;
    const entries: LayoutEntry[] = [];
    await listEntries(directory, '', depth, limit, entries);
    return entries;
  };

  let controlEntries: LayoutEntry[] | null = null;
  if (control) {
    controlEntries = [];
    await listEntries(control, '', 0, limit, controlEntries);
  }

  const music = control ? await findDirectory(control, 'Music') : null;
  let musicFolders: number | null = null;
  if (music) {
    musicFolders = 0;
    for await (const [name, entry] of music.entries()) {
      if (entry.kind === 'directory' && /^F\d\d$/i.test(name)) musicFolders += 1;
    }
  }

  return { root: rootEntries, control: controlEntries, iTunes: await section('iTunes', 2), device: await section('Device', 1), musicFolders };
}
