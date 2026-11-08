/**
 * Whether the iPod's folder can still be reached, and getting permission back after a reload.
 * Chrome has no event for "the iPod was unplugged", so the page asks the folder a cheap question
 * (list its top level) now and then, and whenever a write is about to start. A folder on a
 * volume that is gone answers with NotFoundError, which is the sign used here.
 */
import type { DirectoryEntry } from '@opentunes/engine';
import { IpodAccessError, classifyFsError } from './friendlyError';

export type PermissionState = 'granted' | 'prompt' | 'denied';
export type PermissionMode = 'read' | 'readwrite';

interface PermissionHandle {
  queryPermission?: (descriptor: { mode: PermissionMode }) => Promise<PermissionState>;
  requestPermission?: (descriptor: { mode: PermissionMode }) => Promise<PermissionState>;
}

/** Throws IpodAccessError('disconnected') when the folder no longer answers. */
export async function checkFolderAlive(folder: Pick<DirectoryEntry, 'entries'>): Promise<void> {
  try {
    for await (const entry of folder.entries()) {
      void entry;
      break;
    }
  } catch (error) {
    const problem = classifyFsError(error);
    if (problem === 'disconnected' || problem === 'permission') throw new IpodAccessError(problem, { cause: error });
    throw error;
  }
}

/** True while the folder answers. Never throws. */
export async function isFolderAlive(folder: Pick<DirectoryEntry, 'entries'>): Promise<boolean> {
  try {
    await checkFolderAlive(folder);
    return true;
  } catch {
    return false;
  }
}

/**
 * Asks Chrome to let the page change the iPod. Must run straight from a click. Returns false when
 * the person said no, and throws a plain IpodAccessError when the iPod is not there at all.
 */
export async function allowWriting(root: DirectoryEntry): Promise<boolean> {
  const handle = root as unknown as PermissionHandle;
  if (handle.requestPermission) {
    let state: PermissionState;
    try {
      state = await handle.requestPermission({ mode: 'readwrite' });
    } catch (error) {
      if (classifyFsError(error) === 'disconnected') throw new IpodAccessError('disconnected', { cause: error });
      throw error;
    }
    if (state !== 'granted') return false;
  }
  await checkFolderAlive(root);
  return true;
}

export type ReconnectStep = 'use' | 'ask' | 'blocked';

/** What to do with a folder handle kept from an earlier visit, given what Chrome says about it. */
export function reconnectStep(state: PermissionState | undefined): ReconnectStep {
  if (state === 'granted') return 'use';
  if (state === 'denied') return 'blocked';
  return 'ask';
}

/**
 * Gets a kept folder handle ready to read. Must run straight from a click, because Chrome only
 * shows its permission question then. Resolves to 'granted', or 'denied' when the person says no
 * or Chrome has blocked the folder.
 */
export async function regainAccess(handle: unknown, mode: PermissionMode = 'read'): Promise<'granted' | 'denied'> {
  const target = handle as PermissionHandle;
  if (!target.queryPermission && !target.requestPermission) return 'granted';
  const now = target.queryPermission ? await target.queryPermission({ mode }) : 'prompt';
  if (reconnectStep(now) === 'use') return 'granted';
  if (!target.requestPermission) return 'denied';
  return (await target.requestPermission({ mode })) === 'granted' ? 'granted' : 'denied';
}
