import type { AudioCodec } from '../types';
import { ascii, fourcc, u16be, u32be } from './bytes';
import { applyId3, readId3v2 } from './id3';
import type { Reader } from './reader';
import { addWarning, fillTag, type ProbeState } from './state';
import { cleanText, latin1 } from './text';

/** AIFF and AIFF-C: COMM for the audio, SSND for its size, NAME and AUTH or an ID3 chunk for tags. */

/** The 80 bit IEEE extended float AIFF uses for the sample rate. */
export function parseExtended80(b: Uint8Array, at: number): number {
  const exponent = ((b[at] ?? 0) & 0x7f) << 8 | (b[at + 1] ?? 0);
  const mantissa = u32be(b, at + 2) * 0x100000000 + u32be(b, at + 6);
  if (exponent === 0 && mantissa === 0) return 0;
  const value = mantissa * 2 ** (exponent - 16383 - 63);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function aifcCodec(compression: string): { codec: AudioCodec; bits?: number } {
  switch (compression) {
    case 'NONE':
    case 'sowt':
    case 'twos':
    case 'in24':
    case '42ni':
    case 'in32':
    case '23ni':
      return { codec: 'pcm' };
    case 'fl32':
    case 'FL32':
      return { codec: 'pcm', bits: 32 };
    case 'fl64':
    case 'FL64':
      return { codec: 'pcm', bits: 64 };
    case 'alac':
      return { codec: 'alac' };
    default:
      return { codec: 'unknown' };
  }
}

export async function probeAiff(r: Reader, state: ProbeState, isAifc: boolean): Promise<void> {
  state.container = 'aiff';
  let pos = 12;
  let frames = 0;
  let ssndBytes: number | null = null;
  let sawComm = false;
  let id3Done = false;

  for (let chunks = 0; chunks < 2000 && pos + 8 <= r.size; chunks += 1) {
    const header = await r.read(pos, 8);
    if (header.length < 8) break;
    const id = ascii(header, 0, 4);
    const size = u32be(header, 4);
    const bodyStart = pos + 8;

    if (id === 'COMM') {
      const b = await r.read(bodyStart, Math.min(size, 64));
      if (b.length < 18) {
        addWarning(state, 'The COMM chunk is cut short, so the audio details are unknown.');
      } else {
        sawComm = true;
        const channels = u16be(b, 0);
        frames = u32be(b, 2);
        let bits = u16be(b, 6);
        const rate = Math.round(parseExtended80(b, 8));
        let codec: AudioCodec = 'pcm';
        if (isAifc && b.length >= 22) {
          const compression = fourcc(b, 18);
          const resolved = aifcCodec(compression);
          codec = resolved.codec;
          if (resolved.bits) bits = resolved.bits;
          if (codec === 'unknown') addWarning(state, `The AIFF-C file uses a compression (${compression}) that is not recognised.`);
        }
        state.audio = { codec, sampleRateHz: rate, channels, bitrateKbps: codec === 'pcm' && rate > 0 ? Math.round((rate * channels * bits) / 1000) : null };
        if (codec === 'pcm' || codec === 'alac') state.audio.bitDepth = bits;
      }
    } else if (id === 'SSND') {
      ssndBytes = Math.max(0, Math.min(size, r.size - bodyStart) - 8);
    } else if (id === 'NAME' || id === 'AUTH' || id === 'ANNO') {
      const text = cleanText(latin1(await r.read(bodyStart, Math.min(size, 4096))));
      fillTag(state.tags, id === 'NAME' ? 'title' : id === 'AUTH' ? 'artist' : 'comment', text);
    } else if ((id === 'ID3 ' || id === 'id3 ') && !id3Done) {
      id3Done = true;
      const result = await readId3v2(r, bodyStart, (message) => addWarning(state, message));
      if (result) applyId3(state, result.data);
    }
    pos = bodyStart + size + (size & 1);
  }

  if (!sawComm) {
    addWarning(state, 'The AIFF file has no COMM chunk, so its audio details are unknown.');
    return;
  }
  const audio = state.audio;
  if (audio && audio.sampleRateHz > 0) {
    if (frames > 0) {
      state.durationMs = (frames * 1000) / audio.sampleRateHz;
    } else if (ssndBytes !== null && audio.bitDepth && audio.channels > 0) {
      state.durationMs = (ssndBytes / (audio.channels * Math.ceil(audio.bitDepth / 8)) / audio.sampleRateHz) * 1000;
    }
    // The header says how long the audio is, but the file may be shorter than that.
    if (frames > 0 && ssndBytes !== null && audio.bitDepth && audio.channels > 0) {
      const available = ssndBytes / (audio.channels * Math.ceil(audio.bitDepth / 8));
      if (available + 1 < frames && audio.codec === 'pcm') addWarning(state, 'The audio data is shorter than the AIFF header says, so the file is cut short.');
    }
  }
}
