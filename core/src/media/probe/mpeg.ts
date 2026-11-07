import { ascii, u32be } from './bytes';
import type { Reader } from './reader';
import { addWarning, type ProbeState } from './state';

/** MPEG audio (MP3 and its Layer I and II relatives): frame headers, Xing/Info/VBRI/LAME headers, duration. */

export interface MpegHeader {
  version: 1 | 2 | 2.5;
  layer: 1 | 2 | 3;
  bitrateKbps: number;
  sampleRateHz: number;
  padding: number;
  channels: 1 | 2;
  frameLength: number;
  samplesPerFrame: number;
  /** True when a 16 bit CRC follows the header. */
  crc: boolean;
}

// Bitrate tables in kbps, for index values 1 to 14 (0 is "free format" and 15 is invalid).
const V1_L1 = [32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448];
const V1_L2 = [32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384];
const V1_L3 = [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const V2_L1 = [32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256];
const V2_L23 = [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];

const SAMPLE_RATES: Record<string, number[]> = {
  '1': [44100, 48000, 32000],
  '2': [22050, 24000, 16000],
  '2.5': [11025, 12000, 8000],
};

export function parseMpegHeader(b: Uint8Array, o: number): MpegHeader | null {
  if (o < 0 || o + 4 > b.length) return null;
  const b1 = b[o + 1] ?? 0;
  if (b[o] !== 0xff || (b1 & 0xe0) !== 0xe0) return null;
  const versionBits = (b1 >> 3) & 3;
  const layerBits = (b1 >> 1) & 3;
  if (versionBits === 1 || layerBits === 0) return null;
  const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 2.5;
  const layer = (4 - layerBits) as 1 | 2 | 3;
  const b2 = b[o + 2] ?? 0;
  const bitrateIndex = b2 >> 4;
  const rateIndex = (b2 >> 2) & 3;
  if (bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;
  const table = version === 1 ? (layer === 1 ? V1_L1 : layer === 2 ? V1_L2 : V1_L3) : layer === 1 ? V2_L1 : V2_L23;
  const bitrateKbps = table[bitrateIndex - 1];
  const sampleRateHz = SAMPLE_RATES[String(version)]?.[rateIndex];
  if (bitrateKbps === undefined || sampleRateHz === undefined) return null;
  const padding = (b2 >> 1) & 1;
  const channels = (((b[o + 3] ?? 0) >> 6) & 3) === 3 ? 1 : 2;
  let frameLength: number;
  let samplesPerFrame: number;
  if (layer === 1) {
    frameLength = (Math.floor((12 * bitrateKbps * 1000) / sampleRateHz) + padding) * 4;
    samplesPerFrame = 384;
  } else if (layer === 2) {
    frameLength = Math.floor((144 * bitrateKbps * 1000) / sampleRateHz) + padding;
    samplesPerFrame = 1152;
  } else if (version === 1) {
    frameLength = Math.floor((144 * bitrateKbps * 1000) / sampleRateHz) + padding;
    samplesPerFrame = 1152;
  } else {
    frameLength = Math.floor((72 * bitrateKbps * 1000) / sampleRateHz) + padding;
    samplesPerFrame = 576;
  }
  if (frameLength < 4) return null;
  return { version, layer, bitrateKbps, sampleRateHz, padding, channels, frameLength, samplesPerFrame, crc: (b1 & 1) === 0 };
}

function sameStream(a: MpegHeader, b: MpegHeader): boolean {
  return a.version === b.version && a.layer === b.layer && a.sampleRateHz === b.sampleRateHz;
}

/**
 * The offset of the first real frame in `buf`, or -1. A candidate counts only when the next frame
 * (where this one says it ends) also looks right, so noise and tag padding are not mistaken for audio.
 * A candidate that runs past the end of the bytes is accepted only when those bytes are the end of the file.
 */
export function findFirstMpegFrame(buf: Uint8Array, bufferIsFileEnd: boolean): number {
  for (let i = 0; i + 4 <= buf.length; i += 1) {
    if (buf[i] !== 0xff || ((buf[i + 1] ?? 0) & 0xe0) !== 0xe0) continue;
    const h = parseMpegHeader(buf, i);
    if (!h) continue;
    const next = i + h.frameLength;
    if (next + 4 <= buf.length) {
      const nh = parseMpegHeader(buf, next);
      if (nh && sameStream(h, nh)) return i;
    } else if (bufferIsFileEnd && next >= buf.length - 4) {
      return i; // a short file whose single frame is the last thing in it
    }
  }
  return -1;
}

interface VbrInfo {
  kind: 'Xing' | 'Info' | 'VBRI';
  frames: number | null;
  bytes: number | null;
}

function readVbrInfo(buf: Uint8Array, frameStart: number, h: MpegHeader): VbrInfo | null {
  const sideInfo = h.version === 1 ? (h.channels === 1 ? 17 : 32) : h.channels === 1 ? 9 : 17;
  const base = 4 + sideInfo;
  for (const offset of new Set([base, base + 2, 36])) {
    const at = frameStart + offset;
    const tag = ascii(buf, at, 4);
    if (tag === 'Xing' || tag === 'Info') {
      const flags = u32be(buf, at + 4);
      let pos = at + 8;
      let frames: number | null = null;
      let bytes: number | null = null;
      if ((flags & 1) !== 0) {
        frames = u32be(buf, pos);
        pos += 4;
      }
      if ((flags & 2) !== 0) {
        bytes = u32be(buf, pos);
        pos += 4;
      }
      if ((flags & 4) !== 0) pos += 100;
      if ((flags & 8) !== 0) pos += 4;
      // A LAME extension (encoder name, replay gain, delay and padding) may follow here. The frame count
      // is all the length needs, so the extension is not read: delay and padding are not subtracted.
      return { kind: tag, frames, bytes };
    }
  }
  if (ascii(buf, frameStart + 36, 4) === 'VBRI') {
    // After "VBRI": version, delay and quality (2 bytes each), then the byte count and the frame count.
    const at = frameStart + 36;
    return { kind: 'VBRI', frames: u32be(buf, at + 14), bytes: u32be(buf, at + 10) };
  }
  return null;
}

const WINDOW_BYTES = 128 * 1024;

/**
 * Finds the first MPEG audio frame at or after `start` and fills in the audio stream and the duration.
 * `audioEnd` is where the audio stops (before an ID3v1 tag at the end). Returns false when no frame was found.
 */
export async function readMpegAudio(r: Reader, state: ProbeState, start: number, audioEnd: number): Promise<boolean> {
  const buf = await r.read(start, WINDOW_BYTES);
  const bufferIsFileEnd = start + buf.length >= r.size;
  const index = findFirstMpegFrame(buf, bufferIsFileEnd);
  if (index < 0) return false;
  const h = parseMpegHeader(buf, index);
  if (!h) return false;
  if (index > 0) addWarning(state, `The audio does not start where the tags end: ${index} bytes of other data come first.`);

  const frameOffset = start + index;
  const audioBytes = Math.max(0, audioEnd - frameOffset);
  const vbr = readVbrInfo(buf, index, h);

  let durationMs: number | null = null;
  let bitrateKbps: number | null = h.bitrateKbps;
  let variable = false;

  if (vbr && vbr.frames !== null && vbr.frames > 0) {
    durationMs = (vbr.frames * h.samplesPerFrame * 1000) / h.sampleRateHz;
    variable = vbr.kind !== 'Info';
    if (variable) {
      const bytes = vbr.bytes !== null && vbr.bytes > 0 ? vbr.bytes : audioBytes;
      bitrateKbps = durationMs > 0 && bytes > 0 ? Math.round((bytes * 8) / durationMs) : null;
    }
    // The header counts the whole stream. A file that is shorter than the header says was cut off, and
    // the header length would then claim audio that is not there. The length is scaled to what remains.
    if (vbr.bytes !== null && vbr.bytes > 0 && r.size < vbr.bytes * 0.98) {
      durationMs *= r.size / vbr.bytes;
      addWarning(state, 'The file is shorter than its VBR header says, so it was probably cut short. The length shown is an estimate of what is left.');
    }
  } else {
    // No frame count in the file, so the length comes from the size. Sample the frames that follow
    // to catch a variable bitrate file that carries no VBR header.
    let pos = index;
    let frames = 0;
    let bitrateSum = 0;
    const seen = new Set<number>();
    while (frames < 400 && pos + 4 <= buf.length) {
      const next = parseMpegHeader(buf, pos);
      if (!next || !sameStream(h, next)) break;
      frames += 1;
      bitrateSum += next.bitrateKbps;
      seen.add(next.bitrateKbps);
      pos += next.frameLength;
    }
    if (seen.size > 1 && frames > 0) {
      variable = true;
      bitrateKbps = Math.round(bitrateSum / frames);
      addWarning(state, 'This MP3 has a varying bitrate but no VBR header, so its length is an estimate.');
    }
    if (vbr && vbr.frames === null) addWarning(state, 'The VBR header has no frame count, so the length is estimated from the file size.');
    durationMs = bitrateKbps && audioBytes > 0 ? (audioBytes * 8) / bitrateKbps : null;
  }

  if (h.layer !== 3) {
    addWarning(state, `This is MPEG audio layer ${h.layer === 2 ? 'II (MP2)' : 'I (MP1)'}, not MP3.`);
  }
  state.audio = {
    codec: h.layer === 3 ? 'mp3' : 'unknown',
    sampleRateHz: h.sampleRateHz,
    channels: h.channels,
    bitrateKbps,
    variableBitrate: variable,
  };
  state.durationMs = durationMs;
  return true;
}
