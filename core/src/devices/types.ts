/**
 * Device registry types.
 *
 * One registry describes every iPod model the project cares about: how it
 * connects, which database it uses, which checksum protects that database, and
 * what media it can play. Conversion profiles and the generated
 * docs/DEVICE-SUPPORT.md both come from this data, so nothing is typed twice.
 */

/**
 * How far a row can be trusted.
 * - hardware-tested: a sync was run on a real iPod of this model and recorded.
 * - spec-sourced: limits come from a published specification (see `sources`), but nothing was run on hardware.
 * - unverified: identity facts only, capability limits not filled in yet.
 */
export type Verification = 'hardware-tested' | 'spec-sourced' | 'unverified';

/** Checksum type libgpod uses to sign the iTunesDB. `null` on a model means not confirmed yet. */
export type Checksum = 'none' | 'hash58' | 'hash72' | 'hashAB';

export type Connector = 'firewire' | '30-pin' | 'lightning' | 'usb-integrated' | 'headphone-jack-usb';

export type DatabaseFormat = 'iTunesDB' | 'iTunesSD';

export type DeviceFamily = 'ipod' | 'photo' | 'video' | 'classic' | 'mini' | 'nano' | 'shuffle';

export type MediaKind = 'music' | 'video' | 'podcast' | 'audiobook' | 'photo' | 'notes';

/**
 * - supported: the specification lists it.
 * - not-listed: the specification was read and does not mention it. This is not proof it is absent.
 * - unknown: not researched yet.
 */
export type SupportStatus = 'supported' | 'not-listed' | 'unknown';

export interface Source {
  label: string;
  url: string;
  /** ISO date the page was read. */
  retrieved: string;
}

export interface AudioFormat {
  codec: string;
  bitrateKbps?: { min: number; max: number };
  variableBitrate?: boolean;
  /** Highest sample rate the model plays. Higher rates must be resampled first. */
  maxSampleRateHz?: number;
  /** Highest bit depth played without truncation. */
  maxBitDepth?: number;
  note?: string;
}

export interface VideoFormat {
  codec: 'h264' | 'mpeg4';
  profiles: string[];
  /** H.264 level, for example "3.0". */
  level?: string;
  maxWidth: number;
  maxHeight: number;
  maxFps: number;
  /** Omitted when the specification does not state a video bitrate. */
  maxVideoBitrateKbps?: number;
  audio: string;
  containers: string[];
}

export interface MediaSupport<Format = never> {
  status: SupportStatus;
  formats?: Format[];
  note?: string;
}

export interface DeviceMedia {
  music?: MediaSupport<AudioFormat>;
  video?: MediaSupport<VideoFormat>;
  podcast?: MediaSupport;
  audiobook?: MediaSupport;
  photo?: MediaSupport;
  notes?: MediaSupport;
}

export interface ImageFormat {
  /** libgpod's format id, which also names the .ithmb file the thumbnails live in. */
  id: number;
  width: number;
  height: number;
  /** Pixel layout, for example "L565" (16-bit RGB565, little-endian). */
  pixelFormat: string;
}

/**
 * Facts read from a device's own SysInfoExtended file, which an iPod uses to describe
 * itself. More precise than a marketing page, but only as good as the unit it came from.
 */
export interface DeviceDeclared {
  /** Where the file is, as a path in this repository. */
  source: string;
  /** Whose unit it came from and what is still unconfirmed. */
  note: string;
  volumeFormat?: 'FAT32' | 'HFS+';
  maxTracks?: number;
  maxFileSizeGB?: number;
  features?: Partial<Record<'podcasts' | 'photos' | 'voiceMemos' | 'playlistFolders' | 'genius', boolean>>;
  images?: { albumArt?: ImageFormat[]; photo?: ImageFormat[]; chapter?: ImageFormat[] };
}

export interface DeviceModel {
  /** Stable kebab-case id, for example "nano-7g". */
  id: string;
  name: string;
  family: DeviceFamily;
  /** Short generation label, for example "7G". */
  generation: string;
  /** Release years, coarse on purpose. */
  years: string;
  connector: Connector;
  databaseFormat: DatabaseFormat;
  checksum: Checksum | null;
  /** Where the checksum value came from, when it is not from a published spec. */
  checksumBasis?: string;
  /** What the model can play. `null` until researched. */
  media: DeviceMedia | null;
  /** What a unit of this model says about itself, when we have its SysInfoExtended. */
  deviceDeclared?: DeviceDeclared;
  verification: Verification;
  sources: Source[];
  notes: string[];
}
