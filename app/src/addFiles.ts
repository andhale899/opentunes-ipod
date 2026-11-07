import {
  decideForDevice,
  estimateOutputBytes,
  fileSourceFromBlob,
  fileSourceFromBytes,
  probeMedia,
  type ContentKind,
  type DeviceModel,
  type MediaInfo,
  type PlanDecision,
} from '@opentunes/core';
import { syncDataFromBlob, syncDataFromBytes, type SyncItem } from '@opentunes/engine';

/** A file the person picked, what it is, and what will be done with it. */
export interface Candidate {
  id: string;
  file: File;
  info: MediaInfo;
  decision: PlanDecision;
  /** What the person said the file is, if they overrode the guess. */
  userKind?: ContentKind;
  /** Bytes it will take on the iPod, or null when it cannot be told. */
  estimatedBytes: number | null;
  /** The folder it came from inside a chosen folder, such as "Album / Disc 2", or empty. */
  folder: string;
}

let counter = 0;

/** Reads a picked file's tags and streams and decides, for one model, what to do with it. */
export async function inspectFile(file: File, device: DeviceModel, userKind?: ContentKind, folder = ''): Promise<Candidate> {
  const info = await probeMedia(fileSourceFromBlob(file.name, file));
  const decision = decideForDevice(info, device, { userKind });
  counter += 1;
  return { id: `file-${counter}`, file, info, decision, userKind, estimatedBytes: estimateOutputBytes(info, decision), folder };
}

/** Decides again, for another model or after the person named the kind. Does not read the file again. */
export function redecide(candidate: Candidate, device: DeviceModel, userKind: ContentKind | undefined): Candidate {
  const decision = decideForDevice(candidate.info, device, { userKind });
  return { ...candidate, decision, userKind, estimatedBytes: estimateOutputBytes(candidate.info, decision) };
}

export interface PrepareOptions {
  /** The playlist to put every new track in. */
  playlist?: string;
  /** Called with a fraction of this one file (0 to 1) and a message while it converts. */
  onProgress?: (fraction: number, message?: string) => void;
  signal?: AbortSignal;
}

/**
 * Turns a candidate into the item the sync takes. A file the iPod plays as it is is read straight
 * from the picked file, a piece at a time. Anything else is converted first, and the converted
 * file is probed again so the database describes what is really on the iPod.
 * Returns null for a file that cannot be added.
 */
export async function prepareItem(candidate: Candidate, options: PrepareOptions = {}): Promise<SyncItem | null> {
  const { decision, info, file } = candidate;
  if (decision.action === 'unsupported') return null;
  const playlists = options.playlist ? [options.playlist] : undefined;
  const extension = decision.outputExtension.replace(/^\./, '');

  if (decision.action === 'copy') {
    return { id: candidate.id, kind: decision.kind, data: syncDataFromBlob(file), extension, info, name: file.name, playlists };
  }

  if (!decision.conversion) return null;
  // Loaded when first needed, so a page that only copies files never fetches the converter.
  const { convertMedia } = await import('./convert');
  const converted = await convertMedia({ name: file.name, blob: file }, decision.conversion, {
    onProgress: options.onProgress,
    signal: options.signal,
    artwork: info.artwork,
  });
  const after = await probeMedia(fileSourceFromBytes(converted.fileName, converted.bytes));
  // The converter keeps the tags it was given, but a field it could not carry is filled from the original.
  const merged: MediaInfo = { ...after, tags: { ...info.tags, ...after.tags }, artwork: after.artwork ?? info.artwork };
  return { id: candidate.id, kind: decision.kind, data: syncDataFromBytes(converted.bytes), extension, info: merged, name: file.name, playlists };
}

/** Files that travel with music in a folder and are not media. */
const NOT_MEDIA = /\.(jpe?g|png|gif|bmp|webp|heic|tiff?|txt|nfo|log|cue|m3u8?|pls|ini|db|ds_store|sfv|md5|url|lnk|xml|json|html?|css|js|zip|rar|7z|dmg|exe|app)$/i;
export const isNotMedia = (name: string): boolean => name.startsWith('.') || name.startsWith('~') || NOT_MEDIA.test(name);
