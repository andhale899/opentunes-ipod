import type { Turn } from './session';

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

const FIELD_LABEL: Record<string, string> = { title: 'title', artist: 'artist', album: 'album', albumartist: 'album artist', genre: 'genre', year: 'year', track: 'track no.' };

const shown = (value: string): string => (value === '' ? '(empty)' : value);

/**
 * What the assistant proposed, one row per change with a tick box, before and after, and its
 * reason. Nothing here changes anything: ticking only chooses what "Apply selected" will send to
 * the engine.
 */
export function ProposalPreview({
  turn,
  stale,
  canApply,
  busy,
  onToggleEdit,
  onTogglePlaylist,
  onAll,
  onApply,
}: {
  turn: Turn;
  /** True when the library changed after this answer was made. */
  stale: boolean;
  canApply: boolean;
  busy: boolean;
  onToggleEdit: (id: number) => void;
  onTogglePlaylist: (name: string) => void;
  onAll: (on: boolean) => void;
  onApply: () => void;
}) {
  const result = turn.result;
  if (!result) return null;
  const { edits, playlists, dropped } = result;
  const chosenEdits = edits.filter((edit) => turn.selectedEdits.includes(edit.id));
  const chosenPlaylists = playlists.filter((playlist) => turn.selectedPlaylists.includes(playlist.name));
  const chosen = chosenEdits.length + chosenPlaylists.length;
  const total = edits.length + playlists.length;
  const done = turn.applied !== undefined;
  const locked = busy || done || stale;

  return (
    <div class="ai-proposals">
      {result.answer ? <p class="ai-answer">{result.answer}</p> : null}

      {total ? (
        <>
          <div class="ai-counts" role="status">
            <strong>
              {[edits.length ? plural(edits.length, 'edit') : '', playlists.length ? plural(playlists.length, 'new playlist') : ''].filter(Boolean).join(' and ')} proposed.
            </strong>{' '}
            {chosen} of {total} ticked. Nothing has been changed yet.
            {!done && !stale ? (
              <span class="ai-bulk">
                <button type="button" class="ghost small" disabled={busy} onClick={() => onAll(true)}>
                  Tick all
                </button>
                <button type="button" class="ghost small" disabled={busy} onClick={() => onAll(false)}>
                  Untick all
                </button>
              </span>
            ) : null}
          </div>

          {edits.length ? (
            <ul class="ai-rows" aria-label="Proposed edits">
              {edits.map((edit) => (
                <li key={edit.id} class="ai-row">
                  <label class="ai-row-head">
                    <input type="checkbox" checked={turn.selectedEdits.includes(edit.id)} disabled={locked} onChange={() => onToggleEdit(edit.id)} />
                    <span class="ai-track">{turn.labels[edit.id] ?? `Track ${edit.id}`}</span>
                  </label>
                  <div class="ai-changes">
                    {edit.changes.map((change) => (
                      <div key={change.field}>
                        <span class="ai-field">{FIELD_LABEL[change.field] ?? change.field}</span> <span class="ai-before">{shown(change.before)}</span> <span aria-hidden="true">→</span>{' '}
                        <span class="ai-after">{shown(change.after)}</span>
                      </div>
                    ))}
                    {edit.kind ? (
                      <div>
                        <span class="ai-field">kind</span> <span class="ai-before">{edit.kindBefore}</span> <span aria-hidden="true">→</span> <span class="ai-after">{edit.kind}</span>
                      </div>
                    ) : null}
                  </div>
                  <div class="ai-reason">{edit.reason}</div>
                </li>
              ))}
            </ul>
          ) : null}

          {playlists.length ? (
            <ul class="ai-rows" aria-label="Proposed playlists">
              {playlists.map((playlist) => (
                <li key={playlist.name} class="ai-row">
                  <label class="ai-row-head">
                    <input type="checkbox" checked={turn.selectedPlaylists.includes(playlist.name)} disabled={locked} onChange={() => onTogglePlaylist(playlist.name)} />
                    <span class="ai-track">
                      New playlist "{playlist.name}" <span class="muted">({plural(playlist.ids.length, 'track')})</span>
                    </span>
                  </label>
                  <div class="ai-reason">{playlist.reason}</div>
                  <details>
                    <summary>Tracks in it</summary>
                    <ol class="ai-tracklist">
                      {playlist.ids.slice(0, 100).map((id) => (
                        <li key={id}>{turn.labels[id] ?? `Track ${id}`}</li>
                      ))}
                    </ol>
                    {playlist.ids.length > 100 ? <p class="muted">And {playlist.ids.length - 100} more.</p> : null}
                  </details>
                </li>
              ))}
            </ul>
          ) : null}

          {stale && !done ? <p class="callout warn">The library changed after this was proposed, so it cannot be applied. Ask again.</p> : null}
          {!done && !stale ? (
            <div class="actions">
              <button type="button" disabled={!canApply || busy || chosen === 0} onClick={onApply}>
                Apply selected
              </button>
              {!canApply ? <span class="note">Make a backup first (Backup tab).</span> : null}
            </div>
          ) : null}
        </>
      ) : null}

      {dropped.length ? (
        <details class="ai-dropped">
          <summary>{plural(dropped.length, 'thing')} the assistant asked for {dropped.length === 1 ? 'was' : 'were'} left out</summary>
          <ul class="files">
            {dropped.map((entry, index) => (
              <li key={index}>
                {entry.what}: {entry.why}.
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {turn.applied ? (
        <div class={`result ${turn.applied.ok ? 'ok' : 'no'}`} role={turn.applied.ok ? 'status' : 'alert'}>
          <p>{turn.applied.message}</p>
          {turn.applied.lines.length ? (
            <ul class="files">
              {turn.applied.lines.map((line, index) => (
                <li key={index}>{line}</li>
              ))}
            </ul>
          ) : null}
          {turn.applied.details.length ? (
            <ul class="files">
              {turn.applied.details.map((line, index) => (
                <li key={index}>{line}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
