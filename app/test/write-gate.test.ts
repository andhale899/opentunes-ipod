import { beforeEach, describe, expect, it } from 'vitest';
import { ScratchFolder, type BackupReport } from '@opentunes/engine';
import { loadBackupRecord } from '../src/handles';
import { memoryKv, useKv } from '../src/kv';
import { createLogStore, useLogStore } from '../src/log';
import { pickBackupFolder, runQuickBackup } from '../src/quickBackup';
import { resetActivity } from '../src/activity';
import { beginRead, beginWrite, lockState, readBlockText, resetLock } from '../src/writeLock';

const put = async (root: ScratchFolder, path: string, text: string) => {
  const parts = path.split('/');
  let folder = root;
  for (const part of parts.slice(0, -1)) folder = await folder.getDirectoryHandle(part, { create: true });
  const writer = await (await folder.getFileHandle(parts.at(-1) as string, { create: true })).createWritable();
  await writer.write(new TextEncoder().encode(text));
  await writer.close();
};

beforeEach(() => {
  useKv(memoryKv());
  useLogStore(createLogStore());
  resetLock();
  resetActivity();
});

describe('buttons that change the iPod say up front when a read job holds them off', () => {
  it('has no line when nothing is being read', () => {
    expect(readBlockText(lockState())).toBeNull();
  });

  it('names the running job, and goes away by itself when the job ends', () => {
    const endBackup = beginRead('Backing up the iPod');
    expect(readBlockText(lockState())).toBe('Off while "Backing up the iPod" is running. Wait for it or stop it from the bar above.');
    const endCopy = beginRead('Copying files off the iPod');
    expect(readBlockText(lockState())).toContain('Backing up the iPod');
    endBackup();
    expect(readBlockText(lockState())).toContain('Copying files off the iPod');
    endCopy();
    expect(readBlockText(lockState())).toBeNull();
  });

  it('is the same moment the lock would refuse the change, so the button and the refusal agree', () => {
    const end = beginRead('Reading the iPod');
    expect(readBlockText(lockState())).not.toBeNull();
    expect(() => beginWrite('Saving changes to the iPod')).toThrow(/still being read/);
    end();
    expect(readBlockText(lockState())).toBeNull();
    expect(() => beginWrite('Saving changes to the iPod')()).not.toThrow();
  });

  it('is not used for a running change: that turns every control off at once, with its own banner', () => {
    const end = beginWrite('Saving changes to the iPod');
    expect(readBlockText(lockState())).toBeNull();
    end();
  });
});

describe('"Back up now": the quick backup made where the change is off', () => {
  async function ipod() {
    const root = new ScratchFolder('MY IPOD');
    await put(root, 'iPod_Control/iTunes/iTunesCDB', 'library one');
    await put(root, 'iPod_Control/Device/SysInfo', 'made-up device');
    return root;
  }

  it('asks for no folder on the practice iPod, makes a complete backup, and tells the page it counts', async () => {
    const root = await ipod();
    const destination = await pickBackupFolder(true);
    expect(destination).not.toBeNull();
    const counted: BackupReport[] = [];
    const report = await runQuickBackup(root, destination as never, { inMemory: true, onDone: (made) => counted.push(made) });
    expect(report.complete).toBe(true);
    expect(counted).toEqual([report]);
    expect(await loadBackupRecord('MY IPOD')).toBeNull(); // a practice backup lives in memory and is not remembered
  });

  it('on a real iPod folder also remembers where the backup is, so the next open can check it', async () => {
    const root = await ipod();
    const destination = new ScratchFolder('iPod backups');
    const counted: BackupReport[] = [];
    const report = await runQuickBackup(root, destination as never, { inMemory: false, onDone: (made) => counted.push(made) });
    expect(counted).toHaveLength(1);
    expect(await loadBackupRecord('MY IPOD')).toMatchObject({ folder: report.folder, destinationName: 'iPod backups' });
  });

  it('does not count a stopped backup', async () => {
    const root = await ipod();
    const controller = new AbortController();
    controller.abort();
    const counted: BackupReport[] = [];
    const report = await runQuickBackup(root, new ScratchFolder('iPod backups') as never, { inMemory: false, signal: controller.signal, onDone: (made) => counted.push(made) });
    expect(report.stopped).toBe(true);
    expect(counted).toEqual([]);
    expect(await loadBackupRecord('MY IPOD')).toBeNull();
  });
});
