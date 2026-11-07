/** Progress reporting: keeps the number between 0 and 1, never backwards, and not too chatty. Pure. */

export type ProgressCallback = (fraction: number, message?: string) => void;

export interface Reporter {
  /** Report `fraction` (0 to 1) of the whole job. */
  report(fraction: number, message?: string): void;
  /** A reporter for one step that fills the stretch from `start` to `end` of the whole job. */
  range(start: number, end: number): Reporter;
}

/** Smallest step worth telling the page about, unless the message changes. */
const MIN_STEP = 0.005;

export function createReporter(callback?: ProgressCallback): Reporter {
  let last = -1;
  let lastMessage: string | undefined;

  const report = (fraction: number, message?: string): void => {
    if (!callback) return;
    const value = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
    if (value < last) return;
    if (value - last < MIN_STEP && message === lastMessage && value < 1) return;
    last = value;
    lastMessage = message;
    try {
      callback(value, message);
    } catch {
      // A page callback that throws must not stop the conversion.
    }
  };

  const make = (start: number, end: number): Reporter => ({
    report: (fraction, message) => report(start + (end - start) * Math.min(1, Math.max(0, fraction)), message),
    range: (innerStart, innerEnd) => make(start + (end - start) * innerStart, start + (end - start) * innerEnd),
  });

  return { report, range: (start, end) => make(start, end) };
}

/**
 * How far an ffmpeg step is, from its progress event. `timeMicros` is how much output has been
 * written, in microseconds. With a known length that is exact. Without one, ffmpeg's own ratio
 * is used when it is a sensible number.
 */
export function stepFraction(timeMicros: number, ratio: number, durationMs: number | null): number {
  if (durationMs !== null && durationMs > 0 && Number.isFinite(timeMicros) && timeMicros >= 0) {
    return Math.min(1, timeMicros / 1000 / durationMs);
  }
  return Number.isFinite(ratio) && ratio >= 0 && ratio <= 1 ? ratio : 0;
}
