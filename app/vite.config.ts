import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// Cross-origin isolation lets the converter use multiple threads (SharedArrayBuffer).
// The app loads nothing from other origins, so require-corp is safe.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  base: './',
  plugins: [preact()],
  server: { headers: isolation },
  preview: { headers: isolation },
  build: { target: 'es2022' },
  // ffmpeg.wasm starts its own module worker from a path next to its code, so Vite must not
  // pre-bundle it in dev, and workers are built as ES modules.
  optimizeDeps: { exclude: ['@ffmpeg/ffmpeg'] },
  worker: { format: 'es' },
});
