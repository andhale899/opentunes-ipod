import type { DupGroup, DupTrack, GroupVerdict } from '../library/duplicates';
import { OVERHEAD_TOKENS, cleanField, estimateTokens } from './digest';
import { DUPLICATES_JSON_SUFFIX, DUPLICATES_PROMPT, duplicatesMessage } from './prompt';
import { callModel, type CallOptions, type ProviderConfig } from './providers';
import { REVIEW_TOOLS, validateReview, type Dropped } from './schema';

/**
 * The "Ask AI to review" step of Find duplicates. It sends only the groups that were found, as short
 * numbered lines, and gets back a verdict per group. The model only proposes: a verdict changes tick
 * boxes and nothing else.
 *
 * Sent: for each track a number made up for this request, kind, title, artist, album, year, length in
 * seconds and bitrate. Never sent: file paths, sizes, play counts, artwork, playlist names, the iPod's
 * name or ids, or any track that is not in a group. The app's own track keys and sizes do not leave.
 */

/** More groups than this in one request is too much to read and answer well. The rest wait for the next press. */
export const MAX_GROUPS_PER_REQUEST = 150;

export interface DuplicateDigest {
  text: string;
  /** The group ids this request covers, in the order sent. */
  groups: number[];
  tracks: number;
  tokens: number;
  /** Request track id to the app's track key, and each group's request track ids. Never sent. */
  keyOf: Map<number, string>;
  members: Map<number, Set<number>>;
}

const seconds = (milliseconds: number): string => (milliseconds > 0 ? String(Math.round(milliseconds / 1000)) : '');

/** Which groups to send: the ones not reviewed yet, the least certain first, at most one request's worth. */
export function groupsToSend<T extends DupTrack>(all: DupGroup<T>[], reviewed: Set<number>, limit = MAX_GROUPS_PER_REQUEST): { send: DupGroup<T>[]; waiting: number } {
  const rank = { fuzzy: 0, likely: 1, sure: 2 } as const;
  const pending = all.filter((group) => !reviewed.has(group.id));
  const pool = (pending.length ? pending : all).slice().sort((a, b) => rank[a.level] - rank[b.level] || a.id - b.id);
  return { send: pool.slice(0, limit), waiting: Math.max(0, pool.length - limit) };
}

const HOW: Record<DupGroup['level'], string> = {
  sure: 'same artist, title, album and length',
  likely: 'same artist, title and length, different albums',
  fuzzy: 'found through a small spelling difference',
};

export function buildDuplicateDigest<T extends DupTrack>(groups: DupGroup<T>[]): DuplicateDigest {
  const lines: string[] = [];
  const keyOf = new Map<number, string>();
  const members = new Map<number, Set<number>>();
  let nextTrack = 1;
  for (const group of groups) {
    const ids = new Map<string, number>();
    const set = new Set<number>();
    lines.push(`group ${group.id} (${HOW[group.level]})`);
    for (const member of group.members) {
      const id = nextTrack++;
      ids.set(member.key, id);
      set.add(id);
      keyOf.set(id, member.key);
      const track = member.track;
      lines.push(
        [
          String(id),
          track.kind,
          cleanField(track.title).text,
          cleanField(track.artist).text,
          cleanField(track.album).text,
          track.year > 0 ? String(track.year) : '',
          seconds(track.tracklen),
          track.bitrate > 0 ? String(Math.round(track.bitrate)) : '',
        ].join('|'),
      );
    }
    if (group.pairs.length) lines.push(`similar pairs: ${group.pairs.map(([a, b]) => `${ids.get(a)}~${ids.get(b)}`).join(', ')}`);
    members.set(group.id, set);
  }
  const text = lines.join('\n');
  return { text, groups: groups.map((group) => group.id), tracks: nextTrack - 1, tokens: estimateTokens(text.length) + OVERHEAD_TOKENS, keyOf, members };
}

export interface ReviewOutcome {
  verdicts: GroupVerdict[];
  dropped: Dropped[];
  truncated: boolean;
  jsonMode: boolean;
}

/** Asks the model, checks what comes back, and returns only what passed. Changes nothing anywhere. */
export async function reviewDuplicates(input: { config: ProviderConfig; digest: DuplicateDigest }, options: CallOptions = {}): Promise<ReviewOutcome> {
  const { digest } = input;
  const scope = `The list below has ${digest.groups.length} ${digest.groups.length === 1 ? 'group' : 'groups'} of ${digest.tracks} tracks.`;
  const reply = await callModel(
    input.config,
    { system: DUPLICATES_PROMPT, messages: [{ role: 'user', content: duplicatesMessage(digest.text, scope) }], tools: REVIEW_TOOLS, jsonSuffix: DUPLICATES_JSON_SUFFIX },
    options,
  );
  const checked = validateReview(reply.calls, { groups: digest.members });
  const verdicts: GroupVerdict[] = checked.verdicts.map((verdict) => ({
    group: verdict.group,
    verdict: verdict.verdict,
    keepKey: verdict.keep === undefined ? undefined : digest.keyOf.get(verdict.keep),
    reason: verdict.reason,
  }));
  const dropped = [...checked.dropped];
  if (reply.truncated) dropped.push({ what: 'the end of the answer', why: 'the model ran out of room, so some groups may have no verdict. Ask again for the rest' });
  return { verdicts, dropped, truncated: reply.truncated, jsonMode: reply.jsonMode };
}
