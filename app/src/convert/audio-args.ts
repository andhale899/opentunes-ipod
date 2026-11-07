/**
 * ffmpeg arguments for converting to audio (m4a, m4b). Pure: no worker and no wasm, so the
 * whole thing is unit-tested in Node.
 *
 * Everything runs through the `ipod` muxer (`-f ipod`), which is what iTunes-style files need.
 * It writes `chpl` chapters plus a chapter text track, cover art as `covr`, and the `stik` atom
 * from the `media_type` tag.
 */

import type { AudioTarget, ConversionSpec } from '@opentunes/core';
import type { SourceInfo } from './source';
import { finishArgs, inputArgs, type JobExtras, type OutputPlan } from './common-args';

/** Sample rates the native AAC encoder accepts. */
export const AAC_SAMPLE_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000, 64000, 88200, 96000] as const;

/** Used when neither the spec nor the file says. No iPod plays above this, so it is the safe cap. */
export const DEFAULT_MAX_RATE_HZ = 48000;

export interface AudioParams {
  codec: 'aac' | 'alac';
  /** AAC only. */
  bitrateKbps: number | null;
  sampleRateHz: number;
  channels: 1 | 2;
}

export interface JobFiles {
  /** The input inside ffmpeg's virtual file system. */
  input: string;
  output: string;
}

/** The nearest AAC-capable rate at or below `rate`, or the lowest one if `rate` is below all of them. */
export function snapAacRate(rate: number): number {
  let best: number = AAC_SAMPLE_RATES[0];
  for (const candidate of AAC_SAMPLE_RATES) {
    if (candidate <= rate) best = candidate;
  }
  return best;
}

/** The highest bitrate the native AAC encoder allows (6144 bits per channel per 1024-sample frame), in kbps. */
export function maxAacKbps(channels: number, sampleRateHz: number): number {
  return Math.floor((6144 * channels * sampleRateHz) / 1024 / 1000);
}

export function defaultAacKbps(channels: number): number {
  return channels === 1 ? 96 : 192;
}

/** Keeps a wanted AAC bitrate inside what the encoder accepts for this rate and channel count. */
export function clampAacKbps(wanted: number, channels: number, sampleRateHz: number): number {
  return Math.round(Math.min(Math.max(wanted, 16), Math.max(16, maxAacKbps(channels, sampleRateHz))));
}

/** Channels to write: what the spec says, else the file's own up to stereo (5.1 and the like become stereo). */
export function pickChannels(target: AudioTarget | null | undefined, source: SourceInfo | null): 1 | 2 {
  if (target?.channels) return target.channels;
  return source?.audio && source.audio.channels === 1 ? 1 : 2;
}

/** The sample rate to write. A spec rate wins. Otherwise the file's own rate, but never above 48 kHz. */
export function pickSampleRate(target: AudioTarget | null | undefined, source: SourceInfo | null, codec: 'aac' | 'alac'): number {
  const wanted = target?.sampleRateHz ?? Math.min(source?.audio?.sampleRateHz ?? 44100, DEFAULT_MAX_RATE_HZ);
  return codec === 'aac' ? snapAacRate(wanted) : Math.max(8000, Math.round(wanted));
}

/** Works out the audio settings for an m4a or m4b job from the spec and the probed file. */
export function resolveAudioParams(spec: ConversionSpec, source: SourceInfo | null): AudioParams {
  const target = spec.audio;
  // A missing audio target means "no particular wish": write AAC with sensible defaults.
  const codec = target?.codec ?? 'aac';
  const channels = pickChannels(target, source);
  const sampleRateHz = pickSampleRate(target, source, codec);
  const bitrateKbps = codec === 'aac' ? clampAacKbps(target?.bitrateKbps ?? defaultAacKbps(channels), channels, sampleRateHz) : null;
  return { codec, bitrateKbps, sampleRateHz, channels };
}

/** The `-c:a` and related flags for these settings. */
export function audioCodecArgs(params: AudioParams, streamSelector = ''): string[] {
  const suffix = streamSelector;
  if (params.codec === 'alac') {
    // 16-bit is what the iPods in the registry play. Wider files are reduced to it.
    return [`-c:a${suffix}`, 'alac', `-sample_fmt${suffix}`, 's16p', `-ar${suffix}`, String(params.sampleRateHz), `-ac${suffix}`, String(params.channels)];
  }
  return [
    `-c:a${suffix}`, 'aac',
    `-profile:a${suffix}`, 'aac_low',
    `-b:a${suffix}`, `${params.bitrateKbps}k`,
    `-ar${suffix}`, String(params.sampleRateHz),
    `-ac${suffix}`, String(params.channels),
  ];
}

/**
 * Arguments for `convertMedia` on an audio spec (container m4a or m4b).
 * Only the first audio stream is used, and any video stream except a cover image is dropped.
 */
export function buildAudioArgs(spec: ConversionSpec, files: JobFiles, source: SourceInfo | null, extras: JobExtras = {}): string[] {
  if (spec.container === 'm4v' || spec.video) throw new Error('buildAudioArgs needs an audio spec. Use buildVideoArgs for video.');
  const params = resolveAudioParams(spec, source);
  const inputs = inputArgs(files.input, extras);
  const plan: OutputPlan = {
    spec,
    // Optional so that an input with no audio fails with ffmpeg's own words rather than a crash
    // in the argument builder. The converter checks the probe first and gives a plainer message.
    maps: ['-map', '0:a:0?'],
    coverStreamIndex: 0,
    codecArgs: audioCodecArgs(params),
    container: spec.container,
    inputs,
    source,
    extras,
  };
  return finishArgs(plan, files.output);
}
