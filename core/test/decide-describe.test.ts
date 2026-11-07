import { describe, expect, it } from 'vitest';
import { decideForDevice, describeDecision, estimateOutputBytes, fitVideoSize } from '../src/index';
import type { ConversionSpec, MediaInfo, PlanDecision } from '../src/media/types';
import { audioFile, info, nano, videoFile } from './media-fixtures';

describe('describeDecision', () => {
  const flac = audioFile('flac', { codec: 'flac', bitDepth: 16, bitrateKbps: null });

  it('says "Copy as it is" for a copy', () => {
    const file = audioFile('mp3', { codec: 'mp3' });
    expect(describeDecision(decideForDevice(file, nano), file)).toBe('Copy as it is');
  });

  const cases: Array<[string, MediaInfo, Parameters<typeof decideForDevice>[2], string]> = [
    [
      'a 96 kHz file',
      audioFile('m4a', { codec: 'aac', sampleRateHz: 96000 }),
      undefined,
      'Convert to AAC 256 kbps (the sample rate is 96 kHz and the iPod stops at 48 kHz)',
    ],
    ['a mono 96 kHz file', audioFile('m4a', { codec: 'aac', sampleRateHz: 96000, channels: 1 }), undefined, 'Convert to AAC 128 kbps mono (the sample rate is 96 kHz and the iPod stops at 48 kHz)'],
    ['a FLAC file', flac, undefined, "Convert to AAC 256 kbps (the audio is FLAC, which is not on this iPod's list of formats it plays)"],
    ['a FLAC file, lossless', flac, { lossless: true }, "Convert to Apple Lossless (the audio is FLAC, which is not on this iPod's list of formats it plays)"],
    ['a 24-bit WAV', audioFile('wav', { codec: 'pcm', bitDepth: 24, bitrateKbps: null }), undefined, 'Convert to AAC 256 kbps (the audio is 24-bit and the iPod plays up to 16-bit)'],
    ['a 5.1 file', audioFile('m4a', { codec: 'aac', channels: 6, sampleRateHz: 48000 }), undefined, 'Convert to AAC 256 kbps (the sound has 6 channels and the iPod plays stereo)'],
    ['an HEVC video', videoFile({ codec: 'hevc', profile: 'Main', level: '4.0', width: 1920, height: 1080 }), undefined, 'Convert to H.264 640x360 at up to 1500 kbps (the video is HEVC (H.265), which this iPod does not play)'],
    ['a 60 fps video', videoFile({ fps: 60 }), { videoBitrateKbps: 1200 }, 'Convert to H.264 640x480 at up to 1200 kbps (the video runs at 60 frames per second and the iPod stops at 30)'],
  ];
  it.each(cases)('describes %s', (_name, file, options, expected) => {
    expect(describeDecision(decideForDevice(file, nano, options), file)).toBe(expected);
  });

  it('starts an unsupported description with "Not supported" and the main reason', () => {
    const book = info({ fileName: 'book.pdf', container: 'unknown' });
    const text = describeDecision(decideForDevice(book, nano), book);
    expect(text.startsWith('Not supported: the iPod nano (7th generation) has no Notes or book reader')).toBe(true);
    expect(text.endsWith('.')).toBe(false);

    const protectedFile = audioFile('m4a', { codec: 'aac' }, { protected: true });
    expect(describeDecision(decideForDevice(protectedFile, nano), protectedFile)).toBe(
      'Not supported: This file is copy-protected (DRM), so OpenTunes can neither read it nor convert it, and it cannot be put on the iPod',
    );
  });

  it('is one line with no line breaks, for every kind of decision above', () => {
    for (const [, file, options] of cases) {
      expect(describeDecision(decideForDevice(file, nano, options), file)).not.toMatch(/\n/);
    }
  });

  describe('when a decision carries no reasons, it works the cause out from the file and the plan', () => {
    const spec = (change: Partial<ConversionSpec>): ConversionSpec => ({
      container: 'm4a',
      audio: { codec: 'aac', bitrateKbps: 256, sampleRateHz: 48000, channels: 2 },
      video: null,
      keepChapters: false,
      keepArtwork: true,
      keepTags: true,
      ...change,
    });
    const plan = (conversion: ConversionSpec | null, action: PlanDecision['action'] = 'convert'): PlanDecision => ({
      action,
      reasons: [],
      kind: 'music',
      conversion,
      outputExtension: '.m4a',
    });

    it('names a lowered sample rate', () => {
      expect(describeDecision(plan(spec({})), audioFile('m4a', { codec: 'aac', sampleRateHz: 96000 }))).toBe(
        'Convert to AAC 256 kbps (the sample rate is 96 kHz and it is lowered to 48 kHz)',
      );
    });
    it('names a mix down to stereo', () => {
      expect(describeDecision(plan(spec({})), audioFile('m4a', { codec: 'aac', sampleRateHz: 48000, channels: 6 }))).toBe(
        'Convert to AAC 256 kbps (the sound has 6 channels and it is mixed down to stereo)',
      );
    });
    it('names a scaled picture', () => {
      const video = spec({
        container: 'm4v',
        audio: null,
        video: { codec: 'h264', profile: 'baseline', level: '3.0', maxWidth: 640, maxHeight: 360, maxFps: 30, maxBitrateKbps: 1500 },
      });
      expect(describeDecision(plan(video), videoFile({ width: 1280, height: 720 }))).toBe(
        'Convert to H.264 640x360 at up to 1500 kbps (the picture is 1280x720 and it is scaled down to fit)',
      );
    });
    it('gives just the target when there is nothing to name', () => {
      expect(describeDecision(plan(spec({})), audioFile('flac', { codec: 'flac', sampleRateHz: 44100 }))).toBe('Convert to AAC 256 kbps');
      expect(describeDecision(plan(spec({ audio: { codec: 'alac', sampleRateHz: 44100, channels: 2, bitDepth: 16 } })), audioFile('flac', { codec: 'flac' }))).toBe('Convert to Apple Lossless');
      expect(describeDecision(plan(null), audioFile('flac', { codec: 'flac' }))).toBe('Convert');
    });
    it('handles an unsupported decision with no reasons', () => {
      expect(describeDecision(plan(null, 'unsupported'), audioFile('flac', { codec: 'flac' }))).toBe('Not supported');
    });
  });
});

describe('estimateOutputBytes', () => {
  const artwork = { mime: 'image/jpeg', data: new Uint8Array(1234) };

  it('is the file size for a copy', () => {
    const file = audioFile('mp3', { codec: 'mp3' }, { sizeBytes: 7_654_321 });
    expect(estimateOutputBytes(file, decideForDevice(file, nano))).toBe(7_654_321);
  });

  it('is null for a file that is not added', () => {
    const file = audioFile('m4a', { codec: 'aac' }, { protected: true });
    expect(estimateOutputBytes(file, decideForDevice(file, nano))).toBeNull();
  });

  it('is bitrate times length for AAC, plus the artwork', () => {
    const file = audioFile('flac', { codec: 'flac', bitDepth: 16, bitrateKbps: null }, { durationMs: 200_000 });
    expect(estimateOutputBytes(file, decideForDevice(file, nano))).toBe((256 * 1000 * 200) / 8);
    const withArt = { ...file, artwork };
    expect(estimateOutputBytes(withArt, decideForDevice(withArt, nano))).toBe((256 * 1000 * 200) / 8 + 1234);
  });

  it('halves the bitrate for mono and follows the person\'s bitrate', () => {
    const mono = audioFile('flac', { codec: 'flac', channels: 1, bitDepth: 16, bitrateKbps: null }, { durationMs: 200_000 });
    expect(estimateOutputBytes(mono, decideForDevice(mono, nano))).toBe((128 * 1000 * 200) / 8);
    expect(estimateOutputBytes(mono, decideForDevice(mono, nano, { audioBitrateKbps: 192 }))).toBe((192 * 1000 * 200) / 8);
  });

  it('uses a rough share of the raw size for Apple Lossless, at the planned rate and depth', () => {
    const file = audioFile('flac', { codec: 'flac', bitDepth: 24, sampleRateHz: 96000, bitrateKbps: null }, { durationMs: 100_000 });
    const decision = decideForDevice(file, nano, { lossless: true });
    expect(estimateOutputBytes(file, decision)).toBe(Math.round((48000 * 16 * 2 * 100 * 0.6) / 8));
  });

  it('uses the lower of the cap and the source video bitrate, plus the sound track', () => {
    const fast = videoFile({ fps: 60, bitrateKbps: 9000 });
    expect(estimateOutputBytes(fast, decideForDevice(fast, nano))).toBe(((1500 + 128) * 1000 * 600) / 8);
    const slow = videoFile({ fps: 60, bitrateKbps: 800 });
    expect(estimateOutputBytes(slow, decideForDevice(slow, nano))).toBe(((800 + 128) * 1000 * 600) / 8);
  });

  it('uses the cap when the source video bitrate is not known, and leaves out a missing sound track', () => {
    const unknown = videoFile({ fps: 60, bitrateKbps: null });
    expect(estimateOutputBytes(unknown, decideForDevice(unknown, nano))).toBe(((1500 + 128) * 1000 * 600) / 8);
    const silent = videoFile({ fps: 60 }, null);
    expect(estimateOutputBytes(silent, decideForDevice(silent, nano))).toBe((1000 * 1000 * 600) / 8);
  });

  it('follows the video bitrate option', () => {
    const file = videoFile({ fps: 60, bitrateKbps: 9000 });
    expect(estimateOutputBytes(file, decideForDevice(file, nano, { videoBitrateKbps: 3000 }))).toBe(((3000 + 128) * 1000 * 600) / 8);
  });

  it('is null when the length is not known', () => {
    const audio = audioFile('flac', { codec: 'flac', bitDepth: 16, bitrateKbps: null }, { durationMs: null });
    expect(estimateOutputBytes(audio, decideForDevice(audio, nano))).toBeNull();
    const video = videoFile({ fps: 60 }, {}, { durationMs: null });
    expect(estimateOutputBytes(video, decideForDevice(video, nano))).toBeNull();
  });

  it('is null for a plan that carries no way to work it out', () => {
    const file = audioFile('flac', { codec: 'flac' });
    const base: PlanDecision = { action: 'convert', reasons: ['x.'], kind: 'music', conversion: null, outputExtension: '.m4a' };
    expect(estimateOutputBytes(file, base)).toBeNull();
    const noBitrate: PlanDecision = {
      ...base,
      conversion: { container: 'm4a', audio: { codec: 'aac' }, video: null, keepChapters: false, keepArtwork: true, keepTags: true },
    };
    expect(estimateOutputBytes(file, noBitrate)).toBeNull();
    const nothing: PlanDecision = { ...base, conversion: { container: 'm4a', audio: null, video: null, keepChapters: false, keepArtwork: true, keepTags: true } };
    expect(estimateOutputBytes(file, nothing)).toBeNull();
  });

  it('gives a converted file a smaller estimate than a lossless original', () => {
    const file = audioFile('flac', { codec: 'flac', bitDepth: 16, bitrateKbps: null }, { sizeBytes: 30_000_000, durationMs: 200_000 });
    expect(estimateOutputBytes(file, decideForDevice(file, nano))!).toBeLessThan(file.sizeBytes);
  });
});

describe('fitVideoSize', () => {
  it.each([
    [1280, 720, 640, 480, 640, 360],
    [1920, 1080, 640, 480, 640, 360],
    [1080, 1920, 640, 480, 270, 480],
    [320, 240, 640, 480, 320, 240],
    [641, 481, 640, 480, 638, 480],
    [853, 480, 640, 480, 640, 360],
    [720, 576, 640, 480, 600, 480],
    [640, 480, 640, 480, 640, 480],
    [333, 111, 640, 480, 332, 110],
    [0, 0, 640, 480, 640, 480],
    [-5, 10, 640, 480, 640, 480],
    [1280, 720, 481, 321, 480, 270],
    [4000, 10, 640, 480, 640, 2],
  ])('fits %sx%s into %sx%s as %sx%s', (width, height, boxWidth, boxHeight, outWidth, outHeight) => {
    expect(fitVideoSize(width, height, boxWidth, boxHeight)).toEqual({ width: outWidth, height: outHeight });
  });

  it('always gives even sides inside the box, never scales up, and keeps the shape', () => {
    const failures: string[] = [];
    const sizes = [1, 2, 3, 16, 99, 100, 101, 160, 241, 320, 479, 480, 481, 640, 641, 719, 720, 721, 853, 1080, 1280, 1920, 3840, 4001, 7680];
    const boxes: Array<[number, number]> = [
      [640, 480],
      [720, 576],
      [480, 320],
      [641, 481],
      [320, 240],
      [10, 10],
      [1920, 1080],
    ];
    for (const width of sizes) {
      for (const height of sizes) {
        for (const [boxWidth, boxHeight] of boxes) {
          const fitted = fitVideoSize(width, height, boxWidth, boxHeight);
          const evenBoxWidth = Math.floor(boxWidth / 2) * 2;
          const evenBoxHeight = Math.floor(boxHeight / 2) * 2;
          const where = `${width}x${height} into ${boxWidth}x${boxHeight} gave ${fitted.width}x${fitted.height}`;
          if (fitted.width % 2 !== 0 || fitted.height % 2 !== 0) failures.push(`odd: ${where}`);
          if (fitted.width < 2 || fitted.height < 2) failures.push(`too small: ${where}`);
          if (fitted.width > evenBoxWidth || fitted.height > evenBoxHeight) failures.push(`outside the box: ${where}`);
          if (fitted.width > Math.max(2, width) || fitted.height > Math.max(2, height)) failures.push(`scaled up: ${where}`);
          // The shape holds when neither side was squeezed down to the 2 pixel minimum and both sides are big enough for rounding to be small.
          if (Math.min(width, height) >= 100 && fitted.width >= 50 && fitted.height >= 50) {
            const before = width / height;
            const after = fitted.width / fitted.height;
            if (Math.abs(after - before) / before > 0.05) failures.push(`shape changed: ${where}`);
          }
        }
      }
    }
    expect(failures.slice(0, 10)).toEqual([]);
  });
});
