import type { Artwork } from '../types';
import { startsWithAscii } from './bytes';

/** What an image really is, from its first bytes. Null when it is not a picture type we know. The declared type in a tag is not trusted. */
export function sniffImageMime(b: Uint8Array): string | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b[0] === 0x89 && startsWithAscii(b, 'PNG', 1)) return 'image/png';
  if (startsWithAscii(b, 'GIF8')) return 'image/gif';
  if (startsWithAscii(b, 'BM') && b.length > 14) return 'image/bmp';
  if (startsWithAscii(b, 'RIFF') && startsWithAscii(b, 'WEBP', 8)) return 'image/webp';
  if (b.length >= 4 && ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && b[3] === 0x2a))) return 'image/tiff';
  return null;
}

/** An artwork value that owns its bytes, so it does not point into a shared read buffer. */
export function makeArtwork(mime: string, data: Uint8Array): Artwork {
  return { mime, data: data.slice() };
}

/** The largest picture that is read. Bigger ones are skipped with a warning. */
export const MAX_ARTWORK_BYTES = 24 * 1024 * 1024;

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = (() => {
  const table = new Int16Array(256).fill(-1);
  for (let i = 0; i < B64.length; i += 1) table[B64.charCodeAt(i)] = i;
  table['-'.charCodeAt(0)] = 62; // URL-safe forms
  table['_'.charCodeAt(0)] = 63;
  return table;
})();

/** Decodes base64 (ignoring whitespace and padding). Null when it holds characters that are not base64. */
export function base64Decode(text: string): Uint8Array | null {
  const out = new Uint8Array(Math.floor((text.length * 3) / 4) + 3);
  let n = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 61 || code === 32 || code === 10 || code === 13 || code === 9) continue; // '=' padding and whitespace
    const value = code < 256 ? (B64_LOOKUP[code] ?? -1) : -1;
    if (value < 0) return null;
    acc = ((acc << 6) | value) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[n] = (acc >> bits) & 0xff;
      n += 1;
    }
  }
  return out.subarray(0, n);
}
