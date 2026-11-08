/**
 * Finding songs that are on the iPod more than once. Pure functions with no screen in them, so they
 * are tested on their own (app/test/duplicates.test.ts).
 *
 * How tracks are grouped:
 *  - Only like with like: music with music, a music video with music videos, a podcast episode with
 *    the same show and title. Audiobooks (chapters share a title pattern), movies, TV shows and
 *    anything of an unknown kind are never grouped.
 *  - Titles and artists are made comparable with core's `normalizeText` (accents, case, punctuation,
 *    and noise such as "(feat. X)" or "(Remastered)" do not matter). Live, remix, acoustic, demo,
 *    instrumental, karaoke and radio-edit versions are different recordings and stay apart.
 *  - Lengths must agree to within 4 seconds or 3 percent, whichever is more.
 *  - SURE: same artist, title, album and length. LIKELY: same artist, title and length on another
 *    album (a single and an album, a compilation). FUZZY: spelled slightly differently (typos, "feat."
 *    without brackets, bracket text, "&" and "and"). Fuzzy groups are only candidates: the app shows
 *    them after the AI has looked at them, and never ticks them on its own.
 *  - Nothing is compared pair by pair across the library. Tracks are indexed by a key; the fuzzy
 *    pass compares only within a person's own tracks (and artists spelled almost alike), with a cap.
 */

import { normalizeText } from '@opentunes/core';
import { trackKey, type PlaylistChange, type PlaylistInfo, type TrackInfo } from '@opentunes/engine';

export type Confidence = 'sure' | 'likely' | 'fuzzy';

/** What a track is compared with: only tracks of the same class are ever grouped. */
export type KindClass = 'music' | 'music-video' | 'podcast' | 'video-podcast';

/** The parts of a track this file reads. A real TrackInfo has all of them. */
export type DupTrack = Pick<
  TrackInfo,
  'handle' | 'ipod_path' | 'title' | 'artist' | 'albumartist' | 'album' | 'year' | 'kind' | 'tracklen' | 'bitrate' | 'size' | 'filetype' | 'has_artwork' | 'artwork_count' | 'rating' | 'playcount' | 'time_added'
>;

export interface DupMember<T extends DupTrack = TrackInfo> {
  /** From the engine's `trackKey`: how removals name the track. */
  key: string;
  track: T;
  /** The keep score. Higher is better. See `KEEP_WEIGHTS`. */
  score: number;
  /** In how many ordinary playlists (not the master, podcast or smart ones). */
  playlists: number;
  /** How many tracks of this track's album are on the iPod. */
  albumTracks: number;
}

export interface DupGroup<T extends DupTrack = TrackInfo> {
  /** A small number that is the same for the life of this report. Also what the AI is told. */
  id: number;
  level: Confidence;
  kindClass: KindClass;
  /** Best first. */
  members: DupMember<T>[];
  /** The key of the track to keep. */
  keep: string;
  /** Why, in a few words. */
  reason: string;
  /** What this group is, in a few words ("same artist, title, album and length"). */
  why: string;
  /** What removing everything but `keep` would free, in bytes. */
  bytesFreed: number;
  /** Fuzzy groups only: the pairs of track keys that looked alike. */
  pairs: [string, string][];
}

export interface DuplicateReport<T extends DupTrack = TrackInfo> {
  /** SURE groups first, then LIKELY. */
  groups: DupGroup<T>[];
  /** FUZZY candidates. Shown only after the AI has looked at them. */
  candidates: DupGroup<T>[];
  /** Tracks that were compared, and tracks left out (audiobooks, video, no file path, no tags). */
  compared: number;
  skipped: number;
}

// ------------------------------------------------------------------ tolerances

export const TOLERANCE_MS = 4000;
export const TOLERANCE_RATIO = 0.03;
/** A cluster of fuzzy matches bigger than this is left out: it is more likely a series of different tracks than copies. */
export const MAX_FUZZY_GROUP = 8;
/** Artists with more tracks than this (Various Artists, a big compilation) are not compared fuzzily. */
export const MAX_FUZZY_ARTIST_TRACKS = 400;
/** The most track pairs the fuzzy pass will look at in one run. */
export const MAX_FUZZY_PAIRS = 1_500_000;

/** True when two lengths (milliseconds) are the same song's length: within 4 seconds or 3 percent. Unknown lengths never match. */
export function sameLength(a: number, b: number): boolean {
  if (!(a > 0) || !(b > 0)) return false;
  return Math.abs(a - b) <= Math.max(TOLERANCE_MS, TOLERANCE_RATIO * Math.max(a, b));
}

// ------------------------------------------------------------------ versions

/** Words in a title that make it a different recording. Each one is a tag; two tracks must carry the same tags. */
const TITLE_VERSIONS: [string, RegExp][] = [
  ['live', /\blive\b/],
  ['remix', /\b(remix|remixed|rmx|re-?mix)\b/],
  ['acoustic', /\bacoustic\b/],
  ['demo', /\bdemo\b/],
  ['instrumental', /\binstrumental\b/],
  ['karaoke', /\bkaraoke\b/],
  ['radio edit', /\bradio (edit|mix|version)\b/],
  ['extended', /\bextended\b/],
  ['unplugged', /\bunplugged\b/],
  ['a cappella', /\ba ?capp?ella\b/],
];

/** In an album name only the clear signs count: "Live at ...", "(Live)", "Unplugged", "Remixes". */
const ALBUM_VERSIONS: [string, RegExp][] = [
  ['live', /\blive (at|in|from|on|\d)|[(\[]live\b|\blive[)\]]|\bin concert\b|\blive album\b/],
  ['remix', /\bremixes\b|\bthe remix(es)? album\b/],
  ['acoustic', /\bacoustic\b/],
  ['instrumental', /\binstrumentals?\b/],
  ['karaoke', /\bkaraoke\b/],
  ['unplugged', /\bunplugged\b/],
];

const plainLower = (text: string | null | undefined): string => (text ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();

/** The version tags in a title and album, sorted and joined. "" for a plain studio recording. */
export function versionTags(title: string | null | undefined, album: string | null | undefined = ''): string {
  const found = new Set<string>();
  const fromTitle = plainLower(title);
  for (const [tag, pattern] of TITLE_VERSIONS) if (pattern.test(fromTitle)) found.add(tag);
  const fromAlbum = plainLower(album);
  for (const [tag, pattern] of ALBUM_VERSIONS) if (pattern.test(fromAlbum)) found.add(tag);
  return [...found].sort().join(',');
}

// ------------------------------------------------------------------ normalising

/** Like normalizeText but keeps bracket text such as "(Deluxe Edition)", so two releases of an album stay different. */
function albumKey(album: string | null | undefined): string {
  return plainLower(album)
    .replace(/_/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Titles that say nothing about the song. With no artist they would join unrelated tracks. */
const GENERIC_TITLE = /^(track|audio|untitled|unknown|no title|intro|outro|skit|interlude|voice|recording|new recording|sound)\s*\d*$|^\d+$/;

/** The class a track is compared in, or null for kinds that are never grouped. */
export function kindClassOf(kind: string): KindClass | null {
  switch (kind) {
    case 'music':
      return 'music';
    case 'music-video':
      return 'music-video';
    case 'podcast':
      return 'podcast';
    case 'video-podcast':
      return 'video-podcast';
    default:
      return null;
  }
}

/** The key two tracks share when they are the same song of the same class, ignoring length and album. Null when the tags say too little. */
export function songKey(track: Pick<DupTrack, 'kind' | 'title' | 'artist' | 'albumartist' | 'album'>): string | null {
  const kindClass = kindClassOf(track.kind);
  if (!kindClass) return null;
  const title = normalizeText(track.title ?? '');
  if (!title) return null;
  if (kindClass === 'podcast' || kindClass === 'video-podcast') {
    // The show is the "album" of an episode, or its "artist" when there is no album.
    const show = albumKey(track.album) || normalizeText(track.artist ?? '');
    return show ? `${kindClass}|${show}|${title}` : null;
  }
  const artist = normalizeText(track.artist || track.albumartist || '');
  if (!artist && GENERIC_TITLE.test(title)) return null;
  return `${kindClass}|${artist}|${title}`;
}

/** Like songKey, but also forgives things that are not a different song: "&" and "and", "feat." without brackets, bracket text without numbers, a trailing "- Remastered". */
function looseTitle(raw: string | null | undefined): string {
  let text = (raw ?? '').replace(/&/g, ' and ');
  text = text.replace(/[(\[]([^)\]]*)[)\]]/g, (whole, inner: string) => (/\d/.test(inner) || versionTags(inner) ? whole : ' '));
  text = text.replace(/\s+[-–]\s*(\d{4}\s+)?(remaster(ed)?|mono|stereo)\b.*$/i, '').replace(/\s+(feat|ft|featuring)\.?\s.*$/i, '');
  return normalizeText(text);
}

/** An artist without "the", spaces or "and": "The Beatles" and "Beatles" are one. */
function looseArtist(raw: string | null | undefined): string {
  return normalizeText((raw ?? '').replace(/&/g, ' and '))
    .replace(/^the /, '')
    .replace(/\band\b/g, '')
    .replace(/\s+/g, '');
}

const digitsOf = (text: string): string => (text.match(/\d+/g) ?? []).join(',');

/** Edit distance, giving up (and returning max + 1) once it must exceed `max`. */
export function editDistance(a: string, b: string, max = Infinity): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 1; row <= a.length; row += 1) {
    const current = [row];
    let smallest = row;
    for (let column = 1; column <= b.length; column += 1) {
      const cost = a.charCodeAt(row - 1) === b.charCodeAt(column - 1) ? 0 : 1;
      const value = Math.min((previous[column] as number) + 1, (current[column - 1] as number) + 1, (previous[column - 1] as number) + cost);
      current.push(value);
      if (value < smallest) smallest = value;
    }
    if (smallest > max) return max + 1;
    previous = current;
  }
  return previous[b.length] as number;
}

/** How many edits two titles of this length may differ by and still look like one title. */
const titleLimit = (length: number): number => (length < 5 ? 0 : length < 10 ? 1 : length < 20 ? 2 : 3);

/** True when two titles are close enough to be one title with a typo or a small difference. Numbers must match exactly (Part 1 is not Part 2). */
export function similarTitles(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (digitsOf(a) !== digitsOf(b)) return false;
  return editDistance(a, b, titleLimit(Math.max(a.length, b.length))) <= titleLimit(Math.max(a.length, b.length));
}

/** True when two artists (as looseArtist makes them) are the same or one typo apart. */
export function similarArtists(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 5) return false;
  return editDistance(a, b, 1) <= 1;
}

// ------------------------------------------------------------------ the keep score

/**
 * The score that picks which copy to keep. A higher total is the one to keep. Points:
 *   lossless file ......... 40
 *   bitrate ............... up to 30, in proportion to the best bitrate in the group
 *   file size ............. up to 10, in proportion to the biggest in the group
 *   has artwork ........... 8
 *   rating and plays ...... up to 12 (rating, 0 to 5 stars, 1.2 points a star; plays, 0.6 a play, at most 6)
 *   in playlists .......... 2 each, at most 10 (the master, podcast and smart playlists do not count)
 *   fuller album .......... up to 6, in proportion to the most tracks of an album in the group
 * A tie goes to the copy added first, then to the one whose file name sorts first.
 */
export const KEEP_WEIGHTS = { lossless: 40, bitrate: 30, size: 10, artwork: 8, rating: 6, plays: 6, playlist: 2, playlistMax: 10, album: 6 } as const;

type Part = 'lossless' | 'bitrate' | 'size' | 'artwork' | 'engagement' | 'playlists' | 'album';

const REASONS: Record<Part, string> = {
  lossless: 'lossless copy',
  bitrate: 'higher bitrate',
  size: 'larger file',
  artwork: 'has artwork',
  engagement: 'rated or played more',
  playlists: 'in more playlists',
  album: 'from the fuller album',
};

export function isLossless(track: Pick<DupTrack, 'filetype' | 'ipod_path' | 'bitrate'>): boolean {
  if (/lossless|alac|\bwav|\baiff?|flac/i.test(track.filetype ?? '')) return true;
  if (/\.(wav|aiff?|flac)$/i.test(track.ipod_path ?? '')) return true;
  return /\.m4a$/i.test(track.ipod_path ?? '') && track.bitrate >= 700;
}

const hasArtwork = (track: Pick<DupTrack, 'has_artwork' | 'artwork_count'>): boolean => track.artwork_count > 0 || track.has_artwork === 1;

export interface KeepFacts {
  playlists: number;
  albumTracks: number;
}

/** Scores each track against the others in its group and says why the best one won. */
export function recommendKeep<T extends DupTrack>(tracks: { key: string; track: T; facts: KeepFacts }[]): { scores: number[]; keepIndex: number; reason: string } {
  const maxBitrate = Math.max(0, ...tracks.map(({ track }) => track.bitrate));
  const maxSize = Math.max(0, ...tracks.map(({ track }) => track.size));
  const maxAlbum = Math.max(0, ...tracks.map(({ facts }) => facts.albumTracks));
  const parts = tracks.map(({ track, facts }): Record<Part, number> => ({
    lossless: isLossless(track) ? KEEP_WEIGHTS.lossless : 0,
    bitrate: maxBitrate > 0 ? (KEEP_WEIGHTS.bitrate * track.bitrate) / maxBitrate : 0,
    size: maxSize > 0 ? (KEEP_WEIGHTS.size * track.size) / maxSize : 0,
    artwork: hasArtwork(track) ? KEEP_WEIGHTS.artwork : 0,
    engagement: Math.min(KEEP_WEIGHTS.rating, (Math.max(0, track.rating) / 100) * 5 * 1.2) + Math.min(KEEP_WEIGHTS.plays, Math.max(0, track.playcount) * 0.6),
    playlists: Math.min(KEEP_WEIGHTS.playlistMax, facts.playlists * KEEP_WEIGHTS.playlist),
    album: maxAlbum > 0 ? (KEEP_WEIGHTS.album * facts.albumTracks) / maxAlbum : 0,
  }));
  const scores = parts.map((part) => Object.values(part).reduce((total, value) => total + value, 0));
  const order = tracks
    .map((_, index) => index)
    .sort((a, b) => {
      if (Math.abs((scores[b] as number) - (scores[a] as number)) > 1e-9) return (scores[b] as number) - (scores[a] as number);
      const added = (tracks[a] as { track: T }).track.time_added - (tracks[b] as { track: T }).track.time_added;
      if (added) return added;
      return (tracks[a] as { key: string }).key.localeCompare((tracks[b] as { key: string }).key);
    });
  const keepIndex = order[0] as number;
  const runnerUp = order[1];
  let reason = 'the first copy added';
  if (runnerUp !== undefined) {
    let best: Part | null = null;
    let margin = 1; // a part must lead by a full point to be the reason
    for (const part of Object.keys(REASONS) as Part[]) {
      const lead = (parts[keepIndex] as Record<Part, number>)[part] - (parts[runnerUp] as Record<Part, number>)[part];
      if (lead > margin) {
        margin = lead;
        best = part;
      }
    }
    if (best) reason = REASONS[best];
  }
  return { scores, keepIndex, reason };
}

// ------------------------------------------------------------------ finding groups

const WHY: Record<Confidence, string> = {
  sure: 'same artist, title, album and length',
  likely: 'same artist, title and length, on different albums',
  fuzzy: 'titles or artists spelled a little differently',
};

interface Entry<T extends DupTrack> {
  track: T;
  key: string;
  song: string;
  version: string;
  album: string;
}

/** Splits tracks of one song into runs whose lengths agree, each run measured from its first track. */
function lengthRuns<T extends DupTrack>(entries: Entry<T>[]): Entry<T>[][] {
  const sorted = [...entries].sort((a, b) => a.track.tracklen - b.track.tracklen);
  const runs: Entry<T>[][] = [];
  for (const entry of sorted) {
    const run = runs[runs.length - 1];
    if (run && sameLength((run[0] as Entry<T>).track.tracklen, entry.track.tracklen)) run.push(entry);
    else runs.push([entry]);
  }
  return runs;
}

/** Finds the duplicate groups (SURE and LIKELY) and the fuzzy candidates. Fast: tracks are indexed by a key, not compared in pairs. */
export function findDuplicates<T extends DupTrack>(tracks: T[], playlists: Pick<PlaylistInfo, 'master' | 'podcasts' | 'smart' | 'tracks'>[] = []): DuplicateReport<T> {
  // How many ordinary playlists hold each track.
  const inPlaylists = new Map<number, number>();
  for (const playlist of playlists) {
    if (playlist.master || playlist.podcasts || playlist.smart) continue;
    for (const handle of new Set(playlist.tracks)) inPlaylists.set(handle, (inPlaylists.get(handle) ?? 0) + 1);
  }
  // How many tracks each album has here, for "the fuller album".
  const albumSizes = new Map<string, number>();
  const albumOf = (track: T): string => `${normalizeText(track.albumartist || track.artist || '')}|${albumKey(track.album)}`;
  for (const track of tracks) {
    if (!albumKey(track.album)) continue;
    const name = albumOf(track);
    albumSizes.set(name, (albumSizes.get(name) ?? 0) + 1);
  }

  const index = new Map<string, Entry<T>[]>();
  const eligible: Entry<T>[] = [];
  let skipped = 0;
  for (const track of tracks) {
    const song = track.ipod_path ? songKey(track) : null;
    if (!song) {
      skipped += 1;
      continue;
    }
    const entry: Entry<T> = { track, key: trackKey(track), song, version: versionTags(track.title, track.album), album: albumKey(track.album) };
    eligible.push(entry);
    const bucket = `${song}|${entry.version}`;
    const list = index.get(bucket);
    if (list) list.push(entry);
    else index.set(bucket, [entry]);
  }

  let nextId = 1;
  const memberOf = (entry: Entry<T>): DupMember<T> => ({
    key: entry.key,
    track: entry.track,
    score: 0,
    playlists: inPlaylists.get(entry.track.handle) ?? 0,
    albumTracks: albumSizes.get(albumOf(entry.track)) ?? 0,
  });
  const makeGroup = (level: Confidence, entries: Entry<T>[], pairs: [string, string][]): DupGroup<T> => {
    const members = entries.map(memberOf);
    const choice = recommendKeep(members.map((member) => ({ key: member.key, track: member.track, facts: { playlists: member.playlists, albumTracks: member.albumTracks } })));
    members.forEach((member, at) => {
      member.score = Math.round((choice.scores[at] as number) * 100) / 100;
    });
    members.sort((a, b) => b.score - a.score || a.track.time_added - b.track.time_added || a.key.localeCompare(b.key));
    const keep = (entries[choice.keepIndex] as Entry<T>).key;
    // Keep first, then the others by score.
    members.sort((a, b) => (a.key === keep ? -1 : b.key === keep ? 1 : 0));
    const kept = members[0] as DupMember<T>;
    return {
      id: nextId++,
      level,
      kindClass: kindClassOf(kept.track.kind) as KindClass,
      members,
      keep,
      reason: choice.reason,
      why: WHY[level],
      bytesFreed: members.filter((member) => member.key !== keep).reduce((total, member) => total + member.track.size, 0),
      pairs,
    };
  };

  const sure: Entry<T>[][] = [];
  const likely: Entry<T>[][] = [];
  const grouped = new Set<string>();
  for (const list of index.values()) {
    if (list.length < 2) continue;
    for (const run of lengthRuns(list)) {
      if (run.length < 2) continue;
      // Sure: the same album on every track, and a real one (two blank albums are not a match on their own),
      // or files with no artist and no album at all, which can only be told apart by title and length.
      const first = (run[0] as Entry<T>).album;
      const sameAlbum = first !== '' && run.every((entry) => entry.album === first);
      const untagged = run.every((entry) => entry.album === '' && !normalizeText(entry.track.artist || entry.track.albumartist || ''));
      (sameAlbum || untagged ? sure : likely).push(run);
      for (const entry of run) grouped.add(entry.key);
    }
  }
  const order = (a: Entry<T>[], b: Entry<T>[]): number => (a[0] as Entry<T>).song.localeCompare((b[0] as Entry<T>).song);
  sure.sort(order);
  likely.sort(order);
  const groups = [...sure.map((run) => makeGroup('sure', run, [])), ...likely.map((run) => makeGroup('likely', run, []))];

  // Fuzzy: tracks not in a group, and the track kept from each group (so a typo of a song that has copies can still be found).
  const keepers = new Set(groups.map((group) => group.keep));
  const pool = eligible.filter((entry) => !grouped.has(entry.key) || keepers.has(entry.key));
  const candidates = fuzzyGroups(pool, makeGroup);
  return { groups, candidates, compared: eligible.length, skipped };
}

function fuzzyGroups<T extends DupTrack>(pool: Entry<T>[], makeGroup: (level: Confidence, entries: Entry<T>[], pairs: [string, string][]) => DupGroup<T>): DupGroup<T>[] {
  // One cluster per loosely-equal artist (or show, for podcasts), within a class.
  const clusters = new Map<string, Entry<T>[]>();
  for (const entry of pool) {
    const kindClass = kindClassOf(entry.track.kind) as KindClass;
    const podcast = kindClass === 'podcast' || kindClass === 'video-podcast';
    const who = podcast ? looseArtist(entry.track.album || entry.track.artist) : looseArtist(entry.track.artist || entry.track.albumartist);
    if (!who) continue;
    const name = `${kindClass}|${who}`;
    const list = clusters.get(name);
    if (list) list.push(entry);
    else clusters.set(name, [entry]);
  }

  const parent = new Map<string, string>();
  const find = (key: string): string => {
    let root = key;
    while ((parent.get(root) ?? root) !== root) root = parent.get(root) as string;
    return root;
  };
  const byKey = new Map<string, Entry<T>>();
  const pairs: [Entry<T>, Entry<T>][] = [];
  let budget = MAX_FUZZY_PAIRS;

  const loose = new Map<string, { title: string }>();
  const titleOf = (entry: Entry<T>): string => {
    let found = loose.get(entry.key);
    if (!found) {
      found = { title: looseTitle(entry.track.title) };
      loose.set(entry.key, found);
    }
    return found.title;
  };
  const comparePair = (a: Entry<T>, b: Entry<T>): void => {
    budget -= 1;
    if (a.key === b.key || a.song === b.song) return; // the same song is a group already, or kept apart on purpose
    if (a.version !== b.version) return;
    if (!sameLength(a.track.tracklen, b.track.tracklen)) return;
    if (!similarTitles(titleOf(a), titleOf(b))) return;
    pairs.push([a, b]);
  };
  const compareClusters = (left: Entry<T>[], right: Entry<T>[] | null): void => {
    if (right === null) {
      for (let i = 0; i < left.length && budget > 0; i += 1) for (let j = i + 1; j < left.length && budget > 0; j += 1) comparePair(left[i] as Entry<T>, left[j] as Entry<T>);
    } else {
      for (const a of left) for (const b of right) if (budget > 0) comparePair(a, b);
    }
  };

  // Artists spelled almost alike are found through a short prefix, so only a few clusters meet.
  const blocks = new Map<string, string[]>();
  for (const name of clusters.keys()) {
    const who = name.slice(name.indexOf('|') + 1);
    const block = `${name.slice(0, name.indexOf('|'))}|${who.slice(0, 3)}`;
    const list = blocks.get(block);
    if (list) list.push(name);
    else blocks.set(block, [name]);
  }
  for (const names of blocks.values()) {
    const usable = names.filter((name) => (clusters.get(name) as Entry<T>[]).length <= MAX_FUZZY_ARTIST_TRACKS);
    if (usable.length > 60) {
      // Too many look-alike artists to compare: only within each one.
      for (const name of usable) compareClusters(clusters.get(name) as Entry<T>[], null);
      continue;
    }
    usable.forEach((name, at) => {
      const left = clusters.get(name) as Entry<T>[];
      if (left.length >= 2) compareClusters(left, null);
      for (const other of usable.slice(at + 1)) {
        if (similarArtists(name.slice(name.indexOf('|') + 1), other.slice(other.indexOf('|') + 1))) compareClusters(left, clusters.get(other) as Entry<T>[]);
      }
    });
  }

  for (const [a, b] of pairs) {
    byKey.set(a.key, a);
    byKey.set(b.key, b);
    parent.set(find(a.key), find(b.key));
  }
  const components = new Map<string, Entry<T>[]>();
  for (const entry of byKey.values()) {
    const root = find(entry.key);
    const list = components.get(root);
    if (list) list.push(entry);
    else components.set(root, [entry]);
  }
  const found: DupGroup<T>[] = [];
  const ordered = [...components.values()].filter((list) => list.length >= 2 && list.length <= MAX_FUZZY_GROUP).sort((a, b) => (a[0] as Entry<T>).song.localeCompare((b[0] as Entry<T>).song));
  for (const entries of ordered) {
    const keys = new Set(entries.map((entry) => entry.key));
    found.push(makeGroup('fuzzy', entries, pairs.filter(([a, b]) => keys.has(a.key) && keys.has(b.key)).map(([a, b]) => [a.key, b.key] as [string, string])));
  }
  return found;
}

// ------------------------------------------------------------------ choices

/** What the person has chosen for one group: the track to keep, and the others ticked for removal. */
export interface Choice {
  keep: string;
  remove: Set<string>;
}
export type Choices = Map<number, Choice>;

/** SURE groups start with every copy but the recommended one ticked. LIKELY and fuzzy groups start with nothing ticked. */
export function defaultChoices(groups: DupGroup<DupTrack>[]): Choices {
  const choices: Choices = new Map();
  for (const group of groups) {
    choices.set(group.id, { keep: group.keep, remove: new Set(group.level === 'sure' ? group.members.filter((member) => member.key !== group.keep).map((member) => member.key) : []) });
  }
  return choices;
}

/** Everything but the track kept is ticked, or nothing is. */
export function tickGroup(group: DupGroup<DupTrack>, choice: Choice, on: boolean): Choice {
  return { keep: choice.keep, remove: new Set(on ? group.members.filter((member) => member.key !== choice.keep).map((member) => member.key) : []) };
}

/** Moves the keep choice. The new one is never ticked. If every other copy was ticked, the old one now is. */
export function changeKeep(group: DupGroup<DupTrack>, choice: Choice, keep: string): Choice {
  if (!group.members.some((member) => member.key === keep) || keep === choice.keep) return choice;
  const others = group.members.filter((member) => member.key !== choice.keep);
  const all = others.length > 0 && others.every((member) => choice.remove.has(member.key));
  const remove = new Set(choice.remove);
  remove.delete(keep);
  if (all) remove.add(choice.keep);
  return { keep, remove };
}

export function toggleRemove(choice: Choice, key: string, on: boolean): Choice {
  if (key === choice.keep) return choice;
  const remove = new Set(choice.remove);
  if (on) remove.add(key);
  else remove.delete(key);
  return { keep: choice.keep, remove };
}

/** Ticks every SURE group (and unticks everything else), or unticks all. */
export function selectSure(groups: DupGroup<DupTrack>[], choices: Choices, on: boolean): Choices {
  const next: Choices = new Map(choices);
  for (const group of groups) {
    const choice = choices.get(group.id) ?? { keep: group.keep, remove: new Set<string>() };
    next.set(group.id, tickGroup(group, choice, on && group.level === 'sure'));
  }
  return next;
}

export interface RemovalChoice {
  /** Track keys to pass to `planRemoval`. */
  keys: string[];
  /** Bytes those tracks take. */
  bytes: number;
  /** Ticked tracks that are another group's keep choice, and so are left alone. */
  protectedCount: number;
}

/** The tracks to remove: every ticked one, except a track that is the keep choice of any group. */
export function removalKeys(groups: DupGroup<DupTrack>[], choices: Choices): RemovalChoice {
  const keepers = new Set<string>();
  for (const group of groups) keepers.add(choices.get(group.id)?.keep ?? group.keep);
  const keys = new Set<string>();
  const sizes = new Map<string, number>();
  let protectedCount = 0;
  for (const group of groups) {
    const choice = choices.get(group.id);
    if (!choice) continue;
    for (const member of group.members) {
      if (!choice.remove.has(member.key) || member.key === choice.keep) continue;
      if (keepers.has(member.key)) {
        protectedCount += 1;
        continue;
      }
      keys.add(member.key);
      sizes.set(member.key, member.track.size);
    }
  }
  return { keys: [...keys], bytes: [...sizes.values()].reduce((total, size) => total + size, 0), protectedCount };
}

// ------------------------------------------------------------------ playlists

export interface PlaylistSteps {
  /** `changePlaylists` steps: add the kept song to a playlist a removed copy was in. */
  steps: PlaylistChange[];
  /** One plain sentence for each step. */
  lines: string[];
  /** Playlists a removed copy was in that are left as they are, and why. */
  skipped: string[];
}

/**
 * For each playlist that holds a copy that is going and not the copy that stays, a step that adds
 * the kept track to it, so the playlist does not lose the song. The master, podcast and smart
 * playlists, playlists with no name and playlists whose name is not unique are skipped. A new entry
 * goes to the end of the playlist: the position the removed copy had is not kept.
 */
export function buildPlaylistSteps(groups: DupGroup<DupTrack>[], choices: Choices, playlists: Pick<PlaylistInfo, 'name' | 'master' | 'podcasts' | 'smart' | 'tracks'>[]): PlaylistSteps {
  const { keys: removed } = removalKeys(groups, choices);
  const going = new Set(removed);
  const names = new Map<string, number>();
  for (const playlist of playlists) if (playlist.name) names.set(playlist.name, (names.get(playlist.name) ?? 0) + 1);

  const holding = new Map<number, Pick<PlaylistInfo, 'name' | 'master' | 'podcasts' | 'smart' | 'tracks'>[]>();
  for (const playlist of playlists) {
    for (const handle of new Set(playlist.tracks)) {
      const list = holding.get(handle);
      if (list) list.push(playlist);
      else holding.set(handle, [playlist]);
    }
  }

  const additions = new Map<string, { keys: string[]; titles: string[] }>();
  const skipped = new Set<string>();
  for (const group of groups) {
    const choice = choices.get(group.id);
    if (!choice) continue;
    const keeper = group.members.find((member) => member.key === choice.keep);
    if (!keeper || going.has(keeper.key)) continue;
    const keeperIn = new Set((holding.get(keeper.track.handle) ?? []).map((playlist) => playlist));
    for (const member of group.members) {
      if (!going.has(member.key)) continue;
      for (const playlist of holding.get(member.track.handle) ?? []) {
        if (keeperIn.has(playlist)) continue;
        const label = playlist.name ?? '(no name)';
        if (playlist.master) continue; // every track is in the master playlist, and the keeper stays in it
        if (playlist.smart) skipped.add(`"${label}" is a smart playlist, which fills itself by its own rules, so it is left as it is.`);
        else if (playlist.podcasts) skipped.add(`"${label}" is the podcast playlist, which follows each episode's kind, so it is left as it is.`);
        else if (!playlist.name) skipped.add('A playlist with no name was left as it is, because it cannot be told apart.');
        else if ((names.get(playlist.name) ?? 0) > 1) skipped.add(`There is more than one playlist called "${label}", so it is not clear which to change. It was left as it is.`);
        else {
          const entry = additions.get(playlist.name) ?? { keys: [], titles: [] };
          if (!entry.keys.includes(keeper.key)) {
            entry.keys.push(keeper.key);
            entry.titles.push(keeper.track.title ?? '(no title)');
          }
          additions.set(playlist.name, entry);
        }
      }
    }
  }
  const steps: PlaylistChange[] = [];
  const lines: string[] = [];
  for (const [name, entry] of [...additions.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    steps.push({ action: 'add', playlist: name, tracks: entry.keys });
    lines.push(entry.keys.length === 1 ? `Put "${entry.titles[0]}" into "${name}".` : `Put ${entry.keys.length} kept songs into "${name}".`);
  }
  return { steps, lines, skipped: [...skipped] };
}

// ------------------------------------------------------------------ the AI's verdicts

export type VerdictKind = 'duplicate' | 'different-versions' | 'unsure';

export interface GroupVerdict {
  group: number;
  verdict: VerdictKind;
  /** The key of the track the AI would keep, when it named one from the group. */
  keepKey?: string;
  reason: string;
}

/**
 * Turns verdicts into ticks, and nothing else: duplicate ticks every copy but the keep (the AI's
 * choice when it gave one, else the current one), different-versions and unsure untick the group.
 * Groups with no verdict are left as they are.
 */
export function applyVerdicts(groups: DupGroup<DupTrack>[], choices: Choices, verdicts: Map<number, GroupVerdict>): Choices {
  const next: Choices = new Map(choices);
  for (const group of groups) {
    const verdict = verdicts.get(group.id);
    const choice = choices.get(group.id);
    if (!verdict || !choice) continue;
    if (verdict.verdict === 'duplicate') {
      const keep = verdict.keepKey && group.members.some((member) => member.key === verdict.keepKey) ? verdict.keepKey : choice.keep;
      next.set(group.id, tickGroup(group, { keep, remove: new Set() }, true));
    } else {
      next.set(group.id, tickGroup(group, choice, false));
    }
  }
  return next;
}
