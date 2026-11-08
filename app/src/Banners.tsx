import { useState } from 'preact/hooks';
import { dismissNotice, useNotices } from './errors';
import { bannerText, dismissJournal, useJournal } from './journal';
import { logStep } from './log';

/**
 * A change to the iPod that never finished, found from the note kept in this browser. Calm on
 * purpose: nothing says the iPod is broken, only that it should be looked at.
 */
export function JournalBanner({ onGoToBackup }: { onGoToBackup: () => void }) {
  const { entry, inFlight } = useJournal();
  if (!entry || inFlight) return null;
  return (
    <div class="callout warn journal-banner" role="status">
      <p>
        <strong>{bannerText(entry, Date.now())}</strong>
      </p>
      {entry.backup ? <p class="muted">Your backup from before that change is in the folder "{entry.backup}".</p> : <p class="muted">No backup was recorded before that change.</p>}
      <div class="actions">
        <button type="button" class="secondary small" onClick={onGoToBackup}>
          Take me to Backup
        </button>
        <button type="button" class="ghost small" onClick={() => void dismissJournal()}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

/** Small, non-blocking notices for errors nobody caught, each with a report to copy. */
export function ErrorNotices() {
  const notices = useNotices();
  const [copied, setCopied] = useState<number | null>(null);
  if (!notices.length) return null;

  async function copy(id: number, report: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(report);
      setCopied(id);
      logStep('page', 'An error report was copied.');
    } catch {
      setCopied(-id);
    }
  }

  return (
    <div class="notices" aria-live="polite">
      {notices.map((notice) => (
        <div key={notice.id} class="notice" role="status">
          <div class="notice-text">
            <strong>Something went wrong.</strong> {notice.message}
          </div>
          <div class="notice-actions">
            <button type="button" class="secondary small" onClick={() => void copy(notice.id, notice.report)}>
              {copied === notice.id ? 'Copied' : copied === -notice.id ? 'Copy failed' : 'Copy report'}
            </button>
            <button type="button" class="ghost small" onClick={() => dismissNotice(notice.id)}>
              Dismiss
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
