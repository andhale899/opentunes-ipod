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
import { guessFromFolders, mergeMissingTags } from './folderRules';
import { coverFor, type OnlineCover } from './albumArt';

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
  /** True when `userKind` came from the folder names (Audiobooks, Podcasts ...) and the person has not changed it. */
  kindFromFolder?: boolean;
  /** Tags the file lacked that were filled from the folder and file names, such as "artist". */
  filledFromFolders?: string[];
  /** A cover picture (cover.jpg, folder.jpg ...) found in the file's folder or the one above it. Used only when the file has no cover inside. */
  folderCover?: { name: string; file: File };
  /** A cover found online and approved by the person. Used only when the file and its folder have none. */
  onlineCover?: OnlineCover;
}

let counter = 0;

/**
 * What the converter cannot read, whatever the iPod needs. The planner only knows the iPod, so
 * this turns a "convert" it cannot carry out into a plain "not supported" before anything runs.
 * The ffmpeg inside the page has no AV1 decoder: it stops with "Missing Sequence Header".
 */
export function limitedByConverter(info: MediaInfo, decision: PlanDecision): PlanDecision {
  if (decision.action === 'convert' && info.video?.codec === 'av1') {
    return {
      ...decision,
      action: 'unsupported',
      conversion: null,
      outputExtension: '',
      reasons: ['This video is AV1, which the converter inside this page cannot decode yet. Convert it to H.264 with another tool first, or use a copy in H.264, HEVC or VP9.'],
    };
  }
  return decision;
}

/**
 * Reads a picked file's tags and streams and decides, for one model, what to do with it.
 * `folders` is the file's folder path inside a chosen folder, starting with the chosen folder's own
 * name. When it names a kind (Audiobooks, Podcasts ...) that becomes the file's `userKind`, and tags
 * the file lacks are filled from the folder and file names, see folderRules.ts. The tags in the
 * file always win, and the person can still change the kind.
 */
export async function inspectFile(
  file: File,
  device: DeviceModel,
  userKind?: ContentKind,
  folder = '',
  folders?: string[],
  folderCover?: { name: string; file: File },
  signal?: AbortSignal,
): Promise<Candidate> {
  signal?.throwIfAborted();
  const probed = await probeMedia(fileSourceFromBlob(file.name, file));
  let info = probed;
  let kind = userKind;
  let kindFromFolder = false;
  let filledFromFolders: string[] | undefined;
  if (folders) {
    const guess = guessFromFolders(folders, file.name, probed.tags, { hasVideo: probed.video !== null });
    const merged = mergeMissingTags(probed.tags, guess.tags);
    if (merged.filled.length) {
      info = { ...probed, tags: merged.tags };
      filledFromFolders = merged.filled;
    }
    if (!kind && guess.kind) {
      kind = guess.kind;
      kindFromFolder = true;
    }
  }
  const decision = limitedByConverter(info, decideForDevice(info, device, { userKind: kind }));
  counter += 1;
  return {
    id: `file-${counter}`, file, info, decision, userKind: kind, estimatedBytes: estimateOutputBytes(info, decision), folder, kindFromFolder, filledFromFolders,
    ...(folderCover ? { folderCover } : {}),
  };
}

/** Decides again, for another model or after the person named the kind. Does not read the file again. */
export function redecide(candidate: Candidate, device: DeviceModel, userKind: ContentKind | undefined): Candidate {
  const decision = limitedByConverter(candidate.info, decideForDevice(candidate.info, device, { userKind }));
  return { ...candidate, decision, userKind, kindFromFolder: candidate.kindFromFolder && userKind === candidate.userKind, estimatedBytes: estimateOutputBytes(candidate.info, decision) };
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
  const { decision, file } = candidate;
  options.signal?.throwIfAborted();
  if (decision.action === 'unsupported') return null;
  const playlists = options.playlist ? [options.playlist] : undefined;
  const extension = decision.outputExtension.replace(/^\./, '');
  // The cover the file has inside, else a picture from its folder, else one found online. A picture
  // that cannot be read (a damaged cover.jpg) is left off rather than stopping the file.
  let artwork = candidate.info.artwork;
  try {
    artwork = await coverFor(candidate);
  } catch {
    artwork = null;
  }
  const info: MediaInfo = { ...candidate.info, artwork };

  if (decision.action === 'copy') {
    return { id: candidate.id, kind: decision.kind, data: syncDataFromBlob(file), extension, info, name: file.name, playlists };
  }

  if (!decision.conversion) return null;
  // Loaded when first needed, so a page that only copies files never fetches the converter.
  const { convertMedia } = await import('./convert');
  const converted = await convertMedia({ name: file.name, blob: file }, decision.conversion, {
    onProgress: options.onProgress,
    signal: options.signal,
    artwork: candidate.info.artwork,
  });
  const after = await probeMedia(fileSourceFromBytes(converted.fileName, converted.bytes));
  // A field the converter could not carry is filled from the original, and the fields that say which
  // song this is always come from the original, so the duplicate check made before converting still holds.
  const merged: MediaInfo = { ...after, tags: mergeConvertedTags(info.tags, after.tags), artwork: after.artwork ?? info.artwork };
  return { id: candidate.id, kind: decision.kind, data: syncDataFromBytes(converted.bytes), extension, info: merged, name: file.name, playlists };
}

/** The tags that decide whether a file is the same song, episode or title as another. */
const IDENTITY_TAGS = ['title', 'artist', 'album', 'show', 'season', 'episode'] as const;

/**
 * The tags of a converted file: what the converter carried over, with the original's tags over them.
 * The tags that make up a file's identity (title, artist, album, show, season, episode) are taken from
 * the original alone, which is also what the check for duplicates before converting read. Converting
 * can therefore never change whether a file counts as a duplicate through its tags.
 */
export function mergeConvertedTags(original: MediaInfo['tags'], converted: MediaInfo['tags']): MediaInfo['tags'] {
  const merged: Record<string, unknown> = { ...converted, ...original };
  for (const key of IDENTITY_TAGS) {
    if (original[key] === undefined) delete merged[key];
  }
  return merged as MediaInfo['tags'];
}

/** Files that travel with music in a folder and are not media. */
const NOT_MEDIA = /\.(jpe?g|png|gif|bmp|webp|heic|tiff?|txt|nfo|log|cue|m3u8?|pls|ini|db|ds_store|sfv|md5|url|lnk|xml|json|html?|css|js|zip|rar|7z|dmg|exe|app)$/i;
export const isNotMedia = (name: string): boolean => name.startsWith('.') || name.startsWith('~') || NOT_MEDIA.test(name);
