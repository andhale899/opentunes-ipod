import { BitReader, fourcc, u32be, u64be } from './bytes';

/** Pieces inside an MP4 sample description: box lists in memory, esds, AAC config, avcC, hvcC, ALAC. */

export interface MemBox {
  type: string;
  start: number;
  bodyStart: number;
  end: number;
}

/** The boxes laid end to end in `b` between `start` and `end`. A box that runs past `end` is cut to it. */
export function memBoxes(b: Uint8Array, start: number, end: number): MemBox[] {
  const out: MemBox[] = [];
  const limit = Math.min(end, b.length);
  let pos = start;
  while (pos + 8 <= limit && out.length < 500) {
    let size = u32be(b, pos);
    const type = fourcc(b, pos + 4);
    let header = 8;
    if (size === 1) {
      size = u64be(b, pos + 8);
      header = 16;
    } else if (size === 0) {
      size = limit - pos;
    }
    if (size < header) break;
    const boxEnd = Math.min(limit, pos + size);
    out.push({ type, start: pos, bodyStart: pos + header, end: boxEnd });
    pos += size;
  }
  return out;
}

export const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

export interface EsdsInfo {
  objectType: number;
  maxBitrate: number;
  avgBitrate: number;
  asc: Uint8Array | null;
}

function readDescriptorLength(b: Uint8Array, pos: number): { length: number; next: number } {
  let length = 0;
  let next = pos;
  for (let i = 0; i < 4; i += 1) {
    const byte = b[next] ?? 0;
    next += 1;
    length = (length << 7) | (byte & 0x7f);
    if ((byte & 0x80) === 0) break;
  }
  return { length, next };
}

/** The esds box body starts with 4 bytes of version and flags, then the MPEG-4 descriptors. */
export function parseEsds(b: Uint8Array, bodyStart: number, end: number): EsdsInfo {
  const info: EsdsInfo = { objectType: 0, maxBitrate: 0, avgBitrate: 0, asc: null };
  const limit = Math.min(end, b.length);
  const walk = (from: number, to: number, depth: number): void => {
    let pos = from;
    while (pos + 2 <= to && depth < 6) {
      const tag = b[pos] ?? 0;
      const { length, next } = readDescriptorLength(b, pos + 1);
      const descriptorEnd = Math.min(to, next + length);
      if (tag === 0x03) {
        let at = next + 2; // the ES id
        const flags = b[at] ?? 0;
        at += 1;
        if ((flags & 0x80) !== 0) at += 2;
        if ((flags & 0x40) !== 0) at += 1 + (b[at] ?? 0);
        if ((flags & 0x20) !== 0) at += 2;
        walk(at, descriptorEnd, depth + 1);
      } else if (tag === 0x04) {
        info.objectType = b[next] ?? 0;
        info.maxBitrate = u32be(b, next + 5);
        info.avgBitrate = u32be(b, next + 9);
        walk(next + 13, descriptorEnd, depth + 1);
      } else if (tag === 0x05) {
        info.asc = b.slice(next, descriptorEnd);
      }
      if (descriptorEnd <= pos) break;
      pos = descriptorEnd;
    }
  };
  walk(bodyStart + 4, limit, 0);
  return info;
}

export interface AscInfo {
  objectType: number;
  sampleRateHz: number;
  channelConfig: number;
  /** Spectral band replication: the stream is HE-AAC. */
  sbr: boolean;
  /** Parametric stereo: HE-AAC version 2. */
  ps: boolean;
  /** The output rate when SBR is signalled, otherwise 0. */
  extSampleRateHz: number;
}

function readRate(br: BitReader): number {
  const index = br.read(4);
  return index === 15 ? br.read(24) : (AAC_RATES[index] ?? 0);
}

/**
 * The AudioSpecificConfig that esds carries. HE-AAC is announced two ways: an outer object type of 5
 * (or 29 with parametric stereo), or, for compatibility with older players, an extension after the
 * core configuration. Both are read. A stream that signals SBR only inside the audio data cannot be seen here.
 */
export function parseAsc(asc: Uint8Array): AscInfo | null {
  if (asc.length < 2) return null;
  const br = new BitReader(asc);
  let objectType = br.read(5);
  if (objectType === 31) objectType = 32 + br.read(6);
  const sampleRateHz = readRate(br);
  const channelConfig = br.read(4);
  let sbr = false;
  let ps = false;
  let extSampleRateHz = 0;

  if (objectType === 5 || objectType === 29) {
    sbr = true;
    ps = objectType === 29;
    extSampleRateHz = readRate(br);
    objectType = br.read(5);
    if (objectType === 31) objectType = 32 + br.read(6);
  } else if ([1, 2, 3, 4, 6, 7].includes(objectType) && channelConfig !== 0) {
    // GASpecificConfig, then the optional backward compatible extension.
    br.read(1); // frame length flag
    if (br.read(1) === 1) br.read(14); // core coder delay
    br.read(1); // extension flag
    if (objectType === 6) br.read(3);
    if (br.bitsLeft >= 16 && br.read(11) === 0x2b7) {
      const extensionType = br.read(5);
      if (extensionType === 5 && br.read(1) === 1) {
        sbr = true;
        extSampleRateHz = readRate(br);
        if (br.bitsLeft >= 12 && br.read(11) === 0x548) ps = br.read(1) === 1;
      }
    }
  }
  return { objectType, sampleRateHz, channelConfig, sbr, ps, extSampleRateHz };
}

/** H.264 profile names from the profile_idc byte. */
export function avcProfileName(profile: number): string {
  switch (profile) {
    case 66:
      return 'Baseline';
    case 77:
      return 'Main';
    case 88:
      return 'Extended';
    case 100:
      return 'High';
    case 110:
      return 'High 10';
    case 122:
      return 'High 4:2:2';
    case 244:
      return 'High 4:4:4 Predictive';
    case 44:
      return 'CAVLC 4:4:4 Intra';
    case 118:
      return 'Multiview High';
    case 128:
      return 'Stereo High';
    default:
      return `Profile ${profile}`;
  }
}

/** H.264 level_idc 31 is level "3.1". Level 1b is level_idc 9, or 11 with constraint_set3 on the low profiles. */
export function avcLevelName(level: number, profile: number, compatibility: number): string {
  if (level === 9) return '1b';
  if (level === 11 && (compatibility & 0x10) !== 0 && (profile === 66 || profile === 77 || profile === 88)) return '1b';
  return `${Math.floor(level / 10)}.${level % 10}`;
}

export function hevcProfileName(profileIdc: number): string {
  switch (profileIdc) {
    case 1:
      return 'Main';
    case 2:
      return 'Main 10';
    case 3:
      return 'Main Still Picture';
    case 4:
      return 'Range Extensions';
    default:
      return `Profile ${profileIdc}`;
  }
}

export interface AlacConfig {
  bitDepth: number;
  channels: number;
  avgBitrate: number;
  sampleRateHz: number;
}

/** The ALAC magic cookie: 4 bytes of version and flags, then the fixed configuration. */
export function parseAlacCookie(b: Uint8Array, bodyStart: number): AlacConfig {
  const c = bodyStart + 4;
  return { bitDepth: b[c + 5] ?? 0, channels: b[c + 9] ?? 0, avgBitrate: u32be(b, c + 16), sampleRateHz: u32be(b, c + 20) };
}
