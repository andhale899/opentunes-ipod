// Copies the built engine into app/public/engine so the browser can load it.
//
// The engine is built separately (`npm run engine:build`, needs Docker). If it has not been
// built, this only says so and the app still starts: the iPod reader then explains how to
// enable it.

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../../engine/build/', import.meta.url));
const target = fileURLToPath(new URL('../public/engine/', import.meta.url));
const files = ['engine.js', 'engine.wasm'];

rmSync(target, { recursive: true, force: true });

if (!files.every((file) => existsSync(`${source}${file}`))) {
  console.warn('[sync-engine] engine/build has no engine yet. Run `npm run engine:build` to enable the iPod reader.');
  process.exit(0);
}

mkdirSync(target, { recursive: true });
for (const file of files) {
  cpSync(`${source}${file}`, `${target}${file}`);
}
console.log('[sync-engine] copied engine.js and engine.wasm to app/public/engine/');
