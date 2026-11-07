/**
 * The file access and database write path shared by write-back (writeback.ts) and sync
 * (sync.ts). Internal: not exported from the package, so its shape can change with them.
 *
 * What lives here is the part that was proven on the owner's nano 7G by the first write-back:
 * write each database file in a fixed order (signature files last, removals after writing),
 * read each one back and compare it byte for byte, and put every touched file back as it was
 * if anything goes wrong.
 */

import type { Engine, PlaylistInfo, TrackInfo } from './engine.ts';
import { loadIpodFolder, type DirectoryEntry, type FileLike } from './folder.ts';
import type { BackupReport, WritableFile } from './backup.ts';
import { findFireWireId, verifySignatures, type SignatureCheck } from './signature.ts';

/** An iPod's top folder, opened so it can be read and changed. */
export interface IpodRoot extends DirectoryEntry {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<IpodRoot>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<WritableFile>;
  removeEntry(name: string): Promise<void>;
}

/** A file change worked out in memory, from the iPod's top folder. */
export interface PlannedChange {
  /** From the iPod's top folder. */
  path: string;
  kind: 'added' | 'changed' | 'removed';
  sizeBefore: number | null;
  sizeAfter: number | null;
}

export const DEFAULT_MOUNT = '/ipod';

export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

// ------------------------------------------------------------ iPod file access

export async function folderAt(root: IpodRoot, parts: string[], create: boolean): Promise<IpodRoot | null> {
  let current = root;
  for (const part of parts) {
    try {
      current = await current.getDirectoryHandle(part, { create });
    } catch {
      return null;
    }
  }
  return current;
}

/** The bytes of a file on the iPod, or null if it is not there. */
export async function readFrom(root: IpodRoot, path: string): Promise<Uint8Array | null> {
  const parts = path.split('/');
  const folder = await folderAt(root, parts.slice(0, -1), false);
  if (!folder) return null;
  try {
    const handle = await folder.getFileHandle(parts[parts.length - 1] as string);
    return new Uint8Array(await (await handle.getFile()).arrayBuffer());
  } catch {
    return null;
  }
}

/** The file on the iPod, without reading it, or null if it is not there. */
export async function fileAt(root: IpodRoot, path: string): Promise<FileLike | null> {
  const parts = path.split('/');
  const folder = await folderAt(root, parts.slice(0, -1), false);
  if (!folder) return null;
  try {
    return await (await folder.getFileHandle(parts[parts.length - 1] as string)).getFile();
  } catch {
    return null;
  }
}

export async function writeTo(root: IpodRoot, path: string, bytes: Uint8Array): Promise<void> {
  const parts = path.split('/');
  const folder = await folderAt(root, parts.slice(0, -1), true);
  if (!folder) throw new Error(`The folder for ${path} could not be made on the iPod.`);
  const writer = await (await folder.getFileHandle(parts[parts.length - 1] as string, { create: true })).createWritable();
  await writer.write(bytes);
  await writer.close();
}

export async function removeFrom(root: IpodRoot, path: string): Promise<void> {
  const parts = path.split('/');
  const folder = await folderAt(root, parts.slice(0, -1), false);
  if (folder) await folder.removeEntry(parts[parts.length - 1] as string);
}

/**
 * Every file below the mount point inside the engine, by path from the mount point. `skip`
 * leaves out a folder or file by its path from the mount point, with everything below it.
 */
export function readTree(engine: Engine, mount: string, skip: (path: string) => boolean = () => false): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  const walk = (directory: string): void => {
    for (const name of engine.fs.readdir(directory)) {
      if (name === '.' || name === '..') continue;
      const path = `${directory}/${name}`;
      const relative = path.slice(mount.length + 1);
      if (skip(relative)) continue;
      if (engine.fs.isDir(engine.fs.stat(path).mode)) walk(path);
      else files.set(relative, engine.fs.readFile(path));
    }
  };
  walk(mount);
  return files;
}

/** Which files differ between what the iPod holds and what libgpod wrote in memory. */
export function diffTrees(originals: Map<string, Uint8Array>, rewritten: Map<string, Uint8Array>): { changes: PlannedChange[]; skipped: { path: string; reason: string }[] } {
  const changes: PlannedChange[] = [];
  const skipped: { path: string; reason: string }[] = [];
  for (const [path, bytes] of rewritten) {
    const was = originals.get(path);
    if (!was) {
      if (path === 'iPod_Control/iTunes/iTunesDB' && bytes.length === 0) {
        skipped.push({ path, reason: 'libgpod leaves an empty iTunesDB beside iTunesCDB. This iPod has none, so none is written.' });
      } else {
        changes.push({ path, kind: 'added', sizeBefore: null, sizeAfter: bytes.length });
      }
    } else if (!same(was, bytes)) {
      changes.push({ path, kind: 'changed', sizeBefore: was.length, sizeAfter: bytes.length });
    }
  }
  for (const [path, bytes] of originals) {
    if (!rewritten.has(path)) changes.push({ path, kind: 'removed', sizeBefore: bytes.length, sizeAfter: null });
  }
  changes.sort((a, b) => a.path.localeCompare(b.path));
  return { changes, skipped };
}

/** The FireWire ID libgpod read, or the one in the iPod's own device files. */
export function fireWireIdOf(engine: Engine, mount: string): string | null {
  let fireWireId: string | null = null;
  try {
    fireWireId = engine.device().firewire_id;
  } catch {
    fireWireId = null;
  }
  return fireWireId ?? findFireWireId(engine, mount);
}

// ------------------------------------------------------------ the backup rule

/** Throws unless a complete backup, read back and matched, was made in this session. */
export function requireBackup(backup: BackupReport | null, makeError: (message: string) => Error): void {
  if (!backup || !backup.complete || backup.failures.length) {
    throw makeError('Back up the iPod first. Nothing is written until a complete backup, read back and matched, has been made in this session.');
  }
}

// ------------------------------------------------------- writing the database

/** Signature-critical files go last, and removals after everything has been written. */
function order(change: PlannedChange): number {
  if (change.kind === 'removed') return 4;
  if (change.path.endsWith('/iTunesCDB')) return 3;
  if (change.path.endsWith('/Locations.itdb.cbk')) return 2;
  return 1;
}

export interface Touched {
  path: string;
  /** The bytes the iPod held before, or null if the file was not there. */
  before: Uint8Array | null;
}

/** Puts every touched file back as it was, newest first, and checks each. Returns what could not be. */
export async function rollBack(root: IpodRoot, touched: Touched[]): Promise<string[]> {
  const failures: string[] = [];
  const asItWas = (item: Touched, now: Uint8Array | null): boolean => (item.before ? now !== null && same(item.before, now) : now === null);
  for (const item of [...touched].reverse()) {
    try {
      if (asItWas(item, await readFrom(root, item.path))) continue; // never changed, or already back
      if (item.before) await writeTo(root, item.path, item.before);
      else await removeFrom(root, item.path);
      if (!asItWas(item, await readFrom(root, item.path))) failures.push(`${item.path} was not put back as it was.`);
    } catch (error) {
      failures.push(`${item.path} could not be put back: ${messageOf(error)}`);
    }
  }
  return failures;
}

export interface DatabaseWrite {
  written: { path: string; size: number }[];
  removed: string[];
  /** What went wrong, or null when every file was written and read back identical. */
  failure: string | null;
}

export interface DatabaseWriteOptions {
  /** Called with "Writing <path>" or "Removing <path>" before each file. */
  onStep?: (message: string) => void;
  /** Checked before each file. A message stops the write there, as a failure. */
  stopReason?: () => string | null;
}

/**
 * Writes the planned database files to the iPod, in the order the first write-back used, and
 * reads each back. Every file it is about to change is added to `touched` first, with the bytes
 * the iPod held, so the caller can roll back. Stops at the first problem and says what it was.
 * A file that differs from `originals` stops it before anything is written to that file.
 */
export async function writeDatabaseChanges(
  root: IpodRoot,
  changes: PlannedChange[],
  originals: Map<string, Uint8Array>,
  rewritten: Map<string, Uint8Array>,
  touched: Touched[],
  options: DatabaseWriteOptions = {},
): Promise<DatabaseWrite> {
  const result: DatabaseWrite = { written: [], removed: [], failure: null };
  for (const change of [...changes].sort((a, b) => order(a) - order(b) || a.path.localeCompare(b.path))) {
    const stop = options.stopReason?.();
    if (stop) {
      result.failure = stop;
      return result;
    }
    options.onStep?.(`${change.kind === 'removed' ? 'Removing' : 'Writing'} ${change.path}`);
    try {
      const before = await readFrom(root, change.path);
      const current = originals.get(change.path) ?? null;
      if (before && current && !same(before, current)) {
        result.failure = `${change.path} on the iPod is not what it was when the plan was made, so nothing more was written. Plan again.`;
        return result;
      }
      touched.push({ path: change.path, before });
      if (change.kind === 'removed') {
        await removeFrom(root, change.path);
        if ((await readFrom(root, change.path)) !== null) {
          result.failure = `${change.path} is still on the iPod after it was removed.`;
          return result;
        }
        result.removed.push(change.path);
      } else {
        const bytes = rewritten.get(change.path) as Uint8Array;
        await writeTo(root, change.path, bytes);
        const back = await readFrom(root, change.path);
        if (!back || !same(back, bytes)) {
          result.failure = `${change.path} did not match what was written when it was read back from the iPod.`;
          return result;
        }
        result.written.push({ path: change.path, size: bytes.length });
      }
    } catch (error) {
      result.failure = `${change.path} could not be ${change.kind === 'removed' ? 'removed' : 'written'}: ${messageOf(error)}`;
      return result;
    }
  }
  return result;
}

// ----------------------------------------------------------- reading it back

export interface ReadBack {
  tracks: TrackInfo[];
  playlists: PlaylistInfo[];
  signatures: SignatureCheck[];
  /** Signatures that are not confirmed, as "file: detail". Empty when all are fine or missing. */
  badSignatures: string[];
}

/**
 * Reads the iPod back the way the reader does, with a fresh engine. Null when the iPod has no
 * database folder. Throws if the database cannot be read.
 */
export async function readBackIpod(root: IpodRoot, newEngine: () => Promise<Engine>, mount: string, fireWireId: string | null): Promise<ReadBack | null> {
  const engine = await newEngine();
  const load = await loadIpodFolder(root, engine, { mount });
  if (!load.hasDatabaseFolder) return null;
  engine.open(load.mount);
  const signatures = await verifySignatures(engine, mount, fireWireId);
  const badSignatures = signatures.filter((check) => check.status === 'differs' || check.status === 'unsupported').map((check) => `${check.file}: ${check.detail}`);
  return { tracks: engine.tracks(), playlists: engine.playlists(), signatures, badSignatures };
}
