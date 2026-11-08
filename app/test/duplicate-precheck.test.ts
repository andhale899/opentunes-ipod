import { describe, expect, it } from 'vitest';
import { devices } from '@opentunes/core';
import { checkDuplicates, type DuplicateFound, type TrackInfo } from '@opentunes/engine';
import { inspectFile, mergeConvertedTags, prepareItem, redecide, type Candidate } from '../src/addFiles';
import { countsOf, duplicateInputOf, missedDuplicates, precheck, summaryOf } from '../src/duplicatePrecheck';

const nano = devices.find((device) => device.id === 'nano-7g') as (typeof devices)[number];

/** A short silent 16-bit 44.1 kHz stereo WAV, which the iPod plays as it is and which has no tags. */
function wav(name: string): File {
  const data = new Uint8Array(400);
  const bytes = new Uint8Array(44 + data.length);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + data.length, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, 44100, true);
  view.setUint32(28, 176400, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, data.length, true);
  bytes.set(data, 44);
  return new File([bytes], name);
}

/** A file read the way the page reads it. `folders` fills artist, album and kind from the folder names. */
const read = (name: string, folders?: string[]) => inspectFile(wav(name), nano, undefined, '', folders);

/** A track as the page holds it after reading the iPod. Only what the check looks at is filled. */
const track = (fields: { title: string; artist?: string; album?: string; kind?: string; tracklen?: number }): TrackInfo =>
  ({ kind: 'music', artist: '', album: '', tracklen: 0, ipod_path: `:iPod_Control:Music:F00:${fields.title}.wav`, ...fields }) as unknown as TrackInfo;

const none = { allowAll: false, allowIds: new Set<string>() };

describe('marking rows before anything is converted', () => {
  it('marks a file already on the iPod, names the track, and leaves it out', async () => {
    const candidate = await read('Morning Light.wav', ['Music', 'The Demo Band', 'Samples']);
    const rows = precheck([candidate], [track({ title: 'Morning Light', artist: 'The Demo Band', album: 'Samples' })], none);
    const row = rows.get(candidate.id)!;
    expect(row.state).toBe('on-ipod');
    expect(row.skipped).toBe(true);
    expect(row.label).toBe('Skipped: already on the iPod');
    expect(row.text).toContain('"Morning Light" by The Demo Band');
    expect(row.text).toContain('will not be converted or copied');
  });

  it('marks a file that repeats one above it, by its file name', async () => {
    const first = await read('Same Song.wav');
    const second = await read('Same Song.wav');
    const rows = precheck([first, second], [], none);
    expect(rows.get(first.id)!.state).toBe('new');
    expect(rows.get(second.id)).toMatchObject({ state: 'in-list', skipped: true, otherId: first.id });
    expect(rows.get(second.id)!.text).toContain('"Same Song.wav" above in this list');
  });

  it('lets everything through, and says so, when the box is ticked', async () => {
    const candidate = await read('Morning Light.wav');
    const rows = precheck([candidate], [track({ title: 'Morning Light' })], { allowAll: true, allowIds: new Set() });
    const row = rows.get(candidate.id)!;
    expect(row).toMatchObject({ state: 'on-ipod', skipped: false, addedAnyway: true });
    expect(row.label).toBe('Already on the iPod, added anyway');
    expect(row.text).toContain('because the box below is ticked');
  });

  it('adds one row anyway without ticking the box for the others', async () => {
    const a = await read('Morning Light.wav');
    const b = await read('Night Drive.wav');
    const library = [track({ title: 'Morning Light' }), track({ title: 'Night Drive' })];
    const rows = precheck([a, b], library, { allowAll: false, allowIds: new Set([b.id]) });
    expect(rows.get(a.id)!.skipped).toBe(true);
    expect(rows.get(b.id)).toMatchObject({ skipped: false, addedAnyway: true });
    expect(rows.get(b.id)!.text).toContain('because you chose to');
  });

  it('does not guess for a file with no title: says it could not tell and lets it through', async () => {
    // A file name with no letters or digits gives no title to compare.
    const candidate = await read('!!!.wav');
    const rows = precheck([candidate], [track({ title: '' }), track({ title: 'Anything' })], none);
    const row = rows.get(candidate.id)!;
    expect(row.state).toBe('cannot-tell');
    expect(row.skipped).toBe(false);
    expect(row.label).toBe('Could not tell if this is already on the iPod (no title)');
  });

  it('follows the library: the same list is judged again when the iPod gains or loses the track', async () => {
    const candidate = await read('Morning Light.wav');
    expect(precheck([candidate], [], none).get(candidate.id)!.skipped).toBe(false);
    expect(precheck([candidate], [track({ title: 'Morning Light' })], none).get(candidate.id)!.skipped).toBe(true);
  });

  it('follows the kind: the same title as a podcast episode is not the music already there', async () => {
    const candidate = await read('Morning Light.wav');
    const asPodcast = redecide(candidate, nano, 'podcast');
    const library = [track({ title: 'Morning Light' })];
    expect(precheck([candidate], library, none).get(candidate.id)!.skipped).toBe(true);
    expect(precheck([asPodcast], library, none).get(candidate.id)!.skipped).toBe(false);
  });

  it('counts what will be converted, copied and skipped, and writes it in plain words', async () => {
    // Twelve files that need converting (24-bit audio), three of them already on the iPod.
    const candidates: Candidate[] = [];
    for (let index = 0; index < 12; index += 1) {
      const candidate = await read(`Song ${index}.wav`);
      candidates.push({ ...candidate, decision: { ...candidate.decision, action: 'convert' }, estimatedBytes: 1000 });
    }
    const library = [track({ title: 'Song 0' }), track({ title: 'Song 1' }), track({ title: 'Song 2' })];
    const rows = precheck(candidates, library, none);
    const counts = countsOf(candidates, rows);
    expect(counts).toEqual({ convert: 9, copy: 0, skipped: 3, addedAnyway: 0 });
    expect(summaryOf(counts)).toBe('9 files will be converted, 3 skipped as duplicates');
    expect(summaryOf({ convert: 1, copy: 2, skipped: 1, addedAnyway: 0 })).toBe('1 file will be converted, 2 copied as they are, 1 skipped as a duplicate');
  });

  it('does not count files the iPod cannot take', async () => {
    const candidate = await read('Song.wav');
    const unsupported: Candidate = { ...candidate, decision: { ...candidate.decision, action: 'unsupported', outputExtension: '' } };
    const rows = precheck([unsupported], [], none);
    expect(rows.get(unsupported.id)).toMatchObject({ state: 'not-added', skipped: false, label: '' });
    expect(countsOf([unsupported], rows)).toEqual({ convert: 0, copy: 0, skipped: 0, addedAnyway: 0 });
  });
});

describe('agreeing with planSync', () => {
  it('gives a copied file the same verdict as the item prepareItem makes from it', async () => {
    const candidate = await read('Morning Light.wav', ['Music', 'The Demo Band', 'Samples']);
    const library = [track({ title: 'Morning Light', artist: 'The Demo Band', album: 'Samples' })];
    const item = (await prepareItem(candidate))!;
    const before = checkDuplicates([duplicateInputOf(candidate)], library)[0]!;
    const after = checkDuplicates([item], library)[0]!;
    expect(before.verdict.status).toBe('on-ipod');
    expect(after.verdict.status).toBe(before.verdict.status);
    expect(after.skipped).toBe(before.skipped);
  });

  it('lists a duplicate the plan found that the first check let through, and nothing else', () => {
    const rows = new Map([
      ['a', { state: 'new', skipped: false, addedAnyway: false, text: '', label: '' }],
      ['b', { state: 'on-ipod', skipped: false, addedAnyway: true, text: 'x', label: 'x' }],
    ] as const);
    const found: DuplicateFound[] = [
      { itemId: 'a', trackKey: 'k', otherItemId: null, skipped: true },
      { itemId: 'b', trackKey: 'k2', otherItemId: null, skipped: false },
    ];
    expect(missedDuplicates(new Map(rows), found)).toEqual([{ itemId: 'a', trackKey: 'k', skipped: true }]);
    expect(missedDuplicates(new Map(rows), [])).toEqual([]);
  });

  it('plans with the same answer: a skipped file never reaches planSync, and what does reach it has no duplicates', async () => {
    const dup = await read('Morning Light.wav');
    const fresh = await read('Brand New.wav');
    const library = [track({ title: 'Morning Light' })];
    const rows = precheck([dup, fresh], library, none);
    const toPrepare = [dup, fresh].filter((candidate) => !rows.get(candidate.id)!.skipped);
    expect(toPrepare.map((candidate) => candidate.file.name)).toEqual(['Brand New.wav']);
    // planSync itself is run against these rules in engine/test/duplicates-precheck.test.mjs. Here: the prepared items are all new.
    const items = await Promise.all(toPrepare.map(async (candidate) => (await prepareItem(candidate))!));
    expect(checkDuplicates(items, library).every((result) => !result.skipped && result.verdict.status === 'new')).toBe(true);
  });
});

describe('the tags a converted file keeps', () => {
  it('takes the tags that say which song it is from the original only', () => {
    const merged = mergeConvertedTags({ title: 'Original', artist: 'Band' }, { title: 'Changed', artist: 'Other', album: 'Invented', genre: 'Rock', year: 2001 });
    expect(merged).toMatchObject({ title: 'Original', artist: 'Band', genre: 'Rock', year: 2001 });
    expect(merged.album).toBeUndefined();
  });

  it('fills a field the converter could not carry, and lets the original win elsewhere', () => {
    const merged = mergeConvertedTags({ title: 'T', genre: 'Jazz', comment: 'kept' }, { title: 'T', genre: 'Rock' });
    expect(merged).toEqual({ title: 'T', genre: 'Jazz', comment: 'kept' });
  });
});
