/**
 * The folders the person picked, kept in this browser so a reload can offer "Reconnect" instead of
 * starting over. A folder handle is an opaque permission token that only this browser can use. It
 * names no serial number or ID, and holds nothing from the iPod. What is kept about a backup is
 * only where it is (the folder handle and its name) and when this browser made it.
 */
import { kv } from './kv';
import { logError, logOk, logStep } from './log';

export interface SavedIpod {
  /** The folder's name, as the person sees it. */
  name: string;
  handle: unknown;
  savedAt: number;
}

export interface SavedBackup {
  /** The folder the person chose to keep backups in. */
  destination: unknown;
  destinationName: string;
  /** The folder the backup made inside it (opentunes-backup-...), or for a full copy the path to its library folder (opentunes-offload-.../database). */
  folder: string;
  /** The iPod folder name the backup was made from. */
  ipod: string;
  /** When this browser finished the backup. */
  madeAt: number;
  /** The createdAt written in the backup's own backup-info.json, to be sure it is the same backup. */
  manifestCreatedAt: string;
}

const IPOD_KEY = 'ipod-handle';
/** One record per iPod folder name, so each iPod finds its own last backup. The older single record is still read. */
const BACKUP_KEY = 'backup-record';
const backupKeyFor = (ipod: string): string => `${BACKUP_KEY}:${ipod}`;

async function guarded<T>(what: string, action: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await action();
  } catch (error) {
    logError('reconnect', `${what} failed: ${error instanceof Error ? error.message : String(error)}`);
    return fallback;
  }
}

export const saveIpodHandle = (name: string, handle: unknown): Promise<void> =>
  guarded(
    'Remembering the iPod folder',
    async () => {
      const db = await kv();
      if (!db.handles) return; // a store that cannot hold a handle: nothing to remember
      await db.set(IPOD_KEY, { name, handle, savedAt: Date.now() } satisfies SavedIpod);
      logStep('reconnect', 'The iPod folder was remembered in this browser, for Reconnect after a reload.');
    },
    undefined,
  );

export const loadIpodHandle = (): Promise<SavedIpod | null> =>
  guarded(
    'Looking for a remembered iPod folder',
    async () => {
      const value = (await (await kv()).get(IPOD_KEY)) as Partial<SavedIpod> | undefined;
      return value && typeof value.name === 'string' && value.handle ? (value as SavedIpod) : null;
    },
    null,
  );

export const forgetIpodHandle = (): Promise<void> =>
  guarded(
    'Forgetting the iPod folder',
    async () => {
      await (await kv()).delete(IPOD_KEY);
      logOk('reconnect', 'The remembered iPod folder was forgotten.');
    },
    undefined,
  );

export const saveBackupRecord = (record: SavedBackup): Promise<void> =>
  guarded(
    'Remembering the backup folder',
    async () => {
      const db = await kv();
      if (!db.handles) return;
      await db.set(backupKeyFor(record.ipod), record);
      logStep('backup', 'The backup folder was remembered in this browser, for the next time this iPod is opened.');
    },
    undefined,
  );

const usable = (value: Partial<SavedBackup> | undefined): value is SavedBackup =>
  Boolean(value && value.destination && typeof value.folder === 'string' && typeof value.madeAt === 'number' && typeof value.manifestCreatedAt === 'string' && typeof value.ipod === 'string');

/** The backup remembered for the iPod folder with this name, or null. */
export const loadBackupRecord = (ipod: string): Promise<SavedBackup | null> =>
  guarded(
    'Looking for a remembered backup',
    async () => {
      const db = await kv();
      const own = (await db.get(backupKeyFor(ipod))) as Partial<SavedBackup> | undefined;
      if (usable(own) && own.ipod === ipod) return own;
      // Before there was one record per iPod, a single one was kept.
      const old = (await db.get(BACKUP_KEY)) as Partial<SavedBackup> | undefined;
      return usable(old) && old.ipod === ipod ? old : null;
    },
    null,
  );

export const forgetBackupRecord = (ipod: string): Promise<void> =>
  guarded(
    'Forgetting the backup folder',
    async () => {
      const db = await kv();
      await db.delete(backupKeyFor(ipod));
      const old = (await db.get(BACKUP_KEY)) as Partial<SavedBackup> | undefined;
      if (old && old.ipod === ipod) await db.delete(BACKUP_KEY);
    },
    undefined,
  );
