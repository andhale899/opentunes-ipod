// Browser smoke test: serves the built app, opens the demo iPod in headless Chrome, and
// checks the engine really ran there (WebAssembly loaded, a database built, written and
// read back, and the page rendered it).
//
//   npm run smoke
//
// Needs a built app (`npm run build`, which also copies in the engine) and Chrome or
// Chromium. Set CHROME_BIN to use a particular browser.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const appDirectory = fileURLToPath(new URL('..', import.meta.url));
// SMOKE_PORT lets several checkouts run the smoke test at the same time.
const port = Number(process.env.SMOKE_PORT ?? 4179);

const SCENARIOS = [
  {
    name: 'a demo iPod with one of each kind',
    url: `http://localhost:${port}/?demo=1`,
    expected: ['Demo iPod', '5 tracks, 3 playlists', 'Morning Light', 'Episode 12: Engines', 'A Short Story', 'Demo Film', 'Road trip', 'Audiobook', 'Podcast', 'Files read from the iPod', 'Check what a rewrite would change'],
    forbidden: ['Signature on', 'Back up the database files'],
    alert: false,
  },
  {
    name: 'a nano 7G-style iPod with signed databases',
    url: `http://localhost:${port}/?demo=signed&rewrite=1`,
    expected: [
      'Demo nano 7G',
      '5 tracks, 3 playlists',
      'Signed with hashAB',
      'Signature on iTunesCDB',
      'Signature on Locations.itdb.cbk',
      'Matches what the engine computes',
      '2 files libgpod never opens',
      'not read: libgpod never opens it',
      'No differences found',
      'Signature on iTunesCDB after the rewrite',
      'Copy rewrite report',
    ],
    forbidden: ['Does not match', 'Could not be checked', 'differences found. A sync'],
    alert: false,
  },
  {
    name: 'a panel that fails to draw, caught by its boundary',
    url: `http://localhost:${port}/?selftest=boundary`,
    expected: ['The "Self test" panel could not be drawn: this panel was made to fail', 'Reload the page before using it again'],
    forbidden: [],
    alert: true,
  },
  {
    name: 'an iPod that was never synced',
    url: `http://localhost:${port}/?demo=unsynced`,
    expected: ['never been synced', 'Copy diagnostic report', 'Files read from the iPod'],
    forbidden: [],
    alert: true,
  },
];

function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  return candidates.find((path) => path && existsSync(path));
}

async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://localhost:${port}/`);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('The preview server did not start.');
}

const chrome = findChrome();
if (!chrome) {
  console.error('No Chrome or Chromium found. Install one, or set CHROME_BIN.');
  process.exit(1);
}
if (!existsSync(`${appDirectory}dist/engine/engine.wasm`)) {
  console.error('dist/engine/engine.wasm is missing. Run `npm run engine:build`, then `npm run build`.');
  process.exit(1);
}

const vite = fileURLToPath(new URL('../../node_modules/vite/bin/vite.js', import.meta.url));
const server = spawn(process.execPath, [vite, 'preview', '--port', String(port), '--strictPort'], {
  cwd: appDirectory,
  stdio: 'ignore',
});

let failed = false;
try {
  await waitForServer();
  const flags = ['--headless=new', '--disable-gpu', '--virtual-time-budget=20000', '--dump-dom'];
  if (process.env.CI) flags.push('--no-sandbox');

  for (const scenario of SCENARIOS) {
    const dom = execFileSync(chrome, [...flags, scenario.url], { encoding: 'utf8', timeout: 90_000, stdio: ['ignore', 'pipe', 'ignore'] });
    const missing = scenario.expected.filter((text) => !dom.includes(text));
    const present = scenario.forbidden.filter((text) => dom.includes(text));
    const hasAlert = dom.includes('role="alert"');
    if (missing.length) {
      failed = true;
      console.error(`${scenario.name}: the page is missing: ${missing.join(', ')}`);
    }
    if (present.length) {
      failed = true;
      console.error(`${scenario.name}: the page should not show: ${present.join(', ')}`);
    }
    if (hasAlert !== scenario.alert) {
      failed = true;
      console.error(`${scenario.name}: expected ${scenario.alert ? 'an error message' : 'no error message'} on the page.`);
    }
    if (!missing.length && !present.length && hasAlert === scenario.alert) {
      console.log(`Smoke test passed for ${scenario.name}.`);
    }
  }
} catch (error) {
  failed = true;
  console.error(error instanceof Error ? error.message : error);
} finally {
  server.kill();
}
process.exit(failed ? 1 : 0);
