/**
 * Lets a person pause a job that works through files, and resume it, without losing its place.
 *
 * A job's workers call `checkpoint()` between files, never in the middle of one. While a pause is
 * asked for, a worker that reaches a checkpoint waits there until `resume()` or until the job is
 * stopped through its AbortSignal. A file that is already being copied is finished first, so a
 * pause never leaves a half-written file.
 */
export type PauseState = 'running' | 'pausing' | 'paused';

export class PauseGate {
  #wanted = false;
  #workers = 0;
  #parked = 0;
  readonly #waiters = new Set<() => void>();
  readonly #listeners = new Set<() => void>();

  /** `running`, `pausing` (asked for, still finishing files) or `paused` (every worker is waiting). */
  get state(): PauseState {
    if (!this.#wanted) return 'running';
    return this.#workers > 0 && this.#parked >= this.#workers ? 'paused' : 'pausing';
  }

  /** Asks the job to wait after the files it is on. */
  request(): void {
    if (this.#wanted) return;
    this.#wanted = true;
    this.#notify();
  }

  /** Lets the waiting workers carry on. */
  resume(): void {
    if (!this.#wanted) return;
    this.#wanted = false;
    for (const wake of [...this.#waiters]) wake();
    this.#notify();
  }

  /** The job calls this once for each worker it starts, and `leave` when that worker ends. */
  join(): void {
    this.#workers += 1;
  }

  leave(): void {
    this.#workers = Math.max(0, this.#workers - 1);
    this.#notify();
  }

  /** Waits here while a pause is asked for. Returns at once when it is not. */
  async checkpoint(signal?: AbortSignal): Promise<void> {
    while (this.#wanted && !signal?.aborted) {
      this.#parked += 1;
      this.#notify();
      await new Promise<void>((resolve) => {
        const wake = (): void => {
          signal?.removeEventListener('abort', wake);
          this.#waiters.delete(wake);
          resolve();
        };
        this.#waiters.add(wake);
        signal?.addEventListener('abort', wake, { once: true });
      });
      this.#parked -= 1;
    }
  }

  /** Calls `listener` whenever `state` may have changed. Returns a function that stops listening. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}
