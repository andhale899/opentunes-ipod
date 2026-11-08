import { useRef, useState } from 'preact/hooks';
import { formatBytes } from '@opentunes/core';
import { type BackupReport, type DirectoryEntry, type IpodRoot, type WriteBackPlan, type WriteBackReport } from '@opentunes/engine';
import { applyWriteBack, planWriteBack } from './tracked';
import { Notice, useOnce } from './controls';
import { describeError, isStopped } from './describeError';
import { newEngine } from './engineLoader';

type State =
  | { phase: 'idle' }
  | { phase: 'working'; message: string }
  | { phase: 'planned'; plan: WriteBackPlan }
  | { phase: 'done'; report: WriteBackReport }
  | { phase: 'error'; message: string };

type Permission = { requestPermission?: (descriptor: { mode: 'readwrite' }) => Promise<string> };

/** Asks Chrome to let the page change the iPod. Must run straight from a click. */
export async function allowWriting(root: DirectoryEntry): Promise<boolean> {
  const handle = root as unknown as Permission;
  return !handle.requestPermission || (await handle.requestPermission({ mode: 'readwrite' })) === 'granted';
}

/**
 * The first step that changes an iPod: writes the database libgpod rebuilds, with no new songs,
 * back to it, to see whether the iPod accepts it. Planning only reads. Writing needs the backup
 * from this session, and puts every file back if anything goes wrong.
 */
export function WriteBackPanel({ root, backup }: { root: DirectoryEntry; backup: BackupReport | null }) {
  const [state, setState] = useState<State>({ phase: 'idle' });
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  const ready = backup !== null && backup.complete;
  const once = useOnce();
  const stopper = useRef<AbortController | null>(null);

  async function prepare() {
    await once(async () => {
      setCopied('idle');
      const controller = new AbortController();
      stopper.current = controller;
      setState({ phase: 'working', message: 'Loading the engine...' });
      try {
        const plan = await planWriteBack(root as unknown as IpodRoot, newEngine, { signal: controller.signal, onProgress: (message) => setState({ phase: 'working', message }) });
        setState({ phase: 'planned', plan });
      } catch (error) {
        setState({ phase: 'error', message: isStopped(error) ? 'Stopped. Nothing was written to the iPod.' : describeError(error) });
      } finally {
        stopper.current = null;
      }
    });
  }

  function write(plan: WriteBackPlan): Promise<void> {
    return once(() => writeNow(plan)) as Promise<void>;
  }

  async function writeNow(plan: WriteBackPlan) {
    try {
      if (!(await allowWriting(root))) {
        setState({ phase: 'error', message: 'Chrome was not allowed to change the iPod, so nothing was written.' });
        return;
      }
      setState({ phase: 'working', message: 'Writing to the iPod...' });
      const report = await applyWriteBack(plan, root as unknown as IpodRoot, newEngine, { backup, onProgress: (message) => setState({ phase: 'working', message }) });
      setState({ phase: 'done', report });
    } catch (error) {
      setState({ phase: 'error', message: describeError(error) });
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied('copied');
    } catch {
      setCopied('failed');
    }
  }

  const working = state.phase === 'working';

  return (
    <section class="card">
      <h3>Test: write the library back to the iPod</h3>
      <p class="card-lead">
        Writes the library back to the iPod, rebuilt but with no new songs, to see whether the iPod accepts it. Only files in iPod_Control/iTunes are written, never music. It needs the backup from the Backup tab first. If anything fails while writing, the original files are put back. The only file removed is Play Counts, which libgpod folds into the library and keeps as Play Counts.bak.
      </p>
      <div class="actions">
        <button type="button" onClick={() => void prepare()} disabled={working || !ready}>
          Check what would be written
        </button>
        {working && stopper.current ? (
          <button type="button" class="secondary" onClick={() => stopper.current?.abort()}>
            Stop (nothing is written)
          </button>
        ) : null}
      </div>
      {!ready ? <p class="muted">Make the backup in the Backup tab first. Nothing can be written until a complete backup has been made on this page.</p> : null}

      {state.phase === 'working' ? (
        <p class="note" role="status">
          {state.message}
          {state.message === 'Writing to the iPod...' ? ' This cannot be stopped safely. It takes a few seconds.' : ''}
        </p>
      ) : null}
      {state.phase === 'error' ? (
        <Notice tone="no">
          <p>{state.message}</p>
        </Notice>
      ) : null}

      {state.phase === 'planned' ? (
        <>
          <p>
            {state.plan.changes.length === 0
              ? 'Nothing would change on the iPod.'
              : `${state.plan.changes.length} files would change on the iPod. The backup in the folder "${backup?.folder}" is the way back.`}
          </p>
          <ul class="files">
            {state.plan.changes.map((change) => (
              <li key={change.path}>
                {change.path} <span class="muted">{change.kind}{change.sizeAfter !== null ? `, ${formatBytes(change.sizeAfter)}` : ''}</span>
              </li>
            ))}
            {state.plan.skipped.map((file) => (
              <li key={file.path} class="muted">
                {file.path}: not written. {file.reason}
              </li>
            ))}
          </ul>
          {state.plan.report.problems.length ? (
            <p class="muted">The library test found {state.plan.report.problems.length} differences from what iTunes wrote, listed above. This is the test of whether the iPod accepts them.</p>
          ) : null}
          {state.plan.changes.length ? (
            <button type="button" onClick={() => void write(state.plan)} disabled={working}>
              Write to the iPod now
            </button>
          ) : null}
        </>
      ) : null}

      {state.phase === 'done' ? (
        <>
          <Notice tone={state.report.verified ? 'ok' : 'no'}>
            <p>
              {state.report.verified
                ? `Wrote ${state.report.written.length} files and removed ${state.report.removed.length}. The iPod reads back with the same library and valid signatures. Eject it, then look at it: do the songs, playlists and menus look as before?`
                : state.report.rolledBack && state.report.rollbackFailures.length === 0
                  ? 'The write did not work, and every file it had changed was put back. The iPod is as it was.'
                  : 'The write did not work, and some files could not be put back. Use "Restore from a backup" on the Backup tab now.'}
            </p>
          </Notice>
          {state.report.failures.length || state.report.rollbackFailures.length ? (
            <ul class="files">
              {[...state.report.failures, ...state.report.rollbackFailures].map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}
          <button type="button" onClick={() => void copy(JSON.stringify({ app: 'opentunes', view: 'write-back', generatedAt: new Date().toISOString(), ...state.report }, null, 2))}>
            Copy write report
          </button>
          <span class="note" role="status" aria-live="polite">
            {copied === 'copied' ? ' Copied.' : copied === 'failed' ? ' Copy failed.' : ''}
          </span>
        </>
      ) : null}
    </section>
  );
}
