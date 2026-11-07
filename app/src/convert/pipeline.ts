/**
 * The conversion steps, written against the `Engine` interface so they run the same on
 * ffmpeg.wasm in the browser and on a fake in Node tests. No wasm is imported here.
 *
 * Memory (details and measurements in limits.ts): inputs are mounted from their Blobs and never
 * copied in. The output sits in ffmpeg's in-memory file system and is copied out once, so the
 * peak is about twice the output. Jobs that would pass MAX_OUTPUT_BYTES are refused up front
 * (audio) or have their video bitrate cap lowered to fit. Merge parts are deleted before the
 * result is read to keep the peak down, and the worker is terminated by `runJob` at the end,
 * which is what actually returns the memory.
 */

import type { ConversionSpec } from '@opentunes/core';
import { buildAudioArgs } from './audio-args';
import { buildChapterMetadata } from './chapters';
import { coverExtension, type CoverFile, type JobExtras } from './common-args';
import { ConvertError, failureError } from './errors';
import type { JobContext } from './job';
import { buildMergeArgs, buildMergePartArgs, chaptersFromFrames, chooseMergeParams, countAdtsFrames, partFileName, partTitle } from './merge-args';
import { outputFileName, stripExtension, virtualInputName } from './names';
import { checkMergeSize, checkOutputSize, checkSourceStreams, validateSpec } from './plan';
import { stepFraction } from './progress';
import { parseProbeOutput, type SourceInfo } from './source';
import type { ConvertInput, ConvertOptions, ConvertResult, MergePart } from './types';
import { buildVideoArgs } from './video-args';

const encoder = new TextEncoder();

/** Runs ffprobe on a file and reads the result. Throws a plain error when the file cannot be read. */
async function probeFile(context: JobContext, path: string, displayName: string): Promise<SourceInfo> {
  context.beginStep();
  const text = await context.engine.ffprobe(['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path]);
  const info = parseProbeOutput(text);
  if (!info || (info.audio === null && info.video === null)) {
    const tail = context.step.tail();
    throw new ConvertError(
      'input',
      `"${displayName}" could not be read as audio or video. It may be damaged, cut short, or not a media file.${tail ? `\n\nLast lines of the ffmpeg log:\n${tail}` : ''}`,
      context.log.text(),
    );
  }
  return info;
}

/** Runs one ffmpeg command with progress, and throws a plain error with the log tail if it fails. */
async function runStep(context: JobContext, args: string[], options: { durationMs: number | null; start: number; end: number; message: string; label?: string }): Promise<void> {
  const reporter = context.reporter.range(options.start, options.end);
  context.beginStep();
  context.log.push(`$ ffmpeg ${args.join(' ')}`);
  reporter.report(0, options.message);
  context.onStepProgress((timeMicros, ratio) => reporter.report(stepFraction(timeMicros, ratio, options.durationMs), options.message));
  try {
    const code = await context.engine.exec(args);
    if (code !== 0) throw failureError(context.step, code, options.label ?? '', context.log);
  } finally {
    context.onStepProgress(null);
  }
  reporter.report(1, options.message);
}

/** Reads the finished file out of ffmpeg and checks it looks like an MP4-family file. */
async function readOutput(context: JobContext, path: string): Promise<Uint8Array> {
  context.reporter.report(0.99, 'Reading the result');
  const bytes = await context.engine.readFile(path);
  if (bytes.length < 16) throw new ConvertError('ffmpeg', 'The converter produced an empty file.', context.log.text());
  const box = String.fromCharCode(bytes[4] ?? 0, bytes[5] ?? 0, bytes[6] ?? 0, bytes[7] ?? 0);
  if (box !== 'ftyp') throw new ConvertError('ffmpeg', 'The converter produced a file that is not an MP4-family file.', context.log.text());
  return bytes;
}

/** Writes the chapter file and cover image the job asked for, and returns the extras for the builders. */
async function writeExtras(context: JobContext, spec: ConversionSpec, options: ConvertOptions, chapters: { list: ConvertOptions['chapters']; totalMs: number | null }): Promise<JobExtras> {
  const extras: JobExtras = {};
  if (spec.keepTags && options.tags) extras.tags = options.tags;
  if (spec.keepChapters && chapters.list && chapters.list.length > 0) {
    const text = buildChapterMetadata(chapters.list, chapters.totalMs);
    if (text) {
      await context.engine.writeFile('/work/chapters.ffmeta', encoder.encode(text));
      extras.chapterFile = '/work/chapters.ffmeta';
    }
  }
  if (spec.keepArtwork && options.artwork && options.artwork.data.length > 0) {
    const cover: CoverFile = { path: `/work/cover.${coverExtension(options.artwork.mime)}`, mime: options.artwork.mime };
    await context.engine.writeFile(cover.path, options.artwork.data);
    extras.coverFile = cover;
  }
  return extras;
}

/** One file to one m4a, m4b or m4v. */
export async function runConvert(context: JobContext, input: ConvertInput, spec: ConversionSpec, options: ConvertOptions): Promise<ConvertResult> {
  validateSpec(spec);
  const { engine, reporter } = context;

  reporter.report(0.01, 'Opening the file');
  const inputName = virtualInputName('input', input.name);
  await engine.createDir('/in');
  await engine.createDir('/work');
  await engine.mountBlobs('/in', [{ name: inputName, data: input.blob }]);

  const source = await probeFile(context, `/in/${inputName}`, input.name);
  checkSourceStreams(spec, source, input.name);
  const size = checkOutputSize(spec, source);
  if (size.note) {
    context.log.push(size.note);
    reporter.report(0.02, size.note);
  }

  const extras = await writeExtras(context, spec, options, { list: options.chapters, totalMs: source.durationMs });
  const files = { input: `/in/${inputName}`, output: `/work/output.${spec.container}` };
  const args =
    spec.container === 'm4v'
      ? buildVideoArgs(spec, files, source, { ...extras, maxBitrateKbps: size.maxBitrateKbps })
      : buildAudioArgs(spec, files, source, extras);

  await runStep(context, args, { durationMs: source.durationMs, start: 0.03, end: 0.98, message: spec.container === 'm4v' ? 'Converting the video' : 'Converting the audio' });
  const bytes = await readOutput(context, files.output);
  return { bytes, fileName: outputFileName(input.name, spec.container), log: context.log.text() };
}

/** Several audio files to one m4b with a chapter at the start of each part. See merge-args.ts for how. */
export async function runMerge(context: JobContext, parts: MergePart[], spec: ConversionSpec, options: ConvertOptions): Promise<ConvertResult> {
  if (parts.length === 0) throw new ConvertError('spec', 'Pick at least one file to merge.');
  if (spec.video) throw new ConvertError('spec', 'An audiobook merge needs an audio spec, not a video one.');
  const { engine, reporter } = context;

  reporter.report(0.005, 'Opening the files');
  await engine.createDir('/in');
  await engine.createDir('/work');
  const inputNames = parts.map((part, index) => virtualInputName(`part-in-${String(index).padStart(3, '0')}`, part.name));
  await engine.mountBlobs('/in', parts.map((part, index) => ({ name: inputNames[index] ?? '', data: part.blob })));

  const sources: SourceInfo[] = [];
  for (const [index, part] of parts.entries()) {
    reporter.report(0.005 + (0.035 * index) / parts.length, `Reading file ${index + 1} of ${parts.length}`);
    const source = await probeFile(context, `/in/${inputNames[index]}`, part.name);
    if (!source.audio) throw new ConvertError('input', `"${part.name}" has no audio to merge.`);
    sources.push(source);
  }

  const params = chooseMergeParams(spec, sources);
  const durations = sources.map((source) => source.durationMs);
  const known = durations.every((duration): duration is number => duration !== null);
  const totalProbed = known ? durations.reduce<number>((sum, duration) => sum + (duration ?? 0), 0) : null;
  checkMergeSize(totalProbed, params);

  // Each part's share of the encoding time: by length when every length is known, else by file size.
  const weights = known ? durations.map((duration) => duration ?? 0) : parts.map((part) => part.blob.size);
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0) || 1;
  const encodeStart = 0.04;
  const encodeEnd = 0.93;

  const partPaths: string[] = [];
  const frameCounts: number[] = [];
  let doneWeight = 0;
  for (const [index, part] of parts.entries()) {
    const output = `/work/${partFileName(index)}`;
    const from = encodeStart + ((encodeEnd - encodeStart) * doneWeight) / weightTotal;
    doneWeight += weights[index] ?? 0;
    const to = encodeStart + ((encodeEnd - encodeStart) * doneWeight) / weightTotal;
    await runStep(context, buildMergePartArgs(params, { input: `/in/${inputNames[index]}`, output }), {
      durationMs: durations[index] ?? null,
      start: from,
      end: to,
      message: `Converting file ${index + 1} of ${parts.length}`,
      label: `"${part.name}"`,
    });
    // Counting the frames needs the bytes. One part at a time, so this is a small, brief copy.
    frameCounts.push(countAdtsFrames(await engine.readFile(output)));
    partPaths.push(output);
  }

  const { chapters, totalMs } = chaptersFromFrames(parts.map((part) => ({ name: part.name, title: partTitle(part) })), frameCounts, params.sampleRateHz);
  const extras = await writeExtras(context, spec, { ...options, chapters: undefined }, { list: undefined, totalMs });
  // Chapters are the point of a merge, so they are written whatever `keepChapters` says.
  const chapterText = buildChapterMetadata(chapters, totalMs);
  await engine.writeFile('/work/chapters.ffmeta', encoder.encode(chapterText));
  extras.chapterFile = '/work/chapters.ffmeta';

  const output = '/work/book.m4b';
  await runStep(context, buildMergeArgs(spec, { parts: partPaths, output }, extras), {
    durationMs: totalMs,
    start: encodeEnd,
    end: 0.985,
    message: 'Joining the parts into one audiobook',
  });

  // The parts are not needed any more. Deleting them before the copy out keeps the peak lower.
  for (const path of partPaths) await engine.deleteFile(path);
  const bytes = await readOutput(context, output);

  const baseName = options.tags?.album?.trim() || options.tags?.title?.trim() || stripExtension(parts[0]?.name ?? 'audiobook');
  return { bytes, fileName: outputFileName(`${baseName}.m4b`, 'm4b'), log: context.log.text() };
}
