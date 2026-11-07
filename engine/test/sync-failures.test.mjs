// When a sync goes wrong: every failure, and a stop, must leave the iPod byte for byte as it
// was before the run. Also the checks that keep a sync from starting at all: no backup, an iPod
// that changed after planning, name clashes, too little space and duplicates.
//
// The iPods are in-memory folders written by the real engine. A wrapper refuses or damages
// chosen writes. These tests show the rollback logic; they cannot show how a real USB disk
// fails.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EngineError, SPACE_RESERVE_BYTES, SyncError, applySync, planSync, trackKey } from '../js/index.ts';
import { ITUNES, LIBRARY, MOUNT, backedUp, engines, folderOf, instrument, makeItem, newEngine, putFile, signedIpod, snapshot, writeFile } from './sync-helpers.mjs';

const MEDIA = /^iPod_Control\/Music\/F\d\d\/[^/]+$/;

/** Plans three music files of 3000 bytes each on a fresh nano 7G-style iPod with a backup. */
async function prepared(factory = newEngine, items = [makeItem('music'), makeItem('music'), makeItem('music')]) {
  const ipod = await signedIpod();
  const before = snapshot(ipod);
  const backup = await backedUp(ipod);
  const plan = await planSync(ipod, factory, items);
  return { ipod, before, backup, plan, items };
}

function assertRolledBack(report, ipod, before) {
  assert.equal(report.verified, false);
  assert.equal(report.rolledBack, true);
  assert.deepEqual(report.rollbackFailures, []);
  assert.equal(report.restoreNeeded, false);
  assert.deepEqual(snapshot(ipod), before, 'the iPod is byte for byte as it was');
}

describe('a sync that fails rolls everything back', () => {
  it('when the iPod refuses a media write (disk full)', async () => {
    const { ipod, before, backup, plan } = await prepared();
    const target = plan.files[2].path;
    const report = await applySync(plan, instrument(ipod, { write: (path, index) => (path === target && index === 1 ? 'refuse' : 'fine') }), newEngine, { backup, chunkBytes: 1000, concurrency: 1 });
    assert.match(report.failures[0], new RegExp(`${target.replaceAll('/', '\\/')} could not be copied: the disk is full`));
    assert.equal(report.copied.length, 2, 'two files had been copied before it failed');
    assert.deepEqual(report.database.written, [], 'the database was not touched');
    assert.ok(plan.files.every((file) => report.undone.includes(`Deleted ${file.path}`)), 'every file this run made was deleted, the half-written one too');
    assertRolledBack(report, ipod, before);
  });

  it('when a media file does not read back the same', async () => {
    const { ipod, before, backup, plan } = await prepared();
    const target = plan.files[1].path;
    const report = await applySync(plan, instrument(ipod, { write: (path, index) => (path === target && index === 0 ? 'corrupt' : 'fine') }), newEngine, { backup, chunkBytes: 1000 });
    assert.match(report.failures[0], /did not match the original when it was read back from the iPod \(bytes 0 to 1000\)/);
    assertRolledBack(report, ipod, before);
  });

  it('when the iPod refuses a database write, after every media file was copied', async () => {
    const { ipod, before, backup, plan } = await prepared();
    const report = await applySync(plan, instrument(ipod, { open: (path) => (path.endsWith('/iTunesCDB') ? 'refuse' : 'fine') }), newEngine, { backup });
    assert.match(report.failures[0], /iTunesCDB could not be written: the disk is full/);
    assert.equal(report.copied.length, 3);
    assert.ok(report.database.written.length > 0, 'other database files had been written before it failed');
    assert.ok(report.undone.includes(`Put back ${LIBRARY}/Library.itdb`));
    assert.ok(plan.files.every((file) => report.undone.includes(`Deleted ${file.path}`)));
    assertRolledBack(report, ipod, before);
  });

  it('when the iPod cannot be read back afterwards', async () => {
    const factory = engines((engine, made) => {
      if (made === 2) {
        engine.open = () => {
          throw new EngineError('simulated read-back failure');
        };
      }
    });
    const { ipod, before, backup, plan } = await prepared(factory);
    const report = await applySync(plan, ipod, factory, { backup });
    assert.match(report.failures[0], /could not be read back after the write: simulated read-back failure/);
    assert.equal(report.database.written.length, plan.database.filter((change) => change.kind !== 'removed').length, 'the whole database had been written');
    assertRolledBack(report, ipod, before);
  });

  it('when the library reads back different from the plan', async () => {
    const { ipod, before, backup, plan } = await prepared();
    plan.files[0].kind = 'podcast'; // what the read-back is checked against
    const report = await applySync(plan, ipod, newEngine, { backup });
    assert.match(report.failures[0], /reads back as music and should be podcast/);
    assertRolledBack(report, ipod, before);
  });

  it('when a track the iPod had before does not read back as it was', async () => {
    const { ipod, before, backup, plan } = await prepared();
    plan.tracksBefore[0] = { ...plan.tracksBefore[0], rating: 99 }; // what the old tracks are checked against
    const report = await applySync(plan, ipod, newEngine, { backup });
    assert.match(report.failures[0], /Tracks the iPod had before read back changed: field "rating"/);
    assertRolledBack(report, ipod, before);
  });

  it('when it is stopped in the middle of copying', async () => {
    const { ipod, before, backup, plan } = await prepared();
    const stop = new AbortController();
    const pieces = new Map();
    const watched = instrument(ipod, { write: (path) => void pieces.set(path, (pieces.get(path) ?? 0) + 1) });
    const report = await applySync(plan, watched, newEngine, {
      backup,
      chunkBytes: 1000,
      concurrency: 1,
      signal: stop.signal,
      onProgress: (event) => {
        if (event.phase === 'copying' && event.bytesDone >= 4000) stop.abort();
      },
    });
    assert.equal(report.aborted, true);
    assert.equal(report.failures[0], 'The run was stopped before it finished.');
    assert.equal(report.copied.length, 1, 'one file was finished before the stop');
    assert.equal(pieces.get(plan.files[1].path), 1, 'the second file stopped after the piece being written when the stop came');
    assert.equal(pieces.has(plan.files[2].path), false, 'the third file was never started');
    assertRolledBack(report, ipod, before);
  });

  it('when it is stopped while the database is being written', async () => {
    const { ipod, before, backup, plan } = await prepared();
    const stop = new AbortController();
    const report = await applySync(plan, ipod, newEngine, { backup, signal: stop.signal, onProgress: (event) => event.phase === 'database' && stop.abort() });
    assert.equal(report.aborted, true);
    assert.equal(report.copied.length, 3);
    assert.equal(report.database.written.length, 1, 'one database file was written before the stop was seen');
    assertRolledBack(report, ipod, before);
  });

  it('when it is stopped while the iPod is being read back', async () => {
    const { ipod, before, backup, plan } = await prepared();
    const stop = new AbortController();
    const report = await applySync(plan, ipod, newEngine, { backup, signal: stop.signal, onProgress: (event) => event.phase === 'verifying' && stop.abort() });
    assert.equal(report.aborted, true);
    assertRolledBack(report, ipod, before);
  });

  it('does nothing when it is stopped before it starts', async () => {
    const { ipod, before, backup, plan } = await prepared();
    const report = await applySync(plan, ipod, newEngine, { backup, signal: AbortSignal.abort() });
    assert.equal(report.aborted, true);
    assert.equal(report.rolledBack, false);
    assert.match(report.failures[0], /stopped before anything was written/);
    assert.deepEqual(snapshot(ipod), before);
  });

  it('says loudly when the rollback itself cannot undo everything', async () => {
    const { ipod, backup, plan } = await prepared();
    const target = plan.files[0].path;
    const report = await applySync(plan, instrument(ipod, {
      write: (path) => (path === plan.files[2].path ? 'corrupt' : 'fine'),
      remove: (path) => (path === target ? 'refuse' : 'fine'),
    }), newEngine, { backup, concurrency: 1 });
    assert.equal(report.rolledBack, true);
    assert.equal(report.restoreNeeded, true);
    assert.deepEqual(report.rollbackFailures, [`${target} was copied by this run and could not be deleted.`]);
    assert.match(report.failures.at(-1), /Not everything could be put back\. Do not use the iPod as it is: restore the backup/);
  });

  it('makes a missing music folder, and removes it again when it rolls back', async () => {
    for (const fails of [false, true]) {
      const ipod = await signedIpod();
      // Empty the music folders, so the planned one can be taken away after planning.
      const music = await folderOf(ipod, 'iPod_Control/Music');
      for await (const [name, folder] of music.entries()) for await (const [file] of folder.entries()) await folder.removeEntry(file);
      const before = snapshot(ipod);
      const backup = await backedUp(ipod);
      const plan = await planSync(ipod, newEngine, [makeItem('music')]);
      const folderName = plan.files[0].path.split('/')[2];
      await music.removeEntry(folderName);

      const root = fails ? instrument(ipod, { open: (path) => (path.endsWith('/iTunesCDB') ? 'refuse' : 'fine') }) : ipod;
      const report = await applySync(plan, root, newEngine, { backup });
      if (fails) {
        assertRolledBack(report, ipod, before);
        assert.ok(report.undone.includes(`Removed the empty folder iPod_Control/Music/${folderName}`));
        await assert.rejects(music.getDirectoryHandle(folderName), /was not found/);
      } else {
        assert.equal(report.verified, true);
        assert.ok(snapshot(ipod).has(plan.files[0].path));
      }
    }
  });
});

describe('what stops a sync before it writes anything', () => {
  it('will not write without a complete backup from this session', async () => {
    const { ipod, before, backup, plan } = await prepared();
    for (const bad of [null, { ...backup, complete: false }, { ...backup, failures: ['x'] }]) {
      await assert.rejects(applySync(plan, ipod, newEngine, { backup: bad }), (error) => error instanceof SyncError && /Back up the iPod first/.test(error.message));
    }
    assert.deepEqual(snapshot(ipod), before);
  });

  it('stops if a database file changed after the plan was made', async () => {
    const { ipod, backup, plan } = await prepared();
    await writeFile(await folderOf(ipod, LIBRARY), 'Library.itdb', new Uint8Array(100).fill(9));
    const changed = snapshot(ipod);
    const report = await applySync(plan, ipod, newEngine, { backup });
    assert.match(report.failures[0], /Library\.itdb on the iPod is not what it was when the plan was made, so nothing was written/);
    assert.equal(report.rolledBack, false);
    assert.deepEqual(report.copied, []);
    assert.deepEqual(snapshot(ipod), changed);
  });

  it('stops if a database file appeared after the plan was made', async () => {
    const { ipod, backup, plan } = await prepared();
    await putFile(ipod, `${ITUNES}/OTGPlaylistInfo`, new Uint8Array(8));
    const changed = snapshot(ipod);
    const report = await applySync(plan, ipod, newEngine, { backup });
    assert.match(report.failures[0], /OTGPlaylistInfo appeared on the iPod after the plan was made/);
    assert.deepEqual(snapshot(ipod), changed);
  });

  it('never writes over a file that appeared at a planned place after planning', async () => {
    const { ipod, backup, plan } = await prepared();
    const theirs = new TextEncoder().encode('not ours');
    await putFile(ipod, plan.files[1].path.toUpperCase().replace('IPOD_CONTROL/MUSIC', 'iPod_Control/Music'), theirs);
    const changed = snapshot(ipod);
    const report = await applySync(plan, ipod, newEngine, { backup });
    assert.match(report.failures[0], /is already on the iPod, so nothing was written and nothing was overwritten/);
    assert.deepEqual(snapshot(ipod), changed, 'their file is still there and nothing else changed');
  });
});

describe('file names', () => {
  it('never picks the name of a file already on the iPod, even when libgpod offers it', async () => {
    const ipod = await signedIpod();
    const theirs = 'iPod_Control/Music/F03/libgpod424242.mp3';
    const theirBytes = new TextEncoder().encode('a file iTunes put there');
    await putFile(ipod, theirs, theirBytes);
    let offered = 0;
    let standInSeen = false;
    const factory = engines((engine) => {
      const real = engine.destPath.bind(engine);
      engine.destPath = (name) => {
        offered += 1;
        if (offered === 1) {
          standInSeen = engine.fs.analyzePath(`${MOUNT}/${theirs}`).exists;
          return `${MOUNT}/${theirs}`;
        }
        if (offered === 2) return `${MOUNT}/iPod_Control/Music/F03/LIBGPOD424242.MP3`; // the same file to a FAT disk
        return real(name);
      };
    });
    const backup = await backedUp(ipod);
    const plan = await planSync(ipod, factory, [makeItem('music')]);
    assert.ok(standInSeen, 'the engine was given a stand-in for the file, so libgpod sees it too');
    assert.ok(offered >= 3);
    assert.notEqual(plan.files[0].path.toLowerCase(), theirs.toLowerCase());

    const report = await applySync(plan, ipod, newEngine, { backup });
    assert.equal(report.verified, true);
    assert.deepEqual(snapshot(ipod).get(theirs), theirBytes, 'their file is untouched');
  });

  it('never gives two new files the same name', async () => {
    const ipod = await signedIpod();
    let offered = 0;
    const factory = engines((engine) => {
      const real = engine.destPath.bind(engine);
      engine.destPath = (name) => (++offered <= 2 ? `${MOUNT}/iPod_Control/Music/F07/libgpod101010.mp3` : real(name));
    });
    const plan = await planSync(ipod, factory, [makeItem('music'), makeItem('music')]);
    assert.equal(plan.files[0].path, 'iPod_Control/Music/F07/libgpod101010.mp3');
    assert.notEqual(plan.files[1].path, plan.files[0].path);
  });

  it('refuses a place outside the music folders', async () => {
    const ipod = await signedIpod();
    const factory = engines((engine) => {
      engine.destPath = () => `${MOUNT}/iPod_Control/iTunes/iTunesCDB`;
    });
    await assert.rejects(planSync(ipod, factory, [makeItem('music')]), (error) => error instanceof SyncError && /not inside a Music\/Fxx folder/.test(error.message));
  });
});

describe('space', () => {
  it('refuses with a plain message when the files will not fit', async () => {
    const ipod = await signedIpod();
    const before = snapshot(ipod);
    const items = [makeItem('music', { size: 5000 }), makeItem('movie', { size: 7000 })];
    const probe = await planSync(ipod, newEngine, items);
    const tight = probe.space.usedBytes + 12_000 + SPACE_RESERVE_BYTES - 1;
    await assert.rejects(planSync(ipod, newEngine, items, { capacityBytes: tight }), (error) => error instanceof SyncError && /These files need 12 KB and the iPod has about .* free .*Nothing was written\. Choose fewer files\./.test(error.message));
    assert.deepEqual(snapshot(ipod), before);

    const roomy = await planSync(ipod, newEngine, items, { capacityBytes: tight + 1 });
    assert.equal(roomy.space.fits, true);
    assert.equal(roomy.space.newBytes, 12_000);
    assert.equal(roomy.space.usedBytes, probe.tracksBefore.reduce((sum, track) => sum + track.size, 0));
    assert.ok(!roomy.warnings.some((warning) => /free space/.test(warning)));
    assert.equal(probe.space.fits, null);
    assert.match(probe.warnings[0], /free space was not checked/);
  });
});

describe('duplicates', () => {
  // The demo iPod holds "Morning Light" by The Demo Band, on Samples, 214 seconds long.
  const morningLight = (overrides = {}) => makeItem('music', { tags: { title: 'Morning Light', artist: 'The Demo Band', album: 'Samples' }, durationMs: 215_500, ...overrides });

  it('skips a track already on the iPod, and says which one it matches', async () => {
    const ipod = await signedIpod();
    const item = morningLight();
    const plan = await planSync(ipod, newEngine, [item, makeItem('music')]);
    const existing = plan.tracksBefore.find((track) => track.title === 'Morning Light');
    assert.deepEqual(plan.duplicates, [{ itemId: item.id, trackKey: trackKey(existing), otherItemId: null, skipped: true }]);
    assert.match(plan.skipped.find((skip) => skip.itemId === item.id).reason, /already on the iPod/);
    assert.equal(plan.files.length, 1);
  });

  it('matches through case, accents, punctuation and spacing, and only within 2 seconds and the same kind', async () => {
    const ipod = await signedIpod();
    const loose = morningLight({ tags: { title: '  mórning   LIGHT! ', artist: 'the demo band', album: 'SAMPLES' } });
    const longer = morningLight({ durationMs: 217_000 });
    const podcast = makeItem('podcast', { tags: { title: 'Morning Light', artist: 'The Demo Band', album: 'Samples' }, durationMs: 214_000 });
    const plan = await planSync(ipod, newEngine, [loose, longer, podcast]);
    assert.deepEqual(plan.duplicates.map((found) => found.itemId), [loose.id]);
    assert.deepEqual(plan.files.map((file) => file.itemId), [longer.id, podcast.id]);
  });

  it('catches the same file twice in one sync', async () => {
    const ipod = await signedIpod();
    const first = makeItem('music', { tags: { title: 'Twice' } });
    const second = makeItem('music', { tags: { title: 'Twice' } });
    const plan = await planSync(ipod, newEngine, [first, second]);
    assert.deepEqual(plan.duplicates, [{ itemId: second.id, trackKey: null, otherItemId: first.id, skipped: true }]);
    assert.deepEqual(plan.files.map((file) => file.itemId), [first.id]);
  });

  it('adds duplicates when told to, and still reports them', async () => {
    const ipod = await signedIpod();
    const backup = await backedUp(ipod);
    const item = morningLight();
    const plan = await planSync(ipod, newEngine, [item], { duplicates: 'allow' });
    assert.equal(plan.duplicates[0].skipped, false);
    assert.deepEqual(plan.skipped, []);
    const report = await applySync(plan, ipod, newEngine, { backup });
    assert.equal(report.verified, true);
    assert.equal(plan.expectedTracks.filter((track) => track.title === 'Morning Light').length, 2);
  });

  it('has nothing to do when every item is skipped, and writes nothing', async () => {
    const ipod = await signedIpod();
    const before = snapshot(ipod);
    const backup = await backedUp(ipod);
    const plan = await planSync(ipod, newEngine, [morningLight()]);
    assert.deepEqual(plan.files, []);
    assert.deepEqual(plan.database, []);
    const report = await applySync(plan, ipod, newEngine, { backup });
    assert.deepEqual(report.copied, []);
    assert.deepEqual(report.failures, []);
    assert.deepEqual(snapshot(ipod), before);
  });
});

describe('the media files a rollback deletes', () => {
  it('are only ever the ones this run created', async () => {
    const { ipod, backup, plan } = await prepared();
    const created = [];
    const removed = [];
    const report = await applySync(plan, instrument(ipod, {
      opened: (path) => MEDIA.test(path) && created.push(path),
      log: (event, path) => event === 'remove' && MEDIA.test(path) && removed.push(path),
      open: (path) => (path.endsWith('/iTunesCDB') ? 'refuse' : 'fine'),
    }), newEngine, { backup });
    assert.equal(report.rolledBack, true);
    assert.deepEqual([...removed].sort(), [...created].sort());
  });
});
