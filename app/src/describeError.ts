import { BackupError, EngineError, IpodFolderError } from '@opentunes/engine';
import { EngineUnavailableError } from './engineLoader';
import { IpodAccessError, UNDONE_ADVICE, classifyFsError, plainFailure, problemMessage } from './friendlyError';

/**
 * One plain sentence for whatever went wrong. A browser error about the iPod's folder (it was
 * unplugged, permission was taken back, it is locked or full) is put in plain words. Pass
 * `writing` when the failed step changed the iPod, and the answer says what was undone.
 */
export function describeError(error: unknown, options: { writing?: boolean } = {}): string {
  const message = describeOnly(error);
  const iPodProblem = error instanceof IpodAccessError || classifyFsError(error) !== null;
  return options.writing && iPodProblem ? `${message} ${UNDONE_ADVICE}` : message;
}

function describeOnly(error: unknown): string {
  if (error instanceof IpodAccessError) return error.message;
  if (error instanceof EngineUnavailableError || error instanceof IpodFolderError || error instanceof BackupError || error instanceof EngineError) {
    return plainFailure(error.message);
  }
  const problem = classifyFsError(error);
  if (problem) return problemMessage(problem);
  if (error instanceof DOMException) {
    return `${error.name}: ${error.message}`;
  }
  return plainFailure(error instanceof Error ? error.message : String(error));
}
