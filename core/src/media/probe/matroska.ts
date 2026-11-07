import type { AudioCodec, VideoCodec } from '../types';
import { beInt } from './bytes';
import { avcLevelName, avcProfileName, parseAsc } from './mp4-codecs';
import type { Reader } from './reader';
import { addWarning, fillTag, type ProbeState } from './state';
import { cleanText, utf8 } from './text';

/**
 * Matroska and WebM: just enough of the EBML structure to name the codecs, give sizes and a length.
 * Tags are not read, except the segment title. The big cluster elements are jumped over, not read.
 */

const ID = {
  EBML: 0x1a45dfa3,
  DocType: 0x4282,
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  Title: 0x7ba9,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackType: 0x83,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  DefaultDuration: 0x23e383,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  Audio: 0xe1,
  SamplingFrequency: 0xb5,
  Channels: 0x9f,
  BitDepth: 0x6264,
} as const;

interface Element {
  id: number;
  dataStart: number;
  /** The size the element states. Null when it says its size is unknown (live streams). */
  size: number | null;
}

interface Span extends Element {
  dataEnd: number;
}

/** One EBML element header at `pos` in a byte array, or null. */
function elementAt(b: Uint8Array, pos: number, limit: number): Element | null {
  const first = b[pos];
  if (first === undefined || first === 0) return null;
  let idLength = 1;
  while (idLength <= 4 && (first & (0x80 >> (idLength - 1))) === 0) idLength += 1;
  if (idLength > 4) return null;
  let id = 0;
  for (let i = 0; i < idLength; i += 1) id = id * 256 + (b[pos + i] ?? 0);

  const sizeFirst = b[pos + idLength];
  if (sizeFirst === undefined || sizeFirst === 0) return null;
  let sizeLength = 1;
  while (sizeLength <= 8 && (sizeFirst & (0x80 >> (sizeLength - 1))) === 0) sizeLength += 1;
  if (sizeLength > 8) return null;
  let size = sizeFirst & (0xff >> sizeLength);
  let allOnes = size === 0xff >> sizeLength;
  for (let i = 1; i < sizeLength; i += 1) {
    const byte = b[pos + idLength + i] ?? 0;
    size = size * 256 + byte;
    if (byte !== 0xff) allOnes = false;
  }
  const dataStart = pos + idLength + sizeLength;
  if (dataStart > limit) return null;
  return { id, dataStart, size: allOnes ? null : size };
}

/** The elements laid end to end in `b` between `start` and `end`. An unknown size runs to `end`. */
function children(b: Uint8Array, start: number, end: number): Span[] {
  const out: Span[] = [];
  let pos = start;
  while (pos < end && out.length < 1000) {
    const el = elementAt(b, pos, end);
    if (!el) break;
    const dataEnd = el.size === null ? end : Math.min(end, el.dataStart + el.size);
    out.push({ ...el, dataEnd });
    pos = dataEnd;
  }
  return out;
}

function uintOf(b: Uint8Array, el: Span): number {
  return beInt(b.subarray(el.dataStart, el.dataEnd));
}

function floatOf(b: Uint8Array, el: Span): number {
  const length = el.dataEnd - el.dataStart;
  if (el.dataStart + length > b.length) return 0;
  const view = new DataView(b.buffer, b.byteOffset + el.dataStart, length);
  if (length === 4) return view.getFloat32(0);
  if (length === 8) return view.getFloat64(0);
  return 0;
}

function textOf(b: Uint8Array, el: Span): string {
  return cleanText(utf8(b.subarray(el.dataStart, el.dataEnd)));
}

function videoCodec(codecId: string, priv: Uint8Array | null): VideoCodec {
  if (codecId === 'V_MPEG4/ISO/AVC') return 'h264';
  if (codecId === 'V_MPEGH/ISO/HEVC') return 'hevc';
  if (codecId === 'V_VP8') return 'vp8';
  if (codecId === 'V_VP9') return 'vp9';
  if (codecId === 'V_AV1') return 'av1';
  if (codecId.startsWith('V_MPEG4/ISO/')) return 'mpeg4'; // ASP and AP
  if (codecId.startsWith('V_MPEG2')) return 'mpeg2';
  if (codecId === 'V_MS/VFW/FOURCC' && priv && priv.length >= 20) {
    const fourcc = utf8(priv.subarray(16, 20)).toUpperCase();
    if (['XVID', 'DIVX', 'DX50', 'FMP4', 'MP4V'].includes(fourcc)) return 'mpeg4';
    if (['H264', 'X264', 'AVC1'].includes(fourcc)) return 'h264';
  }
  return 'unknown';
}

function audioCodec(codecId: string, priv: Uint8Array | null): AudioCodec {
  if (codecId.startsWith('A_AAC')) return /SBR|PS/.test(codecId) ? 'he-aac' : 'aac';
  if (codecId === 'A_MPEG/L3') return 'mp3';
  if (codecId === 'A_FLAC') return 'flac';
  if (codecId === 'A_VORBIS') return 'vorbis';
  if (codecId === 'A_OPUS') return 'opus';
  if (codecId === 'A_AC3' || codecId.startsWith('A_AC3/')) return 'ac3';
  if (codecId === 'A_EAC3') return 'eac3';
  if (codecId.startsWith('A_DTS')) return 'dts';
  if (codecId === 'A_ALAC') return 'alac';
  if (codecId.startsWith('A_PCM/')) return 'pcm';
  if (codecId === 'A_MS/ACM' && priv && priv.length >= 2) {
    const tag = (priv[0] ?? 0) | ((priv[1] ?? 0) << 8);
    if (tag === 0x55) return 'mp3';
    if (tag === 0x2000) return 'ac3';
    if (tag >= 0x160 && tag <= 0x163) return 'wma';
    if (tag === 0xff || tag === 0x1610) return 'aac';
    if (tag === 0x1) return 'pcm';
  }
  return 'unknown';
}

export async function probeMatroska(r: Reader, state: ProbeState): Promise<void> {
  state.container = 'mkv';
  const head = await r.read(0, 4096);
  const ebml = elementAt(head, 0, head.length);
  if (!ebml || ebml.id !== ID.EBML || ebml.size === null) {
    addWarning(state, 'The EBML header of this file is damaged, so its type is unknown.');
    return;
  }
  const ebmlEnd = ebml.dataStart + ebml.size;
  for (const el of children(head, ebml.dataStart, Math.min(ebmlEnd, head.length))) {
    if (el.id === ID.DocType) state.container = textOf(head, el) === 'webm' ? 'webm' : 'mkv';
  }

  // Find the segment, then walk its top level elements, reading Info and Tracks and skipping the rest.
  const segmentHeader = await r.read(ebmlEnd, 16);
  const segment = elementAt(segmentHeader, 0, segmentHeader.length);
  if (!segment || segment.id !== ID.Segment) {
    addWarning(state, 'The file has no Segment element after its header, so it may be cut short.');
    return;
  }
  const segmentStart = ebmlEnd + segment.dataStart;
  const segmentEnd = segment.size === null ? r.size : Math.min(r.size, segmentStart + segment.size);

  let timecodeScale = 1_000_000;
  let durationTicks = 0;
  let sawInfo = false;
  let sawTracks = false;
  let pos = segmentStart;
  for (let i = 0; i < 200 && pos < segmentEnd && !(sawInfo && sawTracks); i += 1) {
    const h = await r.read(pos, 16);
    const el = elementAt(h, 0, h.length);
    if (!el) break;
    const bodyStart = pos + el.dataStart;
    if (el.size === null) {
      addWarning(state, 'The file has an element of unknown size before its track list, so reading stopped.');
      break;
    }
    const bodyEnd = Math.min(r.size, bodyStart + el.size);
    if (el.id === ID.Info && bodyEnd - bodyStart <= 1024 * 1024) {
      sawInfo = true;
      const b = await r.read(bodyStart, bodyEnd - bodyStart);
      for (const c of children(b, 0, b.length)) {
        if (c.id === ID.TimecodeScale) timecodeScale = uintOf(b, c) || timecodeScale;
        else if (c.id === ID.Duration) durationTicks = floatOf(b, c);
        else if (c.id === ID.Title) fillTag(state.tags, 'title', textOf(b, c));
      }
    } else if (el.id === ID.Tracks && bodyEnd - bodyStart <= 4 * 1024 * 1024) {
      sawTracks = true;
      const b = await r.read(bodyStart, bodyEnd - bodyStart);
      readTracks(b, state);
    }
    pos = bodyEnd;
  }

  if (durationTicks > 0 && Number.isFinite(durationTicks)) state.durationMs = (durationTicks * timecodeScale) / 1_000_000;
  if (!sawTracks) addWarning(state, 'No track list was found near the start of the file, so the codecs are unknown.');
}

function readTracks(b: Uint8Array, state: ProbeState): void {
  for (const entry of children(b, 0, b.length)) {
    if (entry.id !== ID.TrackEntry) continue;
    let type = 0;
    let codecId = '';
    let priv: Uint8Array | null = null;
    let defaultDurationNs = 0;
    let width = 0;
    let height = 0;
    let rate = 8000;
    let channels = 1;
    let bits = 0;
    for (const c of children(b, entry.dataStart, entry.dataEnd)) {
      if (c.id === ID.TrackType) type = uintOf(b, c);
      else if (c.id === ID.CodecID) codecId = textOf(b, c);
      else if (c.id === ID.CodecPrivate) priv = b.subarray(c.dataStart, c.dataEnd);
      else if (c.id === ID.DefaultDuration) defaultDurationNs = uintOf(b, c);
      else if (c.id === ID.Video) {
        for (const v of children(b, c.dataStart, c.dataEnd)) {
          if (v.id === ID.PixelWidth) width = uintOf(b, v);
          else if (v.id === ID.PixelHeight) height = uintOf(b, v);
        }
      } else if (c.id === ID.Audio) {
        for (const a of children(b, c.dataStart, c.dataEnd)) {
          if (a.id === ID.SamplingFrequency) rate = Math.round(floatOf(b, a));
          else if (a.id === ID.Channels) channels = uintOf(b, a);
          else if (a.id === ID.BitDepth) bits = uintOf(b, a);
        }
      }
    }

    if (type === 1 && !state.video) {
      const codec = videoCodec(codecId, priv);
      const stream: NonNullable<ProbeState['video']> = {
        codec,
        width,
        height,
        fps: defaultDurationNs > 0 ? Math.round((1e9 / defaultDurationNs) * 1000) / 1000 : null,
        bitrateKbps: null,
      };
      if (codec === 'h264' && priv && priv.length >= 4 && priv[0] === 1) {
        stream.profile = avcProfileName(priv[1] ?? 0);
        stream.level = avcLevelName(priv[3] ?? 0, priv[1] ?? 0, priv[2] ?? 0);
      }
      state.video = stream;
    } else if (type === 2 && !state.audio) {
      let codec = audioCodec(codecId, priv);
      if (codec === 'aac' && priv) {
        const asc = parseAsc(priv);
        if (asc && (asc.sbr || asc.ps)) {
          codec = 'he-aac';
          if (asc.extSampleRateHz > 0) rate = asc.extSampleRateHz;
        }
      }
      const stream: NonNullable<ProbeState['audio']> = { codec, sampleRateHz: rate, channels, bitrateKbps: null };
      if (bits > 0 && (codec === 'pcm' || codec === 'flac' || codec === 'alac')) stream.bitDepth = bits;
      state.audio = stream;
    }
  }
}
