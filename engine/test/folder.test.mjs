// Loading an iPod's database files into the engine, and the demo iPod.
//
// The browser hands the app a FileSystemDirectoryHandle for the iPod. Here a stand-in
// with the same shape is built on another engine's in-memory folder, so the loader runs
// the same code path without a browser or a device.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IpodFolderError, buildDemoIpod, loadIpodFolder } from '../js/index.ts';
import { MOUNT, addFile, nano7gStyleIpod, newEngine, restart } from './helpers.mjs';

function fileHandle(engine, path, name) {
  return {
    kind: 'file',
    name,
    async getFile() {
      const bytes = engine.fs.readFile(path);
      return { size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    },
  };
}

function directoryHandle(engine, path, name = path.split('/').pop()) {
  return {
    kind: 'directory',
    name,
    async *entries() {
      for (const entry of engine.fs.readdir(path)) {
        if (entry === '.' || entry === '..') continue;
        const full = `${path}/${entry}`;
        yield [entry, engine.fs.isDir(engine.fs.stat(full).mode) ? directoryHandle(engine, full, entry) : fileHandle(engine, full, entry)];
      }
    },
    async getDirectoryHandle(child) {
      const full = `${path}/${child}`;
      if (!engine.fs.analyzePath(full).exists || !engine.fs.isDir(engine.fs.stat(full).mode)) {
        throw Object.assign(new Error(`${child} not found`), { name: 'NotFoundError' });
      }
      return directoryHandle(engine, full, child);
    },
  };
}

const kindsOf = (engine) => Object.fromEntries(engine.tracks().map((track) => [track.title, track.kind]));

describe('loading an iPod folder', () => {
  it('copies the database files so the engine can open them', async () => {
    const source = await newEngine();
    buildDemoIpod(source);

    const target = await newEngine();
    const report = await loadIpodFolder(directoryHandle(source, MOUNT, 'DEMO IPOD'), target);
    target.open(MOUNT);

    assert.equal(target.tracks().length, 5);
    assert.ok(report.files > 0 && report.bytes > 0);
    assert.equal(report.hasDatabaseFolder, true);
    assert.deepEqual(kindsOf(target), kindsOf(source));
  });

  it('recreates the music folders empty, without copying any music', async () => {
    const source = await newEngine();
    buildDemoIpod(source);
    source.fs.writeFile(`${MOUNT}/iPod_Control/Music/F00/song.mp3`, new Uint8Array(500_000));

    const target = await newEngine();
    const report = await loadIpodFolder(directoryHandle(source, MOUNT), target);

    assert.equal(report.musicFolders.length, 50);
    assert.equal(report.musicFolders[0], 'F00');
    assert.equal(report.musicFolders[49], 'F49');
    assert.deepEqual(target.fs.readdir(`${MOUNT}/iPod_Control/Music/F00`).filter((n) => n !== '.' && n !== '..'), []);
    assert.ok(report.bytes < 500_000, 'the music file was not read');
  });

  it('leaves out the clutter macOS and Windows add to a FAT volume', async () => {
    const source = await newEngine();
    buildDemoIpod(source);
    source.fs.writeFile(`${MOUNT}/iPod_Control/iTunes/._iTunesDB`, new Uint8Array(10));
    source.fs.writeFile(`${MOUNT}/iPod_Control/iTunes/.DS_Store`, new Uint8Array(10));

    const target = await newEngine();
    const report = await loadIpodFolder(directoryHandle(source, MOUNT), target);

    assert.deepEqual(report.skipped.sort(), [`${MOUNT}/iPod_Control/iTunes/.DS_Store`, `${MOUNT}/iPod_Control/iTunes/._iTunesDB`]);
    assert.equal(target.fs.analyzePath(`${MOUNT}/iPod_Control/iTunes/._iTunesDB`).exists, false);
  });

  it('explains a folder that is not an iPod', async () => {
    const source = await newEngine(); // an empty folder
    const target = await newEngine();
    await assert.rejects(
      loadIpodFolder(directoryHandle(source, MOUNT, 'Documents'), target),
      (error) => error instanceof IpodFolderError && /"Documents" has no iPod_Control folder/.test(error.message),
    );
  });

  it('reports an iPod that has no database folder yet', async () => {
    const source = await newEngine();
    source.fs.mkdir(`${MOUNT}/iPod_Control`);
    source.fs.mkdir(`${MOUNT}/iPod_Control/Music`);
    source.fs.mkdir(`${MOUNT}/iPod_Control/Music/F00`);

    const target = await newEngine();
    const report = await loadIpodFolder(directoryHandle(source, MOUNT), target);
    assert.equal(report.hasDatabaseFolder, false);
    assert.throws(() => target.open(MOUNT), /Could not read the iPod database/);
  });

  it('stops instead of loading far more than a database could be', async () => {
    const source = await newEngine();
    buildDemoIpod(source);
    const target = await newEngine();
    await assert.rejects(
      loadIpodFolder(directoryHandle(source, MOUNT), target, { maxBytes: 1000 }),
      (error) => error instanceof IpodFolderError && /more than/.test(error.message),
    );
  });

  it('reads a signed nano 7G-style iPod, device facts included', async () => {
    const source = await nano7gStyleIpod();
    addFile(source, 'music', { title: 'Song' }, 'song.mp3');
    addFile(source, 'audiobook', { title: 'Book' }, 'book.m4b');
    source.write();

    const target = await newEngine();
    await loadIpodFolder(directoryHandle(source, MOUNT), target);
    target.open(MOUNT);

    const device = target.device();
    assert.equal(device.checksum, 'hashAB');
    assert.equal(device.has_sysinfo_extended, true);
    assert.deepEqual(kindsOf(target), { Song: 'music', Book: 'audiobook' });
  });

  it('reports progress', async () => {
    const source = await newEngine();
    buildDemoIpod(source);
    const target = await newEngine();
    const messages = [];
    await loadIpodFolder(directoryHandle(source, MOUNT), target, { onProgress: (message) => messages.push(message) });
    assert.ok(messages.some((message) => /iTunesDB/.test(message)));
  });
});

describe('the demo iPod', () => {
  it('holds one of each kind and survives a restart', async () => {
    const engine = await newEngine();
    buildDemoIpod(engine);
    const reopened = await restart(engine);

    const kinds = new Set(reopened.tracks().map((track) => track.kind));
    assert.deepEqual([...kinds].sort(), ['audiobook', 'movie', 'music', 'podcast']);

    const book = reopened.tracks().find((track) => track.kind === 'audiobook');
    assert.deepEqual(book.chapters.map((chapter) => chapter.title), ['Beginning', 'Middle', 'End']);

    const lists = reopened.playlists();
    assert.equal(lists.find((playlist) => playlist.name === 'Road trip').tracks.length, 2);
    assert.equal(lists.filter((playlist) => playlist.podcasts).length, 1);
    assert.equal(lists.find((playlist) => playlist.master).name, 'Demo iPod');
  });
});
