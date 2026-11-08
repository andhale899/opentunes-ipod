// A partial copy: only some kinds, or only chosen tracks, with the library always complete.
//
// The iPods are in-memory folders written by the real engine (see sync-helpers.mjs), with larger
// stand-in music files. The tests show what the code does with them. They cannot show that it works on
// a real iPod over USB, or how fast it is. The device identity in these iPods is made up.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ScratchFolder,
  WriteBackError,
  checkBackup,
  describeBackup,
  describeOffload,
  includeMatcher,
  mediaPathOf,
  offloadIpod,
  partialLine,
  resolveBackupFolder,
  restoreBackup,
  restoreOffload,
  trackKey,
} from '../js/index.ts';
import { bytesFor, instrument, newEngine, putFile, readIpod, signedIpod, snapshot } from './sync-helpers.mjs';

const NOW = new Date(2026, 10, 7, 18, 4);
const CHUNK = 1000;
const MARKER = 'opentunes-offload.json';
const decode = (bytes) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);

/** A nano 7G-style iPod (two music tracks, a podcast, an audiobook and a movie) with real-sized, different music files. */
async function ipodWithMusic() {
  const ipod = await signedIpod();
  const engine = await readIpod(ipod);
  const byTitle = new Map();
  let seed = 1;
  for (const track of engine.tracks()) {
    const path = mediaPathOf(track.ipod_path);
    const bytes = bytesFor(seed, 2500 + seed * 700);
    seed += 1;
    await putFile(ipod, path, bytes);
    byTitle.set(track.title, { path: path.slice('iPod_Control/Music/'.length), bytes, key: trackKey(track), kind: track.kind });
  }
  return { ipod, byTitle, tracks: engine.tracks() };
}

async function offloaded(ipod, options = {}) {
  const destination = new ScratchFolder('Backups');
  const report = await offloadIpod(ipod, destination, newEngine, { now: NOW, chunkBytes: CHUNK, ...options });
  return { destination, report, folder: await destination.getDirectoryHandle(report.folder) };
}

const markerOf = (folder) => JSON.parse(decode(folder.listFiles().get(MARKER)));
const mediaIn = (folder) => [...folder.listFiles().keys()].filter((path) => /^F\d\d\//.test(path)).sort();
const libraryOf = async (ipod) => {
  const engine = await readIpod(ipod);
  return JSON.stringify({ tracks: engine.tracks(), playlists: engine.playlists() });
};
async function wipe(ipod) {
  const control = await ipod.getDirectoryHandle('iPod_Control');
  for (const name of ['Music', 'iTunes', 'Device']) await control.removeEntry(name);
}
const csvRows = (text) => text.split('\r\n').filter(Boolean).slice(1);

describe('which tracks a copy takes', () => {
  const tracks = [
    { kind: 'music', ipod_path: ':iPod_Control:Music:F01:A.mp3', title: 'a', artist: null, album: null, tracklen: 1 },
    { kind: 'podcast', ipod_path: ':iPod_Control:Music:F02:B.mp3', title: 'b', artist: null, album: null, tracklen: 1 },
    { kind: 'movie', ipod_path: ':iPod_Control:Music:F03:C.m4v', title: 'c', artist: null, album: null, tracklen: 1 },
  ];
  const take = (include) => tracks.filter(includeMatcher(include)).map((track) => track.title);

  it('takes everything with no limit, by kind, by track key, and both together', () => {
    assert.deepEqual(take(undefined), ['a', 'b', 'c']);
    assert.deepEqual(take({}), ['a', 'b', 'c']);
    assert.deepEqual(take({ kinds: ['podcast'] }), ['b']);
    assert.deepEqual(take({ kinds: ['podcast', 'movie'] }), ['b', 'c']);
    assert.deepEqual(take({ trackKeys: [trackKey(tracks[0]), trackKey(tracks[2])] }), ['a', 'c']);
    assert.deepEqual(take({ kinds: ['movie'], trackKeys: [trackKey(tracks[0]), trackKey(tracks[2])] }), ['c'], 'both limits must hold');
    assert.deepEqual(take({ kinds: [] }), [], 'an empty list of kinds takes nothing');
  });

  it('says what a partial copy holds in one fixed sentence', () => {
    assert.equal(
      partialLine({ kinds: ['podcast'], selectedOnly: false, tracksInCopy: 1, tracksNotIncluded: 4 }, 5),
      'This copy holds the files for 1 of 5 tracks. The other 4 tracks stay as they are on the iPod, or will have no file if the iPod was wiped.',
    );
  });
});

describe('a copy of only some kinds', () => {
  it('copies only the podcast, saves the whole library in database/, and only reads the iPod', async () => {
    const { ipod, byTitle } = await ipodWithMusic();
    const before = snapshot(ipod);
    const writes = [];
    const { report, folder } = await offloaded(instrument(ipod, { log: (event, path) => writes.push(`${event} ${path}`) }), { include: { kinds: ['podcast'] } });

    assert.deepEqual(writes, []);
    assert.deepEqual(snapshot(ipod), before);
    const podcast = byTitle.get('Episode 12: Engines');
    assert.deepEqual(mediaIn(folder), [podcast.path]);
    assert.deepEqual(folder.listFiles().get(podcast.path), podcast.bytes);
    assert.equal(report.files.total, 1);
    assert.equal(report.files.copied, 1);
    assert.equal(report.complete, true, 'complete for what was asked for');

    // The database part is whole: a complete backup of the whole library.
    assert.equal(report.database.complete, true);
    const manifest = JSON.parse(decode(folder.listFiles().get('database/backup-info.json')));
    assert.equal(manifest.complete, true);
    for (const file of manifest.files) assert.deepEqual(folder.listFiles().get(`database/${file.path}`), before.get(file.path));
    assert.equal(report.tracks, 5, 'the library still lists every track');
    assert.deepEqual(report.partial, { kinds: ['podcast'], selectedOnly: false, tracksInCopy: 1, tracksNotIncluded: 4 });
    assert.deepEqual(report.unlisted, []);
  });

  it('writes a marker, a README and a library.csv that all say it is partial', async () => {
    const { ipod, byTitle } = await ipodWithMusic();
    const { folder } = await offloaded(ipod, { include: { kinds: ['podcast', 'audiobook'] } });

    const marker = markerOf(folder);
    assert.equal(marker.formatVersion, 1);
    assert.equal(marker.complete, true);
    assert.deepEqual(marker.partial, { kinds: ['podcast', 'audiobook'], selectedOnly: false, tracksInCopy: 2, tracksNotIncluded: 3 });
    assert.equal(marker.mediaFiles, 2);
    assert.equal(marker.tracks, 5);
    assert.deepEqual(marker.media.map((entry) => entry.path).sort(), [byTitle.get('Episode 12: Engines').path, byTitle.get('A Short Story').path].sort());

    const readme = decode(folder.listFiles().get('README.txt'));
    assert.match(readme, /PARTIAL copy of an iPod/);
    assert.match(readme, /podcasts, audiobooks/);
    assert.match(readme, /NOT EVERYTHING IS HERE/);
    assert.match(readme, /holds the files for 2 of 5 tracks/);
    assert.match(readme, /3 tracks were left out on purpose/);
    assert.match(readme, /no file in this folder/);
    assert.doesNotMatch(readme, /is a full copy of an iPod/);

    const rows = csvRows(decode(folder.listFiles().get('library.csv')));
    assert.equal(rows.length, 5);
    const left = rows.filter((row) => row.endsWith('not included in this copy'));
    assert.equal(left.length, 3, 'the three tracks left out say so in the File column');
    for (const row of left) assert.ok(row.startsWith(','), 'and have no path, since there is no file in this folder');
    assert.equal(rows.filter((row) => row.endsWith(',copied')).length, 2);
    const playlists = decode(folder.listFiles().get('playlists.csv'));
    assert.ok(playlists.length > 0);
  });

  it('a full copy is not marked partial, and a filter that takes everything is not either', async () => {
    const { ipod } = await ipodWithMusic();
    const full = await offloaded(ipod);
    assert.equal(full.report.partial, null);
    assert.equal(markerOf(full.folder).partial ?? null, null);
    assert.match(decode(full.folder.listFiles().get('README.txt')), /is a full copy of an iPod/);
    const everything = await offloaded(ipod, { include: { kinds: ['music', 'podcast', 'audiobook', 'movie'] } });
    assert.equal(everything.report.partial, null, 'no track was left out');
    assert.equal(everything.report.files.total, 5);
  });

  it('refuses a partial copy when the library cannot be read, and copies nothing', async () => {
    const { ipod } = await ipodWithMusic();
    const control = await ipod.getDirectoryHandle('iPod_Control');
    await control.removeEntry('iTunes');
    const destination = new ScratchFolder('Backups');
    await assert.rejects(offloadIpod(ipod, destination, newEngine, { now: NOW, chunkBytes: CHUNK, include: { kinds: ['podcast'] } }), /library could not be read|no iTunes folder/);
    assert.equal(destination.listFiles().size, 0, 'nothing was written');
  });
});

describe('a copy of chosen tracks', () => {
  it('copies only the tracks named by key, and by key within a kind', async () => {
    const { ipod, byTitle } = await ipodWithMusic();
    const keys = [byTitle.get('Morning Light').key, byTitle.get('Demo Film').key];
    const only = await offloaded(ipod, { include: { trackKeys: keys } });
    assert.deepEqual(mediaIn(only.folder), [byTitle.get('Morning Light').path, byTitle.get('Demo Film').path].sort());
    assert.deepEqual(only.report.partial, { kinds: null, selectedOnly: true, tracksInCopy: 2, tracksNotIncluded: 3 });
    assert.match(decode(only.folder.listFiles().get('README.txt')), /only the tracks that were selected/);

    const within = await offloaded(ipod, { include: { trackKeys: keys, kinds: ['movie'] } });
    assert.deepEqual(mediaIn(within.folder), [byTitle.get('Demo Film').path]);
    assert.deepEqual(within.report.partial, { kinds: ['movie'], selectedOnly: true, tracksInCopy: 1, tracksNotIncluded: 4 });
  });
});

describe('stopping and resuming a partial copy', () => {
  it('a resume with the same choice finishes it, skipping what is there, and stays partial', async () => {
    const { ipod, byTitle } = await ipodWithMusic();
    const include = { kinds: ['music', 'podcast'] };
    const controller = new AbortController();
    let closed = 0;
    const destination = new ScratchFolder('Backups');
    const watched = instrument(destination, {
      closed: (path) => {
        if (!/(^|\/)F\d\d\/[^/]+$/.test(path) || path.includes('database/')) return;
        closed += 1;
        if (closed === 1) controller.abort();
      },
    });
    const first = await offloadIpod(ipod, watched, newEngine, { now: NOW, chunkBytes: CHUNK, concurrency: 1, signal: controller.signal, include });
    assert.equal(first.stopped, true);
    assert.equal(first.complete, false);
    const stopped = JSON.parse(decode(destination.listFiles().get(`${first.folder}/${MARKER}`)));
    assert.equal(stopped.complete, false);

    const second = await offloadIpod(ipod, destination, newEngine, { now: NOW, chunkBytes: CHUNK, include, folder: first.folder });
    assert.equal(second.complete, true);
    assert.equal(second.files.skipped, 1);
    assert.equal(second.files.copied, 2);
    assert.equal(second.files.total, 3);
    const folder = await destination.getDirectoryHandle(first.folder);
    assert.deepEqual(mediaIn(folder), ['Morning Light', 'Night Drive', 'Episode 12: Engines'].map((title) => byTitle.get(title).path).sort());
    assert.deepEqual(markerOf(folder).partial, { kinds: ['music', 'podcast'], selectedOnly: false, tracksInCopy: 3, tracksNotIncluded: 2 });
  });
});

describe('putting back from a partial copy', () => {
  it('says plainly that the copy holds some of the tracks, in the description and in the report', async () => {
    const { ipod } = await ipodWithMusic();
    const { folder } = await offloaded(ipod, { include: { kinds: ['podcast'] } });
    const summary = await describeOffload(folder, ipod);
    assert.deepEqual(summary.partial, { kinds: ['podcast'], selectedOnly: false, tracksInCopy: 1, tracksNotIncluded: 4 });
    assert.equal(summary.tracks, 5);
    assert.equal(summary.mediaFiles, 1);
    assert.equal(summary.complete, true);

    const full = await offloaded(ipod);
    assert.equal((await describeOffload(full.folder)).partial, null);
  });

  it('on a wiped iPod it copies back the files it has, restores the whole library, and reports that the rest have no file', async () => {
    const { ipod, byTitle } = await ipodWithMusic();
    const library = await libraryOf(ipod);
    const { folder } = await offloaded(ipod, { include: { kinds: ['podcast'] } });
    await wipe(ipod);

    const report = await restoreOffload(ipod, folder, { newEngine, chunkBytes: CHUNK });
    assert.equal(report.complete, true);
    assert.equal(report.files.copied, 1);
    assert.deepEqual(report.partial, { kinds: ['podcast'], selectedOnly: false, tracksInCopy: 1, tracksNotIncluded: 4 });
    assert.equal(report.tracks, 5);
    assert.match(report.summary, /This copy holds the files for 1 of 5 tracks\. The other 4 tracks stay as they are on the iPod, or will have no file if the iPod was wiped\./);
    assert.equal(await libraryOf(ipod), library, 'the library lists all five tracks again');
    const music = [...snapshot(ipod).keys()].filter((path) => path.startsWith('iPod_Control/Music/'));
    assert.deepEqual(music, [`iPod_Control/Music/${byTitle.get('Episode 12: Engines').path}`], 'only the one file is there');
  });

  it('leaves the files an iPod still holds alone, and a full copy has no such line', async () => {
    const { ipod } = await ipodWithMusic();
    const partial = await offloaded(ipod, { include: { kinds: ['podcast'] } });
    const before = snapshot(ipod);
    const report = await restoreOffload(ipod, partial.folder, { newEngine, chunkBytes: CHUNK });
    assert.equal(report.files.alreadyThere, 1);
    for (const [path, bytes] of before) if (path.startsWith('iPod_Control/Music/')) assert.deepEqual(snapshot(ipod).get(path), bytes);
    const full = await offloaded(ipod);
    const fullReport = await restoreOffload(ipod, full.folder, { newEngine, chunkBytes: CHUNK });
    assert.equal(fullReport.partial, null);
    assert.doesNotMatch(fullReport.summary, /This copy holds the files for/);
  });
});

describe('restoring a backup from a full-copy folder', () => {
  it('accepts the full-copy folder itself and its database/ folder, and puts the library back', async () => {
    const { ipod } = await ipodWithMusic();
    const library = await libraryOf(ipod);
    const { folder } = await offloaded(ipod);
    const database = await folder.getDirectoryHandle('database');

    const resolved = await resolveBackupFolder(folder);
    assert.equal(resolved.folder, database);
    assert.equal(resolved.via, folder.name);
    assert.equal((await resolveBackupFolder(database)).via, null, 'a backup folder stays as it is');
    assert.equal((await describeBackup(folder)).files, (await describeBackup(database)).files);
    assert.equal((await checkBackup(folder)).files, (await checkBackup(database)).files);

    for (const given of [folder, database]) {
      const control = await ipod.getDirectoryHandle('iPod_Control');
      for (const name of ['iTunes', 'Device']) await control.removeEntry(name);
      const report = await restoreBackup(ipod, given, { newEngine });
      assert.equal(report.verified, true, `restored from ${given.name}`);
      assert.equal(await libraryOf(ipod), library);
    }
  });

  it('says plainly when a full-copy folder has lost its database folder, and for a folder that is neither', async () => {
    const { ipod } = await ipodWithMusic();
    const { destination, folder } = await offloaded(ipod);
    const broken = new ScratchFolder('copy without database');
    const writer = await (await broken.getFileHandle(MARKER, { create: true })).createWritable();
    await writer.write(folder.listFiles().get(MARKER));
    await writer.close();
    await assert.rejects(restoreBackup(ipod, broken, { newEngine }), (error) => error instanceof WriteBackError && /full-copy folder, but it has no database folder/.test(error.message));
    await assert.rejects(restoreBackup(ipod, new ScratchFolder('Docs'), { newEngine }), /has no backup-info\.json/);
    assert.ok(destination);
  });
});
