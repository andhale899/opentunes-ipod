import { earlierRequest, SYSTEM_PROMPT, userMessage } from './prompt';
import { callModel, type CallOptions, type ChatMessage, type ProviderConfig } from './providers';
import { TOOLS, validateProposals, type Proposals, type ValidationContext } from './schema';
import type { DigestPart } from './digest';

/** How many earlier requests ride along, so "now do the same for genres" makes sense. */
const HISTORY_TURNS = 4;

export interface HistoryTurn {
  request: string;
  /** One line on what came of it, with no track details. */
  summary: string;
}

export interface AskInput {
  config: ProviderConfig;
  part: DigestPart;
  /** One line on which tracks the list holds (all, a part, a filter). */
  scope: string;
  request: string;
  history: HistoryTurn[];
  context: ValidationContext;
}

export interface AskResult extends Proposals {
  truncated: boolean;
  jsonMode: boolean;
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

/** Says which tracks a request covers, for the model and for the person. */
export function scopeText(tracks: number, total: number, part: number, parts: number, filter: string): string {
  const pieces = [`The list below has ${plural(tracks, 'track')}`];
  if (tracks !== total || filter.trim()) pieces.push(`out of ${total} in the whole library`);
  if (filter.trim()) pieces.push(`chosen because they contain "${filter.trim()}"`);
  if (parts > 1) pieces.push(`(part ${part + 1} of ${parts})`);
  return `${pieces.join(' ')}.`;
}

export function summaryOf(result: Proposals): string {
  const proposed: string[] = [];
  if (result.edits.length) proposed.push(plural(result.edits.length, 'edit'));
  if (result.playlists.length) proposed.push(plural(result.playlists.length, 'playlist'));
  const parts = [proposed.length ? `proposed ${proposed.join(' and ')}` : '', result.answer ? 'gave a text answer' : ''].filter(Boolean);
  return parts.length ? `I ${parts.join(' and ')}.` : 'I proposed nothing.';
}

/** Asks the model, checks what comes back, and returns only what passed. Changes nothing anywhere. */
export async function ask(input: AskInput, options: CallOptions = {}): Promise<AskResult> {
  const messages: ChatMessage[] = [];
  for (const turn of input.history.slice(-HISTORY_TURNS)) {
    messages.push({ role: 'user', content: earlierRequest(turn.request) }, { role: 'assistant', content: turn.summary });
  }
  messages.push({ role: 'user', content: userMessage(input.part.text, input.request, input.scope) });
  const reply = await callModel(input.config, { system: SYSTEM_PROMPT, messages, tools: TOOLS }, options);
  const proposals = validateProposals(reply.calls, input.context);
  if (reply.truncated) proposals.dropped.push({ what: 'the end of the answer', why: 'the model ran out of room, so the answer may be incomplete. Narrow the library with a filter and ask again' });
  return { ...proposals, truncated: reply.truncated, jsonMode: reply.jsonMode };
}
