import { useEffect, useState } from 'preact/hooks';
import { dismissFinished, estimateRemaining, formatRemaining, useActivity } from './activity';

const seconds = (since: number, now: number): string => {
  const total = Math.max(0, Math.floor((now - since) / 1000));
  return total < 60 ? `${total} s` : `${Math.floor(total / 60)} min ${String(total % 60).padStart(2, '0')} s`;
};

/**
 * Always visible under the top bar while anything runs: a spinner, what it is doing, how long it
 * has taken, and during a write, a plain warning not to unplug. After a write it says whether the
 * iPod is safe to eject.
 */
export function ActivityBar() {
  const { active, finished } = useActivity();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active.length) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active.length]);

  if (active.length) {
    const writing = active.some((item) => item.writes);
    const main = active[active.length - 1];
    if (!main) return null;
    const slow = now - main.startedAt > 30_000;
    return (
      <div class={`activity ${writing ? 'writing' : ''}`} role="status" aria-live="polite">
        <div class="activity-inner">
          <span class="spinner" aria-hidden="true" />
          <div class="activity-text">
            <strong>
              {main.label}
              <span class="activity-time"> · {seconds(main.startedAt, now)}</span>
            </strong>
            {main.message ? <span class="activity-step">{main.message}</span> : null}
            {main.fraction !== null ? (
              <>
                <progress class="activity-progress" max={1} value={main.fraction} aria-label="Progress" />
                <span class="activity-step activity-left">
                  {Math.round(main.fraction * 100)}% ·{' '}
                  {(() => {
                    const left = estimateRemaining(main, now);
                    return left === null ? 'working out the time left...' : formatRemaining(left);
                  })()}
                </span>
              </>
            ) : (
              <>
                <span class="activity-indeterminate" aria-hidden="true" />
                {now - main.startedAt > 10_000 ? <span class="activity-step">This step cannot say how long it will take.</span> : null}
              </>
            )}
            {writing ? (
              <span class="activity-warn">Do not unplug or eject the iPod, and do not close this tab, until this says it is done.</span>
            ) : null}
            {slow ? <span class="activity-step">Still working. Reading or writing an iPod over USB can be slow, especially from a phone. It has not stalled just because it takes a while.</span> : null}
          </div>
        </div>
      </div>
    );
  }

  if (finished) {
    return (
      <div class={`activity ${finished.ok ? 'done' : 'failed'}`} role={finished.ok ? 'status' : 'alert'}>
        <div class="activity-inner">
          <div class="activity-text">
            <strong>{finished.ok ? `Done: ${finished.label.toLowerCase()}.` : `Did not finish: ${finished.label.toLowerCase()}.`}</strong>
            {finished.ok ? (
              <span class="activity-step">Now eject the iPod from your computer before you unplug it.</span>
            ) : (
              <span class="activity-step">
                {finished.writes ? 'What was done has been undone where it could be. If the iPod looks wrong, restore the backup from the Backup tab. ' : ''}
                {finished.detail ?? ''}
              </span>
            )}
          </div>
          <button type="button" class="ghost small" onClick={dismissFinished}>
            Dismiss
          </button>
        </div>
      </div>
    );
  }
  return null;
}
