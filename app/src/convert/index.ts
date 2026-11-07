/**
 * The converter: ffmpeg.wasm in a web worker, turning files into what the iPod plays.
 *
 *   const { bytes, fileName } = await convertMedia({ name: 'song.flac', blob }, spec, { onProgress, signal });
 *   const book = await mergeAudiobook(parts, spec, { tags: { album: 'My Book' } });
 *
 * `spec` is the ConversionSpec the planner builds from the device registry. Audio becomes AAC-LC
 * or Apple Lossless, video becomes H.264 within the spec's limits. Merged audiobooks become one
 * .m4b with a chapter at the start of each part.
 *
 * Each call starts its own ffmpeg worker and ends it afterwards. Cancel with the AbortSignal.
 * Failures throw a ConvertError (plain message, then the last lines of the ffmpeg log). The
 * limits and how they were found are written up in limits.ts. Not yet run on an iPod.
 */

import type { ConversionSpec } from '@opentunes/core';
import { loadFfmpegEngine } from './ffmpegEngine';
import { runJob } from './job';
import { runConvert, runMerge } from './pipeline';
import type { ConvertInput, ConvertOptions, ConvertResult, MergePart } from './types';

export type { ConvertInput, ConvertOptions, ConvertResult, MergePart, ProgressCallback } from './types';
export { ConvertError, type ConvertFailure } from './errors';
export { MAX_OUTPUT_BYTES } from './limits';

/** Converts one file as the spec says. Rejects with an AbortError when cancelled, a ConvertError when ffmpeg fails. */
export function convertMedia(input: ConvertInput, spec: ConversionSpec, options: ConvertOptions = {}): Promise<ConvertResult> {
  return runJob(loadFfmpegEngine, { signal: options.signal, onProgress: options.onProgress }, (context) => runConvert(context, input, spec, options));
}

/** Joins audio files into one .m4b with a chapter at the start of each. All parts are re-encoded to one sample rate. */
export function mergeAudiobook(parts: MergePart[], spec: ConversionSpec, options: ConvertOptions = {}): Promise<ConvertResult> {
  return runJob(loadFfmpegEngine, { signal: options.signal, onProgress: options.onProgress }, (context) => runMerge(context, parts, spec, options));
}
