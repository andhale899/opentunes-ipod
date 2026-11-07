import { describe, expect, it } from 'vitest';
import { devices, getDevice } from '../src/devices/registry';

describe('device registry', () => {
  it('has unique kebab-case ids', () => {
    const ids = devices.map((device) => device.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it('demands a dated https source for every spec-sourced model', () => {
    for (const device of devices.filter((model) => model.verification === 'spec-sourced')) {
      expect(device.sources.length, `${device.id} needs a source`).toBeGreaterThan(0);
      for (const source of device.sources) {
        expect(source.url).toMatch(/^https:\/\//);
        expect(source.retrieved).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
  });

  it('does not mark any model hardware-tested until a run is recorded', () => {
    expect(devices.filter((device) => device.verification === 'hardware-tested')).toEqual([]);
  });

  it('keeps capability data off models that are still unverified', () => {
    for (const device of devices.filter((model) => model.verification === 'unverified')) {
      expect(device.media, `${device.id} should not carry unsourced limits`).toBeNull();
      expect(device.checksum).toBeNull();
    }
  });

  it('uses the shuffle database format for shuffles only', () => {
    for (const device of devices) {
      expect(device.databaseFormat === 'iTunesSD').toBe(device.family === 'shuffle');
    }
  });

  it('covers the models the project targets', () => {
    for (const id of ['nano-7g', 'ipod-classic-7g', 'ipod-video-5g', 'shuffle-4g']) {
      expect(getDevice(id), id).toBeDefined();
    }
    expect(getDevice('does-not-exist')).toBeUndefined();
  });
});

describe('nano 7G row', () => {
  const nano = getDevice('nano-7g');

  it('matches the published Apple specification', () => {
    expect(nano?.verification).toBe('spec-sourced');
    expect(nano?.connector).toBe('lightning');

    const h264 = nano?.media?.video?.formats?.find((format) => format.codec === 'h264');
    expect(h264).toMatchObject({ maxWidth: 720, maxHeight: 576, maxFps: 30, level: '3.0' });
    expect(h264?.profiles).toEqual(['Baseline', 'Main', 'High']);
    expect(h264?.maxVideoBitrateKbps).toBeUndefined();

    const mpeg4 = nano?.media?.video?.formats?.find((format) => format.codec === 'mpeg4');
    expect(mpeg4?.maxVideoBitrateKbps).toBe(2500);
  });

  it('records photos as not listed rather than supported', () => {
    expect(nano?.media?.photo?.status).toBe('not-listed');
  });

  it('flags its checksum as inferred, not sourced', () => {
    expect(nano?.checksum).toBe('hashAB');
    expect(nano?.checksumBasis).toMatch(/Inferred/);
  });
});
