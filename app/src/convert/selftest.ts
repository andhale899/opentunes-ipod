/**
 * A page for the browser smoke test (opened with ?selftest=convert, never linked). It runs the
 * real converter, the real worker and the real wasm on inputs it makes itself, then reads each
 * result back with ffprobe and prints one line per case. app/scripts/smoke.mjs reads those lines.
 *
 * It only checks what ffmpeg itself reports about the output files (codec, size, chapters,
 * cover, container brand). It says nothing about playing on an iPod.
 */

import type { ConversionSpec } from '@opentunes/core';
import { loadFfmpegEngine } from './ffmpegEngine';
import { convertMedia, mergeAudiobook, ConvertError } from './index';

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  profile?: string;
  level?: number;
  width?: number;
  height?: number;
  pix_fmt?: string;
  r_frame_rate?: string;
  sample_rate?: string;
  channels?: number;
  disposition?: { attached_pic?: number };
}
interface ProbeJson {
  streams: ProbeStream[];
  chapters?: { start_time?: string; tags?: { title?: string } }[];
  format?: { duration?: string };
}

/** A 16-bit PCM WAV of a sine tone. */
function toneWav(seconds: number, rate: number, channels: number, frequency: number): Blob {
  const samples = Math.round(seconds * rate);
  const dataBytes = samples * channels * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string): void => {
    for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index);
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let sample = 0; sample < samples; sample += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * frequency * sample) / rate) * 12000);
    for (let channel = 0; channel < channels; channel += 1) view.setInt16(44 + (sample * channels + channel) * 2, value, true);
  }
  return new Blob([bytes], { type: 'audio/wav' });
}

/** A one-pixel PNG, as a stand-in for cover art. */
const TINY_PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (character) => character.charCodeAt(0));

const brand = (bytes: Uint8Array): string => String.fromCharCode(...bytes.slice(4, 12));
const hasFourcc = (bytes: Uint8Array, code: string): boolean => new TextDecoder('latin1').decode(bytes).includes(code);

/** Reads a file back with ffprobe in a throwaway ffmpeg instance. */
async function inspect(bytes: Uint8Array): Promise<ProbeJson> {
  const engine = await loadFfmpegEngine();
  try {
    await engine.writeFile('/inspect.bin', bytes);
    const text = await engine.ffprobe(['-v', 'error', '-show_streams', '-show_format', '-show_chapters', '-of', 'json', '/inspect.bin']);
    return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as ProbeJson;
  } finally {
    engine.terminate();
  }
}

/** Makes a small video with ffmpeg itself: a test pattern and a tone. */
async function makeTestVideo(width: number, height: number): Promise<Uint8Array> {
  const engine = await loadFfmpegEngine();
  try {
    const code = await engine.exec([
      '-f', 'lavfi', '-i', `testsrc=size=${width}x${height}:rate=25:duration=1,format=yuv420p`,
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      '-c:v', 'libx264', '-c:a', 'aac', '-shortest', '/pattern.mkv',
    ]);
    if (code !== 0) throw new Error(`ffmpeg could not make the test video (code ${code})`);
    return await engine.readFile('/pattern.mkv');
  } finally {
    engine.terminate();
  }
}

const audioSpec = (overrides: Partial<ConversionSpec> = {}): ConversionSpec => ({
  container: 'm4a',
  audio: { codec: 'aac', bitrateKbps: 128, sampleRateHz: 44100, channels: 2 },
  video: null,
  keepChapters: true,
  keepArtwork: true,
  keepTags: true,
  ...overrides,
});

type Case = () => Promise<string>;

function expectThat(condition: boolean, what: string): void {
  if (!condition) throw new Error(what);
}

const cases: [string, Case][] = [
  [
    'audio-aac',
    async () => {
      const input = { name: 'tone.wav', blob: toneWav(1, 44100, 1, 440) };
      const progress: number[] = [];
      const result = await convertMedia(input, audioSpec(), { onProgress: (fraction) => progress.push(fraction) });
      const probe = await inspect(result.bytes);
      const audio = probe.streams.find((stream) => stream.codec_type === 'audio');
      expectThat(brand(result.bytes).startsWith('ftyp'), `no ftyp box, found "${brand(result.bytes)}"`);
      expectThat(hasFourcc(result.bytes, 'mp4a'), 'no mp4a sample entry');
      expectThat(audio?.codec_name === 'aac' && audio.profile === 'LC', `audio is ${audio?.codec_name} ${audio?.profile}`);
      expectThat(audio?.sample_rate === '44100' && audio.channels === 2, `audio is ${audio?.sample_rate} Hz, ${audio?.channels} channels`);
      expectThat(result.fileName === 'tone.m4a', `file name ${result.fileName}`);
      expectThat(progress.at(-1) === 1 && progress.every((value, index) => index === 0 || value >= (progress[index - 1] ?? 0)), 'progress did not end at 1 going only forward');
      return `${result.bytes.length} bytes, ftyp ${brand(result.bytes).slice(4)}, codec mp4a, aac LC 44100 Hz stereo, duration ${Number(probe.format?.duration).toFixed(2)} s, ${progress.length} progress calls`;
    },
  ],
  [
    'audio-alac',
    async () => {
      const result = await convertMedia({ name: 'tone.wav', blob: toneWav(1, 44100, 2, 440) }, audioSpec({ audio: { codec: 'alac', sampleRateHz: 44100, channels: 2 } }));
      const probe = await inspect(result.bytes);
      expectThat(brand(result.bytes).startsWith('ftyp'), 'no ftyp box');
      expectThat(hasFourcc(result.bytes, 'alac'), 'no alac sample entry');
      expectThat(probe.streams.some((stream) => stream.codec_name === 'alac'), 'ffprobe does not see alac');
      return `${result.bytes.length} bytes, ftyp ${brand(result.bytes).slice(4)}, codec alac`;
    },
  ],
  [
    'audio-m4b-chapters-cover-tags',
    async () => {
      const result = await convertMedia({ name: 'book.wav', blob: toneWav(2, 44100, 2, 330) }, audioSpec({ container: 'm4b' }), {
        artwork: { mime: 'image/png', data: TINY_PNG },
        tags: { title: 'Self test', album: 'Self test book' },
        chapters: [{ startMs: 0, title: 'First' }, { startMs: 1000, title: 'Second' }],
      });
      const probe = await inspect(result.bytes);
      expectThat(result.fileName === 'book.m4b', `file name ${result.fileName}`);
      expectThat(probe.chapters?.length === 2 && probe.chapters[1]?.tags?.title === 'Second', `chapters: ${JSON.stringify(probe.chapters)}`);
      expectThat(hasFourcc(result.bytes, 'chpl'), 'no chpl atom');
      expectThat(hasFourcc(result.bytes, 'covr'), 'no covr atom');
      expectThat(hasFourcc(result.bytes, 'stik'), 'no stik atom');
      expectThat(probe.streams.some((stream) => stream.disposition?.attached_pic === 1), 'no attached picture');
      return `${result.bytes.length} bytes, ${probe.chapters?.length} chapters, chpl, covr, stik`;
    },
  ],
  [
    'video-h264',
    async () => {
      const pattern = await makeTestVideo(160, 120);
      const spec: ConversionSpec = {
        container: 'm4v',
        audio: { codec: 'aac', bitrateKbps: 96, sampleRateHz: 44100, channels: 2 },
        video: { codec: 'h264', profile: 'baseline', level: '3.0', maxWidth: 80, maxHeight: 60, maxFps: 15, maxBitrateKbps: 500 },
        keepChapters: false,
        keepArtwork: false,
        keepTags: true,
      };
      const result = await convertMedia({ name: 'pattern.mkv', blob: new Blob([pattern.slice()]) }, spec);
      const probe = await inspect(result.bytes);
      const video = probe.streams.find((stream) => stream.codec_type === 'video');
      const audio = probe.streams.find((stream) => stream.codec_type === 'audio');
      expectThat(brand(result.bytes).startsWith('ftyp'), 'no ftyp box');
      expectThat(hasFourcc(result.bytes, 'avc1'), 'no avc1 sample entry');
      expectThat(video?.codec_name === 'h264' && video.profile === 'Constrained Baseline', `video is ${video?.codec_name} ${video?.profile}`);
      expectThat(video?.width === 80 && video.height === 60, `video is ${video?.width}x${video?.height}`);
      expectThat(video?.pix_fmt === 'yuv420p', `pixel format ${video?.pix_fmt}`);
      expectThat(video?.level === 30, `level ${video?.level}`);
      expectThat(video?.r_frame_rate === '15/1', `frame rate ${video?.r_frame_rate}`);
      expectThat(audio?.codec_name === 'aac' && audio.profile === 'LC' && audio.channels === 2, `audio is ${audio?.codec_name} ${audio?.profile} ${audio?.channels} ch`);
      return `${result.bytes.length} bytes, ftyp ${brand(result.bytes).slice(4)}, codec avc1, h264 Constrained Baseline level 3.0, 160x120 scaled to ${video?.width}x${video?.height}, yuv420p, ${video?.r_frame_rate} fps, aac LC stereo`;
    },
  ],
  [
    'merge-m4b',
    async () => {
      const parts = [
        { name: 'Part 1.wav', blob: toneWav(1, 44100, 1, 440) },
        { name: 'Part 2.wav', blob: toneWav(2, 22050, 1, 330), title: 'The second part' },
      ];
      const result = await mergeAudiobook(parts, audioSpec({ container: 'm4b', audio: { codec: 'aac', bitrateKbps: 64 } }), { tags: { album: 'Merged' } });
      const probe = await inspect(result.bytes);
      const chapters = probe.chapters ?? [];
      const second = Number(chapters[1]?.start_time);
      expectThat(result.fileName === 'Merged.m4b', `file name ${result.fileName}`);
      expectThat(chapters.length === 2 && chapters[0]?.tags?.title === 'Part 1' && chapters[1]?.tags?.title === 'The second part', `chapters: ${JSON.stringify(chapters)}`);
      expectThat(second > 1.0 && second < 1.1, `second chapter starts at ${second} s`);
      const duration = Number(probe.format?.duration);
      expectThat(duration > 3.0 && duration < 3.2, `duration ${duration} s`);
      expectThat(hasFourcc(result.bytes, 'stik') && hasFourcc(result.bytes, 'chpl'), 'no stik or chpl atom');
      return `${result.bytes.length} bytes, 2 chapters (second at ${second.toFixed(3)} s), duration ${duration.toFixed(2)} s, one rate ${probe.streams[0]?.sample_rate} Hz`;
    },
  ],
  [
    'cancel',
    async () => {
      // About 6 minutes of audio: long enough that ffmpeg is still running when the cancel arrives.
      const input = { name: 'long.wav', blob: toneWav(360, 44100, 2, 440) };
      const controller = new AbortController();
      const began = performance.now();
      let cancelledAt = 0;
      let fractionAtCancel = 0;
      const promise = convertMedia(input, audioSpec(), {
        signal: controller.signal,
        onProgress: (fraction, message) => {
          // Wait for real ffmpeg progress (10 percent of the whole job), then cancel.
          if (message === 'Converting the audio' && fraction >= 0.1 && cancelledAt === 0) {
            cancelledAt = performance.now();
            fractionAtCancel = fraction;
            controller.abort();
          }
        },
      });
      const error = await promise.then(() => null, (reason: unknown) => reason);
      const settled = performance.now();
      expectThat(cancelledAt > 0, 'ffmpeg never made progress, so the cancel was not tested');
      expectThat(error instanceof DOMException && error.name === 'AbortError', `rejected with ${String(error)}`);
      expectThat(settled - cancelledAt < 1000, `took ${Math.round(settled - cancelledAt)} ms to stop`);
      return `ffmpeg was ${Math.round(fractionAtCancel * 100)} percent through after ${Math.round(cancelledAt - began)} ms, rejected with AbortError ${Math.round(settled - cancelledAt)} ms after cancelling`;
    },
  ],
  [
    'error-message',
    async () => {
      const error = await convertMedia({ name: 'broken.mp3', blob: new Blob([new Uint8Array(4000).fill(7)]) }, audioSpec()).then(() => null, (reason: unknown) => reason);
      expectThat(error instanceof ConvertError && error.reason === 'input', `rejected with ${String(error)}`);
      expectThat(error instanceof ConvertError && error.message.includes('"broken.mp3" could not be read as audio or video'), 'message is not plain');
      return `ConvertError (${(error as ConvertError).reason}): ${(error as ConvertError).message.split('\n')[0]}`;
    },
  ],
];

/** Runs every case, one after another, and writes one line each into the page. */
export async function renderConvertSelfTest(root: HTMLElement): Promise<void> {
  const pre = document.createElement('pre');
  pre.id = 'convert-selftest';
  pre.textContent = `Converter self test (crossOriginIsolated: ${String(self.crossOriginIsolated)})\n`;
  root.replaceChildren(pre);

  let failed = 0;
  for (const [name, run] of cases) {
    const started = performance.now();
    try {
      const detail = await run();
      pre.textContent += `convert ${name}: ok, ${detail} (${Math.round(performance.now() - started)} ms)\n`;
    } catch (error) {
      failed += 1;
      pre.textContent += `convert ${name}: FAILED, ${error instanceof Error ? error.message : String(error)}\n`;
    }
  }
  pre.textContent += failed === 0 ? 'convert self test: all cases ok\n' : `convert self test: ${failed} cases failed\n`;
  if (failed > 0) pre.setAttribute('role', 'alert');
  pre.dataset.done = 'true';
}
