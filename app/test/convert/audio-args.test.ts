import { describe, expect, it } from 'vitest';
import { buildAudioArgs, clampAacKbps, maxAacKbps, pickChannels, pickSampleRate, resolveAudioParams, snapAacRate } from '../../src/convert/audio-args';
import { after, audioSpec, hasSequence, source, videoSpec } from './helpers';

const files = { input: '/in/input.flac', output: '/work/output.m4a' };

describe('sample rate and bitrate rules', () => {
  it('snaps to the nearest AAC rate at or below', () => {
    expect(snapAacRate(44100)).toBe(44100);
    expect(snapAacRate(40000)).toBe(32000);
    expect(snapAacRate(37800)).toBe(32000);
    expect(snapAacRate(96000)).toBe(96000);
    expect(snapAacRate(5000)).toBe(8000);
  });

  it('uses the spec rate, else the file rate capped at 48 kHz', () => {
    expect(pickSampleRate({ codec: 'aac', sampleRateHz: 22050 }, source(), 'aac')).toBe(22050);
    expect(pickSampleRate({ codec: 'aac' }, source(), 'aac')).toBe(44100);
    expect(pickSampleRate(null, source({ audio: { streamIndex: 0, codec: 'flac', channels: 2, sampleRateHz: 96000 } }), 'aac')).toBe(48000);
    expect(pickSampleRate(null, source({ audio: { streamIndex: 0, codec: 'flac', channels: 2, sampleRateHz: 88200 } }), 'alac')).toBe(48000);
    expect(pickSampleRate(null, null, 'aac')).toBe(44100);
  });

  it('keeps bitrates inside what the native encoder accepts', () => {
    expect(maxAacKbps(2, 44100)).toBe(529);
    expect(maxAacKbps(1, 22050)).toBe(132);
    expect(clampAacKbps(320, 1, 22050)).toBe(132);
    expect(clampAacKbps(4, 2, 44100)).toBe(16);
    expect(clampAacKbps(256, 2, 44100)).toBe(256);
  });

  it('picks channels from the spec, else the file up to stereo', () => {
    expect(pickChannels({ codec: 'aac', channels: 1 }, source())).toBe(1);
    expect(pickChannels(null, source({ audio: { streamIndex: 0, codec: 'aac', channels: 1, sampleRateHz: 44100 } }))).toBe(1);
    expect(pickChannels(null, source({ audio: { streamIndex: 0, codec: 'ac3', channels: 6, sampleRateHz: 48000 } }))).toBe(2);
    expect(pickChannels(null, null)).toBe(2);
  });
});

describe('buildAudioArgs for AAC', () => {
  it('writes AAC-LC with the spec bitrate, rate and channels into an ipod-style file', () => {
    const args = buildAudioArgs(audioSpec(), files, source());
    expect(hasSequence(args, '-c:a', 'aac', '-profile:a', 'aac_low', '-b:a', '256k', '-ar', '44100', '-ac', '2')).toBe(true);
    expect(hasSequence(args, '-movflags', '+faststart', '-f', 'ipod', '/work/output.m4a')).toBe(true);
    expect(args.slice(0, 5)).toEqual(['-hide_banner', '-loglevel', 'info', '-i', '/in/input.flac']);
    expect(args.at(-1)).toBe('/work/output.m4a');
  });

  it('picks the first audio stream, and tolerates a file whose audio the probe did not find', () => {
    expect(hasSequence(buildAudioArgs(audioSpec(), files, source()), '-map', '0:a:0?')).toBe(true);
    expect(hasSequence(buildAudioArgs(audioSpec(), files, null), '-map', '0:a:0?')).toBe(true);
  });

  it('turns 5.1 into stereo and keeps mono as mono when the spec says nothing', () => {
    const spec = audioSpec({ audio: { codec: 'aac', bitrateKbps: 192 } });
    const surround = source({ audio: { streamIndex: 0, codec: 'ac3', channels: 6, sampleRateHz: 48000 } });
    const mono = source({ audio: { streamIndex: 0, codec: 'mp3', channels: 1, sampleRateHz: 22050 } });
    expect(after(buildAudioArgs(spec, files, surround), '-ac')).toBe('2');
    expect(after(buildAudioArgs(spec, files, surround), '-ar')).toBe('48000');
    expect(after(buildAudioArgs(spec, files, mono), '-ac')).toBe('1');
    expect(after(buildAudioArgs(spec, files, mono), '-ar')).toBe('22050');
  });

  it('uses defaults for a missing audio target and for a missing bitrate', () => {
    const none = resolveAudioParams(audioSpec({ audio: null }), source());
    expect(none).toEqual({ codec: 'aac', bitrateKbps: 192, sampleRateHz: 44100, channels: 2 });
    const mono = resolveAudioParams(audioSpec({ audio: { codec: 'aac', channels: 1 } }), source());
    expect(mono.bitrateKbps).toBe(96);
  });

  it('clamps an impossible bitrate instead of letting ffmpeg fail', () => {
    const args = buildAudioArgs(audioSpec({ audio: { codec: 'aac', bitrateKbps: 320, sampleRateHz: 22050, channels: 1 } }), files, source());
    expect(after(args, '-b:a')).toBe('132k');
  });
});

describe('buildAudioArgs for Apple Lossless', () => {
  it('writes alac as 16-bit with the spec rate and no bitrate', () => {
    const args = buildAudioArgs(audioSpec({ audio: { codec: 'alac', sampleRateHz: 48000, channels: 2 } }), files, source());
    expect(hasSequence(args, '-c:a', 'alac', '-sample_fmt', 's16p', '-ar', '48000', '-ac', '2')).toBe(true);
    expect(args).not.toContain('-b:a');
    expect(args).not.toContain('-profile:a');
  });
});

describe('containers', () => {
  it('marks an m4b as an audiobook and leaves an m4a alone', () => {
    const book = buildAudioArgs(audioSpec({ container: 'm4b' }), { input: '/in/a.mp3', output: '/work/output.m4b' }, source());
    expect(hasSequence(book, '-metadata', 'media_type=2')).toBe(true);
    expect(book.at(-1)).toBe('/work/output.m4b');
    expect(buildAudioArgs(audioSpec(), files, source())).not.toContain('media_type=2');
  });

  it('lets the caller choose the media type', () => {
    const args = buildAudioArgs(audioSpec({ container: 'm4b' }), files, source(), { tags: { media_type: '21' } });
    expect(args).toContain('media_type=21');
    expect(args).not.toContain('media_type=2');
  });

  it('refuses a video spec', () => {
    expect(() => buildAudioArgs(videoSpec(), files, source())).toThrow(/audio spec/);
  });
});

describe('tags, chapters and artwork', () => {
  it('keeps the input tags and adds the given ones, dropping bad keys and allowing removal', () => {
    const args = buildAudioArgs(audioSpec(), files, source(), { tags: { title: 'A', 'bad key': 'x', artist: '', album_artist: 'B' } });
    expect(hasSequence(args, '-map_metadata', '0')).toBe(true);
    expect(args).toContain('title=A');
    expect(args).toContain('artist=');
    expect(args).toContain('album_artist=B');
    expect(args.join(' ')).not.toContain('bad key');
  });

  it('writes no tags at all when the spec drops them, but still marks an audiobook', () => {
    const args = buildAudioArgs(audioSpec({ keepTags: false, container: 'm4b' }), files, source(), { tags: { title: 'A' } });
    expect(hasSequence(args, '-map_metadata', '-1')).toBe(true);
    expect(args).not.toContain('title=A');
    expect(args).toContain('media_type=2');
  });

  it('maps chapters from the input, from a chapter file, or not at all', () => {
    expect(hasSequence(buildAudioArgs(audioSpec(), files, source()), '-map_chapters', '0')).toBe(true);
    const withFile = buildAudioArgs(audioSpec(), files, source(), { chapterFile: '/work/chapters.ffmeta' });
    expect(hasSequence(withFile, '-i', '/work/chapters.ffmeta')).toBe(true);
    expect(hasSequence(withFile, '-map_chapters', '1')).toBe(true);
    const off = buildAudioArgs(audioSpec({ keepChapters: false }), files, source(), { chapterFile: '/work/chapters.ffmeta' });
    expect(hasSequence(off, '-map_chapters', '-1')).toBe(true);
  });

  it('copies a JPEG or PNG cover and re-encodes anything else', () => {
    const jpeg = buildAudioArgs(audioSpec(), files, source(), { coverFile: { path: '/work/cover.jpg', mime: 'image/jpeg' } });
    expect(hasSequence(jpeg, '-i', '/work/cover.jpg')).toBe(true);
    expect(hasSequence(jpeg, '-map', '1:v:0')).toBe(true);
    expect(hasSequence(jpeg, '-c:v:0', 'copy', '-disposition:v:0', 'attached_pic')).toBe(true);
    const webp = buildAudioArgs(audioSpec(), files, source(), { coverFile: { path: '/work/cover.webp', mime: 'image/webp' } });
    expect(hasSequence(webp, '-c:v:0', 'mjpeg', '-q:v:0', '3', '-pix_fmt:v:0', 'yuvj420p')).toBe(true);
  });

  it('numbers the cover input after the chapter file', () => {
    const args = buildAudioArgs(audioSpec(), files, source(), { chapterFile: '/work/c.ffmeta', coverFile: { path: '/work/cover.png', mime: 'image/png' } });
    expect(hasSequence(args, '-map', '2:v:0')).toBe(true);
    expect(hasSequence(args, '-map_chapters', '1')).toBe(true);
  });

  it('keeps the input cover stream when no cover is given, and none when the spec drops artwork', () => {
    const withPicture = source({ picture: { streamIndex: 1, codec: 'mjpeg' } });
    const kept = buildAudioArgs(audioSpec(), files, withPicture);
    expect(hasSequence(kept, '-map', '0:1')).toBe(true);
    expect(hasSequence(kept, '-c:v:0', 'copy')).toBe(true);
    const odd = buildAudioArgs(audioSpec(), files, source({ picture: { streamIndex: 1, codec: 'webp' } }));
    expect(odd).toContain('mjpeg');
    const dropped = buildAudioArgs(audioSpec({ keepArtwork: false }), files, withPicture, { coverFile: { path: '/work/cover.jpg', mime: 'image/jpeg' } });
    expect(dropped).not.toContain('attached_pic');
    expect(dropped).not.toContain('0:1');
  });
});
