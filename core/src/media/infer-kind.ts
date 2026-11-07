import type { ContentKind, MediaInfo } from './types';

/**
 * Work out what a file is (music, a movie, a podcast and so on) so it lands in the right place
 * on the iPod. Pure: no I/O, the same input always gives the same answer.
 *
 * Rules, in priority order. The first one that applies wins.
 *
 *  1. `hints.userKind`: the person said what it is. Never second-guessed here.
 *  2. `info.tags.declaredKind`: the file says what it is (an MP4 "stik" atom, an Audiobook genre
 *     the probe already turned into a kind).
 *  3. Evidence, checked in this order:
 *     a. No video, and an audiobook signal -> audiobook. Signals:
 *          - the container is m4b;
 *          - the genre is "Audiobook";
 *          - the genre is "Spoken" or "Spoken Word" AND the file has chapters or lasts over an hour.
 *        A short "Spoken Word" track with no chapters is usually a poem or a skit on an album, so it
 *        stays music. This is the conservative reading.
 *     b. Podcast signals (a podcast category, feed address or episode address in the tags, or the
 *        genre "Podcast") -> podcast, or video-podcast when the file has video.
 *     c. Video with TV signals (a show name, season number, episode number or episode id in the
 *        tags, or a file name with S02E05 in it) -> tv-show.
 *     d. Video with music-video signals (both artist and album tags, and a known duration under
 *        12 minutes) -> music-video. A file with no stated duration is not guessed to be one.
 *     e. Any other video -> movie.
 *     f. Everything else -> music.
 *
 * Nothing here checks what the iPod supports. decideForDevice does that and may fall back.
 */

export interface InferKindHints {
  /** Defaults to `info.fileName`. */
  fileName?: string;
  /** What the person chose. Wins over everything. */
  userKind?: ContentKind;
}

const ONE_HOUR_MS = 60 * 60 * 1000;
const MUSIC_VIDEO_MAX_MS = 12 * 60 * 1000;

const AUDIOBOOK_GENRES = new Set(['audiobook', 'audiobooks', 'audio book', 'audio books']);
const SPOKEN_WORD_GENRES = new Set(['spoken', 'spoken word']);
const PODCAST_GENRES = new Set(['podcast', 'podcasts']);

/** "S02E05", "s2e5". Not inside a longer word, so "classes1e2" does not count. */
const EPISODE_IN_NAME = /(?<![a-z0-9])s\d{1,2}e\d{1,3}(?![a-z0-9])/i;

function normalizeGenre(genre: string | undefined): string {
  return (genre ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function present(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

export function inferKind(info: MediaInfo, hints: InferKindHints = {}): ContentKind {
  if (hints.userKind) return hints.userKind;
  if (info.tags.declaredKind) return info.tags.declaredKind;

  const hasVideo = info.video !== null;
  const genre = normalizeGenre(info.tags.genre);
  const fileName = hints.fileName ?? info.fileName;

  if (!hasVideo) {
    const spoken = SPOKEN_WORD_GENRES.has(genre);
    const long = info.durationMs !== null && info.durationMs > ONE_HOUR_MS;
    if (info.container === 'm4b' || AUDIOBOOK_GENRES.has(genre) || (spoken && (info.chapters.length > 0 || long))) {
      return 'audiobook';
    }
  }

  const tags = info.tags;
  if (PODCAST_GENRES.has(genre) || present(tags.podcastCategory) || present(tags.podcastFeedUrl) || present(tags.podcastEpisodeUrl)) {
    return hasVideo ? 'video-podcast' : 'podcast';
  }

  if (hasVideo) {
    const tvSignal =
      present(tags.show) || tags.season !== undefined || tags.episode !== undefined || present(tags.episodeId) || EPISODE_IN_NAME.test(fileName);
    if (tvSignal) return 'tv-show';

    const shortEnough = info.durationMs !== null && info.durationMs < MUSIC_VIDEO_MAX_MS;
    if (present(tags.artist) && present(tags.album) && shortEnough) return 'music-video';

    return 'movie';
  }

  return 'music';
}
