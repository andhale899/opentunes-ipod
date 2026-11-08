// Album art in a sync: what is written where, how the library links to it, and what happens when
// something goes wrong.
//
// The iPods are in-memory folders written by the real engine, laid out like a nano 7G with the
// device's real SysInfoExtended. The files are read back and checked against the format in
// docs/ARTWORK-RESEARCH.md, with a reader written separately from the writer. These tests cannot
// show that a real nano 7G displays the art: only a run on the owner's iPod can.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { COVER_FORMATS, applySync, createArtworkDb, planSync, renderCover } from '../js/index.ts';
import { decodeRawPicture, rawPicture, readDb, sysInfoExtended } from './artwork-helpers.mjs';
import { LIBRARY, MOUNT, backedUp, instrument, makeItem, newEngine, putFile, readIpod, signedIpod, snapshot } from './sync-helpers.mjs';

const ARTWORK = 'iPod_Control/Artwork';
const DB = `${ARTWORK}/ArtworkDB`;
const thumbPath = (id) => `${ARTWORK}/F${id}_1.ithmb`;
const LIBRARY_ITDB = `${MOUNT}/${LIBRARY}/Library.itdb`;
const options = { artwork: { decode: decodeRawPicture } };
const offsets = (base) => new Map(COVER_FORMATS.map((format) => [format.id, base * format.slotBytes]));

/** A nano 7G-style iPod that carries the device's real description, so the formats are declared. */
async function artIpod({ maxThumbMegabytes } = {}) {
  const ipod = await signedIpod();
  let description = sysInfoExtended('0000000000000001');
  if (maxThumbMegabytes) description = description.replace(/(<key>MaxThumbFileSize<\/key>\s*<integer>)\d+/, `$1${maxThumbMegabytes}`);
  await putFile(ipod, 'iPod_Control/Device/SysInfoExtended', new TextEncoder().encode(description));
  return ipod;
}

/** An iPod that already holds one orphan image, like the owner's: files made to the documented sizes. */
async function artIpodWithArt() {
  const ipod = await artIpod();
  await putFile(ipod, DB, createArtworkDb([{ id: 100, songId: 12345n, sourceSize: 777, trackCount: 1, offsets: offsets(0) }]));
  for (const format of COVER_FORMATS) await putFile(ipod, thumbPath(format.id), new Uint8Array(format.slotBytes).fill(0xa5));
  return ipod;
}

const withCover = (color, tags = {}, extra = {}) => {
  const item = makeItem('music', { tags, ...extra });
  item.info.artwork = rawPicture(20, 20, () => [...color, 255]);
  return item;
};

const files = (ipod) => ipod.listFiles();

async function sqlRows(ipod, query) {
  return (await readIpod(ipod)).sqlQuery(LIBRARY_ITDB, query).rows;
}

describe('album art in a sync', () => {
  it('writes the thumbnails and a new ArtworkDB, links the track in the library, and reads it all back', async () => {
    const ipod = await artIpod();
    const backup = await backedUp(ipod);
    const item = withCover([255, 0, 0], { title: 'With a cover', album: 'Album One' });
    const plain = makeItem('music', { tags: { title: 'Without', album: 'Album Two' } });
    const plan = await planSync(ipod, newEngine, [item, plain], options);
    assert.deepEqual(plan.warnings.filter((warning) => !/no ArtworkDB|free space was not checked/.test(warning)), []);
    assert.ok(plan.warnings.some((warning) => /no ArtworkDB, so a new one is made/.test(warning)));
    assert.equal(plan.artwork.images.length, 1);
    assert.deepEqual(plan.artworkLinks, [{ itemId: item.id, imageId: 100 }]);
    assert.ok(plan.summary.some((line) => /Add album art to 1 track: 1 picture/.test(line)));
    assert.equal(files(ipod).has(DB), false, 'planning wrote nothing');

    const report = await applySync(plan, ipod, newEngine, { backup });
    assert.deepEqual(report.failures, []);
    assert.equal(report.verified, true);
    assert.deepEqual(report.artwork.written.map((file) => file.path), COVER_FORMATS.map((format) => thumbPath(format.id)).concat(DB));
    assert.equal(report.artwork.tracks, 1);

    // The thumbnails: one slot each, the bytes the renderer makes, in the four files.
    const after = files(ipod);
    const expected = renderCover({ width: 20, height: 20, data: Uint8Array.from({ length: 1600 }, (_, i) => [255, 0, 0, 255][i % 4]) });
    for (const format of COVER_FORMATS) {
      assert.equal(after.get(thumbPath(format.id)).length, format.slotBytes);
      assert.deepEqual(after.get(thumbPath(format.id)), expected.get(format.id));
    }
    // The first pixel of a red picture is 0xF800, low byte first.
    assert.deepEqual([...after.get(thumbPath(1010)).slice(0, 2)], [0x00, 0xf8]);

    // The ArtworkDB: one image, id 100, naming the new track by its persistent id.
    const library = await readIpod(ipod);
    const track = library.tracks().find((candidate) => candidate.title === 'With a cover');
    const db = readDb(after.get(DB));
    assert.equal(db.images.length, 1);
    assert.equal(db.images[0].id, 100);
    assert.equal(db.images[0].songId, BigInt(track.dbid));
    assert.equal(db.images[0].sourceSize, item.info.artwork.data.length);
    assert.deepEqual(db.images[0].thumbs.map((thumb) => [thumb.format, thumb.offset]), COVER_FORMATS.map((format) => [format.id, 0]));
    assert.equal(db.nextId, 101);

    // The library: the track holds the image id and flag, in the database and in SQLite.
    assert.deepEqual([track.mhii_link, track.has_artwork, track.artwork_count, track.artwork_size], [100, 1, 1, item.info.artwork.data.length]);
    const other = library.tracks().find((candidate) => candidate.title === 'Without');
    assert.equal(other.mhii_link, 0);
    const pid = BigInt.asIntN(64, BigInt(track.dbid)).toString();
    const rows = library.sqlQuery(LIBRARY_ITDB, 'SELECT pid, artwork_status, artwork_cache_id FROM item WHERE artwork_cache_id <> 0').rows;
    assert.deepEqual(rows.map((row) => [String(row[0]), Number(row[1]), Number(row[2])]), [[pid, 1, 100]]);
    const albums = library.sqlQuery(LIBRARY_ITDB, 'SELECT name, artwork_status, artwork_item_pid FROM album WHERE artwork_item_pid IS NOT NULL AND artwork_item_pid <> 0').rows;
    assert.deepEqual(albums.map((row) => [row[0], Number(row[1]), String(row[2])]), [['Album One', 0, pid]]);
  });

  it('adds to an ArtworkDB that is already there: old image and old thumbnails untouched, the next id, the end of each file', async () => {
    const ipod = await artIpodWithArt();
    const before = snapshot(ipod);
    const backup = await backedUp(ipod);
    const item = withCover([0, 255, 0]);
    const plan = await planSync(ipod, newEngine, [item], options);
    assert.equal(plan.artwork.createsDatabase, false);
    assert.ok(!plan.warnings.some((warning) => /no ArtworkDB/.test(warning)));
    const report = await applySync(plan, ipod, newEngine, { backup });
    assert.deepEqual(report.failures, []);

    const after = files(ipod);
    const db = readDb(after.get(DB));
    assert.deepEqual(db.images.map((image) => image.id), [100, 101]);
    assert.equal(db.nextId, 102);
    assert.deepEqual(db.images[1].thumbs.map((thumb) => [thumb.format, thumb.offset]), COVER_FORMATS.map((format) => [format.id, format.slotBytes]));
    // The old image's record is the same bytes, and so is everything before the new one.
    assert.deepEqual(after.get(DB).slice(0x140, 0x140 + 928), before.get(DB).slice(0x140, 0x140 + 928));
    assert.deepEqual(after.get(DB).slice(0, 8), before.get(DB).slice(0, 8));
    for (const format of COVER_FORMATS) {
      const old = before.get(thumbPath(format.id));
      const now = after.get(thumbPath(format.id));
      assert.equal(now.length, old.length * 2);
      assert.deepEqual(now.slice(0, old.length), old, `the old ${format.id} thumbnail is untouched`);
    }
  });

  it('keeps the art of tracks already on the iPod through a sync that adds a plain track', async () => {
    const ipod = await artIpod();
    const first = await planSync(ipod, newEngine, [withCover([0, 0, 255], { title: 'First' })], options);
    assert.deepEqual((await applySync(first, ipod, newEngine, { backup: await backedUp(ipod) })).failures, []);
    const second = await planSync(ipod, newEngine, [makeItem('music', { tags: { title: 'Second', album: 'Other' } })], options);
    const report = await applySync(second, ipod, newEngine, { backup: await backedUp(ipod) });
    assert.deepEqual(report.failures, []);
    assert.equal(report.artwork, null);
    const rows = await sqlRows(ipod, 'SELECT artwork_status, artwork_cache_id FROM item WHERE artwork_cache_id <> 0');
    assert.deepEqual(rows.map((row) => row.map(Number)), [[1, 100]], 'the link written by the first sync is still in the SQLite library');
  });

  it('gives tracks with the same picture one image, and different pictures their own', async () => {
    const ipod = await artIpod();
    const a1 = withCover([10, 20, 30], { title: 'A1', album: 'Same' });
    const a2 = withCover([10, 20, 30], { title: 'A2', album: 'Same' });
    const b = withCover([200, 100, 0], { title: 'B', album: 'Other' });
    const plan = await planSync(ipod, newEngine, [a1, a2, b], options);
    assert.equal(plan.artwork.images.length, 2);
    assert.deepEqual(plan.artworkLinks.map((link) => [link.itemId, link.imageId]), [[a1.id, 100], [a2.id, 100], [b.id, 101]]);
    const report = await applySync(plan, ipod, newEngine, { backup: await backedUp(ipod) });
    assert.deepEqual(report.failures, []);
    assert.equal(report.artwork.images, 2);
    assert.equal(report.artwork.tracks, 3);

    const library = await readIpod(ipod);
    const db = readDb(files(ipod).get(DB));
    assert.deepEqual(db.images.map((image) => [image.id, image.count]), [[100, 2], [101, 1]]);
    assert.equal(db.images[0].songId, BigInt(library.tracks().find((track) => track.title === 'A1').dbid), 'the first track of the image');
    assert.equal(files(ipod).get(thumbPath(1010)).length, 2 * 115200);
    const rows = library.sqlQuery(LIBRARY_ITDB, 'SELECT title, artwork_cache_id FROM item WHERE artwork_cache_id <> 0 ORDER BY title').rows;
    assert.deepEqual(rows.map((row) => [row[0], Number(row[1])]), [['A1', 100], ['A2', 100], ['B', 101]]);
  });

  it('leaves covers off, with a reason, and still puts the music on', async () => {
    // No decoder given.
    let ipod = await artIpod();
    let plan = await planSync(ipod, newEngine, [withCover([1, 2, 3])]);
    assert.equal(plan.artwork, null);
    assert.ok(plan.warnings.some((warning) => /carry album art, which is not written because this sync was not asked to/.test(warning)));

    // A picture the decoder cannot read.
    ipod = await artIpod();
    const broken = makeItem('music');
    broken.info.artwork = { mime: 'image/x-unknown', data: new Uint8Array([1, 2, 3]) };
    plan = await planSync(ipod, newEngine, [broken], options);
    assert.equal(plan.artwork, null);
    assert.equal(plan.files.length, 1);
    assert.ok(plan.warnings.some((warning) => /could not be read as a picture, so it was left off/.test(warning)));

    // A decoder that throws.
    plan = await planSync(ipod, newEngine, [broken], { artwork: { decode: async () => { throw new Error('boom'); } } });
    assert.ok(plan.warnings.some((warning) => /was left off: boom/.test(warning)));

    // An iPod whose own description does not list the formats (the plain demo nano 7G file).
    ipod = await signedIpod();
    plan = await planSync(ipod, newEngine, [withCover([1, 2, 3])], options);
    assert.equal(plan.artwork, null);
    assert.ok(plan.warnings.some((warning) => /left off: The iPod does not list any album art formats/.test(warning)));
    const report = await applySync(plan, ipod, newEngine, { backup: await backedUp(ipod) });
    assert.equal(report.verified, true);
    assert.equal(report.artwork, null);
  });

  it('leaves the ArtworkDB alone when it is not the shape it knows', async () => {
    const ipod = await artIpodWithArt();
    const odd = Uint8Array.from(files(ipod).get(DB));
    new DataView(odd.buffer).setUint32(0x14, 2, true); // two sets, not three
    await putFile(ipod, DB, odd);
    const plan = await planSync(ipod, newEngine, [withCover([1, 2, 3])], options);
    assert.equal(plan.artwork, null);
    assert.ok(plan.warnings.some((warning) => /Album art was left off: The ArtworkDB has 2 sets, not 3/.test(warning)));
    assert.equal(plan.files.length, 1);
  });

  it('stops at the size limit the iPod declares, writes the covers that fit and says which were left off', async () => {
    const ipod = await artIpod({ maxThumbMegabytes: 1 }); // 1,000,000 bytes: eight 115,200 byte thumbnails
    const items = Array.from({ length: 10 }, (_, index) => withCover([index * 20, 5, 5], { title: `T${index}`, album: `A${index}` }));
    const plan = await planSync(ipod, newEngine, items, options);
    assert.equal(plan.artwork.images.length, 8);
    assert.equal(plan.files.length, 10, 'every track still goes on');
    assert.equal(plan.warnings.filter((warning) => /was left off: F1010_1\.ithmb would pass 1 MB/.test(warning)).length, 2);
    const report = await applySync(plan, ipod, newEngine, { backup: await backedUp(ipod) });
    assert.deepEqual(report.failures, []);
    assert.equal(files(ipod).get(thumbPath(1010)).length, 8 * 115200);
  });
});

describe('the engine calls for album art', () => {
  it('give each track a persistent id as text, set and clear the art link, and refuse nonsense', async () => {
    const engine = await newEngine();
    engine.init(MOUNT, 'MA450', 'Test');
    const handle = engine.addTrack('music', { title: 'x' });
    const [track] = engine.tracks();
    assert.match(track.dbid, /^[1-9]\d{0,19}$/);
    assert.equal(engine.canLinkArtwork, true);

    engine.setArtwork(handle, 100, 4321);
    let [after] = engine.tracks();
    assert.deepEqual([after.mhii_link, after.has_artwork, after.artwork_count, after.artwork_size], [100, 1, 1, 4321]);
    engine.clearArtwork(handle);
    [after] = engine.tracks();
    assert.deepEqual([after.mhii_link, after.has_artwork, after.artwork_count, after.artwork_size], [0, 2, 0, 0]);

    assert.throws(() => engine.setArtwork(handle, 0, 1), /whole number from 1 up/);
    assert.throws(() => engine.setArtwork(handle, 1.5, 1), /whole number from 1 up/);
    assert.throws(() => engine.setArtwork(handle, 5000000000, 1), /whole number from 1 up/);
    assert.throws(() => engine.setArtwork(handle, 100, -1), /does not fit/);
    assert.throws(() => engine.setArtwork(999, 100, 1), /Unknown track handle/);
  });
});

describe('when writing album art goes wrong', () => {
  const failing = async (ipod, hooks, existing = false) => {
    const before = snapshot(ipod);
    const backup = await backedUp(ipod);
    const plan = await planSync(ipod, newEngine, [withCover([9, 9, 9])], options);
    const report = await applySync(plan, instrument(ipod, hooks), newEngine, { backup });
    assert.equal(report.verified, false);
    assert.equal(report.rolledBack, true);
    assert.deepEqual(report.rollbackFailures, []);
    assert.deepEqual(snapshot(ipod), before, existing ? 'the old art files are byte for byte as they were' : 'no art file is left behind');
    return report;
  };

  it('puts back every file when the iPod refuses the database after the art was written', async () => {
    const report = await failing(await artIpod(), { open: (path) => (path.endsWith('/iTunesCDB') ? 'refuse' : 'fine') });
    assert.match(report.failures[0], /iTunesCDB could not be written/);
    assert.ok(report.undone.includes(`Put back ${ARTWORK}/F1010_1.ithmb`));
  });

  it('puts back the old thumbnails and ArtworkDB of an iPod that had art', async () => {
    const report = await failing(await artIpodWithArt(), { open: (path) => (path.endsWith('/iTunesCDB') ? 'refuse' : 'fine') }, true);
    assert.ok(report.undone.includes(`Put back ${DB}`));
  });

  it('puts back everything when the ArtworkDB itself cannot be written, after the thumbnails were', async () => {
    const report = await failing(await artIpodWithArt(), { open: (path) => (path === DB ? 'refuse' : 'fine') }, true);
    assert.match(report.failures[0], /ArtworkDB could not be written/);
    assert.deepEqual(report.database.written, [], 'the database was never touched');
  });

  it('puts back everything when a thumbnail does not read back the same', async () => {
    await failing(await artIpod(), { write: (path, index) => (path === thumbPath(1013) && index === 0 ? 'corrupt' : 'fine') });
  });

  it('refuses to write if the ArtworkDB changed after the plan was made, and writes nothing', async () => {
    const ipod = await artIpodWithArt();
    const backup = await backedUp(ipod);
    const plan = await planSync(ipod, newEngine, [withCover([4, 4, 4])], options);
    const changed = Uint8Array.from(files(ipod).get(DB));
    changed[0x30] ^= 1;
    await putFile(ipod, DB, changed);
    const before = snapshot(ipod);
    const report = await applySync(plan, ipod, newEngine, { backup });
    assert.match(report.failures[0], /ArtworkDB on the iPod is not what it was when the plan was made/);
    assert.deepEqual(snapshot(ipod), before);
  });

  it('refuses a plan that would write an art file it should not', async () => {
    const ipod = await artIpod();
    const backup = await backedUp(ipod);
    const plan = await planSync(ipod, newEngine, [withCover([4, 4, 4])], options);
    plan.artwork.thumbFiles[0].path = 'iPod_Control/Artwork/../iTunes/iTunesCDB';
    await assert.rejects(applySync(plan, ipod, newEngine, { backup }), /not one of the album art files/);
  });
});
