import { describe, expect, it } from 'vitest';
import type { PlaylistInfo, TrackInfo } from '@opentunes/engine';
import {
  ALL,
  EMPTY_BULK,
  chipCounts,
  filterRows,
  groupRows,
  invertSelection,
  nextSort,
  pageGroups,
  planBulkEdit,
  playlistRows,
  playlistRule,
  rowsOf,
  selectState,
  selectedRows,
  setSelected,
  sortRows,
  splitForPlaylist,
  validatePlaylistName,
  type Row,
} from '../src/library/organise';

let handles = 0;
/** A track the way the engine reports it, with only the fields these functions read filled in. */
function track(fields: Partial<TrackInfo>): TrackInfo {
  handles += 1;
  return {
    handle: handles,
    title: null,
    artist: null,
    album: null,
    albumartist: null,
    genre: null,
    kind: 'music',
    tracklen: 180000,
    size: 4_000_000,
    ipod_path: `:iPod_Control:Music:F00:T${String(handles).padStart(4, '0')}.mp3`,
    ...fields,
  } as TrackInfo;
}

const library = (): Row[] =>
  rowsOf([
    track({ title: 'Track 10', artist: 'Beta', album: 'Second', genre: 'Rock', tracklen: 100000, size: 900 }),
    track({ title: 'track 2', artist: 'alpha', album: 'First', genre: 'Rock', tracklen: 300000, size: 20_000 }),
    track({ title: 'Track 1', artist: 'Alpha', album: 'First', genre: 'Jazz', tracklen: 0, size: 3_000 }),
    track({ title: 'Untitled interview', artist: null, album: null, genre: null, kind: 'podcast', tracklen: 2_000_000, size: 31_000_000 }),
    track({ title: 'A Short Story', artist: 'An Author', album: 'A Short Story', kind: 'audiobook', size: 52_000_000 }),
    track({ title: 'Demo Film', kind: 'movie', size: 410_000_000 }),
    track({ title: 'Cast video', kind: 'video-podcast', size: 80_000_000 }),
  ]);

const titles = (rows: Row[]) => rows.map(({ track: t }) => t.title);

describe('filtering', () => {
  it('searches title, artist, album, album artist and genre, every word, any case', () => {
    const rows = library();
    expect(titles(filterRows(rows, { search: 'alpha first', chip: 'all' }))).toEqual(['track 2', 'Track 1']);
    expect(titles(filterRows(rows, { search: 'JAZZ', chip: 'all' }))).toEqual(['Track 1']);
    expect(filterRows(rows, { search: 'nothing like this', chip: 'all' })).toEqual([]);
    expect(filterRows(rows, { search: '   ', chip: 'all' })).toHaveLength(rows.length);
  });

  it('keeps video podcasts under Video, not Podcasts', () => {
    const rows = library();
    expect(titles(filterRows(rows, { search: '', chip: 'podcasts' }))).toEqual(['Untitled interview']);
    expect(titles(filterRows(rows, { search: '', chip: 'video' }))).toEqual(['Demo Film', 'Cast video']);
    expect(titles(filterRows(rows, { search: '', chip: 'audiobooks' }))).toEqual(['A Short Story']);
    expect(filterRows(rows, { search: '', chip: 'music' })).toHaveLength(3);
  });

  it('counts each chip for the text searched', () => {
    const rows = library();
    expect(chipCounts(rows, '')).toEqual({ all: 7, music: 3, podcasts: 1, audiobooks: 1, video: 2 });
    expect(chipCounts(rows, 'story')).toEqual({ all: 1, music: 0, podcasts: 0, audiobooks: 1, video: 0 });
  });
});

describe('sorting', () => {
  it('reads numbers inside text as numbers and ignores case', () => {
    const sorted = sortRows(filterRows(library(), { search: '', chip: 'music' }), { column: 'title', direction: 'asc' });
    expect(titles(sorted)).toEqual(['Track 1', 'track 2', 'Track 10']);
    expect(titles(sortRows(sorted, { column: 'title', direction: 'desc' }))).toEqual(['Track 10', 'track 2', 'Track 1']);
  });

  it('sorts length and size as numbers, not text', () => {
    const rows = library();
    expect(sortRows(rows, { column: 'size', direction: 'asc' })[0]?.track.title).toBe('Track 10'); // 900 would sort after 20000 as text
    expect(sortRows(rows, { column: 'size', direction: 'desc' })[0]?.track.title).toBe('Demo Film');
  });

  it('puts blanks last whichever way it sorts', () => {
    const rows = library();
    const asc = sortRows(rows, { column: 'artist', direction: 'asc' });
    const desc = sortRows(rows, { column: 'artist', direction: 'desc' });
    expect(asc.slice(-3).every(({ track: t }) => !t.artist)).toBe(true);
    expect(desc.slice(-3).every(({ track: t }) => !t.artist)).toBe(true);
    // a track of unknown length is last by length too
    expect(sortRows(rows, { column: 'length', direction: 'asc' }).at(-1)?.track.title).toBe('Track 1');
    expect(sortRows(rows, { column: 'length', direction: 'desc' }).at(-1)?.track.title).toBe('Track 1');
  });

  it('is stable: equal values keep the order they came in, and nothing is changed in place', () => {
    const rows = library();
    const before = titles(rows);
    const byGenre = sortRows(rows, { column: 'genre', direction: 'asc' });
    expect(titles(rows)).toEqual(before);
    expect(titles(byGenre).slice(0, 3)).toEqual(['Track 1', 'track 2', 'Track 10']); // Jazz, then Rock by title with 2 before 10
    expect(titles(sortRows(rows, { column: null, direction: 'asc' }))).toEqual(before);
  });

  it('a header click sorts ascending, then flips, and a new column starts ascending', () => {
    let sort = nextSort({ column: null, direction: 'asc' }, 'artist');
    expect(sort).toEqual({ column: 'artist', direction: 'asc' });
    sort = nextSort(sort, 'artist');
    expect(sort).toEqual({ column: 'artist', direction: 'desc' });
    expect(nextSort(sort, 'album')).toEqual({ column: 'album', direction: 'asc' });
  });
});

describe('grouping', () => {
  it('groups by artist ignoring case, in name order, with the blank group last', () => {
    const groups = groupRows(sortRows(library(), { column: 'title', direction: 'asc' }), 'artist');
    expect(groups.map((group) => group.label)).toEqual(['Alpha', 'An Author', 'Beta', '(no artist)']);
    expect(groups[0]?.rows.map(({ track: t }) => t.title)).toEqual(['Track 1', 'track 2']);
    expect(groups.at(-1)?.rows).toHaveLength(3);
  });

  it('groups by kind with the kind names a person reads', () => {
    const labels = groupRows(library(), 'kind').map((group) => group.label);
    expect(labels).toEqual(['Audiobook', 'Movie', 'Music', 'Podcast', 'Video podcast']);
  });

  it('with no grouping there is one group with no header, and it never collapses', () => {
    const groups = groupRows(library(), 'none');
    expect(groups).toHaveLength(1);
    expect(groups[0]?.id).toBe(ALL);
    expect(pageGroups(groups, 100, new Set([ALL])).shown).toBe(7);
  });

  it('a collapsed group draws no rows and does not use up the page', () => {
    const groups = groupRows(library(), 'genre');
    const rock = groups.find((group) => group.label === 'Rock');
    const page = pageGroups(groups, 100, new Set([rock?.id ?? '']));
    expect(page.groups.find((group) => group.label === 'Rock')?.rows).toEqual([]);
    expect(page.shown).toBe(5);
    expect(page.available).toBe(5);
  });
});

describe('paging 5,000 tracks', () => {
  const many = rowsOf(Array.from({ length: 5000 }, (_, index) => track({ title: `Song ${index}`, artist: `Artist ${index % 50}`, album: `Album ${index % 400}` })));

  it('draws only the first page, across groups, and says how many are left', () => {
    const groups = groupRows(sortRows(many, { column: 'title', direction: 'asc' }), 'artist');
    expect(groups).toHaveLength(50);
    const page = pageGroups(groups, 200, new Set());
    expect(page.shown).toBe(200);
    expect(page.available).toBe(5000);
    expect(page.groups.reduce((sum, group) => sum + group.rows.length, 0)).toBe(200);
    expect(pageGroups(groups, 400, new Set()).shown).toBe(400);
  });

  it('filters, sorts and groups all of them in well under a second', () => {
    const start = performance.now();
    const filtered = filterRows(many, { search: 'song 4', chip: 'music' });
    const grouped = groupRows(sortRows(filtered, { column: 'title', direction: 'desc' }), 'album');
    expect(filtered.length).toBeGreaterThan(1000);
    expect(grouped.length).toBeGreaterThan(0);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

describe('selection', () => {
  it('select all takes every row that matches the filter, not only the rows drawn', () => {
    const many = rowsOf(Array.from({ length: 1000 }, (_, index) => track({ title: `Song ${index}`, genre: index % 2 ? 'Rock' : 'Jazz' })));
    const matching = filterRows(many, { search: 'jazz', chip: 'all' });
    const drawn = pageGroups(groupRows(matching, 'none'), 200, new Set()).shown;
    expect(drawn).toBe(200);
    const selection = setSelected(new Set(), matching, true);
    expect(selection.size).toBe(500);
    expect(selectState(selection, matching)).toBe('all');
    expect(selectState(selection, many)).toBe('some');
  });

  it('select none clears them, and a group can be taken out on its own', () => {
    const rows = library();
    const all = setSelected(new Set(), rows, true);
    const [first, second] = groupRows(rows, 'genre');
    const without = setSelected(all, first?.rows ?? [], false);
    expect(without.size).toBe(rows.length - (first?.rows.length ?? 0));
    expect(selectState(without, first?.rows ?? [])).toBe('none');
    expect(selectState(without, second?.rows ?? [])).toBe('all');
    expect(setSelected(all, rows, false).size).toBe(0);
  });

  it('invert flips the rows in view and leaves a selection outside the view alone', () => {
    const rows = library();
    const music = filterRows(rows, { search: '', chip: 'music' });
    const start = new Set([music[0]?.key ?? '', rows[5]?.key ?? '']);
    const inverted = invertSelection(start, music);
    expect([...inverted].sort()).toEqual([music[1]?.key, music[2]?.key, rows[5]?.key].sort());
    expect(invertSelection(inverted, music)).toEqual(start);
  });

  it('keeps the selected rows in list order', () => {
    const rows = library();
    const picked = new Set([rows[4]?.key ?? '', rows[1]?.key ?? '']);
    expect(titles(selectedRows(rows, picked))).toEqual(['track 2', 'A Short Story']);
  });
});

describe('bulk tag edit', () => {
  it('leaves blank fields alone and makes one edit per track that changes', () => {
    const rows = library().slice(0, 3);
    const plan = planBulkEdit(rows, { ...EMPTY_BULK, genre: ' Pop ' });
    expect(plan.changing).toBe(3);
    expect(plan.edits.map((edit) => edit.key)).toEqual(rows.map((row) => row.key));
    for (const edit of plan.edits) expect(edit).toEqual({ key: edit.key, fields: { genre: 'Pop' } });
    expect(plan.set).toEqual([{ label: 'Genre', value: 'Pop' }]);
  });

  it('skips tracks that already match, and counts them', () => {
    const rows = library().slice(0, 3); // Rock, Rock, Jazz
    const plan = planBulkEdit(rows, { ...EMPTY_BULK, genre: 'Rock' });
    expect(plan.changing).toBe(1);
    expect(plan.alreadyMatching).toBe(2);
  });

  it('sets several fields and the kind in the same edit', () => {
    const rows = library().slice(3, 4); // the podcast
    const plan = planBulkEdit(rows, { artist: 'New Artist', album: 'New Album', albumartist: 'Various', genre: 'Talk', kind: 'audiobook' });
    expect(plan.edits).toEqual([{ key: rows[0]?.key, fields: { artist: 'New Artist', album: 'New Album', albumartist: 'Various', genre: 'Talk' }, kind: 'audiobook' }]);
  });

  it('a kind alone is an edit with no fields, and the same kind is not an edit', () => {
    const rows = library();
    expect(planBulkEdit(rows.slice(0, 1), { ...EMPTY_BULK, kind: 'audiobook' }).edits[0]).toEqual({ key: rows[0]?.key, kind: 'audiobook' });
    expect(planBulkEdit(rows.slice(0, 1), { ...EMPTY_BULK, kind: 'music' }).changing).toBe(0);
  });

  it('an empty form changes nothing', () => {
    const plan = planBulkEdit(library(), EMPTY_BULK);
    expect(plan.changing).toBe(0);
    expect(plan.set).toEqual([]);
    expect(planBulkEdit(library(), { ...EMPTY_BULK, artist: '   ' }).changing).toBe(0);
  });

  it('never makes two edits for the same key', () => {
    const one = library()[0] as Row;
    expect(planBulkEdit([one, one], { ...EMPTY_BULK, genre: 'Pop' }).edits).toHaveLength(1);
  });
});

describe('playlists', () => {
  const list = (fields: Partial<PlaylistInfo>): PlaylistInfo => ({ handle: 1, name: 'Mix', master: false, podcasts: false, smart: false, tracks: [], ...fields });

  it('says why the master, smart, podcast, unnamed and duplicate-named lists are read only', () => {
    const all = [list({ name: 'iPod', master: true }), list({ name: 'Mix' }), list({ name: 'Twin' }), list({ name: 'Twin' })];
    expect(playlistRule(all[0] as PlaylistInfo, all)).toMatchObject({ editable: false });
    expect(playlistRule(all[0] as PlaylistInfo, all).reason).toMatch(/every track/);
    expect(playlistRule(list({ smart: true }), all).reason).toMatch(/Smart playlists/);
    expect(playlistRule(list({ podcasts: true, name: 'Podcasts' }), all).reason).toMatch(/kind/);
    expect(playlistRule(list({ name: null }), all).reason).toMatch(/no name/);
    expect(playlistRule(all[2] as PlaylistInfo, all).reason).toMatch(/More than one/);
    expect(playlistRule(all[1] as PlaylistInfo, all)).toEqual({ editable: true, reason: null });
  });

  it('refuses blank and taken names, whatever the case', () => {
    const all = [list({ name: 'Road trip' })];
    expect(validatePlaylistName('  ', all)).toMatch(/name/);
    expect(validatePlaylistName('road TRIP', all)).toMatch(/already/);
    expect(validatePlaylistName('Gym', all)).toBeNull();
  });

  it('lists a playlist in its own order and splits the selection into new and already in', () => {
    const rows = library();
    const inside = list({ tracks: [rows[2]?.track.handle ?? 0, rows[0]?.track.handle ?? 0, 9999] });
    expect(titles(playlistRows(inside, rows))).toEqual(['Track 1', 'Track 10']);
    const picked = new Set([rows[0]?.key ?? '', rows[1]?.key ?? '', rows[3]?.key ?? '']);
    expect(splitForPlaylist(inside, rows, picked)).toEqual({ toAdd: [rows[1]?.key, rows[3]?.key], alreadyIn: [rows[0]?.key] });
  });
});
