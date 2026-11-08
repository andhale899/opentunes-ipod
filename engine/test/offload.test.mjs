// Copying everything off an iPod: what a run puts where, and what it does when things go wrong.
//
// The iPods are in-memory folders written by the real engine (see sync-helpers.mjs), with the
// stand-in music files replaced by larger ones so a file takes several pieces. The tests show
// what the code does with them. They cannot show how fast it is, or that it works on a real
// iPod over USB: only a run on the owner's hardware can.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ScratchFolder, crc32, csvField, libraryCsv, mediaPathOf, offloadIpod, playlistsCsv, toCsv } from '../js/index.ts';
import { bytesFor, folderOf, instrument, newEngine, putFile, readIpod, signedIpod, snapshot } from './sync-helpers.mjs';

const NOW = new Date(2026, 10, 7, 18, 4);
const CHUNK = 1000;

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
  // A file the library does not list, and one with no length at all.
  const stray = bytesFor(99, 1800);
  await putFile(ipod, 'iPod_Control/Music/F20/STRAY.mp3', stray);
  files.set('F20/STRAY.mp3', stray);
  await putFile(ipod, 'iPod_Control/Music/F21/EMPTY.mp3', new Uint8Array(0));
  files.set('F21/EMPTY.mp3', new Uint8Array(0));
  return { ipod, files, tracks: engine.tracks(), playlists: engine.playlists() };
}

const run = (ipod, destination, options = {}) => offloadIpod(ipod, destination, newEngine, { now: NOW, chunkBytes: CHUNK, ...options });

// ignoreBOM keeps the byte order mark in the text, so the CSV reader below can check it is there.
const textOf = (destination, path) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(destination.listFiles().get(path));

/** The source wrapped so reading `badPath` fails part way, as a flaky USB cable would. */
function flaky(folder, badPath, prefix = '') {
  return {
    kind: 'directory',
    name: folder.name,
    async *entries() {
      for await (const [name, entry] of folder.entries()) {
        if (entry.kind === 'directory') yield [name, flaky(entry, badPath, `${prefix}${name}/`)];
        else yield [name, wrapFile(entry, `${prefix}${name}`, badPath)];
      }
    },
    getDirectoryHandle: async (name) => flaky(await folder.getDirectoryHandle(name), badPath, `${prefix}${name}/`),
  };
}

function wrapFile(entry, path, badPath) {
  return {
    kind: 'file',
    name: entry.name,
    getFile: async () => {
      const file = await entry.getFile();
      if (path !== badPath) return file;
      return { size: file.size, arrayBuffer: file.arrayBuffer, slice: () => ({ arrayBuffer: async () => { throw new Error('read error on the iPod'); } }) };
    },
  };
}

/** A minimal CSV reader, so the tests check that what was written reads back as the same fields. */
function parseCsv(text) {
  assert.equal(text.charCodeAt(0), 0xfeff, 'starts with a byte order mark');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 1; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r' && text[i + 1] === '\n') { row.push(field); rows.push(row); row = []; field = ''; i += 1; }
    else field += c;
  }
  assert.equal(field, '', 'ends with a line break');
  return rows;
}

describe('a full copy', () => {
  it('copies every music file byte for byte under the same relative path, and only reads the iPod', async () => {
    const { ipod, files } = await ipodWithMusic();
    const before = snapshot(ipod);
    const writes = [];
    let opened = 0;
    const readOnly = instrument(ipod, { log: (event, path) => writes.push(`${event} ${path}`), opened: () => { opened += 1; } });
    const destination = new ScratchFolder('Backups');

    const progress = [];
    const report = await run(readOnly, destination, { onProgress: (p) => progress.push(p) });

    assert.equal(report.folder, 'opentunes-offload-2026-11-07-1804');
    assert.equal(report.complete, true);
    assert.equal(report.stopped, false);
    assert.equal(report.files.total, files.size);
    assert.equal(report.files.copied, files.size);
    assert.deepEqual([report.files.skipped, report.files.failed, report.files.notCopied], [0, 0, 0]);
    assert.deepEqual(report.failures, []);
    assert.equal(report.bytes.total, [...files.values()].reduce((sum, bytes) => sum + bytes.length, 0));
    assert.equal(report.bytes.copied, report.bytes.total);
    assert.deepEqual(report.unlisted, ['F20/STRAY.mp3', 'F21/EMPTY.mp3'], 'files the library does not list are copied and named');
    assert.deepEqual(report.missing, []);

    const copied = destination.listFiles();
    for (const [path, bytes] of files) {
      assert.deepEqual(copied.get(`${report.folder}/${path}`), bytes, `${path} is identical`);
    }
    assert.deepEqual([...copied.get(`${report.folder}/library.csv`).slice(0, 3)], [0xef, 0xbb, 0xbf], 'library.csv starts with a UTF-8 byte order mark');
    assert.ok(copied.has(`${report.folder}/library.csv`));
    assert.ok(copied.has(`${report.folder}/playlists.csv`));
    assert.match(textOf(destination, `${report.folder}/README.txt`), /copy of everything on an iPod/);

    // The iPod was read and nothing else.
    assert.deepEqual(writes, []);
    assert.equal(opened, 0);
    assert.deepEqual(snapshot(ipod), before);

    // Progress ends with every file and byte counted, and reports a speed.
    const last = progress.filter((p) => p.phase === 'copying').at(-1);
    assert.equal(last.filesDone, files.size);
    assert.equal(last.bytesDone, report.bytes.total);
    assert.ok(progress.some((p) => p.bytesPerSecond > 0));
    assert.ok(progress.every((p) => p.current.length <= 3), 'never more than three files at once');
  });

  it('copies in pieces of the chunk size and writes up to three files at once', async () => {
    const { ipod } = await ipodWithMusic();
    let open = 0;
    let most = 0;
    let longest = 0;
    const destination = new ScratchFolder('Backups');
    const watched = instrument(destination, {
      opened: () => { open += 1; most = Math.max(most, open); },
      closed: () => { open -= 1; },
      write: (path, index, data) => { if (path.includes('/F')) longest = Math.max(longest, data.length); },
    });
    const report = await run(ipod, watched);
    assert.equal(report.complete, true);
    assert.equal(most, 3);
    assert.ok(longest <= CHUNK, `no piece was bigger than ${CHUNK} bytes (${longest})`);
  });

  it('refuses a destination that holds an iPod_Control folder', async () => {
    const { ipod } = await ipodWithMusic();
    await assert.rejects(run(ipod, ipod), /looks like an iPod/);
  });

  it('refuses a folder that is not an iPod', async () => {
    await assert.rejects(run(new ScratchFolder('Not an iPod'), new ScratchFolder('Backups')), /no iPod_Control folder/);
  });

  it('writes library.csv and playlists.csv for every track, with its file and its playlists', async () => {
    const { ipod, tracks, playlists } = await ipodWithMusic();
    const destination = new ScratchFolder('Backups');
    const report = await run(ipod, destination);
    const library = parseCsv(textOf(destination, `${report.folder}/library.csv`));
    const [header, ...rows] = library;
    assert.deepEqual(header.slice(0, 3), ['Path', 'Title', 'Artist']);
    assert.equal(rows.length, tracks.length);
    const morning = rows.find((row) => row[1] === 'Morning Light');
    assert.match(morning[0], /^F\d\d\/[^/]+$/);
    assert.equal(morning[2], 'The Demo Band');
    assert.equal(morning[3], 'Samples');
    assert.equal(morning[6], 'music');
    assert.equal(morning[7], '2021');
    assert.equal(morning[10], '214');
    assert.equal(morning[16], 'Road trip');
    assert.equal(morning.at(-1), 'copied');
    assert.equal(rows.find((row) => row[1] === 'Episode 12: Engines')[16], 'Podcasts', 'the podcast list is a real list, the master list is not named');
    assert.equal(rows.find((row) => row[1] === 'Demo Film')[16], '', 'in no list but the one that holds everything');

    const lists = parseCsv(textOf(destination, `${report.folder}/playlists.csv`));
    assert.deepEqual(lists[0], ['Playlist', 'Position', 'Path']);
    const roadTrip = lists.filter((row) => row[0] === 'Road trip');
    assert.equal(roadTrip.length, 2);
    assert.deepEqual(roadTrip.map((row) => row[1]), ['1', '2']);
    assert.ok(roadTrip.every((row) => destination.listFiles().has(`${report.folder}/${row[2]}`)), 'each playlist row points at a file in the folder');
    assert.ok(!lists.some((row) => playlists.find((playlist) => playlist.master && playlist.name === row[0])), 'the master list is left out');
  });
});

describe('tracks whose file is not on the iPod', () => {
  it('lists them in the report and in library.csv instead of hiding them', async () => {
    const { ipod, tracks } = await ipodWithMusic();
    const gone = tracks.find((track) => track.title === 'Night Drive');
    const path = mediaPathOf(gone.ipod_path);
    const parts = path.split('/');
    await (await folderOf(ipod, parts.slice(0, -1).join('/'))).removeEntry(parts.at(-1));

    const destination = new ScratchFolder('Backups');
    const report = await run(ipod, destination);
    assert.deepEqual(report.missing, [{ path: gone.ipod_path, title: 'Night Drive', artist: 'The Demo Band' }]);
    assert.equal(report.complete, true, 'a file that was never there is not a failed copy');
    const row = parseCsv(textOf(destination, `${report.folder}/library.csv`)).find((fields) => fields[1] === 'Night Drive');
    assert.equal(row.at(-1), 'missing on the iPod');
    assert.equal(row[0], path.slice('iPod_Control/Music/'.length));
  });
});

describe('a file that cannot be read', () => {
  it('is reported by name and the rest are still copied', async () => {
    const { ipod, files, tracks } = await ipodWithMusic();
    const bad = mediaPathOf(tracks.find((track) => track.title === 'Demo Film').ipod_path);
    const badShort = bad.slice('iPod_Control/Music/'.length);
    const destination = new ScratchFolder('Backups');
    const report = await run(flaky(ipod, bad), destination);

    assert.equal(report.complete, false);
    assert.equal(report.files.failed, 1);
    assert.equal(report.files.copied, files.size - 1);
    assert.equal(report.failures.length, 1);
    assert.equal(report.failures[0].path, badShort);
    assert.match(report.failures[0].reason, /read error on the iPod/);
    const copied = destination.listFiles();
    for (const [path, bytes] of files) {
      if (path === badShort) assert.notDeepEqual(copied.get(`${report.folder}/${path}`), bytes);
      else assert.deepEqual(copied.get(`${report.folder}/${path}`), bytes);
    }
    const row = parseCsv(textOf(destination, `${report.folder}/library.csv`)).find((fields) => fields[1] === 'Demo Film');
    assert.equal(row.at(-1), 'failed');
    assert.match(textOf(destination, `${report.folder}/README.txt`), /1 failed/);

    // Running again into the same folder, with the cable fixed, copies just that file.
    const again = await run(ipod, destination, { folder: report.folder });
    assert.equal(again.complete, true);
    assert.equal(again.files.copied, 1);
    assert.equal(again.files.skipped, files.size - 1);
    assert.deepEqual(destination.listFiles().get(`${report.folder}/${badShort}`), files.get(badShort));
  });

  it('is caught when the copy does not match when read back, and is not left looking good', async () => {
    const { ipod, files } = await ipodWithMusic();
    const target = 'F20/STRAY.mp3';
    const destination = new ScratchFolder('Backups');
    const damaging = instrument(destination, { write: (path, index) => (path.endsWith(target) && index === 0 ? 'corrupt' : undefined) });
    const report = await run(ipod, damaging);

    assert.equal(report.complete, false);
    assert.deepEqual(report.failures.map((failure) => failure.path), [target]);
    assert.match(report.failures[0].reason, /did not match/);
    const left = destination.listFiles().get(`${report.folder}/${target}`);
    assert.notEqual(left.length, files.get(target).length, 'emptied, so a resume does not take it for a good copy');

    const again = await run(ipod, destination, { folder: report.folder });
    assert.equal(again.complete, true);
    assert.deepEqual(destination.listFiles().get(`${report.folder}/${target}`), files.get(target));
  });

  it('is reported when the destination refuses to write it', async () => {
    const { ipod, files } = await ipodWithMusic();
    const destination = new ScratchFolder('Backups');
    const full = instrument(destination, { open: (path) => (path.endsWith('F20/STRAY.mp3') ? 'refuse' : undefined) });
    const report = await run(ipod, full);
    assert.deepEqual(report.failures.map((failure) => failure.path), ['F20/STRAY.mp3']);
    assert.match(report.failures[0].reason, /disk is full/);
    assert.equal(report.files.copied, files.size - 1);
  });
});

describe('stopping and resuming', () => {
  it('stops between files, then a second run into the same folder skips what is there and finishes', async () => {
    const { ipod, files } = await ipodWithMusic();
    const destination = new ScratchFolder('Backups');
    const controller = new AbortController();
    let closed = 0;
    const watched = instrument(destination, { closed: () => { closed += 1; if (closed === 2) controller.abort(); } });

    const first = await run(ipod, watched, { concurrency: 1, signal: controller.signal });
    assert.equal(first.stopped, true);
    assert.equal(first.complete, false);
    assert.equal(first.files.copied, 2);
    assert.equal(first.files.notCopied, files.size - 2);
    assert.deepEqual(first.failures, [], 'a stop is not a failure');
    assert.match(textOf(destination, `${first.folder}/README.txt`), /stopped before the end/);
    const rowStatuses = parseCsv(textOf(destination, `${first.folder}/library.csv`)).slice(1).map((row) => row.at(-1));
    assert.ok(rowStatuses.includes('not copied'));

    const writes = [];
    const second = await run(ipod, instrument(destination, { log: (event, path) => writes.push(path) }), { folder: first.folder });
    assert.equal(second.folder, first.folder, 'the same folder, not a new one');
    assert.equal(second.stopped, false);
    assert.equal(second.complete, true);
    assert.equal(second.files.skipped, 2);
    assert.equal(second.files.copied, files.size - 2);
    assert.equal(second.bytes.skipped + second.bytes.copied, second.bytes.total);
    const media = writes.filter((path) => /F\d\d\//.test(path));
    assert.equal(media.length, files.size - 2, 'the two files already copied were not written again');
    const copied = destination.listFiles();
    for (const [path, bytes] of files) assert.deepEqual(copied.get(`${first.folder}/${path}`), bytes);
    assert.deepEqual([...copied.keys()].filter((path) => path.startsWith('opentunes-offload-2026-11-07-1804-')), [], 'no second folder was made');
  });

  it('stops in the middle of a file and leaves no half file behind', async () => {
    const { ipod, files } = await ipodWithMusic();
    const destination = new ScratchFolder('Backups');
    const controller = new AbortController();
    const watched = instrument(destination, { write: (path, index) => { if (path.includes('/F') && index === 1) controller.abort(); } });
    const report = await run(ipod, watched, { concurrency: 1, signal: controller.signal });
    assert.equal(report.stopped, true);
    assert.equal(report.files.copied, 0);
    assert.equal(report.files.notCopied, files.size);
    for (const [path, bytes] of destination.listFiles()) {
      if (/\/F\d\d\//.test(path)) assert.equal(bytes.length, 0, `${path} holds nothing`);
    }
  });

  it('copies over a file of the wrong size left by an earlier run', async () => {
    const { ipod, files } = await ipodWithMusic();
    const destination = new ScratchFolder('Backups');
    const folder = 'opentunes-offload-earlier';
    await putFile(destination, `${folder}/F20/STRAY.mp3`, new Uint8Array(10));
    const report = await run(ipod, destination, { folder });
    assert.equal(report.files.skipped, 0);
    assert.equal(report.complete, true);
    assert.deepEqual(destination.listFiles().get(`${folder}/F20/STRAY.mp3`), files.get('F20/STRAY.mp3'));
  });

  it('makes a new folder each run when not resuming, even in the same minute', async () => {
    const { ipod } = await ipodWithMusic();
    const destination = new ScratchFolder('Backups');
    const one = await run(ipod, destination);
    const two = await run(ipod, destination);
    assert.equal(one.folder, 'opentunes-offload-2026-11-07-1804');
    assert.equal(two.folder, 'opentunes-offload-2026-11-07-1804-2');
  });
});

describe('CSV', () => {
  it('quotes fields with commas, quotes and line breaks, and doubles the quotes', () => {
    assert.equal(csvField('plain'), 'plain');
    assert.equal(csvField('a, b'), '"a, b"');
    assert.equal(csvField('say "hi"'), '"say ""hi"""');
    assert.equal(csvField('two\nlines'), '"two\nlines"');
    assert.equal(csvField('one\r\nmore'), '"one\r\nmore"');
    assert.equal(csvField(null), '');
    assert.equal(csvField(0), '0');
  });

  it('starts with a byte order mark, uses CRLF, and reads back as the same fields', () => {
    const rows = [['a', 'b,c', 'd"e', 'f\ng', '日本語, ünï'], ['', '1', ' lead', 'trail ', '']];
    const text = toCsv(rows);
    assert.ok(text.startsWith('﻿'));
    assert.ok(text.endsWith('\r\n'));
    assert.ok(new TextEncoder().encode(text).slice(0, 3).every((byte, i) => byte === [0xef, 0xbb, 0xbf][i]), 'the bytes are UTF-8');
    assert.deepEqual(parseCsv(text), rows);
  });

  it('keeps a track with a hard title in one row, and joins its playlists with " | "', () => {
    const track = {
      handle: 7, kind: 'music', title: 'He said "hi", then\nleft', artist: 'A, B & "C"', album: 'Ünï', albumartist: null, genre: 'Rock',
      year: 2001, track_nr: 3, cd_nr: 0, tracklen: 200_400, size: 123, bitrate: 192, rating: 80, playcount: 4, time_added: 1_767_600_000, ipod_path: ':iPod_Control:Music:F07:XKQT.mp3',
    };
    const playlists = [
      { handle: 1, name: 'Everything', master: true, podcasts: false, smart: false, tracks: [7] },
      { handle: 2, name: 'Road, trip', master: false, podcasts: false, smart: false, tracks: [7] },
      { handle: 3, name: 'Quiet "ones"', master: false, podcasts: false, smart: false, tracks: [7] },
    ];
    const text = libraryCsv([track], playlists, () => 'F07/XKQT.mp3', () => 'copied');
    const [header, row] = parseCsv(text);
    assert.equal(row.length, header.length);
    assert.equal(row[0], 'F07/XKQT.mp3');
    assert.equal(row[1], 'He said "hi", then\nleft');
    assert.equal(row[2], 'A, B & "C"');
    assert.equal(row[7], '2001');
    assert.equal(row[9], '', 'a disc of 0 is blank');
    assert.equal(row[10], '200');
    assert.equal(row[13], '80');
    assert.equal(row[15], '2026-01-05T08:00:00Z');
    assert.equal(row[16], 'Road, trip | Quiet "ones"');
    assert.equal(parseCsv(playlistsCsv([track], playlists, () => 'F07/XKQT.mp3')).length, 3, 'header and one row per playlist entry, master left out');
  });
});

describe('the checksum', () => {
  it('is the standard CRC-32, also when continued across pieces', () => {
    const text = new TextEncoder().encode('123456789');
    assert.equal(crc32(text), 0xcbf43926);
    assert.equal(crc32(text.slice(4), crc32(text.slice(0, 4))), 0xcbf43926);
    assert.equal(crc32(new Uint8Array(0)), 0);
  });
});
