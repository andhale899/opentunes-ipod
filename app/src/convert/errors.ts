/**
 * Errors, the ffmpeg log buffer, and turning ffmpeg's last words into a plain sentence.
 * Pure, no worker and no wasm.
 */

export type ConvertFailure = 'input' | 'memory' | 'limit' | 'stalled' | 'spec' | 'ffmpeg';

/** What every failed conversion throws (a cancel throws an AbortError instead). */
export class ConvertError extends Error {
  readonly reason: ConvertFailure;
  /** The ffmpeg log, trimmed to the most recent lines. */
  readonly log: string;

  constructor(reason: ConvertFailure, message: string, log = '') {
    super(message);
    this.name = 'ConvertError';
    this.reason = reason;
    this.log = log;
  }
}

/**
 * Turns anything that is not already a ConvertError into one with a plain message. Browser and
 * library errors ("NotReadableError: Failed to execute 'readAsArrayBuffer' on 'FileReaderSync'")
 * are not something to show a person.
 */
export function explainUnexpected(error: unknown, log = ''): ConvertError {
  if (error instanceof ConvertError) return error;
  const message = error instanceof Error ? `${error.name === 'Error' ? '' : `${error.name}: `}${error.message}` : String(error);
  if (/NotReadableError|NotFoundError|could not be read, typically/i.test(message)) {
    return new ConvertError('input', 'The file could not be read. It may have been moved, deleted or changed after it was picked, or it is too large for this browser to read.', log);
  }
  if (/allocation failed|out of memory|Invalid array length|Aborted\(OOM\)/i.test(message)) {
    return new ConvertError('memory', 'The converter ran out of memory. Close other tabs and try again, or convert a smaller or shorter file.', log);
  }
  return new ConvertError('ffmpeg', `The converter hit an unexpected problem: ${message}`, log);
}

/** The error for a cancelled job. Same shape as `fetch` uses, so callers can test `error.name === 'AbortError'`. */
export function abortError(): DOMException {
  return new DOMException('The conversion was cancelled.', 'AbortError');
}

const STATS_LINE = /^\s*(frame|size|Lsize)\s*=/;

/**
 * Keeps ffmpeg's log without letting it grow without limit. ffmpeg prints a progress line twice
 * a second, so only the latest one is kept, and only the last `maxLines` other lines.
 */
export class LogBuffer {
  private lines: string[] = [];
  private stats = '';
  private readonly maxLines: number;

  constructor(maxLines = 400) {
    this.maxLines = maxLines;
  }

  push(message: string): void {
    for (const piece of message.split(/\r?\n|\r/)) {
      if (piece.trim() === '') continue;
      if (STATS_LINE.test(piece)) {
        this.stats = piece.trim();
        continue;
      }
      this.lines.push(piece);
      if (this.lines.length > this.maxLines) this.lines.splice(0, this.lines.length - this.maxLines);
    }
  }

  /** Forget everything. Used between steps so an error shows only its own step's log. */
  clear(): void {
    this.lines = [];
    this.stats = '';
  }

  text(): string {
    return [...this.lines, ...(this.stats ? [this.stats] : [])].join('\n');
  }

  /** The last few lines that say something (no progress line, no "Aborted()" noise). */
  tail(count = 8): string {
    return this.lines.filter((line) => !/^Aborted\(\)?$/.test(line.trim())).slice(-count).join('\n');
  }
}

/** A plain sentence for what ffmpeg's log says went wrong. */
export function explainFailure(log: string, exitCode: number | null): { reason: ConvertFailure; sentence: string } {
  if (/Aborted\(OOM\)|\bOOM\b|out of memory|Cannot enlarge memory|memory access out of bounds|Array buffer allocation failed/i.test(log)) {
    return { reason: 'memory', sentence: 'The converter ran out of memory. Close other tabs and try again, or convert a smaller or shorter file.' };
  }
  if (/matches no streams|does not contain any stream|Output file is empty/i.test(log)) {
    return { reason: 'input', sentence: 'The file does not have the kind of audio or video that was asked for.' };
  }
  if (/Invalid data found when processing input|moov atom not found|Error while decoding stream|could not find codec parameters/i.test(log)) {
    return { reason: 'input', sentence: 'ffmpeg could not read this file. It may be damaged, cut short, or not a media file.' };
  }
  if (/Unsupported sample rate|Unsupported channel layout|Invalid sample rate|bit_rate too high/i.test(log)) {
    return { reason: 'ffmpeg', sentence: 'The audio settings could not be used with this file.' };
  }
  return { reason: 'ffmpeg', sentence: exitCode === null ? 'ffmpeg stopped without finishing.' : `ffmpeg could not convert this file (it stopped with code ${exitCode}).` };
}

/**
 * Builds the error for a failed ffmpeg step: a plain sentence, then the last lines of the log.
 * The sentence is worked out from `step` only (the step that failed), while the error carries
 * the whole job's log (`whole`, which defaults to the step's).
 */
export function failureError(step: LogBuffer, exitCode: number | null, context = '', whole: LogBuffer = step): ConvertError {
  const { reason, sentence } = explainFailure(step.text(), exitCode);
  const tail = step.tail();
  const lead = context ? `${context}: ${sentence}` : sentence;
  return new ConvertError(reason, tail ? `${lead}\n\nLast lines of the ffmpeg log:\n${tail}` : lead, whole.text());
}
