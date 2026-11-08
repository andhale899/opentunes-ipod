import { useEffect, useMemo, useState } from 'preact/hooks';
import { type BackupReport, type DirectoryEntry, type IpodRoot, type LibraryPlan, type PlaylistChange, type PlaylistInfo } from '@opentunes/engine';
import { changePlaylists, planPlaylistChanges } from '../tracked';
import { WriteWait } from '../BackupGate';
import { Notice, useOnce } from '../controls';
import { useWriteReady } from '../writeReady';
import { describeError } from '../describeError';
import { newEngine } from '../engineLoader';
import { allowWriting } from '../WriteBackPanel';
import { playlistRows, playlistRule, selectedRows, splitForPlaylist, validatePlaylistName, type Row, type Selection } from './organise';
import { TrackBrowser } from './TrackBrowser';

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

type Step =
  | { phase: 'idle' }
  | { phase: 'working'; message: string }
  | { phase: 'plan'; plan: LibraryPlan; changes: PlaylistChange[]; after: () => void }
  | { phase: 'done'; ok: boolean; message: string; details: string[] }
  | { phase: 'error'; message: string };

/** Playlists are told apart by name. An unnamed one gets its place in the list instead. */
const keyOf = (playlist: PlaylistInfo, index: number): string => playlist.name ?? `#${index}`;

/**
 * Playlists on the iPod: see them, make one, rename or delete it, look inside, and put the tracks
 * selected in the Tracks view into one or take them out. Nothing is written until the plan has been
 * shown and the person has pressed apply, and apply needs the session's backup.
 */
export function PlaylistManager({
  root,
  rows,
  playlists,
  selected,
  onSelect,
  backup,
  onChanged,
}: {
  root: DirectoryEntry;
  rows: Row[];
  playlists: PlaylistInfo[];
  selected: Selection;
  onSelect: (next: Set<string>) => void;
  backup: BackupReport | null;
  onChanged: () => void;
}) {
  const [step, setStep] = useState<Step>({ phase: 'idle' });
  const once = useOnce();
  const [viewing, setViewing] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [withSelected, setWithSelected] = useState(true);
  const [renameTo, setRenameTo] = useState('');
  const [target, setTarget] = useState('');

  const { ready, wait } = useWriteReady(backup);
  const busy = step.phase === 'working';

  // The playlists or tracks were read again: a plan made for the old ones must not be applied.
  useEffect(() => {
    setStep((now) => (now.phase === 'plan' ? { phase: 'idle' } : now));
  }, [rows, playlists]);
  const current = viewing === null ? undefined : playlists.find((playlist, index) => keyOf(playlist, index) === viewing);
  const rule = current ? playlistRule(current, playlists) : null;
  const inside = useMemo(() => (current ? playlistRows(current, rows) : []), [current, rows]);
  const chosen = useMemo(() => selectedRows(rows, selected), [rows, selected]);
  const editable = playlists.filter((playlist) => playlistRule(playlist, playlists).editable);
  const targetList = editable.find((playlist) => playlist.name === target) ?? editable[0];
  const addSplit = targetList ? splitForPlaylist(targetList, rows, selected) : { toAdd: [] as string[], alreadyIn: [] as string[] };
  const viewSplit = current ? splitForPlaylist(current, rows, selected) : { toAdd: [] as string[], alreadyIn: [] as string[] };
  const nameProblem = newName.trim() ? validatePlaylistName(newName, playlists) : null;
  const renameProblem = renameTo.trim() && renameTo.trim() !== current?.name ? validatePlaylistName(renameTo, playlists) : null;

  /** Plans the change in memory, which touches nothing on the iPod, and shows what it would do. */
  async function plan(changes: PlaylistChange[], after: () => void = () => undefined) {
    setStep({ phase: 'working', message: 'Planning the change...' });
    try {
      const result = await planPlaylistChanges(root as unknown as IpodRoot, newEngine, changes, { onProgress: (message) => setStep({ phase: 'working', message }) });
      setStep({ phase: 'plan', plan: result, changes, after });
    } catch (error) {
      setStep({ phase: 'error', message: describeError(error) });
    }
  }

  /** The permission prompt Chrome shows before a write leaves time to click twice, so a second click does nothing. */
  async function apply(changes: PlaylistChange[], after: () => void) {
    await once(() => applyNow(changes, after));
  }

  async function applyNow(changes: PlaylistChange[], after: () => void) {
    try {
      if (!(await allowWriting(root))) {
        setStep({ phase: 'error', message: 'Chrome was not allowed to change the iPod, so nothing was changed.' });
        return;
      }
    } catch (error) {
      setStep({ phase: 'error', message: describeError(error, { writing: true }) });
      return;
    }
    setStep({ phase: 'working', message: 'Writing the playlist change...' });
    try {
      const { report } = await changePlaylists(root as unknown as IpodRoot, newEngine, changes, {
        backup,
        onProgress: (progress: string | { message: string }) => setStep({ phase: 'working', message: typeof progress === 'string' ? progress : progress.message }),
      });
      const ok = report.verified && !report.rolledBack && !report.failures.length;
      setStep({ phase: 'done', ok, message: ok ? 'Done. The iPod was read back and matches.' : 'The change did not finish.', details: report.failures });
      if (ok) {
        after();
        onChanged();
      }
    } catch (error) {
      setStep({ phase: 'error', message: describeError(error, { writing: true }) });
    }
  }

  function create() {
    const name = newName.trim();
    const keys = withSelected ? chosen.map((row) => row.key) : [];
    void plan([{ action: 'create', name, tracks: [...new Set(keys)] }], () => {
      setNewName('');
      setViewing(name);
    });
  }

  return (
    <div class="playlist-manager">
      <WriteWait wait={backup !== null && backup.complete ? wait : null} />
      {selected.size ? (
        <div class="add-box">
          <strong>{plural(selected.size, 'track')} selected</strong>
          {editable.length ? (
            <div class="add-controls">
              <label class="field">
                Add them to
                <select value={targetList?.name ?? ''} disabled={busy} onChange={(event) => setTarget((event.target as HTMLSelectElement).value)}>
                  {editable.map((playlist) => (
                    <option key={playlist.handle} value={playlist.name ?? ''}>
                      {playlist.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                disabled={busy || !ready || !targetList || addSplit.toAdd.length === 0}
                onClick={() => targetList && void plan([{ action: 'add', playlist: targetList.name as string, tracks: addSplit.toAdd }])}
              >
                Add {addSplit.toAdd.length} to this playlist
              </button>
            </div>
          ) : (
            <p class="note">There is no playlist to add to yet. Make one below.</p>
          )}
          {addSplit.alreadyIn.length ? <p class="note">{plural(addSplit.alreadyIn.length, 'selected track')} already in "{targetList?.name}" and will not be added twice.</p> : null}
        </div>
      ) : (
        <p class="note">Select tracks in the Tracks view, then come back here to put them in a playlist.</p>
      )}

      <h4>Playlists on this iPod</h4>
      <ul class="playlist-list">
        {playlists.map((playlist, index) => {
          const key = keyOf(playlist, index);
          const why = playlistRule(playlist, playlists);
          return (
            <li key={`${playlist.handle}-${index}`}>
              <button type="button" class="plist" aria-pressed={viewing === key} onClick={() => { setViewing(viewing === key ? null : key); setRenameTo(playlist.name ?? ''); setStep({ phase: 'idle' }); }}>
                <span class="plist-name">{playlist.name ?? '(no name)'}</span>
                <span class="muted">
                  {plural(playlist.tracks.length, 'track')}
                  {playlist.master ? ', holds everything' : ''}
                  {playlist.podcasts ? ', podcasts' : ''}
                  {playlist.smart ? ', smart' : ''}
                </span>
                {why.editable ? null : <span class="pill">Read only</span>}
              </button>
            </li>
          );
        })}
      </ul>

      <div class="create-box">
        <h4>New playlist</h4>
        <label class="field">
          Name
          <input type="text" value={newName} disabled={busy} placeholder="Road trip" onInput={(event) => setNewName((event.target as HTMLInputElement).value)} />
        </label>
        {selected.size ? (
          <label class="check">
            <input type="checkbox" checked={withSelected} disabled={busy} onChange={() => setWithSelected(!withSelected)} />
            Put the {plural(selected.size, 'selected track')} in it
          </label>
        ) : null}
        {nameProblem ? <p class="note no-text">{nameProblem}</p> : null}
        <button type="button" disabled={busy || !ready || !newName.trim() || nameProblem !== null} onClick={create}>
          Create playlist
        </button>
      </div>

      {current && rule ? (
        <div class="playlist-detail">
          <h4>{current.name ?? '(no name)'}</h4>
          {rule.editable ? (
            <div class="detail-actions">
              <label class="field">
                Rename to
                <input type="text" value={renameTo} disabled={busy} onInput={(event) => setRenameTo((event.target as HTMLInputElement).value)} />
              </label>
              <button
                type="button"
                class="secondary"
                disabled={busy || !ready || !renameTo.trim() || renameTo.trim() === current.name || renameProblem !== null}
                onClick={() => void plan([{ action: 'rename', playlist: current.name as string, name: renameTo.trim() }], () => setViewing(renameTo.trim()))}
              >
                Rename playlist
              </button>
              <button type="button" class="danger" disabled={busy || !ready} onClick={() => void plan([{ action: 'delete', playlist: current.name as string }], () => setViewing(null))}>
                Delete playlist
              </button>
              {renameProblem ? <p class="note no-text">{renameProblem}</p> : null}
            </div>
          ) : (
            <div class="callout info" role="note">
              <p>Read only. {rule.reason}</p>
            </div>
          )}
          <TrackBrowser
            rows={inside}
            selected={selected}
            onSelect={onSelect}
            disabled={busy}
            label="tracks in this playlist"
            actions={
              rule.editable ? (
                <button
                  type="button"
                  class="secondary"
                  disabled={busy || !ready || viewSplit.alreadyIn.length === 0}
                  onClick={() => void plan([{ action: 'remove', playlist: current.name as string, tracks: viewSplit.alreadyIn }])}
                >
                  Take {viewSplit.alreadyIn.length} out of this playlist
                </button>
              ) : undefined
            }
          />
        </div>
      ) : null}

      {step.phase === 'working' ? (
        <p class="callout info" role="status">
          {step.message}
        </p>
      ) : null}
      {step.phase === 'error' ? (
        <Notice tone="no">
          <p>{step.message}</p>
        </Notice>
      ) : null}
      {step.phase === 'plan' ? (
        <div class="plan">
          <div class="result ok" role="status">
            <p>
              <strong>Ready to write.</strong> Nothing has changed on the iPod yet.
            </p>
            <ul>
              {step.plan.summary.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <p>{plural(step.plan.database.length, 'database file')} would be rewritten. No music files are touched, and every track stays on the iPod, whatever happens to a playlist.</p>
          </div>
          <div class="actions">
            <button type="button" disabled={!ready || busy} onClick={() => void apply(step.changes, step.after)}>
              Apply to the iPod
            </button>
            <button type="button" class="ghost" onClick={() => setStep({ phase: 'idle' })}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {step.phase === 'done' ? (
        <>
          <Notice tone={step.ok ? 'ok' : 'no'}>
            <p>{step.message}</p>
          </Notice>
          {step.details.length ? (
            <ul class="files">
              {step.details.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
