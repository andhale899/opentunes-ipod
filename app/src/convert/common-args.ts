/**
 * The parts of the ffmpeg command line that audio, video and merge jobs share: extra inputs
 * (chapters, cover image), cover art, chapters, tags, and the output container.
 * Pure, no worker and no wasm.
 */

import type { ConversionSpec } from '@opentunes/core';
import type { SourceInfo } from './source';

export interface CoverFile {
  /** Path in ffmpeg's virtual file system. */
  path: string;
  mime: string;
}

export interface JobExtras {
  /** Tags to write on top of (or, with an empty value, to remove from) the ones kept from the input. */
  tags?: Record<string, string>;
  /** An ffmetadata file with the chapters to write, see chapters.ts. */
  chapterFile?: string;
  /** A cover image to write. Without it the input's own cover (if it has one) is kept. */
  coverFile?: CoverFile;
}

export interface InputPlan {
  args: string[];
  chapterInput: number | null;
  coverInput: number | null;
}

export interface OutputPlan {
  spec: ConversionSpec;
  /** The `-map` flags for the audio and video streams. */
  maps: string[];
  /** Which output video stream the cover will be: 0 for audio files, 1 for video files. */
  coverStreamIndex: number;
  codecArgs: string[];
  container: 'm4a' | 'm4b' | 'm4v';
  inputs: InputPlan;
  source: SourceInfo | null;
  extras: JobExtras;
}

const COVER_COPY_MIMES = new Set(['image/jpeg', 'image/jpg', 'image/png']);
const COVER_COPY_CODECS = new Set(['mjpeg', 'png']);

/** `-i` flags: the media file first, then the chapter file and the cover image when there are any. */
export function inputArgs(input: string, extras: JobExtras): InputPlan {
  const args = ['-i', input];
  let next = 1;
  let chapterInput: number | null = null;
  let coverInput: number | null = null;
  if (extras.chapterFile) {
    args.push('-i', extras.chapterFile);
    chapterInput = next++;
  }
  if (extras.coverFile) {
    args.push('-i', extras.coverFile.path);
    coverInput = next++;
  }
  return { args, chapterInput, coverInput };
}

/** A file name extension for a cover image's MIME type. */
export function coverExtension(mime: string): string {
  switch (mime.toLowerCase()) {
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
    case 'image/bmp':
      return 'bmp';
    default:
      return 'img';
  }
}

/** `-metadata key=value` flags. Keys other than letters, digits and "_" are dropped, an empty value removes a tag. */
export function tagArgs(tags: Record<string, string> | undefined): string[] {
  const args: string[] = [];
  for (const [key, value] of Object.entries(tags ?? {})) {
    if (!/^[A-Za-z0-9_]+$/.test(key)) continue;
    args.push('-metadata', `${key}=${String(value).replace(/\u0000/g, '')}`);
  }
  return args;
}

/** The map, codec and disposition flags that put a cover image into the output, or nothing. */
export function coverArgs(plan: Pick<OutputPlan, 'spec' | 'inputs' | 'source' | 'extras' | 'coverStreamIndex'>): { maps: string[]; codec: string[] } {
  if (!plan.spec.keepArtwork) return { maps: [], codec: [] };
  const n = plan.coverStreamIndex;
  let map: string | null = null;
  let copy = false;

  if (plan.extras.coverFile && plan.inputs.coverInput !== null) {
    map = `${plan.inputs.coverInput}:v:0`;
    copy = COVER_COPY_MIMES.has(plan.extras.coverFile.mime.toLowerCase());
  } else if (plan.source?.picture) {
    map = `0:${plan.source.picture.streamIndex}`;
    copy = COVER_COPY_CODECS.has(plan.source.picture.codec);
  }
  if (map === null) return { maps: [], codec: [] };

  const codec = copy
    ? [`-c:v:${n}`, 'copy']
    : [`-c:v:${n}`, 'mjpeg', `-q:v:${n}`, '3', `-pix_fmt:v:${n}`, 'yuvj420p'];
  return { maps: ['-map', map], codec: [...codec, `-disposition:v:${n}`, 'attached_pic'] };
}

/** The full argument list from a plan: inputs, maps, codecs, metadata, container, output file. */
export function finishArgs(plan: OutputPlan, output: string): string[] {
  const { spec, extras, inputs } = plan;
  const cover = coverArgs(plan);

  const chapters = !spec.keepChapters
    ? ['-map_chapters', '-1']
    : inputs.chapterInput !== null
      ? ['-map_chapters', String(inputs.chapterInput)]
      : ['-map_chapters', '0'];

  const tags = spec.keepTags ? tagArgs(extras.tags) : [];
  const callerSetKind = spec.keepTags && extras.tags !== undefined && 'media_type' in extras.tags;
  // The "stik" atom marks an audiobook. It is structure, not a tag the person edits, so it is written even when tags are dropped.
  const kind = plan.container === 'm4b' && !callerSetKind ? ['-metadata', 'media_type=2'] : [];

  return [
    '-hide_banner',
    '-loglevel', 'info',
    ...inputs.args,
    ...plan.maps,
    ...cover.maps,
    ...plan.codecArgs,
    ...cover.codec,
    '-map_metadata', spec.keepTags ? '0' : '-1',
    ...chapters,
    ...tags,
    ...kind,
    '-movflags', '+faststart',
    '-f', 'ipod',
    output,
  ];
}
