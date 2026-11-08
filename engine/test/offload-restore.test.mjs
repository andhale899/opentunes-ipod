// An offload folder that holds everything, and putting everything back from it.
//
// The iPods are in-memory folders written by the real engine (see sync-helpers.mjs), with the
// stand-in music files replaced by larger ones so a file takes several pieces. The tests show what
// the code does with them. They cannot show that it works on a real iPod over USB, or how fast it
// is: only a run on the owner's hardware can. The device identity in these iPods is made up.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ScratchFolder, WriteBackError, describeOffload, isOffloadFolder, mediaPathOf, offloadIpod, restoreOffload } from '../js/index.ts';
import { bytesFor, folderOf, instrument, newEngine, putFile, readIpod, signedIpod, snapshot, writeFile } from './sync-helpers.mjs';

const NOW = new Date(2026, 10, 7, 18, 4);
const CHUNK = 1000;
const MARKER = 'opentunes-offload.json';

/** A nano 7G-style iPod whose music files are real-sized and different from each other. */
async function ipodWithMusic() {
  const ipod = await signedIpod();
  const engine = await readIpod(ipod);
  const files = new Map();
  let seed = 1;
  for (const track of engine.tracks()) {
    const path = mediaPathOf(track.ipod_path);
    const bytes = bytesFor(seed, 2500 + seed * 700);
    seed += 1;
    await putFile(ipod, path, bytes);
    files.set(path.slice('iPod_Control/Music/'.length), bytes);
  }
  const stray = bytesFor(99, 1800);
  await putFile(ipod, 'iPod_Control/Music/F20/STRAY.mp3', stray);
  files.set('F20/STRAY.mp3', stray);
  return { ipod, files };
}

/** Offloads the iPod into a fresh destination. Returns the destination, the report and the offload folder. */
async function offloaded(ipod, options = {}) {
  const destination = new ScratchFolder('Backups');
  const report = await offloadIpod(ipod, destination, newEngine, { now: NOW, chunkBytes: CHUNK, ...options });
  return { destination, report, folder: await destination.getDirectoryHandle(report.folder) };
}

/** Takes the music and the database off the iPod, as a wiped or replaced iPod would be. Other files stay. */
async function wipe(ipod) {
  const control = await ipod.getDirectoryHandle('iPod_Control');
  for (const name of ['Music', 'iTunes', 'Device']) await control.removeEntry(name);
}

const restore = (ipod, folder, options = {}) => restoreOffload(ipod, folder, { newEngine, chunkBytes: CHUNK, ...options });
// iTunesControl and the radio buffer are files libgpod never opens. Backups leave them out, so a wiped iPod does not get them back.
const NEVER_SAVED = ['iPod_Control/iTunes/iTunesControl', 'iPod_Control/Device/Radio/RadioBuffer'];
const withoutNeverSaved = (files) => new Map([...files].filter(([path]) => !NEVER_SAVED.includes(path)));
const musicOf = (ipod) => new Map([...snapshot(ipod)].filter(([path]) => path.startsWith('iPod_Control/Music/')));
const libraryOf = async (ipod) => {
  const engine = await readIpod(ipod);
  return JSON.stringify({ tracks: engine.tracks(), playlists: engine.playlists() });
};
const isMedia = (path) => /(^|\/)F\d\d\/[^/]+$/.test(path) && !path.includes('database/');

/** The offload folder wrapped so one media file reads with an error, as a failing disk would. */
function unreadable(folder, badPath, prefix = '') {
  return {
    kind: 'directory',
    name: folder.name,
    async *entries() {
      yield* folder.entries();
    },
    getDirectoryHandle: async (name) => unreadable(await folder.getDirectoryHandle(name), badPath, `${prefix}${name}/`),
    getFileHandle: async (name) => {
      const handle = await folder.getFileHandle(name);
      if (`${prefix}${name}` !== badPath) return handle;
      return {
        kind: 'file',
        name,
        getFile: async () => {
          const file = await handle.getFile();
          return { size: file.size, arrayBuffer: async () => { throw new Error('read error in the offload folder'); }, slice: () => ({ arrayBuffer: async () => { throw new Error('read error in the offload folder'); } }) };
        },
      };
    },
  };
}

describe('what an offload folder now holds', () => {
  it('has the database files in backup format, checked, and a marker with the counts and checksums', async () => {
    const { ipod, files } = await ipodWithMusic();
    const before = snapshot(ipod);
    const writes = [];
    const { report, folder } = await offloaded(instrument(ipod, { log: (event, path) => writes.push(`${event} ${path}`) }));

    assert.equal(report.complete, true);
    assert.deepEqual(writes, [], 'the iPod is only read');
    assert.deepEqual(snapshot(ipod), before);
    assert.equal(report.database.complete, true);
    assert.equal(report.database.folder, 'database');
    assert.equal(report.databaseError, null);

    const all = folder.listFiles();
    const manifest = JSON.parse(new TextDecoder().decode(all.get('database/backup-info.json')));
    assert.equal(manifest.kind, 'ipod-database-backup', 'the same format backupIpod writes');
    assert.equal(manifest.complete, true);
    assert.ok(manifest.files.length > 0);
    for (const file of manifest.files) assert.deepEqual(all.get(`database/${file.path}`), before.get(file.path), `${file.path} is the iPod's own file`);
    assert.ok(all.has('database/README.txt'));
    assert.ok(![...all.keys()].some((path) => path.startsWith('database/iPod_Control/Music')), 'no music in database/');

    const marker = JSON.parse(new TextDecoder().decode(all.get(MARKER)));
    assert.equal(marker.kind, 'ipod-offload');
    assert.equal(marker.formatVersion, 1);
    assert.equal(marker.complete, true);
    assert.equal(marker.databaseFolder, 'database');
    assert.equal(marker.createdAt, NOW.toISOString());
    assert.equal(marker.mediaFiles, files.size);
    assert.equal(marker.mediaBytes, [...files.values()].reduce((sum, bytes) => sum + bytes.length, 0));
    assert.deepEqual(marker.media.map((entry) => entry.path).sort(), [...files.keys()].sort());
    assert.ok(marker.media.every((entry) => Number.isInteger(entry.crc32) && entry.size === files.get(entry.path).length));
    assert.ok(!/serial|firewire|guid/i.test(JSON.stringify(Object.keys(marker))), 'the marker has no field for the device identity');

    const readme = new TextDecoder().decode(all.get('README.txt'));
    assert.match(readme, /START HERE to browse/);
    assert.match(readme, /Restore everything from a full copy/);
    assert.match(readme, /Keep this folder private/);
    assert.match(readme, /database\//);
    assert.match(readme, /not the same/);
  });

  it('is resumed into the same folder: the marker is kept, skipped files keep their checksums, database/ is saved again', async () => {
    const { ipod } = await ipodWithMusic();
    const controller = new AbortController();
    let closed = 0;
    const destination = new ScratchFolder('Backups');
    const watched = instrument(destination, { closed: (path) => { if (!isMedia(path)) return; closed += 1; if (closed === 2) controller.abort(); } });
    const first = await offloadIpod(ipod, watched, newEngine, { now: NOW, chunkBytes: CHUNK, concurrency: 1, signal: controller.signal });
    assert.equal(first.stopped, true);
    const stopped = JSON.parse(new TextDecoder().decode(destination.listFiles().get(`${first.folder}/${MARKER}`)));
    assert.equal(stopped.complete, false);
    assert.equal(stopped.mediaFiles, 2, 'only the two files that were copied are listed');
    assert.equal(first.database.complete, true, 'the library files are saved first, so they are there');

    const second = await offloadIpod(ipod, destination, newEngine, { now: NOW, chunkBytes: CHUNK, folder: first.folder });
    assert.equal(second.complete, true);
    assert.equal(second.files.skipped, 2);
    const done = JSON.parse(new TextDecoder().decode(destination.listFiles().get(`${first.folder}/${MARKER}`)));
    assert.equal(done.complete, true);
    assert.equal(done.mediaFiles, second.files.total);
    for (const entry of stopped.media) assert.deepEqual(done.media.find((other) => other.path === entry.path), entry, 'a skipped file keeps its checksum');
    assert.deepEqual([...destination.listFiles().keys()].filter((path) => path.startsWith('opentunes-offload-2026-11-07-1804-')), []);
    await wipe(ipod);
    const back = await restore(ipod, await destination.getDirectoryHandle(first.folder));
    assert.equal(back.complete, true, 'a resumed offload folder can put everything back');
  });

  it('says so when the database files cannot be saved, and the marker is not complete', async () => {
    const { ipod } = await ipodWithMusic();
    const control = await ipod.getDirectoryHandle('iPod_Control');
    await control.removeEntry('iTunes');
    await control.removeEntry('Device');
    const { report, folder } = await offloaded(ipod);
    assert.equal(report.complete, false);
    assert.ok(report.databaseError || report.database?.complete === false);
    assert.equal(JSON.parse(new TextDecoder().decode(folder.listFiles().get(MARKER))).complete, false);
    await assert.rejects(restore(ipod, folder), /was not complete/);
  });
});

describe('putting everything back', () => {
  it('copies the media back, then the database, and the iPod reads back the same, byte for byte', async () => {
    const { ipod, files } = await ipodWithMusic();
    const original = snapshot(ipod);
    const library = await libraryOf(ipod);
    const { folder } = await offloaded(ipod);

    await wipe(ipod);
    assert.equal(musicOf(ipod).size, 0);

    const order = [];
    const progress = [];
    const watched = instrument(ipod, { log: (event, path) => order.push(path) });
    const report = await restore(watched, folder, { onProgress: (p) => progress.push(p) });

    assert.equal(report.complete, true);
    assert.equal(report.stopped, false);
    assert.equal(report.files.copied, files.size);
    assert.equal(report.files.alreadyThere, 0);
    assert.deepEqual([report.files.failed, report.files.notCopied], [0, 0]);
    assert.equal(report.database.verified, true);
    assert.match(report.summary, new RegExp(`${files.size} files were copied back`));
    assert.match(report.summary, /library was put back, read back and checked/);

    // Same media bytes, same database files, same library.
    for (const [path, bytes] of files) assert.deepEqual(snapshot(ipod).get(`iPod_Control/Music/${path}`), bytes, `${path} is identical`);
    assert.deepEqual(snapshot(ipod), withoutNeverSaved(original));
    assert.equal(await libraryOf(ipod), library);

    // Every media file went on before the first database file.
    const firstDatabase = order.findIndex((path) => !path.startsWith('iPod_Control/Music/'));
    const lastMedia = order.map((path) => path.startsWith('iPod_Control/Music/')).lastIndexOf(true);
    assert.ok(firstDatabase > lastMedia, 'the database was restored after all media');

    // Progress: files and bytes of what had to be copied, a speed, never more than three at once.
    const copying = progress.filter((p) => p.phase === 'copying');
    assert.equal(copying.at(-1).filesDone, files.size);
    assert.equal(copying.at(-1).filesTotal, files.size);
    assert.equal(copying.at(-1).bytesDone, copying.at(-1).bytesTotal);
    assert.ok(progress.some((p) => p.bytesPerSecond > 0));
    assert.ok(progress.every((p) => p.current.length <= 3));
    assert.ok(progress.some((p) => p.phase === 'checking') && progress.some((p) => p.phase === 'restoring'));
  });

  it('writes in pieces of the chunk size, up to three files at once, and deletes nothing', async () => {
    const { ipod } = await ipodWithMusic();
    const { folder } = await offloaded(ipod);
    await wipe(ipod);
    let open = 0;
    let most = 0;
    let longest = 0;
    const removed = [];
    const watched = instrument(ipod, {
      opened: (path) => { if (path.startsWith('iPod_Control/Music/')) { open += 1; most = Math.max(most, open); } },
      closed: (path) => { if (path.startsWith('iPod_Control/Music/')) open -= 1; },
      write: (path, index, data) => { if (path.startsWith('iPod_Control/Music/')) longest = Math.max(longest, data.length); },
      remove: (path) => { removed.push(path); },
    });
    const report = await restore(watched, folder);
    assert.equal(report.complete, true);
    assert.equal(most, 3);
    assert.ok(longest <= CHUNK, `no piece was bigger than ${CHUNK} bytes (${longest})`);
    assert.deepEqual(removed, []);
  });

  it('leaves a file that is already there untouched, copies a missing one and one of the wrong size, and keeps unrelated files', async () => {
    const { ipod, files } = await ipodWithMusic();
    const { folder } = await offloaded(ipod);
    const keep = [...files.keys()][0];
    const missing = [...files.keys()][1];
    const wrongSize = [...files.keys()][2];
    const sameSizeOther = [...files.keys()][3];

    await (await folderOf(ipod, `iPod_Control/Music/${missing.split('/')[0]}`)).removeEntry(missing.split('/')[1]);
    await putFile(ipod, `iPod_Control/Music/${wrongSize}`, new Uint8Array(10));
    // Same size, other content: size is the rule for "already there", so this one is left as it is.
    const decoy = bytesFor(500, files.get(sameSizeOther).length);
    await putFile(ipod, `iPod_Control/Music/${sameSizeOther}`, decoy);
    await putFile(ipod, 'iPod_Control/Music/F30/EXTRA.mp3', new TextEncoder().encode('not in the offload'));
    await putFile(ipod, 'iPod_Control/iTunes/ChangedSinceOffload.txt', new TextEncoder().encode('new'));

    const writes = [];
    const report = await restore(instrument(ipod, { log: (event, path) => writes.push(path) }), folder);
    assert.equal(report.complete, true);
    assert.equal(report.files.copied, 2);
    assert.equal(report.files.alreadyThere, files.size - 2);
    assert.equal(report.bytes.copied, files.get(missing).length + files.get(wrongSize).length);
    assert.ok(!writes.includes(`iPod_Control/Music/${keep}`), 'a matching file is not written');
    assert.ok(!writes.includes(`iPod_Control/Music/${sameSizeOther}`));
    assert.deepEqual(snapshot(ipod).get(`iPod_Control/Music/${sameSizeOther}`), decoy);
    assert.deepEqual(snapshot(ipod).get(`iPod_Control/Music/${missing}`), files.get(missing));
    assert.deepEqual(snapshot(ipod).get(`iPod_Control/Music/${wrongSize}`), files.get(wrongSize));
    assert.ok(snapshot(ipod).has('iPod_Control/Music/F30/EXTRA.mp3'), 'a file the offload does not list is kept');
    assert.ok(snapshot(ipod).has('iPod_Control/iTunes/ChangedSinceOffload.txt'), 'a file outside the database list is kept');
  });

  it('with nothing to copy, restores only the database', async () => {
    const { ipod } = await ipodWithMusic();
    const { folder } = await offloaded(ipod);
    const report = await restore(ipod, folder);
    assert.equal(report.complete, true);
    assert.equal(report.files.copied, 0);
    assert.equal(report.bytes.copied, 0);
    assert.match(report.summary, /0 files were copied back/);
  });
});

describe('describing an offload folder', () => {
  it('says what it holds and how many files are already on the iPod', async () => {
    const { ipod, files } = await ipodWithMusic();
    const { folder } = await offloaded(ipod);
    const bytes = [...files.values()].reduce((sum, file) => sum + file.length, 0);

    const alone = await describeOffload(folder);
    assert.equal(alone.complete, true);
    assert.equal(alone.mediaFiles, files.size);
    assert.equal(alone.mediaBytes, bytes);
    assert.equal(alone.createdAt, NOW.toISOString());
    assert.ok(alone.databaseFiles > 0 && alone.databaseBytes > 0);
    assert.equal(alone.tracks, 5);
    assert.equal(alone.onIpod, undefined);

    const first = [...files.keys()][0];
    await (await folderOf(ipod, `iPod_Control/Music/${first.split('/')[0]}`)).removeEntry(first.split('/')[1]);
    const against = await describeOffload(folder, ipod);
    assert.deepEqual(against.onIpod, { alreadyThere: files.size - 1, toCopy: 1, bytesToCopy: files.get(first).length });
  });

  it('refuses what is not a usable offload folder', async () => {
    const { ipod } = await ipodWithMusic();
    const { folder } = await offloaded(ipod);
    await assert.rejects(describeOffload(new ScratchFolder('Docs')), /has no opentunes-offload\.json/);

    const wrongKind = new ScratchFolder('Other');
    await writeFile(wrongKind, MARKER, new TextEncoder().encode(JSON.stringify({ kind: 'something', media: [] })));
    await assert.rejects(describeOffload(wrongKind), /is not an iPod offload folder/);

    const newer = new ScratchFolder('Newer');
    await writeFile(newer, MARKER, new TextEncoder().encode(JSON.stringify({ kind: 'ipod-offload', formatVersion: 99, media: [] })));
    await assert.rejects(describeOffload(newer), /does not know how to read/);

    const noDatabase = new ScratchFolder('NoDatabase');
    await writeFile(noDatabase, MARKER, folder.listFiles().get(MARKER));
    await assert.rejects(describeOffload(noDatabase), /has no database folder/);

    const sneaky = new ScratchFolder('Sneaky');
    await writeFile(sneaky, MARKER, new TextEncoder().encode(JSON.stringify({ kind: 'ipod-offload', formatVersion: 1, databaseFolder: 'database', media: [{ path: '../../escape.mp3', size: 1, crc32: 1 }] })));
    await assert.rejects(describeOffload(sneaky), /lists a file it should not/);
  });

  it('can be told apart from a backup folder, which the Restore panel needs', async () => {
    const { ipod } = await ipodWithMusic();
    const { folder } = await offloaded(ipod);
    assert.equal(await isOffloadFolder(folder), true);
    assert.equal(await isOffloadFolder(await folder.getDirectoryHandle('database')), false, 'database/ is a backup folder');
    assert.equal(await isOffloadFolder(new ScratchFolder('Docs')), false);
  });

  it('is not used to restore when the copy was not complete', async () => {
    const { ipod } = await ipodWithMusic();
    const controller = new AbortController();
    let closed = 0;
    const destination = new ScratchFolder('Backups');
    const watched = instrument(destination, { closed: (path) => { if (!isMedia(path)) return; closed += 1; if (closed === 1) controller.abort(); } });
    const report = await offloadIpod(ipod, watched, newEngine, { now: NOW, chunkBytes: CHUNK, concurrency: 1, signal: controller.signal });
    const folder = await destination.getDirectoryHandle(report.folder);
    assert.equal((await describeOffload(folder)).complete, false);
    await wipe(ipod);
    const before = snapshot(ipod);
    await assert.rejects(restore(ipod, folder), /was not complete/);
    assert.deepEqual(snapshot(ipod), before, 'nothing was written');
  });
});

describe('a damaged offload folder', () => {
  it('refuses a damaged database file before any media is written', async () => {
    const { ipod } = await ipodWithMusic();
    const { folder } = await offloaded(ipod);
    await wipe(ipod);
    const before = snapshot(ipod);

    const database = await folder.getDirectoryHandle('database');
    const cdb = await folderOf(database, 'iPod_Control/iTunes');
    const file = await cdb.getFileHandle('iTunesCDB');
    file.bytes = Uint8Array.from(file.bytes, (byte, index) => (index === 10 ? byte ^ 0xff : byte));

    const writes = [];
    await assert.rejects(restore(instrument(ipod, { log: (event, path) => writes.push(path), open: (path) => { writes.push(`open ${path}`); } }), folder), (error) => error instanceof WriteBackError && /iTunesCDB does not match its checksum in the backup, so nothing was restored/.test(error.message));
    assert.deepEqual(writes, [], 'nothing was written, not even a media file');
    assert.deepEqual(snapshot(ipod), before);
  });

  it('refuses a database file that is missing from the folder', async () => {
    const { ipod } = await ipodWithMusic();
    const { folder } = await offloaded(ipod);
    await wipe(ipod);
    const itunes = await folderOf(await folder.getDirectoryHandle('database'), 'iPod_Control/iTunes');
    await itunes.removeEntry('iTunesCDB');
    await assert.rejects(restore(ipod, folder), /is listed in the backup but is not in the folder/);
    assert.equal(musicOf(ipod).size, 0);
  });

  it('reports a media file whose offload copy is damaged, copies the rest, and leaves the database alone', async () => {
    const { ipod, files } = await ipodWithMusic();
    const { folder } = await offloaded(ipod);
    await wipe(ipod);
    const bad = 'F20/STRAY.mp3';
    const handle = await (await folder.getDirectoryHandle('F20')).getFileHandle('STRAY.mp3');
    handle.bytes = Uint8Array.from(handle.bytes, (byte, index) => (index === 5 ? byte ^ 0xff : byte));

    const report = await restore(ipod, folder);
    assert.equal(report.complete, false);
    assert.equal(report.database, null, 'the database was not restored');
    assert.deepEqual(report.failures.map((failure) => failure.path), [bad]);
    assert.match(report.failures[0].reason, /does not match its checksum/);
    assert.equal(report.files.copied, files.size - 1);
    assert.match(report.summary, /1 file could not be copied back/);
    assert.match(report.summary, /library was not changed/);
    assert.ok(!snapshot(ipod).has(`iPod_Control/Music/${bad}`), 'nothing was written for the damaged file');
    assert.ok(![...snapshot(ipod).keys()].some((path) => path.startsWith('iPod_Control/iTunes')), 'the database is as it was: not there');
  });

  it('reports a media file that cannot be read from the offload folder, by name', async () => {
    const { ipod, files } = await ipodWithMusic();
    const { folder } = await offloaded(ipod);
    await wipe(ipod);
    const report = await restore(ipod, unreadable(folder, 'F20/STRAY.mp3'));
    assert.equal(report.complete, false);
    assert.equal(report.database, null);
    assert.equal(report.files.copied, files.size - 1);
    assert.equal(report.failures[0].path, 'F20/STRAY.mp3');
    assert.match(report.failures[0].reason, /read error in the offload folder/);
  });
});

describe('a file the iPod will not take', () => {
  it('is reported by name, the rest are copied, the database stays untouched, and a second run finishes', async () => {
    const { ipod, files } = await ipodWithMusic();
    const { folder } = await offloaded(ipod);
    await wipe(ipod);
    const full = instrument(ipod, { open: (path) => (path.endsWith('F20/STRAY.mp3') ? 'refuse' : undefined) });
    const report = await restore(full, folder);
    assert.equal(report.complete, false);
    assert.equal(report.database, null);
    assert.deepEqual(report.failures.map((failure) => failure.path), ['F20/STRAY.mp3']);
    assert.match(report.failures[0].reason, /disk is full/);
    assert.equal(report.files.copied, files.size - 1);
    assert.ok(![...snapshot(ipod).keys()].some((path) => path.startsWith('iPod_Control/iTunes')));

    const again = await restore(ipod, folder);
    assert.equal(again.complete, true);
    assert.equal(again.files.copied, 1);
    assert.equal(again.files.alreadyThere, files.size - 1);
  });

  it('is caught when it does not match when read back, and is not left looking good', async () => {
    const { ipod, files } = await ipodWithMusic();
    const { folder } = await offloaded(ipod);
    await wipe(ipod);
    const target = 'F20/STRAY.mp3';
    const damaging = instrument(ipod, { write: (path, index) => (path.endsWith(target) && index === 0 ? 'corrupt' : undefined) });
    const report = await restore(damaging, folder);
    assert.equal(report.complete, false);
    assert.equal(report.database, null);
    assert.deepEqual(report.failures.map((failure) => failure.path), [target]);
    assert.match(report.failures[0].reason, /did not match its checksum when it was read back/);
    assert.notEqual(snapshot(ipod).get(`iPod_Control/Music/${target}`).length, files.get(target).length, 'emptied, so a second run does not take it for a good file');

    const again = await restore(ipod, folder);
    assert.equal(again.complete, true);
    assert.deepEqual(snapshot(ipod).get(`iPod_Control/Music/${target}`), files.get(target));
  });
});

describe('stopping', () => {
  it('stops between files, leaves the database untouched, and a second run finishes', async () => {
    const { ipod, files } = await ipodWithMusic();
    const original = snapshot(ipod);
    const { folder } = await offloaded(ipod);
    await wipe(ipod);
    const controller = new AbortController();
    let closed = 0;
    const watched = instrument(ipod, { closed: (path) => { if (!path.startsWith('iPod_Control/Music/')) return; closed += 1; if (closed === 2) controller.abort(); } });

    const first = await restore(watched, folder, { concurrency: 1, signal: controller.signal });
    assert.equal(first.stopped, true);
    assert.equal(first.complete, false);
    assert.equal(first.database, null);
    assert.equal(first.files.copied, 2);
    assert.equal(first.files.notCopied, files.size - 2);
    assert.deepEqual(first.failures, [], 'a stop is not a failure');
    assert.match(first.summary, /it was stopped, with \d+ files not reached/);
    assert.ok(![...snapshot(ipod).keys()].some((path) => path.startsWith('iPod_Control/iTunes')), 'the database was not restored');

    const second = await restore(ipod, folder);
    assert.equal(second.complete, true);
    assert.equal(second.files.alreadyThere, 2);
    assert.equal(second.files.copied, files.size - 2);
    assert.deepEqual(snapshot(ipod), withoutNeverSaved(original));
  });

  it('stops in the middle of a file and leaves no half file behind', async () => {
    const { ipod, files } = await ipodWithMusic();
    const { folder } = await offloaded(ipod);
    await wipe(ipod);
    const controller = new AbortController();
    const watched = instrument(ipod, { write: (path, index) => { if (path.startsWith('iPod_Control/Music/') && index === 1) controller.abort(); } });
    const report = await restore(watched, folder, { concurrency: 1, signal: controller.signal });
    assert.equal(report.stopped, true);
    assert.equal(report.database, null);
    // A file with no bytes has no write to stop at, and the visiting order depends on random folder
    // names, so one such file may be done before the stop. No file may be half written.
    assert.ok(report.files.notCopied > 0, 'something was left');
    assert.equal(report.files.copied + report.files.notCopied, files.size);
    for (const [path, bytes] of snapshot(ipod)) {
      if (!path.startsWith('iPod_Control/Music/')) continue;
      const original = files.get(path.slice('iPod_Control/Music/'.length));
      assert.ok(bytes.length === 0 || (original && Buffer.compare(Buffer.from(bytes), Buffer.from(original)) === 0), `${path} is whole or empty, never half written`);
    }
  });
});
