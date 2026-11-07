/**
 * Small byte helpers. Every reader returns 0 for bytes past the end instead of throwing, so a
 * truncated file gives a wrong number the caller can check, never an exception.
 */

export function u8(b: Uint8Array, o: number): number {
  return b[o] ?? 0;
}

export function u16be(b: Uint8Array, o: number): number {
  return ((b[o] ?? 0) << 8) | (b[o + 1] ?? 0);
}

export function u16le(b: Uint8Array, o: number): number {
  return (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8);
}

export function u24be(b: Uint8Array, o: number): number {
  return ((b[o] ?? 0) << 16) | ((b[o + 1] ?? 0) << 8) | (b[o + 2] ?? 0);
}

export function u32be(b: Uint8Array, o: number): number {
  return (b[o] ?? 0) * 0x1000000 + (((b[o + 1] ?? 0) << 16) | ((b[o + 2] ?? 0) << 8) | (b[o + 3] ?? 0));
}

export function u32le(b: Uint8Array, o: number): number {
  return (b[o + 3] ?? 0) * 0x1000000 + (((b[o + 2] ?? 0) << 16) | ((b[o + 1] ?? 0) << 8) | (b[o] ?? 0));
}

/** As a double, so exact up to 2^53, which is far beyond any file this app will see. */
export function u64be(b: Uint8Array, o: number): number {
  return u32be(b, o) * 0x100000000 + u32be(b, o + 4);
}

export function u64le(b: Uint8Array, o: number): number {
  return u32le(b, o + 4) * 0x100000000 + u32le(b, o);
}

export function i32be(b: Uint8Array, o: number): number {
  return u32be(b, o) | 0;
}

export function i32le(b: Uint8Array, o: number): number {
  return u32le(b, o) | 0;
}

/** Big-endian unsigned integer of 1 to 8 bytes. */
export function beInt(b: Uint8Array): number {
  let value = 0;
  for (let i = 0; i < b.length && i < 8; i += 1) value = value * 256 + (b[i] ?? 0);
  return value;
}

/** Bytes as characters 0 to 255. Used for four-character codes, which are plain ASCII (and 0xA9 for the copyright sign). */
export function ascii(b: Uint8Array, o: number, n: number): string {
  let text = '';
  const end = Math.min(b.length, o + n);
  for (let i = Math.max(0, o); i < end; i += 1) text += String.fromCharCode(b[i] ?? 0);
  return text;
}

export function fourcc(b: Uint8Array, o: number): string {
  return ascii(b, o, 4);
}

export function startsWithAscii(b: Uint8Array, text: string, o = 0): boolean {
  if (o < 0 || o + text.length > b.length) return false;
  for (let i = 0; i < text.length; i += 1) {
    if (b[o + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** ID3 "synchsafe" integer: 7 bits per byte. */
export function synchsafe32(b: Uint8Array, o: number): number {
  return ((b[o] ?? 0) & 0x7f) * 0x200000 + (((b[o + 1] ?? 0) & 0x7f) << 14) + (((b[o + 2] ?? 0) & 0x7f) << 7) + ((b[o + 3] ?? 0) & 0x7f);
}

export function isSynchsafe(b: Uint8Array, o: number, n: number): boolean {
  for (let i = 0; i < n; i += 1) {
    if (((b[o + i] ?? 0) & 0x80) !== 0) return false;
  }
  return true;
}

/** Undo ID3 unsynchronisation: a 0x00 right after 0xFF was added by the writer and is dropped. */
export function removeUnsynchronisation(b: Uint8Array): Uint8Array {
  const out = new Uint8Array(b.length);
  let n = 0;
  for (let i = 0; i < b.length; i += 1) {
    const value = b[i] ?? 0;
    out[n] = value;
    n += 1;
    if (value === 0xff && b[i + 1] === 0x00) i += 1;
  }
  return out.subarray(0, n);
}

export function indexOfBytes(hay: Uint8Array, needle: Uint8Array, from = 0): number {
  if (needle.length === 0) return from;
  const last = hay.length - needle.length;
  outer: for (let i = Math.max(0, from); i <= last; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

export function lastIndexOfBytes(hay: Uint8Array, needle: Uint8Array, from = hay.length): number {
  for (let i = Math.min(from, hay.length - needle.length); i >= 0; i -= 1) {
    let ok = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (hay[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}

/** Reads bits from the most significant end of a byte array. Reads past the end give 0 and set `overrun`. */
export class BitReader {
  private pos = 0;
  overrun = false;
  private readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  get bitsLeft(): number {
    return Math.max(0, this.bytes.length * 8 - this.pos);
  }

  read(count: number): number {
    let value = 0;
    for (let i = 0; i < count; i += 1) {
      const byte = this.bytes[this.pos >> 3];
      if (byte === undefined) {
        this.overrun = true;
        value = value * 2;
      } else {
        value = value * 2 + ((byte >> (7 - (this.pos & 7))) & 1);
      }
      this.pos += 1;
    }
    return value;
  }
}
