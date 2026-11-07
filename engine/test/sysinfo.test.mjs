// The device file that carries an iPod's FireWire ID.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ScratchFolder, applySysInfo, mergeSysInfo, planSysInfo } from '../js/index.ts';

const ID = '0123456789ABCDEF';
const OTHER = 'FEDCBA9876543210';

async function ipodWith(text) {
  const root = new ScratchFolder('IPOD');
  const device = await (await root.getDirectoryHandle('iPod_Control', { create: true })).getDirectoryHandle('Device', { create: true });
  if (text !== null) {
    const writer = await (await device.getFileHandle('SysInfo', { create: true })).createWritable();
    await writer.write(text);
    await writer.close();
  }
  return root;
}

const sysInfoOf = (root) => new TextDecoder().decode(root.listFiles().get('iPod_Control/Device/SysInfo'));

describe('merging a SysInfo file', () => {
  it('adds the ID line and the model line to nothing', () => {
    assert.equal(mergeSysInfo(null, ID, 'MD480'), `FirewireGuid: 0x${ID}\nModelNumStr: MD480\n`);
    assert.equal(mergeSysInfo(null, ID), `FirewireGuid: 0x${ID}\n`);
  });

  it('keeps every other line, and the lines already there', () => {
    const existing = 'ModelNumStr: MD480\r\npszSerialNumber: ABC123\r\n';
    assert.equal(mergeSysInfo(existing, ID, 'WRONG'), `ModelNumStr: MD480\npszSerialNumber: ABC123\nFirewireGuid: 0x${ID}\n`);
  });

  it('gives the ID in capitals and refuses an ID that is not 16 hex digits', () => {
    assert.equal(mergeSysInfo(null, ID.toLowerCase()), `FirewireGuid: 0x${ID}\n`);
    assert.throws(() => mergeSysInfo(null, '12345'), /16 hex digits/);
  });
});

describe('planning and applying', () => {
  it('creates the file on an iPod that has none, and reads it back', async () => {
    const root = await ipodWith(null);
    const plan = await planSysInfo(root, ID, 'MD480');
    assert.equal(plan.action, 'create');
    assert.equal(plan.before, null);
    assert.deepEqual([...root.listFiles().keys()], [], 'planning wrote nothing');
    await applySysInfo(root, plan);
    assert.equal(sysInfoOf(root), `FirewireGuid: 0x${ID}\nModelNumStr: MD480\n`);
  });

  it('adds the ID line to a file that has none, keeping the rest', async () => {
    const root = await ipodWith('ModelNumStr: MD480\n');
    const plan = await planSysInfo(root, ID);
    assert.equal(plan.action, 'create');
    await applySysInfo(root, plan);
    assert.equal(sysInfoOf(root), `ModelNumStr: MD480\nFirewireGuid: 0x${ID}\n`);
  });

  it('leaves a file alone that already holds this ID, whatever the case or the 0x', async () => {
    for (const line of [`FirewireGuid: 0x${ID}`, `FirewireGuid: ${ID.toLowerCase()}`, `firewireguid:0X${ID}`]) {
      const root = await ipodWith(`${line}\nModelNumStr: MD480\n`);
      const plan = await planSysInfo(root, ID);
      assert.equal(plan.action, 'none', line);
      assert.equal(plan.existingId, ID);
      const before = sysInfoOf(root);
      await applySysInfo(root, plan);
      assert.equal(sysInfoOf(root), before);
    }
  });

  it('refuses to replace a different ID, which would mean a different iPod', async () => {
    const root = await ipodWith(`FirewireGuid: 0x${OTHER}\n`);
    const plan = await planSysInfo(root, ID);
    assert.equal(plan.action, 'mismatch');
    assert.equal(plan.existingId, OTHER);
    await applySysInfo(root, plan);
    assert.equal(sysInfoOf(root), `FirewireGuid: 0x${OTHER}\n`);
  });

  it('makes the Device folder when the iPod has iPod_Control but no Device folder', async () => {
    const root = new ScratchFolder('IPOD');
    await root.getDirectoryHandle('iPod_Control', { create: true });
    const plan = await planSysInfo(root, ID);
    assert.equal(plan.action, 'create');
    await applySysInfo(root, plan);
    assert.equal(sysInfoOf(root), `FirewireGuid: 0x${ID}\n`);
  });
});
