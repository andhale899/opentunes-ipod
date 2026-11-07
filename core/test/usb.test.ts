import { describe, expect, it } from 'vitest';
import { fireWireIdFromUsbSerial, getDevice, modelsForUsbProductId } from '../src';

describe('modelsForUsbProductId', () => {
  it('finds the nano 7th generation by its USB product id', () => {
    const models = modelsForUsbProductId(0x1267);
    expect(models.map((model) => model.id)).toContain('nano-7g');
    expect(models.every((model) => model.usbProductIds?.includes(0x1267))).toBe(true);
  });

  it('returns nothing for an id no model has', () => {
    expect(modelsForUsbProductId(0xffff)).toEqual([]);
  });

  it('agrees with the registry rows', () => {
    for (const id of getDevice('nano-7g')?.usbProductIds ?? []) {
      expect(modelsForUsbProductId(id).some((model) => model.id === 'nano-7g')).toBe(true);
    }
  });
});

describe('fireWireIdFromUsbSerial', () => {
  it('accepts 16 hex digits, with or without 0x, and gives capitals', () => {
    expect(fireWireIdFromUsbSerial('0123456789abcdef')).toEqual({ fireWireId: '0123456789ABCDEF', problem: null });
    expect(fireWireIdFromUsbSerial('0x0123456789ABCDEF')).toEqual({ fireWireId: '0123456789ABCDEF', problem: null });
    expect(fireWireIdFromUsbSerial('  0123456789ABCDEF ').fireWireId).toBe('0123456789ABCDEF');
  });

  it('explains a missing or unusable serial number', () => {
    for (const bad of [undefined, null, '', '   ']) {
      expect(fireWireIdFromUsbSerial(bad).fireWireId).toBeNull();
      expect(fireWireIdFromUsbSerial(bad).problem).toMatch(/did not give a serial number/);
    }
    for (const bad of ['12345', 'XYZXYZXYZXYZXYZX', '0123456789ABCDE', '0123456789ABCDEF0']) {
      const result = fireWireIdFromUsbSerial(bad);
      expect(result.fireWireId).toBeNull();
      expect(result.problem).toMatch(/not a 16-digit FireWire ID/);
    }
  });
});
