import { describe, expect, it } from 'vitest';
import { buildVideoArgs, buildVideoFilter, checkLevel, displaySize, fitSize, resolveVideoAudio, X264_CRF, X264_PRESET } from '../../src/convert/video-args';
import { after, audioSpec, hasSequence, source, videoSource, videoSpec } from './helpers';

const max = { width: 640, height: 480 };
const files = { input: '/in/input.mkv', output: '/work/output.m4v' };

describe('fitSize', () => {
  it('scales a large picture down and keeps its shape', () => {
    expect(fitSize({ width: 1920, height: 1080 }, max)).toEqual({ width: 640, height: 360 });
    expect(fitSize({ width: 1280, height: 720 }, max)).toEqual({ width: 640, height: 360 });
    expect(fitSize({ width: 1920, height: 800 }, max)).toEqual({ width: 640, height: 266 });
  });

  it('fits a tall picture by its height', () => {
    expect(fitSize({ width: 1081, height: 1921 }, max)).toEqual({ width: 270, height: 480 });
    expect(fitSize({ width: 1080, height: 1920 }, max)).toEqual({ width: 270, height: 480 });
  });

  it('never makes a picture larger', () => {
    expect(fitSize({ width: 320, height: 240 }, max)).toEqual({ width: 320, height: 240 });
    expect(fitSize({ width: 640, height: 480 }, max)).toEqual({ width: 640, height: 480 });
    expect(fitSize({ width: 100, height: 50 }, max)).toEqual({ width: 100, height: 50 });
  });

  it('rounds odd sizes down to even ones, never over the limit', () => {
    expect(fitSize({ width: 161, height: 121 }, max)).toEqual({ width: 160, height: 120 });
    expect(fitSize({ width: 641, height: 481 }, max)).toEqual({ width: 640, height: 480 });
    expect(fitSize({ width: 101, height: 51 }, max)).toEqual({ width: 100, height: 50 });
    // 853x479 into 641x481: width is the limit, 479 * 641 / 853 = 359.97, so 360.
    expect(fitSize({ width: 853, height: 479 }, { width: 641, height: 481 })).toEqual({ width: 640, height: 360 });
  });

  it('allows the one-pixel case to become the smallest legal size', () => {
    expect(fitSize({ width: 1, height: 1 }, max)).toEqual({ width: 2, height: 2 });
    expect(fitSize({ width: 5000, height: 1 }, max)).toEqual({ width: 640, height: 2 });
  });

  it('always gives even sides within the limit, for many sizes', () => {
    for (const [width, height] of [[1, 7], [3, 3], [17, 1000], [999, 1001], [4096, 2160], [7680, 4320], [639, 481], [2, 2]] as const) {
      const size = fitSize({ width, height }, max);
      expect(size.width % 2).toBe(0);
      expect(size.height % 2).toBe(0);
      expect(size.width).toBeGreaterThanOrEqual(2);
      expect(size.height).toBeGreaterThanOrEqual(2);
      if (width >= 2 && height >= 2) {
        expect(size.width).toBeLessThanOrEqual(Math.max(2, Math.min(width, 640)));
        expect(size.height).toBeLessThanOrEqual(Math.max(2, Math.min(height, 480)));
      }
    }
  });

  it('rejects sizes that make no sense', () => {
    expect(() => fitSize({ width: 0, height: 10 }, max)).toThrow(RangeError);
    expect(() => fitSize({ width: 10, height: 10 }, { width: 1, height: 480 })).toThrow(RangeError);
  });
});

describe('displaySize', () => {
  const video = { streamIndex: 0, codec: 'h264', width: 720, height: 480, sarNum: 1, sarDen: 1, rotation: 0 };
  it('applies the pixel shape', () => {
    expect(displaySize({ ...video, sarNum: 8, sarDen: 9 })).toEqual({ width: 640, height: 480 });
  });
  it('swaps the sides for a turn of 90 or 270 degrees, not 180', () => {
    expect(displaySize({ ...video, width: 1080, height: 1920, rotation: 90 })).toEqual({ width: 1920, height: 1080 });
    expect(displaySize({ ...video, width: 1080, height: 1920, rotation: 270 })).toEqual({ width: 1920, height: 1080 });
    expect(displaySize({ ...video, width: 1920, height: 1080, rotation: 180 })).toEqual({ width: 1920, height: 1080 });
  });
});

describe('buildVideoFilter', () => {
  const target = videoSpec().video!;
  it('scales to the fitted size with square pixels in 4:2:0', () => {
    expect(buildVideoFilter(target, videoSource().video)).toBe('scale=640:360:flags=lanczos,setsar=1,format=yuv420p');
    expect(buildVideoFilter(target, videoSource(161, 121).video)).toBe('scale=160:120:flags=lanczos,setsar=1,format=yuv420p');
  });
  it('lets ffmpeg decide, without ever enlarging, when the size is not known', () => {
    const filter = buildVideoFilter(target, null);
    expect(filter).toContain("min(iw,640)");
    expect(filter).toContain("min(ih,480)");
    expect(filter).toContain('force_original_aspect_ratio=decrease');
    expect(filter).toContain('force_divisible_by=2');
    expect(filter.endsWith('setsar=1,format=yuv420p')).toBe(true);
  });
});

describe('buildVideoArgs', () => {
  it('writes baseline H.264 with no B-frames and the level, bitrate cap, fps cap and pixel format', () => {
    const args = buildVideoArgs(videoSpec(), files, videoSource());
    expect(hasSequence(args, '-c:v:0', 'libx264', '-preset', X264_PRESET, '-profile:v', 'baseline', '-level', '3.0', '-bf', '0')).toBe(true);
    expect(hasSequence(args, '-crf', String(X264_CRF), '-maxrate', '2500k', '-bufsize', '5000k')).toBe(true);
    expect(hasSequence(args, '-pix_fmt:v:0', 'yuv420p', '-fpsmax', '30')).toBe(true);
    expect(after(args, '-filter:v:0')).toBe('scale=640:360:flags=lanczos,setsar=1,format=yuv420p');
    expect(hasSequence(args, '-movflags', '+faststart', '-f', 'ipod', '/work/output.m4v')).toBe(true);
  });

  it('allows B-frames for main and high', () => {
    for (const profile of ['main', 'high'] as const) {
      const args = buildVideoArgs(videoSpec({ video: { ...videoSpec().video!, profile, level: '4.1' } }), files, videoSource());
      expect(after(args, '-profile:v')).toBe(profile);
      expect(after(args, '-level')).toBe('4.1');
      expect(args).not.toContain('-bf');
    }
  });

  it('writes AAC-LC audio at most 256 kbps, stereo, 48 kHz', () => {
    const loud = videoSpec({ audio: { codec: 'aac', bitrateKbps: 512, sampleRateHz: 96000, channels: 2 } });
    const args = buildVideoArgs(loud, files, videoSource());
    expect(hasSequence(args, '-c:a', 'aac', '-profile:a', 'aac_low', '-b:a', '256k', '-ar', '48000', '-ac', '2')).toBe(true);
  });

  it('brings 5.1 down to stereo and forces AAC even if the spec asked for Apple Lossless', () => {
    const surround = videoSource(1920, 1080, { audio: { streamIndex: 1, codec: 'ac3', channels: 6, sampleRateHz: 48000 } });
    const args = buildVideoArgs(videoSpec({ audio: { codec: 'alac' } }), files, surround);
    expect(after(args, '-ac')).toBe('2');
    expect(after(args, '-c:a')).toBe('aac');
    expect(resolveVideoAudio(videoSpec({ audio: null }), surround)).toEqual({ channels: 2, sampleRateHz: 48000, bitrateKbps: 128 });
  });

  it('keeps mono audio mono with a lower default bitrate', () => {
    const mono = videoSource(640, 480, { audio: { streamIndex: 1, codec: 'aac', channels: 1, sampleRateHz: 22050 } });
    expect(resolveVideoAudio(videoSpec({ audio: null }), mono)).toEqual({ channels: 1, sampleRateHz: 22050, bitrateKbps: 64 });
  });

  it('makes a video with no audio when the file has none, and does not fail', () => {
    const silent = videoSource(1280, 720, { audio: null, audioStreamCount: 0 });
    const args = buildVideoArgs(videoSpec(), files, silent);
    expect(args).not.toContain('-c:a');
    expect(args.filter((item) => item.startsWith('0:a'))).toEqual([]);
    expect(hasSequence(args, '-map', '0:V:0')).toBe(true);
  });

  it('maps the first real video stream and the first audio stream only', () => {
    const args = buildVideoArgs(videoSpec(), files, videoSource());
    expect(hasSequence(args, '-map', '0:V:0', '-map', '0:a:0?')).toBe(true);
  });

  it('uses a lowered bitrate cap when the converter asks for one', () => {
    const args = buildVideoArgs(videoSpec(), files, videoSource(), { maxBitrateKbps: 1030 });
    expect(hasSequence(args, '-maxrate', '1030k', '-bufsize', '2060k')).toBe(true);
  });

  it('puts a cover image second, so it is not scaled or encoded as video', () => {
    const args = buildVideoArgs(videoSpec(), files, videoSource(), { coverFile: { path: '/work/cover.png', mime: 'image/png' } });
    expect(hasSequence(args, '-map', '1:v:0')).toBe(true);
    expect(hasSequence(args, '-c:v:1', 'copy', '-disposition:v:1', 'attached_pic')).toBe(true);
    const reencoded = buildVideoArgs(videoSpec(), files, videoSource(), { coverFile: { path: '/work/cover.webp', mime: 'image/webp' } });
    expect(hasSequence(reencoded, '-c:v:1', 'mjpeg', '-q:v:1', '3', '-pix_fmt:v:1', 'yuvj420p')).toBe(true);
  });

  it('refuses an audio spec, a bad level and a zero fps cap', () => {
    expect(() => buildVideoArgs(audioSpec(), files, source())).toThrow(/video spec/);
    expect(() => buildVideoArgs(videoSpec({ video: { ...videoSpec().video!, level: 'three' } }), files, videoSource())).toThrow(/level/);
    expect(() => buildVideoArgs(videoSpec({ video: { ...videoSpec().video!, maxFps: 0 } }), files, videoSource())).toThrow(/frame rate/);
    expect(checkLevel('3.0')).toBe('3.0');
    expect(checkLevel('4')).toBe('4');
  });

  it('puts tags and chapters on video files the same way as on audio', () => {
    const args = buildVideoArgs(videoSpec(), files, videoSource(), { tags: { title: 'Film' }, chapterFile: '/work/c.ffmeta' });
    expect(args).toContain('title=Film');
    expect(hasSequence(args, '-map_chapters', '1')).toBe(true);
    const bare = buildVideoArgs(videoSpec({ keepTags: false, keepChapters: false }), files, videoSource(), { tags: { title: 'Film' } });
    expect(hasSequence(bare, '-map_metadata', '-1')).toBe(true);
    expect(hasSequence(bare, '-map_chapters', '-1')).toBe(true);
    expect(bare).not.toContain('title=Film');
    expect(bare).not.toContain('media_type=2');
  });
});
