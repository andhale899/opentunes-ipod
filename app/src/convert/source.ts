/**
 * What the converter needs to know about an input file, read from ffprobe's JSON output.
 *
 * Pure: no worker and no wasm, so it runs in Node tests. The converter runs ffprobe inside
 * ffmpeg.wasm first, then builds the ffmpeg arguments from this.
 */

export interface SourceAudio {
  /** Stream number in the file, as ffprobe counts them. */
  streamIndex: number;
  codec: string;
  channels: number;
  sampleRateHz: number;
}

export interface SourceVideo {
  streamIndex: number;
  codec: string;
  width: number;
  height: number;
  /** Pixel shape. 1:1 (square pixels) for most files. */
  sarNum: number;
  sarDen: number;
  /** Degrees the picture is turned for display: 0, 90, 180 or 270. */
  rotation: number;
}

/** A cover image stored as a stream (MP3 and MP4 files keep their art this way). */
export interface SourcePicture {
  streamIndex: number;
  codec: string;
}

export interface SourceInfo {
  durationMs: number | null;
  /** The first audio stream. Files with several audio tracks use this one. */
  audio: SourceAudio | null;
  audioStreamCount: number;
  /** The first real video stream (not a cover image). */
  video: SourceVideo | null;
  picture: SourcePicture | null;
}

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

function toNumber(value: unknown): number | null {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : null;
}

function positiveInt(value: unknown): number | null {
  const number = toNumber(value);
  return number !== null && number > 0 ? Math.round(number) : null;
}

/** "8:9" gives 8 and 9. Anything that is not a usable ratio gives 1:1. */
export function parseAspect(value: unknown): { num: number; den: number } {
  if (typeof value === 'string') {
    const match = /^(\d+):(\d+)$/.exec(value.trim());
    if (match) {
      const num = Number(match[1]);
      const den = Number(match[2]);
      if (num > 0 && den > 0) return { num, den };
    }
  }
  return { num: 1, den: 1 };
}

/** The turn in degrees from the display matrix (or the older "rotate" tag), as 0, 90, 180 or 270. */
export function parseRotation(stream: Json): number {
  let degrees: number | null = null;
  const sideData = stream.side_data_list;
  if (Array.isArray(sideData)) {
    for (const entry of sideData) {
      if (isRecord(entry)) {
        const value = toNumber(entry.rotation);
        if (value !== null) degrees = value;
      }
    }
  }
  if (degrees === null && isRecord(stream.tags)) degrees = toNumber(stream.tags.rotate);
  if (degrees === null) return 0;
  const quarter = Math.round((((degrees % 360) + 360) % 360) / 90) % 4;
  return quarter * 90;
}

/**
 * Reads the text ffprobe printed with `-show_streams -show_format -of json`. Returns null when
 * there is no usable JSON, which is what happens for a file ffmpeg cannot open at all.
 */
export function parseProbeOutput(text: string): SourceInfo | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let data: unknown;
  try {
    data = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!isRecord(data) || !Array.isArray(data.streams)) return null;

  let audio: SourceAudio | null = null;
  let audioStreamCount = 0;
  let video: SourceVideo | null = null;
  let picture: SourcePicture | null = null;
  let streamDuration: number | null = null;

  data.streams.forEach((entry: unknown, position: number) => {
    if (!isRecord(entry)) return;
    const streamIndex = toNumber(entry.index) ?? position;
    const codec = typeof entry.codec_name === 'string' ? entry.codec_name : 'unknown';
    const attachedPicture = isRecord(entry.disposition) && entry.disposition.attached_pic === 1;

    if (entry.codec_type === 'audio') {
      audioStreamCount += 1;
      if (!audio) {
        audio = {
          streamIndex,
          codec,
          channels: positiveInt(entry.channels) ?? 2,
          sampleRateHz: positiveInt(entry.sample_rate) ?? 44100,
        };
        streamDuration = toNumber(entry.duration);
      }
    } else if (entry.codec_type === 'video') {
      if (attachedPicture) {
        picture ??= { streamIndex, codec };
      } else if (!video) {
        const width = positiveInt(entry.width);
        const height = positiveInt(entry.height);
        if (width && height) {
          const aspect = parseAspect(entry.sample_aspect_ratio);
          video = { streamIndex, codec, width, height, sarNum: aspect.num, sarDen: aspect.den, rotation: parseRotation(entry) };
        }
      }
    }
  });

  const format = isRecord(data.format) ? data.format : {};
  const seconds = toNumber(format.duration) ?? streamDuration;
  return {
    durationMs: seconds !== null && seconds > 0 ? Math.round(seconds * 1000) : null,
    audio,
    audioStreamCount,
    video,
    picture,
  };
}
