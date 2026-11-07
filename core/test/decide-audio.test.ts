import { describe, expect, it } from 'vitest';
import { decideForDevice, type DecideOptions } from '../src/index';
import type { AudioTarget, MediaInfo } from '../src/media/types';
import { audioFile, audioOnly44, cloneDevice, expectPlainReasons, nano, said } from './media-fixtures';

describe('audio the nano plays as it is is copied', () => {
  const cases: Array<[string, MediaInfo, string]> = [
    ['MP3 44.1 kHz 192 kbps', audioFile('mp3', { codec: 'mp3' }), '.mp3'],
    ['MP3 48 kHz 320 kbps (the top of the range)', audioFile('mp3', { codec: 'mp3', sampleRateHz: 48000, bitrateKbps: 320 }), '.mp3'],
    ['MP3 8 kbps (the bottom of the range)', audioFile('mp3', { codec: 'mp3', sampleRateHz: 22050, bitrateKbps: 8, channels: 1 }), '.mp3'],
    ['variable bitrate MP3', audioFile('mp3', { codec: 'mp3', variableBitrate: true, bitrateKbps: 245 }), '.mp3'],
    ['MP3 with no stated bitrate and no length to work it out', audioFile('mp3', { codec: 'mp3', bitrateKbps: null }, { durationMs: null }), '.mp3'],
    ['MP3 with no stated bitrate but a size and length that give about 200 kbps', audioFile('mp3', { codec: 'mp3', bitrateKbps: null }, { sizeBytes: 5_000_000, durationMs: 200_000 }), '.mp3'],
    ['AAC-LC in m4a 256 kbps', audioFile('m4a', { codec: 'aac', sampleRateHz: 48000, bitrateKbps: 256 }), '.m4a'],
    ['AAC-LC in m4b', audioFile('m4b', { codec: 'aac' }), '.m4b'],
    ['AAC-LC in an audio-only mp4', audioFile('mp4', { codec: 'aac' }), '.m4a'],
    ['Apple Lossless 16-bit 44.1 kHz', audioFile('m4a', { codec: 'alac', bitDepth: 16, bitrateKbps: null }), '.m4a'],
    ['Apple Lossless 16-bit 48 kHz', audioFile('m4a', { codec: 'alac', bitDepth: 16, sampleRateHz: 48000, bitrateKbps: null }), '.m4a'],
    ['WAV 16-bit 44.1 kHz', audioFile('wav', { codec: 'pcm', bitDepth: 16, bitrateKbps: 1411 }), '.wav'],
    ['AIFF 16-bit 48 kHz', audioFile('aiff', { codec: 'pcm', bitDepth: 16, sampleRateHz: 48000, bitrateKbps: 1536 }), '.aif'],
    ['WAV with no stated bit depth', audioFile('wav', { codec: 'pcm', bitrateKbps: null }), '.wav'],
  ];
  it.each(cases)('%s', (_name, file, extension) => {
    const decision = decideForDevice(file, nano);
    expect(decision.action).toBe('copy');
    expect(decision.conversion).toBeNull();
    expect(decision.outputExtension).toBe(extension);
    // An m4b is an audiobook by its wrapper alone, and everything else in this table is music.
    expect(decision.kind).toBe(file.container === 'm4b' ? 'audiobook' : 'music');
    expectPlainReasons(decision);
  });
});

interface Expected {
  codec: AudioTarget['codec'];
  bitrateKbps?: number;
  sampleRateHz: number;
  channels: 1 | 2;
  bitDepth?: number;
}

describe('audio the nano cannot play as it is is converted', () => {
  const aac = (sampleRateHz: number, channels: 1 | 2 = 2, bitrateKbps = channels === 1 ? 128 : 256): Expected => ({ codec: 'aac', bitrateKbps, sampleRateHz, channels });

  const cases: Array<[string, MediaInfo, Expected, string]> = [
    // Sample rate above the limit, by rate. The 44.1 family drops to 44.1 and the 48 family to 48.
    ['AAC at 96 kHz', audioFile('m4a', { codec: 'aac', sampleRateHz: 96000 }), aac(48000), 'sample rate'],
    ['AAC at 88.2 kHz', audioFile('m4a', { codec: 'aac', sampleRateHz: 88200 }), aac(44100), 'sample rate'],
    ['AAC at 192 kHz', audioFile('m4a', { codec: 'aac', sampleRateHz: 192000 }), aac(48000), 'sample rate'],
    ['AAC at 176.4 kHz', audioFile('m4a', { codec: 'aac', sampleRateHz: 176400 }), aac(44100), 'sample rate'],
    ['AAC at 64 kHz', audioFile('m4a', { codec: 'aac', sampleRateHz: 64000 }), aac(48000), 'sample rate'],
    ['MP3 at 96 kHz', audioFile('mp3', { codec: 'mp3', sampleRateHz: 96000 }), aac(48000), 'sample rate'],
    // Bit depth above the limit.
    ['Apple Lossless 24-bit 44.1 kHz', audioFile('m4a', { codec: 'alac', bitDepth: 24, bitrateKbps: null }), aac(44100), '24-bit'],
    ['WAV 24-bit 96 kHz', audioFile('wav', { codec: 'pcm', bitDepth: 24, sampleRateHz: 96000, bitrateKbps: null }), aac(48000), '24-bit'],
    ['AIFF 24-bit 48 kHz', audioFile('aiff', { codec: 'pcm', bitDepth: 24, sampleRateHz: 48000, bitrateKbps: null }), aac(48000), '24-bit'],
    ['WAV 32-bit', audioFile('wav', { codec: 'pcm', bitDepth: 32, bitrateKbps: null }), aac(44100), '32-bit'],
    // Formats the model lacks.
    ['FLAC 16-bit 44.1 kHz', audioFile('flac', { codec: 'flac', bitDepth: 16, bitrateKbps: null }), aac(44100), 'FLAC'],
    ['FLAC 24-bit 96 kHz', audioFile('flac', { codec: 'flac', bitDepth: 24, sampleRateHz: 96000, bitrateKbps: null }), aac(48000), 'FLAC'],
    ['Ogg Vorbis', audioFile('ogg', { codec: 'vorbis' }), aac(44100), 'Ogg Vorbis'],
    ['Opus at 48 kHz', audioFile('opus', { codec: 'opus', sampleRateHz: 48000 }), aac(48000), 'Opus'],
    ['WMA', audioFile('wma', { codec: 'wma' }), aac(44100), 'WMA'],
    ['AC-3 in an MKV', audioFile('mkv', { codec: 'ac3', sampleRateHz: 48000, channels: 6 }), aac(48000), 'AC-3'],
    ['E-AC-3 in an MKV', audioFile('mkv', { codec: 'eac3', sampleRateHz: 48000, channels: 6 }), aac(48000), 'E-AC-3'],
    ['DTS in an MKV', audioFile('mkv', { codec: 'dts', sampleRateHz: 48000, channels: 6 }), aac(48000), 'DTS'],
    ['audio the probe could not name', audioFile('mkv', { codec: 'unknown', sampleRateHz: 48000 }), aac(48000), 'could not identify'],
    // Bitrate outside the range.
    ['MP3 at 640 kbps', audioFile('mp3', { codec: 'mp3', bitrateKbps: 640 }), aac(44100), '640 kbps'],
    ['MP3 at 321 kbps', audioFile('mp3', { codec: 'mp3', bitrateKbps: 321 }), aac(44100), '321 kbps'],
    ['MP3 at 6 kbps', audioFile('mp3', { codec: 'mp3', bitrateKbps: 6, sampleRateHz: 8000, channels: 1 }), aac(8000, 1), '6 kbps'],
    ['AAC at 512 kbps', audioFile('m4a', { codec: 'aac', bitrateKbps: 512 }), aac(44100), '512 kbps'],
    // Wrapped in a way the iPod does not take as it is.
    ['a bare AAC stream', audioFile('aac', { codec: 'aac' }), aac(44100), '.aac'],
    ['audio in a .mov', audioFile('mov', { codec: 'aac' }), aac(44100), '.mov'],
    ['MP3 inside an m4a wrapper', audioFile('m4a', { codec: 'mp3' }), aac(44100), '.m4a'],
    // Channels.
    ['AAC 5.1', audioFile('m4a', { codec: 'aac', channels: 6, sampleRateHz: 48000 }), aac(48000), '6 channels'],
    ['FLAC 5.1', audioFile('flac', { codec: 'flac', channels: 6, bitDepth: 16, bitrateKbps: null }), aac(44100), 'FLAC'],
    // Mono stays mono, at a lower bitrate.
    ['mono FLAC', audioFile('flac', { codec: 'flac', channels: 1, bitDepth: 16, bitrateKbps: null }), aac(44100, 1), 'FLAC'],
    ['mono AAC at 96 kHz', audioFile('m4a', { codec: 'aac', channels: 1, sampleRateHz: 96000 }), aac(48000, 1), 'sample rate'],
    // A rate the encoder does not know is snapped to one it does.
    ['an odd 37.8 kHz FLAC', audioFile('flac', { codec: 'flac', sampleRateHz: 37800, bitDepth: 16, bitrateKbps: null }), aac(32000), 'FLAC'],
  ];

  it.each(cases)('%s', (_name, file, expected, mention) => {
    const decision = decideForDevice(file, nano);
    expect(decision.action).toBe('convert');
    expect(decision.outputExtension).toBe('.m4a');
    expect(decision.conversion).toEqual({
      container: 'm4a',
      audio: expected,
      video: null,
      keepChapters: false,
      keepArtwork: true,
      keepTags: true,
    });
    expectPlainReasons(decision);
    expect(said(decision)).toContain(mention);
  });

  it('says the sample rate and the limit in the first reason, in plain words', () => {
    const decision = decideForDevice(audioFile('m4a', { codec: 'aac', sampleRateHz: 96000 }), nano);
    expect(decision.reasons[0]).toBe('The sample rate is 96 kHz and the iPod stops at 48 kHz.');
  });

  it('turns a file with 5.1 sound into stereo and says so', () => {
    const decision = decideForDevice(audioFile('m4a', { codec: 'aac', channels: 6, sampleRateHz: 48000 }), nano);
    expect(decision.conversion?.audio?.channels).toBe(2);
    expect(decision.reasons[0]).toBe('The sound has 6 channels and the iPod plays stereo.');
  });
});

describe('the lossless option', () => {
  const lossless: DecideOptions = { lossless: true };
  const alac = (sampleRateHz: number, channels: 1 | 2 = 2, bitDepth = 16): Expected => ({ codec: 'alac', sampleRateHz, channels, bitDepth });

  const cases: Array<[string, MediaInfo, Expected]> = [
    ['FLAC 16-bit 44.1 kHz', audioFile('flac', { codec: 'flac', bitDepth: 16, bitrateKbps: null }), alac(44100)],
    ['FLAC 24-bit 96 kHz', audioFile('flac', { codec: 'flac', bitDepth: 24, sampleRateHz: 96000, bitrateKbps: null }), alac(48000)],
    ['FLAC 24-bit 88.2 kHz', audioFile('flac', { codec: 'flac', bitDepth: 24, sampleRateHz: 88200, bitrateKbps: null }), alac(44100)],
    ['FLAC with no stated depth', audioFile('flac', { codec: 'flac', bitrateKbps: null }), alac(44100)],
    ['Apple Lossless 24-bit 96 kHz', audioFile('m4a', { codec: 'alac', bitDepth: 24, sampleRateHz: 96000, bitrateKbps: null }), alac(48000)],
    ['WAV 24-bit 48 kHz', audioFile('wav', { codec: 'pcm', bitDepth: 24, sampleRateHz: 48000, bitrateKbps: null }), alac(48000)],
    ['AIFF 32-bit 44.1 kHz', audioFile('aiff', { codec: 'pcm', bitDepth: 32, bitrateKbps: null }), alac(44100)],
    ['mono FLAC', audioFile('flac', { codec: 'flac', channels: 1, bitDepth: 16, bitrateKbps: null }), alac(44100, 1)],
    ['FLAC 5.1', audioFile('flac', { codec: 'flac', channels: 6, bitDepth: 24, bitrateKbps: null }), alac(44100)],
  ];
  it.each(cases)('%s becomes Apple Lossless within the limits', (_name, file, expected) => {
    const decision = decideForDevice(file, nano, lossless);
    expect(decision.action).toBe('convert');
    expect(decision.conversion?.audio).toEqual(expected);
    expect(decision.conversion?.container).toBe('m4a');
    expect(decision.outputExtension).toBe('.m4a');
    expectPlainReasons(decision);
    expect(said(decision)).toContain('Apple Lossless');
  });

  it('keeps lossless files that already fit as a copy', () => {
    const file = audioFile('m4a', { codec: 'alac', bitDepth: 16, bitrateKbps: null });
    expect(decideForDevice(file, nano, lossless).action).toBe('copy');
  });

  it('leaves lossy sources on AAC', () => {
    for (const file of [
      audioFile('opus', { codec: 'opus', sampleRateHz: 48000 }),
      audioFile('ogg', { codec: 'vorbis' }),
      audioFile('wma', { codec: 'wma' }),
      audioFile('mp3', { codec: 'mp3', bitrateKbps: 640 }),
    ]) {
      expect(decideForDevice(file, nano, lossless).conversion?.audio?.codec, file.fileName).toBe('aac');
    }
  });

  it('falls back to AAC, and says so, when the model does not list Apple Lossless', () => {
    const noAlac = cloneDevice('test-no-alac', (device) => {
      device.media!.music!.formats = device.media!.music!.formats!.filter((format) => format.codec !== 'Apple Lossless');
    });
    const decision = decideForDevice(audioFile('flac', { codec: 'flac', bitDepth: 16, bitrateKbps: null }), noAlac, lossless);
    expect(decision.conversion?.audio?.codec).toBe('aac');
    expect(said(decision)).toContain('Apple Lossless is not on this iPod');
    expectPlainReasons(decision);
  });

  it('uses Apple Lossless, and says so, when the model lists it but no AAC', () => {
    const onlyAlac = cloneDevice('test-only-alac', (device) => {
      device.media!.music!.formats = device.media!.music!.formats!.filter((format) => format.codec === 'Apple Lossless');
    });
    const decision = decideForDevice(audioFile('flac', { codec: 'flac', bitDepth: 24, sampleRateHz: 96000, bitrateKbps: null }), onlyAlac);
    expect(decision.conversion?.audio).toEqual(alac(48000));
    expect(said(decision)).toContain('AAC is not on this iPod');
  });

  it('reports unsupported when the model lists neither AAC nor Apple Lossless', () => {
    const onlyMp3 = cloneDevice('test-only-mp3', (device) => {
      device.media!.music!.formats = device.media!.music!.formats!.filter((format) => format.codec === 'MP3');
    });
    const decision = decideForDevice(audioFile('flac', { codec: 'flac', bitDepth: 16, bitrateKbps: null }), onlyMp3);
    expect(decision.action).toBe('unsupported');
    expect(said(decision)).toContain('only AAC and Apple Lossless');
    expectPlainReasons(decision);
    // The same model still copies a file it plays.
    expect(decideForDevice(audioFile('mp3', { codec: 'mp3' }), onlyMp3).action).toBe('copy');
  });
});

describe('the audio bitrate option', () => {
  const file = audioFile('flac', { codec: 'flac', bitDepth: 16, bitrateKbps: null });
  const mono = audioFile('flac', { codec: 'flac', channels: 1, bitDepth: 16, bitrateKbps: null });

  it.each([
    [192, 192],
    [320, 320],
    [1000, 320],
    [1, 8],
    [0, 256],
    [-5, 256],
    [Number.NaN, 256],
    [Number.POSITIVE_INFINITY, 256],
  ])('asking for %s kbps gives %s on the nano (range 8 to 320)', (asked, given) => {
    expect(decideForDevice(file, nano, { audioBitrateKbps: asked }).conversion?.audio?.bitrateKbps).toBe(given);
  });

  it('applies the person\'s number to mono too', () => {
    expect(decideForDevice(mono, nano, { audioBitrateKbps: 192 }).conversion?.audio?.bitrateKbps).toBe(192);
  });

  it('clamps to the range of the model it is planning for', () => {
    expect(decideForDevice(file, audioOnly44, { audioBitrateKbps: 320 }).conversion?.audio?.bitrateKbps).toBe(256);
    expect(decideForDevice(file, audioOnly44, { audioBitrateKbps: 8 }).conversion?.audio?.bitrateKbps).toBe(16);
  });
});

describe('HE-AAC', () => {
  const heAac = audioFile('m4a', { codec: 'he-aac', bitrateKbps: 64 });

  it('converts to AAC-LC on the nano, because its registry row carries a caution, and quotes the caution', () => {
    const decision = decideForDevice(heAac, nano);
    expect(decision.action).toBe('convert');
    expect(decision.conversion?.audio?.codec).toBe('aac');
    expect(said(decision)).toContain("Listed on Apple's page. The device's own list names AAC-LC only.");
    expect(said(decision)).toContain('AAC-LC');
    expectPlainReasons(decision);
  });

  it('copies when the registry lists HE-AAC plainly, with no caution', () => {
    const plain = cloneDevice('test-plain-heaac', (device) => {
      const row = device.media!.music!.formats!.find((format) => format.codec === 'HE-AAC')!;
      delete row.note;
    });
    const decision = decideForDevice(heAac, plain);
    expect(decision.action).toBe('copy');
    expect(decision.outputExtension).toBe('.m4a');
  });

  it('converts when the model does not list HE-AAC at all, and says it is not on the list', () => {
    const none = cloneDevice('test-no-heaac', (device) => {
      device.media!.music!.formats = device.media!.music!.formats!.filter((format) => format.codec !== 'HE-AAC');
    });
    const decision = decideForDevice(heAac, none);
    expect(decision.action).toBe('convert');
    expect(said(decision)).toContain('not on this iPod\'s list');
  });

  it('still applies the other limits to HE-AAC that the registry lists plainly', () => {
    const plain = cloneDevice('test-plain-heaac-2', (device) => {
      const row = device.media!.music!.formats!.find((format) => format.codec === 'HE-AAC')!;
      delete row.note;
      row.maxSampleRateHz = 44100;
    });
    expect(decideForDevice(audioFile('m4a', { codec: 'he-aac', sampleRateHz: 48000, bitrateKbps: 64 }), plain).action).toBe('convert');
  });
});

describe('protected files', () => {
  it.each([
    ['an iTunes Store AAC', audioFile('m4a', { codec: 'aac' }, { protected: true })],
    ['an Audible book', audioFile('m4b', { codec: 'aac' }, { protected: true })],
    ['a protected video', audioFile('m4v', { codec: 'aac' }, { protected: true, video: { codec: 'h264', width: 640, height: 480, fps: 30, bitrateKbps: 1000 } })],
  ])('%s is unsupported, and the registry listing Protected AAC does not change that', (_name, file) => {
    const decision = decideForDevice(file, nano);
    expect(decision.action).toBe('unsupported');
    expect(decision.conversion).toBeNull();
    expect(decision.outputExtension).toBe('');
    expect(said(decision)).toContain('copy-protected');
    expectPlainReasons(decision);
  });
});

describe('the planner reads the registry, not nano numbers', () => {
  it('uses a 44.1 kHz ceiling when the model has one', () => {
    const cases: Array<[string, MediaInfo, 'copy' | 'convert', number?]> = [
      ['MP3 44.1 kHz', audioFile('mp3', { codec: 'mp3' }), 'copy'],
      ['MP3 48 kHz', audioFile('mp3', { codec: 'mp3', sampleRateHz: 48000 }), 'convert', 44100],
      ['AAC 96 kHz', audioFile('m4a', { codec: 'aac', sampleRateHz: 96000 }), 'convert', 44100],
      ['AAC 88.2 kHz', audioFile('m4a', { codec: 'aac', sampleRateHz: 88200 }), 'convert', 44100],
      ['AAC 192 kHz', audioFile('m4a', { codec: 'aac', sampleRateHz: 192000 }), 'convert', 44100],
      ['Apple Lossless 48 kHz', audioFile('m4a', { codec: 'alac', bitDepth: 16, sampleRateHz: 48000, bitrateKbps: null }), 'convert', 44100],
    ];
    for (const [name, file, action, rate] of cases) {
      const decision = decideForDevice(file, audioOnly44);
      expect(decision.action, name).toBe(action);
      if (rate) expect(decision.conversion?.audio?.sampleRateHz, name).toBe(rate);
      // The same file is judged differently by the real nano row.
    }
    expect(decideForDevice(audioFile('mp3', { codec: 'mp3', sampleRateHz: 48000 }), nano).action).toBe('copy');
    expect(decideForDevice(audioFile('mp3', { codec: 'mp3', sampleRateHz: 48000 }), audioOnly44).reasons[0]).toBe('The sample rate is 48 kHz and the iPod stops at 44.1 kHz.');
  });

  it('writes lossless within the other model\'s limits too', () => {
    const decision = decideForDevice(audioFile('flac', { codec: 'flac', bitDepth: 24, sampleRateHz: 96000, bitrateKbps: null }), audioOnly44, { lossless: true });
    expect(decision.conversion?.audio).toEqual({ codec: 'alac', sampleRateHz: 44100, channels: 2, bitDepth: 16 });
  });

  it('follows a changed bit depth limit', () => {
    const deeper = cloneDevice('test-24-bit', (device) => {
      for (const format of device.media!.music!.formats!) if (format.maxBitDepth !== undefined) format.maxBitDepth = 24;
    });
    const file = audioFile('m4a', { codec: 'alac', bitDepth: 24, bitrateKbps: null });
    expect(decideForDevice(file, nano).action).toBe('convert');
    expect(decideForDevice(file, deeper).action).toBe('copy');
    const flac = audioFile('flac', { codec: 'flac', bitDepth: 24, bitrateKbps: null });
    expect(decideForDevice(flac, deeper, { lossless: true }).conversion?.audio?.bitDepth).toBe(24);
    expect(decideForDevice(flac, nano, { lossless: true }).conversion?.audio?.bitDepth).toBe(16);
  });

  it('follows a changed bitrate range', () => {
    const narrow = cloneDevice('test-narrow-mp3', (device) => {
      device.media!.music!.formats!.find((format) => format.codec === 'MP3')!.bitrateKbps = { min: 32, max: 192 };
    });
    expect(decideForDevice(audioFile('mp3', { codec: 'mp3', bitrateKbps: 192 }), narrow).action).toBe('copy');
    expect(decideForDevice(audioFile('mp3', { codec: 'mp3', bitrateKbps: 256 }), narrow).action).toBe('convert');
    expect(decideForDevice(audioFile('mp3', { codec: 'mp3', bitrateKbps: 16 }), narrow).action).toBe('convert');
    expect(decideForDevice(audioFile('mp3', { codec: 'mp3', bitrateKbps: 256 }), nano).action).toBe('copy');
  });

  it('refuses a variable bitrate only where the registry says variable bitrate is off', () => {
    const cbr = cloneDevice('test-cbr-only', (device) => {
      device.media!.music!.formats!.find((format) => format.codec === 'MP3')!.variableBitrate = false;
    });
    const vbr = audioFile('mp3', { codec: 'mp3', variableBitrate: true, bitrateKbps: 200 });
    expect(decideForDevice(vbr, nano).action).toBe('copy');
    expect(decideForDevice(vbr, cbr).action).toBe('convert');
    expect(decideForDevice(audioFile('mp3', { codec: 'mp3', bitrateKbps: 200 }), cbr).action).toBe('copy');
  });

  it('copies a format only when the model lists it, whatever the format is', () => {
    const withFlac = cloneDevice('test-flac', (device) => {
      device.media!.music!.formats!.push({ codec: 'FLAC', maxSampleRateHz: 48000, maxBitDepth: 16 });
    });
    const flac = audioFile('flac', { codec: 'flac', bitDepth: 16, bitrateKbps: null });
    expect(decideForDevice(flac, nano).action).toBe('convert');
    const decision = decideForDevice(flac, withFlac);
    expect(decision.action).toBe('copy');
    expect(decision.outputExtension).toBe('.flac');
    expect(decideForDevice(audioFile('flac', { codec: 'flac', bitDepth: 24, bitrateKbps: null }), withFlac).action).toBe('convert');
  });

  it('refuses audio when the model lists no music, with the status in the words', () => {
    const noMusic = cloneDevice('test-no-music', (device) => {
      device.media!.music = { status: 'not-listed' };
    });
    const decision = decideForDevice(audioFile('mp3', { codec: 'mp3' }), noMusic);
    expect(decision.action).toBe('unsupported');
    expect(said(decision)).toContain('does not list music');
    const unresearched = cloneDevice('test-unresearched-music', (device) => {
      device.media!.music = { status: 'unknown' };
    });
    expect(said(decideForDevice(audioFile('mp3', { codec: 'mp3' }), unresearched))).toContain('has not confirmed');
  });
});
