import { useEffect, useMemo, useState } from 'preact/hooks';
import { formatBytes } from '@opentunes/core';
import { trackKey, type BackupReport, type DirectoryEntry, type IpodRoot, type OrphanReport, type PlaylistInfo, type RemovalPlan, type TrackEdit, type TrackInfo } from '@opentunes/engine';
import { applyRemoval, editTracks, findOrphans, planRemoval, removeOrphans } from './tracked';
import { describeError } from './describeError';
import { newEngine } from './engineLoader';
import { BackupGate } from './BackupGate';
import { allowWriting } from './WriteBackPanel';
import { BulkEdit } from './library/BulkEdit';
import { rowsOf, selectedRows } from './library/organise';
import { pruneSelection } from './staleness';
import { PlaylistManager } from './library/PlaylistManager';
import { TrackBrowser } from './library/TrackBrowser';

type Stage =
  | { phase: 'idle' }
  | { phase: 'working'; message: string }
  | { phase: 'removal'; plan: RemovalPlan }
  | { phase: 'orphans'; report: OrphanReport }
  | { phase: 'done'; message: string; ok: boolean; details: string[] }
  | { phase: 'error'; message: string };

const EDIT_FIELDS = [
  ['title', 'Title'],
  ['artist', 'Artist'],
  ['album', 'Album'],
  ['genre', 'Genre'],
] as const;

type EditField = (typeof EDIT_FIELDS)[number][0];

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

type LibraryView = 'tracks' | 'playlists';

/**
 * The library of a real iPod, with the ways to change it: filter, sort, group and select tracks,
 * remove them and their files, fix the details of one track or of many at once, manage playlists,
 * and delete files no track uses. Everything that writes needs the backup, and removals and
 * playlist changes go through a plan that changes nothing first.
 */
export function ManagePanel({
  root,
  tracks,
  playlists = [],
  backup,
  onChanged,
  onNeedBackup,
}: {
  root: DirectoryEntry;
  tracks: TrackInfo[];
  playlists?: PlaylistInfo[];
  backup: BackupReport | null;
  onChanged: () => void;
  /** Takes the person to the backup step. */
  onNeedBackup?: () => void;
}) {
  const [view, setView] = useState<LibraryView>('tracks');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [stage, setStage] = useState<Stage>({ phase: 'idle' });
  const [draft, setDraft] = useState<Partial<Record<EditField, string>>>({});

  const ready = backup !== null && backup.complete;
  const busy = stage.phase === 'working';
  const rows = useMemo(() => rowsOf(tracks), [tracks]);
  const chosen = useMemo(() => selectedRows(rows, selected), [rows, selected]);
  const only = chosen.length === 1 ? chosen[0]?.track : undefined;

  // The library was read again. Selected tracks that are gone are dropped, a plan made for the old
  // library is thrown away, and an edit draft for a track that may have changed is cleared.
  useEffect(() => {
    setSelected((current) => pruneSelection(current, rows.map((row) => row.key)));
    setStage((current) => (current.phase === 'removal' || current.phase === 'orphans' ? { phase: 'idle' } : current));
    setDraft({});
  }, [rows]);

  /** Asks Chrome for write access. An iPod that is not there says so in plain words instead of throwing. */
  async function allowed(refusal: string): Promise<boolean> {
    try {
      if (await allowWriting(root)) return true;
      setStage({ phase: 'error', message: refusal });
    } catch (error) {
      setStage({ phase: 'error', message: describeError(error, { writing: true }) });
    }
    return false;
  }

  function select(next: Set<string>) {
    setSelected(next);
    setDraft({});
    setStage({ phase: 'idle' });
  }

  function show(next: LibraryView) {
    setView(next);
    setStage({ phase: 'idle' });
  }

  const planner = (message: string) => ({ onProgress: (text: string) => setStage({ phase: 'working', message: text || message }) });

  async function planRemove() {
    setStage({ phase: 'working', message: 'Planning the removal...' });
    try {
      const plan = await planRemoval(root as unknown as IpodRoot, newEngine, [...selected], planner('Planning the removal...'));
      setStage({ phase: 'removal', plan });
    } catch (error) {
      setStage({ phase: 'error', message: describeError(error) });
    }
  }

  async function remove(plan: RemovalPlan) {
    if (!(await allowed('Chrome was not allowed to change the iPod, so nothing was changed.'))) return;
    setStage({ phase: 'working', message: 'Removing...' });
    try {
      const report = await applyRemoval(plan, root as unknown as IpodRoot, newEngine, { backup, onProgress: (progress) => setStage({ phase: 'working', message: progress.message }) });
      const ok = report.verified && !report.rolledBack && !report.failures.length;
      setStage({
        phase: 'done',
        ok,
        message: ok ? `Removed ${plural(plan.tracks.length, 'track')} and deleted ${plural(report.deleted.length, 'file')}.` : 'The removal did not finish.',
        details: [...report.failures, ...report.orphans.map((orphan) => `${orphan.path}: ${orphan.reason}`)],
      });
      if (ok) {
        setSelected(new Set());
        onChanged();
      }
    } catch (error) {
      setStage({ phase: 'error', message: describeError(error, { writing: true }) });
    }
  }

  async function save(track: TrackInfo) {
    const fields: Partial<Record<EditField, string>> = {};
    for (const [name] of EDIT_FIELDS) {
      const value = draft[name];
      if (value !== undefined && value !== (track[name] ?? '')) fields[name] = value;
    }
    if (!Object.keys(fields).length) {
      setStage({ phase: 'error', message: 'Nothing was changed.' });
      return;
    }
    if (!(await allowed('Chrome was not allowed to change the iPod, so nothing was changed.'))) return;
    setStage({ phase: 'working', message: 'Saving the changes...' });
    try {
      const { report } = await editTracks(root as unknown as IpodRoot, newEngine, [{ key: trackKey(track), fields }], {
        backup,
        // The plan reports plain text and the write reports a progress object.
        onProgress: (progress: string | { message: string }) => setStage({ phase: 'working', message: typeof progress === 'string' ? progress : progress.message }),
      });
      const ok = report.verified && !report.rolledBack && !report.failures.length;
      setStage({ phase: 'done', ok, message: ok ? 'Saved.' : 'The change did not finish.', details: report.failures });
      if (ok) {
        setSelected(new Set());
        setDraft({});
        onChanged();
      }
    } catch (error) {
      setStage({ phase: 'error', message: describeError(error, { writing: true }) });
    }
  }

  /** Changes artist, album, album artist, genre and kind of many tracks, one edit per track, in one write. */
  async function applyBulk(edits: TrackEdit[]): Promise<boolean> {
    if (!edits.length) return false;
    if (!(await allowed('Chrome was not allowed to change the iPod, so nothing was changed.'))) return false;
    setStage({ phase: 'working', message: `Saving changes to ${plural(edits.length, 'track')}...` });
    try {
      const { report } = await editTracks(root as unknown as IpodRoot, newEngine, edits, {
        backup,
        onProgress: (progress: string | { message: string }) => setStage({ phase: 'working', message: typeof progress === 'string' ? progress : progress.message }),
      });
      const ok = report.verified && !report.rolledBack && !report.failures.length;
      setStage({ phase: 'done', ok, message: ok ? `Changed ${plural(edits.length, 'track')} in one write. The iPod was read back and matches.` : 'The change did not finish.', details: report.failures });
      if (ok) onChanged();
      return ok;
    } catch (error) {
      setStage({ phase: 'error', message: describeError(error, { writing: true }) });
      return false;
    }
  }

  async function look() {
    setStage({ phase: 'working', message: 'Looking for files no track uses...' });
    try {
      setStage({ phase: 'orphans', report: await findOrphans(root as unknown as IpodRoot, newEngine) });
    } catch (error) {
      setStage({ phase: 'error', message: describeError(error) });
    }
  }

  async function clean(report: OrphanReport) {
    if (!(await allowed('Chrome was not allowed to change the iPod, so nothing was deleted.'))) return;
    setStage({ phase: 'working', message: 'Deleting...' });
    try {
      const result = await removeOrphans(root as unknown as IpodRoot, newEngine, report.orphans);
      setStage({
        phase: 'done',
        ok: result.kept.length === 0,
        message: `Deleted ${plural(result.removed.length, 'file')}.`,
        details: result.kept.map((kept) => `${kept.path}: ${kept.reason}`),
      });
    } catch (error) {
      setStage({ phase: 'error', message: describeError(error, { writing: true }) });
    }
  }

  return (
    <section class="card">
      <h3>Your library</h3>
      <p class="card-lead">Find tracks, select them, then remove them, change their details together or put them in a playlist.</p>
      <BackupGate ready={ready} onGo={onNeedBackup} />
      {tracks.length === 0 ? (
        <div class="empty">
          <strong>No music yet</strong>
          Open the Add music tab to put songs, podcasts, audiobooks or video on this iPod.
        </div>
      ) : (
        <>
          <div class="subtabs" role="tablist" aria-label="Library views">
            <button type="button" role="tab" class="subtab" aria-selected={view === 'tracks'} onClick={() => show('tracks')}>
              Tracks <span class="badge">{tracks.length}</span>
            </button>
            <button type="button" role="tab" class="subtab" aria-selected={view === 'playlists'} onClick={() => show('playlists')}>
              Playlists <span class="badge">{playlists.length}</span>
            </button>
          </div>

          {view === 'tracks' ? (
            <>
              <div class="actions">
                <button type="button" class="secondary" disabled={busy} onClick={() => void look()}>
                  Look for leftover files
                </button>
              </div>
              <TrackBrowser
                rows={rows}
                selected={selected}
                onSelect={select}
                disabled={busy}
                actions={
                  <button type="button" class="secondary" disabled={busy || !ready} onClick={() => void planRemove()}>
                    Remove selected
                  </button>
                }
              />

              {only ? (
                <div>
                  <h4>Edit this track</h4>
                  {EDIT_FIELDS.map(([name, label]) => (
                    <label class="field" key={name}>
                      {label}{' '}
                      <input type="text" value={draft[name] ?? only[name] ?? ''} disabled={busy} onInput={(event) => setDraft({ ...draft, [name]: (event.target as HTMLInputElement).value })} />
                    </label>
                  ))}
                  <button type="button" disabled={busy || !ready} onClick={() => void save(only)}>
                    Save changes to the iPod
                  </button>
                </div>
              ) : null}

              {chosen.length ? <BulkEdit selected={chosen} busy={busy} ready={ready} onApply={applyBulk} /> : null}
            </>
          ) : (
            <PlaylistManager root={root} rows={rows} playlists={playlists} selected={selected} onSelect={select} backup={backup} onChanged={onChanged} />
          )}
        </>
      )}

      {stage.phase === 'working' ? (
        <p class="callout info" role="status">
          {stage.message}
        </p>
      ) : null}
      {stage.phase === 'error' ? (
        <div class="result no" role="alert">
          <p>{stage.message}</p>
        </div>
      ) : null}
      {stage.phase === 'removal' ? (
        <>
          <div class="result ok" role="status">
            <p>
              Ready to remove {plural(stage.plan.tracks.length, 'track')} and delete {plural(stage.plan.files.length, 'file')}.
            </p>
          </div>
          {stage.plan.kept.length ? (
            <ul class="files">
              {stage.plan.kept.map((kept) => (
                <li key={kept.path}>
                  {kept.path}: {kept.reason}
                </li>
              ))}
            </ul>
          ) : null}
          <button type="button" class="danger" disabled={!ready} onClick={() => void remove(stage.plan)}>
            Remove from the iPod
          </button>
        </>
      ) : null}
      {stage.phase === 'orphans' ? (
        stage.report.orphans.length ? (
          <>
            <p class="note">
              {plural(stage.report.orphans.length, 'file')} in the music folders that no track uses ({formatBytes(stage.report.orphans.reduce((total, file) => total + (file.size ?? 0), 0))}).
            </p>
            <ul class="files">
              {stage.report.orphans.map((file) => (
                <li key={file.path}>
                  {file.path} <span class="muted">{file.size === null ? '' : formatBytes(file.size)}{file.madeByLibgpod ? ', named like a file this app copies' : ''}</span>
                </li>
              ))}
            </ul>
            <button type="button" class="danger" onClick={() => void clean(stage.report)}>
              Delete these files
            </button>
          </>
        ) : (
          <div class="result ok" role="status">
            <p>No leftover files. {plural(stage.report.referenced, 'file')} in the music folders, all used by the library.{stage.report.missingFiles.length ? ` ${plural(stage.report.missingFiles.length, 'track')} point at a file that is not there.` : ''}</p>
          </div>
        )
      ) : null}
      {stage.phase === 'done' ? (
        <>
          <div class={`result ${stage.ok ? 'ok' : 'no'}`} role={stage.ok ? 'status' : 'alert'}>
            <p>{stage.message}</p>
          </div>
          {stage.details.length ? (
            <ul class="files">
              {stage.details.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
