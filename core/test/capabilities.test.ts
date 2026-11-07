import { describe, expect, it } from 'vitest';
import { detectCapabilities, parseBrowser, type EnvLike } from '../src/capabilities';

const DESKTOP_CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const ANDROID_CHROME_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Mobile Safari/537.36';

function fullEnv(overrides: Partial<EnvLike> = {}): EnvLike {
  return {
    isSecureContext: true,
    crossOriginIsolated: true,
    showDirectoryPicker: () => undefined,
    WebAssembly: {},
    SharedArrayBuffer: function SharedArrayBuffer() {},
    navigator: {
      userAgent: DESKTOP_CHROME_UA,
      usb: {},
      wakeLock: {},
      serviceWorker: {},
      storage: { getDirectory: () => undefined },
    },
    ...overrides,
  };
}

describe('detectCapabilities', () => {
  it('reports a fully capable desktop Chrome as ready with no blockers', () => {
    const report = detectCapabilities(fullEnv());
    expect(report.syncReady).toBe(true);
    expect(report.blockers).toEqual([]);
    expect(report.capabilities.every((capability) => capability.ok)).toBe(true);
  });

  it('blocks syncing when the folder picker is missing, as on older Chrome for Android', () => {
    const report = detectCapabilities(
      fullEnv({
        showDirectoryPicker: undefined,
        navigator: { userAgent: ANDROID_CHROME_UA, usb: {}, wakeLock: {}, serviceWorker: {}, storage: { getDirectory: () => undefined } },
      }),
    );
    expect(report.syncReady).toBe(false);
    expect(report.blockers.map((blocker) => blocker.id)).toEqual(['folderPicker']);
    expect(report.blockers[0]?.fix).toMatch(/Chrome/);
  });

  it('blocks syncing on an insecure page even if the APIs exist', () => {
    const report = detectCapabilities(fullEnv({ isSecureContext: false }));
    expect(report.blockers.map((blocker) => blocker.id)).toContain('secureContext');
    expect(report.syncReady).toBe(false);
  });

  it('does not block on optional capabilities', () => {
    const report = detectCapabilities(
      fullEnv({
        crossOriginIsolated: false,
        navigator: { userAgent: DESKTOP_CHROME_UA, usb: {} },
      }),
    );
    expect(report.syncReady).toBe(true);
    const missing = report.capabilities.filter((capability) => !capability.ok).map((capability) => capability.id);
    expect(missing).toEqual(['originPrivateFs', 'crossOriginIsolated', 'wakeLock', 'serviceWorker']);
  });

  it('requires SharedArrayBuffer as well as the isolation flag', () => {
    const report = detectCapabilities(fullEnv({ SharedArrayBuffer: undefined }));
    expect(report.capabilities.find((capability) => capability.id === 'crossOriginIsolated')?.ok).toBe(false);
  });

  it('treats an empty environment as not ready without throwing', () => {
    const report = detectCapabilities({});
    expect(report.syncReady).toBe(false);
    expect(report.blockers).toHaveLength(4);
  });
});

describe('parseBrowser', () => {
  it('reads Chrome on Android', () => {
    expect(parseBrowser({ userAgent: ANDROID_CHROME_UA })).toEqual({
      name: 'Chrome',
      major: 132,
      mobile: true,
      platform: 'Android',
    });
  });

  it('reads desktop Chrome on macOS', () => {
    expect(parseBrowser({ userAgent: DESKTOP_CHROME_UA })).toEqual({
      name: 'Chrome',
      major: 141,
      mobile: false,
      platform: 'macOS',
    });
  });

  it('tells Edge from Chrome', () => {
    const edge = `${DESKTOP_CHROME_UA} Edg/141.0.0.0`;
    expect(parseBrowser({ userAgent: edge }).name).toBe('Edge');
  });

  it('prefers userAgentData when the browser provides it', () => {
    const info = parseBrowser({ userAgent: DESKTOP_CHROME_UA, userAgentData: { mobile: true, platform: 'Android' } });
    expect(info.mobile).toBe(true);
    expect(info.platform).toBe('Android');
  });

  it('identifies Firefox and Safari so the app can explain they lack WebUSB', () => {
    expect(parseBrowser({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0' }).name).toBe('Firefox');
    expect(
      parseBrowser({
        userAgent:
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      }),
    ).toEqual({ name: 'Safari', major: 17, mobile: true, platform: 'iOS' });
  });

  it('returns Unknown for a missing navigator', () => {
    expect(parseBrowser(undefined)).toEqual({ name: 'Unknown', major: null, mobile: false, platform: null });
  });
});
