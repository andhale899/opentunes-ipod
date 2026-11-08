import { useEffect, useRef, useState } from 'preact/hooks';
import { checkRewrite, findFireWireId, loadIpodFolder, type DirectoryEntry, type RewriteReport, type SignatureStatus } from '@opentunes/engine';
import { startActivity } from './activity';
import { Notice, useOnce } from './controls';
import { describeError, isStopped } from './describeError';
import { newEngine } from './engineLoader';

const MOUNT = '/ipod';
const MAX_LISTED = 40;

type State =
  | { phase: 'idle' }
  | { phase: 'working'; message: string }
  | { phase: 'done'; report: RewriteReport }
  | { phase: 'error'; message: string };

const SIGNATURE_STATUS: Record<SignatureStatus, string> = {
  matches: 'Matches what the engine computes',
  differs: 'Does not match',
  unsupported: 'Could not be checked',
  missing: 'Not there',
};

const change = (before: number | null, after: number | null): string => `${before ?? 'none'} to ${after ?? 'none'}`;

function reportJson(folderName: string, report: RewriteReport): string {
  return JSON.stringify({ app: 'opentunes', view: 'rewrite-check', generatedAt: new Date().toISOString(), folderName, ...report }, null, 2);
}

/**
 * Writes the database the way a sync would, inside the engine's own memory only, and shows
 * what that would change on the iPod. It reads the iPod again for this and never writes to it.
 */
export function RewritePanel({ source, autoStart = false }: { source: DirectoryEntry; autoStart?: boolean }) {
  const [state, setState] = useState<State>({ phase: 'idle' });
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  const abort = useRef<AbortController | null>(null);
  const once = useOnce();

  async function run() {
    await once(go);
  }

  async function go() {
    setCopied('idle');
    setState({ phase: 'working', message: 'Loading the engine...' });
    const controller = new AbortController();
    abort.current = controller;
    // This test reads the iPod and works in memory, so stopping it changes nothing. It is shown in the bar like every other job.
    const activity = startActivity('Testing the library rewrite', { stop: { label: 'Stop (nothing is written)', stopping: 'Stopping...', run: () => controller.abort() } });
    let stopped = false;
    let failure: string | undefined;
    try {
      const engine = await newEngine();
      const load = await loadIpodFolder(source, engine, {
        mount: MOUNT,
        signal: controller.signal,
        onProgress: (message) => {
          activity.update(message);
          setState({ phase: 'working', message });
        },
      });
      engine.open(load.mount);
      let fireWireId: string | null = null;
      try {
        fireWireId = engine.device().firewire_id;
      } catch {
        fireWireId = null;
      }
      controller.signal.throwIfAborted();
      // The comparison itself runs in one go and cannot be interrupted. It takes a few seconds.
      activity.setBlocked('This part cannot be stopped. It takes a few seconds.');
      activity.update('Writing the library in memory and comparing...');
      setState({ phase: 'working', message: 'Writing the library in memory and comparing...' });
      const report = await checkRewrite(engine, load.mount, fireWireId ?? findFireWireId(engine, load.mount));
      setState({ phase: 'done', report });
    } catch (error) {
      stopped = isStopped(error);
      if (!stopped) failure = describeError(error);
      setState({ phase: 'error', message: stopped ? 'Stopped. Nothing was written to the iPod.' : describeError(error) });
    } finally {
      activity.end(failure === undefined, failure, stopped);
      abort.current = null;
    }
  }

  useEffect(() => {
    if (autoStart) void run();
  }, []);

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
      <h3>Library test: would a rewrite lose anything?</h3>
      <p class="card-lead">
        Makes a trial copy of the iPod's library in memory, the way adding music would write it, and compares it with what is on the iPod: the song list, every file, and the extra library files a nano 6th or 7th generation keeps. Nothing is written to the iPod. Track titles are left out of the report.
      </p>
      <div class="actions">
        <button type="button" onClick={() => void run()} disabled={working}>
          Run the test (nothing is written)
        </button>
        {working ? (
          <button type="button" class="secondary" onClick={() => abort.current?.abort()}>
            Stop (nothing is written)
          </button>
        ) : null}
      </div>

      {state.phase === 'working' ? (
        <p class="note" role="status">
          {state.message}
        </p>
      ) : null}
      {state.phase === 'error' ? (
        <Notice tone="no">
          <p>{state.message}</p>
        </Notice>
      ) : null}
      {state.phase === 'done' ? <Result folderName={source.name} report={state.report} copied={copied} onCopy={copy} /> : null}
    </section>
  );
}

function Result({ folderName, report, copied, onCopy }: { folderName: string; report: RewriteReport; copied: 'idle' | 'copied' | 'failed'; onCopy: (text: string) => Promise<void> }) {
  const { problems, library } = report;
  const fileChanges = report.files;
  const tablesChanged = report.sqlite.reduce((sum, file) => sum + file.tables.length, 0);

  const rows: [string, string][] = [['Written in memory in', `${report.writeMilliseconds} ms`]];
  if (library) {
    rows.push(['Tracks', `${library.tracksBefore} before, ${library.tracksAfter} after`]);
    rows.push(['Playlists', `${library.playlistsBefore} before, ${library.playlistsAfter} after`]);
  }
  rows.push(['Files that differ', `${fileChanges.length}`]);
  rows.push(['SQLite tables that differ', `${tablesChanged}${report.sqlite.length ? ` in ${report.sqlite.map((file) => file.file).join(', ')}` : ''}`]);
  if (report.userVersions.length) {
    rows.push(['Library version (user_version)', report.userVersions.map((v) => `${v.file} ${v.before ?? 'unknown'} to ${v.after ?? 'unknown'}`).join(', ')]);
  }
  for (const check of report.signatures) rows.push([`Signature on ${check.file} after the rewrite`, SIGNATURE_STATUS[check.status]]);

  return (
    <>
      {problems.length === 0 ? (
        <Notice tone="ok">
          <p>No differences found. Rewriting the library would keep everything this test could compare.</p>
        </Notice>
      ) : (
        <Notice tone="no">
          <p>
            {problems.length} {problems.length === 1 ? 'difference' : 'differences'} found. Adding music now would rewrite the library and change these things on the iPod.
          </p>
        </Notice>
      )}
      {problems.length ? (
        <ul class="files">
          {problems.slice(0, MAX_LISTED).map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
          {problems.length > MAX_LISTED ? <li class="muted">and {problems.length - MAX_LISTED} more, all in the report</li> : null}
        </ul>
      ) : null}

      <dl class="facts">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>

      {fileChanges.length ? (
        <details>
          <summary>Files that differ after the rewrite ({fileChanges.length})</summary>
          <ul class="files">
            {fileChanges.map((file) => (
              <li key={file.path}>
                {file.path} <span class="muted">{file.kind}, {change(file.sizeBefore, file.sizeAfter)} bytes</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {report.sqlite.length ? (
        <details>
          <summary>SQLite differences ({tablesChanged} tables)</summary>
          <ul class="files">
            {report.sqlite.flatMap((file) =>
              file.tables.map((table) => (
                <li key={`${file.file}/${table.table}`}>
                  {file.file}: {table.table} <span class="muted">rows {change(table.rowsBefore, table.rowsAfter)}</span>
                  {table.columns.length ? <span class="muted">; {table.columns.map((column) => `${column.column} ${change(column.before, column.after)}`).join(', ')}</span> : null}
                </li>
              )),
            )}
          </ul>
        </details>
      ) : null}
      {report.schemaDifferences.length ? (
        <details>
          <summary>Structure the iPod's files have and the rewritten files lack, with no data in it ({report.schemaDifferences.length})</summary>
          <ul class="files">
            {report.schemaDifferences.map((line) => (
              <li class="muted" key={line}>
                {line}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {report.notes.length ? (
        <ul class="files">
          {report.notes.map((note) => (
            <li class="muted" key={note}>
              {note}
            </li>
          ))}
        </ul>
      ) : null}

      <button type="button" onClick={() => void onCopy(reportJson(folderName, report))}>
        Copy rewrite report
      </button>
      <span class="note" role="status" aria-live="polite">
        {copied === 'copied' ? ' Copied.' : copied === 'failed' ? ' Copy failed.' : ''}
      </span>
      <p class="muted">File sizes are in bytes. In the SQLite list, the numbers after a column name are how many rows hold a value that is not empty or zero.</p>
    </>
  );
}
