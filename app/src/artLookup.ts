/**
 * Finds missing album art with two free public services: MusicBrainz (to find which release an
 * artist and album name mean) and the Cover Art Archive (which holds the pictures). Nothing here
 * runs unless the person turns it on and presses the button.
 *
 * What is sent: for each album, its artist and album name to musicbrainz.org, then the id of the
 * release that matched to coverartarchive.org, which answers with a redirect to the picture on
 * archive.org. No file names, no other tags, no audio, no library list. Every web request also
 * shows the computer's address to the server, as always.
 *
 * What was learned from the services' own documents and from real requests made from Chrome
 * (docs/ART-LOOKUP.md has the dates and the details):
 * - MusicBrainz allows about one request a second from one address and answers 503 above that,
 *   so requests to it are spaced 1.1 seconds apart. The Cover Art Archive says it has no limit.
 * - Both allow calls from a web page. Chrome does not let a page set the User-Agent header that
 *   MusicBrainz asks applications to send, so the request identifies itself only by the browser's
 *   own headers and the page's address.
 * - Release JSON from MusicBrainz has `releases[].id`, `title`, `score` and `artist-credit`.
 *   `https://coverartarchive.org/release/<id>/front-500` redirects to the picture, 404 if none.
 *
 * The fetch is passed in, so tests and the smoke test use a fake and never reach a service.
 */

import { sniffPicture, type AlbumRef } from './albumArt';

const MUSICBRAINZ_SEARCH = 'https://musicbrainz.org/ws/2/release/';
const COVER_ART_RELEASE = 'https://coverartarchive.org/release/';

/** MusicBrainz asks for at most about one request a second. A little more than that. */
export const MUSICBRAINZ_GAP_MS = 1100;
/** Politeness between Cover Art Archive requests, which has no stated limit. */
const COVER_ART_GAP_MS = 250;
/** Releases tried for one album, best match first, until one has a picture. */
const MAX_RELEASES_TRIED = 3;
/** A cover bigger than this is not used. A 500 pixel picture is far smaller. */
const MAX_PICTURE_BYTES = 5 * 1024 * 1024;
const MIN_SCORE = 90;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The picture's final address must be one of these, whatever the redirects were. */
const PICTURE_HOSTS = /(^|\.)(archive\.org|coverartarchive\.org)$/i;

export interface FoundCover {
  /** The album asked for. */
  ref: AlbumRef;
  releaseId: string;
  /** The release's own title and artist, as MusicBrainz spells them. */
  releaseTitle: string;
  releaseArtist: string;
  mime: string;
  data: Uint8Array;
}

export type LookupResult =
  | { ref: AlbumRef; status: 'found'; cover: FoundCover }
  | { ref: AlbumRef; status: 'none'; reason: string }
  | { ref: AlbumRef; status: 'error'; reason: string };

export interface LookupOptions {
  /** `window.fetch`, or a fake. */
  fetch: typeof fetch;
  /** Waits that long. Tests pass a stand-in that returns at once. */
  wait?: (milliseconds: number) => Promise<void>;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number, ref: AlbumRef) => void;
}

/** A search for the release: both names in quotes, with Lucene's special characters escaped. */
export function releaseQuery(ref: AlbumRef): string {
  const quote = (text: string): string => `"${text.replace(/[\\"]/g, (character) => `\\${character}`)}"`;
  return `release:${quote(ref.album)} AND artist:${quote(ref.artist)}`;
}

/** Lowercase, no accents, no punctuation, spaces collapsed: for telling whether two titles are the same. */
export function normaliseTitle(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

interface ReleaseHit {
  id: string;
  title: string;
  artist: string;
  score: number;
  official: boolean;
  date: string;
}

/** Releases from a MusicBrainz search answer that are the album asked for, best first. */
export function matchReleases(answer: unknown, ref: AlbumRef): ReleaseHit[] {
  const releases = (answer as { releases?: unknown } | null)?.releases;
  if (!Array.isArray(releases)) return [];
  const wantedTitle = normaliseTitle(ref.album);
  const wantedArtist = normaliseTitle(ref.artist);
  const hits: ReleaseHit[] = [];
  for (const entry of releases as Record<string, unknown>[]) {
    const id = entry['id'];
    const title = entry['title'];
    const score = entry['score'];
    if (typeof id !== 'string' || !UUID.test(id) || typeof title !== 'string' || typeof score !== 'number') continue;
    const credit = Array.isArray(entry['artist-credit']) ? (entry['artist-credit'] as Record<string, unknown>[]) : [];
    const artist = credit.map((part) => `${String(part['name'] ?? '')}${String(part['joinphrase'] ?? '')}`).join('').trim();
    if (score < MIN_SCORE || normaliseTitle(title) !== wantedTitle) continue;
    const credited = normaliseTitle(artist);
    if (!credited || !(credited === wantedArtist || credited.includes(wantedArtist) || wantedArtist.includes(credited))) continue;
    hits.push({ id, title, artist, score, official: entry['status'] === 'Official', date: typeof entry['date'] === 'string' ? entry['date'] : '' });
  }
  // Official releases first, then the higher score, then the earlier date.
  return hits.sort((a, b) => Number(b.official) - Number(a.official) || b.score - a.score || (a.date || '9999').localeCompare(b.date || '9999'));
}

class Stopped extends Error {}

async function readPicture(response: Response): Promise<{ mime: string; data: Uint8Array } | null> {
  if (response.url) {
    let host = '';
    try {
      host = new URL(response.url).hostname;
    } catch {
      return null;
    }
    if (!PICTURE_HOSTS.test(host)) return null;
  }
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_PICTURE_BYTES) return null;
  const data = new Uint8Array(await response.arrayBuffer());
  if (data.length === 0 || data.length > MAX_PICTURE_BYTES) return null;
  const mime = sniffPicture(data);
  return mime ? { mime, data } : null;
}

/**
 * Looks up each album in turn. Never throws for a service that fails or an album it does not know:
 * each album gets its own result, so one problem does not stop the rest. Throws only when stopped.
 */
export async function lookUpAlbumArt(albums: AlbumRef[], options: LookupOptions): Promise<LookupResult[]> {
  const wait = options.wait ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const { signal } = options;
  const check = (): void => {
    if (signal?.aborted) throw new Stopped('Stopped.');
  };
  const call = async (url: string, accept: string): Promise<Response> => {
    check();
    // No cookies, and the page's address only as an origin, so nothing of the page travels with the request.
    return options.fetch(url, { method: 'GET', headers: { Accept: accept }, credentials: 'omit', referrerPolicy: 'origin', signal });
  };
  let lastMusicBrainz = 0;
  const musicBrainzGap = async (): Promise<void> => {
    const since = Date.now() - lastMusicBrainz;
    if (lastMusicBrainz && since < MUSICBRAINZ_GAP_MS) await wait(MUSICBRAINZ_GAP_MS - since);
    check();
    lastMusicBrainz = Date.now();
  };
  const SLOW_DOWN = 'MusicBrainz asked to slow down, so this album was left for later.';
  /** One search, spaced from the last one. A 503 means too fast: wait a few seconds and try once more. */
  const search = async (ref: AlbumRef): Promise<{ answer: unknown } | { reason: string }> => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await musicBrainzGap();
      const response = await call(`${MUSICBRAINZ_SEARCH}?query=${encodeURIComponent(releaseQuery(ref))}&fmt=json&limit=10`, 'application/json');
      if (response.status === 503) {
        if (attempt === 0) await wait(3000);
        continue;
      }
      if (!response.ok) return { reason: `MusicBrainz answered ${response.status}.` };
      return { answer: await response.json() };
    }
    return { reason: SLOW_DOWN };
  };

  const results: LookupResult[] = [];
  for (const [index, ref] of albums.entries()) {
    check();
    options.onProgress?.(index, albums.length, ref);
    try {
      const searched = await search(ref);
      if ('reason' in searched) {
        results.push({ ref, status: 'error', reason: searched.reason });
        continue;
      }
      const hits = matchReleases(searched.answer, ref);
      if (!hits.length) {
        results.push({ ref, status: 'none', reason: 'MusicBrainz has no release with that artist and album name.' });
        continue;
      }
      let found: LookupResult | null = null;
      for (const hit of hits.slice(0, MAX_RELEASES_TRIED)) {
        await wait(COVER_ART_GAP_MS);
        const response = await call(`${COVER_ART_RELEASE}${hit.id}/front-500`, 'image/jpeg, image/png, */*;q=0.1');
        if (response.status === 404) continue;
        if (!response.ok) {
          found = { ref, status: 'error', reason: `The Cover Art Archive answered ${response.status}.` };
          break;
        }
        const picture = await readPicture(response);
        if (!picture) continue;
        found = { ref, status: 'found', cover: { ref, releaseId: hit.id, releaseTitle: hit.title, releaseArtist: hit.artist, ...picture } };
        break;
      }
      results.push(found ?? { ref, status: 'none', reason: 'The Cover Art Archive has no front cover for that release.' });
    } catch (error) {
      if (error instanceof Stopped || signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw new Stopped('Stopped.');
      results.push({ ref, status: 'error', reason: error instanceof TypeError ? 'The lookup could not reach the service (offline, or the browser blocked the call).' : `The lookup failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  options.onProgress?.(albums.length, albums.length, albums[albums.length - 1] ?? { artist: '', album: '' });
  return results;
}

export const isStopped = (error: unknown): boolean => error instanceof Stopped;
