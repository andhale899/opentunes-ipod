import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContentKind, MediaTags } from '@opentunes/core';
import { MAX_SOURCE_PIXELS } from '@opentunes/engine';
import type { Candidate } from '../src/addFiles';
import { coverFor, coverSource } from '../src/albumArt';
import { prepareItem } from '../src/addFiles';
import { decodePicture, decodePictureDetailed } from '../src/artDecode';
import {
  MAX_CHOSEN_PICTURE_BYTES,
  NO_LOOKUP,
  albumGroupTargets,
  applyChosenPicture,
  coverLine,
  coverSummary,
  coverWork,
  guessFromFileName,
  lookupFor,
  readChosenPicture,
  removeChosenPicture,
  rowActions,
  sniffChosenPicture,
} from '../src/coverRows';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0xff, 0xd9]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const WEBP = new Uint8Array([...'RIFF'].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 0], [...'WEBPVP8 '].map((c) => c.charCodeAt(0))));

interface Make {
  name?: string;
  tags?: MediaTags;
  kind?: ContentKind;
  unsupported?: boolean;
  artwork?: boolean;
  folderCover?: boolean;
  durationMs?: number | null;
}

let counter = 0;
function row(make: Make = {}): Candidate {
  counter += 1;
  return {
    id: `row-${counter}`,
    file: { name: make.name ?? `Some file ${counter}.mp3` } as File,
    info: { tags: make.tags ?? {}, artwork: make.artwork ? { mime: 'image/jpeg', data: JPEG } : null, durationMs: make.durationMs === undefined ? 200_000 : make.durationMs },
    decision: { action: make.unsupported ? 'unsupported' : 'copy', kind: make.kind ?? 'music', reasons: [], conversion: null, outputExtension: '.mp3' },
    estimatedBytes: 1,
    folder: '',
    ...(make.folderCover ? { folderCover: { name: 'cover.jpg', file: {} as File } } : {}),
  } as unknown as Candidate;
}

const album = (name: string, over: Make = {}): Candidate => row({ tags: { artist: 'Band', album: name, title: `Song ${counter}` }, ...over });
const none = new Set<string>();

describe('the Cover line of a row', () => {
  it('says where the cover comes from, in words and with a symbol', () => {
    expect(coverLine(album('A', { artwork: true }), false)).toMatchObject({ kind: 'file', text: 'Cover: from the file', icon: expect.any(String) });
    expect(coverLine(album('A', { folderCover: true }), false)).toMatchObject({ kind: 'folder', text: 'Cover: from the folder (cover.jpg)' });
    expect(coverLine({ ...album('A'), onlineCover: { mime: 'image/png', data: PNG, releaseId: 'r' } }, false)).toMatchObject({ kind: 'online', text: 'Cover: found online' });
    expect(coverLine({ ...album('A'), chosenCover: { mime: 'image/png', data: PNG, name: 'me.png' } }, false)).toMatchObject({ kind: 'chosen', text: 'Cover: from the picture you chose' });
    expect(coverLine(album('A'), false)).toMatchObject({ kind: 'none', text: 'No cover' });
  });

  it('has a symbol that differs between a cover and no cover, so colour is never the only sign', () => {
    expect(coverLine(album('A'), false)?.icon).not.toBe(coverLine(album('A', { artwork: true }), false)?.icon);
  });

  it('says nothing for unsupported files, video and duplicates that are left out', () => {
    expect(coverLine(album('A', { unsupported: true }), false)).toBeNull();
    for (const kind of ['movie', 'tv-show', 'music-video', 'video-podcast'] as const) expect(coverLine(album('A', { kind }), false), kind).toBeNull();
    expect(coverLine(album('A'), true)).toBeNull();
    expect(rowActions(album('A', { kind: 'movie' }), false, false)).toMatchObject({ find: false, choose: false, replace: false });
  });

  it('puts a chosen picture ahead of the file, the folder and an online cover, and hands that picture to the sync', async () => {
    const chosen = { mime: 'image/png', data: PNG, name: 'me.png' };
    const covered = { ...album('A', { artwork: true }), chosenCover: chosen };
    expect(coverSource(covered)).toEqual({ from: 'chosen', name: 'me.png' });
    expect(await coverFor(covered)).toEqual({ mime: 'image/png', data: PNG });
    expect(coverSource(album('A', { artwork: true }))).toEqual({ from: 'file' });
  });
});

describe('which buttons a row gets', () => {
  it('a file with no cover and an artist and album name: Find a cover online and Choose a picture', () => {
    expect(rowActions(album('Plain'), false, false)).toMatchObject({ find: true, choose: true, replace: false, change: false, offerGuess: false });
  });

  it('a file with no album name but a title is looked up by its title, and says so; no artist is flagged low confidence', () => {
    const withArtist = rowActions(row({ tags: { title: 'Karma Police', artist: 'Radiohead' } }), false, false);
    expect(withArtist).toMatchObject({ find: true, choose: true });
    expect(withArtist.note).toMatch(/no album name, so it is looked up by its song title and artist/);
    const noArtist = rowActions(row({ tags: { title: 'Karma Police' } }), false, false);
    expect(noArtist).toMatchObject({ find: true, choose: true });
    expect(noArtist.note).toMatch(/low confidence and is never ticked/);
  });

  it('a file with nothing to look up says so plainly and offers only Choose a picture', () => {
    const untagged = rowActions(row({ name: 'Track 1.wav' }), false, false);
    expect(untagged).toMatchObject({ find: false, choose: true, offerGuess: false, replace: false });
    expect(untagged.note).toBe(NO_LOOKUP);
    expect(NO_LOOKUP).toMatch(/no album name/);
    expect(NO_LOOKUP).toMatch(/cannot be looked up/);
    expect(NO_LOOKUP).toMatch(/Choose a picture/);
  });

  it('an untagged file with a readable name offers the guess, and Find only after it is accepted', () => {
    const file = row({ name: '03 Radiohead - Karma Police.mp3' });
    expect(rowActions(file, false, false)).toMatchObject({ find: false, choose: true, offerGuess: true });
    expect(rowActions(file, false, false).note).toContain('"Karma Police" by Radiohead');
    expect(rowActions(file, false, true)).toMatchObject({ find: true, choose: true, offerGuess: false, withdrawGuess: true });
  });

  it('a file that already has a cover from the file, the folder or online offers only Replace the cover', () => {
    expect(rowActions(album('A', { artwork: true }), false, false)).toMatchObject({ find: false, choose: false, replace: true });
    expect(rowActions(album('A', { folderCover: true }), false, false)).toMatchObject({ find: false, choose: false, replace: true });
    expect(rowActions({ ...album('A'), onlineCover: { mime: 'image/png', data: PNG, releaseId: 'r' } }, false, false)).toMatchObject({ replace: true, choose: false });
  });

  it('a file with a chosen picture offers a different one, or taking it back', () => {
    expect(rowActions({ ...album('A'), chosenCover: { mime: 'image/png', data: PNG, name: 'x.png' } }, false, false)).toMatchObject({ change: true, replace: false, choose: false, find: false });
  });
});

describe('guessing from a file name', () => {
  it('reads Artist - Title, drops a leading track number, and is only a guess', () => {
    expect(guessFromFileName('03 Radiohead - Karma Police.mp3')).toEqual({ artist: 'Radiohead', title: 'Karma Police' });
    expect(guessFromFileName('Radiohead - Karma Police - Live.flac')).toEqual({ artist: 'Radiohead', title: 'Karma Police - Live' });
    expect(guessFromFileName('Karma Police.mp3')).toEqual({ artist: '', title: 'Karma Police' });
    expect(guessFromFileName('02. Paranoid_Android.m4a')).toEqual({ artist: '', title: 'Paranoid Android' });
  });
  it('gives nothing for a name that says nothing', () => {
    for (const name of ['Track 1.wav', 'track01.mp3', 'Audio 12.m4a', 'Untitled.mp3', '12345.mp3', '01.mp3', '.mp3']) expect(guessFromFileName(name), name).toBeNull();
  });
});

describe('what the finder looks up for each row', () => {
  it('an album when the file has an artist and an album, a song when it has only a title, a guess when only the name helps', () => {
    expect(lookupFor(album('Plain'), false)).toMatchObject({ kind: 'album', ref: { artist: 'Band', album: 'Plain' } });
    expect(lookupFor(row({ tags: { title: 'T', artist: 'A' }, durationMs: 123_000 }), false)).toMatchObject({ kind: 'song', ref: { title: 'T', artist: 'A', lengthMs: 123_000, fromFileName: false } });
    expect(lookupFor(row({ name: 'A - T.mp3' }), false)).toMatchObject({ kind: 'guess', guess: { artist: 'A', title: 'T' } });
    expect(lookupFor(row({ name: 'A - T.mp3' }), true)).toMatchObject({ kind: 'song', ref: { artist: 'A', title: 'T', fromFileName: true } });
    expect(lookupFor(row({ name: 'Track 4.mp3' }), false)).toMatchObject({ kind: 'none' });
  });
  it('an album name without an artist falls back to the title', () => {
    expect(lookupFor(row({ tags: { album: 'Lonely', title: 'Song' } }), false)).toMatchObject({ kind: 'song', ref: { title: 'Song', artist: '' } });
  });
});

describe('the summary above the list', () => {
  it('counts albums with no cover, songs, guesses and files that cannot be looked up, without duplicates that are left out', () => {
    const a1 = album('One');
    const a2 = album('One');
    const a3 = album('Two');
    const a4 = album('Three');
    const dup = album('Four');
    const covered = album('Five', { artwork: true });
    const song = row({ tags: { title: 'Alone', artist: 'X' } });
    const guess = row({ name: 'X - Y.mp3' });
    const nothing = row({ name: 'Track 9.mp3' });
    const nothingElse = row({ name: 'Track 10.mp3' });
    const work = coverWork([a1, a2, a3, a4, dup, covered, song, guess, nothing, nothingElse], new Set([dup.id]));
    expect(work.albums.map((entry) => [entry.ref.album, entry.tracks])).toEqual([['One', 2], ['Two', 1], ['Three', 1]]);
    expect(work.songs).toHaveLength(1);
    expect(work).toMatchObject({ offers: 1, unlookable: 2, noCover: 8 });
    const text = coverSummary(true, work) as string;
    expect(text).toContain('3 albums have no cover.');
    expect(text).toMatch(/2 files cannot be looked up because they have no album name, song title or usable file name/);
  });

  it('says "Covers are off" when the box is cleared, once, and nothing when every file has a cover', () => {
    expect(coverSummary(false, coverWork([album('A')], none))).toMatch(/^Covers are off/);
    expect(coverSummary(true, coverWork([album('A', { artwork: true })], none))).toBeNull();
    expect(coverSummary(true, coverWork([album('Solo')], none))).toBe('1 album has no cover.');
  });
});

describe('one picture for the files of an album', () => {
  const chosen = { mime: 'image/png', data: PNG, name: 'front.png' };

  it('the row and every other file of the same album with no cover, up to case and spacing; not other albums, covered files, duplicates or video', () => {
    const first = album('Same Album');
    const second = row({ tags: { artist: 'band', album: ' same  ALBUM ', title: 'b' } });
    const covered = album('Same Album', { artwork: true });
    const other = album('Other Album');
    const duplicate = album('Same Album');
    const video = album('Same Album', { kind: 'music-video' });
    const list = [first, second, covered, other, duplicate, video];
    expect(albumGroupTargets(list, first.id, new Set([duplicate.id]))).toEqual([first.id, second.id]);
    expect(albumGroupTargets(list, other.id, new Set())).toEqual([other.id]);
  });

  it('a file with no album name is its own album', () => {
    const lone = row({ tags: { title: 'x' } });
    expect(albumGroupTargets([lone, row({ tags: { title: 'x' } })], lone.id, none)).toEqual([lone.id]);
  });

  it('gives the same picture, byte for byte the same array, to each file when "for all" is on, so the writer keeps one image', () => {
    const a = album('Shared');
    const b = album('Shared');
    const c = album('Elsewhere');
    const covered = album('Shared', { artwork: true });
    const result = applyChosenPicture([a, b, c, covered], a.id, chosen, { all: true, skipped: none });
    expect(result.map((entry) => coverSource(entry).from)).toEqual(['chosen', 'chosen', 'none', 'file']);
    expect(result[0]?.chosenCover?.data).toBe(result[1]?.chosenCover?.data);
  });

  it('gives it to the one file when "for all" is off', () => {
    const a = album('Shared');
    const b = album('Shared');
    expect(applyChosenPicture([a, b], a.id, chosen, { all: false, skipped: none }).map((entry) => coverSource(entry).from)).toEqual(['chosen', 'none']);
  });

  it('never takes the cover a file already has, unless the person replaces it on that file', () => {
    const covered = album('Shared', { artwork: true });
    const bare = album('Shared');
    // Replace the cover on the covered row: only that row changes.
    const replaced = applyChosenPicture([covered, bare], covered.id, chosen, { all: true, skipped: none });
    expect(replaced.map((entry) => coverSource(entry).from)).toEqual(['chosen', 'none']);
    // A picture for the bare row leaves the covered one alone.
    const other = applyChosenPicture([covered, bare], bare.id, chosen, { all: true, skipped: none });
    expect(other.map((entry) => coverSource(entry).from)).toEqual(['file', 'chosen']);
  });

  it('takes a chosen picture back off, leaving the file\'s own cover', () => {
    const covered = album('Shared', { artwork: true });
    const [replaced] = applyChosenPicture([covered], covered.id, chosen, { all: false, skipped: none }) as [Candidate];
    expect(coverSource(replaced).from).toBe('chosen');
    expect(coverSource(removeChosenPicture([replaced], replaced.id)[0] as Candidate).from).toBe('file');
  });
});

describe('reading a picture the person chose', () => {
  const file = (bytes: Uint8Array, name = 'cover.jpg', size = bytes.length) => ({ name, size, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer });
  const readable = async () => ({ ok: true as const, image: { width: 2, height: 2, data: new Uint8Array(16) } });

  it('knows a JPEG, a PNG and a WebP from their first bytes, not their name', () => {
    expect(sniffChosenPicture(JPEG)).toBe('image/jpeg');
    expect(sniffChosenPicture(PNG)).toBe('image/png');
    expect(sniffChosenPicture(WEBP)).toBe('image/webp');
    expect(sniffChosenPicture(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]))).toBeNull();
  });

  it('accepts a picture Chrome decodes and returns its real type', async () => {
    expect(await readChosenPicture(file(PNG, 'actually-a-png.jpg'), readable)).toEqual({ ok: true, cover: { mime: 'image/png', data: PNG, name: 'actually-a-png.jpg' } });
    expect((await readChosenPicture(file(WEBP, 'a.webp'), readable)).ok).toBe(true);
  });

  it('refuses an empty file, one over the size limit before reading it, and one that is not a picture', async () => {
    const decode = vi.fn(readable);
    expect(await readChosenPicture(file(new Uint8Array(0)), decode)).toMatchObject({ ok: false, message: expect.stringMatching(/is empty/) });
    const read = vi.fn(async () => new ArrayBuffer(0));
    const big = await readChosenPicture({ name: 'huge.png', size: MAX_CHOSEN_PICTURE_BYTES + 1, arrayBuffer: read }, decode);
    expect(big).toMatchObject({ ok: false, message: expect.stringMatching(/huge\.png.*more than the 24 MB/) });
    expect(read).not.toHaveBeenCalled();
    expect(await readChosenPicture(file(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]), 'notes.jpg'), decode)).toMatchObject({ ok: false, message: expect.stringMatching(/not a JPEG, PNG or WebP/) });
    expect(decode).not.toHaveBeenCalled();
  });

  it('shares the size limit with covers read from inside files', () => {
    expect(MAX_CHOSEN_PICTURE_BYTES).toBe(24 * 1024 * 1024);
  });

  it('says why when Chrome cannot read it or it has too many pixels', async () => {
    const unreadable = await readChosenPicture(file(JPEG), async () => ({ ok: false, reason: 'unreadable' }));
    expect(unreadable).toMatchObject({ ok: false, message: expect.stringMatching(/Chrome could not read "cover\.jpg" as a picture/) });
    const huge = await readChosenPicture(file(JPEG), async () => ({ ok: false, reason: 'too-large', width: 20_000, height: 20_000 }));
    expect(huge).toMatchObject({ ok: false, message: expect.stringMatching(/20,000 x 20,000 pixels, more than the 36,000,000/) });
  });
});

describe('decoding with the browser (stand-ins for createImageBitmap and the canvas)', () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubBrowser(width: number, height: number) {
    const draws: number[][] = [];
    vi.stubGlobal('createImageBitmap', async () => ({ width, height, close() {} }));
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        constructor(public width: number, public height: number) {}
        getContext() {
          return { imageSmoothingQuality: '', drawImage: (_b: unknown, _x: number, _y: number, w: number, h: number) => draws.push([w, h]), getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }) };
        }
      },
    );
    return draws;
  }

  it('refuses a picture with more pixels than the sync decodes, before drawing it, the same limit as a cover inside a file', async () => {
    const side = Math.ceil(Math.sqrt(MAX_SOURCE_PIXELS)) + 1;
    const draws = stubBrowser(side, side);
    expect(await decodePictureDetailed({ mime: 'image/png', data: PNG })).toEqual({ ok: false, reason: 'too-large', width: side, height: side });
    expect(await decodePicture({ mime: 'image/png', data: PNG })).toBeNull();
    expect(draws).toEqual([]);
  });

  it('shrinks a large but allowed picture to 1200 pixels on its longest side and keeps its proportions', async () => {
    stubBrowser(6000, 3000);
    const result = await decodePictureDetailed({ mime: 'image/jpeg', data: JPEG });
    expect(result).toMatchObject({ ok: true, image: { width: 1200, height: 600 } });
  });

  it('says unreadable when Chrome cannot open the picture', async () => {
    vi.stubGlobal('createImageBitmap', async () => {
      throw new Error('bad');
    });
    expect(await decodePictureDetailed({ mime: 'image/png', data: PNG })).toEqual({ ok: false, reason: 'unreadable' });
    expect(await decodePicture({ mime: 'image/png', data: PNG })).toBeNull();
  });
});

describe('the cover the row shows is the cover the sync gets', () => {
  const copy = { action: 'copy', reasons: [], kind: 'music', conversion: null, outputExtension: '.mp3' } as const;
  const blob = Object.assign(new Blob([new Uint8Array(10)]), { name: 'a.mp3' }) as unknown as File;
  const info = { artwork: null, tags: {}, chapters: [], audio: null, video: null } as never;
  const base = { id: 'x', file: blob, info, decision: copy, estimatedBytes: 10, folder: '' } as unknown as Candidate;

  it('puts the chosen picture into the item, ahead of a cover in the file and one found online', async () => {
    const chosen = { mime: 'image/png', data: PNG, name: 'me.png' };
    const alone = await prepareItem({ ...base, chosenCover: chosen });
    expect(alone?.info.artwork).toEqual({ mime: 'image/png', data: PNG });
    const replacing = await prepareItem({ ...base, info: { ...(info as object), artwork: { mime: 'image/jpeg', data: JPEG } } as never, chosenCover: chosen, onlineCover: { mime: 'image/jpeg', data: JPEG, releaseId: 'r' } });
    expect(replacing?.info.artwork).toEqual({ mime: 'image/png', data: PNG });
    const untouched = await prepareItem({ ...base, info: { ...(info as object), artwork: { mime: 'image/jpeg', data: JPEG } } as never });
    expect(untouched?.info.artwork?.mime).toBe('image/jpeg');
  });

  it('gives files that share one chosen picture the same bytes, so the plan counts one picture', async () => {
    const chosen = { mime: 'image/png', data: PNG, name: 'me.png' };
    const [a, b] = applyChosenPicture([{ ...base, id: 'a', info: { ...(info as object), tags: { artist: 'B', album: 'C' } } as never }, { ...base, id: 'b', info: { ...(info as object), tags: { artist: 'B', album: 'C' } } as never }], 'a', chosen, { all: true, skipped: none }) as [Candidate, Candidate];
    const itemA = await prepareItem(a);
    const itemB = await prepareItem(b);
    expect(itemA?.info.artwork?.data).toBe(itemB?.info.artwork?.data);
  });
});
