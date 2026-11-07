import type { Artwork, Chapter } from '../types';
import { u32be, u32le } from './bytes';
import { MAX_ARTWORK_BYTES, base64Decode, makeArtwork, sniffImageMime } from './image';
import { addWarning, fillTag, joinValues, parseBpm, parseFlag, parseNumberPair, parseYear, type ProbeState } from './state';
import { cleanText, utf8 } from './text';

/** Vorbis comments, used by FLAC, Ogg Vorbis and Opus. Keys are upper-cased because the format ignores case. */

export type VorbisField = [key: string, value: string];

/** Reads a Vorbis comment block that starts at `start`: vendor string, then a count and "KEY=value" entries. */
export function parseVorbisComments(b: Uint8Array, start: number): VorbisField[] {
  const fields: VorbisField[] = [];
  let pos = start;
  const vendorLength = u32le(b, pos);
  pos += 4 + vendorLength;
  if (pos + 4 > b.length) return fields;
  const count = u32le(b, pos);
  pos += 4;
  for (let i = 0; i < count && i < 20000; i += 1) {
    if (pos + 4 > b.length) break;
    const length = u32le(b, pos);
    pos += 4;
    if (pos + length > b.length) break;
    const text = utf8(b.subarray(pos, pos + length));
    pos += length;
    const eq = text.indexOf('=');
    if (eq <= 0) continue;
    fields.push([text.slice(0, eq).toUpperCase(), text.slice(eq + 1)]);
  }
  return fields;
}

export interface PictureBlock {
  type: number;
  mime: string;
  data: Uint8Array;
}

/** The FLAC PICTURE block layout, also what Ogg carries base64 encoded in METADATA_BLOCK_PICTURE. */
export function parsePictureBlock(b: Uint8Array): PictureBlock | null {
  if (b.length < 32) return null;
  const type = u32be(b, 0);
  const mimeLength = u32be(b, 4);
  let pos = 8 + mimeLength;
  if (pos + 4 > b.length) return null;
  const mime = utf8(b.subarray(8, 8 + mimeLength));
  const descLength = u32be(b, pos);
  pos += 4 + descLength + 16; // description, then width, height, depth and colour count
  if (pos + 4 > b.length) return null;
  const dataLength = u32be(b, pos);
  pos += 4;
  if (dataLength === 0 || pos + dataLength > b.length) return null;
  return { type, mime, data: b.subarray(pos, pos + dataLength) };
}

function pictureRank(type: number): number {
  return type === 3 ? 0 : type === 0 ? 1 : 2;
}

export function bestPicture<T extends { type: number }>(pictures: T[]): T | undefined {
  let best: T | undefined;
  for (const picture of pictures) {
    if (!best || pictureRank(picture.type) < pictureRank(best.type)) best = picture;
  }
  return best;
}

/** Turns a picture block into artwork, or says why not. */
export function artworkFromPicture(state: ProbeState, picture: PictureBlock | undefined): Artwork | null {
  if (!picture) return null;
  if (picture.data.length > MAX_ARTWORK_BYTES) {
    addWarning(state, 'The cover picture is too large to read, so it was skipped.');
    return null;
  }
  const mime = sniffImageMime(picture.data);
  if (!mime) {
    if (picture.mime !== '-->') addWarning(state, 'The cover picture is in a format that is not recognised.');
    return null;
  }
  return makeArtwork(mime, picture.data);
}

function values(fields: VorbisField[], ...keys: string[]): string | undefined {
  for (const key of keys) {
    const found = fields.filter((field) => field[0] === key).map((field) => cleanText(field[1])).filter((value) => value.length > 0);
    if (found.length > 0) return joinValues(found);
  }
  return undefined;
}

/** "00:12:34.500" or "12:34.5" as milliseconds. */
function parseChapterTime(text: string): number | null {
  const match = /^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(text.trim());
  if (!match) return null;
  return Math.round((Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1000);
}

/** Puts Vorbis comment fields into the tags and chapters. Fields already set are kept. Returns the embedded pictures, if any. */
export function applyVorbisFields(state: ProbeState, fields: VorbisField[]): PictureBlock[] {
  const tags = state.tags;
  fillTag(tags, 'title', values(fields, 'TITLE'));
  fillTag(tags, 'artist', values(fields, 'ARTIST'));
  fillTag(tags, 'album', values(fields, 'ALBUM'));
  fillTag(tags, 'albumArtist', values(fields, 'ALBUMARTIST', 'ALBUM ARTIST', 'ALBUM_ARTIST'));
  fillTag(tags, 'genre', values(fields, 'GENRE'));
  fillTag(tags, 'composer', values(fields, 'COMPOSER'));
  fillTag(tags, 'comment', values(fields, 'COMMENT'));
  fillTag(tags, 'description', values(fields, 'DESCRIPTION'));
  fillTag(tags, 'grouping', values(fields, 'GROUPING', 'CONTENTGROUP'));
  fillTag(tags, 'lyrics', values(fields, 'LYRICS', 'UNSYNCEDLYRICS'));
  fillTag(tags, 'year', parseYear(values(fields, 'DATE', 'YEAR', 'ORIGINALDATE') ?? ''));

  const track = parseNumberPair(values(fields, 'TRACKNUMBER', 'TRACK') ?? '');
  fillTag(tags, 'trackNumber', track.n);
  fillTag(tags, 'trackTotal', track.total ?? parseNumberPair(values(fields, 'TRACKTOTAL', 'TOTALTRACKS') ?? '').n);
  const disc = parseNumberPair(values(fields, 'DISCNUMBER', 'DISC') ?? '');
  fillTag(tags, 'discNumber', disc.n);
  fillTag(tags, 'discTotal', disc.total ?? parseNumberPair(values(fields, 'DISCTOTAL', 'TOTALDISCS') ?? '').n);

  const bpm = values(fields, 'BPM', 'TEMPO');
  if (bpm) fillTag(tags, 'bpm', parseBpm(bpm));
  const compilation = values(fields, 'COMPILATION');
  if (compilation) fillTag(tags, 'compilation', parseFlag(compilation));
  const podcast = values(fields, 'PODCAST');
  if (podcast && parseFlag(podcast) === true && tags.declaredKind === undefined) tags.declaredKind = 'podcast';

  // Chapters are CHAPTER001=00:00:00.000 with a matching CHAPTER001NAME=Title.
  const chapters: Chapter[] = [];
  for (const [key, value] of fields) {
    const match = /^CHAPTER(\d+)$/.exec(key);
    if (!match) continue;
    const startMs = parseChapterTime(value);
    if (startMs === null) continue;
    const title = values(fields, `CHAPTER${match[1]}NAME`) ?? '';
    chapters.push({ startMs, title });
  }
  if (chapters.length > 0 && state.chapters.length === 0) state.chapters = chapters;

  const pictures: PictureBlock[] = [];
  for (const [key, value] of fields) {
    if (key !== 'METADATA_BLOCK_PICTURE') continue;
    const decoded = base64Decode(value);
    const block = decoded ? parsePictureBlock(decoded) : null;
    if (block) pictures.push(block);
  }
  return pictures;
}
