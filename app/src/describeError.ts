import { BackupError, EngineError, IpodFolderError } from '@opentunes/engine';
import { EngineUnavailableError } from './engineLoader';
import { isStopped } from './stopped';

export { isStopped };

/** One plain sentence for whatever went wrong. */
export function describeError(error: unknown): string {
  if (error instanceof EngineUnavailableError || error instanceof IpodFolderError || error instanceof BackupError || error instanceof EngineError) {
    return error.message;
  }
  if (isStopped(error)) return 'Stopped. Nothing was changed.';
  if (error instanceof DOMException) {
    return `${error.name}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}
