/** Builders for MP3 files: ID3 tags (v2.2, v2.3, v2.4, v1) and MPEG audio frames. */

import { be16, be24, be32, cat, utf16be, utf16le, utf8, zeros } from './helpers';

export type Id3Version = 2 | 3 | 4;
export type TextEncoding = 0 | 1 | 2 | 3;

/** Text as an ID3 field in the given encoding, with its terminator when asked. */
export function encodeText(text: string, encoding: TextEncoding, terminate = false): Uint8Array {
  switch (encoding) {
    case 0: {
      const out = Array.from(text, (ch) => ch.charCodeAt(0) & 0xff);
      return Uint8Array.from(terminate ? [...out, 0] : out);
    }
    case 1:
      return cat(utf16le(text, true), terminate ? [0, 0] : []);
    case 2:
      return cat(utf16be(text), terminate ? [0, 0] : []);
    default:
      return cat(utf8(text), terminate ? [0] : []);
  }
}

export function synchsafe(n: number): number[] {
  return [(n >>> 21) & 0x7f, (n >>> 14) & 0x7f, (n >>> 7) & 0x7f, n & 0x7f];
}

/** Insert 0x00 after 0xFF where a decoder could mistake the pair for an MPEG sync. */
export function addUnsynchronisation(bytes: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i += 1) {
    const value = bytes[i] as number;
    out.push(value);
    if (value === 0xff) {
      const next = bytes[i + 1];
      if (next === undefined || next === 0 || next >= 0xe0) out.push(0);
    }
  }
  return Uint8Array.from(out);
}

export function id3Frame(version: Id3Version, id: string, body: Uint8Array, flags = 0): Uint8Array {
  if (version === 2) return cat(id, be24(body.length), body);
  if (version === 3) return cat(id, be32(body.length), be16(flags), body);
  return cat(id, synchsafe(body.length), be16(flags), body);
}

/** A frame whose size field is written as a plain number even in a 2.4 tag (what some old writers did). */
export function id3FramePlainSize(id: string, body: Uint8Array): Uint8Array {
  return cat(id, be32(body.length), be16(0), body);
}

export function textFrame(version: Id3Version, id: string, text: string, encoding: TextEncoding = 3): Uint8Array {
  return id3Frame(version, id, cat([encoding], encodeText(text, encoding)));
}

export function commentFrame(version: Id3Version, id: 'COMM' | 'USLT' | 'COM' | 'ULT', text: string, description = '', encoding: TextEncoding = 3): Uint8Array {
  return id3Frame(version, id, cat([encoding], 'eng', encodeText(description, encoding, true), encodeText(text, encoding)));
}

export function pictureFrame(version: Id3Version, data: Uint8Array, opts: { mime?: string; type?: number; description?: string; encoding?: TextEncoding; flags?: number } = {}): Uint8Array {
  const encoding = opts.encoding ?? 0;
  const mime = opts.mime ?? 'image/jpeg';
  const type = opts.type ?? 3;
  const desc = encodeText(opts.description ?? '', encoding, true);
  if (version === 2) {
    const format = mime === 'image/png' ? 'PNG' : 'JPG';
    return id3Frame(2, 'PIC', cat([encoding], format, [type], desc, data));
  }
  return id3Frame(version, 'APIC', cat([encoding], mime, [0], [type], desc, data), opts.flags ?? 0);
}

export function chapterFrame(version: 3 | 4, elementId: string, startMs: number, endMs: number, title?: string): Uint8Array {
  const sub = title === undefined ? new Uint8Array(0) : textFrame(version, 'TIT2', title);
  return id3Frame(version, 'CHAP', cat(elementId, [0], be32(startMs), be32(endMs), be32(0xffffffff), be32(0xffffffff), sub));
}

export function tocFrame(version: 3 | 4, elementId: string, children: string[], topLevel = true, ordered = true): Uint8Array {
  const flags = (topLevel ? 2 : 0) | (ordered ? 1 : 0);
  return id3Frame(version, 'CTOC', cat(elementId, [0], [flags, children.length], ...children.map((c) => cat(c, [0]))));
}

export interface Id3TagOptions {
  version: Id3Version;
  frames: Uint8Array[];
  padding?: number;
  /** Apply unsynchronisation to the whole tag (the 2.2 and 2.3 way). */
  tagUnsync?: boolean;
  /** Add an extended header. */
  extendedHeader?: boolean;
  /** Add a footer (2.4 only). */
  footer?: boolean;
}

export function id3v2(opts: Id3TagOptions): Uint8Array {
  let flags = 0;
  let body = cat(...opts.frames);
  if (opts.extendedHeader && opts.version === 3) {
    body = cat(be32(6), be16(0), be32(0), body); // size 6: 2 flag bytes and 4 bytes of padding size
    flags |= 0x40;
  } else if (opts.extendedHeader && opts.version === 4) {
    body = cat(synchsafe(6), [1, 0], body); // size 6: the size, one flag-byte count, one flags byte
    flags |= 0x40;
  }
  if (opts.tagUnsync) {
    body = addUnsynchronisation(body);
    flags |= 0x80;
  }
  if (opts.padding) body = cat(body, zeros(opts.padding));
  if (opts.footer && opts.version === 4) flags |= 0x10;
  const header = cat('ID3', [opts.version, 0, flags], synchsafe(body.length));
  const footer = opts.footer && opts.version === 4 ? cat('3DI', [4, 0, flags], synchsafe(body.length)) : new Uint8Array(0);
  return cat(header, body, footer);
}

export function id3v1(f: { title?: string; artist?: string; album?: string; year?: string; comment?: string; track?: number; genre?: number }): Uint8Array {
  const field = (text: string | undefined, length: number): number[] => {
    const out = new Array<number>(length).fill(0);
    for (let i = 0; i < Math.min(length, (text ?? '').length); i += 1) out[i] = (text as string).charCodeAt(i) & 0xff;
    return out;
  };
  const comment = f.track !== undefined ? [...field(f.comment, 28), 0, f.track] : field(f.comment, 30);
  return Uint8Array.from([...Array.from('TAG', (c) => c.charCodeAt(0)), ...field(f.title, 30), ...field(f.artist, 30), ...field(f.album, 30), ...field(f.year, 4), ...comment, f.genre ?? 255]);
}

// ---- MPEG audio frames ----
// Written out here separately from the probe so a mistake in one does not hide a mistake in the other.

const BITRATES: Record<string, number[]> = {
  '1-1': [32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  '1-2': [32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '1-3': [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '2-1': [32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  '2-2': [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  '2-3': [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const RATES: Record<string, number[]> = { '1': [44100, 48000, 32000], '2': [22050, 24000, 16000], '2.5': [11025, 12000, 8000] };

export interface MpegFrameOptions {
  version?: 1 | 2 | 2.5;
  layer?: 1 | 2 | 3;
  bitrate: number;
  rate: number;
  mono?: boolean;
  padding?: boolean;
  /** Add the optional CRC protection bit (sets the bit to 0) and two CRC bytes. */
  crc?: boolean;
}

export function mpegFrameLength(o: MpegFrameOptions): number {
  const version = o.version ?? 1;
  const layer = o.layer ?? 3;
  const pad = o.padding ? 1 : 0;
  if (layer === 1) return (Math.floor((12 * o.bitrate * 1000) / o.rate) + pad) * 4;
  if (layer === 3 && version !== 1) return Math.floor((72 * o.bitrate * 1000) / o.rate) + pad;
  return Math.floor((144 * o.bitrate * 1000) / o.rate) + pad;
}

export function mpegFrame(o: MpegFrameOptions, payload?: Uint8Array): Uint8Array {
  const version = o.version ?? 1;
  const layer = o.layer ?? 3;
  const bitrateIndex = (BITRATES[`${version === 1 ? 1 : 2}-${layer}`] as number[]).indexOf(o.bitrate) + 1;
  const rateIndex = (RATES[String(version)] as number[]).indexOf(o.rate);
  if (bitrateIndex <= 0 || rateIndex < 0) throw new Error('fixture: no such MPEG bitrate or rate');
  const versionBits = version === 1 ? 3 : version === 2 ? 2 : 0;
  const layerBits = 4 - layer;
  const b1 = 0xe0 | (versionBits << 3) | (layerBits << 1) | (o.crc ? 0 : 1);
  const b2 = (bitrateIndex << 4) | (rateIndex << 2) | ((o.padding ? 1 : 0) << 1);
  const b3 = o.mono ? 0xc0 : 0x40; // joint stereo or single channel
  const frame = new Uint8Array(mpegFrameLength(o));
  frame.set([0xff, b1, b2, b3]);
  if (payload) frame.set(payload, 4);
  return frame;
}

/** `count` identical frames with no padding (so the file length is exact). */
export function mpegFrames(o: MpegFrameOptions, count: number): Uint8Array {
  const one = mpegFrame(o);
  const out = new Uint8Array(one.length * count);
  for (let i = 0; i < count; i += 1) out.set(one, i * one.length);
  return out;
}

export interface VbrFrameOptions extends MpegFrameOptions {
  kind: 'Xing' | 'Info' | 'VBRI';
  frames?: number;
  bytes?: number;
}

/** The first frame of a VBR or LAME file: an ordinary frame carrying a Xing, Info or VBRI header. */
export function vbrHeaderFrame(o: VbrFrameOptions): Uint8Array {
  const version = o.version ?? 1;
  const sideInfo = version === 1 ? (o.mono ? 17 : 32) : o.mono ? 9 : 17;
  const frame = mpegFrame(o);
  if (o.kind === 'VBRI') {
    const at = 36;
    frame.set(cat('VBRI', be16(1), be16(0), be16(0), be32(o.bytes ?? 0), be32(o.frames ?? 0), be16(1), be16(1), be16(1), be16(1)), at);
    return frame;
  }
  const at = 4 + sideInfo;
  let flags = 0;
  const fields: number[][] = [];
  if (o.frames !== undefined) {
    flags |= 1;
    fields.push(be32(o.frames));
  }
  if (o.bytes !== undefined) {
    flags |= 2;
    fields.push(be32(o.bytes));
  }
  frame.set(cat(o.kind, be32(flags), ...fields), at);
  // A LAME extension, so the reader meets the bytes real files carry after the counts.
  const lameAt = at + 8 + fields.length * 4;
  frame.set(cat('LAME3.99r', [0x00]), lameAt);
  return frame;
}

export function mp3File(parts: { id3?: Uint8Array; leading?: Uint8Array; frames: Uint8Array[]; id3v1?: Uint8Array }): Uint8Array {
  return cat(parts.leading ?? [], parts.id3 ?? [], ...parts.frames, parts.id3v1 ?? []);
}

/** 48 kHz, 128 kbps, MPEG 1 Layer III: 384 bytes per frame exactly, 24 ms each. */
export const CBR_48K_128: MpegFrameOptions = { bitrate: 128, rate: 48000 };

/** ADTS frames: `payload` bytes after a 7 byte header. */
export function adtsFrame(o: { sampleRateIndex: number; channelConfig: number; payload: number; profile?: number }): Uint8Array {
  const frameLength = 7 + o.payload;
  const profile = o.profile ?? 1; // audio object type minus one: 1 is AAC-LC
  const out = new Uint8Array(frameLength);
  out[0] = 0xff;
  out[1] = 0xf1; // MPEG-4, layer 0, no CRC
  out[2] = (profile << 6) | (o.sampleRateIndex << 2) | ((o.channelConfig >> 2) & 1);
  out[3] = ((o.channelConfig & 3) << 6) | ((frameLength >> 11) & 3);
  out[4] = (frameLength >> 3) & 0xff;
  out[5] = ((frameLength & 7) << 5) | 0x1f;
  out[6] = 0xfc;
  return out;
}

