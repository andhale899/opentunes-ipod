import { describe, expect, it } from 'vitest';
import { songKey, type SongRef } from '../src/albumArt';
import { DEFAULT_MAX_LOOKUPS, describeMatch, lookUpCovers, matchRecordings, newLookupCache, rankReleases, recordingQuery, type LookupItem, type RecordingRelease, type SongResult } from '../src/artLookup';

// Every test here uses a fake fetch. Nothing reaches MusicBrainz or the Cover Art Archive.

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const REC = uuid(1);
const REL_ALBUM = uuid(10);
const REL_SINGLE = uuid(11);
const REL_BOOTLEG = uuid(12);
const GROUP = uuid(20);

const release = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  title: 'OK Computer',
  status: 'Official',
  date: '1997-05-21',
  'release-group': { id: GROUP, 'primary-type': 'Album' },
  ...over,
});
const recording = (over: Record<string, unknown> = {}) => ({
  id: REC,
  score: 100,
  title: 'Karma Police',
  length: 261_000,
  'artist-credit': [{ name: 'Radiohead' }],
  releases: [release(REL_ALBUM)],
  ...over,
});

interface Call {
  url: string;
  init: RequestInit | undefined;
}
function fake(answer: (url: string) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return answer(String(input));
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const picture = (url = 'https://dn1.ca.archive.org/0/items/x/front_thumb500.jpg') => {
  const response = new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
  Object.defineProperty(response, 'url', { value: url });
  return response;
};
const instant = async () => {};
const song = (over: Partial<SongRef> = {}): SongRef => ({ title: 'Karma Police', artist: 'Radiohead', lengthMs: 262_000, fromFileName: false, ...over });
const asItems = (...refs: SongRef[]): LookupItem[] => refs.map((ref) => ({ kind: 'song', ref }));
const resultOf = (outcome: { result: unknown } | undefined): SongResult => outcome?.result as SongResult;
const recordings = (...list: unknown[]) => json({ created: 'x', count: list.length, offset: 0, recordings: list });
const musicBrainz = (url: string) => url.startsWith('https://musicbrainz.org/');

describe('the recording search text', () => {
  it('quotes title and artist, escapes Lucene characters, and leaves the artist out when there is none', () => {
    expect(recordingQuery({ title: 'Karma Police', artist: 'Radiohead' })).toBe('recording:"Karma Police" AND artist:"Radiohead"');
    expect(recordingQuery({ title: 'Say "Hi"', artist: 'AC/DC' })).toBe('recording:"Say \\"Hi\\"" AND artist:"AC/DC"');
    expect(recordingQuery({ title: 'Karma Police', artist: '' })).toBe('recording:"Karma Police"');
  });
});

describe('choosing the recording and the release', () => {
  it('keeps recordings with the same title and artist, drops others, and ranks official albums first', () => {
    const answer = { recordings: [recording({ id: uuid(2), title: 'Another Song' }), recording({ id: uuid(3), 'artist-credit': [{ name: 'Someone Else' }] }), recording({ id: uuid(4), score: 50 }), recording()] };
    const { hits } = matchRecordings(answer, song());
    expect(hits.map((hit) => hit.id)).toEqual([REC]);
  });

  it('prefers an official Album, then a Single, then the rest, and the earlier date among equals', () => {
    const base: RecordingRelease = { id: '', title: 'T', artist: 'A', date: '', official: true, type: 'Album', secondary: [], groupId: null };
    const list = rankReleases([
      { ...base, id: 'bootleg-album', official: false },
      { ...base, id: 'live-album', secondary: ['Live'] },
      { ...base, id: 'single', type: 'Single' },
      { ...base, id: 'ep', type: 'EP' },
      { ...base, id: 'album-late', date: '2005' },
      { ...base, id: 'album-early', date: '1997' },
    ]);
    expect(list.map((entry) => entry.id)).toEqual(['album-early', 'album-late', 'single', 'ep', 'live-album', 'bootleg-album']);
  });

  it('rejects a recording whose length is more than three seconds from the file\'s, and keeps one within three', () => {
    expect(matchRecordings({ recordings: [recording({ length: 300_000 })] }, song()).rejectedByLength).toBe(1);
    expect(matchRecordings({ recordings: [recording({ length: 300_000 })] }, song()).hits).toEqual([]);
    expect(matchRecordings({ recordings: [recording({ length: 259_500 })] }, song()).hits).toHaveLength(1);
    expect(matchRecordings({ recordings: [recording({ length: 265_500 })] }, song()).hits).toHaveLength(0);
  });

  it('is good only when artist, title and length all agree; maybe when a length is missing or the name was guessed; low with no artist', () => {
    expect(matchRecordings({ recordings: [recording()] }, song()).hits[0]?.confidence).toBe('good');
    expect(matchRecordings({ recordings: [recording({ length: undefined })] }, song()).hits[0]?.confidence).toBe('maybe');
    expect(matchRecordings({ recordings: [recording()] }, song({ lengthMs: null })).hits[0]?.confidence).toBe('maybe');
    expect(matchRecordings({ recordings: [recording()] }, song({ fromFileName: true })).hits[0]?.confidence).toBe('maybe');
    expect(matchRecordings({ recordings: [recording()] }, song({ artist: '' })).hits[0]?.confidence).toBe('low');
  });
});

describe('an answer shaped like the real one (trimmed from a real recording search, 2026-11-08)', () => {
  // Public MusicBrainz ids and titles. Real answers carry much more (aliases, media, track lists) and some fields
  // are missing on some entries: no length on a recording, no date on a release.
  const real = {
    created: '2026-11-08T04:57:36.373Z',
    count: 281,
    offset: 0,
    recordings: [
      {
        id: '689c761a-e399-470f-9477-910b6de82477', score: 100, title: 'Karma Police', length: 334000, disambiguation: 'live, 2003-08-23: Alpine Valley, East Troy, WI, USA', video: null,
        'artist-credit': [{ name: 'Radiohead', artist: { id: 'a74b1b7f-71a5-4011-9441-d0b5e4122711', name: 'Radiohead' } }],
        releases: [{ id: '6914a223-6362-45f1-9a66-e566767ddd6b', 'status-id': 'x', title: '2003-08-23: Alpine Valley', status: 'Bootleg', 'artist-credit': [{ name: 'Radiohead' }], 'release-group': { id: 'b72db416-31dd-3fcb-adb7-eb9326d27864', 'primary-type': 'Album', 'secondary-types': ['Live'] } }],
      },
      {
        id: '233e0c74-1dd2-4a3a-8ad7-c787bfecd002', score: 100, title: 'Karma Police', length: 274000, video: null,
        'artist-credit': [{ name: 'Radiohead' }],
        releases: [{ id: '31122249-b0cf-4d44-808a-09c277de3f00', title: 'Un-wired & Raw', status: 'Bootleg', 'artist-credit': [{ name: 'Radiohead' }], 'release-group': { id: 'ae075b11-a344-4a6a-8f6a-3d2a5393a7ed', 'primary-type': 'Album', 'secondary-types': ['Compilation'] } }],
      },
      { id: 'bffae6dd-c544-430c-8a4a-10ec30b66a80', score: 100, title: 'Karma Police', disambiguation: 'live, 1998-04-18: Radio City Music Hall', 'artist-credit': [{ name: 'Radiohead' }], releases: [] },
    ],
  };

  it('keeps only the version whose length fits, and reads the release group type and secondary types', () => {
    const studio = matchRecordings(real, song({ lengthMs: 274_500 }));
    expect(studio.hits.map((hit) => hit.id)).toEqual(['233e0c74-1dd2-4a3a-8ad7-c787bfecd002', 'bffae6dd-c544-430c-8a4a-10ec30b66a80']);
    expect(studio.rejectedByLength).toBe(1);
    expect(studio.hits[0]?.releases[0]).toMatchObject({ official: false, type: 'Album', secondary: ['Compilation'], groupId: 'ae075b11-a344-4a6a-8f6a-3d2a5393a7ed', date: '' });
    expect(matchRecordings(real, song({ lengthMs: 334_000 })).hits[0]?.disambiguation).toMatch(/^live/);
  });

  it('with no length for the file, puts a plain recording ahead of ones marked live, and says only "maybe"', () => {
    const { hits } = matchRecordings(real, song({ lengthMs: null }));
    expect(hits.map((hit) => hit.id)).toEqual(['233e0c74-1dd2-4a3a-8ad7-c787bfecd002', '689c761a-e399-470f-9477-910b6de82477', 'bffae6dd-c544-430c-8a4a-10ec30b66a80']);
    expect(hits.every((hit) => hit.confidence === 'maybe')).toBe(true);
  });
});

describe('looking up songs', () => {
  it('searches by title and artist, then asks for the front cover of the best official album, and sends nothing else', async () => {
    const { fetch, calls } = fake((url) => (musicBrainz(url) ? recordings(recording({ releases: [release(REL_BOOTLEG, { status: 'Bootleg' }), release(REL_SINGLE, { 'release-group': { id: uuid(21), 'primary-type': 'Single' } }), release(REL_ALBUM)] })) : picture()));
    const { outcomes, skipped } = await lookUpCovers(asItems(song()), { fetch, wait: instant });
    expect(skipped).toEqual([]);
    const result = resultOf(outcomes[0]);
    expect(result).toMatchObject({ status: 'found', match: { releaseId: REL_ALBUM, releaseTitle: 'OK Computer', year: '1997', recordingTitle: 'Karma Police', recordingArtist: 'Radiohead', confidence: 'good', viaReleaseGroup: false, mime: 'image/png' } });
    expect(describeMatch((result as Extract<SongResult, { status: 'found' }>).match)).toBe('Karma Police by Radiohead, on OK Computer (1997)');
    expect(calls.map((call) => call.url)).toEqual([
      `https://musicbrainz.org/ws/2/recording/?query=${encodeURIComponent('recording:"Karma Police" AND artist:"Radiohead"')}&fmt=json&limit=10`,
      `https://coverartarchive.org/release/${REL_ALBUM}/front-500`,
    ]);
    for (const call of calls) {
      expect(call.init).toMatchObject({ method: 'GET', credentials: 'omit', referrerPolicy: 'origin' });
      expect(call.init?.body).toBeUndefined();
      expect(Object.keys(call.init?.headers ?? {})).toEqual(['Accept']);
    }
    // The file's length is compared here and is not in any request.
    expect(calls.some((call) => call.url.includes('262') || call.url.includes('length') || call.url.includes('dur'))).toBe(false);
  });

  it('rejects the wrong version by length and says why, without asking the Cover Art Archive', async () => {
    const { fetch, calls } = fake(() => recordings(recording({ length: 340_000, title: 'Karma Police' })));
    const { outcomes } = await lookUpCovers(asItems(song()), { fetch, wait: instant });
    expect(resultOf(outcomes[0])).toMatchObject({ status: 'none', reason: expect.stringMatching(/another version/) });
    expect(calls).toHaveLength(1);
  });

  it('uses the version whose length fits when several recordings share the title', async () => {
    const LIVE = uuid(5);
    const { fetch, calls } = fake((url) => (musicBrainz(url) ? recordings(recording({ id: LIVE, length: 330_000, releases: [release(uuid(30), { title: 'Live Album' })] }), recording({ releases: [release(REL_ALBUM)] })) : picture()));
    const { outcomes } = await lookUpCovers(asItems(song()), { fetch, wait: instant });
    expect(resultOf(outcomes[0])).toMatchObject({ status: 'found', match: { releaseId: REL_ALBUM } });
    expect(calls[1]?.url).toBe(`https://coverartarchive.org/release/${REL_ALBUM}/front-500`);
  });

  it('with no artist still searches by title and marks the match low confidence', async () => {
    const { fetch, calls } = fake((url) => (musicBrainz(url) ? recordings(recording()) : picture()));
    const { outcomes } = await lookUpCovers(asItems(song({ artist: '' })), { fetch, wait: instant });
    expect(calls[0]?.url).toBe(`https://musicbrainz.org/ws/2/recording/?query=${encodeURIComponent('recording:"Karma Police"')}&fmt=json&limit=10`);
    expect(resultOf(outcomes[0])).toMatchObject({ status: 'found', match: { confidence: 'low' } });
  });

  it('marks a match found from a guessed file name as at best maybe', async () => {
    const { fetch } = fake((url) => (musicBrainz(url) ? recordings(recording()) : picture()));
    const { outcomes } = await lookUpCovers(asItems(song({ fromFileName: true })), { fetch, wait: instant });
    expect(resultOf(outcomes[0])).toMatchObject({ status: 'found', match: { confidence: 'maybe' } });
  });

  it('reports nothing found when MusicBrainz has no such recording, or the song is on no release', async () => {
    let { fetch } = fake(() => recordings());
    expect(resultOf((await lookUpCovers(asItems(song()), { fetch, wait: instant })).outcomes[0])).toMatchObject({ status: 'none', reason: expect.stringMatching(/no recording with that title/) });
    ({ fetch } = fake(() => recordings(recording({ releases: [] }))));
    expect(resultOf((await lookUpCovers(asItems(song()), { fetch, wait: instant })).outcomes[0])).toMatchObject({ status: 'none', reason: expect.stringMatching(/on no release/) });
  });

  it('tries up to three releases, then the release group\'s cover, then gives up', async () => {
    const releases = [uuid(40), uuid(41), uuid(42), uuid(43)].map((id) => release(id));
    const { fetch, calls } = fake((url) => (musicBrainz(url) ? recordings(recording({ releases })) : new Response('', { status: 404 })));
    const { outcomes } = await lookUpCovers(asItems(song()), { fetch, wait: instant });
    expect(resultOf(outcomes[0])).toMatchObject({ status: 'none' });
    expect(calls.filter((call) => call.url.includes('coverartarchive')).map((call) => call.url)).toEqual([uuid(40), uuid(41), uuid(42)].map((id) => `https://coverartarchive.org/release/${id}/front-500`).concat(`https://coverartarchive.org/release-group/${GROUP}/front-500`));
  });

  it('falls back to the release group\'s front cover when the releases have none', async () => {
    const { fetch } = fake((url) => (musicBrainz(url) ? recordings(recording()) : url.includes('/release-group/') ? picture() : new Response('', { status: 404 })));
    const { outcomes } = await lookUpCovers(asItems(song()), { fetch, wait: instant });
    expect(resultOf(outcomes[0])).toMatchObject({ status: 'found', match: { releaseId: REL_ALBUM, viaReleaseGroup: true } });
  });

  it('keeps MusicBrainz requests more than a second apart, across albums and songs (a real wait on the real clock)', async () => {
    const stamps: number[] = [];
    const { fetch } = fake((url) => {
      if (musicBrainz(url)) stamps.push(Date.now());
      return recordings();
    });
    await lookUpCovers([...asItems(song()), { kind: 'album', ref: { artist: 'B', album: 'C' } }, ...asItems(song({ title: 'Another' }))], { fetch, wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) });
    expect(stamps).toHaveLength(3);
    expect((stamps[1] as number) - (stamps[0] as number)).toBeGreaterThanOrEqual(1090);
    expect((stamps[2] as number) - (stamps[1] as number)).toBeGreaterThanOrEqual(1090);
  }, 10_000);

  it('keeps the gap between one run and the next through the cache', async () => {
    const stamps: number[] = [];
    const { fetch } = fake((url) => {
      if (musicBrainz(url)) stamps.push(Date.now());
      return recordings();
    });
    const cache = newLookupCache();
    const real = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    await lookUpCovers(asItems(song()), { fetch, wait: real, cache, maxLookups: 1 });
    await lookUpCovers(asItems(song({ title: 'Second' })), { fetch, wait: real, cache, maxLookups: 1 });
    expect((stamps[1] as number) - (stamps[0] as number)).toBeGreaterThanOrEqual(1090);
  }, 10_000);

  it('waits and tries once more after a 503, then leaves that song for later', async () => {
    const waits: number[] = [];
    const { fetch, calls } = fake(() => new Response('', { status: 503 }));
    const { outcomes } = await lookUpCovers(asItems(song()), { fetch, wait: async (ms) => void waits.push(ms) });
    expect(resultOf(outcomes[0])).toMatchObject({ status: 'error', reason: expect.stringMatching(/slow down/) });
    expect(calls).toHaveLength(2);
    expect(waits).toContain(3000);
  });

  it('does not keep a failure, so it is tried again next time', async () => {
    let fail = true;
    const { fetch, calls } = fake((url) => (fail ? new Response('', { status: 500 }) : musicBrainz(url) ? recordings(recording()) : picture()));
    const cache = newLookupCache();
    expect(resultOf((await lookUpCovers(asItems(song()), { fetch, wait: instant, cache })).outcomes[0]).status).toBe('error');
    fail = false;
    expect(resultOf((await lookUpCovers(asItems(song()), { fetch, wait: instant, cache })).outcomes[0]).status).toBe('found');
    expect(calls.length).toBeGreaterThan(1);
  });
});

describe('the cap and the cache', () => {
  const four = asItems(song({ title: 'One' }), song({ title: 'Two' }), song({ title: 'Three' }), song({ title: 'Four' }));
  const answers = (url: string) => (musicBrainz(url) ? recordings(...[1, 2, 3, 4].map((n) => recording({ title: ['One', 'Two', 'Three', 'Four'][n - 1], releases: [release(uuid(50 + n))] }))) : picture());

  it('looks up no more than the cap in one run and hands back the rest', async () => {
    expect(DEFAULT_MAX_LOOKUPS).toBe(25);
    const { fetch, calls } = fake(answers);
    const { outcomes, skipped } = await lookUpCovers(four, { fetch, wait: instant, maxLookups: 2 });
    expect(outcomes).toHaveLength(2);
    expect(skipped).toEqual(four.slice(2));
    expect(calls.filter((call) => musicBrainz(call.url))).toHaveLength(2);
  });

  it('continues where it stopped on the next run, without asking again for what is already known', async () => {
    const { fetch, calls } = fake(answers);
    const cache = newLookupCache();
    await lookUpCovers(four, { fetch, wait: instant, maxLookups: 2, cache });
    const before = calls.length;
    const { outcomes, skipped } = await lookUpCovers(four, { fetch, wait: instant, maxLookups: 2, cache });
    expect(skipped).toEqual([]);
    expect(outcomes).toHaveLength(4);
    expect(calls.slice(before).filter((call) => musicBrainz(call.url))).toHaveLength(2);
    // A third run asks for nothing.
    const again = calls.length;
    await lookUpCovers(four, { fetch, wait: instant, maxLookups: 2, cache });
    expect(calls.length).toBe(again);
  });

  it('shares the cover between songs that match the same release, and looks a song that appears twice up once', async () => {
    const { fetch, calls } = fake((url) => (musicBrainz(url) ? recordings(recording({ title: url.includes('Two') ? 'Two' : 'One', releases: [release(REL_ALBUM)] })) : picture()));
    const { outcomes } = await lookUpCovers(asItems(song({ title: 'One' }), song({ title: 'Two' }), song({ title: 'One' })), { fetch, wait: instant });
    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((outcome) => resultOf(outcome).status === 'found')).toBe(true);
    expect(calls.filter((call) => call.url.includes('coverartarchive'))).toHaveLength(1);
    expect(calls.filter((call) => musicBrainz(call.url))).toHaveLength(2);
  });

  it('treats two files of the same song with nearly the same length (the same three-second step) as one', () => {
    expect(songKey(song({ lengthMs: 262_000 }))).toBe(songKey(song({ lengthMs: 262_300 })));
    expect(songKey(song({ lengthMs: 262_000 }))).not.toBe(songKey(song({ lengthMs: 330_000 })));
  });

  it('counts only fresh lookups against the cap, so answers from the cache cost nothing', async () => {
    const { fetch } = fake(answers);
    const cache = newLookupCache();
    await lookUpCovers(four.slice(0, 2), { fetch, wait: instant, cache });
    const { outcomes, skipped } = await lookUpCovers(four, { fetch, wait: instant, cache, maxLookups: 2 });
    expect(outcomes).toHaveLength(4);
    expect(skipped).toEqual([]);
  });
});
