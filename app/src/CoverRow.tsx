import { useEffect, useState } from 'preact/hooks';
import type { Candidate } from './addFiles';
import { coverLine, rowActions } from './coverRows';

/** A small picture from bytes the page holds. The address is made when it shows and let go when it goes. */
function Preview({ data, mime, label }: { data: Uint8Array; mime: string; label: string }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    const made = URL.createObjectURL(new Blob([new Uint8Array(data)], { type: mime }));
    setUrl(made);
    return () => URL.revokeObjectURL(made);
  }, [data, mime]);
  return url ? <img class="cover-preview" src={url} width={40} height={40} alt={label} /> : null;
}

export interface CoverRowHandlers {
  /** "Find a cover online": open and focus the finder for this row. */
  onFind: (candidate: Candidate) => void;
  /** "Choose a picture...", "Replace the cover", "Choose a different picture": open the picture picker for this row. */
  onChoose: (candidate: Candidate) => void;
  /** "Remove the picture I chose". */
  onRemove: (candidate: Candidate) => void;
  /** Accept or withdraw the guess from the file name. */
  onGuess: (candidate: Candidate, accept: boolean) => void;
  /** Tick or untick "Use this picture for all N files of this album" for this row. */
  onShared: (candidate: Candidate, on: boolean) => void;
}

/**
 * The cover part of one row of the Add music list: a "Cover:" line with a symbol and words (never
 * colour alone), a small preview of a picture the person chose, and the buttons that row gets.
 * What each state says and which buttons appear is decided in coverRows.ts.
 */
export function CoverRow({
  candidate,
  skipped,
  guessAccepted,
  albumFiles,
  sharedOn,
  message,
  busy,
  ...handlers
}: {
  candidate: Candidate;
  skipped: boolean;
  guessAccepted: boolean;
  /** How many files of this row's album have no cover and would get a chosen picture. */
  albumFiles: number;
  sharedOn: boolean;
  /** Why the last picture chosen for this row was refused, if it was. */
  message: string;
  busy: boolean;
} & CoverRowHandlers) {
  const line = coverLine(candidate, skipped);
  if (!line) return null;
  const actions = rowActions(candidate, skipped, guessAccepted);
  const name = candidate.file.name;
  const preview = candidate.chosenCover ?? (candidate.onlineCover ? { data: candidate.onlineCover.data, mime: candidate.onlineCover.mime, name: 'found online' } : null);
  return (
    <div class="cover-row" data-cover={line.kind}>
      <div class="cover-line">
        <span class="cover-icon" aria-hidden="true">{line.icon}</span>
        <span class="cover-text">{line.text}</span>
        {preview ? <Preview data={preview.data} mime={preview.mime} label={candidate.chosenCover ? `The picture you chose for ${name}` : `The cover found online for ${name}`} /> : null}
      </div>
      {actions.note ? <p class="cover-note" data-cover-note>{actions.note}</p> : null}
      {message ? <p class="cover-note cover-problem" role="alert">{message}</p> : null}
      <div class="cover-actions">
        {actions.find ? (
          <button type="button" class="secondary small" disabled={busy} onClick={() => handlers.onFind(candidate)} aria-label={`Find a cover online for ${name}`}>
            Find a cover online
          </button>
        ) : null}
        {actions.offerGuess ? (
          <button type="button" class="secondary small" disabled={busy} onClick={() => handlers.onGuess(candidate, true)} aria-label={`Use the file name as a guess for ${name}`}>
            Use the file name as a guess
          </button>
        ) : null}
        {actions.withdrawGuess ? (
          <button type="button" class="ghost small" disabled={busy} onClick={() => handlers.onGuess(candidate, false)} aria-label={`Do not use the file name as a guess for ${name}`}>
            Do not use the guess
          </button>
        ) : null}
        {actions.choose ? (
          <button type="button" class="secondary small" disabled={busy} onClick={() => handlers.onChoose(candidate)} aria-label={`Choose a picture for ${name}`}>
            Choose a picture...
          </button>
        ) : null}
        {actions.replace ? (
          <button type="button" class="ghost small" disabled={busy} onClick={() => handlers.onChoose(candidate)} aria-label={`Replace the cover of ${name}`}>
            Replace the cover
          </button>
        ) : null}
        {actions.change ? (
          <>
            <button type="button" class="ghost small" disabled={busy} onClick={() => handlers.onChoose(candidate)} aria-label={`Choose a different picture for ${name}`}>
              Choose a different picture
            </button>
            <button type="button" class="ghost small" disabled={busy} onClick={() => handlers.onRemove(candidate)} aria-label={`Remove the picture you chose for ${name}`}>
              Remove the picture I chose
            </button>
          </>
        ) : null}
      </div>
      {actions.choose && albumFiles >= 2 ? (
        <label class="check cover-shared">
          <input type="checkbox" checked={sharedOn} disabled={busy} onChange={(event) => handlers.onShared(candidate, (event.target as HTMLInputElement).checked)} />
          Use this picture for all {albumFiles} files of this album
        </label>
      ) : null}
    </div>
  );
}
