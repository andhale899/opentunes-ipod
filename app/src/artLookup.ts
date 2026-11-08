/**
 * Finds missing album art with two free public services: MusicBrainz (to find which release an
 * artist and album name mean) and the Cover Art Archive (which holds the pictures). Nothing here
 * runs unless the person turns it on and presses the button.
 *
 * What is sent: for each album, its artist and album name to musicbrainz.org, then the id of the
 * release that matched to coverartarchive.org, which answers with a redirect to the picture on
 * archive.org. For a file with no album name it is the song's title and its artist (when there is
 * one) to musicbrainz.org, and the same release id to coverartarchive.org; the file's length is only
 * compared here, with what MusicBrainz answers, and is not sent.
 * No file names, no other tags, no audio, no library list. Every web request also
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

import { albumKey, sniffPicture, songKey, type AlbumRef, type SongRef } from './albumArt';

const MUSICBRAINZ_SEARCH = 'https://musicbrainz.org/ws/2/release/';
const MUSICBRAINZ_RECORDING = 'https://musicbrainz.org/ws/2/recording/';
const COVER_ART = 'https://coverartarchive.org/';

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

type Picture = { mime: string; data: Uint8Array };

async function readPicture(response: Response): Promise<Picture | null> {
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

// ---------------------------------------------------------------- songs

/** A recording search: the title in quotes and, when there is one, the artist. Lucene's special characters are escaped. */
export function recordingQuery(ref: Pick<SongRef, 'title' | 'artist'>): string {
  const quote = (text: string): string => `"${text.replace(/[\\"]/g, (character) => `\\${character}`)}"`;
  return ref.artist ? `recording:${quote(ref.title)} AND artist:${quote(ref.artist)}` : `recording:${quote(ref.title)}`;
}

/** How sure a match is. Only "good" and "maybe" are ticked for the person; "low" never is. */
export type Confidence = 'good' | 'maybe' | 'low';

/** A release a recording appears on, with what is needed to prefer one. */
export interface RecordingRelease {
  id: string;
  title: string;
  artist: string;
  date: string;
  official: boolean;
  /** MusicBrainz's primary type of the release group: Album, Single, EP and so on. Empty when not given. */
  type: string;
  /** Live, Compilation, Remix and so on. */
  secondary: string[];
  groupId: string | null;
}

export interface RecordingHit {
  id: string;
  title: string;
  artist: string;
  score: number;
  lengthMs: number | null;
  /** MusicBrainz's note that tells recordings of one title apart ("live, 2003-08-23: ..."). Empty for a plain studio recording. */
  disambiguation: string;
  confidence: Confidence;
  /** Best release first. */
  releases: RecordingRelease[];
}

const creditOf = (entry: Record<string, unknown>): string => {
  const credit = Array.isArray(entry['artist-credit']) ? (entry['artist-credit'] as Record<string, unknown>[]) : [];
  return credit.map((part) => `${String(part['name'] ?? '')}${String(part['joinphrase'] ?? '')}`).join('').trim();
};

const sameArtist = (credited: string, wanted: string): boolean => {
  const a = normaliseTitle(credited);
  const b = normaliseTitle(wanted);
  return !!a && !!b && (a === b || a.includes(b) || b.includes(a));
};

/** Lower is better: official first, then a plain Album, then a Single, an EP, an Album that is live or a compilation, anything else. */
function releaseRank(release: RecordingRelease): number {
  const type = release.type.toLowerCase();
  const kind = type === 'album' ? (release.secondary.length ? 3 : 0) : type === 'single' ? 1 : type === 'ep' ? 2 : 4;
  return (release.official ? 0 : 10) + kind;
}

/** The releases a recording appears on, best first: official Album, then Single, then the earlier date. */
export function rankReleases(releases: RecordingRelease[]): RecordingRelease[] {
  return [...releases].sort((a, b) => releaseRank(a) - releaseRank(b) || (a.date || '9999').localeCompare(b.date || '9999'));
}

/** A recording's length may differ from a file's by this much and still be the same version. */
export const LENGTH_TOLERANCE_MS = 3000;

/**
 * The recordings in a MusicBrainz recording search that are the song asked for. The title must match
 * (ignoring case and punctuation), the artist too when one was given, and when both the file and the
 * recording state a length they must be within three seconds, which is how another version (a live
 * take, a radio edit) is told apart. `rejectedByLength` counts the ones turned away for that reason.
 */
export function matchRecordings(answer: unknown, ref: SongRef): { hits: RecordingHit[]; rejectedByLength: number } {
  const recordings = (answer as { recordings?: unknown } | null)?.recordings;
  const hits: RecordingHit[] = [];
  let rejectedByLength = 0;
  if (!Array.isArray(recordings)) return { hits, rejectedByLength };
  const wantedTitle = normaliseTitle(ref.title);
  for (const entry of recordings as Record<string, unknown>[]) {
    const id = entry['id'];
    const title = entry['title'];
    const score = entry['score'];
    if (typeof id !== 'string' || !UUID.test(id) || typeof title !== 'string' || typeof score !== 'number') continue;
    if (score < MIN_SCORE || normaliseTitle(title) !== wantedTitle) continue;
    const artist = creditOf(entry);
    if (ref.artist && !sameArtist(artist, ref.artist)) continue;
    const lengthMs = typeof entry['length'] === 'number' ? (entry['length'] as number) : null;
    const lengthKnown = lengthMs !== null && ref.lengthMs !== null;
    if (lengthKnown && Math.abs((lengthMs as number) - (ref.lengthMs as number)) > LENGTH_TOLERANCE_MS) {
      rejectedByLength += 1;
      continue;
    }
    const releases: RecordingRelease[] = [];
    for (const raw of Array.isArray(entry['releases']) ? (entry['releases'] as Record<string, unknown>[]) : []) {
      const releaseId = raw['id'];
      if (typeof releaseId !== 'string' || !UUID.test(releaseId)) continue;
      const group = (raw['release-group'] ?? {}) as Record<string, unknown>;
      const groupId = typeof group['id'] === 'string' && UUID.test(group['id'] as string) ? (group['id'] as string) : null;
      releases.push({
        id: releaseId,
        title: typeof raw['title'] === 'string' ? (raw['title'] as string) : '',
        artist: creditOf(raw) || artist,
        date: typeof raw['date'] === 'string' ? (raw['date'] as string) : '',
        official: raw['status'] === 'Official',
        type: typeof group['primary-type'] === 'string' ? (group['primary-type'] as string) : '',
        secondary: Array.isArray(group['secondary-types']) ? (group['secondary-types'] as unknown[]).filter((value): value is string => typeof value === 'string') : [],
        groupId,
      });
    }
    // No artist given: low, whatever else fits. A guessed file name can be at best "maybe". A length that
    // could not be compared is "maybe". Only artist, title and length all agreeing is "good".
    const confidence: Confidence = !ref.artist ? 'low' : lengthKnown && !ref.fromFileName ? 'good' : 'maybe';
    hits.push({ id, title, artist, score, lengthMs, disambiguation: typeof entry['disambiguation'] === 'string' ? (entry['disambiguation'] as string) : '', confidence, releases: rankReleases(releases) });
  }
  // Higher score first, then the length closest to the file's, then a plain recording before one with a note such as "live, 2003".
  const away = (hit: RecordingHit): number => (hit.lengthMs !== null && ref.lengthMs !== null ? Math.abs(hit.lengthMs - ref.lengthMs) : Number.MAX_SAFE_INTEGER);
  hits.sort((a, b) => b.score - a.score || away(a) - away(b) || Number(!!a.disambiguation) - Number(!!b.disambiguation));
  return { hits, rejectedByLength };
}

/** What a song matched, with the picture, for showing next to it and for approving. */
export interface SongMatch {
  releaseId: string;
  releaseTitle: string;
  releaseArtist: string;
  /** The release's year, or an empty string. */
  year: string;
  recordingTitle: string;
  recordingArtist: string;
  confidence: Confidence;
  /** True when the picture is the release group's front cover, because the release itself has none. */
  viaReleaseGroup: boolean;
  mime: string;
  data: Uint8Array;
}

export type SongResult = { ref: SongRef; status: 'found'; match: SongMatch } | { ref: SongRef; status: 'none'; reason: string } | { ref: SongRef; status: 'error'; reason: string };

/** "Title by Artist, on Album (year)": what a match is, in words. */
export function describeMatch(match: Pick<SongMatch, 'recordingTitle' | 'recordingArtist' | 'releaseTitle' | 'year'>): string {
  return `${match.recordingTitle} by ${match.recordingArtist}, on ${match.releaseTitle}${match.year ? ` (${match.year})` : ''}`;
}

// ---------------------------------------------------------------- the lookup

export type AlbumItem = { kind: 'album'; ref: AlbumRef };
export type SongItem = { kind: 'song'; ref: SongRef };
/** One thing to look up: an album by its names, or a song by its title, artist and length. */
export type LookupItem = AlbumItem | SongItem;

export const itemKey = (item: LookupItem): string => (item.kind === 'album' ? `a:${albumKey(item.ref)}` : `s:${songKey(item.ref)}`);

export type LookupOutcome = { item: AlbumItem; result: LookupResult } | { item: SongItem; result: SongResult };

/**
 * What one session has already learned, so the same album, the same song or the same release is never
 * asked for twice. Only answers ("found", "none") are kept, never a failure, so a failed one is tried
 * again. It also remembers when MusicBrainz was last asked, so two runs in a row still keep the gap.
 */
export interface LookupCache {
  outcomes: Map<string, LookupOutcome>;
  /** A picture per release or release group, or null when the Cover Art Archive has none. */
  pictures: Map<string, Picture | null>;
  lastMusicBrainzAt: number;
}

export const newLookupCache = (): LookupCache => ({ outcomes: new Map(), pictures: new Map(), lastMusicBrainzAt: 0 });

/** The most albums and songs asked about in one run. A person can run again to continue. */
export const DEFAULT_MAX_LOOKUPS = 25;

export interface CoverLookupOptions extends Omit<LookupOptions, 'onProgress'> {
  cache?: LookupCache;
  /** Fresh lookups in this run, not counting answers already in the cache. */
  maxLookups?: number;
  onProgress?: (done: number, total: number, item: LookupItem) => void;
}

/**
 * Looks up each item in turn: an album through MusicBrainz's release search, a song through its
 * recording search. Never throws for a service that fails or an item it does not know: each item gets
 * its own outcome. Throws only when stopped. Items beyond `maxLookups` fresh lookups are returned in
 * `skipped`, not asked about. Requests to MusicBrainz are always at least 1.1 seconds apart.
 */
export async function lookUpCovers(items: LookupItem[], options: CoverLookupOptions): Promise<{ outcomes: LookupOutcome[]; skipped: LookupItem[] }> {
  const wait = options.wait ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const { signal } = options;
  const cache = options.cache ?? newLookupCache();
  const check = (): void => {
    if (signal?.aborted) throw new Stopped('Stopped.');
  };
  const call = async (url: string, accept: string): Promise<Response> => {
    check();
    // No cookies, and the page's address only as an origin, so nothing of the page travels with the request.
    return options.fetch(url, { method: 'GET', headers: { Accept: accept }, credentials: 'omit', referrerPolicy: 'origin', signal });
  };
  const musicBrainzGap = async (): Promise<void> => {
    const since = Date.now() - cache.lastMusicBrainzAt;
    if (cache.lastMusicBrainzAt && since < MUSICBRAINZ_GAP_MS) await wait(MUSICBRAINZ_GAP_MS - since);
    check();
    cache.lastMusicBrainzAt = Date.now();
  };
  const SLOW_DOWN = 'MusicBrainz asked to slow down, so this one was left for later.';
  /** One search, spaced from the last one. A 503 means too fast: wait a few seconds and try once more. */
  const search = async (url: string): Promise<{ answer: unknown } | { reason: string }> => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await musicBrainzGap();
      const response = await call(url, 'application/json');
      if (response.status === 503) {
        if (attempt === 0) await wait(3000);
        continue;
      }
      if (!response.ok) return { reason: `MusicBrainz answered ${response.status}.` };
      return { answer: await response.json() };
    }
    return { reason: SLOW_DOWN };
  };
  /** A front cover from the Cover Art Archive, kept for the session. "missing" is a 404 or a picture that cannot be used. */
  const front = async (kind: 'release' | 'release-group', id: string): Promise<{ picture: Picture } | { missing: true } | { reason: string }> => {
    const key = `${kind}:${id}`;
    if (cache.pictures.has(key)) {
      const kept = cache.pictures.get(key) as Picture | null;
      return kept ? { picture: kept } : { missing: true };
    }
    await wait(COVER_ART_GAP_MS);
    const response = await call(`${COVER_ART}${kind}/${id}/front-500`, 'image/jpeg, image/png, */*;q=0.1');
    if (response.status === 404) {
      cache.pictures.set(key, null);
      return { missing: true };
    }
    if (!response.ok) return { reason: `The Cover Art Archive answered ${response.status}.` };
    const picture = await readPicture(response);
    cache.pictures.set(key, picture);
    return picture ? { picture } : { missing: true };
  };

  const lookUpAlbum = async (ref: AlbumRef): Promise<LookupResult> => {
    const searched = await search(`${MUSICBRAINZ_SEARCH}?query=${encodeURIComponent(releaseQuery(ref))}&fmt=json&limit=10`);
    if ('reason' in searched) return { ref, status: 'error', reason: searched.reason };
    const hits = matchReleases(searched.answer, ref);
    if (!hits.length) return { ref, status: 'none', reason: 'MusicBrainz has no release with that artist and album name.' };
    for (const hit of hits.slice(0, MAX_RELEASES_TRIED)) {
      const got = await front('release', hit.id);
      if ('reason' in got) return { ref, status: 'error', reason: got.reason };
      if ('picture' in got) return { ref, status: 'found', cover: { ref, releaseId: hit.id, releaseTitle: hit.title, releaseArtist: hit.artist, ...got.picture } };
    }
    return { ref, status: 'none', reason: 'The Cover Art Archive has no front cover for that release.' };
  };

  type Candidate = { hit: RecordingHit; release: RecordingRelease };
  const lookUpSong = async (ref: SongRef): Promise<SongResult> => {
    const searched = await search(`${MUSICBRAINZ_RECORDING}?query=${encodeURIComponent(recordingQuery(ref))}&fmt=json&limit=10`);
    if ('reason' in searched) return { ref, status: 'error', reason: searched.reason };
    const { hits, rejectedByLength } = matchRecordings(searched.answer, ref);
    // Releases in order: the best recording's best release first. Each is tried once, up to three, then
    // the front cover of the first one's release group (the same album, another pressing).
    const tried = new Set<string>();
    const candidates: Candidate[] = [];
    for (const hit of hits) {
      for (const release of hit.releases) {
        if (!tried.has(release.id)) {
          tried.add(release.id);
          candidates.push({ hit, release });
        }
      }
    }
    if (!candidates.length) {
      if (rejectedByLength && !hits.length) return { ref, status: 'none', reason: "MusicBrainz knows a song with that title, but its length is not this file's, so it is probably another version. Nothing was used." };
      return { ref, status: 'none', reason: hits.length ? 'MusicBrainz lists that song but on no release.' : 'MusicBrainz has no recording with that title and artist.' };
    }
    const made = (candidate: Candidate, picture: Picture, viaReleaseGroup: boolean): SongResult => ({
      ref,
      status: 'found',
      match: {
        releaseId: candidate.release.id,
        releaseTitle: candidate.release.title,
        releaseArtist: candidate.release.artist,
        year: candidate.release.date.slice(0, 4),
        recordingTitle: candidate.hit.title,
        recordingArtist: candidate.hit.artist,
        confidence: candidate.hit.confidence,
        viaReleaseGroup,
        ...picture,
      },
    });
    for (const candidate of candidates.slice(0, MAX_RELEASES_TRIED)) {
      const got = await front('release', candidate.release.id);
      if ('reason' in got) return { ref, status: 'error', reason: got.reason };
      if ('picture' in got) return made(candidate, got.picture, false);
    }
    const firstGroup = candidates.find((candidate) => candidate.release.groupId);
    if (firstGroup) {
      const got = await front('release-group', firstGroup.release.groupId as string);
      if ('reason' in got) return { ref, status: 'error', reason: got.reason };
      if ('picture' in got) return made(firstGroup, got.picture, true);
    }
    return { ref, status: 'none', reason: 'The Cover Art Archive has no front cover for the releases of that song.' };
  };

  const outcomes: LookupOutcome[] = [];
  const skipped: LookupItem[] = [];
  const maxLookups = options.maxLookups ?? Infinity;
  const total = Math.min(new Set(items.filter((item) => !cache.outcomes.has(itemKey(item))).map(itemKey)).size, maxLookups);
  let done = 0;
  const seen = new Set<string>();
  for (const item of items) {
    check();
    const key = itemKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    const kept = cache.outcomes.get(key);
    if (kept) {
      outcomes.push(kept);
      continue;
    }
    if (done >= maxLookups) {
      skipped.push(item);
      continue;
    }
    options.onProgress?.(done, total, item);
    try {
      const outcome: LookupOutcome = item.kind === 'album' ? { item, result: await lookUpAlbum(item.ref) } : { item, result: await lookUpSong(item.ref) };
      outcomes.push(outcome);
      if (outcome.result.status !== 'error') cache.outcomes.set(key, outcome);
    } catch (error) {
      if (error instanceof Stopped || signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw new Stopped('Stopped.');
      const reason = error instanceof TypeError ? 'The lookup could not reach the service (offline, or the browser blocked the call).' : `The lookup failed: ${error instanceof Error ? error.message : String(error)}`;
      outcomes.push(item.kind === 'album' ? { item, result: { ref: item.ref, status: 'error', reason } } : { item, result: { ref: item.ref, status: 'error', reason } });
    }
    done += 1;
  }
  const last = items[items.length - 1];
  if (last) options.onProgress?.(total, total, last);
  return { outcomes, skipped };
}

/**
 * Looks up each album in turn. Never throws for a service that fails or an album it does not know:
 * each album gets its own result, so one problem does not stop the rest. Throws only when stopped.
 */
export async function lookUpAlbumArt(albums: AlbumRef[], options: LookupOptions): Promise<LookupResult[]> {
  const { onProgress, ...rest } = options;
  const { outcomes } = await lookUpCovers(
    albums.map((ref): LookupItem => ({ kind: 'album', ref })),
    { ...rest, onProgress: onProgress ? (done, total, item) => onProgress(done, total, item.ref as AlbumRef) : undefined },
  );
  return outcomes.flatMap((outcome) => (outcome.item.kind === 'album' ? [outcome.result as LookupResult] : []));
}

export const isStopped = (error: unknown): boolean => error instanceof Stopped;
