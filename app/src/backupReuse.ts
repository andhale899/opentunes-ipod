/**
 * Using a backup made earlier (before a reload) as the backup a write needs.
 *
 * Is that safe? The backup exists so that a bad write can be undone. It only does that job if it
 * still describes the iPod: if the iPod changed since (iTunes, another computer, an earlier
 * change here), putting the backup back would also undo that other change. So a remembered backup
 * counts only when ALL of these hold:
 *
 *  1. this browser made it and remembered where it is (the record, with the backup's own
 *     creation time, so a different folder put in its place is noticed);
 *  2. it was made from an iPod folder of the same name;
 *  3. it passes the checks restoring uses: backup-info.json says complete, every file is there at
 *     its size and matches its SHA-256;
 *  4. the iPod's database files today are byte for byte what the backup holds (SHA-256 for files
 *     up to 8 MiB, size for larger ones such as artwork), with nothing missing and nothing new.
 *
 * If 4 fails the person is told how old the backup is and what changed, and chooses: a new backup
 * (the recommended one) or that older backup anyway, which is only ever used after an explicit
 * confirm that says what a restore from it would lose (see lastBackup.ts). Nothing that does not
 * match is ever accepted on its own. A backup whose iPod identity files (SysInfo, SysInfoExtended)
 * differ from the iPod's is treated as another iPod's and cannot be used anyway.
 *
 * The pure decision is in `decideReuse`. The reads are in `checkEarlierBackup`.
 */
import { isClutter, isNotNeeded, type BackupReport, type BackupSource, type DirectoryEntry, type FileEntry } from '@opentunes/engine';
import type { SavedBackup } from './handles';

export interface ManifestFile {
  path: string;
  size: number;
  sha256: string | null;
}

export interface Manifest {
  createdAt: string;
  complete: boolean;
  files: ManifestFile[];
  left: BackupReport['left'];
}

/** Files bigger than this are compared by size alone, so artwork does not take minutes to read. */
export const HASH_LIMIT = 8 * 1024 * 1024;

async function sha256(bytes: Uint8Array): Promise<string | null> {
  if (!globalThis.crypto?.subtle) return null;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Reads backup-info.json the way restoring does, and refuses what restoring refuses. Throws a plain Error. */
export function parseManifest(text: string, folderName: string): Manifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`The backup-info.json in "${folderName}" cannot be read.`);
  }
  const value = parsed as { kind?: unknown; complete?: unknown; createdAt?: unknown; files?: unknown; left?: unknown };
  if (value.kind !== 'ipod-database-backup' || !Array.isArray(value.files)) throw new Error(`"${folderName}" is not an iPod database backup.`);
  const files = (value.files as ManifestFile[]).map((file) => ({ path: String(file.path), size: Number(file.size), sha256: typeof file.sha256 === 'string' ? file.sha256 : null }));
  for (const file of files) {
    if (!file.path.startsWith('iPod_Control/') || file.path.split('/').some((part) => part === '..' || part === '')) {
      throw new Error(`The backup lists a path it should not: ${file.path}`);
    }
  }
  return { createdAt: String(value.createdAt ?? ''), complete: value.complete === true, files, left: Array.isArray(value.left) ? (value.left as BackupReport['left']) : [] };
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

export async function readManifest(backup: BackupSource): Promise<Manifest> {
  const bytes = await readFromBackup(backup, 'backup-info.json');
  if (!bytes) throw new Error(`"${backup.name}" has no backup-info.json, so it is not a backup made by this app.`);
  return parseManifest(new TextDecoder().decode(bytes), backup.name);
}

/** The checks restoring makes before it writes anything: every file there, at its size, matching its checksum. */
export async function verifyBackupFiles(backup: BackupSource, manifest: Manifest, onProgress?: (message: string) => void): Promise<string[]> {
  const problems: string[] = [];
  for (const file of manifest.files) {
    onProgress?.(`Checking ${file.path} in the backup`);
    const bytes = await readFromBackup(backup, file.path);
    if (!bytes) problems.push(`${file.path} is listed in the backup but is not in the folder.`);
    else if (bytes.length !== file.size) problems.push(`${file.path} is ${bytes.length} bytes in the backup and should be ${file.size}.`);
    else if (file.sha256 && (await sha256(bytes)) !== file.sha256) problems.push(`${file.path} does not match its checksum in the backup.`);
  }
  return problems;
}

export interface IpodComparison {
  /** Paths whose content or size is different on the iPod now. */
  changed: string[];
  /** In the backup, not on the iPod now. */
  missing: string[];
  /** On the iPod now, not in the backup. */
  added: string[];
}

interface Listed {
  path: string;
  file: FileEntry;
}

async function listBackedUp(root: DirectoryEntry): Promise<Listed[]> {
  const out: Listed[] = [];
  const walk = async (directory: DirectoryEntry, prefix: string): Promise<void> => {
    for await (const [name, entry] of directory.entries()) {
      if (isClutter(name)) continue;
      if (entry.kind === 'directory') await walk(entry, `${prefix}${name}/`);
      else if (!isNotNeeded(`${prefix}${name}`.slice('iPod_Control/'.length))) out.push({ path: `${prefix}${name}`, file: entry });
    }
  };
  let control: DirectoryEntry;
  try {
    control = await root.getDirectoryHandle('iPod_Control');
  } catch {
    return [];
  }
  for await (const [name, entry] of control.entries()) {
    if (isClutter(name)) continue;
    if (entry.kind === 'file') {
      if (!isNotNeeded(name)) out.push({ path: `iPod_Control/${name}`, file: entry });
    } else if (['iTunes', 'Device', 'Artwork'].includes(name)) await walk(entry, `iPod_Control/${name}/`);
  }
  return out;
}

/** Compares the iPod as it is now with a manifest. Reads only. */
export async function compareWithIpod(root: DirectoryEntry, manifest: Manifest, onProgress?: (message: string) => void): Promise<IpodComparison> {
  const wanted = new Map(manifest.files.map((file) => [file.path, file]));
  const left = new Set(manifest.left.map((entry) => entry.path));
  const result: IpodComparison = { changed: [], missing: [], added: [] };
  const seen = new Set<string>();
  for (const { path, file } of await listBackedUp(root)) {
    seen.add(path);
    const expected = wanted.get(path);
    if (!expected) {
      if (!left.has(path)) result.added.push(path);
      continue;
    }
    onProgress?.(`Comparing ${path} with the backup`);
    const handle = await file.getFile();
    if (handle.size !== expected.size) {
      result.changed.push(path);
    } else if (expected.sha256 && handle.size <= HASH_LIMIT) {
      const hash = await sha256(new Uint8Array(await handle.arrayBuffer()));
      if (hash !== expected.sha256) result.changed.push(path);
    }
  }
  for (const path of wanted.keys()) if (!seen.has(path)) result.missing.push(path);
  return result;
}

export type ReuseReason = 'ok' | 'different-ipod' | 'different-backup' | 'incomplete' | 'damaged' | 'ipod-changed';

/** The device files that say which iPod this is. If they differ from a backup's, the backup is another iPod's. */
const IDENTITY_FILE = /^iPod_Control\/Device\/SysInfo(Extended)?$/;

export function identityDiffers(comparison: IpodComparison): boolean {
  return [...comparison.changed, ...comparison.missing].some((path) => IDENTITY_FILE.test(path));
}

export interface ReuseDecision {
  allowed: boolean;
  reason: ReuseReason;
  /** Plain sentence for the person. */
  message: string;
}

export function ageText(madeAt: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - madeAt) / 60_000));
  if (minutes < 2) return 'just now';
  if (minutes < 90) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} hours ago`;
  return `${Math.round(hours / 24)} days ago`;
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

/** The rule above, as a pure function of what was found. */
export function decideReuse(input: {
  record: Pick<SavedBackup, 'ipod' | 'madeAt' | 'manifestCreatedAt' | 'folder'>;
  ipodName: string;
  manifest: Pick<Manifest, 'createdAt' | 'complete'>;
  problems: string[];
  comparison: IpodComparison;
  now: number;
}): ReuseDecision {
  const { record, manifest, problems, comparison, now } = input;
  const age = ageText(record.madeAt, now);
  if (record.ipod !== input.ipodName) {
    return { allowed: false, reason: 'different-ipod', message: `That backup was made from an iPod folder called "${record.ipod}", and this one is called "${input.ipodName}". Make a new backup.` };
  }
  if (manifest.createdAt !== record.manifestCreatedAt) {
    return { allowed: false, reason: 'different-backup', message: `The folder "${record.folder}" is not the backup this browser made: its creation time is different. Make a new backup.` };
  }
  if (!manifest.complete) return { allowed: false, reason: 'incomplete', message: 'That backup was not complete, so it is not used. Make a new backup.' };
  if (problems.length) {
    return { allowed: false, reason: 'damaged', message: `That backup does not pass the checks a restore makes (${problems[0]}). Make a new backup.` };
  }
  if (identityDiffers(comparison)) {
    return { allowed: false, reason: 'different-ipod', message: `The files that identify an iPod are not the same as the ones in that backup, so it looks like it was made from a different iPod. It is not used. Make a new backup.` };
  }
  const differences = comparison.changed.length + comparison.missing.length + comparison.added.length;
  if (differences) {
    const parts = [
      comparison.changed.length ? `${plural(comparison.changed.length, 'file')} different` : '',
      comparison.added.length ? `${plural(comparison.added.length, 'new file')}` : '',
      comparison.missing.length ? `${plural(comparison.missing.length, 'file')} gone` : '',
    ].filter(Boolean);
    return {
      allowed: false,
      reason: 'ipod-changed',
      message: `The iPod has changed since that backup was made (${age}): ${parts.join(', ')}. Restoring it would undo those changes.`,
    };
  }
  return { allowed: true, reason: 'ok', message: `The backup made ${age} passed every check and the iPod's database files are exactly what it holds, so it can be used as the backup for changes.` };
}

/** The report the write code needs, rebuilt from a backup that passed. */
export function reportFromManifest(folder: string, manifest: Manifest): BackupReport {
  return {
    folder,
    files: manifest.files.length,
    bytes: manifest.files.reduce((sum, file) => sum + file.size, 0),
    verified: manifest.files.length,
    failures: [],
    left: manifest.left,
    complete: true,
    stopped: false,
  };
}

export interface EarlierBackupResult {
  decision: ReuseDecision;
  /** The report to use, only when the decision allows it. */
  report: BackupReport | null;
  /** When the iPod changed since an otherwise good backup: the report it would give if the person chose it anyway. Null for any other refusal, which can never be chosen. */
  olderReport: BackupReport | null;
  /** What differs on the iPod now. Empty when the backup could not be compared. */
  comparison: IpodComparison;
  /** When the backup was made, from this browser's own record. */
  madeAt: number;
}

/** Opens a folder given as a path of names below `parent`, such as "opentunes-offload-2026-11-07-1804/database". */
export async function openFolderPath(parent: { getDirectoryHandle(name: string): Promise<BackupSource> }, path: string): Promise<BackupSource> {
  let folder = parent as unknown as BackupSource;
  for (const part of path.split('/').filter(Boolean)) folder = await folder.getDirectoryHandle(part);
  return folder;
}

/** Runs every read: the backup's manifest and files, then the iPod. Throws a plain Error when the folder is not readable. */
export async function checkEarlierBackup(record: SavedBackup, ipodRoot: DirectoryEntry, now: number, options: { onProgress?: (message: string) => void } = {}): Promise<EarlierBackupResult> {
  const onProgress = options.onProgress;
  const folder = await openFolderPath(record.destination as { getDirectoryHandle(name: string): Promise<BackupSource> }, record.folder);
  onProgress?.('Reading the backup...');
  const manifest = await readManifest(folder);
  const problems = await verifyBackupFiles(folder, manifest, onProgress);
  const comparison = await compareWithIpod(ipodRoot, manifest, onProgress);
  const decision = decideReuse({ record, ipodName: ipodRoot.name, manifest, problems, comparison, now });
  return {
    decision,
    report: decision.allowed ? reportFromManifest(record.folder, manifest) : null,
    olderReport: decision.reason === 'ipod-changed' ? reportFromManifest(record.folder, manifest) : null,
    comparison,
    madeAt: record.madeAt,
  };
}
