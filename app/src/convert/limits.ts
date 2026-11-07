/**
 * Size limits of the browser converter, and why. Pure, no worker and no wasm.
 *
 * Why the single-thread core (`@ffmpeg/core`) and not the multi-thread one (tested 2026-11-07,
 * headless Chrome 10 cores, macOS):
 *  - 640x480 baseline encode of 5 s: single 3.8 s wall, multi 1.6 s. Multi is about 3x faster.
 *  - A 1080p test source (10 s): single finished in 5.3 s. Multi gave no answer in 45 s and in
 *    an earlier run none in 180 s, so it hangs rather than failing. A hang is the one outcome
 *    the converter must never have.
 *  - The multi core's heap is fixed at 1 GiB shared memory and cannot grow. The single core
 *    starts at 32 MiB and can grow to 2 GiB.
 *  Audio is unaffected by the choice: the AAC encoder is single threaded either way, and runs
 *  at about 70x real time in the single core (30 minutes of audio in 25 s).
 *
 * Where the memory goes:
 *  - Input files are mounted into ffmpeg with WORKERFS, which reads the Blob in slices.
 *    Nothing is copied into memory, so the input size is not the limit (a 300 MB WAV input was
 *    tested; inputs over 2 GiB were not).
 *  - The output file lives in ffmpeg's in-memory file system, then `readFile` copies it so it
 *    can be handed to the page. So the peak is about twice the output size.
 *  - Measured: a 1.5 GB output was written and read back in full. A 2.3 GB output was written
 *    but `readFile` then never answered (no error, no result in 150 s). So about 2 GiB is the
 *    hard edge, and it fails silently.
 *  - WebAssembly memory is never given back to the browser, so every job gets its own ffmpeg
 *    instance and the worker is terminated when the job ends. That is the only real "free".
 *
 * So `MAX_OUTPUT_BYTES` is set to 1 GiB, well under the 2 GiB edge, so a machine with less
 * memory than the 16 GB test machine still has room for the doubled peak. Beyond it the
 * converter says so before it starts (audio) or lowers the video bitrate cap so the file
 * cannot pass the limit (video), and refuses only when even that cannot fit.
 */

export const MAX_OUTPUT_BYTES = 1024 * 1024 * 1024;

/** Video below this bitrate is not worth making, so a job that would need less is refused instead. */
export const MIN_VIDEO_KBPS = 200;

/** If ffmpeg prints nothing and reports no progress for this long, the job is treated as stuck. */
export const STALL_TIMEOUT_MS = 120_000;

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Bytes an AAC file of this length and bitrate takes, with 3 percent for the container. */
export function estimateAacBytes(durationMs: number, bitrateKbps: number): number {
  return Math.ceil(((durationMs / 1000) * bitrateKbps * 1000 * 1.03) / 8);
}

/**
 * Upper bound for an Apple Lossless file: plain 16-bit audio of the same length. Real files are
 * smaller (often 50 to 70 percent), so this can only over-estimate, never let a too-large job through.
 */
export function estimateAlacBytes(durationMs: number, sampleRateHz: number, channels: number): number {
  return Math.ceil((durationMs / 1000) * sampleRateHz * channels * 2);
}

export type VideoFit = { ok: true; maxrateKbps: number; lowered: boolean } | { ok: false; neededKbps: number };

/**
 * The video bitrate cap that keeps the whole file under `capBytes`. The file cannot be larger
 * than (video cap + audio) x duration, because the encoder is held to the cap, so lowering the
 * cap is a guarantee and not a guess. Returns the wanted cap when it already fits.
 */
export function fitVideoBitrate(wantedKbps: number, audioKbps: number, durationMs: number, capBytes: number = MAX_OUTPUT_BYTES): VideoFit {
  const seconds = durationMs / 1000;
  const totalKbpsAllowed = (capBytes * 8) / 1000 / 1.03 / seconds;
  const videoAllowed = Math.floor(totalKbpsAllowed - audioKbps);
  if (videoAllowed >= wantedKbps) return { ok: true, maxrateKbps: wantedKbps, lowered: false };
  if (videoAllowed < MIN_VIDEO_KBPS) return { ok: false, neededKbps: MIN_VIDEO_KBPS };
  return { ok: true, maxrateKbps: videoAllowed, lowered: true };
}
