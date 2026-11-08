import { describe, expect, it } from 'vitest';
import { ModelError, listModels, type FetchLike } from '../../src/ai/providers';

const KEY = 'sk-test-0000-model-list';

function fake(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
  return { calls, fetchImpl };
}

describe('asking a service which models a key can use', () => {
  it('reads Anthropic models with the browser header and keeps their friendly names, newest first', async () => {
    const { calls, fetchImpl } = fake(200, { data: [{ id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5' }, { id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5' }] });
    const list = await listModels({ provider: 'anthropic', apiKey: KEY, baseUrl: '' }, { fetchImpl });
    expect(list.map((choice) => choice.id)).toEqual(['claude-sonnet-5-5', 'claude-haiku-5-5']);
    expect(list[0]?.label).toBe('Claude Sonnet 5.5 (claude-sonnet-5-5)');
    expect(calls[0]?.url).toBe('https://api.anthropic.com/v1/models?limit=1000');
    expect(calls[0]?.init.method).toBe('GET');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe(KEY);
    expect(headers['anthropic-dangerous-direct-browser-access']).toBe('true');
    expect(calls[0]?.url).not.toContain(KEY);
  });

  it('keeps only chat models from api.openai.com, sorted so newer names come first', async () => {
    const { calls, fetchImpl } = fake(200, { data: [{ id: 'text-embedding-3-small' }, { id: 'gpt-4o' }, { id: 'whisper-1' }, { id: 'gpt-4o-mini' }, { id: 'o3-mini' }, { id: 'dall-e-3' }, { id: 'tts-1' }] });
    const list = await listModels({ provider: 'openai', apiKey: KEY, baseUrl: 'https://api.openai.com/v1' }, { fetchImpl });
    expect(list.map((choice) => choice.id)).toEqual(['o3-mini', 'gpt-4o-mini', 'gpt-4o']);
    expect(calls[0]?.url).toBe('https://api.openai.com/v1/models');
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
  });

  it('does not filter the list of another endpoint', async () => {
    const { fetchImpl } = fake(200, { data: [{ id: 'llama3.1:8b' }, { id: 'nomic-embed-text' }] });
    const list = await listModels({ provider: 'openai', apiKey: KEY, baseUrl: 'https://llm.example.com/v1' }, { fetchImpl });
    expect(list.map((choice) => choice.id).sort()).toEqual(['llama3.1:8b', 'nomic-embed-text']);
  });

  it('says what went wrong in plain words and never repeats the key', async () => {
    const wrongKey = fake(401, { error: { message: `Incorrect API key provided: ${KEY}` } });
    const error = await listModels({ provider: 'openai', apiKey: KEY, baseUrl: 'https://api.openai.com/v1' }, { fetchImpl: wrongKey.fetchImpl }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ModelError);
    expect((error as ModelError).kind).toBe('auth');
    expect((error as ModelError).message).not.toContain(KEY);

    const blocked: FetchLike = async () => {
      throw new TypeError('Failed to fetch');
    };
    await expect(listModels({ provider: 'openai', apiKey: KEY, baseUrl: 'https://llm.example.com/v1' }, { fetchImpl: blocked })).rejects.toThrow(/type the model name yourself/);
  });

  it('asks for a key first, and says so when nothing usable comes back', async () => {
    await expect(listModels({ provider: 'anthropic', apiKey: '', baseUrl: '' })).rejects.toBeInstanceOf(ModelError);
    const empty = fake(200, { data: [] });
    await expect(listModels({ provider: 'anthropic', apiKey: KEY, baseUrl: '' }, { fetchImpl: empty.fetchImpl })).rejects.toThrow(/did not list any models/);
  });
});
