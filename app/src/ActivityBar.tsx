import { useEffect, useState } from 'preact/hooks';
import { dismissFinished, estimateRemaining, formatRemaining, requestStop, togglePause, useActivity, type Activity } from './activity';

const seconds = (since: number, now: number): string => {
  const total = Math.max(0, Math.floor((now - since) / 1000));
  return total < 60 ? `${total} s` : `${Math.floor(total / 60)} min ${String(total % 60).padStart(2, '0')} s`;
};

/** Pause and Stop for the job in the bar. Stop says what it does, and asks first when it undoes something. */
function Controls({ item }: { item: Activity }) {
  const [asking, setAsking] = useState(false);
  const { stop, pause } = item;
  if (!stop && pause === null) return null;
  // The question goes away if the part that can be stopped ends while it is open.
  const question = asking && stop !== null && stop.confirm !== null && stop.blocked === null && !stop.requested;
  return (
    <div class="activity-controls">
      {question && stop ? (
        <>
          <span class="activity-step" role="alert">
            {stop.confirm}
          </span>
          <div class="activity-buttons">
            <button type="button" class="danger small" onClick={() => { setAsking(false); requestStop(item.id); }}>
              Yes, stop
            </button>
            <button type="button" class="secondary small" onClick={() => setAsking(false)}>
              Keep going
            </button>
          </div>
        </>
      ) : (
        <>
          <div class="activity-buttons">
            {pause !== null ? (
              <button type="button" class="secondary small" disabled={stop?.requested === true} onClick={() => togglePause(item.id)}>
                {pause === 'running' ? 'Pause after this file' : pause === 'pausing' ? 'Cancel the pause' : 'Resume'}
              </button>
            ) : null}
            {stop && !stop.requested ? (
              <button
                type="button"
                class="secondary small"
                disabled={stop.blocked !== null}
                aria-describedby={stop.blocked !== null ? `stop-why-${item.id}` : undefined}
                onClick={() => (stop.confirm !== null ? setAsking(true) : requestStop(item.id))}
              >
                {stop.label}
              </button>
            ) : null}
          </div>
          {stop?.requested ? <span class="activity-step">{stop.stopping}</span> : null}
          {stop && !stop.requested && stop.blocked !== null ? (
            <span class="activity-step" id={`stop-why-${item.id}`}>
              {stop.blocked}
            </span>
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * Always visible under the top bar while anything runs: a spinner, what it is doing, how long it
 * has taken, and during a write, a plain warning not to unplug. Jobs that can be stopped or paused
 * show those buttons here, so they are still in reach after a tab change. After a write it says
 * whether the iPod is safe to eject.
 */
export function ActivityBar() {
  const { active, finished, wake, wasHidden, hiddenMs } = useActivity();
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
    const paused = main.pause === 'paused';
    const pausing = main.pause === 'pausing';
    return (
      <div class={`activity ${writing ? 'writing' : ''} ${paused ? 'paused' : ''}`}>
        <div class="activity-inner">
          <span class={paused ? 'pause-mark' : 'spinner'} aria-hidden="true">
            {paused ? '❚❚' : ''}
          </span>
          <div class="activity-text">
            <div class="activity-live" role="status" aria-live="polite">
              <strong>
                {paused ? `Paused: ${main.label}` : main.label}
                <span class="activity-time" aria-hidden="true"> · {seconds(main.startedAt, now)}</span>
              </strong>
              {paused ? <span class="activity-step">Paused after the last file. Nothing more is copied until you press Resume.</span> : null}
              {pausing ? <span class="activity-step">Pausing after the files being copied now...</span> : null}
              {main.message && !paused ? <span class="activity-step">{main.message}</span> : null}
              {writing ? (
                <span class="activity-warn">
                  {paused ? 'The iPod is still in the middle of a change. ' : ''}Do not unplug or eject the iPod, and do not close this tab, until this says it is done. Keep this tab open and the screen on.
                </span>
              ) : null}
              {wasHidden ? (
                <span class="activity-warn">
                  This tab was in the background for {Math.max(1, Math.round(hiddenMs / 1000))} s while this runs. Chrome on a phone can freeze a background tab, which stops the work. Keep this tab open and the screen on.
                </span>
              ) : null}
              {!writing && !wasHidden && (wake === 'unsupported' || wake === 'refused') ? (
                <span class="activity-step">This browser would not keep the screen awake. Keep it on yourself until this is done.</span>
              ) : null}
              {slow && !paused ? <span class="activity-step">Still working. Reading or writing an iPod over USB can be slow, especially from a phone. It has not stalled just because it takes a while.</span> : null}
            </div>
            {main.fraction !== null ? (
              <>
                <progress class="activity-progress" max={1} value={main.fraction} aria-label="Progress" />
                <span class="activity-step activity-left">
                  {Math.round(main.fraction * 100)}% ·{' '}
                  {paused
                    ? 'paused'
                    : (() => {
                        const left = estimateRemaining(main, now);
                        return left === null ? 'working out the time left...' : formatRemaining(left);
                      })()}
                </span>
              </>
            ) : (
              <>
                <span class="activity-indeterminate" aria-hidden="true" />
                {now - main.startedAt > 10_000 && !paused ? <span class="activity-step">This step cannot say how long it will take.</span> : null}
              </>
            )}
            <Controls item={main} key={main.id} />
          </div>
        </div>
      </div>
    );
  }

  if (finished) {
    const tone = finished.stopped ? 'stopped' : finished.ok ? 'done' : 'failed';
    return (
      <div class={`activity ${tone}`} role={finished.ok ? 'status' : 'alert'}>
        <div class="activity-inner">
          <div class="activity-text">
            <strong>
              {finished.stopped ? `Stopped: ${finished.label.toLowerCase()}.` : finished.ok ? `Done: ${finished.label.toLowerCase()}.` : `Did not finish: ${finished.label.toLowerCase()}.`}
            </strong>
            {finished.stopped ? (
              <span class="activity-step">
                {finished.detail ?? ''}
                {finished.writes ? ' It is safe to eject the iPod.' : ' The iPod itself was not changed.'}
              </span>
            ) : finished.ok ? (
              <span class="activity-step">{finished.writes ? 'Now eject the iPod from your computer before you unplug it.' : (finished.note ?? '')}</span>
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
