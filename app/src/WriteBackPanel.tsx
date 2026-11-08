import { useState } from 'preact/hooks';
import { formatBytes } from '@opentunes/core';
import { type BackupReport, type DirectoryEntry, type IpodRoot, type WriteBackPlan, type WriteBackReport } from '@opentunes/engine';
import { applyWriteBack, planWriteBack } from './tracked';
import { describeError } from './describeError';
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

  async function prepare() {
    setCopied('idle');
    setState({ phase: 'working', message: 'Loading the engine...' });
    try {
      const plan = await planWriteBack(root as unknown as IpodRoot, newEngine, { onProgress: (message) => setState({ phase: 'working', message }) });
      setState({ phase: 'planned', plan });
    } catch (error) {
      setState({ phase: 'error', message: describeError(error) });
    }
  }

  async function write(plan: WriteBackPlan) {
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
      <h3>Write the rebuilt database back (test)</h3>
      <p class="card-lead">
        Writes the database libgpod rebuilds, with no new songs, back to the iPod, to see whether the iPod accepts it. Only files in iPod_Control/iTunes are written, never music. It needs the backup from the Backup tab first. If anything fails while writing, the original files are put back. The only file removed is Play Counts, which libgpod folds into the library and keeps as Play Counts.bak.
      </p>
      <button type="button" onClick={() => void prepare()} disabled={working || !ready}>
        Prepare the write
      </button>
      {!ready ? <p class="muted">Make the backup in the Backup tab first. Nothing can be written until a complete backup has been made on this page.</p> : null}

      {state.phase === 'working' ? (
        <p class="note" role="status">
          {state.message}
        </p>
      ) : null}
      {state.phase === 'error' ? (
        <div class="result no" role="alert">
          <p>{state.message}</p>
        </div>
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
            <p class="muted">The rewrite check found {state.plan.report.problems.length} differences from what iTunes wrote, listed above. This is the test of whether the iPod accepts them.</p>
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
          <div class={`result ${state.report.verified ? 'ok' : 'no'}`} role={state.report.verified ? 'status' : 'alert'}>
            <p>
              {state.report.verified
                ? `Wrote ${state.report.written.length} files and removed ${state.report.removed.length}. The iPod reads back with the same library and valid signatures. Eject it, then look at it: do the songs, playlists and menus look as before?`
                : state.report.rolledBack && state.report.rollbackFailures.length === 0
                  ? 'The write did not work, and every file it had changed was put back. The iPod is as it was.'
                  : 'The write did not work, and some files could not be put back. Use "Restore from a backup" below now.'}
            </p>
          </div>
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
          {copied === 'copied' ? <span class="note"> Copied.</span> : null}
          {copied === 'failed' ? <span class="note"> Copy failed.</span> : null}
        </>
      ) : null}
    </section>
  );
}
