/**
 * What the converter needs from ffmpeg. The real one is ffmpegEngine.ts (ffmpeg.wasm in a web
 * worker). Keeping it as an interface lets the whole job logic (probe, arguments, progress,
 * cancel, stall detection, errors) be tested in Node with a fake. No wasm is imported here.
 */

export interface Engine {
  /** Called for every line ffmpeg prints (one handler, a new call replaces it). */
  onLog(handler: (message: string) => void): void;
  /** Called as ffmpeg writes output: how much, in microseconds, and ffmpeg's own 0 to 1 guess. */
  onProgress(handler: (timeMicros: number, ratio: number) => void): void;
  /** Runs ffmpeg. Resolves with its exit code, 0 for success. */
  exec(args: string[]): Promise<number>;
  /** Runs ffprobe and returns what it printed on standard output. Its exit code is not reliable in the wasm build. */
  ffprobe(args: string[]): Promise<string>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  deleteFile(path: string): Promise<void>;
  createDir(path: string): Promise<void>;
  /** Makes Blobs readable at `mountPoint/name` without copying them into memory. */
  mountBlobs(mountPoint: string, blobs: { name: string; data: Blob }[]): Promise<void>;
  /** Ends the worker and frees all of its memory. Calls still waiting never settle. */
  terminate(): void;
}

export type EngineFactory = () => Promise<Engine>;
