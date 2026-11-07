import type { AudioFormat, DeviceModel, MediaKind, SupportStatus, VideoFormat } from '../devices/types';

/**
 * Reads a device's media rules out of the registry, so the planner never carries a number for one
 * model. The registry describes formats in loose text ("Apple Lossless", "AAC-LC up to 256 kbps,
 * 48 kHz, stereo"); this file turns that text into values that can be compared.
 */

/** The kinds of audio the registry can name, reduced to one spelling each. */
export type AudioFamily =
  | 'aac'
  | 'he-aac'
  | 'protected-aac'
  | 'mp3'
  | 'alac'
  | 'wav'
  | 'aiff'
  | 'flac'
  | 'vorbis'
  | 'opus'
  | 'wma'
  | 'audible';

/** "Apple Lossless" and "ALAC" are the same family. Null for a name this code does not know. */
export function audioFamilyFromRegistryName(name: string): AudioFamily | null {
  const text = name.toLowerCase().replace(/[^a-z0-9+]+/g, ' ').trim();
  if (/protected/.test(text)) return 'protected-aac';
  if (/audible/.test(text)) return 'audible';
  if (/\bhe aac\b|\bheaac\b|aac\+|aac plus|aacplus/.test(text)) return 'he-aac';
  if (/apple lossless|\balac\b/.test(text)) return 'alac';
  if (/^aac\b/.test(text)) return 'aac';
  if (/\bmp3\b|layer 3|layer iii/.test(text)) return 'mp3';
  if (/\baiff?\b/.test(text)) return 'aiff';
  if (/\bwave?\b|\bpcm\b/.test(text)) return 'wav';
  if (/\bflac\b/.test(text)) return 'flac';
  if (/vorbis|\bogg\b/.test(text)) return 'vorbis';
  if (/\bopus\b/.test(text)) return 'opus';
  if (/\bwma\b|windows media/.test(text)) return 'wma';
  return null;
}

/** The audio rules a model lists for music, by family. The first row for a family wins. */
export function musicFormatsByFamily(device: DeviceModel): Map<AudioFamily, AudioFormat> {
  const byFamily = new Map<AudioFamily, AudioFormat>();
  for (const format of device.media?.music?.formats ?? []) {
    const family = audioFamilyFromRegistryName(format.codec);
    if (family && !byFamily.has(family)) byFamily.set(family, format);
  }
  return byFamily;
}

export interface Support {
  /** True when the model can take this kind of media. */
  ok: boolean;
  /** The registry's status, or 'missing' when the row has none at all. */
  status: SupportStatus | 'missing';
  /** True when the iPod's own description file says the feature is off. */
  declaredOff: boolean;
  /** The registry's note for this kind, if it has one. */
  note?: string;
}

/**
 * Whether the model supports a kind of media. The specification status decides, and the device's
 * own description file (`deviceDeclared.features`) can switch podcasts on or off when it speaks.
 */
export function supportFor(device: DeviceModel, kind: MediaKind): Support {
  const entry = device.media?.[kind];
  const status: Support['status'] = entry?.status ?? 'missing';
  const features = device.deviceDeclared?.features;
  const declared = kind === 'podcast' ? features?.podcasts : kind === 'photo' ? features?.photos : undefined;
  const declaredOff = declared === false;
  const ok = !declaredOff && (status === 'supported' || declared === true);
  return { ok, status, declaredOff, ...(entry?.note ? { note: entry.note } : {}) };
}

/** What a model's audio-inside-video rule allows, read from text like "AAC-LC up to 256 kbps, 48 kHz, stereo". */
export interface VideoAudioRule {
  /** Highest bitrate, or null when the text names none. */
  maxBitrateKbps: number | null;
  /** Highest sample rate, or null when the text names none. */
  maxSampleRateHz: number | null;
  /** 1 for "mono". 2 for "stereo" and for any text that does not say, the safe reading. */
  maxChannels: number;
}

export function parseVideoAudioRule(text: string): VideoAudioRule {
  const kbps = /(\d+(?:\.\d+)?)\s*kbps/i.exec(text);
  const khz = /(\d+(?:\.\d+)?)\s*khz/i.exec(text);
  return {
    maxBitrateKbps: kbps?.[1] ? Math.round(Number(kbps[1])) : null,
    maxSampleRateHz: khz?.[1] ? Math.round(Number(khz[1]) * 1000) : null,
    maxChannels: /\bmono\b/i.test(text) ? 1 : 2,
  };
}

/** "Constrained Baseline" and "Baseline" both read "baseline". Null when no profile is given. */
export function normalizeProfile(profile: string | undefined): string | null {
  if (!profile || !profile.trim()) return null;
  const text = profile.trim().toLowerCase().replace(/\s+/g, ' ');
  return text === 'constrained baseline' ? 'baseline' : text;
}

/** "3.0" becomes 3, "3.1" becomes 3.1. Null for anything that is not a number. */
export function parseLevel(level: string | undefined): number | null {
  if (!level) return null;
  const value = Number.parseFloat(level);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** ".M4V" and "m4v" both read "m4v". */
export function normalizeContainerName(name: string): string {
  return name.trim().toLowerCase().replace(/^\./, '');
}

export type H264Profile = 'baseline' | 'main' | 'high';

export interface H264Choice {
  format: VideoFormat;
  /** The lowest profile the row lists, because that is the safest one to encode with. */
  profile: H264Profile;
}

/**
 * The safest H.264 row the model lists, which is the conversion target.
 *
 * Safest means: a row that allows Baseline only comes first, then the row with the smallest picture
 * area, then the one that lists the fewest profiles. On the nano 7G that picks the Baseline-only
 * 640x480 row, which sits inside the other H.264 row too. A row that lists none of Baseline, Main
 * or High cannot be encoded to, so it is skipped. Null when the model lists no usable H.264 row.
 */
export function safestH264(device: DeviceModel): H264Choice | null {
  const choices: H264Choice[] = [];
  for (const format of device.media?.video?.formats ?? []) {
    if (format.codec !== 'h264') continue;
    const names = format.profiles.map((profile) => normalizeProfile(profile));
    const profile: H264Profile | null = names.includes('baseline') ? 'baseline' : names.includes('main') ? 'main' : names.includes('high') ? 'high' : null;
    if (profile) choices.push({ format, profile });
  }
  const rank = (choice: H264Choice): [number, number, number] => [
    choice.format.profiles.every((profile) => normalizeProfile(profile) === 'baseline') ? 0 : 1,
    choice.format.maxWidth * choice.format.maxHeight,
    choice.format.profiles.length,
  ];
  choices.sort((a, b) => {
    const left = rank(a);
    const right = rank(b);
    return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
  });
  return choices[0] ?? null;
}
