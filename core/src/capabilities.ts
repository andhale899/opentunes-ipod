/**
 * Browser capability detection.
 *
 * OpenTunes needs a handful of browser features to talk to an iPod. This module
 * decides, from a plain description of the environment, which are present and
 * what a person can do about the ones that are missing. It takes the environment
 * as an argument (instead of reading `window`) so it can be tested with fakes.
 */

export type CapabilityId =
  | 'secureContext'
  | 'webUsb'
  | 'folderPicker'
  | 'webAssembly'
  | 'originPrivateFs'
  | 'crossOriginIsolated'
  | 'wakeLock'
  | 'serviceWorker';

export interface Capability {
  id: CapabilityId;
  label: string;
  ok: boolean;
  /** A missing required capability blocks syncing; a missing optional one only limits a feature. */
  required: boolean;
  /** What the feature is used for, in plain language. */
  meaning: string;
  /** What to do when it is missing, or null when it is present or there is nothing to do. */
  fix: string | null;
}

export interface BrowserInfo {
  name: string;
  major: number | null;
  mobile: boolean;
  platform: string | null;
}

export interface CapabilityReport {
  browser: BrowserInfo;
  capabilities: Capability[];
  blockers: Capability[];
  syncReady: boolean;
}

export interface NavigatorLike {
  userAgent?: string;
  userAgentData?: { mobile?: boolean; platform?: string };
  usb?: unknown;
  wakeLock?: unknown;
  serviceWorker?: unknown;
  storage?: { getDirectory?: unknown };
}

export interface EnvLike {
  isSecureContext?: boolean;
  crossOriginIsolated?: boolean;
  showDirectoryPicker?: unknown;
  WebAssembly?: unknown;
  SharedArrayBuffer?: unknown;
  navigator?: NavigatorLike;
}

const present = (value: unknown): boolean => value !== undefined && value !== null;

function guessPlatform(ua: string): string | null {
  if (/CrOS/.test(ua)) return 'ChromeOS';
  if (/Android/.test(ua)) return 'Android';
  if (/iPhone|iPad|iPod/.test(ua)) return 'iOS';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Macintosh|Mac OS X/.test(ua)) return 'macOS';
  if (/Linux/.test(ua)) return 'Linux';
  return null;
}

/** Reads the browser name and major version from the user agent. Brave reports itself as Chrome. */
export function parseBrowser(nav: NavigatorLike | undefined): BrowserInfo {
  const ua = nav?.userAgent ?? '';
  const mobile = nav?.userAgentData?.mobile ?? /Android|Mobile|iPhone|iPad/i.test(ua);
  const platform = nav?.userAgentData?.platform ?? guessPlatform(ua);
  const major = (re: RegExp): number | null => {
    const match = re.exec(ua);
    return match?.[1] ? Number(match[1]) : null;
  };

  if (/Edg\//.test(ua)) return { name: 'Edge', major: major(/Edg\/(\d+)/), mobile, platform };
  if (/OPR\//.test(ua)) return { name: 'Opera', major: major(/OPR\/(\d+)/), mobile, platform };
  if (/SamsungBrowser\//.test(ua)) {
    return { name: 'Samsung Internet', major: major(/SamsungBrowser\/(\d+)/), mobile, platform };
  }
  if (/Firefox\//.test(ua)) return { name: 'Firefox', major: major(/Firefox\/(\d+)/), mobile, platform };
  if (/Chrome\//.test(ua) || /CriOS\//.test(ua)) {
    return { name: 'Chrome', major: major(/(?:Chrome|CriOS)\/(\d+)/), mobile, platform };
  }
  if (/Safari\//.test(ua)) return { name: 'Safari', major: major(/Version\/(\d+)/), mobile, platform };
  return { name: 'Unknown', major: null, mobile, platform };
}

export function detectCapabilities(env: EnvLike): CapabilityReport {
  const nav = env.navigator;

  const capabilities: Capability[] = [
    {
      id: 'secureContext',
      label: 'Secure page (HTTPS or localhost)',
      ok: env.isSecureContext === true,
      required: true,
      meaning: 'Chrome only offers USB and folder access to secure pages.',
      fix: 'Open the app over HTTPS or at http://localhost. A plain http://192.168.x.x address does not count, see docs/ANDROID-TESTING.md.',
    },
    {
      id: 'webUsb',
      label: 'WebUSB',
      ok: present(nav?.usb),
      required: true,
      meaning: "Reads the iPod's serial number and FireWire ID, which newer models need before their database can be written.",
      fix: 'Use Chrome or Edge. Safari, Firefox and iOS browsers do not support WebUSB.',
    },
    {
      id: 'folderPicker',
      label: 'Folder access (File System Access)',
      ok: present(env.showDirectoryPicker),
      required: true,
      meaning: "Lets you choose the iPod's drive so the app can write music and the database to it.",
      fix: 'Use desktop Chrome or Edge. For Chrome on Android, update Chrome: a status listing says support starts at version 132, which is unconfirmed.',
    },
    {
      id: 'webAssembly',
      label: 'WebAssembly',
      ok: present(env.WebAssembly),
      required: true,
      meaning: 'Runs the iPod database engine.',
      fix: 'Use a current version of Chrome or Edge.',
    },
    {
      id: 'originPrivateFs',
      label: 'Browser-private storage (OPFS)',
      ok: present(nav?.storage?.getDirectory),
      required: false,
      meaning: 'Backs the Demo iPod, which lets you try the app without any hardware.',
      fix: 'Update the browser. Without it the Demo iPod is unavailable.',
    },
    {
      id: 'crossOriginIsolated',
      label: 'Cross-origin isolation',
      ok: env.crossOriginIsolated === true && present(env.SharedArrayBuffer),
      required: false,
      meaning: 'Allows fast multi-threaded conversion. Conversion still works without it, only slower.',
      fix: 'The dev server sets this automatically. A hosted copy needs the right response headers or a service worker.',
    },
    {
      id: 'wakeLock',
      label: 'Screen wake lock',
      ok: present(nav?.wakeLock),
      required: false,
      meaning: 'Keeps the screen on during a long sync so a phone does not suspend the transfer.',
      fix: 'Update the browser. Without it, keep the screen on by hand while syncing.',
    },
    {
      id: 'serviceWorker',
      label: 'Service worker',
      ok: present(nav?.serviceWorker),
      required: false,
      meaning: 'Needed to install the app to the home screen and to work offline.',
      fix: 'Use a secure page and a current browser.',
    },
  ];

  const blockers = capabilities.filter((capability) => capability.required && !capability.ok);

  return {
    browser: parseBrowser(nav),
    capabilities,
    blockers,
    syncReady: blockers.length === 0,
  };
}
