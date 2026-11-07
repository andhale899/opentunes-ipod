import type { VideoCodec } from '../types';
import { ascii, i32le, u16le, u32le } from './bytes';
import { waveFormatCodec } from './wav';
import type { Reader } from './reader';
import { addWarning, type ProbeState } from './state';

/** AVI: the header list (hdrl) names each stream, its codec and its size, and gives the length. */

function videoCodecFromFourcc(code: string): VideoCodec {
  const upper = code.toUpperCase();
  if (['H264', 'X264', 'AVC1', 'DAVC', 'VSSH'].includes(upper)) return 'h264';
  if (['XVID', 'DIVX', 'DX50', 'FMP4', 'MP4V', 'DIV4', 'DIV5', 'FVFW'].includes(upper)) return 'mpeg4';
  if (['HEVC', 'HEV1', 'HVC1', 'H265'].includes(upper)) return 'hevc';
  if (['MPG2', 'MPEG', 'M2V1'].includes(upper)) return 'mpeg2';
  if (upper === 'VP80') return 'vp8';
  if (upper === 'VP90') return 'vp9';
  return 'unknown';
}

export async function probeAvi(r: Reader, state: ProbeState): Promise<void> {
  state.container = 'avi';
  let pos = 12;
  let hdrl: { start: number; end: number } | null = null;
  for (let i = 0; i < 64 && pos + 12 <= r.size; i += 1) {
    const h = await r.read(pos, 12);
    const size = u32le(h, 4);
    if (ascii(h, 0, 4) === 'LIST' && ascii(h, 8, 4) === 'hdrl') {
      hdrl = { start: pos + 12, end: Math.min(r.size, pos + 8 + size) };
      break;
    }
    pos += 8 + size + (size & 1);
  }
  if (!hdrl) {
    addWarning(state, 'The AVI file has no header list (hdrl), so its streams are unknown.');
    return;
  }
  if (hdrl.end - hdrl.start > 1024 * 1024) hdrl.end = hdrl.start + 1024 * 1024;
  const b = await r.read(hdrl.start, hdrl.end - hdrl.start);

  let microsPerFrame = 0;
  let totalFrames = 0;
  let streamDurationMs: number | null = null;
  let current: { type: string; handler: string; scale: number; rate: number; length: number } | null = null;

  const walk = (start: number, end: number): void => {
    let at = start;
    while (at + 8 <= end && at + 8 <= b.length) {
      const id = ascii(b, at, 4);
      const size = u32le(b, at + 4);
      const body = at + 8;
      const bodyEnd = Math.min(b.length, body + size);
      if (id === 'LIST') {
        walk(body + 4, bodyEnd);
      } else if (id === 'avih') {
        microsPerFrame = u32le(b, body);
        totalFrames = u32le(b, body + 16);
      } else if (id === 'strh') {
        current = { type: ascii(b, body, 4), handler: ascii(b, body + 4, 4), scale: u32le(b, body + 20), rate: u32le(b, body + 24), length: u32le(b, body + 32) };
      } else if (id === 'strf' && current) {
        if (current.type === 'vids' && !state.video) {
          // The codec is named in the bitmap header, and in the stream header's handler as a second opinion.
          const printable = /^[\x20-\x7e]{4}$/;
          const compression = ascii(b, body + 16, 4);
          const fourcc = printable.test(compression) ? compression : printable.test(current.handler) ? current.handler : '';
          const fps = current.scale > 0 && current.rate > 0 ? Math.round((current.rate / current.scale) * 1000) / 1000 : null;
          state.video = {
            codec: videoCodecFromFourcc(fourcc),
            width: i32le(b, body + 4),
            height: Math.abs(i32le(b, body + 8)),
            fps,
            bitrateKbps: null,
          };
          if (fps && current.length > 0) streamDurationMs = (current.length / fps) * 1000;
        } else if (current.type === 'auds' && !state.audio) {
          const tag = u16le(b, body);
          const channels = u16le(b, body + 2);
          const sampleRateHz = u32le(b, body + 4);
          const avgBytes = u32le(b, body + 8);
          const bits = u16le(b, body + 14);
          const codec = waveFormatCodec(tag);
          state.audio = { codec, sampleRateHz, channels, bitrateKbps: avgBytes > 0 ? Math.round((avgBytes * 8) / 1000) : null };
          if (codec === 'pcm' && bits > 0) state.audio.bitDepth = bits;
        }
      }
      at = body + size + (size & 1);
    }
  };
  walk(0, b.length);

  if (streamDurationMs !== null) state.durationMs = streamDurationMs;
  else if (microsPerFrame > 0 && totalFrames > 0) state.durationMs = (totalFrames * microsPerFrame) / 1000;
  if (!state.video && !state.audio) addWarning(state, 'No audio or video stream was found in the AVI header.');
}
