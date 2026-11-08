// The duplicate check that runs before anything is converted, against planSync.
//
// Both call the same judge in sync.ts. These tests make that a fact rather than a promise: every
// case is run through checkDuplicates (what the Add music list shows before converting) and through
// planSync on a real engine and an in-memory iPod, and the two must give the same verdict for every
// item. The demo iPod holds Morning Light and Night Drive by The Demo Band on Samples (214 and 187
// seconds), the podcast episode "Episode 12: Engines" by Demo Cast, and the audiobook "A Short Story"
// by An Author.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkDuplicates, createDuplicateJudge, itemProblem, planSync, trackKey } from '../js/index.ts';
import { makeItem, newEngine, signedIpod } from './sync-helpers.mjs';

const song = (title, overrides = {}) =>
  makeItem('music', { tags: { title, artist: 'The Demo Band', album: 'Samples' }, durationMs: 214_000, ...overrides });

/** What planSync said about each item, in the shape checkDuplicates uses. */
function planned(plan, items) {
  return items.map((item) => {
    const found = plan.duplicates.find((entry) => entry.itemId === item.id);
    if (!found) return { id: item.id, status: 'none', skipped: false };
    return found.trackKey ? { id: item.id, status: 'on-ipod', key: found.trackKey, skipped: found.skipped } : { id: item.id, status: 'in-batch', other: found.otherItemId, skipped: found.skipped };
  });
}

function checked(results) {
  return results.map(({ itemId, verdict, skipped }) => {
    if (verdict.status === 'on-ipod') return { id: itemId, status: 'on-ipod', key: verdict.trackKey, skipped };
    if (verdict.status === 'in-batch') return { id: itemId, status: 'in-batch', other: verdict.otherItemId, skipped };
    return { id: itemId, status: 'none', skipped };
  });
}

const CASES = [
  {
    name: 'same tags and length as a track on the iPod',
    items: () => [song('Morning Light')],
    expect: ['on-ipod'],
  },
  {
    name: 'same title and artist but a different album',
    items: () => [song('Morning Light', { tags: { title: 'Morning Light', artist: 'The Demo Band', album: 'Greatest Hits' } })],
    expect: ['none'],
  },
  {
    name: 'a live version is not the studio track',
    items: () => [song('Morning Light (Live)')],
    expect: ['none'],
  },
  {
    name: 'case, accents, punctuation and spacing do not matter',
    items: () => [song('  mórning   LIGHT! ', { tags: { title: '  mórning   LIGHT! ', artist: 'the demo band', album: 'SAMPLES' } })],
    expect: ['on-ipod'],
  },
  {
    name: 'length within 2 seconds still matches, beyond it does not',
    items: () => [song('Morning Light', { durationMs: 215_900 }), song('Night Drive', { durationMs: 190_000 })],
    expect: ['on-ipod', 'none'],
  },
  {
    name: 'a length the file does not give matches on the tags alone',
    items: () => [song('Morning Light', { durationMs: null })],
    expect: ['on-ipod'],
  },
  {
    name: 'a file with no title tag is compared by its file name, as the plan does',
    items: () => [song('x', { tags: { title: undefined, artist: 'The Demo Band', album: 'Samples' } })].map((item) => ({ ...item, name: 'Morning Light.mp3' })),
    expect: ['on-ipod'],
  },
  {
    name: 'a file with no title and a name with no letters or digits cannot be judged and goes through',
    items: () => [{ ...song('x', { tags: { title: undefined } }), name: '!!!.mp3' }],
    expect: ['none'],
    cannotTell: [0],
  },
  {
    name: 'missing artist and album on both sides still compare on the title',
    items: () => [makeItem('music', { tags: { title: 'Morning Light', artist: undefined, album: undefined }, durationMs: 214_000 })],
    expect: ['none'],
  },
  {
    name: 'the same podcast episode, and the same title as music is another kind',
    items: () => [
      makeItem('podcast', { tags: { title: 'Episode 12: Engines', artist: 'Demo Cast', album: 'Demo Cast' }, durationMs: 1_980_000 }),
      makeItem('podcast', { tags: { title: 'Morning Light', artist: 'The Demo Band', album: 'Samples' }, durationMs: 214_000 }),
    ],
    expect: ['on-ipod', 'none'],
  },
  {
    name: 'a new episode of the same podcast is not a duplicate',
    items: () => [makeItem('podcast', { tags: { title: 'Episode 13: Wheels', artist: 'Demo Cast', album: 'Demo Cast' }, durationMs: 1_980_000 })],
    expect: ['none'],
  },
  {
    name: 'an audiobook already on the iPod, a chapter file with its own title, and the same chapter file twice',
    items: () => [
      makeItem('audiobook', { tags: { title: 'A Short Story', artist: 'An Author', album: 'A Short Story' }, durationMs: 5_400_000 }),
      makeItem('audiobook', { tags: { title: 'Chapter 1', artist: 'An Author', album: 'Another Book' }, durationMs: 600_000, chapters: [{ startMs: 0, title: 'Opening' }] }),
      makeItem('audiobook', { tags: { title: 'Chapter 1', artist: 'An Author', album: 'Another Book' }, durationMs: 600_000, chapters: [{ startMs: 0, title: 'Opening' }] }),
    ],
    expect: ['on-ipod', 'none', 'in-batch'],
  },
  {
    name: 'two files in the batch that are the same song',
    items: () => [song('Brand New'), song('Brand New')],
    expect: ['none', 'in-batch'],
  },
  {
    name: 'three files in the batch, the third matches the first (not the second)',
    items: () => [song('One'), song('Two'), song('One')],
    expect: ['none', 'none', 'in-batch'],
  },
  {
    name: 'a file that matches the iPod is reported against the iPod even when an earlier file matches it too',
    items: () => [song('Morning Light'), song('Morning Light')],
    expect: ['on-ipod', 'on-ipod'],
  },
  {
    name: 'a file the iPod cannot take is left out and is not what later files are compared with',
    items: () => [song('Brand New', { extension: '.flac' }), song('Brand New')],
    expect: ['none', 'none'],
    problems: [0],
  },
  {
    name: 'a TV episode is told apart by show, season and episode',
    items: () => [
      makeItem('tv-show', { tags: { title: 'Pilot', show: 'The Show', season: 1, episode: 1 }, durationMs: 1_300_000 }),
      makeItem('tv-show', { tags: { title: 'Pilot', show: 'The Show', season: 1, episode: 2 }, durationMs: 1_300_000 }),
      makeItem('tv-show', { tags: { title: 'Pilot', show: 'The Show', season: 1, episode: 1 }, durationMs: 1_300_000 }),
    ],
    expect: ['none', 'none', 'in-batch'],
  },
  {
    name: 'allowing duplicates adds them and still names them',
    items: () => [song('Morning Light'), song('Brand New'), song('Brand New')],
    options: { allow: true },
    expect: ['on-ipod', 'none', 'in-batch'],
  },
  {
    name: 'one row added anyway keeps the others skipped, and later rows are compared with it',
    items: () => [song('Morning Light'), song('Night Drive', { durationMs: 187_000 }), song('Brand New'), song('Brand New')],
    options: { allowIdsAt: [1, 3] },
    expect: ['on-ipod', 'on-ipod', 'none', 'in-batch'],
  },
];

describe('the check before converting gives the same verdict as planSync', () => {
  for (const testCase of CASES) {
    it(testCase.name, async () => {
      const ipod = await signedIpod();
      const items = testCase.items();
      const allowIds = (testCase.options?.allowIdsAt ?? []).map((index) => items[index].id);
      const options = { allow: testCase.options?.allow ?? false, allowIds };

      const plan = await planSync(ipod, newEngine, items, { duplicates: options.allow ? 'allow' : 'skip', allowDuplicateIds: allowIds });
      const before = checkDuplicates(items, plan.tracksBefore, options);

      assert.deepEqual(checked(before).map((entry) => entry.status), testCase.expect, 'the check says what the case expects');
      // The plan reports a left-out item as skipped for its own reason too; compare duplicates only.
      const duplicatesOnly = before.map((entry, index) => ({ ...checked([entry])[0], index })).filter((entry) => !before[entry.index].problem);
      const fromPlan = planned(plan, items).filter((_, index) => !before[index].problem);
      assert.deepEqual(duplicatesOnly.map(({ index: _index, ...rest }) => rest), fromPlan, 'the check and the plan agree on every item');

      // The items the check keeps are exactly the files the plan copies.
      const keptByCheck = items.filter((_, index) => !before[index].problem && !before[index].skipped).map((item) => item.id);
      assert.deepEqual(plan.files.map((file) => file.itemId), keptByCheck, 'the same files go through');

      for (const index of testCase.problems ?? []) assert.ok(before[index].problem, 'a file the iPod cannot take has a problem named');
      for (const index of testCase.cannotTell ?? []) assert.equal(before[index].verdict.status, 'cannot-tell');
    });
  }

  it('names the track on the iPod that a file matches', async () => {
    const ipod = await signedIpod();
    const item = song('Morning Light');
    const plan = await planSync(ipod, newEngine, [item]);
    const [result] = checkDuplicates([item], plan.tracksBefore);
    assert.equal(result.verdict.status, 'on-ipod');
    assert.equal(result.verdict.track.title, 'Morning Light');
    assert.equal(result.verdict.track.artist, 'The Demo Band');
    assert.equal(result.verdict.trackKey, trackKey(result.verdict.track));
    assert.equal(result.verdict.trackKey, plan.duplicates[0].trackKey);
  });

  it('gives the same answer when asked item by item, as planSync does, and when asked all at once', async () => {
    const ipod = await signedIpod();
    const items = [song('Morning Light'), song('Same'), song('Same'), song('Other')];
    const plan = await planSync(ipod, newEngine, items);
    const judge = createDuplicateJudge(plan.tracksBefore);
    const stepwise = items.map((item) => {
      const verdict = judge.judge(item);
      if (verdict.status === 'new' || verdict.status === 'cannot-tell') judge.accept(item);
      return verdict.status;
    });
    assert.deepEqual(stepwise, checkDuplicates(items, plan.tracksBefore).map((entry) => entry.verdict.status));
  });

  it('asks nothing of the file itself: a prepared item with the same tags gets the same verdict as the unprepared one', async () => {
    const ipod = await signedIpod();
    const prepared = song('Morning Light');
    // The page checks a file by what the probe read, with the size of the picked file.
    const bare = { id: prepared.id, kind: prepared.kind, extension: prepared.extension, info: prepared.info, name: prepared.name, data: { size: 1 } };
    const plan = await planSync(ipod, newEngine, [prepared]);
    assert.deepEqual(checkDuplicates([bare], plan.tracksBefore)[0].verdict, checkDuplicates([prepared], plan.tracksBefore)[0].verdict);
  });

  it('says why a file cannot be added, in the words planSync uses', async () => {
    const ipod = await signedIpod();
    const flac = song('Anything', { extension: '.flac' });
    const empty = song('Empty', { size: 0, data: { size: 0, read: async () => new Uint8Array(0) } });
    const plan = await planSync(ipod, newEngine, [flac, empty]);
    assert.equal(itemProblem(flac), plan.skipped.find((entry) => entry.itemId === flac.id).reason);
    assert.equal(itemProblem(empty), plan.skipped.find((entry) => entry.itemId === empty.id).reason);
    assert.equal(itemProblem(song('Fine')), null);
  });

  it('planSync with one id allowed adds that item and still skips the other duplicates', async () => {
    const ipod = await signedIpod();
    const first = song('Morning Light');
    const second = song('Night Drive', { durationMs: 187_000 });
    const plan = await planSync(ipod, newEngine, [first, second], { allowDuplicateIds: [second.id] });
    assert.deepEqual(plan.files.map((file) => file.itemId), [second.id]);
    assert.deepEqual(plan.duplicates.map((found) => [found.itemId, found.skipped]), [[first.id, true], [second.id, false]]);
  });
});
