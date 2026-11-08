import type { DirectoryEntry } from '@opentunes/engine';

type Entry = { kind: 'file' | 'directory' };
type Listable = { name: string; entries(): AsyncIterable<[string, Entry]>; getDirectoryHandle(name: string): Promise<DirectoryEntry> };

async function names(folder: Listable): Promise<Map<string, Entry['kind']>> {
  const found = new Map<string, Entry['kind']>();
  try {
    for await (const [name, entry] of folder.entries()) found.set(name, entry.kind);
  } catch {
    // an unreadable folder is explained by the reader's own error
  }
  return found;
}

/**
 * When the folder the person picked is not an iPod, says what it is and what to pick instead. A
 * backup folder holds a copy of iPod_Control, so without this it would open as if it were an iPod
 * and the app would offer to write to it. Returns null when the folder may be an iPod.
 */
export async function explainWrongFolder(folder: DirectoryEntry): Promise<string | null> {
  const here = folder as unknown as Listable;
  const top = await names(here);
  if (top.has('backup-info.json')) {
    return `"${folder.name}" is a backup made by OpenTunes, not an iPod. To put a backup back, open your iPod first, then use "Restore from a backup" on the Backup tab and choose this folder there.`;
  }
  if (top.has('library.csv') && top.has('playlists.csv')) {
    return `"${folder.name}" is a copy of the music taken off an iPod (made by Offload), not an iPod. Choose the iPod's own drive instead. To put these files on an iPod, use Add music and choose this folder there.`;
  }
  if (top.has('iPod_Control')) return null;
  if (folder.name === 'iPod_Control' || (top.has('iTunes') && top.has('Music'))) {
    return `"${folder.name}" is the iPod_Control folder inside the iPod. Choose the folder above it: the iPod's own drive, the one that contains iPod_Control.`;
  }
  const inside: string[] = [];
  // A look into the first few folders is enough to find an iPod one level down. A big folder is not scanned.
  for (const [name, kind] of [...top].slice(0, 40)) {
    if (kind !== 'directory' || name.startsWith('.')) continue;
    try {
      const child = (await folder.getDirectoryHandle(name)) as unknown as Listable;
      if ((await names(child)).has('iPod_Control')) inside.push(name);
    } catch {
      // not readable, so not offered
    }
  }
  if (inside.length === 1) return `"${folder.name}" is not an iPod, but the folder "${inside[0]}" inside it holds iPod_Control. Choose "${inside[0]}" instead.`;
  return null;
}
