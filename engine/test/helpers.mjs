// Shared setup for the engine tests.
//
// The iPod is a folder in the engine's own in-memory file system, so no hardware is
// involved. These tests show the engine writes and reads databases correctly. They cannot
// show that a real iPod accepts the result.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createEngine } from '../js/engine.ts';

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const enginePath = here('../build/engine.js');

if (!existsSync(enginePath)) {
  throw new Error('engine/build/engine.js is missing. Run `npm run engine:build` first.');
}
const { default: factory } = await import(enginePath);

export const MOUNT = '/ipod';
export const GUID_PLACEHOLDER = 'REPLACE_ME_WITH_FIREWIRE_GUID';

/** A fresh engine with an empty folder at MOUNT. Nothing is open yet. */
export async function newEngine() {
  const engine = await createEngine(factory);
  engine.fs.mkdir(MOUNT);
  return engine;
}

/** An engine with a freshly set up iPod open. MA450 is an iPod Video, no checksum needed. */
export async function newIpod(modelNumber = 'MA450') {
  const engine = await newEngine();
  engine.init(MOUNT, modelNumber, 'Test iPod');
  return engine;
}

/**
 * A nano 7G-style iPod: the v1 template stands in for the SysInfoExtended a real unit
 * carries. It declares DBVersion 5, so libgpod signs the database with hashAB.
 */
export async function nano7gStyleIpod({ fireWireId = '0000000000000001' } = {}) {
  const engine = await newEngine();
  engine.init(MOUNT, 'MA450', 'Nano 7G style');
  const template = readFileSync(here('../data/7_nano_SysInfoExtended.plist'), 'utf8');
  if (!template.includes(GUID_PLACEHOLDER)) {
    throw new Error('The template should carry a FireWire ID placeholder.');
  }
  engine.fs.writeFile(
    `${MOUNT}/iPod_Control/Device/SysInfoExtended`,
    fireWireId ? template.replace(GUID_PLACEHOLDER, fireWireId) : template,
  );
  engine.open(MOUNT);
  return engine;
}

function copyTree(from, to, directory) {
  for (const name of from.fs.readdir(directory)) {
    if (name === '.' || name === '..') continue;
    const path = `${directory}/${name}`;
    if (from.fs.isDir(from.fs.stat(path).mode)) {
      to.fs.mkdir(path);
      copyTree(from, to, path);
    } else {
      to.fs.writeFile(path, from.fs.readFile(path));
    }
  }
}

/** Copies the iPod folder into a new engine and opens it there, like reopening the app. */
export async function restart(engine) {
  const next = await newEngine();
  copyTree(engine, next, MOUNT);
  next.open(MOUNT);
  return next;
}

/** Adds a track and gives it a file, the way the app does when it syncs. */
export function addFile(engine, kind, fields, filename, size = 1000) {
  const handle = engine.addTrack(kind, fields);
  const destination = engine.destPath(filename);
  engine.fs.writeFile(destination, new Uint8Array(size));
  engine.commit(handle, destination, size);
  return handle;
}
