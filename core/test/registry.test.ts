import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

describe('USB product ids', () => {
  it('are Apple iPod ids, and the nano 7G has the one seen on hardware', () => {
    for (const device of devices) {
      for (const id of device.usbProductIds ?? []) {
        expect(id, device.id).toBeGreaterThanOrEqual(0x1200);
        expect(id, device.id).toBeLessThanOrEqual(0x13ff);
      }
    }
    expect(getDevice('nano-7g')?.usbProductIds).toEqual([0x1267]);
  });

  it('are not claimed by two models that differ in family, except where one id covers both', () => {
    const owners = new Map<number, string[]>();
    for (const device of devices) {
      for (const id of device.usbProductIds ?? []) owners.set(id, [...(owners.get(id) ?? []), device.family]);
    }
    for (const [id, families] of owners) {
      expect(new Set(families).size, `0x${id.toString(16)} is shared across families`).toBe(1);
    }
  });
});

describe('observations from real units', () => {
  it('are dated and say who saw them', () => {
    const observations = devices.flatMap((device) => device.observed ?? []);
    expect(observations.length).toBeGreaterThan(0);
    for (const observation of observations) {
      expect(observation.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(observation.source).not.toBe('');
      expect(observation.facts.length).toBeGreaterThan(0);
    }
  });

  it('never contain a serial number or FireWire ID', () => {
    const text = JSON.stringify(devices.flatMap((device) => device.observed ?? []));
    expect(text).not.toMatch(/\b[0-9A-Fa-f]{16}\b/);
    expect(text).not.toMatch(/serial(?!\s+number string)/i);
  });
});

describe('nano 7G row', () => {
  const nano = getDevice('nano-7g');

  it('matches the published Apple specification', () => {
    expect(nano?.verification).toBe('spec-sourced');
    expect(nano?.connector).toBe('lightning');

    const [h264, h264Baseline] = (nano?.media?.video?.formats ?? []).filter((format) => format.codec === 'h264');
    expect(h264).toMatchObject({ maxWidth: 720, maxHeight: 576, maxFps: 30, level: '3.0' });
    expect(h264?.profiles).toEqual(['Baseline', 'Main', 'High']);

    const mpeg4 = nano?.media?.video?.formats?.find((format) => format.codec === 'mpeg4');
    expect(mpeg4?.maxVideoBitrateKbps).toBe(2500);

    // The device also lists a Baseline-only H.264 entry capped at 640x480. That size is
    // inside both entries, so it is the safe default for the planner.
    expect(h264Baseline).toMatchObject({ profiles: ['Baseline'], maxWidth: 640, maxHeight: 480 });
  });

  it('caps audio at 48 kHz and lossless at 16 bits, as the device declares', () => {
    const formats = nano?.media?.music?.formats ?? [];
    for (const codec of ['AAC', 'MP3', 'Apple Lossless', 'AIFF', 'WAV']) {
      expect(formats.find((format) => format.codec === codec)?.maxSampleRateHz, codec).toBe(48000);
    }
    expect(formats.find((format) => format.codec === 'Apple Lossless')?.maxBitDepth).toBe(16);
  });

  it('records photos and podcasts as supported on the device, not on the spec page', () => {
    expect(nano?.media?.photo?.status).toBe('supported');
    expect(nano?.media?.photo?.note).toMatch(/Not on Apple's page/);
    expect(nano?.media?.podcast?.status).toBe('supported');
    expect(nano?.deviceDeclared?.images?.photo).toEqual([
      { id: 1007, width: 480, height: 864, pixelFormat: 'L565' },
      { id: 1005, width: 80, height: 80, pixelFormat: 'L565' },
    ]);
  });

  it('records the disk format and limits the device declares', () => {
    expect(nano?.deviceDeclared).toMatchObject({ volumeFormat: 'FAT32', maxTracks: 65534, maxFileSizeGB: 4 });
    expect(nano?.deviceDeclared?.images?.albumArt?.map((format) => format.id)).toEqual([1010, 1011, 1013, 1015, 1016]);
  });

  it('points at a device file that really is in the repository', () => {
    const source = nano?.deviceDeclared?.source ?? '';
    const path = fileURLToPath(new URL(`../../${source}`, import.meta.url));
    expect(source).not.toBe('');
    expect(existsSync(path), path).toBe(true);
  });

  it('bases its checksum on the device declaration, and has not been written to hardware', () => {
    expect(nano?.checksum).toBe('hashAB');
    expect(nano?.checksumBasis).toMatch(/database version 5/);
    expect(nano?.checksumBasis).toMatch(/Not yet confirmed/);
    expect(nano?.verification).not.toBe('hardware-tested');
  });
});
