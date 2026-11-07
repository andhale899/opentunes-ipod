/** Builders for MP4 and QuickTime files: boxes, tracks, sample entries, iTunes metadata, chapter tracks. */

import { be16, be32, be64, cat, type Part, utf16be, utf8, zeros } from './helpers';

export function box(type: string, ...children: Part[]): Uint8Array {
  const body = cat(...children);
  return cat(be32(body.length + 8), type, body);
}

/** A box with a 64 bit size field (the size 1 form). */
export function box64(type: string, ...children: Part[]): Uint8Array {
  const body = cat(...children);
  return cat(be32(1), type, be64(body.length + 16), body);
}

/** A box whose size is 0, meaning "to the end of the file". */
export function boxToEnd(type: string, ...children: Part[]): Uint8Array {
  return cat(be32(0), type, ...children);
}

export function fullBox(type: string, version: number, flags: number, ...children: Part[]): Uint8Array {
  return box(type, [version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff], ...children);
}

export function ftyp(major: string, compatible: string[] = []): Uint8Array {
  return box('ftyp', major, be32(0), ...compatible);
}

export function mvhd(o: { timescale: number; duration: number; version?: 0 | 1 }): Uint8Array {
  if (o.version === 1) return fullBox('mvhd', 1, 0, be64(0), be64(0), be32(o.timescale), be64(o.duration), zeros(80));
  return fullBox('mvhd', 0, 0, be32(0), be32(0), be32(o.timescale), be32(o.duration), zeros(80));
}

export function tkhd(o: { id: number; width?: number; height?: number; enabled?: boolean; version?: 0 | 1 }): Uint8Array {
  const flags = o.enabled === false ? 0 : 3;
  const dims = [...be32((o.width ?? 0) * 65536), ...be32((o.height ?? 0) * 65536)];
  if (o.version === 1) return fullBox('tkhd', 1, flags, be64(0), be64(0), be32(o.id), be32(0), be64(0), zeros(8), zeros(8 + 36), dims);
  return fullBox('tkhd', 0, flags, be32(0), be32(0), be32(o.id), be32(0), be32(0), zeros(8), zeros(8 + 36), dims);
}

export function mdhd(o: { timescale: number; duration: number; version?: 0 | 1 }): Uint8Array {
  if (o.version === 1) return fullBox('mdhd', 1, 0, be64(0), be64(0), be32(o.timescale), be64(o.duration), be16(0x55c4), be16(0));
  return fullBox('mdhd', 0, 0, be32(0), be32(0), be32(o.timescale), be32(o.duration), be16(0x55c4), be16(0));
}

export function hdlr(handler: string): Uint8Array {
  return fullBox('hdlr', 0, 0, be32(0), handler, be32(0), be32(0), be32(0), [0]);
}

// ---- esds and the AAC audio specific config ----

/** An MPEG-4 descriptor. `padded` writes the length in four bytes (0x80 0x80 0x80 n), which many encoders do. */
export function descriptor(tag: number, body: Part[], padded = false): Uint8Array {
  const content = cat(...body);
  const n = content.length;
  const length = padded ? [0x80 | ((n >> 21) & 0x7f), 0x80 | ((n >> 14) & 0x7f), 0x80 | ((n >> 7) & 0x7f), n & 0x7f] : n < 128 ? [n] : [0x80 | (n >> 7), n & 0x7f];
  return cat([tag], length, content);
}

export function esds(o: { objectType: number; asc?: Uint8Array; avgBitrate?: number; maxBitrate?: number; padded?: boolean }): Uint8Array {
  const decoderInfo = o.asc ? descriptor(5, [o.asc], o.padded) : new Uint8Array(0);
  const config = descriptor(4, [[o.objectType, 0x15], [0, 0, 0], be32(o.maxBitrate ?? 0), be32(o.avgBitrate ?? 0), decoderInfo], o.padded);
  return fullBox('esds', 0, 0, descriptor(3, [be16(1), [0], config, descriptor(6, [[2]], o.padded)], o.padded));
}

/** Packs fields of the given bit widths, most significant bit first, padding the last byte with zeros. */
export function bitPack(...fields: [value: number, width: number][]): Uint8Array {
  const bits: number[] = [];
  for (const [value, width] of fields) {
    for (let i = width - 1; i >= 0; i -= 1) bits.push(Math.floor(value / 2 ** i) % 2);
  }
  while (bits.length % 8 !== 0) bits.push(0);
  const out = new Uint8Array(bits.length / 8);
  bits.forEach((bit, i) => {
    out[i >> 3] = (out[i >> 3] as number) | (bit << (7 - (i & 7)));
  });
  return out;
}

/** The index of a rate in the AAC rate table (0 is 96000, 3 is 48000, 4 is 44100, 6 is 24000, 7 is 22050). */
export const AAC_RATE_INDEX = { 96000: 0, 64000: 2, 48000: 3, 44100: 4, 32000: 5, 24000: 6, 22050: 7, 16000: 8 } as const;

/** AAC-LC: object type 2, then the rate index, the channel configuration and the 3 bit core config. */
export function ascLc(rateIndex: number, channels: number): Uint8Array {
  return bitPack([2, 5], [rateIndex, 4], [channels, 4], [0, 3]);
}

/** HE-AAC announced the explicit way: object type 5 on the outside, with the output rate. */
export function ascHeExplicit(coreRateIndex: number, outRateIndex: number, channels: number, parametricStereo = false): Uint8Array {
  return bitPack([parametricStereo ? 29 : 5, 5], [coreRateIndex, 4], [channels, 4], [outRateIndex, 4], [2, 5], [0, 3]);
}

/** HE-AAC announced the backward compatible way: an LC config followed by a 0x2b7 extension. */
export function ascHeBackward(coreRateIndex: number, outRateIndex: number, channels: number, parametricStereo = false): Uint8Array {
  const sbr: [number, number][] = [[2, 5], [coreRateIndex, 4], [channels, 4], [0, 3], [0x2b7, 11], [5, 5], [1, 1], [outRateIndex, 4]];
  if (parametricStereo) sbr.push([0x548, 11], [1, 1]);
  return bitPack(...sbr);
}

// ---- sample entries ----

/** The fixed part of an audio sample entry, version 0. The rate is the 16.16 field, which cannot hold 65536 or more. */
export function audioEntry(type: string, o: { channels: number; sampleSize?: number; rate: number }, ...children: Part[]): Uint8Array {
  return box(type, zeros(6), be16(1), be16(0), be16(0), be32(0), be16(o.channels), be16(o.sampleSize ?? 16), be16(0), be16(0), be32((o.rate & 0xffff) * 65536), ...children);
}

export function visualEntry(type: string, o: { width: number; height: number }, ...children: Part[]): Uint8Array {
  return box(type, zeros(6), be16(1), be16(0), be16(0), zeros(12), be16(o.width), be16(o.height), be32(0x480000), be32(0x480000), be32(0), be16(1), zeros(32), be16(0x18), be16(0xffff), ...children);
}

export function avcC(profile: number, compatibility: number, level: number): Uint8Array {
  return box('avcC', [1, profile, compatibility, level, 0xff, 0xe1, 0, 4, 0x67, 0, 0, 0, 1, 0, 0]);
}

export function hvcC(profileIdc: number, levelIdc: number): Uint8Array {
  return box('hvcC', [1, profileIdc, 0, 0, 0, 0x60, 0, 0, 0, 0, 0, 0, levelIdc, 0xf0, 0, 0xfc, 0xfd, 0xf8, 0xf8, 0, 0, 0, 0, 0]);
}

export function btrt(avgBitrate: number): Uint8Array {
  return box('btrt', be32(0), be32(avgBitrate), be32(avgBitrate));
}

/**
 * The nested "alac" box with the magic cookie: version and flags, then Apple's ALACSpecificConfig
 * (frame length, compatible version, bit depth, three tuning bytes, channels, max run, max frame bytes,
 * average bitrate, sample rate).
 */
export function alacCookie(o: { bitDepth: number; channels: number; sampleRate: number; avgBitrate: number }): Uint8Array {
  return box('alac', be32(0), be32(4096), [0, o.bitDepth, 40, 10, 14, o.channels], be16(255), be32(0), be32(o.avgBitrate), be32(o.sampleRate));
}

/** FairPlay and other protection wrap the real format name in sinf/frma. */
export function sinf(originalFormat: string): Uint8Array {
  return box('sinf', box('frma', originalFormat), fullBox('schm', 0, 0, 'itun', be32(0)), box('schi', box('user', be32(0)), box('key ', be32(0))));
}

// ---- tracks ----

export interface TrackOptions {
  id: number;
  handler: 'soun' | 'vide' | 'text';
  timescale: number;
  /** Media duration in timescale units. */
  duration: number;
  entry: Uint8Array;
  sampleCount: number;
  /** One size for every sample (the stsz "fixed size" form). */
  sampleSize?: number;
  /** Or a size for each sample. */
  sampleSizes?: number[];
  width?: number;
  height?: number;
  enabled?: boolean;
  /** The id of the track this one gives chapters for. */
  chapters?: number;
  version?: 0 | 1;
  /** stts: [count, delta] pairs. Defaults to every sample lasting duration / sampleCount. */
  stts?: [number, number][];
  stsc?: [number, number, number][];
  chunkOffsets?: number[];
  co64?: boolean;
}

export function trak(o: TrackOptions): Uint8Array {
  const sizes = o.sampleSizes;
  let table = new Uint8Array(0);
  if (sizes) {
    // Written straight into a typed array, because a table can have a million entries.
    table = new Uint8Array(sizes.length * 4);
    const view = new DataView(table.buffer);
    sizes.forEach((size, i) => view.setUint32(i * 4, size));
  }
  const stsz = sizes ? fullBox('stsz', 0, 0, be32(0), be32(sizes.length), table) : fullBox('stsz', 0, 0, be32(o.sampleSize ?? 0), be32(o.sampleCount));
  const stts = o.stts ?? [[o.sampleCount, o.sampleCount > 0 ? Math.round(o.duration / o.sampleCount) : 0]];
  const stsc = o.stsc ?? [[1, 1, 1]];
  const offsets = o.chunkOffsets ?? [0];
  const stbl = box(
    'stbl',
    fullBox('stsd', 0, 0, be32(1), o.entry),
    fullBox('stts', 0, 0, be32(stts.length), ...stts.map(([c, d]) => [...be32(c), ...be32(d)])),
    fullBox('stsc', 0, 0, be32(stsc.length), ...stsc.map(([a, b, c]) => [...be32(a), ...be32(b), ...be32(c)])),
    stsz,
    o.co64 ? fullBox('co64', 0, 0, be32(offsets.length), ...offsets.map((n) => be64(n))) : fullBox('stco', 0, 0, be32(offsets.length), ...offsets.map((n) => be32(n))),
  );
  const mediaHeader = o.handler === 'soun' ? fullBox('smhd', 0, 0, be32(0)) : o.handler === 'vide' ? fullBox('vmhd', 0, 1, zeros(8)) : fullBox('gmhd', 0, 0);
  return box(
    'trak',
    tkhd({ id: o.id, width: o.width, height: o.height, enabled: o.enabled, version: o.version }),
    o.chapters !== undefined ? box('tref', box('chap', be32(o.chapters))) : new Uint8Array(0),
    box('mdia', mdhd({ timescale: o.timescale, duration: o.duration, version: o.version }), hdlr(o.handler), box('minf', mediaHeader, stbl)),
  );
}

/** An audio track of AAC, with a size per sample so the probe can total the bytes. */
export function aacTrack(o: { id?: number; rate: number; channels?: number; asc: Uint8Array; samples: number; sampleBytes: number; avgBitrate?: number; padded?: boolean; objectType?: number; entryRate?: number; timescale?: number }): Uint8Array {
  return trak({
    id: o.id ?? 1,
    handler: 'soun',
    timescale: o.timescale ?? o.rate,
    duration: o.samples * 1024,
    sampleCount: o.samples,
    sampleSize: o.sampleBytes,
    entry: audioEntry('mp4a', { channels: o.channels ?? 2, rate: o.entryRate ?? o.rate }, esds({ objectType: o.objectType ?? 0x40, asc: o.asc, avgBitrate: o.avgBitrate, padded: o.padded })),
  });
}

/** The QuickTime text sample: a 2 byte length and the text, optionally followed by an "encd" box. */
export function chapterSample(title: string, utf16 = false): Uint8Array {
  const text = utf16 ? cat([0xfe, 0xff], utf16be(title)) : utf8(title);
  return cat(be16(text.length), text, utf16 ? [] : cat(be32(12), 'encd', be32(0x100)));
}

/** A text track that holds chapter titles, with its samples placed at `dataOffset` in the file. */
export function chapterTrack(o: { id: number; timescale: number; titles: { title: string; ticks: number; utf16?: boolean }[]; dataOffset: number; onePerChunk?: boolean; entryType?: string; co64?: boolean }): { trak: Uint8Array; data: Uint8Array } {
  const samples = o.titles.map((t) => chapterSample(t.title, t.utf16));
  const sizes = samples.map((s) => s.length);
  const total = o.titles.reduce((sum, t) => sum + t.ticks, 0);
  const offsets: number[] = [];
  let at = o.dataOffset;
  for (const size of sizes) {
    offsets.push(at);
    at += size;
  }
  return {
    data: cat(...samples),
    trak: trak({
      id: o.id,
      handler: 'text',
      timescale: o.timescale,
      duration: total,
      sampleCount: samples.length,
      sampleSizes: sizes,
      entry: box(o.entryType ?? 'text', zeros(6), be16(1), zeros(40)),
      stts: o.titles.map((t) => [1, t.ticks] as [number, number]),
      stsc: o.onePerChunk ? [[1, 1, 1]] : [[1, samples.length, 1]],
      chunkOffsets: o.onePerChunk ? offsets : [o.dataOffset],
      co64: o.co64,
    }),
  };
}

// ---- iTunes metadata ----

export function data(flags: number, payload: Part): Uint8Array {
  return box('data', be32(flags), be32(0), payload);
}

export const textItem = (name: string, text: string): Uint8Array => box(name, data(1, utf8(text)));
export const intItem = (name: string, value: number, bytes = 1): Uint8Array => box(name, data(21, Array.from({ length: bytes }, (_, i) => Math.floor(value / 2 ** (8 * (bytes - 1 - i))) & 0xff)));
export const trknItem = (n: number, total: number): Uint8Array => box('trkn', data(0, [0, 0, ...be16(n), ...be16(total), 0, 0]));
export const diskItem = (n: number, total: number): Uint8Array => box('disk', data(0, [0, 0, ...be16(n), ...be16(total)]));
export const gnreItem = (index: number): Uint8Array => box('gnre', data(0, be16(index)));
export const covrItem = (...pictures: { bytes: Uint8Array; flags: 13 | 14 }[]): Uint8Array => box('covr', ...pictures.map((p) => data(p.flags, p.bytes)));
export const COPY = '©';

/** A free-form iTunes item: owner, name and text, as in the "iTunSMPB" gapless note. */
export const freeformItem = (name: string, text: string): Uint8Array => box('----', fullBox('mean', 0, 0, 'com.apple.iTunes'), fullBox('name', 0, 0, name), data(1, utf8(text)));

/** The iTunSMPB text: a leading space, reserved, priming, padding, valid samples, then zero fields. */
export const smpbText = (o: { priming: number; padding: number; valid: number }): string =>
  ` 00000000 ${o.priming.toString(16).toUpperCase().padStart(8, '0')} ${o.padding.toString(16).toUpperCase().padStart(8, '0')} ${o.valid.toString(16).toUpperCase().padStart(16, '0')} 00000000 00000000 00000000 00000000`;

export function ilstMeta(...items: Uint8Array[]): Uint8Array {
  return fullBox('meta', 0, 0, fullBox('hdlr', 0, 0, be32(0), 'mdir', 'appl', be32(0), be32(0), [0]), box('ilst', ...items));
}

/** A meta box in the older QuickTime form: no version and flags in front of the children. */
export function ilstMetaQuickTime(...items: Uint8Array[]): Uint8Array {
  return box('meta', fullBox('hdlr', 0, 0, be32(0), 'mdir', 'appl', be32(0), be32(0), [0]), box('ilst', ...items));
}

/** Nero chapters. */
export function chpl(chapters: { startMs: number; title: string }[], withReserved = true): Uint8Array {
  return box('chpl', [1, 0, 0, 0], withReserved ? be32(0) : [], [chapters.length], ...chapters.map((c) => cat(be64(c.startMs * 10000), [utf8(c.title).length], utf8(c.title))));
}

// ---- whole files ----

export interface Mp4Layout {
  ftyp: Uint8Array;
  /** Builds the moov box. `dataOffset` is where the mdat payload starts in the whole file. */
  moov: (dataOffset: number) => Uint8Array;
  mdatPayload: Uint8Array;
  moovFirst?: boolean;
  /** Write the mdat size as 64 bits. */
  mdat64?: boolean;
  /** Write the mdat size as 0 (to the end of the file). Only with the moov first. */
  mdatToEnd?: boolean;
  /** Boxes to put between ftyp and the rest, such as free or skip. */
  filler?: Uint8Array;
}

export function assemble(o: Mp4Layout): Uint8Array {
  const filler = o.filler ?? new Uint8Array(0);
  const mdat = (): Uint8Array => (o.mdatToEnd ? boxToEnd('mdat', o.mdatPayload) : o.mdat64 ? box64('mdat', o.mdatPayload) : box('mdat', o.mdatPayload));
  const mdatHeader = o.mdat64 ? 16 : 8;
  if (o.moovFirst) {
    const first = o.moov(0);
    const moov = o.moov(o.ftyp.length + filler.length + first.length + mdatHeader);
    return cat(o.ftyp, filler, moov, mdat());
  }
  const moov = o.moov(o.ftyp.length + filler.length + mdatHeader);
  return cat(o.ftyp, filler, mdat(), moov);
}

/** A plain audio file: ftyp, moov with one AAC track and optional metadata, and a small mdat. */
export function simpleAudioFile(o: { brand?: string; asc?: Uint8Array; rate?: number; samples?: number; sampleBytes?: number; items?: Uint8Array[]; extraMoov?: Part[]; moovFirst?: boolean; mdat64?: boolean }): Uint8Array {
  const rate = o.rate ?? 48000;
  const samples = o.samples ?? 1875; // 1875 x 1024 samples at 48000 Hz is exactly 40 seconds
  return assemble({
    ftyp: ftyp(o.brand ?? 'M4A ', ['M4A ', 'mp42', 'isom']),
    moovFirst: o.moovFirst,
    mdat64: o.mdat64,
    mdatPayload: zeros(256),
    moov: () =>
      box(
        'moov',
        mvhd({ timescale: 1000, duration: Math.round((samples * 1024 * 1000) / rate) }),
        aacTrack({ rate, asc: o.asc ?? ascLc(AAC_RATE_INDEX[rate as 48000] ?? 3, 2), samples, sampleBytes: o.sampleBytes ?? 640 }),
        ...(o.extraMoov ?? []),
        o.items ? box('udta', ilstMeta(...o.items)) : new Uint8Array(0),
      ),
  });
}

export interface MovieOptions {
  /** The ftyp major brand. Null leaves the ftyp box out, like an old QuickTime file. */
  brand?: string | null;
  compatible?: string[];
  /** Tracks, or a function that builds them once the position of the mdat payload is known. */
  tracks: Uint8Array[] | ((dataOffset: number) => Uint8Array[]);
  movieTimescale?: number;
  movieDuration?: number;
  mvhdVersion?: 0 | 1;
  /** Boxes placed in moov after the tracks, such as udta or meta. */
  moovExtras?: Part[];
  mdatPayload?: Uint8Array;
  moovFirst?: boolean;
  mdat64?: boolean;
  mdatToEnd?: boolean;
  filler?: Uint8Array;
}

export function movieFile(o: MovieOptions): Uint8Array {
  return assemble({
    ftyp: o.brand === null ? new Uint8Array(0) : ftyp(o.brand ?? 'M4A ', o.compatible ?? ['M4A ', 'mp42', 'isom']),
    moov: (dataOffset) =>
      box(
        'moov',
        mvhd({ timescale: o.movieTimescale ?? 1000, duration: o.movieDuration ?? 40000, version: o.mvhdVersion }),
        ...(typeof o.tracks === 'function' ? o.tracks(dataOffset) : o.tracks),
        ...(o.moovExtras ?? []),
      ),
    mdatPayload: o.mdatPayload ?? zeros(256),
    moovFirst: o.moovFirst,
    mdat64: o.mdat64,
    mdatToEnd: o.mdatToEnd,
    filler: o.filler,
  });
}

/** One audio track whose sample entry is built by the caller. 1875 samples of 1024 at 48000 Hz is 40 seconds. */
export function audioTrackWith(entry: Uint8Array, o: { id?: number; timescale?: number; samples?: number; sampleBytes?: number; version?: 0 | 1; chapters?: number } = {}): Uint8Array {
  const samples = o.samples ?? 1875;
  return trak({ id: o.id ?? 1, handler: 'soun', timescale: o.timescale ?? 48000, duration: samples * 1024, sampleCount: samples, sampleSize: o.sampleBytes ?? 640, entry, version: o.version, chapters: o.chapters });
}

/** One video track. 750 samples over 25 seconds at a timescale of 600 is 30 frames a second. */
export function videoTrackWith(entry: Uint8Array, o: { id?: number; timescale?: number; duration?: number; samples?: number; sampleBytes?: number; width?: number; height?: number; enabled?: boolean } = {}): Uint8Array {
  return trak({
    id: o.id ?? 2,
    handler: 'vide',
    timescale: o.timescale ?? 600,
    duration: o.duration ?? 15000,
    sampleCount: o.samples ?? 750,
    sampleSize: o.sampleBytes ?? 4000,
    entry,
    width: o.width,
    height: o.height,
    enabled: o.enabled,
  });
}
