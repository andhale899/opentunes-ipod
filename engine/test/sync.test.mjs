// Syncing new files to an iPod: what a successful sync puts where.
//
// The iPods are in-memory folders written by the real engine (see sync-helpers.mjs). These
// tests show what the code does with them. They cannot show that a real nano 7G plays the
// result: only a run on the owner's iPod can.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SyncError, applySync, planSync, syncDataFromBytes } from '../js/index.ts';
import { ITUNES, LIBRARY, MOUNT, backedUp, bytesFor, instrument, makeItem, newEngine, plainIpod, readIpod, signedIpod, snapshot } from './sync-helpers.mjs';

const FLAGS = ['movie_flag', 'skip_when_shuffling', 'remember_playback_position', 'flag4', 'mark_unplayed'];

// From libgpod's documentation of Itdb_Track, as the engine's kinds test uses them.
const EXPECTED = {
  music:           { mediatype: 1,  movie_flag: 0, skip_when_shuffling: 0, remember_playback_position: 0, flag4: 0, mark_unplayed: 1, filetype: 'MPEG audio file' },
  movie:           { mediatype: 2,  movie_flag: 1, skip_when_shuffling: 0, remember_playback_position: 0, flag4: 0, mark_unplayed: 1, filetype: 'MPEG-4 video file' },
  'music-video':   { mediatype: 32, movie_flag: 1, skip_when_shuffling: 0, remember_playback_position: 0, flag4: 0, mark_unplayed: 1, filetype: 'MPEG-4 video file' },
  'tv-show':       { mediatype: 64, movie_flag: 1, skip_when_shuffling: 0, remember_playback_position: 0, flag4: 0, mark_unplayed: 1, filetype: 'MPEG-4 video file' },
  podcast:         { mediatype: 4,  movie_flag: 0, skip_when_shuffling: 1, remember_playback_position: 1, flag4: 1, mark_unplayed: 2, filetype: 'MPEG audio file' },
  'video-podcast': { mediatype: 6,  movie_flag: 1, skip_when_shuffling: 1, remember_playback_position: 1, flag4: 1, mark_unplayed: 2, filetype: 'MPEG-4 video file' },
  audiobook:       { mediatype: 8,  movie_flag: 0, skip_when_shuffling: 1, remember_playback_position: 1, flag4: 0, mark_unplayed: 1, filetype: 'AAC audio file' },
};

const MEDIA = /^iPod_Control\/Music\/F\d\d\/[^/]+$/;
const DATABASE = /^iPod_Control\/(iTunes|Device)\//;

function oneOfEach() {
  return {
    music: makeItem('music', {
      tags: { title: 'A Song', artist: 'Band', album: 'Record', albumArtist: 'Band', genre: 'Rock', composer: 'Writer', comment: 'Nice', grouping: 'G', year: 2001, trackNumber: 3, trackTotal: 10, discNumber: 1, discTotal: 2, bpm: 120.4, compilation: true },
      durationMs: 201_500,
    }),
    movie: makeItem('movie', { tags: { title: 'A Film', description: 'About things', year: 1999 }, durationMs: 5_400_000 }),
    'music-video': makeItem('music-video', { tags: { title: 'A Clip', artist: 'Band' } }),
    'tv-show': makeItem('tv-show', { tags: { title: 'Pilot', show: 'The Show', season: 2, episode: 5, episodeId: 'S02E05', network: 'The Network', description: 'The first one' } }),
    podcast: makeItem('podcast', {
      tags: { title: 'Episode 1', artist: 'Host', album: 'The Cast', podcastCategory: 'Technology', podcastFeedUrl: 'https://example.com/feed.xml', podcastEpisodeUrl: 'https://example.com/1.mp3', description: 'Show notes' },
      playlists: ['Listen later'],
    }),
    'video-podcast': makeItem('video-podcast', { tags: { title: 'Video episode', album: 'The Vidcast', podcastFeedUrl: 'https://example.com/v.xml' } }),
    audiobook: makeItem('audiobook', {
      tags: { title: 'The Book', artist: 'An Author', album: 'The Book' },
      durationMs: 3_600_000,
      chapters: [{ startMs: 0, title: 'Opening' }, { startMs: 600_000, title: 'Middle' }, { startMs: 1_800_000, title: 'End: 日本語' }],
      playlists: ['Listen later'],
    }),
  };
}

describe('planning a sync', () => {
  it('changes nothing on the iPod, and lists the media and database files that would change', async () => {
    const ipod = await signedIpod();
    const before = snapshot(ipod);
    const items = Object.values(oneOfEach());
    const plan = await planSync(ipod, newEngine, items);
    assert.deepEqual(snapshot(ipod), before);

    assert.equal(plan.files.length, items.length);
    assert.equal(plan.bytesToCopy, items.reduce((sum, item) => sum + item.data.size, 0));
    for (const file of plan.files) {
      assert.match(file.path, /^iPod_Control\/Music\/F\d\d\/libgpod\d{6}\.(mp3|m4v|m4b)$/);
      assert.equal(file.ipodPath, `:${file.path.replaceAll('/', ':')}`);
      assert.ok(!before.has(file.path), 'not a file already on the iPod');
    }
    assert.equal(new Set(plan.files.map((file) => file.path.toLowerCase())).size, plan.files.length, 'every file has its own name');
    const changed = Object.fromEntries(plan.database.map((change) => [change.path, change.kind]));
    assert.equal(changed[`${ITUNES}/iTunesCDB`], 'changed');
    assert.equal(changed[`${LIBRARY}/Library.itdb`], 'changed');
    assert.equal(changed[`${LIBRARY}/Locations.itdb`], 'changed');
    assert.ok(plan.database.every((change) => DATABASE.test(change.path)));
    assert.deepEqual(plan.skipped, []);
    assert.equal(plan.expectedTracks.length, plan.tracksBefore.length + items.length);
    assert.match(plan.warnings[0], /free space was not checked/);
  });
});

describe('a sync of every kind', () => {
  for (const [label, build] of [['nano 7G-style iPod', signedIpod], ['older iPod without the SQLite library', plainIpod]]) {
    it(`adds one track of each kind to a ${label}, with their fields, flags and chapters`, async () => {
      const ipod = await build();
      const backup = await backedUp(ipod);
      const items = oneOfEach();
      const plan = await planSync(ipod, newEngine, Object.values(items));
      const report = await applySync(plan, ipod, newEngine, { backup });

      assert.deepEqual(report.failures, []);
      assert.equal(report.verified, true);
      assert.equal(report.rolledBack, false);
      assert.equal(report.copied.length, 7);

      const files = snapshot(ipod);
      const pathOf = Object.fromEntries(plan.files.map((file) => [file.itemId, file]));
      for (const item of Object.values(items)) {
        const { path } = pathOf[item.id];
        assert.deepEqual(files.get(path), await item.data.read(0, item.data.size), `${item.kind}: the file on the iPod is the original`);
      }

      const engine = await readIpod(ipod);
      const tracks = engine.tracks();
      assert.equal(tracks.length, plan.tracksBefore.length + 7);
      const byPath = Object.fromEntries(tracks.map((track) => [track.ipod_path, track]));
      for (const [kind, item] of Object.entries(items)) {
        const track = byPath[pathOf[item.id].ipodPath];
        assert.ok(track, `${kind}: in the library at its planned path`);
        assert.equal(track.kind, kind);
        assert.equal(track.mediatype, EXPECTED[kind].mediatype, `${kind}: mediatype`);
        for (const flag of FLAGS) assert.equal(track[flag], EXPECTED[kind][flag], `${kind}: ${flag}`);
        assert.equal(track.filetype, EXPECTED[kind].filetype, `${kind}: filetype`);
        assert.equal(track.size, item.data.size);
        assert.equal(track.tracklen, item.info.durationMs);
        assert.equal(track.bitrate, 192);
        assert.equal(track.samplerate, 44100);
        assert.equal(track.transferred, true);
        assert.equal(track.title, item.info.tags.title);
      }

      const song = byPath[pathOf[items.music.id].ipodPath];
      assert.deepEqual(
        [song.artist, song.album, song.albumartist, song.genre, song.composer, song.comment, song.grouping, song.year, song.track_nr, song.tracks, song.cd_nr, song.cds, song.BPM, song.compilation],
        ['Band', 'Record', 'Band', 'Rock', 'Writer', 'Nice', 'G', 2001, 3, 10, 1, 2, 120, 1],
      );
      const show = byPath[pathOf[items['tv-show'].id].ipodPath];
      assert.deepEqual([show.tvshow, show.season_nr, show.episode_nr, show.tvepisode, show.tvnetwork, show.description], ['The Show', 2, 5, 'S02E05', 'The Network', 'The first one']);
      const episode = byPath[pathOf[items.podcast.id].ipodPath];
      assert.deepEqual([episode.category, episode.podcastrss, episode.podcasturl, episode.description], ['Technology', 'https://example.com/feed.xml', 'https://example.com/1.mp3', 'Show notes']);
      const book = byPath[pathOf[items.audiobook.id].ipodPath];
      assert.deepEqual(book.chapters, [
        { start: 1, title: 'Opening' }, // libgpod starts the first chapter at 1
        { start: 600_000, title: 'Middle' },
        { start: 1_800_000, title: 'End: 日本語' },
      ]);

      const lists = engine.playlists();
      const handleOf = (item) => tracks.find((track) => track.ipod_path === pathOf[item.id].ipodPath).handle;
      const podcasts = lists.find((list) => list.podcasts);
      assert.deepEqual(
        [...podcasts.tracks].sort(),
        [...tracks.filter((track) => track.kind === 'podcast' || track.kind === 'video-podcast').map((track) => track.handle)].sort(),
        'every podcast, old and new, is in the podcast playlist, and nothing else',
      );
      assert.ok(podcasts.tracks.includes(handleOf(items['video-podcast'])));
      const later = lists.find((list) => list.name === 'Listen later');
      assert.deepEqual(later.tracks, [handleOf(items.podcast), handleOf(items.audiobook)], 'the playlist named by the items was made');
      assert.equal(lists.find((list) => list.master).tracks.length, tracks.length);

      // The tracks that were there before are as they were.
      for (const old of plan.tracksBefore) {
        const now = byPath[old.ipod_path];
        assert.ok(now, `${old.title} is still there`);
        for (const field of ['title', 'artist', 'album', 'kind', 'size', 'tracklen', 'playcount', 'time_added']) assert.equal(now[field], old[field], `${old.title}: ${field}`);
      }
    });
  }

  it('records the new tracks in the SQLite library a nano 7G reads, with their locations', async () => {
    const ipod = await signedIpod();
    const backup = await backedUp(ipod);
    const items = oneOfEach();
    const plan = await planSync(ipod, newEngine, Object.values(items));
    const report = await applySync(plan, ipod, newEngine, { backup });
    assert.equal(report.verified, true);
    assert.deepEqual(report.signatures.map((check) => [check.file, check.status]), [['iTunesCDB', 'matches'], ['Locations.itdb.cbk', 'matches']]);

    const engine = await readIpod(ipod);
    const library = `${MOUNT}/${LIBRARY}`;
    const rows = engine.sqlQuery(`${library}/Library.itdb`, 'SELECT pid, title, media_kind, remember_bookmark, exclude_from_shuffle FROM item').rows;
    const locations = engine.sqlQuery(`${library}/Locations.itdb`, 'SELECT item_pid, location, file_size FROM location').rows;
    const locationOf = new Map(locations.map(([pid, location, size]) => [String(pid), { location, size }]));
    assert.equal(rows.length, plan.tracksBefore.length + 7);
    for (const [kind, item] of Object.entries(items)) {
      const row = rows.find((candidate) => candidate[1] === item.info.tags.title);
      assert.ok(row, `${kind}: an item row`);
      assert.equal(row[2], EXPECTED[kind].mediatype, `${kind}: media_kind`);
      assert.equal(row[3], EXPECTED[kind].remember_playback_position, `${kind}: remember_bookmark`);
      assert.equal(row[4], EXPECTED[kind].skip_when_shuffling, `${kind}: exclude_from_shuffle`);
      const file = plan.files.find((candidate) => candidate.itemId === item.id);
      assert.deepEqual(locationOf.get(String(row[0])), { location: file.path.replace('iPod_Control/Music/', ''), size: item.data.size }, `${kind}: its location row`);
    }
  });

  it('writes an older iPod\'s iTunesDB and nothing of the SQLite library', async () => {
    const ipod = await plainIpod();
    const backup = await backedUp(ipod);
    const plan = await planSync(ipod, newEngine, [makeItem('music', { playlists: ['Gym'] }), makeItem('movie')]);
    assert.deepEqual(plan.database.map((change) => [change.path, change.kind]), [[`${ITUNES}/iTunesDB`, 'changed']]);
    const report = await applySync(plan, ipod, newEngine, { backup });
    assert.equal(report.verified, true);
    assert.deepEqual(report.signatures.map((check) => check.status), ['missing', 'missing']);
    assert.ok(![...snapshot(ipod).keys()].some((path) => path.includes('iTunes Library.itlp') || path.endsWith('iTunesCDB')));
    const engine = await readIpod(ipod);
    const gym = engine.playlists().find((list) => list.name === 'Gym');
    assert.equal(gym.tracks.length, 1);
  });
});

describe('copying the media', () => {
  it('copies three files at a time by default, and never more', async () => {
    for (const [concurrency, expected] of [[undefined, 3], [1, 1]]) {
      const ipod = await signedIpod();
      const backup = await backedUp(ipod);
      const slow = (seed) => {
        const bytes = bytesFor(seed, 4096);
        return { size: bytes.length, read: async (start, end) => (await new Promise((resolve) => setTimeout(resolve, 2)), bytes.slice(start, end)) };
      };
      const items = Array.from({ length: 7 }, (_, index) => makeItem('music', { data: slow(100 + index) }));
      const plan = await planSync(ipod, newEngine, items);
      let inFlight = 0;
      let most = 0;
      const watched = instrument(ipod, {
        opened: (path) => {
          if (MEDIA.test(path)) most = Math.max(most, ++inFlight);
        },
        closed: (path) => {
          if (MEDIA.test(path)) inFlight -= 1;
        },
      });
      const report = await applySync(plan, watched, newEngine, { backup, chunkBytes: 1024, ...(concurrency ? { concurrency } : {}) });
      assert.equal(report.verified, true);
      assert.equal(report.copied.length, 7);
      assert.equal(most, expected, `with concurrency ${concurrency ?? 'left to the default'}, ${expected} at once`);
      assert.equal(inFlight, 0);
    }
  });

  it('streams a large file in pieces, writing and checking it without reading it whole', async () => {
    const ipod = await signedIpod();
    const backup = await backedUp(ipod);
    const size = 9 * 1024 * 1024 + 123;
    const byteAt = (index) => (index * 31 + (index >>> 11)) & 0xff;
    const piece = (start, end) => Uint8Array.from({ length: end - start }, (_, i) => byteAt(start + i));
    const ranges = [];
    const data = { size, read: async (start, end) => (ranges.push([start, end]), piece(start, Math.min(end, size))) };
    const item = makeItem('movie', { data, durationMs: 60_000 });
    const plan = await planSync(ipod, newEngine, [item]);

    const report = await applySync(plan, ipod, newEngine, { backup });
    assert.deepEqual(report.failures, []);
    assert.equal(report.verified, true);

    const chunk = 4 * 1024 * 1024;
    assert.equal(ranges.length, 6, 'three pieces to write and the same three to check');
    assert.deepEqual(ranges.slice(0, 3), [[0, chunk], [chunk, 2 * chunk], [2 * chunk, size]]);
    assert.ok(ranges.every(([start, end]) => end - start <= chunk), 'no piece is bigger than 4 MiB');
    assert.deepEqual(snapshot(ipod).get(plan.files[0].path), piece(0, size));
  });

  it('reads the copy back from the iPod in pieces when the file allows it, as a browser File does', async () => {
    const ipod = await signedIpod();
    const backup = await backedUp(ipod);
    const item = makeItem('music', { size: 10_000 });
    const plan = await planSync(ipod, newEngine, [item]);
    const slices = [];
    // A stand-in for the browser: the file read back is a Blob, which has slice().
    const asBlob = (folder) => ({
      ...instrument(folder, {}),
      getDirectoryHandle: async (name, options) => asBlob(await folder.getDirectoryHandle(name, options)),
      getFileHandle: async (name, options) => {
        const handle = await instrument(folder, {}).getFileHandle(name, options);
        return {
          ...handle,
          getFile: async () => {
            const file = await handle.getFile();
            const blob = new Blob([new Uint8Array(await file.arrayBuffer())]);
            return { size: blob.size, arrayBuffer: () => blob.arrayBuffer(), slice: (start, end) => (slices.push([start, end]), blob.slice(start, end)) };
          },
        };
      },
    });
    const report = await applySync(plan, asBlob(ipod), newEngine, { backup, chunkBytes: 4096 });
    assert.equal(report.verified, true);
    assert.deepEqual(slices, [[0, 4096], [4096, 8192], [8192, 10_000]]);
  });

  it('reports progress with bytes done, bytes in all, the current file and a rate', async () => {
    const ipod = await signedIpod();
    const backup = await backedUp(ipod);
    const items = [makeItem('music', { size: 5000 }), makeItem('podcast', { size: 7000 })];
    const plan = await planSync(ipod, newEngine, items);
    const events = [];
    const report = await applySync(plan, ipod, newEngine, { backup, chunkBytes: 1000, onProgress: (event) => events.push(event) });
    assert.equal(report.verified, true);

    const phases = [...new Set(events.map((event) => event.phase))];
    assert.deepEqual(phases, ['checking', 'copying', 'database', 'verifying', 'done']);
    const copying = events.filter((event) => event.phase === 'copying' && event.message.startsWith('Copying'));
    assert.equal(copying.length, 12, 'one event per piece written');
    assert.ok(copying.every((event) => plan.files.some((file) => file.path === event.currentFile)));
    assert.ok(copying.every((event, index) => index === 0 || event.bytesDone > copying[index - 1].bytesDone));
    assert.ok(copying.every((event) => event.bytesTotal === 12_000));
    assert.ok(events.some((event) => typeof event.bytesPerSecond === 'number' && event.bytesPerSecond > 0));
    assert.equal(events.at(-1).bytesDone, 12_000);
  });

  it('accepts a browser File or Blob as the source', async () => {
    const { syncDataFromBlob } = await import('../js/index.ts');
    const bytes = bytesFor(7, 3000);
    const data = syncDataFromBlob(new Blob([bytes]));
    assert.equal(data.size, 3000);
    assert.deepEqual(await data.read(10, 20), bytes.slice(10, 20));
    assert.deepEqual(await syncDataFromBytes(bytes).read(2990, 4000), bytes.slice(2990));
  });
});

describe('where a sync writes', () => {
  it('only touches the database folders and the music folders, and deletes nothing it did not make', async () => {
    const ipod = await signedIpod();
    const before = snapshot(ipod);
    const backup = await backedUp(ipod);
    const plan = await planSync(ipod, newEngine, Object.values(oneOfEach()));
    const report = await applySync(plan, ipod, newEngine, { backup });
    assert.equal(report.verified, true);

    const after = snapshot(ipod);
    for (const [path, bytes] of after) {
      const was = before.get(path);
      if (was && was.length === bytes.length && was.every((byte, i) => byte === bytes[i])) continue;
      assert.ok(DATABASE.test(path) || MEDIA.test(path), `${path} was written`);
      if (MEDIA.test(path)) assert.ok(!was, `${path} was not there before, nothing was overwritten`);
    }
    const gone = [...before.keys()].filter((path) => !after.has(path));
    assert.deepEqual(gone, [`${ITUNES}/Play Counts`], 'only the file libgpod folds into the library on every write');
  });

  it('copies and checks every media file before it writes any database file', async () => {
    const ipod = await signedIpod();
    const backup = await backedUp(ipod);
    const plan = await planSync(ipod, newEngine, [makeItem('music'), makeItem('movie'), makeItem('audiobook'), makeItem('podcast')]);
    const events = [];
    const report = await applySync(plan, instrument(ipod, { log: (event, path) => events.push({ event, path }) }), newEngine, { backup });
    assert.equal(report.verified, true);
    const lastMedia = events.findLastIndex((entry) => MEDIA.test(entry.path));
    const firstDatabase = events.findIndex((entry) => DATABASE.test(entry.path));
    assert.equal(events.filter((entry) => MEDIA.test(entry.path)).length, 4);
    assert.ok(lastMedia < firstDatabase, 'all media first');
    assert.deepEqual(events.slice(-2).map((entry) => entry.path), [`${ITUNES}/iTunesCDB`, `${ITUNES}/Play Counts`], 'the signed database last, then the removal');
  });

  it('refuses a plan that was changed to point anywhere else, before writing anything', async () => {
    const ipod = await signedIpod();
    const before = snapshot(ipod);
    const backup = await backedUp(ipod);

    const sneaky = await planSync(ipod, newEngine, [makeItem('music')]);
    sneaky.files[0].path = 'iPod_Control/Music/F00/../../../evil.mp3';
    await assert.rejects(applySync(sneaky, ipod, newEngine, { backup }), (error) => error instanceof SyncError && /not directly inside a Music\/Fxx folder/.test(error.message));

    const parent = await planSync(ipod, newEngine, [makeItem('music')]);
    parent.files[0].path = 'iPod_Control/Music/F00/..';
    await assert.rejects(applySync(parent, ipod, newEngine, { backup }), /not directly inside a Music\/Fxx folder/);

    const artwork = await planSync(ipod, newEngine, [makeItem('music')]);
    artwork.database.push({ path: 'iPod_Control/Artwork/ArtworkDB', kind: 'added', sizeBefore: null, sizeAfter: 1 });
    await assert.rejects(applySync(artwork, ipod, newEngine, { backup }), /outside the iPod's database folders/);
    assert.deepEqual(snapshot(ipod), before);
  });

  it('skips files the iPod cannot play as they are, or that cannot be on it', async () => {
    const ipod = await signedIpod();
    const items = [
      makeItem('music', { extension: '.flac' }),
      makeItem('music', { data: syncDataFromBytes(new Uint8Array(0)) }),
      makeItem('music', { data: { size: 2 ** 32, read: async () => new Uint8Array(0) } }),
      makeItem('music', { extension: 'aac' }),
      makeItem('audiobook', { extension: '.aax' }),
      makeItem('music'),
    ];
    const plan = await planSync(ipod, newEngine, items);
    assert.deepEqual(plan.skipped.map((skip) => skip.itemId), items.slice(0, 5).map((item) => item.id));
    assert.match(plan.skipped[0].reason, /does not play \.flac files/);
    assert.match(plan.skipped[1].reason, /empty/);
    assert.match(plan.skipped[2].reason, /more than the 4 GB/);
    assert.match(plan.skipped[3].reason, /does not play \.aac files as they are/);
    assert.match(plan.skipped[4].reason, /Audible files/);
    assert.deepEqual(plan.files.map((file) => file.itemId), [items[5].id]);
    await assert.rejects(planSync(ipod, newEngine, [items[5], { ...items[5] }]), /share the id/);
  });
});
