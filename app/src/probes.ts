/**
 * Hands-on checks that need a real browser and a real iPod.
 *
 * Feature detection says an API exists. These probes find out whether it works
 * with the actual iPod, which is the part that differs between desktop Chrome
 * and Chrome on Android. Nothing here is sent anywhere.
 */

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
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
}

interface FsDir extends FsHandle {
  entries(): AsyncIterableIterator<[string, FsHandle]>;
  getDirectoryHandle(name: string): Promise<FsDir>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FsFile>;
  removeEntry(name: string): Promise<void>;
}

const APPLE_VENDOR_ID = 0x05ac;
const WRITE_TEST_FILE = '.opentunes-write-test';

const now = (): string => new Date().toISOString();
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

/**
 * Lets the person pick the iPod's drive, then reports what Chrome can see in it.
 * With `writeTest` it also creates, reads back and deletes a four-byte file in the root.
 */
export async function probeFolder(options: { writeTest: boolean }): Promise<ProbeResult> {
  const picker = (window as unknown as {
    showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<FsDir>;
  }).showDirectoryPicker;
  if (!picker) return { ok: false, summary: 'The folder picker is not available in this browser.', at: now() };

  let dir: FsDir;
  try {
    dir = await picker.call(window, { mode: options.writeTest ? 'readwrite' : 'read' });
  } catch (error) {
    return { ok: false, summary: describeError(error), at: now() };
  }

  try {
    const names: string[] = [];
    for await (const [name, handle] of dir.entries()) {
      names.push(handle.kind === 'directory' ? `${name}/` : name);
      if (names.length >= 30) break;
    }

    const data: Record<string, unknown> = {
      folderName: dir.name,
      firstEntries: names,
      hasIpodControl: names.includes('iPod_Control/'),
    };

    if (data.hasIpodControl) {
      try {
        const control = await dir.getDirectoryHandle('iPod_Control');
        const itunes = await control.getDirectoryHandle('iTunes');
        const db = await (await itunes.getFileHandle('iTunesDB')).getFile();
        data.iTunesDbBytes = db.size;
      } catch {
        data.iTunesDbBytes = null;
      }
      try {
        const control = await dir.getDirectoryHandle('iPod_Control');
        const device = await control.getDirectoryHandle('Device');
        await device.getFileHandle('SysInfo');
        data.sysInfoPresent = true;
      } catch {
        data.sysInfoPresent = false;
      }
    }

    if (options.writeTest) {
      const started = performance.now();
      const file = await dir.getFileHandle(WRITE_TEST_FILE, { create: true });
      const writable = await file.createWritable();
      await writable.write('ok');
      await writable.close();
      const readBack = await (await dir.getFileHandle(WRITE_TEST_FILE)).getFile();
      const text = await readBack.text();
      await dir.removeEntry(WRITE_TEST_FILE);
      data.writeTest = { readBack: text, matches: text === 'ok', milliseconds: Math.round(performance.now() - started) };
    }

    const summary = data.hasIpodControl
      ? `Chrome can read "${dir.name}" and it looks like an iPod (iPod_Control found).`
      : `Chrome can read "${dir.name}", but there is no iPod_Control folder in it.`;
    return { ok: true, summary, data, at: now() };
  } catch (error) {
    return { ok: false, summary: describeError(error), data: { folderName: dir.name }, at: now() };
  }
}
