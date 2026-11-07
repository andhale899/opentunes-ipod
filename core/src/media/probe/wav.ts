import type { AudioCodec } from '../types';
import { ascii, u16le, u32le, u64le } from './bytes';
import { applyId3, readId3v2 } from './id3';
import type { Reader } from './reader';
import { addWarning, fillTag, parseNumberPair, parseYear, type ProbeState } from './state';
import { cleanText, utf8 } from './text';

/** WAV (RIFF) files: the fmt chunk, the data size, LIST/INFO tags and an optional ID3 chunk. RF64 is read too. */

const MAX_LIST_BYTES = 1024 * 1024;

/** The audio codec for a WAVE format tag. */
export function waveFormatCodec(tag: number): AudioCodec {
  switch (tag) {
    case 0x0001:
    case 0x0003:
      return 'pcm';
    case 0x0055:
      return 'mp3';
    case 0x0160:
    case 0x0161:
    case 0x0162:
    case 0x0163:
      return 'wma';
    case 0x00ff:
    case 0x1610:
      return 'aac';
    case 0x2000:
      return 'ac3';
    case 0x2001:
      return 'dts';
    default:
      return 'unknown';
  }
}

const INFO_FIELDS: Record<string, 'title' | 'artist' | 'album' | 'genre' | 'comment' | 'composer' | 'albumArtist' | 'year' | 'track'> = {
  INAM: 'title',
  IART: 'artist',
  IPRD: 'album',
  IGNR: 'genre',
  ICMT: 'comment',
  IMUS: 'composer',
  IAAR: 'albumArtist',
  ICRD: 'year',
  ITRK: 'track',
  IPRT: 'track',
  TRCK: 'track',
};

function applyListInfo(state: ProbeState, body: Uint8Array): void {
  let pos = 4; // past the "INFO" list type
  while (pos + 8 <= body.length) {
    const id = ascii(body, pos, 4);
    const size = u32le(body, pos + 4);
    const value = body.subarray(pos + 8, Math.min(body.length, pos + 8 + size));
    const field = INFO_FIELDS[id];
    if (field) {
      const text = cleanText(utf8(value));
      if (field === 'year') fillTag(state.tags, 'year', parseYear(text));
      else if (field === 'track') {
        const pair = parseNumberPair(text);
        fillTag(state.tags, 'trackNumber', pair.n);
        fillTag(state.tags, 'trackTotal', pair.total);
      } else fillTag(state.tags, field, text);
    }
    pos += 8 + size + (size & 1);
  }
}

export async function probeWav(r: Reader, state: ProbeState, rf64: boolean): Promise<void> {
  state.container = 'wav';
  let pos = 12;
  let dataBytes: number | null = null;
  let ds64DataSize: number | null = null;
  let sawFmt = false;
  let byteRate = 0;
  let blockAlign = 0;
  let id3Done = false;

  for (let chunks = 0; chunks < 2000 && pos + 8 <= r.size; chunks += 1) {
    const header = await r.read(pos, 8);
    if (header.length < 8) break;
    const id = ascii(header, 0, 4);
    const size = u32le(header, 4);
    const bodyStart = pos + 8;

    if (id === 'ds64') {
      const body = await r.read(bodyStart, 24);
      ds64DataSize = u64le(body, 8);
    } else if (id === 'fmt ') {
      const b = await r.read(bodyStart, Math.min(size, 64));
      if (b.length < 16) {
        addWarning(state, 'The fmt chunk is cut short, so the audio details are unknown.');
      } else {
        sawFmt = true;
        let tag = u16le(b, 0);
        const channels = u16le(b, 2);
        const sampleRateHz = u32le(b, 4);
        byteRate = u32le(b, 8);
        blockAlign = u16le(b, 12);
        let bits = u16le(b, 14);
        if (tag === 0xfffe && b.length >= 26) {
          // Extensible format: the real tag is the first two bytes of the sub-format GUID.
          const valid = u16le(b, 18);
          tag = u16le(b, 24);
          if (valid > 0 && valid <= bits && tag === 0x0001) bits = valid;
        }
        const codec = waveFormatCodec(tag);
        if (codec === 'unknown') addWarning(state, `The WAV file uses an audio format (tag ${tag}) that is not recognised.`);
        if (tag === 0x0003) addWarning(state, 'This WAV file holds floating point audio.');
        const bitrate = byteRate > 0 ? Math.round((byteRate * 8) / 1000) : codec === 'pcm' && bits > 0 ? Math.round((sampleRateHz * channels * bits) / 1000) : null;
        state.audio = { codec, sampleRateHz, channels, bitrateKbps: bitrate };
        if (codec === 'pcm' && bits > 0) state.audio.bitDepth = bits;
      }
    } else if (id === 'data') {
      let length = size;
      if (rf64 && size === 0xffffffff && ds64DataSize !== null) length = ds64DataSize;
      const available = Math.max(0, r.size - bodyStart);
      if (length === 0 || length > available) {
        if (length !== 0 && length !== 0xffffffff) addWarning(state, 'The audio data is shorter than the WAV header says, so the file is cut short.');
        length = available;
      }
      dataBytes = length;
      if (length === available) break; // nothing can follow
    } else if (id === 'LIST' && size >= 4 && size <= MAX_LIST_BYTES) {
      const body = await r.read(bodyStart, size);
      if (ascii(body, 0, 4) === 'INFO') applyListInfo(state, body);
    } else if ((id === 'id3 ' || id === 'ID3 ') && !id3Done) {
      id3Done = true;
      const result = await readId3v2(r, bodyStart, (message) => addWarning(state, message));
      if (result) applyId3(state, result.data);
    }
    pos = bodyStart + size + (size & 1); // chunks are padded to an even size
  }

  if (!sawFmt) addWarning(state, 'The WAV file has no fmt chunk, so its audio details are unknown.');
  if (dataBytes === null) addWarning(state, 'The WAV file has no data chunk.');
  if (dataBytes !== null && state.audio) {
    const { codec, sampleRateHz } = state.audio;
    if (codec === 'pcm' && blockAlign > 0 && sampleRateHz > 0) {
      // For PCM every frame is blockAlign bytes, so this does not depend on the byte rate field, which some editors get wrong.
      state.durationMs = (dataBytes / blockAlign / sampleRateHz) * 1000;
    } else if (byteRate > 0) {
      state.durationMs = (dataBytes * 1000) / byteRate;
    } else if (blockAlign > 0 && sampleRateHz > 0) {
      state.durationMs = (dataBytes / blockAlign / sampleRateHz) * 1000;
    }
  }
}
