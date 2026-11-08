/**
 * The safety net for errors nobody caught: a script error or a promise that failed with no
 * handler. Instead of silence, a small notice says "Something went wrong" in plain words and
 * offers a report to copy. The report holds the plain message, what the page was doing and the
 * time. No track titles, no serial numbers or IDs (masked), no stack of file names.
 */
import { useEffect, useState } from 'preact/hooks';
import { currentActivity } from './activity';
import { describeError } from './describeError';
import { logError, maskSecrets } from './log';

export interface Notice {
  id: number;
  at: number;
  /** One plain sentence. */
  message: string;
  /** Where it came from: error, promise or a panel. */
  source: string;
  report: string;
}

/** Messages the browser raises that mean nothing went wrong. */
export function shouldIgnore(message: string, error: unknown): boolean {
  if (/ResizeObserver loop/i.test(message)) return true;
  if (error instanceof DOMException && error.name === 'AbortError') return true; // a cancelled folder picker or request
  return false;
}

export function buildReport(input: { message: string; name: string; source: string; at: number; doing: string[]; browser: string }): string {
  return JSON.stringify(
    {
      app: 'opentunes',
      view: 'error-report',
      generatedAt: new Date(input.at).toISOString(),
      source: input.source,
      problem: maskSecrets(input.message),
      kind: input.name,
      wasDoing: input.doing.map((label) => maskSecrets(label)),
      browser: input.browser,
    },
    null,
    2,
  );
}

let nextId = 1;
let notices: Notice[] = [];
let lastKey = '';
let lastAt = 0;
const listeners = new Set<() => void>();
const emit = (): void => listeners.forEach((listener) => listener());
const MAX_SHOWN = 3;

/** Shows a notice for an error. A repeat of the same message within three seconds is dropped. */
export function reportProblem(error: unknown, source = 'error', now = Date.now()): void {
  const message = maskSecrets(describeError(error));
  if (shouldIgnore(message, error)) return;
  if (message === lastKey && now - lastAt < 3000) return;
  lastKey = message;
  lastAt = now;
  logError(source, `Something went wrong: ${message}`);
  const name = error instanceof Error ? error.name : typeof error;
  const doing = currentActivity().active.map((item) => item.label);
  const browser = typeof navigator === 'undefined' ? 'unknown' : (navigator.userAgent.match(/(Chrome|Edg|Chromium)\/\d+/)?.[0] ?? 'unknown');
  notices = [...notices, { id: nextId++, at: now, message, source, report: buildReport({ message, name, source, at: now, doing, browser }) }].slice(-MAX_SHOWN);
  emit();
}

export function dismissNotice(id: number): void {
  notices = notices.filter((notice) => notice.id !== id);
  emit();
}

export function currentNotices(): Notice[] {
  return notices;
}

/** For tests. */
export function resetNotices(): void {
  notices = [];
  lastKey = '';
  lastAt = 0;
  emit();
}

let installed = false;

/** Listens for errors and unhandled rejections for the life of the page. Safe to call twice. */
export function installGlobalErrorHandlers(target: Pick<Window, 'addEventListener'> = window): void {
  if (installed) return;
  installed = true;
  target.addEventListener('error', (event) => {
    const failure = (event as ErrorEvent).error ?? (event as ErrorEvent).message;
    if (failure === 'Script error.' || failure === undefined || failure === '') return; // cross-origin noise with no detail
    reportProblem(failure, 'error');
  });
  target.addEventListener('unhandledrejection', (event) => {
    reportProblem((event as PromiseRejectionEvent).reason, 'promise');
  });
}

export function useNotices(): Notice[] {
  const [, setTick] = useState(0);
  useEffect(() => {
    const listener = (): void => setTick((tick) => tick + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return notices;
}
