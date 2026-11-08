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

const REAL_MEDIA = process.env.SMOKE_REAL_MEDIA ? listMedia(process.env.SMOKE_REAL_MEDIA) : null;

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
        const order = await page.evaluate(`[...document.querySelectorAll('td.cell-title')].map((cell) => cell.firstChild.textContent.trim()).join('|')`);
        if (order !== '01 First.wav|02 Second.wav|03 Third.wav') throw new Error('The folder files came in the wrong order: ' + order);
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
        await page.waitFor('Back up the database files');
        await page.click('Choose where to keep the backup');
        await page.waitFor('Every file was read back and matched');
        await page.click('Assistant');
        await page.waitFor('Ask a language model');
        const optIn = await page.evaluate(`document.querySelector('.ai-optin span').textContent`);
        check(optIn === "Send my library's titles, artists, albums and genres (no audio, no file paths) to api.anthropic.com when I ask the assistant something.", 'The opt-in wording is wrong: ' + optIn);
        check(await page.evaluate(`document.querySelector('.ai-optin input').checked === false`), 'The opt-in must start off.');
        await page.evaluate(`(() => { const box = document.querySelector('input[type=password]'); box.value = 'sk-test-0000'; box.dispatchEvent(new Event('input', { bubbles: true })); })()`);
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
        await page.waitFor('Back up the database files');
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
        // Collapse the group: its header stays and its rows go.
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
              await page.waitFor('Back up the database files');
              await page.click('Choose where to keep the backup');
              await page.waitFor('Every file was read back and matched');
              await page.click('Add music');
              await page.chooseFiles(REAL_MEDIA);
              await page.waitFor(' can be added', 120_000);
              await page.click('Convert and check');
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
        /** Clicks the button whose text is exactly `text`. */
        async click(text) {
          const clicked = await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(text)} && !x.disabled); if (!b) return false; b.click(); return true; })()`);
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
