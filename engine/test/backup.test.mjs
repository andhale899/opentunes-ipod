// Backing up an iPod's database files to a folder on the computer.
//
// The source is an iPod folder in the engine's in-memory file system, read through the same
// directory-handle shape the browser gives. The destination is a plain in-memory folder.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  BackupError,
  IpodFolderError,
  ScratchFolder,
  backupIpod,
  buildDemoIpod,
  buildSignedDemoIpod,
  memoryDirectory,
} from '../js/index.ts';
import { MOUNT, newEngine } from './helpers.mjs';

const CONTROL = `${MOUNT}/iPod_Control`;
const WHEN = new Date(2026, 10, 7, 18, 4); // 7 November 2026, 18:04 local time
const FOLDER = 'opentunes-backup-2026-11-07-1804';

/** A nano 7G-style iPod with the other things a real one holds: artwork, music, clutter. */
async function realisticIpod() {
  const engine = await newEngine();
  buildSignedDemoIpod(engine);
  const put = (path, size, fill = 1) => {
    const parts = path.split('/');
    for (let i = 2; i < parts.length; i += 1) {
      const directory = `${MOUNT}/${parts.slice(0, i).join('/')}`;
      if (!engine.fs.analyzePath(directory).exists) engine.fs.mkdir(directory);
    }
    engine.fs.writeFile(`${MOUNT}/${path}`, new Uint8Array(size).fill(fill));
  };
  put('iPod_Control/Artwork/ArtworkDB', 1000, 2);
  put('iPod_Control/Artwork/F1234_1.ithmb', 5000, 3);
  put('iPod_Control/iPodPrefs', 38, 4);
  put('iPod_Control/Music/F00/ABCD.mp3', 4000, 5);
  put('iPod_Control/Speakable/Tracks/x.bin', 30, 6);
  put('iPod_Control/iTunes/._iTunesCDB', 10, 7);
  return engine;
}

const read = (engine, path) => engine.fs.readFile(`${MOUNT}/${path}`);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function filesIn(destination, folder = FOLDER) {
  return (await destination.getDirectoryHandle(folder)).listFiles();
}

/** Wraps a destination so a test can damage or refuse the write of chosen files. */
function interfere(folder, decide) {
  return {
    name: folder.name,
    getDirectoryHandle: async (name, options) => interfere(await folder.getDirectoryHandle(name, options), decide),
    getFileHandle: async (name, options) => {
      const file = await folder.getFileHandle(name, options);
      return {
        getFile: () => file.getFile(),
        createWritable: async () => {
          const action = decide(name);
          if (action === 'refuse') throw new Error('the disk is full');
          const writer = await file.createWritable();
          return {
            write: (data) => writer.write(action === 'corrupt' ? Uint8Array.from(data, (byte, i) => (i === 0 ? byte ^ 0xff : byte)) : data),
            close: () => writer.close(),
          };
        },
      };
    },
  };
}

describe('backing up an iPod', () => {
  it('copies the library, device and artwork files, and leaves the music and the clutter', async () => {
    const engine = await realisticIpod();
    const destination = new ScratchFolder('Desktop');
    const report = await backupIpod(memoryDirectory(engine, MOUNT, 'IPOD'), destination, { now: WHEN });

    assert.equal(report.folder, FOLDER);
    assert.deepEqual(report.failures, []);
    assert.equal(report.complete, true);
    assert.equal(report.verified, report.files);

    const copied = await filesIn(destination);
    const names = [...copied.keys()].sort();
    for (const wanted of [
      'iPod_Control/iTunes/iTunesCDB',
      'iPod_Control/iTunes/iTunes Library.itlp/Library.itdb',
      'iPod_Control/iTunes/iTunes Library.itlp/Locations.itdb.cbk',
      'iPod_Control/Device/SysInfoExtended',
      'iPod_Control/Artwork/ArtworkDB',
      'iPod_Control/Artwork/F1234_1.ithmb',
      'iPod_Control/iPodPrefs',
      'backup-info.json',
      'README.txt',
    ]) {
      assert.ok(names.includes(wanted), `${wanted} is in the backup`);
    }
    for (const unwanted of ['iPod_Control/Music/F00/ABCD.mp3', 'iPod_Control/Speakable/Tracks/x.bin', 'iPod_Control/iTunes/._iTunesCDB', 'iPod_Control/iTunes/iTunesControl', 'iPod_Control/Device/Radio/RadioBuffer']) {
      assert.ok(!names.includes(unwanted), `${unwanted} is not in the backup`);
    }
    assert.equal(names.filter((name) => name.startsWith('iPod_Control/')).length, report.files);

    for (const name of names.filter((entry) => entry.startsWith('iPod_Control/'))) {
      assert.deepEqual(copied.get(name), new Uint8Array(read(engine, name)), `${name} is identical`);
    }
    assert.equal(report.bytes, [...copied].filter(([name]) => name.startsWith('iPod_Control/')).reduce((sum, [, bytes]) => sum + bytes.length, 0));
  });

  it('says which files it left out and why', async () => {
    const engine = await realisticIpod();
    const report = await backupIpod(memoryDirectory(engine, MOUNT), new ScratchFolder(), { now: WHEN });
    assert.deepEqual(report.left, [
      { path: 'iPod_Control/iTunes/iTunesControl', size: 16, reason: 'not needed' },
      { path: 'iPod_Control/Device/Radio/RadioBuffer', size: 16, reason: 'not needed' },
    ]);
  });

  it('writes a manifest whose hashes match the files, and restore instructions', async () => {
    const engine = await realisticIpod();
    const destination = new ScratchFolder();
    await backupIpod(memoryDirectory(engine, MOUNT), destination, { now: WHEN });

    const copied = await filesIn(destination);
    const manifest = JSON.parse(new TextDecoder().decode(copied.get('backup-info.json')));
    assert.equal(manifest.kind, 'ipod-database-backup');
    assert.equal(manifest.complete, true);
    assert.equal(manifest.createdAt, WHEN.toISOString());
    assert.equal(manifest.files.length, copied.size - 2);
    for (const file of manifest.files) {
      assert.equal(file.sha256, sha256(copied.get(file.path)), file.path);
      assert.equal(file.size, copied.get(file.path).length);
    }

    const readme = new TextDecoder().decode(copied.get('README.txt'));
    assert.match(readme, /cp -R ".*iPod_Control\/\." ".*iPod_Control\/"/);
    assert.match(readme, /xcopy .* \/E \/Y \/I/);
    assert.match(readme, /choose Replace/);
    assert.match(readme, /holds no music/);
  });

  it('keeps the identity of the iPod out of the notes it writes', async () => {
    const engine = await realisticIpod();
    const destination = new ScratchFolder();
    await backupIpod(memoryDirectory(engine, MOUNT, 'MY PRIVATE IPOD NAME'), destination, { now: WHEN });
    const copied = await filesIn(destination);
    const notes = new TextDecoder().decode(copied.get('backup-info.json')) + new TextDecoder().decode(copied.get('README.txt'));
    assert.ok(!notes.includes('0000000000000001'), 'no FireWire ID');
    assert.ok(!notes.includes('MY PRIVATE IPOD NAME'), 'no volume name');
  });

  it('never changes the iPod', async () => {
    const engine = await realisticIpod();
    const before = new Map();
    const walk = (directory) => {
      for (const name of engine.fs.readdir(directory).filter((entry) => entry !== '.' && entry !== '..')) {
        const path = `${directory}/${name}`;
        if (engine.fs.isDir(engine.fs.stat(path).mode)) walk(path);
        else before.set(path, sha256(engine.fs.readFile(path)));
      }
    };
    walk(MOUNT);
    await backupIpod(memoryDirectory(engine, MOUNT), new ScratchFolder(), { now: WHEN });
    const after = new Map(before);
    before.clear();
    walk(MOUNT);
    assert.deepEqual(before, after);
  });

  it('does not reuse a folder name made in the same minute', async () => {
    const engine = await realisticIpod();
    const destination = new ScratchFolder();
    const first = await backupIpod(memoryDirectory(engine, MOUNT), destination, { now: WHEN });
    const second = await backupIpod(memoryDirectory(engine, MOUNT), destination, { now: WHEN });
    const third = await backupIpod(memoryDirectory(engine, MOUNT), destination, { now: WHEN });
    assert.deepEqual([first.folder, second.folder, third.folder], [FOLDER, `${FOLDER}-2`, `${FOLDER}-3`]);
  });

  it('reports progress', async () => {
    const engine = await realisticIpod();
    const messages = [];
    await backupIpod(memoryDirectory(engine, MOUNT), new ScratchFolder(), { now: WHEN, onProgress: (message) => messages.push(message) });
    assert.ok(messages.includes('Copying iPod_Control/iTunes/iTunesCDB'));
  });
});

describe('refusing to back up where it should not', () => {
  it('will not keep a backup on an iPod', async () => {
    const engine = await realisticIpod();
    const anotherIpod = new ScratchFolder('OTHER IPOD');
    await anotherIpod.getDirectoryHandle('iPod_Control', { create: true });
    await assert.rejects(
      backupIpod(memoryDirectory(engine, MOUNT), anotherIpod, { now: WHEN }),
      (error) => error instanceof BackupError && /"OTHER IPOD" holds an iPod_Control folder/.test(error.message),
    );
    assert.deepEqual([...anotherIpod.listFiles().keys()], [], 'nothing was written there');
  });

  it('explains a source that is not an iPod', async () => {
    const empty = await newEngine();
    await assert.rejects(
      backupIpod(memoryDirectory(empty, MOUNT, 'Documents'), new ScratchFolder(), { now: WHEN }),
      (error) => error instanceof IpodFolderError && /"Documents" has no iPod_Control folder/.test(error.message),
    );
  });

  it('explains an iPod with no database files', async () => {
    const engine = await newEngine();
    engine.fs.mkdir(CONTROL);
    engine.fs.mkdir(`${CONTROL}/Music`);
    engine.fs.writeFile(`${CONTROL}/Music/song.mp3`, new Uint8Array(10));
    const destination = new ScratchFolder();
    await assert.rejects(backupIpod(memoryDirectory(engine, MOUNT, 'IPOD'), destination, { now: WHEN }), /no database files on "IPOD" to back up/);
    assert.deepEqual([...destination.listFiles().keys()], [], 'no empty backup folder is left behind');
  });
});

describe('when a copy goes wrong', () => {
  it('notices a file that does not match its original and says the backup is not complete', async () => {
    const engine = await realisticIpod();
    const destination = new ScratchFolder();
    const report = await backupIpod(memoryDirectory(engine, MOUNT), interfere(destination, (name) => (name === 'iTunesCDB' ? 'corrupt' : 'fine')), { now: WHEN });

    assert.equal(report.complete, false);
    assert.deepEqual(report.failures, ['iPod_Control/iTunes/iTunesCDB did not match its original after it was copied.']);
    assert.equal(report.verified, report.files - 1);
    const manifest = JSON.parse(new TextDecoder().decode((await filesIn(destination)).get('backup-info.json')));
    assert.equal(manifest.complete, false);
    assert.ok(!manifest.files.some((file) => file.path.endsWith('iTunesCDB')), 'a bad copy is not listed as good');
  });

  it('carries on after a file cannot be written, and lists it', async () => {
    const engine = await realisticIpod();
    const destination = new ScratchFolder();
    const report = await backupIpod(memoryDirectory(engine, MOUNT), interfere(destination, (name) => (name === 'ArtworkDB' ? 'refuse' : 'fine')), { now: WHEN });

    assert.equal(report.complete, false);
    assert.deepEqual(report.failures, ['iPod_Control/Artwork/ArtworkDB could not be copied: the disk is full']);
    assert.equal(report.verified, report.files - 1);
    assert.ok((await filesIn(destination)).has('iPod_Control/iTunes/iTunesCDB'), 'the other files are there');
  });

  it('leaves out a file over the size limit and says the backup is not complete', async () => {
    const engine = await realisticIpod();
    const report = await backupIpod(memoryDirectory(engine, MOUNT), new ScratchFolder(), { now: WHEN, maxFileBytes: 2000 });
    assert.equal(report.complete, false);
    assert.ok(report.left.some((file) => file.reason === 'too large' && file.path === 'iPod_Control/Artwork/F1234_1.ithmb'));
    assert.deepEqual(report.failures, []);
  });
});

describe('an iPod without the SQLite library', () => {
  it('backs up an older iPod just the same', async () => {
    const engine = await newEngine();
    buildDemoIpod(engine);
    const destination = new ScratchFolder();
    const report = await backupIpod(memoryDirectory(engine, MOUNT), destination, { now: WHEN });
    assert.equal(report.complete, true);
    assert.ok((await filesIn(destination)).has('iPod_Control/iTunes/iTunesDB'));
  });
});
