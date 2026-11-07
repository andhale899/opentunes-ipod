/**
 * Copies an iPod's database files to a folder on the computer, and checks the copy.
 *
 * The files are the ones a sync can change: everything in iPod_Control/iTunes (the library),
 * iPod_Control/Device (the iPod's description files) and iPod_Control/Artwork, plus the files
 * directly inside iPod_Control. No music. Each file is read back from the copy and compared
 * with the original, and a manifest with every file's SHA-256 is written beside them so the
 * backup can be checked again later.
 *
 * Reads the iPod and writes only to the destination. A destination that holds an iPod_Control
 * folder is refused, because that is an iPod and not somewhere to keep a backup.
 */

import { IpodFolderError, isClutter, isNotNeeded, type DirectoryEntry, type FileEntry, type FileLike } from './folder.ts';

export class BackupError extends Error {}

export interface WritableFile {
  createWritable(): Promise<{ write(data: Uint8Array): Promise<void>; close(): Promise<void> }>;
  getFile(): Promise<FileLike>;
}

export interface WritableDirectory {
  name: string;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<WritableDirectory>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<WritableFile>;
}

export interface BackupOptions {
  /** Used for the folder name. Defaults to now. */
  now?: Date;
  /** A file bigger than this is not copied and the backup is reported as incomplete. */
  maxFileBytes?: number;
  onProgress?: (message: string) => void;
}

export interface LeftOut {
  path: string;
  size: number;
  reason: 'not needed' | 'too large';
}

export interface BackupReport {
  /** The new folder, made inside the one that was chosen. */
  folder: string;
  files: number;
  bytes: number;
  /** Files read back from the copy and found identical to the original. */
  verified: number;
  /** What went wrong, one sentence each. Empty when nothing did. */
  failures: string[];
  /** Files that were not copied, and why. */
  left: LeftOut[];
  /** True when every file that belongs in the backup is there and was read back identical. */
  complete: boolean;
}

const DEFAULT_MAX_FILE_BYTES = 256 * 1024 * 1024;
/** The folders of iPod_Control that are backed up. Music and Speakable are not. */
const BACKED_UP_FOLDERS = ['iTunes', 'Device', 'Artwork'];

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

interface Planned {
  path: string;
  file: FileEntry;
  size: number;
}

async function findDirectory(parent: DirectoryEntry, name: string): Promise<DirectoryEntry | null> {
  try {
    return await parent.getDirectoryHandle(name);
  } catch {
    return null;
  }
}

async function collect(directory: DirectoryEntry, prefix: string, plan: Planned[], left: LeftOut[], maxFileBytes: number): Promise<void> {
  for await (const [name, entry] of directory.entries()) {
    if (isClutter(name)) continue;
    const path = `${prefix}${name}`;
    if (entry.kind === 'directory') {
      await collect(entry, `${path}/`, plan, left, maxFileBytes);
      continue;
    }
    const size = (await entry.getFile()).size;
    if (isNotNeeded(path.slice('iPod_Control/'.length))) left.push({ path, size, reason: 'not needed' });
    else if (size > maxFileBytes) left.push({ path, size, reason: 'too large' });
    else plan.push({ path, file: entry, size });
  }
}

async function planBackup(control: DirectoryEntry, maxFileBytes: number): Promise<{ plan: Planned[]; left: LeftOut[] }> {
  const plan: Planned[] = [];
  const left: LeftOut[] = [];
  for await (const [name, entry] of control.entries()) {
    if (isClutter(name)) continue;
    if (entry.kind === 'file') {
      const size = (await entry.getFile()).size;
      if (size > maxFileBytes) left.push({ path: `iPod_Control/${name}`, size, reason: 'too large' });
      else plan.push({ path: `iPod_Control/${name}`, file: entry, size });
    } else if (BACKED_UP_FOLDERS.includes(name)) {
      await collect(entry, `iPod_Control/${name}/`, plan, left, maxFileBytes);
    }
  }
  return { plan, left };
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
  const base = `opentunes-backup-${stamp(now)}`;
  let name = base;
  for (let n = 2; await exists(destination, name); n += 1) name = `${base}-${n}`;
  return destination.getDirectoryHandle(name, { create: true });
}

async function directoryFor(root: WritableDirectory, path: string): Promise<WritableDirectory> {
  let current = root;
  for (const part of path.split('/').slice(0, -1)) current = await current.getDirectoryHandle(part, { create: true });
  return current;
}

async function sha256(bytes: Uint8Array): Promise<string | null> {
  if (!globalThis.crypto?.subtle) return null;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((value, index) => value === b[index]);

async function writeText(folder: WritableDirectory, name: string, text: string): Promise<void> {
  const writer = await (await folder.getFileHandle(name, { create: true })).createWritable();
  await writer.write(new TextEncoder().encode(text));
  await writer.close();
}

const README = (createdAt: string): string => `This is a backup of the database files on an iPod, made by OpenTunes on ${createdAt}.

It holds copies of these folders from the iPod's iPod_Control folder: iTunes (the library), Device (the iPod's description files) and Artwork, plus the files directly inside iPod_Control. It holds no music.

backup-info.json lists every file with its size and SHA-256, so the copy can be checked again later.

To put it back, copy the files over the ones on the iPod and keep everything else.

macOS or Linux, in a terminal, with the iPod connected:

  cp -R "<this folder>/iPod_Control/." "/Volumes/<the iPod's name>/iPod_Control/"

Windows, in a command prompt:

  xcopy "<this folder>\\iPod_Control" "<the iPod's drive>:\\iPod_Control\\" /E /Y /I

Do not drag the iPod_Control folder onto the one on the iPod and choose Replace. That removes the iPod's music folder. Eject the iPod normally afterwards.
`;

/**
 * Backs up `source`, the iPod's top folder, into a new folder inside `destination`.
 * Throws if there is nothing to back up or the destination looks like an iPod. Problems with
 * single files do not stop the rest: they are listed in the report, which then says the
 * backup is not complete.
 */
export async function backupIpod(source: DirectoryEntry, destination: WritableDirectory, options: BackupOptions = {}): Promise<BackupReport> {
  const now = options.now ?? new Date();
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;

  const control = await findDirectory(source, 'iPod_Control');
  if (!control) {
    throw new IpodFolderError(`"${source.name}" has no iPod_Control folder. Choose the top folder of the iPod itself, the one that contains iPod_Control.`);
  }
  if (await exists(destination, 'iPod_Control')) {
    throw new BackupError(`"${destination.name}" holds an iPod_Control folder, so it looks like an iPod. Choose a folder on your computer to keep the backup in.`);
  }

  const { plan, left } = await planBackup(control, maxFileBytes);
  if (plan.length === 0) throw new BackupError(`There are no database files on "${source.name}" to back up.`);

  const folder = await uniqueFolder(destination, now);
  const failures: string[] = [];
  const manifest: { path: string; size: number; sha256: string | null }[] = [];
  let bytes = 0;
  let verified = 0;

  for (const item of plan) {
    options.onProgress?.(`Copying ${item.path}`);
    try {
      const original = new Uint8Array(await (await item.file.getFile()).arrayBuffer());
      const target = await (await directoryFor(folder, item.path)).getFileHandle(item.path.split('/').pop() as string, { create: true });
      const writer = await target.createWritable();
      await writer.write(original);
      await writer.close();
      bytes += original.length;
      const copy = new Uint8Array(await (await target.getFile()).arrayBuffer());
      if (same(original, copy)) {
        verified += 1;
        manifest.push({ path: item.path, size: original.length, sha256: await sha256(original) });
      } else {
        failures.push(`${item.path} did not match its original after it was copied.`);
      }
    } catch (error) {
      failures.push(`${item.path} could not be copied: ${messageOf(error)}`);
    }
  }

  const complete = failures.length === 0 && !left.some((file) => file.reason === 'too large');
  const createdAt = now.toISOString();
  try {
    await writeText(folder, 'backup-info.json', JSON.stringify({ app: 'opentunes', kind: 'ipod-database-backup', createdAt, complete, files: manifest, left, failures }, null, 2));
    await writeText(folder, 'README.txt', README(createdAt));
  } catch (error) {
    failures.push(`The backup notes could not be written: ${messageOf(error)}`);
  }

  return { folder: folder.name, files: plan.length, bytes, verified, failures, left, complete: complete && failures.length === 0 };
}
