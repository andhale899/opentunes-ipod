import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { formatBytes, formatDuration } from '@opentunes/core';
import { type BackupReport, type DirectoryEntry, type IpodRoot, type PlaylistInfo, type RemovalPlan, type TrackInfo } from '@opentunes/engine';
import { applyRemoval, changePlaylists, planRemoval } from '../tracked';
import { startActivity } from '../activity';
import { WriteWait } from '../BackupGate';
import { ConfirmBox, Notice, useOnce } from '../controls';
import { useWriteReady } from '../writeReady';
import { describeError } from '../describeError';
import { newEngine } from '../engineLoader';
import { allowWriting } from '../WriteBackPanel';
import { ModelError, hostOf, keyProblem, scrub, type ProviderConfig } from '../ai/providers';
import { MAX_GROUPS_PER_REQUEST, buildDuplicateDigest, groupsToSend, reviewDuplicates } from '../ai/review';
import { initSession, sessionChanged, useSessionWatch } from '../ai/session';
import type { Dropped } from '../ai/schema';
import {
  applyVerdicts,
  buildPlaylistSteps,
  changeKeep,
  defaultChoices,
  findDuplicates,
  removalKeys,
  selectSure,
  tickGroup,
  toggleRemove,
  type Choices,
  type DupGroup,
  type DuplicateReport,
  type GroupVerdict,
  type PlaylistSteps,
} from './duplicates';

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;
const formatCount = (count: number): string => count.toLocaleString('en');
/** Groups drawn at a time. The rest wait behind "Show more", so a big library stays quick. */
const PAGE = 40;
/** How long to wait for a model before stopping, in milliseconds. */
const ASK_LIMIT_MS = 5 * 60_000;

const LEVEL_LABEL = { sure: 'Sure', likely: 'Likely', fuzzy: 'Possible' } as const;
const VERDICT_LABEL = { duplicate: 'The AI says: duplicate', 'different-versions': 'The AI says: different versions', unsure: 'The AI is unsure' } as const;

type Stage =
  | { phase: 'idle' }
  | { phase: 'working'; message: string }
  | { phase: 'plan'; plan: RemovalPlan; steps: PlaylistSteps; keys: string[] }
  | { phase: 'done'; ok: boolean; message: string; details: string[] }
  | { phase: 'error'; message: string };

/** Everything the person has chosen about one report. A new report (the library changed) starts from scratch. */
interface Held {
  report: DuplicateReport<TrackInfo>;
  choices: Choices;
  verdicts: Map<number, GroupVerdict>;
  dropped: Dropped[];
  note: string;
}

const succeeded = (report: { verified: boolean; rolledBack: boolean; failures: string[] }): boolean => report.verified && !report.rolledBack && !report.failures.length;

/**
 * Find duplicates: songs that are on the iPod more than once, with the copy to keep chosen for each
 * group and the others ticked for removal. Removal follows the Library tab's safe flow: plan in
 * memory, show it, then write behind the backup gate, read the iPod back, and refresh. The AI review
 * is optional and only changes the tick boxes.
 */
export function DuplicatesPanel({
  root,
  tracks,
  playlists,
  backup,
  onChanged,
}: {
  root: DirectoryEntry;
  tracks: TrackInfo[];
  playlists: PlaylistInfo[];
  backup: BackupReport | null;
  onChanged: () => void;
}) {
  const session = initSession();
  const [, setTick] = useState(0);
  const bump = () => {
    setTick((tick) => tick + 1);
    sessionChanged();
  };
  useSessionWatch();
  const report = useMemo(() => findDuplicates(tracks, playlists), [tracks, playlists]);
  const everyGroup = useMemo(() => [...report.groups, ...report.candidates], [report]);
  const [held, setHeld] = useState<Held | null>(null);
  const now: Held = held && held.report === report ? held : { report, choices: defaultChoices(everyGroup), verdicts: new Map(), dropped: [], note: '' };
  const update = (change: Partial<Omit<Held, 'report'>>) => setHeld({ ...now, ...change });

  const [stage, setStage] = useState<Stage>({ phase: 'idle' });
  const [intoPlaylists, setIntoPlaylists] = useState(true);
  const [shown, setShown] = useState(PAGE);
  const [asking, setAsking] = useState(false);
  /** Set once the ticked duplicates are planned and shown, while "Remove from the iPod" asks first. */
  const [confirming, setConfirming] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const once = useOnce();
  useEffect(() => () => controller.current?.abort(), []);

  const { ready, backupOk, wait } = useWriteReady(backup);
  const busy = stage.phase === 'working' || asking;

  // Fuzzy candidates appear only once the AI has looked at them.
  const visibleCandidates = report.candidates.filter((group) => now.verdicts.has(group.id));
  const visible: DupGroup<TrackInfo>[] = [...report.groups, ...visibleCandidates];
  const choiceOf = (group: DupGroup<TrackInfo>) => now.choices.get(group.id) ?? { keep: group.keep, remove: new Set<string>() };

  const could = report.groups.reduce((total, group) => total + group.members.length - 1, 0);
  const couldFree = report.groups.reduce((total, group) => total + group.bytesFreed, 0);
  const sureCount = report.groups.filter((group) => group.level === 'sure').length;
  const ticked = removalKeys(visible, now.choices);

  function change(next: Choices) {
    update({ choices: next });
    setStage({ phase: 'idle' });
    setConfirming(false);
  }
  function setChoice(group: DupGroup<TrackInfo>, choice: ReturnType<typeof choiceOf>) {
    change(new Map(now.choices).set(group.id, choice));
  }

  // ------------------------------------------------------------ removal

  async function plan() {
    if (!ticked.keys.length) return;
    setConfirming(false);
    setStage({ phase: 'working', message: 'Planning the removal...' });
    try {
      const steps = intoPlaylists ? buildPlaylistSteps(visible, now.choices, playlists) : { steps: [], lines: [], skipped: [] };
      const result = await planRemoval(root as unknown as IpodRoot, newEngine, ticked.keys, { onProgress: (message) => setStage({ phase: 'working', message: message || 'Planning the removal...' }) });
      setStage({ phase: 'plan', plan: result, steps, keys: ticked.keys });
    } catch (error) {
      setStage({ phase: 'error', message: describeError(error) });
    }
  }

  /** Runs from the button. Chrome's permission prompt must come first, straight from the click. */
  async function remove(chosen: Extract<Stage, { phase: 'plan' }>) {
    setConfirming(false);
    await once(() => removeNow(chosen));
  }

  async function removeNow(chosen: Extract<Stage, { phase: 'plan' }>) {
    try {
      if (!(await allowWriting(root))) {
        setStage({ phase: 'error', message: 'Chrome was not allowed to change the iPod, so nothing was changed.' });
        return;
      }
    } catch (error) {
      setStage({ phase: 'error', message: describeError(error, { writing: true }) });
      return;
    }
    if (!ready) return;
    const iPod = root as unknown as IpodRoot;
    const progress = (value: string | { message: string }) => setStage({ phase: 'working', message: typeof value === 'string' ? value : value.message });
    const lines: string[] = [];
    let changed = false;
    try {
      let plan = chosen.plan;
      if (chosen.steps.steps.length) {
        // The kept songs go into the playlists first. If that fails nothing has been removed and the iPod was put back.
        setStage({ phase: 'working', message: 'Putting the songs you keep into their playlists...' });
        const { report: written } = await changePlaylists(iPod, newEngine, chosen.steps.steps, { backup, onProgress: progress });
        if (!succeeded(written)) {
          setStage({ phase: 'done', ok: false, message: 'The playlist step did not finish, so the iPod was put back as it was and nothing was removed.', details: written.failures });
          return;
        }
        changed = true;
        lines.push(...chosen.steps.lines);
        // The plan was made before the playlists changed, so plan again on what is there now.
        setStage({ phase: 'working', message: 'Planning the removal again after the playlist change...' });
        plan = await planRemoval(iPod, newEngine, chosen.keys, { onProgress: (message) => setStage({ phase: 'working', message: message || 'Planning the removal...' }) });
        if (plan.tracks.length !== chosen.plan.tracks.length) throw new Error('The library changed while this was running, so nothing was removed. Look for duplicates again.');
      }
      setStage({ phase: 'working', message: 'Removing...' });
      const result = await applyRemoval(plan, iPod, newEngine, { backup, onProgress: progress });
      const ok = succeeded(result);
      if (ok) changed = true;
      setStage({
        phase: 'done',
        ok,
        message: ok ? `Removed ${plural(plan.tracks.length, 'track')} and deleted ${plural(result.deleted.length, 'file')}.${lines.length ? ' ' + lines.join(' ') : ''}` : 'The removal did not finish.',
        details: [...result.failures, ...result.orphans.map((orphan) => `${orphan.path}: ${orphan.reason}`), ...(ok ? chosen.steps.skipped : [])],
      });
    } catch (error) {
      setStage({ phase: 'error', message: `${lines.length ? 'The songs you keep were put into their playlists, but ' : ''}${describeError(error, { writing: true })}` });
    }
    if (changed) onChanged();
  }

  // ------------------------------------------------------------ the AI

  const settings = session.settings;
  const provider = settings.provider;
  const apiKey = session.keys[provider] ?? '';
  const config: ProviderConfig = { provider, apiKey, model: settings.models[provider], baseUrl: settings.baseUrl };
  const host = hostOf(config);
  const problem = keyProblem(apiKey);
  const setUp = !problem && settings.models[provider].trim() !== '' && host !== null;
  const reviewedIds = new Set(now.verdicts.keys());
  const outgoing = useMemo(() => groupsToSend(everyGroup, reviewedIds), [everyGroup, now.verdicts]);
  const digest = useMemo(() => buildDuplicateDigest(outgoing.send), [outgoing]);
  const reviewNeeded = everyGroup.length > 0;

  async function ask() {
    if (!session.optIn || !setUp || !digest.groups.length || asking) return;
    const abort = new AbortController();
    controller.current = abort;
    setAsking(true);
    const activity = startActivity(`Asking ${host as string}`, { message: `Sent ${plural(digest.groups.length, 'group')}. Waiting for the model.` });
    let timedOut = false;
    const limit = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, ASK_LIMIT_MS);
    let answered = false;
    try {
      const outcome = await reviewDuplicates({ config, digest }, { signal: abort.signal });
      const verdicts = new Map(now.verdicts);
      for (const verdict of outcome.verdicts) verdicts.set(verdict.group, verdict);
      answered = true;
      const missing = digest.groups.filter((id) => !outcome.verdicts.some((verdict) => verdict.group === id)).length;
      update({
        verdicts,
        dropped: outcome.dropped,
        note: `The AI gave a verdict on ${plural(outcome.verdicts.length, 'group')}${missing ? `; ${plural(missing, 'group')} got none` : ''}. Nothing has been ticked or changed yet.`,
      });
    } catch (error) {
      const message = timedOut
        ? `No answer after ${ASK_LIMIT_MS / 60_000} minutes, so it was stopped. Nothing was changed.`
        : error instanceof ModelError
          ? error.message
          : scrub(describeError(error), apiKey);
      update({ note: message });
    } finally {
      clearTimeout(limit);
      activity.end(answered);
      if (controller.current === abort) controller.current = null;
      setAsking(false);
    }
  }

  function applyAi() {
    update({ choices: applyVerdicts(everyGroup, now.choices, now.verdicts), note: "The AI's verdicts are now in the tick boxes. Nothing is removed until you press Remove ticked duplicates." });
    setStage({ phase: 'idle' });
  }

  const verdictCounts = { duplicate: 0, 'different-versions': 0, unsure: 0 };
  for (const verdict of now.verdicts.values()) verdictCounts[verdict.verdict] += 1;

  // ------------------------------------------------------------ drawing

  if (!report.groups.length && !report.candidates.length) {
    return (
      <div class="dupes">
        <div class="result ok" role="status">
          <p>No duplicates found among {plural(report.compared, 'track')}.</p>
        </div>
        <p class="note">
          Only music, music videos and podcast episodes are compared. {report.skipped ? `${plural(report.skipped, 'track')} were left out (audiobooks, video, or too few tags to tell).` : ''}
        </p>
        {stage.phase === 'done' ? <Done stage={stage} /> : null}
      </div>
    );
  }

  return (
    <div class="dupes">
      <p class="dup-summary" role="status">
        <strong>
          {plural(report.groups.length, 'group')}, {plural(could, 'track')} that could go, about {formatBytes(couldFree)} freed.
        </strong>{' '}
        <span class="muted">
          {plural(sureCount, 'sure group')} start ticked. {plural(report.groups.length - sureCount, 'likely group')} are for you to check
          {report.candidates.length ? `, and ${report.candidates.length} possible ${report.candidates.length === 1 ? 'match' : 'matches'} with small spelling differences ${report.candidates.length === 1 ? 'waits' : 'wait'} for the AI to look at ${report.candidates.length === 1 ? 'it' : 'them'}` : ''}.
        </span>
      </p>

      <div class="actions">
        <button type="button" class="secondary small" disabled={busy} onClick={() => change(selectSure(visible, now.choices, true))}>
          Select all sure
        </button>
        <button type="button" class="secondary small" disabled={busy} onClick={() => change(selectSure(visible, now.choices, false))}>
          Select none
        </button>
      </div>

      {reviewNeeded ? (
        <details class="dup-ai" open={now.verdicts.size > 0 || undefined}>
          <summary>Ask AI to review (optional)</summary>
          {!setUp ? (
            <p class="callout info">
              {apiKey === ''
                ? 'The AI is not set up. Open the Assistant tab, add a key and pick a model there. This tab uses the same key and the same opt-in.'
                : 'The AI settings are not complete. Open the Assistant tab to fix the key, the model or the address.'}
            </p>
          ) : (
            <>
              <label class="check ai-optin">
                <input
                  type="checkbox"
                  checked={session.optIn}
                  onChange={(event) => {
                    session.optIn = (event.target as HTMLInputElement).checked;
                    bump();
                  }}
                />
                <span>
                  Send the titles, artists, albums, years, lengths and bitrates of the tracks in these groups (no audio, no file paths, no sizes, no playlist names) to <strong>{host}</strong> when I press Ask AI to review.
                </span>
              </label>
              <p class="note">This is the same opt-in as in the Assistant tab, and it starts off every time the page loads. The AI only proposes verdicts. It cannot remove anything.</p>
              <p class="note ai-summary" role="status">
                This request would send {plural(digest.groups.length, 'group')} ({plural(digest.tracks, 'track')}, about {formatCount(digest.tokens)} tokens of text) to {host}.
                {outgoing.waiting ? ` ${plural(outgoing.waiting, 'more group')} wait for the next request (at most ${MAX_GROUPS_PER_REQUEST} at a time).` : ''}
              </p>
              <div class="actions">
                <button type="button" disabled={!session.optIn || busy} onClick={() => void ask()}>
                  Ask AI to review
                </button>
                {asking ? (
                  <button type="button" class="secondary" onClick={() => controller.current?.abort()}>
                    Stop
                  </button>
                ) : null}
                {!session.optIn ? <span class="note">Tick the box above first.</span> : null}
              </div>
            </>
          )}
          {now.note ? (
            <p class="callout info" role="status">
              {now.note}
            </p>
          ) : null}
          {now.verdicts.size ? (
            <div class="actions">
              <span class="note">
                {verdictCounts.duplicate} duplicate, {verdictCounts['different-versions']} different versions, {verdictCounts.unsure} unsure.
              </span>
              <button type="button" class="secondary" disabled={busy} onClick={applyAi}>
                Apply the AI's verdicts
              </button>
            </div>
          ) : null}
          {now.dropped.length ? (
            <details>
              <summary>{plural(now.dropped.length, 'thing')} the AI said {now.dropped.length === 1 ? 'was' : 'were'} left out</summary>
              <ul class="files">
                {now.dropped.map((entry, at) => (
                  <li key={at}>
                    {entry.what}: {entry.why}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </details>
      ) : null}

      <div class="dup-groups">
        {visible.slice(0, shown).map((group) => {
          const choice = choiceOf(group);
          const verdict = now.verdicts.get(group.id);
          const allTicked = group.members.every((member) => member.key === choice.keep || choice.remove.has(member.key));
          return (
            <article class={`dup-group dup-${group.level}`} key={group.id} aria-label={`Duplicate group ${group.id}`}>
              <header class="dup-head">
                <span class={`dup-badge dup-badge-${group.level}`}>{LEVEL_LABEL[group.level]}</span>
                <span class="dup-why">{group.why}</span>
                <label class="check dup-all">
                  <input type="checkbox" checked={allTicked} disabled={busy} onChange={() => setChoice(group, tickGroup(group, choice, !allTicked))} />
                  Remove all but the one kept
                </label>
              </header>
              {verdict ? (
                <p class={`dup-verdict dup-verdict-${verdict.verdict}`}>
                  <strong>{VERDICT_LABEL[verdict.verdict]}.</strong> {verdict.reason}
                </p>
              ) : null}
              <div class="dup-rows" role="radiogroup" aria-label={`Which copy to keep in group ${group.id}`}>
                {group.members.map((member) => {
                  const track = member.track;
                  const keeping = member.key === choice.keep;
                  return (
                    <div class={`dup-row${keeping ? ' dup-keep' : ''}`} key={member.key}>
                      <div class="dup-controls">
                        <label class="check">
                          <input type="radio" name={`keep-${group.id}`} checked={keeping} disabled={busy} onChange={() => setChoice(group, changeKeep(group, choice, member.key))} />
                          Keep this one
                        </label>
                        <label class="check">
                          <input
                            type="checkbox"
                            aria-label={`Remove ${track.title ?? 'this track'}`}
                            checked={!keeping && choice.remove.has(member.key)}
                            disabled={busy || keeping}
                            onChange={(event) => setChoice(group, toggleRemove(choice, member.key, (event.target as HTMLInputElement).checked))}
                          />
                          Remove
                        </label>
                      </div>
                      <div class="dup-info">
                        <strong class="dup-title">{track.title || '(no title)'}</strong>
                        <span class="dup-sub">
                          {track.artist || '(no artist)'}
                          {track.album ? ` - ${track.album}` : ''}
                        </span>
                        <span class="dup-meta muted">
                          {formatDuration(track.tracklen)} · {track.bitrate > 0 ? `${Math.round(track.bitrate)} kbps` : 'bitrate unknown'} · {formatBytes(track.size)} · {plural(track.playcount, 'play')} · {plural(member.playlists, 'playlist')}
                        </span>
                        {keeping ? <span class="dup-reason">Recommended: {group.reason}</span> : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </article>
          );
        })}
      </div>
      {visible.length > shown ? (
        <div class="more-row">
          <button type="button" class="secondary" onClick={() => setShown(shown + PAGE)}>
            Show more ({visible.length - shown} more groups)
          </button>
        </div>
      ) : null}

      <div class="dup-remove">
        <label class="check">
          <input type="checkbox" checked={intoPlaylists} disabled={busy} onChange={(event) => { setIntoPlaylists((event.target as HTMLInputElement).checked); setStage({ phase: 'idle' }); }} />
          Put the song I keep into the playlists the removed copies were in
        </label>
        <p class="note">
          {plural(ticked.keys.length, 'track')} ticked{ticked.keys.length ? `, about ${formatBytes(ticked.bytes)} freed` : ''}.
          {ticked.protectedCount ? ` ${plural(ticked.protectedCount, 'ticked track')} ${ticked.protectedCount === 1 ? 'is' : 'are'} the one kept in another group, so ${ticked.protectedCount === 1 ? 'it stays' : 'they stay'}.` : ''}
        </p>
        <div class="actions">
          <button type="button" class="secondary" disabled={busy || !ready || !ticked.keys.length} onClick={() => void plan()}>
            Remove ticked duplicates
          </button>
          {!backupOk ? <span class="note">Make the backup first (Backup tab).</span> : <WriteWait wait={wait} />}
        </div>
      </div>

      {stage.phase === 'working' ? (
        <p class="callout info" role="status">
          {stage.message}
        </p>
      ) : null}
      {stage.phase === 'error' ? (
        <Notice tone="no">
          <p>{stage.message}</p>
        </Notice>
      ) : null}
      {stage.phase === 'plan' ? (
        <>
          <div class="result ok" role="status">
            <p>
              Ready to remove {plural(stage.plan.tracks.length, 'track')} and delete {plural(stage.plan.files.length, 'file')}.
            </p>
          </div>
          {stage.steps.lines.length ? (
            <>
              <p class="note">First, so no playlist loses a song:</p>
              <ul class="files">
                {stage.steps.lines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </>
          ) : intoPlaylists ? (
            <p class="note">No playlist needs the kept songs added.</p>
          ) : null}
          {stage.steps.skipped.length ? (
            <ul class="files">
              {stage.steps.skipped.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}
          {stage.plan.kept.length ? (
            <ul class="files">
              {stage.plan.kept.map((kept) => (
                <li key={kept.path}>
                  {kept.path}: {kept.reason}
                </li>
              ))}
            </ul>
          ) : null}
          {confirming ? (
            <ConfirmBox
              title={`Remove ${plural(stage.plan.tracks.length, 'track')} from the iPod?`}
              confirmLabel="Remove from the iPod"
              cancelLabel="Do not remove"
              danger
              disabled={!ready || busy}
              onConfirm={() => void remove(stage)}
              onCancel={() => setConfirming(false)}
            >
              <p>
                {plural(stage.plan.tracks.length, 'duplicate track')} and {plural(stage.plan.files.length, 'song file')} are removed from the iPod. The copy you chose to keep in each group stays.
              </p>
              <p>
                The song files are deleted from the iPod. <strong>This cannot be undone from the backup</strong>, because the backup holds the library but no music. To keep a copy of the songs first, use the Offload tab.
              </p>
            </ConfirmBox>
          ) : (
            <button type="button" class="danger" disabled={!ready || busy} onClick={() => setConfirming(true)}>
              Remove from the iPod...
            </button>
          )}
        </>
      ) : null}
      {stage.phase === 'done' ? <Done stage={stage} /> : null}
    </div>
  );
}

function Done({ stage }: { stage: Extract<Stage, { phase: 'done' }> }) {
  return (
    <>
      <Notice tone={stage.ok ? 'ok' : 'no'}>
        <p>{stage.message}</p>
      </Notice>
      {stage.details.length ? (
        <ul class="files">
          {stage.details.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
    </>
  );
}
