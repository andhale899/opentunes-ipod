/**
 * Working out which iPod is plugged in from what WebUSB can read without opening it: the USB
 * product id and the serial number string, which on an iPod is its FireWire ID.
 */

import { devices } from './registry';
import type { DeviceModel } from './types';

/** Every model whose USB product id is this one. Several can share one, so the answer is a list. */
export function modelsForUsbProductId(productId: number): DeviceModel[] {
  return devices.filter((model) => model.usbProductIds?.includes(productId));
}

export interface UsbIdentity {
  /** 16 hex digits in capitals, or null when the serial string is not a FireWire ID. */
  fireWireId: string | null;
  /** A plain sentence when the serial is missing or not usable, or null. */
  problem: string | null;
}

/** Reads an iPod's FireWire ID out of its USB serial number string, with or without a 0x in front. */
export function fireWireIdFromUsbSerial(serial: string | null | undefined): UsbIdentity {
  const text = (serial ?? '').trim().replace(/^0x/i, '');
  if (text === '') {
    return { fireWireId: null, problem: 'The iPod did not give a serial number over USB, so its FireWire ID cannot be read this way.' };
  }
  if (!/^[0-9a-f]{16}$/i.test(text)) {
    return { fireWireId: null, problem: 'The serial number the iPod gave over USB is not a 16-digit FireWire ID, so it cannot be used to sign the database.' };
  }
  return { fireWireId: text.toUpperCase(), problem: null };
}
