import { useEffect, useRef, useState } from 'preact/hooks';
import { albumKey, albumRefOf, coverSource, type AlbumRef, type OnlineCover } from './albumArt';
import { isStopped, lookUpAlbumArt, type LookupResult } from './artLookup';
import { describeError } from './describeError';
import type { Candidate } from './addFiles';

interface Album {
  key: string;
  ref: AlbumRef;
  tracks: number;
}

/** The albums among the chosen files that have no cover from the file or its folder, and how many files lack an album to look up. */
export function albumsWithoutCover(candidates: Candidate[]): { albums: Album[]; unnamed: number } {
  const byKey = new Map<string, Album>();
  let unnamed = 0;
  for (const candidate of candidates) {
    if (candidate.decision.action === 'unsupported' || coverSource(candidate).from !== 'none') continue;
    const ref = albumRefOf(candidate.info.tags);
    if (!ref) {
      unnamed += 1;
      continue;
    }
    const key = albumKey(ref);
    const known = byKey.get(key);
    if (known) known.tracks += 1;
    else byKey.set(key, { key, ref, tracks: 1 });
  }
  return { albums: [...byKey.values()], unnamed };
}

type Phase = { name: 'idle' } | { name: 'looking'; done: number; total: number; current: string } | { name: 'review' } | { name: 'error'; message: string };

/**
 * An optional step that looks up missing album art online. It sends only the artist and album name
 * of each album, to musicbrainz.org and coverartarchive.org, and only after the box is ticked and the
 * button pressed. It shows what it found next to the album, and changes nothing until the person
 * presses "Use the ticked covers". The lookup itself is in artLookup.ts.
 */
export function ArtFinder({ candidates, disabled, onUse }: { candidates: Candidate[]; disabled: boolean; onUse: (covers: Map<string, OnlineCover>) => void }) {
  const [allowed, setAllowed] = useState(false);
  const [phase, setPhase] = useState<Phase>({ name: 'idle' });
  const [results, setResults] = useState<LookupResult[]>([]);
  const [previews, setPreviews] = useState<Map<string, string>>(new Map());
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [used, setUsed] = useState<number | null>(null);
  const abort = useRef<AbortController | null>(null);
  const urls = useRef<string[]>([]);

  const { albums, unnamed } = albumsWithoutCover(candidates);

  function dropPreviews() {
    for (const url of urls.current) URL.revokeObjectURL(url);
    urls.current = [];
  }
  useEffect(() => () => { dropPreviews(); abort.current?.abort(); }, []);

  // The list of files changed: an old answer no longer matches it.
  const signature = albums.map((album) => album.key).join('|');
  useEffect(() => {
    if (phase.name === 'review') {
      dropPreviews();
      setResults([]);
      setPreviews(new Map());
      setTicked(new Set());
      setUsed(null);
      setPhase({ name: 'idle' });
    }
  }, [signature]);

  async function find() {
    const controller = new AbortController();
    abort.current = controller;
    dropPreviews();
    setUsed(null);
    setPhase({ name: 'looking', done: 0, total: albums.length, current: '' });
    try {
      // window.fetch is read now, not when the page loaded.
      const found = await lookUpAlbumArt(albums.map((album) => album.ref), {
        fetch: window.fetch.bind(window),
        signal: controller.signal,
        onProgress: (done, total, ref) => setPhase({ name: 'looking', done, total, current: `${ref.artist} - ${ref.album}` }),
      });
      const shown = new Map<string, string>();
      const ticks = new Set<string>();
      for (const result of found) {
        if (result.status !== 'found') continue;
        const url = URL.createObjectURL(new Blob([new Uint8Array(result.cover.data)], { type: result.cover.mime }));
        urls.current.push(url);
        shown.set(albumKey(result.ref), url);
        ticks.add(albumKey(result.ref));
      }
      setResults(found);
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
    const covers = new Map<string, OnlineCover>();
    for (const result of results) {
      const key = albumKey(result.ref);
      if (result.status === 'found' && ticked.has(key)) covers.set(key, { mime: result.cover.mime, data: result.cover.data, releaseId: result.cover.releaseId });
    }
    onUse(covers);
    setUsed(covers.size);
    setResults([]);
    setTicked(new Set());
    dropPreviews();
    setPreviews(new Map());
    setPhase({ name: 'idle' });
  }

  if (!albums.length && used === null) return null;
  const foundResults = results.filter((result) => result.status === 'found');

  return (
    <details class="art-finder">
      <summary>Find missing album art online (optional)</summary>
      <p>
        {albums.length} {albums.length === 1 ? 'album has' : 'albums have'} no cover picture, neither in the files nor in their folders.
        {unnamed ? ` ${unnamed} ${unnamed === 1 ? 'file has' : 'files have'} no artist or album name, so ${unnamed === 1 ? 'it' : 'they'} cannot be looked up.` : ''} This step looks them up in the Cover Art Archive, a free public collection, using MusicBrainz to find the right release.
      </p>
      <p class="note">
        <strong>What is sent:</strong> only the artist and album name of each album, to musicbrainz.org, and then the id of the release it found to coverartarchive.org, which sends the picture from archive.org. No file names, no other tags, no audio and no list of your library. Those sites also see your computer's address, as with any web page. Nothing is sent until you tick the box and press the button, and nothing is added to your files or the iPod until you have seen each picture and pressed "Use the ticked covers".
      </p>
      <label class="check">
        <input type="checkbox" checked={allowed} disabled={disabled || phase.name === 'looking'} onChange={(event) => setAllowed((event.target as HTMLInputElement).checked)} />
        Send the artist and album names of these {albums.length} {albums.length === 1 ? 'album' : 'albums'} to musicbrainz.org and coverartarchive.org
      </label>
      <div class="actions">
        <button type="button" disabled={!allowed || disabled || phase.name === 'looking' || !albums.length} onClick={() => void find()}>
          Find covers
        </button>
        {phase.name === 'looking' ? (
          <button type="button" class="secondary" onClick={() => abort.current?.abort()}>
            Stop
          </button>
        ) : null}
      </div>
      {phase.name === 'looking' ? (
        <p class="callout info" role="status">
          Looking up {Math.min(phase.done + 1, phase.total)} of {phase.total}{phase.current ? `: ${phase.current}` : ''}. About a second each, because MusicBrainz asks for no more than one request a second.
        </p>
      ) : null}
      {phase.name === 'error' ? (
        <div class="result no" role="alert">
          <p>{phase.message}</p>
        </div>
      ) : null}
      {used !== null ? <p class="callout info" role="status">Covers chosen for {used} {used === 1 ? 'album' : 'albums'}. They go on the iPod with the files.</p> : null}
      {phase.name === 'review' ? (
        <>
          <p class="note">
            Found {foundResults.length} of {results.length}. The Cover Art Archive says its images are freely accessible, to be used at your own risk, and to be respectful of the rights of the artists and labels. Look at each picture before you use it.
          </p>
          <ul class="art-results">
            {results.map((result) => {
              const key = albumKey(result.ref);
              return (
                <li key={key} class={result.status === 'found' ? 'art-found' : 'art-missing'}>
                  {result.status === 'found' ? (
                    <>
                      <img src={previews.get(key)} width={96} height={96} alt={`Cover found for ${result.ref.album}`} />
                      <label class="check">
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
                        <span>
                          <strong>{result.ref.album}</strong> by {result.ref.artist}
                          <span class="path">MusicBrainz release "{result.cover.releaseTitle}" by {result.cover.releaseArtist} ({result.cover.releaseId})</span>
                        </span>
                      </label>
                    </>
                  ) : (
                    <p>
                      <strong>{result.ref.album}</strong> by {result.ref.artist}: {result.status === 'none' ? 'no cover found.' : 'not looked up.'} <span class="path">{result.reason}</span>
                    </p>
                  )}
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
    </details>
  );
}
