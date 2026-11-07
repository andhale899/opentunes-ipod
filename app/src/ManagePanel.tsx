import { useMemo, useState } from 'preact/hooks';
import { formatBytes, formatDuration, kindLabel } from '@opentunes/core';
import {
  applyRemoval,
  editTracks,
  findOrphans,
  planRemoval,
  removeOrphans,
  trackKey,
  type BackupReport,
  type DirectoryEntry,
  type IpodRoot,
  type OrphanReport,
  type RemovalPlan,
  type TrackInfo,
} from '@opentunes/engine';
import { describeError } from './describeError';
import { newEngine } from './engineLoader';
import { BackupGate } from './BackupGate';
import { allowWriting } from './WriteBackPanel';

const MAX_ROWS = 200;

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

/**
 * The library of a real iPod, with the ways to change it: search, remove tracks and their files,
 * fix the title, artist, album and genre of one track, and delete files no track uses. Everything
 * that writes needs the backup, and goes through a plan that changes nothing first.
 */
export function ManagePanel({
  root,
  tracks,
  backup,
  onChanged,
  onNeedBackup,
}: {
  root: DirectoryEntry;
  tracks: TrackInfo[];
  backup: BackupReport | null;
  onChanged: () => void;
  /** Takes the person to the backup step. */
  onNeedBackup?: () => void;
}) {
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [stage, setStage] = useState<Stage>({ phase: 'idle' });
  const [draft, setDraft] = useState<Partial<Record<EditField, string>>>({});

  const ready = backup !== null && backup.complete;
  const busy = stage.phase === 'working';
  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const all = tracks.map((track) => ({ track, key: trackKey(track) }));
    return needle ? all.filter(({ track }) => [track.title, track.artist, track.album].some((text) => text?.toLowerCase().includes(needle))) : all;
  }, [tracks, search]);

  const only = selected.size === 1 ? tracks.find((track) => selected.has(trackKey(track))) : undefined;

  function toggle(key: string) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    setDraft({});
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
    if (!(await allowWriting(root))) {
      setStage({ phase: 'error', message: 'Chrome was not allowed to change the iPod, so nothing was changed.' });
      return;
    }
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
      setStage({ phase: 'error', message: describeError(error) });
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
    if (!(await allowWriting(root))) {
      setStage({ phase: 'error', message: 'Chrome was not allowed to change the iPod, so nothing was changed.' });
      return;
    }
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
      setStage({ phase: 'error', message: describeError(error) });
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
    if (!(await allowWriting(root))) {
      setStage({ phase: 'error', message: 'Chrome was not allowed to change the iPod, so nothing was deleted.' });
      return;
    }
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
      setStage({ phase: 'error', message: describeError(error) });
    }
  }

  return (
    <section class="card">
      <h3>Your library</h3>
      <p class="card-lead">Select tracks to remove them, or select one to edit its details.</p>
      <BackupGate ready={ready} onGo={onNeedBackup} />
      {tracks.length === 0 ? (
        <div class="empty">
          <strong>No music yet</strong>
          Open the Add music tab to put songs, podcasts, audiobooks or video on this iPod.
        </div>
      ) : (
        <>
          <div class="toolbar">
            <label class="field">
              Search
              <input type="search" value={search} onInput={(event) => setSearch((event.target as HTMLInputElement).value)} placeholder="Title, artist or album" />
            </label>
            <div class="spacer" />
            <button type="button" class="secondary" disabled={busy} onClick={() => void look()}>
              Look for leftover files
            </button>
          </div>
          <div class="table-wrap">
            <table class="library">
              <thead>
                <tr>
                  <th />
                  <th>Title</th>
                  <th>Artist</th>
                  <th>Album</th>
                  <th>Kind</th>
                  <th class="num">Length</th>
                  <th class="num">Size</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, MAX_ROWS).map(({ track, key }) => (
                  <tr key={track.handle} title={track.ipod_path ?? ''} class={selected.has(key) ? 'selected' : ''}>
                    <td>
                      <input type="checkbox" checked={selected.has(key)} onChange={() => toggle(key)} aria-label={`Select ${track.title ?? 'track'}`} disabled={busy} />
                    </td>
                    <td class="cell-title">{track.title ?? '(no title)'}</td>
                    <td>{track.artist ?? ''}</td>
                    <td>{track.album ?? ''}</td>
                    <td>{kindLabel(track.kind)}</td>
                    <td class="num">{formatDuration(track.tracklen)}</td>
                    <td class="num">{formatBytes(track.size)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length > MAX_ROWS ? (
              <p class="muted">
                Showing the first {MAX_ROWS} of {rows.length}. Search to narrow the list.
              </p>
            ) : null}
          </div>
        </>
      )}

      {selected.size ? (
        <div class="actions">
          <span class="note">{plural(selected.size, 'track')} selected</span>
          <button type="button" class="secondary" disabled={busy || !ready} onClick={() => void planRemove()}>
            Remove selected
          </button>
          <button type="button" class="ghost" disabled={busy} onClick={() => { setSelected(new Set()); setDraft({}); }}>
            Clear selection
          </button>
        </div>
      ) : null}

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
