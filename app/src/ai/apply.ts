import type { PlaylistChange, TrackEdit } from '@opentunes/engine';
import type { ProposedEdit, ProposedPlaylist } from './schema';

/**
 * Turns the proposals the person ticked into the engine's own change types. Nothing here writes.
 * The only playlist action built is "create": the assistant cannot rename, delete, add to or
 * take from a playlist that exists, and `assertSafe` refuses anything else as a last check.
 */

export function buildEdits(edits: ProposedEdit[]): TrackEdit[] {
  return edits.map((edit) => ({ key: edit.key, fields: { ...edit.fields }, ...(edit.kind ? { kind: edit.kind } : {}) }));
}

export function buildPlaylistChanges(playlists: ProposedPlaylist[]): PlaylistChange[] {
  return playlists.map((playlist) => ({ action: 'create', name: playlist.name, tracks: [...playlist.keys] }));
}

const EDITABLE_BY_AI = new Set(['title', 'artist', 'album', 'albumartist', 'genre', 'year', 'track_nr']);

/** Throws if a change is of a kind the assistant is never allowed to make. */
export function assertSafe(edits: TrackEdit[], changes: PlaylistChange[]): void {
  for (const change of changes) {
    if (change.action !== 'create') throw new Error(`The assistant may only create playlists, not "${change.action}" them.`);
  }
  for (const edit of edits) {
    for (const field of Object.keys(edit.fields ?? {})) {
      if (!EDITABLE_BY_AI.has(field)) throw new Error(`The assistant may not change "${field}".`);
    }
  }
}
