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

export interface LoadReport {
  mount: string;
  files: number;
  bytes: number;
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

  const totals: Totals = { files: 0, bytes: 0, skipped: [] };
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

  return { mount, files: totals.files, bytes: totals.bytes, musicFolders, skipped: totals.skipped, hasDatabaseFolder: iTunes !== null };
}
