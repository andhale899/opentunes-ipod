import { beforeEach, describe, expect, it } from 'vitest';
import { ScratchFolder, backupIpod } from '@opentunes/engine';
import { checkEarlierBackup, identityDiffers } from '../src/backupReuse';
import { forgetBackupRecord, loadBackupRecord, saveBackupRecord, type SavedBackup } from '../src/handles';
import { checkLastBackup, dateText, describeChanges, permissionNow, rememberBackup } from '../src/lastBackup';
import { createLogStore, useLogStore } from '../src/log';
import { memoryKv, useKv } from '../src/kv';

const put = async (root: ScratchFolder, path: string, text: string) => {
  const parts = path.split('/');
  let folder = root;
  for (const part of parts.slice(0, -1)) folder = await folder.getDirectoryHandle(part, { create: true });
  const writer = await (await folder.getFileHandle(parts.at(-1) as string, { create: true })).createWritable();
  await writer.write(new TextEncoder().encode(text));
  await writer.close();
};

const DAY = 24 * 3_600_000;

async function setup() {
  const ipod = new ScratchFolder('MY IPOD');
  await put(ipod, 'iPod_Control/iTunes/iTunesCDB', 'library one');
  await put(ipod, 'iPod_Control/Device/SysInfo', 'made-up device one');
  await put(ipod, 'iPod_Control/Artwork/ArtworkDB', 'art');
  const destination = new ScratchFolder('iPod backups');
  const report = await backupIpod(ipod, destination as never);
  const folder = await destination.getDirectoryHandle(report.folder);
  const manifest = JSON.parse(new TextDecoder().decode(folder.listFiles().get('backup-info.json')));
  const record: SavedBackup = { destination, destinationName: 'iPod backups', folder: report.folder, ipod: 'MY IPOD', madeAt: 1_000, manifestCreatedAt: manifest.createdAt as string };
  return { ipod, destination, folder, report, record };
}

const check = (record: SavedBackup, ipod: ScratchFolder, options: { now?: number; permission?: 'granted' | 'prompt' | 'denied' } = {}) =>
  checkLastBackup(record, ipod, { now: options.now ?? 2_000, permission: options.permission ?? 'granted' });

beforeEach(() => {
  useKv(memoryKv());
  useLogStore(createLogStore());
});

describe('the automatic check of the last backup', () => {
  it('matches: complete, every checksum right, and the iPod exactly as it was', async () => {
    const { ipod, record } = await setup();
    const result = await check(record, ipod);
    expect(result.status).toBe('matches');
    if (result.status === 'matches') expect(result.report).toMatchObject({ complete: true, files: 3, folder: record.folder });
  });

  it('asks for a click, and reads nothing, when Chrome has not given the folder yet', async () => {
    const { ipod, record } = await setup();
    // A destination that fails on any read: if the check touched it, it would say "missing", not "needs-permission".
    const untouchable = { ...record, destination: { getDirectoryHandle: async () => { throw new Error('read without permission'); } } };
    for (const permission of ['prompt', 'denied'] as const) {
      expect((await check(untouchable, ipod, { permission })).status).toBe('needs-permission');
    }
    expect(await permissionNow({})).toBe('granted');
    expect(await permissionNow({ queryPermission: async () => 'prompt' })).toBe('prompt');
    expect(await permissionNow({ queryPermission: async () => { throw new Error('gone'); } })).toBe('prompt');
  });

  it('differs: says what changed, how old the backup is, and keeps the report for the person to choose it', async () => {
    const { ipod, record } = await setup();
    await put(ipod, 'iPod_Control/iTunes/iTunesCDB', 'library two, changed in iTunes');
    await put(ipod, 'iPod_Control/iTunes/Extra', 'new');
    const result = await check(record, ipod, { now: 1_000 + 3 * DAY });
    expect(result.status).toBe('differs');
    if (result.status !== 'differs') return;
    expect(result.changes).toBe('the library (2 files)');
    expect(result.message).toContain('3 days ago');
    expect(result.message).toContain(dateText(1_000));
    expect(result.message).toContain('the library (2 files)');
    expect(result.report).toMatchObject({ complete: true, folder: record.folder });
  });

  it('is never accepted on its own: a differing backup never comes back as matching, even when only the artwork differs', async () => {
    const { ipod, record } = await setup();
    await put(ipod, 'iPod_Control/Artwork/ArtworkDB', 'other art');
    const result = await check(record, ipod);
    expect(result.status).toBe('differs');
    if (result.status === 'differs') expect(result.changes).toBe('the album art (1 file)');
  });

  it('missing: the folder is gone', async () => {
    const { ipod, record } = await setup();
    const result = await check({ ...record, folder: 'opentunes-backup-2020-01-01-0000' }, ipod);
    expect(result).toMatchObject({ status: 'problem', reason: 'missing' });
    if (result.status === 'problem') expect(result.message).toContain('opentunes-backup-2020-01-01-0000');
  });

  it('damaged: a backup file no longer matches its checksum', async () => {
    const { ipod, folder, record } = await setup();
    await put(folder, 'iPod_Control/iTunes/iTunesCDB', 'tampered!!!');
    const result = await check(record, ipod);
    expect(result).toMatchObject({ status: 'problem', reason: 'damaged' });
  });

  it('damaged: the backup lost a file or its backup-info.json', async () => {
    const { ipod, folder, record } = await setup();
    await folder.removeEntry('backup-info.json');
    expect(await check(record, ipod)).toMatchObject({ status: 'problem', reason: 'damaged' });
  });

  it('incomplete: the backup says it was not finished', async () => {
    const { ipod, folder, record } = await setup();
    const manifest = JSON.parse(new TextDecoder().decode(folder.listFiles().get('backup-info.json')));
    await put(folder, 'backup-info.json', JSON.stringify({ ...manifest, complete: false }));
    expect(await check(record, ipod)).toMatchObject({ status: 'problem', reason: 'incomplete' });
  });

  it('another iPod: a different folder name, a different folder in the same place, or different device identity files', async () => {
    const { ipod, record } = await setup();
    expect(await check({ ...record, ipod: 'SOMEONE ELSES' }, ipod)).toMatchObject({ status: 'problem', reason: 'other-ipod' });
    expect(await check({ ...record, manifestCreatedAt: '1999-01-01T00:00:00.000Z' }, ipod)).toMatchObject({ status: 'problem', reason: 'other-ipod' });
    // Same folder name, but its device identity file is not the one in the backup: that is another iPod, and cannot be chosen anyway.
    await put(ipod, 'iPod_Control/Device/SysInfo', 'made-up device two');
    await put(ipod, 'iPod_Control/iTunes/iTunesCDB', 'a completely different library');
    const result = await check(record, ipod);
    expect(result).toMatchObject({ status: 'problem', reason: 'other-ipod' });
    expect('report' in result).toBe(false);
  });

  it('names the identity files that make a backup another iPod\'s', () => {
    expect(identityDiffers({ changed: ['iPod_Control/Device/SysInfo'], missing: [], added: [] })).toBe(true);
    expect(identityDiffers({ changed: [], missing: ['iPod_Control/Device/SysInfoExtended'], added: [] })).toBe(true);
    expect(identityDiffers({ changed: ['iPod_Control/iTunes/iTunesCDB'], missing: [], added: ['iPod_Control/Device/Other'] })).toBe(false);
  });

  it('works for the library folder of a full copy, by its path inside the folder that was chosen', async () => {
    const ipod = new ScratchFolder('MY IPOD');
    await put(ipod, 'iPod_Control/iTunes/iTunesCDB', 'library one');
    await put(ipod, 'iPod_Control/Device/SysInfo', 'made-up device one');
    const destination = new ScratchFolder('Copies');
    const offload = await destination.getDirectoryHandle('opentunes-offload-2026-11-07-1804', { create: true });
    await backupIpod(ipod, offload as never, { folderName: 'database' });
    const manifest = JSON.parse(new TextDecoder().decode((await offload.getDirectoryHandle('database')).listFiles().get('backup-info.json')));
    const record: SavedBackup = { destination, destinationName: 'Copies', folder: 'opentunes-offload-2026-11-07-1804/database', ipod: 'MY IPOD', madeAt: 5, manifestCreatedAt: manifest.createdAt as string };
    expect((await check(record, ipod)).status).toBe('matches');
    await put(ipod, 'iPod_Control/iTunes/iTunesCDB', 'changed');
    expect((await check(record, ipod)).status).toBe('differs');
  });

  it('keeps the lower-level result: only a difference offers the older backup, nothing else does', async () => {
    const { ipod, record } = await setup();
    await put(ipod, 'iPod_Control/iTunes/iTunesCDB', 'changed');
    const changed = await checkEarlierBackup(record, ipod, 2_000);
    expect(changed.olderReport).toMatchObject({ complete: true });
    expect(changed.report).toBeNull();
    const damaged = await checkEarlierBackup({ ...record, manifestCreatedAt: 'x' }, ipod, 2_000);
    expect(damaged.olderReport).toBeNull();
  });
});

describe('saying what changed', () => {
  it('groups the differences into the library, the device files, the album art and other files', () => {
    expect(describeChanges({ changed: ['iPod_Control/iTunes/iTunesCDB'], missing: ['iPod_Control/iTunes/Locations.itdb'], added: ['iPod_Control/Device/New', 'iPod_Control/Artwork/F1.ithmb', 'iPod_Control/Stray'] })).toBe(
      'the library (2 files), the device files (1 file), the album art (1 file), other files (1)',
    );
    expect(describeChanges({ changed: [], missing: [], added: [] })).toBe('nothing that could be named');
  });
});

describe('remembering the backup after every backup and full copy', () => {
  it('keeps one record for each iPod folder name, and finds the right one', async () => {
    const { destination, report } = await setup();
    await rememberBackup(report, destination as never, 'MY IPOD');
    await rememberBackup(report, destination as never, 'OTHER IPOD');
    const mine = await loadBackupRecord('MY IPOD');
    expect(mine).toMatchObject({ destinationName: 'iPod backups', folder: report.folder, ipod: 'MY IPOD' });
    expect(typeof mine?.manifestCreatedAt).toBe('string');
    expect(await loadBackupRecord('OTHER IPOD')).toMatchObject({ ipod: 'OTHER IPOD' });
    expect(await loadBackupRecord('UNKNOWN')).toBeNull();
    await forgetBackupRecord('MY IPOD');
    expect(await loadBackupRecord('MY IPOD')).toBeNull();
    expect(await loadBackupRecord('OTHER IPOD')).not.toBeNull();
  });

  it('remembers a full copy by the path of its library folder, so the next open can find it', async () => {
    const ipod = new ScratchFolder('MY IPOD');
    await put(ipod, 'iPod_Control/iTunes/iTunesCDB', 'library one');
    const destination = new ScratchFolder('Copies');
    const offload = await destination.getDirectoryHandle('opentunes-offload-2026-11-07-1804', { create: true });
    const saved = await backupIpod(ipod, offload as never, { folderName: 'database' });
    await rememberBackup({ ...saved, folder: 'opentunes-offload-2026-11-07-1804/database' }, destination as never, 'MY IPOD');
    const record = await loadBackupRecord('MY IPOD');
    expect(record?.folder).toBe('opentunes-offload-2026-11-07-1804/database');
    expect((await check(record as SavedBackup, ipod)).status).toBe('matches');
  });

  it('still reads the single record kept before there was one per iPod, but only for the same iPod name', async () => {
    const { destination, record } = await setup();
    const db = await (await import('../src/kv')).kv();
    await db.set('backup-record', { ...record, destination });
    expect(await loadBackupRecord('MY IPOD')).toMatchObject({ folder: record.folder });
    expect(await loadBackupRecord('OTHER IPOD')).toBeNull();
    await saveBackupRecord({ ...record, destination, folder: 'newer' });
    expect((await loadBackupRecord('MY IPOD'))?.folder).toBe('newer');
  });

  it('does not throw when the folder cannot be read; the page just has nothing to remember', async () => {
    const { report } = await setup();
    await rememberBackup(report, new ScratchFolder('empty') as never, 'MY IPOD');
    expect(await loadBackupRecord('MY IPOD')).toBeNull();
  });
});
