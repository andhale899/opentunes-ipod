import { describe, expect, it } from 'vitest';
import { ModelError, callModel, checkBaseUrl, hostOf, parseJsonReply, scrub, type FetchLike, type ModelRequest, type ProviderConfig } from '../../src/ai/providers';
import { TOOLS } from '../../src/ai/schema';

const KEY = 'sk-test-0000';
const request: ModelRequest = { system: 'SYSTEM', messages: [{ role: 'user', content: 'hello' }], tools: TOOLS };
const anthropic: ProviderConfig = { provider: 'anthropic', apiKey: KEY, model: 'claude-sonnet-5-5', baseUrl: '' };
const openai: ProviderConfig = { provider: 'openai', apiKey: KEY, model: 'some-model', baseUrl: 'https://example.test/v1/' };

/** Waits for a promise that must fail, and returns the error. */
async function failure(promise: Promise<unknown>): Promise<ModelError> {
  try {
    await promise;
  } catch (error) {
    return error as ModelError;
  }
  throw new Error('It should have failed, and it did not.');
}

interface Seen {
  url: string;
  init: RequestInit;
  body: Record<string, any>;
  headers: Record<string, string>;
}

/** A fake fetch that records every call and answers from a list. Nothing touches the network. */
function fake(...answers: (Response | Error | ((seen: Seen) => Response))[]): { fetchImpl: FetchLike; calls: Seen[] } {
  const calls: Seen[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const seen: Seen = { url, init, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> };
    calls.push(seen);
    const next = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next(seen) : (next as Response);
  };
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const anthropicToolReply = (name: string, input: unknown, stop = 'tool_use') => json({ content: [{ type: 'tool_use', id: 't1', name, input }], stop_reason: stop });
const openaiToolReply = (name: string, args: unknown, finish = 'tool_calls') =>
  json({ choices: [{ finish_reason: finish, message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } }] } }] });

describe('Anthropic Messages API', () => {
  it('posts to the right address with the right headers, tools and forced tool use', async () => {
    const { fetchImpl, calls } = fake(anthropicToolReply('answer', { text: 'hi' }));
    const reply = await callModel(anthropic, request, { fetchImpl });
    expect(calls).toHaveLength(1);
    const [call] = calls as [Seen];
    expect(call.url).toBe('https://api.anthropic.com/v1/messages');
    expect(call.init.method).toBe('POST');
    expect(call.headers).toEqual({ 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true', 'content-type': 'application/json' });
    expect(call.body.model).toBe('claude-sonnet-5-5');
    expect(call.body.system).toBe('SYSTEM');
    expect(call.body.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(call.body.max_tokens).toBeGreaterThan(1000);
    expect(call.body.tool_choice).toEqual({ type: 'any' });
    expect(call.body.tools.map((tool: { name: string }) => tool.name)).toEqual(['propose_edits', 'propose_playlists', 'answer']);
    expect(call.body.tools[0].input_schema).toEqual(TOOLS[0]?.schema);
    expect(reply.calls).toEqual([{ name: 'answer', input: { text: 'hi' } }]);
    expect(reply.jsonMode).toBe(false);
  });

  it('never puts the key in the address or the body', async () => {
    const { fetchImpl, calls } = fake(anthropicToolReply('answer', { text: 'hi' }));
    await callModel(anthropic, request, { fetchImpl });
    expect(calls[0]?.url).not.toContain(KEY);
    expect(String(calls[0]?.init.body)).not.toContain(KEY);
  });

  it('trims a pasted key, and refuses one with a space inside without echoing it', async () => {
    const { fetchImpl, calls } = fake(anthropicToolReply('answer', { text: 'hi' }));
    await callModel({ ...anthropic, apiKey: `  ${KEY}\n` }, request, { fetchImpl });
    expect(calls[0]?.headers['x-api-key']).toBe(KEY);
    const bad = await failure(callModel({ ...anthropic, apiKey: 'sk-test 0000' }, request, { fetchImpl }));
    expect(bad).toBeInstanceOf(ModelError);
    expect((bad as ModelError).message).not.toContain('sk-test');
    expect(calls).toHaveLength(1);
  });

  it('reads text and several tool calls from one reply', async () => {
    const { fetchImpl } = fake(json({ content: [{ type: 'text', text: 'Here you go' }, { type: 'tool_use', name: 'propose_edits', input: { edits: [] } }, { type: 'tool_use', name: 'propose_playlists', input: { playlists: [] } }], stop_reason: 'tool_use' }));
    const reply = await callModel(anthropic, request, { fetchImpl });
    expect(reply.calls.map((call) => call.name)).toEqual(['propose_edits', 'propose_playlists']);
    expect(reply.text).toBe('Here you go');
  });

  it('reports a reply that was cut off', async () => {
    const { fetchImpl } = fake(anthropicToolReply('propose_edits', { edits: [] }, 'max_tokens'));
    expect((await callModel(anthropic, request, { fetchImpl })).truncated).toBe(true);
  });

  it('falls back to JSON text when the endpoint says it does not take tools', async () => {
    const answer = '```json\n{"propose_edits": {"edits": [{"id": 1, "fields": {"artist": "X"}, "reason": "r"}]}}\n```';
    const { fetchImpl, calls } = fake(json({ error: { type: 'invalid_request_error', message: 'tools: this model does not support tool use' } }, 400), json({ content: [{ type: 'text', text: answer }], stop_reason: 'end_turn' }));
    const reply = await callModel(anthropic, request, { fetchImpl });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.body.tools).toBeUndefined();
    expect(calls[1]?.body.tool_choice).toBeUndefined();
    expect(calls[1]?.body.system).toContain('Reply with a single JSON object');
    expect(reply.jsonMode).toBe(true);
    expect(reply.calls).toEqual([{ name: 'propose_edits', input: { edits: [{ id: 1, fields: { artist: 'X' }, reason: 'r' }] } }]);
  });
});

describe('OpenAI-style endpoint', () => {
  it('posts to {base}/chat/completions with a bearer token and function calling', async () => {
    const { fetchImpl, calls } = fake(openaiToolReply('propose_playlists', { playlists: [{ name: 'Run', ids: [1], reason: 'r' }] }));
    const reply = await callModel(openai, request, { fetchImpl });
    const [call] = calls as [Seen];
    expect(call.url).toBe('https://example.test/v1/chat/completions');
    expect(call.headers).toEqual({ Authorization: `Bearer ${KEY}`, 'content-type': 'application/json' });
    expect(call.body.model).toBe('some-model');
    expect(call.body.messages).toEqual([{ role: 'system', content: 'SYSTEM' }, { role: 'user', content: 'hello' }]);
    expect(call.body.tool_choice).toBe('required');
    expect(call.body.tools[2]).toEqual({ type: 'function', function: { name: 'answer', description: TOOLS[2]?.description, parameters: TOOLS[2]?.schema } });
    expect(reply.calls).toEqual([{ name: 'propose_playlists', input: { playlists: [{ name: 'Run', ids: [1], reason: 'r' }] } }]);
    expect(call.url).not.toContain(KEY);
  });

  it('uses the default OpenAI address form when given one', async () => {
    const { fetchImpl, calls } = fake(openaiToolReply('answer', { text: 'x' }));
    await callModel({ ...openai, baseUrl: 'https://api.openai.com/v1' }, request, { fetchImpl });
    expect(calls[0]?.url).toBe('https://api.openai.com/v1/chat/completions');
  });

  it('falls back to JSON text when tools are refused', async () => {
    const { fetchImpl, calls } = fake(json({ error: { message: "Unrecognized request argument supplied: tools" } }, 400), json({ choices: [{ finish_reason: 'stop', message: { content: '{"answer": {"text": "Two albums."}}' } }] }));
    const reply = await callModel(openai, request, { fetchImpl });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.body.tools).toBeUndefined();
    expect(calls[1]?.body.tool_choice).toBeUndefined();
    expect(calls[1]?.body.messages[0].content).toContain('Reply with a single JSON object');
    expect(reply.calls).toEqual([{ name: 'answer', input: { text: 'Two albums.' } }]);
    expect(reply.jsonMode).toBe(true);
  });

  it('reads JSON from plain text when the endpoint ignored the tools, and plain text as an answer', async () => {
    const one = await callModel(openai, request, { fetchImpl: fake(json({ choices: [{ finish_reason: 'stop', message: { content: 'Sure: {"propose_edits": {"edits": []}}' } }] })).fetchImpl });
    expect(one.calls).toEqual([{ name: 'propose_edits', input: { edits: [] } }]);
    const two = await callModel(openai, request, { fetchImpl: fake(json({ choices: [{ finish_reason: 'stop', message: { content: 'Your library looks fine.' } }] })).fetchImpl });
    expect(two.calls).toEqual([{ name: 'answer', input: { text: 'Your library looks fine.' } }]);
  });

  it('reports arguments cut off by the length limit', async () => {
    const { fetchImpl } = fake(openaiToolReply('propose_edits', '{"edits": [{"id": 1,', 'length'));
    await expect(callModel(openai, request, { fetchImpl })).rejects.toMatchObject({ kind: 'bad-reply', message: expect.stringContaining('ran out of room') });
  });

  it('says plainly when a base address is unusable, before any request', async () => {
    const { fetchImpl, calls } = fake(openaiToolReply('answer', { text: 'x' }));
    for (const baseUrl of ['not a url', 'http://example.test/v1', 'https://user:pw@example.test/v1', `https://example.test/v1?key=${KEY}`]) {
      const error = await failure(callModel({ ...openai, baseUrl }, request, { fetchImpl }));
      expect(error).toBeInstanceOf(ModelError);
      expect((error as ModelError).kind).toBe('setup');
      expect((error as ModelError).message).not.toContain(KEY);
    }
    expect(calls).toHaveLength(0);
  });
});

describe('addresses', () => {
  it('allows https, and http only for this computer', () => {
    expect(checkBaseUrl('https://api.openai.com/v1/')).toEqual({ ok: true, base: 'https://api.openai.com/v1', host: 'api.openai.com' });
    expect(checkBaseUrl('http://localhost:11434/v1')).toEqual({ ok: true, base: 'http://localhost:11434/v1', host: 'localhost:11434' });
    expect(checkBaseUrl('http://example.test/v1').ok).toBe(false);
    expect(checkBaseUrl('ftp://example.test').ok).toBe(false);
  });

  it('names the host the library would go to', () => {
    expect(hostOf(anthropic)).toBe('api.anthropic.com');
    expect(hostOf(openai)).toBe('example.test');
    expect(hostOf({ provider: 'openai', baseUrl: 'nope' })).toBeNull();
  });
});

describe('errors in plain language', () => {
  const failing = (response: Response | Error, config = anthropic) => failure(callModel(config, request, { fetchImpl: fake(response).fetchImpl }));

  it('401 says the key was wrong', async () => {
    const error = await failing(json({ error: { message: 'invalid x-api-key' } }, 401));
    expect(error).toMatchObject({ kind: 'auth', status: 401 });
    expect(error.message).toMatch(/did not accept the key/);
  });

  it('429 says rate limit', async () => {
    const error = await failing(json({ error: { message: 'slow down' } }, 429), openai);
    expect(error).toMatchObject({ kind: 'rate', status: 429 });
    expect(error.message).toMatch(/rate limit/);
    expect(error.message).toContain('example.test');
  });

  it('400 passes on what the service said', async () => {
    const error = await failing(json({ error: { message: 'model: unknown model "nope"' } }, 400));
    expect(error).toMatchObject({ kind: 'bad-request', status: 400, toolsRefused: false });
    expect(error.message).toContain('unknown model');
  });

  it('403, 404, 413 and 5xx each have their own message', async () => {
    expect((await failing(json({}, 403))).message).toMatch(/refused this key or model/);
    expect((await failing(json({}, 404))).message).toMatch(/does not exist/);
    expect((await failing(json({}, 413))).message).toMatch(/too big/);
    expect(await failing(json({ error: { message: 'overloaded' } }, 529))).toMatchObject({ kind: 'server' });
    expect(await failing(new Response('Bad gateway', { status: 502 }))).toMatchObject({ kind: 'server', message: expect.stringContaining('Bad gateway') });
  });

  it('a network or CORS failure says some endpoints do not allow browser calls', async () => {
    const error = await failing(new TypeError('Failed to fetch'), openai);
    expect(error).toMatchObject({ kind: 'network' });
    expect(error.message).toMatch(/Some endpoints do not allow calls from a web page/);
    expect(error.message).toContain('example.test');
  });

  it('a reply that is not JSON, or not the expected shape, is reported', async () => {
    expect(await failing(new Response('<html>', { status: 200 }))).toMatchObject({ kind: 'bad-reply' });
    expect(await failing(json({ nothing: true }))).toMatchObject({ kind: 'bad-reply' });
    expect(await failing(json({ content: [] }))).toMatchObject({ kind: 'bad-reply' });
  });

  it('never lets the key out, even when the service echoes it back', async () => {
    const echo = { error: { message: `Incorrect API key provided: ${KEY}. Authorization: Bearer ${KEY} sk-live-abcdef123456` } };
    for (const status of [400, 401, 403, 404, 429, 500]) {
      for (const config of [anthropic, openai]) {
        const error = await failing(json(echo, status), config);
        expect(error.message, `${status} ${config.provider}`).not.toContain(KEY);
        expect(error.message).not.toContain('sk-live-abcdef123456');
        expect(error.message).not.toMatch(/Bearer sk/);
      }
    }
    expect(scrub(`token ${KEY} here`, KEY)).toBe('token [key hidden] here');
    const plain = await failing(new Response(`oops ${KEY}`, { status: 500 }));
    expect(plain.message).not.toContain(KEY);
  });

  it('a thrown error from fetch that mentions the key does not leak it either', async () => {
    const { fetchImpl } = fake(new Error(`boom ${KEY}`));
    const error = await failure(callModel(anthropic, request, { fetchImpl }));
    expect(error.message).not.toContain(KEY);
  });
});

describe('stopping', () => {
  it('passes the abort signal to fetch and reports a stop', async () => {
    const controller = new AbortController();
    const fetchImpl: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
      });
    const pending = failure(callModel(anthropic, request, { fetchImpl, signal: controller.signal }));
    controller.abort();
    const error = await pending;
    expect(error).toMatchObject({ kind: 'abort', message: 'Stopped. Nothing was changed.' });
  });

  it('does not make a second request once stopped', async () => {
    const controller = new AbortController();
    const { fetchImpl, calls } = fake(json({ error: { message: 'tools not supported' } }, 400));
    const wrapped: FetchLike = async (url, init) => {
      controller.abort();
      return fetchImpl(url, init);
    };
    const error = await failure(callModel(anthropic, request, { fetchImpl: wrapped, signal: controller.signal }));
    expect(calls).toHaveLength(1);
    expect(error).toMatchObject({ kind: 'abort' });
  });
});

describe('reading JSON text', () => {
  it('finds the object in fences and prose, and tolerates missing wrapper keys', () => {
    expect(parseJsonReply('```json\n{"answer": {"text": "a"}}\n```')).toEqual([{ name: 'answer', input: { text: 'a' } }]);
    expect(parseJsonReply('{"edits": [{"id": 1}]}')).toEqual([{ name: 'propose_edits', input: { edits: [{ id: 1 }] } }]);
    expect(parseJsonReply('{"playlists": []}')).toEqual([{ name: 'propose_playlists', input: { playlists: [] } }]);
    expect(parseJsonReply('{"text": "t"}')).toEqual([{ name: 'answer', input: { text: 't' } }]);
  });

  it('returns nothing for text that is not a JSON object', () => {
    for (const text of ['', 'plain words', '{not json}', '[1,2]', '{"other": 1}']) expect(parseJsonReply(text)).toEqual([]);
  });
});
