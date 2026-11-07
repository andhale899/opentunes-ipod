// The rewrite check: write the database into the engine's copy of an iPod and report what
// changed. These tests show it stays quiet when nothing is lost and speaks up when something
// is. The real question, what libgpod's rewrite does to a real nano 7G's library, can only be
// answered by running the check on one.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DEMO_FIREWIRE_ID, EngineError, buildDemoIpod, buildSignedDemoIpod, checkRewrite, compareLibraries } from '../js/index.ts';
import { MOUNT, newEngine } from './helpers.mjs';

const ITUNES = `${MOUNT}/iPod_Control/iTunes`;
const ITLP = `${ITUNES}/iTunes Library.itlp`;

async function signedDemo() {
  const engine = await newEngine();
  buildSignedDemoIpod(engine);
  return engine;
}

/** Edits one of the library's SQLite files the way another program could have left it. */
function editLibraryFile(engine, file, statements) {
  const copy = join(mkdtempSync(join(tmpdir(), 'opentunes-')), file);
  writeFileSync(copy, engine.fs.readFile(`${ITLP}/${file}`));
  const database = new DatabaseSync(copy);
  database.exec(statements);
  database.close();
  engine.fs.writeFile(`${ITLP}/${file}`, readFileSync(copy));
}

function removeTree(engine, path) {
  for (const name of engine.fs.readdir(path)) {
    if (name === '.' || name === '..') continue;
    const child = `${path}/${name}`;
    if (engine.fs.isDir(engine.fs.stat(child).mode)) removeTree(engine, child);
    else engine.fs.unlink(child);
  }
  engine.fs.rmdir(path);
}

describe('rewriting an iPod database in memory', () => {
  it('finds nothing to report when libgpod wrote the library itself', async () => {
    const engine = await signedDemo();
    const report = await checkRewrite(engine, MOUNT, DEMO_FIREWIRE_ID);

    assert.equal(report.writeError, null);
    assert.equal(report.readBackError, null);
    assert.deepEqual(report.problems, []);
    assert.deepEqual(report.notes, []);
    assert.equal(report.library.tracksBefore, 5);
    assert.equal(report.library.tracksAfter, 5);
    assert.equal(report.library.unmatched, 0);
    assert.deepEqual(report.library.changedFields, {});
    assert.deepEqual(report.signatures.map((check) => [check.file, check.status]), [['iTunesCDB', 'matches'], ['Locations.itdb.cbk', 'matches']]);
    assert.ok(report.writeMilliseconds >= 0);
  });

  it('works on an iPod with no SQLite library files', async () => {
    const engine = await newEngine();
    buildDemoIpod(engine);
    const report = await checkRewrite(engine, MOUNT, null);
    assert.deepEqual(report.problems, []);
    assert.deepEqual(report.sqlite, []);
    assert.deepEqual(report.signatures.map((check) => check.status), ['missing', 'missing']);
  });

  it('never puts a track title in the report', async () => {
    const engine = await signedDemo();
    const text = JSON.stringify(await checkRewrite(engine, MOUNT, DEMO_FIREWIRE_ID));
    for (const title of ['Morning Light', 'Night Drive', 'Episode 12', 'A Short Story', 'Demo Film']) {
      assert.ok(!text.includes(title), title);
    }
  });

  it('treats the files libgpod always renames or removes as expected, and says why', async () => {
    const engine = await signedDemo();
    engine.fs.writeFile(`${ITUNES}/Play Counts`, new Uint8Array(40));
    engine.fs.writeFile(`${ITUNES}/OTGPlaylistInfo`, new Uint8Array(40));

    const report = await checkRewrite(engine, MOUNT, DEMO_FIREWIRE_ID);
    assert.deepEqual(report.problems, []);
    assert.ok(report.notes.some((note) => /Play Counts: libgpod folds the Play Counts file into the library and keeps the old file as Play Counts\.bak/.test(note)));
    assert.ok(report.notes.some((note) => /OTGPlaylistInfo: libgpod turns the On-The-Go playlist/.test(note)));
    assert.ok(report.files.some((file) => file.path.endsWith('Play Counts') && file.kind === 'removed'));
    assert.ok(report.files.some((file) => file.path.endsWith('Play Counts.bak') && file.kind === 'added'));
  });

  it('still reports a file that goes missing for no known reason', async () => {
    const engine = await signedDemo();
    engine.fs.writeFile(`${ITUNES}/SomethingElse`, new Uint8Array(40));
    const original = engine.write.bind(engine);
    engine.write = () => {
      original();
      engine.fs.unlink(`${ITUNES}/SomethingElse`);
    };
    const report = await checkRewrite(engine, MOUNT, DEMO_FIREWIRE_ID);
    assert.deepEqual(report.problems, ['The file iPod_Control/iTunes/SomethingElse is gone after the rewrite.']);
  });

  it('speaks up when the library files hold what libgpod does not carry', async () => {
    const engine = await signedDemo();
    // Artwork links and a play count that only the SQLite files know about, as iTunes leaves them.
    editLibraryFile(engine, 'Library.itdb', 'UPDATE item SET artwork_status = 1, artwork_cache_id = 7; UPDATE album SET artwork_item_pid = 4242;');
    editLibraryFile(engine, 'Dynamic.itdb', 'UPDATE item_stats SET play_count_user = 3;');

    const report = await checkRewrite(engine, MOUNT, DEMO_FIREWIRE_ID);
    const text = report.problems.join('\n');
    assert.match(text, /Library\.itdb: item\.artwork_cache_id held a value on 5 rows before the rewrite and holds a value on 0 after\./);
    assert.match(text, /Library\.itdb: album\.artwork_item_pid held a value on 3 rows/);
    assert.match(text, /Dynamic\.itdb: item_stats\.play_count_user held a value on 5 rows/);
    assert.deepEqual(report.library.changedFields, {}, 'the library libgpod reads is unaffected');
    assert.deepEqual(report.sqlite.map((change) => change.file), ['Dynamic.itdb', 'Library.itdb']);
  });

  it('says so when libgpod cannot write the library', async () => {
    const engine = await signedDemo();
    removeTree(engine, ITUNES);
    engine.fs.writeFile(ITUNES, 'not a folder');

    const report = await checkRewrite(engine, MOUNT, DEMO_FIREWIRE_ID);
    assert.match(report.writeError, /Could not write the iPod database/);
    assert.equal(report.library, null);
    assert.deepEqual(report.signatures, []);
    assert.match(report.problems[0], /^libgpod could not write this library: /);
  });

  it('says so when libgpod cannot read back what it wrote', async () => {
    const engine = await signedDemo();
    engine.open = () => {
      throw new EngineError('simulated read-back failure');
    };
    const report = await checkRewrite(engine, MOUNT, DEMO_FIREWIRE_ID);
    assert.equal(report.writeError, null);
    assert.equal(report.readBackError, 'simulated read-back failure');
    assert.match(report.problems[0], /could not read back the database it wrote: simulated read-back failure/);
  });

  it('notes a table it could not compare', async () => {
    const engine = await signedDemo();
    const original = engine.sqlQuery.bind(engine);
    engine.sqlQuery = (path, query, max) => {
      if (path.endsWith('Genius.itdb') && query.includes('SELECT COUNT') && query.includes('"genius_config"')) throw new Error('simulated failure');
      return original(path, query, max);
    };
    const report = await checkRewrite(engine, MOUNT, DEMO_FIREWIRE_ID);
    assert.ok(report.notes.some((note) => /Genius\.itdb: the table genius_config could not be read before the rewrite \(simulated failure\)/.test(note)));
    assert.ok(report.notes.some((note) => /after the rewrite/.test(note)));
  });
});

describe('comparing two reads of a library', () => {
  const track = (handle, path, extra = {}) => ({ handle, ipod_path: path, title: 't', artist: 'a', album: 'b', tracklen: 1000, rating: 0, playcount: 0, ...extra });
  const list = (handle, name, tracks, flags = {}) => ({ handle, name, master: false, podcasts: false, smart: false, tracks, ...flags });

  const tracks = [track(1, ':iPod_Control:Music:F00:AAAA.mp3'), track(2, ':iPod_Control:Music:F01:BBBB.mp3'), track(3, ':iPod_Control:Music:F02:CCCC.mp3')];
  const lists = [list(1, 'iPod', [1, 2, 3], { master: true }), list(2, 'Mix', [3, 1])];

  it('matches tracks by their path, so new handles and a new order do not matter', () => {
    const after = [track(10, ':iPod_Control:Music:F02:CCCC.mp3'), track(11, ':iPod_Control:Music:F00:AAAA.mp3'), track(12, ':iPod_Control:Music:F01:BBBB.mp3')];
    const afterLists = [list(5, 'iPod', [11, 12, 10], { master: true }), list(6, 'Mix', [10, 11])];
    const result = compareLibraries(tracks, lists, after, afterLists);
    assert.equal(result.unmatched, 0);
    assert.deepEqual(result.changedFields, {});
    assert.deepEqual(result.playlistChanges, []);
  });

  it('counts the tracks that changed, per field, and the ones that are missing or new', () => {
    const after = [track(1, ':iPod_Control:Music:F00:AAAA.mp3', { rating: 80 }), track(2, ':iPod_Control:Music:F01:BBBB.mp3', { rating: 20, playcount: 4 }), track(4, ':iPod_Control:Music:F03:DDDD.mp3')];
    const result = compareLibraries(tracks, [], after, []);
    assert.deepEqual(result.changedFields, { rating: 2, playcount: 1 });
    assert.equal(result.unmatched, 2); // CCCC is gone, DDDD is new
    assert.equal(result.tracksBefore, 3);
    assert.equal(result.tracksAfter, 3);
  });

  it('names the playlists that went missing, appeared, shrank or were reordered', () => {
    const afterLists = [list(1, 'iPod', [1, 2], { master: true }), list(3, 'Other', [1]), list(4, 'Mix', [1, 3])];
    const result = compareLibraries(tracks, lists, tracks, afterLists);
    assert.deepEqual(result.playlistChanges, [
      'The playlist "iPod" has 3 tracks before the rewrite and 2 after.',
      'The playlist "Mix" holds different tracks, or the same tracks in a different order, after the rewrite.',
      'A playlist "Other" appears after the rewrite that was not there before.',
    ]);
    const gone = compareLibraries(tracks, lists, tracks, [lists[0]]);
    assert.deepEqual(gone.playlistChanges, ['The playlist "Mix" is missing after the rewrite.']);
  });

  it('tells two playlists with the same name apart', () => {
    const before = [list(1, 'Mix', [1]), list(2, 'Mix', [2])];
    const after = [list(7, 'Mix', [1]), list(8, 'Mix', [2])];
    assert.deepEqual(compareLibraries(tracks, before, tracks, after).playlistChanges, []);
  });
});
