import { startsWithAscii, u24be, u32be } from './bytes';
import { MAX_ARTWORK_BYTES } from './image';
import { applyId3, type Id3Data } from './id3';
import type { Reader } from './reader';
import { addWarning, type ProbeState } from './state';
import { applyVorbisFields, artworkFromPicture, bestPicture, parseVorbisComments } from './vorbis';

/** FLAC: STREAMINFO for the audio, Vorbis comments for tags, PICTURE blocks for cover art. */

const MAX_COMMENT_BLOCK = 16 * 1024 * 1024;

export interface StreamInfo {
  sampleRateHz: number;
  channels: number;
  bitDepth: number;
  totalSamples: number;
}

/** The 34 byte STREAMINFO block: 20 bits of rate, 3 of channels, 5 of bit depth, 36 of total samples. */
export function parseStreamInfo(b: Uint8Array, at = 0): StreamInfo {
  const b0 = b[at + 10] ?? 0;
  const b1 = b[at + 11] ?? 0;
  const b2 = b[at + 12] ?? 0;
  const b3 = b[at + 13] ?? 0;
  return {
    sampleRateHz: (b0 << 12) | (b1 << 4) | (b2 >> 4),
    channels: ((b2 >> 1) & 7) + 1,
    bitDepth: (((b2 & 1) << 4) | (b3 >> 4)) + 1,
    totalSamples: (b3 & 15) * 0x100000000 + u32be(b, at + 14),
  };
}

export async function probeFlac(r: Reader, state: ProbeState, start: number, id3: Id3Data | null): Promise<void> {
  state.container = 'flac';
  if (!startsWithAscii(await r.read(start, 4), 'fLaC')) {
    addWarning(state, 'The FLAC marker is missing.');
    return;
  }

  let pos = start + 4;
  let audioStart = pos;
  let sawStreamInfo = false;
  // A picture is either already in memory (from a comment) or a place in the file to read it from.
  const pictures: { type: number; mime: string; offset: number; length: number; data?: Uint8Array }[] = [];

  for (let blocks = 0; blocks < 1000; blocks += 1) {
    const header = await r.read(pos, 4);
    if (header.length < 4) {
      addWarning(state, 'The FLAC metadata is cut short.');
      break;
    }
    const last = ((header[0] ?? 0) & 0x80) !== 0;
    const type = (header[0] ?? 0) & 0x7f;
    const length = u24be(header, 1);
    const bodyStart = pos + 4;
    const bodyEnd = bodyStart + length;
    if (bodyEnd > r.size) {
      addWarning(state, 'The FLAC metadata is cut short.');
      if (type === 0 && length >= 34 && bodyStart + 34 <= r.size) {
        // The block is whole even though what follows is not.
      } else {
        break;
      }
    }

    if (type === 0 && length >= 34) {
      const info = parseStreamInfo(await r.read(bodyStart, 34));
      sawStreamInfo = true;
      if (info.sampleRateHz > 0) {
        state.audio = { codec: 'flac', sampleRateHz: info.sampleRateHz, channels: info.channels, bitrateKbps: null, bitDepth: info.bitDepth };
        if (info.totalSamples > 0) state.durationMs = (info.totalSamples * 1000) / info.sampleRateHz;
        else addWarning(state, 'The FLAC header does not give the number of samples, so the length is unknown.');
      } else {
        addWarning(state, 'The FLAC header has no sample rate.');
      }
    } else if (type === 4 && length <= MAX_COMMENT_BLOCK) {
      const body = await r.read(bodyStart, length);
      for (const picture of applyVorbisFields(state, parseVorbisComments(body, 0))) {
        pictures.push({ type: picture.type, mime: picture.mime, offset: -1, length: picture.data.length, data: picture.data });
      }
    } else if (type === 6) {
      // Read only the start of the block to learn the picture type, and fetch the bytes later if it is chosen.
      const head = await r.read(bodyStart, Math.min(length, 4096));
      const mimeLength = u32be(head, 4);
      const descAt = 8 + mimeLength;
      const descLength = u32be(head, descAt);
      const dataLengthAt = descAt + 4 + descLength + 16;
      const dataLength = u32be(head, dataLengthAt);
      if (dataLengthAt + 4 <= head.length && dataLength > 0 && dataLengthAt + 4 + dataLength <= length) {
        pictures.push({ type: u32be(head, 0), mime: '', offset: bodyStart + dataLengthAt + 4, length: dataLength });
      }
    }
    pos = bodyEnd;
    audioStart = Math.min(pos, r.size);
    if (last) break;
  }

  if (!sawStreamInfo) addWarning(state, 'The FLAC file has no STREAMINFO block, so its audio details are unknown.');

  const chosen = bestPicture(pictures);
  if (chosen && !state.artwork) {
    if (chosen.length > MAX_ARTWORK_BYTES) {
      addWarning(state, 'The cover picture is too large to read, so it was skipped.');
    } else {
      const data = chosen.data ?? (await r.read(chosen.offset, chosen.length));
      if (data.length === chosen.length) state.artwork = artworkFromPicture(state, { type: chosen.type, mime: chosen.mime, data });
    }
  }

  if (state.audio && state.durationMs && state.durationMs > 0) {
    const audioBytes = Math.max(0, r.size - audioStart);
    state.audio.bitrateKbps = Math.round((audioBytes * 8) / state.durationMs);
  }
  applyId3(state, id3);
}

