import type { VideoCodec } from '../types';
import { ascii, u16le, u32le, u64le } from './bytes';
import { waveFormatCodec } from './wav';
import type { Reader } from './reader';
import { addWarning, fillTag, parseNumberPair, parseYear, type ProbeState } from './state';
import { cleanText, utf16 } from './text';

/** ASF (WMA and WMV): the header object holds the file length, the streams and some tags. */

/** A GUID as the 16 bytes it takes in a file, written as the usual text. */
function guidAt(b: Uint8Array, at: number): string {
  const hex = (i: number) => (b[at + i] ?? 0).toString(16).padStart(2, '0');
  return `${hex(3)}${hex(2)}${hex(1)}${hex(0)}-${hex(5)}${hex(4)}-${hex(7)}${hex(6)}-${hex(8)}${hex(9)}-${hex(10)}${hex(11)}${hex(12)}${hex(13)}${hex(14)}${hex(15)}`.toUpperCase();
}

export const ASF_HEADER_GUID = '75B22630-668E-11CF-A6D9-00AA0062CE6C';
const FILE_PROPERTIES = '8CABDCA1-A947-11CF-8EE4-00C00C205365';
const STREAM_PROPERTIES = 'B7DC0791-A9B7-11CF-8EE6-00C00C205365';
const CONTENT_DESCRIPTION = '75B22633-668E-11CF-A6D9-00AA0062CE6C';
const EXTENDED_CONTENT = 'D2D0A440-E307-11D2-97F0-00A0C95EA850';
const AUDIO_STREAM = 'F8699E40-5B4D-11CF-A8FD-00805F5C442B';
const VIDEO_STREAM = 'BC19EFC0-5B4D-11CF-A8FD-00805F5C442B';

function videoCodecFromFourcc(code: string): VideoCodec {
  const upper = code.toUpperCase();
  if (['H264', 'X264', 'AVC1'].includes(upper)) return 'h264';
  if (['MP4S', 'M4S2', 'MP4V', 'XVID', 'DIVX'].includes(upper)) return 'mpeg4';
  return 'unknown';
}

/** True when the bytes start with the ASF header object GUID. */
export function asfHeaderStartsAt(b: Uint8Array): boolean {
  return b.length >= 16 && guidAt(b, 0) === ASF_HEADER_GUID;
}

export async function probeAsf(r: Reader, state: ProbeState): Promise<void> {
  state.container = 'wma';
  const head = await r.read(0, 30);
  const headerSize = u64le(head, 16);
  if (head.length < 30 || headerSize < 30) {
    addWarning(state, 'The ASF header is damaged, so the file details are unknown.');
    return;
  }
  const available = Math.min(headerSize, r.size) - 30;
  if (headerSize > r.size) addWarning(state, 'The ASF header is longer than the file, so the file is cut short.');
  if (available > 8 * 1024 * 1024) {
    addWarning(state, 'The ASF header is too large to read.');
    return;
  }
  const b = await r.read(30, available);

  let playDuration100ns = 0;
  let prerollMs = 0;
  let pos = 0;
  while (pos + 24 <= b.length) {
    const guid = guidAt(b, pos);
    const size = u64le(b, pos + 16);
    if (size < 24) break;
    const body = pos + 24;
    const end = Math.min(b.length, pos + size);

    if (guid === FILE_PROPERTIES) {
      playDuration100ns = u64le(b, body + 40);
      prerollMs = u64le(b, body + 56);
    } else if (guid === STREAM_PROPERTIES) {
      const type = guidAt(b, body);
      const dataLength = u32le(b, body + 40);
      const data = body + 54;
      if (type === AUDIO_STREAM && !state.audio && data + 16 <= end) {
        const tag = u16le(b, data);
        const avgBytes = u32le(b, data + 8);
        const codec = waveFormatCodec(tag);
        state.audio = { codec, sampleRateHz: u32le(b, data + 4), channels: u16le(b, data + 2), bitrateKbps: avgBytes > 0 ? Math.round((avgBytes * 8) / 1000) : null };
        if (codec === 'pcm') state.audio.bitDepth = u16le(b, data + 14);
      } else if (type === VIDEO_STREAM && !state.video && dataLength >= 51 && data + 51 <= end) {
        const compression = ascii(b, data + 11 + 16, 4);
        state.video = { codec: videoCodecFromFourcc(compression), width: u32le(b, data), height: u32le(b, data + 4), fps: null, bitrateKbps: null };
      }
    } else if (guid === CONTENT_DESCRIPTION && body + 10 <= end) {
      const lengths = [u16le(b, body), u16le(b, body + 2), u16le(b, body + 4), u16le(b, body + 6), u16le(b, body + 8)];
      let at = body + 10;
      const strings = lengths.map((length) => {
        const text = cleanText(utf16(b.subarray(at, Math.min(end, at + length)), false));
        at += length;
        return text;
      });
      fillTag(state.tags, 'title', strings[0]);
      fillTag(state.tags, 'artist', strings[1]);
      fillTag(state.tags, 'comment', strings[3]);
    } else if (guid === EXTENDED_CONTENT && body + 2 <= end) {
      applyExtendedContent(state, b, body, end);
    }
    pos += size;
  }

  if (playDuration100ns > 0) state.durationMs = Math.max(0, playDuration100ns / 10000 - prerollMs);
  else addWarning(state, 'The ASF header has no length, so the length is unknown.');
  if (!state.audio && !state.video) addWarning(state, 'No audio or video stream was found in the ASF header.');
}

function applyExtendedContent(state: ProbeState, b: Uint8Array, start: number, end: number): void {
  const count = u16le(b, start);
  let at = start + 2;
  for (let i = 0; i < count && at + 2 <= end; i += 1) {
    const nameLength = u16le(b, at);
    const name = cleanText(utf16(b.subarray(at + 2, at + 2 + nameLength), false));
    at += 2 + nameLength;
    const valueType = u16le(b, at);
    const valueLength = u16le(b, at + 2);
    const value = b.subarray(at + 4, at + 4 + valueLength);
    at += 4 + valueLength;
    const asText = valueType === 0 ? cleanText(utf16(value, false)) : valueType === 3 ? String(u32le(value, 0)) : valueType === 5 ? String(u16le(value, 0)) : '';
    if (!asText) continue;
    switch (name) {
      case 'WM/AlbumTitle':
        fillTag(state.tags, 'album', asText);
        break;
      case 'WM/AlbumArtist':
        fillTag(state.tags, 'albumArtist', asText);
        break;
      case 'WM/Genre':
        fillTag(state.tags, 'genre', asText);
        break;
      case 'WM/Composer':
        fillTag(state.tags, 'composer', asText);
        break;
      case 'WM/Year':
        fillTag(state.tags, 'year', parseYear(asText));
        break;
      case 'WM/TrackNumber': {
        const pair = parseNumberPair(asText);
        fillTag(state.tags, 'trackNumber', pair.n);
        fillTag(state.tags, 'trackTotal', pair.total);
        break;
      }
      case 'WM/PartOfSet': {
        const pair = parseNumberPair(asText);
        fillTag(state.tags, 'discNumber', pair.n);
        fillTag(state.tags, 'discTotal', pair.total);
        break;
      }
      default:
        break;
    }
  }
}
