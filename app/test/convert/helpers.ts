import type { ConversionSpec } from '@opentunes/core';
import type { SourceInfo } from '../../src/convert/source';

export function audioSpec(overrides: Partial<ConversionSpec> = {}): ConversionSpec {
  return {
    container: 'm4a',
    audio: { codec: 'aac', bitrateKbps: 256, sampleRateHz: 44100, channels: 2 },
    video: null,
    keepChapters: true,
    keepArtwork: true,
    keepTags: true,
    ...overrides,
  };
}

export function videoSpec(overrides: Partial<ConversionSpec> = {}): ConversionSpec {
  return {
    container: 'm4v',
    audio: { codec: 'aac', bitrateKbps: 128, sampleRateHz: 44100, channels: 2 },
    video: { codec: 'h264', profile: 'baseline', level: '3.0', maxWidth: 640, maxHeight: 480, maxFps: 30, maxBitrateKbps: 2500 },
    keepChapters: true,
    keepArtwork: true,
    keepTags: true,
    ...overrides,
  };
}

export function source(overrides: Partial<SourceInfo> = {}): SourceInfo {
  return {
    durationMs: 60_000,
    audio: { streamIndex: 0, codec: 'flac', channels: 2, sampleRateHz: 44100 },
    audioStreamCount: 1,
    video: null,
    picture: null,
    ...overrides,
  };
}

export function videoSource(width = 1920, height = 1080, overrides: Partial<SourceInfo> = {}): SourceInfo {
  return source({
    video: { streamIndex: 0, codec: 'h264', width, height, sarNum: 1, sarDen: 1, rotation: 0 },
    audio: { streamIndex: 1, codec: 'aac', channels: 2, sampleRateHz: 48000 },
    ...overrides,
  });
}

/** The value after a flag, or undefined. */
export function after(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

/** True when `sequence` appears in `args` as consecutive items. */
export function hasSequence(args: string[], ...sequence: string[]): boolean {
  for (let start = 0; start + sequence.length <= args.length; start += 1) {
    if (sequence.every((item, offset) => args[start + offset] === item)) return true;
  }
  return false;
}

/** A raw ADTS stream of `frames` frames, each 20 bytes long, with valid headers. */
export function adtsStream(frames: number, frameLength = 20): Uint8Array {
  const bytes = new Uint8Array(frames * frameLength);
  for (let frame = 0; frame < frames; frame += 1) {
    const at = frame * frameLength;
    bytes[at] = 0xff;
    bytes[at + 1] = 0xf1;
    bytes[at + 2] = 0x50;
    bytes[at + 3] = (frameLength >> 11) & 0x03;
    bytes[at + 4] = (frameLength >> 3) & 0xff;
    bytes[at + 5] = ((frameLength & 0x07) << 5) | 0x1f;
    bytes[at + 6] = 0xfc;
  }
  return bytes;
}

/** Enough of an MP4 file to pass the converter's "starts with ftyp" check. */
export function fakeMp4(size = 64): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set(new TextEncoder().encode('ftypM4A '), 4);
  return bytes;
}
