import { describe, expect, it } from 'vitest';
import { decideForDevice, type DecideOptions } from '../src/index';
import type { AudioTarget, MediaInfo, VideoTarget } from '../src/media/types';
import { audioOnly44, cloneDevice, expectPlainReasons, info, nano, said, smallVideo, videoFile } from './media-fixtures';

describe('video the nano plays as it is is copied', () => {
  const cases: Array<[string, MediaInfo, string]> = [
    ['Baseline 640x480 30 fps with AAC-LC stereo in .m4v', videoFile(), '.m4v'],
    ['the same in .mp4', videoFile({}, {}, { container: 'mp4', fileName: 'clip.mp4' }), '.mp4'],
    ['the same in .mov', videoFile({}, {}, { container: 'mov', fileName: 'clip.mov' }), '.mov'],
    ['a picture with no sound', videoFile({}, null), '.m4v'],
    ['High profile 720x576 at level 3.0 (fits the first listed row)', videoFile({ profile: 'High', width: 720, height: 576, bitrateKbps: 4000 }), '.m4v'],
    ['Main profile 720x480', videoFile({ profile: 'Main', width: 720, height: 480 }), '.m4v'],
    ['Constrained Baseline is Baseline', videoFile({ profile: 'Constrained Baseline' }), '.m4v'],
    ['a small 320x240 picture', videoFile({ width: 320, height: 240 }), '.m4v'],
    ['641x481 Baseline, over 640x480 but inside the first row\'s 720x576', videoFile({ width: 641, height: 481 }), '.m4v'],
    ['29.97 frames per second', videoFile({ fps: 29.97 }), '.m4v'],
    ['30.0001 frames per second (rounding noise)', videoFile({ fps: 30.0001 }), '.m4v'],
    ['video bitrate right at the 10000 kbps limit', videoFile({ bitrateKbps: 10000, profile: 'High', width: 720, height: 576 }), '.m4v'],
    ['AAC at the top of the sound limits: 256 kbps, 48 kHz, stereo', videoFile({}, { bitrateKbps: 256, sampleRateHz: 48000 }), '.m4v'],
    ['mono AAC at 44.1 kHz (inside the stereo limit)', videoFile({}, { channels: 1, sampleRateHz: 44100 }), '.m4v'],
    ['a video bitrate the file does not state, worked out from its size and length', videoFile({ bitrateKbps: null }), '.m4v'],
    [
      'MPEG-4 Simple at 720x576 and 2000 kbps (the third listed row)',
      videoFile({ codec: 'mpeg4', profile: 'Simple', level: undefined, width: 720, height: 576, fps: 25, bitrateKbps: 2000 }),
      '.m4v',
    ],
  ];
  it.each(cases)('%s', (_name, file, extension) => {
    const decision = decideForDevice(file, nano);
    expect(decision.action).toBe('copy');
    expect(decision.conversion).toBeNull();
    expect(decision.outputExtension).toBe(extension);
    expect(decision.kind).toBe('movie');
    expectPlainReasons(decision);
    expect(said(decision)).toContain('copied without changes');
  });
});

interface VideoExpected {
  maxWidth: number;
  maxHeight: number;
  maxFps?: number;
  maxBitrateKbps?: number;
}

function baselineTarget(expected: VideoExpected): VideoTarget {
  return { codec: 'h264', profile: 'baseline', level: '3.0', maxFps: 30, maxBitrateKbps: 1500, ...expected };
}

const stereoAac = (sampleRateHz = 48000, bitrateKbps = 128, channels: 1 | 2 = 2): AudioTarget => ({ codec: 'aac', bitrateKbps, sampleRateHz, channels });

describe('video the nano cannot play as it is is converted to the Baseline 640x480 row', () => {
  const cases: Array<[string, MediaInfo, VideoExpected, AudioTarget | null, string]> = [
    // Size: the shape is kept and both sides are even.
    ['1280x720 High at level 3.1', videoFile({ profile: 'High', level: '3.1', width: 1280, height: 720, bitrateKbps: 3000 }), { maxWidth: 640, maxHeight: 360 }, stereoAac(), 'level is 3.1'],
    ['1920x1080 at 24 fps', videoFile({ profile: 'High', level: '4.0', width: 1920, height: 1080, fps: 24, bitrateKbps: 8000 }), { maxWidth: 640, maxHeight: 360 }, stereoAac(), '1920x1080'],
    ['4K 3840x2160', videoFile({ profile: 'High', level: '5.1', width: 3840, height: 2160, bitrateKbps: 9000 }), { maxWidth: 640, maxHeight: 360 }, stereoAac(), '3840x2160'],
    ['a portrait phone video 1080x1920', videoFile({ profile: 'High', level: '4.0', width: 1080, height: 1920 }), { maxWidth: 270, maxHeight: 480 }, stereoAac(), '1080x1920'],
    ['a picture just over every listed size, 721x577', videoFile({ width: 721, height: 577 }), { maxWidth: 598, maxHeight: 480 }, stereoAac(), '721x577'],
    ['721x576 High (one pixel too wide for the first row)', videoFile({ profile: 'High', width: 721, height: 576 }), { maxWidth: 600, maxHeight: 480 }, stereoAac(), '721x576'],
    // Frame rate and video bitrate.
    ['60 frames per second', videoFile({ fps: 60 }), { maxWidth: 640, maxHeight: 480 }, stereoAac(), '60 frames per second'],
    ['30.5 frames per second', videoFile({ fps: 30.5 }), { maxWidth: 640, maxHeight: 480 }, stereoAac(), '30.5 frames per second'],
    ['a video bitrate of 10001 kbps', videoFile({ bitrateKbps: 10001 }), { maxWidth: 640, maxHeight: 480 }, stereoAac(), '10001 kbps'],
    // Codecs the model lacks.
    ['HEVC 1080p', videoFile({ codec: 'hevc', profile: 'Main', level: '4.0', width: 1920, height: 1080 }), { maxWidth: 640, maxHeight: 360 }, stereoAac(), 'HEVC'],
    ['VP9', videoFile({ codec: 'vp9', profile: undefined, level: undefined, width: 1280, height: 720 }, {}, { container: 'webm', fileName: 'clip.webm' }), { maxWidth: 640, maxHeight: 360 }, stereoAac(), 'VP9'],
    ['AV1', videoFile({ codec: 'av1', profile: undefined, level: undefined, width: 1280, height: 720 }, {}, { container: 'mp4', fileName: 'clip.mp4' }), { maxWidth: 640, maxHeight: 360 }, stereoAac(), 'AV1'],
    ['MPEG-2', videoFile({ codec: 'mpeg2', profile: undefined, level: undefined, width: 720, height: 480 }, {}, { container: 'mkv', fileName: 'clip.mkv' }), { maxWidth: 640, maxHeight: 426 }, stereoAac(), 'MPEG-2'],
    ['a codec the probe could not name', videoFile({ codec: 'unknown', profile: undefined, level: undefined }, {}, { container: 'avi', fileName: 'clip.avi' }), { maxWidth: 640, maxHeight: 480 }, stereoAac(), 'could not identify the video'],
    ['MPEG-4 over its 2500 kbps limit', videoFile({ codec: 'mpeg4', profile: 'Simple', level: undefined, width: 720, height: 576, fps: 25, bitrateKbps: 3000 }), { maxWidth: 600, maxHeight: 480 }, stereoAac(), '3000 kbps'],
    ['MPEG-4 Advanced Simple', videoFile({ codec: 'mpeg4', profile: 'Advanced Simple', level: undefined, width: 640, height: 480, fps: 25, bitrateKbps: 1000 }), { maxWidth: 640, maxHeight: 480 }, stereoAac(), 'Advanced Simple'],
    // Profile and level.
    ['H.264 High 10 profile', videoFile({ profile: 'High 10', width: 720, height: 576 }), { maxWidth: 600, maxHeight: 480 }, stereoAac(), 'High 10'],
    ['level 3.1 at a size that otherwise fits', videoFile({ level: '3.1' }), { maxWidth: 640, maxHeight: 480 }, stereoAac(), 'level is 3.1'],
    // The wrapper.
    ['H.264 Baseline in an MKV', videoFile({}, {}, { container: 'mkv', fileName: 'clip.mkv' }), { maxWidth: 640, maxHeight: 480 }, stereoAac(), '.mkv'],
    ['H.264 Baseline in an AVI', videoFile({}, {}, { container: 'avi', fileName: 'clip.avi' }), { maxWidth: 640, maxHeight: 480 }, stereoAac(), '.avi'],
    // Sound.
    ['5.1 AC-3 sound', videoFile({}, { codec: 'ac3', channels: 6, bitrateKbps: 448 }), { maxWidth: 640, maxHeight: 480 }, stereoAac(), '5.1 surround'],
    ['5.1 AAC sound', videoFile({}, { channels: 6, bitrateKbps: 384 }), { maxWidth: 640, maxHeight: 480 }, stereoAac(), '5.1 surround'],
    ['DTS sound', videoFile({}, { codec: 'dts', channels: 6, bitrateKbps: 768 }), { maxWidth: 640, maxHeight: 480 }, stereoAac(), 'DTS'],
    ['E-AC-3 sound', videoFile({}, { codec: 'eac3', channels: 6, bitrateKbps: 640 }), { maxWidth: 640, maxHeight: 480 }, stereoAac(), 'E-AC-3'],
    ['mono AC-3 sound stays mono', videoFile({}, { codec: 'ac3', channels: 1, bitrateKbps: 192 }), { maxWidth: 640, maxHeight: 480 }, stereoAac(48000, 64, 1), 'AC-3'],
    ['MP3 sound', videoFile({}, { codec: 'mp3', sampleRateHz: 44100, bitrateKbps: 192 }), { maxWidth: 640, maxHeight: 480 }, stereoAac(44100), 'MP3'],
    ['HE-AAC sound', videoFile({}, { codec: 'he-aac', sampleRateHz: 44100, bitrateKbps: 64 }), { maxWidth: 640, maxHeight: 480 }, stereoAac(44100), 'HE-AAC'],
    ['AAC sound at 96 kHz', videoFile({}, { sampleRateHz: 96000, bitrateKbps: 192 }), { maxWidth: 640, maxHeight: 480 }, stereoAac(48000), '96 kHz'],
    ['AAC sound at 88.2 kHz', videoFile({}, { sampleRateHz: 88200, bitrateKbps: 192 }), { maxWidth: 640, maxHeight: 480 }, stereoAac(44100), '88.2 kHz'],
    ['AAC sound at 320 kbps', videoFile({}, { bitrateKbps: 320 }), { maxWidth: 640, maxHeight: 480 }, stereoAac(48000, 128), '320 kbps'],
    // A picture with no sound converts without a sound track.
    ['a silent 60 fps clip', videoFile({ fps: 60 }, null), { maxWidth: 640, maxHeight: 480 }, null, '60 frames per second'],
    // Facts the file does not state: the safe answer is to convert.
    ['no stated profile', videoFile({ profile: undefined }), { maxWidth: 640, maxHeight: 480 }, stereoAac(), 'does not say which H.264 profile'],
    ['no stated level', videoFile({ level: undefined }), { maxWidth: 640, maxHeight: 480 }, stereoAac(), 'does not say its H.264 level'],
    ['no stated frame rate', videoFile({ fps: null }), { maxWidth: 640, maxHeight: 480 }, stereoAac(), 'does not say its frame rate'],
    ['no stated size', videoFile({ width: 0, height: 0 }), { maxWidth: 640, maxHeight: 480 }, stereoAac(), 'does not say how big'],
    ['no stated video bitrate and no length to work it out', videoFile({ bitrateKbps: null }, {}, { durationMs: null }), { maxWidth: 640, maxHeight: 480 }, stereoAac(), 'does not say its video bitrate'],
  ];

  it.each(cases)('%s', (_name, file, video, audio, mention) => {
    const decision = decideForDevice(file, nano);
    expect(decision.action).toBe('convert');
    expect(decision.outputExtension).toBe('.m4v');
    expect(decision.kind).toBe('movie');
    expect(decision.conversion).toEqual({
      container: 'm4v',
      audio,
      video: baselineTarget(video),
      keepChapters: false,
      keepArtwork: true,
      keepTags: true,
    });
    expectPlainReasons(decision);
    expect(said(decision)).toContain(mention);
  });

  it('keeps chapters when the video has them', () => {
    const decision = decideForDevice(videoFile({ fps: 60 }, {}, { chapters: [{ startMs: 0, title: 'Start' }] }), nano);
    expect(decision.conversion?.keepChapters).toBe(true);
  });

  it('explains a too-big picture with the figures in plain words, then says what it will do', () => {
    const decision = decideForDevice(videoFile({ profile: 'High', level: '3.0', width: 1280, height: 720 }), nano);
    expect(decision.reasons[0]).toBe('The picture is 1280x720 and the iPod stops at 720x576.');
    expect(decision.reasons[1]).toContain('converted to H.264 Baseline, 640x360');
  });
});

describe('the video options', () => {
  const big = videoFile({ profile: 'High', level: '4.0', width: 1920, height: 1080, bitrateKbps: 9000 });
  const bitrateOf = (options?: DecideOptions) => decideForDevice(big, nano, options).conversion?.video?.maxBitrateKbps;

  it.each([
    [undefined, 1500],
    [800, 800],
    [5000, 5000],
    [10000, 10000],
    [99999, 10000],
    [0, 1500],
    [-1, 1500],
    [Number.NaN, 1500],
  ])('a video bitrate of %s gives a cap of %s (the registry maximum is 10000)', (asked, given) => {
    expect(bitrateOf(asked === undefined ? {} : { videoBitrateKbps: asked })).toBe(given);
  });

  it('caps the sound at the registry limit and keeps the person\'s smaller number', () => {
    const withSound = (kbps: number) => decideForDevice(videoFile({ fps: 60 }, { codec: 'ac3', channels: 6 }), nano, { audioBitrateKbps: kbps }).conversion?.audio?.bitrateKbps;
    expect(withSound(192)).toBe(192);
    expect(withSound(999)).toBe(256);
    expect(withSound(0)).toBe(128);
  });
});

describe('the planner reads the registry for video, not nano numbers', () => {
  it('plans for the other model\'s only row', () => {
    const decision = decideForDevice(videoFile(), smallVideo);
    expect(decision.action).toBe('convert');
    expect(decision.conversion).toEqual({
      container: 'm4v',
      // 44.1 kHz and 128 kbps stereo come from the row's own sound text.
      audio: stereoAac(44100, 128),
      // Main profile, level 3.0, 25 fps, 1000 kbps. 640x480 fits into 480x320 as 426x320.
      video: { codec: 'h264', profile: 'main', level: '3.0', maxWidth: 426, maxHeight: 320, maxFps: 25, maxBitrateKbps: 1000 },
      keepChapters: false,
      keepArtwork: true,
      keepTags: true,
    });
    expect(decideForDevice(videoFile(), nano).action).toBe('copy');
  });

  it('copies what fits the other model and converts what only fits the nano', () => {
    const fits = videoFile({ profile: 'Main', width: 480, height: 320, fps: 25, bitrateKbps: 900 }, { sampleRateHz: 44100 });
    expect(decideForDevice(fits, smallVideo).action).toBe('copy');
    expect(decideForDevice(videoFile({ profile: 'Main', width: 480, height: 320, fps: 25, bitrateKbps: 900 }, { sampleRateHz: 44100 }, { container: 'mp4' }), smallVideo).action).toBe('convert');
    expect(decideForDevice(videoFile({ profile: 'Main', width: 480, height: 320, fps: 26 }, { sampleRateHz: 44100 }), smallVideo).action).toBe('convert');
    expect(decideForDevice(videoFile({ profile: 'Main', width: 480, height: 320, fps: 25, bitrateKbps: 1100 }, { sampleRateHz: 44100 }), smallVideo).action).toBe('convert');
    expect(decideForDevice(videoFile({ profile: 'Main', width: 480, height: 320, fps: 25, bitrateKbps: 900 }, { sampleRateHz: 48000 }), smallVideo).action).toBe('convert');
    expect(decideForDevice(videoFile({ profile: 'Main', width: 480, height: 320, fps: 25, bitrateKbps: 900 }, { sampleRateHz: 44100, bitrateKbps: 192 }), smallVideo).action).toBe('convert');
  });

  it('picks the safest H.264 row whatever order the registry lists them in', () => {
    const reversed = cloneDevice('test-reversed-rows', (device) => {
      device.media!.video!.formats!.reverse();
    });
    const file = videoFile({ profile: 'High', level: '4.0', width: 1920, height: 1080 });
    expect(decideForDevice(file, reversed).conversion).toEqual(decideForDevice(file, nano).conversion);
  });

  it('encodes with Main when that is the lowest profile a row lists', () => {
    const mainOnly = cloneDevice('test-main-high', (device) => {
      const first = device.media!.video!.formats![0]!;
      first.profiles = ['Main', 'High'];
      device.media!.video!.formats = [first];
    });
    const decision = decideForDevice(videoFile({ fps: 60 }), mainOnly);
    expect(decision.conversion?.video).toEqual({ codec: 'h264', profile: 'main', level: '3.0', maxWidth: 640, maxHeight: 480, maxFps: 30, maxBitrateKbps: 1500 });
  });

  it('skips a row that lists no profile the encoder can write', () => {
    const odd = cloneDevice('test-odd-rows', (device) => {
      const formats = device.media!.video!.formats!;
      formats.unshift({ ...formats[1]!, profiles: ['Extended'], maxWidth: 160, maxHeight: 120 });
    });
    expect(decideForDevice(videoFile({ fps: 60 }), odd).conversion?.video?.maxWidth).toBe(640);
  });

  it('applies the registry bitrate cap below the default when the row is lower', () => {
    const low = cloneDevice('test-low-bitrate', (device) => {
      for (const format of device.media!.video!.formats!) format.maxVideoBitrateKbps = 900;
    });
    expect(decideForDevice(videoFile({ fps: 60 }), low).conversion?.video?.maxBitrateKbps).toBe(900);
    expect(decideForDevice(videoFile({ fps: 60 }), low, { videoBitrateKbps: 5000 }).conversion?.video?.maxBitrateKbps).toBe(900);
  });

  it('adds no bitrate limit of its own when the registry states none, apart from the default cap', () => {
    const unstated = cloneDevice('test-no-bitrate', (device) => {
      for (const format of device.media!.video!.formats!) delete format.maxVideoBitrateKbps;
    });
    // A file with an enormous bitrate is not refused for it, and the unstated bitrate is never asked for.
    expect(decideForDevice(videoFile({ bitrateKbps: 50000 }), unstated).action).toBe('copy');
    expect(decideForDevice(videoFile({ bitrateKbps: null }, {}, { durationMs: null }), unstated).action).toBe('copy');
    expect(decideForDevice(videoFile({ fps: 60 }), unstated, { videoBitrateKbps: 30000 }).conversion?.video?.maxBitrateKbps).toBe(30000);
  });

  it('uses the fallback level when a row names none', () => {
    const noLevel = cloneDevice('test-no-level', (device) => {
      for (const format of device.media!.video!.formats!) delete format.level;
    });
    expect(decideForDevice(videoFile({ fps: 60 }), noLevel).conversion?.video?.level).toBe('3.0');
    expect(decideForDevice(videoFile({ level: undefined }), noLevel).action).toBe('copy');
  });

  it('refuses to convert when the model lists no H.264 row, but still copies a file that fits a listed row', () => {
    const mpeg4Only = cloneDevice('test-mpeg4-only', (device) => {
      device.media!.video!.formats = device.media!.video!.formats!.filter((format) => format.codec === 'mpeg4');
    });
    const decision = decideForDevice(videoFile({ fps: 60 }), mpeg4Only);
    expect(decision.action).toBe('unsupported');
    expect(said(decision)).toContain('only H.264');
    expectPlainReasons(decision);
    const mpeg4 = videoFile({ codec: 'mpeg4', profile: 'Simple', level: undefined, width: 640, height: 480, fps: 25, bitrateKbps: 1000 });
    expect(decideForDevice(mpeg4, mpeg4Only).action).toBe('copy');
  });

  it('reads the sound limits from the row text', () => {
    const tight = cloneDevice('test-tight-sound', (device) => {
      for (const format of device.media!.video!.formats!) format.audio = 'AAC-LC up to 96 kbps, 32 kHz, mono';
    });
    const decision = decideForDevice(videoFile({ fps: 60 }, { sampleRateHz: 48000, bitrateKbps: 128, channels: 2 }), tight);
    expect(decision.conversion?.audio).toEqual({ codec: 'aac', bitrateKbps: 64, sampleRateHz: 32000, channels: 1 });
    expect(said(decision)).toContain('mono');
  });
});

describe('video the model cannot take at all', () => {
  it.each([
    ['video is not listed', { status: 'not-listed' as const }, 'does not list video'],
    ['video was never researched', { status: 'unknown' as const }, 'has not confirmed'],
    ['video is listed with no rows', { status: 'supported' as const, formats: [] }, 'has not confirmed'],
  ])('refuses when %s', (_name, support, mention) => {
    const device = cloneDevice('test-no-video', (copy) => {
      copy.media!.video = support;
    });
    for (const file of [videoFile(), videoFile({ codec: 'hevc' }), videoFile({}, null)]) {
      const decision = decideForDevice(file, device);
      expect(decision.action).toBe('unsupported');
      expect(decision.conversion).toBeNull();
      expect(decision.outputExtension).toBe('');
      expect(said(decision)).toContain(mention);
      expectPlainReasons(decision);
    }
  });

  it('refuses video on the audio-only model but still plans its audio', () => {
    const decision = decideForDevice(videoFile(), audioOnly44);
    expect(decision.action).toBe('unsupported');
    expect(said(decision)).toContain('does not list video');
    expect(decideForDevice(info({ container: 'mp3', fileName: 'a.mp3', audio: { codec: 'mp3', sampleRateHz: 44100, channels: 2, bitrateKbps: 192 } }), audioOnly44).action).toBe('copy');
  });
});
