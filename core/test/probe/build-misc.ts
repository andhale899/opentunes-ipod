/** Builders for FLAC, WAV, AIFF, Ogg, Matroska, AVI and ASF files. */

import { bitPack } from './build-mp4';
import { be16, be24, be32, cat, le16, le32, le64, type Part, utf16le, utf8, zeros } from './helpers';

// ---- Vorbis comments and FLAC ----

/** A Vorbis comment block: the vendor, then KEY=value entries, each with a little-endian length. */
export function vorbisComment(entries: string[], vendor = 'fixture'): Uint8Array {
  return cat(le32(utf8(vendor).length), utf8(vendor), le32(entries.length), ...entries.map((entry) => cat(le32(utf8(entry).length), utf8(entry))));
}

export function flacStreamInfo(o: { rate: number; channels: number; bits: number; samples: number }): Uint8Array {
  return cat(
    be16(4096),
    be16(4096),
    be24(0),
    be24(0),
    bitPack([o.rate, 20], [o.channels - 1, 3], [o.bits - 1, 5], [o.samples, 36]),
    zeros(16),
  );
}

export function flacBlock(type: number, body: Uint8Array, last = false): Uint8Array {
  return cat([(last ? 0x80 : 0) | type], be24(body.length), body);
}

/** A PICTURE body, also what Ogg carries (base64 encoded) in METADATA_BLOCK_PICTURE. */
export function pictureBody(o: { type?: number; mime: string; description?: string; data: Uint8Array }): Uint8Array {
  return cat(be32(o.type ?? 3), be32(o.mime.length), o.mime, be32(utf8(o.description ?? '').length), utf8(o.description ?? ''), be32(500), be32(500), be32(24), be32(0), be32(o.data.length), o.data);
}

export interface FlacOptions {
  rate?: number;
  channels?: number;
  bits?: number;
  samples?: number;
  comments?: string[];
  pictures?: { type?: number; mime: string; data: Uint8Array }[];
  /** Blocks to put between STREAMINFO and the comments, such as padding. */
  extraBlocks?: Uint8Array[];
  /** Bytes standing in for the audio frames. */
  audioBytes?: number;
  id3?: Uint8Array;
  omitStreamInfo?: boolean;
}

export function flacFile(o: FlacOptions = {}): Uint8Array {
  const blocks: Uint8Array[] = [];
  if (!o.omitStreamInfo) blocks.push(flacBlock(0, flacStreamInfo({ rate: o.rate ?? 44100, channels: o.channels ?? 2, bits: o.bits ?? 16, samples: o.samples ?? 441000 })));
  blocks.push(...(o.extraBlocks ?? []));
  if (o.comments) blocks.push(flacBlock(4, vorbisComment(o.comments)));
  for (const picture of o.pictures ?? []) blocks.push(flacBlock(6, pictureBody(picture)));
  // Mark the last block.
  const last = blocks[blocks.length - 1];
  if (last) last[0] = (last[0] as number) | 0x80;
  return cat(o.id3 ?? [], 'fLaC', ...blocks, zeros(o.audioBytes ?? 1000));
}

// ---- WAV ----

export function riffChunk(id: string, body: Uint8Array): Uint8Array {
  return cat(id, le32(body.length), body, body.length % 2 === 1 ? [0] : []);
}

export function wavFmt(o: { tag?: number; channels: number; rate: number; bits: number; byteRate?: number; extensible?: { subTag: number; validBits: number } }): Uint8Array {
  const blockAlign = (o.channels * o.bits) / 8;
  const byteRate = o.byteRate ?? o.rate * blockAlign;
  const base = [...le16(o.extensible ? 0xfffe : (o.tag ?? 1)), ...le16(o.channels), ...le32(o.rate), ...le32(byteRate), ...le16(blockAlign), ...le16(o.bits)];
  if (!o.extensible) return riffChunk('fmt ', Uint8Array.from(base));
  return riffChunk('fmt ', cat(base, le16(22), le16(o.extensible.validBits), le32(3), le16(o.extensible.subTag), [0, 0, 0, 0, 0x10, 0, 0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71]));
}

export function listInfo(entries: Record<string, string>): Uint8Array {
  return riffChunk('LIST', cat('INFO', ...Object.entries(entries).map(([id, text]) => riffChunk(id, cat(utf8(text), [0])))));
}

export function wavFile(o: { chunks: Uint8Array[]; riff?: 'RIFF' | 'RF64' }): Uint8Array {
  const body = cat('WAVE', ...o.chunks);
  return cat(o.riff ?? 'RIFF', le32(body.length), body);
}

/** The usual two chunk WAV: `fmt ` then `data` with `dataBytes` bytes of silence. */
export function simpleWav(o: { channels?: number; rate?: number; bits?: number; dataBytes: number; before?: Uint8Array[]; after?: Uint8Array[]; tag?: number }): Uint8Array {
  return wavFile({
    chunks: [wavFmt({ channels: o.channels ?? 2, rate: o.rate ?? 44100, bits: o.bits ?? 16, tag: o.tag }), ...(o.before ?? []), riffChunk('data', zeros(o.dataBytes)), ...(o.after ?? [])],
  });
}

// ---- AIFF ----

/** A number as the 80 bit extended float AIFF stores sample rates in. */
export function extended80(value: number): Uint8Array {
  const exponent = Math.floor(Math.log2(value));
  const mantissa = BigInt(value * 2 ** (63 - exponent));
  const out = new Uint8Array(10);
  const biased = 16383 + exponent;
  out[0] = (biased >> 8) & 0x7f;
  out[1] = biased & 0xff;
  for (let i = 0; i < 8; i += 1) out[2 + i] = Number((mantissa >> BigInt(8 * (7 - i))) & 0xffn);
  return out;
}

export function aiffChunk(id: string, body: Uint8Array): Uint8Array {
  return cat(id, be32(body.length), body, body.length % 2 === 1 ? [0] : []);
}

export function aiffComm(o: { channels: number; frames: number; bits: number; rate: number; compression?: string }): Uint8Array {
  const base = cat(be16(o.channels), be32(o.frames), be16(o.bits), extended80(o.rate));
  if (!o.compression) return aiffChunk('COMM', base);
  const name = utf8('not compressed');
  return aiffChunk('COMM', cat(base, o.compression, [name.length], name, name.length % 2 === 0 ? [0] : []));
}

export function aiffFile(o: { chunks: Uint8Array[]; aifc?: boolean }): Uint8Array {
  const body = cat(o.aifc ? 'AIFC' : 'AIFF', ...o.chunks);
  return cat('FORM', be32(body.length), body);
}

export function ssnd(dataBytes: number): Uint8Array {
  return aiffChunk('SSND', cat(be32(0), be32(0), zeros(dataBytes)));
}

// ---- Ogg ----

const NO_GRANULE = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];

/** The checksum is left at zero: the probe does not check it. */
export function oggPage(o: { serial: number; seq: number; granule: number | null; flags: number; lacing: number[]; body: Uint8Array }): Uint8Array {
  return cat('OggS', [0, o.flags], o.granule === null ? NO_GRANULE : le64(o.granule), le32(o.serial), le32(o.seq), le32(0), [o.lacing.length], o.lacing, o.body);
}

function lacingFor(length: number): number[] {
  const out = new Array<number>(Math.floor(length / 255)).fill(255);
  out.push(length % 255);
  return out;
}

/** Lays one packet out over as many pages as it needs (255 segments each). The last page carries `granule`. */
export function pagesForPacket(o: { serial: number; seq: number; packet: Uint8Array; granule: number; firstFlags?: number; lastFlags?: number }): Uint8Array[] {
  const lacing = lacingFor(o.packet.length);
  const pages: Uint8Array[] = [];
  let at = 0;
  for (let from = 0; from < lacing.length; from += 255) {
    const slice = lacing.slice(from, from + 255);
    const size = slice.reduce((sum, n) => sum + n, 0);
    const isFirst = from === 0;
    const isLast = from + 255 >= lacing.length;
    pages.push(
      oggPage({
        serial: o.serial,
        seq: o.seq + pages.length,
        granule: isLast ? o.granule : null,
        flags: (isFirst ? (o.firstFlags ?? 0) : 1) | (isLast ? (o.lastFlags ?? 0) : 0),
        lacing: slice,
        body: o.packet.subarray(at, at + size),
      }),
    );
    at += size;
  }
  return pages;
}

export function vorbisIdPacket(o: { channels: number; rate: number; nominalBitrate?: number }): Uint8Array {
  return cat([1], 'vorbis', le32(0), [o.channels], le32(o.rate), le32(0), le32(o.nominalBitrate ?? 0), le32(0), [0xb8, 1]);
}

export const vorbisCommentPacket = (entries: string[]): Uint8Array => cat([3], 'vorbis', vorbisComment(entries), [1]);
export const vorbisSetupPacket = (): Uint8Array => cat([5], 'vorbis', zeros(40));

export function opusHeadPacket(o: { channels: number; preSkip: number }): Uint8Array {
  return cat('OpusHead', [1, o.channels], le16(o.preSkip), le32(44100), le16(0), [0]);
}
export const opusTagsPacket = (entries: string[]): Uint8Array => cat('OpusTags', vorbisComment(entries));

export interface OggFileOptions {
  serial?: number;
  head: Uint8Array;
  comments: Uint8Array;
  setup?: Uint8Array;
  /** The granule position of the last audio page. Null leaves out the audio pages. */
  lastGranule: number | null;
  audioPages?: number;
  /** Streams that come first and are not audio, to test finding the right one. */
  beforeStreams?: Uint8Array[];
}

export function oggFile(o: OggFileOptions): Uint8Array {
  const serial = o.serial ?? 1111;
  const pages: Uint8Array[] = [...(o.beforeStreams ?? [])];
  let seq = 0;
  pages.push(...pagesForPacket({ serial, seq, packet: o.head, granule: 0, firstFlags: 2 }));
  seq += 1;
  pages.push(...pagesForPacket({ serial, seq, packet: o.comments, granule: 0 }));
  seq = pages.length;
  if (o.setup) pages.push(...pagesForPacket({ serial, seq: 2, packet: o.setup, granule: 0 }));
  if (o.lastGranule !== null) {
    const count = o.audioPages ?? 3;
    for (let i = 0; i < count; i += 1) {
      const last = i === count - 1;
      const granule = last ? o.lastGranule : Math.floor((o.lastGranule * (i + 1)) / count);
      pages.push(oggPage({ serial, seq: 10 + i, granule, flags: last ? 4 : 0, lacing: [100], body: zeros(100) }));
    }
  }
  return cat(...pages);
}

/** The start of a stream we do not know, such as Theora video. */
export function theoraBeginPage(serial: number): Uint8Array {
  return oggPage({ serial, seq: 0, granule: 0, flags: 2, lacing: [20], body: cat([0x80], 'theora', zeros(13)) });
}

// ---- Matroska and WebM ----

export function ebmlId(id: number): number[] {
  const out: number[] = [];
  for (let n = id; n > 0; n = Math.floor(n / 256)) out.unshift(n % 256);
  return out;
}

export function ebmlSize(n: number): number[] {
  for (let length = 1; length <= 8; length += 1) {
    if (n < 2 ** (7 * length) - 1) {
      const out: number[] = [];
      let value = n;
      for (let i = 0; i < length; i += 1) {
        out.unshift(value % 256);
        value = Math.floor(value / 256);
      }
      out[0] = (out[0] as number) | (0x80 >> (length - 1));
      return out;
    }
  }
  throw new Error('fixture: size too large');
}

export function el(id: number, ...body: Part[]): Uint8Array {
  const content = cat(...body);
  return cat(ebmlId(id), ebmlSize(content.length), content);
}

export const elUint = (id: number, value: number): Uint8Array => {
  const bytes: number[] = [];
  for (let n = value; n > 0 || bytes.length === 0; n = Math.floor(n / 256)) bytes.unshift(n % 256);
  return el(id, bytes);
};
export const elStr = (id: number, text: string): Uint8Array => el(id, text);
export const elFloat = (id: number, value: number, width: 4 | 8 = 8): Uint8Array => {
  const view = new DataView(new ArrayBuffer(width));
  if (width === 8) view.setFloat64(0, value);
  else view.setFloat32(0, value);
  return el(id, new Uint8Array(view.buffer));
};

export const MKV = {
  EBML: 0x1a45dfa3,
  DocType: 0x4282,
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  Title: 0x7ba9,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
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
  Cluster: 0x1f43b675,
  Tags: 0x1254c367,
} as const;

export function mkvVideoTrack(o: { number?: number; codecId: string; width: number; height: number; defaultDurationNs?: number; codecPrivate?: Uint8Array }): Uint8Array {
  return el(
    MKV.TrackEntry,
    elUint(MKV.TrackNumber, o.number ?? 1),
    elUint(MKV.TrackType, 1),
    elStr(MKV.CodecID, o.codecId),
    o.codecPrivate ? el(MKV.CodecPrivate, o.codecPrivate) : new Uint8Array(0),
    o.defaultDurationNs ? elUint(MKV.DefaultDuration, o.defaultDurationNs) : new Uint8Array(0),
    el(MKV.Video, elUint(MKV.PixelWidth, o.width), elUint(MKV.PixelHeight, o.height)),
  );
}

export function mkvAudioTrack(o: { number?: number; codecId: string; rate: number; channels: number; bits?: number; codecPrivate?: Uint8Array }): Uint8Array {
  return el(
    MKV.TrackEntry,
    elUint(MKV.TrackNumber, o.number ?? 2),
    elUint(MKV.TrackType, 2),
    elStr(MKV.CodecID, o.codecId),
    o.codecPrivate ? el(MKV.CodecPrivate, o.codecPrivate) : new Uint8Array(0),
    el(MKV.Audio, elFloat(MKV.SamplingFrequency, o.rate), elUint(MKV.Channels, o.channels), o.bits ? elUint(MKV.BitDepth, o.bits) : new Uint8Array(0)),
  );
}

export function mkvFile(o: { docType?: string; durationTicks?: number; timecodeScale?: number; title?: string; tracks: Uint8Array[]; unknownSegmentSize?: boolean; clusterBytes?: number; tracksAfterCluster?: boolean }): Uint8Array {
  const info = el(
    MKV.Info,
    o.timecodeScale !== undefined ? elUint(MKV.TimecodeScale, o.timecodeScale) : new Uint8Array(0),
    o.durationTicks !== undefined ? elFloat(MKV.Duration, o.durationTicks) : new Uint8Array(0),
    o.title ? el(MKV.Title, utf8(o.title)) : new Uint8Array(0),
  );
  const tracks = el(MKV.Tracks, ...o.tracks);
  const cluster = el(MKV.Cluster, zeros(o.clusterBytes ?? 200));
  const inner = o.tracksAfterCluster ? cat(info, cluster, tracks) : cat(info, tracks, cluster);
  const header = el(MKV.EBML, elStr(MKV.DocType, o.docType ?? 'matroska'));
  const segment = o.unknownSegmentSize ? cat(ebmlId(MKV.Segment), [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], inner) : el(MKV.Segment, inner);
  return cat(header, segment);
}

// ---- AVI ----

export function riffList(type: string, ...chunks: Part[]): Uint8Array {
  const body = cat(type, ...chunks);
  return cat('LIST', le32(body.length), body);
}

export function aviMainHeader(o: { microsPerFrame: number; totalFrames: number; width: number; height: number }): Uint8Array {
  return riffChunk('avih', cat(le32(o.microsPerFrame), le32(0), le32(0), le32(0x10), le32(o.totalFrames), le32(0), le32(2), le32(0), le32(o.width), le32(o.height), zeros(16)));
}

export function aviStreamHeader(o: { type: 'vids' | 'auds'; handler: string; scale: number; rate: number; length: number }): Uint8Array {
  return riffChunk('strh', cat(o.type, o.handler, le32(0), le16(0), le16(0), le32(0), le32(o.scale), le32(o.rate), le32(0), le32(o.length), zeros(20)));
}

export function aviVideoFormat(o: { width: number; height: number; compression: string }): Uint8Array {
  return riffChunk('strf', cat(le32(40), le32(o.width), le32(o.height), le16(1), le16(24), o.compression, le32(0), zeros(16)));
}

export function aviAudioFormat(o: { tag: number; channels: number; rate: number; avgBytes: number; bits: number }): Uint8Array {
  return riffChunk('strf', cat(le16(o.tag), le16(o.channels), le32(o.rate), le32(o.avgBytes), le16(1), le16(o.bits), le16(0)));
}

export function aviFile(o: { main: Uint8Array; streams: Uint8Array[][]; moviBytes?: number }): Uint8Array {
  const hdrl = riffList('hdrl', o.main, ...o.streams.map((s) => riffList('strl', ...s)));
  const body = cat('AVI ', hdrl, riffList('movi', zeros(o.moviBytes ?? 100)));
  return cat('RIFF', le32(body.length), body);
}

// ---- ASF ----

/** A GUID written as text becomes the 16 bytes a file holds, where the first three groups are little endian. */
export function guidBytes(text: string): Uint8Array {
  const hex = text.replace(/-/g, '');
  const bytes = Array.from({ length: 16 }, (_, i) => Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16));
  return Uint8Array.from([bytes[3], bytes[2], bytes[1], bytes[0], bytes[5], bytes[4], bytes[7], bytes[6], ...bytes.slice(8)] as number[]);
}

export const GUID = {
  header: '75B22630-668E-11CF-A6D9-00AA0062CE6C',
  fileProperties: '8CABDCA1-A947-11CF-8EE4-00C00C205365',
  streamProperties: 'B7DC0791-A9B7-11CF-8EE6-00C00C205365',
  contentDescription: '75B22633-668E-11CF-A6D9-00AA0062CE6C',
  extendedContent: 'D2D0A440-E307-11D2-97F0-00A0C95EA850',
  audio: 'F8699E40-5B4D-11CF-A8FD-00805F5C442B',
  video: 'BC19EFC0-5B4D-11CF-A8FD-00805F5C442B',
  noErrorCorrection: '20FB5700-5B55-11CF-A8FD-00805F5C442B',
  data: '75B22636-668E-11CF-A6D9-00AA0062CE6C',
} as const;

export function asfObject(guid: string, body: Uint8Array): Uint8Array {
  return cat(guidBytes(guid), le64(24 + body.length), body);
}

export function asfFileProperties(o: { playDuration100ns: number; prerollMs: number }): Uint8Array {
  return asfObject(GUID.fileProperties, cat(zeros(16), le64(10000), le64(0), le64(100), le64(o.playDuration100ns), le64(o.playDuration100ns), le64(o.prerollMs), le32(2), le32(3200), le32(3200), le32(0)));
}

export function asfStream(typeGuid: string, typeData: Uint8Array): Uint8Array {
  return asfObject(GUID.streamProperties, cat(guidBytes(typeGuid), guidBytes(GUID.noErrorCorrection), le64(0), le32(typeData.length), le32(0), le16(1), le32(0), typeData));
}

export function asfAudioStream(o: { tag: number; channels: number; rate: number; avgBytes: number; bits: number }): Uint8Array {
  return asfStream(GUID.audio, cat(le16(o.tag), le16(o.channels), le32(o.rate), le32(o.avgBytes), le16(1), le16(o.bits), le16(0)));
}

export function asfVideoStream(o: { width: number; height: number; compression: string }): Uint8Array {
  return asfStream(GUID.video, cat(le32(o.width), le32(o.height), [0], le16(40), le32(40), le32(o.width), le32(o.height), le16(1), le16(24), o.compression, le32(0), zeros(16)));
}

export function asfContentDescription(o: { title?: string; author?: string; copyright?: string; description?: string; rating?: string }): Uint8Array {
  const fields = [o.title, o.author, o.copyright, o.description, o.rating].map((text) => (text ? cat(utf16le(text), [0, 0]) : new Uint8Array(0)));
  return asfObject(GUID.contentDescription, cat(...fields.map((f) => le16(f.length)), ...fields));
}

export function asfExtendedContent(entries: { name: string; type: 'string' | 'dword' | 'word'; value: string | number }[]): Uint8Array {
  const items = entries.map((entry) => {
    const name = cat(utf16le(entry.name), [0, 0]);
    const value = entry.type === 'string' ? cat(utf16le(String(entry.value)), [0, 0]) : entry.type === 'dword' ? Uint8Array.from(le32(Number(entry.value))) : Uint8Array.from(le16(Number(entry.value)));
    const typeCode = entry.type === 'string' ? 0 : entry.type === 'dword' ? 3 : 5;
    return cat(le16(name.length), name, le16(typeCode), le16(value.length), value);
  });
  return asfObject(GUID.extendedContent, cat(le16(entries.length), ...items));
}

export function asfFile(objects: Uint8Array[]): Uint8Array {
  const body = cat(...objects);
  const header = cat(guidBytes(GUID.header), le64(30 + body.length), le32(objects.length), [1, 2], body);
  return cat(header, asfObject(GUID.data, zeros(200)));
}
