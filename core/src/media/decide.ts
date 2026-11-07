import type { AudioFormat, DeviceModel, VideoFormat } from '../devices/types';
import { inferKind } from './infer-kind';
import {
  musicFormatsByFamily,
  normalizeContainerName,
  normalizeProfile,
  parseLevel,
  parseVideoAudioRule,
  safestH264,
  supportFor,
  type AudioFamily,
  type Support,
  type VideoAudioRule,
} from './registry-rules';
import type {
  AudioCodec,
  AudioStream,
  AudioTarget,
  ContentKind,
  ConversionSpec,
  MediaContainer,
  MediaInfo,
  PlanDecision,
  VideoCodec,
  VideoStream,
  VideoTarget,
} from './types';

/**
 * The device-aware planner. Given a probed file and a device row from the registry, it says what
 * to do with the file: copy it as it is, convert it (and exactly how), or leave it out (and why).
 *
 * Pure functions, no I/O. Every limit comes from `device.media` and `device.deviceDeclared`, never
 * from a constant for one model. The few numbers in this file are DEFAULTS for choices the registry
 * does not make (how many kbps to spend), and each is clamped to what the registry allows.
 *
 * What it does not do: run ffmpeg, read files, or touch the iPod. The converter turns a
 * ConversionSpec into a file, and may keep a stream as it is when the stream already fits the caps.
 */

export { inferKind } from './infer-kind';
export type { InferKindHints } from './infer-kind';

export interface DecideOptions {
  /** Convert lossless sources (FLAC, and Apple Lossless or WAV or AIFF that are too big) to Apple Lossless within the limits, instead of AAC. */
  lossless?: boolean;
  /** What the person says the file is. Wins over every guess. */
  userKind?: ContentKind;
  /** Audio bitrate to write when converting to AAC. Clamped to the model's range. */
  audioBitrateKbps?: number;
  /** Video bitrate cap when converting. Clamped to the model's maximum. */
  videoBitrateKbps?: number;
}

/* ----------------------------- defaults (not device limits) ----------------------------- */

/** AAC for music and podcasts, per channel count. 256 kbps stereo is transparent for nearly everyone. */
const DEFAULT_AAC_STEREO_KBPS = 256;
const DEFAULT_AAC_MONO_KBPS = 128;
/** AAC for the sound track of a converted video. */
const DEFAULT_VIDEO_AUDIO_STEREO_KBPS = 128;
const DEFAULT_VIDEO_AUDIO_MONO_KBPS = 64;
/** Video bitrate cap when converting. Small enough to save space on a small iPod. */
const DEFAULT_VIDEO_KBPS = 1500;
/** Only used when a registry H.264 row names no level. */
const FALLBACK_H264_LEVEL = '3.0';
/** Frame rates are floats ("30.000030"), so allow a hair over the limit. */
const FPS_TOLERANCE = 0.01;
/** Apple Lossless is typically about 60 percent of the size of the same audio as PCM. A rough figure for space planning. */
const ALAC_SIZE_RATIO = 0.6;
/** Sample rates an AAC encoder accepts. */
const STANDARD_SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000];

/** E-book and document files, by extension. The iPod has no reader for them. */
const DOCUMENT_EXTENSIONS = new Set(['.epub', '.pdf', '.mobi', '.azw', '.azw3', '.txt', '.rtf', '.doc', '.docx']);

/* ----------------------------------- small helpers ----------------------------------- */

function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function positive(value: number | undefined | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function clampTo(value: number, min?: number, max?: number): number {
  let result = value;
  if (max !== undefined && result > max) result = max;
  if (min !== undefined && result < min) result = min;
  return result;
}

function kHz(hz: number): string {
  return `${Number((hz / 1000).toFixed(2))} kHz`;
}

function fpsText(fps: number): string {
  return `${Number(fps.toFixed(2))} frames per second`;
}

function extensionOf(fileName: string): string {
  const match = /\.[a-z0-9]+$/i.exec(fileName.trim());
  return match ? match[0].toLowerCase() : '';
}

const AUDIO_NAMES: Record<Exclude<AudioCodec, 'pcm' | 'unknown'>, string> = {
  mp3: 'MP3',
  aac: 'AAC',
  'he-aac': 'HE-AAC',
  alac: 'Apple Lossless',
  flac: 'FLAC',
  vorbis: 'Ogg Vorbis',
  opus: 'Opus',
  wma: 'WMA',
  ac3: 'Dolby Digital (AC-3)',
  eac3: 'Dolby Digital Plus (E-AC-3)',
  dts: 'DTS',
};

function audioName(audio: AudioStream, container: MediaContainer): string {
  if (audio.codec === 'unknown') return 'in a format OpenTunes could not identify';
  if (audio.codec === 'pcm') return container === 'aiff' ? 'AIFF' : container === 'wav' ? 'WAV' : 'uncompressed';
  return AUDIO_NAMES[audio.codec];
}

const VIDEO_NAMES: Record<Exclude<VideoCodec, 'unknown'>, string> = {
  h264: 'H.264',
  mpeg4: 'MPEG-4',
  hevc: 'HEVC (H.265)',
  mpeg2: 'MPEG-2',
  vp8: 'VP8',
  vp9: 'VP9',
  av1: 'AV1',
};

const KIND_PHRASE: Record<ContentKind, string> = {
  music: 'music',
  movie: 'a movie',
  'music-video': 'a music video',
  'tv-show': 'a TV show',
  podcast: 'a podcast',
  'video-podcast': 'a video podcast',
  audiobook: 'an audiobook',
};

function isVideoKind(kind: ContentKind): boolean {
  return kind === 'movie' || kind === 'music-video' || kind === 'tv-show' || kind === 'video-podcast';
}

function isLossless(codec: AudioCodec): boolean {
  return codec === 'flac' || codec === 'alac' || codec === 'pcm';
}

/** Average bitrate of the whole file, from its size and length. Null when the length is unknown. */
function averageKbps(info: MediaInfo): number | null {
  const ms = positive(info.durationMs);
  return ms === null || info.sizeBytes <= 0 ? null : (info.sizeBytes * 8) / ms;
}

function unsupported(kind: ContentKind, reasons: string[]): PlanDecision {
  return { action: 'unsupported', reasons, kind, conversion: null, outputExtension: '' };
}

/* -------------------------------------- sample rate -------------------------------------- */

/**
 * The sample rate to write: the source's rate when the model allows it, otherwise the nearest rate
 * the model allows. A source in the 44.1 kHz family (88.2, 176.4) drops to 44.1 or lower in that
 * family so the resampling stays an exact halving. Always at or below `limitHz` when there is one,
 * and always a rate an AAC encoder accepts.
 */
function targetSampleRate(sourceHz: number, limitHz: number | undefined): number {
  const source = positive(sourceHz) ?? 44100;
  const cap = positive(limitHz) ?? Number.POSITIVE_INFINITY;
  if (source <= cap && STANDARD_SAMPLE_RATES.includes(source)) return source;
  const ceiling = Math.min(source, cap);
  let candidates = STANDARD_SAMPLE_RATES.filter((rate) => rate <= ceiling);
  if (source % 11025 === 0) {
    const sameFamily = candidates.filter((rate) => rate % 11025 === 0);
    if (sameFamily.length > 0) candidates = sameFamily;
  }
  return candidates[0] ?? Math.floor(ceiling);
}

/** Apple Lossless writes 16, 24 or 32 bits. Pick the smallest that holds the source, then cap it to the model. */
function targetBitDepth(sourceDepth: number | undefined, maxDepth: number | undefined): number {
  const source = positive(sourceDepth) ?? 16;
  const wanted = source <= 16 ? 16 : source <= 24 ? 24 : 32;
  const cap = positive(maxDepth) ?? 32;
  const allowed = [16, 24, 32].filter((depth) => depth <= Math.min(wanted, cap));
  return allowed.length > 0 ? Math.max(...allowed) : Math.floor(cap);
}

/* ------------------------------------ picture size ------------------------------------ */

function evenDown(n: number): number {
  return Math.max(2, Math.floor(n / 2 + 1e-9) * 2);
}

/**
 * Scale a picture down to fit inside a box, keeping the shape, with even width and height (H.264
 * needs even sizes). Never scales up. Unknown sizes (zero or less) give the box. The result is
 * never larger than the box, even when the box has odd sides.
 */
export function fitVideoSize(width: number, height: number, maxWidth: number, maxHeight: number): { width: number; height: number } {
  const boxWidth = evenDown(maxWidth);
  const boxHeight = evenDown(maxHeight);
  if (!(width > 0) || !(height > 0)) return { width: boxWidth, height: boxHeight };
  const scale = Math.min(1, boxWidth / width, boxHeight / height);
  return {
    width: Math.min(boxWidth, evenDown(width * scale)),
    height: Math.min(boxHeight, evenDown(height * scale)),
  };
}

/* ------------------------------------- reasons: kind ------------------------------------- */

function documentReason(device: DeviceModel): string {
  const status = device.media?.notes?.status ?? 'unknown';
  const declared = device.deviceDeclared !== undefined;
  if (status === 'supported') {
    return `The ${device.name} lists a Notes feature, but OpenTunes does not put text or book files there yet.`;
  }
  if (status === 'not-listed') {
    return `The published specification for ${device.name} does not list Notes or a book reader${declared ? ", and the iPod's own description file does not declare one" : ''}, so e-books and documents cannot be put on it.`;
  }
  return `The ${device.name} has no Notes or book reader that OpenTunes knows of (this is not confirmed either way)${declared ? ", and the iPod's own description file does not declare one" : ''}, so e-books and documents are not put on it.`;
}

/** The decision for a file the model cannot take at all, worded from the registry's status for that kind. */
function missingSupportReason(support: Support, subject: string, consequence: string): string {
  if (support.declaredOff) return `This iPod's own description file says it does not support ${subject}, ${consequence}.`;
  if (support.status === 'not-listed') return `This iPod's specification does not list ${subject}, ${consequence}.`;
  return `OpenTunes has not confirmed that this iPod supports ${subject}, ${consequence}.`;
}

interface ResolvedKind {
  kind: ContentKind;
  /** Plain sentences about kind changes and what the registry says about this kind. Added after the main reasons. */
  notes: string[];
}

/**
 * Start from inferKind, make the kind agree with what is in the file, then check that the model
 * supports it. Anything that changes the kind adds a sentence, so nothing changes silently.
 */
function resolveKind(info: MediaInfo, device: DeviceModel, options: DecideOptions): ResolvedKind {
  const hasVideo = info.video !== null;
  const notes: string[] = [];
  let kind = inferKind(info, { fileName: info.fileName, userKind: options.userKind });

  if (hasVideo && !isVideoKind(kind)) {
    const next: ContentKind = kind === 'podcast' ? 'video-podcast' : kind === 'music' ? 'music-video' : 'movie';
    notes.push(`This file has a picture, so it is treated as ${KIND_PHRASE[next]}, not as ${KIND_PHRASE[kind]}.`);
    kind = next;
  } else if (!hasVideo && isVideoKind(kind)) {
    const next: ContentKind = kind === 'video-podcast' ? 'podcast' : 'music';
    notes.push(`This file has no picture, so it is treated as ${KIND_PHRASE[next]}, not as ${KIND_PHRASE[kind]}.`);
    kind = next;
  }

  if (kind === 'podcast' || kind === 'video-podcast') {
    const support = supportFor(device, 'podcast');
    if (!support.ok) {
      const next: ContentKind = kind === 'podcast' ? 'music' : 'movie';
      notes.push(missingSupportReason(support, 'podcasts', `so the file is added as ${KIND_PHRASE[next]} instead`));
      kind = next;
    } else if (support.note) {
      notes.push(`About podcasts on this iPod: ${sentence(support.note)}`);
    }
  } else if (kind === 'audiobook') {
    const support = supportFor(device, 'audiobook');
    if (!support.ok) {
      notes.push(missingSupportReason(support, 'audiobooks', 'so the file is added as music instead'));
      kind = 'music';
    } else if (support.note) {
      notes.push(`About audiobooks on this iPod: ${sentence(support.note)}`);
    }
  }

  return { kind, notes };
}

/* --------------------------------------- audio only --------------------------------------- */

function sourceFamily(audio: AudioStream, container: MediaContainer): AudioFamily | null {
  switch (audio.codec) {
    case 'mp3':
    case 'aac':
    case 'he-aac':
    case 'alac':
    case 'flac':
    case 'vorbis':
    case 'opus':
    case 'wma':
      return audio.codec;
    case 'pcm':
      return container === 'aiff' ? 'aiff' : 'wav';
    default:
      return null;
  }
}

/** The extension a file keeps when copied as it is, or null when its wrapper is not one the iPod takes as it is. */
function audioCopyExtension(family: AudioFamily, container: MediaContainer): string | null {
  switch (family) {
    case 'mp3':
      return container === 'mp3' ? '.mp3' : null;
    case 'aac':
    case 'he-aac':
    case 'alac':
      return container === 'm4b' ? '.m4b' : container === 'm4a' || container === 'mp4' ? '.m4a' : null;
    case 'wav':
      return container === 'wav' ? '.wav' : null;
    case 'aiff':
      return container === 'aiff' ? '.aif' : null;
    case 'flac':
      return container === 'flac' ? '.flac' : null;
    case 'vorbis':
      return container === 'ogg' ? '.ogg' : null;
    case 'opus':
      return container === 'opus' || container === 'ogg' ? '.opus' : null;
    case 'wma':
      return container === 'wma' ? '.wma' : null;
    default:
      return null;
  }
}

interface AudioAssessment {
  /** True when the file can go on as it is. */
  fits: boolean;
  /** Plain sentences, the main cause first. Empty when the file fits. */
  causes: string[];
  /** The extension to keep when it fits. */
  extension: string | null;
}

function assessAudioOnly(info: MediaInfo, audio: AudioStream, rules: Map<AudioFamily, AudioFormat>): AudioAssessment {
  const name = audioName(audio, info.container);
  const family = sourceFamily(audio, info.container);

  if (audio.codec === 'unknown') {
    return { fits: false, causes: ['OpenTunes could not identify the audio format, so it will try to convert it.'], extension: null };
  }
  if (family === null) {
    return { fits: false, causes: [`The audio is ${name}, which this iPod does not play.`], extension: null };
  }
  const rule = rules.get(family);
  if (!rule) {
    return { fits: false, causes: [`The audio is ${name}, which is not on this iPod's list of formats it plays.`], extension: null };
  }

  const causes: string[] = [];

  // HE-AAC counts as supported only when the registry lists it without a caution. A note means the
  // sources disagree (the nano 7G's page lists it, its own description file names AAC-LC only), so
  // take the cautious road and convert to plain AAC-LC.
  if (family === 'he-aac' && rule.note) {
    causes.push("The audio is HE-AAC, and this iPod's list shows it with a caution.");
    causes.push(`The caution reads: "${sentence(rule.note)}" So the file is converted to standard AAC (AAC-LC) to be safe.`);
  }

  const extension = audioCopyExtension(family, info.container);
  if (extension === null) {
    causes.push(`The audio sits in a .${info.container} file, which the iPod does not play as it is.`);
  }

  const rate = positive(audio.sampleRateHz);
  if (rate !== null && rule.maxSampleRateHz !== undefined && rate > rule.maxSampleRateHz) {
    causes.push(`The sample rate is ${kHz(rate)} and the iPod stops at ${kHz(rule.maxSampleRateHz)}.`);
  }

  if (rule.maxBitDepth !== undefined && audio.bitDepth !== undefined && audio.bitDepth > rule.maxBitDepth) {
    causes.push(`The audio is ${audio.bitDepth}-bit and the iPod plays up to ${rule.maxBitDepth}-bit.`);
  }

  if (rule.bitrateKbps) {
    const bitrate = positive(audio.bitrateKbps) ?? averageKbps(info);
    if (bitrate !== null && (bitrate > rule.bitrateKbps.max || bitrate < rule.bitrateKbps.min)) {
      causes.push(`The bitrate is about ${Math.round(bitrate)} kbps and the iPod plays ${rule.bitrateKbps.min} to ${rule.bitrateKbps.max} kbps for ${name}.`);
    }
  }

  if (audio.channels > 2) {
    causes.push(`The sound has ${audio.channels} channels and the iPod plays stereo.`);
  }

  if (rule.variableBitrate === false && audio.variableBitrate === true) {
    causes.push(`The file uses a variable bitrate, which this iPod's list does not allow for ${name}.`);
  }

  return { fits: causes.length === 0, causes, extension };
}

function describeAudioFit(info: MediaInfo, audio: AudioStream): string {
  const parts: string[] = [];
  const rate = positive(audio.sampleRateHz);
  if (rate !== null) parts.push(kHz(rate));
  const bitrate = positive(audio.bitrateKbps);
  if (bitrate !== null) parts.push(`${Math.round(bitrate)} kbps`);
  const details = parts.length > 0 ? ` at ${parts.join(', ')}` : '';
  return `This is ${audioName(audio, info.container)} audio${details}, which this iPod plays as it is, so it is copied without changes.`;
}

/** Pick AAC or Apple Lossless for audio the model cannot play as it is. Null when the model lists neither. */
function planAudioTarget(
  audio: AudioStream,
  rules: Map<AudioFamily, AudioFormat>,
  options: DecideOptions,
): { target: AudioTarget; sentences: string[] } | { problem: string } {
  const aac = rules.get('aac');
  const alac = rules.get('alac');
  const sentences: string[] = [];
  const channels: 1 | 2 = audio.channels === 1 ? 1 : 2;

  let codec: 'aac' | 'alac' | null = null;
  if (options.lossless && isLossless(audio.codec)) {
    if (alac) codec = 'alac';
    else sentences.push('You asked for lossless, but Apple Lossless is not on this iPod\'s list, so the file is converted to AAC instead.');
  }
  if (codec === null) {
    if (aac) codec = 'aac';
    else if (alac) {
      codec = 'alac';
      sentences.push('AAC is not on this iPod\'s list, so the file is converted to Apple Lossless instead.');
    }
  }
  if (codec === null) {
    return {
      problem: 'OpenTunes can write only AAC and Apple Lossless, and this iPod\'s list names neither, so this audio cannot be converted for it.',
    };
  }

  if (codec === 'alac') {
    const rule = alac as AudioFormat;
    const target: AudioTarget = {
      codec: 'alac',
      sampleRateHz: targetSampleRate(audio.sampleRateHz, rule.maxSampleRateHz),
      channels,
      bitDepth: targetBitDepth(audio.bitDepth, rule.maxBitDepth),
    };
    return { target, sentences };
  }

  const rule = aac as AudioFormat;
  const wanted = positive(options.audioBitrateKbps) ?? (channels === 1 ? DEFAULT_AAC_MONO_KBPS : DEFAULT_AAC_STEREO_KBPS);
  const target: AudioTarget = {
    codec: 'aac',
    bitrateKbps: Math.round(clampTo(wanted, rule.bitrateKbps?.min, rule.bitrateKbps?.max)),
    sampleRateHz: targetSampleRate(audio.sampleRateHz, rule.maxSampleRateHz),
    channels,
  };
  return { target, sentences };
}

function describeAudioTargetSentence(target: AudioTarget, extension: string): string {
  const mono = target.channels === 1 ? 'mono' : 'stereo';
  const rate = target.sampleRateHz ? `, ${kHz(target.sampleRateHz)}` : '';
  if (target.codec === 'alac') {
    return `It is converted to Apple Lossless${target.bitDepth ? ` (${target.bitDepth}-bit)` : ''}${rate}, ${mono}, and saved as ${extension}.`;
  }
  return `It is converted to AAC at ${target.bitrateKbps} kbps${rate}, ${mono}, and saved as ${extension}.`;
}

function decideAudioOnly(info: MediaInfo, audio: AudioStream, device: DeviceModel, resolved: ResolvedKind, options: DecideOptions): PlanDecision {
  const { kind, notes } = resolved;
  const music = supportFor(device, 'music');
  const rules = musicFormatsByFamily(device);
  if (!music.ok || rules.size === 0) {
    return unsupported(kind, [missingSupportReason(music, 'music', 'so audio files cannot be put on it')]);
  }

  const assessment = assessAudioOnly(info, audio, rules);
  if (assessment.fits && assessment.extension !== null) {
    return {
      action: 'copy',
      reasons: [describeAudioFit(info, audio), ...notes],
      kind,
      conversion: null,
      outputExtension: assessment.extension,
    };
  }

  const plan = planAudioTarget(audio, rules, options);
  if ('problem' in plan) return unsupported(kind, [plan.problem, ...assessment.causes]);

  const container: ConversionSpec['container'] = kind === 'audiobook' ? 'm4b' : 'm4a';
  const extension = `.${container}`;
  const conversion: ConversionSpec = {
    container,
    audio: plan.target,
    video: null,
    keepChapters: kind === 'audiobook' || info.chapters.length > 0,
    keepArtwork: true,
    keepTags: true,
  };
  return {
    action: 'convert',
    reasons: [...assessment.causes, ...plan.sentences, describeAudioTargetSentence(plan.target, extension), ...notes],
    kind,
    conversion,
    outputExtension: extension,
  };
}

/* ---------------------------------------- video ---------------------------------------- */

interface VideoAssessment {
  format: VideoFormat;
  audioRule: VideoAudioRule;
  causes: string[];
}

/** Check a video file against one listed video row: the picture, the sound track and the wrapper. */
function assessVideoAgainst(info: MediaInfo, video: VideoStream, audio: AudioStream | null, format: VideoFormat): VideoAssessment {
  const audioRule = parseVideoAudioRule(format.audio);
  const causes: string[] = [];

  if (video.codec !== format.codec) {
    causes.push(
      video.codec === 'unknown'
        ? 'OpenTunes could not identify the video format, so it will try to convert it.'
        : `The video is ${VIDEO_NAMES[video.codec]}, which this iPod does not play.`,
    );
  } else {
    const allowed = format.profiles.map((profile) => normalizeProfile(profile));
    const profile = normalizeProfile(video.profile);
    const codecName = VIDEO_NAMES[format.codec];
    if (profile === null) {
      causes.push(`The file does not say which ${codecName} profile the video uses, so it is converted to be safe.`);
    } else if (!allowed.includes(profile)) {
      causes.push(`The video uses the ${codecName} ${video.profile} profile, which is more than this iPod plays.`);
    }

    const limitLevel = parseLevel(format.level);
    if (limitLevel !== null) {
      const level = parseLevel(video.level);
      if (level === null) causes.push(`The file does not say its ${codecName} level, so it is converted to be safe.`);
      else if (level > limitLevel + 1e-9) causes.push(`The video's ${codecName} level is ${video.level} and the iPod stops at ${format.level}.`);
    }

    if (!(video.width > 0) || !(video.height > 0)) {
      causes.push('The file does not say how big the picture is, so it is converted to be safe.');
    } else if (video.width > format.maxWidth || video.height > format.maxHeight) {
      causes.push(`The picture is ${video.width}x${video.height} and the iPod stops at ${format.maxWidth}x${format.maxHeight}.`);
    }

    const fps = positive(video.fps);
    if (fps === null) {
      causes.push('The file does not say its frame rate, so it is converted to be safe.');
    } else if (fps > format.maxFps + FPS_TOLERANCE) {
      causes.push(`The video runs at ${fpsText(fps)} and the iPod stops at ${format.maxFps}.`);
    }

    if (format.maxVideoBitrateKbps !== undefined) {
      let bitrate = positive(video.bitrateKbps);
      if (bitrate === null) {
        // Estimate from the whole file, less the sound track when its size is known. This can only
        // overestimate, which errs toward converting.
        const average = averageKbps(info);
        bitrate = average === null ? null : positive(average - (positive(audio?.bitrateKbps) ?? 0));
      }
      if (bitrate === null) causes.push('The file does not say its video bitrate, so it is converted to be safe.');
      else if (bitrate > format.maxVideoBitrateKbps) {
        causes.push(`The video's bitrate is about ${Math.round(bitrate)} kbps and the iPod stops at ${format.maxVideoBitrateKbps} kbps.`);
      }
    }
  }

  if (audio) {
    const soundName = audioName(audio, info.container);
    if (audio.codec === 'unknown') {
      causes.push('OpenTunes could not identify the audio format, so it will try to convert it.');
    } else if (audio.codec !== 'aac') {
      causes.push(`The audio is ${soundName}, which is not the AAC-LC this iPod's video list asks for.`);
    }
    const rate = positive(audio.sampleRateHz);
    if (rate !== null && audioRule.maxSampleRateHz !== null && rate > audioRule.maxSampleRateHz) {
      causes.push(`The audio sample rate is ${kHz(rate)} and the iPod stops at ${kHz(audioRule.maxSampleRateHz)}.`);
    }
    const bitrate = positive(audio.bitrateKbps);
    if (bitrate !== null && audioRule.maxBitrateKbps !== null && bitrate > audioRule.maxBitrateKbps) {
      causes.push(`The audio bitrate is ${Math.round(bitrate)} kbps and the iPod stops at ${audioRule.maxBitrateKbps} kbps.`);
    }
    if (audio.channels > audioRule.maxChannels) {
      const channels = audio.channels === 6 ? '5.1 surround sound' : `${audio.channels} channels of sound`;
      causes.push(`The audio is ${channels} and the iPod plays ${audioRule.maxChannels === 1 ? 'mono' : 'stereo'}.`);
    }
  }

  const containers = format.containers.map((name) => normalizeContainerName(name));
  if (!containers.includes(info.container)) {
    const list = format.containers.map((name) => `.${normalizeContainerName(name)}`);
    const shown = list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}` : (list[0] ?? 'nothing');
    causes.push(`The file is a .${info.container} file and the iPod plays ${shown} files.`);
  }

  return { format, audioRule, causes };
}

function describeVideoFit(info: MediaInfo, video: VideoStream, audio: AudioStream | null): string {
  const profile = video.profile ? ` ${video.profile}` : '';
  const fps = positive(video.fps);
  const sound = audio ? `, with ${audioName(audio, info.container)} audio` : ', with no sound';
  return `This is ${VIDEO_NAMES[video.codec as Exclude<VideoCodec, 'unknown'>]}${profile} video at ${video.width}x${video.height}${fps ? `, ${fpsText(fps)}` : ''}${sound}, in a .${info.container} file. That fits what this iPod plays, so it is copied without changes.`;
}

function decideVideo(info: MediaInfo, video: VideoStream, device: DeviceModel, resolved: ResolvedKind, options: DecideOptions): PlanDecision {
  const { kind, notes } = resolved;
  const support = supportFor(device, 'video');
  const formats = device.media?.video?.formats ?? [];
  if (!support.ok || formats.length === 0) {
    return unsupported(kind, [missingSupportReason(support, 'video', 'so video files cannot be put on it')]);
  }

  const audio = info.audio;
  const assessments = formats.map((format) => assessVideoAgainst(info, video, audio, format));

  const fitting = assessments.find((assessment) => assessment.causes.length === 0);
  if (fitting) {
    return {
      action: 'copy',
      reasons: [describeVideoFit(info, video, audio), ...notes],
      kind,
      conversion: null,
      outputExtension: `.${info.container}`,
    };
  }

  // Explain against the row the file came closest to, so the "iPod stops at" figures are the ones it was nearest to meeting.
  // Rows for the file's own codec come first (their problems are the real ones), then the fewest problems, then the roomiest row.
  const sameCodec = (assessment: VideoAssessment): number => (assessment.format.codec === video.codec ? 0 : 1);
  const closest = [...assessments].sort(
    (a, b) =>
      sameCodec(a) - sameCodec(b) ||
      a.causes.length - b.causes.length ||
      b.format.maxWidth * b.format.maxHeight - a.format.maxWidth * a.format.maxHeight,
  )[0]!;

  const choice = safestH264(device);
  if (!choice) {
    return unsupported(kind, [
      "OpenTunes can write only H.264 video, and this iPod's list has no H.264 row it can use, so this video cannot be converted for it.",
      ...closest.causes,
    ]);
  }

  const target = choice.format;
  const size = fitVideoSize(video.width, video.height, target.maxWidth, target.maxHeight);
  const videoBitrate = Math.max(1, Math.round(clampTo(positive(options.videoBitrateKbps) ?? DEFAULT_VIDEO_KBPS, undefined, target.maxVideoBitrateKbps)));
  const videoTarget: VideoTarget = {
    codec: 'h264',
    profile: choice.profile,
    level: target.level ?? FALLBACK_H264_LEVEL,
    maxWidth: size.width,
    maxHeight: size.height,
    maxFps: target.maxFps,
    maxBitrateKbps: videoBitrate,
  };

  const targetRule = parseVideoAudioRule(target.audio);
  let audioTarget: AudioTarget | null = null;
  if (audio) {
    const channels: 1 | 2 = audio.channels === 1 || targetRule.maxChannels === 1 ? 1 : 2;
    const wanted = positive(options.audioBitrateKbps) ?? (channels === 1 ? DEFAULT_VIDEO_AUDIO_MONO_KBPS : DEFAULT_VIDEO_AUDIO_STEREO_KBPS);
    audioTarget = {
      codec: 'aac',
      bitrateKbps: Math.max(1, Math.round(clampTo(wanted, undefined, targetRule.maxBitrateKbps ?? undefined))),
      sampleRateHz: targetSampleRate(audio.sampleRateHz, targetRule.maxSampleRateHz ?? undefined),
      channels,
    };
  }

  const conversion: ConversionSpec = {
    container: 'm4v',
    audio: audioTarget,
    video: videoTarget,
    keepChapters: info.chapters.length > 0,
    keepArtwork: true,
    keepTags: true,
  };

  const profileName = choice.profile.charAt(0).toUpperCase() + choice.profile.slice(1);
  const result =
    `It is converted to H.264 ${profileName}, ${size.width}x${size.height}, up to ${videoBitrate} kbps` +
    (audioTarget ? `, with ${audioTarget.channels === 1 ? 'mono' : 'stereo'} AAC audio at ${audioTarget.bitrateKbps} kbps` : '') +
    ', and saved as .m4v, which is the safest setting this iPod lists.';

  return {
    action: 'convert',
    reasons: [...closest.causes, result, ...notes],
    kind,
    conversion,
    outputExtension: '.m4v',
  };
}

/* --------------------------------------- the planner --------------------------------------- */

/**
 * Decide what to do with one file for one iPod model.
 *
 * Order of checks: e-book or document by file name, copy protection, unknown container, no sound
 * and no picture, a model with no researched limits, then the kind (with fallbacks), then audio or
 * video rules read from `device.media`. Every decision carries plain reasons. The first reason is
 * the main one, written to read well inside brackets after the table description.
 */
export function decideForDevice(info: MediaInfo, device: DeviceModel, options: DecideOptions = {}): PlanDecision {
  const baseKind = inferKind(info, { fileName: info.fileName, userKind: options.userKind });

  if (DOCUMENT_EXTENSIONS.has(extensionOf(info.fileName))) {
    return unsupported(baseKind, [
      documentReason(device),
      `${extensionOf(info.fileName).slice(1).toUpperCase()} files are e-books or documents, not music or video, so there is nothing to convert them to.`,
    ]);
  }

  if (info.protected) {
    return unsupported(baseKind, [
      'This file is copy-protected (DRM), so OpenTunes can neither read it nor convert it, and it cannot be put on the iPod.',
    ]);
  }

  if (info.container === 'unknown') {
    return unsupported(baseKind, ['OpenTunes could not tell what kind of file this is, so it cannot be put on the iPod.', ...info.warnings]);
  }

  if (info.audio === null && info.video === null) {
    return unsupported(baseKind, ['This file has no sound and no picture that OpenTunes could find, so there is nothing to put on the iPod.', ...info.warnings]);
  }

  if (device.media === null) {
    return unsupported(baseKind, [`OpenTunes has not researched what ${device.name} plays yet, so it cannot plan files for it.`]);
  }

  const resolved = resolveKind(info, device, options);
  if (info.video !== null) return decideVideo(info, info.video, device, resolved, options);
  return decideAudioOnly(info, info.audio as AudioStream, device, resolved, options);
}

/* --------------------------------------- describing --------------------------------------- */

function trimPeriod(text: string): string {
  return text.trim().replace(/\.+$/, '');
}

/** "The sample rate is ..." read inside brackets becomes "the sample rate is ...". Other starts are left alone. */
function forBrackets(reason: string): string {
  const text = trimPeriod(reason);
  return text.startsWith('The ') ? `the ${text.slice(4)}` : text;
}

/** The main cause when the decision has no reasons, worked out from the file and the spec. */
function fallbackCause(info: MediaInfo, conversion: ConversionSpec): string {
  const audio = info.audio;
  const target = conversion.audio;
  if (audio && target) {
    if (target.sampleRateHz !== undefined && positive(audio.sampleRateHz) !== null && target.sampleRateHz < audio.sampleRateHz) {
      return `the sample rate is ${kHz(audio.sampleRateHz)} and it is lowered to ${kHz(target.sampleRateHz)}`;
    }
    if (target.channels !== undefined && audio.channels > target.channels) {
      return `the sound has ${audio.channels} channels and it is mixed down to ${target.channels === 1 ? 'mono' : 'stereo'}`;
    }
  }
  const video = info.video;
  const videoTarget = conversion.video;
  if (video && videoTarget && (video.width > videoTarget.maxWidth || video.height > videoTarget.maxHeight)) {
    return `the picture is ${video.width}x${video.height} and it is scaled down to fit`;
  }
  return '';
}

/** One sentence for a table row, for example "Copy as it is" or "Convert to AAC 256 kbps (the sample rate is 96 kHz and the iPod stops at 48 kHz)". */
export function describeDecision(decision: PlanDecision, info: MediaInfo): string {
  if (decision.action === 'unsupported') {
    const first = decision.reasons[0];
    return first ? `Not supported: ${forBrackets(first)}` : 'Not supported';
  }
  if (decision.action === 'copy') return 'Copy as it is';

  const spec = decision.conversion;
  let what = 'Convert';
  if (spec?.video) {
    what = `Convert to H.264 ${spec.video.maxWidth}x${spec.video.maxHeight} at up to ${spec.video.maxBitrateKbps} kbps`;
  } else if (spec?.audio) {
    what =
      spec.audio.codec === 'alac'
        ? 'Convert to Apple Lossless'
        : `Convert to AAC${spec.audio.bitrateKbps !== undefined ? ` ${spec.audio.bitrateKbps} kbps` : ''}${spec.audio.channels === 1 ? ' mono' : ''}`;
  }

  const first = decision.reasons[0];
  const why = first ? forBrackets(first) : spec ? fallbackCause(info, spec) : '';
  return why ? `${what} (${why})` : what;
}

/* --------------------------------------- estimating --------------------------------------- */

/**
 * How many bytes the file will take on the iPod, for space planning. A copy is the file's own size.
 * A conversion is bitrate times length (video: the lower of the cap and the source's own bitrate,
 * plus the sound track), plus the artwork. Apple Lossless uses a rough ratio of the uncompressed
 * size. Null for a file that is not added, or when the length or bitrate is not known.
 */
export function estimateOutputBytes(info: MediaInfo, decision: PlanDecision): number | null {
  if (decision.action === 'unsupported') return null;
  if (decision.action === 'copy') return info.sizeBytes;

  const spec = decision.conversion;
  const ms = positive(info.durationMs);
  if (!spec || ms === null) return null;
  const seconds = ms / 1000;
  const artwork = spec.keepArtwork && info.artwork ? info.artwork.data.length : 0;

  let bits: number;
  if (spec.video) {
    const sourceKbps = positive(info.video?.bitrateKbps);
    const videoKbps = sourceKbps !== null ? Math.min(sourceKbps, spec.video.maxBitrateKbps) : spec.video.maxBitrateKbps;
    const audioKbps = spec.audio?.bitrateKbps ?? 0;
    bits = (videoKbps + audioKbps) * 1000 * seconds;
  } else if (spec.audio?.codec === 'aac') {
    if (spec.audio.bitrateKbps === undefined) return null;
    bits = spec.audio.bitrateKbps * 1000 * seconds;
  } else if (spec.audio?.codec === 'alac') {
    const rate = spec.audio.sampleRateHz ?? positive(info.audio?.sampleRateHz);
    const depth = spec.audio.bitDepth ?? positive(info.audio?.bitDepth) ?? 16;
    if (rate === null) return null;
    bits = rate * depth * (spec.audio.channels ?? 2) * seconds * ALAC_SIZE_RATIO;
  } else {
    return null;
  }
  return Math.round(bits / 8) + artwork;
}
