// HashAB tests: the checksum the nano 6G and 7G need before they accept a database.
//
// The known-answer vectors come from dstaley/hashab (test-data.json at the pinned commit).
// Each is a SHA-1 and an 8-byte device ID with the exact 57-byte signature expected. They
// were produced to match libhashab32.so, so passing them is strong evidence the hash is
// right without any hardware. The write tests check libgpod uses the hash in the files a
// nano 7G reads. Neither shows that a real iPod accepts the result: that needs hardware.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EngineError } from '../js/engine.ts';
import { MOUNT, addFile, nano7gStyleIpod, newEngine, restart } from './helpers.mjs';

const vectors = JSON.parse(readFileSync(fileURLToPath(new URL('./hashab-vectors.json', import.meta.url)), 'utf8'));

const fromHex = (hex) => Uint8Array.from(hex.match(/../g).map((byte) => parseInt(byte, 16)));
const toHex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
const nonZero = (bytes) => bytes.filter((byte) => byte !== 0).length;

const ITUNES = `${MOUNT}/iPod_Control/iTunes`;

describe('hashAB known-answer vectors', () => {
  it('has the expected vector file', () => {
    assert.equal(vectors.length, 100);
  });

  it('matches every vector with the hash compiled into the engine', async () => {
    const { module } = await newEngine();
    const target = module._malloc(57);
    const sha1 = module._malloc(20);
    const uuid = module._malloc(20); // libgpod passes 20 bytes, only the first 8 are used
    const rnd = module._malloc(23);
    module.HEAPU8.set(new TextEncoder().encode('ABCDEFGHIJKLMNOPQRSTUVW'), rnd);

    const failures = [];
    for (const vector of vectors) {
      module.HEAPU8.fill(0, uuid, uuid + 20);
      module.HEAPU8.set(fromHex(vector.sha1), sha1);
      module.HEAPU8.set(fromHex(vector.uuid), uuid);
      module._calcHashAB(target, sha1, uuid, rnd);
      const got = toHex(module.HEAPU8.slice(target, target + 57));
      if (got !== vector.target) failures.push({ sha1: vector.sha1, expected: vector.target, got });
    }
    for (const pointer of [target, sha1, uuid, rnd]) module._free(pointer);
    assert.deepEqual(failures, [], `${failures.length} of ${vectors.length} vectors differ`);
  });
});

describe('hashAB database write (nano 7G style)', () => {
  it('selects hashAB from the device SysInfoExtended', async () => {
    const engine = await nano7gStyleIpod();
    const device = engine.device();
    assert.equal(device.checksum, 'hashAB', 'DBVersion 5 should select hashAB');
    assert.equal(device.checksum_type, 3);
    assert.equal(device.firewire_id, '0000000000000001');
    assert.equal(device.has_sysinfo_extended, true);
  });

  it('writes the signed files a nano 7G reads, using only SysInfoExtended for the ID', async () => {
    const engine = await nano7gStyleIpod();
    addFile(engine, 'music', { title: 'Song', artist: 'Artist' }, 'x.mp3', 10);
    engine.write();

    // This model family keeps an empty iTunesDB and puts the real data in iTunesCDB.
    assert.equal(engine.fs.stat(`${ITUNES}/iTunesDB`).size, 0);

    const cdb = engine.fs.readFile(`${ITUNES}/iTunesCDB`);
    assert.equal(String.fromCharCode(...cdb.slice(0, 4)), 'mhbd');
    assert.equal(cdb[0x30] | (cdb[0x31] << 8), 3, 'hashing scheme field should say hashAB');
    assert.deepEqual([...cdb.slice(0xab, 0xad)], [3, 0], 'signature header at 0xAB');
    assert.ok(nonZero(cdb.slice(0xab, 0xab + 57)) > 40, 'signature bytes should be filled in');
    assert.equal(nonZero(cdb.slice(0x58, 0x58 + 20)), 0, 'hash58 field stays empty');
    assert.equal(nonZero(cdb.slice(0x72, 0x72 + 46)), 0, 'hash72 field stays empty');

    const cbk = engine.fs.readFile(`${ITUNES}/iTunes Library.itlp/Locations.itdb.cbk`);
    assert.ok(cbk.length > 0);
    assert.deepEqual([...cbk.slice(0, 2)], [3, 0], 'the checksum file carries the same signature header');
  });

  it('reads the signed database back', async () => {
    const engine = await nano7gStyleIpod();
    addFile(engine, 'music', { title: 'Song', artist: 'Artist', album: 'Album' }, 'x.mp3', 10);
    engine.write();

    const [track] = (await restart(engine)).tracks();
    assert.equal(track.title, 'Song');
    assert.equal(track.artist, 'Artist');
    assert.equal(track.album, 'Album');
  });

  it('fails the write when the FireWire ID is not a real one', async () => {
    const engine = await nano7gStyleIpod({ fireWireId: null });
    addFile(engine, 'music', { title: 'Song' }, 'x.mp3', 10);
    assert.throws(
      () => engine.write(),
      // libgpod's own message is vague. The app has to check the ID itself before writing.
      (error) => error instanceof EngineError && /Locations\.itdb\.cbk/.test(error.message),
    );
  });
});
