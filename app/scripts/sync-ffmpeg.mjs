// Copies the ffmpeg.wasm core into app/public/ffmpeg so the converter can load it from the same
// origin as the app. Nothing is fetched from a CDN, at build time or at run time.
//
// The core is the single-thread build of @ffmpeg/core (pinned in app/package.json). The
// multi-thread build was tested and not used: it hung on a 1080p source and has a fixed 1 GiB
// heap that cannot grow. The reasons are written up at the top of app/src/convert/limits.ts.
//
// Only the JavaScript glue (ES module build) and the wasm are copied. The files are generated,
// so they are listed in .gitignore and never committed.

import { cpSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const target = fileURLToPath(new URL('../public/ffmpeg/', import.meta.url));

let glue;
let wasm;
try {
  glue = fileURLToPath(import.meta.resolve('@ffmpeg/core'));
  wasm = fileURLToPath(import.meta.resolve('@ffmpeg/core/wasm'));
} catch {
  console.error('[sync-ffmpeg] @ffmpeg/core is not installed. Run `npm install` from the repository root.');
  process.exit(1);
}

if (!existsSync(glue) || !existsSync(wasm)) {
  console.error('[sync-ffmpeg] The @ffmpeg/core package is missing its ES module build. Reinstall it with `npm install`.');
  process.exit(1);
}

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(glue, `${target}ffmpeg-core.js`);
cpSync(wasm, `${target}ffmpeg-core.wasm`);

const megabytes = (path) => (statSync(path).size / 1048576).toFixed(1);
console.log(`[sync-ffmpeg] copied ffmpeg-core.js (${megabytes(glue)} MB) and ffmpeg-core.wasm (${megabytes(wasm)} MB) to app/public/ffmpeg/`);
