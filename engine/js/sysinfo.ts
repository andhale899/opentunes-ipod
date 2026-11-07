/**
 * The small device file `iPod_Control/Device/SysInfo`.
 *
 * A nano 6G or 7G cannot be written without its FireWire ID. libgpod reads it from this file,
 * as a line `FirewireGuid: 0x<16 hex digits>`. An iPod synced by iTunes usually has the file;
 * the old TunesReloaded wrote it from the USB serial number, and so does this. Planning reads;
 * applying writes the one file and reads it back. It never replaces an ID that differs, because
 * that would mean it is looking at a different iPod than the one plugged in.
 */

import type { IpodRoot } from './writeback.ts';

export interface SysInfoPlan {
  /**
   * - none: the file already holds this ID.
   * - create: there is no file, or no ID line in it.
   * - mismatch: the file holds a different ID. Nothing is written.
   */
  action: 'none' | 'create' | 'mismatch';
  /** What the file holds now, or null if there is none. */
  before: string | null;
  /** What it would hold. Equal to `before` unless the action is create. */
  after: string;
  /** The ID the file holds now, when it has one. */
  existingId: string | null;
}

const ID_LINE = /^\s*FirewireGuid\s*:\s*(?:0x)?([0-9a-f]{16})\s*$/im;
const PATH = ['iPod_Control', 'Device', 'SysInfo'] as const;

/** Adds a FirewireGuid line (and a ModelNumStr line when given and absent) and keeps every other line. */
export function mergeSysInfo(existing: string | null, fireWireId: string, modelNumStr?: string | null): string {
  if (!/^[0-9a-f]{16}$/i.test(fireWireId)) throw new Error('A FireWire ID is 16 hex digits.');
  const lines = (existing ?? '').split(/\r?\n/).filter((line) => line.trim() !== '');
  const hasId = lines.some((line) => /^\s*FirewireGuid\s*:/i.test(line));
  const hasModel = lines.some((line) => /^\s*ModelNumStr\s*:/i.test(line));
  if (!hasId) lines.push(`FirewireGuid: 0x${fireWireId.toUpperCase()}`);
  if (modelNumStr && !hasModel) lines.push(`ModelNumStr: ${modelNumStr}`);
  return lines.join('\n') + '\n';
}

async function readSysInfo(root: IpodRoot): Promise<string | null> {
  try {
    const device = await (await root.getDirectoryHandle(PATH[0])).getDirectoryHandle(PATH[1]);
    const handle = await device.getFileHandle(PATH[2]);
    return new TextDecoder().decode(await (await handle.getFile()).arrayBuffer());
  } catch {
    return null;
  }
}

/** Reads the iPod's SysInfo and says what writing this ID would do. Writes nothing. */
export async function planSysInfo(root: IpodRoot, fireWireId: string, modelNumStr?: string | null): Promise<SysInfoPlan> {
  const before = await readSysInfo(root);
  const existingId = before?.match(ID_LINE)?.[1]?.toUpperCase() ?? null;
  if (existingId && existingId !== fireWireId.toUpperCase()) return { action: 'mismatch', before, after: before ?? '', existingId };
  if (existingId) return { action: 'none', before, after: before ?? '', existingId };
  return { action: 'create', before, after: mergeSysInfo(before, fireWireId, modelNumStr), existingId: null };
}

/** Writes the planned file and reads it back. Only a 'create' plan writes anything. */
export async function applySysInfo(root: IpodRoot, plan: SysInfoPlan): Promise<void> {
  if (plan.action !== 'create') return;
  const control = await root.getDirectoryHandle(PATH[0]);
  const device = await control.getDirectoryHandle(PATH[1], { create: true });
  const writer = await (await device.getFileHandle(PATH[2], { create: true })).createWritable();
  await writer.write(new TextEncoder().encode(plan.after));
  await writer.close();
  const back = await readSysInfo(root);
  if (back !== plan.after) throw new Error('SysInfo did not read back as it was written.');
}
