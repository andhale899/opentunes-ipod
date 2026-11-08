import { describe, expect, it } from 'vitest';
import type { PlaylistInfo, TrackInfo } from '@opentunes/engine';
import {
  KEEP_WEIGHTS,
  applyVerdicts,
  buildPlaylistSteps,
  changeKeep,
  defaultChoices,
  editDistance,
  findDuplicates,
  removalKeys,
  sameLength,
  selectSure,
  similarArtists,
  similarTitles,
  songKey,
  tickGroup,
  toggleRemove,
  versionTags,
  type DupGroup,
  type DupTrack,
} from '../src/library/duplicates';

let handles = 0;
/** A track the way the engine reports it, with only what the duplicate finder reads. The paths are made up. */
function track(fields: Partial<DupTrack> = {}): TrackInfo {
  handles += 1;
  return {
    handle: handles,
    ipod_path: `:iPod_Control:Music:F00:T${String(handles).padStart(4, '0')}.m4a`,
    title: 'Morning Light',
    artist: 'The Examples',
    albumartist: null,
    album: 'Demo Album',
    year: 2011,
    kind: 'music',
    tracklen: 200_000,
    bitrate: 256,
    size: 6_400_000,
    filetype: 'AAC audio file',
    has_artwork: 0,
    artwork_count: 0,
    rating: 0,
    playcount: 0,
    time_added: handles,
    ...fields,
  } as TrackInfo;
}

const playlist = (name: string | null, tracks: TrackInfo[], extra: Partial<PlaylistInfo> = {}): PlaylistInfo =>
  ({ handle: 100 + handles++, name, master: false, podcasts: false, smart: false, tracks: tracks.map((one) => one.handle), ...extra }) as PlaylistInfo;

const keysOf = (group: DupGroup): string[] => group.members.map((member) => member.track.title ?? '');

describe('comparing lengths', () => {
  it('allows 4 seconds or 3 percent, whichever is more, and never matches an unknown length', () => {
    expect(sameLength(30_000, 33_900)).toBe(true); // short track: 4 seconds is more than 3 percent
    expect(sameLength(30_000, 34_100)).toBe(false);
    expect(sameLength(200_000, 205_900)).toBe(true); // 3 percent of 3:20 is 6 seconds
    expect(sameLength(200_000, 206_500)).toBe(false);
    expect(sameLength(600_000, 617_000)).toBe(true); // 17 s is under 3 percent of 10 minutes
    expect(sameLength(600_000, 619_000)).toBe(false);
    expect(sameLength(0, 0)).toBe(false);
    expect(sameLength(0, 200_000)).toBe(false);
  });
});

describe('the song key', () => {
  it('ignores case, accents, punctuation and noise tags, using the shared identity code', () => {
    const a = songKey({ kind: 'music', title: 'Café del Mar (Remastered 2011)', artist: 'The Examples', albumartist: null, album: '' });
    const b = songKey({ kind: 'music', title: 'cafe del mar', artist: 'the examples', albumartist: null, album: '' });
    expect(a).toBe(b);
    expect(songKey({ kind: 'music', title: 'Song (feat. Someone)', artist: 'A', albumartist: null, album: '' })).toBe(songKey({ kind: 'music', title: 'Song', artist: 'A', albumartist: null, album: '' }));
  });

  it('keeps a live or remix title apart from the studio one', () => {
    const studio = songKey({ kind: 'music', title: 'Song', artist: 'A', albumartist: null, album: '' });
    expect(songKey({ kind: 'music', title: 'Song (Live)', artist: 'A', albumartist: null, album: '' })).not.toBe(studio);
    expect(songKey({ kind: 'music', title: 'Song (Remix)', artist: 'A', albumartist: null, album: '' })).not.toBe(studio);
  });

  it('never compares audiobooks, movies or TV, and skips a bare "Track 01" with no artist', () => {
    for (const kind of ['audiobook', 'movie', 'tv-show', 'unspecified']) expect(songKey({ kind, title: 'Chapter 1', artist: 'A', albumartist: null, album: 'B' })).toBeNull();
    expect(songKey({ kind: 'music', title: 'Track 01', artist: '', albumartist: null, album: '' })).toBeNull();
    expect(songKey({ kind: 'music', title: 'Track 01', artist: 'A', albumartist: null, album: '' })).not.toBeNull();
    expect(songKey({ kind: 'music', title: '', artist: 'A', albumartist: null, album: '' })).toBeNull();
  });

  it('keeps music, music videos and podcasts in their own classes', () => {
    const base = { title: 'Same', artist: 'A', albumartist: null, album: 'Show' };
    const keys = ['music', 'music-video', 'podcast', 'video-podcast'].map((kind) => songKey({ kind, ...base }));
    expect(new Set(keys).size).toBe(4);
  });

  it('matches a podcast by show and title, with the show being the album', () => {
    const a = songKey({ kind: 'podcast', title: 'Episode 5', artist: 'Host', albumartist: null, album: 'The Show' });
    expect(a).toBe(songKey({ kind: 'podcast', title: 'episode 5', artist: 'Someone else', albumartist: null, album: 'the show' }));
    expect(a).not.toBe(songKey({ kind: 'podcast', title: 'Episode 5', artist: 'Host', albumartist: null, album: 'Another Show' }));
  });
});

describe('versions', () => {
  it('names live, remix, acoustic, demo, instrumental, karaoke and radio edit', () => {
    expect(versionTags('Song (Live at Wembley)')).toBe('live');
    expect(versionTags('Song - Remix')).toBe('remix');
    expect(versionTags('Song (Acoustic)')).toBe('acoustic');
    expect(versionTags('Song [Demo]')).toBe('demo');
    expect(versionTags('Song (Instrumental)')).toBe('instrumental');
    expect(versionTags('Song (Karaoke Version)')).toBe('karaoke');
    expect(versionTags('Song (Radio Edit)')).toBe('radio edit');
    expect(versionTags('Song (Live) (Acoustic)')).toBe('acoustic,live');
    expect(versionTags('Song')).toBe('');
  });

  it('reads a live album from the album name, but not a studio album with "Live" in its name', () => {
    expect(versionTags('Song', 'Live at the Apollo')).toBe('live');
    expect(versionTags('Song', 'Greatest Hits (Live)')).toBe('live');
    expect(versionTags('Song', 'Live Through This')).toBe('');
    expect(versionTags('Song', 'Demo Album')).toBe('');
  });
});

describe('edit distance', () => {
  it('counts changes and gives up past the limit', () => {
    expect(editDistance('kitten', 'sitting')).toBe(3);
    expect(editDistance('same', 'same')).toBe(0);
    expect(editDistance('abcdef', 'uvwxyz', 2)).toBe(3);
    expect(editDistance('a', 'abcdef', 2)).toBe(3);
  });

  it('treats a typo as similar and a different number as different', () => {
    expect(similarTitles('morning light', 'mornin light')).toBe(true);
    expect(similarTitles('morning light', 'evening song')).toBe(false);
    expect(similarTitles('song part 1', 'song part 2')).toBe(false);
    expect(similarTitles('go', 'no')).toBe(false); // short titles must match exactly
    expect(similarArtists('beatles', 'beatls')).toBe(true);
    expect(similarArtists('abba', 'abbb')).toBe(false);
  });
});

describe('grouping', () => {
  it('finds a SURE group: same artist, title, album and length (length within tolerance)', () => {
    const a = track({ tracklen: 200_000 });
    const b = track({ tracklen: 202_500 });
    const report = findDuplicates([a, b, track({ title: 'Another' })]);
    expect(report.groups).toHaveLength(1);
    expect(report.groups[0]).toMatchObject({ level: 'sure', why: 'same artist, title, album and length' });
    expect(report.groups[0]?.members).toHaveLength(2);
    expect(report.candidates).toEqual([]);
  });

  it('finds a LIKELY group when the album differs (a single and an album)', () => {
    const report = findDuplicates([track({ album: 'Demo Album' }), track({ album: 'Demo Album (Single)' }), track({ album: 'Greatest Hits' })]);
    expect(report.groups).toHaveLength(1);
    expect(report.groups[0]?.level).toBe('likely');
    expect(report.groups[0]?.members).toHaveLength(3);
  });

  it('does not call two blank albums a SURE match when there is an artist, but does for files with no tags at all', () => {
    const withArtist = findDuplicates([track({ album: '' }), track({ album: '' })]);
    expect(withArtist.groups[0]?.level).toBe('likely');
    const bare = findDuplicates([track({ album: '', artist: '', title: 'smoke tone copy' }), track({ album: '', artist: '', title: 'smoke tone copy' })]);
    expect(bare.groups[0]?.level).toBe('sure');
  });

  it('keeps different lengths apart, and a length of zero never groups', () => {
    expect(findDuplicates([track({ tracklen: 200_000 }), track({ tracklen: 260_000 })]).groups).toEqual([]);
    expect(findDuplicates([track({ tracklen: 0 }), track({ tracklen: 0 })]).groups).toEqual([]);
  });

  it('keeps live, remix, acoustic, demo, instrumental, karaoke and radio edit versions apart from the studio track and from each other', () => {
    const titles = ['Song', 'Song (Live)', 'Song (Remix)', 'Song (Acoustic)', 'Song (Demo)', 'Song (Instrumental)', 'Song (Karaoke Version)', 'Song (Radio Edit)'];
    const report = findDuplicates(titles.map((title) => track({ title })));
    expect(report.groups).toEqual([]);
    // The same version twice still groups.
    expect(findDuplicates([track({ title: 'Song (Live)' }), track({ title: 'Song - Live' })]).groups).toHaveLength(1);
  });

  it('keeps a track from a live album apart from the studio track', () => {
    expect(findDuplicates([track({ album: 'Live at the Apollo' }), track({ album: 'Studio' })]).groups).toEqual([]);
  });

  it('never groups audiobook chapters, movies, or tracks with no file path', () => {
    const chapters = [track({ kind: 'audiobook', title: 'Chapter 1' }), track({ kind: 'audiobook', title: 'Chapter 1' })];
    const movies = [track({ kind: 'movie' }), track({ kind: 'movie' })];
    const noPath = [track({ ipod_path: null }), track({ ipod_path: null })];
    const report = findDuplicates([...chapters, ...movies, ...noPath]);
    expect(report.groups).toEqual([]);
    expect(report.skipped).toBe(6);
  });

  it('compares like with like: a song and a music video of it are not duplicates', () => {
    expect(findDuplicates([track({ kind: 'music' }), track({ kind: 'music-video' })]).groups).toEqual([]);
  });

  it('groups a podcast episode of the same show, title and length', () => {
    const report = findDuplicates([
      track({ kind: 'podcast', title: 'Episode 5', album: 'The Show', artist: 'Host' }),
      track({ kind: 'podcast', title: 'Episode 5', album: 'The Show', artist: 'Host' }),
      track({ kind: 'podcast', title: 'Episode 5', album: 'Another Show', artist: 'Host' }),
    ]);
    expect(report.groups).toHaveLength(1);
    expect(report.groups[0]).toMatchObject({ kindClass: 'podcast', level: 'sure' });
  });

  it('gives each group a distinct small id, SURE before LIKELY', () => {
    const report = findDuplicates([track({ title: 'B' }), track({ title: 'B' }), track({ title: 'A', album: 'x' }), track({ title: 'A', album: 'y' })]);
    expect(report.groups.map((group) => group.level)).toEqual(['sure', 'likely']);
    expect(report.groups.map((group) => group.id)).toEqual([1, 2]);
  });
});

describe('fuzzy candidates', () => {
  it('finds a typo in the title and a "feat." that has no brackets, and marks them FUZZY', () => {
    const report = findDuplicates([
      track({ title: 'Morning Light' }),
      track({ title: 'Mornin Light', album: 'Other' }),
      track({ title: 'Evening Song' }),
      track({ title: 'Evening Song feat. Someone', album: 'Other' }),
    ]);
    expect(report.groups).toEqual([]);
    expect(report.candidates).toHaveLength(2);
    expect(report.candidates.every((group) => group.level === 'fuzzy' && group.pairs.length === 1)).toBe(true);
  });

  it('finds an artist spelled a little differently', () => {
    const report = findDuplicates([track({ artist: 'The Beatles', title: 'Come Together' }), track({ artist: 'Beatls', title: 'Come Together' })]);
    expect(report.candidates).toHaveLength(1);
    expect(report.candidates[0]?.members).toHaveLength(2);
  });

  it('does not offer different numbered parts, different versions or different lengths', () => {
    expect(findDuplicates([track({ title: 'Song Part 1' }), track({ title: 'Song Part 2' })]).candidates).toEqual([]);
    expect(findDuplicates([track({ title: 'Morning Light' }), track({ title: 'Mornin Light (Live)' })]).candidates).toEqual([]);
    expect(findDuplicates([track({ title: 'Morning Light', tracklen: 200_000 }), track({ title: 'Mornin Light', tracklen: 300_000 })]).candidates).toEqual([]);
  });

  it('does not duplicate a track that is already in a SURE group', () => {
    const report = findDuplicates([track({ title: 'Morning Light' }), track({ title: 'Morning Light' }), track({ title: 'Morning Light', album: 'x' })]);
    expect(report.candidates).toEqual([]);
  });
});

describe('which copy to keep', () => {
  const winner = (a: Partial<DupTrack>, b: Partial<DupTrack>, lists: PlaylistInfo[] = []) => {
    const first = track(a);
    const second = track(b);
    const group = findDuplicates([first, second], lists).groups[0] as DupGroup;
    return { group, first, second, kept: group.members.find((member) => member.key === group.keep)?.track };
  };

  it('prefers lossless over a higher bitrate lossy copy, and says so', () => {
    const { group, first } = winner({ filetype: 'Apple Lossless audio file', bitrate: 800, size: 30_000_000 }, { bitrate: 320, filetype: 'MPEG audio file' });
    expect(group.reason).toBe('lossless copy');
    expect(group.members[0]?.track).toBe(first);
  });

  it('prefers the higher bitrate, then the larger file', () => {
    expect(winner({ bitrate: 128, size: 3_000_000 }, { bitrate: 256, size: 3_000_000 }).group.reason).toBe('higher bitrate');
    const sameRate = winner({ bitrate: 256, size: 6_000_000 }, { bitrate: 256, size: 9_000_000 });
    expect(sameRate.group.reason).toBe('larger file');
    expect(sameRate.kept).toBe(sameRate.second);
  });

  it('prefers artwork, then plays or a rating, then more playlists', () => {
    expect(winner({ artwork_count: 1 }, {}).group.reason).toBe('has artwork');
    expect(winner({ playcount: 9 }, {}).group.reason).toBe('rated or played more');
    expect(winner({ rating: 100 }, {}).group.reason).toBe('rated or played more');
    const a = track();
    const b = track();
    const group = findDuplicates([a, b], [playlist('One', [b]), playlist('Two', [b])]).groups[0] as DupGroup;
    expect(group.keep).toBe(group.members.find((member) => member.track === b)?.key);
    expect(group.reason).toBe('in more playlists');
  });

  it('does not count the master, podcast or smart playlists', () => {
    const a = track();
    const b = track();
    const lists = [playlist('Master', [a, b], { master: true }), playlist('Podcasts', [b], { podcasts: true }), playlist('Smart', [b], { smart: true })];
    const group = findDuplicates([a, b], lists).groups[0] as DupGroup;
    expect(group.members.every((member) => member.playlists === 0)).toBe(true);
  });

  it('prefers the copy from the album with more tracks on the iPod', () => {
    const lone = track({ album: 'Single' });
    const full = track({ album: 'Full Album' });
    const others = [track({ title: 'Two', album: 'Full Album', tracklen: 100_000 }), track({ title: 'Three', album: 'Full Album', tracklen: 130_000 })];
    const group = findDuplicates([lone, full, ...others]).groups[0] as DupGroup;
    expect(group.keep).toBe(group.members.find((member) => member.track === full)?.key);
    expect(group.reason).toBe('from the fuller album');
  });

  it('breaks a tie by keeping the copy added first', () => {
    const { group, first } = winner({ time_added: 10 }, { time_added: 20 });
    expect(group.reason).toBe('the first copy added');
    expect(group.members[0]?.track).toBe(first);
  });

  it('lists the kept copy first and reports what removing the others frees', () => {
    const { group } = winner({ size: 5_000_000, bitrate: 256 }, { size: 3_000_000, bitrate: 128 });
    expect(group.members[0]?.key).toBe(group.keep);
    expect(group.bytesFreed).toBe(3_000_000);
  });

  it('documents its weights', () => {
    expect(KEEP_WEIGHTS.lossless).toBeGreaterThan(KEEP_WEIGHTS.bitrate);
  });
});

describe('speed', () => {
  it('handles 5,000 tracks, with duplicates and look-alikes, well under a second', () => {
    const library: TrackInfo[] = [];
    for (let at = 0; at < 5000; at += 1) {
      const artist = `Artist ${at % 400}`;
      library.push(track({ title: `Song number ${at}`, artist, album: `Album ${at % 90}`, tracklen: 150_000 + (at % 97) * 1000 }));
    }
    // 100 exact copies and 100 typos.
    for (let at = 0; at < 100; at += 1) library.push({ ...library[at], handle: 90_000 + at, ipod_path: `:iPod_Control:Music:F01:COPY${at}.m4a` } as TrackInfo);
    for (let at = 200; at < 300; at += 1) library.push({ ...library[at], title: `Song numbr ${at}`, handle: 91_000 + at, ipod_path: `:iPod_Control:Music:F02:TYPO${at}.m4a`, album: 'Other' } as TrackInfo);
    const started = performance.now();
    const report = findDuplicates(library);
    const took = performance.now() - started;
    expect(report.groups).toHaveLength(100);
    expect(report.candidates.length).toBeGreaterThanOrEqual(90);
    expect(took).toBeLessThan(1000);
  });
});

describe('ticks and choices', () => {
  const three = () => {
    const a = track({ bitrate: 320 });
    const b = track({ bitrate: 128 });
    const c = track({ bitrate: 192 });
    const group = findDuplicates([a, b, c]).groups[0] as DupGroup;
    return { group, a, b, c };
  };

  it('starts SURE groups ticked except for the recommended copy, and LIKELY groups unticked', () => {
    const report = findDuplicates([track({ title: 'S' }), track({ title: 'S' }), track({ title: 'L', album: 'x' }), track({ title: 'L', album: 'y' })]);
    const choices = defaultChoices(report.groups);
    const [sure, likely] = report.groups as [DupGroup, DupGroup];
    expect(choices.get(sure.id)?.remove.size).toBe(1);
    expect(choices.get(sure.id)?.remove.has(sure.keep)).toBe(false);
    expect(choices.get(likely.id)?.remove.size).toBe(0);
  });

  it('moves the keep choice: the new one is unticked, and if all others were ticked the old one now is', () => {
    const { group } = three();
    const start = defaultChoices([group]).get(group.id) as { keep: string; remove: Set<string> };
    const other = group.members[1]?.key as string;
    const moved = changeKeep(group, start, other);
    expect(moved.keep).toBe(other);
    expect(moved.remove.has(other)).toBe(false);
    expect(moved.remove.has(group.keep)).toBe(true);
    expect(moved.remove.size).toBe(2);
    // From a partly ticked group, the old keep stays unticked.
    const partly = toggleRemove({ keep: group.keep, remove: new Set<string>() }, group.members[2]?.key as string, true);
    expect(changeKeep(group, partly, other).remove.has(group.keep)).toBe(false);
  });

  it('cannot tick the track being kept', () => {
    const { group } = three();
    const choice = { keep: group.keep, remove: new Set<string>() };
    expect(toggleRemove(choice, group.keep, true).remove.size).toBe(0);
  });

  it('select all sure ticks SURE groups only, select none clears everything', () => {
    const report = findDuplicates([track({ title: 'S' }), track({ title: 'S' }), track({ title: 'L', album: 'x' }), track({ title: 'L', album: 'y' })]);
    const none = selectSure(report.groups, defaultChoices(report.groups), false);
    expect(removalKeys(report.groups, none).keys).toEqual([]);
    const sure = selectSure(report.groups, none, true);
    expect(removalKeys(report.groups, sure).keys).toHaveLength(1);
  });

  it('removes only ticked tracks, never one that is kept in another group, and adds up the bytes', () => {
    const { group } = three();
    const everyone = tickGroup(group, { keep: group.keep, remove: new Set() }, true);
    const picked = removalKeys([group], new Map([[group.id, everyone]]));
    expect(picked.keys).toHaveLength(2);
    expect(picked.bytes).toBe(2 * 6_400_000);
    // A track ticked in one group and kept in another is left alone.
    const a = track({ title: 'X' });
    const b = track({ title: 'X' });
    const reportA = findDuplicates([a, b]).groups[0] as DupGroup;
    const second: DupGroup = { ...reportA, id: 99, keep: reportA.members[1]?.key as string };
    const choices = new Map([
      [reportA.id, { keep: reportA.keep, remove: new Set([reportA.members[1]?.key as string]) }],
      [second.id, { keep: second.keep, remove: new Set([reportA.keep]) }],
    ]);
    const result = removalKeys([reportA, second], choices);
    expect(result.keys).toEqual([]);
    expect(result.protectedCount).toBe(2);
  });
});

describe('putting the kept song into the playlists of the removed copies', () => {
  it('adds the kept track to each ordinary playlist that held a removed copy and not the kept one', () => {
    const keep = track({ bitrate: 320, title: 'Song' });
    const gone = track({ bitrate: 128, title: 'Song' });
    const lists = [playlist('Road trip', [gone]), playlist('Gym', [gone, keep]), playlist('Chill', [keep]), playlist('Master', [keep, gone], { master: true })];
    const group = findDuplicates([keep, gone], lists).groups[0] as DupGroup;
    const choices = defaultChoices([group]);
    const result = buildPlaylistSteps([group], choices, lists);
    expect(result.steps).toEqual([{ action: 'add', playlist: 'Road trip', tracks: [group.keep] }]);
    expect(result.lines).toEqual(['Put "Song" into "Road trip".']);
    expect(result.skipped).toEqual([]);
  });

  it('skips smart, podcast, unnamed and ambiguous playlists, and says why', () => {
    const keep = track({ bitrate: 320, title: 'Song' });
    const gone = track({ bitrate: 128, title: 'Song' });
    const lists = [
      playlist('Smart one', [gone], { smart: true }),
      playlist('Podcasts', [gone], { podcasts: true }),
      playlist(null, [gone]),
      playlist('Twin', [gone]),
      playlist('Twin', []),
    ];
    const group = findDuplicates([keep, gone], lists).groups[0] as DupGroup;
    const result = buildPlaylistSteps([group], defaultChoices([group]), lists);
    expect(result.steps).toEqual([]);
    expect(result.skipped).toHaveLength(4);
    expect(result.skipped.join(' ')).toMatch(/smart playlist/);
    expect(result.skipped.join(' ')).toMatch(/podcast playlist/);
    expect(result.skipped.join(' ')).toMatch(/no name/);
    expect(result.skipped.join(' ')).toMatch(/more than one playlist called "Twin"/);
  });

  it('puts several kept songs into one playlist as one step, without repeats', () => {
    const k1 = track({ bitrate: 320, title: 'One' });
    const g1 = track({ bitrate: 128, title: 'One' });
    const k2 = track({ bitrate: 320, title: 'Two' });
    const g2 = track({ bitrate: 128, title: 'Two' });
    const lists = [playlist('Mix', [g1, g2])];
    const report = findDuplicates([k1, g1, k2, g2], lists);
    const result = buildPlaylistSteps(report.groups, defaultChoices(report.groups), lists);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]).toMatchObject({ action: 'add', playlist: 'Mix' });
    expect((result.steps[0] as { tracks: string[] }).tracks).toHaveLength(2);
    expect(result.lines).toEqual(['Put 2 kept songs into "Mix".']);
  });

  it('makes no step for a track that is not going, or when nothing is ticked', () => {
    const keep = track({ bitrate: 320 });
    const gone = track({ bitrate: 128 });
    const lists = [playlist('Road trip', [gone])];
    const group = findDuplicates([keep, gone], lists).groups[0] as DupGroup;
    expect(buildPlaylistSteps([group], new Map([[group.id, { keep: group.keep, remove: new Set() }]]), lists).steps).toEqual([]);
  });
});

describe("applying the AI's verdicts", () => {
  it('changes only ticks: duplicate ticks the others, different-versions and unsure untick', () => {
    const report = findDuplicates([track({ title: 'A', album: 'x' }), track({ title: 'A', album: 'y' }), track({ title: 'B' }), track({ title: 'B' }), track({ title: 'C', album: 'x' }), track({ title: 'C', album: 'y' })]);
    const named = (title: string): DupGroup => report.groups.find((group) => keysOf(group)[0] === title) as DupGroup;
    const [b, a, c] = [named('B'), named('A'), named('C')] as [DupGroup, DupGroup, DupGroup];
    const start = defaultChoices(report.groups);
    const verdicts = new Map([
      [a.id, { group: a.id, verdict: 'duplicate' as const, reason: 'same' }],
      [b.id, { group: b.id, verdict: 'different-versions' as const, reason: 'live' }],
    ]);
    const next = applyVerdicts(report.groups, start, verdicts);
    expect(next.get(a.id)?.remove.size).toBe(1);
    expect(next.get(b.id)?.remove.size).toBe(0);
    expect(next.get(c.id)).toBe(start.get(c.id)); // no verdict: left alone
    // Nothing was removed by it: the keep choice is unchanged without an AI keep.
    expect(next.get(a.id)?.keep).toBe(a.keep);
  });

  it('uses the AI keep only when it is a member of the group', () => {
    const report = findDuplicates([track({ bitrate: 320 }), track({ bitrate: 128 })]);
    const group = report.groups[0] as DupGroup;
    const other = group.members[1]?.key as string;
    const good = applyVerdicts(report.groups, defaultChoices(report.groups), new Map([[group.id, { group: group.id, verdict: 'duplicate' as const, keepKey: other, reason: 'x' }]]));
    expect(good.get(group.id)?.keep).toBe(other);
    expect(good.get(group.id)?.remove.has(group.keep)).toBe(true);
    const bad = applyVerdicts(report.groups, defaultChoices(report.groups), new Map([[group.id, { group: group.id, verdict: 'duplicate' as const, keepKey: 'not a track', reason: 'x' }]]));
    expect(bad.get(group.id)?.keep).toBe(group.keep);
  });
});
