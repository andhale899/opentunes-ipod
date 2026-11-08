// Shared setup for the album art tests.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (path) => fileURLToPath(new URL(path, import.meta.url));

/** A picture made from a function of the pixel position, as the decoder the app uses would hand it over. */
export function rgbaImage(width, height, pixel) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) data.set(pixel(x, y), (y * width + x) * 4);
  }
  return { width, height, data };
}

/** The nano 7G's own description, with a made-up FireWire ID in place of the placeholder. */
export function sysInfoExtended(fireWireId = '0123456789ABCDEF') {
  return readFileSync(here('../data/7_nano_SysInfoExtended.plist'), 'utf8').replace('REPLACE_ME_WITH_FIREWIRE_GUID', fireWireId);
}

/**
 * A stand-in for a picture file: "raw" bytes that the test decoder understands, so no image
 * library is needed. The first 8 bytes are the width and height, then RGBA pixels.
 */
export const RAW_MIME = 'image/x-opentunes-test-raw';

export function rawPicture(width, height, pixel) {
  const image = rgbaImage(width, height, pixel);
  const bytes = new Uint8Array(8 + image.data.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, width, true);
  view.setUint32(4, height, true);
  bytes.set(image.data, 8);
  return { mime: RAW_MIME, data: bytes };
}

/** The decoder to hand to planSync in tests. Null for anything that is not a raw test picture. */
export async function decodeRawPicture(picture) {
  if (picture.mime !== RAW_MIME || picture.data.length < 8) return null;
  const view = new DataView(picture.data.buffer, picture.data.byteOffset);
  const width = view.getUint32(0, true);
  const height = view.getUint32(4, true);
  if (picture.data.length !== 8 + width * height * 4) return null;
  return { width, height, data: picture.data.slice(8) };
}

import assert from 'node:assert/strict';

const u32 = (bytes, at) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(at, true);
const u16 = (bytes, at) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(at, true);
const tag = (bytes, at) => String.fromCharCode(...bytes.slice(at, at + 4));

/** A reader written from the field list in the research document, not from artwork.ts. */
export function readDb(bytes) {
  assert.equal(tag(bytes, 0), 'mhfd');
  assert.equal(u32(bytes, 4), 0x84);
  assert.equal(u32(bytes, 8), bytes.length, 'total length');
  assert.equal(u32(bytes, 0x10), 6);
  assert.equal(u32(bytes, 0x14), 3);
  assert.equal(bytes[0x30], 1);
  const result = { nextId: u32(bytes, 0x1c), images: [], formats: [], albums: null };
  let at = 0x84;
  for (const index of [1, 2, 3]) {
    assert.equal(tag(bytes, at), 'mhsd');
    assert.equal(u32(bytes, at + 4), 0x60);
    assert.equal(u16(bytes, at + 12), index);
    const total = u32(bytes, at + 8);
    const list = at + 0x60;
    assert.equal(u32(bytes, list + 4), 0x5c);
    const count = u32(bytes, list + 8);
    let cursor = list + 0x5c;
    if (index === 1) {
      assert.equal(tag(bytes, list), 'mhli');
      for (let n = 0; n < count; n += 1) {
        assert.equal(tag(bytes, cursor), 'mhii');
        assert.equal(u32(bytes, cursor + 4), 0x98);
        const length = u32(bytes, cursor + 8);
        assert.equal(u32(bytes, cursor + 0x0c), 5);
        const image = {
          id: u32(bytes, cursor + 0x10),
          songId: new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(cursor + 0x14, true),
          sourceSize: u32(bytes, cursor + 0x30),
          count: u32(bytes, cursor + 0x38),
          flag: u32(bytes, cursor + 0x3c),
          nan: [[...bytes.slice(cursor + 0x48, cursor + 0x50)], [...bytes.slice(cursor + 0x50, cursor + 0x58)]],
          thumbs: [],
        };
        let child = cursor + 0x98;
        for (let part = 0; part < 4; part += 1) {
          assert.equal(tag(bytes, child), 'mhod');
          assert.equal(u32(bytes, child + 4), 0x18);
          assert.equal(u32(bytes, child + 8), 164);
          assert.equal(u16(bytes, child + 12), 2);
          const ni = child + 0x18;
          assert.equal(tag(bytes, ni), 'mhni');
          assert.equal(u32(bytes, ni + 4), 0x4c);
          assert.equal(u32(bytes, ni + 8), 140);
          assert.equal(u32(bytes, ni + 0x0c), 1);
          const name = ni + 0x4c;
          assert.equal(tag(bytes, name), 'mhod');
          assert.equal(u32(bytes, name + 8), 64);
          assert.equal(u16(bytes, name + 12), 3);
          assert.equal(u32(bytes, name + 0x18), 28);
          assert.equal(bytes[name + 0x1c], 2);
          const file = new TextDecoder('utf-16le').decode(bytes.slice(name + 0x24, name + 0x24 + 28));
          image.thumbs.push({ format: u32(bytes, ni + 0x10), offset: u32(bytes, ni + 0x14), size: u32(bytes, ni + 0x18), vpad: u16(bytes, ni + 0x1c), hpad: u16(bytes, ni + 0x1e), height: u16(bytes, ni + 0x20), width: u16(bytes, ni + 0x22), size2: u32(bytes, ni + 0x28), file });
          child += 164;
        }
        assert.equal(tag(bytes, child), 'mhod');
        assert.equal(u32(bytes, child + 8), 0x78);
        assert.equal(u16(bytes, child + 12), 6);
        assert.deepEqual([tag(bytes, child + 0x18), u32(bytes, child + 0x1c), u32(bytes, child + 0x20)], ['mhaf', 0x60, 0x3c]);
        assert.equal(child + 0x78, cursor + length);
        result.images.push(image);
        cursor += length;
      }
    } else if (index === 2) {
      assert.equal(tag(bytes, list), 'mhla');
      assert.equal(count, 0);
    } else {
      assert.equal(tag(bytes, list), 'mhlf');
      for (let n = 0; n < count; n += 1) {
        assert.equal(tag(bytes, cursor), 'mhif');
        assert.equal(u32(bytes, cursor + 4), 0x7c);
        assert.equal(u32(bytes, cursor + 8), 0x7c);
        result.formats.push([u32(bytes, cursor + 0x10), u32(bytes, cursor + 0x14)]);
        cursor += 0x7c;
      }
    }
    assert.equal(cursor, at + total, `set ${index} fills its length`);
    at += total;
  }
  assert.equal(at, bytes.length);
  return result;
}

