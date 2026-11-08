/**
 * Telling whether what the page shows is still what the iPod holds. Pure functions.
 *
 * A fingerprint is a short fingerprint of the library as read (every track's key and size, the
 * playlists' names and sizes, and the sizes of the database files read). Two reads with the same
 * fingerprint mean nothing changed in between. It holds no titles once made: it is a hash.
 */

export interface FingerprintInput {
  tracks: { ipod_path: string | null; title: string | null; artist: string | null; album: string | null; tracklen: number; size: number }[];
  playlists: { name: string | null; tracks: unknown[] }[];
  files: { path: string; size: number }[];
}

/** A 53-bit string hash (cyrb53). Not secret, only for "did this change". */
function hash(text: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export function fingerprintOf(input: FingerprintInput): string {
  const tracks = input.tracks.map((track) => [track.ipod_path ?? '', track.title ?? '', track.artist ?? '', track.album ?? '', track.tracklen, track.size].join('\u0001')).sort();
  const playlists = input.playlists.map((playlist) => `${playlist.name ?? ''}\u0001${playlist.tracks.length}`).sort();
  const files = input.files.map((file) => `${file.path}\u0001${file.size}`).sort();
  return `${input.tracks.length}.${input.playlists.length}.${hash(tracks.join('\n'))}.${hash(playlists.join('\n'))}.${hash(files.join('\n'))}`;
}

/** Keeps only the selected keys that still name a row. Returns the same set when nothing was dropped. */
export function pruneSelection(selected: Set<string>, keys: Iterable<string>): Set<string> {
  const present = new Set(keys);
  let dropped = false;
  const kept = new Set<string>();
  for (const key of selected) {
    if (present.has(key)) kept.add(key);
    else dropped = true;
  }
  return dropped ? kept : selected;
}

/** What to tell the person after "Reload from the iPod". */
export function reloadMessage(change: { changed: boolean; before: number; after: number; readAtText: string }): string {
  if (!change.changed) return `Read the iPod again at ${change.readAtText}. Nothing had changed.`;
  const what = change.before === change.after ? `it still has ${change.after} track${change.after === 1 ? '' : 's'}, but something in its library or files is different` : `it had ${change.before} track${change.before === 1 ? '' : 's'} and now has ${change.after}`;
  return `The iPod changed since it was last read: ${what}. The screens were reset, and the earlier backup no longer matches the iPod, so make a new one before changing anything.`;
}
