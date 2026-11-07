/**
 * Hands-on checks that need a real browser and a real iPod.
 *
 * Feature detection says an API exists. These probes find out whether it works with the
 * actual iPod, which is the part that differs between operating systems and models.
 * Nothing here is sent anywhere.
 */

import { describeIpodLayout, type DirectoryEntry } from '@opentunes/engine';

export interface ProbeResult {
  ok: boolean;
  /** One plain sentence for the person. */
  summary: string;
  data?: Record<string, unknown>;
  at: string;
}

interface UsbDeviceLike {
  productName?: string;
  manufacturerName?: string;
  serialNumber?: string;
  vendorId: number;
  productId: number;
  usbVersionMajor: number;
  usbVersionMinor: number;
  deviceClass: number;
  opened: boolean;
}

interface UsbApi {
  requestDevice(options: { filters: { vendorId: number }[] }): Promise<UsbDeviceLike>;
}

interface FsHandle {
  kind: 'file' | 'directory';
  name: string;
}

interface FsFile extends FsHandle {
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(data: string | Uint8Array): Promise<void>; close(): Promise<void> }>;
}

interface FsDir extends FsHandle {
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FsFile>;
  removeEntry(name: string): Promise<void>;
}

const APPLE_VENDOR_ID = 0x05ac;
const WRITE_TEST_FILE = '.opentunes-write-test';
const SPEED_TEST_PREFIX = '.opentunes-speed-test-';

const now = (): string => new Date().toISOString();
const ms = (since: number): number => Math.round(performance.now() - since);
const hex = (value: number): string => `0x${value.toString(16).padStart(4, '0')}`;

function describeError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'AbortError' || error.name === 'NotFoundError') {
      return `Cancelled or nothing was selected (${error.name}).`;
    }
    return `${error.name}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Asks Chrome for an Apple USB device and reports what WebUSB can read without opening it. */
export async function probeUsb(): Promise<ProbeResult> {
  const usb = (navigator as unknown as { usb?: UsbApi }).usb;
  if (!usb) return { ok: false, summary: 'WebUSB is not available in this browser.', at: now() };

  try {
    const device = await usb.requestDevice({ filters: [{ vendorId: APPLE_VENDOR_ID }] });
    return {
      ok: true,
      summary: `Chrome can see ${device.productName ?? 'an Apple USB device'}.`,
      data: {
        productName: device.productName ?? null,
        manufacturerName: device.manufacturerName ?? null,
        serialNumber: device.serialNumber ?? null,
        vendorId: hex(device.vendorId),
        productId: hex(device.productId),
        usbVersion: `${device.usbVersionMajor}.${device.usbVersionMinor}`,
        deviceClass: device.deviceClass,
        opened: device.opened,
      },
      at: now(),
    };
  } catch (error) {
    return { ok: false, summary: describeError(error), at: now() };
  }
}

type Picked = { dir: FsDir } | { failure: ProbeResult };

async function pickDirectory(mode: 'read' | 'readwrite'): Promise<Picked> {
  const picker = (window as unknown as {
    showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<FsDir>;
  }).showDirectoryPicker;
  if (!picker) return { failure: { ok: false, summary: 'The folder picker is not available in this browser.', at: now() } };
  try {
    return { dir: await picker.call(window, { mode }) };
  } catch (error) {
    return { failure: { ok: false, summary: describeError(error), at: now() } };
  }
}

/** Creates, writes, reads back and deletes a two-byte file, timing each step. */
async function timedWriteTest(dir: FsDir): Promise<Record<string, unknown>> {
  const steps: Record<string, number> = {};
  const started = performance.now();
  try {
    let t = performance.now();
    const file = await dir.getFileHandle(WRITE_TEST_FILE, { create: true });
    steps.createMs = ms(t);
    t = performance.now();
    const writable = await file.createWritable();
    steps.openWriterMs = ms(t);
    t = performance.now();
    await writable.write('ok');
    steps.writeMs = ms(t);
    t = performance.now();
    await writable.close();
    steps.closeMs = ms(t);
    t = performance.now();
    const text = await (await (await dir.getFileHandle(WRITE_TEST_FILE)).getFile()).text();
    steps.readMs = ms(t);
    t = performance.now();
    await dir.removeEntry(WRITE_TEST_FILE);
    steps.removeMs = ms(t);
    return { readBack: text, matches: text === 'ok', milliseconds: ms(started), steps };
  } catch (error) {
    await dir.removeEntry(WRITE_TEST_FILE).catch(() => undefined);
    throw error;
  }
}

/**
 * Lets the person pick the iPod's drive, then reports what is on it: the top-level folders
 * and the files in iPod_Control/iTunes and Device, with sizes. With `writeTest` it also
 * creates, reads back and deletes a two-byte file in the root, timing each step.
 */
export async function probeFolder(options: { writeTest: boolean }): Promise<ProbeResult> {
  const picked = await pickDirectory(options.writeTest ? 'readwrite' : 'read');
  if ('failure' in picked) return picked.failure;
  const { dir } = picked;

  try {
    const layout = await describeIpodLayout(dir as unknown as DirectoryEntry);
    const data: Record<string, unknown> = { folderName: dir.name, hasIpodControl: layout.control !== null, layout };
    if (options.writeTest) data.writeTest = await timedWriteTest(dir);

    const summary = layout.control
      ? `Chrome can read "${dir.name}" and it looks like an iPod (iPod_Control found).`
      : `Chrome can read "${dir.name}", but there is no iPod_Control folder in it.`;
    return { ok: true, summary, data, at: now() };
  } catch (error) {
    return { ok: false, summary: describeError(error), data: { folderName: dir.name }, at: now() };
  }
}

const MEGABYTE = 1024 * 1024;

function patternedChunk(): Uint8Array {
  const chunk = new Uint8Array(MEGABYTE);
  for (let i = 0; i < chunk.length; i += 1) chunk[i] = (i * 31 + 7) & 255;
  return chunk;
}

async function writeFile(dir: FsDir, name: string, megabytes: number, chunk: Uint8Array): Promise<{ writeMs: number; closeMs: number }> {
  const file = await dir.getFileHandle(name, { create: true });
  const writable = await file.createWritable();
  let t = performance.now();
  for (let i = 0; i < megabytes; i += 1) await writable.write(chunk);
  const writeMs = ms(t);
  t = performance.now();
  await writable.close();
  return { writeMs, closeMs: ms(t) };
}

const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

/**
 * How fast Chrome can write to this iPod. Writes about 20 MB of temporary files to the top
 * folder (three tiny files, one 8 MB file, then three 4 MB files at once) and deletes them.
 * The result decides how a sync is organised: one file at a time or several, and how long
 * a library will take.
 */
export async function probeWriteSpeed(): Promise<ProbeResult> {
  const picked = await pickDirectory('readwrite');
  if ('failure' in picked) return picked.failure;
  const { dir } = picked;

  const leftovers = new Set<string>();
  const chunk = patternedChunk();
  try {
    const tiny: { createMs: number; writeCloseMs: number; removeMs: number }[] = [];
    for (let i = 0; i < 3; i += 1) {
      const name = `${SPEED_TEST_PREFIX}tiny-${i}`;
      leftovers.add(name);
      let t = performance.now();
      const file = await dir.getFileHandle(name, { create: true });
      const createMs = ms(t);
      t = performance.now();
      const writable = await file.createWritable();
      await writable.write('x');
      await writable.close();
      const writeCloseMs = ms(t);
      t = performance.now();
      await dir.removeEntry(name);
      leftovers.delete(name);
      tiny.push({ createMs, writeCloseMs, removeMs: ms(t) });
    }

    const bulkName = `${SPEED_TEST_PREFIX}bulk`;
    leftovers.add(bulkName);
    const bulkStart = performance.now();
    const bulk = await writeFile(dir, bulkName, 8, chunk);
    const bulkMs = ms(bulkStart);
    await dir.removeEntry(bulkName);
    leftovers.delete(bulkName);

    const names = [0, 1, 2].map((i) => `${SPEED_TEST_PREFIX}parallel-${i}`);
    for (const name of names) leftovers.add(name);
    const parallelStart = performance.now();
    await Promise.all(names.map((name) => writeFile(dir, name, 4, chunk)));
    const parallelMs = ms(parallelStart);
    for (const name of names) {
      await dir.removeEntry(name);
      leftovers.delete(name);
    }

    const bulkRate = Math.round((8 / (bulkMs / 1000)) * 10) / 10;
    const parallelRate = Math.round((12 / (parallelMs / 1000)) * 10) / 10;
    const smallFileMs = median(tiny.map((step) => step.createMs + step.writeCloseMs + step.removeMs));
    return {
      ok: true,
      summary: `A small file costs about ${smallFileMs} ms (create, write, delete). One large file wrote at ${bulkRate} MB/s, three at once at ${parallelRate} MB/s.`,
      data: {
        folderName: dir.name,
        tinyFiles: tiny,
        smallFileMedianMs: smallFileMs,
        bulk: { megabytes: 8, ms: bulkMs, writeMs: bulk.writeMs, closeMs: bulk.closeMs, megabytesPerSecond: bulkRate },
        parallel: { files: 3, megabytes: 12, ms: parallelMs, megabytesPerSecond: parallelRate },
      },
      at: now(),
    };
  } catch (error) {
    return { ok: false, summary: describeError(error), data: { folderName: dir.name }, at: now() };
  } finally {
    // Whatever happened, take the temporary files back off the iPod.
    for (const name of leftovers) await dir.removeEntry(name).catch(() => undefined);
  }
}
