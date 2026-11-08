import type { ContentKind, MediaTags } from '@opentunes/core';

/**
 * Guesses what a file is, and fills tags it lacks, from the folders it sits in. Pure functions:
 * no files are read here. The rules are written up for people in FolderGuide.tsx, keep the two in step.
 *
 * `folders` is the path of the file inside the folder the person chose, starting with the chosen
 * folder's own name: the chosen folder may itself be "Audiobooks" or "TV Shows". The outermost
 * folder with a known name decides the kind. Tags already in the file always win: only missing
 * ones are filled.
 */

/** Names that mean a kind, compared in lower case with spaces, dashes and underscores removed. */
const KIND_NAMES: Record<string, ContentKind> = {
  music: 'music',
  songs: 'music',
  song: 'music',
  audiobooks: 'audiobook',
  audiobook: 'audiobook',
  books: 'audiobook',
  book: 'audiobook',
  podcasts: 'podcast',
  podcast: 'podcast',
  movies: 'movie',
  movie: 'movie',
  films: 'movie',
  film: 'movie',
  tvshows: 'tv-show',
  tvshow: 'tv-show',
  tv: 'tv-show',
  series: 'tv-show',
  shows: 'tv-show',
  show: 'tv-show',
  musicvideos: 'music-video',
  musicvideo: 'music-video',
};

const compact = (name: string): string => name.toLowerCase().replace(/[\s_\-.]+/g, '');

/** The kind a folder name stands for, or undefined. */
export function kindOfFolderName(name: string): ContentKind | undefined {
  return KIND_NAMES[compact(name)];
}

const SEASON_FOLDER = /^\s*(?:season|series|saison|s)[\s_.-]*0*(\d{1,2})\s*$/i;
const DISC_FOLDER = /^\s*(?:disc|disk|cd)[\s_.-]*0*(\d{1,2})\s*$/i;
const EPISODE_S_E = /(?<![a-z0-9])s(\d{1,2})e(\d{1,3})(?![a-z0-9])/i;
const EPISODE_X = /(?<![a-z0-9])(\d{1,2})x(\d{1,3})(?![a-z0-9])/i;
/** "01 Title", "01 - Title", "01. Title", "1)Title". Four digits (a year) are not a track number. */
const TRACK_PREFIX = /^(\d{1,3})(?:\s*[-._)]\s*|\s+)(?=\S)/;
const DATE_PREFIX = /^(\d{4})-(\d{2})-(\d{2})(?:\s*[-_.]\s*|\s+)(?=\S)/;
const NAME_YEAR = /^(.*\S)\s*\((\d{4})\)\s*$/;

const withoutExtension = (fileName: string): string => fileName.replace(/\.[^./\\]+$/, '');
const clean = (text: string): string => text.replace(/^[\s._-]+|[\s._-]+$/g, '');

/** True for a tag that is not there: undefined, blank text, zero or NaN. */
function isMissing(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (typeof value === 'number') return !(value > 0);
  return false;
}

export interface FolderGuess {
  /** The kind the folder names say, or undefined when no folder has a known name. */
  kind?: ContentKind;
  /** Tags the file lacks and the folders and file name supply. Never includes a tag the file already has. */
  tags: MediaTags;
}

export interface GuessOptions {
  /** True for a video file. Lets an S01E02 file name be read even outside a "TV Shows" folder. */
  hasVideo?: boolean;
}

interface Episode {
  season: number;
  episode: number;
  /** What follows the S01E02 part, which is the episode's title, or '' when nothing does. */
  rest: string;
}

function episodeIn(name: string): Episode | null {
  for (const pattern of [EPISODE_S_E, EPISODE_X]) {
    const match = pattern.exec(name);
    if (match) {
      const rest = clean(name.slice(match.index + match[0].length));
      return { season: Number(match[1]), episode: Number(match[2]), rest };
    }
  }
  return null;
}

const episodeId = (season: number, episode: number): string => `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;

/**
 * What the folders and the file name say about a file. `existing` is what the file's own tags
 * hold: anything it holds is left out of the answer.
 */
export function guessFromFolders(folders: string[], fileName: string, existing: MediaTags = {}, options: GuessOptions = {}): FolderGuess {
  const names = folders.map((name) => name.trim()).filter(Boolean);
  const at = names.findIndex((name) => kindOfFolderName(name) !== undefined);
  const kind = at === -1 ? undefined : kindOfFolderName(names[at] as string);
  const base = withoutExtension(fileName).trim();
  const found: MediaTags = {};

  const want = (key: keyof MediaTags): boolean => isMissing(existing[key]);
  const put = <K extends keyof MediaTags>(key: K, value: MediaTags[K] | undefined): void => {
    if (value !== undefined && !isMissing(value) && want(key)) found[key] = value;
  };

  // Folders below the category folder, nearest the category first. A "Disc 2" folder is a disc, not a name.
  const rest = at === -1 ? [] : names.slice(at + 1);
  let disc: number | undefined;
  const levels = rest.filter((name) => {
    const match = DISC_FOLDER.exec(name);
    if (match) disc = Number(match[1]);
    return !match;
  });

  /** The track number and the name after it, for "01 Title". */
  const numbered = (): { track?: number; title: string } => {
    const match = TRACK_PREFIX.exec(base);
    return match ? { track: Number(match[1]), title: clean(base.slice(match[0].length)) } : { title: base };
  };

  if (kind === 'music' || kind === 'audiobook') {
    // Music/Artist/Album/01 Title.mp3 and Audiobooks/Author/Book Title/01 Chapter.mp3
    const { track, title } = numbered();
    if (levels.length >= 2) {
      put('artist', levels[0]);
      put('album', levels[levels.length - 1]);
    } else if (levels.length === 1 && kind === 'audiobook') {
      put('album', levels[0]); // the folder is the book, the author is not known
    }
    put('discNumber', disc);
    put('trackNumber', track);
    if (track !== undefined && title) put('title', title);
  } else if (kind === 'podcast') {
    // Podcasts/Show Name/2026-01-05 Episode.mp3
    put('album', levels[0]);
    const dated = DATE_PREFIX.exec(base);
    if (dated) {
      put('year', Number(dated[1]));
      put('title', clean(base.slice(dated[0].length)));
    }
  } else if (kind === 'tv-show') {
    // TV Shows/Show Name/Season 1/S01E02 Title.mp4
    const showLevel = levels.find((name) => !SEASON_FOLDER.test(name));
    const seasonFolder = levels.map((name) => SEASON_FOLDER.exec(name)).find((match) => match !== null);
    const seasonFromFolder = seasonFolder ? Number(seasonFolder[1]) : levels.some((name) => /^\s*specials?\s*$/i.test(name)) ? 0 : undefined;
    if (showLevel && !/^\s*specials?\s*$/i.test(showLevel)) put('show', showLevel);
    const episode = episodeIn(base);
    const season = episode?.season ?? seasonFromFolder;
    // Season 0 is real (specials), so a season is missing only when it is not there at all.
    if (season !== undefined && existing.season === undefined) found.season = season;
    if (episode) {
      put('episode', episode.episode);
      if (want('episodeId')) found.episodeId = episodeId(episode.season, episode.episode);
      if (episode.rest) put('title', episode.rest);
    }
  } else if (kind === 'movie') {
    // Movies/Title (Year).mp4
    const named = NAME_YEAR.exec(base);
    if (named) {
      put('title', clean(named[1] as string));
      put('year', Number(named[2]));
    }
  } else if (kind === 'music-video') {
    // Music Videos/Artist/Title.mp4
    put('artist', levels[0]);
  } else if (options.hasVideo) {
    // No folder name to go by, but "S01E02" in a video's name is unambiguous.
    const episode = EPISODE_S_E.exec(base) ? episodeIn(base) : null;
    if (episode) {
      if (existing.season === undefined) found.season = episode.season;
      put('episode', episode.episode);
      if (want('episodeId')) found.episodeId = episodeId(episode.season, episode.episode);
    }
  }

  return { kind, tags: found };
}

/** True when the file's own tags lack `key`. A season of 0 is a real season, so only an absent one is missing. */
const lacks = (tags: MediaTags, key: keyof MediaTags): boolean => (key === 'season' ? tags.season === undefined : isMissing(tags[key]));

/** The file's own tags with the folder-derived ones added where the file has none. Returns what was added too. */
export function mergeMissingTags(existing: MediaTags, fill: MediaTags): { tags: MediaTags; filled: (keyof MediaTags)[] } {
  const tags: MediaTags = { ...existing };
  const filled: (keyof MediaTags)[] = [];
  for (const key of Object.keys(fill) as (keyof MediaTags)[]) {
    if (lacks(existing, key) && fill[key] !== undefined) {
      (tags as Record<string, unknown>)[key] = fill[key];
      filled.push(key);
    }
  }
  return { tags, filled };
}
