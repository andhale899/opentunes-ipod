import type { Artwork, Chapter } from '@opentunes/core';
import type { ProgressCallback } from './progress';

export type { ProgressCallback } from './progress';

export interface ConvertInput {
  /** Only used to name the output file. */
  name: string;
  blob: Blob;
}

export interface MergePart {
  name: string;
  blob: Blob;
  /** The chapter title. Defaults to the file name without its extension. */
  title?: string;
}

export interface ConvertOptions {
  /** Called with 0 to 1, going only forward, and an optional plain-language step name. */
  onProgress?: ProgressCallback;
  /** Aborting stops ffmpeg and ends the worker. The promise then rejects with an AbortError. */
  signal?: AbortSignal;
  /** A cover image to write. Needs `keepArtwork` in the spec. Without it the input's own cover is kept. */
  artwork?: Artwork | null;
  /**
   * Tags to write over the ones kept from the input (ffmpeg names: title, artist, album,
   * album_artist, genre, composer, comment, grouping, description, date, track, disc, lyrics,
   * show, season_number, episode_id, network, media_type). An empty value removes a tag.
   * Needs `keepTags` in the spec.
   */
  tags?: Record<string, string>;
  /**
   * Chapters to write, replacing the input's own. Needs `keepChapters` in the spec.
   * Ignored by `mergeAudiobook`, which makes one chapter per part.
   */
  chapters?: Chapter[];
}

export interface ConvertResult {
  bytes: Uint8Array;
  /** The input's name with the new extension, for example "Song.flac" gives "Song.m4a". */
  fileName: string;
  /** The ffmpeg log, trimmed, with only the latest progress line. */
  log: string;
}
