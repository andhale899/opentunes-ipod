import { afterEach, describe, expect, it } from 'vitest';
import { trackKey, type OffloadReport } from '@opentunes/engine';
import { MEDIA_GROUPS, NO_CHOICE, groupTotals, planFor, selectedWithFiles, type ChoiceTrack, type MediaGroup } from '../src/backupChoice';
import { chipOfKind } from '../src/library/organise';
import { backupReportFromOffload, chipText } from '../src/lastBackup';
import { clearLibrarySelection, getLibrarySelection, pruneLibrarySelection, setLibrarySelection, subscribeLibrarySelection } from '../src/selection';

const track = (title: string, kind: string, folder: string, size: number, path: string | null = `:iPod_Control:Music:${folder}:${title.replace(/\W/g, '')}.mp3`): ChoiceTrack => ({
  kind,
  ipod_path: path,
  title,
  artist: null,
  album: null,
  tracklen: 1000,
  size,
});

const library = [
  track('Morning Light', 'music', 'F01', 8_000_000),
  track('Night Drive', 'music', 'F02', 7_000_000),
  track('Episode 12', 'podcast', 'F03', 31_000_000),
  track('A Short Story', 'audiobook', 'F04', 52_000_000),
  track('Demo Film', 'movie', 'F05', 410_000_000),
  track('Video Cast', 'video-podcast', 'F06', 90_000_000),
  track('No file here', 'music', 'F07', 5_000_000, null),
];

const choose = (...groups: MediaGroup[]) => ({ groups: new Set(groups), selectedOnly: false });
const nothing: ReadonlySet<string> = new Set();

describe('the kinds a person can tick', () => {
  it('cover every kind the engine has, and agree with the Library tab about which group a kind is in', () => {
    const engineKinds = ['music', 'movie', 'music-video', 'tv-show', 'podcast', 'video-podcast', 'audiobook'];
    const chipToGroup: Record<string, MediaGroup> = { music: 'music', podcasts: 'podcasts', audiobooks: 'audiobooks', video: 'video' };
    for (const kind of engineKinds) {
      const groups = MEDIA_GROUPS.filter((group) => group.kinds.includes(kind));
      expect(groups, kind).toHaveLength(1);
      expect(groups[0]?.id, kind).toBe(chipToGroup[chipOfKind(kind) as string]);
    }
  });

  it('counts files and bytes per kind from the library, once per file and never a track with no file', () => {
    const totals = Object.fromEntries(groupTotals(library).map((entry) => [entry.id, [entry.files, entry.bytes]]));
    expect(totals).toEqual({ music: [2, 15_000_000], podcasts: [1, 31_000_000], audiobooks: [1, 52_000_000], video: [2, 500_000_000] });
    const twice = groupTotals([library[0] as ChoiceTrack, library[0] as ChoiceTrack]);
    expect(twice.find((entry) => entry.id === 'music')?.files).toBe(1);
  });
});

describe('what a choice comes to', () => {
  it('is the quick backup with nothing ticked, also when "selected only" is ticked but nothing is selected', () => {
    expect(planFor(NO_CHOICE, library, nothing)).toEqual({ mode: 'library' });
    expect(planFor({ groups: new Set(), selectedOnly: true }, library, nothing)).toEqual({ mode: 'library' });
  });

  it('copies the ticked kinds only, with the files and size that will be copied', () => {
    const plan = planFor(choose('podcasts'), library, nothing);
    expect(plan).toMatchObject({ mode: 'media', full: false, files: 1, bytes: 31_000_000, tracks: 1, include: { kinds: ['podcast'] } });
    const two = planFor(choose('podcasts', 'video'), library, nothing);
    expect(two).toMatchObject({ mode: 'media', files: 3, bytes: 531_000_000, include: { kinds: ['podcast', 'movie', 'music-video', 'tv-show', 'video-podcast'] } });
  });

  it('is the full copy with every kind ticked, which also takes tracks of no listed kind and files nothing lists', () => {
    const plan = planFor(choose('music', 'podcasts', 'audiobooks', 'video'), library, nothing);
    expect(plan).toMatchObject({ mode: 'media', full: true, include: undefined, files: 6 });
  });

  it('copies only the selected tracks when asked, whatever their kind', () => {
    const selection = new Set([trackKey(library[0] as ChoiceTrack), trackKey(library[4] as ChoiceTrack), trackKey(library[6] as ChoiceTrack)]);
    const plan = planFor({ groups: new Set(), selectedOnly: true }, library, selection);
    expect(plan).toMatchObject({ mode: 'media', full: false, files: 2, bytes: 418_000_000, tracks: 2 });
    expect(plan.mode === 'media' && plan.include?.kinds).toBeUndefined();
    expect(plan.mode === 'media' && plan.include?.trackKeys?.sort()).toEqual([...selection].sort());
    expect(selectedWithFiles(library, selection)).toBe(2);
  });

  it('needs both when kinds and a selection are ticked together', () => {
    const selection = new Set([trackKey(library[0] as ChoiceTrack), trackKey(library[2] as ChoiceTrack)]);
    const plan = planFor({ groups: new Set<MediaGroup>(['podcasts']), selectedOnly: true }, library, selection);
    expect(plan).toMatchObject({ mode: 'media', files: 1, bytes: 31_000_000, include: { kinds: ['podcast'] } });
    const none = planFor({ groups: new Set<MediaGroup>(['audiobooks']), selectedOnly: true }, library, selection);
    expect(none).toMatchObject({ mode: 'media', files: 0, bytes: 0 });
  });
});

describe('the selection shared with the Library tab', () => {
  afterEach(() => clearLibrarySelection());

  it('is set by the Library tab, read by the backup panel, and tells listeners only when it changes', () => {
    let heard = 0;
    const stop = subscribeLibrarySelection(() => (heard += 1));
    setLibrarySelection(['a', 'b']);
    expect([...getLibrarySelection()].sort()).toEqual(['a', 'b']);
    setLibrarySelection(['b', 'a']);
    expect(heard).toBe(1);
    stop();
    setLibrarySelection(['a']);
    expect(heard).toBe(1);
  });

  it('is pruned when the library is read again, so a track that is gone is not copied', () => {
    setLibrarySelection(['a', 'b', 'c']);
    pruneLibrarySelection(['a', 'c', 'z']);
    expect([...getLibrarySelection()].sort()).toEqual(['a', 'c']);
    clearLibrarySelection();
    expect(getLibrarySelection().size).toBe(0);
  });
});

describe('a finished copy as the backup this session counts', () => {
  const copy = (changes: Partial<OffloadReport> = {}): OffloadReport =>
    ({
      folder: 'opentunes-offload-2026-11-07-1804',
      complete: true,
      stopped: false,
      files: { total: 1, copied: 1, skipped: 0, failed: 0, notCopied: 0 },
      bytes: { total: 1, copied: 1, skipped: 0 },
      failures: [],
      missing: [],
      unlisted: [],
      tracks: 5,
      playlists: 1,
      libraryError: null,
      notesError: null,
      database: { folder: 'database', files: 12, bytes: 3456, complete: true, failures: [] },
      databaseError: null,
      partial: null,
      elapsedMs: 10,
      bytesPerSecond: 1,
      ...changes,
    }) as OffloadReport;

  it('is the database folder, as a complete backup the write gate accepts', () => {
    expect(backupReportFromOffload(copy())).toEqual({ folder: 'opentunes-offload-2026-11-07-1804/database', files: 12, bytes: 3456, verified: 12, failures: [], left: [], complete: true, stopped: false });
  });

  it('is nothing when the copy was stopped or its library files were not saved and checked', () => {
    expect(backupReportFromOffload(copy({ stopped: true }))).toBeNull();
    expect(backupReportFromOffload(copy({ databaseError: 'It could not be saved.' }))).toBeNull();
    expect(backupReportFromOffload(copy({ database: { folder: 'database', files: 12, bytes: 1, complete: false, failures: ['x'] } }))).toBeNull();
    expect(backupReportFromOffload(copy({ database: null }))).toBeNull();
  });

  it('says in the chip which backup is in use', () => {
    const madeAt = new Date(2026, 10, 7, 18, 4).getTime();
    expect(chipText(null)).toBe('Backup made');
    expect(chipText({ kind: 'made', madeAt })).toBe('Backup made');
    expect(chipText({ kind: 'verified', madeAt })).toMatch(/^Backup from .* still matches this iPod$/);
    expect(chipText({ kind: 'older', madeAt })).toMatch(/^Older backup from .* in use$/);
  });
});
