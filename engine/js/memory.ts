/**
 * A folder inside the engine's own in-memory file system, shaped like the browser's
 * directory handle.
 *
 * It lets the demo iPods, and the tests, go through exactly the loader a real iPod goes
 * through, so what they show is the real code path and not a shortcut.
 */

import type { Engine } from './engine.ts';
import type { DirectoryEntry, FileEntry } from './folder.ts';

export function memoryDirectory(engine: Engine, path: string, name: string = path.split('/').pop() ?? path): DirectoryEntry {
  const { fs } = engine;

  const fileAt = (filePath: string, fileName: string): FileEntry => ({
    kind: 'file',
    name: fileName,
    async getFile() {
      const bytes = fs.readFile(filePath);
      return { size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer };
    },
  });

  return {
    kind: 'directory',
    name,
    async *entries() {
      for (const entry of fs.readdir(path)) {
        if (entry === '.' || entry === '..') continue;
        const full = `${path}/${entry}`;
        yield [entry, fs.isDir(fs.stat(full).mode) ? memoryDirectory(engine, full, entry) : fileAt(full, entry)] as [string, DirectoryEntry | FileEntry];
      }
    },
    async getDirectoryHandle(child: string) {
      const full = `${path}/${child}`;
      if (!fs.analyzePath(full).exists || !fs.isDir(fs.stat(full).mode)) {
        throw Object.assign(new Error(`${child} was not found.`), { name: 'NotFoundError' });
      }
      return memoryDirectory(engine, full, child);
    },
  };
}
