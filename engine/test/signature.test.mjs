// Checking hashAB signatures on an iPod's own files.
//
// The signatures iTunes wrote carry 23 random bytes of its own choosing, where libgpod uses a
// fixed string. So the check has to read the random bytes back out of the signature instead
// of assuming them. These tests include signatures made with other random bytes to prove it.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extractRandomBytes, findFireWireId, parseFireWireId, verifySignatures } from '../js/index.ts';
import { MOUNT, addFile, nano7gStyleIpod, newEngine, newIpod } from './helpers.mjs';

const vectors = JSON.parse(readFileSync(fileURLToPath(new URL('./hashab-vectors.json', import.meta.url)), 'utf8'));
const fromHex = (hex) => Uint8Array.from(hex.match(/../g).map((byte) => parseInt(byte, 16)));

const ITUNES = `${MOUNT}/iPod_Control/iTunes`;
const GUID = '0000000000000001';

async function signedIpod() {
  const engine = await nano7gStyleIpod({ fireWireId: GUID });
  addFile(engine, 'music', { title: 'Song', artist: 'Artist' }, 'x.mp3', 10);
  addFile(engine, 'podcast', { title: 'Episode' }, 'e.mp3', 10);
  engine.write();
  return engine;
}

const byFile = (checks) => Object.fromEntries(checks.map((check) => [check.file, check]));

/** Random bytes unlike the fixed string libgpod uses, standing in for what iTunes picks. */
const OTHER_RANDOM = Uint8Array.from({ length: 23 }, (_, i) => (i * 37 + 11) & 255);

/** Signs a 20-byte digest with the engine's own hashAB, using the random bytes given. */
function signDigest(engine, digest, uuid, random) {
  const { module } = engine;
  const [target, digestPointer, uuidPointer, randomPointer] = [57, 20, 20, 23].map((size) => module._malloc(size));
  module.HEAPU8.fill(0, uuidPointer, uuidPointer + 20);
  module.HEAPU8.set(digest, digestPointer);
  module.HEAPU8.set(uuid, uuidPointer);
  module.HEAPU8.set(random, randomPointer);
  module._calcHashAB(target, digestPointer, uuidPointer, randomPointer);
  const signature = module.HEAPU8.slice(target, target + 57);
  for (const pointer of [target, digestPointer, uuidPointer, randomPointer]) module._free(pointer);
  return signature;
}

describe('reading the random bytes back out of a signature', () => {
  it('recovers the same 23 bytes from all 100 hashab vectors', () => {
    const expected = new TextEncoder().encode('ABCDEFGHIJKLMNOPQRSTUVW');
    for (const vector of vectors) {
      assert.deepEqual([...extractRandomBytes(fromHex(vector.target))], [...expected], vector.sha1);
    }
  });

  it('refuses anything that is not a hashAB signature', () => {
    assert.equal(extractRandomBytes(new Uint8Array(57)), null);
    assert.equal(extractRandomBytes(new Uint8Array(10)), null);
    assert.equal(extractRandomBytes(fromHex(vectors[0].target).slice(0, 56)), null);
  });
});

describe('FireWire IDs', () => {
  it('parses 16 hex digits, with or without 0x, and nothing else', () => {
    assert.deepEqual([...parseFireWireId('0123456789ABCDEF')], [0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef]);
    assert.deepEqual([...parseFireWireId('0x0123456789abcdef')], [0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef]);
    for (const bad of ['', null, undefined, 'REPLACE_ME_WITH_FIREWIRE_GUID', '12345', '0123456789ABCDE']) {
      assert.equal(parseFireWireId(bad), null, String(bad));
    }
  });

  it('finds the ID in the iPod device files', async () => {
    const engine = await nano7gStyleIpod({ fireWireId: GUID });
    assert.equal(findFireWireId(engine, MOUNT), GUID, 'from SysInfoExtended');
    engine.fs.writeFile(`${MOUNT}/iPod_Control/Device/SysInfo`, 'ModelNumStr: MD480\nFirewireGuid: 0xFEDCBA9876543210\n');
    assert.equal(findFireWireId(engine, MOUNT), 'FEDCBA9876543210', 'SysInfo is preferred');
    assert.equal(findFireWireId(await newEngine(), MOUNT), null);
  });
});

describe('verifying the signatures on a signed iPod', () => {
  it('finds both of them exactly as the engine computes them', async () => {
    const engine = await signedIpod();
    const checks = byFile(await verifySignatures(engine, MOUNT, GUID));
    assert.equal(checks['iTunesCDB'].status, 'matches', checks['iTunesCDB'].detail);
    assert.equal(checks['Locations.itdb.cbk'].status, 'matches', checks['Locations.itdb.cbk'].detail);
  });

  it('reports a changed database, a changed Locations file, and the wrong FireWire ID', async () => {
    const engine = await signedIpod();

    const cdb = engine.fs.readFile(`${ITUNES}/iTunesCDB`);
    cdb[cdb.length - 1] ^= 0xff;
    engine.fs.writeFile(`${ITUNES}/iTunesCDB`, cdb);
    assert.equal(byFile(await verifySignatures(engine, MOUNT, GUID))['iTunesCDB'].status, 'differs');

    const locations = `${ITUNES}/iTunes Library.itlp/Locations.itdb`;
    const bytes = engine.fs.readFile(locations);
    bytes[2000] ^= 0xff;
    engine.fs.writeFile(locations, bytes);
    const cbk = byFile(await verifySignatures(engine, MOUNT, GUID))['Locations.itdb.cbk'];
    assert.equal(cbk.status, 'differs');
    assert.match(cbk.detail, /Block 1 of Locations\.itdb/);

    const other = await signedIpod();
    const wrongId = byFile(await verifySignatures(other, MOUNT, 'FEDCBA9876543210'));
    assert.equal(wrongId['iTunesCDB'].status, 'differs');
    assert.equal(wrongId['Locations.itdb.cbk'].status, 'differs');
  });

  it('accepts a Locations.itdb.cbk signed with random bytes of the signer own choosing, as iTunes does', async () => {
    const engine = await signedIpod();
    const uuid = parseFireWireId(GUID);

    // Rebuild Locations.itdb.cbk by hand with those random bytes, as another signer would.
    const locations = engine.fs.readFile(`${ITUNES}/iTunes Library.itlp/Locations.itdb`);
    const blocks = Math.floor(locations.length / 1024);
    const hashes = new Uint8Array(blocks * 20);
    for (let b = 0; b < blocks; b += 1) {
      hashes.set(new Uint8Array(await crypto.subtle.digest('SHA-1', locations.slice(b * 1024, (b + 1) * 1024))), b * 20);
    }
    const final = new Uint8Array(await crypto.subtle.digest('SHA-1', hashes));
    const signature = signDigest(engine, final, uuid, OTHER_RANDOM);

    assert.notDeepEqual([...extractRandomBytes(signature)], [...new TextEncoder().encode('ABCDEFGHIJKLMNOPQRSTUVW')]);
    const cbk = new Uint8Array(57 + 20 + hashes.length);
    cbk.set(signature, 0);
    cbk.set(final, 57);
    cbk.set(hashes, 77);
    engine.fs.writeFile(`${ITUNES}/iTunes Library.itlp/Locations.itdb.cbk`, cbk);

    assert.equal(byFile(await verifySignatures(engine, MOUNT, GUID))['Locations.itdb.cbk'].status, 'matches');
  });

  it('accepts an iTunesCDB signed with random bytes of the signer own choosing, as iTunes does', async () => {
    const engine = await signedIpod();
    const path = `${ITUNES}/iTunesCDB`;
    const cdb = engine.fs.readFile(path);
    const before = cdb.slice(0xab, 0xab + 57);

    const zeroed = new Uint8Array(cdb);
    for (const [offset, length] of [[0x18, 8], [0x58, 20], [0x72, 46], [0xab, 57]]) zeroed.fill(0, offset, offset + length);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', zeroed));
    cdb.set(signDigest(engine, digest, parseFireWireId(GUID), OTHER_RANDOM), 0xab);
    engine.fs.writeFile(path, cdb);

    assert.notDeepEqual([...cdb.slice(0xab, 0xab + 57)], [...before], 'the signature really changed');
    assert.equal(byFile(await verifySignatures(engine, MOUNT, GUID))['iTunesCDB'].status, 'matches');
  });

  it('says what it cannot check instead of guessing', async () => {
    const unsigned = await newIpod(); // an iPod Video: no iTunesCDB, no Locations file
    const missing = byFile(await verifySignatures(unsigned, MOUNT, GUID));
    assert.equal(missing['iTunesCDB'].status, 'missing');
    assert.equal(missing['Locations.itdb.cbk'].status, 'missing');

    const noId = byFile(await verifySignatures(await signedIpod(), MOUNT, null));
    assert.equal(noId['iTunesCDB'].status, 'unsupported');
    assert.match(noId['iTunesCDB'].detail, /FireWire ID/);
    assert.equal(noId['Locations.itdb.cbk'].status, 'unsupported');
  });

  it('calls absent files missing even when the FireWire ID is also missing', async () => {
    const unsigned = byFile(await verifySignatures(await newIpod(), MOUNT, null));
    assert.equal(unsigned['iTunesCDB'].status, 'missing');
    assert.equal(unsigned['Locations.itdb.cbk'].status, 'missing');
  });

  it('says so when the browser cannot hash, instead of failing', async () => {
    const engine = await signedIpod();
    const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
    try {
      const checks = byFile(await verifySignatures(engine, MOUNT, GUID));
      assert.equal(checks['iTunesCDB'].status, 'unsupported');
      assert.match(checks['iTunesCDB'].detail, /secure context/);
    } finally {
      if (original) Object.defineProperty(globalThis, 'crypto', original);
    }
  });
});
