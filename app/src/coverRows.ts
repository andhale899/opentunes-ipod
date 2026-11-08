/**
 * What the Add music list says about each file's cover, which buttons a row gets, how a picture the
 * person chose is read and checked, and how it is shared between the files of one album. Pure
 * functions over the list of candidates, so the page only draws what they return.
 *
 * A row's cover, in order: the picture the person chose (only ever set on a row with no cover, or
 * after "Replace the cover"), the one inside the file, one in its folder, one found online and
 * approved. See albumArt.ts for the order and docs/ART-LOOKUP.md for the whole picture.
 */
import { MAX_ARTWORK_BYTES, type ContentKind } from '@opentunes/core';
import { MAX_SOURCE_PIXELS } from '@opentunes/engine';
import type { Candidate } from './addFiles';
import { albumKey, albumRefOf, coverSource, type AlbumRef, type ChosenCover, type CoverSource, songKey, type SongRef } from './albumArt';
import { decodePictureDetailed, type DecodeResult } from './artDecode';

const VIDEO_KINDS: ContentKind[] = ['movie', 'tv-show', 'music-video', 'video-podcast'];

/** A row that can have a cover: not unsupported, not left out as a duplicate, and not video. Other rows say nothing about covers. */
export function canTakeArt(candidate: Candidate, skipped: boolean): boolean {
  return candidate.decision.action !== 'unsupported' && !skipped && !VIDEO_KINDS.includes(candidate.decision.kind);
}

export type CoverLineKind = CoverSource['from'];

export interface CoverLine {
  kind: CoverLineKind;
  /** The words on the row. */
  text: string;
  /** A symbol shown with the words, so the state never depends on colour alone. Hidden from screen readers, the words say it. */
  icon: string;
}

/** The "Cover:" line of a row, or null when the row cannot take art. */
export function coverLine(candidate: Candidate, skipped: boolean): CoverLine | null {
  if (!canTakeArt(candidate, skipped)) return null;
  const source = coverSource(candidate);
  switch (source.from) {
    case 'file':
      return { kind: 'file', text: 'Cover: from the file', icon: '✓' };
    case 'folder':
      return { kind: 'folder', text: `Cover: from the folder (${source.name})`, icon: '✓' };
    case 'online':
      return { kind: 'online', text: 'Cover: found online', icon: '✓' };
    case 'chosen':
      return { kind: 'chosen', text: 'Cover: from the picture you chose', icon: '✓' };
    default:
      return { kind: 'none', text: 'No cover', icon: '✕' };
  }
}

// ---------------------------------------------------------------- what can be looked up

const clean = (text: string | undefined): string => (text ?? '').replace(/\s+/g, ' ').trim();
const withoutExtension = (name: string): string => name.replace(/\.[A-Za-z0-9]{1,5}$/, '');
const TRACK_PREFIX = /^\d{1,3}(?:\s*[-._)]\s*|\s+)(?=\S)/;
/** File names that say nothing about the song. */
const EMPTY_NAME = /^(?:track|audio|untitled|unknown|recording|new recording|voice|file|song|disc|cd)[\s_-]*\d*$/i;

/**
 * A guess at the artist and title from a file name such as "Radiohead - Karma Police.mp3" (a leading
 * track number is dropped). Only the title when there is no " - ". Null for a name that tells nothing,
 * such as "Track 01.mp3". The person has to accept a guess before it is used.
 */
export function guessFromFileName(fileName: string): { title: string; artist: string } | null {
  const base = clean(withoutExtension(fileName).replace(/_/g, ' ').replace(TRACK_PREFIX, ''));
  if (!base || !/\p{L}/u.test(base) || EMPTY_NAME.test(base)) return null;
  const split = /^(.+?)\s+[-–]\s+(.+)$/.exec(base);
  if (split) return { artist: clean(split[1]), title: clean(split[2]) };
  return { artist: '', title: base };
}

/** How a file with no cover can be looked up online, or why it cannot. */
export type LookupFor =
  | { kind: 'album'; ref: AlbumRef }
  | { kind: 'song'; ref: SongRef; /** Words for the row: why a title is used and how sure it can be. */ note: string }
  | { kind: 'guess'; guess: { title: string; artist: string } }
  | { kind: 'none'; reason: string };

export const NO_LOOKUP = 'This file has no album name and no song title, so it cannot be looked up. Choose a picture, or add the album name in the Library after adding.';

/**
 * What the finder can do for a row: look its album up (it has an artist and an album name), look the
 * song up by title and artist (no album name), offer a guess from the file name that the person can
 * accept, or nothing. `acceptedGuess` is true when the person accepted the file-name guess for it.
 */
export function lookupFor(candidate: Candidate, acceptedGuess: boolean): LookupFor {
  const tags = candidate.info.tags;
  const album = albumRefOf(tags);
  if (album) return { kind: 'album', ref: album };
  const title = clean(tags.title);
  const artist = clean(tags.albumArtist) || clean(tags.artist);
  const lengthMs = candidate.info.durationMs;
  if (title) {
    const ref: SongRef = { title, artist, lengthMs, fromFileName: false };
    const why = clean(tags.album) ? 'This file has an album name but no artist' : 'This file has no album name';
    return {
      kind: 'song',
      ref,
      note: artist ? `${why}, so it is looked up by its song title and artist instead. That is less certain than an album.` : `${why} and no artist, so it can only be looked up by its song title. A match will be marked low confidence and is never ticked for you.`,
    };
  }
  const guess = guessFromFileName(candidate.file.name);
  if (!guess) return { kind: 'none', reason: NO_LOOKUP };
  const guessed = { title: guess.title, artist: guess.artist || artist };
  if (!acceptedGuess) return { kind: 'guess', guess: guessed };
  return {
    kind: 'song',
    ref: { title: guessed.title, artist: guessed.artist, lengthMs, fromFileName: true },
    note: `Looked up as "${guessed.title}"${guessed.artist ? ` by ${guessed.artist}` : ''}, guessed from the file name.`,
  };
}

/** The file-name guess in words: "Karma Police" by Radiohead. */
export const describeGuess = (guess: { title: string; artist: string }): string => `"${guess.title}"${guess.artist ? ` by ${guess.artist}` : ''}`;

export interface AlbumWork {
  key: string;
  ref: AlbumRef;
  tracks: number;
  ids: string[];
}
export interface SongWork {
  key: string;
  ref: SongRef;
  tracks: number;
  ids: string[];
}

export interface CoverWork {
  /** Albums with no cover and an artist and album name, one entry per album. */
  albums: AlbumWork[];
  /** Songs with no cover and no album name that have a title (from the tags, or a guess the person accepted), one entry per song. */
  songs: SongWork[];
  /** Files with no cover and only a guess from the file name, which the person has not accepted. */
  offers: number;
  /** Files with no cover that cannot be looked up at all. */
  unlookable: number;
  /** All files with no cover that can take one. */
  noCover: number;
}

/** What the files that have no cover need, for the summary above the list and for the finder. Rows left out as duplicates and rows that cannot take art are not counted. */
export function coverWork(candidates: Candidate[], skipped: ReadonlySet<string>, guesses: ReadonlySet<string> = new Set()): CoverWork {
  const albums = new Map<string, AlbumWork>();
  const songs = new Map<string, SongWork>();
  const work: CoverWork = { albums: [], songs: [], offers: 0, unlookable: 0, noCover: 0 };
  for (const candidate of candidates) {
    if (!canTakeArt(candidate, skipped.has(candidate.id)) || coverSource(candidate).from !== 'none') continue;
    work.noCover += 1;
    const how = lookupFor(candidate, guesses.has(candidate.id));
    if (how.kind === 'album') {
      const key = albumKey(how.ref);
      const known = albums.get(key);
      if (known) {
        known.tracks += 1;
        known.ids.push(candidate.id);
      } else albums.set(key, { key, ref: how.ref, tracks: 1, ids: [candidate.id] });
    } else if (how.kind === 'song') {
      const key = songKey(how.ref);
      const known = songs.get(key);
      if (known) {
        known.tracks += 1;
        known.ids.push(candidate.id);
      } else songs.set(key, { key, ref: how.ref, tracks: 1, ids: [candidate.id] });
    } else if (how.kind === 'guess') work.offers += 1;
    else work.unlookable += 1;
  }
  work.albums = [...albums.values()];
  work.songs = [...songs.values()];
  return work;
}

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

/** The one line above the list. Null when there is nothing to say. */
export function coverSummary(putArt: boolean, work: CoverWork): string | null {
  if (!putArt) return 'Covers are off, so no pictures will be put on the iPod.';
  if (!work.noCover) return null;
  const parts: string[] = [];
  if (work.albums.length) parts.push(`${plural(work.albums.length, 'album has', 'albums have')} no cover.`);
  if (work.songs.length) parts.push(`${plural(work.songs.length, 'song', 'songs')} with no album name can be looked up by title.`);
  if (work.offers) parts.push(`${plural(work.offers, 'file', 'files')} with no tags can be looked up from a guess at the file name that you accept.`);
  if (work.unlookable) {
    parts.push(`${plural(work.unlookable, 'file', 'files')} cannot be looked up because ${work.unlookable === 1 ? 'it has' : 'they have'} no album name, song title or usable file name. You can choose a picture for ${work.unlookable === 1 ? 'it' : 'them'}.`);
  }
  return parts.join(' ');
}

// ---------------------------------------------------------------- buttons on a row

export interface RowActions {
  /** "Find a cover online": the row can be looked up (an album, a song, or a file-name guess already accepted). */
  find: boolean;
  /** "Choose a picture...": the row has no cover. */
  choose: boolean;
  /** "Replace the cover": the row has a cover from the file, the folder or online, and the person may swap it. */
  replace: boolean;
  /** "Choose a different picture" and "Remove the picture I chose": the row has a picture the person chose. */
  change: boolean;
  /** "Use the file name as a guess": a guess is on offer, not yet accepted. */
  offerGuess: boolean;
  /** "Do not use the guess": a guess was accepted. */
  withdrawGuess: boolean;
  /** Plain words on the row about why it cannot be looked up, or what will be looked up. Empty when there is nothing to say. */
  note: string;
}

const NONE: RowActions = { find: false, choose: false, replace: false, change: false, offerGuess: false, withdrawGuess: false, note: '' };

/** The buttons and the note of a row. A row that cannot take art gets none. */
export function rowActions(candidate: Candidate, skipped: boolean, acceptedGuess: boolean): RowActions {
  if (!canTakeArt(candidate, skipped)) return NONE;
  const from = coverSource(candidate).from;
  if (from === 'chosen') return { ...NONE, change: true };
  if (from !== 'none') return { ...NONE, replace: true };
  const how = lookupFor(candidate, acceptedGuess);
  if (how.kind === 'album') return { ...NONE, find: true, choose: true };
  if (how.kind === 'song') return { ...NONE, find: true, choose: true, withdrawGuess: how.ref.fromFileName, note: how.note };
  if (how.kind === 'guess') return { ...NONE, choose: true, offerGuess: true, note: `No title or album in this file. The file name looks like ${describeGuess(how.guess)}.` };
  return { ...NONE, choose: true, note: how.reason };
}

// ---------------------------------------------------------------- a picture the person chose

/** The same limit as a cover read from inside a file. */
export const MAX_CHOSEN_PICTURE_BYTES = MAX_ARTWORK_BYTES;

/** What a picture really is, from its first bytes: JPEG, PNG or WebP (when Chrome decodes it). Null for anything else. */
export function sniffChosenPicture(data: Uint8Array): string | null {
  if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length > 7 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png';
  const ascii = (at: number, text: string): boolean => [...text].every((character, index) => data[at + index] === character.charCodeAt(0));
  if (data.length > 12 && ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  return null;
}

export type ChosenResult = { ok: true; cover: ChosenCover } | { ok: false; message: string };

const megabytes = (bytes: number): string => `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;

/**
 * Reads and checks a picture the person chose: a size limit before it is read, its first bytes (not
 * its name) say JPEG, PNG or WebP, and then the browser's own decoder must read it within the pixel
 * limit the sync has. The same decoder and limits as a cover found inside a file. Says in plain words
 * why a picture is refused.
 */
export async function readChosenPicture(
  file: { name: string; size: number; arrayBuffer(): Promise<ArrayBuffer> },
  decode: (picture: { mime: string; data: Uint8Array }) => Promise<DecodeResult> = decodePictureDetailed,
): Promise<ChosenResult> {
  const no = (message: string): ChosenResult => ({ ok: false, message });
  if (file.size === 0) return no(`"${file.name}" is empty, so it was not used.`);
  if (file.size > MAX_CHOSEN_PICTURE_BYTES) return no(`"${file.name}" is ${megabytes(file.size)}, more than the ${megabytes(MAX_CHOSEN_PICTURE_BYTES)} a cover picture can be, so it was not used. Choose a smaller picture.`);
  let data: Uint8Array;
  try {
    data = new Uint8Array(await file.arrayBuffer());
  } catch {
    return no(`"${file.name}" could not be read, so it was not used.`);
  }
  const mime = sniffChosenPicture(data);
  if (!mime) return no(`"${file.name}" is not a JPEG, PNG or WebP picture, so it was not used.`);
  const decoded = await decode({ mime, data });
  if (!decoded.ok) {
    return decoded.reason === 'too-large'
      ? no(`"${file.name}" is ${decoded.width.toLocaleString('en-US')} x ${decoded.height.toLocaleString('en-US')} pixels, more than the ${MAX_SOURCE_PIXELS.toLocaleString('en-US')} pixels that can be used, so it was not used. Choose a smaller picture.`)
      : no(`Chrome could not read "${file.name}" as a picture, so it was not used.`);
  }
  return { ok: true, cover: { mime, data, name: file.name } };
}

// ---------------------------------------------------------------- one picture for the files of an album

/**
 * The rows that get a chosen picture when "Use this picture for all N files of this album" is on: the
 * row itself, and every other row of the same album (same artist and album name, up to case and
 * spacing) that can take art, is not left out as a duplicate, and has no cover yet. A row that already
 * has a cover keeps it. A row with no album name is its own album.
 */
export function albumGroupTargets(candidates: Candidate[], id: string, skipped: ReadonlySet<string>): string[] {
  const row = candidates.find((candidate) => candidate.id === id);
  if (!row) return [];
  const ref = albumRefOf(row.info.tags);
  if (!ref) return [id];
  const key = albumKey(ref);
  return candidates
    .filter((candidate) => {
      if (candidate.id === id) return true;
      const other = albumRefOf(candidate.info.tags);
      return !!other && albumKey(other) === key && canTakeArt(candidate, skipped.has(candidate.id)) && coverSource(candidate).from === 'none';
    })
    .map((candidate) => candidate.id);
}

/**
 * Gives a chosen picture to a row, and to the other files of its album when `all` is true and the row
 * had no cover. The same bytes go to each, so the writer, which keeps one image per picture, stores it once.
 */
export function applyChosenPicture(candidates: Candidate[], id: string, cover: ChosenCover, options: { all: boolean; skipped: ReadonlySet<string> }): Candidate[] {
  const row = candidates.find((candidate) => candidate.id === id);
  if (!row) return candidates;
  const targets = new Set(options.all && coverSource(row).from === 'none' ? albumGroupTargets(candidates, id, options.skipped) : [id]);
  return candidates.map((candidate) => (targets.has(candidate.id) ? { ...candidate, chosenCover: cover } : candidate));
}

/** Takes a chosen picture back off a row, so it has what it had before: its own cover, or none. */
export function removeChosenPicture(candidates: Candidate[], id: string): Candidate[] {
  return candidates.map((candidate) => {
    if (candidate.id !== id || !candidate.chosenCover) return candidate;
    const { chosenCover: _gone, ...rest } = candidate;
    return rest;
  });
}
