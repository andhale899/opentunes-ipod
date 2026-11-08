import { DEFAULT_BASE_URL, type ProviderId } from './providers';
import { MAX_TRACKS_PER_REQUEST } from './digest';

/**
 * Ready-made choices for the assistant's "service" box, so nobody has to know a base address or a
 * model name. Free services come first and the first one is the default. Each still needs the
 * person's own key: a key shipped inside a public web page would be taken and used up by anyone.
 */
export interface Preset {
  id: string;
  label: string;
  provider: ProviderId;
  baseUrl: string;
  /** A model to start with, or '' when the list should be loaded and one picked. */
  model: string;
  free: boolean;
  /** Where to get a key. */
  keyUrl: string | null;
  /** One plain sentence on what to expect. */
  note: string;
  /** Tracks sent in one request. Free tiers allow only a few thousand tokens a minute, so this is small. */
  maxTracks: number;
  /** Keeps a long list of models to the ones that make sense. */
  modelFilter?: (id: string) => boolean;
}

export const PRESETS: Preset[] = [
  {
    id: 'groq',
    label: 'Groq (free tier)',
    provider: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'openai/gpt-oss-120b',
    free: true,
    keyUrl: 'https://console.groq.com/keys',
    note: 'Free with a key and no card. The free plan allows only about 8,000 tokens a minute, so the assistant sends about 100 tracks at a time. Filter the library first.',
    maxTracks: 100,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter (free models)',
    provider: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: '',
    free: true,
    keyUrl: 'https://openrouter.ai/keys',
    note: 'Free models only (their names end in :free), about 20 requests a minute and 50 a day. The free list changes often, so load it and pick one.',
    maxTracks: 200,
    modelFilter: (id) => id.endsWith(':free'),
  },
  {
    id: 'gemini',
    label: 'Google Gemini (free tier)',
    provider: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.5-flash',
    free: true,
    keyUrl: 'https://aistudio.google.com/apikey',
    note: 'Free with a key from AI Studio. On the free tier Google may use what you send to improve its products. Check AI Studio for the current limits.',
    maxTracks: 400,
  },
  {
    id: 'ollama',
    label: 'Ollama on this computer (free, private)',
    provider: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    model: '',
    free: true,
    keyUrl: 'https://ollama.com/download',
    note: 'Runs on your own computer, so nothing leaves it. Start Ollama with OLLAMA_ORIGINS set to this page\'s address or the browser will block the call, and use a model that supports tools. Type any text as the key.',
    maxTracks: 150,
  },
  {
    id: 'anthropic',
    label: 'Anthropic (Claude, paid)',
    provider: 'anthropic',
    baseUrl: DEFAULT_BASE_URL,
    model: 'claude-sonnet-5-5',
    free: false,
    keyUrl: 'https://console.anthropic.com/settings/keys',
    note: 'Paid, and the best at following the structured steps. A Haiku model is cheaper for simple tidy-ups.',
    maxTracks: MAX_TRACKS_PER_REQUEST,
  },
  {
    id: 'openai',
    label: 'OpenAI (paid)',
    provider: 'openai',
    baseUrl: DEFAULT_BASE_URL,
    model: '',
    free: false,
    keyUrl: 'https://platform.openai.com/api-keys',
    note: 'Paid. Load the list and pick a chat model such as gpt-4o or gpt-4.1.',
    maxTracks: MAX_TRACKS_PER_REQUEST,
  },
  {
    id: 'custom',
    label: 'Any other OpenAI-style address',
    provider: 'openai',
    baseUrl: '',
    model: '',
    free: false,
    keyUrl: null,
    note: 'Type the address and the model name your service uses.',
    maxTracks: 400,
  },
];

/** The preset the settings are using now: the one with the same service and address, else 'custom'. */
export function presetFor(settings: { provider: ProviderId; baseUrl: string }): Preset {
  const wanted = settings.baseUrl.trim().replace(/\/+$/, '');
  const found = PRESETS.find((preset) => preset.id !== 'custom' && preset.provider === settings.provider && (preset.provider === 'anthropic' || preset.baseUrl === wanted));
  return found ?? (PRESETS.find((preset) => preset.id === 'custom') as Preset);
}

export const DEFAULT_PRESET: Preset = PRESETS[0] as Preset;
