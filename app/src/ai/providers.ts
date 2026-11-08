import { JSON_MODE_SUFFIX } from './prompt';
import { TOOL_NAMES, type ToolCall, type ToolDefinition } from './schema';

/**
 * Talks to a language model straight from the browser, with `fetch`. Two kinds of endpoint:
 * Anthropic's Messages API, and anything that speaks the OpenAI chat-completions format.
 *
 * The key is only ever put in a request header. It is never put in a URL, a log line, or an
 * error message: every message that leaves this file goes through `scrub` first.
 */

export type ProviderId = 'anthropic' | 'openai';

export interface ProviderConfig {
  provider: ProviderId;
  apiKey: string;
  model: string;
  /** Used by the OpenAI-style provider only. */
  baseUrl: string;
}

export const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';
export const DEFAULT_MODELS: Record<ProviderId, string> = { anthropic: 'claude-sonnet-5-5', openai: '' };
export const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
export const ANTHROPIC_MAX_TOKENS = 8192;

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ModelRequest {
  system: string;
  messages: ChatMessage[];
  tools: readonly ToolDefinition[];
}

export interface ModelReply {
  /** Any plain text the model sent. */
  text: string;
  calls: ToolCall[];
  /** True when the model ran out of room and the reply was cut off. */
  truncated: boolean;
  /** True when the endpoint would not take tools and the answer was read from JSON text. */
  jsonMode: boolean;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface CallOptions {
  signal?: AbortSignal;
  /** For tests. Defaults to the page's own fetch, looked up when the call is made. */
  fetchImpl?: FetchLike;
}

export type ErrorKind = 'auth' | 'rate' | 'bad-request' | 'not-found' | 'server' | 'network' | 'abort' | 'bad-reply' | 'setup';

export class ModelError extends Error {
  kind: ErrorKind;
  status?: number;
  /** True when the endpoint refused because it does not take tools. */
  toolsRefused: boolean;
  constructor(kind: ErrorKind, message: string, extra: { status?: number; toolsRefused?: boolean } = {}) {
    super(message);
    this.name = 'ModelError';
    this.kind = kind;
    this.status = extra.status;
    this.toolsRefused = extra.toolsRefused ?? false;
  }
}

// ---------------------------------------------------------------- keys and addresses

/** Removes the key, and anything shaped like one, from text that is about to be shown. */
export function scrub(text: string, key = ''): string {
  let out = text;
  if (key.length >= 4) out = out.split(key).join('[key hidden]');
  return out.replace(/\b(sk|pk|key|tok|xai|gsk|AIza)[-_][A-Za-z0-9_-]{6,}/g, '[key hidden]').replace(/Bearer\s+\S+/gi, 'Bearer [key hidden]');
}

/** Header values cannot hold spaces or line breaks, and a pasted key often has one at the end. */
export function cleanKey(key: string): string {
  return key.trim();
}

export const keyProblem = (key: string): string | null => {
  const clean = cleanKey(key);
  if (!clean) return 'Paste an API key first.';
  if (!/^[\x21-\x7e]+$/.test(clean)) return 'The key has a space or an odd character in it. Paste it again, on its own.';
  return null;
};

export type BaseUrl = { ok: true; base: string; host: string } | { ok: false; error: string };

/** An address is fine when it is https (or a local http one for a model on this computer) and carries nothing secret. */
export function checkBaseUrl(text: string): BaseUrl {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return { ok: false, error: 'That is not a web address. It should look like https://api.openai.com/v1.' };
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return { ok: false, error: 'The address must start with https:// (http:// is only allowed for a model on this computer).' };
  if (url.username || url.password) return { ok: false, error: 'The address must not hold a user name or password. The key goes in its own field.' };
  if (url.search || url.hash) return { ok: false, error: 'The address must not have a ? or # part. The key goes in its own field and is never put in a URL.' };
  return { ok: true, base: `${url.origin}${url.pathname.replace(/\/+$/, '')}`, host: url.host };
}

/** The host the library would be sent to, or null when the settings are not usable yet. */
export function hostOf(config: Pick<ProviderConfig, 'provider' | 'baseUrl'>): string | null {
  if (config.provider === 'anthropic') return new URL(ANTHROPIC_URL).host;
  const checked = checkBaseUrl(config.baseUrl);
  return checked.ok ? checked.host : null;
}

function endpointOf(config: ProviderConfig): { url: string; host: string } {
  if (config.provider === 'anthropic') return { url: ANTHROPIC_URL, host: new URL(ANTHROPIC_URL).host };
  const checked = checkBaseUrl(config.baseUrl);
  if (!checked.ok) throw new ModelError('setup', checked.error);
  return { url: `${checked.base}/chat/completions`, host: checked.host };
}

// ---------------------------------------------------------------- errors in plain language

function detailOf(text: string, key: string): string {
  let message = text;
  try {
    const body = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown };
    const found = typeof body.error === 'string' ? body.error : body.error?.message ?? body.message;
    if (typeof found === 'string') message = found;
  } catch {
    // not JSON, use the text
  }
  const clean = scrub(message.replace(/\s+/g, ' ').trim(), key);
  return clean.length > 300 ? `${clean.slice(0, 299)}…` : clean;
}

export const NOT_A_CHAT_MODEL = 'That model cannot be used for chat here (it is for another kind of request). Pick a different model from the list.';

/** The service says the model exists but is for another endpoint (completions, responses, audio ...). */
const WRONG_ENDPOINT_STRONG = /not a chat model|did you mean to use v1\/completions|only (supported|available|works?) (in|with|on) (the )?(v1\/)?(responses|completions)\b|only supports? (the )?(v1\/)?(responses|completions)\b|not supported in the v1\/chat\/completions/i;
/** A vaguer wording, trusted only when the message is not about tools (which has its own fallback). */
const WRONG_ENDPOINT_WEAK = /not supported (in|by|for|with) (this|the) (endpoint|api)/i;
const ABOUT_TOOLS = /\btools?\b|tool_choice|function/i;

/** True when a 400 or 404 body says the model is not one this chat endpoint can use. */
export function isWrongEndpointForModel(detail: string): boolean {
  return WRONG_ENDPOINT_STRONG.test(detail) || (WRONG_ENDPOINT_WEAK.test(detail) && !ABOUT_TOOLS.test(detail));
}

function httpError(status: number, bodyText: string, host: string, key: string): ModelError {
  const detail = detailOf(bodyText, key);
  const more = detail ? ` It said: ${detail}` : '';
  if ((status === 404 || status === 400) && isWrongEndpointForModel(detail)) return new ModelError('bad-request', NOT_A_CHAT_MODEL, { status });
  if (status === 401) return new ModelError('auth', `${host} did not accept the key (401). Check that it is the right key for this service and has not been revoked.${more}`, { status });
  if (status === 403) return new ModelError('auth', `${host} refused this key or model (403). The key may not be allowed to use that model.${more}`, { status });
  if (status === 404) return new ModelError('not-found', `${host} says that address or model does not exist (404). Check the model name, and for another endpoint the base address.${more}`, { status });
  if (status === 429) return new ModelError('rate', `${host} says you have hit a rate limit or run out of credit (429). Wait a minute and try again, or check the account's usage and billing.${more}`, { status });
  if (status === 413) return new ModelError('bad-request', `${host} says the request is too big (413). Narrow the library with a filter and try again.${more}`, { status });
  if (status === 400 || status === 422) {
    return new ModelError('bad-request', `${host} rejected the request (${status}).${more}`, { status, toolsRefused: /\btools?\b|tool_choice|function/i.test(detail) });
  }
  if (status >= 500) return new ModelError('server', `${host} had a problem on its side (${status}). Try again in a moment.${more}`, { status });
  return new ModelError('bad-request', `${host} answered with an error (${status}).${more}`, { status });
}

async function post(url: string, host: string, headers: Record<string, string>, body: unknown, key: string, options: CallOptions): Promise<unknown> {
  const send: FetchLike = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  let response: Response;
  try {
    response = await send(url, { method: 'POST', headers, body: JSON.stringify(body), signal: options.signal });
  } catch (error) {
    if (options.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw new ModelError('abort', 'Stopped. Nothing was changed.');
    throw new ModelError('network', `Could not reach ${host}. Check the internet connection and the address. Some endpoints do not allow calls from a web page (a CORS block), and this app has no server to relay them, so those cannot be used here.`);
  }
  if (!response.ok) {
    let text = '';
    try {
      text = await response.text();
    } catch {
      // no body
    }
    throw httpError(response.status, text, host, key);
  }
  try {
    return await response.json();
  } catch (error) {
    if (options.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw new ModelError('abort', 'Stopped. Nothing was changed.');
    throw new ModelError('bad-reply', `${host} sent back something that is not JSON, so it may not be an endpoint of the kind chosen.`);
  }
}

// ---------------------------------------------------------------- reading replies

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Reads the answer from JSON text, for an endpoint that would not take tools (or ignored them). */
export function parseJsonReply(text: string): ToolCall[] {
  const stripped = text.replace(/```(?:json)?/gi, '');
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  let value: unknown;
  try {
    value = JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!isObject(value)) return [];
  const calls: ToolCall[] = TOOL_NAMES.filter((name) => name in value).map((name) => ({ name, input: value[name] }));
  if (calls.length) return calls;
  // A model that leaves out the wrapper keys.
  if (Array.isArray(value.edits)) calls.push({ name: 'propose_edits', input: { edits: value.edits } });
  if (Array.isArray(value.playlists)) calls.push({ name: 'propose_playlists', input: { playlists: value.playlists } });
  if (typeof value.text === 'string') calls.push({ name: 'answer', input: { text: value.text } });
  return calls;
}

function finish(text: string, calls: ToolCall[], truncated: boolean, host: string, jsonMode: boolean): ModelReply {
  let found = calls;
  let usedJson = jsonMode;
  if (!found.length && text.trim()) {
    found = parseJsonReply(text);
    if (found.length) usedJson = true;
    else found = [{ name: 'answer', input: { text: text.trim() } }];
  }
  if (!found.length) {
    throw new ModelError('bad-reply', truncated ? `${host} ran out of room before it answered. Narrow the library with a filter and try again.` : `${host} sent back an empty answer. Try again.`);
  }
  return { text, calls: found, truncated, jsonMode: usedJson };
}

function readAnthropic(data: unknown, host: string, jsonMode: boolean): ModelReply {
  if (!isObject(data) || !Array.isArray(data.content)) throw new ModelError('bad-reply', `${host} sent back an answer in a shape this app does not know.`);
  const texts: string[] = [];
  const calls: ToolCall[] = [];
  for (const block of data.content) {
    if (!isObject(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    else if (block.type === 'tool_use' && typeof block.name === 'string') calls.push({ name: block.name, input: block.input });
  }
  return finish(texts.join('\n'), calls, data.stop_reason === 'max_tokens', host, jsonMode);
}

function readOpenAi(data: unknown, host: string, jsonMode: boolean): ModelReply {
  const choice = isObject(data) && Array.isArray(data.choices) && isObject(data.choices[0]) ? data.choices[0] : null;
  const message = choice && isObject(choice.message) ? choice.message : null;
  if (!choice || !message) throw new ModelError('bad-reply', `${host} sent back an answer in a shape this app does not know.`);
  const truncated = choice.finish_reason === 'length';
  const calls: ToolCall[] = [];
  for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    const fn = isObject(call) && isObject(call.function) ? call.function : null;
    if (!fn || typeof fn.name !== 'string') continue;
    let input: unknown = fn.arguments;
    if (typeof input === 'string') {
      try {
        input = JSON.parse(input);
      } catch {
        if (truncated) throw new ModelError('bad-reply', `${host} ran out of room in the middle of its answer. Narrow the library with a filter and try again.`);
        input = null;
      }
    }
    calls.push({ name: fn.name, input });
  }
  const text = typeof message.content === 'string' ? message.content : '';
  return finish(text, calls, truncated, host, jsonMode);
}

// ---------------------------------------------------------------- the calls

async function once(config: ProviderConfig, request: ModelRequest, withTools: boolean, options: CallOptions): Promise<ModelReply> {
  const problem = keyProblem(config.apiKey);
  if (problem) throw new ModelError('setup', problem);
  if (!config.model.trim()) throw new ModelError('setup', 'Enter the name of the model to use.');
  const key = cleanKey(config.apiKey);
  const model = config.model.trim();
  const { url, host } = endpointOf(config);
  const system = withTools ? request.system : request.system + JSON_MODE_SUFFIX;

  if (config.provider === 'anthropic') {
    const body: Record<string, unknown> = { model, max_tokens: ANTHROPIC_MAX_TOKENS, system, messages: request.messages };
    if (withTools) {
      body.tools = request.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.schema }));
      body.tool_choice = { type: 'any' };
    }
    const headers = { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION, 'anthropic-dangerous-direct-browser-access': 'true', 'content-type': 'application/json' };
    return readAnthropic(await post(url, host, headers, body, key, options), host, !withTools);
  }

  const body: Record<string, unknown> = { model, messages: [{ role: 'system', content: system }, ...request.messages] };
  if (withTools) {
    body.tools = request.tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.schema } }));
    body.tool_choice = 'required';
  }
  const headers = { Authorization: `Bearer ${key}`, 'content-type': 'application/json' };
  return readOpenAi(await post(url, host, headers, body, key, options), host, !withTools);
}

/**
 * Sends the request with forced tool use. If the endpoint says it does not take tools, asks
 * once more for the same answer as JSON text. Throws a ModelError with a plain message.
 */
export async function callModel(config: ProviderConfig, request: ModelRequest, options: CallOptions = {}): Promise<ModelReply> {
  try {
    return await once(config, request, true, options);
  } catch (error) {
    if (error instanceof ModelError && error.toolsRefused) {
      if (options.signal?.aborted) throw new ModelError('abort', 'Stopped. Nothing was changed.');
      return once(config, request, false, options);
    }
    if (error instanceof ModelError) throw error;
    // Anything else would be a bug here. Say so without echoing what might hold the key.
    throw new ModelError('bad-reply', scrub(error instanceof Error ? error.message : 'Something went wrong.', config.apiKey));
  }
}

// ---------------------------------------------------------------- the list of models

export interface ModelChoice {
  id: string;
  /** A friendlier name when the service gives one. */
  label: string;
}

/**
 * Ids on api.openai.com that are not usable with /chat/completions, so they would only confuse
 * the list: completion-only (instruct, davinci, babbage), Responses-only (codex, deep-research,
 * the "-pro" models), and models for audio, images, speech, search, moderation or computer use.
 * Conservative on purpose: an id that is only probably not a chat model is hidden, and can still be
 * typed in by hand.
 */
const NOT_CHAT =
  /(embed|whisper|tts|speech|dall-e|moderation|image|realtime|audio|transcribe|diarize|translate|search|computer-use|davinci|babbage|instruct|sora|codex|deep-research|gpt-oss|(^|[-_.])pro($|[-_.])|(^|[-_.])live($|[-_.]))/i;

/** ChatGPT-style chat models: gpt-*, o-series (o1, o3 ...) and chatgpt-*. */
const CHAT_FAMILY = /^(gpt|o\d|chatgpt)/i;

/** Which ids from api.openai.com's list are offered for chat. */
export const isOpenAiChatModel = (id: string): boolean => CHAT_FAMILY.test(id) && !NOT_CHAT.test(id);

/**
 * Asks the service which models this key can use, so the person picks one instead of typing a
 * name from memory. It is a read-only call that costs nothing. Throws a ModelError with a plain
 * message, like callModel.
 */
export async function listModels(config: Pick<ProviderConfig, 'provider' | 'apiKey' | 'baseUrl'>, options: CallOptions = {}): Promise<ModelChoice[]> {
  const problem = keyProblem(config.apiKey);
  if (problem) throw new ModelError('setup', problem);
  const key = cleanKey(config.apiKey);
  let url: string;
  let host: string;
  let headers: Record<string, string>;
  if (config.provider === 'anthropic') {
    url = 'https://api.anthropic.com/v1/models?limit=1000';
    host = 'api.anthropic.com';
    headers = { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION, 'anthropic-dangerous-direct-browser-access': 'true' };
  } else {
    const checked = checkBaseUrl(config.baseUrl);
    if (!checked.ok) throw new ModelError('setup', checked.error);
    url = `${checked.base}/models`;
    host = checked.host;
    headers = { Authorization: `Bearer ${key}` };
  }

  const send: FetchLike = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  let response: Response;
  try {
    response = await send(url, { method: 'GET', headers, signal: options.signal });
  } catch (error) {
    if (options.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw new ModelError('abort', 'Stopped.');
    throw new ModelError('network', `Could not reach ${host} to ask for its models. Check the internet connection and the address. Some endpoints do not allow calls from a web page, so for those type the model name yourself.`);
  }
  if (!response.ok) {
    let text = '';
    try {
      text = await response.text();
    } catch {
      // no body
    }
    throw httpError(response.status, text, host, key);
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new ModelError('bad-reply', `${host} sent back something that is not a list of models. Type the model name yourself.`);
  }
  const rows = isObject(data) && Array.isArray(data.data) ? data.data : Array.isArray(data) ? data : [];
  const choices: ModelChoice[] = [];
  for (const row of rows) {
    if (!isObject(row) || typeof row.id !== 'string' || row.id === '') continue;
    const label = typeof row.display_name === 'string' && row.display_name ? `${row.display_name} (${row.id})` : row.id;
    choices.push({ id: row.id, label });
  }
  const official = host === 'api.openai.com';
  const kept = official ? choices.filter((choice) => isOpenAiChatModel(choice.id)) : choices;
  if (!kept.length) throw new ModelError('bad-reply', `${host} did not list any models this app can use. Type the model name yourself.`);
  // Anthropic lists the newest first. For the others, a descending name sort puts newer versions first more often than not.
  return config.provider === 'anthropic' ? kept : kept.sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }));
}
