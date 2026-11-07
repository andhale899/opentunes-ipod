// Loading an iPod's database files into the engine, and the demo iPod.
//
// The browser hands the app a FileSystemDirectoryHandle for the iPod. Here a stand-in
// with the same shape is built on another engine's in-memory folder, so the loader runs
// the same code path without a browser or a device.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IpodFolderError, buildDemoIpod, buildUnsyncedIpod, describeIpodLayout, loadIpodFolder, memoryDirectory } from '../js/index.ts';
import { MOUNT, addFile, nano7gStyleIpod, newEngine, restart } from './helpers.mjs';

const kindsOf = (engine) => Object.fromEntries(engine.tracks().map((track) => [track.title, track.kind]));

describe('loading an iPod folder', () => {
  it('copies the database files so the engine can open them', async () => {
    const source = await newEngine();
    buildDemoIpod(source);

    const target = await newEngine();
    const report = await loadIpodFolder(memoryDirectory(source, MOUNT, 'DEMO IPOD'), target);
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
    const report = await loadIpodFolder(memoryDirectory(source, MOUNT), target);

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
    const report = await loadIpodFolder(memoryDirectory(source, MOUNT), target);

    assert.deepEqual(report.skipped.sort(), [`${MOUNT}/iPod_Control/iTunes/.DS_Store`, `${MOUNT}/iPod_Control/iTunes/._iTunesDB`]);
    assert.equal(target.fs.analyzePath(`${MOUNT}/iPod_Control/iTunes/._iTunesDB`).exists, false);
  });

  it('explains a folder that is not an iPod', async () => {
    const source = await newEngine(); // an empty folder
    const target = await newEngine();
    await assert.rejects(
      loadIpodFolder(memoryDirectory(source, MOUNT, 'Documents'), target),
      (error) => error instanceof IpodFolderError && /"Documents" has no iPod_Control folder/.test(error.message),
    );
  });

  it('reports an iPod that has no database folder yet', async () => {
    const source = await newEngine();
    source.fs.mkdir(`${MOUNT}/iPod_Control`);
    source.fs.mkdir(`${MOUNT}/iPod_Control/Music`);
    source.fs.mkdir(`${MOUNT}/iPod_Control/Music/F00`);

    const target = await newEngine();
    const report = await loadIpodFolder(memoryDirectory(source, MOUNT), target);
    assert.equal(report.hasDatabaseFolder, false);
    assert.throws(() => target.open(MOUNT), /Could not read the iPod database/);
  });

  it('stops instead of loading far more than a database could be', async () => {
    const source = await newEngine();
    buildDemoIpod(source);
    const target = await newEngine();
    await assert.rejects(
      loadIpodFolder(memoryDirectory(source, MOUNT), target, { maxBytes: 1000 }),
      (error) => error instanceof IpodFolderError && /more than/.test(error.message),
    );
  });

  it('reads a signed nano 7G-style iPod, device facts included', async () => {
    const source = await nano7gStyleIpod();
    addFile(source, 'music', { title: 'Song' }, 'song.mp3');
    addFile(source, 'audiobook', { title: 'Book' }, 'book.m4b');
    source.write();

    const target = await newEngine();
    await loadIpodFolder(memoryDirectory(source, MOUNT), target);
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
    await loadIpodFolder(memoryDirectory(source, MOUNT), target, { onProgress: (message) => messages.push(message) });
    assert.ok(messages.some((message) => /iTunesDB/.test(message)));
  });
});

describe('describing an iPod layout', () => {
  it('lists what is where, with sizes, without reading file contents', async () => {
    const source = await newEngine();
    buildDemoIpod(source);
    source.fs.writeFile(`${MOUNT}/Some Song.mp3`, new Uint8Array(1234)); // loose file at the top
    source.fs.mkdir(`${MOUNT}/LOST.DIR`);

    const layout = await describeIpodLayout(memoryDirectory(source, MOUNT));
    assert.ok(layout.root.some((entry) => entry.path === 'iPod_Control' && entry.kind === 'directory'));
    assert.ok(layout.root.some((entry) => entry.path === 'LOST.DIR'));
    assert.ok(layout.root.some((entry) => entry.path === 'Some Song.mp3' && entry.kind === 'file'));
    assert.ok(layout.control.some((entry) => entry.path === 'iTunes'));
    assert.equal(layout.musicFolders, 50);

    const database = layout.iTunes.find((entry) => entry.path === 'iTunesDB');
    assert.equal(database.kind, 'file');
    assert.ok(database.size > 0);
    assert.ok(layout.device.some((entry) => entry.path === 'SysInfo'), 'device files are listed');
  });

  it('says so when parts of the layout are missing', async () => {
    const source = await newEngine();
    source.fs.mkdir(`${MOUNT}/iPod_Control`);
    const layout = await describeIpodLayout(memoryDirectory(source, MOUNT));
    assert.deepEqual(layout.control, []);
    assert.equal(layout.iTunes, null);
    assert.equal(layout.device, null);
    assert.equal(layout.musicFolders, null);

    const empty = await describeIpodLayout(memoryDirectory(await newEngine(), MOUNT));
    assert.equal(empty.control, null);
  });

  it('reaches into the nano 7G library folder and stops at the limit', async () => {
    const source = await nano7gStyleIpod();
    addFile(source, 'music', { title: 'Song' }, 'x.mp3');
    source.write();
    const layout = await describeIpodLayout(memoryDirectory(source, MOUNT));
    assert.ok(layout.iTunes.some((entry) => entry.path === 'iTunesCDB'));
    assert.ok(layout.iTunes.some((entry) => entry.path === 'iTunes Library.itlp/Library.itdb'));
    assert.equal((await describeIpodLayout(memoryDirectory(source, MOUNT), 3)).iTunes.length, 3);
  });
});

describe('the load listing', () => {
  it('records each database file with its size and its path from the top of the iPod', async () => {
    const source = await newEngine();
    buildDemoIpod(source);
    const target = await newEngine();
    const report = await loadIpodFolder(memoryDirectory(source, MOUNT), target);
    const database = report.listing.find((file) => file.path === 'iPod_Control/iTunes/iTunesDB');
    assert.ok(database && database.size > 0);
    assert.equal(report.listing.length, report.files);
  });
});

describe('the in-memory folder', () => {
  it('behaves like a browser directory handle', async () => {
    const engine = await newEngine();
    engine.fs.mkdir(`${MOUNT}/inner`);
    engine.fs.writeFile(`${MOUNT}/inner/a.txt`, new Uint8Array([1, 2, 3]));
    const root = memoryDirectory(engine, MOUNT, 'ROOT');
    assert.equal(root.name, 'ROOT');

    const inner = await root.getDirectoryHandle('inner');
    const entries = [];
    for await (const [name, entry] of inner.entries()) entries.push([name, entry.kind]);
    assert.deepEqual(entries, [['a.txt', 'file']]);

    const missing = await inner.getDirectoryHandle('x').catch((error) => error);
    assert.equal(missing.name, 'NotFoundError');

    const [[, file]] = await Array.fromAsync(inner.entries());
    const contents = await file.getFile();
    assert.equal(contents.size, 3);
    assert.deepEqual([...new Uint8Array(await contents.arrayBuffer())], [1, 2, 3]);
  });
});

describe('the unsynced demo iPod', () => {
  it('loads, then fails to open with an explanation and the evidence', async () => {
    const source = await newEngine();
    buildUnsyncedIpod(source);
    const target = await newEngine();
    const report = await loadIpodFolder(memoryDirectory(source, MOUNT, 'DEMO IPOD'), target);

    assert.equal(report.hasDatabaseFolder, true);
    assert.deepEqual(report.listing.find((file) => file.path === 'iPod_Control/iTunes/iTunesDB'), { path: 'iPod_Control/iTunes/iTunesDB', size: 0 });
    assert.throws(() => target.open(MOUNT), /never been synced/);
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
