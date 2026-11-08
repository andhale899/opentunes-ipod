import { describe, expect, it } from 'vitest';
import { lookUpAlbumArt, matchReleases, normaliseTitle, releaseQuery, isStopped } from '../src/artLookup';

// Every test here uses a fake fetch. Nothing reaches MusicBrainz or the Cover Art Archive.

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const RELEASE = '1834eae1-741b-3c03-9ca5-0df3decb43ea';
const OTHER = '175d6ac9-7185-357c-af04-5887dc3ea788';

const hit = (id: string, over: Record<string, unknown> = {}) => ({ id, title: 'OK Computer', score: 100, status: 'Official', date: '1997-05-21', 'artist-credit': [{ name: 'Radiohead' }], ...over });

interface Call { url: string; init: RequestInit | undefined }

/** A fake fetch that answers from a function of the address, and records every call. */
function fake(answer: (url: string) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return answer(String(input));
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const picture = (url: string, bytes = PNG) => {
  const response = new Response(bytes, { status: 200, headers: { 'content-type': 'image/png' } });
  Object.defineProperty(response, 'url', { value: url });
  return response;
};
const instant = async () => {};

describe('the search text', () => {
  it('quotes both names and escapes the characters Lucene treats as special', () => {
    expect(releaseQuery({ artist: 'Radiohead', album: 'OK Computer' })).toBe('release:"OK Computer" AND artist:"Radiohead"');
    expect(releaseQuery({ artist: 'AC/DC', album: 'Say "Hello" \\ Bye' })).toBe('release:"Say \\"Hello\\" \\\\ Bye" AND artist:"AC/DC"');
  });

  it('compares titles without case, accents, punctuation or spacing', () => {
    expect(normaliseTitle('  Sigur  Rós – ( )  ')).toBe('sigur ros');
    expect(normaliseTitle('Simon & Garfunkel')).toBe(normaliseTitle('simon and garfunkel'));
  });
});

describe('choosing the release', () => {
  const ref = { artist: 'Radiohead', album: 'OK Computer' };
  it('keeps releases of the same title and artist with a high score, official first', () => {
    const answer = { releases: [hit(OTHER, { status: 'Bootleg' }), hit(RELEASE), hit('f0f0f0f0-0000-4000-8000-000000000000', { title: 'OK Computer OKNOTOK', score: 100 }), hit('e0e0e0e0-0000-4000-8000-000000000000', { score: 60 })] };
    expect(matchReleases(answer, ref).map((entry) => entry.id)).toEqual([RELEASE, OTHER]);
  });
  it('wants the artist to match too, and ignores anything that is not an id', () => {
    expect(matchReleases({ releases: [hit(RELEASE, { 'artist-credit': [{ name: 'Someone Else' }] })] }, ref)).toEqual([]);
    expect(matchReleases({ releases: [hit('not-an-id')] }, ref)).toEqual([]);
    expect(matchReleases({ nothing: true }, ref)).toEqual([]);
    expect(matchReleases(null, ref)).toEqual([]);
  });
});

describe('looking up albums', () => {
  const ref = { artist: 'Radiohead', album: 'OK Computer' };

  it('asks MusicBrainz for the names, then the Cover Art Archive for the release, and sends nothing else', async () => {
    const { fetch, calls } = fake((url) => (url.startsWith('https://musicbrainz.org/') ? json({ releases: [hit(RELEASE)] }) : picture(`https://dn1.ca.archive.org/0/items/mbid-${RELEASE}/x_thumb500.jpg`)));
    const [result] = await lookUpAlbumArt([ref], { fetch, wait: instant });
    expect(result).toMatchObject({ status: 'found', cover: { releaseId: RELEASE, releaseTitle: 'OK Computer', releaseArtist: 'Radiohead', mime: 'image/png' } });
    expect(calls.map((call) => call.url)).toEqual([
      `https://musicbrainz.org/ws/2/release/?query=${encodeURIComponent('release:"OK Computer" AND artist:"Radiohead"')}&fmt=json&limit=10`,
      `https://coverartarchive.org/release/${RELEASE}/front-500`,
    ]);
    for (const call of calls) {
      expect(call.init).toMatchObject({ method: 'GET', credentials: 'omit', referrerPolicy: 'origin' });
      expect(call.init?.body).toBeUndefined();
      expect(Object.keys(call.init?.headers ?? {})).toEqual(['Accept']);
    }
  });

  it('keeps MusicBrainz requests more than a second apart (a real wait on the real clock)', async () => {
    const stamps: number[] = [];
    const { fetch } = fake((url) => {
      if (url.startsWith('https://musicbrainz.org/')) stamps.push(Date.now());
      return json({ releases: [] });
    });
    await lookUpAlbumArt([ref, { artist: 'B', album: 'C' }], { fetch, wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) });
    expect(stamps).toHaveLength(2);
    expect((stamps[1] as number) - (stamps[0] as number)).toBeGreaterThanOrEqual(1090);
  }, 10_000);

  it('tries the next release when one has no cover, up to three, and reports none when none has', async () => {
    const ids = [RELEASE, OTHER, 'a1a1a1a1-0000-4000-8000-000000000000', 'b2b2b2b2-0000-4000-8000-000000000000'];
    const { fetch, calls } = fake((url) => (url.startsWith('https://musicbrainz.org/') ? json({ releases: ids.map((id) => hit(id)) }) : new Response('', { status: 404 })));
    const [result] = await lookUpAlbumArt([ref], { fetch, wait: instant });
    expect(result).toMatchObject({ status: 'none', reason: expect.stringMatching(/no front cover/) });
    expect(calls.filter((call) => call.url.includes('coverartarchive')).map((call) => call.url)).toEqual(ids.slice(0, 3).map((id) => `https://coverartarchive.org/release/${id}/front-500`));
  });

  it('says so when MusicBrainz has no such release, and does not call the Cover Art Archive', async () => {
    const { fetch, calls } = fake(() => json({ releases: [hit(RELEASE, { title: 'Another Album' })] }));
    const [result] = await lookUpAlbumArt([ref], { fetch, wait: instant });
    expect(result).toMatchObject({ status: 'none', reason: expect.stringMatching(/no release with that artist and album/) });
    expect(calls).toHaveLength(1);
  });

  it('waits and tries once more after a 503, then gives up on that album and carries on with the next', async () => {
    let tries = 0;
    const waits: number[] = [];
    const { fetch } = fake((url) => {
      if (!url.startsWith('https://musicbrainz.org/')) return picture('https://x.archive.org/a.png');
      tries += 1;
      if (url.includes(encodeURIComponent('"Slow"'))) return new Response('', { status: 503 });
      return json({ releases: [hit(RELEASE, { title: 'Fine' })] });
    });
    const results = await lookUpAlbumArt([{ artist: 'Radiohead', album: 'Slow' }, { artist: 'Radiohead', album: 'Fine' }], { fetch, wait: async (ms) => void waits.push(ms) });
    expect(results.map((result) => result.status)).toEqual(['error', 'found']);
    expect(results[0]).toMatchObject({ reason: expect.stringMatching(/slow down/) });
    expect(tries).toBe(3);
    expect(waits).toContain(3000);
  });

  it('reports a service that cannot be reached as that album\'s result and carries on', async () => {
    const { fetch } = fake((url) => {
      if (url.includes(encodeURIComponent('"Down"'))) throw new TypeError('Failed to fetch');
      return json({ releases: [] });
    });
    const results = await lookUpAlbumArt([{ artist: 'A', album: 'Down' }, { artist: 'A', album: 'Up' }], { fetch, wait: instant });
    expect(results.map((result) => result.status)).toEqual(['error', 'none']);
    expect(results[0]).toMatchObject({ reason: expect.stringMatching(/could not reach the service/) });
  });

  it('refuses a picture that is not a JPEG or PNG, one served from another host, and one that is too big', async () => {
    const answer = (url: string, make: () => Response) => (url.startsWith('https://musicbrainz.org/') ? json({ releases: [hit(RELEASE)] }) : make());
    let { fetch } = fake((url) => answer(url, () => picture('https://x.archive.org/a.png', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]))));
    expect((await lookUpAlbumArt([ref], { fetch, wait: instant }))[0]?.status).toBe('none');
    ({ fetch } = fake((url) => answer(url, () => picture('https://evil.example/a.png'))));
    expect((await lookUpAlbumArt([ref], { fetch, wait: instant }))[0]?.status).toBe('none');
    ({ fetch } = fake((url) => answer(url, () => new Response(PNG, { status: 200, headers: { 'content-length': String(6 * 1024 * 1024) } }))));
    expect((await lookUpAlbumArt([ref], { fetch, wait: instant }))[0]?.status).toBe('none');
  });

  it('stops when asked, and reports progress', async () => {
    const controller = new AbortController();
    const progress: string[] = [];
    const { fetch } = fake(() => json({ releases: [] }));
    const albums = [ref, { artist: 'B', album: 'C' }, { artist: 'D', album: 'E' }];
    const run = lookUpAlbumArt(albums, {
      fetch,
      wait: instant,
      signal: controller.signal,
      onProgress: (done, total, current) => {
        progress.push(`${done}/${total} ${current.artist}`);
        if (done === 1) controller.abort();
      },
    });
    await expect(run).rejects.toSatisfy(isStopped);
    expect(progress).toEqual(['0/3 Radiohead', '1/3 B']);
  });
});
