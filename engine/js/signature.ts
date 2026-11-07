/**
 * Checks the hashAB signatures on an iPod's own database files. Reads only.
 *
 * The nano 6G and 7G refuse a database that is not signed correctly. The signature is a
 * function of a SHA-1 of the file and the iPod's FireWire ID, plus 23 random bytes that
 * the signer picks and leaves visible inside the signature. iTunes wrote the signatures
 * already on an iPod, so recomputing one with the engine's hashAB code, and finding it
 * identical, shows the engine signs the way this iPod expects. That is a check on real
 * hardware data without writing anything to the iPod.
 *
 * Two files carry a signature:
 * - iTunesCDB: SHA-1 of the whole file with four header fields zeroed, signature at 0xAB.
 * - Locations.itdb.cbk: [57-byte signature][20-byte SHA-1 of the block hashes][one SHA-1
 *   per 1024-byte block of Locations.itdb].
 * Both layouts follow libgpod and the hashab project, which agree.
 */

import type { Engine } from './engine.ts';

export type SignatureStatus = 'matches' | 'differs' | 'unsupported' | 'missing';

export interface SignatureCheck {
  file: string;
  status: SignatureStatus;
  detail: string;
}

const SIGNATURE_SIZE = 57;
const RANDOM_SIZE = 23;
const BLOCK_SIZE = 1024;
const HASH_SIZE = 20;

/**
 * Where each random byte ends up in the signature: signature[i + 2] holds the random byte
 * numbered PERMUTATION[i] when that number is below 23. Copied from the hashab project
 * (calcHashAB.c, public domain). A test runs it against the project's 100 vectors.
 */
const PERMUTATION = [
  0x15, 0x1c, 0x06, 0x0c, 0x07, 0x1a, 0x05, 0x13, 0x08, 0x19, 0x03, 0x01, 0x2d, 0x1e, 0x10, 0x31, 0x1d, 0x14, 0x28, 0x27,
  0x35, 0x00, 0x2f, 0x1b, 0x26, 0x0b, 0x0e, 0x02, 0x23, 0x17, 0x24, 0x22, 0x12, 0x1f, 0x20, 0x04, 0x29, 0x25, 0x21, 0x09,
  0x18, 0x0d, 0x32, 0x0f, 0x11, 0x2e, 0x33, 0x2b, 0x30, 0x2a, 0x36, 0x0a, 0x2c, 0x34, 0x16, 0x37,
];

/** The random bytes the signer picked, read back out of a signature. Null if it is not one. */
export function extractRandomBytes(signature: Uint8Array): Uint8Array | null {
  if (signature.length !== SIGNATURE_SIZE || signature[0] !== 3 || signature[1] !== 0) return null;
  const random = new Uint8Array(RANDOM_SIZE);
  const seen = new Set<number>();
  for (let i = 0; i < SIGNATURE_SIZE - 2; i += 1) {
    const source = PERMUTATION[i];
    if (source !== undefined && source < RANDOM_SIZE) {
      random[source] = signature[i + 2] ?? 0;
      seen.add(source);
    }
  }
  return seen.size === RANDOM_SIZE ? random : null;
}

/** A FireWire ID is 16 hex digits, optionally after "0x". Returns its 8 bytes, or null. */
export function parseFireWireId(text: string | null | undefined): Uint8Array | null {
  const digits = (text ?? '').trim().replace(/^0x/i, '');
  if (!/^[0-9a-f]{16}$/i.test(digits)) return null;
  return Uint8Array.from(digits.match(/../g) ?? [], (pair) => parseInt(pair, 16));
}

/** Finds the FireWire ID in the iPod's own device files, when libgpod could not give it. */
export function findFireWireId(engine: Engine, mount: string): string | null {
  const read = (name: string): string | null => {
    const path = `${mount}/iPod_Control/Device/${name}`;
    return engine.fs.analyzePath(path).exists ? new TextDecoder().decode(engine.fs.readFile(path)) : null;
  };
  const sysInfo = read('SysInfo');
  const fromSysInfo = sysInfo?.match(/FirewireGuid:\s*(?:0x)?([0-9a-f]{16})/i)?.[1];
  if (fromSysInfo) return fromSysInfo;
  const extended = read('SysInfoExtended');
  return extended?.match(/<key>FireWireGUID<\/key>\s*<string>\s*(?:0x)?([0-9a-f]{16})\s*<\/string>/i)?.[1] ?? null;
}

async function sha1(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-1', bytes as BufferSource));
}

/** The engine's own hashAB, the same code libgpod calls when it writes a database. */
function hashAB(engine: Engine, digest: Uint8Array, uuid: Uint8Array, random: Uint8Array): Uint8Array {
  const { module } = engine;
  const target = module._malloc(SIGNATURE_SIZE);
  const digestPointer = module._malloc(HASH_SIZE);
  const uuidPointer = module._malloc(HASH_SIZE); // libgpod passes 20 bytes and only the first 8 matter
  const randomPointer = module._malloc(RANDOM_SIZE);
  try {
    module.HEAPU8.fill(0, uuidPointer, uuidPointer + HASH_SIZE);
    module.HEAPU8.set(digest, digestPointer);
    module.HEAPU8.set(uuid, uuidPointer);
    module.HEAPU8.set(random, randomPointer);
    module._calcHashAB(target, digestPointer, uuidPointer, randomPointer);
    return module.HEAPU8.slice(target, target + SIGNATURE_SIZE);
  } finally {
    for (const pointer of [target, digestPointer, uuidPointer, randomPointer]) module._free(pointer);
  }
}

const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((value, index) => value === b[index]);

function readIfPresent(engine: Engine, path: string): Uint8Array | null {
  return engine.fs.analyzePath(path).exists ? engine.fs.readFile(path) : null;
}

/** What a check needs before it can run: the iPod's ID as bytes, or the reason it cannot. */
type Prerequisites = { uuid: Uint8Array } | { problem: string };

const cannotCheck = (file: string, problem: string): SignatureCheck => ({ file, status: 'unsupported', detail: problem });

async function checkDatabase(engine: Engine, path: string, needs: Prerequisites): Promise<SignatureCheck> {
  const file = 'iTunesCDB';
  const bytes = readIfPresent(engine, path);
  if (!bytes) return { file, status: 'missing', detail: 'There is no iTunesCDB on this iPod.' };
  if ('problem' in needs) return cannotCheck(file, needs.problem);
  const { uuid } = needs;
  if (bytes.length < 0xe4 || String.fromCharCode(...bytes.slice(0, 4)) !== 'mhbd') {
    return { file, status: 'differs', detail: 'The file does not start like an iPod database.' };
  }
  const scheme = (bytes[0x30] ?? 0) | ((bytes[0x31] ?? 0) << 8);
  if (scheme !== 3) {
    return { file, status: 'unsupported', detail: `It uses signing scheme ${scheme}. Only hashAB (3) is checked.` };
  }
  const stored = bytes.slice(0xab, 0xab + SIGNATURE_SIZE);
  const random = extractRandomBytes(stored);
  if (!random) return { file, status: 'differs', detail: 'The stored signature is not in the hashAB format.' };

  const zeroed = new Uint8Array(bytes);
  for (const [offset, length] of [[0x18, 8], [0x58, 20], [0x72, 46], [0xab, SIGNATURE_SIZE]] as const) {
    zeroed.fill(0, offset, offset + length);
  }
  const computed = hashAB(engine, await sha1(zeroed), uuid, random);
  return same(computed, stored)
    ? { file, status: 'matches', detail: 'The signature on the iPod is exactly what the engine computes.' }
    : { file, status: 'differs', detail: 'The signature on the iPod is not what the engine computes for this file and FireWire ID.' };
}

async function checkLocations(engine: Engine, folder: string, needs: Prerequisites): Promise<SignatureCheck> {
  const file = 'Locations.itdb.cbk';
  const cbk = readIfPresent(engine, `${folder}/Locations.itdb.cbk`);
  const locations = readIfPresent(engine, `${folder}/Locations.itdb`);
  if (!cbk || !locations) return { file, status: 'missing', detail: 'There is no Locations.itdb.cbk, or no Locations.itdb to check it against.' };
  if ('problem' in needs) return cannotCheck(file, needs.problem);
  const { uuid } = needs;

  const header = SIGNATURE_SIZE + HASH_SIZE;
  if (cbk.length < header || (cbk.length - header) % HASH_SIZE !== 0) {
    return { file, status: 'differs', detail: 'The file is not the size a checksum file should be.' };
  }
  const blocks = (cbk.length - header) / HASH_SIZE;
  if (blocks !== Math.floor(locations.length / BLOCK_SIZE)) {
    return { file, status: 'differs', detail: `It lists ${blocks} blocks but Locations.itdb has ${Math.floor(locations.length / BLOCK_SIZE)}.` };
  }

  const hashes = new Uint8Array(blocks * HASH_SIZE);
  for (let block = 0; block < blocks; block += 1) {
    const hash = await sha1(locations.subarray(block * BLOCK_SIZE, (block + 1) * BLOCK_SIZE));
    hashes.set(hash, block * HASH_SIZE);
    if (!same(hash, cbk.subarray(header + block * HASH_SIZE, header + (block + 1) * HASH_SIZE))) {
      return { file, status: 'differs', detail: `Block ${block} of Locations.itdb does not match its stored hash.` };
    }
  }
  const final = await sha1(hashes);
  if (!same(final, cbk.subarray(SIGNATURE_SIZE, header))) {
    return { file, status: 'differs', detail: 'The hash of the block hashes does not match.' };
  }

  const stored = cbk.slice(0, SIGNATURE_SIZE);
  const random = extractRandomBytes(stored);
  if (!random) return { file, status: 'differs', detail: 'The stored signature is not in the hashAB format.' };
  return same(hashAB(engine, final, uuid, random), stored)
    ? { file, status: 'matches', detail: 'The block hashes and the signature on the iPod are exactly what the engine computes.' }
    : { file, status: 'differs', detail: 'The block hashes match, but the signature is not what the engine computes for this FireWire ID.' };
}

/**
 * Runs both checks on the iPod folder loaded at `mount`. `fireWireId` is its 16 hex digits.
 * A file that is not there is reported as missing whatever else is wrong, so an iPod without
 * these files shows nothing alarming.
 */
export async function verifySignatures(engine: Engine, mount: string, fireWireId: string | null): Promise<SignatureCheck[]> {
  const uuid = parseFireWireId(fireWireId);
  const needs: Prerequisites = !uuid
    ? { problem: 'No valid FireWire ID was found, and the signature depends on it.' }
    : !globalThis.crypto?.subtle
      ? { problem: "This page is not in a secure context, so the browser's SHA-1 is not available." }
      : { uuid };
  const itunes = `${mount}/iPod_Control/iTunes`;
  return [
    await checkDatabase(engine, `${itunes}/iTunesCDB`, needs),
    await checkLocations(engine, `${itunes}/iTunes Library.itlp`, needs),
  ];
}
