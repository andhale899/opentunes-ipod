import { describe, expect, it } from 'vitest';
import { DEFAULT_PRESET, PRESETS, presetFor } from '../../src/ai/presets';
import { checkBaseUrl } from '../../src/ai/providers';
import { defaultSettings } from '../../src/ai/settings';

describe('service presets', () => {
  it('starts on a free service, and never ships a key', () => {
    expect(DEFAULT_PRESET.free).toBe(true);
    expect(defaultSettings().baseUrl).toBe(DEFAULT_PRESET.baseUrl);
    expect(JSON.stringify(PRESETS)).not.toMatch(/\bsk-[A-Za-z0-9_-]{8,}|gsk_[A-Za-z0-9]{8,}|AIza[0-9A-Za-z_-]{20,}/);
  });

  it('has an address this app will accept for every preset that sets one, and a sane request size', () => {
    for (const preset of PRESETS) {
      if (preset.baseUrl && preset.provider === 'openai') expect(checkBaseUrl(preset.baseUrl).ok, preset.id).toBe(true);
      expect(preset.maxTracks).toBeGreaterThan(0);
      expect(preset.id).toBeTruthy();
    }
    expect(new Set(PRESETS.map((preset) => preset.id)).size).toBe(PRESETS.length);
  });

  it('keeps free tiers to small requests, because they allow few tokens a minute', () => {
    const groq = PRESETS.find((preset) => preset.id === 'groq');
    expect(groq?.maxTracks).toBeLessThanOrEqual(120);
    expect(PRESETS.find((preset) => preset.id === 'anthropic')?.maxTracks).toBeGreaterThan(1000);
  });

  it('works out which preset the settings are using, with a trailing slash or none', () => {
    expect(presetFor({ provider: 'openai', baseUrl: 'https://api.groq.com/openai/v1/' }).id).toBe('groq');
    expect(presetFor({ provider: 'openai', baseUrl: 'https://api.openai.com/v1' }).id).toBe('openai');
    expect(presetFor({ provider: 'anthropic', baseUrl: 'anything' }).id).toBe('anthropic');
    expect(presetFor({ provider: 'openai', baseUrl: 'https://llm.example.com/v1' }).id).toBe('custom');
  });

  it('only lists :free models for OpenRouter', () => {
    const filter = PRESETS.find((preset) => preset.id === 'openrouter')?.modelFilter;
    expect(filter?.('meta-llama/llama-3.3-70b-instruct:free')).toBe(true);
    expect(filter?.('openai/gpt-4o')).toBe(false);
  });
});
