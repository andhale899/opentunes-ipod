import { fireWireIdFromUsbSerial, modelsForUsbProductId, type DeviceModel } from '@opentunes/core';

const APPLE_VENDOR_ID = 0x05ac;

interface UsbDeviceLike {
  productName?: string;
  serialNumber?: string;
  vendorId: number;
  productId: number;
}

interface UsbApi {
  requestDevice(options: { filters: { vendorId: number }[] }): Promise<UsbDeviceLike>;
}

export interface ConnectResult {
  ok: boolean;
  /** One plain sentence for the person. */
  summary: string;
  productId: number | null;
  productName: string | null;
  /** The registry models with this USB product id. Empty when none, and several when they share an id. */
  models: DeviceModel[];
  /** From the USB serial number string. Null if it was not readable or not a FireWire ID. */
  fireWireId: string | null;
}

/**
 * Asks Chrome for an Apple USB device and reads what WebUSB gives without opening it: the product
 * id, which names the model, and the serial number string, which is the FireWire ID. Must run
 * straight from a click. Reads only, and nothing is sent anywhere.
 */
export async function connectIpod(): Promise<ConnectResult> {
  const empty: ConnectResult = { ok: false, summary: '', productId: null, productName: null, models: [], fireWireId: null };
  const usb = (navigator as unknown as { usb?: UsbApi }).usb;
  if (!usb) return { ...empty, summary: 'WebUSB is not available in this browser, so the iPod cannot be identified over USB.' };

  let device: UsbDeviceLike;
  try {
    device = await usb.requestDevice({ filters: [{ vendorId: APPLE_VENDOR_ID }] });
  } catch (error) {
    const cancelled = error instanceof DOMException && (error.name === 'NotFoundError' || error.name === 'AbortError');
    return { ...empty, summary: cancelled ? 'No iPod was chosen.' : error instanceof Error ? error.message : String(error) };
  }

  const models = modelsForUsbProductId(device.productId);
  const identity = fireWireIdFromUsbSerial(device.serialNumber);
  const name = models.length === 1 ? (models[0] as DeviceModel).name : models.length > 1 ? `one of ${models.length} models that share this USB id` : 'a model this app does not know';
  return {
    ok: identity.fireWireId !== null,
    summary: identity.fireWireId ? `Found ${name}.` : `Found ${name}, but ${identity.problem ?? 'its ID could not be read.'}`,
    productId: device.productId,
    productName: device.productName ?? null,
    models,
    fireWireId: identity.fireWireId,
  };
}
