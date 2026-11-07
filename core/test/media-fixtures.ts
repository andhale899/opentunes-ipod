import { expect } from 'vitest';
import { getDevice } from '../src/devices/registry';
import type { DeviceModel } from '../src/devices/types';
import type { AudioStream, MediaContainer, MediaInfo, PlanDecision, VideoStream } from '../src/media/types';

/**
 * Builders for the planner tests. Every file here is made up in code, and no ID in this file
 * looks like a real device ID.
 */

function realNano(): DeviceModel {
  const device = getDevice('nano-7g');
  if (!device) throw new Error('the registry has no nano-7g row');
  return device;
}

/** The nano 7G row straight from the registry. */
export const nano: DeviceModel = realNano();

/** A copy of the nano row with changes, so tests can prove the planner reads the registry and not nano numbers. */
export function cloneDevice(id: string, change: (device: DeviceModel) => void): DeviceModel {
  const copy = structuredClone(nano);
  copy.id = id;
  copy.name = `Test iPod ${id}`;
  change(copy);
  return copy;
}

/** Audio only. 44.1 kHz ceiling, AAC capped at 256 kbps, no video, and the description file does not speak for podcasts. */
export const audioOnly44: DeviceModel = cloneDevice('test-audio-44', (device) => {
  const media = device.media!;
  for (const format of media.music!.formats!) {
    if (format.maxSampleRateHz !== undefined) format.maxSampleRateHz = 44100;
    if (format.codec === 'AAC') format.bitrateKbps = { min: 16, max: 256 };
  }
  media.video = { status: 'not-listed' };
  media.podcast = { status: 'not-listed' };
  media.audiobook = { status: 'unknown' };
  delete device.deviceDeclared;
});

/** A video model with one small Main-profile row, a 25 fps limit, a 1000 kbps cap and tighter audio. */
export const smallVideo: DeviceModel = cloneDevice('test-video-small', (device) => {
  device.media!.video = {
    status: 'supported',
    formats: [
      {
        codec: 'h264',
        profiles: ['Main'],
        level: '3.0',
        maxWidth: 480,
        maxHeight: 320,
        maxFps: 25,
        maxVideoBitrateKbps: 1000,
        audio: 'AAC-LC up to 128 kbps, 44.1 kHz, stereo',
        containers: ['.m4v'],
      },
    ],
  };
});

export function info(overrides: Partial<MediaInfo> = {}): MediaInfo {
  return {
    fileName: 'file.bin',
    sizeBytes: 5_000_000,
    container: 'unknown',
    durationMs: 200_000,
    audio: null,
    video: null,
    tags: {},
    chapters: [],
    artwork: null,
    protected: false,
    warnings: [],
    ...overrides,
  };
}

/** An audio-only file. The defaults are an ordinary stereo 44.1 kHz file at 192 kbps. */
export function audioFile(
  container: MediaContainer,
  audio: Partial<AudioStream> & Pick<AudioStream, 'codec'>,
  file: Partial<MediaInfo> = {},
): MediaInfo {
  return info({
    fileName: `track.${container}`,
    container,
    audio: { sampleRateHz: 44100, channels: 2, bitrateKbps: 192, ...audio },
    ...file,
  });
}

/** A video file. The defaults fit the nano's Baseline 640x480 row exactly, with AAC-LC stereo sound. Pass `null` for no sound. */
export function videoFile(video: Partial<VideoStream> = {}, audio: Partial<AudioStream> | null = {}, file: Partial<MediaInfo> = {}): MediaInfo {
  return info({
    fileName: 'clip.m4v',
    container: 'm4v',
    durationMs: 600_000,
    sizeBytes: 100_000_000,
    video: { codec: 'h264', profile: 'Baseline', level: '3.0', width: 640, height: 480, fps: 30, bitrateKbps: 1000, ...video },
    audio: audio === null ? null : { codec: 'aac', sampleRateHz: 48000, channels: 2, bitrateKbps: 128, ...audio },
    ...file,
  });
}

/** What is wrong with a decision's reasons, as short messages. Empty when they are all whole plain sentences. */
export function plainProblems(decision: PlanDecision): string[] {
  const problems: string[] = [];
  if (decision.reasons.length === 0) problems.push('no reasons');
  for (const reason of decision.reasons) {
    if (reason.length === 0 || reason.trim() !== reason) problems.push(`empty or stray spaces: "${reason}"`);
    else if (!/^[A-Z0-9]/.test(reason)) problems.push(`does not start with a capital letter or digit: "${reason}"`);
    else if (!/\.$/.test(reason)) problems.push(`does not end with a full stop: "${reason}"`);
    else if (/\u2014|\u2013|undefined|NaN|\[object|null/.test(reason)) problems.push(`has a dash or a code leftover: "${reason}"`);
  }
  return problems;
}

/** Every reason is a whole plain sentence: not empty, starts with a capital or digit, ends with a full stop, no dashes or code-looking leftovers. */
export function expectPlainReasons(decision: PlanDecision): void {
  expect(plainProblems(decision)).toEqual([]);
}

/** All the reasons as one string, for "mentions" checks. */
export function said(decision: PlanDecision): string {
  return decision.reasons.join(' ');
}
