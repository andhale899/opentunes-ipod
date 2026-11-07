/**
 * A folder held in plain JavaScript maps that can be read and written, shaped like the
 * browser's directory handle. For tests and demos that need somewhere to write to, such as
 * the destination of a backup. Nothing here touches a disk.
 */

import type { DirectoryEntry, FileEntry } from './folder.ts';

function notFound(name: string): Error {
  return Object.assign(new Error(`${name} was not found.`), { name: 'NotFoundError' });
}

function wrongKind(name: string): Error {
  return Object.assign(new Error(`${name} is not the kind of entry that was asked for.`), { name: 'TypeMismatchError' });
}

export class ScratchFile implements FileEntry {
  readonly kind = 'file' as const;
  readonly name: string;
  bytes = new Uint8Array(0);

  constructor(name: string) {
    this.name = name;
  }

  async getFile() {
    const bytes = this.bytes;
    return { size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer };
  }

  /** Like the browser's: nothing is stored until the writer is closed. */
  async createWritable() {
    const chunks: Uint8Array[] = [];
    return {
      write: async (data: Uint8Array | string) => {
        chunks.push(typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data));
      },
      close: async () => {
        const joined = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
        let offset = 0;
        for (const chunk of chunks) {
          joined.set(chunk, offset);
          offset += chunk.length;
        }
        this.bytes = joined;
      },
    };
  }
}

export class ScratchFolder implements DirectoryEntry {
  readonly kind = 'directory' as const;
  readonly name: string;
  readonly #children = new Map<string, ScratchFolder | ScratchFile>();

  constructor(name = 'scratch') {
    this.name = name;
  }

  async *entries(): AsyncIterable<[string, DirectoryEntry | FileEntry]> {
    for (const [name, child] of this.#children) yield [name, child];
  }

  async getDirectoryHandle(name: string, options: { create?: boolean } = {}): Promise<ScratchFolder> {
    const found = this.#children.get(name);
    if (found instanceof ScratchFolder) return found;
    if (found) throw wrongKind(name);
    if (!options.create) throw notFound(name);
    const created = new ScratchFolder(name);
    this.#children.set(name, created);
    return created;
  }

  async getFileHandle(name: string, options: { create?: boolean } = {}): Promise<ScratchFile> {
    const found = this.#children.get(name);
    if (found instanceof ScratchFile) return found;
    if (found) throw wrongKind(name);
    if (!options.create) throw notFound(name);
    const created = new ScratchFile(name);
    this.#children.set(name, created);
    return created;
  }

  async removeEntry(name: string): Promise<void> {
    if (!this.#children.delete(name)) throw notFound(name);
  }

  /** Every file below this folder, as slash-separated paths. For checking what a test wrote. */
  listFiles(prefix = ''): Map<string, Uint8Array> {
    const files = new Map<string, Uint8Array>();
    for (const [name, child] of this.#children) {
      if (child instanceof ScratchFile) files.set(`${prefix}${name}`, child.bytes);
      else for (const [path, bytes] of child.listFiles(`${prefix}${name}/`)) files.set(path, bytes);
    }
    return files;
  }
}
