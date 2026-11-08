import { useRef, useState } from 'preact/hooks';
import { checkBaseUrl, type ModelChoice, type ProviderId } from './providers';
import type { Settings } from './settings';

/**
 * Which service to use, the key, the model, and the opt-in to send the library. The key box is
 * never given a value, so a key typed or saved earlier is never written back into the page.
 */
export function AssistantSettings({
  settings,
  onSettings,
  keyIsSet,
  onKey,
  keyBox,
  onForget,
  optIn,
  onOptIn,
  host,
  storageFailed,
  onLoadModels,
}: {
  settings: Settings;
  onSettings: (patch: Partial<Settings>) => void;
  keyIsSet: boolean;
  onKey: (text: string) => void;
  /** Changes when the key box should be emptied (the provider changed, or the key was forgotten). */
  keyBox: string;
  onForget: () => void;
  optIn: boolean;
  onOptIn: (on: boolean) => void;
  host: string | null;
  storageFailed: boolean;
  /** Asks the service for the models this key can use. Rejects with a plain message. */
  onLoadModels?: (signal: AbortSignal) => Promise<ModelChoice[]>;
}) {
  const [choices, setChoices] = useState<ModelChoice[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const loading_ = useRef<AbortController | null>(null);
  const { provider } = settings;
  const address = provider === 'openai' ? checkBaseUrl(settings.baseUrl) : null;

  return (
    <div class="ai-settings">
      <div class="ai-settings-grid">
        <label class="field">
          Service
          <select value={provider} onChange={(event) => onSettings({ provider: (event.target as HTMLSelectElement).value as ProviderId })}>
            <option value="anthropic">Anthropic (Claude)</option>
            <option value="openai">Any OpenAI-style endpoint</option>
          </select>
        </label>
        {provider === 'openai' ? (
          <label class="field">
            Base address
            <input type="text" value={settings.baseUrl} spellcheck={false} autocomplete="off" onInput={(event) => onSettings({ baseUrl: (event.target as HTMLInputElement).value })} />
            {address && !address.ok ? <span class="ai-problem">{address.error}</span> : null}
          </label>
        ) : null}
        <label class="field">
          API key
          <input key={keyBox} type="password" name="opentunes-ai-key" autocomplete="off" spellcheck={false} placeholder={keyIsSet ? 'A key is set (not shown)' : 'Paste your key'} onInput={(event) => onKey((event.target as HTMLInputElement).value)} />
        </label>
        <div class="field">
          Model
          <div class="model-row">
            {choices.length ? (
              <select
                aria-label="Model"
                value={choices.some((choice) => choice.id === settings.models[provider]) ? settings.models[provider] : ''}
                onChange={(event) => {
                  const picked = (event.target as HTMLSelectElement).value;
                  if (picked) onSettings({ models: { ...settings.models, [provider]: picked } });
                }}
              >
                <option value="">Pick a model...</option>
                {choices.map((choice) => (
                  <option key={choice.id} value={choice.id}>
                    {choice.label}
                  </option>
                ))}
              </select>
            ) : null}
            <button
              type="button"
              class="secondary small"
              disabled={!keyIsSet || loading || !onLoadModels}
              onClick={() => {
                if (!onLoadModels) return;
                const controller = new AbortController();
                loading_.current = controller;
                setLoading(true);
                setLoadError('');
                onLoadModels(controller.signal)
                  .then((list) => setChoices(list))
                  .catch((error: unknown) => setLoadError(controller.signal.aborted ? 'Stopped. The list was not loaded.' : error instanceof Error ? error.message : 'Could not load the list.'))
                  .finally(() => {
                    setLoading(false);
                    loading_.current = null;
                  });
              }}
            >
              {loading ? 'Loading...' : choices.length ? 'Reload the list' : 'Load the list from the service'}
            </button>
            {loading ? (
              <button type="button" class="ghost small" onClick={() => loading_.current?.abort()}>
                Stop
              </button>
            ) : null}
          </div>
          <input type="text" aria-label="Model name" value={settings.models[provider]} spellcheck={false} autocomplete="off" placeholder={provider === 'openai' ? 'Or type the model name your endpoint uses' : 'Or type a model name, for example claude-sonnet-5-5'} onInput={(event) => onSettings({ models: { ...settings.models, [provider]: (event.target as HTMLInputElement).value } })} />
          {loadError ? <span class="ai-problem" role="alert">{loadError}</span> : null}
          <span class="note">
            {keyIsSet ? 'The list is read from the service with your key. It costs nothing and sends no library data.' : 'Paste a key first, then the list can be loaded.'}
            {provider === 'anthropic' ? ' A Haiku model is cheaper for simple tidy-ups.' : ''}
          </span>
        </div>
      </div>

      <p class="note" role="status">
        {keyIsSet ? 'A key is set. It stays in this tab only' + (settings.remember ? ', and is also saved in this browser.' : ' and is gone when the page closes.') : 'No key set yet.'}
      </p>
      <div class="ai-key-actions">
        <label class="check">
          <input type="checkbox" checked={settings.remember} onChange={(event) => onSettings({ remember: (event.target as HTMLInputElement).checked })} />
          Remember the key in this browser
        </label>
        <button type="button" class="ghost small" onClick={onForget} disabled={!keyIsSet && !settings.remember}>
          Forget the key
        </button>
      </div>
      {settings.remember ? (
        <p class="callout warn">
          The key is saved in this browser's local storage. Anyone who uses this browser profile can read it.
          {storageFailed ? ' This browser would not save it, so it stays in this tab only.' : ''}
        </p>
      ) : null}

      <label class="check ai-optin">
        <input type="checkbox" checked={optIn} onChange={(event) => onOptIn((event.target as HTMLInputElement).checked)} />
        <span>
          Send my library's titles, artists, albums and genres (no audio, no file paths) to <strong>{host ?? 'the address above (fix it first)'}</strong> when I ask the assistant something.
        </span>
      </label>
      <p class="note">Each track's kind, year and track number go with them, and so does what you type. Nothing is sent until you press Ask, and this box starts off every time the page loads.</p>
    </div>
  );
}
