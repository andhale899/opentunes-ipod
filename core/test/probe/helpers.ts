/**
 * Byte-building helpers for the probe tests. There are no sample files: every fixture is assembled
 * here from the published layout of each format, so a test shows what the format looks like.
 */

import { fileSourceFromBytes } from '../../src/media/source';
import type { FileSource, MediaInfo } from '../../src/media/types';
import { probeMedia } from '../../src/media/probe/index';

export type Part = Uint8Array | number[] | string;

/** A string becomes its characters as bytes 0 to 255 (a four-character code, for example). */
export function toBytes(part: Part): Uint8Array {
  if (typeof part === 'string') {
    const out = new Uint8Array(part.length);
    for (let i = 0; i < part.length; i += 1) out[i] = part.charCodeAt(i) & 0xff;
    return out;
  }
  return part instanceof Uint8Array ? part : Uint8Array.from(part);
}

export function cat(...parts: Part[]): Uint8Array {
  const arrays = parts.map(toBytes);
  const out = new Uint8Array(arrays.reduce((sum, a) => sum + a.length, 0));
  let at = 0;
  for (const a of arrays) {
    out.set(a, at);
    at += a.length;
  }
  return out;
}

export const be16 = (n: number): number[] => [(n >>> 8) & 0xff, n & 0xff];
export const be24 = (n: number): number[] => [(n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
export const be32 = (n: number): number[] => [Math.floor(n / 0x1000000) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
export const be64 = (n: number): number[] => [...be32(Math.floor(n / 0x100000000)), ...be32(n % 0x100000000)];
export const le16 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff];
export const le32 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, Math.floor(n / 0x1000000) & 0xff];
export const le64 = (n: number): number[] => [...le32(n % 0x100000000), ...le32(Math.floor(n / 0x100000000))];
export const zeros = (n: number): Uint8Array => new Uint8Array(n);
export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

export function utf16le(text: string, bom = false): Uint8Array {
  const out: number[] = bom ? [0xff, 0xfe] : [];
  for (let i = 0; i < text.length; i += 1) out.push(text.charCodeAt(i) & 0xff, text.charCodeAt(i) >> 8);
  return Uint8Array.from(out);
}

export function utf16be(text: string, bom = false): Uint8Array {
  const out: number[] = bom ? [0xfe, 0xff] : [];
  for (let i = 0; i < text.length; i += 1) out.push(text.charCodeAt(i) >> 8, text.charCodeAt(i) & 0xff);
  return Uint8Array.from(out);
}

/** A small valid JPEG-looking blob (the probe only checks the first bytes). */
export function fakeJpeg(length = 64, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  out[0] = 0xff;
  out[1] = 0xd8;
  out[2] = 0xff;
  out[3] = 0xe0;
  for (let i = 4; i < length; i += 1) out[i] = (i * 31 + seed) & 0xff;
  out[length - 2] = 0xff;
  out[length - 1] = 0xd9;
  return out;
}

export function fakePng(length = 64, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (let i = 8; i < length; i += 1) out[i] = (i * 17 + seed) & 0xff;
  return out;
}

export function source(name: string, bytes: Uint8Array): FileSource {
  return fileSourceFromBytes(name, bytes);
}

export function probeBytes(name: string, bytes: Uint8Array): Promise<MediaInfo> {
  return probeMedia(fileSourceFromBytes(name, bytes));
}

/** A source over bytes that records every slice that is asked for. */
export function recordingSource(name: string, bytes: Uint8Array): { source: FileSource; requested: () => number; calls: () => [number, number][] } {
  const calls: [number, number][] = [];
  return {
    source: {
      name,
      size: bytes.length,
      slice: async (start, end) => {
        calls.push([start, end]);
        return bytes.subarray(Math.max(0, start), Math.min(bytes.length, end));
      },
    },
    requested: () => calls.reduce((sum, [a, b]) => sum + Math.max(0, Math.min(b, bytes.length) - Math.max(0, a)), 0),
    calls: () => calls,
  };
}

/** Repeatable pseudo-random bytes for garbage tests (mulberry32). */
export function randomBytes(length: number, seed: number): Uint8Array {
  let state = seed >>> 0;
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    out[i] = ((t ^ (t >>> 14)) >>> 0) & 0xff;
  }
  return out;
}
