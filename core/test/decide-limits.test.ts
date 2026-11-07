import { describe, expect, it } from 'vitest';
import { decideForDevice, type DecideOptions } from '../src/index';
import type { AudioFormat, DeviceModel, VideoFormat } from '../src/devices/types';
import type { AudioStream, MediaContainer, MediaInfo, PlanDecision, VideoStream } from '../src/media/types';
import { audioFile, audioOnly44, nano, plainProblems, smallVideo, videoFile } from './media-fixtures';

/**
 * Property-style loops. They run the planner over many sample rates, bit depths, bitrates, sizes,
 * frame rates and wrappers, on more than one device row, and check two things against the registry
 * numbers read separately here:
 *
 *   1. Soundness: a conversion never asks for more than the registry allows, and a copy is only
 *      chosen for a file that really fits.
 *   2. No needless work: a file that fits is never converted.
 *
 * Failures are gathered and shown together (first ten), so one bad case does not hide the others.
 */

/* ------------------------------------------ audio ------------------------------------------ */

const AUDIO_ROW_NAME: Record<string, string> = { mp3: 'MP3', aac: 'AAC', alac: 'Apple Lossless' };

function musicRow(device: DeviceModel, name: string): AudioFormat | undefined {
  return device.media?.music?.formats?.find((format) => format.codec === name);
}

/** Whether the registry says an audio-only file plays as it is. Written separately from the planner. */
function audioPlaysAsIs(file: MediaInfo, device: DeviceModel): boolean {
  const audio = file.audio as AudioStream;
  let name: string | undefined;
  let wrapperOk = false;
  switch (audio.codec) {
    case 'mp3':
      name = 'MP3';
      wrapperOk = file.container === 'mp3';
      break;
    case 'aac':
      name = 'AAC';
      wrapperOk = file.container === 'm4a' || file.container === 'm4b' || file.container === 'mp4';
      break;
    case 'alac':
      name = 'Apple Lossless';
      wrapperOk = file.container === 'm4a' || file.container === 'm4b' || file.container === 'mp4';
      break;
    case 'pcm':
      name = file.container === 'aiff' ? 'AIFF' : 'WAV';
      wrapperOk = file.container === 'aiff' || file.container === 'wav';
      break;
    default:
      return false; // HE-AAC carries a caution on the nano, and every other codec is not listed
  }
  const row = musicRow(device, name);
  if (!row || !wrapperOk) return false;
  if (row.maxSampleRateHz !== undefined && audio.sampleRateHz > row.maxSampleRateHz) return false;
  if (row.maxBitDepth !== undefined && audio.bitDepth !== undefined && audio.bitDepth > row.maxBitDepth) return false;
  if (audio.channels > 2) return false;
  if (row.bitrateKbps) {
    const bitrate = audio.bitrateKbps ?? (file.sizeBytes * 8) / (file.durationMs as number);
    if (bitrate < row.bitrateKbps.min || bitrate > row.bitrateKbps.max) return false;
  }
  return true;
}

describe('audio decisions stay inside the registry, on every sample', () => {
  const rates = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 37800, 44100, 48000, 50000, 64000, 88200, 96000, 176400, 192000, 352800, 384000];
  const codecs: Array<{ container: MediaContainer; codec: AudioStream['codec'] }> = [
    { container: 'mp3', codec: 'mp3' },
    { container: 'm4a', codec: 'aac' },
    { container: 'm4b', codec: 'aac' },
    { container: 'm4a', codec: 'he-aac' },
    { container: 'm4a', codec: 'alac' },
    { container: 'wav', codec: 'pcm' },
    { container: 'aiff', codec: 'pcm' },
    { container: 'flac', codec: 'flac' },
    { container: 'ogg', codec: 'vorbis' },
    { container: 'opus', codec: 'opus' },
    { container: 'wma', codec: 'wma' },
    { container: 'mkv', codec: 'ac3' },
  ];
  const depths = [undefined, 16, 24, 32];
  const bitrates = [null, 8, 320, 321];
  const channelCounts = [1, 2, 6];
  const optionSets: DecideOptions[] = [{}, { lossless: true }, { audioBitrateKbps: 5000 }];
  const devices = [nano, audioOnly44];

  it('never exceeds a registry limit, never copies what does not fit, never converts what does', () => {
    const failures: string[] = [];
    let decisions = 0;
    let copies = 0;
    let conversions = 0;

    for (const device of devices) {
      for (const { container, codec } of codecs) {
        for (const rate of rates) {
          for (const depth of depths) {
            for (const bitrate of bitrates) {
              for (const channels of channelCounts) {
                const file = audioFile(container, { codec, sampleRateHz: rate, bitDepth: depth, bitrateKbps: bitrate, channels });
                const lossless = codec === 'alac' || codec === 'flac' || codec === 'pcm';
                for (const options of optionSets) {
                  decisions += 1;
                  const decision = decideForDevice(file, device, options);
                  const where = `${device.id} ${container}/${codec} ${rate} Hz ${depth ?? '?'}-bit ${bitrate ?? '?'} kbps ${channels}ch ${JSON.stringify(options)}`;

                  const problems = plainProblems(decision);
                  if (problems.length > 0) failures.push(`${where}: reasons ${problems[0]}`);
                  if (decision.action === 'unsupported') {
                    failures.push(`${where}: unsupported on a model that lists AAC`);
                    continue;
                  }

                  const fits = audioPlaysAsIs(file, device);
                  if (decision.action === 'copy') {
                    copies += 1;
                    if (!fits) failures.push(`${where}: copied but does not fit`);
                    if (decision.conversion !== null || decision.outputExtension === '') failures.push(`${where}: a copy has a spec or no extension`);
                    continue;
                  }

                  conversions += 1;
                  if (fits) failures.push(`${where}: converted but already fits`);
                  const spec = decision.conversion;
                  const audio = spec?.audio;
                  if (!spec || !audio || spec.video !== null) {
                    failures.push(`${where}: conversion has no audio target`);
                    continue;
                  }
                  // An m4b wrapper means an audiobook, written as m4b, but only where the model lists audiobooks.
                  // Elsewhere it falls back to music, which is m4a. Everything that is not an m4b is m4a.
                  const wanted = container === 'm4b' && device.media?.audiobook?.status === 'supported' ? 'm4b' : 'm4a';
                  if (spec.container !== wanted || decision.outputExtension !== `.${wanted}`) failures.push(`${where}: wrong container ${spec.container}`);
                  const row = musicRow(device, AUDIO_ROW_NAME[audio.codec] as string);
                  if (!row) {
                    failures.push(`${where}: target ${audio.codec} is not a row of ${device.id}`);
                    continue;
                  }
                  if (audio.codec === 'alac' && !(options.lossless && lossless)) failures.push(`${where}: Apple Lossless chosen for a source or option that does not ask for it`);
                  if (audio.sampleRateHz === undefined || audio.sampleRateHz < 8000) failures.push(`${where}: bad rate ${audio.sampleRateHz}`);
                  else {
                    if (row.maxSampleRateHz !== undefined && audio.sampleRateHz > row.maxSampleRateHz) failures.push(`${where}: rate ${audio.sampleRateHz} above ${row.maxSampleRateHz}`);
                    if (audio.sampleRateHz > rate) failures.push(`${where}: rate ${audio.sampleRateHz} above the source ${rate}`);
                  }
                  if (audio.channels !== 1 && audio.channels !== 2) failures.push(`${where}: channels ${audio.channels}`);
                  if (audio.channels === 1 && channels !== 1) failures.push(`${where}: made mono from ${channels} channels`);
                  if (channels === 1 && audio.channels !== 1) failures.push(`${where}: mono did not stay mono`);
                  if (audio.codec === 'aac') {
                    if (audio.bitrateKbps === undefined) failures.push(`${where}: no bitrate`);
                    else if (row.bitrateKbps && (audio.bitrateKbps < row.bitrateKbps.min || audio.bitrateKbps > row.bitrateKbps.max)) {
                      failures.push(`${where}: bitrate ${audio.bitrateKbps} outside ${row.bitrateKbps.min}-${row.bitrateKbps.max}`);
                    }
                    if (audio.bitDepth !== undefined) failures.push(`${where}: AAC with a bit depth`);
                  } else {
                    if (audio.bitDepth === undefined) failures.push(`${where}: Apple Lossless with no bit depth`);
                    else if (row.maxBitDepth !== undefined && audio.bitDepth > row.maxBitDepth) failures.push(`${where}: depth ${audio.bitDepth} above ${row.maxBitDepth}`);
                  }
                }
              }
            }
          }
        }
      }
    }

    expect(failures.slice(0, 10)).toEqual([]);
    // The loop really did cover both outcomes, in numbers.
    expect(decisions).toBeGreaterThan(50_000);
    expect(copies).toBeGreaterThan(500);
    expect(conversions).toBeGreaterThan(10_000);
  });
});

/* ------------------------------------------ video ------------------------------------------ */

/** Sound limits for the made-up video rows, as the registry text states them. */
const SOUND_LIMITS: Record<string, { rate: number; kbps: number }> = {
  'nano-7g': { rate: 48000, kbps: 256 },
  'test-video-small': { rate: 44100, kbps: 128 },
};

function normalizedProfile(profile: string | undefined): string | undefined {
  const text = profile?.trim().toLowerCase();
  return text === 'constrained baseline' ? 'baseline' : text;
}

function averageKbps(file: MediaInfo): number | null {
  return file.durationMs ? (file.sizeBytes * 8) / file.durationMs : null;
}

/** Whether the registry says a video plays as it is, with every fact known. Written separately from the planner. */
function videoPlaysAsIs(file: MediaInfo, device: DeviceModel): boolean {
  const video = file.video as VideoStream;
  const audio = file.audio;
  const sound = SOUND_LIMITS[device.id] as { rate: number; kbps: number };
  return (device.media?.video?.formats ?? []).some((row: VideoFormat) => {
    if (video.codec !== row.codec) return false;
    const profile = normalizedProfile(video.profile);
    if (!profile || !row.profiles.map((name) => name.toLowerCase()).includes(profile)) return false;
    if (row.level !== undefined) {
      if (!video.level || Number.parseFloat(video.level) > Number.parseFloat(row.level)) return false;
    }
    if (!(video.width > 0) || !(video.height > 0) || video.width > row.maxWidth || video.height > row.maxHeight) return false;
    if (video.fps === null || !(video.fps > 0) || video.fps > row.maxFps + 0.01) return false;
    if (row.maxVideoBitrateKbps !== undefined) {
      const average = averageKbps(file);
      const bitrate = video.bitrateKbps ?? (average === null ? null : average - (audio?.bitrateKbps ?? 0));
      if (bitrate === null || bitrate > row.maxVideoBitrateKbps) return false;
    }
    if (!row.containers.map((name) => name.replace('.', '')).includes(file.container)) return false;
    if (audio) {
      if (audio.codec !== 'aac' || audio.channels > 2) return false;
      if (audio.sampleRateHz > sound.rate) return false;
      if (audio.bitrateKbps !== null && audio.bitrateKbps > sound.kbps) return false;
    }
    return true;
  });
}

function checkVideoDecision(file: MediaInfo, device: DeviceModel, decision: PlanDecision, where: string, failures: string[]): void {
  const problems = plainProblems(decision);
  if (problems.length > 0) failures.push(`${where}: reasons ${problems[0]}`);
  if (decision.action === 'unsupported') {
    failures.push(`${where}: unsupported on a model with an H.264 row`);
    return;
  }
  const fits = videoPlaysAsIs(file, device);
  if (decision.action === 'copy') {
    if (!fits) failures.push(`${where}: copied but does not fit`);
    if (decision.conversion !== null || decision.outputExtension !== `.${file.container}`) failures.push(`${where}: a copy has a spec or the wrong extension`);
    return;
  }

  if (fits) failures.push(`${where}: converted but already fits`);
  const spec = decision.conversion;
  const video = file.video as VideoStream;
  if (!spec || !spec.video) {
    failures.push(`${where}: conversion has no video target`);
    return;
  }
  const target = spec.video;
  if (spec.container !== 'm4v' || decision.outputExtension !== '.m4v') failures.push(`${where}: wrong container ${spec.container}`);

  // The target must sit inside at least one listed H.264 row, with that row's profile and level.
  const row = (device.media?.video?.formats ?? []).find(
    (candidate) =>
      candidate.codec === 'h264' &&
      candidate.profiles.map((name) => name.toLowerCase()).includes(target.profile) &&
      (candidate.level ?? '3.0') === target.level &&
      target.maxWidth <= candidate.maxWidth &&
      target.maxHeight <= candidate.maxHeight &&
      target.maxFps <= candidate.maxFps &&
      target.maxBitrateKbps <= (candidate.maxVideoBitrateKbps ?? Number.POSITIVE_INFINITY),
  );
  if (!row) failures.push(`${where}: target ${JSON.stringify(target)} is inside no listed H.264 row`);
  if (target.maxWidth % 2 !== 0 || target.maxHeight % 2 !== 0 || target.maxWidth < 2 || target.maxHeight < 2) failures.push(`${where}: odd or tiny size ${target.maxWidth}x${target.maxHeight}`);
  if (target.maxBitrateKbps < 1) failures.push(`${where}: bitrate cap ${target.maxBitrateKbps}`);
  if (video.width > 0 && video.height > 0) {
    if (target.maxWidth > Math.max(2, video.width) || target.maxHeight > Math.max(2, video.height)) failures.push(`${where}: scaled up to ${target.maxWidth}x${target.maxHeight}`);
    if (Math.min(video.width, video.height) >= 100 && target.maxWidth >= 50 && target.maxHeight >= 50) {
      const before = video.width / video.height;
      const after = target.maxWidth / target.maxHeight;
      if (Math.abs(after - before) / before > 0.05) failures.push(`${where}: shape changed to ${target.maxWidth}x${target.maxHeight}`);
    }
  }

  const sound = SOUND_LIMITS[device.id] as { rate: number; kbps: number };
  if (file.audio === null) {
    if (spec.audio !== null) failures.push(`${where}: sound track invented`);
  } else if (!spec.audio) {
    failures.push(`${where}: sound track dropped`);
  } else {
    if (spec.audio.codec !== 'aac') failures.push(`${where}: sound is ${spec.audio.codec}`);
    if (spec.audio.channels !== 1 && spec.audio.channels !== 2) failures.push(`${where}: sound channels ${spec.audio.channels}`);
    if (file.audio.channels === 1 && spec.audio.channels !== 1) failures.push(`${where}: mono sound did not stay mono`);
    if ((spec.audio.sampleRateHz ?? 0) < 8000 || (spec.audio.sampleRateHz ?? 0) > sound.rate) failures.push(`${where}: sound rate ${spec.audio.sampleRateHz}`);
    if ((spec.audio.bitrateKbps ?? 0) < 1 || (spec.audio.bitrateKbps ?? 0) > sound.kbps) failures.push(`${where}: sound bitrate ${spec.audio.bitrateKbps}`);
  }
}

describe('video decisions stay inside the registry, on every sample', () => {
  const sizes: Array<[number, number]> = [
    [0, 0], [1, 1], [16, 16], [160, 120], [320, 240], [480, 320], [640, 480], [641, 481], [720, 480], [720, 576],
    [721, 577], [853, 480], [1280, 720], [1920, 1080], [3840, 2160], [481, 853], [1080, 1920], [5000, 100], [100, 5000], [7680, 4320],
  ];
  const fpsValues = [null, 0, 10, 23.976, 24, 25, 29.97, 30, 30.0001, 31, 50, 59.94, 60, 240];
  const bitrates = [null, 100, 1500, 2500, 2501, 9999, 10000, 10001, 80000];
  const profiles = ['Baseline', 'Constrained Baseline', 'Main', 'High', 'High 10', undefined];
  const levels = ['3.0', '3.1', '4.0', undefined, '3.0'];
  const codecs: VideoStream['codec'][] = ['h264', 'h264', 'h264', 'mpeg4', 'hevc', 'vp9', 'h264'];
  const containers: MediaContainer[] = ['m4v', 'mp4', 'mov', 'mkv', 'avi', 'm4v'];
  const sounds: Array<Partial<AudioStream> | null> = [
    {},
    { codec: 'ac3', channels: 6, bitrateKbps: 448 },
    { sampleRateHz: 96000, bitrateKbps: 320 },
    null,
    { sampleRateHz: 44100, channels: 1, bitrateKbps: 64 },
    { codec: 'he-aac', sampleRateHz: 44100, bitrateKbps: 64 },
    { sampleRateHz: 44100, bitrateKbps: null },
  ];
  const devices = [nano, smallVideo];

  function build(size: [number, number], fps: number | null, bitrate: number | null, index: number): MediaInfo {
    const container = containers[index % containers.length] as MediaContainer;
    return videoFile(
      {
        codec: codecs[index % codecs.length] as VideoStream['codec'],
        profile: profiles[index % profiles.length],
        level: levels[index % levels.length],
        width: size[0],
        height: size[1],
        fps,
        bitrateKbps: bitrate,
      },
      sounds[index % sounds.length] as Partial<AudioStream> | null,
      { container, fileName: `clip.${container}` },
    );
  }

  it('over sizes, frame rates and bitrates, never exceeds a limit and never copies what does not fit', () => {
    const failures: string[] = [];
    let index = 0;
    let copies = 0;
    let conversions = 0;
    for (const device of devices) {
      for (const size of sizes) {
        for (const fps of fpsValues) {
          for (const bitrate of bitrates) {
            index += 1;
            const file = build(size, fps, bitrate, index);
            const decision = decideForDevice(file, device);
            if (decision.action === 'copy') copies += 1;
            if (decision.action === 'convert') conversions += 1;
            checkVideoDecision(file, device, decision, `${device.id} ${size[0]}x${size[1]} ${fps ?? '?'} fps ${bitrate ?? '?'} kbps #${index}`, failures);
          }
        }
      }
    }
    expect(failures.slice(0, 10)).toEqual([]);
    expect(copies).toBeGreaterThan(20);
    expect(conversions).toBeGreaterThan(1000);
  });

  it('over profiles, levels, codecs, wrappers and sound tracks, does the same', () => {
    const failures: string[] = [];
    let index = 0;
    let copies = 0;
    let conversions = 0;
    const picture: Array<[[number, number], number | null, number | null]> = [
      [[640, 480], 30, 1000],
      [[720, 576], 25, 2000],
      [[480, 320], 25, 900],
      [[1920, 1080], 30, 5000],
      [[320, 240], 15, null],
    ];
    for (const device of devices) {
      for (const profile of profiles) {
        for (const level of levels) {
          for (const codec of codecs) {
            for (const container of containers) {
              for (const sound of sounds) {
                index += 1;
                const [size, fps, bitrate] = picture[index % picture.length] as [[number, number], number | null, number | null];
                const file = videoFile(
                  { codec, profile, level, width: size[0], height: size[1], fps, bitrateKbps: bitrate },
                  sound,
                  { container, fileName: `clip.${container}` },
                );
                const decision = decideForDevice(file, device);
                if (decision.action === 'copy') copies += 1;
                if (decision.action === 'convert') conversions += 1;
                checkVideoDecision(file, device, decision, `${device.id} ${codec} ${profile ?? '?'} ${level ?? '?'} ${container} sound#${sounds.indexOf(sound)} #${index}`, failures);
              }
            }
          }
        }
      }
    }
    expect(failures.slice(0, 10)).toEqual([]);
    expect(copies).toBeGreaterThan(20);
    expect(conversions).toBeGreaterThan(1000);
  });

  it('keeps the bitrate options inside the registry too', () => {
    const failures: string[] = [];
    const file = videoFile({ codec: 'hevc', profile: undefined, level: undefined, width: 1920, height: 1080 }, { codec: 'ac3', channels: 6 });
    for (const device of devices) {
      const row = device.media?.video?.formats?.[0] as VideoFormat;
      const sound = SOUND_LIMITS[device.id] as { rate: number; kbps: number };
      for (const asked of [Number.NEGATIVE_INFINITY, -1, 0, 0.4, 1, 64, 500, 1500, 9999, 10000, 10001, 1e9, Number.POSITIVE_INFINITY, Number.NaN]) {
        const spec = decideForDevice(file, device, { videoBitrateKbps: asked, audioBitrateKbps: asked }).conversion;
        const cap = spec?.video?.maxBitrateKbps ?? Number.NaN;
        const audioKbps = spec?.audio?.bitrateKbps ?? Number.NaN;
        if (!(cap >= 1 && cap <= (row.maxVideoBitrateKbps ?? Number.POSITIVE_INFINITY))) failures.push(`${device.id} asked ${asked}: video cap ${cap}`);
        if (!(audioKbps >= 1 && audioKbps <= sound.kbps)) failures.push(`${device.id} asked ${asked}: sound bitrate ${audioKbps}`);
      }
    }
    expect(failures).toEqual([]);
  });
});
