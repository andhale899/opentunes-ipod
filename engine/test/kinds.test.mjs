// Media kinds: music, movies, music videos, TV shows, podcasts, video podcasts, audiobooks.
//
// A kind decides which menu a track appears under on the iPod and which flags go with it.
// The expected values come from libgpod's documentation of Itdb_Track. These tests show the
// engine writes them and reads them back. Whether a given iPod model then plays the file
// depends on its format, which is the planner's job, and needs hardware to confirm.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MOUNT, addFile, nano7gStyleIpod, newIpod, restart } from './helpers.mjs';

const FLAGS = ['movie_flag', 'skip_when_shuffling', 'remember_playback_position', 'flag4', 'mark_unplayed'];

const EXPECTED = {
  music:           { mediatype: 1,  movie_flag: 0, skip_when_shuffling: 0, remember_playback_position: 0, flag4: 0, mark_unplayed: 1, file: 'a.mp3', filetype: 'MPEG audio file' },
  movie:           { mediatype: 2,  movie_flag: 1, skip_when_shuffling: 0, remember_playback_position: 0, flag4: 0, mark_unplayed: 1, file: 'a.m4v', filetype: 'MPEG-4 video file' },
  'music-video':   { mediatype: 32, movie_flag: 1, skip_when_shuffling: 0, remember_playback_position: 0, flag4: 0, mark_unplayed: 1, file: 'a.m4v', filetype: 'MPEG-4 video file' },
  'tv-show':       { mediatype: 64, movie_flag: 1, skip_when_shuffling: 0, remember_playback_position: 0, flag4: 0, mark_unplayed: 1, file: 'a.m4v', filetype: 'MPEG-4 video file' },
  podcast:         { mediatype: 4,  movie_flag: 0, skip_when_shuffling: 1, remember_playback_position: 1, flag4: 1, mark_unplayed: 2, file: 'a.mp3', filetype: 'MPEG audio file' },
  'video-podcast': { mediatype: 6,  movie_flag: 1, skip_when_shuffling: 1, remember_playback_position: 1, flag4: 1, mark_unplayed: 2, file: 'a.m4v', filetype: 'MPEG-4 video file' },
  audiobook:       { mediatype: 8,  movie_flag: 0, skip_when_shuffling: 1, remember_playback_position: 1, flag4: 0, mark_unplayed: 1, file: 'a.m4b', filetype: 'AAC audio file' },
};

describe('kinds', () => {
  it('lists every kind with its media type', async () => {
    const engine = await newIpod();
    const listed = Object.fromEntries(engine.kinds().map((kind) => [kind.name, kind.mediatype]));
    const expected = Object.fromEntries(Object.entries(EXPECTED).map(([name, want]) => [name, want.mediatype]));
    assert.deepEqual(listed, expected);
  });

  for (const [kind, want] of Object.entries(EXPECTED)) {
    it(`writes a ${kind} with the flags libgpod documents`, async () => {
      const engine = await newIpod();
      addFile(engine, kind, { title: `A ${kind}`, year: 2020 }, want.file);
      engine.write();

      const [track] = (await restart(engine)).tracks();
      assert.equal(track.kind, kind);
      assert.equal(track.mediatype, want.mediatype);
      for (const flag of FLAGS) assert.equal(track[flag], want[flag], flag);
      assert.equal(track.filetype, want.filetype);
      assert.equal(track.year, 2020);
    });
  }
});

describe('podcasts', () => {
  it('lists podcasts in the podcast playlist and music nowhere near it', async () => {
    const engine = await newIpod();
    const song = addFile(engine, 'music', { title: 'Song' }, 's.mp3');
    assert.equal(engine.playlists().some((playlist) => playlist.podcasts), false, 'no podcast playlist until one is needed');

    const episode = addFile(engine, 'podcast', {
      title: 'Episode 1', artist: 'The Show', album: 'The Show', category: 'Technology',
      description: 'Show notes for episode one', podcasturl: 'https://example.com/ep1.mp3',
      podcastrss: 'https://example.com/feed.xml',
    }, 'e.mp3');

    const lists = engine.playlists();
    const podcasts = lists.find((playlist) => playlist.podcasts);
    assert.ok(podcasts, 'the podcast playlist is created on demand');
    assert.deepEqual(podcasts.tracks, [episode]);
    assert.deepEqual([...lists.find((playlist) => playlist.master).tracks].sort(), [song, episode].sort(), 'the master playlist holds everything');
    engine.write();

    const reopened = await restart(engine);
    assert.equal(reopened.playlists().filter((playlist) => playlist.podcasts).length, 1, 'libgpod hides the list if there is more than one');
    const found = reopened.tracks().find((track) => track.kind === 'podcast');
    assert.equal(found.podcasturl, 'https://example.com/ep1.mp3');
    assert.equal(found.podcastrss, 'https://example.com/feed.xml');
    assert.equal(found.category, 'Technology');
    assert.equal(found.description, 'Show notes for episode one');
  });

  it('moves a track in and out of the podcast playlist when its kind changes', async () => {
    const engine = await newIpod();
    const handle = addFile(engine, 'music', { title: 'Talk' }, 't.mp3');
    const members = () => engine.playlists().find((playlist) => playlist.podcasts)?.tracks ?? [];

    engine.setKind(handle, 'podcast');
    assert.deepEqual(members(), [handle]);
    assert.equal(engine.tracks()[0].mark_unplayed, 2);

    engine.setKind(handle, 'music');
    assert.deepEqual(members(), []);
    assert.equal(engine.tracks()[0].mediatype, 1);
    assert.equal(engine.tracks()[0].mark_unplayed, 1);
  });

  it('keeps the podcast playlist protected from deletion', async () => {
    const engine = await newIpod();
    addFile(engine, 'podcast', { title: 'E' }, 'e.mp3');
    const podcasts = engine.playlists().find((playlist) => playlist.podcasts).handle;
    assert.throws(() => engine.deletePlaylist(podcasts), /podcast playlist/);
  });
});

describe('audiobooks', () => {
  it('keeps chapters and the saved position', async () => {
    const engine = await newIpod();
    const book = addFile(engine, 'audiobook', { title: 'The Book', artist: 'The Author', album: 'The Book', bookmark_time: 90000 }, 'book.m4b');
    engine.addChapter(book, 0, 'Introduction');
    engine.addChapter(book, 60000, 'Chapter 1');
    engine.addChapter(book, 125000, 'Chapter 2: 日本語');
    engine.write();

    const [found] = (await restart(engine)).tracks();
    assert.deepEqual(found.chapters, [
      { start: 1, title: 'Introduction' }, // libgpod starts the first chapter at 1
      { start: 60000, title: 'Chapter 1' },
      { start: 125000, title: 'Chapter 2: 日本語' },
    ]);
    assert.equal(found.bookmark_time, 90000);
  });

  it('clears chapters, and rejects a start that does not fit', async () => {
    const engine = await newIpod();
    const book = addFile(engine, 'audiobook', { title: 'B' }, 'b.m4b');
    engine.addChapter(book, 1000, 'One');
    engine.clearChapters(book);
    assert.deepEqual(engine.tracks()[0].chapters, []);
    assert.throws(() => engine.addChapter(book, -5, 'Bad'), /chapter start/);
    assert.throws(() => engine.addChapter(book, 2 ** 40, 'Bad'), /chapter start/);
  });
});

describe('video kinds', () => {
  it('keeps the TV show details', async () => {
    const engine = await newIpod();
    addFile(engine, 'tv-show', {
      title: 'Pilot', tvshow: 'The Show', tvnetwork: 'The Network', tvepisode: '101',
      season_nr: 1, episode_nr: 1, description: 'The first one',
    }, 'pilot.m4v');
    engine.write();

    const [show] = (await restart(engine)).tracks();
    assert.equal(show.kind, 'tv-show');
    assert.equal(show.tvshow, 'The Show');
    assert.equal(show.tvnetwork, 'The Network');
    assert.equal(show.tvepisode, '101');
    assert.equal(show.season_nr, 1);
    assert.equal(show.episode_nr, 1);
    assert.equal(show.description, 'The first one');
  });

  it('tells a movie from a music video after a restart', async () => {
    const engine = await newIpod();
    addFile(engine, 'movie', { title: 'The Film' }, 'film.m4v');
    addFile(engine, 'music-video', { title: 'The Clip', artist: 'The Band' }, 'clip.m4v');
    engine.write();
    const kinds = Object.fromEntries((await restart(engine)).tracks().map((track) => [track.title, track.kind]));
    assert.deepEqual(kinds, { 'The Film': 'movie', 'The Clip': 'music-video' });
  });
});

describe('nano 7G database (SQLite)', () => {
  it('records each kind in the library database the device reads', async () => {
    const engine = await nano7gStyleIpod();
    for (const [kind, want] of Object.entries(EXPECTED)) addFile(engine, kind, { title: kind }, want.file);
    engine.write();

    const bytes = engine.fs.readFile(`${MOUNT}/iPod_Control/iTunes/iTunes Library.itlp/Library.itdb`);
    const directory = mkdtempSync(join(tmpdir(), 'opentunes-'));
    try {
      const file = join(directory, 'Library.itdb');
      writeFileSync(file, bytes);
      const database = new DatabaseSync(file, { readOnly: true });
      const rows = database
        .prepare('SELECT title, media_kind, is_song, is_audio_book, is_music_video, is_movie, is_tv_show, remember_bookmark, exclude_from_shuffle FROM item')
        .all();
      const byTitle = Object.fromEntries(rows.map((row) => [row.title, row]));
      database.close();

      assert.deepEqual(Object.keys(byTitle).sort(), Object.keys(EXPECTED).sort());
      for (const [kind, want] of Object.entries(EXPECTED)) {
        const row = byTitle[kind];
        assert.equal(row.media_kind, want.mediatype, `${kind}: media_kind`);
        assert.equal(row.is_song, want.mediatype & 1 ? 1 : 0, `${kind}: is_song`);
        assert.equal(row.is_movie, want.mediatype & 2 ? 1 : 0, `${kind}: is_movie`);
        assert.equal(row.is_audio_book, want.mediatype & 8 ? 1 : 0, `${kind}: is_audio_book`);
        assert.equal(row.is_music_video, want.mediatype & 32 ? 1 : 0, `${kind}: is_music_video`);
        assert.equal(row.is_tv_show, want.mediatype & 64 ? 1 : 0, `${kind}: is_tv_show`);
        assert.equal(row.remember_bookmark, want.remember_playback_position, `${kind}: remember_bookmark`);
        assert.equal(row.exclude_from_shuffle, want.skip_when_shuffling, `${kind}: exclude_from_shuffle`);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reads back what it wrote, kinds included', async () => {
    const engine = await nano7gStyleIpod();
    for (const [kind, want] of Object.entries(EXPECTED)) addFile(engine, kind, { title: kind }, want.file);
    engine.write();

    const kinds = Object.fromEntries((await restart(engine)).tracks().map((track) => [track.title, track.kind]));
    assert.deepEqual(kinds, Object.fromEntries(Object.keys(EXPECTED).map((kind) => [kind, kind])));
  });
});
