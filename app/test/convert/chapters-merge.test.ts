import { describe, expect, it } from 'vitest';
import { buildChapterMetadata, escapeMetadataValue, normalizeChapters, truncateUtf8 } from '../../src/convert/chapters';
import { buildConcatInput, buildMergeArgs, buildMergePartArgs, chaptersFromFrames, chooseMergeParams, countAdtsFrames, partFileName, partTitle } from '../../src/convert/merge-args';
import { adtsStream, after, audioSpec, hasSequence, source } from './helpers';

describe('buildChapterMetadata', () => {
  it('writes the ffmetadata file with a millisecond time base', () => {
    const text = buildChapterMetadata([{ startMs: 0, title: 'One' }, { startMs: 60_000, title: 'Two' }], 150_000);
    expect(text).toBe(
      [
        ';FFMETADATA1',
        '[CHAPTER]', 'TIMEBASE=1/1000', 'START=0', 'END=60000', 'title=One',
        '[CHAPTER]', 'TIMEBASE=1/1000', 'START=60000', 'END=150000', 'title=Two',
        '',
      ].join('\n'),
    );
  });

  it('gives an empty string for no chapters', () => {
    expect(buildChapterMetadata([], 1000)).toBe('');
    expect(buildChapterMetadata([{ startMs: 5000, title: 'Late' }], 1000)).toBe('');
  });

  it('sorts, rounds, and drops bad and repeated starts', () => {
    const list = normalizeChapters(
      [
        { startMs: 30_000.4, title: 'B' },
        { startMs: -5, title: 'negative' },
        { startMs: Number.NaN, title: 'nan' },
        { startMs: 0, title: 'A' },
        { startMs: 30_000, title: 'B again' },
      ],
      100_000,
    );
    expect(list).toEqual([
      { startMs: 0, endMs: 30_000, title: 'A' },
      { startMs: 30_000, endMs: 100_000, title: 'B' },
    ]);
  });

  it('drops a chapter that starts at or after the end, and ends the last one a millisecond on when the length is unknown', () => {
    expect(normalizeChapters([{ startMs: 0, title: 'A' }, { startMs: 10_000, title: 'B' }], 10_000)).toHaveLength(1);
    expect(normalizeChapters([{ startMs: 0, title: 'A' }, { startMs: 10_000, title: 'B' }])[1]).toEqual({ startMs: 10_000, endMs: 10_001, title: 'B' });
  });

  it('names untitled chapters by position', () => {
    expect(normalizeChapters([{ startMs: 0, title: '  ' }, { startMs: 5, title: '' }], 100).map((chapter) => chapter.title)).toEqual(['Chapter 1', 'Chapter 2']);
  });

  it('escapes the characters ffmetadata treats as syntax', () => {
    expect(escapeMetadataValue('a=b;c#d\\e')).toBe('a\\=b\\;c\\#d\\\\e');
    expect(escapeMetadataValue('two\nlines')).toBe('two\\\nlines');
    expect(buildChapterMetadata([{ startMs: 0, title: 'Part 1: a=b' }], 10)).toContain('title=Part 1: a\\=b');
  });

  it('cuts a title to 255 bytes of UTF-8 without splitting a character', () => {
    const long = 'é'.repeat(200);
    const cut = truncateUtf8(long, 255);
    expect(new TextEncoder().encode(cut).length).toBeLessThanOrEqual(255);
    expect(cut).toBe('é'.repeat(127));
    expect(truncateUtf8('short', 255)).toBe('short');
    expect(truncateUtf8('a😀b', 5)).toBe('a😀');
    expect(truncateUtf8('a😀b', 4)).toBe('a');
  });
});

describe('merge settings', () => {
  const mono = (rate: number) => source({ audio: { streamIndex: 0, codec: 'mp3', channels: 1, sampleRateHz: rate } });
  const stereo = (rate: number) => source({ audio: { streamIndex: 0, codec: 'mp3', channels: 2, sampleRateHz: rate } });

  it('uses the spec, else mono when every part is mono, and the highest part rate up to 48 kHz', () => {
    const spec = audioSpec({ container: 'm4b', audio: { codec: 'aac' } });
    expect(chooseMergeParams(spec, [mono(22050), mono(44100)])).toEqual({ codec: 'aac', bitrateKbps: 96, sampleRateHz: 44100, channels: 1 });
    expect(chooseMergeParams(spec, [mono(22050), stereo(32000)])).toMatchObject({ channels: 2, sampleRateHz: 32000, bitrateKbps: 192 });
    expect(chooseMergeParams(spec, [stereo(96000)])).toMatchObject({ sampleRateHz: 48000 });
    expect(chooseMergeParams(audioSpec({ container: 'm4b', audio: { codec: 'aac', bitrateKbps: 64, sampleRateHz: 22050, channels: 1 } }), [stereo(48000)])).toEqual({ codec: 'aac', bitrateKbps: 64, sampleRateHz: 22050, channels: 1 });
  });

  it('is always AAC, even when the spec says Apple Lossless', () => {
    expect(chooseMergeParams(audioSpec({ container: 'm4b', audio: { codec: 'alac' } }), [stereo(44100)]).codec).toBe('aac');
  });
});

describe('the merge command lines', () => {
  it('encodes each part to raw AAC with no tags, no chapters and the common settings', () => {
    const args = buildMergePartArgs({ codec: 'aac', bitrateKbps: 64, sampleRateHz: 44100, channels: 1 }, { input: '/in/part-in-000.mp3', output: '/work/part-000.aac' });
    expect(args).toEqual([
      '-hide_banner', '-loglevel', 'info',
      '-i', '/in/part-in-000.mp3',
      '-map', '0:a:0',
      '-map_metadata', '-1',
      '-map_chapters', '-1',
      '-c:a', 'aac', '-profile:a', 'aac_low', '-b:a', '64k', '-ar', '44100', '-ac', '1',
      '-f', 'adts',
      '/work/part-000.aac',
    ]);
  });

  it('lists the parts in order for the concat protocol', () => {
    expect(buildConcatInput(['/work/part-000.aac', '/work/part-001.aac'])).toBe('concat:/work/part-000.aac|/work/part-001.aac');
    expect(() => buildConcatInput([])).toThrow(/nothing to merge/);
    expect(() => buildConcatInput(['/work/a|b.aac'])).toThrow(/"\|"/);
  });

  it('names part files with three digits', () => {
    expect(partFileName(0)).toBe('part-000.aac');
    expect(partFileName(12)).toBe('part-012.aac');
    expect(partFileName(1234)).toBe('part-1234.aac');
  });

  it('joins without re-encoding into an m4b with chapters, cover, tags and the audiobook mark', () => {
    const args = buildMergeArgs(
      audioSpec({ container: 'm4b' }),
      { parts: ['/work/part-000.aac', '/work/part-001.aac'], output: '/work/book.m4b' },
      { chapterFile: '/work/chapters.ffmeta', coverFile: { path: '/work/cover.jpg', mime: 'image/jpeg' }, tags: { album: 'Book' } },
    );
    expect(hasSequence(args, '-i', 'concat:/work/part-000.aac|/work/part-001.aac', '-i', '/work/chapters.ffmeta', '-i', '/work/cover.jpg')).toBe(true);
    expect(hasSequence(args, '-map', '0:a:0', '-map', '2:v:0', '-c:a', 'copy')).toBe(true);
    expect(hasSequence(args, '-map_chapters', '1')).toBe(true);
    expect(args).toContain('album=Book');
    expect(args).toContain('media_type=2');
    expect(args.at(-1)).toBe('/work/book.m4b');
    expect(after(args, '-f')).toBe('ipod');
  });

  it('writes chapters even if the spec says not to keep them, because they are the point of a merge', () => {
    const args = buildMergeArgs(audioSpec({ container: 'm4a', keepChapters: false }), { parts: ['/work/part-000.aac'], output: '/work/book.m4b' }, { chapterFile: '/work/c.ffmeta' });
    expect(hasSequence(args, '-map_chapters', '1')).toBe(true);
    expect(args.at(-1)).toBe('/work/book.m4b');
  });
});

describe('counting AAC frames and placing chapters', () => {
  it('counts frames in a raw ADTS stream', () => {
    expect(countAdtsFrames(adtsStream(0))).toBe(0);
    expect(countAdtsFrames(adtsStream(1))).toBe(1);
    expect(countAdtsFrames(adtsStream(45))).toBe(45);
    expect(countAdtsFrames(adtsStream(109, 300))).toBe(109);
  });

  it('refuses a stream that is damaged or cut short', () => {
    const stream = adtsStream(3);
    expect(() => countAdtsFrames(stream.subarray(0, stream.length - 5))).toThrow(/middle of a frame|damaged/);
    const bad = adtsStream(3);
    bad[20] = 0x00;
    expect(() => countAdtsFrames(bad)).toThrow(/damaged/);
    expect(() => countAdtsFrames(new Uint8Array([0xff, 0xf1, 0, 0]))).toThrow(/damaged/);
  });

  it('puts each chapter where its part starts, exactly, from the frame counts', () => {
    // 45 and 109 frames at 44.1 kHz: the case measured in ffmpeg.wasm, 3.576 s in all.
    const { chapters, totalMs } = chaptersFromFrames(
      [{ name: 'one.mp3' }, { name: 'two.mp3', title: 'Second' }, { name: 'three.mp3' }],
      [45, 109, 10],
      44100,
    );
    expect(chapters).toEqual([
      { startMs: 0, title: 'one' },
      { startMs: 1045, title: 'Second' },
      { startMs: 3576, title: 'three' },
    ]);
    expect(totalMs).toBe(Math.round((164 * 1024 * 1000) / 44100));
  });

  it('does not drift over many parts', () => {
    const frames = Array.from({ length: 200 }, () => 4000);
    const parts = frames.map((_, index) => ({ name: `part ${index}.mp3` }));
    const { chapters } = chaptersFromFrames(parts, frames, 44100);
    expect(chapters[199]?.startMs).toBe(Math.round((199 * 4000 * 1024 * 1000) / 44100));
    expect(() => chaptersFromFrames(parts, [1], 44100)).toThrow(/frame count/);
  });

  it('titles a part by its title, else its name without the extension', () => {
    expect(partTitle({ name: 'Chapter 01.final.mp3' })).toBe('Chapter 01.final');
    expect(partTitle({ name: 'x.mp3', title: '  Prologue ' })).toBe('Prologue');
    expect(partTitle({ name: 'x.mp3', title: '   ' })).toBe('x');
  });
});
