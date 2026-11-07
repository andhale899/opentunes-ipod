import { describe, expect, it } from 'vitest';
import { ConvertError, LogBuffer, explainFailure, explainUnexpected, failureError } from '../../src/convert/errors';
import { MAX_OUTPUT_BYTES, estimateAacBytes, estimateAlacBytes, fitVideoBitrate, formatBytes } from '../../src/convert/limits';
import { outputFileName, stripExtension, virtualInputName, extensionOf } from '../../src/convert/names';
import { checkMergeSize, checkOutputSize, checkSourceStreams, validateSpec } from '../../src/convert/plan';
import { createReporter, stepFraction } from '../../src/convert/progress';
import { parseAspect, parseProbeOutput, parseRotation } from '../../src/convert/source';
import { audioSpec, source, videoSource, videoSpec } from './helpers';

// Shaped like what ffprobe 5.1 printed for a generated 160x120 file with 5.1 audio (checked in ffmpeg.wasm).
const PROBE_TEXT = `{
    "streams": [
        { "index": 0, "codec_name": "h264", "codec_type": "video", "width": 160, "height": 120, "sample_aspect_ratio": "1:1", "disposition": { "attached_pic": 0 } },
        { "index": 1, "codec_name": "aac", "codec_type": "audio", "sample_rate": "44100", "channels": 6, "channel_layout": "5.1", "duration": "1.000000", "disposition": { "attached_pic": 0 } },
        { "index": 2, "codec_name": "aac", "codec_type": "audio", "sample_rate": "22050", "channels": 1, "disposition": { "attached_pic": 0 } },
        { "index": 3, "codec_name": "mjpeg", "codec_type": "video", "width": 500, "height": 500, "disposition": { "attached_pic": 1 } }
    ],
    "format": { "filename": "pat6.mp4", "nb_streams": 4, "duration": "1.500000", "size": "30356" }
}
FFprobe: Cleanup done.`;

describe('parseProbeOutput', () => {
  it('reads the first audio stream, the first real video stream, the cover and the length', () => {
    const info = parseProbeOutput(PROBE_TEXT);
    expect(info).toEqual({
      durationMs: 1500,
      audio: { streamIndex: 1, codec: 'aac', channels: 6, sampleRateHz: 44100 },
      audioStreamCount: 2,
      video: { streamIndex: 0, codec: 'h264', width: 160, height: 120, sarNum: 1, sarDen: 1, rotation: 0 },
      picture: { streamIndex: 3, codec: 'mjpeg' },
    });
  });

  it('copes with a file that has no audio, or only audio', () => {
    expect(parseProbeOutput('{"streams":[{"index":0,"codec_type":"video","codec_name":"h264","width":64,"height":48}],"format":{}}')).toMatchObject({ audio: null, audioStreamCount: 0, durationMs: null });
    expect(parseProbeOutput('{"streams":[{"index":0,"codec_type":"audio","codec_name":"mp3"}],"format":{"duration":"2.5"}}')).toMatchObject({
      video: null,
      audio: { channels: 2, sampleRateHz: 44100 },
      durationMs: 2500,
    });
  });

  it('falls back to the audio stream length when the format has none', () => {
    expect(parseProbeOutput('{"streams":[{"index":0,"codec_type":"audio","duration":"3.25"}]}')?.durationMs).toBe(3250);
  });

  it('gives null for text with no usable JSON', () => {
    expect(parseProbeOutput('')).toBeNull();
    expect(parseProbeOutput('junk.bin: Invalid data found when processing input')).toBeNull();
    expect(parseProbeOutput('{ not json }')).toBeNull();
    expect(parseProbeOutput('{"format":{}}')).toBeNull();
  });

  it('reads pixel shape and rotation', () => {
    expect(parseAspect('8:9')).toEqual({ num: 8, den: 9 });
    expect(parseAspect('0:1')).toEqual({ num: 1, den: 1 });
    expect(parseAspect(undefined)).toEqual({ num: 1, den: 1 });
    expect(parseRotation({ side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }] })).toBe(270);
    expect(parseRotation({ side_data_list: [{ rotation: 90 }] })).toBe(90);
    expect(parseRotation({ tags: { rotate: '180' } })).toBe(180);
    expect(parseRotation({})).toBe(0);
    const phone = parseProbeOutput('{"streams":[{"index":0,"codec_type":"video","width":1920,"height":1080,"sample_aspect_ratio":"1:1","side_data_list":[{"rotation":-90}]}]}');
    expect(phone?.video).toMatchObject({ rotation: 270 });
  });
});

describe('size limits', () => {
  it('estimates AAC and Apple Lossless sizes', () => {
    expect(estimateAacBytes(3_600_000, 192)).toBe(Math.ceil((3600 * 192_000 * 1.03) / 8));
    expect(estimateAlacBytes(60_000, 44100, 2)).toBe(60 * 44100 * 4);
  });

  it('formats sizes', () => {
    expect(formatBytes(MAX_OUTPUT_BYTES)).toBe('1.0 GB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5 MB');
    expect(formatBytes(10)).toBe('1 KB');
  });

  it('keeps the wanted video cap when it fits, lowers it when it does not, and refuses when nothing fits', () => {
    const fits = fitVideoBitrate(2500, 128, 10 * 60 * 1000);
    expect(fits).toEqual({ ok: true, maxrateKbps: 2500, lowered: false });

    const long = fitVideoBitrate(2500, 128, 2 * 3600 * 1000);
    expect(long.ok).toBe(true);
    if (long.ok) {
      expect(long.lowered).toBe(true);
      expect(long.maxrateKbps).toBeLessThan(2500);
      // The promise: even at the cap for the whole time, the file stays inside the limit.
      const worstBytes = ((long.maxrateKbps + 128) * 1000 * 7200 * 1.03) / 8;
      expect(worstBytes).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
    }

    expect(fitVideoBitrate(2500, 128, 40 * 3600 * 1000)).toEqual({ ok: false, neededKbps: 200 });
  });

  it('lets a normal audio job through and refuses one that cannot fit, before any work', () => {
    expect(checkOutputSize(audioSpec(), source({ durationMs: 5 * 3600 * 1000 }))).toEqual({});
    expect(() => checkOutputSize(audioSpec(), source({ durationMs: 60 * 3600 * 1000 }))).toThrow(ConvertError);
    try {
      checkOutputSize(audioSpec(), source({ durationMs: 60 * 3600 * 1000 }));
    } catch (error) {
      expect((error as ConvertError).reason).toBe('limit');
      expect((error as ConvertError).message).toMatch(/about .* GB/);
    }
  });

  it('is stricter for Apple Lossless, which is estimated as plain audio', () => {
    const alac = audioSpec({ audio: { codec: 'alac', sampleRateHz: 44100, channels: 2 } });
    expect(checkOutputSize(alac, source({ durationMs: 3600 * 1000 }))).toEqual({});
    expect(() => checkOutputSize(alac, source({ durationMs: 2 * 3600 * 1000 }))).toThrow(/Use a lower bitrate/);
  });

  it('lowers the video cap for a long film and says so', () => {
    const result = checkOutputSize(videoSpec(), videoSource(1920, 1080, { durationMs: 2 * 3600 * 1000 }));
    expect(result.maxBitrateKbps).toBeGreaterThan(200);
    expect(result.maxBitrateKbps).toBeLessThan(2500);
    expect(result.note).toMatch(/lowered from 2500 to \d+ kbps/);
    expect(checkOutputSize(videoSpec(), videoSource(1920, 1080, { durationMs: 20 * 60 * 1000 }))).toEqual({});
    expect(() => checkOutputSize(videoSpec(), videoSource(1920, 1080, { durationMs: 50 * 3600 * 1000 }))).toThrow(/hours long/);
  });

  it('cannot check a file whose length is unknown, and lets it through', () => {
    expect(checkOutputSize(audioSpec(), source({ durationMs: null }))).toEqual({});
    expect(checkOutputSize(videoSpec(), videoSource(640, 480, { durationMs: null }))).toEqual({});
    expect(() => checkMergeSize(null, { codec: 'aac', bitrateKbps: 192, sampleRateHz: 44100, channels: 2 })).not.toThrow();
    expect(() => checkMergeSize(100 * 3600 * 1000, { codec: 'aac', bitrateKbps: 192, sampleRateHz: 44100, channels: 2 })).toThrow(/stops at/);
  });
});

describe('spec and source checks', () => {
  it('accepts the three containers with the right settings', () => {
    expect(() => validateSpec(audioSpec())).not.toThrow();
    expect(() => validateSpec(audioSpec({ container: 'm4b' }))).not.toThrow();
    expect(() => validateSpec(videoSpec())).not.toThrow();
  });

  it('refuses mismatches with a plain message', () => {
    expect(() => validateSpec(videoSpec({ video: null }))).toThrow(/gives no video settings/);
    expect(() => validateSpec(audioSpec({ video: videoSpec().video }))).toThrow(/gives video settings/);
    expect(() => validateSpec({ ...audioSpec(), container: 'mp4' as 'm4a' })).toThrow(/m4a, m4b or m4v/);
  });

  it('says what is missing from the input', () => {
    expect(() => checkSourceStreams(audioSpec(), source({ audio: null }), 'a.mkv')).toThrow('"a.mkv" has no audio to convert.');
    expect(() => checkSourceStreams(videoSpec(), source(), 'a.flac')).toThrow('"a.flac" has no video to convert.');
    expect(() => checkSourceStreams(videoSpec(), videoSource(), 'ok.mkv')).not.toThrow();
  });
});

describe('file names', () => {
  it('swaps the extension and cleans the name', () => {
    expect(outputFileName('Song.flac', 'm4a')).toBe('Song.m4a');
    expect(outputFileName('dir/sub/My Film.final.mkv', 'm4v')).toBe('My Film.final.m4v');
    expect(outputFileName('a:b|c?.mp3', 'm4a')).toBe('a_b_c_.m4a');
    expect(outputFileName('', 'm4b')).toBe('converted.m4b');
    expect(outputFileName('.mp3', 'm4a')).toBe('.mp3.m4a');
  });

  it('keeps only a plain extension for the name inside ffmpeg', () => {
    expect(virtualInputName('input', 'Track: 01 | x.FLAC')).toBe('input.flac');
    expect(virtualInputName('input', 'weird.ex tension')).toBe('input.bin');
    expect(virtualInputName('input', 'noextension')).toBe('input.bin');
    expect(stripExtension('a/b/c.d.e')).toBe('c.d');
    expect(extensionOf('x.TAR.GZ')).toBe('gz');
  });
});

describe('the ffmpeg log and plain errors', () => {
  it('keeps only the latest progress line and a bounded number of other lines', () => {
    const log = new LogBuffer(3);
    log.push('frame=  1 fps=0.0 q=1.0 size=       0kB time=00:00:00.03');
    log.push('line 1\nline 2');
    log.push('size=     100kB time=00:00:01.00 bitrate=800kbits/s');
    log.push('line 3\r\nline 4');
    log.push('Aborted()');
    expect(log.text()).toBe('line 3\nline 4\nAborted()\nsize=     100kB time=00:00:01.00 bitrate=800kbits/s');
    expect(log.tail(2)).toBe('line 3\nline 4');
    log.clear();
    expect(log.text()).toBe('');
  });

  it('turns ffmpeg messages into plain sentences', () => {
    expect(explainFailure('Aborted(OOM)', -1).reason).toBe('memory');
    expect(explainFailure('RangeError: Array buffer allocation failed', 1).reason).toBe('memory');
    expect(explainFailure("Stream map '0:a:0' matches no streams.", 1).reason).toBe('input');
    expect(explainFailure('x.mp3: Invalid data found when processing input', 1).sentence).toMatch(/damaged/);
    expect(explainFailure('Unsupported sample rate', 1).reason).toBe('ffmpeg');
    expect(explainFailure('something odd', 7).sentence).toContain('code 7');
    expect(explainFailure('', null).sentence).toBe('ffmpeg stopped without finishing.');
  });

  it('wraps unexpected errors without losing a ConvertError that is already plain', () => {
    const plain = new ConvertError('limit', 'too big');
    expect(explainUnexpected(plain)).toBe(plain);
    expect(explainUnexpected(new RangeError('Array buffer allocation failed')).reason).toBe('memory');
    expect(explainUnexpected('just a string').message).toBe('The converter hit an unexpected problem: just a string');
    expect(explainUnexpected(new TypeError('x is not a function')).message).toBe('The converter hit an unexpected problem: TypeError: x is not a function');
  });

  it('puts the last log lines in the error message', () => {
    const log = new LogBuffer();
    for (let line = 1; line <= 20; line += 1) log.push(`log line ${line}`);
    log.push('x.mp3: Invalid data found when processing input');
    const error = failureError(log, 1, '"x.mp3"');
    expect(error).toBeInstanceOf(ConvertError);
    expect(error.reason).toBe('input');
    expect(error.message.startsWith('"x.mp3": ffmpeg could not read this file.')).toBe(true);
    expect(error.message).toContain('Last lines of the ffmpeg log:');
    expect(error.message).toContain('Invalid data found');
    expect(error.message).not.toContain('log line 1\n');
    expect(error.log).toContain('log line 1');
  });
});

describe('progress', () => {
  it('only goes forward, stays within 0 and 1, and skips tiny steps', () => {
    const seen: [number, string | undefined][] = [];
    const reporter = createReporter((fraction, message) => seen.push([fraction, message]));
    reporter.report(0.1, 'a');
    reporter.report(0.1001, 'a');
    reporter.report(0.05, 'a');
    reporter.report(0.1001, 'b');
    reporter.report(7, 'c');
    reporter.report(Number.NaN, 'd');
    expect(seen).toEqual([[0.1, 'a'], [0.1001, 'b'], [1, 'c']]);
  });

  it('maps a step onto its part of the whole job', () => {
    const seen: number[] = [];
    const reporter = createReporter((fraction) => seen.push(fraction));
    const step = reporter.range(0.2, 0.6);
    step.report(0);
    step.report(0.5);
    step.report(1);
    step.range(0, 0.5).report(1);
    expect(seen.map((value) => Number(value.toFixed(3)))).toEqual([0.2, 0.4, 0.6]);
  });

  it('survives a callback that throws, and works with no callback', () => {
    expect(() => createReporter(() => { throw new Error('page bug'); }).report(0.5)).not.toThrow();
    expect(() => createReporter().report(0.5)).not.toThrow();
  });

  it('works out a step fraction from the output time, else from ffmpeg ratio', () => {
    expect(stepFraction(30_000_000, 0, 60_000)).toBe(0.5);
    expect(stepFraction(90_000_000, 0, 60_000)).toBe(1);
    expect(stepFraction(1_000_000, 0.25, null)).toBe(0.25);
    expect(stepFraction(1_000_000, 7, null)).toBe(0);
    expect(stepFraction(Number.NaN, 0.4, 60_000)).toBe(0.4);
  });
});
