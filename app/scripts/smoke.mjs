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
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDirectory = fileURLToPath(new URL('..', import.meta.url));
// SMOKE_PORT lets several checkouts run the smoke test at the same time.
const port = Number(process.env.SMOKE_PORT ?? 4179);

/** A short stereo tone as a WAV file, written to `path`. 16-bit at 44.1 kHz plays on the iPod as it is, 24-bit at 96 kHz must be converted. */
function writeTone(path, { rate, bits, seconds }) {
  const bytesPer = bits / 8;
  const frames = rate * seconds;
  const data = Buffer.alloc(frames * 2 * bytesPer);
  for (let i = 0; i < frames; i += 1) {
    const sample = Math.sin((2 * Math.PI * 440 * i) / rate) * 0.3;
    for (let channel = 0; channel < 2; channel += 1) {
      const at = (i * 2 + channel) * bytesPer;
      if (bits === 16) data.writeInt16LE(Math.round(sample * 32767), at);
      else data.writeIntLE(Math.round(sample * 8388607), at, 3);
    }
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2 * bytesPer, 28);
  header.writeUInt16LE(2 * bytesPer, 32);
  header.writeUInt16LE(bits, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([header, data]));
}

const toneFolder = mkdtempSync(join(tmpdir(), 'opentunes-tones-'));
const TONE_COPY = join(toneFolder, 'smoke tone copy.wav');
const TONE_CONVERT = join(toneFolder, 'smoke tone convert.wav');
writeTone(TONE_COPY, { rate: 44100, bits: 16, seconds: 2 });
writeTone(TONE_CONVERT, { rate: 96000, bits: 24, seconds: 1 });

const SCENARIOS = [
  {
    name: 'a demo iPod with one of each kind (library tab)',
    url: `http://localhost:${port}/?demo=1`,
    expected: ['Demo iPod', '5 tracks, 3 playlists', 'Morning Light', 'Episode 12: Engines', 'A Short Story', 'Demo Film', 'Road trip', 'Audiobook', 'Podcast', 'Demo data'],
    forbidden: ['Signature on', 'Back up the database files', 'Add music'],
    alert: false,
  },
  {
    name: 'a demo iPod, diagnostics tab',
    url: `http://localhost:${port}/?demo=1&tab=diagnostics`,
    expected: ['Device details', 'Files read from the iPod', 'Check what a rewrite would change', 'Copy iPod report'],
    forbidden: ['Signature on', 'Back up the database files'],
    alert: false,
  },
  {
    name: 'a nano 7G-style iPod with signed databases',
    url: `http://localhost:${port}/?demo=signed&rewrite=1&tab=diagnostics`,
    expected: [
      'Demo nano 7G',
      '5 tracks, 3 playlists',
      'Signed with hashAB',
      'Signatures verified',
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
  {
    // The whole add flow on a practice iPod held in memory: back up, pick two files, one copied
    // as it is and one converted by the real ffmpeg.wasm, plan, write, read the iPod back.
    name: 'adding files to a practice iPod (one copied, one converted), removing one and editing a title',
    url: `http://localhost:${port}/?demo=practice`,
    devtools: {
      doneSelector: 'body',
      timeoutMs: 5_000,
      async drive(page) {
        await page.waitFor('Practice iPod, held in memory');
        await page.click('Backup');
        await page.waitFor('Back up the database files');
        await page.click('Choose where to keep the backup');
        await page.waitFor('Every file was read back and matched');
        await page.click('Add music');
        await page.waitFor('No files chosen yet');
        await page.chooseFiles([TONE_COPY, TONE_CONVERT]);
        await page.waitFor('2 of 2 can be added');
        await page.waitFor('Copy as it is');
        await page.waitFor('Convert to AAC');
        await page.click('Convert and check');
        await page.waitFor('Ready to copy 2 files', 90_000);
        await page.click('Put on the iPod');
        await page.waitFor('Copied 2 files and checked the iPod by reading it back', 90_000);
        await page.waitFor('7 tracks');
        // Remove the copied file and its media file, then fix a title.
        await page.evaluate(`[...document.querySelectorAll('button[role=tab]')].find((tab) => tab.textContent.startsWith('Library')).click()`);
        await page.waitFor('Your library');
        await page.evaluate(`document.querySelector('input[aria-label="Select smoke tone copy"]').click()`);
        await page.waitFor('1 track selected');
        await page.click('Remove selected');
        await page.waitFor('Ready to remove 1 track and delete 1 file');
        await page.click('Remove from the iPod');
        await page.waitFor('Removed 1 track and deleted 1 file');
        await page.waitFor('6 tracks');
        await page.evaluate(`document.querySelector('input[aria-label="Select Morning Light"]').click()`);
        await page.waitFor('Edit this track');
        await page.evaluate(`(() => { const box = document.querySelector('h4 + label input'); box.value = 'Morning Light (edited)'; box.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        await page.click('Save changes to the iPod');
        await page.waitFor('Saved.');
        await page.waitFor('Morning Light (edited)');
      },
    },
    expected: ['smoke tone convert', 'Morning Light (edited)', 'Saved.', '6 tracks'],
    forbidden: ['smoke tone copy', 'did not finish', 'could not be put back'],
    alert: false,
  },
];

/**
 * Opens a page in headless Chrome over the DevTools protocol and returns its HTML once an element
 * matching `doneSelector` exists, or after `timeoutMs`. Real time, no virtual clock.
 */
async function dumpWithDevTools(chromePath, url, { doneSelector, timeoutMs, drive }) {
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
    if (drive) {
      const pageText = () => evaluate('document.body ? document.body.innerText : ""');
      // The part of the page the flow works in, not the browser-feature list above it.
      const shown = async () => {
        const text = String(await pageText());
        const at = Math.max(0, text.indexOf('Add to the iPod'));
        return text.slice(at, at + 2500);
      };
      await drive({
        send,
        evaluate,
        /** Waits until the page shows `text`, or throws with what the page shows instead. */
        async waitFor(text, ms = 60_000) {
          const until = Date.now() + ms;
          while (Date.now() < until) {
            if ((await pageText())?.includes(text)) return;
            await new Promise((resolve) => setTimeout(resolve, 150));
          }
          throw new Error(`Waited ${ms / 1000}s for "${text}". The page shows: ${await shown()}`);
        },
        /** Clicks the button whose text is exactly `text`. */
        async click(text) {
          const clicked = await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(text)} && !x.disabled); if (!b) return false; b.click(); return true; })()`);
          if (!clicked) throw new Error(`No enabled button "${text}". The page shows: ${await shown()}`);
        },
        async chooseFiles(paths) {
          const { result: doc } = await send('DOM.getDocument');
          const { result: found } = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type=file]' });
          await send('DOM.setFileInputFiles', { nodeId: found.nodeId, files: paths });
        },
      });
    }
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

  for (const scenario of SCENARIOS.filter((entry) => !process.env.SMOKE_ONLY || entry.name.includes(process.env.SMOKE_ONLY))) {
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
  rmSync(toneFolder, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
