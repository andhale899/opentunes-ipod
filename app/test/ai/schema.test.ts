import { NUMBER_FIELDS, TEXT_FIELDS } from '@opentunes/engine';
import { describe, expect, it } from 'vitest';
import { buildDigest } from '../../src/ai/digest';
import { AI_FIELDS, EDIT_FIELD_MAP, LIMITS, TOOLS, validateProposals, type ToolCall } from '../../src/ai/schema';
import { library } from './fixtures';

const digest = buildDigest(library());
const context = { known: digest.known, existingPlaylists: ['Road trip', 'My iPod'] };
const edits = (...list: unknown[]): ToolCall[] => [{ name: 'propose_edits', input: { edits: list } }];
const playlists = (...list: unknown[]): ToolCall[] => [{ name: 'propose_playlists', input: { playlists: list } }];
const whys = (result: ReturnType<typeof validateProposals>): string => result.dropped.map((entry) => `${entry.what}: ${entry.why}`).join('\n');

describe('what the assistant may touch', () => {
  it('only names fields the engine really can edit, and never a file field', () => {
    const editable = new Set<string>([...TEXT_FIELDS, ...NUMBER_FIELDS]);
    for (const field of AI_FIELDS) expect(editable.has(EDIT_FIELD_MAP[field]), field).toBe(true);
    for (const forbidden of ['size', 'ipod_path', 'tracklen', 'playcount', 'rating', 'filetype', 'id']) {
      expect(Object.values(EDIT_FIELD_MAP) as string[]).not.toContain(forbidden);
    }
  });

  it('offers three tools with object schemas that close their properties', () => {
    expect(TOOLS.map((tool) => tool.name)).toEqual(['propose_edits', 'propose_playlists', 'answer']);
    for (const tool of TOOLS) expect(tool.schema).toMatchObject({ type: 'object', additionalProperties: false });
    const item = ((TOOLS[0]?.schema.properties as Record<string, { items: { properties: Record<string, unknown> } }>).edits as { items: { properties: Record<string, unknown> } }).items;
    expect(Object.keys(item.properties).sort()).toEqual(['fields', 'id', 'kind', 'reason']);
  });
});

describe('checking proposed edits', () => {
  it('accepts a good edit and works out before and after', () => {
    const result = validateProposals(edits({ id: 1, fields: { artist: 'The Beatles', track: 5 }, reason: 'Spelling' }), context);
    expect(result.dropped).toEqual([]);
    expect(result.edits).toHaveLength(1);
    const [edit] = result.edits;
    expect(edit?.key).toBe(digest.known.get(1)?.key);
    expect(edit?.fields).toEqual({ artist: 'The Beatles', track_nr: 5 });
    expect(edit?.changes).toEqual([
      { field: 'artist', before: 'Beatls', after: 'The Beatles' },
      { field: 'track', before: '3', after: '5' },
    ]);
    expect(edit?.reason).toBe('Spelling');
  });

  it('drops unknown ids, and ids that are not whole numbers', () => {
    const result = validateProposals(edits({ id: 99, fields: { artist: 'X' }, reason: 'r' }, { id: '1', fields: { artist: 'X' }, reason: 'r' }, { id: 1.5, fields: { artist: 'X' }, reason: 'r' }, { fields: { artist: 'X' } }), context);
    expect(result.edits).toEqual([]);
    expect(result.dropped).toHaveLength(4);
    expect(whys(result)).toContain('not in the list that was sent');
  });

  it('drops a field the engine cannot edit but keeps the rest of the change', () => {
    const result = validateProposals(edits({ id: 1, fields: { artist: 'The Beatles', size: 1, ipod_path: '/x', playcount: 0, track_nr: 1 }, reason: 'r' }), context);
    expect(result.edits[0]?.fields).toEqual({ artist: 'The Beatles' });
    expect(result.dropped.map((entry) => entry.what)).toEqual(['"size" on track 1 (Morning Light)', '"ipod_path" on track 1 (Morning Light)', '"playcount" on track 1 (Morning Light)', '"track_nr" on track 1 (Morning Light)']);
  });

  it('drops an edit whose only fields are not allowed', () => {
    const result = validateProposals(edits({ id: 2, fields: { size: 5 }, reason: 'r' }), context);
    expect(result.edits).toEqual([]);
    expect(whys(result)).toContain('cannot be edited');
  });

  it('checks the type and range of each value', () => {
    const result = validateProposals(
      edits(
        { id: 1, fields: { year: 'soon' }, reason: 'r' },
        { id: 2, fields: { year: 99999 }, reason: 'r' },
        { id: 3, fields: { track: 0 }, reason: 'r' },
        { id: 4, fields: { title: 5 }, reason: 'r' },
        { id: 1, fields: { title: '   ' }, reason: 'r' },
        { id: 2, fields: { genre: 'g'.repeat(LIMITS.textChars + 1) }, reason: 'r' },
        { id: 2, fields: { year: 1999 }, reason: 'r' },
      ),
      context,
    );
    expect(result.edits.map((edit) => edit.id)).toEqual([2]);
    expect(result.dropped).toHaveLength(6);
  });

  it('cleans control characters and spacing in new text', () => {
    const result = validateProposals(edits({ id: 1, fields: { album: '  Demo \n\u0000 Album 2 ' }, reason: 'r' }), context);
    expect(result.edits[0]?.fields.album).toBe('Demo Album 2');
  });

  it('skips a change that sets the value a track already has, and says nothing changed', () => {
    const result = validateProposals(edits({ id: 1, fields: { artist: 'Beatls', year: 2011 }, reason: 'r' }), context);
    expect(result.edits).toEqual([]);
    expect(whys(result)).toContain('changed nothing');
  });

  it('allows switching an audio track between music, audiobook and podcast, and nothing else', () => {
    const ok = validateProposals(edits({ id: 3, kind: 'audiobook', reason: 'It is a book' }), context);
    expect(ok.edits[0]).toMatchObject({ kind: 'audiobook', kindBefore: 'music', changes: [] });
    for (const kind of ['movie', 'tv-show', 'music-video', 'video-podcast', 'banana', 5]) {
      const bad = validateProposals(edits({ id: 3, kind, reason: 'r' }), context);
      expect(bad.edits, String(kind)).toEqual([]);
      expect(bad.dropped.length).toBeGreaterThan(0);
    }
    // A video cannot be turned into audio by renaming it.
    const video = validateProposals(edits({ id: 4, kind: 'audiobook', reason: 'r' }), context);
    expect(video.edits).toEqual([]);
    expect(whys(video)).toContain('only audio can change kind');
  });

  it('allows each track to be changed once per answer', () => {
    const result = validateProposals(edits({ id: 1, fields: { artist: 'A' }, reason: 'r' }, { id: 1, fields: { artist: 'B' }, reason: 'r' }), context);
    expect(result.edits).toHaveLength(1);
    expect(result.edits[0]?.fields.artist).toBe('A');
    expect(whys(result)).toContain('once per answer');
  });

  it('caps the number of edits and reports the rest', () => {
    const big = buildDigest(Array.from({ length: LIMITS.edits + 3 }, (_, index) => ({ ...library()[0]!, ipod_path: `:iPod_Control:Music:F00:T${index}.m4a` })));
    const list = Array.from({ length: LIMITS.edits + 3 }, (_, index) => ({ id: index + 1, fields: { artist: 'New' }, reason: 'r' }));
    const result = validateProposals(edits(...list), { known: big.known, existingPlaylists: [] });
    expect(result.edits).toHaveLength(LIMITS.edits);
    expect(result.dropped).toEqual([{ what: '3 changes past the first 500', why: expect.stringContaining('most one answer') }]);
  });

  it('survives garbage without throwing', () => {
    for (const input of [null, 'text', 5, [], {}, { edits: 'x' }, { edits: [null, 5, 'x', []] }, { edits: [{ id: 1, fields: 'x', reason: 5 }] }]) {
      expect(() => validateProposals([{ name: 'propose_edits', input }], context)).not.toThrow();
    }
    expect(validateProposals(edits(null, 5), context).edits).toEqual([]);
  });

  it('refuses a tool it does not know, such as one that deletes', () => {
    const result = validateProposals([{ name: 'delete_tracks', input: { ids: [1] } }, { name: 'rename_playlist', input: {} }], context);
    expect(result.edits).toEqual([]);
    expect(result.playlists).toEqual([]);
    expect(result.dropped).toHaveLength(2);
    expect(whys(result)).toContain('not something the assistant can do');
  });
});

describe('checking proposed playlists', () => {
  it('accepts a new playlist and maps ids to track keys, dropping repeats', () => {
    const result = validateProposals(playlists({ name: ' Running ', ids: [2, 1, 2], reason: 'Upbeat' }), context);
    expect(result.dropped).toEqual([]);
    expect(result.playlists).toEqual([{ name: 'Running', ids: [2, 1], keys: [digest.known.get(2)?.key, digest.known.get(1)?.key], reason: 'Upbeat' }]);
  });

  it('drops unknown ids and reports how many', () => {
    const result = validateProposals(playlists({ name: 'Mix', ids: [1, 77, 'x', 2], reason: 'r' }), context);
    expect(result.playlists[0]?.ids).toEqual([1, 2]);
    expect(result.dropped[0]?.what).toBe('2 ids in the playlist "Mix"');
  });

  it('drops a playlist with no usable tracks, no name or a name that is taken', () => {
    const result = validateProposals(playlists({ name: 'Mix', ids: [77], reason: 'r' }, { name: '', ids: [1], reason: 'r' }, { name: 'road TRIP', ids: [1], reason: 'r' }, { name: 'My iPod', ids: [1], reason: 'r' }, { name: 'Ok', ids: 'nope', reason: 'r' }), context);
    expect(result.playlists).toEqual([]);
    expect(whys(result)).toContain('a playlist with that name exists already');
    expect(result.dropped.length).toBeGreaterThanOrEqual(5);
  });

  it('does not allow two new playlists with the same name', () => {
    const result = validateProposals(playlists({ name: 'Mix', ids: [1], reason: 'r' }, { name: 'MIX', ids: [2], reason: 'r' }), context);
    expect(result.playlists.map((one) => one.name)).toEqual(['Mix']);
  });

  it('caps playlists and their length', () => {
    const lots = Array.from({ length: LIMITS.playlists + 2 }, (_, index) => ({ name: `Mix ${index}`, ids: [1], reason: 'r' }));
    const result = validateProposals(playlists(...lots), context);
    expect(result.playlists).toHaveLength(LIMITS.playlists);
    expect(result.dropped).toHaveLength(1);
  });
});

describe('answers', () => {
  it('keeps the text of an answer, and no changes come with it', () => {
    const result = validateProposals([{ name: 'answer', input: { text: ' Two albums look incomplete. ' } }], context);
    expect(result).toMatchObject({ answer: 'Two albums look incomplete.', edits: [], playlists: [], dropped: [] });
  });

  it('joins several answers and drops an empty one', () => {
    const result = validateProposals([{ name: 'answer', input: { text: 'a' } }, { name: 'answer', input: { text: 'b' } }, { name: 'answer', input: {} }], context);
    expect(result.answer).toBe('a\n\nb');
    expect(result.dropped).toHaveLength(1);
  });
});
