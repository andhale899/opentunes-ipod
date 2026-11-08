import { describe, expect, it } from 'vitest';
import { albumKey, albumRefOf, coverFor, coverSource, findFolderCover, folderCoverRank, pickFolderCover, pictureMime, sniffPicture } from '../src/albumArt';
import { prepareItem, type Candidate } from '../src/addFiles';
import type { MediaInfo, PlanDecision } from '@opentunes/core';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0xff, 0xd9]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);

describe('which picture file is a folder cover', () => {
  it('knows cover, folder, front, album and AlbumArt as .jpg, .jpeg or .png, in any case', () => {
    for (const name of ['cover.jpg', 'Cover.JPG', 'folder.jpeg', 'FRONT.png', 'album.jpg', 'AlbumArt.jpg', 'albumart.PNG']) {
      expect(folderCoverRank(name), name).not.toBeNull();
    }
    for (const name of ['cover.gif', 'cover', 'back.jpg', 'albumartsmall.jpg', 'cover.jpg.txt', 'my cover.jpg', 'AlbumArt_{ABC}_Large.jpg', '.cover.jpg']) {
      expect(folderCoverRank(name), name).toBeNull();
    }
  });

  it('prefers cover over folder over front over album over AlbumArt, and jpg over png', () => {
    const files = new Map([['albumart.jpg', 1], ['front.jpg', 2], ['folder.png', 3], ['cover.png', 4], ['cover.jpg', 5], ['notes.txt', 6]]);
    expect(pickFolderCover(files)).toEqual({ name: 'cover.jpg', file: 5 });
    files.delete('cover.jpg');
    expect(pickFolderCover(files)).toEqual({ name: 'cover.png', file: 4 });
    expect(pickFolderCover(new Map([['notes.txt', 1]]))).toBeNull();
  });

  it('looks in the file\'s own folder, then the one above, and no further', () => {
    const byFolder = new Map<string, Map<string, string>>([
      ['Music/Album', new Map([['cover.jpg', 'album cover']])],
      ['Music/Album/Disc 2', new Map([['folder.jpg', 'disc cover']])],
      ['Music', new Map([['cover.jpg', 'library cover']])],
    ]);
    expect(findFolderCover(['Music', 'Album', 'Disc 1'], byFolder)?.file).toBe('album cover');
    expect(findFolderCover(['Music', 'Album', 'Disc 2'], byFolder)?.file).toBe('disc cover');
    expect(findFolderCover(['Music', 'Other', 'Album'], byFolder)).toBeNull();
    expect(findFolderCover(['Music', 'Album'], byFolder)?.file).toBe('album cover');
    expect(findFolderCover(['Music'], byFolder)?.file).toBe('library cover');
    expect(findFolderCover([], new Map([['', new Map([['cover.jpg', 'top']])]]))?.file).toBe('top');
    expect(findFolderCover([], byFolder)).toBeNull();
  });
});

describe('telling what a picture is', () => {
  it('goes by the first bytes, and by the name when asked', () => {
    expect(sniffPicture(JPEG)).toBe('image/jpeg');
    expect(sniffPicture(PNG)).toBe('image/png');
    expect(sniffPicture(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBeNull();
    expect(sniffPicture(new Uint8Array(0))).toBeNull();
    expect(pictureMime('a.JPEG')).toBe('image/jpeg');
    expect(pictureMime('a.png')).toBe('image/png');
    expect(pictureMime('a.gif')).toBeNull();
  });
});

describe('the album a track belongs to, for the online lookup', () => {
  it('needs an artist and an album, prefers the album artist, and ignores spacing and case in the key', () => {
    expect(albumRefOf({ artist: 'A', album: '' })).toBeNull();
    expect(albumRefOf({ album: 'B' })).toBeNull();
    expect(albumRefOf({ artist: ' The  Band ', album: 'The Record', albumArtist: 'Various' })).toEqual({ artist: 'Various', album: 'The Record' });
    expect(albumRefOf({ artist: ' The  Band ', album: ' The   Record' })).toEqual({ artist: 'The Band', album: 'The Record' });
    expect(albumKey({ artist: 'The BAND', album: 'record' })).toBe(albumKey({ artist: 'the band', album: 'Record' }));
  });
});

const file = (bytes: Uint8Array) => ({ arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer });

describe('a track\'s cover: the file first, then its folder, then one found online', () => {
  const inside = { mime: 'image/png', data: PNG };
  it('says where it comes from', () => {
    const folderCover = { name: 'cover.jpg', file: file(JPEG) };
    const onlineCover = { mime: 'image/jpeg', data: JPEG, releaseId: 'id' };
    expect(coverSource({ info: { artwork: inside }, folderCover, onlineCover })).toEqual({ from: 'file' });
    expect(coverSource({ info: { artwork: null }, folderCover, onlineCover })).toEqual({ from: 'folder', name: 'cover.jpg' });
    expect(coverSource({ info: { artwork: null }, onlineCover })).toEqual({ from: 'online', releaseId: 'id' });
    expect(coverSource({ info: { artwork: null } })).toEqual({ from: 'none' });
  });

  it('reads the picture of the first one that exists', async () => {
    const folderCover = { name: 'Cover.JPG', file: file(JPEG) };
    expect(await coverFor({ info: { artwork: inside }, folderCover })).toBe(inside);
    expect(await coverFor({ info: { artwork: null }, folderCover })).toEqual({ mime: 'image/jpeg', data: JPEG });
    expect(await coverFor({ info: { artwork: null } })).toBeNull();
    // A cover.jpg that is really a PNG is described by what it is.
    expect(await coverFor({ info: { artwork: null }, folderCover: { name: 'cover.jpg', file: file(PNG) } })).toEqual({ mime: 'image/png', data: PNG });
    // Bytes that are not a JPEG or PNG are still handed on under the name's type: Chrome's decoder
    // decides, and a picture it cannot read is left off with a warning.
    expect((await coverFor({ info: { artwork: null }, folderCover: { name: 'cover.jpg', file: file(new Uint8Array(20)) } }))?.mime).toBe('image/jpeg');
  });

  it('goes into the item the sync takes', async () => {
    const copy: PlanDecision = { action: 'copy', reasons: [], kind: 'music', conversion: null, outputExtension: '.mp3' };
    const info = { artwork: null, tags: {}, chapters: [], audio: null, video: null } as unknown as MediaInfo;
    const blob = Object.assign(new Blob([new Uint8Array(10)]), { name: 'a.mp3' }) as unknown as File;
    const base = { id: 'x', file: blob, info, decision: copy, estimatedBytes: 10, folder: '' } satisfies Candidate;

    const fromFolder = await prepareItem({ ...base, folderCover: { name: 'cover.jpg', file: file(JPEG) as unknown as File } });
    expect(fromFolder?.info.artwork).toEqual({ mime: 'image/jpeg', data: JPEG });
    const online = await prepareItem({ ...base, onlineCover: { mime: 'image/png', data: PNG, releaseId: 'r' } });
    expect(online?.info.artwork?.mime).toBe('image/png');
    const inFile = await prepareItem({ ...base, info: { ...info, artwork: { mime: 'image/jpeg', data: JPEG } }, onlineCover: { mime: 'image/png', data: PNG, releaseId: 'r' } });
    expect(inFile?.info.artwork?.mime).toBe('image/jpeg');
    const none = await prepareItem(base);
    expect(none?.info.artwork).toBeNull();
    // A cover picture that cannot be read does not stop the file.
    const broken = await prepareItem({ ...base, folderCover: { name: 'cover.jpg', file: { arrayBuffer: async () => { throw new Error('gone'); } } as unknown as File } });
    expect(broken?.info.artwork).toBeNull();
  });
});
