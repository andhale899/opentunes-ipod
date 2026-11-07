/**
 * Checks done before ffmpeg starts: is the spec usable, and will the result fit in memory.
 * Pure, no worker and no wasm.
 */

import type { ConversionSpec } from '@opentunes/core';
import { estimateAacBytes, estimateAlacBytes, fitVideoBitrate, formatBytes, MAX_OUTPUT_BYTES } from './limits';
import { ConvertError } from './errors';
import { resolveAudioParams, type AudioParams } from './audio-args';
import { resolveVideoAudio } from './video-args';
import type { SourceInfo } from './source';

/** Throws a ConvertError for a spec the converter cannot follow. */
export function validateSpec(spec: ConversionSpec): void {
  if (spec.container === 'm4v') {
    if (!spec.video) throw new ConvertError('spec', 'The conversion asks for a video file (m4v) but gives no video settings.');
  } else if (spec.container === 'm4a' || spec.container === 'm4b') {
    if (spec.video) throw new ConvertError('spec', `The conversion asks for an audio file (${spec.container}) but gives video settings.`);
  } else {
    throw new ConvertError('spec', 'The conversion names a container the converter does not write. Use m4a, m4b or m4v.');
  }
}

/** Throws a ConvertError when the input lacks what the spec needs. */
export function checkSourceStreams(spec: ConversionSpec, source: SourceInfo, name: string): void {
  if (spec.container === 'm4v') {
    if (!source.video) throw new ConvertError('input', `"${name}" has no video to convert.`);
  } else if (!source.audio) {
    throw new ConvertError('input', `"${name}" has no audio to convert.`);
  }
}

export interface SizeCheck {
  /** When set, the video bitrate cap to use instead of the spec's, so the file stays inside memory. */
  maxBitrateKbps?: number;
  /** A plain sentence to put in the log and show as the step name, when something was changed. */
  note?: string;
}

function tooBigError(bytes: number): ConvertError {
  return new ConvertError(
    'limit',
    `This would make a file of about ${formatBytes(bytes)}. The converter holds the result in browser memory and stops at ${formatBytes(MAX_OUTPUT_BYTES)}. Use a lower bitrate, or split the file into shorter parts.`,
  );
}

/**
 * Stops a job that cannot fit in memory before any work is done, with a plain message.
 * Audio sizes are estimated from length and bitrate. Video is held to the spec's bitrate cap, so
 * its cap is lowered when needed (a guarantee, since the encoder cannot exceed the cap for long).
 * A source with an unknown length cannot be checked, and is let through.
 */
export function checkOutputSize(spec: ConversionSpec, source: SourceInfo): SizeCheck {
  const duration = source.durationMs;
  if (duration === null) return {};

  if (spec.container === 'm4v' && spec.video) {
    const audioKbps = source.audio === null ? 0 : resolveVideoAudio(spec, source).bitrateKbps;
    const fit = fitVideoBitrate(spec.video.maxBitrateKbps, audioKbps, duration);
    if (!fit.ok) {
      const hours = (duration / 3_600_000).toFixed(1);
      throw new ConvertError('limit', `This video is about ${hours} hours long. Even at a very low quality the result would not fit in the ${formatBytes(MAX_OUTPUT_BYTES)} the converter can hold in browser memory. Split it into shorter parts.`);
    }
    return fit.lowered
      ? { maxBitrateKbps: fit.maxrateKbps, note: `Video bitrate cap lowered from ${spec.video.maxBitrateKbps} to ${fit.maxrateKbps} kbps so a ${(duration / 3_600_000).toFixed(1)} hour video fits in browser memory.` }
      : {};
  }

  const params = resolveAudioParams(spec, source);
  const bytes = params.codec === 'aac' ? estimateAacBytes(duration, params.bitrateKbps ?? 0) : estimateAlacBytes(duration, params.sampleRateHz, params.channels);
  if (bytes > MAX_OUTPUT_BYTES) throw tooBigError(bytes);
  return {};
}

/** The same check for a merge: all parts end up in one file. */
export function checkMergeSize(totalMs: number | null, params: AudioParams): void {
  if (totalMs === null) return;
  const bytes = estimateAacBytes(totalMs, params.bitrateKbps ?? 0);
  if (bytes > MAX_OUTPUT_BYTES) throw tooBigError(bytes);
}
