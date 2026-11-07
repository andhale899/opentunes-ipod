import { useEffect, useState } from 'preact/hooks';
import { checkRewrite, findFireWireId, loadIpodFolder, type DirectoryEntry, type RewriteReport, type SignatureStatus } from '@opentunes/engine';
import { describeError } from './describeError';
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

  async function run() {
    setCopied('idle');
    setState({ phase: 'working', message: 'Loading the engine...' });
    try {
      const engine = await newEngine();
      const load = await loadIpodFolder(source, engine, { mount: MOUNT, onProgress: (message) => setState({ phase: 'working', message }) });
      engine.open(load.mount);
      let fireWireId: string | null = null;
      try {
        fireWireId = engine.device().firewire_id;
      } catch {
        fireWireId = null;
      }
      setState({ phase: 'working', message: 'Writing the database in memory and comparing...' });
      const report = await checkRewrite(engine, load.mount, fireWireId ?? findFireWireId(engine, load.mount));
      setState({ phase: 'done', report });
    } catch (error) {
      setState({ phase: 'error', message: describeError(error) });
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
      <h3>Rewrite check</h3>
      <p class="card-lead">
        Writes the database the way a sync would, but only inside the engine's own memory, and compares the result with what is on the iPod: the library, every file, and the SQLite files a nano 6th or 7th generation keeps. Nothing is written to the iPod. Track titles are left out of the report.
      </p>
      <button type="button" onClick={() => void run()} disabled={working}>
        Check what a rewrite would change
      </button>

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
        <div class="result ok" role="status">
          <p>No differences found. Rewriting the database would keep everything this check could compare.</p>
        </div>
      ) : (
        <div class="result no" role="alert">
          <p>
            {problems.length} {problems.length === 1 ? 'difference' : 'differences'} found. A sync that rewrote the database now would change what is on the iPod.
          </p>
        </div>
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
      {copied === 'copied' ? <span class="note"> Copied.</span> : null}
      {copied === 'failed' ? <span class="note"> Copy failed.</span> : null}
      <p class="muted">File sizes are in bytes. In the SQLite list, the numbers after a column name are how many rows hold a value that is not empty or zero.</p>
    </>
  );
}
