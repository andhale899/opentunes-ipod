/**
 * True when an error is the person pressing Stop: the browser's own AbortError, which every
 * engine function throws when it is stopped before it has written anything. A stop is not a failure.
 */
export function isStopped(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}
