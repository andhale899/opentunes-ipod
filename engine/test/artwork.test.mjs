// Album art, the pure parts: the thumbnails and the ArtworkDB bytes.
//
// The expected values are the ones in docs/ARTWORK-RESEARCH.md, which come from the owner's own
// ArtworkDB and .ithmb files (sizes and offsets of every field), not from this code. The reader
// in this file is written separately from the one in artwork.ts, so the writer is not checked
// against itself. These tests cannot show a real nano 7G accepts the result.
//
// One test compares the writer with a real ArtworkDB. It runs only when OPENTUNES_REAL_ARTWORKDB
// names one (for example a file from a backup of the owner's iPod), and is skipped otherwise.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import {
  ArtworkError, COVER_FORMATS, addToArtworkDb, coverSupport, createArtworkDb, imageRecord, nextImageId, parseArtworkDb, planArtwork, renderCover, renderThumbnail, withCoverFormats,
} from '../js/index.ts';
import { readDb, rgbaImage, sysInfoExtended } from './artwork-helpers.mjs';
import { MOUNT, newEngine } from './helpers.mjs';


describe('the thumbnail formats', () => {
  it('are the four of the owner\'s nano 7G, with the sizes of its .ithmb files', () => {
    assert.deepEqual(COVER_FORMATS.map((format) => [format.id, format.width, format.height, format.slotBytes]), [
      [1010, 240, 240, 115200], [1013, 50, 50, 5000], [1015, 58, 58, 6728], [1016, 57, 57, 6612],
    ]);
    assert.equal(COVER_FORMATS.find((format) => format.id === 1016).rowBytes, 116); // 57 pixels, widened to 58
  });

  it('are the ones the real device file declares, and a different model is refused', () => {
    const support = coverSupport(sysInfoExtended());
    assert.deepEqual(support, { ok: true, reason: null, maxThumbFileBytes: 50_000_000 });
    assert.match(coverSupport(null).reason, /no SysInfoExtended/);
    assert.match(coverSupport('<plist><dict><key>DBVersion</key><integer>5</integer></dict></plist>').reason, /does not list any album art formats/);
    assert.match(coverSupport(sysInfoExtended().replace('<integer>1016</integer>', '<integer>1099</integer>')).reason, /does not list album art format 1016/);
    // Another size for 1010
    const changed = sysInfoExtended().replace(/(<key>FormatId<\/key>\s*<integer>1010<\/integer>\s*<key>RenderWidth<\/key>\s*<integer>)240/, '$1200');
    assert.match(coverSupport(changed).reason, /format 1010 differently/);
    // The new key is only read when the old one is empty, as libgpod does.
    assert.equal(coverSupport(sysInfoExtended().replace('<key>AlbumArt2</key>', '<key>Other</key>')).ok, false);
  });

  it('can be added to the stripped-down description of the practice iPod, and libgpod then reads them', async () => {
    const plain = '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n  <key>DBVersion</key>\n  <integer>5</integer>\n</dict>\n</plist>\n';
    assert.equal(coverSupport(plain).ok, false);
    const added = withCoverFormats(plain);
    assert.deepEqual(coverSupport(added), { ok: true, reason: null, maxThumbFileBytes: 50_000_000 });
    assert.equal(withCoverFormats(added), added, 'a file that lists formats is left as it is');
    assert.equal(withCoverFormats(sysInfoExtended()), sysInfoExtended());
    const engine = await newEngine();
    engine.init(MOUNT, 'MA450', 'Test');
    engine.fs.writeFile(`${MOUNT}/iPod_Control/Device/SysInfoExtended`, added.replace('<key>DBVersion</key>', '<key>FireWireGUID</key>\n  <string>0000000000000001</string>\n  <key>DBVersion</key>'));
    engine.open(MOUNT);
    assert.equal(engine.device().supports.artwork, true, 'libgpod reads the formats from AlbumArt2');
  });
});

/** Unpacks a thumbnail the way the iPod reads it: little endian RGB565, rows of `rowBytes`. */
function unpack(bytes, format) {
  const pixels = [];
  for (let y = 0; y < format.height; y += 1) {
    for (let x = 0; x < format.width; x += 1) {
      const value = bytes[y * format.rowBytes + x * 2] | (bytes[y * format.rowBytes + x * 2 + 1] << 8);
      pixels.push([((value >> 11) & 31) * 255 / 31, ((value >> 5) & 63) * 255 / 63, (value & 31) * 255 / 31]);
    }
  }
  return pixels;
}

describe('rendering a thumbnail', () => {
  it('writes little endian RGB565, row by row, with zero bytes where a row is widened', () => {
    const format = COVER_FORMATS.find((candidate) => candidate.id === 1016);
    const image = rgbaImage(10, 10, () => [255, 0, 0, 255]);
    const bytes = renderThumbnail(image, format);
    assert.equal(bytes.length, 6612);
    // Red is 11111 000000 00000 = 0xF800: the low byte first.
    assert.deepEqual([...bytes.slice(0, 4)], [0x00, 0xf8, 0x00, 0xf8]);
    for (let y = 0; y < format.height; y += 1) {
      assert.deepEqual([...bytes.slice(y * 116 + 114, y * 116 + 116)], [0, 0], `row ${y} widening bytes`);
      assert.equal(bytes[y * 116 + 112 + 1], 0xf8, `row ${y} last pixel`);
    }
  });

  it('keeps each corner of a four colour picture in its own corner, at every size', () => {
    const colours = { tl: [255, 0, 0], tr: [0, 255, 0], bl: [0, 0, 255], br: [255, 255, 255] };
    const image = rgbaImage(400, 400, (x, y) => [...colours[`${y < 200 ? 't' : 'b'}${x < 200 ? 'l' : 'r'}`], 255]);
    const covers = renderCover(image);
    for (const format of COVER_FORMATS) {
      const pixels = unpack(covers.get(format.id), format);
      const at = (x, y) => pixels[y * format.width + x];
      const near = (pixel, colour) => pixel.every((value, index) => Math.abs(value - colour[index]) < 12);
      assert.ok(near(at(2, 2), colours.tl), `${format.id} top left ${at(2, 2)}`);
      assert.ok(near(at(format.width - 3, 2), colours.tr), `${format.id} top right`);
      assert.ok(near(at(2, format.height - 3), colours.bl), `${format.id} bottom left`);
      assert.ok(near(at(format.width - 3, format.height - 3), colours.br), `${format.id} bottom right`);
    }
  });

  it('averages when shrinking, so a fine pattern comes out as grey and not as one of its colours', () => {
    const image = rgbaImage(480, 480, (x) => (x % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    const format = COVER_FORMATS[0];
    const [r, g, b] = unpack(renderThumbnail(image, format), format)[120 * 240 + 120];
    for (const value of [r, g, b]) assert.ok(value > 100 && value < 155, `grey, got ${value}`);
  });

  it('fits a wide picture inside the square without cropping it, and fills the rest black', () => {
    const format = COVER_FORMATS[0];
    const image = rgbaImage(480, 240, () => [255, 255, 255, 255]);
    const pixels = unpack(renderThumbnail(image, format), format);
    const at = (x, y) => pixels[y * format.width + x];
    assert.deepEqual(at(0, 60), [255, 255, 255], 'the whole width is used');
    assert.deepEqual(at(239, 60), [255, 255, 255]);
    assert.deepEqual(at(120, 10), [0, 0, 0], 'black above');
    assert.deepEqual(at(120, 230), [0, 0, 0], 'black below');
    assert.deepEqual(at(120, 120), [255, 255, 255]);
  });

  it('lays a see-through picture over black', () => {
    const format = COVER_FORMATS[1];
    const half = unpack(renderThumbnail(rgbaImage(50, 50, () => [255, 255, 255, 0]), format), format)[0];
    assert.deepEqual(half, [0, 0, 0]);
  });

  it('refuses a picture with no pixels, and one that is too large', () => {
    assert.throws(() => renderThumbnail({ width: 0, height: 4, data: new Uint8Array(0) }, COVER_FORMATS[0]), ArtworkError);
    assert.throws(() => renderThumbnail({ width: 7000, height: 7000, data: new Uint8Array(16) }, COVER_FORMATS[0]), /no pixels|more than/);
  });
});

const offsets = (base) => new Map(COVER_FORMATS.map((format) => [format.id, base * format.slotBytes]));
const SONG = 0x1122334455667788n;

describe('the ArtworkDB', () => {
  it('has the layout of the owner\'s file: sizes, counts, the four formats in order, names and slots', () => {
    const bytes = createArtworkDb([{ id: 100, songId: SONG, sourceSize: 17135, trackCount: 1, offsets: offsets(0) }]);
    assert.equal(bytes.length, 0x848, 'the owner\'s file with one image is 2,120 bytes');
    const db = readDb(bytes);
    assert.equal(db.nextId, 101);
    assert.deepEqual(db.formats, [[1010, 115200], [1013, 5000], [1015, 6728], [1016, 6612]]);
    const [image] = db.images;
    assert.equal(image.id, 100);
    assert.equal(image.songId, SONG);
    assert.equal(image.sourceSize, 17135);
    assert.deepEqual([image.count, image.flag], [1, 1]);
    assert.deepEqual(image.nan, [[0, 0, 0, 0, 0, 0, 0xf8, 0x7f], [0, 0, 0, 0, 0, 0, 0xf8, 0x7f]]);
    assert.deepEqual(image.thumbs.map((t) => [t.format, t.offset, t.size, t.size2, t.width, t.height, t.vpad, t.hpad, t.file]), [
      [1010, 0, 115200, 115200, 240, 240, 0, 0, ':F1010_1.ithmb'],
      [1013, 0, 5000, 5000, 50, 50, 0, 0, ':F1013_1.ithmb'],
      [1015, 0, 6728, 6728, 58, 58, 0, 0, ':F1015_1.ithmb'],
      [1016, 0, 6612, 6612, 57, 57, 0, 0, ':F1016_1.ithmb'],
    ]);
  });

  it('writes the mhii record with the sizes of the owner\'s file: 928 bytes with four formats', () => {
    assert.equal(imageRecord({ id: 100, songId: 1n, sourceSize: 1, trackCount: 1, offsets: offsets(0) }).length, 928);
  });

  it('keeps a track id above 2^63 as the unsigned number the file holds', () => {
    const big = 0xfedcba9876543210n;
    const bytes = createArtworkDb([{ id: 100, songId: big, sourceSize: 1, trackCount: 1, offsets: offsets(0) }]);
    assert.equal(readDb(bytes).images[0].songId, big);
    assert.equal(readDb(createArtworkDb([{ id: 100, songId: BigInt.asIntN(64, big), sourceSize: 1, trackCount: 1, offsets: offsets(0) }])).images[0].songId, big);
  });

  it('adds images after the ones in it and leaves every byte of the old ones as it is', () => {
    const old = createArtworkDb([{ id: 100, songId: 1n, sourceSize: 10, trackCount: 1, offsets: offsets(0) }]);
    const added = [
      { id: 101, songId: 2n, sourceSize: 20, trackCount: 3, offsets: offsets(1) },
      { id: 102, songId: 3n, sourceSize: 30, trackCount: 1, offsets: offsets(2) },
    ];
    const next = addToArtworkDb(old, added);
    assert.equal(next.length, old.length + 2 * 928);
    const db = readDb(next);
    assert.equal(db.nextId, 103);
    assert.deepEqual(db.images.map((image) => [image.id, image.songId, image.count]), [[100, 1n, 1], [101, 2n, 3], [102, 3n, 1]]);
    // The old image's record, the top record's ids, the album set and the format list: all identical.
    const oldImage = old.slice(0x140, 0x140 + 928);
    assert.deepEqual(next.slice(0x140, 0x140 + 928), oldImage);
    assert.deepEqual(next.slice(0x20, 0x20 + 16), old.slice(0x20, 0x20 + 16));
    assert.deepEqual(next.slice(0x3c, 0x44), old.slice(0x3c, 0x44));
    assert.deepEqual(next.slice(next.length - (96 + 92 + 4 * 124 + 96 + 92)), old.slice(old.length - (96 + 92 + 4 * 124 + 96 + 92)));
    assert.equal(nextImageId(parseArtworkDb(next)), 103);
  });

  it('makes a new file with random ids unless it is given them, and the same ids give the same bytes', () => {
    const images = [{ id: 100, songId: 1n, sourceSize: 1, trackCount: 1, offsets: offsets(0) }];
    assert.notDeepEqual(createArtworkDb(images), createArtworkDb(images));
    const ids = { first: new Uint8Array(16).fill(7), second: new Uint8Array(8).fill(9) };
    assert.deepEqual(createArtworkDb(images, ids), createArtworkDb(images, ids));
  });

  it('refuses a file that is not the shape it knows, with a reason', () => {
    const good = createArtworkDb([{ id: 100, songId: 1n, sourceSize: 1, trackCount: 1, offsets: offsets(0) }]);
    const bad = (change) => {
      const copy = Uint8Array.from(good);
      change(copy);
      return copy;
    };
    const set = (at, value) => (bytes) => new DataView(bytes.buffer).setUint32(at, value, true);
    assert.throws(() => parseArtworkDb(new Uint8Array(10)), /does not start with an mhfd/);
    assert.throws(() => parseArtworkDb(bad((b) => (b[0] = 0x78))), /does not start with an mhfd/);
    assert.throws(() => parseArtworkDb(bad(set(8, 5000))), /says it is 5000 bytes/);
    assert.throws(() => parseArtworkDb(bad(set(0x14, 2))), /2 sets/);
    assert.throws(() => parseArtworkDb(good.slice(0, 2000)), /says it is/);
    assert.throws(() => parseArtworkDb(bad(set(0x84 + 0x60 + 8, 5))), /not an mhii|does not fill/);
    assert.throws(() => addToArtworkDb(bad(set(0x6d4 + 0x14, 1)).slice(), []), /left alone/); // mhif of 1013 has another slot size
    assert.throws(() => addToArtworkDb(good, [{ id: 100, songId: 1n, sourceSize: 1, trackCount: 1, offsets: offsets(1) }]), /already in the ArtworkDB/);
  });
});

describe('planning where thumbnails go', () => {
  const cover = (key, songId = 1n, trackCount = 1) => ({
    key, songId, trackCount, sourceSize: 100,
    thumbnails: new Map(COVER_FORMATS.map((format) => [format.id, new Uint8Array(format.slotBytes).fill(key.charCodeAt(0))])),
  });
  const empty = { database: null, thumbSizes: new Map() };

  it('starts a new file at id 100 with every thumbnail at offset 0, then one slot further for each cover', () => {
    const plan = planArtwork(empty, [cover('a'), cover('b')]);
    assert.equal(plan.createsDatabase, true);
    assert.deepEqual(plan.images.map((image) => [image.id, image.offsets.get(1010), image.offsets.get(1016)]), [[100, 0, 0], [101, 115200, 6612]]);
    assert.deepEqual(plan.thumbFiles.map((file) => [file.path, file.sizeBefore, file.append.length]), [
      ['iPod_Control/Artwork/F1010_1.ithmb', 0, 230400], ['iPod_Control/Artwork/F1013_1.ithmb', 0, 10000],
      ['iPod_Control/Artwork/F1015_1.ithmb', 0, 13456], ['iPod_Control/Artwork/F1016_1.ithmb', 0, 13224],
    ]);
    assert.equal(plan.thumbFiles[0].append[0], 'a'.charCodeAt(0));
    assert.equal(plan.thumbFiles[0].append[115200], 'b'.charCodeAt(0));
    assert.equal(readDb(plan.databaseAfter).images.length, 2);
  });

  it('adds after what the iPod holds: at the end of each file, with the next id', () => {
    const database = createArtworkDb([{ id: 100, songId: 1n, sourceSize: 1, trackCount: 1, offsets: offsets(0) }]);
    const sizes = new Map(COVER_FORMATS.map((format) => [format.id, format.slotBytes]));
    const plan = planArtwork({ database, thumbSizes: sizes }, [cover('c')]);
    assert.equal(plan.createsDatabase, false);
    assert.deepEqual(plan.images.map((image) => [image.id, image.offsets.get(1010), image.offsets.get(1013)]), [[101, 115200, 5000]]);
    assert.equal(plan.thumbFiles[0].sizeBefore, 115200);
  });

  it('refuses thumbnail files that are not whole thumbnails, or that the ArtworkDB points past, or that have no ArtworkDB', () => {
    const database = createArtworkDb([{ id: 100, songId: 1n, sourceSize: 1, trackCount: 1, offsets: offsets(0) }]);
    const sizes = (edit) => {
      const map = new Map(COVER_FORMATS.map((format) => [format.id, format.slotBytes]));
      edit(map);
      return map;
    };
    assert.throws(() => planArtwork({ database, thumbSizes: sizes((m) => m.set(1010, 115201)) }, [cover('a')]), /not a whole number/);
    assert.throws(() => planArtwork({ database, thumbSizes: sizes((m) => m.set(1015, 0)) }, [cover('a')]), /points past the end of F1015_1/);
    assert.throws(() => planArtwork({ database: null, thumbSizes: sizes(() => {}) }, [cover('a')]), /no ArtworkDB/);
  });

  it('stops at the size limit the iPod declares, leaving out that cover and every one after it', () => {
    const plan = planArtwork(empty, [cover('a'), cover('b'), cover('c')], 115200 * 2 + 10);
    assert.deepEqual(plan.images.map((image) => image.key), ['a', 'b']);
    assert.deepEqual(plan.left.map((entry) => entry.key), ['c']);
    assert.match(plan.left[0].reason, /F1010_1\.ithmb would pass 0 MB|would pass .* MB/);
  });

  it('refuses a thumbnail of the wrong size', () => {
    const bad = cover('a');
    bad.thumbnails.set(1013, new Uint8Array(10));
    assert.throws(() => planArtwork(empty, [bad]), /format 1013 is 10 bytes and should be 5000/);
  });
});

describe('against a real ArtworkDB from the owner\'s iPod', () => {
  const path = process.env.OPENTUNES_REAL_ARTWORKDB;
  it('rebuilds the same bytes from the fields it reads, and adds an image without changing the old one', { skip: !path || !existsSync(path) ? 'set OPENTUNES_REAL_ARTWORKDB to run' : false }, () => {
    const real = new Uint8Array(readFileSync(path));
    const info = parseArtworkDb(real);
    assert.deepEqual(info.formats.map((format) => format.id), [1010, 1013, 1015, 1016]);
    const rebuilt = createArtworkDb(
      info.images.map((image) => ({ id: image.id, songId: image.songId, sourceSize: image.sourceSize, trackCount: image.trackCount, offsets: new Map(image.thumbs.map((thumb) => [thumb.formatId, thumb.offset])) })),
      { first: real.slice(0x20, 0x30), second: real.slice(0x3c, 0x44) },
    );
    assert.deepEqual(rebuilt, real, 'the writer reproduces the real file byte for byte');
    const next = addToArtworkDb(real, [{ id: nextImageId(info), songId: 5n, sourceSize: 1, trackCount: 1, offsets: offsets(info.images.length) }]);
    assert.deepEqual(next.slice(0, info.imageSetEnd - 0).slice(0x20, 0x30), real.slice(0x20, 0x30));
    assert.deepEqual(next.slice(0x84 + 0x60 + 0x5c, info.imageSetEnd), real.slice(0x84 + 0x60 + 0x5c, info.imageSetEnd));
    assert.equal(parseArtworkDb(next).images.length, info.images.length + 1);
  });
});
