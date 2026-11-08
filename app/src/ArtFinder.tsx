import { useEffect, useRef, useState } from 'preact/hooks';
import { albumKey, songKey, type OnlineCover } from './albumArt';
import { DEFAULT_MAX_LOOKUPS, describeMatch, isStopped, itemKey, lookUpCovers, newLookupCache, type LookupItem, type LookupOutcome, type LookupResult, type SongResult } from './artLookup';
import { coverWork } from './coverRows';
import { describeError } from './describeError';
import type { Candidate } from './addFiles';

/** What the person approved, handed back to the list. */
export interface UsedCovers {
  /** Album covers by `albumKey`. */
  albums: Map<string, OnlineCover>;
  /** Song covers by `songKey`, with the matched album name when the person asked for it to be filled in. */
  songs: Map<string, { cover: OnlineCover; albumName: string | null }>;
}

/** The finder's pointer to one thing on a row: "look this album (or song) up". `nonce` changes on every press, so pressing twice still works. */
export interface FinderFocus {
  key: string;
  nonce: number;
}

type Phase = { name: 'idle' } | { name: 'looking'; done: number; total: number; current: string } | { name: 'review' } | { name: 'error'; message: string };

/** What the session has learned. A lookup is never repeated for the same album, song or release while this page is open. */
const session = newLookupCache();

const CONFIDENCE_WORD = { good: 'Good match', maybe: 'Maybe', low: 'Low confidence' } as const;
const CONFIDENCE_HELP = {
  good: 'the title, artist and length all fit.',
  maybe: 'the title and artist fit, but the length could not be checked.',
  low: 'there was no artist to check, so this may be a different song with the same title. It is not ticked for you.',
} as const;

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

/**
 * An optional step that looks up missing album art online. It is open whenever a file has no cover and
 * can be looked up, so the button is never hidden. It sends only the album's name and artist (or, for a
 * file with no album name, the song's title and artist) to musicbrainz.org and coverartarchive.org, and
 * only after the box is ticked and the button pressed. It shows what it found next to what it matched,
 * and changes nothing until the person presses "Use the ticked covers". The lookup is in artLookup.ts.
 */
export function ArtFinder({
  candidates,
  skipped,
  guesses,
  disabled,
  focus,
  onUse,
}: {
  candidates: Candidate[];
  /** Ids of rows left out as duplicates: they never ask for a cover. */
  skipped: ReadonlySet<string>;
  /** Ids of rows whose file-name guess the person accepted. */
  guesses: ReadonlySet<string>;
  disabled: boolean;
  focus: FinderFocus | null;
  onUse: (covers: UsedCovers) => void;
}) {
  const [allowed, setAllowed] = useState(false);
  const [fillAlbum, setFillAlbum] = useState(false);
  const [phase, setPhase] = useState<Phase>({ name: 'idle' });
  const [outcomes, setOutcomes] = useState<LookupOutcome[]>([]);
  const [left, setLeft] = useState(0);
  const [previews, setPreviews] = useState<Map<string, string>>(new Map());
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [used, setUsed] = useState<number | null>(null);
  /** When set, only this album or song (a key from `itemKey`) is looked up, because its row's button was pressed. */
  const [only, setOnly] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const urls = useRef<string[]>([]);
  const root = useRef<HTMLElement>(null);
  const box = useRef<HTMLInputElement>(null);
  const go = useRef<HTMLButtonElement>(null);

  const work = coverWork(candidates, skipped, guesses);
  const everything: LookupItem[] = [
    ...work.albums.map((album): LookupItem => ({ kind: 'album', ref: album.ref })),
    ...work.songs.map((song): LookupItem => ({ kind: 'song', ref: song.ref })),
  ];
  const scoped = only ? everything.filter((item) => itemKey(item) === only) : everything;
  const items = only && !scoped.length ? everything : scoped;
  const fresh = items.filter((item) => !session.outcomes.has(itemKey(item)));
  const thisRun = fresh.slice(0, DEFAULT_MAX_LOOKUPS);
  const albumsSent = thisRun.filter((item) => item.kind === 'album').length;
  const songsSent = thisRun.filter((item) => item.kind === 'song').length;
  const tracksOfAlbum = new Map(work.albums.map((album) => [`a:${album.key}`, album.tracks]));
  const tracksOfSong = new Map(work.songs.map((song) => [`s:${song.key}`, song.tracks]));
  const nameOf = (item: LookupItem): string => (item.kind === 'album' ? `${item.ref.album} by ${item.ref.artist}` : `${item.ref.title}${item.ref.artist ? ` by ${item.ref.artist}` : ''}`);

  function dropPreviews() {
    for (const url of urls.current) URL.revokeObjectURL(url);
    urls.current = [];
  }
  useEffect(() => () => { dropPreviews(); abort.current?.abort(); }, []);

  // The list of files changed: an old review no longer matches it.
  const signature = everything.map(itemKey).join('|');
  useEffect(() => {
    if (phase.name === 'review') {
      dropPreviews();
      setOutcomes([]);
      setPreviews(new Map());
      setTicked(new Set());
      setUsed(null);
      setPhase({ name: 'idle' });
    }
  }, [signature]);

  // A row's "Find a cover online" was pressed: look at that one, and put the cursor where the person acts next.
  useEffect(() => {
    if (!focus) return;
    setOnly(focus.key);
    root.current?.scrollIntoView?.({ block: 'nearest' });
    (allowed ? go.current : box.current)?.focus();
  }, [focus?.nonce]);

  async function find() {
    const controller = new AbortController();
    abort.current = controller;
    dropPreviews();
    setUsed(null);
    setPhase({ name: 'looking', done: 0, total: thisRun.length, current: '' });
    try {
      // window.fetch is read now, not when the page loaded.
      const run = await lookUpCovers(items, {
        fetch: window.fetch.bind(window),
        signal: controller.signal,
        cache: session,
        maxLookups: DEFAULT_MAX_LOOKUPS,
        onProgress: (done, total, item) => setPhase({ name: 'looking', done, total, current: nameOf(item) }),
      });
      const shown = new Map<string, string>();
      const ticks = new Set<string>();
      for (const outcome of run.outcomes) {
        if (outcome.result.status !== 'found') continue;
        const key = itemKey(outcome.item);
        const picture = outcome.item.kind === 'album' ? (outcome.result as Extract<LookupResult, { status: 'found' }>).cover : (outcome.result as Extract<SongResult, { status: 'found' }>).match;
        const url = URL.createObjectURL(new Blob([new Uint8Array(picture.data)], { type: picture.mime }));
        urls.current.push(url);
        shown.set(key, url);
        // A low confidence match is never ticked for the person.
        if (outcome.item.kind === 'album' || (outcome.result as Extract<SongResult, { status: 'found' }>).match.confidence !== 'low') ticks.add(key);
      }
      setOutcomes(run.outcomes);
      setLeft(run.skipped.length);
      setPreviews(shown);
      setTicked(ticks);
      setPhase({ name: 'review' });
    } catch (error) {
      setPhase(isStopped(error) ? { name: 'idle' } : { name: 'error', message: describeError(error) });
    } finally {
      abort.current = null;
    }
  }

  function use() {
    const covers: UsedCovers = { albums: new Map(), songs: new Map() };
    for (const outcome of outcomes) {
      if (outcome.result.status !== 'found' || !ticked.has(itemKey(outcome.item))) continue;
      if (outcome.item.kind === 'album') {
        const found = (outcome.result as Extract<LookupResult, { status: 'found' }>).cover;
        covers.albums.set(albumKey(outcome.item.ref), { mime: found.mime, data: found.data, releaseId: found.releaseId });
      } else {
        const match = (outcome.result as Extract<SongResult, { status: 'found' }>).match;
        covers.songs.set(songKey(outcome.item.ref), { cover: { mime: match.mime, data: match.data, releaseId: match.releaseId }, albumName: fillAlbum && match.releaseTitle ? match.releaseTitle : null });
      }
    }
    onUse(covers);
    setUsed(covers.albums.size + covers.songs.size);
    setOutcomes([]);
    setTicked(new Set());
    dropPreviews();
    setPreviews(new Map());
    setPhase({ name: 'idle' });
    setOnly(null);
  }

  if (!everything.length && used === null) return null;
  const looking = phase.name === 'looking';
  const found = outcomes.filter((outcome) => outcome.result.status === 'found');
  const sends = [albumsSent ? `${plural(albumsSent, 'album name', 'album names')} (with the artist)` : '', songsSent ? `${plural(songsSent, 'song title', 'song titles')} (with the artist, when there is one)` : ''].filter(Boolean).join(' and ');

  return (
    <section class="art-finder" ref={root} aria-labelledby="art-finder-title" data-art-finder>
      <h4 id="art-finder-title">Find missing album art online (optional)</h4>
      {everything.length ? (
        <>
          <p>
            <strong>What is sent:</strong> only the album's name and artist, to musicbrainz.org and coverartarchive.org.
            {work.songs.length ? ' For a file with no album name it is the song title and artist instead.' : ''} Nothing is sent until you tick the box and press the button.
          </p>
          {only ? (
            <p class="note" data-only>
              Only this one for now: {nameOf(items[0] as LookupItem)}.{' '}
              {everything.length > 1 ? (
                <button type="button" class="ghost small" disabled={looking} onClick={() => setOnly(null)}>
                  Look up all {everything.length} instead
                </button>
              ) : null}
            </p>
          ) : null}
          <label class="check">
            <input ref={box} type="checkbox" checked={allowed} disabled={disabled || looking} onChange={(event) => setAllowed((event.target as HTMLInputElement).checked)} />
            Send these names to musicbrainz.org and coverartarchive.org to look for covers
          </label>
          {work.songs.length ? (
            <label class="check">
              <input type="checkbox" checked={fillAlbum} disabled={disabled || looking} onChange={(event) => setFillAlbum((event.target as HTMLInputElement).checked)} />
              Also fill in the album name from the match (only for the songs whose cover you approve)
            </label>
          ) : null}
          <p class="note" data-would-send>
            {thisRun.length ? (
              <>
                Would send {sends} to musicbrainz.org and coverartarchive.org.
                {songsSent ? " A song's length is not sent: it is only compared here with what MusicBrainz answers." : ''}
                {fresh.length > thisRun.length ? ` That is the first ${thisRun.length} of ${fresh.length}: press the button again afterwards for the rest.` : ''} Nothing is sent yet.
              </>
            ) : (
              'Everything here was looked up already in this session, so nothing more would be sent.'
            )}
          </p>
          <div class="actions">
            <button ref={go} type="button" disabled={!allowed || disabled || looking || !items.length} onClick={() => void find()}>
              Find covers
            </button>
            {looking ? (
              <button type="button" class="secondary" onClick={() => abort.current?.abort()}>
                Stop
              </button>
            ) : null}
          </div>
        </>
      ) : null}
      <details class="art-more">
        <summary>More about what is sent, and the limits</summary>
        <p>
          This step looks the albums up in the Cover Art Archive, a free public collection, using MusicBrainz to find the right release. It sends the artist and album name of each album to musicbrainz.org, and then the id of the release it found to coverartarchive.org, which sends the picture from archive.org. A file with no album name is looked up by its song title and artist (MusicBrainz's recording search, then the releases that recording is on, preferring an official album, then a single). No file names, no other tags, no audio and no list of your library are sent. Those sites also see your computer's address, as with any web page.
        </p>
        <p>
          At most {DEFAULT_MAX_LOOKUPS} albums and songs are looked up each time, about a second apart because MusicBrainz asks for no more than one request a second. Press the button again to continue. Answers are kept while this page is open, so the same album or song is never asked for twice.
        </p>
        <p>Nothing is added to your files or the iPod until you have seen each picture and pressed "Use the ticked covers".</p>
      </details>
      {looking && phase.name === 'looking' ? (
        <p class="callout info" role="status">
          Looking up {Math.min(phase.done + 1, phase.total)} of {phase.total}{phase.current ? `: ${phase.current}` : ''}. About a second each.
        </p>
      ) : null}
      {phase.name === 'error' ? (
        <div class="result no" role="alert">
          <p>{phase.message}</p>
        </div>
      ) : null}
      {used !== null ? <p class="callout info" role="status">Covers chosen for {used} {used === 1 ? 'album or song' : 'albums and songs'}. They go on the iPod with the files.</p> : null}
      {phase.name === 'review' ? (
        <>
          <p class="note" role="status">
            Found {found.length} of {outcomes.length}.{left ? ` ${plural(left, 'more was', 'more were')} not looked up in this run (at most ${DEFAULT_MAX_LOOKUPS} at a time). Press Find covers again to continue.` : ''} The Cover Art Archive says its images are freely accessible, to be used at your own risk, and to be respectful of the rights of the artists and labels. Look at each picture before you use it.
          </p>
          <ul class="art-results">
            {outcomes.map((outcome) => {
              const key = itemKey(outcome.item);
              const result = outcome.result;
              const tracks = (outcome.item.kind === 'album' ? tracksOfAlbum : tracksOfSong).get(key) ?? 0;
              if (result.status !== 'found') {
                return (
                  <li key={key} class="art-missing">
                    <p>
                      <strong>{nameOf(outcome.item)}</strong>: {result.status === 'none' ? 'no cover found.' : 'not looked up.'} <span class="path">{result.reason}</span>
                    </p>
                  </li>
                );
              }
              const tick = (
                <input
                  type="checkbox"
                  checked={ticked.has(key)}
                  onChange={(event) => {
                    const next = new Set(ticked);
                    if ((event.target as HTMLInputElement).checked) next.add(key);
                    else next.delete(key);
                    setTicked(next);
                  }}
                />
              );
              if (outcome.item.kind === 'album') {
                const cover = (result as Extract<LookupResult, { status: 'found' }>).cover;
                return (
                  <li key={key} class="art-found">
                    <img src={previews.get(key)} width={96} height={96} alt={`Cover found for ${outcome.item.ref.album}`} />
                    <label class="check">
                      {tick}
                      <span>
                        <strong>{outcome.item.ref.album}</strong> by {outcome.item.ref.artist}
                        <span class="path">MusicBrainz release "{cover.releaseTitle}" by {cover.releaseArtist} ({cover.releaseId})</span>
                      </span>
                    </label>
                  </li>
                );
              }
              const match = (result as Extract<SongResult, { status: 'found' }>).match;
              return (
                <li key={key} class="art-found" data-confidence={match.confidence}>
                  <img src={previews.get(key)} width={96} height={96} alt={`Cover found for ${outcome.item.ref.title}`} />
                  <label class="check">
                    {tick}
                    <span>
                      <strong>{outcome.item.ref.title}</strong>{outcome.item.ref.artist ? ` by ${outcome.item.ref.artist}` : ''} ({plural(tracks, 'file', 'files')})
                      <span class="path">
                        Matched: {describeMatch(match)}
                        {match.viaReleaseGroup ? ". The picture is that album's front cover from another pressing" : ''}.
                      </span>
                      <span class="path">
                        <strong class={`confidence ${match.confidence}`}>{CONFIDENCE_WORD[match.confidence]}</strong>: {CONFIDENCE_HELP[match.confidence]}
                        {outcome.item.ref.fromFileName ? ' The title and artist were guessed from the file name.' : ''}
                      </span>
                      {fillAlbum ? <span class="path">The album name "{match.releaseTitle}" will be filled in if you use this cover.</span> : null}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
          <div class="actions">
            <button type="button" disabled={!ticked.size} onClick={use}>
              Use the ticked covers ({ticked.size})
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}
