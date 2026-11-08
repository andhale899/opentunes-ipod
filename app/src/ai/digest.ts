import { trackKey, type TrackInfo } from '@opentunes/engine';
import type { KnownTrack } from './schema';

/**
 * The library as the text the model sees: one short line per track, with a number the model
 * uses to name it, so a proposal can be mapped back to a real track. Pure, so it can be tested
 * without a browser.
 *
 * Sent: kind, title, artist, album, genre, year, track number. Never sent: file paths, sizes
 * (unless asked for), durations, play counts, artwork, or the iPod's name and ids.
 */

/** The part of a track the digest reads. Taking only this keeps the digest honest about what leaves. */
export type DigestSource = Pick<TrackInfo, 'ipod_path' | 'title' | 'artist' | 'album' | 'albumartist' | 'genre' | 'year' | 'track_nr' | 'tracklen' | 'kind' | 'size'>;

/** More than this in one request is too much to review or to answer well. */
export const MAX_TRACKS_PER_REQUEST = 1500;
export const MAX_FIELD_CHARS = 60;
export const DIGEST_HEADER = 'id|kind|title|artist|album|genre|year|track';
/** Fixed text around the digest: the system prompt, the tool definitions and the question. */
export const OVERHEAD_TOKENS = 1200;

export interface DigestOptions {
  includeSize?: boolean;
  maxFieldChars?: number;
}

export interface Digest {
  /** One entry per track, in library order, numbered from 1. */
  lines: string[];
  /** Id to the track as it is now, for validating proposals and showing before and after. */
  known: Map<number, KnownTrack>;
  /** How many fields were cut short. */
  truncated: number;
  /** The column names, sent once above the lines. */
  header: string;
}

export interface DigestPart {
  /** The ids this request covers. */
  ids: number[];
  text: string;
  tracks: number;
  chars: number;
  tokens: number;
}

/** Roughly four characters to a token. A guide for the person, not a bill. */
export const estimateTokens = (chars: number): number => Math.ceil(chars / 4);

/**
 * Makes a field safe to put between "|" separators and inside a <library> block: no separators,
 * line breaks, control characters or angle brackets (a title cannot close the block and add
 * instructions after it), runs of space collapsed, cut to a length.
 */
export function cleanField(value: string | null | undefined, maxChars = MAX_FIELD_CHARS): { text: string; cut: boolean } {
  const text = (value ?? '')
    .replace(/[|<>]/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = [...text];
  return chars.length > maxChars ? { text: `${chars.slice(0, maxChars - 1).join('')}…`, cut: true } : { text, cut: false };
}

export function buildDigest(tracks: DigestSource[], options: DigestOptions = {}): Digest {
  const max = options.maxFieldChars ?? MAX_FIELD_CHARS;
  const lines: string[] = [];
  const known = new Map<number, KnownTrack>();
  let truncated = 0;
  tracks.forEach((track, index) => {
    const id = index + 1;
    const fields = [track.title, track.artist, track.album, track.genre].map((value) => cleanField(value, max));
    truncated += fields.filter((field) => field.cut).length;
    const parts = [String(id), track.kind, ...fields.map((field) => field.text), track.year > 0 ? String(track.year) : '', track.track_nr > 0 ? `track ${track.track_nr}` : ''];
    if (options.includeSize) parts.push(`${Math.round(track.size / 1024)} KB`);
    lines.push(parts.join('|'));
    known.set(id, {
      id,
      key: trackKey(track),
      kind: track.kind,
      title: track.title,
      artist: track.artist,
      album: track.album,
      albumartist: track.albumartist,
      genre: track.genre,
      year: track.year,
      track_nr: track.track_nr,
    });
  });
  return { lines, known, truncated, header: options.includeSize ? `${DIGEST_HEADER}|size` : DIGEST_HEADER };
}

function partOf(digest: Digest, ids: number[]): DigestPart {
  const text = [digest.header, ...ids.map((id) => digest.lines[id - 1] as string)].join('\n');
  return { ids, text, tracks: ids.length, chars: text.length, tokens: estimateTokens(text.length) + OVERHEAD_TOKENS };
}

/** Which tracks a request covers: those whose line holds `filter` (any case), or all when it is empty. */
export function selectIds(digest: Digest, filter = ''): number[] {
  const needle = filter.trim().toLowerCase();
  const ids: number[] = [];
  digest.lines.forEach((line, index) => {
    // Skip the id and the kind, which every line has.
    if (!needle || line.split('|').slice(2).join('|').toLowerCase().includes(needle)) ids.push(index + 1);
  });
  return ids;
}

/** Splits the ids into requests of at most `size` tracks each. */
export function chunkIds(ids: number[], size = MAX_TRACKS_PER_REQUEST): number[][] {
  const parts: number[][] = [];
  for (let at = 0; at < ids.length; at += size) parts.push(ids.slice(at, at + size));
  return parts.length ? parts : [[]];
}

/**
 * The text to send for part `part` (from 0) of the tracks `ids` select. When there is more than
 * one part the person has to ask part by part, or narrow the filter.
 */
export function digestPart(digest: Digest, ids: number[], part = 0, size = MAX_TRACKS_PER_REQUEST): { part: DigestPart; parts: number } {
  const chunks = chunkIds(ids, size);
  const index = Math.min(Math.max(part, 0), chunks.length - 1);
  return { part: partOf(digest, chunks[index] as number[]), parts: chunks.length };
}
