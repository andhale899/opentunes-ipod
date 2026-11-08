/**
 * The logic of the library screen, with no screen in it: filter, sort, group, select, work out a
 * bulk edit, and decide what a playlist allows. Pure functions, so they are tested on their own
 * (app/test/organise.test.ts) and the components only draw what these return.
 */

import { kindLabel } from '@opentunes/core';
import { trackKey, type Kind, type PlaylistInfo, type TrackEdit, type TrackInfo } from '@opentunes/engine';

/** The parts of a track the library screen reads. A real TrackInfo has all of them. */
export type OrganiseTrack = Pick<TrackInfo, 'title' | 'artist' | 'album' | 'albumartist' | 'genre' | 'kind' | 'tracklen' | 'size' | 'ipod_path'>;

/** A track with the key edits and removals name it by. */
export interface Row<T extends OrganiseTrack = TrackInfo> {
  key: string;
  track: T;
}

export function rowsOf(tracks: TrackInfo[]): Row<TrackInfo>[] {
  return tracks.map((track) => ({ key: trackKey(track), track }));
}

// ------------------------------------------------------------------------ kinds

export type KindChip = 'all' | 'music' | 'podcasts' | 'audiobooks' | 'video';

export const KIND_CHIPS: { id: KindChip; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'music', label: 'Music' },
  { id: 'podcasts', label: 'Podcasts' },
  { id: 'audiobooks', label: 'Audiobooks' },
  { id: 'video', label: 'Video' },
];

/** Which chip a kind counts under. Video podcasts are video, so they show under Video only. */
export function chipOfKind(kind: string): Exclude<KindChip, 'all'> | null {
  switch (kind) {
    case 'music':
      return 'music';
    case 'podcast':
      return 'podcasts';
    case 'audiobook':
      return 'audiobooks';
    case 'movie':
    case 'music-video':
    case 'tv-show':
    case 'video-podcast':
      return 'video';
    default:
      return null;
  }
}

// ----------------------------------------------------------------------- filter

export interface Filter {
  search: string;
  chip: KindChip;
}

const SEARCH_FIELDS = ['title', 'artist', 'album', 'albumartist', 'genre'] as const;

/** True when every word typed appears in the title, artist, album, album artist or genre. */
export function matchesSearch(track: OrganiseTrack, search: string): boolean {
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const haystack = SEARCH_FIELDS.map((field) => track[field] ?? '').join('\n').toLowerCase();
  return words.every((word) => haystack.includes(word));
}

export function matchesChip(track: OrganiseTrack, chip: KindChip): boolean {
  return chip === 'all' || chipOfKind(track.kind) === chip;
}

export function filterRows<T extends OrganiseTrack>(rows: Row<T>[], filter: Filter): Row<T>[] {
  return rows.filter(({ track }) => matchesChip(track, filter.chip) && matchesSearch(track, filter.search));
}

/** How many tracks each chip would show for the text searched, so the numbers are what a click gives. */
export function chipCounts<T extends OrganiseTrack>(rows: Row<T>[], search: string): Record<KindChip, number> {
  const counts: Record<KindChip, number> = { all: 0, music: 0, podcasts: 0, audiobooks: 0, video: 0 };
  for (const { track } of rows) {
    if (!matchesSearch(track, search)) continue;
    counts.all += 1;
    const chip = chipOfKind(track.kind);
    if (chip) counts[chip] += 1;
  }
  return counts;
}

// ------------------------------------------------------------------------- sort

export type SortColumn = 'title' | 'artist' | 'album' | 'genre' | 'kind' | 'length' | 'size';
export type Direction = 'asc' | 'desc';
export interface Sort {
  column: SortColumn | null;
  direction: Direction;
}

export const SORT_COLUMNS: { id: SortColumn; label: string; numeric: boolean }[] = [
  { id: 'title', label: 'Title', numeric: false },
  { id: 'artist', label: 'Artist', numeric: false },
  { id: 'album', label: 'Album', numeric: false },
  { id: 'genre', label: 'Genre', numeric: false },
  { id: 'kind', label: 'Kind', numeric: false },
  { id: 'length', label: 'Length', numeric: true },
  { id: 'size', label: 'Size', numeric: true },
];

/** "Track 2" sorts before "Track 10", and capitals do not matter. */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function textOf(track: OrganiseTrack, column: SortColumn): string {
  switch (column) {
    case 'title':
      return (track.title ?? '').trim();
    case 'artist':
      return (track.artist ?? '').trim();
    case 'album':
      return (track.album ?? '').trim();
    case 'genre':
      return (track.genre ?? '').trim();
    case 'kind':
      return kindLabel(track.kind);
    default:
      return '';
  }
}

function numberOf(track: OrganiseTrack, column: SortColumn): number {
  return column === 'length' ? track.tracklen : column === 'size' ? track.size : 0;
}

/**
 * Sorts a copy. Text compares with numbers read as numbers, lengths and sizes compare as numbers.
 * Blank values go last whichever way it sorts, and ties fall back to the title, then to the order
 * the tracks came in, so the order is the same every time.
 */
export function sortRows<T extends OrganiseTrack>(rows: Row<T>[], sort: Sort): Row<T>[] {
  const { column, direction } = sort;
  if (!column) return rows.slice();
  const numeric = SORT_COLUMNS.find((entry) => entry.id === column)?.numeric ?? false;
  const sign = direction === 'asc' ? 1 : -1;
  const decorated = rows.map((row, index) => ({ row, index, text: numeric ? '' : textOf(row.track, column), value: numeric ? numberOf(row.track, column) : 0 }));
  decorated.sort((a, b) => {
    const blankA = numeric ? !(a.value > 0) : a.text === '';
    const blankB = numeric ? !(b.value > 0) : b.text === '';
    if (blankA !== blankB) return blankA ? 1 : -1;
    let order = 0;
    if (!blankA) order = numeric ? a.value - b.value : collator.compare(a.text, b.text);
    if (order !== 0) return order * sign;
    return collator.compare(a.row.track.title ?? '', b.row.track.title ?? '') || a.index - b.index;
  });
  return decorated.map((entry) => entry.row);
}

/** What clicking a column header does: sort by it, or flip the direction if it is already the sort. */
export function nextSort(current: Sort, column: SortColumn): Sort {
  if (current.column !== column) return { column, direction: 'asc' };
  return { column, direction: current.direction === 'asc' ? 'desc' : 'asc' };
}

// ------------------------------------------------------------------------ group

export type GroupBy = 'none' | 'artist' | 'album' | 'genre' | 'kind';

export const GROUP_OPTIONS: { id: GroupBy; label: string }[] = [
  { id: 'none', label: 'None' },
  { id: 'artist', label: 'Artist' },
  { id: 'album', label: 'Album' },
  { id: 'genre', label: 'Genre' },
  { id: 'kind', label: 'Kind' },
];

/** The id of the one group there is when nothing is grouped. It has no header, so it is never collapsed. */
export const ALL = '*all';

export interface Group<T extends OrganiseTrack = TrackInfo> {
  /** Stable name for collapsing. Blank for the group of tracks with no value, and `ALL` when there is no grouping. */
  id: string;
  label: string;
  rows: Row<T>[];
}

const NONE_LABEL: Record<Exclude<GroupBy, 'none' | 'kind'>, string> = {
  artist: '(no artist)',
  album: '(no album)',
  genre: '(no genre)',
};

/**
 * Splits rows into groups, keeping the order the rows are in inside each group. Groups are ordered
 * by name, with the one for a blank value last. With no grouping there is one group with no label.
 */
export function groupRows<T extends OrganiseTrack>(rows: Row<T>[], by: GroupBy): Group<T>[] {
  if (by === 'none') return [{ id: ALL, label: '', rows }];
  const groups = new Map<string, Group<T>>();
  for (const row of rows) {
    const text = by === 'kind' ? kindLabel(row.track.kind) : (row.track[by] ?? '').trim();
    const id = text.toLowerCase();
    let group = groups.get(id);
    if (!group) {
      group = { id, label: text || NONE_LABEL[by as keyof typeof NONE_LABEL], rows: [] };
      groups.set(id, group);
    }
    group.rows.push(row);
  }
  return [...groups.values()].sort((a, b) => {
    if ((a.id === '') !== (b.id === '')) return a.id === '' ? 1 : -1;
    return collator.compare(a.label, b.label);
  });
}

export interface Page<T extends OrganiseTrack = TrackInfo> {
  groups: Group<T>[];
  /** Rows drawn, and rows that could be drawn if nothing were cut off. Rows of a collapsed group are in neither. */
  shown: number;
  available: number;
}

/**
 * Cuts the groups down to the first `limit` rows to draw. A collapsed group keeps its header and
 * draws no rows. This is what keeps 5,000 tracks quick: only one page is ever drawn.
 */
export function pageGroups<T extends OrganiseTrack>(groups: Group<T>[], limit: number, collapsed: ReadonlySet<string>): Page<T> {
  let left = Math.max(0, limit);
  let shown = 0;
  let available = 0;
  const out = groups.map((group) => {
    if (group.id !== ALL && collapsed.has(group.id)) return { ...group, rows: [] };
    available += group.rows.length;
    const rows = group.rows.slice(0, left);
    left -= rows.length;
    shown += rows.length;
    return { ...group, rows };
  });
  return { groups: out, shown, available };
}

// -------------------------------------------------------------------- selection

/** A selection is a set of track keys, so it survives a re-sort, a new filter and a refresh. */
export type Selection = ReadonlySet<string>;

/** Adds (or takes out) every one of these rows, not only the ones drawn. Anything else selected stays. */
export function setSelected<T extends OrganiseTrack>(selection: Selection, rows: Row<T>[], on: boolean): Set<string> {
  const next = new Set(selection);
  for (const { key } of rows) {
    if (on) next.add(key);
    else next.delete(key);
  }
  return next;
}

/** Flips every one of these rows. Tracks selected but not in `rows` stay selected. */
export function invertSelection<T extends OrganiseTrack>(selection: Selection, rows: Row<T>[]): Set<string> {
  const next = new Set(selection);
  for (const { key } of rows) {
    if (next.has(key)) next.delete(key);
    else next.add(key);
  }
  return next;
}

export type SelectState = 'none' | 'some' | 'all';

export function selectState<T extends OrganiseTrack>(selection: Selection, rows: Row<T>[]): SelectState {
  if (!rows.length) return 'none';
  let chosen = 0;
  for (const { key } of rows) if (selection.has(key)) chosen += 1;
  return chosen === 0 ? 'none' : chosen === rows.length ? 'all' : 'some';
}

/** The rows that are selected, in the order given. */
export function selectedRows<T extends OrganiseTrack>(rows: Row<T>[], selection: Selection): Row<T>[] {
  return rows.filter(({ key }) => selection.has(key));
}

// -------------------------------------------------------------------- bulk edit

export interface BulkForm {
  artist: string;
  album: string;
  albumartist: string;
  genre: string;
  /** A kind, or blank to leave kinds alone. */
  kind: string;
}

export const EMPTY_BULK: BulkForm = { artist: '', album: '', albumartist: '', genre: '', kind: '' };

export const BULK_TEXT_FIELDS = [
  ['artist', 'Artist'],
  ['album', 'Album'],
  ['albumartist', 'Album artist'],
  ['genre', 'Genre'],
] as const;

export const KINDS: Kind[] = ['music', 'podcast', 'audiobook', 'movie', 'music-video', 'tv-show', 'video-podcast'];

export interface BulkPlan {
  /** One edit for each track that would change, in the order of the rows. */
  edits: TrackEdit[];
  changing: number;
  /** Selected tracks that already have every value asked for. */
  alreadyMatching: number;
  /** The fields being set, as the person wrote them (trimmed). Blank ones are left out. */
  set: { label: string; value: string }[];
}

/**
 * What a bulk edit would do. A blank box leaves that field alone, so a blank can never wipe tags.
 * One edit per track key, even if a key shows up twice, and none for a track that already matches.
 */
export function planBulkEdit<T extends OrganiseTrack>(rows: Row<T>[], form: BulkForm): BulkPlan {
  const wanted = BULK_TEXT_FIELDS.map(([field, label]) => ({ field, label, value: form[field].trim() })).filter((entry) => entry.value !== '');
  const kind = form.kind as Kind | '';
  const set: { label: string; value: string }[] = wanted.map(({ label, value }) => ({ label, value }));
  if (kind) set.push({ label: 'Kind', value: kindLabel(kind) });
  const edits: TrackEdit[] = [];
  const seen = new Set<string>();
  let alreadyMatching = 0;
  for (const { key, track } of rows) {
    if (seen.has(key)) continue;
    seen.add(key);
    const fields: Record<string, string> = {};
    for (const { field, value } of wanted) {
      if ((track[field] ?? '') !== value) fields[field] = value;
    }
    const kindChanges = kind !== '' && track.kind !== kind;
    if (!Object.keys(fields).length && !kindChanges) {
      alreadyMatching += 1;
      continue;
    }
    const edit: TrackEdit = { key };
    if (Object.keys(fields).length) edit.fields = fields;
    if (kindChanges) edit.kind = kind as Kind;
    edits.push(edit);
  }
  return { edits, changing: edits.length, alreadyMatching: set.length ? alreadyMatching : 0, set };
}

// -------------------------------------------------------------------- playlists

export interface PlaylistRule {
  /** True when OpenTunes may rename, delete and change the tracks of this playlist. */
  editable: boolean;
  /** Why not, in a sentence for the person. */
  reason: string | null;
}

/** Which playlists can be changed, and for the ones that cannot, why. The engine refuses the same ones. */
export function playlistRule(playlist: Pick<PlaylistInfo, 'name' | 'master' | 'smart' | 'podcasts'>, all: Pick<PlaylistInfo, 'name'>[]): PlaylistRule {
  if (playlist.master) return { editable: false, reason: 'This list holds every track on the iPod and the iPod keeps it that way. Add or remove tracks in the Tracks view instead.' };
  if (playlist.smart) return { editable: false, reason: 'Smart playlists fill themselves by rules the iPod follows, so OpenTunes leaves them as they are.' };
  if (playlist.podcasts) return { editable: false, reason: "The podcast list follows each track's kind. Change a track's kind to Podcast to put it here." };
  if (!playlist.name) return { editable: false, reason: 'This playlist has no name, and playlists are changed by name.' };
  if (all.filter((other) => other.name === playlist.name).length > 1) {
    return { editable: false, reason: 'More than one playlist has this name, so a change could reach the wrong one. Give them different names first.' };
  }
  return { editable: true, reason: null };
}

/** Null when the name can be used for a new or renamed playlist. */
export function validatePlaylistName(name: string, playlists: Pick<PlaylistInfo, 'name'>[]): string | null {
  const wanted = name.trim();
  if (!wanted) return 'Give the playlist a name.';
  if (playlists.some((playlist) => (playlist.name ?? '').trim().toLowerCase() === wanted.toLowerCase())) return `There is already a playlist called "${wanted}".`;
  return null;
}

/** The tracks of a playlist, in the playlist's order. Handles the library no longer has are skipped. */
export function playlistRows<T extends OrganiseTrack & { handle: number }>(playlist: Pick<PlaylistInfo, 'tracks'>, rows: Row<T>[]): Row<T>[] {
  const byHandle = new Map(rows.map((row) => [row.track.handle, row]));
  const out: Row<T>[] = [];
  for (const handle of playlist.tracks) {
    const row = byHandle.get(handle);
    if (row) out.push(row);
  }
  return out;
}

/** Splits the selection into what adding to a playlist would add, and what is in it already. */
export function splitForPlaylist<T extends OrganiseTrack & { handle: number }>(
  playlist: Pick<PlaylistInfo, 'tracks'>,
  rows: Row<T>[],
  selection: Selection,
): { toAdd: string[]; alreadyIn: string[] } {
  const inside = new Set(playlist.tracks);
  const toAdd: string[] = [];
  const alreadyIn: string[] = [];
  const seen = new Set<string>();
  for (const { key, track } of rows) {
    if (!selection.has(key) || seen.has(key)) continue;
    seen.add(key);
    (inside.has(track.handle) ? alreadyIn : toAdd).push(key);
  }
  return { toAdd, alreadyIn };
}
