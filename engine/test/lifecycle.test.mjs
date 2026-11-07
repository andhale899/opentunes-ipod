// Engine lifecycle: set up, add, write, restart, edit, remove, playlists, error messages.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EngineError, NUMBER_FIELDS, READ_ONLY_FIELDS, TEXT_FIELDS } from '../js/engine.ts';
import { MOUNT, addFile, newEngine, newIpod, restart } from './helpers.mjs';

const messageMatches = (pattern) => (error) => error instanceof EngineError && pattern.test(error.message);

describe('setting up and opening', () => {
  it('speaks the API version the bindings expect', async () => {
    const engine = await newEngine();
    assert.equal(engine.apiVersion(), '1');
  });

  it('refuses to work before a database is open', async () => {
    const engine = await newEngine();
    assert.throws(() => engine.tracks(), messageMatches(/No database is open/));
    assert.throws(() => engine.write(), messageMatches(/No database is open/));
    assert.throws(() => engine.addTrack('music'), messageMatches(/No database is open/));
    assert.throws(() => engine.playlists(), messageMatches(/No database is open/));
  });

  it('cannot open a folder that holds no iPod database', async () => {
    const engine = await newEngine();
    assert.throws(() => engine.open(MOUNT), messageMatches(/Could not read the iPod database/));
  });

  it('explains an iPod whose database is empty, as a never-synced one is', async () => {
    const engine = await newIpod();
    engine.fs.writeFile(`${MOUNT}/iPod_Control/iTunes/iTunesDB`, new Uint8Array(0));
    assert.throws(() => engine.open(MOUNT), messageMatches(/never been synced/));
  });

  it('needs a model number to set up a blank iPod', async () => {
    const engine = await newEngine();
    assert.throws(() => engine.init(MOUNT, ''), messageMatches(/model number/));
  });

  it('sets up an iPod and reports what libgpod knows about it', async () => {
    const engine = await newIpod();
    const device = engine.device();
    assert.equal(device.model_num_str, 'MA450');
    assert.equal(device.checksum, 'none');
    assert.deepEqual(Object.keys(device.supports).sort(), ['artwork', 'chapter_image', 'photo', 'podcast', 'video']);
    for (const value of Object.values(device.supports)) assert.equal(typeof value, 'boolean');
    assert.deepEqual(engine.tracks(), []);
    assert.equal(engine.playlists().filter((playlist) => playlist.master).length, 1);
  });

  it('creates the folders and database file an iPod needs', async () => {
    const engine = await newIpod();
    assert.ok(engine.fs.analyzePath(`${MOUNT}/iPod_Control/Music/F00`).exists);
    assert.ok(engine.fs.analyzePath(`${MOUNT}/iPod_Control/Music/F49`).exists);
    const database = engine.fs.readFile(`${MOUNT}/iPod_Control/iTunes/iTunesDB`);
    assert.equal(String.fromCharCode(...database.slice(0, 4)), 'mhbd');
  });
});

describe('tracks', () => {
  it('keeps every field after the database is written and reopened', async () => {
    const engine = await newIpod();
    const handle = engine.addTrack('music', {
      title: 'Song', artist: 'Artist', album: 'Album', albumartist: 'Album Artist', genre: 'Rock',
      composer: 'Composer', comment: 'A comment', track_nr: 3, tracks: 12, cd_nr: 1, cds: 2,
      year: 2024, tracklen: 215000, bitrate: 256, samplerate: 44100, rating: 80, compilation: 1,
    });
    const destination = engine.destPath('song.mp3');
    assert.match(destination, new RegExp(`^${MOUNT}/iPod_Control/Music/F\\d\\d/[^/]+\\.mp3$`));
    engine.fs.writeFile(destination, new Uint8Array(1234));
    engine.commit(handle, destination, 1234);
    engine.write();

    const [track] = (await restart(engine)).tracks();
    assert.equal(track.title, 'Song');
    assert.equal(track.artist, 'Artist');
    assert.equal(track.album, 'Album');
    assert.equal(track.albumartist, 'Album Artist');
    assert.equal(track.genre, 'Rock');
    assert.equal(track.composer, 'Composer');
    assert.equal(track.comment, 'A comment');
    assert.equal(track.track_nr, 3);
    assert.equal(track.tracks, 12);
    assert.equal(track.cd_nr, 1);
    assert.equal(track.cds, 2);
    assert.equal(track.year, 2024);
    assert.equal(track.tracklen, 215000);
    assert.equal(track.bitrate, 256);
    assert.equal(track.samplerate, 44100);
    assert.equal(track.rating, 80);
    assert.equal(track.compilation, 1);
    assert.equal(track.size, 1234);
    assert.match(track.ipod_path, /^:iPod_Control:Music:F\d\d:[^:]+\.mp3$/);
    assert.equal(track.filetype_marker, 0x4d503320, 'the suffix MP3 as "MP3 "');
    assert.equal(track.filetype, 'MPEG audio file');
    assert.equal(track.type2, 1, 'MP3 is type2 1');
    assert.equal(track.kind, 'music');
  });

  it('survives text with quotes, backslashes, newlines and non-Latin scripts', async () => {
    const engine = await newIpod();
    const title = 'Ünïcödé 日本語 Кино 🎵 "quoted" back\\slash\nnewline\ttab';
    addFile(engine, 'music', { title, artist: 'アーティスト' }, 'x.mp3');
    engine.write();
    const [track] = (await restart(engine)).tracks();
    assert.equal(track.title, title);
    assert.equal(track.artist, 'アーティスト');
  });

  it('keeps handles stable when another track is removed', async () => {
    const engine = await newIpod();
    const a = addFile(engine, 'music', { title: 'A' }, 'a.mp3');
    const b = addFile(engine, 'music', { title: 'B' }, 'b.mp3');
    const c = addFile(engine, 'music', { title: 'C' }, 'c.mp3');
    engine.removeTrack(b);

    const titles = new Map(engine.tracks().map((track) => [track.handle, track.title]));
    assert.equal(titles.get(a), 'A');
    assert.equal(titles.get(c), 'C');
    assert.equal(titles.has(b), false);
    assert.throws(() => engine.setText(b, 'title', 'x'), messageMatches(/Unknown track handle/));
  });

  it('edits a track after it has been written and reopened', async () => {
    const engine = await newIpod();
    addFile(engine, 'music', { title: 'Before', year: 1999 }, 'x.mp3');
    engine.write();

    const reopened = await restart(engine);
    const [track] = reopened.tracks();
    reopened.set(track.handle, { title: 'After', year: 2025, genre: 'Jazz' });
    reopened.write();

    const [edited] = (await restart(reopened)).tracks();
    assert.equal(edited.title, 'After');
    assert.equal(edited.year, 2025);
    assert.equal(edited.genre, 'Jazz');
    assert.equal(edited.ipod_path, track.ipod_path, 'the file path does not change');
  });

  it('rejects bad requests with messages a person can act on', async () => {
    const engine = await newIpod();
    const track = engine.addTrack('music');
    assert.throws(() => engine.setText(track, 'nope', 'x'), messageMatches(/not a text field/));
    assert.throws(() => engine.setNumber(track, 'title', 1), messageMatches(/not a numeric field/));
    assert.throws(() => engine.setText(track, 'ipod_path', 'x'), messageMatches(/set by the engine/));
    assert.throws(() => engine.setNumber(track, 'mediatype', 1), messageMatches(/Use a track kind/));
    assert.throws(() => engine.setNumber(track, 'year', Number.NaN), messageMatches(/needs a number/));
    assert.throws(() => engine.addTrack('nonsense'), messageMatches(/Unknown track kind/));
    assert.throws(() => engine.setKind(track, 'nonsense'), messageMatches(/Unknown track kind/));
    assert.throws(() => engine.destPath(''), messageMatches(/file name is required/));
    assert.throws(() => engine.commit(track, '/elsewhere/file.mp3', 10), messageMatches(/not under the iPod/));
    assert.throws(() => engine.commit(track, engine.destPath('x.mp3'), -1), messageMatches(/does not fit/));
  });

  it('clamps numbers to the range of the field instead of wrapping around', async () => {
    const engine = await newIpod();
    const handle = engine.addTrack('music');
    engine.setNumber(handle, 'rating', -10);
    engine.setNumber(handle, 'compilation', 300);
    engine.setNumber(handle, 'samplerate', 96000);
    const [track] = engine.tracks();
    assert.equal(track.rating, 0);
    assert.equal(track.compilation, 255);
    assert.equal(track.samplerate, 65535);
  });

  it('returns exactly the fields the TypeScript bindings know about', async () => {
    const engine = await newIpod();
    addFile(engine, 'music', { title: 'x' }, 'x.mp3');
    const returned = Object.keys(engine.tracks()[0]).filter((key) => !['handle', 'kind', 'chapters'].includes(key));
    const known = [...TEXT_FIELDS, ...NUMBER_FIELDS, ...READ_ONLY_FIELDS];
    assert.deepEqual(returned.filter((key) => !known.includes(key)), [], 'fields the bindings do not declare');
    assert.deepEqual(known.filter((key) => !returned.includes(key)), [], 'fields the engine does not return');
  });
});

describe('playlists', () => {
  it('creates, renames, fills and deletes a playlist', async () => {
    const engine = await newIpod();
    const track = addFile(engine, 'music', { title: 'T' }, 't.mp3');
    const playlist = engine.createPlaylist('Road trip');
    engine.addToPlaylist(playlist, track);
    engine.addToPlaylist(playlist, track); // adding twice keeps one
    engine.renamePlaylist(playlist, 'Commute');
    engine.write();

    const reopened = await restart(engine);
    const found = reopened.playlists().find((p) => p.name === 'Commute');
    assert.ok(found, 'the renamed playlist survives');
    assert.equal(found.tracks.length, 1);
    assert.equal(found.master, false);

    reopened.deletePlaylist(found.handle);
    assert.equal(reopened.playlists().some((p) => p.name === 'Commute'), false);
  });

  it('takes a removed track out of every playlist and still writes', async () => {
    const engine = await newIpod();
    const keep = addFile(engine, 'music', { title: 'Keep' }, 'k.mp3');
    const drop = addFile(engine, 'music', { title: 'Drop' }, 'd.mp3');
    const playlist = engine.createPlaylist('Mix');
    engine.addToPlaylist(playlist, keep);
    engine.addToPlaylist(playlist, drop);

    engine.removeTrack(drop);
    assert.deepEqual(engine.playlists().find((p) => p.handle === playlist).tracks, [keep]);
    engine.write();

    const reopened = await restart(engine);
    assert.deepEqual(reopened.tracks().map((track) => track.title), ['Keep']);
    assert.equal(reopened.playlists().find((p) => p.name === 'Mix').tracks.length, 1);
  });

  it('protects the master playlist', async () => {
    const engine = await newIpod();
    const track = addFile(engine, 'music', { title: 'T' }, 't.mp3');
    const master = engine.playlists().find((playlist) => playlist.master).handle;
    assert.throws(() => engine.deletePlaylist(master), messageMatches(/master playlist/));
    assert.throws(() => engine.removeFromPlaylist(master, track), messageMatches(/master playlist/));
    assert.throws(() => engine.createPlaylist(''), messageMatches(/needs a name/));
  });

  it('renames the iPod when the master playlist is renamed', async () => {
    const engine = await newIpod();
    const master = engine.playlists().find((playlist) => playlist.master).handle;
    engine.renamePlaylist(master, 'My Nano');
    engine.write();
    const reopened = await restart(engine);
    assert.equal(reopened.playlists().find((playlist) => playlist.master).name, 'My Nano');
  });
});
