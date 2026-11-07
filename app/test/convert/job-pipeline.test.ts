import { describe, expect, it } from 'vitest';
import type { Engine } from '../../src/convert/engine';
import { ConvertError } from '../../src/convert/errors';
import { runJob } from '../../src/convert/job';
import { runConvert, runMerge } from '../../src/convert/pipeline';
import { adtsStream, after, audioSpec, fakeMp4, hasSequence, videoSpec } from './helpers';

/** ffprobe text for a simple file. */
function probeText(options: { audio?: boolean; video?: boolean; seconds?: number; channels?: number; rate?: number } = {}): string {
  const streams: unknown[] = [];
  if (options.video) streams.push({ index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, sample_aspect_ratio: '1:1', disposition: { attached_pic: 0 } });
  if (options.audio !== false) streams.push({ index: streams.length, codec_type: 'audio', codec_name: 'flac', sample_rate: String(options.rate ?? 44100), channels: options.channels ?? 2, disposition: { attached_pic: 0 } });
  return JSON.stringify({ streams, format: { duration: String(options.seconds ?? 60) } });
}

interface FakeOptions {
  probe?: (path: string) => string;
  exec?: (args: string[], engine: FakeEngine) => Promise<number>;
  frames?: number[];
}

class FakeEngine implements Engine {
  calls: string[][] = [];
  probes: string[] = [];
  files = new Map<string, Uint8Array>();
  dirs: string[] = [];
  mounted: { mountPoint: string; names: string[] }[] = [];
  deleted: string[] = [];
  terminated = 0;
  reads: string[] = [];
  private log: (message: string) => void = () => undefined;
  private progress: (timeMicros: number, ratio: number) => void = () => undefined;
  private partCount = 0;

  constructor(private readonly options: FakeOptions = {}) {}

  onLog(handler: (message: string) => void) {
    this.log = handler;
  }
  onProgress(handler: (timeMicros: number, ratio: number) => void) {
    this.progress = handler;
  }
  async exec(args: string[]): Promise<number> {
    this.calls.push(args);
    if (this.options.exec) return this.options.exec(args, this);
    const output = args[args.length - 1] ?? '';
    this.log('size=       0kB time=00:00:00.00');
    this.progress(500_000, 0.5);
    if (output.endsWith('.aac')) {
      this.files.set(output, adtsStream(this.options.frames?.[this.partCount] ?? 40));
      this.partCount += 1;
    } else {
      this.files.set(output, fakeMp4());
    }
    this.progress(60_000_000, 1);
    return 0;
  }
  async ffprobe(args: string[]): Promise<string> {
    const path = args[args.length - 1] ?? '';
    this.probes.push(path);
    return (this.options.probe ?? (() => probeText()))(path);
  }
  async writeFile(path: string, data: Uint8Array) {
    this.files.set(path, data);
  }
  async readFile(path: string) {
    this.reads.push(path);
    const data = this.files.get(path);
    if (!data) throw new Error(`no file ${path}`);
    return data;
  }
  async deleteFile(path: string) {
    this.deleted.push(path);
    this.files.delete(path);
  }
  async createDir(path: string) {
    this.dirs.push(path);
  }
  async mountBlobs(mountPoint: string, blobs: { name: string; data: Blob }[]) {
    this.mounted.push({ mountPoint, names: blobs.map((blob) => blob.name) });
  }
  terminate() {
    this.terminated += 1;
  }
}

const blob = (size = 10) => new Blob([new Uint8Array(size)]);
const factory = (engine: Engine) => async () => engine;
const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);

describe('convertMedia steps', () => {
  it('converts audio: mounts the input, probes it, runs ffmpeg once, returns the bytes and the new name', async () => {
    const engine = new FakeEngine();
    const progress: number[] = [];
    const result = await runJob(factory(engine), { onProgress: (fraction) => progress.push(fraction) }, (context) =>
      runConvert(context, { name: 'My Song.flac', blob: blob() }, audioSpec(), {}),
    );

    expect(result.fileName).toBe('My Song.m4a');
    expect(result.bytes.length).toBe(64);
    expect(engine.mounted).toEqual([{ mountPoint: '/in', names: ['input.flac'] }]);
    expect(engine.probes).toEqual(['/in/input.flac']);
    expect(engine.calls).toHaveLength(1);
    const args = engine.calls[0] ?? [];
    expect(hasSequence(args, '-i', '/in/input.flac')).toBe(true);
    expect(args.at(-1)).toBe('/work/output.m4a');
    expect(hasSequence(args, '-c:a', 'aac', '-profile:a', 'aac_low', '-b:a', '256k')).toBe(true);
    expect(result.log).toContain('$ ffmpeg -hide_banner');
    // Progress only goes forward and ends at 1. The worker is ended.
    expect(progress.at(-1)).toBe(1);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(engine.terminated).toBe(1);
  });

  it('writes the chapters and the cover the caller gave, when the spec keeps them', async () => {
    const engine = new FakeEngine();
    const cover = { mime: 'image/png', data: new Uint8Array([1, 2, 3]) };
    await runJob(factory(engine), {}, (context) =>
      runConvert(context, { name: 'book.mp3', blob: blob() }, audioSpec({ container: 'm4b' }), {
        artwork: cover,
        tags: { album: 'Book' },
        chapters: [{ startMs: 30_000, title: 'Two' }, { startMs: 0, title: 'One' }],
      }),
    );
    expect(text(engine.files.get('/work/chapters.ffmeta'))).toBe(
      ';FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=30000\ntitle=One\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=30000\nEND=60000\ntitle=Two\n',
    );
    expect(engine.files.get('/work/cover.png')).toEqual(cover.data);
    const args = engine.calls[0] ?? [];
    expect(hasSequence(args, '-map_chapters', '1')).toBe(true);
    expect(args).toContain('album=Book');
  });

  it('writes neither chapters nor cover when the spec drops them', async () => {
    const engine = new FakeEngine();
    await runJob(factory(engine), {}, (context) =>
      runConvert(context, { name: 'a.mp3', blob: blob() }, audioSpec({ keepChapters: false, keepArtwork: false, keepTags: false }), {
        artwork: { mime: 'image/png', data: new Uint8Array([1]) },
        tags: { title: 'x' },
        chapters: [{ startMs: 0, title: 'One' }],
      }),
    );
    expect([...engine.files.keys()].sort()).toEqual(['/work/output.m4a']);
    expect(engine.calls[0]).not.toContain('title=x');
  });

  it('converts video and lowers the bitrate cap for a film that would not fit in memory', async () => {
    const engine = new FakeEngine({ probe: () => probeText({ video: true, seconds: 2 * 3600 }) });
    const progress: [number, string | undefined][] = [];
    const result = await runJob(factory(engine), { onProgress: (fraction, message) => progress.push([fraction, message]) }, (context) =>
      runConvert(context, { name: 'film.mkv', blob: blob() }, videoSpec(), {}),
    );
    expect(result.fileName).toBe('film.m4v');
    const args = engine.calls[0] ?? [];
    const maxrate = Number(after(args, '-maxrate')?.replace('k', ''));
    expect(maxrate).toBeGreaterThan(200);
    expect(maxrate).toBeLessThan(2500);
    expect(result.log).toMatch(/Video bitrate cap lowered from 2500 to \d+ kbps/);
    expect(progress.some(([, message]) => message?.includes('lowered'))).toBe(true);
    expect(after(args, '-filter:v:0')).toBe('scale=640:360:flags=lanczos,setsar=1,format=yuv420p');
  });

  it('refuses before doing any work when the input has no audio, no video, or cannot be read', async () => {
    const noAudio = new FakeEngine({ probe: () => probeText({ audio: false, video: true }) });
    await expect(runJob(factory(noAudio), {}, (context) => runConvert(context, { name: 'clip.mp4', blob: blob() }, audioSpec(), {}))).rejects.toThrow('"clip.mp4" has no audio to convert.');
    expect(noAudio.calls).toHaveLength(0);
    expect(noAudio.terminated).toBe(1);

    const noVideo = new FakeEngine();
    await expect(runJob(factory(noVideo), {}, (context) => runConvert(context, { name: 'a.flac', blob: blob() }, videoSpec(), {}))).rejects.toThrow('has no video to convert');

    const junk = new FakeEngine({ probe: () => '' });
    const error = await runJob(factory(junk), {}, (context) => runConvert(context, { name: 'junk.bin', blob: blob() }, audioSpec(), {})).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConvertError);
    expect((error as ConvertError).reason).toBe('input');
    expect((error as ConvertError).message).toContain('"junk.bin" could not be read as audio or video');
  });

  it('refuses a job that cannot fit in memory before ffmpeg starts', async () => {
    const engine = new FakeEngine({ probe: () => probeText({ seconds: 80 * 3600 }) });
    const error = await runJob(factory(engine), {}, (context) => runConvert(context, { name: 'huge.wav', blob: blob() }, audioSpec(), {})).catch((e: unknown) => e);
    expect((error as ConvertError).reason).toBe('limit');
    expect(engine.calls).toHaveLength(0);
  });

  it('refuses a spec that does not match its container', async () => {
    const engine = new FakeEngine();
    await expect(runJob(factory(engine), {}, (context) => runConvert(context, { name: 'a.mp3', blob: blob() }, videoSpec({ video: null }), {}))).rejects.toThrow(/gives no video settings/);
    expect(engine.probes).toHaveLength(0);
  });

  it('explains an ffmpeg failure in plain words with the last lines of the log', async () => {
    const engine = new FakeEngine({
      exec: async (_args, self) => {
        self['log']('Input #0, mp3, from input.mp3:');
        self['log']('input.mp3: Invalid data found when processing input');
        return 1;
      },
    });
    const error = await runJob(factory(engine), {}, (context) => runConvert(context, { name: 'bad.mp3', blob: blob() }, audioSpec(), {})).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConvertError);
    const convertError = error as ConvertError;
    expect(convertError.reason).toBe('input');
    expect(convertError.message).toContain('ffmpeg could not read this file');
    expect(convertError.message).toContain('Last lines of the ffmpeg log:');
    expect(convertError.message).toContain('Invalid data found when processing input');
    expect(convertError.log).toContain('$ ffmpeg');
    expect(engine.terminated).toBe(1);
  });

  it('reports a memory abort as a memory problem', async () => {
    const engine = new FakeEngine({
      exec: async (_args, self) => {
        self['log']('Aborted(OOM)');
        return -1;
      },
    });
    const error = await runJob(factory(engine), {}, (context) => runConvert(context, { name: 'a.mp3', blob: blob() }, audioSpec(), {})).catch((e: unknown) => e);
    expect((error as ConvertError).reason).toBe('memory');
    expect((error as ConvertError).message).toContain('ran out of memory');
  });

  it('rejects an output that is not an MP4 file, and an empty one', async () => {
    const wrong = new FakeEngine({ exec: async (args, self) => { self.files.set(args.at(-1) ?? '', new Uint8Array(64)); return 0; } });
    await expect(runJob(factory(wrong), {}, (context) => runConvert(context, { name: 'a.mp3', blob: blob() }, audioSpec(), {}))).rejects.toThrow(/not an MP4-family file/);
    const empty = new FakeEngine({ exec: async (args, self) => { self.files.set(args.at(-1) ?? '', new Uint8Array(0)); return 0; } });
    await expect(runJob(factory(empty), {}, (context) => runConvert(context, { name: 'a.mp3', blob: blob() }, audioSpec(), {}))).rejects.toThrow(/empty file/);
  });
});

describe('cancel and stall', () => {
  it('rejects with an AbortError and ends the worker when the signal fires during ffmpeg', async () => {
    const engine = new FakeEngine({ exec: () => new Promise<number>(() => undefined) });
    const controller = new AbortController();
    const promise = runJob(factory(engine), { signal: controller.signal, stallTimeoutMs: 0 }, (context) => runConvert(context, { name: 'a.mp3', blob: blob() }, audioSpec(), {}));
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    const error = await promise.catch((e: unknown) => e);
    expect((error as Error).name).toBe('AbortError');
    expect(engine.terminated).toBe(1);
  });

  it('never even starts the converter for a signal that is already aborted', async () => {
    let created = 0;
    const controller = new AbortController();
    controller.abort();
    const error = await runJob(async () => { created += 1; return new FakeEngine(); }, { signal: controller.signal }, async () => 'unreachable').catch((e: unknown) => e);
    expect((error as Error).name).toBe('AbortError');
    expect(created).toBe(0);
  });

  it('ends a converter that was still loading when cancelled', async () => {
    const engine = new FakeEngine();
    let release!: () => void;
    const controller = new AbortController();
    const promise = runJob(
      () => new Promise<Engine>((resolve) => { release = () => resolve(engine); }),
      { signal: controller.signal, stallTimeoutMs: 0 },
      async () => 'unreachable',
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(engine.terminated).toBe(1);
  });

  it('gives up with a clear error when ffmpeg goes silent, instead of hanging', async () => {
    const engine = new FakeEngine({ exec: () => new Promise<number>(() => undefined) });
    const started = Date.now();
    const error = await runJob(factory(engine), { stallTimeoutMs: 80 }, (context) => runConvert(context, { name: 'a.mp3', blob: blob() }, audioSpec(), {})).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConvertError);
    expect((error as ConvertError).reason).toBe('stalled');
    expect((error as ConvertError).message).toContain('stopped responding');
    expect(Date.now() - started).toBeLessThan(2000);
    expect(engine.terminated).toBe(1);
  });

  it('does not call a long job stalled while it keeps printing', async () => {
    const engine = new FakeEngine({
      exec: async (args, self) => {
        for (let tick = 0; tick < 6; tick += 1) {
          self['log'](`size=  ${tick}kB time=00:00:0${tick}.00`);
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
        self.files.set(args.at(-1) ?? '', fakeMp4());
        return 0;
      },
    });
    const result = await runJob(factory(engine), { stallTimeoutMs: 100 }, (context) => runConvert(context, { name: 'a.mp3', blob: blob() }, audioSpec(), {}));
    expect(result.bytes.length).toBe(64);
  });

  it('turns a failure of the work itself into a plain ConvertError and still ends the worker', async () => {
    const engine = new FakeEngine();
    const error = await runJob(factory(engine), {}, async () => { throw new Error('boom'); }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConvertError);
    expect((error as ConvertError).message).toBe('The converter hit an unexpected problem: boom');
    expect(engine.terminated).toBe(1);
  });

  it('says in plain words when the browser cannot read the picked file', async () => {
    const engine = new FakeEngine({ probe: () => { throw new DOMException("Failed to execute 'readAsArrayBuffer' on 'FileReaderSync': The requested file could not be read, typically due to permission problems", 'NotReadableError'); } });
    const error = await runJob(factory(engine), {}, (context) => runConvert(context, { name: 'a.wav', blob: blob() }, audioSpec(), {})).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConvertError);
    expect((error as ConvertError).reason).toBe('input');
    expect((error as ConvertError).message).toBe('The file could not be read. It may have been moved, deleted or changed after it was picked, or it is too large for this browser to read.');
  });

  it('says when the converter could not start', async () => {
    const error = await runJob(async () => { throw new Error('Failed to fetch'); }, {}, async () => 'unreachable').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConvertError);
    expect((error as ConvertError).message).toBe('The converter hit an unexpected problem: Failed to fetch');
  });
});

describe('mergeAudiobook steps', () => {
  const parts = [
    { name: 'Part 1.mp3', blob: blob(100) },
    { name: 'Part 2.mp3', blob: blob(300), title: 'The Middle' },
    { name: 'Part 3.m4a', blob: blob(100) },
  ];
  const spec = audioSpec({ container: 'm4b', audio: { codec: 'aac', bitrateKbps: 64, sampleRateHz: 44100, channels: 1 } });

  it('encodes each part, counts frames, writes a chapter per part, joins, and deletes the parts before reading the book', async () => {
    const engine = new FakeEngine({ frames: [45, 109, 10], probe: () => probeText({ seconds: 60, channels: 1 }) });
    const progress: number[] = [];
    const result = await runJob(factory(engine), { onProgress: (fraction) => progress.push(fraction) }, (context) =>
      runMerge(context, parts, spec, { tags: { album: 'My Book: Vol. 1', artist: 'Someone' }, artwork: { mime: 'image/jpeg', data: new Uint8Array([9, 9]) } }),
    );

    expect(engine.mounted[0]?.names).toEqual(['part-in-000.mp3', 'part-in-001.mp3', 'part-in-002.m4a']);
    expect(engine.probes).toHaveLength(3);
    // Three part encodes, then the join.
    expect(engine.calls).toHaveLength(4);
    expect(engine.calls[0]?.at(-1)).toBe('/work/part-000.aac');
    expect(hasSequence(engine.calls[1] ?? [], '-c:a', 'aac', '-profile:a', 'aac_low', '-b:a', '64k', '-ar', '44100', '-ac', '1', '-f', 'adts')).toBe(true);
    const join = engine.calls[3] ?? [];
    expect(hasSequence(join, '-i', 'concat:/work/part-000.aac|/work/part-001.aac|/work/part-002.aac')).toBe(true);
    expect(hasSequence(join, '-c:a', 'copy')).toBe(true);
    expect(join).toContain('album=My Book: Vol. 1');
    expect(join).toContain('media_type=2');
    expect(join.at(-1)).toBe('/work/book.m4b');

    // 45, 109 and 10 frames at 44.1 kHz.
    expect(text(engine.files.get('/work/chapters.ffmeta'))).toBe(
      [
        ';FFMETADATA1',
        '[CHAPTER]', 'TIMEBASE=1/1000', 'START=0', 'END=1045', 'title=Part 1',
        '[CHAPTER]', 'TIMEBASE=1/1000', 'START=1045', 'END=3576', 'title=The Middle',
        '[CHAPTER]', 'TIMEBASE=1/1000', 'START=3576', 'END=3808', 'title=Part 3',
        '',
      ].join('\n'),
    );

    expect(engine.deleted).toEqual(['/work/part-000.aac', '/work/part-001.aac', '/work/part-002.aac']);
    expect(engine.reads.at(-1)).toBe('/work/book.m4b');
    expect(result.fileName).toBe('My Book_ Vol. 1.m4b');
    expect(progress.at(-1)).toBe(1);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(engine.terminated).toBe(1);
  });

  it('names the book after its first part when no album or title is given', async () => {
    const engine = new FakeEngine({ probe: () => probeText({ seconds: 60 }) });
    const result = await runJob(factory(engine), {}, (context) => runMerge(context, parts.slice(0, 1), spec, {}));
    expect(result.fileName).toBe('Part 1.m4b');
    expect(engine.calls).toHaveLength(2);
  });

  it('says which part is the problem', async () => {
    const engine = new FakeEngine({ probe: (path) => (path.includes('001') ? '' : probeText({ seconds: 60 })) });
    await expect(runJob(factory(engine), {}, (context) => runMerge(context, parts, spec, {}))).rejects.toThrow('"Part 2.mp3" could not be read');
    expect(engine.calls).toHaveLength(0);

    const failing = new FakeEngine({
      probe: () => probeText({ seconds: 60 }),
      exec: async (args, self) => {
        if (args.at(-1) === '/work/part-001.aac') {
          self['log']('Invalid data found when processing input');
          return 1;
        }
        self.files.set(args.at(-1) ?? '', adtsStream(10));
        return 0;
      },
    });
    await expect(runJob(factory(failing), {}, (context) => runMerge(context, parts, spec, {}))).rejects.toThrow(/"Part 2.mp3": ffmpeg could not read this file/);

    const silent = new FakeEngine({ probe: (path) => (path.includes('002') ? probeText({ audio: false, video: true }) : probeText()) });
    await expect(runJob(factory(silent), {}, (context) => runMerge(context, parts, spec, {}))).rejects.toThrow('"Part 3.m4a" has no audio to merge.');
  });

  it('refuses an empty list, a video spec, and a book too long for memory', async () => {
    const engine = new FakeEngine();
    await expect(runJob(factory(engine), {}, (context) => runMerge(context, [], spec, {}))).rejects.toThrow('Pick at least one file');
    await expect(runJob(factory(engine), {}, (context) => runMerge(context, parts, videoSpec(), {}))).rejects.toThrow(/audio spec/);
    const huge = new FakeEngine({ probe: () => probeText({ seconds: 200 * 3600 }) });
    const error = await runJob(factory(huge), {}, (context) => runMerge(context, parts, audioSpec({ container: 'm4b', audio: { codec: 'aac', bitrateKbps: 192 } }), {})).catch((e: unknown) => e);
    expect((error as ConvertError).reason).toBe('limit');
    expect(huge.calls).toHaveLength(0);
  });

  it('can be cancelled in the middle of a part', async () => {
    const engine = new FakeEngine({ probe: () => probeText({ seconds: 60 }), exec: () => new Promise<number>(() => undefined) });
    const controller = new AbortController();
    const promise = runJob(factory(engine), { signal: controller.signal, stallTimeoutMs: 0 }, (context) => runMerge(context, parts, spec, {}));
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(engine.terminated).toBe(1);
  });
});
