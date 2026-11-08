/**
 * Notices when the tab goes to the background while a job runs. Chrome on Android freezes a
 * background tab, and a frozen tab in the middle of a write is the one thing the page cannot
 * survive, so the person is told when they come back, and the tab title says a job is running.
 */

export interface VisibilityDocument {
  visibilityState: string;
  title: string;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

export interface BackgroundWatch {
  /** Start watching. Returns the stop function. */
  start(): () => void;
  /** How long the tab was hidden during this watch, in milliseconds, or 0. */
  hiddenMs(): number;
  wasHidden(): boolean;
}

export function watchBackground(doc: VisibilityDocument | undefined, now: () => number = Date.now, onChange: () => void = () => undefined): BackgroundWatch {
  let hiddenAt: number | null = null;
  let total = 0;
  let was = false;
  const listener = (): void => {
    if (doc?.visibilityState === 'hidden') {
      hiddenAt = now();
      was = true;
    } else if (hiddenAt !== null) {
      total += now() - hiddenAt;
      hiddenAt = null;
    }
    onChange();
  };
  return {
    start() {
      hiddenAt = null;
      total = 0;
      was = false;
      if (doc?.visibilityState === 'hidden') {
        hiddenAt = now();
        was = true;
      }
      doc?.addEventListener('visibilitychange', listener);
      return () => doc?.removeEventListener('visibilitychange', listener);
    },
    hiddenMs: () => total + (hiddenAt !== null ? now() - hiddenAt : 0),
    wasHidden: () => was,
  };
}
