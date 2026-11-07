// Changing what is already on an iPod: removing tracks, editing them, playlists, and cleaning up
// files an interrupted run left behind. All of it goes through the same verified database write
// as a sync, and removal writes the database before it deletes any file.
//
// The iPods are in-memory folders written by the real engine. Smart playlists cannot be made by
// this engine, so the smart-playlist tests mark an ordinary playlist as smart in what the engine
// reports, and show that this code then leaves it alone.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SyncError,
  applyLibraryPlan,
  applyRemoval,
  applySync,
  changePlaylists,
  editTracks,
  findOrphans,
  planEdits,
  planPlaylistChanges,
  planRemoval,
  planSync,
  removeOrphans,
  trackKey,
} from '../js/index.ts';
import { LIBRARY, backedUp, emptyIpod, engines, instrument, makeItem, newEngine, putFile, readIpod, signedIpod, snapshot } from './sync-helpers.mjs';

const MEDIA = /^iPod_Control\/Music\/F\d\d\/[^/]+$/;

/** A nano 7G-style iPod with two synced tracks on it, real files included. */
async function syncedIpod() {
  const ipod = await signedIpod();
  const items = [makeItem('music', { tags: { title: 'Keep me' } }), makeItem('music', { tags: { title: 'Remove me' } })];
  const plan = await planSync(ipod, newEngine, items);
  const report = await applySync(plan, ipod, newEngine, { backup: await backedUp(ipod) });
  assert.equal(report.verified, true);
  const fileOf = (title) => plan.files[items.findIndex((item) => item.info.tags.title === title)];
  return { ipod, fileOf, backup: await backedUp(ipod) };
}

const keyOf = (engine, title) => trackKey(engine.tracks().find((track) => track.title === title));

describe('removing tracks', () => {
  it('writes and checks the database first, then deletes the file', async () => {
    const { ipod, fileOf, backup } = await syncedIpod();
    const gone = fileOf('Remove me');
    const key = keyOf(await readIpod(ipod), 'Remove me');
    const plan = await planRemoval(ipod, newEngine, [key]);
    assert.deepEqual(plan.files, [gone.path]);
    assert.equal(plan.tracks[0].title, 'Remove me');
    assert.ok(plan.database.length > 0);

    const events = [];
    const report = await applyRemoval(plan, instrument(ipod, { log: (event, path) => events.push(`${event} ${path}`) }), newEngine, { backup });
    assert.deepEqual(report.failures, []);
    assert.equal(report.verified, true);
    assert.deepEqual(report.deleted, [gone.path]);
    assert.deepEqual(report.orphans, []);
    const mediaDelete = events.indexOf(`remove ${gone.path}`);
    assert.ok(mediaDelete > 0);
    assert.ok(events.slice(0, mediaDelete).some((event) => event.endsWith('/iTunesCDB')), 'the database was written before');
    assert.deepEqual(events.slice(mediaDelete + 1), [], 'the file was the last thing touched');

    const after = snapshot(ipod);
    assert.ok(!after.has(gone.path));
    assert.ok(after.has(fileOf('Keep me').path));
    const engine = await readIpod(ipod);
    assert.equal(engine.tracks().some((track) => track.title === 'Remove me'), false);
    assert.equal(engine.tracks().length, plan.tracksBefore.length - 1);
  });

  it('reports a file it cannot delete afterwards as left over, not as a failure', async () => {
    const { ipod, fileOf, backup } = await syncedIpod();
    const gone = fileOf('Remove me');
    const plan = await planRemoval(ipod, newEngine, [keyOf(await readIpod(ipod), 'Remove me')]);
    const report = await applyRemoval(plan, instrument(ipod, { remove: (path) => (path === gone.path ? 'refuse' : 'fine') }), newEngine, { backup });
    assert.equal(report.verified, true);
    assert.deepEqual(report.failures, []);
    assert.equal(report.rolledBack, false);
    assert.deepEqual(report.orphans.map((orphan) => orphan.path), [gone.path]);
    assert.match(report.orphans[0].reason, /could not be deleted: the iPod refused/);
    assert.ok(snapshot(ipod).has(gone.path));

    const found = await findOrphans(ipod, newEngine);
    assert.deepEqual(found.orphans.map((orphan) => [orphan.path, orphan.madeByLibgpod]), [[gone.path, true]]);
    const cleaned = await removeOrphans(ipod, newEngine, found.orphans);
    assert.deepEqual(cleaned.removed, [gone.path]);
    assert.ok(!snapshot(ipod).has(gone.path));
  });

  it('puts only the database back when the database write fails, and deletes nothing', async () => {
    const { ipod, backup } = await syncedIpod();
    const before = snapshot(ipod);
    const plan = await planRemoval(ipod, newEngine, [keyOf(await readIpod(ipod), 'Remove me')]);
    const report = await applyRemoval(plan, instrument(ipod, { open: (path) => (path.endsWith('/iTunesCDB') ? 'refuse' : 'fine') }), newEngine, { backup });
    assert.equal(report.rolledBack, true);
    assert.deepEqual(report.rollbackFailures, []);
    assert.deepEqual(report.deleted, []);
    assert.deepEqual(snapshot(ipod), before);
  });

  it('refuses keys that match nothing, and needs a backup', async () => {
    const { ipod, backup } = await syncedIpod();
    await assert.rejects(planRemoval(ipod, newEngine, [':ipod_control:music:f00:nothing.mp3']), (error) => error instanceof SyncError && /No track on the iPod matches/.test(error.message));
    const plan = await planRemoval(ipod, newEngine, [keyOf(await readIpod(ipod), 'Remove me')]);
    await assert.rejects(applyRemoval(plan, ipod, newEngine, { backup: null }), /Back up the iPod first/);
    assert.ok(backup.complete);
  });
});

describe('editing tracks', () => {
  it('changes text and number fields and leaves every other track as it was', async () => {
    const ipod = await signedIpod();
    const backup = await backedUp(ipod);
    const engine = await readIpod(ipod);
    const key = keyOf(engine, 'Night Drive');
    const { plan, report } = await editTracks(ipod, newEngine, [{ key, fields: { title: 'Night Drive (Edit)', year: 2022, rating: 80, comment: 'better' } }], { backup });
    assert.deepEqual(report.failures, []);
    assert.equal(report.verified, true);
    assert.deepEqual(report.signatures.map((check) => check.status), ['matches', 'matches']);

    const after = (await readIpod(ipod)).tracks();
    const edited = after.find((track) => trackKey(track) === key);
    assert.deepEqual([edited.title, edited.year, edited.rating, edited.comment], ['Night Drive (Edit)', 2022, 80, 'better']);
    for (const old of plan.tracksBefore.filter((track) => trackKey(track) !== key)) {
      const now = after.find((track) => trackKey(track) === trackKey(old));
      assert.deepEqual({ ...now, handle: 0, id: 0 }, { ...old, handle: 0, id: 0 }, `${old.title} is unchanged`);
    }
  });

  it('changes a kind, which moves the track into the podcast playlist', async () => {
    const ipod = await signedIpod();
    const backup = await backedUp(ipod);
    const key = keyOf(await readIpod(ipod), 'Night Drive');
    const plan = await planEdits(ipod, newEngine, [{ key, kind: 'podcast' }]);
    const report = await applyLibraryPlan(plan, ipod, newEngine, { backup });
    assert.equal(report.verified, true);
    const engine = await readIpod(ipod);
    const track = engine.tracks().find((candidate) => trackKey(candidate) === key);
    assert.equal(track.kind, 'podcast');
    assert.ok(engine.playlists().find((list) => list.podcasts).tracks.includes(track.handle));
  });

  it('refuses fields that describe the file, fields that do not exist, and missing backups', async () => {
    const ipod = await signedIpod();
    const key = keyOf(await readIpod(ipod), 'Night Drive');
    await assert.rejects(planEdits(ipod, newEngine, [{ key, fields: { size: 1 } }]), /describes the file on the iPod/);
    await assert.rejects(planEdits(ipod, newEngine, [{ key, fields: { ipod_path: 'x' } }]), /not a track field that can be changed/);
    await assert.rejects(editTracks(ipod, newEngine, [{ key, fields: { year: 1 } }], { backup: null }), /Back up the iPod first/);
  });

  it('puts the database back when the write fails', async () => {
    const ipod = await signedIpod();
    const before = snapshot(ipod);
    const backup = await backedUp(ipod);
    const plan = await planEdits(ipod, newEngine, [{ key: keyOf(await readIpod(ipod), 'Night Drive'), fields: { title: 'X' } }]);
    let damaged = false;
    const report = await applyLibraryPlan(plan, instrument(ipod, { write: (path) => (path.endsWith('Library.itdb') && !damaged ? ((damaged = true), 'corrupt') : 'fine') }), newEngine, { backup });
    assert.equal(report.rolledBack, true);
    assert.match(report.failures[0], /Library\.itdb did not match what was written/);
    assert.deepEqual(snapshot(ipod), before);
  });
});

describe('playlists', () => {
  it('creates, renames, adds to, takes out of and deletes playlists, in order', async () => {
    const ipod = await signedIpod();
    const backup = await backedUp(ipod);
    const engine = await readIpod(ipod);
    const morning = keyOf(engine, 'Morning Light');
    const night = keyOf(engine, 'Night Drive');
    const film = keyOf(engine, 'Demo Film');
    const { plan, report } = await changePlaylists(ipod, newEngine, [
      { action: 'create', name: 'Mix', tracks: [night, morning] },
      { action: 'rename', playlist: 'Road trip', name: 'Long drive' },
      { action: 'add', playlist: 'Long drive', tracks: [film] },
      { action: 'remove', playlist: 'Long drive', tracks: [morning] },
      { action: 'create', name: 'Temporary' },
      { action: 'delete', playlist: 'Temporary' },
    ], { backup });
    assert.deepEqual(report.failures, []);
    assert.equal(report.verified, true);
    assert.equal(plan.summary.length, 6);

    const after = await readIpod(ipod);
    const titles = (name) => after.playlists().find((list) => list.name === name).tracks.map((handle) => after.tracks().find((track) => track.handle === handle).title);
    assert.deepEqual(titles('Mix'), ['Night Drive', 'Morning Light']);
    assert.deepEqual(titles('Long drive'), ['Night Drive', 'Demo Film']);
    assert.equal(after.playlists().some((list) => list.name === 'Road trip' || list.name === 'Temporary'), false);
    assert.equal(after.tracks().length, plan.tracksBefore.length, 'no track was added or removed');
  });

  it('adds podcasts to the podcast playlist, and keeps everything else out of it', async () => {
    const ipod = await signedIpod();
    const backup = await backedUp(ipod);
    const synced = makeItem('podcast', { tags: { title: 'New episode' }, playlists: ['Podcasts', 'Commute'] });
    const plan = await planSync(ipod, newEngine, [synced]);
    assert.deepEqual(plan.warnings.filter((warning) => /playlist/.test(warning)), []);
    assert.deepEqual(plan.playlists.map((use) => [use.name, use.created]), [['Podcasts', false], ['Commute', true]]);
    assert.equal((await applySync(plan, ipod, newEngine, { backup })).verified, true);

    let engine = await readIpod(ipod);
    const episode = engine.tracks().find((track) => track.title === 'New episode');
    assert.ok(engine.playlists().find((list) => list.podcasts).tracks.includes(episode.handle));
    assert.ok(engine.playlists().find((list) => list.name === 'Commute').tracks.includes(episode.handle));

    const old = keyOf(engine, 'Episode 12: Engines');
    const song = keyOf(engine, 'Morning Light');
    const { report } = await changePlaylists(ipod, newEngine, [{ action: 'add', playlist: 'Podcasts', tracks: [old] }, { action: 'add', playlist: 'Commute', tracks: [old] }], { backup: await backedUp(ipod) });
    assert.equal(report.verified, true);
    engine = await readIpod(ipod);
    assert.equal(engine.playlists().find((list) => list.name === 'Commute').tracks.length, 2);

    await assert.rejects(planPlaylistChanges(ipod, newEngine, [{ action: 'add', playlist: 'Podcasts', tracks: [song] }]), /only holds podcasts/);
    await assert.rejects(planPlaylistChanges(ipod, newEngine, [{ action: 'remove', playlist: 'Podcasts', tracks: [old] }]), /follows the tracks' kinds/);
    await assert.rejects(planPlaylistChanges(ipod, newEngine, [{ action: 'delete', playlist: 'Podcasts' }]), /cannot be deleted/);
    const music = makeItem('music', { tags: { title: 'Not a podcast' }, playlists: ['Podcasts'] });
    const refused = await planSync(ipod, newEngine, [music]);
    assert.match(refused.warnings.find((warning) => /podcast playlist/.test(warning)), /only holds podcasts/);
  });

  it('finds the podcast playlist a new podcast makes, instead of making a second list with its name', async () => {
    const ipod = await emptyIpod();
    const backup = await backedUp(ipod);
    const first = makeItem('podcast', { tags: { title: 'First episode' } });
    const second = makeItem('podcast', { tags: { title: 'Second episode' }, playlists: ['Podcasts'] });
    const plan = await planSync(ipod, newEngine, [first, second]);
    assert.deepEqual(plan.playlists.map((use) => [use.name, use.created]), [['Podcasts', false]]);
    assert.equal((await applySync(plan, ipod, newEngine, { backup })).verified, true);
    const lists = (await readIpod(ipod)).playlists();
    assert.equal(lists.filter((list) => list.name === 'Podcasts').length, 1);
    assert.equal(lists.find((list) => list.podcasts).tracks.length, 2);
  });

  it('refuses names that are taken or unclear, and the master playlist', async () => {
    const ipod = await signedIpod();
    await assert.rejects(planPlaylistChanges(ipod, newEngine, [{ action: 'create', name: 'Road trip' }]), /already a playlist called "Road trip"/);
    await assert.rejects(planPlaylistChanges(ipod, newEngine, [{ action: 'add', playlist: 'Nope', tracks: [] }]), /no playlist called "Nope"/);
    await assert.rejects(planPlaylistChanges(ipod, newEngine, [{ action: 'create', name: 'Twin' }, { action: 'rename', playlist: 'Road trip', name: 'Twin' }]), /already a playlist called "Twin"/);
    await assert.rejects(planPlaylistChanges(ipod, newEngine, [{ action: 'delete', playlist: 'Demo nano 7G' }]), /master playlist/);
    const renamed = await planPlaylistChanges(ipod, newEngine, [{ action: 'rename', playlist: 'Demo nano 7G', name: 'My nano' }]);
    assert.deepEqual(renamed.summary, ['Rename the iPod to "My nano".']);
  });

  it('never changes a smart playlist', async () => {
    const ipod = await signedIpod();
    const backup = await backedUp(ipod);
    // This engine cannot make smart playlists, so "Road trip" is reported as one.
    const factory = engines((engine) => {
      const real = engine.playlists.bind(engine);
      engine.playlists = () => real().map((list) => (list.name === 'Road trip' ? { ...list, smart: true } : list));
    });
    const key = keyOf(await readIpod(ipod), 'Demo Film');
    for (const change of [
      { action: 'add', playlist: 'Road trip', tracks: [key] },
      { action: 'remove', playlist: 'Road trip', tracks: [key] },
      { action: 'rename', playlist: 'Road trip', name: 'Other' },
      { action: 'delete', playlist: 'Road trip' },
    ]) {
      await assert.rejects(planPlaylistChanges(ipod, factory, [change]), /is a smart playlist\. The iPod fills it by its own rules/);
    }

    const item = makeItem('music', { tags: { title: 'Into a smart list' }, playlists: ['Road trip'] });
    const plan = await planSync(ipod, factory, [item]);
    assert.match(plan.warnings.find((warning) => /smart/.test(warning)), /"Road trip" is a smart playlist/);
    assert.deepEqual(plan.playlists, []);
    const report = await applySync(plan, ipod, factory, { backup });
    assert.equal(report.verified, true);
    const engine = await readIpod(ipod);
    assert.equal(engine.playlists().find((list) => list.name === 'Road trip').tracks.length, 2, 'it holds what it held');
  });
});

describe('left-over files', () => {
  it('finds files the library does not list, and removes only those, after checking again', async () => {
    const ipod = await signedIpod();
    const listed = [...snapshot(ipod).keys()].filter((path) => MEDIA.test(path));
    assert.equal(listed.length, 5, 'the demo tracks have files');
    await putFile(ipod, 'iPod_Control/Music/F05/libgpod111111.mp3', new Uint8Array(10));
    await putFile(ipod, 'iPod_Control/Music/F06/ABCD.m4a', new Uint8Array(20));
    await putFile(ipod, 'iPod_Control/Music/F05/._libgpod111111.mp3', new Uint8Array(4));
    await putFile(ipod, 'iPod_Control/Music/F07/libgpod222222.mp3', new Uint8Array(30));

    const found = await findOrphans(ipod, newEngine);
    const byPath = Object.fromEntries(found.orphans.map((orphan) => [orphan.path, orphan]));
    assert.deepEqual(Object.keys(byPath).sort(), ['iPod_Control/Music/F05/libgpod111111.mp3', 'iPod_Control/Music/F06/ABCD.m4a', 'iPod_Control/Music/F07/libgpod222222.mp3']);
    assert.deepEqual([byPath['iPod_Control/Music/F05/libgpod111111.mp3'].size, byPath['iPod_Control/Music/F05/libgpod111111.mp3'].madeByLibgpod], [10, true]);
    assert.equal(byPath['iPod_Control/Music/F06/ABCD.m4a'].madeByLibgpod, false);
    assert.equal(found.referenced, 5);
    assert.deepEqual(found.missingFiles, []);

    // The file grows after it was found, so it is no longer the same file.
    await putFile(ipod, 'iPod_Control/Music/F07/libgpod222222.mp3', new Uint8Array(31));
    const sneaky = [
      ...found.orphans,
      { path: listed[0], size: snapshot(ipod).get(listed[0]).length, madeByLibgpod: true },
      { path: `${LIBRARY}/Library.itdb`, size: null, madeByLibgpod: false },
      { path: 'iPod_Control/Music/F05/._libgpod111111.mp3', size: 4, madeByLibgpod: false },
    ];
    const result = await removeOrphans(ipod, newEngine, sneaky);
    assert.deepEqual(result.removed.sort(), ['iPod_Control/Music/F05/libgpod111111.mp3', 'iPod_Control/Music/F06/ABCD.m4a']);
    const kept = Object.fromEntries(result.kept.map((entry) => [entry.path, entry.reason]));
    assert.match(kept[listed[0]], /library lists this file/);
    assert.match(kept[`${LIBRARY}/Library.itdb`], /not a media file directly inside a Music\/Fxx folder/);
    assert.match(kept['iPod_Control/Music/F05/._libgpod111111.mp3'], /not a media file/);
    assert.match(kept['iPod_Control/Music/F07/libgpod222222.mp3'], /31 bytes now and was 30/);

    const after = snapshot(ipod);
    for (const path of listed) assert.ok(after.has(path), `${path} the library lists is still there`);
    assert.ok(after.has('iPod_Control/Music/F05/._libgpod111111.mp3'));
    assert.ok(after.has(`${LIBRARY}/Library.itdb`));
  });

  it('lists tracks whose file is missing', async () => {
    const ipod = await signedIpod();
    const engine = await readIpod(ipod);
    const track = engine.tracks()[0];
    const parts = track.ipod_path.split(':').filter(Boolean);
    const folder = await (await (await ipod.getDirectoryHandle('iPod_Control')).getDirectoryHandle('Music')).getDirectoryHandle(parts[2]);
    await folder.removeEntry(parts[3]);
    const found = await findOrphans(ipod, newEngine);
    assert.deepEqual(found.missingFiles, [track.ipod_path]);
    assert.deepEqual(found.orphans, []);
  });
});
