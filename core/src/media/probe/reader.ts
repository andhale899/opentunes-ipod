import type { FileSource } from '../types';

/** A read bigger than this is cut short. Nothing in the probe needs more, and a damaged length must not ask for gigabytes. */
export const MAX_READ_BYTES = 64 * 1024 * 1024;

/** The most one probe reads from a file in total. Cover art, a long sample table and the tags together stay far below it. */
export const MAX_TOTAL_READ_BYTES = 192 * 1024 * 1024;

/** Reads up to this much are served from one cached block, so many small reads in a row cost one slice. */
const SMALL_READ = 16 * 1024;
const BLOCK = 64 * 1024;

/**
 * A careful wrapper around a FileSource.
 *
 * - Reads are clamped to the file, so asking past the end gives fewer bytes, never an error.
 * - A source that throws is caught: the read returns nothing and one warning is recorded.
 * - Small reads that follow each other share a cached block.
 *
 * The arrays it returns may be views into a shared buffer. Treat them as read only, and copy
 * (`slice()`) anything that is kept.
 */
export class Reader {
  readonly size: number;
  private readonly source: FileSource;
  private readonly warn: (message: string) => void;
  private block: { start: number; bytes: Uint8Array } | null = null;
  private failed = false;
  private fetched = 0;
  private overBudget = false;

  constructor(source: FileSource, warn: (message: string) => void) {
    this.source = source;
    this.warn = warn;
    this.size = Number.isFinite(source.size) && source.size > 0 ? Math.floor(source.size) : 0;
  }

  /** Bytes from `start`, at most `length`, fewer at the end of the file or when reading fails. */
  async read(start: number, length: number): Promise<Uint8Array> {
    if (!Number.isFinite(start) || !Number.isFinite(length)) return new Uint8Array(0);
    const from = Math.max(0, Math.floor(start));
    const to = Math.min(this.size, from + Math.min(Math.max(0, Math.floor(length)), MAX_READ_BYTES));
    if (to <= from) return new Uint8Array(0);
    const want = to - from;

    if (want <= SMALL_READ) {
      const cached = this.block;
      if (cached && from >= cached.start && to <= cached.start + cached.bytes.length) {
        return cached.bytes.subarray(from - cached.start, to - cached.start);
      }
      const blockEnd = Math.min(this.size, from + BLOCK);
      const bytes = await this.fetch(from, blockEnd);
      this.block = { start: from, bytes };
      return bytes.subarray(0, Math.min(bytes.length, want));
    }
    return this.fetch(from, to);
  }

  /** Exactly `length` bytes, or null when the file is too short or reading fails. */
  async readExact(start: number, length: number): Promise<Uint8Array | null> {
    const bytes = await this.read(start, length);
    return bytes.length === length ? bytes : null;
  }

  private async fetch(from: number, to: number): Promise<Uint8Array> {
    // The budget is a safety net. A real file needs a few megabytes, and a crafted one must not make the probe read gigabytes.
    if (this.fetched + (to - from) > MAX_TOTAL_READ_BYTES) {
      if (!this.overBudget) {
        this.overBudget = true;
        this.warn('The file asks for more reading than is reasonable, so reading stopped early and the information may be incomplete.');
      }
      return new Uint8Array(0);
    }
    this.fetched += to - from;
    try {
      const bytes = await this.source.slice(from, to);
      if (!(bytes instanceof Uint8Array)) return new Uint8Array(0);
      return bytes.length > to - from ? bytes.subarray(0, to - from) : bytes;
    } catch {
      if (!this.failed) {
        this.failed = true;
        this.warn(`The file could not be read past byte ${from}, so the information may be incomplete.`);
      }
      return new Uint8Array(0);
    }
  }
}
