import { formatBytes } from '@opentunes/core';
import { describeInclude, partialLine, type OffloadReport } from '@opentunes/engine';
import { Notice } from './controls';

const SHOWN = 200;

/** What a finished or stopped media copy says: what is in the folder, what failed, what was left out, and that its library folder is a backup. */
export function OffloadResult({ report, into, countsAsBackup, onResume }: { report: OffloadReport; into: string; /** True when the copy's library folder is now the backup this session counts. */ countsAsBackup: boolean; onResume?: () => void }) {
  const here = report.files.copied + report.files.skipped;
  const unfinished = report.stopped || report.failures.length > 0;
  const seconds = Math.max(1, Math.round(report.elapsedMs / 1000));
  const partial = report.partial;
  const kind = partial ? 'partial copy' : 'copy';
  return (
    <>
      <Notice tone={report.complete ? 'ok' : 'no'}>
        <p>
          {report.complete
            ? `Copied ${here} file${here === 1 ? '' : 's'} (${formatBytes(report.bytes.copied + report.bytes.skipped)}) into the folder "${report.folder}" in "${into}", and checked each by reading it back.`
            : report.stopped
              ? `Stopped. ${here} of ${report.files.total} files are in the folder "${report.folder}" in "${into}". Copy again into the same folder to finish.`
              : `The ${kind} in "${report.folder}" in "${into}" is not complete: ${here} of ${report.files.total} files are there${report.failures.length ? `, ${report.failures.length} failed` : ''}.`}
        </p>
        <p class="muted">
          {report.files.skipped ? `${report.files.skipped} were already there and skipped. ` : ''}
          {report.bytes.copied > 0 ? `Copied ${formatBytes(report.bytes.copied)} in ${seconds} s${report.bytesPerSecond > 0 ? ` (${formatBytes(report.bytesPerSecond)}/s)` : ''}. ` : ''}
          {report.libraryError ? '' : `The library lists ${report.tracks} track${report.tracks === 1 ? '' : 's'} and ${report.playlists} playlist${report.playlists === 1 ? '' : 's'}.`}
        </p>
      </Notice>

      {partial ? (
        <div class="callout warn" role="note">
          <p>
            <strong>This is a partial copy ({describeInclude(partial)}).</strong> {partialLine(partial, report.tracks)} The {partial.tracksNotIncluded} tracks left out are marked "not included in this copy" in library.csv and the README says so.
          </p>
        </div>
      ) : null}

      {countsAsBackup ? (
        <p class="muted">The library folder in this copy is a complete, checked backup, so it counts as your backup for changes to the iPod.</p>
      ) : null}

      {onResume && unfinished ? (
        <div class="actions">
          <button type="button" onClick={onResume}>
            {report.stopped ? 'Copy the rest' : 'Try the failed files again'}
          </button>
        </div>
      ) : null}

      {report.libraryError ? (
        <div class="callout warn" role="note">
          <p>{report.libraryError}</p>
        </div>
      ) : null}
      {report.notesError ? (
        <div class="callout no" role="note">
          <p>{report.notesError}</p>
        </div>
      ) : null}

      {report.failures.length ? (
        <>
          <p>
            <strong>{report.failures.length === 1 ? '1 file could not be copied:' : `${report.failures.length} files could not be copied:`}</strong>
          </p>
          <ul class="files">
            {report.failures.slice(0, SHOWN).map((failure) => (
              <li key={failure.path}>
                {failure.path}: {failure.reason}
              </li>
            ))}
          </ul>
          {report.failures.length > SHOWN ? <p class="muted">Showing the first {SHOWN}.</p> : null}
        </>
      ) : null}

      {report.missing.length ? (
        <details open>
          <summary>
            {report.missing.length} track{report.missing.length === 1 ? ' is' : 's are'} in the library but {report.missing.length === 1 ? 'its' : 'their'} file is not on the iPod
          </summary>
          <ul class="files">
            {report.missing.slice(0, SHOWN).map((track) => (
              <li key={track.path}>
                {track.title ?? '(no title)'}
                {track.artist ? `, ${track.artist}` : ''} <span class="muted">{track.path}</span>
              </li>
            ))}
          </ul>
          {report.missing.length > SHOWN ? <p class="muted">Showing the first {SHOWN}. All are marked in library.csv.</p> : null}
        </details>
      ) : null}

      {report.unlisted.length ? (
        <p class="muted">
          {report.unlisted.length} file{report.unlisted.length === 1 ? '' : 's'} in the music folders {report.unlisted.length === 1 ? 'is' : 'are'} not in the library (left over from an interrupted sync, for example). {report.unlisted.length === 1 ? 'It was' : 'They were'} copied too, and {report.unlisted.length === 1 ? 'is' : 'are'} not in library.csv.
        </p>
      ) : null}
      {report.database ? (
        <p class="muted">
          {report.database.complete
            ? `The iPod's library files (${report.database.files} files, ${formatBytes(report.database.bytes)}) are saved in the database folder, each read back and checked, so this folder can put the iPod back.`
            : `The iPod's library files were not saved completely${report.database.failures.length ? `: ${report.database.failures.join(' ')}` : ''}. This folder cannot put the iPod back yet.`}
        </p>
      ) : null}
      {report.databaseError ? (
        <div class="callout warn" role="note">
          <p>{report.databaseError} This folder holds the media files but cannot put the iPod back.</p>
        </div>
      ) : null}
      <p class="muted">
        The folder holds the copied files in F00, F01 and so on, library.csv, playlists.csv, the database folder, opentunes-offload.json and a README.txt that explains them. It holds the iPod's identity files, so keep it private. To put everything back, use "Restore everything from a full copy" in step 2.
      </p>
    </>
  );
}
