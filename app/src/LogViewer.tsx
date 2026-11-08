import { useEffect, useRef, useState } from 'preact/hooks';
import { formatLog, log, logStep, type LogEntry, type LogLevel } from './log';

const ICONS: Record<LogLevel, { mark: string; word: string }> = {
  ok: { mark: '✓', word: 'Done' },
  step: { mark: '…', word: 'Step' },
  error: { mark: '✕', word: 'Error' },
};

const time = (at: number): string => new Date(at).toLocaleTimeString([], { hour12: false });

function useLogEntries(): LogEntry[] {
  const [, setTick] = useState(0);
  useEffect(() => log().subscribe(() => setTick((tick) => tick + 1)), []);
  return log().entries();
}

const stamp = (): string => {
  const now = new Date();
  const two = (value: number): string => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}`;
};

/**
 * A small button in the corner that opens a drawer listing what the app has been doing, so a
 * stuck-looking job can be told from a quiet one, and so the last lines survive a reload. The log
 * stays in this browser and never leaves it unless the person copies or downloads it.
 */
export function LogViewer() {
  const entries = useLogEntries();
  const [open, setOpen] = useState(false);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [note, setNote] = useState('');
  const button = useRef<HTMLButtonElement | null>(null);
  const closeButton = useRef<HTMLButtonElement | null>(null);
  const list = useRef<HTMLOListElement | null>(null);
  const stuck = useRef(true);

  const shown = errorsOnly ? entries.filter((entry) => entry.level === 'error') : entries;
  const unseen = log().unseenErrors();

  function close(): void {
    setOpen(false);
    setNote('');
    // Back to the button that opened it, so a keyboard user is where they were.
    window.setTimeout(() => button.current?.focus(), 0);
  }

  function toggle(): void {
    if (open) close();
    else {
      setOpen(true);
      log().markSeen();
    }
  }

  useEffect(() => {
    if (open) closeButton.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  // New lines scroll into view, unless the person has scrolled up to read.
  useEffect(() => {
    const element = list.current;
    if (open && element && stuck.current) element.scrollTop = element.scrollHeight;
    if (open) log().markSeen();
  });

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(formatLog(shown));
      setNote('Copied.');
      logStep('page', 'The log was copied.');
    } catch {
      setNote('Copy failed. Use Download instead.');
    }
  }

  function download(): void {
    try {
      const blob = new Blob([formatLog(shown)], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `opentunes-log-${stamp()}.txt`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setNote('Downloaded.');
      logStep('page', 'The log was downloaded.');
    } catch {
      setNote('The download did not work.');
    }
  }

  function clear(): void {
    log().clear();
    setNote('Cleared.');
  }

  return (
    <>
      <button
        ref={button}
        type="button"
        class={`log-button ${unseen ? 'has-errors' : ''}`}
        aria-expanded={open}
        aria-controls="log-panel"
        onClick={toggle}
        title="See what the app has been doing"
      >
        Logs
        {unseen ? (
          <span class="log-dot" aria-label={`${unseen} new error${unseen === 1 ? '' : 's'}`}>
            {unseen > 9 ? '9+' : unseen}
          </span>
        ) : null}
      </button>
      {open ? (
        <section id="log-panel" class="log-panel" role="dialog" aria-label="What the app has been doing">
          <header class="log-head">
            <h2>Logs</h2>
            <button ref={closeButton} type="button" class="ghost small" onClick={close} aria-label="Close the log">
              Close
            </button>
          </header>
          <p class="log-note">This log stays in your browser. It may contain file names, so look through it before you share it.</p>
          <div class="log-tools">
            <label class="check">
              <input type="checkbox" checked={errorsOnly} onChange={() => setErrorsOnly(!errorsOnly)} />
              Errors only
            </label>
            <button type="button" class="secondary small" onClick={() => void copy()}>
              Copy log
            </button>
            <button type="button" class="secondary small" onClick={download}>
              Download log (.txt)
            </button>
            <button type="button" class="ghost small" onClick={clear}>
              Clear
            </button>
            <span class="note" role="status">
              {note}
            </span>
          </div>
          <ol
            class="log-list"
            ref={list}
            tabIndex={0}
            aria-label="Log entries, newest at the bottom"
            onScroll={(event) => {
              const element = event.currentTarget as HTMLOListElement;
              stuck.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
            }}
          >
            {shown.length === 0 ? <li class="log-empty">{errorsOnly ? 'No errors.' : 'Nothing yet.'}</li> : null}
            {shown.map((entry) => (
              <li key={entry.id} class={`log-entry log-${entry.level} ${entry.before ? 'log-before' : ''}`}>
                <span class="log-mark" aria-hidden="true">
                  {ICONS[entry.level].mark}
                </span>
                <span class="log-time">{time(entry.at)}</span>
                <span class="log-text">
                  <span class="sr-only">{ICONS[entry.level].word}: </span>
                  {entry.before ? <em class="log-tag">before the reload </em> : null}
                  {entry.text}
                </span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </>
  );
}
