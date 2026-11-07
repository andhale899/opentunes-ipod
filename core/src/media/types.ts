/**
 * The shared shapes of the media pipeline: what a probed file looks like, what the planner
 * decides about it, and what the converter is asked to produce.
 *
 * Each stage is built and tested on its own against these types, so they are the contract
 * between the parts. docs/FULL-BUILD.md says who owns which part.
 */

/** What an item becomes on the iPod. Same names as the engine's `Kind`. */
export type ContentKind = 'music' | 'movie' | 'music-video' | 'tv-show' | 'podcast' | 'video-podcast' | 'audiobook';

export type MediaContainer = 'mp3' | 'aac' | 'm4a' | 'm4b' | 'm4v' | 'mp4' | 'mov' | 'flac' | 'wav' | 'aiff' | 'ogg' | 'opus' | 'wma' | 'mkv' | 'webm' | 'avi' | 'unknown';

export type AudioCodec = 'mp3' | 'aac' | 'he-aac' | 'alac' | 'pcm' | 'flac' | 'vorbis' | 'opus' | 'wma' | 'ac3' | 'eac3' | 'dts' | 'unknown';

export type VideoCodec = 'h264' | 'mpeg4' | 'hevc' | 'mpeg2' | 'vp8' | 'vp9' | 'av1' | 'unknown';

export interface AudioStream {
  codec: AudioCodec;
  sampleRateHz: number;
  channels: number;
  /** Null when the file does not say and it cannot be worked out. */
  bitrateKbps: number | null;
  variableBitrate?: boolean;
  /** For PCM and lossless audio. */
  bitDepth?: number;
}

export interface VideoStream {
  codec: VideoCodec;
  /** For example "Baseline", "Main", "High". */
  profile?: string;
  /** For example "3.0". */
  level?: string;
  width: number;
  height: number;
  fps: number | null;
  bitrateKbps: number | null;
}

/** What the tags say. Every field is optional because most files lack most of them. */
export interface MediaTags {
  title?: string;
  artist?: string;
  album?: string;
  albumArtist?: string;
  genre?: string;
  composer?: string;
  comment?: string;
  grouping?: string;
  description?: string;
  year?: number;
  trackNumber?: number;
  trackTotal?: number;
  discNumber?: number;
  discTotal?: number;
  bpm?: number;
  compilation?: boolean;
  lyrics?: string;
  /** TV shows. */
  show?: string;
  season?: number;
  episode?: number;
  /** An episode id such as "S02E05", when the file has one. */
  episodeId?: string;
  network?: string;
  /** Podcasts. */
  podcastCategory?: string;
  podcastFeedUrl?: string;
  podcastEpisodeUrl?: string;
  /** What the file itself claims to be, when it says (for example the MP4 "stik" atom or an Audiobook genre). */
  declaredKind?: ContentKind;
}

export interface Chapter {
  startMs: number;
  title: string;
}

export interface Artwork {
  mime: string;
  data: Uint8Array;
}

export interface MediaInfo {
  fileName: string;
  sizeBytes: number;
  container: MediaContainer;
  durationMs: number | null;
  audio: AudioStream | null;
  video: VideoStream | null;
  tags: MediaTags;
  chapters: Chapter[];
  artwork: Artwork | null;
  /** True for files the iPod cannot play and no converter can open (for example FairPlay). */
  protected: boolean;
  /** Plain sentences about anything odd the parser noticed. Never throws for a damaged file: it says so here. */
  warnings: string[];
}

/** Something a file can be read from in pieces, so a large file never has to be loaded whole. */
export interface FileSource {
  name: string;
  size: number;
  /** Bytes from `start` up to but not including `end`. Shorter at the end of the file. */
  slice(start: number, end: number): Promise<Uint8Array>;
}

export type PlanAction = 'copy' | 'convert' | 'unsupported';

export interface AudioTarget {
  codec: 'aac' | 'alac';
  bitrateKbps?: number;
  sampleRateHz?: number;
  channels?: 1 | 2;
}

export interface VideoTarget {
  codec: 'h264';
  profile: 'baseline' | 'main' | 'high';
  level: string;
  maxWidth: number;
  maxHeight: number;
  maxFps: number;
  maxBitrateKbps: number;
}

/** What the converter is asked to produce. Built by the planner from the device registry. */
export interface ConversionSpec {
  container: 'm4a' | 'm4b' | 'm4v';
  audio: AudioTarget | null;
  video: VideoTarget | null;
  keepChapters: boolean;
  keepArtwork: boolean;
  keepTags: boolean;
}

export interface PlanDecision {
  action: PlanAction;
  /** Plain sentences that say why, for showing to the person. */
  reasons: string[];
  kind: ContentKind;
  conversion: ConversionSpec | null;
  /** The extension the file will have on the iPod, with the dot, for example ".m4a". */
  outputExtension: string;
}
