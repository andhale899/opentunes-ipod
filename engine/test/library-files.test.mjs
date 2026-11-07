// The SQLite library files libgpod writes for a nano 6G or 7G, looked at through the engine's
// own read-only SQL reader.
//
// The device's SysInfoExtended lists the SQL steps that make a library fit it, in numbered
// sets. These tests check libgpod runs the complete set, which is what iTunes does for a
// library below the newest version, and that the steps leave their mark.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { profileDatabase } from '../js/index.ts';
import { MOUNT, addFile, nano7gStyleIpod } from './helpers.mjs';

const LIBRARY = `${MOUNT}/iPod_Control/iTunes/iTunes Library.itlp/Library.itdb`;

async function writtenLibrary() {
  const engine = await nano7gStyleIpod();
  addFile(engine, 'music', { title: 'Song', artist: 'Artist', album: 'Album' }, 'song.mp3', 100);
  engine.write();
  return engine;
}

const columnsOf = (engine, table) => engine.sqlQuery(LIBRARY, `PRAGMA table_info(${table})`).rows.map((row) => row[1]);

describe('the library files written for a nano 7G-style iPod', () => {
  it('are at the library version the device asks for', async () => {
    const engine = await writtenLibrary();
    assert.equal(engine.sqlQuery(LIBRARY, 'PRAGMA user_version').rows[0][0], 26);
    assert.equal(profileDatabase(engine, LIBRARY).userVersion, 26);
  });

  it('carry the columns the steps for the oldest library add', async () => {
    const engine = await writtenLibrary();
    const item = columnsOf(engine, 'item');
    assert.ok(item.includes('is_home_video'), 'CreateIsHomeVideo ran');
    assert.ok(item.includes('track_artist_pid'), 'the later steps ran too');
    assert.ok(columnsOf(engine, 'track_artist').includes('is_unknown'));
  });

  it('still hold the track that was added', async () => {
    const engine = await writtenLibrary();
    const { rows } = engine.sqlQuery(LIBRARY, 'SELECT title, is_home_video FROM item');
    assert.deepEqual(rows, [['Song', 0]]);
  });
});
