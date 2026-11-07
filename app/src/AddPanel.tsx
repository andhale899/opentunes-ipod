import { useRef, useState } from 'preact/hooks';
import { describeDecision, devices, formatBytes, kindLabel, type ContentKind, type DeviceModel } from '@opentunes/core';
import {
  applySync,
  planSync,
  type BackupReport,
  type DeviceInfo,
  type DirectoryEntry,
  type IpodRoot,
  type SyncItem,
  type SyncPlan,
  type SyncProgress,
  type SyncReport,
} from '@opentunes/engine';
import { inspectFile, prepareItem, redecide, type Candidate } from './addFiles';
import { describeError } from './describeError';
import { newEngine } from './engineLoader';
import { allowWriting } from './WriteBackPanel';

type Stage =
  | { phase: 'idle' }
  | { phase: 'reading'; message: string }
  | { phase: 'converting'; message: string; fraction: number }
  | { phase: 'planned'; plan: SyncPlan; items: SyncItem[] }
  | { phase: 'syncing'; progress: SyncProgress | null }
  | { phase: 'done'; report: SyncReport }
  | { phase: 'error'; message: string };

const KINDS: ContentKind[] = ['music', 'audiobook', 'podcast', 'movie', 'tv-show', 'music-video', 'video-podcast'];

/** Models the planner has limits for. A model with none cannot be planned for. */
const PLANNABLE = devices.filter((device) => device.media !== null);

/** Formatted space is a little under the marketing figure, so leave a margin. */
const USABLE_SHARE = 0.98;

function sum(values: (number | null)[]): number {
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

/**
 * Add songs, audiobooks, podcasts and video: pick files, see what will be done with each, convert
 * what the iPod cannot play, then copy with a backup in place. Nothing is written until the last
 * button, and any failure puts the iPod back as it was.
 */
export function AddPanel({
  root,
  device,
  backup,
  onChanged,
}: {
  root: DirectoryEntry;
  device: DeviceInfo | null;
  backup: BackupReport | null;
  /** Called after a sync that changed the iPod, so the page reads it again. */
  onChanged: () => void;
}) {
  const [model, setModel] = useState<DeviceModel>(() => PLANNABLE.find((entry) => entry.id === 'nano-7g') ?? (PLANNABLE[0] as DeviceModel));
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [problems, setProblems] = useState<string[]>([]);
  const [playlist, setPlaylist] = useState('');
  const [stage, setStage] = useState<Stage>({ phase: 'idle' });
  const abort = useRef<AbortController | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  const ready = backup !== null && backup.complete;
  const busy = stage.phase === 'reading' || stage.phase === 'converting' || stage.phase === 'syncing';
  const addable = candidates.filter((candidate) => candidate.decision.action !== 'unsupported');
  const capacityBytes = device && device.capacity_gb > 0 ? Math.round(device.capacity_gb * 1e9 * USABLE_SHARE) : undefined;

  async function choose(files: FileList | null) {
    if (!files?.length) return;
    setStage({ phase: 'reading', message: 'Reading the files...' });
    const added: Candidate[] = [];
    const failed: string[] = [];
    for (const [index, file] of [...files].entries()) {
      setStage({ phase: 'reading', message: `Reading ${index + 1} of ${files.length}: ${file.name}` });
      try {
        added.push(await inspectFile(file, model));
      } catch (error) {
        failed.push(`${file.name}: ${describeError(error)}`);
      }
    }
    setCandidates((previous) => [...previous, ...added]);
    setProblems(failed);
    setStage({ phase: 'idle' });
  }

  function chooseModel(id: string) {
    const next = PLANNABLE.find((entry) => entry.id === id);
    if (!next) return;
    setModel(next);
    setCandidates((previous) => previous.map((candidate) => redecide(candidate, next, candidate.userKind)));
    setStage({ phase: 'idle' });
  }

  function chooseKind(id: string, value: string) {
    const userKind = value === '' ? undefined : (value as ContentKind);
    setCandidates((previous) => previous.map((candidate) => (candidate.id === id ? redecide(candidate, model, userKind) : candidate)));
    setStage({ phase: 'idle' });
  }

  function remove(id: string) {
    setCandidates((previous) => previous.filter((candidate) => candidate.id !== id));
    setStage({ phase: 'idle' });
  }

  async function prepare() {
    const controller = new AbortController();
    abort.current = controller;
    const items: SyncItem[] = [];
    try {
      for (const [index, candidate] of addable.entries()) {
        const label = `${index + 1} of ${addable.length}: ${candidate.file.name}`;
        setStage({ phase: 'converting', message: label, fraction: 0 });
        const item = await prepareItem(candidate, {
          playlist: playlist.trim() || undefined,
          signal: controller.signal,
          onProgress: (fraction) => setStage({ phase: 'converting', message: label, fraction }),
        });
        if (item) items.push(item);
      }
      setStage({ phase: 'reading', message: 'Checking the iPod and planning...' });
      const plan = await planSync(root as unknown as IpodRoot, newEngine, items, {
        capacityBytes,
        onProgress: (message) => setStage({ phase: 'reading', message }),
      });
      setStage({ phase: 'planned', plan, items });
    } catch (error) {
      setStage({ phase: 'error', message: controller.signal.aborted ? 'Stopped. Nothing was written to the iPod.' : describeError(error) });
    } finally {
      abort.current = null;
    }
  }

  async function sync(plan: SyncPlan) {
    // Chrome only shows its permission prompt straight from a click, so ask before anything else.
    if (!(await allowWriting(root))) {
      setStage({ phase: 'error', message: 'Chrome was not allowed to change the iPod, so nothing was written.' });
      return;
    }
    const controller = new AbortController();
    abort.current = controller;
    setStage({ phase: 'syncing', progress: null });
    try {
      const report = await applySync(plan, root as unknown as IpodRoot, newEngine, {
        backup,
        signal: controller.signal,
        onProgress: (progress) => setStage({ phase: 'syncing', progress }),
      });
      setStage({ phase: 'done', report });
      if (report.verified && !report.rolledBack) {
        setCandidates([]);
        onChanged();
      }
    } catch (error) {
      setStage({ phase: 'error', message: describeError(error) });
    } finally {
      abort.current = null;
    }
  }

  return (
    <section class="card">
      <h3>Add to the iPod</h3>
      <p class="muted">
        Pick music, audiobooks, podcasts or video. Each file is read and checked against what the iPod plays. Files it cannot play are converted in this page, nothing is uploaded. The iPod is not touched until you press the last button, and that needs the backup above.
      </p>

      <label class="field">
        iPod model{' '}
        <select value={model.id} onChange={(event) => chooseModel((event.target as HTMLSelectElement).value)} disabled={busy}>
          {PLANNABLE.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
        </select>
      </label>

      <div class="actions">
        <button type="button" disabled={busy} onClick={() => picker.current?.click()}>
          Choose files
        </button>
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            const input = event.target as HTMLInputElement;
            void choose(input.files).then(() => {
              input.value = '';
            });
          }}
        />
        {candidates.length ? (
          <button type="button" class="secondary" disabled={busy} onClick={() => { setCandidates([]); setProblems([]); setStage({ phase: 'idle' }); }}>
            Clear the list
          </button>
        ) : null}
      </div>

      {problems.length ? (
        <div class="result no" role="alert">
          {problems.map((problem) => (
            <p key={problem}>{problem}</p>
          ))}
        </div>
      ) : null}

      {candidates.length ? (
        <div class="table-wrap">
          <table class="library">
            <thead>
              <tr>
                <th>File</th>
                <th>Kind</th>
                <th>What happens</th>
                <th>On the iPod</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {candidates.map((candidate) => {
                const unsupported = candidate.decision.action === 'unsupported';
                return (
                  <tr key={candidate.id}>
                    <td title={candidate.file.name}>{candidate.info.tags.title ?? candidate.file.name}</td>
                    <td>
                      <select
                        value={candidate.userKind ?? ''}
                        disabled={busy}
                        onChange={(event) => chooseKind(candidate.id, (event.target as HTMLSelectElement).value)}
                        aria-label={`Kind of ${candidate.file.name}`}
                      >
                        <option value="">{kindLabel(candidate.decision.kind)} (guessed)</option>
                        {KINDS.map((kind) => (
                          <option key={kind} value={kind}>
                            {kindLabel(kind)}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td class={unsupported ? 'no-text' : ''} style="white-space: normal; min-width: 16rem">
                      {describeDecision(candidate.decision, candidate.info)}
                    </td>
                    <td>{candidate.estimatedBytes === null ? '' : formatBytes(candidate.estimatedBytes)}</td>
                    <td>
                      <button type="button" class="secondary" disabled={busy} onClick={() => remove(candidate.id)} aria-label={`Leave out ${candidate.file.name}`}>
                        Leave out
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {candidates.length ? (
        <>
          <p class="muted">
            {addable.length} of {candidates.length} can be added, about {formatBytes(sum(addable.map((candidate) => candidate.estimatedBytes)))}.
          </p>
          <label class="field">
            Put them in a playlist (optional){' '}
            <input type="text" value={playlist} disabled={busy} onInput={(event) => setPlaylist((event.target as HTMLInputElement).value)} placeholder="Playlist name" />
          </label>
          <div class="actions">
            <button type="button" disabled={busy || !addable.length} onClick={() => void prepare()}>
              Convert and check
            </button>
            {busy && abort.current ? (
              <button type="button" class="secondary" onClick={() => abort.current?.abort()}>
                Stop
              </button>
            ) : null}
          </div>
        </>
      ) : null}

      {stage.phase === 'reading' ? (
        <p class="note" role="status">
          {stage.message}
        </p>
      ) : null}
      {stage.phase === 'converting' ? (
        <p class="note" role="status">
          Converting {stage.message} ({Math.round(stage.fraction * 100)}%)
        </p>
      ) : null}
      {stage.phase === 'error' ? (
        <div class="result no" role="alert">
          <p>{stage.message}</p>
        </div>
      ) : null}

      {stage.phase === 'planned' ? <Planned plan={stage.plan} ready={ready} onSync={() => void sync(stage.plan)} /> : null}

      {stage.phase === 'syncing' ? (
        <>
          <p class="note" role="status">
            {stage.progress?.message ?? 'Starting...'}
          </p>
          {stage.progress && stage.progress.bytesTotal > 0 ? (
            <progress max={stage.progress.bytesTotal} value={stage.progress.bytesDone} style="width: 100%" />
          ) : null}
          {stage.progress?.bytesPerSecond ? <p class="muted">{formatBytes(stage.progress.bytesPerSecond)}/s</p> : null}
          <button type="button" class="secondary" onClick={() => abort.current?.abort()}>
            Stop and undo
          </button>
        </>
      ) : null}

      {stage.phase === 'done' ? <Done report={stage.report} /> : null}
    </section>
  );
}

function Planned({ plan, ready, onSync }: { plan: SyncPlan; ready: boolean; onSync: () => void }) {
  const fits = plan.space.fits;
  return (
    <>
      <div class={`result ${plan.files.length && fits !== false ? 'ok' : 'no'}`} role="status">
        <p>
          {plan.files.length
            ? `Ready to copy ${plan.files.length} file${plan.files.length === 1 ? '' : 's'} (${formatBytes(plan.bytesToCopy)}).`
            : 'Nothing would be copied.'}
          {fits === false ? ' They do not fit on the iPod.' : ''}
        </p>
      </div>
      {plan.skipped.length || plan.duplicates.length || plan.warnings.length ? (
        <ul class="files">
          {plan.skipped.map((skipped) => (
            <li key={`skip-${skipped.itemId}`}>Skipped: {skipped.reason}</li>
          ))}
          {plan.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
      <details>
        <summary>What will be written</summary>
        <ul class="files">
          {plan.summary.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </details>
      {!ready ? <p class="muted">Make the backup above first. Writing stays off until a complete backup exists from this session.</p> : null}
      <button type="button" disabled={!ready || !plan.files.length || fits === false} onClick={onSync}>
        Put on the iPod
      </button>
    </>
  );
}

function Done({ report }: { report: SyncReport }) {
  const good = report.verified && !report.rolledBack && !report.failures.length;
  return (
    <>
      <div class={`result ${good ? 'ok' : 'no'}`} role={good ? 'status' : 'alert'}>
        <p>
          {good
            ? `Copied ${report.copied.length} file${report.copied.length === 1 ? '' : 's'} and checked the iPod by reading it back. Eject it from the computer before you unplug it.`
            : report.aborted
              ? 'Stopped. What was done has been undone.'
              : 'The sync did not finish.'}
        </p>
      </div>
      {report.failures.length ? (
        <ul class="files">
          {report.failures.map((failure) => (
            <li key={failure}>{failure}</li>
          ))}
        </ul>
      ) : null}
      {report.rollbackFailures.length || report.restoreNeeded ? (
        <div class="result no" role="alert">
          <p>The iPod could not be put back completely. Do not use it as it is: restore the backup below.</p>
          {report.rollbackFailures.map((failure) => (
            <p key={failure}>{failure}</p>
          ))}
        </div>
      ) : null}
    </>
  );
}
