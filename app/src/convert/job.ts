/**
 * Runs one job on its own ffmpeg instance and makes sure it always ends: with a result, with a
 * clear error, or with an AbortError when the caller cancels. Never a hang.
 *
 * Three things end a job early, and all of them terminate the worker:
 *  - the caller's AbortSignal,
 *  - a stall: ffmpeg printed nothing and made no progress for `stallTimeoutMs`. This matters
 *    because ffmpeg.wasm's worker has no crash handling: when it dies (for example reading back
 *    a result over 2 GiB, which was seen to give no answer at all) the promise just never settles,
 *  - the work itself failing.
 *
 * One instance per job is also how memory comes back. WebAssembly memory only grows, so the only
 * way to give it up is to end the worker.
 */

import type { Engine, EngineFactory } from './engine';
import { abortError, ConvertError, explainUnexpected, LogBuffer } from './errors';
import { createReporter, type ProgressCallback, type Reporter } from './progress';
import { STALL_TIMEOUT_MS } from './limits';

export interface JobOptions {
  signal?: AbortSignal;
  onProgress?: ProgressCallback;
  /** 0 turns the stall check off. Defaults to STALL_TIMEOUT_MS. */
  stallTimeoutMs?: number;
}

export interface JobContext {
  engine: Engine;
  /** The whole job's log, trimmed. Returned to the caller. */
  log: LogBuffer;
  /** The current step's log only, so an error shows (and is explained from) the step that failed. */
  step: LogBuffer;
  /** Starts a new step: clears `step`. */
  beginStep(): void;
  reporter: Reporter;
  /** Sets who hears ffmpeg's progress events. Pass null when no step is running. */
  onStepProgress(handler: ((timeMicros: number, ratio: number) => void) | null): void;
}

export async function runJob<T>(createEngine: EngineFactory, options: JobOptions, work: (context: JobContext) => Promise<T>): Promise<T> {
  const { signal } = options;
  if (signal?.aborted) throw abortError();

  const log = new LogBuffer();
  const step = new LogBuffer();
  const reporter = createReporter(options.onProgress);
  const stallMs = options.stallTimeoutMs ?? STALL_TIMEOUT_MS;

  let lastActivity = Date.now();
  let finished = false;
  let engine: Engine | null = null;
  let stepProgress: ((timeMicros: number, ratio: number) => void) | null = null;
  let ended!: (error: unknown) => void;
  const endedEarly = new Promise<never>((_, reject) => {
    ended = reject;
  });

  const onAbort = (): void => ended(abortError());
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer =
    stallMs > 0
      ? setInterval(() => {
          if (Date.now() - lastActivity > stallMs) {
            ended(new ConvertError('stalled', `The converter stopped responding (nothing for ${Math.round(stallMs / 1000)} seconds), so it was stopped. The file may be too large or damaged. Try again, or try a smaller file.`, log.text()));
          }
        }, Math.max(10, Math.min(5000, Math.floor(stallMs / 4))))
      : null;

  const main = (async (): Promise<T> => {
    try {
      reporter.report(0, 'Starting the converter');
      const created = await createEngine();
      if (finished) {
        // The job already ended (cancelled or stalled) while the converter was still loading.
        created.terminate();
        throw abortError();
      }
      engine = created;
      created.onLog((message) => {
        lastActivity = Date.now();
        log.push(message);
        step.push(message);
      });
      created.onProgress((timeMicros, ratio) => {
        lastActivity = Date.now();
        stepProgress?.(timeMicros, ratio);
      });
      lastActivity = Date.now();
      return await work({
        engine: created,
        log,
        step,
        beginStep: () => {
          step.clear();
          lastActivity = Date.now();
        },
        reporter,
        onStepProgress: (handler) => {
          stepProgress = handler;
        },
      });
    } catch (error) {
      // Callers get an AbortError or a ConvertError, never a raw browser or library error.
      throw error instanceof DOMException && error.name === 'AbortError' ? error : explainUnexpected(error, log.text());
    }
  })();
  // If the job ended some other way first, a later failure of `main` is expected and not news.
  main.catch(() => undefined);

  try {
    const result = await Promise.race([main, endedEarly]);
    reporter.report(1);
    return result;
  } finally {
    finished = true;
    if (timer) clearInterval(timer);
    signal?.removeEventListener('abort', onAbort);
    (engine as Engine | null)?.terminate();
  }
}
