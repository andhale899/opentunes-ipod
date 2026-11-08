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
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
const COVER = join(toneFolder, 'cover.jpg');
writeFileSync(COVER, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
writeTone(TONE_COPY, { rate: 44100, bits: 16, seconds: 2 });
writeTone(TONE_CONVERT, { rate: 96000, bits: 24, seconds: 1 });

/**
 * Not part of the normal run. With SMOKE_REAL_MEDIA=/path/to/folder it adds every file in that
 * folder (and its subfolders) to a practice iPod through the page, converts what needs it with the
 * real ffmpeg.wasm, and prints what the page says. For trying real files without an iPod.
 */
function listMedia(folder) {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) return entry.name.startsWith('.') ? [] : listMedia(path);
    return /\.(jpe?g|png|md|txt|log|ds_store)$/i.test(entry.name) || entry.name.startsWith('.') ? [] : [path];
  });
}

/** Ticks boxes of the Backup panel's "What to include" by the start of their label, in the page. */
const tickKinds = (page, ...labels) =>
  page.evaluate(`(() => { for (const label of ${JSON.stringify(labels)}) { const row = [...document.querySelectorAll('.include-list label')].find((l) => l.textContent.trim().startsWith(label)); if (!row) return 'no box: ' + label; row.querySelector('input').click(); } return 'ok'; })()`);

/**
 * Puts a folder held in the page where the folder picker would answer, and keeps what is written so a
 * scenario can look at it: window.__dest is the folder, window.__files() maps each path to its bytes and
 * window.__text(path) reads one as text (the UTF-8 byte order mark kept).
 */
const FAKE_FOLDER = `(() => {
  const directory = (name) => ({
    kind: 'directory', name, children: new Map(),
    async *entries() { for (const entry of this.children) yield entry; },
    async getDirectoryHandle(child, options = {}) {
      const found = this.children.get(child);
      if (found && found.kind === 'directory') return found;
      if (found || !options.create) throw Object.assign(new Error(child + ' was not found.'), { name: 'NotFoundError' });
      const made = directory(child); this.children.set(child, made); return made;
    },
    async getFileHandle(child, options = {}) {
      const found = this.children.get(child);
      if (found && found.kind === 'file') return found;
      if (found || !options.create) throw Object.assign(new Error(child + ' was not found.'), { name: 'NotFoundError' });
      const file = {
        kind: 'file', name: child, bytes: new Uint8Array(0),
        async getFile() { return new File([this.bytes], child); },
        async createWritable() {
          const chunks = [];
          return {
            write: async (data) => { chunks.push(new Uint8Array(data)); },
            close: async () => { const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0)); let at = 0; for (const c of chunks) { all.set(c, at); at += c.length; } file.bytes = all; },
          };
        },
      };
      this.children.set(child, file); return file;
    },
  });
  window.__dest = directory('smoke-destination');
  window.showDirectoryPicker = async () => window.__dest;
  window.__files = () => { const out = {}; const walk = (dir, prefix) => { for (const [n, e] of dir.children) { if (e.kind === 'directory') walk(e, prefix + n + '/'); else out[prefix + n] = e.bytes; } }; walk(window.__dest, ''); return out; };
  window.__text = (path) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(window.__files()[path]);
})()`;

const REAL_MEDIA = process.env.SMOKE_REAL_MEDIA ? listMedia(process.env.SMOKE_REAL_MEDIA) : null;

const SCENARIOS = [
  {
    name: 'a demo iPod with one of each kind (library tab)',
    url: `http://localhost:${port}/?demo=1`,
    expected: ['Demo iPod', '5 tracks, 3 playlists', 'Morning Light', 'Episode 12: Engines', 'A Short Story', 'Demo Film', 'Road trip', 'Audiobook', 'Podcast', 'Demo data'],
    forbidden: ['Signature on', 'What to include', 'Add music'],
    alert: false,
  },
  {
    name: 'a demo iPod, diagnostics tab',
    url: `http://localhost:${port}/?demo=1&tab=diagnostics`,
    expected: ['Device details', 'Files read from the iPod', 'Run the test (nothing is written)', 'Copy iPod report'],
    forbidden: ['Signature on', 'What to include'],
    alert: false,
  },
  {
    name: 'a nano 7G-style iPod with signed databases',
    url: `http://localhost:${port}/?demo=signed&rewrite=1&tab=diagnostics`,
    // The rewrite check is the heaviest page load. Chrome's virtual-time budget was too short for a
    // slow CI runner, so this one waits in real time for the last line it expects.
    devtools: {
      doneSelector: 'body',
      timeoutMs: 5_000,
      async drive(page) {
        await page.waitFor('Copy rewrite report', 120_000);
      },
    },
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
    forbidden: ['Does not match', 'Could not be checked', 'differences found. Adding music'],
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
        await page.waitFor('What to include');
        await page.click('Choose where to keep the backup');
        await page.waitFor('Every file was read back and matched');
        await page.click('Add music');
        await page.waitFor('No files chosen yet');
        await page.chooseFiles([TONE_COPY, TONE_CONVERT]);
        await page.waitFor('2 of 2 can be added');
        await page.waitFor('Copy as it is');
        await page.waitFor('Convert to AAC');
        await page.click('Check and prepare');
        await page.waitFor('Ready to copy 2 files', 90_000);
        await page.click('Put on the iPod');
        await page.waitFor('Copied 2 files and checked the iPod by reading it back', 90_000);
        await page.waitFor('7 tracks');
        await page.waitFor('Now eject the iPod from your computer before you unplug it');
        // A picture next to the music, as in a chosen folder, is left out without a fuss.
        await page.click('Add music');
        // Stand in for Chrome's folder picker with a folder that has an album, a subfolder and a cover picture.
        await page.evaluate(`(() => {
          const wav = () => { const b = new Uint8Array(44 + 400); const v = new DataView(b.buffer); const t = (o, x) => [...x].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
            t(0, 'RIFF'); v.setUint32(4, 36 + 400, true); t(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true); v.setUint32(24, 44100, true); v.setUint32(28, 176400, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true); t(36, 'data'); v.setUint32(40, 400, true); return b; };
          const file = (name) => ({ kind: 'file', name, getFile: async () => new File([wav()], name) });
          const folder = (name, children) => ({ kind: 'directory', name, async *entries() { for (const [childName, child] of Object.entries(children)) yield [childName, child]; } });
          window.showDirectoryPicker = async () => folder('testmedia', {
            'cover.jpg': file('cover.jpg'),
            Album: folder('Album', { '02 Second.wav': file('02 Second.wav'), '01 First.wav': file('01 First.wav'), 'Disc 2': folder('Disc 2', { '03 Third.wav': file('03 Third.wav') }) }),
            '.hidden': folder('.hidden', { 'x.wav': file('x.wav') }),
          });
        })()`);
        await page.click('Choose a folder');
        await page.waitFor('3 of 3 can be added');
        await page.waitFor('1 other file was left out');
        await page.waitFor('Album / Disc 2');
        const order = await page.evaluate(`[...document.querySelectorAll('.pane:not([hidden]) td.cell-title')].map((cell) => cell.firstChild.textContent.trim()).join('|')`);
        if (order !== '01 First.wav|02 Second.wav|03 Third.wav') throw new Error('The folder files came in the wrong order: ' + order);
        // A folder named for a kind: the kind is set from the folder name and missing tags are filled from the names.
        await page.click('Clear the list');
        await page.waitFor('files from the list?');
        await page.click('Yes, clear the list');
        await page.evaluate(`(() => {
          const wav = () => { const b = new Uint8Array(44 + 400); const v = new DataView(b.buffer); const t = (o, x) => [...x].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
            t(0, 'RIFF'); v.setUint32(4, 36 + 400, true); t(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true); v.setUint32(24, 44100, true); v.setUint32(28, 176400, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true); t(36, 'data'); v.setUint32(40, 400, true); return b; };
          const file = (name) => ({ kind: 'file', name, getFile: async () => new File([wav()], name) });
          const folder = (name, children) => ({ kind: 'directory', name, async *entries() { for (const [childName, child] of Object.entries(children)) yield [childName, child]; } });
          window.showDirectoryPicker = async () => folder('Audiobooks', { 'Some Author': folder('Some Author', { 'Some Book': folder('Some Book', { '01 Opening.wav': file('01 Opening.wav') }) }) });
        })()`);
        await page.click('Choose a folder');
        await page.waitFor('1 of 1 can be added');
        await page.waitFor('from the folder name');
        await page.waitFor('filled in from the folder and file names');
        const detected = await page.evaluate(`(() => { const select = document.querySelector('select[aria-label="Kind of 01 Opening.wav"]'); return select ? select.value : 'no select'; })()`);
        if (detected !== 'audiobook') throw new Error('The folder named Audiobooks should have set the kind to audiobook, but the kind is: ' + detected);
        await page.evaluate(`[...document.querySelectorAll('button[role=tab]')].find((tab) => tab.textContent.startsWith('Library')).click()`);
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
  {
    // Album art on a practice iPod: a cover picture in a folder is found and used, a file with no
    // cover is looked up through a FAKE fetch (window.fetch is replaced, and the browser here resolves
    // no host except localhost, so nothing can leave the page), the person approves the found cover,
    // and the art is written and read back. Nothing is sent before the box is ticked and the button
    // pressed, and only the artist and album names are sent.
    name: 'album art on a practice iPod (cover.png from a folder, a looked-up cover through a fake fetch, written and read back)',
    url: `http://localhost:${port}/?demo=practice`,
    devtools: {
      doneSelector: 'body',
      timeoutMs: 5_000,
      async drive(page) {
        const check = (condition, message) => {
          if (!condition) throw new Error(message);
        };
        await page.waitFor('Practice iPod, held in memory');
        await page.evaluate(`(() => {
          window.__art = [];
          const png = async () => {
            const canvas = new OffscreenCanvas(64, 64);
            const context = canvas.getContext('2d');
            context.fillStyle = '#c03030';
            context.fillRect(0, 0, 64, 64);
            context.fillStyle = '#3030c0';
            context.fillRect(16, 16, 32, 32);
            return new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
          };
          const real = window.fetch.bind(window);
          window.fetch = async (url, init) => {
            const address = String(url);
            // The page's own files (the engine's wasm) still load. Everything else is the fake's.
            if (new URL(address, location.href).hostname === 'localhost') return real(url, init);
            window.__art.push({ url: address, method: init && init.method, headers: init && init.headers, credentials: init && init.credentials, body: init && init.body });
            if (address.startsWith('https://musicbrainz.org/ws/2/release/')) {
              const query = decodeURIComponent(new URL(address).searchParams.get('query'));
              const known = query === 'release:"Plain Album" AND artist:"Smoke Band"';
              return new Response(JSON.stringify({ created: 'x', count: known ? 1 : 0, offset: 0, releases: known ? [{ id: '1834eae1-741b-3c03-9ca5-0df3decb43ea', title: 'Plain Album', score: 100, status: 'Official', date: '2001', 'artist-credit': [{ name: 'Smoke Band' }] }] : [] }), { status: 200, headers: { 'content-type': 'application/json' } });
            }
            if (address === 'https://coverartarchive.org/release/1834eae1-741b-3c03-9ca5-0df3decb43ea/front-500') {
              const response = new Response(await png(), { status: 200, headers: { 'content-type': 'image/png' } });
              Object.defineProperty(response, 'url', { value: 'https://dn1.ca.archive.org/0/items/mbid-x/cover_thumb500.png' });
              return response;
            }
            throw new Error('The fake fetch was asked for an address it does not know: ' + address);
          };
        })()`);
        await page.click('Backup');
        await page.waitFor('What to include');
        await page.click('Choose where to keep the backup');
        await page.waitFor('Every file was read back and matched');
        await page.click('Add music');
        await page.waitFor('No files chosen yet');
        await page.evaluate(`(() => {
          const wav = () => { const b = new Uint8Array(44 + 400); const v = new DataView(b.buffer); const t = (o, x) => [...x].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
            t(0, 'RIFF'); v.setUint32(4, 36 + 400, true); t(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true); v.setUint32(24, 44100, true); v.setUint32(28, 176400, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true); t(36, 'data'); v.setUint32(40, 400, true); return b; };
          const file = (name) => ({ kind: 'file', name, getFile: async () => new File([wav()], name) });
          const cover = (name) => ({ kind: 'file', name, getFile: async () => {
            const canvas = new OffscreenCanvas(48, 48);
            const context = canvas.getContext('2d');
            context.fillStyle = '#30a030';
            context.fillRect(0, 0, 48, 48);
            return new File([await canvas.convertToBlob({ type: 'image/png' })], name);
          } });
          const folder = (name, children) => ({ kind: 'directory', name, async *entries() { for (const [childName, child] of Object.entries(children)) yield [childName, child]; } });
          window.showDirectoryPicker = async () => folder('Music', {
            'Smoke Band': folder('Smoke Band', {
              'Covered Album': folder('Covered Album', { 'Cover.PNG': cover('Cover.PNG'), '01 One.wav': file('01 One.wav'), '02 Two.wav': file('02 Two.wav') }),
              'Plain Album': folder('Plain Album', { '01 Three.wav': file('01 Three.wav') }),
            }),
          });
        })()`);
        await page.click('Choose a folder');
        await page.waitFor('3 of 3 can be added');
        await page.waitFor('Cover: Cover.PNG from its folder');
        await page.waitFor('Cover: none');
        // The online step: nothing is sent before the box is ticked and the button pressed.
        await page.evaluate(`document.querySelector('.art-finder').open = true`);
        await page.waitFor('1 album has no cover picture');
        await page.waitFor('What is sent: only the artist and album name of each album');
        check((await page.evaluate('window.__art.length')) === 0, 'Something was sent before the box was ticked.');
        check(await page.evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Find covers').disabled`), 'Find covers must be off until the box is ticked.');
        await page.evaluate(`document.querySelector('.art-finder input[type=checkbox]').click()`);
        check((await page.evaluate('window.__art.length')) === 0, 'Something was sent when the box was ticked, before the button.');
        await page.click('Find covers');
        await page.waitFor('Found 1 of 1', 30_000);
        await page.waitFor('freely accessible, to be used at your own risk');
        await page.waitFor('Use the ticked covers (1)');
        // Only the names went out: one search and one picture request, GET, no body, no cookies.
        const sent = JSON.parse(await page.evaluate('JSON.stringify(window.__art)'));
        check(sent.length === 2, 'Expected two requests, got ' + sent.length + ': ' + JSON.stringify(sent.map((call) => call.url)));
        check(sent[0].url.startsWith('https://musicbrainz.org/ws/2/release/?query=') && sent[0].url.includes('fmt=json'), 'The search address is wrong: ' + sent[0].url);
        check(sent[1].url === 'https://coverartarchive.org/release/1834eae1-741b-3c03-9ca5-0df3decb43ea/front-500', 'The picture address is wrong: ' + sent[1].url);
        check(sent.every((call) => call.method === 'GET' && call.credentials === 'omit' && call.body === undefined), 'A request was not a plain GET without cookies or a body.');
        check(!JSON.stringify(sent).match(/wav|One|Two|Three|Covered|iPod/), 'A request carried something besides the artist and album names: ' + JSON.stringify(sent));
        // Nothing is added until it is approved.
        check(!(await page.evaluate('document.body.textContent.includes("found online")')), 'The cover was used before it was approved.');
        await page.click('Use the ticked covers (1)');
        await page.waitFor('Covers chosen for 1 album');
        await page.waitFor('Cover: found online (you approved it)');
        await page.click('Check and prepare');
        await page.waitFor('Ready to copy 3 files', 90_000);
        const planText = await page.evaluate('document.body.textContent');
        check(planText.includes('Add album art to 3 tracks: 2 pictures'), 'The plan does not list the album art: ' + planText.slice(planText.indexOf('Ready to copy'), planText.indexOf('Ready to copy') + 600));
        await page.click('Put on the iPod');
        await page.waitFor('Copied 3 files and checked the iPod by reading it back', 90_000);
        await page.waitFor('Album art was written for 3 tracks (2 pictures) and read back');
        await page.waitFor('8 tracks');
      },
    },
    expected: ['Album art was written for 3 tracks (2 pictures) and read back', '8 tracks'],
    forbidden: ['did not finish', 'could not be put back', 'The fake fetch was asked'],
    alert: false,
  },
  {
    // The AI assistant with a FAKE model: window.fetch is replaced, so nothing leaves the page
    // (the browser here resolves no host except localhost). It checks that nothing is sent before
    // the opt-in, what is sent after it, that the preview shows before and after, that one edit
    // and one new playlist apply through the backup gate, and that the key is never in the page.
    name: 'the AI assistant on a practice iPod (fake model, no network): opt in, ask, preview, apply one edit and one playlist',
    url: `http://localhost:${port}/?demo=practice`,
    devtools: {
      doneSelector: 'body',
      timeoutMs: 5_000,
      async drive(page) {
        const check = (condition, message) => {
          if (!condition) throw new Error(message);
        };
        await page.waitFor('Practice iPod, held in memory');
        // The assistant is off until the person opts in, and the app's own wording says so.
        await page.waitFor('Nothing is uploaded unless you turn the AI assistant on');
        await page.evaluate(`(() => {
          window.__ai = [];
          const real = window.fetch.bind(window);
          window.fetch = async (url, init) => {
            if (!String(url).startsWith('https://api.anthropic.com/')) return real(url, init);
            // Listing models is a plain GET with no library data in it.
            if (init.method === 'GET' && String(url).includes('/v1/models')) {
              return new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5' }, { id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5' }] }), { status: 200 });
            }
            const body = JSON.parse(init.body);
            window.__ai.push({ url: String(url), headers: init.headers, body });
            const library = body.messages[body.messages.length - 1].content;
            const idOf = (title) => Number(library.split('\\n').find((line) => line.split('|')[2] === title).split('|')[0]);
            return new Response(JSON.stringify({
              stop_reason: 'tool_use',
              content: [
                { type: 'tool_use', id: 'a', name: 'propose_edits', input: { edits: [
                  { id: idOf('Morning Light'), fields: { artist: 'Smoke Artist' }, reason: 'A fake model changed this' },
                  { id: 9999, fields: { artist: 'Nobody' }, reason: 'An id that was never sent' },
                  { id: idOf('Night Drive'), fields: { size: 5 }, reason: 'A field the engine may not edit' },
                ] } },
                { type: 'tool_use', id: 'b', name: 'propose_playlists', input: { playlists: [{ name: 'Smoke mix', ids: [idOf('Morning Light'), idOf('Night Drive')], reason: 'A fake playlist' }] } },
              ],
            }), { status: 200 });
          };
        })()`);
        await page.click('Backup');
        await page.waitFor('What to include');
        await page.click('Choose where to keep the backup');
        await page.waitFor('Every file was read back and matched');
        await page.click('Assistant');
        // The default service is a free one, with a link to get a free key.
        await page.waitFor('Groq (free tier)');
        await page.waitFor('Get a free key');
        // This scenario fakes Anthropic, so pick it.
        await page.evaluate(`(() => { const box = document.querySelector('select option[value=anthropic]').parentElement; box.value = 'anthropic'; box.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        await page.waitFor('Ask a language model');
        const optIn = await page.evaluate(`document.querySelector('.ai-optin span').textContent`);
        check(optIn === "Send my library's titles, artists, albums and genres (no audio, no file paths) to api.anthropic.com when I ask the assistant something.", 'The opt-in wording is wrong: ' + optIn);
        check(await page.evaluate(`document.querySelector('.ai-optin input').checked === false`), 'The opt-in must start off.');
        await page.evaluate(`(() => { const box = document.querySelector('input[type=password]'); box.value = 'sk-test-0000'; box.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        // The model list comes from the service, so nobody has to type a model name.
        await page.click('Load the list from the service');
        await page.waitFor('Claude Haiku 5.5 (claude-haiku-5-5)');
        await page.evaluate(`(() => { const box = document.querySelector('select[aria-label="Model"]'); box.value = 'claude-haiku-5-5'; box.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        const modelNow = await page.evaluate(`document.querySelector('input[aria-label="Model name"]').value`);
        check(modelNow === 'claude-haiku-5-5', 'Picking a model from the list did not fill the model name: ' + modelNow);
        await page.evaluate(`(() => { const box = document.querySelector('textarea'); box.value = 'Change the artist of Morning Light and make a mix'; box.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        await page.waitFor('Tick the box above to allow sending the library.');
        check(await page.evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Ask').disabled`), 'Ask must be off before the opt-in.');
        await page.waitFor('This request would send 5 tracks');
        check((await page.evaluate('window.__ai.length')) === 0, 'Something was sent before the opt-in.');
        await page.evaluate(`document.querySelector('.ai-optin input').click()`);
        await page.click('Ask');
        await page.waitFor('Nothing has been changed yet');
        await page.waitFor('Smoke Artist');
        await page.waitFor('The Demo Band');
        await page.waitFor('A fake model changed this');
        await page.waitFor('New playlist "Smoke mix"');
        await page.waitFor('2 of 2 ticked');
        await page.waitFor('2 things the assistant asked for were left out');
        // What was sent: one request, to the right place, with the key only in a header.
        const sent = JSON.parse(await page.evaluate('JSON.stringify(window.__ai)'));
        check(sent.length === 1, 'Expected one request, got ' + sent.length);
        const [call] = sent;
        check(call.headers['x-api-key'] === 'sk-test-0000' && call.headers['anthropic-dangerous-direct-browser-access'] === 'true', 'The headers are wrong.');
        check(!call.url.includes('sk-test') && !JSON.stringify(call.body).includes('sk-test'), 'The key is in the URL or the body.');
        check(call.body.tool_choice.type === 'any' && call.body.tools.length === 3, 'Tools were not forced.');
        const library = call.body.messages[call.body.messages.length - 1].content;
        check(library.includes('|Morning Light|The Demo Band|Samples|Rock|2021|track 1') && !/iPod_Control|\.m4a|F\d\d/.test(library), 'The library text is wrong or holds a path.');
        // Apply the edit and the playlist.
        await page.click('Apply selected');
        await page.waitFor('Apply these changes to the iPod?');
        await page.waitFor('restore this session');
        await page.click('Apply to the iPod');
        await page.waitFor('Applied 1 edit and 1 new playlist', 90_000);
        await page.evaluate(`[...document.querySelectorAll('button[role=tab]')].find((tab) => tab.textContent.startsWith('Library')).click()`);
        await page.waitFor('Smoke Artist');
        // The library organiser keeps playlists in its own sub-tab.
        await page.evaluate(`[...document.querySelectorAll('button[role=tab]')].find((tab) => tab.textContent.trim().startsWith('Playlists')).click()`);
        await page.waitFor('Smoke mix');
        await page.evaluate(`[...document.querySelectorAll('button[role=tab]')].find((tab) => tab.textContent.startsWith('Assistant')).click()`);
        // Back on the tab: the conversation, the key and the opt-in are still there (this tab's memory), and the old answer cannot be applied twice.
        await page.waitFor('Applied 1 edit and 1 new playlist');
        check(!(await page.evaluate(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Apply selected')`)), 'An applied answer must not offer Apply again.');
      },
    },
    expected: ['Smoke Artist', 'Applied 1 edit and 1 new playlist', 'A key is set'],
    forbidden: ['sk-test-0000', 'did not finish', 'could not be put back', 'Nothing more was changed'],
    alert: false,
  },
  {
    // The library organiser on a practice iPod: select every track, set a genre on all of them in one
    // write, group by it, make a playlist from the selection, then take the tracks out of it again.
    name: 'organising a practice iPod (select all, bulk edit, group, playlist create, add and remove)',
    url: `http://localhost:${port}/?demo=practice`,
    devtools: {
      doneSelector: 'body',
      timeoutMs: 5_000,
      async drive(page) {
        const setValue = (selector, value) =>
          page.evaluate(`(() => { const box = document.querySelector(${JSON.stringify(selector)}); if (!box) return false; box.value = ${JSON.stringify(value)}; box.dispatchEvent(new Event(box.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); return true; })()`);
        const clickTab = (name) => page.evaluate(`[...document.querySelectorAll('button[role=tab]')].find((tab) => tab.textContent.trim().startsWith(${JSON.stringify(name)})).click()`);
        await page.waitFor('Practice iPod, held in memory');
        await page.click('Backup');
        await page.waitFor('What to include');
        await page.click('Choose where to keep the backup');
        await page.waitFor('Every file was read back and matched');
        await clickTab('Library');
        await page.waitFor('Your library');
        // Filter chips carry counts.
        const chips = await page.evaluate(`[...document.querySelectorAll('.chip')].map((chip) => chip.textContent.trim().replace(/\\s+/g, ' ')).join('|')`);
        if (chips !== 'All 5|Music 2|Podcasts 1|Audiobooks 1|Video 1') throw new Error('The kind chips read: ' + chips);
        // Select every track, set the genre and the album artist on all of them in one write.
        await page.click('Select all (5)');
        await page.waitFor('5 tracks selected');
        await setValue('.bulk .field:nth-child(3) input', 'Various');
        await setValue('.bulk .field:nth-child(4) input', 'Folk');
        await page.waitFor('5 tracks would change');
        await page.click('Apply to 5 tracks');
        await page.waitFor('Changed 5 tracks in one write');
        await setValue('.browser select', 'genre');
        await page.waitFor('Folk');
        const groups = await page.evaluate(`[...document.querySelectorAll('.group-name')].map((name) => name.textContent).join('|')`);
        if (groups !== 'Folk') throw new Error('Grouping by genre gave: ' + groups);
        // Collapse the group: its header stays and its rows go. Let the page settle first, or its own reset of the groups can undo the click.
        await new Promise((resolve) => setTimeout(resolve, 400));
        await page.evaluate(`document.querySelector('.group-toggle').click()`);
        await page.waitFor('Showing 0 of 0 tracks');
        await page.evaluate(`document.querySelector('.group-toggle').click()`);
        await page.waitFor('Showing 5 of 5 tracks');
        // A playlist from the selection.
        await clickTab('Playlists');
        await page.waitFor('Playlists on this iPod');
        await setValue('.create-box input[type=text]', 'Smoke mix');
        await page.click('Create playlist');
        await page.waitFor('Ready to write.');
        await page.waitFor('Create the playlist "Smoke mix" with 5 tracks.');
        await page.click('Apply to the iPod');
        await page.waitFor('Done. The iPod was read back and matches.');
        await page.waitFor('Smoke mix');
        // Read-only lists say why.
        await page.evaluate(`[...document.querySelectorAll('button.plist')].find((item) => item.textContent.includes('holds everything')).click()`);
        await page.waitFor('Read only. This list holds every track');
        // Take the tracks out of the new playlist again.
        await page.evaluate(`[...document.querySelectorAll('button.plist')].find((item) => item.textContent.includes('Smoke mix')).click()`);
        await page.waitFor('Take 5 out of this playlist');
        await page.click('Take 5 out of this playlist');
        await page.waitFor('Take 5 tracks out of "Smoke mix". They stay on the iPod.');
        await page.click('Apply to the iPod');
        await page.waitFor('Done. The iPod was read back and matches.');
        const lists = await page.evaluate(`[...document.querySelectorAll('button.plist')].map((item) => item.textContent.replace(/\\s+/g, ' ').trim()).join('|')`);
        if (!/Smoke mix\s*0 tracks/.test(String(lists))) throw new Error('The playlists read: ' + lists);
        // Add the selection to an existing playlist. Road trip holds two of the five already, so three are added.
        await page.waitFor('already in "Road trip"');
        await page.click('Add 3 to this playlist');
        await page.waitFor('Add 3 tracks to "Road trip".');
        await page.click('Apply to the iPod');
        await page.waitFor('Done. The iPod was read back and matches.');
        const after = await page.evaluate(`[...document.querySelectorAll('button.plist')].map((item) => item.textContent.replace(/\\s+/g, ' ').trim()).join('|')`);
        if (!/Road trip\s*5 tracks/.test(String(after))) throw new Error('The playlists read: ' + after);
      },
    },
    expected: ['Smoke mix', 'Done. The iPod was read back and matches.'],
    forbidden: ['did not finish', 'could not be put back'],
    alert: false,
  },
  {
    // Find duplicates on a practice iPod. Part 1: add the same tone files twice (with the box that
    // allows the same song again), see one SURE group, remove the extra copy through the backup gate.
    // Part 2: a fake model (window.fetch replaced, nothing leaves the page) reviews a new group; only
    // the groups' metadata may be sent, its verdict only changes ticks, and nothing is removed until
    // the person presses the remove button.
    name: 'finding duplicates on a practice iPod (remove a SURE group, then a fake AI review that only ticks)',
    url: `http://localhost:${port}/?demo=practice`,
    devtools: {
      doneSelector: 'body',
      timeoutMs: 5_000,
      async drive(page) {
        const check = (condition, message) => {
          if (!condition) throw new Error(message);
        };
        const clickTab = (name) => page.evaluate(`[...document.querySelectorAll('button[role=tab]')].find((tab) => tab.textContent.trim().startsWith(${JSON.stringify(name)})).click()`);
        const addTone = async (paths, expectedLine, readyLine, copiedLine) => {
          await clickTab('Add music');
          await page.waitFor('Add music, podcasts');
          const hasClear = await page.evaluate(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Clear the list' && b.offsetParent !== null)`);
          if (hasClear) {
            await page.click('Clear the list');
            await page.waitFor('from the list?');
            await page.click('Yes, clear the list');
          }
          await page.chooseFiles(paths);
          // Tick the box first: a file already on the iPod is skipped before converting unless it is ticked.
          await page.waitFor('Add files even if');
          await page.evaluate(`(() => { const box = [...document.querySelectorAll('label.check')].find((l) => l.textContent.includes('Add files even if')).querySelector('input'); if (!box.checked) box.click(); })()`);
          await page.waitFor(expectedLine);
          await page.click('Check and prepare');
          await page.waitFor(readyLine, 90_000);
          await page.click('Put on the iPod');
          await page.waitFor(copiedLine, 90_000);
        };
        await page.waitFor('Practice iPod, held in memory');
        await page.evaluate(`(() => {
          window.__ai = [];
          const real = window.fetch.bind(window);
          window.fetch = async (url, init) => {
            if (!String(url).startsWith('https://api.anthropic.com/')) return real(url, init);
            const body = JSON.parse(init.body);
            window.__ai.push({ url: String(url), headers: init.headers, body });
            const text = body.messages[body.messages.length - 1].content;
            const lines = text.split('\\n');
            const at = lines.findIndex((line) => /^group \\d+ /.test(line));
            const group = Number(lines[at].split(' ')[1]);
            const firstTrack = Number(lines[at + 1].split('|')[0]);
            return new Response(JSON.stringify({
              stop_reason: 'tool_use',
              content: [{ type: 'tool_use', id: 'a', name: 'review_duplicates', input: { verdicts: [
                { group, verdict: 'duplicate', keep: firstTrack, reason: 'A fake model says these are the same file.' },
                { group: 9999, verdict: 'duplicate', reason: 'A group that was never sent' },
              ] } }],
            }), { status: 200 });
          };
        })()`);
        await page.click('Backup');
        await page.waitFor('What to include');
        await page.click('Choose where to keep the backup');
        await page.waitFor('Every file was read back and matched');

        // Part 1: the same two tone files, then one of them again.
        await addTone([TONE_COPY, TONE_CONVERT], '2 of 2 can be added', 'Ready to copy 2 files', 'Copied 2 files and checked the iPod by reading it back');
        await page.waitFor('7 tracks');
        await addTone([TONE_COPY], '1 of 1 can be added', 'Ready to copy 1 file', 'Copied 1 file and checked the iPod by reading it back');
        await page.waitFor('8 tracks');
        await clickTab('Library');
        await page.waitFor('Your library');
        await clickTab('Find duplicates');
        await page.waitFor('1 group, 1 track that could go');
        const groups = await page.evaluate(`document.querySelectorAll('.dup-group').length`);
        check(groups === 1, 'Expected one group, found ' + groups);
        const card = await page.evaluate(`document.querySelector('.dup-group').innerText`);
        check(/Sure/.test(card) && card.includes('same artist, title, album and length') && card.includes('Recommended:'), 'The group card is wrong: ' + card);
        check(!card.includes('smoke tone convert'), 'A different song was put in the group.');
        check((await page.evaluate(`document.querySelectorAll('.dup-row input[type=radio]:checked').length`)) === 1, 'Exactly one copy should be kept.');
        check((await page.evaluate(`document.querySelectorAll('.dup-row input[type=checkbox]:checked').length`)) === 1, 'Exactly one copy should be ticked for removal.');
        await page.waitFor('1 track ticked');
        await page.click('Remove ticked duplicates');
        await page.waitFor('Ready to remove 1 track and delete 1 file');
        // The duplicate finder asks first, and says the music cannot come back from the backup.
        await page.click('Remove from the iPod...');
        await page.waitFor('Remove 1 track from the iPod?');
        await page.waitFor('This cannot be undone from the backup');
        await page.click('Do not remove');
        check(await page.evaluate(`document.querySelectorAll('.dup-group').length`) === 1, 'Backing out of the removal changed the groups.');
        await page.click('Remove from the iPod...');
        await page.click('Remove from the iPod');
        await page.waitFor('Removed 1 track and deleted 1 file');
        await page.waitFor('No duplicates found');
        check((await page.evaluate('window.__ai.length')) === 0, 'The AI was called without being asked.');

        // Part 2: a new copy, and the AI review.
        await addTone([TONE_COPY], '1 of 1 can be added', 'Ready to copy 1 file', 'Copied 1 file and checked the iPod by reading it back');
        await page.waitFor('8 tracks');
        await clickTab('Library');
        await clickTab('Find duplicates');
        await page.waitFor('1 group, 1 track that could go');
        // The panels stay mounted, so the section may still be open from the last visit.
        await page.evaluate(`(() => { const box = document.querySelector('.dup-ai'); if (!box.open) box.querySelector('summary').click(); })()`);
        // Not set up yet: it says so and points to the Assistant tab, and has no key box of its own.
        await page.waitFor('The AI is not set up. Open the Assistant tab');
        check((await page.evaluate(`document.querySelectorAll('.dupes input[type=password]').length`)) === 0, 'The duplicates tab must not have a key box.');
        await clickTab('Assistant');
        await page.waitFor('Ask a language model');
        // The default service is a free one now. This scenario fakes Anthropic, so pick it first.
        await page.evaluate(`(() => { const box = document.querySelector('select option[value=anthropic]').parentElement; box.value = 'anthropic'; box.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        await page.evaluate(`(() => { const box = document.querySelector('input[type=password]'); box.value = 'sk-test-0000'; box.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        await clickTab('Library');
        await clickTab('Find duplicates');
        // The panels stay mounted, so the section may still be open from the last visit.
        await page.evaluate(`(() => { const box = document.querySelector('.dup-ai'); if (!box.open) box.querySelector('summary').click(); })()`);
        await page.waitFor('This request would send 1 group (2 tracks');
        check(await page.evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Ask AI to review').disabled`), 'Ask AI to review must be off before the opt-in.');
        const wording = await page.evaluate(`document.querySelector('.dup-ai .ai-optin span').textContent`);
        check(wording.includes('no audio, no file paths, no sizes, no playlist names') && wording.includes('api.anthropic.com'), 'The opt-in wording is wrong: ' + wording);
        check((await page.evaluate('window.__ai.length')) === 0, 'Something was sent before the opt-in.');
        await page.evaluate(`document.querySelector('.dup-ai .ai-optin input').click()`);
        await page.click('Ask AI to review');
        await page.waitFor('The AI says: duplicate');
        await page.waitFor('A fake model says these are the same file.');
        await page.waitFor('1 thing the AI said was left out');
        const sent = JSON.parse(await page.evaluate('JSON.stringify(window.__ai)'));
        check(sent.length === 1, 'Expected one request, got ' + sent.length);
        const [call] = sent;
        check(call.headers['x-api-key'] === 'sk-test-0000' && !call.url.includes('sk-test') && !JSON.stringify(call.body).includes('sk-test'), 'The key must be in a header only.');
        check(call.body.tools.length === 1 && call.body.tools[0].name === 'review_duplicates' && call.body.tool_choice.type === 'any', 'The tool was not forced.');
        const message = call.body.messages[call.body.messages.length - 1].content;
        check(message.includes('smoke tone copy') && message.includes('group 1 (same artist, title, album and length)'), 'The groups were not sent: ' + message);
        check(!/Morning Light|Night Drive|smoke tone convert/.test(message), 'Tracks that are not in a group were sent.');
        check(!/iPod_Control|\.wav|\.m4a|F\d\d|playlist|Road trip/i.test(message), 'A path or playlist name was sent.');
        // The verdict only ticks. Untick everything, apply it, and the track is still there.
        await page.click('Select none');
        await page.waitFor('0 tracks ticked');
        await page.click("Apply the AI's verdicts");
        await page.waitFor('1 track ticked');
        await page.waitFor('Nothing is removed until you press Remove ticked duplicates');
        await page.waitFor('8 tracks');
        await page.click('Remove ticked duplicates');
        await page.waitFor('Ready to remove 1 track and delete 1 file');
        await page.click('Remove from the iPod...');
        await page.click('Remove from the iPod');
        await page.waitFor('Removed 1 track and deleted 1 file');
        await page.waitFor('7 tracks');
        await page.waitFor('No duplicates found');
      },
    },
    expected: ['No duplicates found', 'Removed 1 track and deleted 1 file', '7 tracks'],
    forbidden: ['sk-test-0000', 'did not finish', 'could not be put back', 'did not finish'],
    alert: false,
  },
  {
    // Duplicates are found BEFORE anything is converted. A fake folder holds two files that are
    // already on the practice iPod (Morning Light and Night Drive, as 24-bit audio that WOULD need
    // converting), two that repeat each other, a file with no title and one new file. The rows are
    // marked at once, 'Check and prepare' does not start the converter (window.Worker is wrapped to
    // count workers), the box and a single row's own button bring the duplicates back, and the
    // marks follow the iPod's library when a track is removed.
    name: 'duplicates are marked before converting (skipped files are never converted; the box and one row can add them back)',
    url: `http://localhost:${port}/?demo=practice`,
    devtools: {
      doneSelector: 'body',
      timeoutMs: 5_000,
      async drive(page) {
        const check = (condition, message) => {
          if (!condition) throw new Error(message);
        };
        const clickTab = (name) => page.evaluate(`[...document.querySelectorAll('button[role=tab]')].find((tab) => tab.textContent.trim().startsWith(${JSON.stringify(name)})).click()`);
        const rows = async () =>
          JSON.parse(
            await page.evaluate(`JSON.stringify([...document.querySelectorAll('.pane:not([hidden]) .add-stack tbody tr')].map((tr) => ({
              name: tr.querySelector('.cell-title').getAttribute('title'),
              state: tr.dataset.duplicate || '',
              label: (tr.querySelector('.dup-badge') || {}).textContent || '',
              text: tr.querySelector('.cell-title').innerText,
              happens: tr.querySelector('td[data-label="What happens"]').innerText,
              size: tr.querySelector('td[data-label="On the iPod"]').innerText,
            })))`),
          );
        const rowOf = async (name) => {
          const found = (await rows()).find((row) => row.name === name);
          check(found, 'No row for ' + name);
          return found;
        };
        const workers = () => page.evaluate('window.__workers');
        const tick = (on) =>
          page.evaluate(`(() => { const box = [...document.querySelectorAll('label.check')].find((l) => l.textContent.includes('Add files even if')).querySelector('input'); if (box.checked !== ${on}) box.click(); })()`);
        const pressOnRow = (name, label) =>
          page.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === ${JSON.stringify(label + ': ' + name)}); if (!b) return false; b.click(); return true; })()`);

        await page.waitFor('Practice iPod, held in memory');
        // A fake folder picker with silent WAV files, and a count of the workers the page starts.
        await page.evaluate(`(() => {
          const wav = (rate, bits, seconds) => {
            const per = bits / 8;
            const data = Math.round(rate * seconds) * per;
            const b = new Uint8Array(44 + data);
            const v = new DataView(b.buffer);
            const t = (o, x) => [...x].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
            t(0, 'RIFF'); v.setUint32(4, 36 + data, true); t(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
            v.setUint32(24, rate, true); v.setUint32(28, rate * per, true); v.setUint16(32, per, true); v.setUint16(34, bits, true); t(36, 'data'); v.setUint32(40, data, true);
            return b;
          };
          const file = (name, rate, bits, seconds) => ({ kind: 'file', name, getFile: async () => new File([wav(rate, bits, seconds)], name) });
          const folder = (name, children) => ({ kind: 'directory', name, async *entries() { for (const [childName, child] of Object.entries(children)) yield [childName, child]; } });
          window.showDirectoryPicker = async () => folder('Music', {
            'The Demo Band': folder('The Demo Band', {
              Samples: folder('Samples', {
                'Morning Light.wav': file('Morning Light.wav', 8000, 24, 214),
                'Night Drive.wav': file('Night Drive.wav', 8000, 24, 187),
                'Brand New.wav': file('Brand New.wav', 8000, 16, 3),
                '01 Brand New.wav': file('01 Brand New.wav', 8000, 16, 3),
                '!!!.wav': file('!!!.wav', 8000, 16, 2),
              }),
            }),
          });
          window.__workers = 0;
          const Real = window.Worker;
          window.Worker = class extends Real { constructor(...args) { super(...args); window.__workers += 1; } };
        })()`);
        await page.click('Backup');
        await page.waitFor("Back up the iPod's library");
        await page.click('Choose where to keep the backup');
        await page.waitFor('Every file was read back and matched');

        // 1. The rows are marked as soon as the files are read, before anything is converted.
        await page.click('Add music');
        await page.waitFor('No files chosen yet');
        await page.click('Choose a folder');
        await page.waitFor('2 of 5 can be added');
        const first = await rows();
        check(first.length === 5, 'Expected 5 rows, got ' + first.length);
        const morning = await rowOf('Morning Light.wav');
        check(morning.state === 'on-ipod' && morning.label === 'Skipped: already on the iPod', 'Morning Light is not marked as on the iPod: ' + JSON.stringify(morning));
        check(morning.text.includes('"Morning Light" by The Demo Band'), 'The row does not name the matching track: ' + morning.text);
        check(/Convert/.test(morning.happens) === false && morning.size === 'Not added', 'A skipped row still shows work or a size: ' + JSON.stringify(morning));
        check((await rowOf('Night Drive.wav')).state === 'on-ipod', 'Night Drive is not marked as on the iPod.');
        const repeat = await rowOf('Brand New.wav');
        check(repeat.state === 'in-list' && repeat.label === 'Skipped: same as 01 Brand New.wav above', 'The repeat inside the list is not marked: ' + JSON.stringify(repeat));
        check((await rowOf('01 Brand New.wav')).state === '', 'The first of two repeats must not be marked.');
        const untitled = await rowOf('!!!.wav');
        check(untitled.state === 'cannot-tell' && untitled.label === 'Could not tell if this is already on the iPod (no title)', 'A file with no title is not left unjudged: ' + JSON.stringify(untitled));
        // The count is up front, and the size line leaves the skipped files out (two small files, not two 5 MB ones).
        await page.waitFor('0 files will be converted, 2 copied as they are, 3 skipped as duplicates');
        const sizeLine = String(await page.evaluate(`document.querySelector('.pane:not([hidden]) .dup-summary').innerText`));
        check(/2 of 5 can be added, about [0-9.]+ KB\./.test(sizeLine) && sizeLine.includes('3 skipped as duplicates'), 'The size line counts skipped rows: ' + sizeLine);
        check((await page.evaluate(`document.querySelector('.dup-summary').getAttribute('aria-live')`)) === 'polite', 'The counts are not in a live region.');
        await page.waitFor('already on the iPod or repeat another file in this list');
        // Phone: the notes sit inside the stacked cards, with no sideways scroll.
        await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        const phone = JSON.parse(String(await page.evaluate(`JSON.stringify({ overflow: document.documentElement.scrollWidth > window.innerWidth + 1, cells: [...document.querySelectorAll('.add-stack tbody tr:first-child td')].map((td) => getComputedStyle(td).display), note: Boolean(document.querySelector('.add-stack .dup-note')) })`)));
        await page.send('Emulation.clearDeviceMetricsOverride');
        check(!phone.overflow && phone.cells.every((display) => display === 'block') && phone.note, 'The marked rows are not cards on a phone: ' + JSON.stringify(phone));

        // 2. Check and prepare never starts the converter for a skipped file, and the plan agrees.
        check((await workers()) === 0, 'A worker was started before Check and prepare.');
        await page.click('Check and prepare');
        await page.waitFor('Ready to copy 2 files', 90_000);
        await page.waitFor('3 files were skipped as duplicates before converting, so they were never converted');
        check((await workers()) === 0, 'The converter was started for a file that was skipped as a duplicate (workers: ' + (await workers()) + ').');
        check(!(await page.evaluate(`document.body.innerText.includes('the first check missed')`)), 'The plan found a duplicate the first check missed.');
        await page.click('Put on the iPod');
        await page.waitFor('Copied 2 files and checked the iPod by reading it back', 90_000);
        await page.waitFor('7 tracks');

        // 3. Offer the same folder again: now everything but the untitled file is on the iPod.
        await clickTab('Add music');
        await page.click('Choose a folder');
        await page.waitFor('1 of 5 can be added');
        check((await rowOf('01 Brand New.wav')).state === 'on-ipod', 'A file added through the app is not recognised when offered again.');
        check((await rowOf('Brand New.wav')).state === 'on-ipod', 'The second repeat should match the iPod now, not the file above it.');
        check((await rowOf('!!!.wav')).state === 'cannot-tell', 'The untitled file should still be let through.');
        // The marks follow the iPod: remove that track in the Library tab and the row is no longer marked.
        await clickTab('Library');
        await page.waitFor('Your library');
        await page.evaluate(`document.querySelector('input[aria-label="Select Brand New"]').click()`);
        await page.waitFor('1 track selected');
        await page.click('Remove selected');
        await page.waitFor('Ready to remove 1 track and delete 1 file');
        await page.click('Remove from the iPod');
        await page.waitFor('Removed 1 track and deleted 1 file');
        await clickTab('Add music');
        await page.waitFor('2 of 5 can be added');
        check((await rowOf('01 Brand New.wav')).state === '', 'The row is still marked after its track left the iPod.');
        check((await rowOf('Brand New.wav')).state === 'in-list', 'The second repeat should match the file above it again.');

        // 4. The box: every duplicate goes through, marked as added anyway, and the converter is needed again.
        await tick(true);
        await page.waitFor('2 files will be converted, 3 copied as they are');
        const anyway = await rowOf('Morning Light.wav');
        check(anyway.state === 'on-ipod' && anyway.label === 'Already on the iPod, added anyway', 'The ticked box is not shown on the row: ' + JSON.stringify(anyway));
        check(/Convert/.test(anyway.happens), 'A duplicate that is added anyway should show its conversion: ' + anyway.happens);
        await tick(false);
        await page.waitFor('0 files will be converted, 2 copied as they are, 3 skipped as duplicates');

        // 5. One row only: Add this one anyway on Night Drive. The others stay skipped.
        check(await pressOnRow('Night Drive.wav', 'Add this one anyway'), 'No Add this one anyway button on Night Drive.');
        await page.waitFor('1 file will be converted, 2 copied as they are, 2 skipped as duplicates');
        check((await rowOf('Morning Light.wav')).state === 'on-ipod' && (await rowOf('Morning Light.wav')).label.startsWith('Skipped'), 'The other duplicate stopped being skipped.');
        check((await rowOf('Night Drive.wav')).label === 'Already on the iPod, added anyway', 'Night Drive is not marked as added anyway.');
        check((await workers()) === 0, 'Pressing Add this one anyway started the converter by itself.');
        // The converter starts now, for that one file only (this is also the check that the worker count works).
        await page.click('Check and prepare');
        await page.waitFor('Ready to copy 3 files', 120_000);
        check((await workers()) > 0, 'The converter never started for the file that was added anyway, so the worker count proves nothing.');
        await page.waitFor('2 files were skipped as duplicates before converting');
        await page.waitFor('Night Drive');
      },
    },
    expected: ['Ready to copy 3 files', 'skipped as duplicates before converting'],
    forbidden: ['did not finish', 'could not be put back', 'the first check missed'],
    alert: false,
  },
  {
    // Controls and clarity on a practice iPod: tabs keep what they hold, removing and choosing another
    // iPod ask first and say what cannot be undone, and a backup folder is not taken for an iPod.
    name: 'controls and confirm steps on a practice iPod (kept tabs, remove asks first, choose another iPod asks first)',
    url: `http://localhost:${port}/?demo=practice`,
    devtools: {
      doneSelector: 'body',
      timeoutMs: 5_000,
      async drive(page) {
        const check = (condition, message) => {
          if (!condition) throw new Error(message);
        };
        const visibleButton = (text) => page.evaluate(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === ${JSON.stringify(text)} && b.offsetParent !== null)`);
        await page.waitFor('Practice iPod, held in memory');
        await page.click('Backup');
        await page.waitFor('What to include');
        await page.click('Choose where to keep the backup');
        await page.waitFor('Every file was read back and matched');
        // Files picked in Add music survive a visit to another tab.
        await page.click('Add music');
        await page.waitFor('No files chosen yet');
        await page.chooseFiles([TONE_COPY]);
        await page.waitFor('1 of 1 can be added');
        await page.click('Backup');
        await page.waitFor('What to include');
        await page.click('Add music');
        await page.waitFor('1 of 1 can be added');
        // The tab list is a proper tab list: one tab stop, panels named by their tabs.
        const aria = await page.evaluate(`JSON.stringify({ tabindex: [...document.querySelectorAll('.tabs button[role=tab]')].filter((t) => t.tabIndex === 0).length, panels: [...document.querySelectorAll('[role=tabpanel]:not([hidden])')].length })`);
        check(aria === '{"tabindex":1,"panels":1}', 'The tabs are not a single tab stop with one visible panel: ' + aria);
        // Removing asks first and says it cannot be undone from the backup. Backing out changes nothing.
        await page.evaluate(`[...document.querySelectorAll('button[role=tab]')].find((tab) => tab.textContent.trim().startsWith('Library')).click()`);
        await page.waitFor('Your library');
        await page.evaluate(`document.querySelector('input[aria-label="Select Morning Light"]').click()`);
        await page.waitFor('1 track selected');
        await page.click('Remove selected');
        await page.waitFor('Remove 1 track from the iPod?');
        await page.waitFor('This cannot be undone from the backup');
        check(await visibleButton('Remove from the iPod'), 'The confirm step has no Remove button.');
        await page.click('Do not remove');
        check(!(await visibleButton('Remove from the iPod')), 'Backing out of the removal left the Remove button on screen.');
        // Choosing another iPod asks, says what goes away, and Stay keeps everything.
        await page.click('Choose another iPod');
        await page.waitFor('Choose another iPod?');
        await page.waitFor('The practice iPod lives only in memory');
        await page.click('Stay with this iPod');
        await page.waitFor('Your library');
        check(!(await page.evaluate(`document.body.innerText.includes('Stay with this iPod')`)), 'The confirm step stayed open after Stay.');
        // A job in progress is stoppable from the bar, and the bar has a place for Pause.
        await page.click('Look for leftover files');
        await page.waitFor('No leftover files');
      },
    },
    expected: ['No leftover files'],
    forbidden: ['did not finish', 'could not be put back'],
    alert: false,
  },
  {
    // The pieces of Add music that need both the controls and the robustness work to be there: Pause
    // after a file while converting, a leave-the-page warning for converted files that are held, a
    // confirm on Clear the list, the file table as cards on a phone, and Stop while reading.
    name: 'Add music controls (pause while converting, held-work warning, clear asks first, phone cards, stop while reading)',
    url: `http://localhost:${port}/?demo=practice`,
    devtools: {
      doneSelector: 'body',
      timeoutMs: 5_000,
      async drive(page) {
        const check = (condition, message) => {
          if (!condition) throw new Error(message);
        };
        const leaveAsks = () => page.evaluate(`(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; })()`);
        await page.waitFor('Practice iPod, held in memory');
        await page.click('Backup');
        await page.waitFor('What to include');
        await page.click('Choose where to keep the backup');
        await page.waitFor('Every file was read back and matched');
        await page.click('Add music');
        await page.waitFor('No files chosen yet');
        check(!(await leaveAsks()), 'The page asked before leaving with nothing held.');
        await page.chooseFiles([TONE_CONVERT, TONE_COPY]);
        await page.waitFor('2 of 2 can be added');
        // The list is a table on a wide screen and one card per file on a phone, each cell under its label.
        await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        const phone = JSON.parse(
          String(
            await page.evaluate(`JSON.stringify({
              cells: [...document.querySelectorAll('.add-stack tbody tr:first-child td')].map((td) => getComputedStyle(td).display),
              label: getComputedStyle(document.querySelector('.add-stack tbody tr:first-child td[data-label="What happens"]'), '::before').content,
              overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
            })`),
          ),
        );
        check(phone.cells.every((display) => display === 'block'), 'The Add music rows are not stacked cards on a phone: ' + phone.cells.join(','));
        check(phone.label.includes('What happens'), 'A card cell has no label: ' + phone.label);
        check(!phone.overflow, 'The Add music list scrolls sideways on a phone.');
        await page.send('Emulation.clearDeviceMetricsOverride');
        // Pause after the file being converted. The bar says paused and offers Resume.
        await page.click('Check and prepare');
        await page.waitFor('Converting 1 of 2');
        await page.click('Pause after this file');
        await page.waitFor('Paused before the next file');
        await page.waitFor('Paused: Preparing files');
        await page.click('Resume');
        await page.waitFor('Ready to copy 2 files', 90_000);
        // Converted files are held: leaving asks. Clear the list asks first, and Keep keeps them.
        check(await leaveAsks(), 'The page did not ask before leaving while converted files are held.');
        await page.click('Clear the list');
        await page.waitFor('Clear 2 files from the list?');
        await page.waitFor('the files converted so far are thrown away');
        await page.click('Keep the list');
        await page.waitFor('Ready to copy 2 files');
        check(await leaveAsks(), 'Keeping the list released the held files.');
        await page.click('Clear the list');
        await page.click('Yes, clear the list');
        await page.waitFor('No files chosen yet');
        // The held files are released once the page has drawn again.
        for (let i = 0; i < 30 && (await leaveAsks()); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
        check(!(await leaveAsks()), 'The page still asks before leaving after the list was cleared.');
        // Stop while reading the files: a folder whose listing never ends is stopped from the bar, and the list stays empty.
        await page.evaluate(`(() => {
          const never = { kind: 'directory', name: 'Slow', async *entries() { for (let i = 0; i < 1000; i += 1) { await new Promise((resolve) => setTimeout(resolve, 20)); yield ['file' + i + '.txt', { kind: 'file', name: 'file' + i + '.txt', getFile: async () => new File([], 'x') }]; } } };
          window.showDirectoryPicker = async () => never;
        })()`);
        await page.click('Choose a folder');
        await page.waitFor('Reading the folder');
        await page.click('Stop reading (nothing is changed)');
        await page.waitFor('Stopped: reading the folder');
        await page.waitFor('Nothing was added and nothing on the iPod was changed');
        await page.waitFor('No files chosen yet');
      },
    },
    expected: ['No files chosen yet', 'Stopped: reading the folder'],
    forbidden: ['did not finish', 'could not be put back'],
    alert: false,
  },
  {
    // Kept tabs and the write lock together: while a write runs (the lock is taken the way a running
    // write takes it), every control in every panel is off, hidden panels too, the tab list still
    // works with the arrow keys so the running job's tab can be looked at, and everything comes back
    // when the lock is released.
    name: 'kept tabs and the write lock (hidden panels are off during a write, the tab list still works)',
    url: `http://localhost:${port}/?demo=practice`,
    devtools: {
      doneSelector: 'body',
      timeoutMs: 5_000,
      async drive(page) {
        const check = (condition, message) => {
          if (!condition) throw new Error(message);
        };
        const run = async (expression) => (await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
        await page.waitFor('Practice iPod, held in memory');
        // Open Add music so it is mounted, then go back to the library: Add music is now hidden but alive.
        await page.click('Add music');
        await page.waitFor('No files chosen yet');
        await page.evaluate(`[...document.querySelectorAll('button[role=tab]')].find((tab) => tab.textContent.trim().startsWith('Library')).click()`);
        await page.waitFor('Your library');
        const shape = JSON.parse(
          String(
            await page.evaluate(`JSON.stringify({
              fieldset: Boolean(document.querySelector('fieldset.write-lock')),
              panelsInside: [...document.querySelectorAll('[role=tabpanel]')].every((panel) => panel.closest('fieldset.write-lock')),
              tabsOutside: [...document.querySelectorAll('.tabs button[role=tab]')].every((tab) => !tab.closest('fieldset.write-lock')),
              panels: document.querySelectorAll('[role=tabpanel]').length,
              visible: document.querySelectorAll('[role=tabpanel]:not([hidden])').length,
            })`),
          ),
        );
        check(shape.fieldset && shape.panelsInside && shape.tabsOutside, 'The panels are not all inside the write-lock fieldset, or the tabs are: ' + JSON.stringify(shape));
        check(shape.panels >= 2 && shape.visible === 1, 'Add music was not kept mounted behind the library: ' + JSON.stringify(shape));
        const choose = `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Choose files')`;
        check(await page.evaluate(`!${choose}.matches(':disabled')`), 'Choose files is off with no write running.');
        // A write is running.
        check((await run('window.__opentunesPractice.holdWriteLock()')) === true, 'Could not take the write lock.');
        await page.waitFor('The iPod is being changed (Test write)');
        check(await page.evaluate(`${choose}.matches(':disabled')`), 'Choose files, in the hidden Add music panel, is still on while a write runs.');
        check(await page.evaluate(`document.querySelector('fieldset.write-lock').disabled`), 'The fieldset is not disabled during a write.');
        // A second write is refused by the lock itself, with a plain message.
        const refused = await run(`window.__opentunesPractice.tryAnotherWrite()`);
        check(String(refused).includes('Another change to the iPod is already running (test write)'), 'The lock did not refuse a second write: ' + refused);
        check(await page.evaluate(`[...document.querySelectorAll('.tabs button[role=tab]')].every((tab) => !tab.disabled)`), 'The tabs were turned off, so a running job cannot be looked at.');
        // The arrow keys still move between tabs, and the panel that was hidden shows, still off.
        await page.evaluate(`document.querySelector('.tabs button[role=tab][aria-selected=true]').focus()`);
        await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
        await page.waitFor('No files chosen yet');
        const focusOnSelectedTab = () => page.evaluate(`document.activeElement.getAttribute('role') === 'tab' && document.activeElement.getAttribute('aria-selected') === 'true'`);
        // Focus moves in a timer after the tab changes, so give it a moment.
        for (let i = 0; i < 30 && !(await focusOnSelectedTab()); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
        check(await focusOnSelectedTab(), 'Focus did not follow the arrow key to the new tab.');
        check(await page.evaluate(`${choose}.matches(':disabled')`), 'Choose files came back on while the write still runs.');
        // The write ends and everything comes back.
        await run('window.__opentunesPractice.releaseWriteLock()');
        for (let i = 0; i < 40 && (await page.evaluate(`${choose}.matches(':disabled')`)); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
        check(!(await page.evaluate(`${choose}.matches(':disabled')`)), 'Choose files stayed off after the write ended.');
      },
    },
    expected: ['No files chosen yet'],
    forbidden: ['The iPod is being changed'],
    alert: false,
  },
  {
    // Copies everything off the practice iPod into a folder the page hands back from a faked
    // showDirectoryPicker, the same technique the folder step above uses. The iPod is only read.
    name: 'offloading a practice iPod into a picked folder',
    url: `http://localhost:${port}/?demo=practice`,
    devtools: {
      doneSelector: 'body',
      timeoutMs: 5_000,
      async drive(page) {
        await page.waitFor('Practice iPod, held in memory');
        await page.click('Backup');
        await page.waitFor('What to include');
        // A destination folder held in the page: it keeps what is written so the test can look at it.
        await page.evaluate(`(() => {
          const directory = (name) => ({
            kind: 'directory', name, children: new Map(),
            async *entries() { for (const entry of this.children) yield entry; },
            async getDirectoryHandle(child, options = {}) {
              const found = this.children.get(child);
              if (found && found.kind === 'directory') return found;
              if (found || !options.create) throw Object.assign(new Error(child + ' was not found.'), { name: 'NotFoundError' });
              const made = directory(child); this.children.set(child, made); return made;
            },
            async getFileHandle(child, options = {}) {
              const found = this.children.get(child);
              if (found && found.kind === 'file') return found;
              if (found || !options.create) throw Object.assign(new Error(child + ' was not found.'), { name: 'NotFoundError' });
              const file = {
                kind: 'file', name: child, bytes: new Uint8Array(0),
                async getFile() { return new File([this.bytes], child); },
                async createWritable() {
                  const chunks = [];
                  return {
                    write: async (data) => { chunks.push(new Uint8Array(data)); },
                    close: async () => { const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0)); let at = 0; for (const c of chunks) { all.set(c, at); at += c.length; } file.bytes = all; },
                  };
                },
              };
              this.children.set(child, file); return file;
            },
          });
          window.__offloadDestination = directory('offload-destination');
          window.showDirectoryPicker = async () => window.__offloadDestination;
          window.__listOffload = () => { const out = {}; const walk = (dir, prefix) => { for (const [n, e] of dir.children) { if (e.kind === 'directory') walk(e, prefix + n + '/'); else out[prefix + n] = e.bytes; } }; walk(window.__offloadDestination, ''); return out; };
        })()`);
        // Every kind ticked is the full copy.
        await tickKinds(page, 'Music', 'Podcasts', 'Audiobooks', 'Video');
        await page.waitFor('The library and everything on the iPod: 5 files');
        await page.click('Choose where to copy everything');
        await page.waitFor('and checked each by reading it back', 60_000);
        const found = await page.evaluate(`(() => { try {
          const files = window.__listOffload();
          const text = (path) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(files[path]);
          const names = Object.keys(files);
          const folder = names.find((n) => n.endsWith('/library.csv')).split('/')[0];
          const media = names.filter((n) => n.split('/').length === 3 && /^F[0-9][0-9]$/.test(n.split('/')[1]));
          const csv = text(folder + '/library.csv');
          const row = csv.split(String.fromCharCode(13, 10)).find((line) => line.includes('Morning Light')) || '';
          const copy = media.find((n) => n.endsWith(row.split(',')[0]));
          return JSON.stringify({
            folder,
            media: media.length,
            bom: files[folder + '/library.csv'][0] === 0xef && files[folder + '/library.csv'][1] === 0xbb && files[folder + '/library.csv'][2] === 0xbf,
            hasPlaylists: names.includes(folder + '/playlists.csv') && text(folder + '/playlists.csv').includes('Road trip'),
            hasReadme: text(folder + '/README.txt').includes('full copy of an iPod'),
            csvRow: row,
            copyText: copy ? new TextDecoder().decode(files[copy]) : null,
          });
        } catch (error) { return JSON.stringify({ error: String(error) }); } })()`);
        const result = JSON.parse(String(found));
        if (result.error) throw new Error('Reading the offload folder failed in the page: ' + result.error);
        if (!/^opentunes-offload-\d{4}-\d{2}-\d{2}-\d{4}$/.test(result.folder)) throw new Error('The offload folder is not named opentunes-offload-YYYY-MM-DD-HHMM: ' + found);
        if (result.media !== 5) throw new Error('Expected 5 media files copied, found ' + result.media + ': ' + found);
        if (!result.bom) throw new Error('library.csv has no UTF-8 byte order mark.');
        if (!result.hasPlaylists || !result.hasReadme) throw new Error('playlists.csv or README.txt is missing or wrong: ' + found);
        if (!result.csvRow.includes('The Demo Band') || !result.csvRow.endsWith('copied')) throw new Error('library.csv row for Morning Light is wrong: ' + result.csvRow);
        if (result.copyText !== 'stand-in for Morning Light') throw new Error('The copied file does not hold the iPod file\'s bytes: ' + result.copyText);
      },
    },
    expected: ['Copied 5 files', 'in "offload-destination"', 'the database folder, opentunes-offload.json and a README.txt'],
    forbidden: ['could not be copied', 'is not complete'],
    alert: false,
  },
  {
    // Offloads a practice iPod into a faked folder (the technique above), takes one track off the
    // iPod, then puts everything back from that same fake folder and checks what the page says and
    // that the track and its file are back. The folder picker is faked; nothing touches a disk.
    name: 'restoring everything from an offload folder on a practice iPod',
    url: `http://localhost:${port}/?demo=practice`,
    devtools: {
      doneSelector: 'body',
      timeoutMs: 5_000,
      async drive(page) {
        await page.waitFor('Practice iPod, held in memory');
        // The backup of the current state, which Restore everything needs.
        await page.click('Backup');
        await page.waitFor('What to include');
        await page.click('Choose where to keep the backup');
        await page.waitFor('Every file was read back and matched');
        await page.waitFor('What a copy with music and videos gives you');
        await page.waitFor('Restore everything from a full copy');
        await page.evaluate(`(() => {
          const directory = (name) => ({
            kind: 'directory', name, children: new Map(),
            async *entries() { for (const entry of this.children) yield entry; },
            async getDirectoryHandle(child, options = {}) {
              const found = this.children.get(child);
              if (found && found.kind === 'directory') return found;
              if (found || !options.create) throw Object.assign(new Error(child + ' was not found.'), { name: 'NotFoundError' });
              const made = directory(child); this.children.set(child, made); return made;
            },
            async getFileHandle(child, options = {}) {
              const found = this.children.get(child);
              if (found && found.kind === 'file') return found;
              if (found || !options.create) throw Object.assign(new Error(child + ' was not found.'), { name: 'NotFoundError' });
              const file = {
                kind: 'file', name: child, bytes: new Uint8Array(0),
                async getFile() { return new File([this.bytes], child); },
                async createWritable() {
                  const chunks = [];
                  return {
                    write: async (data) => { chunks.push(new Uint8Array(data)); },
                    close: async () => { const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0)); let at = 0; for (const c of chunks) { all.set(c, at); at += c.length; } file.bytes = all; },
                  };
                },
              };
              this.children.set(child, file); return file;
            },
          });
          window.__restoreDestination = directory('restore-destination');
          window.showDirectoryPicker = async () => window.__restoreDestination;
        })()`);
        await tickKinds(page, 'Music', 'Podcasts', 'Audiobooks', 'Video');
        await page.click('Choose where to copy everything');
        await page.waitFor('and checked each by reading it back', 60_000);
        await page.waitFor('are saved in the database folder');
        const saved = await page.evaluate(`(() => { try {
          const folder = [...window.__restoreDestination.children.values()].find((entry) => entry.kind === 'directory');
          const marker = JSON.parse(new TextDecoder().decode(folder.children.get('opentunes-offload.json').bytes));
          const database = folder.children.get('database');
          const info = JSON.parse(new TextDecoder().decode(database.children.get('backup-info.json').bytes));
          return JSON.stringify({ kind: marker.kind, complete: marker.complete, media: marker.mediaFiles, folder: marker.databaseFolder, backupKind: info.kind, backupComplete: info.complete, files: info.files.length });
        } catch (error) { return JSON.stringify({ error: String(error) }); } })()`);
        const marker = JSON.parse(String(saved));
        if (marker.error) throw new Error('Reading the offload folder failed in the page: ' + marker.error);
        if (marker.kind !== 'ipod-offload' || marker.complete !== true || marker.media !== 5 || marker.folder !== 'database') throw new Error('The offload marker is wrong: ' + saved);
        if (marker.backupKind !== 'ipod-database-backup' || marker.backupComplete !== true || marker.files < 1) throw new Error('database/ is not a complete backup: ' + saved);

        // Take a track and its file off the iPod, so there is something to put back.
        await page.evaluate(`[...document.querySelectorAll('button[role=tab]')].find((tab) => tab.textContent.startsWith('Library')).click()`);
        await page.waitFor('Your library');
        await page.evaluate(`document.querySelector('input[aria-label="Select Night Drive"]').click()`);
        await page.waitFor('1 track selected');
        await page.click('Remove selected');
        await page.waitFor('Ready to remove 1 track and delete 1 file');
        await page.click('Remove from the iPod');
        await page.waitFor('Removed 1 track and deleted 1 file');
        await page.waitFor('4 tracks');

        // Put everything back from the offload folder, picked through the same fake picker.
        await page.click('Backup');
        await page.waitFor('Restore everything from a full copy');
        await page.evaluate(`window.showDirectoryPicker = async () => [...window.__restoreDestination.children.values()].find((entry) => entry.kind === 'directory')`);
        await page.click('Choose a full-copy folder');
        await page.waitFor('holds 5 media files');
        await page.waitFor('4 of the media files are already on this iPod');
        await page.waitFor('This replaces the iPod\'s library');
        await page.click('Restore everything to the iPod...');
        await page.waitFor('Put everything back on the iPod?');
        await page.click('Restore everything to the iPod');
        await page.waitFor('1 file was copied back to the iPod, 4 files were already there and left alone', 60_000);
        await page.waitFor('The saved library was put back, read back and checked');
        await page.waitFor('The iPod can now be ejected');
        await page.evaluate(`[...document.querySelectorAll('button[role=tab]')].find((tab) => tab.textContent.startsWith('Library')).click()`);
        await page.waitFor('Your library');
        await page.waitFor('5 tracks');
        await page.waitFor('Night Drive');
      },
    },
    expected: ['Night Drive', '5 tracks', 'Done: putting everything back on the ipod'],
    forbidden: ['could not be copied back', 'did not finish', 'did not check out cleanly', 'is not complete'],
    alert: false,
  },
  {
    // A fresh browser profile: the landing shows the risk notice once, the footer link opens the
    // About page with the credits read from THIRD_PARTY.md, and a reload does not show the notice again.
    name: 'the landing risk notice (once) and the About, credits and risk page',
    url: `http://localhost:${port}/`,
    devtools: {
      doneSelector: 'body',
      timeoutMs: 5_000,
      async drive(page) {
        await page.waitFor('Choose iPod folder');
        await page.waitFor('Use at your own risk.');
        await page.click('Read the details');
        await page.waitFor('Back up first.');
        for (const text of ['not affiliated with, or endorsed by, Apple', 'iPod is a trademark of Apple Inc.', 'nano 7th generation', 'Nothing is downloaded from streaming services', 'LGPL, version 2 or later (source file headers)', 'GPL 2 or later (package.json)', 'The Unlicense (public domain)', 'MIT (package.json)']) {
          await page.waitFor(text, 5_000);
        }
        await page.click('Close');
        await page.click('About, credits and risk');
        await page.waitFor('Credits');
        await page.send('Page.reload');
        await page.waitFor('Choose iPod folder');
        await new Promise((resolve) => setTimeout(resolve, 500));
        const again = String(await page.evaluate('document.body.innerText'));
        if (again.includes('Use at your own risk.')) throw new Error('The risk notice came back after a reload.');
        if (!again.includes('About, credits and risk')) throw new Error('The footer link is missing after a reload.');
      },
    },
    expected: ['About, credits and risk'],
    forbidden: [],
    alert: false,
  },
  {
    // A change that never finished: the app writes a note in the browser when a write starts. Here the
    // note is planted the way the app writes it (IndexedDB, database "opentunes", store "kv"), then the
    // page is reloaded, as if the tab had been closed mid-write. The banner must appear, Dismiss must
    // clear it for good, and the log must still hold what came before the reload.
    name: 'a change that never finished: the note left in the browser shows a banner after a reload, and Dismiss clears it',
    url: `http://localhost:${port}/?demo=practice`,
    devtools: {
      doneSelector: 'body',
      timeoutMs: 5_000,
      async drive(page) {
        const check = (condition, message) => {
          if (!condition) throw new Error(message);
        };
        const run = async (expression) => (await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
        await page.waitFor('Practice iPod, held in memory');
        check(!String(await page.evaluate('document.body.innerText')).includes('did not finish'), 'A banner showed before any note existed.');
        await run(`new Promise((resolve, reject) => {
          const open = indexedDB.open('opentunes', 1);
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const tx = open.result.transaction('kv', 'readwrite');
            tx.objectStore('kv').put({ version: 1, operation: 'Saving changes to the iPod', startedAt: Date.now() - 60000, ipod: 'MY IPOD', backup: 'opentunes-backup-2026-11-07-1200', status: 'running', practice: false }, 'write-journal');
            tx.oncomplete = () => resolve(true);
          };
        })`);
        await page.send('Page.reload');
        await page.waitFor('The last change to the iPod did not finish (it was saving changes to the iPod at');
        await page.waitFor('look at the Diagnostics tab');
        await page.waitFor('restore your backup');
        await page.waitFor('opentunes-backup-2026-11-07-1200');
        await page.waitFor('Take me to Backup');
        // The log kept the earlier page's lines, and says the note was found.
        await page.evaluate("document.querySelector('.log-button').click()");
        await page.waitFor('A change to the iPod was found that never finished');
        await page.waitFor('before the reload');
        await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
        await page.click('Dismiss');
        await new Promise((resolve) => setTimeout(resolve, 300));
        check(!String(await page.evaluate('document.body.innerText')).includes('did not finish (it was'), 'Dismiss did not hide the banner.');
        await page.send('Page.reload');
        await page.waitFor('Practice iPod, held in memory');
        await new Promise((resolve) => setTimeout(resolve, 500));
        check(!String(await page.evaluate('document.body.innerText')).includes('did not finish (it was'), 'The banner came back after Dismiss and a reload.');
      },
    },
    expected: ['Practice iPod, held in memory'],
    forbidden: ['did not finish (it was'],
    alert: false,
  },
  {
    // Two changes at once, and a change made behind the page's back. Two clicks on Save in the same
    // moment: one write runs, the second is refused with a plain message. Then the practice iPod is
    // changed outside the page (as iTunes would) and Reload from the iPod must notice, reset the
    // screens and stop counting the old backup.
    name: 'a double click on Save is held back by the panel, and Reload from the iPod picks up a change made behind the back',
    url: `http://localhost:${port}/?demo=practice`,
    devtools: {
      doneSelector: 'body',
      timeoutMs: 5_000,
      async drive(page) {
        const check = (condition, message) => {
          if (!condition) throw new Error(message);
        };
        const run = async (expression) => (await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
        await page.waitFor('Practice iPod, held in memory');
        await page.waitFor('Last read from the iPod:');
        await page.click('Backup');
        await page.waitFor('What to include');
        await page.click('Choose where to keep the backup');
        await page.waitFor('Every file was read back and matched');
        await page.evaluate(`[...document.querySelectorAll('button[role=tab]')].find((tab) => tab.textContent.startsWith('Library')).click()`);
        await page.waitFor('Your library');
        await page.evaluate(`document.querySelector('input[aria-label="Select Morning Light"]').click()`);
        await page.waitFor('Edit this track');
        await page.evaluate(`(() => { const box = document.querySelector('h4 + label input'); box.value = 'Morning Light (twice)'; box.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        // Two clicks in the same moment.
        await page.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Save changes to the iPod'); b.click(); b.click(); })()`);
        await page.waitFor('Saved.', 90_000);
        const titles = String(await page.evaluate(`[...document.querySelectorAll('td.cell-title')].map((cell) => cell.textContent.trim()).join('|')`));
        check(titles.split('Morning Light (twice)').length === 2, 'The edit should be on the iPod once: ' + titles);
        // The panel's once-only guard swallows the second click, so the lock is not even asked. The lock's
        // own refusal is checked in the kept tabs scenario below and in write-lock.test.ts.
        await page.evaluate("document.querySelector('.log-button').click()");
        await page.waitFor('Finished: Saving changes to the iPod');
        check(!String(await page.evaluate('document.body.innerText')).includes('Another change to the iPod is already running'), 'The second click reached the lock, so the panel guard did not hold it back.');
        await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
        // A change made outside the page: the first track is removed through the engine, without telling the page.
        check((await run(`window.__opentunesPractice.removeFirstTrackBehindTheBack()`)) === 1, 'The change behind the back did not work.');
        await page.waitFor('Backup made');
        await page.click('Reload from the iPod');
        await page.waitFor('The iPod changed since it was last read');
        await page.waitFor('4 tracks');
        await page.waitFor('No backup yet');
        await page.waitFor('earlier backup no longer matches');
        // A second reload with nothing changed says so, and keeps the screens.
        await page.click('Reload from the iPod');
        await page.waitFor('Nothing had changed');
      },
    },
    expected: ['Last read from the iPod:', '4 tracks'],
    forbidden: ['The iPod is being changed'],
    alert: false,
  },
  {
    // The Logs button: an entry for something that just ran, Copy log, Download log, Errors only, and
    // Escape closing the drawer with focus back on the button. Clipboard and download are stood in for
    // so the test can read what would have been copied and saved.
    name: 'the Logs button shows what ran, copies and downloads it, and Escape closes it',
    url: `http://localhost:${port}/?demo=practice`,
    devtools: {
      doneSelector: 'body',
      timeoutMs: 5_000,
      async drive(page) {
        const check = (condition, message) => {
          if (!condition) throw new Error(message);
        };
        await page.waitFor('Practice iPod, held in memory');
        await page.click('Backup');
        await page.waitFor('What to include');
        await page.click('Choose where to keep the backup');
        await page.waitFor('Every file was read back and matched');
        await page.evaluate(`(() => {
          window.__copied = null; window.__saved = null;
          Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { window.__copied = text; } } });
          const create = URL.createObjectURL.bind(URL);
          URL.createObjectURL = (blob) => { blob.text().then((text) => { window.__saved = text; }); return create(blob); };
        })()`);
        check((await page.evaluate(`document.querySelector('.log-button').getBoundingClientRect().height >= 44`)) === true, 'The Logs button is smaller than 44 px.');
        await page.evaluate("document.querySelector('.log-button').click()");
        await page.waitFor('This log stays in your browser. It may contain file names, so look through it before you share it.');
        await page.waitFor('Finished: Backing up the iPod');
        await page.waitFor('Started: Backing up the iPod');
        await page.click('Copy log');
        await page.waitFor('Copied.');
        check(String(await page.evaluate('window.__copied')).includes('Finished: Backing up the iPod'), 'Copy log did not copy the entries.');
        await page.click('Download log (.txt)');
        await page.waitFor('Downloaded.');
        await new Promise((resolve) => setTimeout(resolve, 300));
        check(String(await page.evaluate('window.__saved')).includes('Finished: Backing up the iPod'), 'Download log did not save the entries.');
        // No private data in what was copied.
        check(!/000A27|000A95/i.test(String(await page.evaluate('window.__copied'))), 'The log holds an ID.');
        await page.evaluate(`document.querySelector('.log-tools input[type=checkbox]').click()`);
        await page.waitFor('No errors.');
        await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
        await new Promise((resolve) => setTimeout(resolve, 300));
        check((await page.evaluate(`Boolean(document.querySelector('.log-panel'))`)) === false, 'Escape did not close the log.');
        check((await page.evaluate(`document.activeElement && document.activeElement.classList.contains('log-button')`)) === true, 'Focus did not return to the Logs button.');
      },
    },
    expected: ['Logs'],
    forbidden: [],
    alert: false,
  },
  {
    // Reconnect after a reload. A folder handle (here a folder in the browser's private storage, which
    // is a real FileSystemDirectoryHandle) is kept the way the app keeps the iPod's, the page is
    // reloaded, and the landing page must offer Reconnect with its name. Using it asks for permission
    // and reads the folder: this one is not an iPod, so the plain "no iPod_Control folder" message shows.
    name: 'Reconnect is offered for the folder used last time, after a reload',
    url: `http://localhost:${port}/`,
    devtools: {
      doneSelector: 'body',
      timeoutMs: 5_000,
      async drive(page) {
        const run = async (expression) => (await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
        await page.waitFor('Choose iPod folder');
        await new Promise((resolve) => setTimeout(resolve, 500));
        await run(`(async () => {
          const root = await navigator.storage.getDirectory();
          const folder = await root.getDirectoryHandle('smoke-ipod-folder', { create: true });
          await new Promise((resolve, reject) => {
            const open = indexedDB.open('opentunes', 1);
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
              const tx = open.result.transaction('kv', 'readwrite');
              tx.objectStore('kv').put({ name: 'smoke-ipod-folder', handle: folder, savedAt: Date.now() }, 'ipod-handle');
              tx.oncomplete = resolve;
              tx.onerror = () => reject(tx.error);
            };
          });
          return true;
        })()`);
        await page.send('Page.reload');
        await page.waitFor('Reconnect smoke-ipod-folder');
        await page.waitFor('Chrome forgets the permission when the page reloads');
        await page.click('Reconnect smoke-ipod-folder');
        await page.waitFor('has no iPod_Control folder');
      },
    },
    expected: ['Reconnect smoke-ipod-folder', 'has no iPod_Control folder'],
    forbidden: [],
    alert: true,
  },
  {
    // One panel, nothing ticked: the quick backup of the library only, exactly as before.
    name: 'one backup panel: a quick backup with nothing ticked (library only)',
    url: `http://localhost:${port}/?demo=practice`,
    devtools: {
      doneSelector: 'body',
      timeoutMs: 5_000,
      async drive(page) {
        const check = (condition, message) => {
          if (!condition) throw new Error(message);
        };
        await page.waitFor('Practice iPod, held in memory');
        await page.waitFor('No backup yet');
        await page.click('Backup');
        await page.waitFor('What to include');
        await page.waitFor('Nothing ticked: only the library is saved');
        const boxes = String(await page.evaluate(`JSON.stringify([...document.querySelectorAll('.include-list label')].map((l) => l.textContent.replace(/\\s+/g, ' ').trim()))`));
        check(boxes.includes('Music') && boxes.includes('Podcasts') && boxes.includes('Audiobooks') && boxes.includes('Video'), 'The kinds are not all offered: ' + boxes);
        check(boxes.includes('2 files') && boxes.includes('1 file,'), 'The boxes do not say how many files each kind has: ' + boxes);
        check(!boxes.includes('Only the tracks I selected'), 'The selection box is offered with nothing selected: ' + boxes);
        await page.click('Choose where to keep the backup');
        await page.waitFor('Every file was read back and matched');
        await page.waitFor('Backup made');
        const text = String(await page.evaluate('document.body.innerText'));
        check(!text.includes('opentunes-offload.json'), 'A quick backup should not make a full copy.');
      },
    },
    expected: ['Backed up', 'Backup made'],
    forbidden: ['could not be copied', 'is not complete'],
    alert: false,
  },
  {
    // Only Podcasts ticked: a partial copy. The library part is complete, the marker, README and library.csv say what is missing,
    // the copy counts as the backup, and Restore everything says how many tracks the folder holds.
    name: 'one backup panel: a copy with only Podcasts ticked (partial, counts as the backup, restore says so)',
    url: `http://localhost:${port}/?demo=practice`,
    devtools: {
      doneSelector: 'body',
      timeoutMs: 5_000,
      async drive(page) {
        const check = (condition, message) => {
          if (!condition) throw new Error(message);
        };
        await page.waitFor('Practice iPod, held in memory');
        await page.click('Backup');
        await page.waitFor('What to include');
        await page.evaluate(FAKE_FOLDER);
        check((await tickKinds(page, 'Podcasts')) === 'ok', 'The Podcasts box is missing.');
        await page.waitFor('a partial copy of the media: 1 file');
        await page.click('Choose where to copy');
        await page.waitFor('Copied 1 file', 60_000);
        await page.waitFor('This is a partial copy (only these kinds: podcasts)');
        await page.waitFor('counts as your backup');
        await page.waitFor('Backup made');
        const found = JSON.parse(String(await page.evaluate(`(() => { try {
          const files = window.__files();
          const names = Object.keys(files);
          const folder = names.find((n) => n.endsWith('/library.csv')).split('/')[0];
          const media = names.filter((n) => /^[^/]+\\/F[0-9][0-9]\\/[^/]+$/.test(n));
          const marker = JSON.parse(window.__text(folder + '/opentunes-offload.json'));
          const info = JSON.parse(window.__text(folder + '/database/backup-info.json'));
          const rows = window.__text(folder + '/library.csv').split(String.fromCharCode(13, 10)).filter(Boolean).slice(1);
          return JSON.stringify({ media: media.length, partial: marker.partial, complete: marker.complete, tracks: marker.tracks, backupComplete: info.complete, backupFiles: info.files.length,
            readme: window.__text(folder + '/README.txt').includes('PARTIAL copy of an iPod'), notIncluded: rows.filter((r) => r.endsWith('not included in this copy')).length, copied: rows.filter((r) => r.endsWith(',copied')).length });
        } catch (error) { return JSON.stringify({ error: String(error) }); } })()`)));
        check(!found.error, 'Reading the copy failed in the page: ' + found.error);
        check(found.media === 1, 'Expected 1 media file, found ' + found.media);
        check(found.complete === true && found.partial && found.partial.selectedOnly === false && JSON.stringify(found.partial.kinds) === '["podcast"]' && found.partial.tracksNotIncluded === 4 && found.partial.tracksInCopy === 1, 'The marker does not say what is partial: ' + JSON.stringify(found));
        check(found.backupComplete === true && found.backupFiles > 0, 'database/ is not a complete backup: ' + JSON.stringify(found));
        check(found.readme === true && found.notIncluded === 4 && found.copied === 1, 'The README or library.csv does not say what is left out: ' + JSON.stringify(found));
        // Restore everything, step 2: it says plainly that the folder holds only some of the tracks.
        await page.evaluate(`window.showDirectoryPicker = async () => [...window.__dest.children.values()].find((entry) => entry.kind === 'directory')`);
        await page.click('Choose a full-copy folder');
        await page.waitFor('This is a partial copy (only these kinds: podcasts)');
        await page.waitFor('This copy holds the files for 1 of 5 tracks. The other 4 tracks stay as they are on the iPod, or will have no file if the iPod was wiped.');
      },
    },
    expected: ['This copy holds the files for 1 of 5 tracks'],
    forbidden: ['could not be copied', 'is not complete'],
    alert: false,
  },
  {
    // Only what is selected in the Library tab: the selection is shared with the Backup tab.
    name: 'one backup panel: a copy of only the tracks selected in the Library tab',
    url: `http://localhost:${port}/?demo=practice`,
    devtools: {
      doneSelector: 'body',
      timeoutMs: 5_000,
      async drive(page) {
        const check = (condition, message) => {
          if (!condition) throw new Error(message);
        };
        await page.waitFor('Practice iPod, held in memory');
        await page.waitFor('Your library');
        await page.evaluate(`document.querySelector('input[aria-label="Select Morning Light"]').click()`);
        await page.evaluate(`document.querySelector('input[aria-label="Select Night Drive"]').click()`);
        await page.waitFor('2 tracks selected');
        await page.click('Backup');
        await page.waitFor('What to include');
        await page.waitFor('Only the tracks I selected in the Library tab (2 selected)');
        await page.evaluate(FAKE_FOLDER);
        await page.evaluate(`document.querySelector('.include-selected input').click()`);
        await page.waitFor('a partial copy of the media: 2 files');
        await page.click('Choose where to copy');
        await page.waitFor('Copied 2 files', 60_000);
        await page.waitFor('This is a partial copy (only the tracks that were selected)');
        const found = JSON.parse(String(await page.evaluate(`(() => { try {
          const names = Object.keys(window.__files());
          const folder = names.find((n) => n.endsWith('/library.csv')).split('/')[0];
          const media = names.filter((n) => /^[^/]+\\/F[0-9][0-9]\\/[^/]+$/.test(n));
          const marker = JSON.parse(window.__text(folder + '/opentunes-offload.json'));
          const rows = window.__text(folder + '/library.csv').split(String.fromCharCode(13, 10)).filter(Boolean).slice(1);
          return JSON.stringify({ media: media.length, partial: marker.partial, light: rows.find((r) => r.includes('Morning Light')) || '', film: rows.find((r) => r.includes('Demo Film')) || '' });
        } catch (error) { return JSON.stringify({ error: String(error) }); } })()`)));
        check(!found.error, 'Reading the copy failed in the page: ' + found.error);
        check(found.media === 2, 'Expected 2 media files, found ' + found.media);
        check(found.partial && found.partial.selectedOnly === true && found.partial.kinds === null && found.partial.tracksInCopy === 2 && found.partial.tracksNotIncluded === 3, 'The marker does not say it is selected tracks only: ' + JSON.stringify(found));
        check(found.light.endsWith(',copied') && found.film.endsWith('not included in this copy'), 'library.csv does not tell the two apart: ' + found.light + ' | ' + found.film);
      },
    },
    expected: ['Copied 2 files', 'Backup made'],
    forbidden: ['could not be copied', 'is not complete'],
    alert: false,
  },
  {
    // Where a change is off for lack of a backup there is a "Back up now" button that makes it right there, and the
    // buttons come on with no page change. A running read job turns the write buttons off with the reason shown, and
    // they come back on by themselves.
    name: 'Back up now where a change is off, and write buttons off with a reason while a read job runs',
    url: `http://localhost:${port}/?demo=practice`,
    devtools: {
      doneSelector: 'body',
      timeoutMs: 5_000,
      async drive(page) {
        const check = (condition, message) => {
          if (!condition) throw new Error(message);
        };
        const disabled = async (text) => page.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(text)} && x.offsetParent !== null); return b ? b.disabled : null; })()`);
        const visible = (text) => page.evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`);
        await page.waitFor('Practice iPod, held in memory');
        await page.waitFor('Your library');
        await page.waitFor('Make a backup first.');
        await page.waitFor('Back up now');
        check(await page.evaluate(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Backup options' && b.offsetParent !== null)`), 'There is no Backup options link next to Back up now.');
        await page.evaluate(`document.querySelector('input[aria-label="Select Morning Light"]').click()`);
        await page.waitFor('1 track selected');
        check((await disabled('Remove selected')) === true, 'Remove selected is on with no backup.');
        await page.click('Back up now');
        await page.waitFor('Backup made');
        check(!(await visible('Make a backup first.')), 'The notice stayed after the backup.');
        check((await disabled('Remove selected')) === false, 'Remove selected did not come on after Back up now.');
        // A read job (a backup or a copy would be one) holds the write buttons off, with the reason.
        const wording = 'Off while "Backing up the iPod" is running. Wait for it or stop it from the bar above.';
        check((await page.evaluate(`window.__opentunesPractice.holdReadLock('Backing up the iPod')`)) === true, 'Could not take the read lock.');
        await page.waitFor(wording);
        check((await disabled('Remove selected')) === true, 'Remove selected is on while a read job runs.');
        await page.evaluate(`window.__opentunesPractice.releaseReadLock()`);
        await new Promise((resolve) => setTimeout(resolve, 300));
        check(!(await visible(wording)), 'The reason stayed after the job ended.');
        check((await disabled('Remove selected')) === false, 'Remove selected did not come back on by itself.');
        // Add music: the same line, and Put on the iPod stays off while it runs.
        await page.click('Add music');
        await page.waitFor('No files chosen yet');
        await page.chooseFiles([TONE_COPY]);
        await page.waitFor('1 of 1 can be added');
        await page.click('Check and prepare');
        await page.waitFor('Ready to copy 1 file');
        check((await disabled('Put on the iPod')) === false, 'Put on the iPod is off with a backup and no job running.');
        await page.evaluate(`window.__opentunesPractice.holdReadLock('Copying files off the iPod')`);
        await page.waitFor('Off while "Copying files off the iPod" is running.');
        check((await disabled('Put on the iPod')) === true, 'Put on the iPod is on while a read job runs.');
        await page.evaluate(`window.__opentunesPractice.releaseReadLock()`);
        await new Promise((resolve) => setTimeout(resolve, 300));
        check((await disabled('Put on the iPod')) === false, 'Put on the iPod did not come back on by itself.');
      },
    },
    expected: ['Backup made'],
    forbidden: ['did not finish'],
    alert: false,
  },
  {
    // An OPFS folder stands in for the iPod and for the backup folder. The page makes a backup of it, which it remembers by the
    // iPod folder name. After a reload the backup is found and checked with no click (matches: counted, no new backup asked).
    // With a change made behind the page's back it offers both choices, and the older one counts only after the confirm.
    // With Chrome's permission faked as "not yet" it shows one button, "Check my last backup".
    name: 'the last backup is checked automatically when an iPod is opened (matches, differs with both choices, needs a click)',
    url: `http://localhost:${port}/?demo=practice`,
    devtools: {
      doneSelector: 'body',
      timeoutMs: 5_000,
      async drive(page) {
        const check = (condition, message) => {
          if (!condition) throw new Error(message);
        };
        const run = async (expression) => {
          const answer = (await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result;
          if (answer?.exceptionDetails) throw new Error('In the page: ' + JSON.stringify(answer.exceptionDetails).slice(0, 500));
          return answer?.result?.value;
        };
        const visible = (text) => page.evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`);
        const base = `http://localhost:${port}/`;
        const reopen = async () => {
          await page.send('Page.navigate', { url: base });
          await page.waitFor('Reconnect smoke-auto-ipod');
          await page.click('Reconnect smoke-auto-ipod');
          await page.waitFor('Last read from the iPod');
        };
        await page.waitFor('Practice iPod, held in memory');
        // The practice iPod's files, copied into a folder in the browser's private storage, and kept as "the iPod folder used last time".
        await run(`(async () => {
          const files = window.__opentunesPractice.root.listFiles();
          const root = await navigator.storage.getDirectory();
          await root.getDirectoryHandle('smoke-auto-backups', { create: true });
          const ipod = await root.getDirectoryHandle('smoke-auto-ipod', { create: true });
          for (const [path, bytes] of files) {
            let directory = ipod; const parts = path.split('/');
            for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part, { create: true });
            const writer = await (await directory.getFileHandle(parts[parts.length - 1], { create: true })).createWritable();
            await writer.write(bytes); await writer.close();
          }
          await new Promise((resolve, reject) => {
            const open = indexedDB.open('opentunes', 1);
            open.onerror = () => reject(open.error);
            open.onsuccess = () => { const tx = open.result.transaction('kv', 'readwrite'); tx.objectStore('kv').put({ name: 'smoke-auto-ipod', handle: ipod, savedAt: Date.now() }, 'ipod-handle'); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); };
          });
          return files.size;
        })()`);

        // 1. A first backup of that "real" iPod folder, into the other folder. The page remembers where it is.
        await reopen();
        check(await visible('No backup yet'), 'A new iPod folder should start with no backup.');
        await page.click('Backup');
        await page.waitFor('What to include');
        await page.evaluate(`window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('smoke-auto-backups')`);
        await page.click('Choose where to keep the backup');
        await page.waitFor('Every file was read back and matched');
        const until = Date.now() + 10_000;
        for (;;) {
          const kept = await run(`new Promise((resolve) => { const open = indexedDB.open('opentunes', 1); open.onsuccess = () => { const r = open.result.transaction('kv').objectStore('kv').get('backup-record:smoke-auto-ipod'); r.onsuccess = () => resolve(Boolean(r.result)); }; })`);
          if (kept) break;
          if (Date.now() > until) throw new Error('The backup folder was not remembered after the backup.');
          await new Promise((resolve) => setTimeout(resolve, 200));
        }

        // 2. After a reload the last backup is found and checked with no click: it matches, so it counts and no new backup is asked.
        await reopen();
        await page.waitFor('still matches this iPod');
        await page.click('Backup');
        await page.waitFor('so you do not need another');
        check(!(await visible('No backup yet')), 'The chip says there is no backup though the last one matches.');
        check(await page.evaluate(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Make a new backup anyway' && b.offsetParent !== null)`), 'There is no "Make a new backup anyway" button.');
        check(!(await visible('Make a backup first.')), 'The gate shows though the last backup counts.');

        // 3. The iPod changed behind the page's back: both choices, and the older backup counts only after the confirm.
        await run(`(async () => { const ipod = await (await navigator.storage.getDirectory()).getDirectoryHandle('smoke-auto-ipod'); const itunes = await (await ipod.getDirectoryHandle('iPod_Control')).getDirectoryHandle('iTunes'); const writer = await (await itunes.getFileHandle('Extra', { create: true })).createWritable(); await writer.write(new TextEncoder().encode('changed by another program')); await writer.close(); return true; })()`);
        await reopen();
        await page.click('Backup');
        await page.waitFor('Your last backup is out of date');
        await page.waitFor('the library (1 file)');
        check(await visible('No backup yet'), 'A backup that does not match must not count on its own.');
        check(await page.evaluate(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Make a new backup' && b.offsetParent !== null)`), 'No "Make a new backup" button.');
        await page.click('Use that old backup anyway');
        await page.waitFor('Use the older backup anyway?');
        await page.waitFor("would take the iPod's library back to");
        await page.waitFor("The app's own changes are still undone automatically if they fail.");
        check(await visible('No backup yet'), 'The older backup counted before the confirm.');
        await page.click('Yes, use the older backup');
        await page.waitFor('Older backup from');
        await page.waitFor('in use');
        check(!(await visible('No backup yet')), 'The chip still says no backup after the confirm.');
        await page.evaluate("document.querySelector('.log-button').click()");
        await page.waitFor('was chosen to be used anyway');

        // 4. Chrome has not given the folder yet: one button, and a click checks it.
        await run(`(async () => { const ipod = await (await navigator.storage.getDirectory()).getDirectoryHandle('smoke-auto-ipod'); const itunes = await (await ipod.getDirectoryHandle('iPod_Control')).getDirectoryHandle('iTunes'); await itunes.removeEntry('Extra'); return true; })()`);
        await page.send('Page.enable');
        await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { const proto = FileSystemHandle.prototype; proto.queryPermission = async () => 'prompt'; proto.requestPermission = async () => 'granted'; })()` });
        await reopen();
        await page.click('Backup');
        await page.waitFor('Check my last backup');
        check(!(await visible('still matches this iPod')), 'The backup was counted before the click.');
        await page.click('Check my last backup');
        await page.waitFor('still matches this iPod');
      },
    },
    expected: ['still matches this iPod'],
    forbidden: ['could not be read', 'is damaged'],
    alert: false,
  },
  ...(REAL_MEDIA
    ? [
        {
          name: `real media from ${process.env.SMOKE_REAL_MEDIA} (${REAL_MEDIA.length} files)`,
          url: `http://localhost:${port}/?demo=practice`,
          devtools: {
            doneSelector: 'body',
            timeoutMs: 5_000,
            async drive(page) {
              await page.waitFor('Choose another iPod');
              await page.click('Backup');
              await page.waitFor('What to include');
              await page.click('Choose where to keep the backup');
              await page.waitFor('Every file was read back and matched');
              await page.click('Add music');
              await page.chooseFiles(REAL_MEDIA);
              await page.waitFor(' can be added', 120_000);
              await page.click('Check and prepare');
              const until = Date.now() + 900_000;
              for (;;) {
                const text = String(await page.evaluate('document.body.innerText'));
                if (/Ready to copy|Nothing would be copied|Nothing could be prepared/.test(text)) break;
                if (Date.now() > until) throw new Error('Timed out converting. ' + text.slice(-800));
                await new Promise((resolve) => setTimeout(resolve, 1000));
              }
              const text = String(await page.evaluate('document.body.innerText'));
              console.log(text.slice(text.indexOf('Add music, podcasts')).replace(/\n(Music|Audiobook|Podcast|Movie|TV show|Music video|Video podcast)(?=\n)/g, '').slice(0, 6000));
            },
          },
          expected: [],
          forbidden: [],
          alert: false,
        },
      ]
    : []),
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
        /** Clicks the button whose text is exactly `text`, among the buttons that are on screen and not disabled (tabs stay mounted, so a hidden panel may hold one with the same text). */
        async click(text) {
          const clicked = await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(text)} && !x.matches(':disabled') && x.offsetParent !== null); if (!b) return false; b.click(); return true; })()`);
          if (!clicked) throw new Error(`No enabled button "${text}". The page shows: ${await shown()}`);
        },
        async chooseFiles(paths, selector = 'input[data-pick=files]') {
          const { result: doc } = await send('DOM.getDocument');
          const { result: found } = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
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
