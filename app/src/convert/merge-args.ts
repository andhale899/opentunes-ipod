/**
 * Merging several audio files into one .m4b with a chapter at the start of each. Pure: no worker
 * and no wasm, unit-tested in Node.
 *
 * How it works, and why:
 *  1. Each part is decoded and encoded to AAC on its own, at one common sample rate and channel
 *     count, and written as a raw ADTS stream (`part-000.aac`). ADTS has no timestamps, only
 *     frames of 1024 samples each.
 *  2. The frames in each part are counted. Part N starts at (frames before it x 1024) / rate,
 *     which is exact, so the chapter marks are exact and cannot drift.
 *  3. The parts are joined with ffmpeg's `concat:` protocol, which just appends the bytes, and
 *     written to the .m4b without re-encoding (`-c:a copy`).
 *
 * The other obvious route, the concat demuxer on finished .m4a files, was tried and rejected: it
 * leaves about 21 ms of timestamp error at every join, which adds up to seconds of drift in the
 * chapter marks of a book with many parts.
 */

import type { Chapter, ConversionSpec } from '@opentunes/core';
import type { SourceInfo } from './source';
import { audioCodecArgs, clampAacKbps, defaultAacKbps, DEFAULT_MAX_RATE_HZ, snapAacRate, type AudioParams } from './audio-args';
import { finishArgs, inputArgs, type JobExtras, type OutputPlan } from './common-args';
import { stripExtension } from './names';

/** Samples in one AAC frame. */
export const AAC_FRAME_SAMPLES = 1024;

export interface MergePartLike {
  name: string;
  title?: string;
}

/** The chapter title for a part: its `title`, else its file name without the extension. */
export function partTitle(part: MergePartLike): string {
  return part.title?.trim() || stripExtension(part.name);
}

/** `part-000.aac`, `part-001.aac`, and so on, in the virtual file system. */
export function partFileName(index: number): string {
  return `part-${String(index).padStart(3, '0')}.aac`;
}

/**
 * The one set of audio settings every part is encoded with: the spec's where it gives them,
 * otherwise stereo unless every part is mono, and the highest part rate up to 48 kHz.
 * Always AAC: an Apple Lossless stream cannot be joined this way, and audiobooks do not need it.
 */
export function chooseMergeParams(spec: ConversionSpec, sources: readonly SourceInfo[]): AudioParams {
  const target = spec.audio;
  const known = sources.map((source) => source.audio).filter((audio): audio is NonNullable<typeof audio> => audio !== null);
  const channels: 1 | 2 = target?.channels ?? (known.length > 0 && known.every((audio) => audio.channels === 1) ? 1 : 2);
  const highest = known.reduce((rate, audio) => Math.max(rate, audio.sampleRateHz), 0);
  const sampleRateHz = snapAacRate(target?.sampleRateHz ?? Math.min(highest || 44100, DEFAULT_MAX_RATE_HZ));
  const bitrateKbps = clampAacKbps(target?.bitrateKbps ?? defaultAacKbps(channels), channels, sampleRateHz);
  return { codec: 'aac', bitrateKbps, sampleRateHz, channels };
}

/** Arguments that turn one part into a raw AAC (ADTS) stream with the common settings. */
export function buildMergePartArgs(params: AudioParams, files: { input: string; output: string }): string[] {
  return [
    '-hide_banner',
    '-loglevel', 'info',
    '-i', files.input,
    '-map', '0:a:0',
    '-map_metadata', '-1',
    '-map_chapters', '-1',
    ...audioCodecArgs(params),
    '-f', 'adts',
    files.output,
  ];
}

/** The `concat:` input that appends the part files in order. File names must not hold "|". */
export function buildConcatInput(partPaths: readonly string[]): string {
  if (partPaths.length === 0) throw new Error('There is nothing to merge.');
  if (partPaths.some((path) => path.includes('|'))) throw new Error('A part file name holds "|", which the merge cannot use.');
  return `concat:${partPaths.join('|')}`;
}

/** Arguments that join the encoded parts into the .m4b, with chapters, cover and tags. No re-encoding. */
export function buildMergeArgs(spec: ConversionSpec, files: { parts: readonly string[]; output: string }, extras: JobExtras = {}): string[] {
  // A merged book is always an .m4b with chapters: the chapter marks are the reason to merge.
  const mergeSpec: ConversionSpec = { ...spec, container: 'm4b', video: null, keepChapters: true };
  const plan: OutputPlan = {
    spec: mergeSpec,
    maps: ['-map', '0:a:0'],
    coverStreamIndex: 0,
    codecArgs: ['-c:a', 'copy'],
    container: 'm4b',
    inputs: inputArgs(buildConcatInput(files.parts), extras),
    source: null,
    extras,
  };
  return finishArgs(plan, files.output);
}

/**
 * Counts the frames in a raw ADTS stream by hopping from header to header. Throws if the stream
 * is not made of whole ADTS frames, which would mean the encoder output is damaged.
 */
export function countAdtsFrames(bytes: Uint8Array): number {
  let position = 0;
  let frames = 0;
  while (position < bytes.length) {
    const b0 = bytes[position];
    const b1 = bytes[position + 1];
    const b3 = bytes[position + 3];
    const b4 = bytes[position + 4];
    const b5 = bytes[position + 5];
    if (position + 7 > bytes.length || b0 !== 0xff || b1 === undefined || (b1 & 0xf0) !== 0xf0 || b3 === undefined || b4 === undefined || b5 === undefined) {
      throw new Error(`The AAC stream is damaged near byte ${position}.`);
    }
    const length = ((b3 & 0x03) << 11) | (b4 << 3) | (b5 >> 5);
    if (length < 7) throw new Error(`The AAC stream is damaged near byte ${position}.`);
    position += length;
    frames += 1;
  }
  if (position !== bytes.length) throw new Error('The AAC stream ends in the middle of a frame.');
  return frames;
}

/**
 * The chapter list and the total length for parts with these frame counts at this sample rate.
 * Each chapter starts where its part's first frame starts, and the total is every frame.
 */
export function chaptersFromFrames(parts: readonly MergePartLike[], frameCounts: readonly number[], sampleRateHz: number): { chapters: Chapter[]; totalMs: number } {
  if (parts.length !== frameCounts.length) throw new Error('Every part needs a frame count.');
  const toMs = (frames: number): number => Math.round((frames * AAC_FRAME_SAMPLES * 1000) / sampleRateHz);
  let frames = 0;
  const chapters = parts.map((part, index) => {
    const chapter = { startMs: toMs(frames), title: partTitle(part) };
    frames += frameCounts[index] ?? 0;
    return chapter;
  });
  return { chapters, totalMs: toMs(frames) };
}
