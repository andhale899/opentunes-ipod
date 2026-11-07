/**
 * ffmpeg arguments for converting to video (m4v): H.264 with AAC audio, sized and limited
 * to what the spec allows. Pure: no worker and no wasm, unit-tested in Node.
 *
 * Nothing here has been checked on an iPod. The settings follow the spec's profile, level,
 * size, frame rate and bitrate, and the output is checked in tests and in the browser test only
 * for what ffmpeg reports (profile, size, pixel format, audio codec).
 */

import type { ConversionSpec, VideoTarget } from '@opentunes/core';
import type { SourceInfo, SourceVideo } from './source';
import { clampAacKbps, type JobFiles } from './audio-args';
import { finishArgs, inputArgs, type JobExtras, type OutputPlan } from './common-args';

export interface Size {
  width: number;
  height: number;
}

/** Audio on video files: AAC-LC, at most this much, stereo, 48 kHz. */
export const VIDEO_AUDIO_MAX_KBPS = 256;
export const VIDEO_AUDIO_MAX_RATE_HZ = 48000;
export const VIDEO_AUDIO_DEFAULT_KBPS = 128;

/**
 * "veryfast" because the converter runs in WebAssembly on one thread. Slower presets compress a
 * little better and take several times longer.
 */
export const X264_PRESET = 'veryfast';
/** Quality target. The bitrate cap below holds the file to the spec whatever this gives. */
export const X264_CRF = 23;

const evenFloor = (value: number): number => Math.max(2, Math.floor(value / 2) * 2);

/**
 * The size to encode at: the source scaled down to fit inside `max` with the same shape, never
 * larger than the source, with both sides even (H.264 in 4:2:0 needs that). Odd sizes round
 * down, so the result never goes over the limit. The one exception is a side of 1 pixel,
 * which becomes 2 because 2 is the smallest legal size.
 */
export function fitSize(source: Size, max: Size): Size {
  if (!(source.width >= 1 && source.height >= 1)) throw new RangeError('The video size must be at least 1 by 1.');
  if (!(max.width >= 2 && max.height >= 2)) throw new RangeError('The largest allowed video size must be at least 2 by 2.');
  let width = source.width;
  let height = source.height;
  if (width > max.width || height > max.height) {
    if (width * max.height >= height * max.width) {
      // Width is the side that hits its limit first.
      height = Math.round((height * max.width) / width);
      width = max.width;
    } else {
      width = Math.round((width * max.height) / height);
      height = max.height;
    }
  }
  return { width: evenFloor(width), height: evenFloor(height) };
}

/**
 * The size the picture has when shown: pixel shape and any 90 or 270 degree turn applied.
 * ffmpeg turns the picture itself before the scale filter, so the filter sees this shape.
 */
export function displaySize(video: SourceVideo): Size {
  const sar = video.sarNum / video.sarDen;
  const turned = video.rotation === 90 || video.rotation === 270;
  return turned
    ? { width: Math.max(1, Math.round(video.height / sar)), height: video.width }
    : { width: Math.max(1, Math.round(video.width * sar)), height: video.height };
}

/** The `-vf` chain: scale to the target size, square pixels, 4:2:0. */
export function buildVideoFilter(target: VideoTarget, video: SourceVideo | null): string {
  const max = { width: target.maxWidth, height: target.maxHeight };
  if (video) {
    const size = fitSize(displaySize(video), max);
    return `scale=${size.width}:${size.height}:flags=lanczos,setsar=1,format=yuv420p`;
  }
  // The file's size is unknown: let ffmpeg work it out. Never larger than the source, even sides.
  return `scale=w='min(iw,${max.width})':h='min(ih,${max.height})':force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos,setsar=1,format=yuv420p`;
}

export interface VideoAudioParams {
  bitrateKbps: number;
  sampleRateHz: number;
  channels: 1 | 2;
}

/** Audio on a video file is always AAC-LC, at most 256 kbps, at most stereo, at most 48 kHz. */
export function resolveVideoAudio(spec: ConversionSpec, source: SourceInfo | null): VideoAudioParams {
  const target = spec.audio;
  const sourceChannels = source?.audio?.channels ?? 2;
  const channels: 1 | 2 = target?.channels ?? (sourceChannels === 1 ? 1 : 2);
  const wantedRate = target?.sampleRateHz ?? source?.audio?.sampleRateHz ?? VIDEO_AUDIO_MAX_RATE_HZ;
  const sampleRateHz = Math.min(wantedRate, VIDEO_AUDIO_MAX_RATE_HZ);
  const wantedKbps = Math.min(target?.bitrateKbps ?? VIDEO_AUDIO_DEFAULT_KBPS * (channels === 1 ? 0.5 : 1), VIDEO_AUDIO_MAX_KBPS);
  return { channels, sampleRateHz, bitrateKbps: clampAacKbps(wantedKbps, channels, sampleRateHz) };
}

/** The level text must look like "3.0" or "4.1". Anything else would reach ffmpeg as a confusing error. */
export function checkLevel(level: string): string {
  if (!/^\d(\.\d)?$/.test(level)) throw new RangeError(`The H.264 level "${level}" is not valid. Use a value such as 3.0.`);
  return level;
}

export interface VideoJobExtras extends JobExtras {
  /** Replaces the spec's bitrate cap. The converter uses this to keep a long video inside browser memory. */
  maxBitrateKbps?: number;
}

/**
 * Arguments for `convertMedia` on a video spec (container m4v).
 *
 *  - First video stream and first audio stream only. Subtitles and data streams are dropped.
 *  - A source with no audio gives a video with no audio, without failing.
 *  - H.264 with the spec's profile and level. Baseline has no B-frames, no CABAC.
 *  - Scaled down to fit, never up, even sides, square pixels, yuv420p.
 *  - Frame rate capped (`-fpsmax` only lowers it, it never raises a slower source).
 *  - Quality by CRF, with a peak bitrate cap and a buffer of two seconds at that cap.
 *  - `-movflags +faststart` so the index is at the front of the file.
 */
export function buildVideoArgs(spec: ConversionSpec, files: JobFiles, source: SourceInfo | null, extras: VideoJobExtras = {}): string[] {
  const target = spec.video;
  if (spec.container !== 'm4v' || !target) throw new Error('buildVideoArgs needs a video spec with the m4v container.');
  checkLevel(target.level);
  if (!(target.maxFps > 0)) throw new RangeError('The frame rate cap must be above 0.');
  const maxrate = Math.round(extras.maxBitrateKbps ?? target.maxBitrateKbps);
  if (!(maxrate > 0)) throw new RangeError('The video bitrate cap must be above 0.');

  const audio = resolveVideoAudio(spec, source);
  const hasAudio = source ? source.audio !== null : true;

  const codecArgs = [
    '-c:v:0', 'libx264',
    '-preset', X264_PRESET,
    '-profile:v', target.profile,
    '-level', checkLevel(target.level),
    ...(target.profile === 'baseline' ? ['-bf', '0'] : []),
    '-crf', String(X264_CRF),
    '-maxrate', `${maxrate}k`,
    '-bufsize', `${maxrate * 2}k`,
    // Per-stream, so a cover image that has to be re-encoded is not scaled with the video.
    '-filter:v:0', buildVideoFilter(target, source?.video ?? null),
    '-pix_fmt:v:0', 'yuv420p',
    '-fpsmax', String(target.maxFps),
    ...(hasAudio
      ? [
          '-c:a', 'aac',
          '-profile:a', 'aac_low',
          '-b:a', `${audio.bitrateKbps}k`,
          '-ar', String(audio.sampleRateHz),
          '-ac', String(audio.channels),
        ]
      : []),
  ];

  const plan: OutputPlan = {
    spec,
    maps: ['-map', '0:V:0', ...(hasAudio ? ['-map', '0:a:0?'] : [])],
    coverStreamIndex: 1,
    codecArgs,
    container: 'm4v',
    inputs: inputArgs(files.input, extras),
    source,
    extras,
  };
  return finishArgs(plan, files.output);
}
