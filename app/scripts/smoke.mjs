// Browser smoke test: serves the built app, opens the demo iPod in headless Chrome, and
// checks the engine really ran there (WebAssembly loaded, a database built, written and
// read back, and the page rendered it).
//
//   npm run smoke
//
// Needs a built app (`npm run build`, which also copies in the engine and ffmpeg) and Chrome or
// Chromium. Set CHROME_BIN to use a particular browser.
//
// Most scenarios use Chrome's virtual time (`--virtual-time-budget`, 20 seconds), which is
// fine for code that runs on the page. It cannot wait for a web worker: with the converter it
// dumped the page after under a second whatever the budget (tried 20 and 120 seconds), because
// virtual time moves on whenever the page itself is idle, and the page is idle while the worker
// works. So the converter scenario (`devtools: true`) drives Chrome over the DevTools protocol
// instead, in real time, and waits until the page says it is done. That needs Node 22 or newer
// for the built-in WebSocket (CI uses 22 and 24).

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  {
    // Real converter, real worker, real ffmpeg.wasm, on files the page generates. Each case reads
    // its own output back with ffprobe. See app/src/convert/selftest.ts. Runs with no network
    // except localhost, so loading anything from a CDN would fail it.
    name: 'the converter (tone to AAC and Apple Lossless, video to H.264, audiobook merge, cancel, error; no network but localhost)',
    url: `http://localhost:${port}/?selftest=convert`,
    devtools: { doneSelector: '[data-done="true"]', timeoutMs: 120_000 },
    show: /^convert .*$/gm,
    expected: [
      'convert audio-aac: ok',
      'ftyp M4A , codec mp4a',
      'convert audio-alac: ok',
      'codec alac',
      'convert audio-m4b-chapters-cover-tags: ok',
      'chpl, covr, stik',
      'convert video-h264: ok',
      'ftyp M4V , codec avc1',
      'h264 Constrained Baseline level 3.0',
      'convert merge-m4b: ok',
      'convert cancel: ok',
      'convert error-message: ok',
      'convert self test: all cases ok',
    ],
    forbidden: ['FAILED', 'cases failed'],
    alert: false,
  },
];

/**
 * Opens a page in headless Chrome over the DevTools protocol and returns its HTML once an element
 * matching `doneSelector` exists, or after `timeoutMs`. Real time, no virtual clock.
 */
async function dumpWithDevTools(chromePath, url, { doneSelector, timeoutMs }) {
  if (typeof WebSocket !== 'function') throw new Error('This scenario needs Node 22 or newer (it uses the built-in WebSocket).');
  const profile = mkdtempSync(join(tmpdir(), 'opentunes-smoke-'));
  // Every host except this machine cannot be resolved, so the page passes only if it needs nothing
  // from the internet. (ffmpeg.wasm's own default is a CDN address, which the converter never uses.)
  const flags = ['--headless=new', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1'];
  if (process.env.CI) flags.push('--no-sandbox');
  const browser = spawn(chromePath, [...flags, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  try {
    const port = await new Promise((resolve, reject) => {
      let text = '';
      const timer = setTimeout(() => reject(new Error('Chrome did not report its DevTools port.')), 15_000);
      browser.stderr.on('data', (chunk) => {
        text += chunk;
        const match = text.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
        if (match) {
          clearTimeout(timer);
          resolve(Number(match[1]));
        }
      });
      browser.once('exit', () => reject(new Error('Chrome exited before it was ready.')));
    });
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = pages.find((entry) => entry.type === 'page');
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = () => reject(new Error('Could not connect to Chrome DevTools.'));
    });
    let nextId = 1;
    const waiting = new Map();
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && waiting.has(message.id)) {
        waiting.get(message.id)(message);
        waiting.delete(message.id);
      }
    };
    const send = (method, params = {}) =>
      new Promise((resolve) => {
        const id = nextId++;
        waiting.set(id, resolve);
        socket.send(JSON.stringify({ id, method, params }));
      });
    const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result?.result?.value;

    await send('Page.navigate', { url });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      if (await evaluate(`Boolean(document.querySelector(${JSON.stringify(doneSelector)}))`)) break;
    }
    const html = await evaluate('document.documentElement.outerHTML');
    socket.close();
    return html ?? '';
  } finally {
    const exited = new Promise((resolve) => browser.once('exit', resolve));
    browser.kill();
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

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
if (!existsSync(`${appDirectory}dist/ffmpeg/ffmpeg-core.wasm`)) {
  console.error('dist/ffmpeg/ffmpeg-core.wasm is missing. Run `npm run build`, which copies it from node_modules.');
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
    const dom = scenario.devtools
      ? await dumpWithDevTools(chrome, scenario.url, scenario.devtools)
      : execFileSync(chrome, [...flags, scenario.url], { encoding: 'utf8', timeout: 90_000, stdio: ['ignore', 'pipe', 'ignore'] });
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
    // Scenarios that print their own result lines on the page show them, passed or not.
    if (scenario.show) for (const line of dom.match(scenario.show) ?? []) console.log(`  ${line}`);
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
