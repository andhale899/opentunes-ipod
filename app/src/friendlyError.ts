/**
 * Plain words for what the browser says when the iPod's folder stops answering. Chrome's own
 * messages ("A requested file or directory could not be found at the time an operation was
 * processed") mean nothing to most people, and they all come down to a few real causes: the iPod
 * was unplugged or ejected, the page lost permission, the iPod is locked or read-only, or it is full.
 * Pure functions, tested without a browser. The wording has been checked against what Chrome
 * documents, not against a real unplugged iPod.
 */

export type FsProblem = 'disconnected' | 'permission' | 'readonly' | 'full' | 'cancelled';

export const DISCONNECTED = 'The iPod was disconnected. Plug it in, then use Reconnect.';

const MESSAGES: Record<FsProblem, string> = {
  disconnected: DISCONNECTED,
  permission: 'Chrome did not allow that. If it was the iPod folder, use Reconnect and allow access when Chrome asks.',
  readonly: 'The iPod would not accept a change. It may be locked, mounted read-only, or being used by another program. Eject it, plug it in again, then use Reconnect.',
  full: 'The iPod is full, so nothing more can be written to it.',
  cancelled: 'It was stopped.',
};

export const problemMessage = (problem: FsProblem): string => MESSAGES[problem];

const NAMES: Record<string, FsProblem> = {
  NotFoundError: 'disconnected',
  NotReadableError: 'disconnected',
  NotAllowedError: 'permission',
  SecurityError: 'permission',
  NoModificationAllowedError: 'readonly',
  InvalidModificationError: 'readonly',
  QuotaExceededError: 'full',
  AbortError: 'cancelled',
};

/** Chrome's wording, as it appears inside other messages. Each gets a plain replacement. */
const RAW: [RegExp, FsProblem][] = [
  [/A requested file or directory could not be found at the time an operation was processed\.?/i, 'disconnected'],
  [/The requested file could not be read, typically due to permission problems that have occurred after a reference to a file was acquired\.?/i, 'disconnected'],
  [/The state cached in an interface object was changed since it was read from disk\.?/i, 'disconnected'],
  [/An operation that depends on state cached in an interface object was made but the state had changed since it was read from disk\.?/i, 'disconnected'],
  [/\bNotAllowedError\b[^.]*\.?/, 'permission'],
  [/A requested file or directory could not be modified[^.]*\.?/i, 'readonly'],
  [/\bNoModificationAllowedError\b[^.]*\.?/, 'readonly'],
  [/\bQuotaExceededError\b[^.]*\.?|No space left on device|not enough space on the disk/i, 'full'],
];

const lower = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1);

/** The cause of a DOMException (or an Error named like one), or null when it is something else. */
export function classifyFsError(error: unknown): FsProblem | null {
  if (!(error instanceof Error) && !(typeof DOMException !== 'undefined' && error instanceof DOMException)) return null;
  const { name, message } = error as { name?: unknown; message?: unknown };
  // InvalidStateError is also used elsewhere, so only the folder wording counts.
  if (name === 'InvalidStateError') return /state cached in an interface object/i.test(String(message ?? '')) ? 'disconnected' : null;
  return NAMES[String(name ?? '')] ?? null;
}

/** An error that already carries a plain message, so callers can show it untouched. */
export class IpodAccessError extends Error {
  readonly problem: FsProblem;
  constructor(problem: FsProblem, options?: { cause?: unknown }) {
    super(MESSAGES[problem], options);
    this.name = 'IpodAccessError';
    this.problem = problem;
  }
}

/**
 * Replaces Chrome's raw wording inside one line of a report with plain words, keeping the original
 * in brackets so nothing is hidden. A line that holds none of it comes back unchanged.
 */
export function plainFailure(line: string): string {
  for (const [pattern, problem] of RAW) {
    const match = pattern.exec(line);
    if (match) return `${line.slice(0, match.index)}${lower(MESSAGES[problem])}${line.slice(match.index + match[0].length)} (Chrome said: ${match[0].replace(/\.$/, '')})`;
  }
  return line;
}

export const plainFailures = (lines: string[]): string[] => lines.map(plainFailure);

/** What to add to a message when the failed step was a change to the iPod. */
export const UNDONE_ADVICE = 'The change was undone where it could be. If the iPod looks wrong, your backup can restore the rest: open the Backup tab.';
