// Shared setup for the sync tests.
//
// The iPods are folders held in memory (ScratchFolder) that the real engine writes, laid out
// like a nano 7G (iTunesCDB, the SQLite library, hashAB signatures) or like an older iPod with
// only an iTunesDB. Every demo track gets a small stand-in media file, so the music folders
// hold files the library lists, as on a real iPod. Nothing here touches a disk or an iPod.

import assert from 'node:assert/strict';
import { ScratchFolder, backupIpod, buildDemoIpod, buildSignedDemoIpod, mediaPathOf, syncDataFromBytes } from '../js/index.ts';
import { MOUNT, newEngine } from './helpers.mjs';

export const ITUNES = 'iPod_Control/iTunes';
export const LIBRARY = `${ITUNES}/iTunes Library.itlp`;
const NOW = new Date(2026, 10, 7, 18, 4);

/** A Play Counts file for `entries` tracks, all zero. */
function playCounts(entries) {
  const bytes = new Uint8Array(96 + entries * 12);
  bytes.set(new TextEncoder().encode('mhdp'), 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, 96, true);
  view.setUint32(8, 12, true);
  view.setUint32(12, entries, true);
  return bytes;
}

async function copyInto(engine, directory, folder) {
  for (const name of engine.fs.readdir(directory)) {
    if (name === '.' || name === '..') continue;
    const path = `${directory}/${name}`;
    if (engine.fs.isDir(engine.fs.stat(path).mode)) {
      await copyInto(engine, path, await folder.getDirectoryHandle(name, { create: true }));
    } else {
      await writeFile(folder, name, engine.fs.readFile(path));
    }
  }
}

export async function writeFile(folder, name, bytes) {
  const writer = await (await folder.getFileHandle(name, { create: true })).createWritable();
  await writer.write(bytes);
  await writer.close();
}

/** The folder at `path` (slash separated) inside `root`, made if asked. */
export async function folderOf(root, path, create = false) {
  let folder = root;
  for (const part of path.split('/')) folder = await folder.getDirectoryHandle(part, { create });
  return folder;
}

export async function putFile(root, path, bytes) {
  const parts = path.split('/');
  await writeFile(await folderOf(root, parts.slice(0, -1).join('/'), true), parts[parts.length - 1], bytes);
}

/** Gives every track in the engine's library a small stand-in file on the scratch iPod. */
async function addStandIns(engine, ipod) {
  for (const track of engine.tracks()) {
    const path = mediaPathOf(track.ipod_path);
    if (path) await putFile(ipod, path, new TextEncoder().encode(`stand-in for ${track.title}`));
  }
}

/** A nano 7G-style iPod: iTunesCDB and no iTunesDB, the SQLite library, signatures, and plays waiting in Play Counts. */
export async function signedIpod() {
  const engine = await newEngine();
  buildSignedDemoIpod(engine);
  engine.fs.unlink(`${MOUNT}/${ITUNES}/iTunesDB`);
  engine.fs.writeFile(`${MOUNT}/${ITUNES}/Play Counts`, playCounts(5));
  const ipod = new ScratchFolder('IPOD');
  await copyInto(engine, MOUNT, ipod);
  await addStandIns(engine, ipod);
  return ipod;
}

/** An older iPod (an iPod Video): only an iTunesDB, no SQLite library and no signatures. */
export async function plainIpod() {
  const engine = await newEngine();
  buildDemoIpod(engine);
  const ipod = new ScratchFolder('OLDPOD');
  await copyInto(engine, MOUNT, ipod);
  await addStandIns(engine, ipod);
  return ipod;
}

/** An older iPod set up with an empty library: no tracks, no podcast playlist. */
export async function emptyIpod() {
  const engine = await newEngine();
  engine.init(MOUNT, 'MA450', 'Empty iPod');
  engine.write();
  const ipod = new ScratchFolder('EMPTY');
  await copyInto(engine, MOUNT, ipod);
  return ipod;
}

export const snapshot =(ipod) => new Map([...ipod.listFiles()].map(([path, bytes]) => [path, Uint8Array.from(bytes)]));

export async function backedUp(ipod) {
  const backup = await backupIpod(ipod, new ScratchFolder('Backups'), { now: NOW });
  assert.equal(backup.complete, true);
  return backup;
}

/** Bytes that differ from file to file, so a mix-up between files shows. */
export function bytesFor(seed, size) {
  const bytes = new Uint8Array(size);
  let state = (seed * 2654435761) >>> 0 || 1;
  for (let i = 0; i < size; i += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[i] = state & 0xff;
  }
  return bytes;
}

const EXTENSIONS = { music: '.mp3', movie: '.m4v', 'music-video': '.m4v', 'tv-show': '.m4v', podcast: '.mp3', 'video-podcast': '.m4v', audiobook: '.m4b' };
const VIDEO_KINDS = ['movie', 'music-video', 'tv-show', 'video-podcast'];

let counter = 0;

/** A prepared item of a kind, shaped like what the probe and planner hand over. */
export function makeItem(kind, { tags = {}, size = 3000, durationMs = 180_000, chapters = [], fields, playlists, id, data, extension } = {}) {
  counter += 1;
  const video = VIDEO_KINDS.includes(kind);
  const ext = extension ?? EXTENSIONS[kind];
  return {
    id: id ?? `item-${counter}`,
    kind,
    extension: ext,
    name: `file-${counter}${ext}`,
    data: data ?? syncDataFromBytes(bytesFor(counter, size)),
    info: {
      durationMs,
      container: ext.slice(1),
      audio: { codec: ext === '.mp3' ? 'mp3' : 'aac', sampleRateHz: 44100, channels: 2, bitrateKbps: 192 },
      video: video ? { codec: 'h264', width: 640, height: 480, fps: 25, bitrateKbps: 1500 } : null,
      tags: { title: `Title ${counter}`, artist: 'Some Artist', album: 'Some Album', ...tags },
      chapters,
      artwork: null,
    },
    ...(fields ? { fields } : {}),
    ...(playlists ? { playlists } : {}),
  };
}

/**
 * Wraps an iPod folder so a test can watch and interfere with what is done to it. Hooks get the
 * path from the iPod's top folder:
 * - open(path): 'refuse' makes createWritable throw "the disk is full".
 * - write(path, index, data): 'refuse' throws on that write, 'corrupt' flips a byte of it.
 * - opened(path) / closed(path): a writer was made / closed or aborted.
 * - remove(path): 'refuse' makes the delete throw.
 * - log(event, path): every write and delete, in order.
 */
export function instrument(folder, hooks = {}, prefix = '') {
  return {
    kind: 'directory',
    name: folder.name,
    async *entries() {
      for await (const [name, entry] of folder.entries()) {
        yield [name, entry.kind === 'directory' ? instrument(entry, hooks, `${prefix}${name}/`) : entry];
      }
    },
    getDirectoryHandle: async (name, options) => instrument(await folder.getDirectoryHandle(name, options), hooks, `${prefix}${name}/`),
    removeEntry: async (name) => {
      const path = `${prefix}${name}`;
      if (hooks.remove?.(path) === 'refuse') throw new Error('the iPod refused to delete it');
      hooks.log?.('remove', path);
      return folder.removeEntry(name);
    },
    getFileHandle: async (name, options) => {
      const file = await folder.getFileHandle(name, options);
      const path = `${prefix}${name}`;
      return {
        kind: 'file',
        name,
        getFile: () => file.getFile(),
        createWritable: async () => {
          if (hooks.open?.(path) === 'refuse') throw new Error('the disk is full');
          const writer = await file.createWritable();
          hooks.opened?.(path);
          let index = 0;
          let open = true;
          const finish = () => {
            if (open) hooks.closed?.(path);
            open = false;
          };
          return {
            write: async (data) => {
              const action = hooks.write?.(path, index, data);
              index += 1;
              if (action === 'refuse') throw new Error('the disk is full');
              await writer.write(action === 'corrupt' ? Uint8Array.from(data, (byte, i) => (i === 0 ? byte ^ 0xff : byte)) : data);
            },
            close: async () => {
              try {
                await writer.close();
                hooks.log?.('write', path);
              } finally {
                finish();
              }
            },
            abort: async () => finish(),
          };
        },
      };
    },
  };
}

/** An engine factory that lets a test change each engine it hands out, numbered from 1. */
export function engines(change = () => {}) {
  let made = 0;
  return async () => {
    const engine = await newEngine();
    made += 1;
    change(engine, made);
    return engine;
  };
}

/** Reads the iPod with a fresh engine the way the reader does, and returns that engine. */
export async function readIpod(ipod) {
  const { loadIpodFolder } = await import('../js/index.ts');
  const engine = await newEngine();
  await loadIpodFolder(ipod, engine, { mount: MOUNT });
  engine.open(MOUNT);
  return engine;
}

export { MOUNT, newEngine };
