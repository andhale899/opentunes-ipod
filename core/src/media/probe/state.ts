import type { Artwork, AudioStream, Chapter, ContentKind, MediaContainer, MediaInfo, MediaTags, VideoStream } from '../types';
import { cleanText, VALUE_SEPARATOR } from './text';

/** What a format reader fills in as it reads. `finalize` turns it into a MediaInfo. */
export interface ProbeState {
  container: MediaContainer;
  durationMs: number | null;
  audio: AudioStream | null;
  video: VideoStream | null;
  tags: MediaTags;
  chapters: Chapter[];
  artwork: Artwork | null;
  protected: boolean;
  warnings: string[];
}

export function createState(): ProbeState {
  return { container: 'unknown', durationMs: null, audio: null, video: null, tags: {}, chapters: [], artwork: null, protected: false, warnings: [] };
}

export function addWarning(state: ProbeState, message: string): void {
  if (!state.warnings.includes(message) && state.warnings.length < 50) state.warnings.push(message);
}

/** Sets a tag only when it is still empty, so the first (best) source wins and later ones only fill gaps. */
export function fillTag<K extends keyof MediaTags>(tags: MediaTags, key: K, value: MediaTags[K] | undefined | null): void {
  if (value === undefined || value === null) return;
  if (typeof value === 'string' && value.length === 0) return;
  if (typeof value === 'number' && !Number.isFinite(value)) return;
  if (tags[key] === undefined) tags[key] = value;
}

/** Copies every tag from `from` that `into` does not have yet. */
export function mergeTags(into: MediaTags, from: MediaTags): void {
  for (const key of Object.keys(from) as (keyof MediaTags)[]) {
    const value = from[key];
    if (value !== undefined) fillTag(into, key, value as never);
  }
}

/** "3", "3/12", "03 of 12" become a number and an optional total. */
export function parseNumberPair(text: string): { n?: number; total?: number } {
  const match = /^\s*(\d+)\s*(?:(?:\/|of)\s*(\d+))?/i.exec(text);
  if (!match) return {};
  const result: { n?: number; total?: number } = {};
  const n = Number(match[1]);
  if (Number.isFinite(n) && n > 0) result.n = n;
  if (match[2] !== undefined) {
    const total = Number(match[2]);
    if (Number.isFinite(total) && total > 0) result.total = total;
  }
  return result;
}

/** The year in "1999", "1999-05-04" or "2004-03-02T10:00:00Z". Zero and absurd years are ignored. */
export function parseYear(text: string): number | undefined {
  const match = /(\d{4})/.exec(text);
  if (!match) return undefined;
  const year = Number(match[1]);
  return year >= 1000 && year <= 9999 ? year : undefined;
}

export function parseBpm(text: string): number | undefined {
  const value = Math.round(Number.parseFloat(text));
  return Number.isFinite(value) && value > 0 && value < 1000 ? value : undefined;
}

export function parseFlag(text: string): boolean | undefined {
  const value = text.trim().toLowerCase();
  if (value === '1' || value === 'true' || value === 'yes') return true;
  if (value === '0' || value === 'false' || value === 'no') return false;
  return undefined;
}

export function joinValues(values: string[]): string {
  return values.map((value) => cleanText(value)).filter((value) => value.length > 0).join(VALUE_SEPARATOR);
}

/** "Audiobook" and "Podcast" as a genre are the file saying what it is. Nothing else is guessed. */
export function declaredKindFromGenre(genre: string | undefined): ContentKind | undefined {
  if (!genre) return undefined;
  const text = genre.trim().toLowerCase();
  if (text === 'podcast' || text === 'podcasts') return 'podcast';
  if (text === 'audiobook' || text === 'audiobooks' || text === 'audio book' || text === 'audio books') return 'audiobook';
  return undefined;
}

/** Longest length believed: about three years. Anything bigger is a damaged header. */
const MAX_DURATION_MS = 1e11;

function cleanDuration(value: number | null): number | null {
  if (value === null || !Number.isFinite(value) || value < 0 || value > MAX_DURATION_MS) return null;
  return Math.round(value);
}

const inRange = (value: number, max: number): boolean => Number.isFinite(value) && value >= 0 && value <= max;

/**
 * A last check on the numbers every format reader produced. A damaged header can hold nonsense, such as a
 * negative sample rate, and nothing downstream should have to cope with that. Values out of range become
 * "unknown" (zero, or null where the type allows it), and one warning says so.
 */
function sanitizeStreams(state: ProbeState): { audio: AudioStream | null; video: VideoStream | null; changed: boolean } {
  let changed = false;
  let audio: AudioStream | null = null;
  if (state.audio) {
    audio = { ...state.audio };
    if (!inRange(audio.sampleRateHz, 1_000_000)) {
      audio.sampleRateHz = 0;
      changed = true;
    } else audio.sampleRateHz = Math.round(audio.sampleRateHz);
    if (!inRange(audio.channels, 64)) {
      audio.channels = 0;
      changed = true;
    } else audio.channels = Math.round(audio.channels);
    if (audio.bitrateKbps !== null) {
      if (!inRange(audio.bitrateKbps, 1_000_000)) {
        audio.bitrateKbps = null;
        changed = true;
      } else audio.bitrateKbps = Math.round(audio.bitrateKbps);
    }
    if (audio.bitDepth !== undefined && !(Number.isFinite(audio.bitDepth) && audio.bitDepth >= 1 && audio.bitDepth <= 64)) {
      delete audio.bitDepth;
      changed = true;
    }
  }
  let video: VideoStream | null = null;
  if (state.video) {
    video = { ...state.video };
    if (!inRange(video.width, 65535)) {
      video.width = 0;
      changed = true;
    } else video.width = Math.round(video.width);
    if (!inRange(video.height, 65535)) {
      video.height = 0;
      changed = true;
    } else video.height = Math.round(video.height);
    if (video.fps !== null && !(Number.isFinite(video.fps) && video.fps > 0 && video.fps <= 1000)) {
      video.fps = null;
      changed = true;
    }
    if (video.bitrateKbps !== null) {
      if (!inRange(video.bitrateKbps, 10_000_000)) {
        video.bitrateKbps = null;
        changed = true;
      } else video.bitrateKbps = Math.round(video.bitrateKbps);
    }
  }
  return { audio, video, changed };
}

function cleanTags(tags: MediaTags): MediaTags {
  const out: MediaTags = {};
  for (const key of Object.keys(tags) as (keyof MediaTags)[]) {
    const value = tags[key];
    if (value === undefined) continue;
    if (typeof value === 'string' && value.length === 0) continue;
    if (typeof value === 'number' && !Number.isFinite(value)) continue;
    (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

/** Builds the result. Always succeeds, even when nothing could be read. */
export function finalize(state: ProbeState, fileName: string, sizeBytes: number): MediaInfo {
  const tags = cleanTags(state.tags);
  if (tags.declaredKind === undefined) {
    const fromGenre = declaredKindFromGenre(tags.genre);
    if (fromGenre) tags.declaredKind = fromGenre;
  }
  // A podcast with a picture track is a video podcast.
  if (tags.declaredKind === 'podcast' && state.video) tags.declaredKind = 'video-podcast';

  const streams = sanitizeStreams(state);
  if (streams.changed) addWarning(state, 'Some values in the file were out of range, so they were treated as unknown.');
  if (state.durationMs !== null && cleanDuration(state.durationMs) === null) addWarning(state, 'The length in the file is not a believable number, so it was treated as unknown.');

  const chapters = state.chapters
    .filter((chapter) => Number.isFinite(chapter.startMs) && chapter.startMs >= 0)
    .map((chapter, index) => ({ startMs: Math.round(chapter.startMs), title: chapter.title.length > 0 ? chapter.title : `Chapter ${index + 1}` }))
    .sort((a, b) => a.startMs - b.startMs);

  return {
    fileName,
    sizeBytes,
    container: state.container,
    durationMs: cleanDuration(state.durationMs),
    audio: streams.audio,
    video: streams.video,
    tags,
    chapters,
    artwork: state.artwork,
    protected: state.protected,
    warnings: state.warnings.slice(),
  };
}
