import type { Artwork, Chapter, MediaTags } from '../types';
import { ascii, isSynchsafe, removeUnsynchronisation, startsWithAscii, synchsafe32, u16be, u24be, u32be } from './bytes';
import { genreByIndex, resolveGenre } from './genres';
import { MAX_ARTWORK_BYTES, makeArtwork, sniffImageMime } from './image';
import type { Reader } from './reader';
import { fillTag, joinValues, mergeTags, type ProbeState, parseBpm, parseFlag, parseNumberPair, parseYear } from './state';
import { cleanText, decodeId3Text, findId3Terminator, latin1 as latin1Bytes, splitValues } from './text';

/** ID3v2 reading (versions 2.2, 2.3 and 2.4) and the ID3v1 fallback. Used by MP3, AAC, FLAC, WAV and AIFF. */

/** What an ID3 tag held, before it is merged into the result. */
export interface Id3Data {
  tags: MediaTags;
  chapters: Chapter[];
  artwork: Artwork | null;
  /** True when the tag carried the iTunes podcast flag (PCST). */
  podcast: boolean;
}

export interface Id3Header {
  version: number;
  revision: number;
  flags: number;
  bodySize: number;
  footer: boolean;
  /** Header, body and footer together. */
  totalSize: number;
}

/** The biggest ID3 tag body that is read whole (needed only when the whole tag is unsynchronised). */
const MAX_TAG_BYTES = 32 * 1024 * 1024;
/** Frames other than pictures bigger than this are skipped. */
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_FRAMES = 5000;

export function parseId3Header(b: Uint8Array): Id3Header | null {
  if (b.length < 10 || !startsWithAscii(b, 'ID3')) return null;
  const version = b[3] ?? 0;
  if (version < 2 || version > 4) return null;
  if (!isSynchsafe(b, 6, 4)) return null;
  const flags = b[5] ?? 0;
  const footer = version === 4 && (flags & 0x10) !== 0;
  const bodySize = synchsafe32(b, 6);
  return { version, revision: b[4] ?? 0, flags, bodySize, footer, totalSize: 10 + bodySize + (footer ? 10 : 0) };
}

interface Region {
  length: number;
  read(start: number, length: number): Promise<Uint8Array>;
}

function memoryRegion(bytes: Uint8Array): Region {
  return { length: bytes.length, read: async (start, length) => bytes.subarray(Math.max(0, start), Math.max(0, Math.min(bytes.length, start + length))) };
}

function fileRegion(r: Reader, base: number, length: number): Region {
  return { length, read: async (start, len) => (start >= length ? new Uint8Array(0) : r.read(base + start, Math.min(len, length - start))) };
}

interface FrameRef {
  id: string;
  offset: number;
  size: number;
  flags: number;
}

const V22_TO_V23: Record<string, string> = {
  TT2: 'TIT2', TP1: 'TPE1', TAL: 'TALB', TP2: 'TPE2', TCO: 'TCON', TCM: 'TCOM', TYE: 'TYER', TDA: 'TDAT', TRK: 'TRCK',
  TPA: 'TPOS', TBP: 'TBPM', COM: 'COMM', TT1: 'TIT1', ULT: 'USLT', PIC: 'APIC', TCP: 'TCMP', TXX: 'TXXX', PCS: 'PCST',
  WFD: 'WFED', GP1: 'GRP1', TOR: 'TORY', TCT: 'TCAT',
};

function validFrameId(id: string, idLength: number): boolean {
  return id.length === idLength && /^[A-Z0-9]+$/.test(id);
}

async function looksLikeFrameStart(region: Region, pos: number, idLength: number): Promise<boolean> {
  if (pos >= region.length) return true; // exactly at the end
  const b = await region.read(pos, idLength);
  if (b.length === 0) return true;
  if (b[0] === 0) return true; // padding
  return validFrameId(ascii(b, 0, idLength), idLength);
}

async function listFrames(region: Region, start: number, end: number, version: number, warn: (m: string) => void): Promise<FrameRef[]> {
  const headerLength = version === 2 ? 6 : 10;
  const idLength = version === 2 ? 3 : 4;
  const frames: FrameRef[] = [];
  let pos = start;
  while (pos + headerLength <= end && frames.length < MAX_FRAMES) {
    const h = await region.read(pos, headerLength);
    if (h.length < headerLength) break;
    if (h[0] === 0) break; // padding starts here
    const id = ascii(h, 0, idLength);
    if (!validFrameId(id, idLength)) {
      warn('Some of the ID3 tag could not be read because a frame header is damaged.');
      break;
    }
    const bodyStart = pos + headerLength;
    let size: number;
    let flags = 0;
    if (version === 2) {
      size = u24be(h, 3);
    } else if (version === 3) {
      size = u32be(h, 4);
      flags = u16be(h, 8);
    } else {
      flags = u16be(h, 8);
      const plain = u32be(h, 4);
      const safe = isSynchsafe(h, 4, 4) ? synchsafe32(h, 4) : -1;
      const fits = (n: number) => n >= 0 && bodyStart + n <= end;
      if (fits(safe) && fits(plain) && safe !== plain) {
        // Some writers (older iTunes among them) wrote plain sizes in 2.4 tags. The one that lands on another frame is right.
        size = (await looksLikeFrameStart(region, bodyStart + safe, idLength)) ? safe : plain;
      } else if (fits(safe)) {
        size = safe;
      } else if (fits(plain)) {
        size = plain;
      } else {
        size = safe >= 0 ? safe : plain;
      }
    }
    if (bodyStart + size > end) {
      warn('The ID3 tag is cut short, so its last frame is incomplete.');
      size = Math.max(0, end - bodyStart);
      frames.push({ id, offset: bodyStart, size, flags });
      break;
    }
    frames.push({ id, offset: bodyStart, size, flags });
    pos = bodyStart + size;
  }
  return frames;
}

/** The frame's bytes with the per-frame flags applied. Null for frames that are compressed or encrypted. */
async function frameBody(region: Region, f: FrameRef, version: number, tagUnsync: boolean): Promise<Uint8Array | null> {
  let bytes = await region.read(f.offset, f.size);
  if (version === 3) {
    if ((f.flags & 0x00c0) !== 0) return null; // compressed or encrypted
    if ((f.flags & 0x0020) !== 0) bytes = bytes.subarray(1);
  } else if (version === 4) {
    if ((f.flags & 0x000c) !== 0) return null;
    let skip = 0;
    if ((f.flags & 0x0040) !== 0) skip += 1;
    if ((f.flags & 0x0001) !== 0) skip += 4;
    bytes = bytes.subarray(skip);
    if ((f.flags & 0x0002) !== 0 || tagUnsync) bytes = removeUnsynchronisation(bytes);
  }
  return bytes;
}

function textValues(body: Uint8Array): string[] {
  if (body.length < 2) return [];
  return splitValues(decodeId3Text(body[0] ?? 0, body.subarray(1)));
}

/** COMM and USLT: encoding, language, short description, then the text. */
function parseCommentLike(body: Uint8Array): { description: string; text: string } | null {
  if (body.length < 4) return null;
  const encoding = body[0] ?? 0;
  const term = findId3Terminator(body, 4, encoding);
  if (term.index < 0) return { description: '', text: cleanText(decodeId3Text(encoding, body.subarray(4))) };
  return {
    description: cleanText(decodeId3Text(encoding, body.subarray(4, term.index))),
    text: cleanText(decodeId3Text(encoding, body.subarray(term.index + term.width))),
  };
}

interface PictureCandidate {
  frame: FrameRef;
  mime: string | null;
  type: number;
  dataOffset: number;
  /** Set when the frame had to be transformed, so the data is read from here and not from the file. */
  body: Uint8Array | null;
}

function parsePictureHead(head: Uint8Array, version: number): { mime: string | null; type: number; dataOffset: number } | null {
  if (head.length < 5) return null;
  const encoding = head[0] ?? 0;
  let mime: string | null;
  let pos: number;
  if (version === 2) {
    mime = ascii(head, 1, 3);
    pos = 4;
  } else {
    const term = findId3Terminator(head, 1, 0);
    if (term.index < 0) return null;
    mime = latin1Bytes(head.subarray(1, term.index));
    pos = term.index + 1;
  }
  const type = head[pos] ?? 0;
  pos += 1;
  const desc = findId3Terminator(head, pos, encoding);
  if (desc.index < 0) return null;
  return { mime, type, dataOffset: desc.index + desc.width };
}

function pictureRank(type: number): number {
  return type === 3 ? 0 : type === 0 ? 1 : 2;
}

function parseId3Number(values: string[] | undefined): { n?: number; total?: number } {
  const first = values?.[0];
  return first ? parseNumberPair(first) : {};
}

interface ChapFrame {
  id: string;
  startMs: number;
  title: string;
}

interface CtocFrame {
  id: string;
  topLevel: boolean;
  children: string[];
}

function readNullTerminatedLatin1(b: Uint8Array, from: number): { text: string; next: number } {
  let i = from;
  while (i < b.length && b[i] !== 0) i += 1;
  return { text: latin1Bytes(b.subarray(from, i)), next: i + 1 };
}

async function parseChap(body: Uint8Array, version: number, warn: (m: string) => void): Promise<ChapFrame | null> {
  const id = readNullTerminatedLatin1(body, 0);
  if (id.next + 16 > body.length) return null;
  const startMs = u32be(body, id.next);
  const rest = memoryRegion(body.subarray(id.next + 16));
  const subs = await listFrames(rest, 0, rest.length, version, warn);
  let title = '';
  for (const sub of subs) {
    if (sub.id !== 'TIT2') continue;
    const sb = await frameBody(rest, sub, version, false);
    const value = sb ? textValues(sb)[0] : undefined;
    if (value) {
      title = value;
      break;
    }
  }
  return { id: id.text, startMs, title };
}

function parseCtoc(body: Uint8Array): CtocFrame | null {
  const id = readNullTerminatedLatin1(body, 0);
  if (id.next + 2 > body.length) return null;
  const flags = body[id.next] ?? 0;
  const count = body[id.next + 1] ?? 0;
  const children: string[] = [];
  let pos = id.next + 2;
  for (let i = 0; i < count && pos < body.length; i += 1) {
    const child = readNullTerminatedLatin1(body, pos);
    children.push(child.text);
    pos = child.next;
  }
  return { id: id.text, topLevel: (flags & 0x02) !== 0, children };
}

/** The chapter order the table of contents gives, when there is one; otherwise every chapter in time order. */
function orderChapters(chaps: ChapFrame[], tocs: CtocFrame[]): Chapter[] {
  const byId = new Map(chaps.map((chap) => [chap.id, chap]));
  const tocById = new Map(tocs.map((toc) => [toc.id, toc]));
  const top = tocs.find((toc) => toc.topLevel) ?? tocs[0];
  let selected: ChapFrame[] = chaps;
  if (top) {
    const ordered: ChapFrame[] = [];
    const seen = new Set<string>();
    const walk = (toc: CtocFrame, depth: number) => {
      if (depth > 8 || seen.has(toc.id)) return;
      seen.add(toc.id);
      for (const child of toc.children) {
        const chap = byId.get(child);
        if (chap) {
          ordered.push(chap);
          continue;
        }
        const nested = tocById.get(child);
        if (nested) walk(nested, depth + 1);
      }
    };
    walk(top, 0);
    if (ordered.length > 0) selected = ordered;
  }
  return selected.map((chap) => ({ startMs: chap.startMs, title: chap.title }));
}

/**
 * Reads the ID3v2 tag that starts at `offset`. Returns null when there is no valid tag there.
 * `end` is the offset just past the tag (and its footer), where the audio or the next tag begins.
 */
export async function readId3v2(r: Reader, offset: number, warn: (message: string) => void): Promise<{ data: Id3Data; end: number } | null> {
  const header = parseId3Header(await r.read(offset, 10));
  if (!header) return null;

  const bodyStart = offset + 10;
  const end = Math.min(r.size, offset + header.totalSize);
  let bodySize = header.bodySize;
  const available = Math.max(0, r.size - bodyStart);
  if (bodySize > available) {
    warn('The ID3 tag says it is longer than the file, so the file looks cut short.');
    bodySize = available;
  }
  const data: Id3Data = { tags: {}, chapters: [], artwork: null, podcast: false };
  const { version } = header;

  if (version === 2 && (header.flags & 0x40) !== 0) {
    warn('The ID3 tag uses compression, which is not supported, so its tags were skipped.');
    return { data, end };
  }

  const tagUnsync = (header.flags & 0x80) !== 0;
  let region: Region;
  if (tagUnsync && version <= 3) {
    // Unsynchronisation changed the bytes of the frame headers too, so the whole tag has to be undone first.
    const raw = await r.read(bodyStart, Math.min(bodySize, MAX_TAG_BYTES));
    if (bodySize > MAX_TAG_BYTES) warn('The ID3 tag is very large, so only its first part was read.');
    region = memoryRegion(removeUnsynchronisation(raw));
  } else {
    region = fileRegion(r, bodyStart, bodySize);
  }
  const frameUnsync = tagUnsync && version === 4;

  let framesStart = 0;
  if ((header.flags & 0x40) !== 0 && version >= 3) {
    const ext = await region.read(0, 6);
    framesStart = version === 3 ? 4 + u32be(ext, 0) : synchsafe32(ext, 0);
    if (framesStart > region.length || framesStart < 0) framesStart = 0;
  }

  const frames = await listFrames(region, framesStart, region.length, version, warn);

  const texts = new Map<string, string[]>();
  const comments: { description: string; text: string }[] = [];
  const lyrics: { description: string; text: string }[] = [];
  const userText = new Map<string, string>();
  const pictures: PictureCandidate[] = [];
  const chaps: ChapFrame[] = [];
  const tocs: CtocFrame[] = [];
  let feedUrl: string | undefined;
  let skippedFrames = 0;

  for (const frame of frames) {
    const id = version === 2 ? (V22_TO_V23[frame.id] ?? frame.id) : frame.id;
    const isPicture = id === 'APIC';
    const wanted = id.startsWith('T') || id === 'COMM' || id === 'USLT' || isPicture || id === 'CHAP' || id === 'CTOC' || id === 'PCST' || id === 'WFED' || id === 'GRP1';
    if (!wanted) continue;
    if (!isPicture && frame.size > MAX_FRAME_BYTES) {
      skippedFrames += 1;
      continue;
    }

    if (isPicture) {
      const flagged = version >= 3 && (frame.flags & (version === 3 ? 0x00e0 : 0x004f)) !== 0;
      if (flagged || frameUnsync) {
        if (frame.size > MAX_ARTWORK_BYTES) {
          warn('A cover picture in the tag is too large to read, so it was skipped.');
          continue;
        }
        const body = await frameBody(region, frame, version, frameUnsync);
        if (!body) continue;
        const head = parsePictureHead(body.subarray(0, 8192), version);
        if (head) pictures.push({ frame, mime: head.mime, type: head.type, dataOffset: head.dataOffset, body });
      } else {
        const head = parsePictureHead(await region.read(frame.offset, Math.min(frame.size, 8192)), version);
        if (head) pictures.push({ frame, mime: head.mime, type: head.type, dataOffset: head.dataOffset, body: null });
      }
      continue;
    }

    const body = await frameBody(region, frame, version, frameUnsync);
    if (!body) {
      skippedFrames += 1;
      continue;
    }

    if (id === 'TXXX') {
      if (body.length >= 2) {
        const encoding = body[0] ?? 0;
        const term = findId3Terminator(body, 1, encoding);
        if (term.index >= 0) {
          const key = cleanText(decodeId3Text(encoding, body.subarray(1, term.index))).toUpperCase();
          const value = joinValues(splitValues(decodeId3Text(encoding, body.subarray(term.index + term.width))));
          if (key && value && !userText.has(key)) userText.set(key, value);
        }
      }
    } else if (id === 'COMM') {
      const parsed = parseCommentLike(body);
      if (parsed) comments.push(parsed);
    } else if (id === 'USLT') {
      const parsed = parseCommentLike(body);
      if (parsed) lyrics.push(parsed);
    } else if (id === 'CHAP') {
      const chap = await parseChap(body, version, warn);
      if (chap) chaps.push(chap);
    } else if (id === 'CTOC') {
      const toc = parseCtoc(body);
      if (toc) tocs.push(toc);
    } else if (id === 'PCST') {
      // iTunes writes this frame with four zero bytes on podcast episodes, so its presence is the flag.
      data.podcast = true;
    } else if (id === 'WFED') {
      let url = cleanText(latin1Bytes(body));
      if (url.length > 0 && url.charCodeAt(0) < 32) url = url.slice(1);
      if (url && feedUrl === undefined) feedUrl = url;
    } else if (id.startsWith('T') || id === 'GRP1') {
      const values = textValues(body);
      if (values.length > 0 && !texts.has(id)) texts.set(id, values);
    }
  }
  if (skippedFrames > 0) warn('Some ID3 frames are compressed, encrypted or too large and were skipped.');

  const first = (id: string): string | undefined => {
    const values = texts.get(id);
    return values && values.length > 0 ? joinValues(values) : undefined;
  };

  const tags = data.tags;
  fillTag(tags, 'title', first('TIT2'));
  fillTag(tags, 'artist', first('TPE1'));
  fillTag(tags, 'album', first('TALB'));
  fillTag(tags, 'albumArtist', first('TPE2') ?? userText.get('ALBUMARTIST') ?? userText.get('ALBUM ARTIST'));
  fillTag(tags, 'composer', first('TCOM'));
  const genreValues = texts.get('TCON');
  if (genreValues) fillTag(tags, 'genre', joinValues(genreValues.map((value) => resolveGenre(value))));
  for (const yearId of ['TDRC', 'TYER', 'TDRL', 'TORY', 'TDOR']) {
    const year = parseYear(first(yearId) ?? '');
    if (year !== undefined) {
      fillTag(tags, 'year', year);
      break;
    }
  }
  const track = parseId3Number(texts.get('TRCK'));
  fillTag(tags, 'trackNumber', track.n);
  fillTag(tags, 'trackTotal', track.total);
  const disc = parseId3Number(texts.get('TPOS'));
  fillTag(tags, 'discNumber', disc.n);
  fillTag(tags, 'discTotal', disc.total);
  const bpm = first('TBPM');
  if (bpm) fillTag(tags, 'bpm', parseBpm(bpm));
  const compilation = first('TCMP');
  if (compilation) fillTag(tags, 'compilation', parseFlag(compilation));
  fillTag(tags, 'grouping', first('GRP1') ?? first('TIT1'));
  fillTag(tags, 'description', first('TDES'));
  fillTag(tags, 'podcastCategory', first('TCAT'));
  fillTag(tags, 'podcastEpisodeUrl', first('TGID'));
  fillTag(tags, 'podcastFeedUrl', feedUrl);

  // iTunes keeps its own bookkeeping in COMM frames with descriptions like "iTunNORM". Those are not the person's comment.
  const userComments = comments.filter((c) => !/^itun/i.test(c.description) && c.text.length > 0);
  fillTag(tags, 'comment', (userComments.find((c) => c.description.length === 0) ?? userComments[0])?.text);
  const lyric = lyrics.find((l) => l.text.length > 0);
  fillTag(tags, 'lyrics', lyric?.text);
  if (data.podcast) tags.declaredKind = 'podcast';

  if (chaps.length > 0) data.chapters = orderChapters(chaps, tocs);

  if (pictures.length > 0) {
    let best = pictures[0] as PictureCandidate;
    for (const candidate of pictures) {
      if (pictureRank(candidate.type) < pictureRank(best.type)) best = candidate;
    }
    const length = best.frame.size - best.dataOffset;
    if (best.mime === '-->') {
      // The picture is a link to somewhere else, not data.
    } else if (length <= 0) {
      warn('The cover picture in the tag is empty.');
    } else if (length > MAX_ARTWORK_BYTES) {
      warn('The cover picture in the tag is too large to read, so it was skipped.');
    } else {
      const bytes = best.body ? best.body.subarray(best.dataOffset) : await region.read(best.frame.offset + best.dataOffset, length);
      const mime = sniffImageMime(bytes);
      if (bytes.length > 0 && mime) data.artwork = makeArtwork(mime, bytes);
      else if (bytes.length > 0) warn('The cover picture in the tag is in a format that is not recognised.');
    }
  }

  return { data, end };
}

/** The ID3v1 tag in the last 128 bytes, or null. */
export async function readId3v1(r: Reader): Promise<MediaTags | null> {
  if (r.size < 128) return null;
  const b = await r.read(r.size - 128, 128);
  if (b.length < 128 || !startsWithAscii(b, 'TAG')) return null;
  const field = (from: number, length: number): string => cleanText(latin1Bytes(b.subarray(from, from + length)).replace(/\0.*$/s, ''));
  const tags: MediaTags = {};
  fillTag(tags, 'title', field(3, 30));
  fillTag(tags, 'artist', field(33, 30));
  fillTag(tags, 'album', field(63, 30));
  fillTag(tags, 'year', parseYear(field(93, 4)));
  if (b[125] === 0 && (b[126] ?? 0) !== 0) {
    fillTag(tags, 'comment', field(97, 28));
    fillTag(tags, 'trackNumber', b[126]);
  } else {
    fillTag(tags, 'comment', field(97, 30));
  }
  const genre = b[127] ?? 255;
  if (genre !== 255) fillTag(tags, 'genre', genreByIndex(genre));
  return tags;
}

/** Skips one or more ID3v2 tags at `from`. Returns where the audio starts and what the tags held. */
export async function skipId3v2Tags(r: Reader, from: number, warn: (message: string) => void): Promise<{ audioStart: number; tags: Id3Data[] }> {
  let pos = from;
  const found: Id3Data[] = [];
  for (let i = 0; i < 8; i += 1) {
    const result = await readId3v2(r, pos, warn);
    if (!result) break;
    found.push(result.data);
    if (result.end <= pos) break;
    pos = result.end;
  }
  return { audioStart: pos, tags: found };
}

/** Adds what an ID3 tag held to the result. Fields already filled are kept, so call this in order of preference. */
export function applyId3(state: ProbeState, data: Id3Data | null): void {
  if (!data) return;
  mergeTags(state.tags, data.tags);
  if (state.chapters.length === 0 && data.chapters.length > 0) state.chapters = data.chapters.slice();
  state.artwork ??= data.artwork;
}

/** One Id3Data from several tags, the first tag winning where they overlap. */
export function combineId3(tags: Id3Data[]): Id3Data | null {
  if (tags.length === 0) return null;
  const out: Id3Data = { tags: {}, chapters: [], artwork: null, podcast: false };
  for (const item of tags) {
    for (const key of Object.keys(item.tags) as (keyof MediaTags)[]) fillTag(out.tags, key, item.tags[key] as never);
    if (out.chapters.length === 0) out.chapters = item.chapters;
    out.artwork ??= item.artwork;
    out.podcast ||= item.podcast;
  }
  return out;
}
