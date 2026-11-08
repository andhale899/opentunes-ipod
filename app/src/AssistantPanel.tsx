import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { type BackupReport, type DirectoryEntry, type IpodRoot, type LibraryReport, type PlaylistInfo, type TrackInfo } from '@opentunes/engine';
import { changePlaylists, editTracks, planEdits, planPlaylistChanges } from './tracked';
import { BackupGate } from './BackupGate';
import { describeError } from './describeError';
import { newEngine } from './engineLoader';
import { allowWriting } from './WriteBackPanel';
import { startActivity } from './activity';
import { assertSafe, buildEdits, buildPlaylistChanges } from './ai/apply';
import { ask, scopeText, summaryOf } from './ai/assistant';
import { AssistantSettings } from './ai/AssistantSettings';
import { MAX_TRACKS_PER_REQUEST, buildDigest, digestPart, selectIds } from './ai/digest';
import { ModelError, cleanKey, hostOf, keyProblem, listModels, scrub, type ProviderConfig } from './ai/providers';
import { ProposalPreview } from './ai/ProposalPreview';
import { browserStorage, forgetKeys, saveSettings, type Settings } from './ai/settings';
import { initSession, markTouched, saveDraft, session, type Turn } from './ai/session';

const EXAMPLES = [
  'Fix spelling and casing of artists and albums',
  'Mark audiobook chapters as audiobooks and group them by book',
  'Make a playlist for running',
  'Which albums look incomplete?',
];

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;
const formatCount = (count: number): string => count.toLocaleString('en');
const labelOf = (track: { title: string | null; artist: string | null }): string => `${track.title || '(no title)'}${track.artist ? `, ${track.artist}` : ''}`;
const succeeded = (report: LibraryReport): boolean => report.verified && !report.rolledBack && !report.failures.length;

/** How long to wait for a model before stopping, in milliseconds. */
const ASK_LIMIT_MS = 5 * 60_000;

/**
 * Ask a language model to tidy the library. The model only proposes: it never touches the iPod.
 * Everything it proposes is checked, shown as a preview with a tick box on each change, and only
 * what is ticked goes to the same edit and playlist code the Library tab uses, which needs the
 * backup and puts everything back if a write does not read back correctly.
 */
export function AssistantPanel({
  root,
  tracks,
  playlists,
  backup,
  onChanged,
  onNeedBackup,
}: {
  root: DirectoryEntry;
  tracks: TrackInfo[];
  playlists: PlaylistInfo[];
  backup: BackupReport | null;
  onChanged: () => void;
  onNeedBackup?: () => void;
}) {
  const state = initSession();
  const [, setTick] = useState(0);
  const bump = () => setTick((tick) => tick + 1);
  const [keyVersion, setKeyVersion] = useState(0);
  const [storageFailed, setStorageFailed] = useState(false);
  const [prompt, setPromptState] = useState(() => state.draft);
  /** The unsent question is kept in the page's memory, so a switch of tab does not lose it. */
  const setPrompt = (text: string) => {
    state.draft = text;
    saveDraft(text);
    setPromptState(text);
  };
  const [filter, setFilter] = useState('');
  const [partIndex, setPartIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const controller = useRef<AbortController | null>(null);

  const { settings } = state;
  const provider = settings.provider;
  const apiKey = state.keys[provider] ?? '';
  const config: ProviderConfig = { provider, apiKey, model: settings.models[provider], baseUrl: settings.baseUrl };
  const host = hostOf(config);
  const ready = backup !== null && backup.complete;

  // Settings are saved as they change. The key is saved only when "Remember" is ticked.
  useEffect(() => {
    if (!state.initialised) return;
    const saved = saveSettings(browserStorage(), settings, state.keys);
    setStorageFailed(!saved && settings.remember);
  });

  // Leaving the tab stops a request that is still waiting.
  useEffect(() => () => controller.current?.abort(), []);

  const digest = useMemo(() => buildDigest(tracks), [tracks]);
  const ids = useMemo(() => selectIds(digest, filter), [digest, filter]);
  const { part, parts } = digestPart(digest, ids, partIndex);
  const shownPart = Math.min(partIndex, parts - 1);
  const problem = keyProblem(apiKey);
  const canAsk = state.optIn && !problem && settings.models[provider].trim() !== '' && host !== null && part.tracks > 0 && prompt.trim() !== '' && !busy;
  const whyNot = !state.optIn
    ? 'Tick the box above to allow sending the library.'
    : problem && !apiKey
      ? 'Paste an API key first.'
      : problem
        ? problem
        : !settings.models[provider].trim()
          ? 'Enter a model name.'
          : host === null
            ? 'Fix the base address first.'
            : part.tracks === 0
              ? 'No tracks match the filter.'
              : !prompt.trim()
                ? 'Type what you want done, or pick an example.'
                : '';

  function changeSettings(patch: Partial<Settings>) {
    state.settings = { ...state.settings, ...patch };
    if (patch.provider) setKeyVersion((version) => version + 1);
    bump();
  }

  function setKey(text: string) {
    state.keys = { ...state.keys, [provider]: cleanKey(text) };
    bump();
  }

  function forget() {
    state.keys = {};
    forgetKeys(browserStorage());
    setKeyVersion((version) => version + 1);
    bump();
  }

  function updateTurn(id: number, change: (turn: Turn) => Turn) {
    state.turns = state.turns.map((turn) => (turn.id === id ? change(turn) : turn));
    bump();
  }

  async function send() {
    if (!canAsk) return;
    const request = prompt.trim();
    const abort = new AbortController();
    controller.current = abort;
    const id = state.nextId++;
    const scope = scopeText(part.tracks, tracks.length, shownPart, parts, filter);
    const turn: Turn = { id, request, host: host as string, scope, sentTracks: part.tracks, status: 'waiting', labels: {}, selectedEdits: [], selectedPlaylists: [], libraryRef: tracks };
    const history = state.turns.filter((earlier) => earlier.status === 'done' && earlier.result).map((earlier) => ({ request: earlier.request, summary: summaryOf(earlier.result as NonNullable<Turn['result']>) }));
    state.turns = [...state.turns, turn];
    setPrompt('');
    setBusy(true);
    bump();
    // Nothing else tells the person the model is thinking, so say so, with the time it has taken.
    const activity = startActivity(`Asking ${host as string}`, { message: `Sent ${part.tracks} tracks. Waiting for the model. A large library can take a minute or two.` });
    let timedOut = false;
    const limit = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, ASK_LIMIT_MS);
    let answered = false;
    try {
      const sent = new Set(part.ids);
      const known = new Map([...digest.known].filter(([knownId]) => sent.has(knownId)));
      const result = await ask(
        { config, part, scope, request, history, context: { known, existingPlaylists: playlists.map((playlist) => playlist.name ?? '') } },
        { signal: abort.signal },
      );
      const labels: Record<number, string> = {};
      for (const wanted of [...result.edits.map((edit) => edit.id), ...result.playlists.flatMap((playlist) => playlist.ids)]) {
        const track = known.get(wanted);
        if (track) labels[wanted] = labelOf(track);
      }
      answered = true;
      updateTurn(id, (previous) => ({ ...previous, status: 'done', result, labels, selectedEdits: result.edits.map((edit) => edit.id), selectedPlaylists: result.playlists.map((playlist) => playlist.name) }));
    } catch (error) {
      const message = timedOut
        ? `No answer after ${ASK_LIMIT_MS / 60_000} minutes, so it was stopped. Nothing was changed. Try a smaller part of the library, or a faster model.`
        : error instanceof ModelError
          ? error.message
          : scrub(describeError(error), apiKey);
      updateTurn(id, (previous) => ({ ...previous, status: 'error', error: message }));
    } finally {
      clearTimeout(limit);
      activity.end(answered);
      if (controller.current === abort) controller.current = null;
      setBusy(false);
    }
  }

  function stop() {
    controller.current?.abort();
  }

  function toggle(turnId: number, kind: 'edit' | 'playlist', value: number | string) {
    updateTurn(turnId, (turn) => {
      const key = kind === 'edit' ? 'selectedEdits' : 'selectedPlaylists';
      const current = turn[key] as (number | string)[];
      const next = current.includes(value) ? current.filter((one) => one !== value) : [...current, value];
      return { ...turn, [key]: next } as Turn;
    });
  }

  function tickAll(turnId: number, on: boolean) {
    updateTurn(turnId, (turn) => ({
      ...turn,
      selectedEdits: on ? (turn.result?.edits.map((edit) => edit.id) ?? []) : [],
      selectedPlaylists: on ? (turn.result?.playlists.map((playlist) => playlist.name) ?? []) : [],
    }));
  }

  /** Runs from the Apply button. Chrome's permission prompt must come first, straight from the click. */
  async function apply(turn: Turn) {
    if (busy) return;
    try {
      if (!(await allowWriting(root))) {
        setStatus('Chrome was not allowed to change the iPod, so nothing was changed.');
        return;
      }
    } catch (error) {
      updateTurn(turn.id, (previous) => ({ ...previous, applied: { ok: false, message: describeError(error, { writing: true }), lines: [], details: [] } }));
      return;
    }
    const result = turn.result;
    if (!result || !ready || busy) return;
    const chosenEdits = buildEdits(result.edits.filter((edit) => turn.selectedEdits.includes(edit.id)));
    const chosenPlaylists = buildPlaylistChanges(result.playlists.filter((playlist) => turn.selectedPlaylists.includes(playlist.name)));
    if (!chosenEdits.length && !chosenPlaylists.length) return;
    setBusy(true);
    const lines: string[] = [];
    const details: string[] = [];
    let changed = false;
    let message = '';
    let ok = true;
    const progress = (text: string | { message: string }) => setStatus(typeof text === 'string' ? text : text.message);
    try {
      assertSafe(chosenEdits, chosenPlaylists);
      const iPod = root as unknown as IpodRoot;
      // Playlists first: creating one never changes a track's key, and an edit might.
      if (chosenPlaylists.length) {
        setStatus('Checking the playlists in memory...');
        const plan = await planPlaylistChanges(iPod, newEngine, chosenPlaylists, { onProgress: setStatus });
        lines.push(...plan.summary);
        setStatus(`Plan: ${plan.summary.join(' ')} Writing...`);
        const { report } = await changePlaylists(iPod, newEngine, chosenPlaylists, { backup, onProgress: progress });
        if (!succeeded(report)) {
          ok = false;
          details.push(...report.failures);
          message = 'The playlists did not finish, so the iPod was put back as it was. The edits were not tried.';
        } else changed = true;
      }
      if (ok && chosenEdits.length) {
        setStatus('Checking the edits in memory...');
        const plan = await planEdits(iPod, newEngine, chosenEdits, { onProgress: setStatus });
        lines.push(...plan.summary);
        setStatus(`Plan: ${plan.summary.join(' ')} Writing...`);
        const { report } = await editTracks(iPod, newEngine, chosenEdits, { backup, onProgress: progress });
        if (!succeeded(report)) {
          ok = false;
          details.push(...report.failures);
          message = chosenPlaylists.length ? 'The edits did not finish, so they were put back. The playlists had already been made.' : 'The edits did not finish, so the iPod was put back as it was.';
        } else changed = true;
      }
      if (ok) message = `Applied ${[chosenEdits.length ? plural(chosenEdits.length, 'edit') : '', chosenPlaylists.length ? plural(chosenPlaylists.length, 'new playlist') : ''].filter(Boolean).join(' and ')}. Each write was read back and checked.`;
    } catch (error) {
      ok = false;
      message = `Nothing more was changed. ${describeError(error, { writing: true })}`;
    }
    updateTurn(turn.id, (previous) => ({ ...previous, applied: { ok, message, lines, details } }));
    setStatus('');
    setBusy(false);
    if (changed) onChanged();
  }

  const tooMany = ids.length > MAX_TRACKS_PER_REQUEST;

  return (
    <section class="card ai-panel">
      <h3>Assistant</h3>
      <p class="card-lead">
        Ask a language model to tidy tags or build playlists. It can only propose: you see every change first, tick what you want, and what you apply goes through the same backup and read-back checks as the Library tab. This is the one part of OpenTunes that sends anything off this computer, and only if you allow it below.
      </p>
      <BackupGate ready={ready} onGo={onNeedBackup} />
      {state.afterReload && !state.optIn && !state.turns.length ? (
        <p class="callout info" role="note">
          This page was reloaded since you last used the assistant. The permission to send the library, the conversation and the key (unless you ticked Remember) are kept in memory only, so they were cleared. Tick the box and paste the key again to continue.
        </p>
      ) : null}

      <AssistantSettings
        settings={settings}
        onSettings={changeSettings}
        keyIsSet={apiKey !== ''}
        onKey={setKey}
        keyBox={`${provider}-${keyVersion}`}
        onForget={forget}
        optIn={state.optIn}
        onOptIn={(on) => {
          state.optIn = on;
          markTouched();
          bump();
        }}
        host={host}
        storageFailed={storageFailed}
        onLoadModels={() => listModels({ provider, apiKey, baseUrl: settings.baseUrl })}
      />

      {tracks.length === 0 ? (
        <div class="empty">
          <strong>No music yet</strong>
          There is nothing for the assistant to work on. Add music first.
        </div>
      ) : (
        <>
          <div class="ai-scope">
            <label class="field">
              Only tracks that contain (optional)
              <input type="search" value={filter} placeholder="Part of a title, artist, album or genre" onInput={(event) => { setFilter((event.target as HTMLInputElement).value); setPartIndex(0); }} />
            </label>
            {tooMany ? (
              <label class="field">
                Part
                <select value={shownPart} onChange={(event) => setPartIndex(Number((event.target as HTMLSelectElement).value))}>
                  {Array.from({ length: parts }, (_, index) => (
                    <option key={index} value={index}>
                      Part {index + 1} of {parts} ({formatCount(index * MAX_TRACKS_PER_REQUEST + 1)} to {formatCount(Math.min(ids.length, (index + 1) * MAX_TRACKS_PER_REQUEST))} of the {formatCount(ids.length)} tracks)
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
          {tooMany ? (
            <p class="callout info">
              {formatCount(ids.length)} tracks match, which is more than one request holds ({formatCount(MAX_TRACKS_PER_REQUEST)}). Ask one part at a time, or narrow the list with the filter above. The assistant only sees the part you pick.
            </p>
          ) : null}
          <p class="note ai-summary" role="status">
            This request would send {plural(part.tracks, 'track')} (about {formatCount(part.tokens)} tokens of text, plus your question) to {host ?? 'no address yet'}. No audio, file paths or sizes.
          </p>
        </>
      )}

      <div class="ai-examples" aria-label="Examples">
        {EXAMPLES.map((example) => (
          <button key={example} type="button" class="secondary small" disabled={busy} onClick={() => setPrompt(example)}>
            {example}
          </button>
        ))}
      </div>
      <label class="field">
        What should the assistant do?
        <textarea class="ai-prompt" rows={3} value={prompt} disabled={busy} placeholder="For example: fix artist names that are spelled two different ways" onInput={(event) => setPrompt((event.target as HTMLTextAreaElement).value)} />
      </label>
      <div class="actions">
        <button type="button" disabled={!canAsk} onClick={() => void send()}>
          Ask
        </button>
        {busy && controller.current ? (
          <button type="button" class="secondary" onClick={stop}>
            Stop
          </button>
        ) : null}
        {!canAsk && !busy && whyNot ? <span class="note">{whyNot}</span> : null}
      </div>

      {status ? (
        <p class="callout info" role="status">
          {status}
        </p>
      ) : null}

      <div class="ai-history" aria-live="polite">
        {state.turns.map((turn) => (
          <div key={turn.id} class="ai-turn">
            <div class="ai-you">
              <span class="ai-who">You</span>
              {turn.request}
              <span class="ai-sent muted">
                {' '}
                Sent {plural(turn.sentTracks, 'track')} to {turn.host}.
              </span>
            </div>
            <div class="ai-reply">
              <span class="ai-who">Assistant</span>
              {turn.status === 'waiting' ? <p class="muted">Waiting for {turn.host}...</p> : null}
              {turn.status === 'error' ? (
                <div class="result no" role="alert">
                  <p>{turn.error}</p>
                </div>
              ) : null}
              {turn.status === 'done' ? (
                <ProposalPreview
                  turn={turn}
                  stale={turn.libraryRef !== tracks}
                  canApply={ready}
                  busy={busy}
                  onToggleEdit={(editId) => toggle(turn.id, 'edit', editId)}
                  onTogglePlaylist={(name) => toggle(turn.id, 'playlist', name)}
                  onAll={(on) => tickAll(turn.id, on)}
                  onApply={() => void apply(turn)}
                />
              ) : null}
              {turn.status === 'done' && turn.result && !turn.result.answer && !turn.result.edits.length && !turn.result.playlists.length ? <p class="muted">The assistant proposed nothing.</p> : null}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
