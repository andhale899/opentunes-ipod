import type { AudioCodec, AudioStream, Chapter, MediaContainer, VideoCodec, VideoStream } from '../types';
import { fourcc, u16be, u32be, u64be } from './bytes';
import { MAX_ARTWORK_BYTES, makeArtwork, sniffImageMime } from './image';
import {
  avcLevelName,
  avcProfileName,
  hevcProfileName,
  memBoxes,
  parseAlacCookie,
  parseAsc,
  parseEsds,
  type EsdsInfo,
  type MemBox,
} from './mp4-codecs';
import { applyIlstItem, applyQuickTimeTextAtom, type IlstEntry, itemEntries } from './mp4-itunes';
import type { Reader } from './reader';
import { addWarning, type ProbeState } from './state';
import { cleanText, utf16, utf8 } from './text';

/**
 * The MP4 family: M4A, M4B, M4V, MP4 and MOV. Boxes are walked by their headers, so the big `mdat`
 * box with the audio and video samples is jumped over and never read. The movie box (`moov`) may
 * come before or after it.
 */

interface Box {
  type: string;
  start: number;
  header: number;
  end: number;
  truncated: boolean;
}

/** Boxes bigger than this are not read whole, except cover pictures and sample size tables. */
const MAX_BOX_BODY = 1024 * 1024;
/** The sample size table is read in pieces up to this many bytes, to total the bytes of a track. */
const MAX_STSZ_BYTES = 16 * 1024 * 1024;
const MAX_CHAPTERS = 20000;

async function readBox(r: Reader, pos: number, limit: number): Promise<Box | null> {
  if (pos + 8 > limit) return null;
  const b = await r.read(pos, 16);
  if (b.length < 8) return null;
  let size = u32be(b, 0);
  const type = fourcc(b, 4);
  let header = 8;
  if (size === 1) {
    if (b.length < 16) return null;
    size = u64be(b, 8);
    header = 16;
  } else if (size === 0) {
    size = limit - pos; // runs to the end of whatever holds it
  }
  if (type === 'uuid') header += 16;
  if (size < header) return null;
  let end = pos + size;
  let truncated = false;
  if (end > limit) {
    end = limit;
    truncated = true;
  }
  return { type, start: pos, header, end, truncated };
}

async function listBoxes(r: Reader, start: number, end: number, max = 4096): Promise<Box[]> {
  const out: Box[] = [];
  let pos = start;
  while (pos + 8 <= end && out.length < max) {
    const box = await readBox(r, pos, end);
    if (!box) break;
    out.push(box);
    if (box.end <= pos) break;
    pos = box.end;
  }
  return out;
}

function childOf(boxes: Box[], type: string): Box | undefined {
  return boxes.find((box) => box.type === type);
}

async function bodyOf(r: Reader, box: Box, max = MAX_BOX_BODY): Promise<Uint8Array> {
  return r.read(box.start + box.header, Math.min(max, box.end - box.start - box.header));
}

interface Stbl {
  stts?: Box;
  stsc?: Box;
  stsz?: Box;
  stco?: Box;
  co64?: Box;
}

interface TrackInfo {
  id: number;
  enabled: boolean;
  handler: string;
  timescale: number;
  /** In media timescale units. Zero when the file does not say. */
  duration: number;
  width: number;
  height: number;
  chapTargets: number[];
  entry: Uint8Array | null;
  stbl: Stbl;
  sampleCount: number;
  dataBytes: number | null;
}

interface Mp4Context {
  r: Reader;
  state: ProbeState;
  tracks: TrackInfo[];
  movieTimescale: number;
  movieDuration: number;
  fragmentDuration: number;
  nero: Chapter[];
  /** The iTunes gapless note (iTunSMPB): encoder priming, padding, and the number of samples that are really audio. */
  gapless: { priming: number; padding: number; valid: number } | null;
}

const STANDARD_RATES = new Set([7350, 8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000, 64000, 88200, 96000, 176400, 192000]);

function containerFromBrands(major: string, compatible: string[]): MediaContainer {
  switch (major) {
    case 'M4A ':
    case 'M4P ':
      return 'm4a';
    case 'M4B ':
      return 'm4b';
    case 'M4V ':
    case 'M4VH':
    case 'M4VP':
      return 'm4v';
    case 'qt  ':
      return 'mov';
    default:
      break;
  }
  if (compatible.includes('M4B ')) return 'm4b';
  if (compatible.includes('M4A ')) return 'm4a';
  if (compatible.includes('M4V ')) return 'm4v';
  return 'mp4';
}

export async function probeMp4(r: Reader, state: ProbeState, hasFtyp: boolean): Promise<void> {
  state.container = hasFtyp ? 'mp4' : 'mov';
  const ctx: Mp4Context = { r, state, tracks: [], movieTimescale: 0, movieDuration: 0, fragmentDuration: 0, nero: [], gapless: null };

  let pos = 0;
  let sawMoov = false;
  for (let guard = 0; guard < 4000 && pos < r.size; guard += 1) {
    const box = await readBox(r, pos, r.size);
    if (!box) {
      if (!sawMoov) addWarning(state, 'A box header in the file is damaged, so reading stopped there.');
      break;
    }
    if (box.type === 'ftyp') {
      const body = await bodyOf(r, box, 4096);
      const major = fourcc(body, 0);
      const compatible: string[] = [];
      for (let i = 8; i + 4 <= body.length; i += 4) compatible.push(fourcc(body, i));
      state.container = containerFromBrands(major, compatible);
    } else if (box.type === 'moov') {
      sawMoov = true;
      if (box.truncated) addWarning(state, 'The movie box (moov) is cut short, so some information may be missing.');
      await parseMoov(ctx, box);
      break;
    }
    if (box.truncated) break;
    pos = box.end;
  }
  if (!sawMoov) {
    addWarning(state, 'This file has no movie box (moov), so it is probably cut short. Nothing could be read from it but its type.');
    return;
  }
  await finish(ctx);
}

async function parseMoov(ctx: Mp4Context, moov: Box): Promise<void> {
  const { r } = ctx;
  const children = await listBoxes(r, moov.start + moov.header, moov.end);
  for (const child of children) {
    if (child.type === 'mvhd') {
      const b = await bodyOf(r, child, 40);
      if ((b[0] ?? 0) === 1) {
        ctx.movieTimescale = u32be(b, 20);
        const d = u64be(b, 24);
        ctx.movieDuration = d < 2 ** 53 ? d : 0;
      } else {
        ctx.movieTimescale = u32be(b, 12);
        const d = u32be(b, 16);
        ctx.movieDuration = d === 0xffffffff ? 0 : d;
      }
    } else if (child.type === 'mvex') {
      const inner = await listBoxes(r, child.start + child.header, child.end);
      const mehd = childOf(inner, 'mehd');
      if (mehd) {
        const b = await bodyOf(r, mehd, 16);
        ctx.fragmentDuration = (b[0] ?? 0) === 1 ? u64be(b, 4) : u32be(b, 4);
      }
    } else if (child.type === 'trak') {
      const track = await parseTrak(ctx, child);
      if (track) ctx.tracks.push(track);
    }
  }
  // Tags come after the tracks so a failure there cannot lose the streams.
  for (const child of children) {
    if (child.type === 'udta') await parseUdta(ctx, child);
    else if (child.type === 'meta') await parseMeta(ctx, child);
  }
}

async function parseUdta(ctx: Mp4Context, udta: Box): Promise<void> {
  const { r, state } = ctx;
  const children = await listBoxes(r, udta.start + udta.header, udta.end);
  for (const child of children) {
    if (child.type === 'meta') await parseMeta(ctx, child);
    else if (child.type === 'chpl') ctx.nero = await parseChpl(r, child);
  }
  for (const child of children) {
    if (child.type.startsWith('©')) applyQuickTimeTextAtom(state.tags, child.type, await bodyOf(r, child, 4096));
  }
}

async function parseMeta(ctx: Mp4Context, meta: Box): Promise<void> {
  const { r } = ctx;
  const bodyStart = meta.start + meta.header;
  const head = await r.read(bodyStart, 12);
  // iTunes writes meta as a full box (4 bytes of version and flags first). QuickTime does not.
  const skip = fourcc(head, 4) === 'hdlr' ? 0 : u32be(head, 0) === 0 ? 4 : 0;
  const children = await listBoxes(r, bodyStart + skip, meta.end);
  const ilst = childOf(children, 'ilst');
  if (ilst) await parseIlst(ctx, ilst);
}

async function parseIlst(ctx: Mp4Context, ilst: Box): Promise<void> {
  const { r, state } = ctx;
  const items = await listBoxes(r, ilst.start + ilst.header, ilst.end, 1000);
  const collected = new Map<string, IlstEntry[]>();
  for (const item of items) {
    if (item.type === 'covr') {
      await readCover(ctx, item);
      continue;
    }
    if (item.type === '----') {
      await readFreeform(ctx, item);
      continue;
    }
    if (collected.has(item.type)) continue;
    const size = item.end - item.start;
    if (size > MAX_BOX_BODY) {
      addWarning(state, `The "${item.type}" metadata item is too large to read, so it was skipped.`);
      continue;
    }
    collected.set(item.type, itemEntries(await r.read(item.start, size)));
  }
  // The long description is only a fallback for the short one, so it goes last.
  for (const [name, entries] of collected) {
    if (name !== 'ldes') applyIlstItem(state.tags, name, entries);
  }
  const long = collected.get('ldes');
  if (long) applyIlstItem(state.tags, 'ldes', long);
}

/** A free-form iTunes item: a "mean" (who owns the name), a "name" and a "data" box. Only the gapless note is used. */
async function readFreeform(ctx: Mp4Context, item: Box): Promise<void> {
  if (ctx.gapless || item.end - item.start > 4096) return;
  const bytes = await ctx.r.read(item.start, item.end - item.start);
  const parts = memBoxes(bytes, 8, bytes.length);
  const text = (type: string, skip: number): string => {
    const found = parts.find((box) => box.type === type);
    return found ? cleanText(utf8(bytes.subarray(found.bodyStart + skip, found.end))) : '';
  };
  if (text('name', 4) !== 'iTunSMPB') return;
  // " 00000000 00000840 0000026A 0000000000022556 ...": reserved, priming, padding, then the valid sample count, all in hex.
  const fields = text('data', 8).split(/\s+/).map((field) => Number.parseInt(field, 16));
  const [, priming, padding, valid] = fields;
  if (priming !== undefined && padding !== undefined && valid !== undefined && [priming, padding, valid].every((n) => Number.isFinite(n) && n >= 0) && valid > 0) {
    ctx.gapless = { priming, padding, valid };
  }
}

async function readCover(ctx: Mp4Context, covr: Box): Promise<void> {
  const { r, state } = ctx;
  if (state.artwork) return;
  const datas = (await listBoxes(r, covr.start + covr.header, covr.end, 16)).filter((box) => box.type === 'data');
  for (const data of datas) {
    const length = data.end - (data.start + data.header) - 8;
    if (length <= 0) continue;
    if (length > MAX_ARTWORK_BYTES) {
      addWarning(state, 'The cover picture is too large to read, so it was skipped.');
      continue;
    }
    const bytes = await r.read(data.start + data.header + 8, length);
    const mime = sniffImageMime(bytes);
    if (bytes.length > 0 && mime) {
      state.artwork = makeArtwork(mime, bytes);
      return;
    }
    if (bytes.length > 0) addWarning(state, 'The cover picture is in a format that is not recognised.');
  }
}

/** Nero chapters: version, flags, 4 reserved bytes, a count, then 100 nanosecond start times with 1 byte title lengths. */
async function parseChpl(r: Reader, box: Box): Promise<Chapter[]> {
  const b = await bodyOf(r, box);
  const tryParse = (reserved: number): Chapter[] | null => {
    let pos = 4 + reserved;
    const count = b[pos] ?? 0;
    pos += 1;
    const out: Chapter[] = [];
    for (let i = 0; i < count; i += 1) {
      if (pos + 9 > b.length) return null;
      const start = u64be(b, pos);
      const length = b[pos + 8] ?? 0;
      pos += 9;
      if (pos + length > b.length) return null;
      out.push({ startMs: Math.round(start / 10000), title: cleanText(utf8(b.subarray(pos, pos + length))) });
      pos += length;
    }
    // A parse that leaves bytes over used the wrong layout, so the other layout gets its turn.
    return b.length - pos <= 3 ? out : null;
  };
  return tryParse(4) ?? tryParse(0) ?? [];
}

async function parseTrak(ctx: Mp4Context, trak: Box): Promise<TrackInfo | null> {
  const { r } = ctx;
  const t: TrackInfo = { id: 0, enabled: true, handler: '', timescale: 0, duration: 0, width: 0, height: 0, chapTargets: [], entry: null, stbl: {}, sampleCount: 0, dataBytes: null };
  const children = await listBoxes(r, trak.start + trak.header, trak.end);

  const tkhd = childOf(children, 'tkhd');
  if (tkhd) {
    const b = await bodyOf(r, tkhd, 96);
    t.enabled = (u32be(b, 0) & 1) !== 0;
    if ((b[0] ?? 0) === 1) {
      t.id = u32be(b, 20);
      t.width = u32be(b, 88) >>> 16;
      t.height = u32be(b, 92) >>> 16;
    } else {
      t.id = u32be(b, 12);
      t.width = u32be(b, 76) >>> 16;
      t.height = u32be(b, 80) >>> 16;
    }
  }

  const tref = childOf(children, 'tref');
  if (tref) {
    const refs = await listBoxes(r, tref.start + tref.header, tref.end);
    const chap = childOf(refs, 'chap');
    if (chap) {
      const b = await bodyOf(r, chap, 1024);
      for (let i = 0; i + 4 <= b.length; i += 4) t.chapTargets.push(u32be(b, i));
    }
  }

  const mdia = childOf(children, 'mdia');
  if (!mdia) return t;
  const mdiaChildren = await listBoxes(r, mdia.start + mdia.header, mdia.end);
  const mdhd = childOf(mdiaChildren, 'mdhd');
  if (mdhd) {
    const b = await bodyOf(r, mdhd, 40);
    if ((b[0] ?? 0) === 1) {
      t.timescale = u32be(b, 20);
      const d = u64be(b, 24);
      t.duration = d < 2 ** 53 ? d : 0;
    } else {
      t.timescale = u32be(b, 12);
      const d = u32be(b, 16);
      t.duration = d === 0xffffffff ? 0 : d;
    }
  }
  const hdlr = childOf(mdiaChildren, 'hdlr');
  if (hdlr) t.handler = fourcc(await bodyOf(r, hdlr, 16), 8);

  const minf = childOf(mdiaChildren, 'minf');
  if (!minf) return t;
  const stblBox = childOf(await listBoxes(r, minf.start + minf.header, minf.end), 'stbl');
  if (!stblBox) return t;
  const stbl = await listBoxes(r, stblBox.start + stblBox.header, stblBox.end);
  const stsd = childOf(stbl, 'stsd');
  if (stsd) {
    const b = await bodyOf(r, stsd, 65536 + 16);
    if (u32be(b, 4) > 0) {
      const size = u32be(b, 8);
      if (size >= 8) t.entry = b.subarray(8, 8 + Math.min(size, b.length - 8));
    }
  }
  t.stbl = { stts: childOf(stbl, 'stts'), stsc: childOf(stbl, 'stsc'), stsz: childOf(stbl, 'stsz'), stco: childOf(stbl, 'stco'), co64: childOf(stbl, 'co64') };
  if (t.stbl.stsz) {
    const sizes = await totalSampleBytes(r, t.stbl.stsz);
    t.sampleCount = sizes.count;
    t.dataBytes = sizes.bytes;
  }
  return t;
}

/** The sample count and total byte size from a stsz box. The total is null when the table is too big to total. */
async function totalSampleBytes(r: Reader, stsz: Box): Promise<{ count: number; bytes: number | null }> {
  const bodyStart = stsz.start + stsz.header;
  const head = await r.read(bodyStart, 12);
  const fixed = u32be(head, 4);
  const count = u32be(head, 8);
  if (fixed !== 0) return { count, bytes: fixed * count };
  const tableBytes = Math.min(count * 4, Math.max(0, stsz.end - bodyStart - 12));
  if (count === 0 || tableBytes < count * 4 || tableBytes > MAX_STSZ_BYTES) return { count, bytes: null };
  let total = 0;
  const CHUNK = 1024 * 1024;
  for (let at = 0; at < tableBytes; at += CHUNK) {
    const piece = await r.read(bodyStart + 12 + at, Math.min(CHUNK, tableBytes - at));
    for (let i = 0; i + 4 <= piece.length; i += 4) total += u32be(piece, i);
  }
  return { count, bytes: total };
}

// ---- sample descriptions ----

interface DescribedAudio {
  stream: AudioStream;
  avgBitrateKbps: number | null;
}

function nestedBoxes(entry: Uint8Array, start: number): MemBox[] {
  const boxes = memBoxes(entry, start, entry.length);
  // QuickTime wraps the codec boxes of older sound entries inside a "wave" box.
  for (const wave of boxes.filter((box) => box.type === 'wave')) boxes.push(...memBoxes(entry, wave.bodyStart, wave.end));
  return boxes;
}

/** Finds FairPlay or other protection on a sample entry. Returns the format the entry had before it was protected. */
function protectionOf(entry: Uint8Array, boxes: MemBox[], state: ProbeState): string | null {
  const type = fourcc(entry, 4);
  const sinf = boxes.find((box) => box.type === 'sinf');
  let original: string | null = null;
  if (sinf) {
    const frma = memBoxes(entry, sinf.bodyStart, sinf.end).find((box) => box.type === 'frma');
    if (frma) original = fourcc(entry, frma.bodyStart);
    state.protected = true;
  }
  if (type === 'drms' || type === 'drmi' || type === 'enca' || type === 'encv') state.protected = true;
  return original;
}

function describeAudio(entry: Uint8Array, track: TrackInfo, state: ProbeState): DescribedAudio {
  const type = fourcc(entry, 4);
  const soundVersion = u16be(entry, 16);
  let channels = u16be(entry, 24);
  let sampleSize = u16be(entry, 26);
  let rate = u16be(entry, 32);
  let childStart = 36;
  if (soundVersion === 1) {
    childStart = 52;
  } else if (soundVersion === 2) {
    childStart = 72;
    if (entry.length >= 48) rate = Math.round(new DataView(entry.buffer, entry.byteOffset + 40, 8).getFloat64(0));
    channels = u32be(entry, 48);
    sampleSize = u32be(entry, 56);
  }
  const boxes = nestedBoxes(entry, childStart);
  const original = protectionOf(entry, boxes, state);
  const esdsBox = boxes.find((box) => box.type === 'esds');
  const esds: EsdsInfo | null = esdsBox ? parseEsds(entry, esdsBox.bodyStart, esdsBox.end) : null;
  const format = original ?? (type === 'drms' && esds ? 'mp4a' : type);

  // The sample entry holds the rate as a 16 bit number, which cannot hold 96000, so a nonsense value
  // gives way to the media timescale, which for audio is the sample rate.
  if (!STANDARD_RATES.has(rate) && STANDARD_RATES.has(track.timescale)) rate = track.timescale;

  let codec: AudioCodec = 'unknown';
  let bitDepth: number | undefined;
  let avgBitrateKbps: number | null = null;

  switch (format) {
    case 'mp4a': {
      if (!esds) {
        addWarning(state, 'The audio track says it is AAC but has no codec details (esds), so its codec is unknown.');
        break;
      }
      if (esds.avgBitrate > 0) avgBitrateKbps = Math.round(esds.avgBitrate / 1000);
      if (esds.objectType === 0x40 || (esds.objectType >= 0x66 && esds.objectType <= 0x68)) {
        codec = 'aac';
        const asc = esds.asc ? parseAsc(esds.asc) : null;
        if (asc) {
          const implicitSbr = !asc.sbr && asc.objectType === 2 && asc.sampleRateHz > 0 && rate === asc.sampleRateHz * 2;
          if (asc.sbr || asc.ps || implicitSbr) codec = 'he-aac';
          if (asc.sbr && asc.extSampleRateHz > 0) rate = asc.extSampleRateHz;
          if (rate === 0) rate = asc.sampleRateHz;
          // The channel count in an MP4 sample entry is a placeholder (the standard says to write 2), so the
          // configuration inside the stream is the one to believe. Configuration 0 means "described elsewhere".
          const configured = asc.channelConfig === 7 ? 8 : asc.channelConfig >= 1 && asc.channelConfig <= 6 ? asc.channelConfig : 0;
          if (configured > 0) channels = configured;
          if (asc.ps) channels = 2; // parametric stereo turns a mono core into two channels
        }
      } else if (esds.objectType === 0x69 || esds.objectType === 0x6b) {
        codec = 'mp3';
      } else if (esds.objectType === 0xa5) {
        codec = 'ac3';
      } else if (esds.objectType === 0xa6) {
        codec = 'eac3';
      } else if (esds.objectType >= 0xa9 && esds.objectType <= 0xab) {
        codec = 'dts';
      }
      break;
    }
    case 'alac': {
      codec = 'alac';
      // The sample entry holds a nested "alac" box with the real settings.
      const cookie = boxes.filter((box) => box.type === 'alac').pop();
      if (cookie) {
        const config = parseAlacCookie(entry, cookie.bodyStart);
        if (config.bitDepth > 0) bitDepth = config.bitDepth;
        if (config.channels > 0) channels = config.channels;
        if (config.sampleRateHz > 0) rate = config.sampleRateHz;
        if (config.avgBitrate > 0) avgBitrateKbps = Math.round(config.avgBitrate / 1000);
      }
      break;
    }
    case '.mp3':
    case 'mp3 ':
      codec = 'mp3';
      break;
    case 'ac-3':
      codec = 'ac3';
      break;
    case 'ec-3':
      codec = 'eac3';
      break;
    case 'Opus':
      codec = 'opus';
      break;
    case 'fLaC':
      codec = 'flac';
      break;
    case 'dtsc':
    case 'dtsh':
    case 'dtsl':
    case 'dtse':
      codec = 'dts';
      break;
    case 'sowt':
    case 'twos':
    case 'raw ':
    case 'in24':
    case 'in32':
    case 'fl32':
    case 'fl64':
    case 'lpcm':
      codec = 'pcm';
      bitDepth = format === 'in24' ? 24 : format === 'in32' || format === 'fl32' ? 32 : format === 'fl64' ? 64 : format === 'raw ' ? 8 : sampleSize || 16;
      break;
    default:
      break;
  }

  const stream: AudioStream = { codec, sampleRateHz: rate, channels, bitrateKbps: null };
  if (bitDepth !== undefined) stream.bitDepth = bitDepth;
  return { stream, avgBitrateKbps };
}

interface DescribedVideo {
  stream: VideoStream;
  avgBitrateKbps: number | null;
}

const IMAGE_ENTRY_TYPES = new Set(['jpeg', 'png ', 'mjpa', 'mjpb', 'mjp2', 'tiff', 'gif ', 'bmp ', 'rle ', 'raw ']);

/** Null for a "video" track that is really a still picture, such as cover art stored as a track. */
function describeVideo(entry: Uint8Array, track: TrackInfo, state: ProbeState): DescribedVideo | null {
  const type = fourcc(entry, 4);
  const boxes = nestedBoxes(entry, 86);
  const original = protectionOf(entry, boxes, state);
  const format = original ?? type;
  if (IMAGE_ENTRY_TYPES.has(format)) return null;

  let width = u16be(entry, 32);
  let height = u16be(entry, 34);
  if (width === 0 || height === 0) {
    width = track.width;
    height = track.height;
  }

  let codec: VideoCodec = 'unknown';
  let profile: string | undefined;
  let level: string | undefined;
  switch (format) {
    case 'avc1':
    case 'avc2':
    case 'avc3':
    case 'avc4': {
      codec = 'h264';
      const avcC = boxes.find((box) => box.type === 'avcC');
      if (avcC) {
        const profileIdc = entry[avcC.bodyStart + 1] ?? 0;
        const compatibility = entry[avcC.bodyStart + 2] ?? 0;
        const levelIdc = entry[avcC.bodyStart + 3] ?? 0;
        if (profileIdc > 0) profile = avcProfileName(profileIdc);
        if (levelIdc > 0) level = avcLevelName(levelIdc, profileIdc, compatibility);
      }
      break;
    }
    case 'hvc1':
    case 'hev1':
    case 'dvh1':
    case 'dvhe': {
      codec = 'hevc';
      const hvcC = boxes.find((box) => box.type === 'hvcC');
      if (hvcC) {
        const profileIdc = (entry[hvcC.bodyStart + 1] ?? 0) & 0x1f;
        const levelIdc = entry[hvcC.bodyStart + 12] ?? 0;
        if (profileIdc > 0) profile = hevcProfileName(profileIdc);
        if (levelIdc > 0) level = (levelIdc / 30).toFixed(1);
      }
      break;
    }
    case 'mp4v': {
      const esdsBox = boxes.find((box) => box.type === 'esds');
      const esds = esdsBox ? parseEsds(entry, esdsBox.bodyStart, esdsBox.end) : null;
      if (esds && (esds.objectType === 0x6c || esds.objectType === 0x6e)) return null; // a JPEG picture track
      if (esds && esds.objectType === 0x20) codec = 'mpeg4';
      else if (esds && esds.objectType >= 0x60 && esds.objectType <= 0x65) codec = 'mpeg2';
      break;
    }
    case 'vp08':
      codec = 'vp8';
      break;
    case 'vp09':
      codec = 'vp9';
      break;
    case 'av01':
      codec = 'av1';
      break;
    default:
      break;
  }

  let avgBitrateKbps: number | null = null;
  const btrt = boxes.find((box) => box.type === 'btrt');
  if (btrt && u32be(entry, btrt.bodyStart + 8) > 0) avgBitrateKbps = Math.round(u32be(entry, btrt.bodyStart + 8) / 1000);

  const stream: VideoStream = { codec, width, height, fps: null, bitrateKbps: null };
  if (profile) stream.profile = profile;
  if (level) stream.level = level;
  return { stream, avgBitrateKbps };
}

// ---- chapters in a QuickTime text track ----

async function readU32Table(r: Reader, box: Box, entryBytes: number, perEntryFields: number, limit: number): Promise<number[]> {
  const bodyStart = box.start + box.header;
  const head = await r.read(bodyStart, 8);
  const count = Math.min(u32be(head, 4), limit, Math.floor(Math.max(0, box.end - bodyStart - 8) / entryBytes));
  const b = await r.read(bodyStart + 8, count * entryBytes);
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) {
    for (let f = 0; f < perEntryFields; f += 1) {
      const at = i * entryBytes + f * (entryBytes / perEntryFields);
      out.push(entryBytes / perEntryFields === 8 ? u64be(b, at) : u32be(b, at));
    }
  }
  return out;
}

function chapterText(sample: Uint8Array): string {
  const length = Math.min(u16be(sample, 0), Math.max(0, sample.length - 2));
  const body = sample.subarray(2, 2 + length);
  if (body.length >= 2 && body[0] === 0xfe && body[1] === 0xff) return cleanText(utf16(body.subarray(2), true));
  if (body.length >= 2 && body[0] === 0xff && body[1] === 0xfe) return cleanText(utf16(body.subarray(2), false));
  return cleanText(utf8(body));
}

/** Chapter titles and start times from a text track, found through the "tref/chap" reference of another track. */
async function readChapterTrack(r: Reader, track: TrackInfo): Promise<Chapter[]> {
  const { stts, stsc, stsz, stco, co64 } = track.stbl;
  if (!stts || !stsc || !stsz || (!stco && !co64) || track.timescale <= 0) return [];

  const sizeHead = await r.read(stsz.start + stsz.header, 12);
  const fixed = u32be(sizeHead, 4);
  const sampleCount = Math.min(u32be(sizeHead, 8), MAX_CHAPTERS);
  let sizes: number[];
  if (fixed !== 0) sizes = Array.from({ length: sampleCount }, () => fixed);
  else sizes = (await readU32Table(r, { ...stsz, header: stsz.header + 4 }, 4, 1, sampleCount)).slice(0, sampleCount);
  if (sizes.length === 0) return [];

  const chunkOffsets = co64 ? await readU32Table(r, co64, 8, 1, MAX_CHAPTERS) : await readU32Table(r, stco as Box, 4, 1, MAX_CHAPTERS);
  const stscTable = await readU32Table(r, stsc, 12, 3, MAX_CHAPTERS); // first chunk, samples per chunk, description index
  const sttsTable = await readU32Table(r, stts, 8, 2, MAX_CHAPTERS); // count, delta

  // Where each sample sits: chunks hold runs of samples, and the stsc table says how many.
  const offsets: number[] = [];
  let sample = 0;
  for (let chunk = 1; chunk <= chunkOffsets.length && sample < sizes.length; chunk += 1) {
    let perChunk = 1;
    for (let i = 0; i + 2 < stscTable.length; i += 3) {
      if ((stscTable[i] as number) <= chunk) perChunk = stscTable[i + 1] as number;
    }
    let offset = chunkOffsets[chunk - 1] as number;
    for (let k = 0; k < perChunk && sample < sizes.length; k += 1) {
      offsets.push(offset);
      offset += sizes[sample] as number;
      sample += 1;
    }
  }

  // When each sample starts, from the time-to-sample table.
  const starts: number[] = [];
  let ticks = 0;
  for (let i = 0; i + 1 < sttsTable.length && starts.length < sizes.length; i += 2) {
    for (let k = 0; k < (sttsTable[i] as number) && starts.length < sizes.length; k += 1) {
      starts.push(ticks);
      ticks += sttsTable[i + 1] as number;
    }
  }

  const chapters: Chapter[] = [];
  const total = Math.min(offsets.length, starts.length);
  for (let i = 0; i < total; i += 1) {
    const bytes = await r.read(offsets[i] as number, sizes[i] as number);
    if (bytes.length < 2) continue;
    chapters.push({ startMs: ((starts[i] as number) * 1000) / track.timescale, title: chapterText(bytes) });
  }
  return chapters;
}

// ---- putting it together ----

function pickTrack(tracks: TrackInfo[], handler: string): TrackInfo[] {
  const same = tracks.filter((t) => t.handler === handler);
  return [...same.filter((t) => t.enabled), ...same.filter((t) => !t.enabled)];
}

async function finish(ctx: Mp4Context): Promise<void> {
  const { r, state, tracks } = ctx;
  const movieSeconds = ctx.movieTimescale > 0 && ctx.movieDuration > 0 ? ctx.movieDuration / ctx.movieTimescale : ctx.movieTimescale > 0 && ctx.fragmentDuration > 0 ? ctx.fragmentDuration / ctx.movieTimescale : 0;

  const trackSeconds = (t: TrackInfo): number => (t.timescale > 0 && t.duration > 0 ? t.duration / t.timescale : movieSeconds);
  const kbps = (bytes: number | null, seconds: number): number | null => (bytes !== null && bytes > 0 && seconds > 0 ? Math.round((bytes * 8) / seconds / 1000) : null);

  let longest = 0;

  for (const track of pickTrack(tracks, 'soun')) {
    if (!track.entry) continue;
    const described = describeAudio(track.entry, track, state);
    const seconds = trackSeconds(track);
    described.stream.bitrateKbps = kbps(track.dataBytes, seconds) ?? described.avgBitrateKbps;
    state.audio = described.stream;
    longest = Math.max(longest, seconds);
    break;
  }

  for (const track of pickTrack(tracks, 'vide')) {
    if (!track.entry) continue;
    // A video track with one sample is a still picture (cover art stored as a track), not video.
    if (track.sampleCount === 1) continue;
    const described = describeVideo(track.entry, track, state);
    if (!described) continue;
    const seconds = trackSeconds(track);
    described.stream.bitrateKbps = kbps(track.dataBytes, seconds) ?? described.avgBitrateKbps;
    if (track.sampleCount > 1 && seconds > 0) described.stream.fps = Math.round((track.sampleCount / seconds) * 1000) / 1000;
    state.video = described.stream;
    longest = Math.max(longest, seconds);
    break;
  }

  state.durationMs = (movieSeconds > 0 ? movieSeconds : longest) * 1000;
  if (state.durationMs === 0) state.durationMs = null;

  // iTunes and Apple's encoders write the movie length with the encoder's priming and padding included, and note the
  // true length in iTunSMPB. The note is used only when it fits the track it describes (so a stale note is ignored).
  const audioTrack = pickTrack(tracks, 'soun')[0];
  if (ctx.gapless && audioTrack && !state.video && audioTrack.timescale > 0 && audioTrack.duration > 0) {
    const { priming, padding, valid } = ctx.gapless;
    const total = audioTrack.duration;
    if (valid <= total + 2048 && valid + priming + padding + 2048 >= total) state.durationMs = (valid * 1000) / audioTrack.timescale;
  }

  // Chapters from a text track that another track points at, which is what Apple software writes.
  let trackChapters: Chapter[] = [];
  for (const source of tracks) {
    for (const targetId of source.chapTargets) {
      const target = tracks.find((t) => t.id === targetId && t !== source);
      if (!target) continue;
      trackChapters = await readChapterTrack(r, target);
      if (trackChapters.length > 0) break;
    }
    if (trackChapters.length > 0) break;
  }
  if (trackChapters.length > 0) {
    state.chapters = trackChapters;
    if (ctx.nero.length > 0 && ctx.nero.length !== trackChapters.length) {
      addWarning(state, 'The chapter track and the Nero chapter list disagree, so the chapter track was used.');
    }
  } else if (ctx.nero.length > 0) {
    state.chapters = ctx.nero;
  }

  if (!state.audio && !state.video) addWarning(state, 'No audio or video track was found in this file.');
}
