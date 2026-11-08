/**
 * Where a track's album art comes from, and the small rules for finding a cover picture that
 * sits next to music in a folder. Pure functions, no browser needed.
 *
 * A track's cover, in order: the picture inside the file itself, then a cover picture in the
 * file's folder (or the folder above it), then one the person approved from the online lookup.
 * The first one that exists is used. Nothing here reads or writes the iPod.
 */

import type { Artwork, MediaInfo } from '@opentunes/core';

/** The picture file names that count as a folder's cover, best first. Matched without regard to case. */
export const FOLDER_COVER_NAMES = ['cover', 'folder', 'front', 'album', 'albumart'] as const;
const FOLDER_COVER_EXTENSIONS = ['jpg', 'jpeg', 'png'] as const;

/** How well a file name fits as a folder's cover: 0 is best, null is not a cover name at all. */
export function folderCoverRank(fileName: string): number | null {
  const match = /^(.+)\.([^.]+)$/.exec(fileName.trim());
  if (!match) return null;
  const base = (match[1] as string).toLowerCase();
  const extension = (match[2] as string).toLowerCase();
  const name = FOLDER_COVER_NAMES.indexOf(base as (typeof FOLDER_COVER_NAMES)[number]);
  const kind = FOLDER_COVER_EXTENSIONS.indexOf(extension as (typeof FOLDER_COVER_EXTENSIONS)[number]);
  if (name < 0 || kind < 0) return null;
  return name * FOLDER_COVER_EXTENSIONS.length + kind;
}

/** The best cover file among the names given, or null when none is called a cover name. */
export function pickFolderCover<T>(files: Map<string, T>): { name: string; file: T } | null {
  let best: { name: string; file: T; rank: number } | null = null;
  for (const [name, file] of files) {
    const rank = folderCoverRank(name);
    if (rank !== null && (!best || rank < best.rank)) best = { name, file, rank };
  }
  return best ? { name: best.name, file: best.file } : null;
}

/**
 * The cover picture for a file inside a chosen folder: the one in its own folder, otherwise the
 * one in the folder above (an album with Disc 1 and Disc 2 folders keeps one cover at the top).
 * `byFolder` maps a folder, as its path parts joined with "/", to the picture files in it.
 * Only the file's own folder and its parent are looked in, so a cover at the top of a whole
 * library is not given to every album below it.
 */
export function findFolderCover<T>(parts: string[], byFolder: Map<string, Map<string, T>>): { name: string; file: T } | null {
  const own = byFolder.get(parts.join('/'));
  const found = own ? pickFolderCover(own) : null;
  if (found || parts.length === 0) return found;
  const above = byFolder.get(parts.slice(0, -1).join('/'));
  return above ? pickFolderCover(above) : null;
}

/** "image/jpeg" or "image/png" from a picture's file name, or null for anything else. */
export function pictureMime(fileName: string): string | null {
  const extension = /\.([^.]+)$/.exec(fileName)?.[1]?.toLowerCase();
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
  if (extension === 'png') return 'image/png';
  return null;
}

/** What the picture bytes really are, from their first bytes, or null when not a JPEG or PNG. */
export function sniffPicture(data: Uint8Array): string | null {
  if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length > 7 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png';
  return null;
}

/** A cover found online and approved by the person. */
export interface OnlineCover {
  mime: string;
  data: Uint8Array;
  /** The MusicBrainz release it came from, so the person can look it up. */
  releaseId: string;
}

/** A picture the person chose from their own files for a row. Read and checked when it was chosen. */
export interface ChosenCover {
  mime: string;
  data: Uint8Array;
  /** The picture's file name, for the row. */
  name: string;
}

/** What a track's cover will be and where it comes from, for showing in the list. */
export type CoverSource = { from: 'file' } | { from: 'folder'; name: string } | { from: 'online'; releaseId: string } | { from: 'chosen'; name: string } | { from: 'none' };

export interface CoverCandidate {
  info: Pick<MediaInfo, 'artwork'>;
  folderCover?: { name: string; file: { arrayBuffer(): Promise<ArrayBuffer> } } | undefined;
  onlineCover?: OnlineCover | undefined;
  /** A picture the person chose. It is only ever set on a row with no cover, or after "Replace the cover", so it wins over the rest. */
  chosenCover?: ChosenCover | undefined;
}

export function coverSource(candidate: CoverCandidate): CoverSource {
  if (candidate.chosenCover) return { from: 'chosen', name: candidate.chosenCover.name };
  if (candidate.info.artwork) return { from: 'file' };
  if (candidate.folderCover) return { from: 'folder', name: candidate.folderCover.name };
  if (candidate.onlineCover) return { from: 'online', releaseId: candidate.onlineCover.releaseId };
  return { from: 'none' };
}

/** The picture a track will get, read from where it comes from. Null when it has none. */
export async function coverFor(candidate: CoverCandidate): Promise<Artwork | null> {
  if (candidate.chosenCover) return { mime: candidate.chosenCover.mime, data: candidate.chosenCover.data };
  if (candidate.info.artwork) return candidate.info.artwork;
  if (candidate.folderCover) {
    const data = new Uint8Array(await candidate.folderCover.file.arrayBuffer());
    const mime = sniffPicture(data) ?? pictureMime(candidate.folderCover.name);
    return mime ? { mime, data } : null;
  }
  return candidate.onlineCover ? { mime: candidate.onlineCover.mime, data: candidate.onlineCover.data } : null;
}

/** One album to look up: the artist and the album name, the only two things the lookup sends. */
export interface AlbumRef {
  artist: string;
  album: string;
}

const clean = (text: string | undefined): string => (text ?? '').replace(/\s+/g, ' ').trim();

/** The album a track belongs to, for the online lookup. Null when the tags do not name both an artist and an album. */
export function albumRefOf(tags: Pick<MediaInfo['tags'], 'artist' | 'albumArtist' | 'album'>): AlbumRef | null {
  const album = clean(tags.album);
  const artist = clean(tags.albumArtist) || clean(tags.artist);
  return album && artist ? { artist, album } : null;
}

/** The same album, spelled the same up to case and spacing, gets the same key. */
export const albumKey = (ref: AlbumRef): string => `${ref.artist.toLowerCase()}\u0000${ref.album.toLowerCase()}`;

/**
 * One song to look up when its file names no album: the title, the artist when there is one, and the
 * file's length, which is used on this computer to tell versions apart and is not sent anywhere.
 */
export interface SongRef {
  title: string;
  /** Empty when the file names no artist. A lookup without one is marked low confidence. */
  artist: string;
  lengthMs: number | null;
  /** True when the title and artist were guessed from the file name and the person accepted the guess. */
  fromFileName: boolean;
}

/** Two files of the same song (same title and artist, lengths in the same three-second step) get the same key. Only used to look a song up once; a near miss is looked up twice, which is harmless. */
export const songKey = (ref: SongRef): string => `${ref.title.toLowerCase()}\u0000${ref.artist.toLowerCase()}\u0000${ref.lengthMs === null ? 'x' : Math.round(ref.lengthMs / 3000)}`;
