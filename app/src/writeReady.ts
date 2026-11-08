/**
 * Whether the buttons that change the iPod may be used: a complete backup counts for this session, and no
 * read job (a backup, a copy, a read of the iPod) is running, since the lock would refuse the change anyway.
 * `wait` is the line that says so when it is the running job that holds them off.
 */
import type { BackupReport } from '@opentunes/engine';
import { readBlockText, useLockState } from './writeLock';

export interface WriteReady {
  /** True when a write button can be on. */
  ready: boolean;
  /** True when a complete backup counts, whatever is running. */
  backupOk: boolean;
  /** Why the buttons are off because a job is running, or null. */
  wait: string | null;
}

export function useWriteReady(backup: BackupReport | null): WriteReady {
  const wait = readBlockText(useLockState());
  const backupOk = backup !== null && backup.complete;
  return { ready: backupOk && wait === null, backupOk, wait };
}
