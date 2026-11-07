// Writing a rebuilt database back to an iPod, and restoring a backup.
//
// The iPod is a nano 7G-style folder held in memory that can be written to. These tests show
// the safety rules hold: nothing is written without a complete backup, a failure at any point
// puts every changed file back, and a damaged backup restores nothing. They cannot show a real
// iPod accepts the result.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  EngineError,
  ScratchFolder,
  WriteBackError,
  applyWriteBack,
  backupIpod,
  buildSignedDemoIpod,
  describeBackup,
  planWriteBack,
  restoreBackup,
} from '../js/index.ts';
import { MOUNT, newEngine } from './helpers.mjs';

const ITUNES = 'iPod_Control/iTunes';
const NOW = new Date(2026, 10, 7, 18, 4);

/** A Play Counts file for `entries` tracks, all zero: the header libgpod reads, then 12-byte entries. */
function playCounts(entries) {
  const bytes = new Uint8Array(96 + entries * 12);
  bytes.set(new TextEncoder().encode('mhdp'), 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, 96, true);
  view.setUint32(8, 12, true);
  view.setUint32(12, entries, true);
  return bytes;
}

async function copyInto(engine, directory, folder) {
  for (const name of engine.fs.readdir(directory)) {
    if (name === '.' || name === '..') continue;
    const path = `${directory}/${name}`;
    if (engine.fs.isDir(engine.fs.stat(path).mode)) {
      await copyInto(engine, path, await folder.getDirectoryHandle(name, { create: true }));
    } else {
      const writer = await (await folder.getFileHandle(name, { create: true })).createWritable();
      await writer.write(engine.fs.readFile(path));
      await writer.close();
    }
  }
}

/** A nano 7G-style iPod in a writable folder: no iTunesDB file, and plays waiting in Play Counts. */
async function scratchIpod() {
  const engine = await newEngine();
  buildSignedDemoIpod(engine);
  engine.fs.unlink(`${MOUNT}/${ITUNES}/iTunesDB`);
  engine.fs.writeFile(`${MOUNT}/${ITUNES}/Play Counts`, playCounts(5));
  const ipod = new ScratchFolder('IPOD');
  await copyInto(engine, MOUNT, ipod);
  return ipod;
}

const snapshot = (ipod) => new Map([...ipod.listFiles()].map(([path, bytes]) => [path, Uint8Array.from(bytes)]));

/** Wraps an iPod folder so a test can refuse or damage the write of chosen files. */
function interfere(folder, decide) {
  return {
    kind: 'directory',
    name: folder.name,
    entries: () => folder.entries(),
    getDirectoryHandle: async (name, options) => interfere(await folder.getDirectoryHandle(name, options), decide),
    removeEntry: (name) => folder.removeEntry(name),
    getFileHandle: async (name, options) => {
      const file = await folder.getFileHandle(name, options);
      return {
        getFile: () => file.getFile(),
        createWritable: async () => {
          const action = decide(name);
          if (action === 'refuse') throw new Error('the disk is full');
          const writer = await file.createWritable();
          return {
            write: (data) => writer.write(action === 'corrupt' ? Uint8Array.from(data, (byte, i) => (i === 0 ? byte ^ 0xff : byte)) : data),
            close: () => writer.close(),
          };
        },
      };
    },
  };
}

async function backedUp(ipod) {
  const destination = new ScratchFolder('Backups');
  const backup = await backupIpod(ipod, destination, { now: NOW });
  assert.equal(backup.complete, true);
  return { backup, destination, folder: await destination.getDirectoryHandle(backup.folder) };
}

describe('planning a write-back', () => {
  it('changes nothing on the iPod, and lists what would change', async () => {
    const ipod = await scratchIpod();
    const before = snapshot(ipod);
    const plan = await planWriteBack(ipod, newEngine);
    assert.deepEqual(snapshot(ipod), before);

    const byPath = Object.fromEntries(plan.changes.map((change) => [change.path, change.kind]));
    assert.equal(byPath[`${ITUNES}/iTunesCDB`], 'changed');
    assert.equal(byPath[`${ITUNES}/iTunes Library.itlp/Library.itdb`], 'changed');
    assert.equal(byPath[`${ITUNES}/Play Counts`], 'removed');
    assert.equal(byPath[`${ITUNES}/Play Counts.bak`], 'added');
    assert.deepEqual(plan.skipped.map((file) => file.path), [`${ITUNES}/iTunesDB`]);
    assert.deepEqual(plan.report.problems, []);
    assert.ok(!plan.changes.some((change) => change.path.startsWith('iPod_Control/Music')));
  });

  it('refuses a folder that has no database to write', async () => {
    const empty = new ScratchFolder('Empty');
    await empty.getDirectoryHandle('iPod_Control', { create: true });
    await assert.rejects(planWriteBack(empty, newEngine), /no iTunes folder/);
  });
});

describe('writing back', () => {
  it('writes the planned files, reads each back, and checks the iPod afterwards', async () => {
    const ipod = await scratchIpod();
    const { backup } = await backedUp(ipod);
    const plan = await planWriteBack(ipod, newEngine);
    const messages = [];
    const report = await applyWriteBack(plan, ipod, newEngine, { backup, onProgress: (message) => messages.push(message) });

    assert.deepEqual(report.failures, []);
    assert.equal(report.verified, true);
    assert.equal(report.rolledBack, false);
    assert.deepEqual(report.signatures.map((check) => [check.file, check.status]), [['iTunesCDB', 'matches'], ['Locations.itdb.cbk', 'matches']]);

    const after = snapshot(ipod);
    for (const { path, size } of report.written) {
      assert.deepEqual(after.get(path), plan.rewritten.get(path), path);
      assert.equal(after.get(path).length, size);
    }
    assert.deepEqual(report.removed, [`${ITUNES}/Play Counts`]);
    assert.ok(!after.has(`${ITUNES}/Play Counts`));
    assert.ok(after.has(`${ITUNES}/Play Counts.bak`));
    assert.ok(!after.has(`${ITUNES}/iTunesDB`), 'no empty iTunesDB was added');
    assert.ok(messages.some((message) => message === `Writing ${ITUNES}/iTunesCDB`));
  });

  it('writes the signed files last and removes after writing', async () => {
    const ipod = await scratchIpod();
    const { backup } = await backedUp(ipod);
    const plan = await planWriteBack(ipod, newEngine);

    // A rewrite leaves this demo's Locations.itdb.cbk as it was, so make it differ to see where it goes.
    // The damaged signature file is then caught by the check after the write, which is a test of its own.
    const cbk = `${ITUNES}/iTunes Library.itlp/Locations.itdb.cbk`;
    const original = plan.rewritten.get(cbk);
    plan.rewritten.set(cbk, Uint8Array.from(original, (byte, i) => (i === 100 ? byte ^ 1 : byte)));
    plan.changes.push({ path: cbk, kind: 'changed', sizeBefore: original.length, sizeAfter: original.length });

    const messages = [];
    const report = await applyWriteBack(plan, ipod, newEngine, { backup, onProgress: (message) => messages.push(message) });
    const steps = messages.filter((message) => /^(Writing|Removing) /.test(message)).map((message) => message.replace(/^(Writing|Removing) /, ''));
    assert.deepEqual(steps.slice(-3), [cbk, `${ITUNES}/iTunesCDB`, `${ITUNES}/Play Counts`]);
    assert.ok(steps.indexOf(`${ITUNES}/Play Counts.bak`) < steps.indexOf(cbk));
    assert.equal(report.rolledBack, true, 'a signature file that does not verify is not left on the iPod');
    assert.match(report.failures[0], /A signature on the iPod is not confirmed after the write/);
  });

  it('will not write without a complete backup from this session', async () => {
    const ipod = await scratchIpod();
    const before = snapshot(ipod);
    const { backup } = await backedUp(ipod);
    const plan = await planWriteBack(ipod, newEngine);
    for (const bad of [null, { ...backup, complete: false }, { ...backup, failures: ['x'] }]) {
      await assert.rejects(applyWriteBack(plan, ipod, newEngine, { backup: bad }), (error) => error instanceof WriteBackError && /Back up the iPod first/.test(error.message));
    }
    assert.deepEqual(snapshot(ipod), before);
  });
});

describe('when writing back goes wrong', () => {
  it('puts every changed file back when a write is refused', async () => {
    const ipod = await scratchIpod();
    const before = snapshot(ipod);
    const { backup } = await backedUp(ipod);
    const plan = await planWriteBack(ipod, newEngine);

    const report = await applyWriteBack(plan, interfere(ipod, (name) => (name === 'iTunesCDB' ? 'refuse' : 'fine')), newEngine, { backup });
    assert.equal(report.verified, false);
    assert.equal(report.rolledBack, true);
    assert.deepEqual(report.rollbackFailures, []);
    assert.match(report.failures[0], /iTunesCDB could not be written: the disk is full/);
    assert.ok(report.written.length > 0, 'other files had been written before it failed');
    assert.deepEqual(snapshot(ipod), before, 'the iPod is as it was');
  });

  it('puts every changed file back when a file does not read back the same', async () => {
    const ipod = await scratchIpod();
    const before = snapshot(ipod);
    const { backup } = await backedUp(ipod);
    const plan = await planWriteBack(ipod, newEngine);

    let damaged = false;
    const report = await applyWriteBack(plan, interfere(ipod, (name) => {
      if (name === 'Library.itdb' && !damaged) {
        damaged = true;
        return 'corrupt';
      }
      return 'fine';
    }), newEngine, { backup });
    assert.equal(report.rolledBack, true);
    assert.match(report.failures[0], /Library\.itdb did not match what was written/);
    assert.deepEqual(snapshot(ipod), before);
  });

  it('puts every file back when the iPod cannot be read back afterwards', async () => {
    const ipod = await scratchIpod();
    const before = snapshot(ipod);
    const { backup } = await backedUp(ipod);
    let engines = 0;
    const factory = async () => {
      const engine = await newEngine();
      engines += 1;
      if (engines === 2) {
        engine.open = () => {
          throw new EngineError('simulated read-back failure');
        };
      }
      return engine;
    };
    const plan = await planWriteBack(ipod, factory);
    const report = await applyWriteBack(plan, ipod, factory, { backup });
    assert.equal(report.rolledBack, true);
    assert.match(report.failures[0], /could not be read back after the write: simulated read-back failure/);
    assert.deepEqual(snapshot(ipod), before);
  });

  it('stops if the iPod changed after the plan was made, and leaves it as it found it', async () => {
    const ipod = await scratchIpod();
    const { backup } = await backedUp(ipod);
    const plan = await planWriteBack(ipod, newEngine);

    const folder = await (await ipod.getDirectoryHandle('iPod_Control')).getDirectoryHandle('iTunes');
    const tampered = new Uint8Array(100).fill(9);
    const writer = await (await (await folder.getDirectoryHandle('iTunes Library.itlp')).getFileHandle('Library.itdb')).createWritable();
    await writer.write(tampered);
    await writer.close();
    const changed = snapshot(ipod);

    const report = await applyWriteBack(plan, ipod, newEngine, { backup });
    assert.equal(report.verified, false);
    assert.match(report.failures[0], /Library\.itdb on the iPod is not what it was when the plan was made/);
    assert.deepEqual(snapshot(ipod), changed, 'nothing was left half done');
  });
});

describe('restoring a backup', () => {
  it('puts the original files back after a write, and the iPod reads back', async () => {
    const ipod = await scratchIpod();
    const before = snapshot(ipod);
    const { backup, folder } = await backedUp(ipod);
    const plan = await planWriteBack(ipod, newEngine);
    await applyWriteBack(plan, ipod, newEngine, { backup });
    assert.notDeepEqual(snapshot(ipod), before, 'the write changed the iPod');

    const summary = await describeBackup(folder);
    assert.equal(summary.createdAt, NOW.toISOString());
    assert.ok(summary.files > 5 && summary.bytes > 0);

    const report = await restoreBackup(ipod, folder, { newEngine });
    assert.deepEqual(report.failures, []);
    assert.equal(report.verified, true);
    assert.equal(report.restored, summary.files);
    assert.deepEqual(report.signatures.map((check) => check.status), ['matches', 'matches']);

    const after = snapshot(ipod);
    for (const [path, bytes] of before) assert.deepEqual(after.get(path), bytes, `${path} is as it was`);
    assert.ok(after.has(`${ITUNES}/Play Counts.bak`), 'files the write added are left alone, nothing is deleted');
  });

  it('checks every file before writing any, so a damaged backup changes nothing', async () => {
    const ipod = await scratchIpod();
    const { folder } = await backedUp(ipod);
    const damaged = await (await (await (await folder.getDirectoryHandle('iPod_Control')).getDirectoryHandle('iTunes')).getFileHandle('iTunesCDB'));
    damaged.bytes = Uint8Array.from(damaged.bytes, (byte, i) => (i === 10 ? byte ^ 1 : byte));
    // Make the iPod differ from the backup, so a restore that went ahead would show.
    const folderOnIpod = await (await ipod.getDirectoryHandle('iPod_Control')).getDirectoryHandle('iTunes');
    const writer = await (await folderOnIpod.getFileHandle('iTunesPrefs', { create: true })).createWritable();
    await writer.write(new Uint8Array(3));
    await writer.close();
    const before = snapshot(ipod);

    await assert.rejects(restoreBackup(ipod, folder), (error) => error instanceof WriteBackError && /iTunesCDB does not match its checksum in the backup, so nothing was restored/.test(error.message));
    assert.deepEqual(snapshot(ipod), before);
  });

  it('refuses a folder that is not a usable backup', async () => {
    const ipod = await scratchIpod();
    const write = async (folder, text) => {
      const writer = await (await folder.getFileHandle('backup-info.json', { create: true })).createWritable();
      await writer.write(text);
      await writer.close();
    };

    await assert.rejects(restoreBackup(ipod, new ScratchFolder('Docs')), /has no backup-info\.json/);

    const notBackup = new ScratchFolder('Other');
    await write(notBackup, JSON.stringify({ kind: 'something-else', files: [] }));
    await assert.rejects(restoreBackup(ipod, notBackup), /is not an iPod database backup/);

    const incomplete = new ScratchFolder('Half');
    await write(incomplete, JSON.stringify({ kind: 'ipod-database-backup', complete: false, files: [] }));
    await assert.rejects(restoreBackup(ipod, incomplete), /was not complete/);

    const sneaky = new ScratchFolder('Sneaky');
    await write(sneaky, JSON.stringify({ kind: 'ipod-database-backup', complete: true, createdAt: 'x', files: [{ path: 'iPod_Control/../../escape', size: 1, sha256: null }] }));
    await assert.rejects(restoreBackup(ipod, sneaky), /lists a path it should not/);

    const missing = new ScratchFolder('Missing');
    await write(missing, JSON.stringify({ kind: 'ipod-database-backup', complete: true, createdAt: 'x', files: [{ path: 'iPod_Control/iTunes/gone', size: 1, sha256: null }] }));
    await assert.rejects(restoreBackup(ipod, missing), /is listed in the backup but is not in the folder/);
  });
});
