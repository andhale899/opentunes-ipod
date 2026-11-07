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

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const vectors = JSON.parse(readFileSync(here('./hashab-vectors.json'), 'utf8'));
const { default: createIPodModule } = await import(here('../build/ipod_manager.js'));

const fromHex = (hex) => Uint8Array.from(hex.match(/../g).map((byte) => parseInt(byte, 16)));
const toHex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
const nonZero = (bytes) => bytes.filter((byte) => byte !== 0).length;

const GUID_PLACEHOLDER = 'REPLACE_ME_WITH_FIREWIRE_GUID';
const ITUNES = '/ipod/iPod_Control/iTunes';

describe('hashAB known-answer vectors', () => {
  it('has the expected vector file', () => {
    assert.equal(vectors.length, 100);
  });

  it('matches every vector with the hash compiled into the engine', async () => {
    const M = await createIPodModule();
    const target = M._malloc(57);
    const sha1 = M._malloc(20);
    const uuid = M._malloc(20); // libgpod passes 20 bytes, only the first 8 are used
    const rnd = M._malloc(23);
    M.HEAPU8.set(new TextEncoder().encode('ABCDEFGHIJKLMNOPQRSTUVW'), rnd);

    const failures = [];
    for (const vector of vectors) {
      M.HEAPU8.fill(0, uuid, uuid + 20);
      M.HEAPU8.set(fromHex(vector.sha1), sha1);
      M.HEAPU8.set(fromHex(vector.uuid), uuid);
      M._calcHashAB(target, sha1, uuid, rnd);
      const got = toHex(M.HEAPU8.slice(target, target + 57));
      if (got !== vector.target) failures.push({ sha1: vector.sha1, expected: vector.target, got });
    }
    assert.deepEqual(failures, [], `${failures.length} of ${vectors.length} vectors differ`);
  });
});

/** A nano 7G-style iPod: the v1 template stands in for the SysInfoExtended a real unit carries. */
async function nano7gStyleEngine({ fireWireId }) {
  const M = await createIPodModule();
  M.FS.mkdir('/ipod');
  const call = (name, types = [], args = [], ret = 'number') => M.ccall(name, ret, types, args);
  assert.equal(call('ipod_set_mountpoint', ['string'], ['/ipod']), 0);
  assert.equal(call('ipod_init_new', ['string', 'string'], ['MA450', 'Test']), 0);

  const template = readFileSync(here('../data/7_nano_SysInfoExtended.plist'), 'utf8');
  assert.ok(template.includes(GUID_PLACEHOLDER), 'template should carry a FireWire ID placeholder');
  M.FS.writeFile('/ipod/iPod_Control/Device/SysInfoExtended', fireWireId ? template.replace(GUID_PLACEHOLDER, fireWireId) : template);

  assert.equal(call('ipod_parse_db'), 0, call('ipod_get_last_error', [], [], 'string'));
  call('ipod_add_track', ['string', 'string', 'string', 'string', 'number', 'number', 'number', 'number', 'number', 'number', 'number', 'string'],
    ['Song', 'Artist', 'Album', 'Genre', 1, 1, 2024, 1000, 128, 44100, 10, 'MPEG audio file']);
  const destination = call('ipod_get_track_dest_path', ['string'], ['x.mp3'], 'string');
  M.FS.writeFile(destination, new Uint8Array(10));
  assert.equal(call('ipod_finalize_last_track_no_stat', ['string', 'number'], [destination, 10]), 0);
  return { M, call };
}

describe('hashAB database write (nano 7G style)', () => {
  it('selects hashAB from the device SysInfoExtended', async () => {
    const { call } = await nano7gStyleEngine({ fireWireId: '0000000000000001' });
    const info = JSON.parse(call('ipod_get_device_info_json', [], [], 'string'));
    assert.equal(info.checksum_type, 3, 'DBVersion 5 should select hashAB');
    assert.equal(info.firewire_id, '0000000000000001');
  });

  it('writes the signed files a nano 7G reads, using only SysInfoExtended for the ID', async () => {
    const { M, call } = await nano7gStyleEngine({ fireWireId: '0000000000000001' });
    assert.equal(call('ipod_write_db'), 0, call('ipod_get_last_error', [], [], 'string'));

    // This model family keeps an empty iTunesDB and puts the real data in iTunesCDB.
    assert.equal(M.FS.stat(`${ITUNES}/iTunesDB`).size, 0);

    const cdb = M.FS.readFile(`${ITUNES}/iTunesCDB`);
    assert.equal(String.fromCharCode(...cdb.slice(0, 4)), 'mhbd');
    assert.equal(cdb[0x30] | (cdb[0x31] << 8), 3, 'hashing scheme field should say hashAB');
    assert.deepEqual([...cdb.slice(0xab, 0xad)], [3, 0], 'signature header at 0xAB');
    assert.ok(nonZero(cdb.slice(0xab, 0xab + 57)) > 40, 'signature bytes should be filled in');
    assert.equal(nonZero(cdb.slice(0x58, 0x58 + 20)), 0, 'hash58 field stays empty');
    assert.equal(nonZero(cdb.slice(0x72, 0x72 + 46)), 0, 'hash72 field stays empty');

    const cbk = M.FS.readFile(`${ITUNES}/iTunes Library.itlp/Locations.itdb.cbk`);
    assert.ok(cbk.length > 0);
    assert.deepEqual([...cbk.slice(0, 2)], [3, 0], 'the checksum file carries the same signature header');
  });

  it('fails the write when the FireWire ID is not a real one', async () => {
    const { call } = await nano7gStyleEngine({ fireWireId: null });
    assert.equal(call('ipod_write_db'), -1);
    // libgpod's own message is vague. The app has to check the ID itself before writing.
    assert.match(call('ipod_get_last_error', [], [], 'string'), /Locations\.itdb\.cbk/);
  });
});
