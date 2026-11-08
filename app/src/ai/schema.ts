import type { Kind } from '@opentunes/engine';

/**
 * What the model may ask for, and the checks every answer goes through before the person sees it.
 *
 * The model only proposes. This file decides what a proposal may contain: which tracks (only ids
 * from the digest that was sent), which fields (only ones the engine can edit), which kinds, how
 * many. Anything else is dropped, and the drop is reported so the person can see what was refused.
 */

// ---------------------------------------------------------------- what is allowed

/** Fields the model may name, and the engine field each one sets. */
export const EDIT_FIELD_MAP = {
  title: 'title',
  artist: 'artist',
  album: 'album',
  albumartist: 'albumartist',
  genre: 'genre',
  year: 'year',
  track: 'track_nr',
} as const;

export type AiField = keyof typeof EDIT_FIELD_MAP;
export type EngineField = (typeof EDIT_FIELD_MAP)[AiField];

export const TEXT_AI_FIELDS = ['title', 'artist', 'album', 'albumartist', 'genre'] as const satisfies readonly AiField[];
export const NUMBER_AI_FIELDS = ['year', 'track'] as const satisfies readonly AiField[];
export const AI_FIELDS = [...TEXT_AI_FIELDS, ...NUMBER_AI_FIELDS] as const;

/**
 * Kinds the model may switch a track between. Video kinds are left out on purpose: the file on
 * the iPod is audio, and calling it a movie would not make it one.
 */
export const AI_KINDS = ['music', 'audiobook', 'podcast'] as const satisfies readonly Kind[];

export const LIMITS = {
  edits: 500,
  playlists: 10,
  playlistTracks: 1000,
  textChars: 200,
  reasonChars: 200,
  nameChars: 100,
  answerChars: 4000,
  yearMin: 1000,
  yearMax: 2100,
  trackMax: 999,
} as const;

// ---------------------------------------------------------------- tool definitions

export interface ToolDefinition {
  name: ToolName;
  description: string;
  /** A JSON Schema object. Anthropic calls it input_schema, OpenAI-style endpoints call it parameters. */
  schema: Record<string, unknown>;
}

export type ToolName = 'propose_edits' | 'propose_playlists' | 'answer';
export const TOOL_NAMES: readonly ToolName[] = ['propose_edits', 'propose_playlists', 'answer'];

const FIELDS_SCHEMA = {
  type: 'object',
  description: 'Only the fields that should change, with their new values.',
  properties: {
    title: { type: 'string' },
    artist: { type: 'string' },
    album: { type: 'string' },
    albumartist: { type: 'string' },
    genre: { type: 'string' },
    year: { type: 'integer' },
    track: { type: 'integer', description: 'Track number on the album.' },
  },
  additionalProperties: false,
};

export const TOOLS: readonly ToolDefinition[] = [
  {
    name: 'propose_edits',
    description:
      'Propose changes to the title, artist, album, album artist, genre, year, track number or kind of existing tracks. Use the ids from the library list. Change only what needs changing. The person reviews every change before anything is applied.',
    schema: {
      type: 'object',
      properties: {
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'integer', description: 'The track id from the library list.' },
              fields: FIELDS_SCHEMA,
              kind: { type: 'string', enum: [...AI_KINDS], description: 'Only when the track is in the wrong menu on the iPod.' },
              reason: { type: 'string', description: 'One short sentence for the person.' },
            },
            required: ['id', 'reason'],
            additionalProperties: false,
          },
        },
      },
      required: ['edits'],
      additionalProperties: false,
    },
  },
  {
    name: 'propose_playlists',
    description: 'Propose new playlists made from existing tracks. Only new playlists: existing playlists cannot be renamed, changed or deleted. Use ids from the library list.',
    schema: {
      type: 'object',
      properties: {
        playlists: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'A new playlist name.' },
              ids: { type: 'array', items: { type: 'integer' }, description: 'Track ids from the library list, in play order.' },
              reason: { type: 'string', description: 'One short sentence for the person.' },
            },
            required: ['name', 'ids', 'reason'],
            additionalProperties: false,
          },
        },
      },
      required: ['playlists'],
      additionalProperties: false,
    },
  },
  {
    name: 'answer',
    description: 'Answer a question about the library in plain text. Changes nothing. Use it for questions, and when no change is needed.',
    schema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------- validated results

/** The current values of a track, for showing before and after and for spotting no-ops. */
export interface KnownTrack {
  id: number;
  /** From the engine's trackKey. Never sent to the model. */
  key: string;
  kind: string;
  title: string | null;
  artist: string | null;
  album: string | null;
  albumartist: string | null;
  genre: string | null;
  year: number;
  track_nr: number;
}

export interface FieldChange {
  field: AiField;
  before: string;
  after: string;
}

export interface ProposedEdit {
  id: number;
  key: string;
  /** Engine field names, ready for a TrackEdit. */
  fields: Partial<Record<Exclude<EngineField, 'year' | 'track_nr'>, string>> & Partial<Record<'year' | 'track_nr', number>>;
  kind?: (typeof AI_KINDS)[number];
  kindBefore?: string;
  changes: FieldChange[];
  reason: string;
}

export interface ProposedPlaylist {
  name: string;
  ids: number[];
  keys: string[];
  reason: string;
}

export interface Dropped {
  what: string;
  why: string;
}

export interface Proposals {
  answer: string | null;
  edits: ProposedEdit[];
  playlists: ProposedPlaylist[];
  dropped: Dropped[];
}

export interface ValidationContext {
  /** The tracks whose ids were sent, by id. An id not in here is unknown. */
  known: Map<number, KnownTrack>;
  /** Names of the playlists already on the iPod, so a new one cannot clash. */
  existingPlaylists: string[];
}

export interface ToolCall {
  name: string;
  input: unknown;
}

// ---------------------------------------------------------------- the validator

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Strips control characters and surrounding space, and collapses runs of space. */
function cleanText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

const shorten = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const describeValue = (value: unknown): string => {
  const text = typeof value === 'string' ? JSON.stringify(shorten(value, 40)) : String(JSON.stringify(value) ?? value);
  return shorten(text, 60);
};

const asInteger = (value: unknown): number | null => (typeof value === 'number' && Number.isInteger(value) ? value : null);

function label(known: KnownTrack | undefined, id: unknown): string {
  return known ? `track ${known.id} (${shorten(known.title ?? 'no title', 40)})` : `track ${describeValue(id)}`;
}

const before = (known: KnownTrack, field: AiField): string => {
  const value = known[EDIT_FIELD_MAP[field]];
  if (typeof value === 'number') return value === 0 ? '' : String(value);
  return value ?? '';
};

function checkEdit(raw: unknown, context: ValidationContext, dropped: Dropped[], seen: Set<number>): ProposedEdit | null {
  if (!isObject(raw)) {
    dropped.push({ what: 'a change', why: 'it was not an object' });
    return null;
  }
  const id = asInteger(raw.id);
  const known = id === null ? undefined : context.known.get(id);
  if (id === null || !known) {
    dropped.push({ what: `a change to ${label(undefined, raw.id)}`, why: 'that id was not in the list that was sent' });
    return null;
  }
  const name = label(known, id);
  if (seen.has(id)) {
    dropped.push({ what: `a second change to ${name}`, why: 'each track can be changed once per answer' });
    return null;
  }

  const fields: ProposedEdit['fields'] = {};
  const changes: FieldChange[] = [];
  if (raw.fields !== undefined && !isObject(raw.fields)) {
    dropped.push({ what: `the fields for ${name}`, why: 'they were not an object' });
  }
  for (const [field, value] of Object.entries(isObject(raw.fields) ? raw.fields : {})) {
    if (!Object.hasOwn(EDIT_FIELD_MAP, field)) {
      dropped.push({ what: `"${shorten(field, 30)}" on ${name}`, why: 'that field cannot be edited here' });
      continue;
    }
    const aiField = field as AiField;
    let after: string | number;
    if ((NUMBER_AI_FIELDS as readonly string[]).includes(aiField)) {
      const number = asInteger(value);
      const low = aiField === 'year' ? LIMITS.yearMin : 1;
      const high = aiField === 'year' ? LIMITS.yearMax : LIMITS.trackMax;
      if (number === null || number < low || number > high) {
        dropped.push({ what: `${aiField} ${describeValue(value)} on ${name}`, why: `it must be a whole number from ${low} to ${high}` });
        continue;
      }
      after = number;
    } else {
      if (typeof value !== 'string') {
        dropped.push({ what: `${aiField} ${describeValue(value)} on ${name}`, why: 'it must be text' });
        continue;
      }
      const text = cleanText(value);
      if (text.length > LIMITS.textChars) {
        dropped.push({ what: `${aiField} on ${name}`, why: `it was longer than ${LIMITS.textChars} characters` });
        continue;
      }
      if (aiField === 'title' && !text) {
        dropped.push({ what: `an empty title on ${name}`, why: 'a track needs a title' });
        continue;
      }
      after = text;
    }
    const engineField = EDIT_FIELD_MAP[aiField];
    const current = before(known, aiField);
    if (String(after) === current) continue; // already that value, nothing to do
    (fields as Record<string, string | number>)[engineField] = after;
    changes.push({ field: aiField, before: current, after: String(after) });
  }

  let kind: ProposedEdit['kind'];
  if (raw.kind !== undefined) {
    if (typeof raw.kind !== 'string' || !(AI_KINDS as readonly string[]).includes(raw.kind)) {
      dropped.push({ what: `the kind ${describeValue(raw.kind)} for ${name}`, why: `only ${AI_KINDS.join(', ')} can be set` });
    } else if (!(AI_KINDS as readonly string[]).includes(known.kind)) {
      dropped.push({ what: `a kind change for ${name}`, why: `it is ${known.kind}, and only audio can change kind` });
    } else if (raw.kind !== known.kind) {
      kind = raw.kind as ProposedEdit['kind'];
    }
  }

  if (!changes.length && !kind) {
    if (!dropped.some((entry) => entry.what.includes(name))) dropped.push({ what: `a change to ${name}`, why: 'it changed nothing' });
    return null;
  }
  seen.add(id);
  const reason = typeof raw.reason === 'string' && cleanText(raw.reason) ? shorten(cleanText(raw.reason), LIMITS.reasonChars) : '(no reason given)';
  return { id, key: known.key, fields, kind, kindBefore: kind ? known.kind : undefined, changes, reason };
}

function checkPlaylist(raw: unknown, context: ValidationContext, dropped: Dropped[], taken: Set<string>): ProposedPlaylist | null {
  if (!isObject(raw)) {
    dropped.push({ what: 'a playlist', why: 'it was not an object' });
    return null;
  }
  const name = typeof raw.name === 'string' ? cleanText(raw.name) : '';
  const shown = name ? `the playlist "${shorten(name, 40)}"` : 'a playlist with no name';
  if (!name || name.length > LIMITS.nameChars) {
    dropped.push({ what: shown, why: name ? `the name was longer than ${LIMITS.nameChars} characters` : 'it needs a name' });
    return null;
  }
  if (taken.has(name.toLowerCase())) {
    dropped.push({ what: shown, why: 'a playlist with that name exists already, and existing playlists are not changed' });
    return null;
  }
  if (!Array.isArray(raw.ids)) {
    dropped.push({ what: shown, why: 'it had no list of track ids' });
    return null;
  }
  const ids: number[] = [];
  const keys: string[] = [];
  const used = new Set<number>();
  let unknown = 0;
  for (const value of raw.ids) {
    const id = asInteger(value);
    const known = id === null ? undefined : context.known.get(id);
    if (id === null || !known) unknown += 1;
    else if (!used.has(id)) {
      used.add(id);
      ids.push(id);
      keys.push(known.key);
    }
  }
  if (unknown) dropped.push({ what: `${unknown} ${unknown === 1 ? 'id' : 'ids'} in ${shown}`, why: 'they were not in the list that was sent' });
  if (ids.length > LIMITS.playlistTracks) {
    dropped.push({ what: `${ids.length - LIMITS.playlistTracks} tracks at the end of ${shown}`, why: `a playlist here holds at most ${LIMITS.playlistTracks}` });
    ids.length = LIMITS.playlistTracks;
    keys.length = LIMITS.playlistTracks;
  }
  if (!ids.length) {
    dropped.push({ what: shown, why: 'none of its tracks could be used' });
    return null;
  }
  taken.add(name.toLowerCase());
  const reason = typeof raw.reason === 'string' && cleanText(raw.reason) ? shorten(cleanText(raw.reason), LIMITS.reasonChars) : '(no reason given)';
  return { name, ids, keys, reason };
}

/** Checks everything the model asked for. Never throws: what is not allowed goes in `dropped`. */
export function validateProposals(calls: ToolCall[], context: ValidationContext): Proposals {
  const result: Proposals = { answer: null, edits: [], playlists: [], dropped: [] };
  const seen = new Set<number>();
  const taken = new Set(context.existingPlaylists.map((name) => name.toLowerCase()));
  const answers: string[] = [];

  for (const call of calls) {
    const input = call.input;
    if (call.name === 'answer') {
      const text = isObject(input) && typeof input.text === 'string' ? input.text.trim() : '';
      if (text) answers.push(shorten(text, LIMITS.answerChars));
      else result.dropped.push({ what: 'an answer', why: 'it had no text' });
    } else if (call.name === 'propose_edits') {
      const list = isObject(input) ? input.edits : undefined;
      if (!Array.isArray(list)) {
        result.dropped.push({ what: 'a list of changes', why: 'it was not a list' });
        continue;
      }
      let capReported = false;
      list.forEach((raw, index) => {
        if (result.edits.length >= LIMITS.edits) {
          if (!capReported) result.dropped.push({ what: `${list.length - index} changes past the first ${LIMITS.edits}`, why: 'that is the most one answer may hold. Ask again for the rest' });
          capReported = true;
          return;
        }
        const edit = checkEdit(raw, context, result.dropped, seen);
        if (edit) result.edits.push(edit);
      });
    } else if (call.name === 'propose_playlists') {
      const list = isObject(input) ? input.playlists : undefined;
      if (!Array.isArray(list)) {
        result.dropped.push({ what: 'a list of playlists', why: 'it was not a list' });
        continue;
      }
      let capReported = false;
      list.forEach((raw, index) => {
        if (result.playlists.length >= LIMITS.playlists) {
          if (!capReported) result.dropped.push({ what: `${list.length - index} playlists past the first ${LIMITS.playlists}`, why: 'that is the most one answer may hold' });
          capReported = true;
          return;
        }
        const playlist = checkPlaylist(raw, context, result.dropped, taken);
        if (playlist) result.playlists.push(playlist);
      });
    } else {
      result.dropped.push({ what: `a request for "${shorten(String(call.name), 30)}"`, why: 'that is not something the assistant can do. It can only propose edits and new playlists, or answer' });
    }
  }
  result.answer = answers.length ? answers.join('\n\n') : null;
  return result;
}
