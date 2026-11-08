/**
 * Keeps the screen on during a long job, so a phone does not lock and freeze the tab in the middle
 * of a change. The browser drops the lock whenever the tab is hidden, so it is asked for again when
 * the tab is visible again. Everything is optional: a browser or a battery saver that refuses just
 * means the page says "keep the screen on yourself".
 */

export interface SentinelLike {
  released?: boolean;
  release(): Promise<void>;
  addEventListener(type: 'release', listener: () => void): void;
}

export interface WakeNavigator {
  wakeLock?: { request(type: 'screen'): Promise<SentinelLike> };
}

export interface WakeDocument {
  visibilityState: string;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

export type WakeStatus = 'off' | 'held' | 'unsupported' | 'refused';

export interface WakeHandle {
  /** Starts wanting the lock. Counts, so two jobs need two releases. */
  acquire(): Promise<void>;
  release(): Promise<void>;
  status(): WakeStatus;
}

export function createWakeLock(nav: WakeNavigator | undefined, doc: WakeDocument | undefined, onChange: (status: WakeStatus) => void = () => undefined): WakeHandle {
  let wanted = 0;
  let sentinel: SentinelLike | null = null;
  let current: WakeStatus = 'off';
  let listening = false;

  const set = (next: WakeStatus): void => {
    if (next !== current) {
      current = next;
      onChange(next);
    }
  };

  async function request(): Promise<void> {
    if (!nav?.wakeLock) {
      set('unsupported');
      return;
    }
    if (sentinel && !sentinel.released) return;
    if (doc && doc.visibilityState !== 'visible') return; // asked for again when it is visible
    try {
      const got = await nav.wakeLock.request('screen');
      if (wanted === 0) {
        await got.release().catch(() => undefined);
        return;
      }
      sentinel = got;
      got.addEventListener('release', () => {
        if (sentinel === got) sentinel = null;
        if (wanted > 0) set('refused');
      });
      set('held');
    } catch {
      set('refused');
    }
  }

  const onVisible = (): void => {
    if (wanted > 0 && doc?.visibilityState === 'visible') void request();
  };

  return {
    async acquire() {
      wanted += 1;
      if (!listening && doc) {
        doc.addEventListener('visibilitychange', onVisible);
        listening = true;
      }
      if (wanted === 1) await request();
    },
    async release() {
      wanted = Math.max(0, wanted - 1);
      if (wanted > 0) return;
      if (listening && doc) {
        doc.removeEventListener('visibilitychange', onVisible);
        listening = false;
      }
      const held = sentinel;
      sentinel = null;
      set('off');
      try {
        await held?.release();
      } catch {
        // already released by the browser
      }
    },
    status: () => current,
  };
}
