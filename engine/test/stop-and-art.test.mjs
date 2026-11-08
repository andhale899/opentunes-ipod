// Stop and pause where they meet album art and the offload restore: a stop while the album art is
// being written rolls the art back with the media, the art phase is its own progress phase (so the
// page may offer Stop there), and putting an offload copy back can be paused between files.
//
// The iPods are in-memory folders written by the real engine. They cannot show what a real nano 7G
// does: only a run on the owner's hardware can. The device identity in them is made up.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PauseGate, ScratchFolder, applySync, mediaPathOf, offloadIpod, planSync, restoreOffload } from '../js/index.ts';
import { decodeRawPicture, rawPicture, sysInfoExtended } from './artwork-helpers.mjs';
import { backedUp, bytesFor, instrument, makeItem, newEngine, putFile, readIpod, signedIpod, snapshot } from './sync-helpers.mjs';

const ARTWORK = 'iPod_Control/Artwork';
const options = { artwork: { decode: decodeRawPicture } };

async function artIpod() {
  const ipod = await signedIpod();
  await putFile(ipod, 'iPod_Control/Device/SysInfoExtended', new TextEncoder().encode(sysInfoExtended('0000000000000001')));
  return ipod;
}

const withCover = (color) => {
  const item = makeItem('music', { tags: { title: 'Stop me', album: 'Album' } });
  item.info.artwork = rawPicture(20, 20, () => [...color, 255]);
  return item;
};

const until = async (condition, ms = 5000) => {
  const limit = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > limit) throw new Error('waited too long');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe('stopping while album art is written', () => {
  it('reports the art writes under their own phase, after the media and before the library', async () => {
    const ipod = await artIpod();
    const backup = await backedUp(ipod);
    const plan = await planSync(ipod, newEngine, [withCover([1, 2, 3])], options);
    const phases = [];
    const report = await applySync(plan, ipod, newEngine, { backup, onProgress: (progress) => phases.push(progress.phase) });
    assert.equal(report.verified, true);
    const order = [...new Set(phases)];
    assert.ok(order.indexOf('copying') < order.indexOf('artwork'), 'media first');
    assert.ok(order.indexOf('artwork') < order.indexOf('database'), 'art before the library');
  });

  it('rolls back the media and every art file already written, byte for byte, and says it was a stop', async () => {
    const ipod = await artIpod();
    const before = snapshot(ipod);
    const backup = await backedUp(ipod);
    const plan = await planSync(ipod, newEngine, [withCover([9, 9, 9])], options);
    const controller = new AbortController();
    let artFiles = 0;
    // Stop once the second art file has been closed: some art is on the iPod, the ArtworkDB is not.
    const watched = instrument(ipod, {
      closed: (path) => {
        if (!path.startsWith(`${ARTWORK}/`)) return;
        artFiles += 1;
        if (artFiles === 2) controller.abort();
      },
    });
    const report = await applySync(plan, watched, newEngine, { backup, signal: controller.signal });
    assert.equal(report.verified, false);
    assert.equal(report.aborted, true, 'a stop, not a failure');
    assert.equal(report.rolledBack, true);
    assert.deepEqual(report.rollbackFailures, []);
    assert.ok(artFiles >= 2, 'art was being written when the stop came');
    assert.equal(report.artwork, null, 'the art is not reported as written');
    assert.deepEqual(report.database.written, [], 'the library was never touched');
    assert.deepEqual(snapshot(ipod), before, 'every file, art included, is as it was');
  });

  it('is not stopped in the art phase when nothing asks for it', async () => {
    const ipod = await artIpod();
    const backup = await backedUp(ipod);
    const plan = await planSync(ipod, newEngine, [withCover([4, 5, 6])], options);
    const report = await applySync(plan, ipod, newEngine, { backup, signal: new AbortController().signal });
    assert.equal(report.verified, true);
    assert.equal(report.aborted, false);
  });
});

describe('pausing the restore of an offload copy', () => {
  async function ipodWithMusic() {
    const ipod = await signedIpod();
    const engine = await readIpod(ipod);
    let seed = 1;
    for (const track of engine.tracks()) {
      await putFile(ipod, mediaPathOf(track.ipod_path), bytesFor(seed, 3000));
      seed += 1;
    }
    return ipod;
  }

  async function wiped() {
    const ipod = await ipodWithMusic();
    const destination = new ScratchFolder('Copy');
    const offload = await offloadIpod(ipod, destination, newEngine, { now: new Date(2026, 10, 7, 18, 4), chunkBytes: 1000 });
    const folder = await destination.getDirectoryHandle(offload.folder);
    const control = await ipod.getDirectoryHandle('iPod_Control');
    for (const name of ['Music', 'iTunes', 'Device']) await control.removeEntry(name);
    return { ipod, folder };
  }

  const countMedia = (ipod) => [...snapshot(ipod).keys()].filter((path) => /^iPod_Control\/Music\/F\d\d\//.test(path)).length;

  it('waits between files while paused, writes nothing more, and carries on after resume', async () => {
    const { ipod, folder } = await wiped();
    const pause = new PauseGate();
    let asked = false;
    const run = restoreOffload(ipod, folder, {
      newEngine,
      concurrency: 1,
      chunkBytes: 1000,
      pause,
      onProgress: (progress) => {
        if (progress.phase === 'copying' && progress.filesDone === 1 && !asked) {
          asked = true;
          pause.request();
        }
      },
    });
    await until(() => pause.state === 'paused');
    const whilePaused = countMedia(ipod);
    assert.ok(whilePaused >= 1, 'a file was copied back before the pause');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(countMedia(ipod), whilePaused, 'nothing more was copied while paused');
    assert.ok(![...snapshot(ipod).keys()].some((path) => path.startsWith('iPod_Control/iTunes')), 'the library was not restored while paused');
    pause.resume();
    const report = await run;
    assert.equal(report.complete, true);
    assert.equal(report.stopped, false);
  });

  it('can be stopped while paused: the library is not touched and a second run finishes', async () => {
    const { ipod, folder } = await wiped();
    const pause = new PauseGate();
    const stop = new AbortController();
    pause.request();
    const run = restoreOffload(ipod, folder, { newEngine, concurrency: 1, chunkBytes: 1000, pause, signal: stop.signal });
    await until(() => pause.state === 'paused');
    stop.abort();
    const report = await run;
    assert.equal(report.stopped, true);
    assert.equal(report.database, null);
    assert.equal(report.complete, false);
    assert.deepEqual(report.failures, [], 'a stop is not a failure');
    const second = await restoreOffload(ipod, folder, { newEngine, chunkBytes: 1000 });
    assert.equal(second.complete, true);
  });
});
