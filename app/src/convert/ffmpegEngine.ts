/**
 * The real engine: ffmpeg.wasm (single thread core, version pinned in package.json) running in
 * the web worker that @ffmpeg/ffmpeg starts. This is the only file that imports the library.
 *
 * Everything is loaded from the app's own origin, from `ffmpeg/` next to the page. The files
 * are copied there from node_modules by `app/scripts/sync-ffmpeg.mjs` before `dev` and `build`.
 * Nothing comes from a CDN. A new instance (and so a new worker) is made for every job, because
 * WebAssembly memory is never handed back until the worker ends, see limits.ts.
 */

import { FFFSType, FFmpeg } from '@ffmpeg/ffmpeg';
import type { Engine } from './engine';
import { ConvertError } from './errors';

function coreUrl(file: string): string {
  // `base` is "./" in vite.config.ts, so the files are found relative to the page, wherever it is served from.
  return new URL(`${import.meta.env.BASE_URL}ffmpeg/${file}`, document.baseURI).href;
}

/** The library rejects with plain strings. Make them real errors with their message. */
async function guard<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    throw error instanceof Error ? error : new Error(typeof error === 'string' ? error : String(error));
  }
}

export async function loadFfmpegEngine(): Promise<Engine> {
  const ffmpeg = new FFmpeg();
  let logHandler: (message: string) => void = () => undefined;
  let progressHandler: (timeMicros: number, ratio: number) => void = () => undefined;
  let captured: string[] | null = null;

  ffmpeg.on('log', ({ type, message }) => {
    // ffprobe prints its answer on standard output. ffmpeg's own messages come on standard error.
    if (captured && type === 'stdout') captured.push(message);
    else logHandler(message);
  });
  ffmpeg.on('progress', ({ progress, time }) => progressHandler(time, progress));

  try {
    await ffmpeg.load({ coreURL: coreUrl('ffmpeg-core.js'), wasmURL: coreUrl('ffmpeg-core.wasm') });
  } catch (error) {
    ffmpeg.terminate();
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConvertError('ffmpeg', `The converter could not start (${reason}). The ffmpeg files are copied into app/public/ffmpeg by \`npm run dev\` and \`npm run build\`.`);
  }

  return {
    onLog: (handler) => {
      logHandler = handler;
    },
    onProgress: (handler) => {
      progressHandler = handler;
    },
    exec: (args) => guard(ffmpeg.exec(args)),
    ffprobe: async (args) => {
      captured = [];
      try {
        await guard(ffmpeg.ffprobe(args));
        return captured.join('\n');
      } finally {
        captured = null;
      }
    },
    writeFile: async (path, data) => {
      // The library moves the buffer to its worker, which empties the caller's array. A copy keeps
      // the caller's artwork bytes usable for the next track. Only covers and small files go through here.
      await guard(ffmpeg.writeFile(path, data.slice()));
    },
    readFile: async (path) => {
      const data = await guard(ffmpeg.readFile(path));
      return typeof data === 'string' ? new TextEncoder().encode(data) : data;
    },
    deleteFile: async (path) => {
      await guard(ffmpeg.deleteFile(path));
    },
    createDir: async (path) => {
      await guard(ffmpeg.createDir(path));
    },
    mountBlobs: async (mountPoint, blobs) => {
      const mounted = await guard(ffmpeg.mount(FFFSType.WORKERFS, { blobs }, mountPoint));
      if (!mounted) throw new Error('This ffmpeg build cannot mount files without copying them.');
    },
    terminate: () => ffmpeg.terminate(),
  };
}
