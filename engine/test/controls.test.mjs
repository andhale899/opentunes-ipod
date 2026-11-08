// Stop and pause: which engine functions can be stopped, what a stop leaves behind, and how a
// pause waits between files. The iPods are in-memory folders written by the real engine, so these
// tests show the logic. They cannot show how a real iPod behaves when it is stopped.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PauseGate,
  ScratchFolder,
  WriteBackError,
  applySync,
  backupIpod,
  describeBackup,
  findOrphans,
  loadIpodFolder,
  mediaPathOf,
  offloadIpod,
  planEdits,
  planRemoval,
  planSync,
  planWriteBack,
  restoreBackup,
  trackKey,
} from '../js/index.ts';
import { MOUNT, newEngine } from './helpers.mjs';
import { backedUp, bytesFor, makeItem, putFile, readIpod, signedIpod, snapshot } from './sync-helpers.mjs';

const NOW = new Date(2026, 10, 7, 18, 4);
const isAbort = (error) => error instanceof DOMException && error.name === 'AbortError';
const nextTick = () => new Promise((resolve) => setTimeout(resolve, 0));
const until = async (condition) => {
  for (let i = 0; i < 400 && !condition(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
};
const mediaIn = (destination) => [...destination.listFiles().keys()].filter((path) => /\/F\d\d\//.test(path)).length;

describe('PauseGate', () => {
  it('lets workers through while nobody asked for a pause', async () => {
    const gate = new PauseGate();
    gate.join();
    await gate.checkpoint();
    assert.equal(gate.state, 'running');
  });

  it('says pausing until every worker waits, then paused, and running again after resume', async () => {
    const gate = new PauseGate();
    const seen = [];
    gate.subscribe(() => seen.push(gate.state));
    gate.join();
    gate.join();
    gate.request();
    assert.equal(gate.state, 'pausing');
    let released = 0;
    const first = gate.checkpoint().then(() => (released += 1));
    await nextTick();
    assert.equal(gate.state, 'pausing', 'one of two workers is still on a file');
    const second = gate.checkpoint().then(() => (released += 1));
    await nextTick();
    assert.equal(gate.state, 'paused');
    assert.equal(released, 0);
    gate.resume();
    await Promise.all([first, second]);
    assert.equal(released, 2);
    assert.equal(gate.state, 'running');
    assert.ok(seen.includes('paused'));
  });

  it('releases a waiting worker when the job is stopped', async () => {
    const gate = new PauseGate();
    const stop = new AbortController();
    gate.join();
    gate.request();
    const waiting = gate.checkpoint(stop.signal);
    await nextTick();
    assert.equal(gate.state, 'paused');
    stop.abort();
    await waiting;
  });

  it('counts a worker that has finished, so the rest can still be paused', async () => {
    const gate = new PauseGate();
    gate.join();
    gate.join();
    gate.request();
    void gate.checkpoint();
    await nextTick();
    assert.equal(gate.state, 'pausing');
    gate.leave();
    assert.equal(gate.state, 'paused');
    gate.resume();
  });
});

describe('stopping a read', () => {
  it('stops reading the iPod with an AbortError, and the iPod is untouched', async () => {
    const ipod = await signedIpod();
    const before = snapshot(ipod);
    await assert.rejects(loadIpodFolder(ipod, await newEngine(), { mount: MOUNT, signal: AbortSignal.abort() }), isAbort);
    assert.deepEqual(snapshot(ipod), before);
  });

  it('stops planning a sync at the start and half way through, and writes nothing', async () => {
    const ipod = await signedIpod();
    const before = snapshot(ipod);
    await assert.rejects(planSync(ipod, newEngine, [makeItem('music')], { signal: AbortSignal.abort() }), isAbort);
    const stop = new AbortController();
    await assert.rejects(planSync(ipod, newEngine, [makeItem('music')], { signal: stop.signal, onProgress: (message) => message.startsWith('Listing') && stop.abort() }), isAbort);
    assert.deepEqual(snapshot(ipod), before);
  });

  it('stops planning a removal, an edit and a write-back', async () => {
    const ipod = await signedIpod();
    const tracks = (await readIpod(ipod)).tracks();
    const before = snapshot(ipod);
    await assert.rejects(planRemoval(ipod, newEngine, [trackKey(tracks[0])], { signal: AbortSignal.abort() }), isAbort);
    await assert.rejects(planEdits(ipod, newEngine, [{ key: trackKey(tracks[0]), fields: { title: 'x' } }], { signal: AbortSignal.abort() }), isAbort);
    await assert.rejects(planWriteBack(ipod, newEngine, { signal: AbortSignal.abort() }), isAbort);
    assert.deepEqual(snapshot(ipod), before);
  });

  it('stops the search for leftover files', async () => {
    const ipod = await signedIpod();
    await assert.rejects(findOrphans(ipod, newEngine, { signal: AbortSignal.abort() }), isAbort);
    const stop = new AbortController();
    await assert.rejects(findOrphans(ipod, newEngine, { signal: stop.signal, onProgress: (message) => message.startsWith('Listing') && stop.abort() }), isAbort);
    const report = await findOrphans(ipod, newEngine);
    assert.ok(Array.isArray(report.orphans), 'without a stop it still works');
  });
});

describe('stopping a backup', () => {
  it('stops between files, marks the folder incomplete, and a restore refuses it', async () => {
    const ipod = await signedIpod();
    const destination = new ScratchFolder('Backups');
    const stop = new AbortController();
    let copied = 0;
    const report = await backupIpod(ipod, destination, {
      now: NOW,
      signal: stop.signal,
      onProgress: () => {
        copied += 1;
        if (copied === 2) stop.abort();
      },
    });
    assert.equal(report.stopped, true);
    assert.equal(report.complete, false);
    assert.match(report.failures[0], /stopped before it finished/);
    assert.ok(report.verified < report.files, 'some files were not copied');
    const folder = await destination.getDirectoryHandle(report.folder);
    const info = JSON.parse(new TextDecoder().decode(folder.listFiles().get('backup-info.json')));
    assert.equal(info.complete, false);
    await assert.rejects(describeBackup(folder), (error) => error instanceof WriteBackError && /not complete/.test(error.message));
  });

  it('reports a normal backup as not stopped', async () => {
    const backup = await backedUp(await signedIpod());
    assert.equal(backup.stopped, false);
  });
});

describe('stopping a restore', () => {
  async function backedUpIpod() {
    const ipod = await signedIpod();
    const destination = new ScratchFolder('Backups');
    const report = await backupIpod(ipod, destination, { now: NOW });
    return { ipod, folder: await destination.getDirectoryHandle(report.folder) };
  }

  it('stops while the backup is being checked, before anything is written', async () => {
    const { ipod, folder } = await backedUpIpod();
    // Damage the iPod's copy so a restore would change it, then stop before that happens.
    await putFile(ipod, 'iPod_Control/iTunes/iTunesCDB', new Uint8Array(10));
    const before = snapshot(ipod);
    const stop = new AbortController();
    const phases = [];
    await assert.rejects(
      restoreBackup(ipod, folder, {
        signal: stop.signal,
        onProgress: (message, phase) => {
          phases.push(phase);
          stop.abort();
        },
      }),
      isAbort,
    );
    assert.deepEqual(phases, ['checking']);
    assert.deepEqual(snapshot(ipod), before, 'nothing was written');
  });

  it('ignores a stop once it is writing, so the iPod is never left with a mix of old and restored files', async () => {
    const { ipod, folder } = await backedUpIpod();
    await putFile(ipod, 'iPod_Control/iTunes/iTunesCDB', new Uint8Array(10));
    const stop = new AbortController();
    const phases = [];
    const report = await restoreBackup(ipod, folder, {
      newEngine,
      signal: stop.signal,
      onProgress: (message, phase) => {
        phases.push(phase);
        if (phase === 'writing') stop.abort();
      },
    });
    assert.equal(report.verified, true, 'every file was restored and read back');
    assert.deepEqual([...new Set(phases)], ['checking', 'writing', 'verifying']);
  });
});

describe('pausing an offload', () => {
  async function ipodWithMusic() {
    const ipod = await signedIpod();
    const engine = await readIpod(ipod);
    let seed = 1;
    for (const track of engine.tracks()) {
      await putFile(ipod, mediaPathOf(track.ipod_path), bytesFor(seed, 3000));
      seed += 1;
    }
    return { ipod, count: engine.tracks().length };
  }

  it('waits between files while paused, and carries on after resume', async () => {
    const { ipod, count } = await ipodWithMusic();
    const destination = new ScratchFolder('Copy');
    const pause = new PauseGate();
    let asked = false;
    const run = offloadIpod(ipod, destination, newEngine, {
      now: NOW,
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
    assert.equal(pause.state, 'paused');
    const whilePaused = mediaIn(destination);
    assert.ok(whilePaused >= 1 && whilePaused < count, `some files are copied (${whilePaused} of ${count})`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(mediaIn(destination), whilePaused, 'nothing more was copied while paused');
    pause.resume();
    const report = await run;
    assert.equal(report.complete, true);
    assert.equal(report.files.copied, count);
  });

  it('can be stopped while paused, which ends the run as stopped and resumable', async () => {
    const { ipod, count } = await ipodWithMusic();
    const destination = new ScratchFolder('Copy');
    const pause = new PauseGate();
    const stop = new AbortController();
    pause.request();
    const run = offloadIpod(ipod, destination, newEngine, { now: NOW, concurrency: 2, pause, signal: stop.signal });
    await until(() => pause.state === 'paused');
    assert.equal(pause.state, 'paused');
    stop.abort();
    const report = await run;
    assert.equal(report.stopped, true);
    assert.equal(report.files.copied, 0);
    assert.equal(report.files.notCopied, count);
  });

  it('stops before the first file with an AbortError and makes no folder', async () => {
    const { ipod } = await ipodWithMusic();
    const destination = new ScratchFolder('Copy');
    await assert.rejects(offloadIpod(ipod, destination, newEngine, { now: NOW, signal: AbortSignal.abort() }), isAbort);
    assert.deepEqual([...destination.listFiles().keys()], []);
  });
});

describe('pausing a sync', () => {
  const three = () => [makeItem('music'), makeItem('music'), makeItem('music')];

  it('copies nothing while paused, does not touch the database, and finishes after resume', async () => {
    const ipod = await signedIpod();
    const backup = await backedUp(ipod);
    const plan = await planSync(ipod, newEngine, three());
    const before = snapshot(ipod);
    const pause = new PauseGate();
    pause.request();
    const run = applySync(plan, ipod, newEngine, { backup, pause, concurrency: 1 });
    await until(() => pause.state === 'paused');
    assert.equal(pause.state, 'paused');
    assert.deepEqual(snapshot(ipod), before, 'the iPod is as it was while the job waits');
    pause.resume();
    const report = await run;
    assert.equal(report.verified, true);
    assert.equal(report.copied.length, 3);
  });

  it('can be stopped while paused, and the iPod is put back as it was', async () => {
    const ipod = await signedIpod();
    const backup = await backedUp(ipod);
    const plan = await planSync(ipod, newEngine, three());
    const before = snapshot(ipod);
    const pause = new PauseGate();
    const stop = new AbortController();
    pause.request();
    const run = applySync(plan, ipod, newEngine, { backup, pause, signal: stop.signal, concurrency: 1 });
    await until(() => pause.state === 'paused');
    stop.abort();
    const report = await run;
    assert.equal(report.aborted, true);
    assert.equal(report.verified, false);
    assert.deepEqual(snapshot(ipod), before);
  });
});
