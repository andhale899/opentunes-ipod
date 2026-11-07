import type { Reader } from './reader';
import { addWarning, type ProbeState } from './state';

/** AAC in ADTS frames (.aac files): sample rate, channels and a length. */

const ADTS_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
const ADTS_CHANNELS = [0, 1, 2, 3, 4, 5, 6, 8];

export interface AdtsHeader {
  sampleRateHz: number;
  channelConfig: number;
  frameLength: number;
}

export function parseAdtsHeader(b: Uint8Array, o: number): AdtsHeader | null {
  if (o < 0 || o + 7 > b.length) return null;
  if (b[o] !== 0xff || ((b[o + 1] ?? 0) & 0xf6) !== 0xf0) return null;
  const b1 = b[o + 1] ?? 0;
  const b2 = b[o + 2] ?? 0;
  const b3 = b[o + 3] ?? 0;
  const b4 = b[o + 4] ?? 0;
  const b5 = b[o + 5] ?? 0;
  const rate = ADTS_RATES[(b2 >> 2) & 15];
  if (rate === undefined) return null;
  const channelConfig = ((b2 & 1) << 2) | (b3 >> 6);
  const frameLength = ((b3 & 3) << 11) | (b4 << 3) | (b5 >> 5);
  const headerLength = (b1 & 1) === 1 ? 7 : 9;
  if (frameLength < headerLength) return null;
  return { sampleRateHz: rate, channelConfig, frameLength };
}

const WINDOW_BYTES = 256 * 1024;
const SAMPLES_PER_FRAME = 1024;

/** Reads the first frames after `start`. `audioEnd` is where the audio stops. Returns false when no frame was found. */
export async function readAdtsAudio(r: Reader, state: ProbeState, start: number, audioEnd: number): Promise<boolean> {
  const buf = await r.read(start, WINDOW_BYTES);
  const bufferIsFileEnd = start + buf.length >= r.size;

  let first = -1;
  let h: AdtsHeader | null = null;
  for (let i = 0; i + 7 <= buf.length; i += 1) {
    if (buf[i] !== 0xff || ((buf[i + 1] ?? 0) & 0xf6) !== 0xf0) continue;
    const candidate = parseAdtsHeader(buf, i);
    if (!candidate) continue;
    const next = parseAdtsHeader(buf, i + candidate.frameLength);
    const sameNext = next !== null && next.sampleRateHz === candidate.sampleRateHz && next.channelConfig === candidate.channelConfig;
    const lastFrame = i + candidate.frameLength + 7 > buf.length && bufferIsFileEnd;
    if (sameNext || lastFrame) {
      first = i;
      h = candidate;
      break;
    }
  }
  if (first < 0 || !h) return false;
  if (first > 0) addWarning(state, `The audio does not start where the tags end: ${first} bytes of other data come first.`);

  let pos = first;
  let frames = 0;
  while (pos + 7 <= buf.length) {
    const next = parseAdtsHeader(buf, pos);
    if (!next || next.sampleRateHz !== h.sampleRateHz || pos + next.frameLength > buf.length) break;
    frames += 1;
    pos += next.frameLength;
  }
  if (frames === 0) frames = 1;
  const walkedBytes = Math.max(1, pos - first);
  const audioBytes = Math.max(0, audioEnd - (start + first));
  const wholeFileWalked = bufferIsFileEnd && audioBytes - walkedBytes < 7;

  let durationMs: number;
  if (wholeFileWalked) {
    durationMs = (frames * SAMPLES_PER_FRAME * 1000) / h.sampleRateHz;
  } else {
    durationMs = ((audioBytes / (walkedBytes / frames)) * SAMPLES_PER_FRAME * 1000) / h.sampleRateHz;
    addWarning(state, 'The length of this AAC file is an estimate from its first part, because the file has no length header.');
  }

  const channels = ADTS_CHANNELS[h.channelConfig] ?? 0;
  if (channels === 0) addWarning(state, 'The AAC stream does not state its channel layout in the frame header.');
  state.audio = {
    codec: 'aac',
    sampleRateHz: h.sampleRateHz,
    channels,
    bitrateKbps: Math.round(((walkedBytes / frames) * 8 * h.sampleRateHz) / SAMPLES_PER_FRAME / 1000),
    variableBitrate: false,
  };
  state.durationMs = durationMs;
  return true;
}
