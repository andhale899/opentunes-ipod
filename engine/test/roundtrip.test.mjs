// Round-trip tests for the engine, run in Node against the built WebAssembly module.
//
//   npm run engine:build && npm run engine:test
//
// The iPod is an in-memory folder (Emscripten's MEMFS), so no hardware is involved.
// These tests show the engine can create a database, write it, and read it back. They
// cannot show that a real iPod accepts the result.

import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const modulePath = fileURLToPath(new URL('../build/ipod_manager.js', import.meta.url));
if (!existsSync(modulePath)) {
  throw new Error('engine/build/ipod_manager.js is missing. Run `npm run engine:build` first.');
}
const { default: createIPodModule } = await import(modulePath);

const MOUNT = '/ipod';

/** A fresh module instance with an empty in-memory iPod folder. */
async function freshEngine() {
  const M = await createIPodModule();
  M.FS.mkdir(MOUNT);
  const api = {
    M,
    int: (name, types = [], args = []) => M.ccall(name, 'number', types, args),
    str: (name, types = [], args = []) => M.ccall(name, 'string', types, args),
    lastError: () => M.ccall('ipod_get_last_error', 'string', [], []),
  };
  assert.equal(api.int('ipod_set_mountpoint', ['string'], [MOUNT]), 0, 'set mountpoint');
  return api;
}

describe('engine round trip', () => {
  let engine;

  before(async () => {
    engine = await freshEngine();
  });

  it('initialises an empty iPod and parses it back', () => {
    const result = engine.int('ipod_init_new', ['string', 'string'], ['MA450', 'Test iPod']);
    assert.equal(result, 0, `init failed: ${engine.lastError()}`);
    assert.equal(engine.int('ipod_is_db_loaded'), 1);
    assert.equal(engine.int('ipod_get_track_count'), 0);
    assert.ok(engine.int('ipod_get_playlist_count') >= 1, 'a master playlist should exist');
  });

  it('creates the folders and database files an iPod needs', () => {
    const { FS } = engine.M;
    assert.ok(FS.analyzePath(`${MOUNT}/iPod_Control/iTunes/iTunesDB`).exists, 'iTunesDB');
    assert.ok(FS.analyzePath(`${MOUNT}/iPod_Control/Music/F00`).exists, 'Music/F00');
    const db = FS.readFile(`${MOUNT}/iPod_Control/iTunes/iTunesDB`);
    assert.equal(String.fromCharCode(...db.slice(0, 4)), 'mhbd', 'database starts with the mhbd header');
  });

  it('adds a track, writes the database, and reads the track back', () => {
    const index = engine.int(
      'ipod_add_track',
      ['string', 'string', 'string', 'string', 'number', 'number', 'number', 'number', 'number', 'number', 'number', 'string'],
      ['Test Song', 'Test Artist', 'Test Album', 'Rock', 1, 1, 2024, 180000, 256, 44100, 4096, 'MPEG audio file'],
    );
    assert.ok(index >= 0, `add_track failed: ${engine.lastError()}`);

    const destination = engine.str('ipod_get_track_dest_path', ['string'], ['song.mp3']);
    assert.ok(destination && destination.startsWith(`${MOUNT}/iPod_Control/Music/F`), `unexpected path ${destination}`);

    engine.M.FS.writeFile(destination, new Uint8Array(4096));
    assert.equal(engine.int('ipod_finalize_last_track_no_stat', ['string', 'number'], [destination, 4096]), 0, engine.lastError());
    assert.equal(engine.int('ipod_write_db'), 0, `write failed: ${engine.lastError()}`);
  });

  it('keeps the track after the engine is restarted and the database re-read', async () => {
    const second = await freshEngine();
    // Copy the written iPod folder into a new engine instance, as a re-open would.
    const files = [];
    const walk = (dir) => {
      for (const name of engine.M.FS.readdir(dir)) {
        if (name === '.' || name === '..') continue;
        const path = `${dir}/${name}`;
        if (engine.M.FS.isDir(engine.M.FS.stat(path).mode)) walk(path);
        else files.push(path);
      }
    };
    walk(MOUNT);
    for (const path of files) {
      const parent = path.slice(0, path.lastIndexOf('/'));
      for (let at = MOUNT, parts = parent.slice(MOUNT.length).split('/').filter(Boolean); parts.length; ) {
        at = `${at}/${parts.shift()}`;
        if (!second.M.FS.analyzePath(at).exists) second.M.FS.mkdir(at);
      }
      second.M.FS.writeFile(path, engine.M.FS.readFile(path));
    }

    assert.equal(second.int('ipod_parse_db'), 0, `parse failed: ${second.lastError()}`);
    assert.equal(second.int('ipod_get_track_count'), 1);
    const tracks = JSON.parse(second.str('ipod_get_all_tracks_json'));
    assert.equal(tracks[0].title, 'Test Song');
    assert.equal(tracks[0].artist, 'Test Artist');
  });
});
