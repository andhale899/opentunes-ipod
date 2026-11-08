/**
 * Writes a rebuilt database back to an iPod, and puts a backup back.
 *
 * This is the first code that changes an iPod. It is built to be undone:
 * - It will not start without a complete, verified backup from this session.
 * - Planning changes nothing. It reads the iPod, writes the database in the engine's own
 *   memory and lists exactly which files would change.
 * - Applying writes those files one at a time and reads each back. If any write fails, or the
 *   result cannot be read back with valid signatures, every file already touched is put back
 *   as it was, from the bytes read before anything was written.
 * - Restoring checks every file in a backup against its checksum before writing a single one.
 *
 * Only files under iPod_Control/iTunes and iPod_Control/Device are ever written. Music and
 * artwork are never touched.
 */

import type { Engine } from './engine.ts';
import { IpodFolderError, loadIpodFolder, type DirectoryEntry, type FileEntry } from './folder.ts';
import type { BackupReport } from './backup.ts';
import { checkRewrite, compareLibraries, type RewriteReport } from './rewrite.ts';
import { findFireWireId, verifySignatures, type SignatureCheck } from './signature.ts';
import {
  DEFAULT_MOUNT,
  diffTrees,
  fireWireIdOf,
  messageOf,
  readBackIpod,
  readFrom,
  readTree,
  requireBackup,
  rollBack,
  same,
  writeDatabaseChanges,
  writeTo,
  type IpodRoot,
  type PlannedChange,
  type Touched,
} from './ipod-files.ts';

export type { IpodRoot, PlannedChange } from './ipod-files.ts';

export class WriteBackError extends Error {}

/** A backup folder made by `backupIpod`, opened for reading. */
export interface BackupSource extends DirectoryEntry {
  getDirectoryHandle(name: string): Promise<BackupSource>;
  getFileHandle(name: string): Promise<FileEntry>;
}

// --------------------------------------------------------------------- planning

export interface WriteBackPlan {
  changes: PlannedChange[];
  /** Files libgpod writes that are deliberately left off the iPod, and why. */
  skipped: { path: string; reason: string }[];
  /** The rewrite check that was run to make the plan. */
  report: RewriteReport;
  fireWireId: string | null;
  mount: string;
  /** What the iPod holds now, and what would be written. Kept so applying needs no second guess. */
  originals: Map<string, Uint8Array>;
  rewritten: Map<string, Uint8Array>;
  tracksBefore: Parameters<typeof compareLibraries>[0];
  playlistsBefore: Parameters<typeof compareLibraries>[1];
}

export interface PlanOptions {
  mount?: string;
  onProgress?: (message: string) => void;
  /** Stops planning with an AbortError. Planning writes nothing to the iPod. */
  signal?: AbortSignal;
}

/**
 * Reads the iPod, writes its database in the engine's memory, and works out which files would
 * change. Writes nothing to the iPod. Throws if libgpod cannot write or read back the database.
 */
export async function planWriteBack(root: IpodRoot, newEngine: () => Promise<Engine>, options: PlanOptions = {}): Promise<WriteBackPlan> {
  const mount = options.mount ?? DEFAULT_MOUNT;
  const engine = await newEngine();
  const load = await loadIpodFolder(root, engine, { mount, onProgress: options.onProgress, signal: options.signal });
  options.signal?.throwIfAborted();
  if (!load.hasDatabaseFolder) throw new IpodFolderError(`"${root.name}" has no iTunes folder in iPod_Control, so there is no database to write back.`);
  engine.open(load.mount);
  const fireWireId = fireWireIdOf(engine, mount);

  const originals = readTree(engine, mount);
  const tracksBefore = engine.tracks();
  const playlistsBefore = engine.playlists();

  options.onProgress?.('Writing the database in memory...');
  const report = await checkRewrite(engine, mount, fireWireId);
  if (report.writeError) throw new WriteBackError(`libgpod could not write this library, so there is nothing to put on the iPod: ${report.writeError}`);
  if (report.readBackError) throw new WriteBackError(`libgpod could not read back the database it wrote, so it will not be put on the iPod: ${report.readBackError}`);

  const rewritten = readTree(engine, mount);
  const { changes, skipped } = diffTrees(originals, rewritten);
  return { changes, skipped, report, fireWireId, mount, originals, rewritten, tracksBefore, playlistsBefore };
}

// --------------------------------------------------------------------- applying

export interface WriteBackReport {
  written: { path: string; size: number }[];
  removed: string[];
  skipped: { path: string; reason: string }[];
  /** True when every file was read back identical and the iPod's database reads back with valid signatures. */
  verified: boolean;
  signatures: SignatureCheck[];
  /** True when something went wrong and the files that had been changed were put back. */
  rolledBack: boolean;
  /** Files that could not be put back. If there are any, restore from the backup. */
  rollbackFailures: string[];
  /** What went wrong, one sentence each. */
  failures: string[];
}

export interface ApplyOptions {
  /** The backup made in this session. It must be complete. */
  backup: BackupReport | null;
  onProgress?: (message: string) => void;
}

/**
 * Writes the planned files to the iPod. Needs a complete backup. If anything fails, puts back
 * every file it changed. Never throws for a problem with the iPod: it reports it.
 */
export async function applyWriteBack(plan: WriteBackPlan, root: IpodRoot, newEngine: () => Promise<Engine>, options: ApplyOptions): Promise<WriteBackReport> {
  requireBackup(options.backup, (message) => new WriteBackError(message));

  const report: WriteBackReport = { written: [], removed: [], skipped: plan.skipped, verified: false, signatures: [], rolledBack: false, rollbackFailures: [], failures: [] };
  const touched: Touched[] = [];

  const fail = async (message: string): Promise<WriteBackReport> => {
    report.failures.push(message);
    options.onProgress?.('Something went wrong. Putting the original files back...');
    report.rollbackFailures = await rollBack(root, touched);
    report.rolledBack = true;
    return report;
  };

  const write = await writeDatabaseChanges(root, plan.changes, plan.originals, plan.rewritten, touched, { onStep: options.onProgress });
  report.written = write.written;
  report.removed = write.removed;
  if (write.failure) return await fail(write.failure);

  // Read the iPod back the way the reader does, and check what it now holds.
  options.onProgress?.('Reading the iPod back to check it...');
  try {
    const back = await readBackIpod(root, newEngine, plan.mount, plan.fireWireId);
    if (!back) return await fail('The iPod has no database folder after the write.');
    const library = compareLibraries(plan.tracksBefore, plan.playlistsBefore, back.tracks, back.playlists);
    report.signatures = back.signatures;
    if (library.tracksBefore !== library.tracksAfter || library.unmatched) {
      return await fail(`The iPod's library reads back with ${library.tracksAfter} tracks, and it had ${library.tracksBefore}.`);
    }
    if (Object.keys(library.changedFields).length || library.playlistChanges.length) {
      return await fail(`The iPod's library reads back differently: ${[...Object.keys(library.changedFields).map((field) => `track field "${field}"`), ...library.playlistChanges].join('; ')}`);
    }
    if (back.badSignatures.length) return await fail(`A signature on the iPod is not confirmed after the write: ${back.badSignatures.join('; ')}`);
  } catch (error) {
    return await fail(`The iPod could not be read back after the write: ${messageOf(error)}`);
  }

  report.verified = true;
  return report;
}

// -------------------------------------------------------------------- restoring

export interface BackupSummary {
  createdAt: string;
  files: number;
  bytes: number;
}

interface Manifest {
  createdAt: string;
  files: { path: string; size: number; sha256: string | null }[];
}

async function readFromBackup(backup: BackupSource, path: string): Promise<Uint8Array | null> {
  const parts = path.split('/');
  try {
    let folder = backup;
    for (const part of parts.slice(0, -1)) folder = await folder.getDirectoryHandle(part);
    const handle = await folder.getFileHandle(parts[parts.length - 1] as string);
    return new Uint8Array(await (await handle.getFile()).arrayBuffer());
  } catch {
    return null;
  }
}

async function sha256Of(bytes: Uint8Array): Promise<string | null> {
  if (!globalThis.crypto?.subtle) return null;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function readManifest(backup: BackupSource): Promise<Manifest> {
  const bytes = await readFromBackup(backup, 'backup-info.json');
  if (!bytes) throw new WriteBackError(`"${backup.name}" has no backup-info.json, so it is not a backup made by this app.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new WriteBackError(`The backup-info.json in "${backup.name}" cannot be read.`);
  }
  const manifest = parsed as { kind?: unknown; complete?: unknown; createdAt?: unknown; files?: unknown };
  if (manifest.kind !== 'ipod-database-backup' || !Array.isArray(manifest.files)) {
    throw new WriteBackError(`"${backup.name}" is not an iPod database backup.`);
  }
  if (manifest.complete !== true) {
    throw new WriteBackError(`The backup in "${backup.name}" was not complete, so it is not used to restore. Make a new backup.`);
  }
  const files = (manifest.files as Manifest['files']).map((file) => ({ path: String(file.path), size: Number(file.size), sha256: typeof file.sha256 === 'string' ? file.sha256 : null }));
  for (const file of files) {
    if (!file.path.startsWith('iPod_Control/') || file.path.split('/').some((part) => part === '..' || part === '')) {
      throw new WriteBackError(`The backup lists a path it should not: ${file.path}`);
    }
  }
  return { createdAt: String(manifest.createdAt ?? ''), files };
}

/** What a backup folder holds, for showing before it is restored. Throws if it is not a usable backup. */
export async function describeBackup(backup: BackupSource): Promise<BackupSummary> {
  const manifest = await readManifest(backup);
  return { createdAt: manifest.createdAt, files: manifest.files.length, bytes: manifest.files.reduce((sum, file) => sum + file.size, 0) };
}

async function readVerifiedBackup(backup: BackupSource, manifest: Manifest, signal?: AbortSignal): Promise<Map<string, Uint8Array>> {
  const contents = new Map<string, Uint8Array>();
  for (const file of manifest.files) {
    signal?.throwIfAborted();
    const bytes = await readFromBackup(backup, file.path);
    if (!bytes) throw new WriteBackError(`${file.path} is listed in the backup but is not in the folder, so nothing was restored.`);
    if (bytes.length !== file.size) throw new WriteBackError(`${file.path} is ${bytes.length} bytes in the backup and should be ${file.size}, so nothing was restored.`);
    if (file.sha256 && (await sha256Of(bytes)) !== file.sha256) throw new WriteBackError(`${file.path} does not match its checksum in the backup, so nothing was restored.`);
    contents.set(file.path, bytes);
  }
  return contents;
}

/**
 * Checks a backup the way a restore does, without writing anything: the manifest is usable and
 * complete, and every file is there with its size and checksum. Throws what a restore would throw.
 */
export async function checkBackup(backup: BackupSource): Promise<BackupSummary> {
  const manifest = await readManifest(backup);
  await readVerifiedBackup(backup, manifest);
  return { createdAt: manifest.createdAt, files: manifest.files.length, bytes: manifest.files.reduce((sum, file) => sum + file.size, 0) };
}

export interface RestoreReport {
  restored: number;
  bytes: number;
  failures: string[];
  /** True when every file was written, read back identical, and the iPod's database reads back. */
  verified: boolean;
  signatures: SignatureCheck[];
}

/** Where a restore is: `checking` the backup (nothing written, can be stopped), `writing` files to the iPod, or `verifying` them. */
export type RestorePhase = 'checking' | 'writing' | 'verifying';

export interface RestoreOptions {
  /** To read the iPod back after restoring and check its signatures. */
  newEngine?: () => Promise<Engine>;
  mount?: string;
  onProgress?: (message: string, phase?: RestorePhase) => void;
  /**
   * Stops the restore with an AbortError while the backup is still being checked, before the first
   * file is written. Once files are being written it is ignored, because stopping halfway would
   * leave the iPod with a mix of old and restored files.
   */
  signal?: AbortSignal;
}

/**
 * Copies a backup's files back onto the iPod, one by one, and keeps everything else. Every file
 * is checked against its checksum before the first one is written, so a damaged backup changes
 * nothing. Deletes nothing.
 */
export async function restoreBackup(root: IpodRoot, backup: BackupSource, options: RestoreOptions = {}): Promise<RestoreReport> {
  const mount = options.mount ?? DEFAULT_MOUNT;
  const manifest = await readManifest(backup);

  options.onProgress?.('Checking the backup...', 'checking');
  const contents = await readVerifiedBackup(backup, manifest, options.signal);

  options.signal?.throwIfAborted();
  const report: RestoreReport = { restored: 0, bytes: 0, failures: [], verified: false, signatures: [] };
  for (const [path, bytes] of contents) {
    options.onProgress?.(`Restoring ${path}`, 'writing');
    try {
      await writeTo(root, path, bytes);
      const back = await readFrom(root, path);
      if (back && same(back, bytes)) {
        report.restored += 1;
        report.bytes += bytes.length;
      } else {
        report.failures.push(`${path} did not match its backup when it was read back from the iPod.`);
      }
    } catch (error) {
      report.failures.push(`${path} could not be restored: ${messageOf(error)}`);
    }
  }

  if (!report.failures.length && options.newEngine) {
    options.onProgress?.('Reading the iPod back to check it...', 'verifying');
    try {
      const engine = await options.newEngine();
      const load = await loadIpodFolder(root, engine, { mount });
      if (load.hasDatabaseFolder) {
        engine.open(load.mount);
        let id: string | null = null;
        try {
          id = engine.device().firewire_id;
        } catch {
          id = null;
        }
        report.signatures = await verifySignatures(engine, mount, id ?? findFireWireId(engine, mount));
      }
      const bad = report.signatures.filter((check) => check.status === 'differs' || check.status === 'unsupported');
      if (bad.length) report.failures.push(`A signature on the iPod is not confirmed after the restore: ${bad.map((check) => `${check.file}: ${check.detail}`).join('; ')}`);
    } catch (error) {
      report.failures.push(`The iPod could not be read back after the restore: ${messageOf(error)}`);
    }
  }
  report.verified = report.failures.length === 0;
  return report;
}
