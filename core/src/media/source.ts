import type { FileSource } from './types';

/** A file source over bytes already in memory. For tests and for small files. */
export function fileSourceFromBytes(name: string, bytes: Uint8Array): FileSource {
  return { name, size: bytes.length, slice: async (start, end) => bytes.subarray(Math.max(0, start), Math.min(bytes.length, end)) };
}

/** The part of a browser Blob (and so a File) that a source needs. */
export interface BlobLike {
  size: number;
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
}

/** A file source over a browser File or Blob. Reads only the pieces asked for. */
export function fileSourceFromBlob(name: string, blob: BlobLike): FileSource {
  return {
    name,
    size: blob.size,
    slice: async (start, end) => new Uint8Array(await blob.slice(Math.max(0, start), Math.min(blob.size, end)).arrayBuffer()),
  };
}
